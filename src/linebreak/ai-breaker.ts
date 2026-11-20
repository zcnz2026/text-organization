import { GeminiPoolExhaustedError, type GeminiPoolClient } from "../ai/gemini-client";
import { diagLog } from "../platform/diag-log";
import { createSubtitleMeasurer, type SubtitleMeasurer } from "./measurer";
import type {
  ImportedSubtitleSheet,
  LineBreakLanguageSpec,
  ProcessedSubtitleRow,
  SubtitleLineBreakRun,
} from "./types";
import {
  classifySubtitleRow,
  evaluateAndFinalizePlan,
  findIndependentSentenceSplits,
  type IndexBreakPlan,
  normalizeSourceSubtitle,
  renderTokenSlice,
  solveCitationSameScreen,
  solveOptimalBreakDeterministic,
  type SubtitleToken,
  tokenizeSubtitle,
} from "./validator";

const AI_BATCH_SIZE = 20;

export class LineBreakPausedError extends Error {
  readonly completedAiRows: number;
  readonly totalAiRows: number;
  readonly isKeyError: boolean;
  readonly partialAiCache: Record<number, { srcText: string; row: ProcessedSubtitleRow }>;

  constructor(opts: {
    message: string;
    completedAiRows: number;
    totalAiRows: number;
    isKeyError: boolean;
    partialAiCache: Record<number, { srcText: string; row: ProcessedSubtitleRow }>;
  }) {
    super(opts.message);
    this.name = "LineBreakPausedError";
    this.completedAiRows = opts.completedAiRows;
    this.totalAiRows = opts.totalAiRows;
    this.isKeyError = opts.isKeyError;
    this.partialAiCache = opts.partialAiCache;
  }
}

const AI_LINEBREAK_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          screenEnds: {
            type: "array",
            items: { type: "integer" },
          },
          atSplits: {
            type: "array",
            items: { type: "integer", nullable: true },
          },
          compactSameScreen: { type: "boolean" },
        },
        required: ["id", "screenEnds", "atSplits"],
      },
    },
  },
  required: ["items"],
};

interface PendingAiRow {
  id: string;
  rowIndex: number;
  isCitation: boolean;
  tokens: SubtitleToken[];
  chineseRef: string;
  englishRef: string;
  totalMeasured: number;
  hasTwoSentences: boolean;
}

function formatIndexedTokensWithCumulative(
  tokens: SubtitleToken[],
  measurer: SubtitleMeasurer,
): string {
  return tokens
    .map((tok, idx) => {
      const cum = measurer.measure(renderTokenSlice(tokens, 0, idx + 1, null, measurer.spec));
      return `[${idx}|${cum}]${tok.text}`;
    })
    .join(" ");
}

function buildSystemInstruction(spec: LineBreakLanguageSpec, measurer: SubtitleMeasurer): string {
  const unitLabel = spec.mode === "char" ? "字符" : "标尺等效单位（46=1倍尺子宽，84=同屏双行常规上限）";
  return [
    `你是专业的多语种视频字幕断行与分屏专家。当前目标语种：${spec.name}（度量单位：${unitLabel}）。`,
    `每个词前标有 [词序号|从头累计长度]，总词数为 N（序号 0 到 N-1）。你只允许返回词序号切分方案，绝不修改原文。`,
    ``,
    `## 核心规则（严格按优先级执行）`,
    `1. **语义第一，视觉第二（严禁凑均分而拆散语法意群）**：`,
    `   - 绝不拆散：冠词/物主形容词+名词（如 your // childhood dream）、固定并列专名/头衔（如 父子二人、行政管理和管理学学位）、数量宾语与所属定语（如 68本...书 // 全能神教会）、复合动词、介词+宾语、否定词+动词、书名号/引号内部短语。`,
    `   - 优先在句末标点、逗号/分号、从句引导词前、自然说话停顿处切分（结合中文/英文参考语义停顿，不要看到逗号就盲目拆散并列词）。`,
    `2. **单行与同屏双行上限**：`,
    `   - 单行上限 = ${measurer.singleLimit}；同屏双行常规总上限 = ${measurer.doubleLimit}。`,
    `   - 长度 ≤ ${measurer.singleLimit} 的屏严禁加 @（填 null）。`,
    `   - 每屏最多只能加 1 个断行符 @（由 atSplits[屏序号] 指定切分词序号 k，表示 [start..k-1] 为上行、[k..end-1] 为下行）。`,
    `   - 加 @ 后，上行长度与下行长度各自均不得超过 ${measurer.singleLimit}！`,
    `3. **视觉美观比例（${measurer.minRatio}~${measurer.maxRatio} 原则，无需刻意均分）**：`,
    `   - 同屏双行 @ 前后长度比值必须在 [${measurer.minRatio}, ${measurer.maxRatio}] 之间（避免一行很满、另一行仅一两个词）；只要语法停顿自然，微正金字塔、平齐矩形或微弱倒金字塔均佳。`,
    `4. **严防“分屏琐碎”与弹性“卡度”规则**：`,
    `   - **严禁琐碎分屏（≤${measurer.doubleLimit}）**：只要整句意思紧凑，≤${measurer.doubleLimit} 一律保持 1 屏双行（screenEnds=[N]），绝不拆成碎屏！仅当长度在 ${measurer.earlySplitMin}~${measurer.doubleLimit} 且包含两个完整独立的句子（或后半句是引出下一行的说话提示如“常常对人说：”）时，才拆成 2 屏。`,
    `   - **微超免断区（${measurer.singleLimit + 1}~${measurer.softNoBreakLimit}）**：若能自然美观断行则正常设 @；若唯一语法切分点会导致前后长度悬殊（超出比例范围），保持单屏单行（screenEnds=[N], atSplits=[null]）。`,
    `   - **超长分屏（>${measurer.doubleLimit}）**：严禁把第一屏机械凑满 ${measurer.doubleLimit} 才分屏，也严禁分出只剩一两个词的碎屏！必须按完整主谓/从句意群拆成 2 屏（极长可拆 3 屏，若拆 3 屏显得零散则改拆 2 屏），再对 >${measurer.singleLimit} 的屏填入 @ 切分词序号。`,
    `   - **紧凑句豁免（${measurer.doubleLimit + 1}~${measurer.compactSameScreenLimit}）**：若整句结构极其紧凑、分屏会导致意思断裂或出现仅两三个词的碎屏，且上下两行各自不超过 ${measurer.singleLimit + 2}，请设 compactSameScreen=true 保留同屏双行（screenEnds=[N]）。`,
    `   - **出处行特例（isCitation=true）**：书名/诗歌出处行一律保持 1 屏（screenEnds=[N]），在书名卷号与篇名引号分界处设 1 个 @。`,
    ...(measurer.globalCustomPrompt
      ? [`5. **团队全局补充断行要求（最高优先级执行）**：\n   ${measurer.globalCustomPrompt}`]
      : []),
    ...(spec.customPromptRule
      ? [`6. **${spec.name}专属补充断行要求（最高优先级执行）**：\n   ${spec.customPromptRule}`]
      : []),
  ].join("\n");
}

async function callGeminiBatch(
  batch: PendingAiRow[],
  spec: LineBreakLanguageSpec,
  measurer: SubtitleMeasurer,
  gemini: GeminiPoolClient,
): Promise<Map<string, IndexBreakPlan>> {
  const sys = buildSystemInstruction(spec, measurer);
  const promptLines = batch.map((item) => {
    const meta = [
      `id="${item.id}"`,
      `tokens=${item.tokens.length}`,
      `totalLen=${item.totalMeasured}`,
      item.isCitation ? `isCitation=true(保持单屏加1个@)` : "",
      item.hasTwoSentences ? `含多个独立句子` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const refs = [
      item.chineseRef ? `  中文参考: ${item.chineseRef}` : "",
      item.englishRef ? `  英文参考: ${item.englishRef}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `### 条目 ${meta}\n${refs ? `${refs}\n` : ""}  外文分词: ${formatIndexedTokensWithCumulative(item.tokens, measurer)}`;
  });

  const resp = await gemini.generateStructuredJson<{
    items?: Array<{
      id: string;
      screenEnds: number[];
      atSplits: Array<number | null>;
      compactSameScreen?: boolean;
    }>;
  }>({
    systemInstruction: sys,
    userPrompt: `请为以下 ${batch.length} 条字幕输出最优断行/分屏切分词序号 JSON：\n\n${promptLines.join("\n\n")}`,
    jsonSchema: AI_LINEBREAK_SCHEMA,
  });

  const map = new Map<string, IndexBreakPlan>();
  for (const it of resp.items ?? []) {
    if (!it || typeof it.id !== "string" || !Array.isArray(it.screenEnds)) continue;
    const normalizedAts = (it.atSplits ?? []).map((v) =>
      typeof v === "number" && v > 0 ? v : null,
    );
    map.set(it.id, {
      screenEnds: it.screenEnds,
      atSplits: normalizedAts,
      compactSameScreen: Boolean(it.compactSameScreen),
    });
  }
  return map;
}

export type CachedAiRowMap = Record<number, { srcText: string; row: ProcessedSubtitleRow }>;

export interface RunLineBreakOptions {
  gemini?: GeminiPoolClient;
  useAi: boolean;
  /** If true, stops and throws LineBreakPausedError when API keys fail/exhaust instead of silent fallback */
  pauseOnKeyExhausted?: boolean;
  /** Pre-completed AI rows from an earlier interrupted run for instant checkpoint resume */
  cachedAiRows?: CachedAiRowMap;
  /** Invoked after each 20-row AI batch completes so checkpoints are persisted continuously */
  onCheckpoint?: (
    cache: CachedAiRowMap,
    completedAiRows: number,
    totalAiRows: number,
  ) => void | Promise<void>;
  /** Optional abort signal for user-initiated pause */
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, text: string) => void;
}

export async function runSubtitleLineBreakPipeline(
  sheet: ImportedSubtitleSheet,
  langSpec: LineBreakLanguageSpec,
  options: RunLineBreakOptions,
): Promise<SubtitleLineBreakRun> {
  const measurer = createSubtitleMeasurer(langSpec);
  const colMap = sheet.columnMap;
  const results: ProcessedSubtitleRow[] = new Array(sheet.rows.length);
  const pendingAi: Array<PendingAiRow & { srcText: string }> = [];
  const liveAiCache: CachedAiRowMap = { ...(options.cachedAiRows ?? {}) };
  let preCachedCount = 0;

  for (const row of sheet.rows) {
    const category = classifySubtitleRow(row, colMap, measurer);
    const rawTarget = row.rawCells[colMap.targetCol] ?? "";

    if (category === "skip_green") {
      const m = measurer.analyzeScreen(rawTarget.trim());
      results[row.rowIndex] = {
        sourceRowIndex: row.rowIndex,
        category,
        status: "skip_green",
        usedAi: false,
        screens: [{ ...m, exceedsSingleLimit: false, ratioOutOfBounds: false }],
        reason: "高亮绿底免断行",
        reviewNote: "",
      };
      continue;
    }

    if (category === "skip_empty") {
      results[row.rowIndex] = {
        sourceRowIndex: row.rowIndex,
        category,
        status: "untouched",
        usedAi: false,
        screens: [measurer.analyzeScreen("")],
        reason: "空行跳过",
        reviewNote: "",
      };
      continue;
    }

    if (category === "skip_title_graphic") {
      const m = measurer.analyzeScreen(rawTarget.trim());
      results[row.rowIndex] = {
        sourceRowIndex: row.rowIndex,
        category,
        status: "review_warning",
        usedAi: false,
        screens: [{ ...m, exceedsSingleLimit: false, ratioOutOfBounds: false }],
        reason: "疑似标题/多行图解未断行",
        reviewNote: "疑似标题/多行图解未断行，请核对",
      };
      continue;
    }

    const clean = normalizeSourceSubtitle(rawTarget, langSpec);

    if (category === "short_keep") {
      results[row.rowIndex] = {
        sourceRowIndex: row.rowIndex,
        category,
        status: "untouched",
        usedAi: false,
        screens: [measurer.analyzeScreen(clean)],
        reason: `≤ ${measurer.singleLimit} 不断行`,
        reviewNote: "",
      };
      continue;
    }

    const tokens = tokenizeSubtitle(clean, langSpec);
    const isCitation = category === "citation_same_screen";
    const totalM = measurer.measure(clean);

    const wantsAi =
      options.useAi &&
      (Boolean(options.gemini?.hasKeys) || Boolean(options.pauseOnKeyExhausted)) &&
      tokens.length >= 2;

    if (wantsAi) {
      const cached = liveAiCache[row.rowIndex];
      if (cached && cached.srcText === clean) {
        results[row.rowIndex] = cached.row;
        preCachedCount += 1;
        continue;
      }

      pendingAi.push({
        id: `r_${row.rowIndex}`,
        rowIndex: row.rowIndex,
        srcText: clean,
        isCitation,
        tokens,
        chineseRef: colMap.chineseCol >= 0 ? (row.rawCells[colMap.chineseCol] ?? "").trim() : "",
        englishRef: colMap.englishCol >= 0 ? (row.rawCells[colMap.englishCol] ?? "").trim() : "",
        totalMeasured: totalM,
        hasTwoSentences: findIndependentSentenceSplits(tokens, measurer).length > 0,
      });
    } else {
      const detPlan = isCitation
        ? solveCitationSameScreen(tokens, measurer)
        : solveOptimalBreakDeterministic(tokens, measurer);
      results[row.rowIndex] = evaluateAndFinalizePlan(
        row.rowIndex,
        category,
        tokens,
        detPlan,
        measurer,
        false,
      );
    }
  }

  const totalAiTarget = preCachedCount + pendingAi.length;

  if (pendingAi.length > 0) {
    if (!options.gemini || !options.gemini.hasKeys) {
      if (options.pauseOnKeyExhausted) {
        throw new LineBreakPausedError({
          message: "未配置可用的 Gemini API Key，已保存进度等待补充 Key 后接续处理",
          completedAiRows: preCachedCount,
          totalAiRows: totalAiTarget,
          isKeyError: true,
          partialAiCache: liveAiCache,
        });
      }
    } else {
      const batches: Array<Array<PendingAiRow & { srcText: string }>> = [];
      for (let i = 0; i < pendingAi.length; i += AI_BATCH_SIZE) {
        batches.push(pendingAi.slice(i, i + AI_BATCH_SIZE));
      }

      let completedRows = preCachedCount;
      options.onProgress?.(
        completedRows,
        totalAiTarget,
        preCachedCount > 0
          ? `从断点接续 ${langSpec.name} 意群断行 (${completedRows}/${totalAiTarget})...`
          : `正在调用大模型进行 ${langSpec.name} 意群断行 (0/${totalAiTarget})...`,
      );

      for (const batch of batches) {
        if (options.signal?.aborted) {
          throw new LineBreakPausedError({
            message: `已手动暂停（已完成 ${completedRows}/${totalAiTarget} 条长句断行，可随时继续）`,
            completedAiRows: completedRows,
            totalAiRows: totalAiTarget,
            isKeyError: false,
            partialAiCache: liveAiCache,
          });
        }

        let aiMap = new Map<string, IndexBreakPlan>();
        try {
          aiMap = await callGeminiBatch(batch, langSpec, measurer, options.gemini);
        } catch (err) {
          const isPoolExhausted = err instanceof GeminiPoolExhaustedError;
          if (options.pauseOnKeyExhausted) {
            diagLog.warn(
              "LineBreakAI",
              `AI 密钥池暂停保存断点 (${completedRows}/${totalAiTarget}): ${err instanceof Error ? err.message : String(err)}`,
            );
            throw new LineBreakPausedError({
              message:
                err instanceof Error
                  ? `${err.message}（已保存进度 ${completedRows}/${totalAiTarget}，更换/补充 Key 后可接续处理）`
                  : `API 请求受限（已保存进度 ${completedRows}/${totalAiTarget}）`,
              completedAiRows: completedRows,
              totalAiRows: totalAiTarget,
              isKeyError: isPoolExhausted || true,
              partialAiCache: liveAiCache,
            });
          }
          diagLog.warn(
            "LineBreakAI",
            `批次 AI 断行请求异常，该批次回退本地意群规则引擎: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        for (const item of batch) {
          const aiPlan = aiMap.get(item.id);
          const category = item.isCitation ? "citation_same_screen" : "needs_break";
          const finalized = aiPlan
            ? evaluateAndFinalizePlan(item.rowIndex, category, item.tokens, aiPlan, measurer, true)
            : evaluateAndFinalizePlan(
                item.rowIndex,
                category,
                item.tokens,
                item.isCitation
                  ? solveCitationSameScreen(item.tokens, measurer)
                  : solveOptimalBreakDeterministic(item.tokens, measurer),
                measurer,
                false,
              );
          results[item.rowIndex] = finalized;
          liveAiCache[item.rowIndex] = { srcText: item.srcText, row: finalized };
        }

        completedRows += batch.length;
        await options.onCheckpoint?.(liveAiCache, completedRows, totalAiTarget);
        options.onProgress?.(
          completedRows,
          totalAiTarget,
          `正在调用大模型进行 ${langSpec.name} 意群断行 (${completedRows}/${totalAiTarget})...`,
        );
      }
    }
  }

  return summarizeRun(sheet.sheetName, langSpec, results);
}

export function summarizeRun(
  sheetName: string,
  langSpec: LineBreakLanguageSpec,
  results: ProcessedSubtitleRow[],
): SubtitleLineBreakRun {
  let totalOutputScreens = 0;
  let sameScreenAtCount = 0;
  let insertedScreenRowsCount = 0;
  let skippedGreenCount = 0;
  let reviewCount = 0;

  for (const r of results) {
    totalOutputScreens += r.screens.length;
    if (r.screens.length > 1) {
      insertedScreenRowsCount += r.screens.length - 1;
    }
    for (const sc of r.screens) {
      if (sc.hasAt) sameScreenAtCount += 1;
    }
    if (r.status === "skip_green") skippedGreenCount += 1;
    if (
      r.reviewNote ||
      r.status === "review_warning" ||
      r.status === "soft_kept_single" ||
      r.status === "compact_kept_double"
    ) {
      reviewCount += 1;
    }
  }

  return {
    langSpec,
    sheetName,
    results,
    totalSourceRows: results.length,
    totalOutputScreens,
    sameScreenAtCount,
    insertedScreenRowsCount,
    skippedGreenCount,
    reviewCount,
  };
}

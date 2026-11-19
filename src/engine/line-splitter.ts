import type { GeminiPoolClient } from "../ai/gemini-client";
import { diagLog } from "../platform/diag-log";
import type { PunctuationRule, ScriptRow } from "../types/domain";
import { stripOuterDoubleQuotes } from "./punctuation";

export interface TokenSpan {
  start: number;
  end: number;
  cap?: boolean;
  ellipsis?: boolean;
}

export interface BatchSplitRequest {
  id: string;
  fallbackText: string;
  aiSourceText: string;
  referenceEn?: string;
  sourceRows: ScriptRow[];
}

const BATCH_SPAN_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          spans: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "integer" },
                end: { type: "integer" },
                cap: { type: "boolean" },
                ellipsis: { type: "boolean" },
              },
              required: ["start", "end"],
            },
          },
        },
        required: ["id", "spans"],
      },
    },
  },
  required: ["results"],
};

function capitalizeFirstLetter(text: string): string {
  return text.replace(/^([^\p{L}]*)(\p{L})/u, (_m, pre: string, ch: string) =>
    `${pre}${ch.toUpperCase()}`,
  );
}

export function tokenizeForIndexing(text: string): { tokens: string[]; joinSep: string } {
  const clean = stripOuterDoubleQuotes(text).trim();
  const spaceWords = clean.split(/\s+/).filter(Boolean);
  if (spaceWords.length >= 6 || !/[\u3040-\u30ff\u0e00-\u0e7f\u1780-\u17ff\u1000-\u109f\u4e00-\u9fff]/u.test(clean)) {
    return { tokens: spaceWords, joinSep: " " };
  }
  // No-space scripts (Japanese, Thai, Khmer, Myanmar, Lao): split into punctuation-aware small chunks
  const tokens: string[] = [];
  for (const seg of clean.split(/(?<=[、。！？,.!?;；，។။\s])/u)) {
    const s = seg.trim();
    if (!s) continue;
    const chars = [...s];
    if (chars.length <= 6) tokens.push(s);
    else {
      for (let i = 0; i < chars.length; i += 4) tokens.push(chars.slice(i, i + 4).join(""));
    }
  }
  return { tokens: tokens.length > 0 ? tokens : [clean], joinSep: "" };
}

export function formatIndexedTokens(tokens: string[]): string {
  return tokens.map((t, i) => `[${i}]${t}`).join(" ");
}

export function sliceTokensBySpans(
  tokens: string[],
  joinSep: string,
  spans: TokenSpan[],
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
): string[] | null {
  if (!Array.isArray(spans) || spans.length !== sourceRows.length || tokens.length === 0) return null;
  let prevStart = -1;
  const out: string[] = [];

  for (let i = 0; i < spans.length; i += 1) {
    const sp = spans[i];
    if (
      typeof sp?.start !== "number" ||
      typeof sp?.end !== "number" ||
      !Number.isInteger(sp.start) ||
      !Number.isInteger(sp.end) ||
      sp.start < 0 ||
      sp.end < sp.start ||
      sp.end >= tokens.length ||
      sp.start < prevStart
    ) {
      return null;
    }
    prevStart = sp.start;

    let chunk = tokens.slice(sp.start, sp.end + 1).join(joinSep).trim();
    if (!chunk) return null;

    const row = sourceRows[i];
    if (sp.cap || (i === 0 && row.remark.includes("涉及截取"))) {
      chunk = capitalizeFirstLetter(chunk);
    }
    const wantsEllipsis =
      sp.ellipsis ||
      row.remark.includes("有省略") ||
      row.chinese.includes("……") ||
      row.english.includes("…");
    if (wantsEllipsis && !chunk.endsWith(rule.ellipsis) && !chunk.endsWith("...") && !chunk.endsWith("…")) {
      chunk = `${chunk} ${rule.ellipsis}`;
    }
    out.push(chunk);
  }
  return out;
}

export function deterministicSplitLines(
  rawTargetParagraph: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
): string[] {
  const count = sourceRows.length;
  const cleanTarget = stripOuterDoubleQuotes(rawTargetParagraph);
  if (count <= 1) return [cleanTarget];

  let workingText = cleanTarget;
  const firstRem = sourceRows[0]?.remark ?? "";
  const truncMatch = /涉及截取[：:]\s*(.+)$/u.exec(firstRem);
  if (truncMatch && sourceRows[0].english) {
    const fullOriginEn = truncMatch[1].trim();
    const keptEn = stripOuterDoubleQuotes(sourceRows[0].english);
    const dropRatio = Math.max(0, (fullOriginEn.length - keptEn.length) / Math.max(1, fullOriginEn.length));
    if (dropRatio > 0.08 && dropRatio < 0.6) {
      const commaIdx = workingText.indexOf(",");
      if (commaIdx > 0 && commaIdx < workingText.length * 0.45) {
        workingText = capitalizeFirstLetter(workingText.slice(commaIdx + 1).trim());
      }
    }
  }

  const words = workingText.split(/\s+/).filter(Boolean);
  if (words.length < count) {
    const chars = [...workingText];
    const step = Math.max(1, Math.ceil(chars.length / count));
    return sourceRows.map((_r, idx) =>
      chars.slice(idx * step, idx === count - 1 ? chars.length : (idx + 1) * step).join("").trim(),
    );
  }

  const weights = sourceRows.map((r) => Math.max(4, stripOuterDoubleQuotes(r.english || r.chinese).length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const lines: string[] = [];
  let wordCursor = 0;
  let accWeight = 0;

  for (let i = 0; i < count; i += 1) {
    accWeight += weights[i];
    if (i === count - 1) {
      lines.push(words.slice(wordCursor).join(" "));
      break;
    }

    const idealEnd = Math.round((accWeight / totalWeight) * words.length);
    const maxEnd = words.length - (count - 1 - i);
    const minEnd = wordCursor + 1;
    let bestEnd = Math.min(maxEnd, Math.max(minEnd, idealEnd));

    const searchRadius = Math.min(4, Math.floor((maxEnd - minEnd) / 2));
    for (let offset = 0; offset <= searchRadius; offset += 1) {
      for (const candidate of [bestEnd + offset, bestEnd - offset]) {
        if (candidate >= minEnd && candidate <= maxEnd && /[,.;:!?—–]$/.test(words[candidate - 1])) {
          bestEnd = candidate;
          offset = searchRadius + 1;
          break;
        }
      }
    }

    let chunk = words.slice(wordCursor, bestEnd).join(" ");
    if (
      (sourceRows[i].remark.includes("有省略") || sourceRows[i].chinese.includes("……") || sourceRows[i].english.includes("…")) &&
      !chunk.endsWith(rule.ellipsis) &&
      !chunk.endsWith("...")
    ) {
      chunk = `${chunk} ${rule.ellipsis}`;
    }
    lines.push(chunk);
    wordCursor = bestEnd;
  }

  return lines;
}

const SYSTEM_PROMPT =
  "你是多语种影视字幕词序号精准定位助手。每个任务提供带 [0][1][2]... 编号的目标语定稿原文，以及需要对齐的若干行中英文字幕。请为每一行返回对应的起止词编号 {start, end}（闭区间，含首尾）。\n" +
  "规则：\n" +
  "1. 严格按各行中英文的语义起止边界定界；若剧本只摘录前半句或局部，只选对应的词段，绝不多带后半句。\n" +
  "2. 相邻两行如无省略则首尾衔接（下一行 start = 上一行 end + 1）；若某行备注有省略，可跳过中间词并设 ellipsis:true。\n" +
  "3. 若首行备注涉及截取且去掉了句首词，请从新句首词开始并设 cap:true。\n" +
  "4. 只输出 JSON 词序号，不要重写原文。";

export async function batchSplitTargetsWithAi(
  requests: BatchSplitRequest[],
  rule: PunctuationRule,
  gemini?: GeminiPoolClient,
): Promise<Map<string, { lines: string[]; usedAi: boolean }>> {
  const resultMap = new Map<string, { lines: string[]; usedAi: boolean }>();
  if (requests.length === 0) return resultMap;

  if (!gemini?.hasKeys) {
    for (const req of requests) {
      resultMap.set(req.id, { lines: deterministicSplitLines(req.fallbackText, req.sourceRows, rule), usedAi: false });
    }
    return resultMap;
  }

  // Pack up to 6 blocks (<= 14k chars) per API request to save system prompt tokens
  const batches: BatchSplitRequest[][] = [];
  let curBatch: BatchSplitRequest[] = [];
  let curChars = 0;
  for (const req of requests) {
    const est = req.aiSourceText.length + (req.referenceEn?.length ?? 0) + req.sourceRows.length * 100;
    if (curBatch.length >= 6 || (curBatch.length > 0 && curChars + est > 14000)) {
      batches.push(curBatch);
      curBatch = [];
      curChars = 0;
    }
    curBatch.push(req);
    curChars += est;
  }
  if (curBatch.length > 0) batches.push(curBatch);

  for (const batch of batches) {
    const tokenized = new Map<string, { tokens: string[]; joinSep: string }>();
    const blocksPrompt = batch
      .map((req) => {
        const tk = tokenizeForIndexing(req.aiSourceText);
        tokenized.set(req.id, tk);
        const rowsSpec = req.sourceRows
          .map((r, i) => `  (${i + 1}) ZH: ${r.chinese} | EN: ${r.english}${r.remark ? ` | 备注: ${r.remark}` : ""}`)
          .join("\n");
        const refEnLine = req.referenceEn ? `原段参考英文：${req.referenceEn}\n` : "";
        return `### 任务ID: ${req.id}\n${refEnLine}编号定稿原文（${rule.langName}）：\n${formatIndexedTokens(tk.tokens)}\n需对齐的字幕行（共 ${req.sourceRows.length} 行）：\n${rowsSpec}`;
      })
      .join("\n\n");

    try {
      const res = await gemini.generateStructuredJson<{
        results: Array<{ id: string; spans: TokenSpan[] }>;
      }>({
        systemInstruction: SYSTEM_PROMPT,
        userPrompt: blocksPrompt,
        jsonSchema: BATCH_SPAN_SCHEMA,
      });

      const byId = new Map((res.results ?? []).map((item) => [item.id, item.spans]));
      let aiHits = 0;
      for (const req of batch) {
        const tk = tokenized.get(req.id)!;
        const spans = byId.get(req.id);
        const sliced = spans ? sliceTokensBySpans(tk.tokens, tk.joinSep, spans, req.sourceRows, rule) : null;
        if (sliced) {
          resultMap.set(req.id, { lines: sliced, usedAi: true });
          aiHits += 1;
        } else {
          diagLog.warn("AI 词序号校验回退", `[${rule.langName}] 任务 ${req.id} 未通过边界校验，已回退本地切分`);
          resultMap.set(req.id, { lines: deterministicSplitLines(req.fallbackText, req.sourceRows, rule), usedAi: false });
        }
      }
      diagLog.info("AI 批量分句", `[${rule.langName}] 本批 ${batch.length} 块，词序号精准命中 ${aiHits} 块`);
    } catch (err) {
      diagLog.warn("AI 批量分句回退", `[${rule.langName}] 本批 ${batch.length} 块调用失败，已回退本地切分`, err instanceof Error ? err.message : String(err));
      for (const req of batch) {
        resultMap.set(req.id, { lines: deterministicSplitLines(req.fallbackText, req.sourceRows, rule), usedAi: false });
      }
    }
  }

  return resultMap;
}

export async function splitTargetIntoScriptLines(
  rawTargetParagraph: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini?: GeminiPoolClient,
  opts?: { fullParagraphTarget?: string; referenceEn?: string; isPartial?: boolean },
): Promise<{ lines: string[]; usedAi: boolean }> {
  const needAi = sourceRows.length > 1 || Boolean(opts?.isPartial);
  if (!needAi) {
    return { lines: [stripOuterDoubleQuotes(rawTargetParagraph)], usedAi: false };
  }
  const map = await batchSplitTargetsWithAi(
    [
      {
        id: `row_${sourceRows[0]?.line || sourceRows[0]?.rowIndex || 0}`,
        fallbackText: rawTargetParagraph,
        aiSourceText: opts?.fullParagraphTarget || rawTargetParagraph,
        referenceEn: opts?.referenceEn,
        sourceRows,
      },
    ],
    rule,
    gemini,
  );
  return map.values().next().value ?? { lines: deterministicSplitLines(rawTargetParagraph, sourceRows, rule), usedAi: false };
}

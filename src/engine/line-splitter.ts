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
  suppressAutoEllipsis?: boolean;
}

export interface SplitResult {
  lines: string[];
  usedAi: boolean;
  hasInversion?: boolean;
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
          hasInversion: { type: "boolean" },
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

function hasNonLeadingOmission(row: ScriptRow): boolean {
  if (row.remark.includes("有省略")) return true;
  const stripLead = (s: string) =>
    (s || "").trim().replace(/^["“«„'‘(\[\s]*(?:……|\.\.\.|…|\[\.\.\.\]|\(\.\.\.\))\s*/u, "");
  const zhRest = stripLead(row.chinese);
  const enRest = stripLead(row.english);
  return zhRest.includes("……") || enRest.includes("…") || enRest.includes("...");
}

function encodeThaiDoubleSpaces(text: string, rule: PunctuationRule): string {
  if (rule.langCode !== "th") return text;
  return text.replace(/ {2,}/g, " @ ");
}

function decodeThaiDoubleSpaces(text: string, rule: PunctuationRule): string {
  if (rule.langCode !== "th") return text;
  return text
    .replace(/\s*@\s*/g, "  ")
    .replace(/^ {2,}/, "")
    .replace(/ {2,}$/, "");
}

/**
 * Post-slice boundary repair:
 * 1. If line[i] ends with sentence punctuation (.?!。！？) followed by 1 dangling sentence-starter word
 *    (e.g. "...Tuhan. Jika" or "...обов'язку. Це"), shift that word to the start of line[i+1].
 * 2. If the LAST line ends with sentence punctuation followed by 1 leaked next-sentence word
 *    (e.g. "...Sang Pencipta. “Terang", "...semacam ini. Oleh", "...Творця. Це") while the
 *    last source row clearly ends at a sentence boundary (.?!。！？), trim the leaked trailing word.
 */
function repairDanglingSentenceStarters(lines: string[], sourceRows: ScriptRow[]): string[] {
  const out = [...lines];
  const trailingWordAfterSentenceRe = /^([\s\S]+?[.!?。！？])\s+([«„“"']?[\p{Lu}\p{Lt}][\p{L}\p{M}'’-]*[,，]?)$/u;

  for (let i = 0; i < out.length - 1; i += 1) {
    const m = trailingWordAfterSentenceRe.exec(out[i]);
    if (!m) continue;
    const nextLine = out[i + 1].trim();
    // Only shift if next line does NOT start with an uppercase sentence starter or opening quote
    if (nextLine && !/^[«„“"'A-ZА-ЯЁІЇЄҐ]/u.test(nextLine)) {
      out[i] = m[1].trim();
      out[i + 1] = `${m[2]} ${nextLine}`.trim();
    }
  }

  // Trim leaked 1-word next-sentence prefix on the very last line
  const lastIdx = out.length - 1;
  if (lastIdx >= 0) {
    const srcLast = sourceRows[lastIdx];
    const srcEndsSentence = /[.!?。！？]["”»'’]*$/u.test((srcLast?.english || srcLast?.chinese || "").trim());
    if (srcEndsSentence) {
      const m = trailingWordAfterSentenceRe.exec(out[lastIdx]);
      if (m) {
        out[lastIdx] = m[1].trim();
      }
    }
  }

  return out;
}

export function sliceTokensBySpans(
  tokens: string[],
  joinSep: string,
  spans: TokenSpan[],
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  suppressAutoEllipsis = false,
): string[] | null {
  if (!Array.isArray(spans) || spans.length !== sourceRows.length || tokens.length === 0) return null;
  let prevEnd = -1;
  const out: string[] = [];

  for (let i = 0; i < spans.length; i += 1) {
    const sp = spans[i];
    if (typeof sp?.start !== "number" || typeof sp?.end !== "number") return null;
    let start = Math.round(sp.start);
    let end = Math.round(sp.end);

    // Tolerate minor off-by-one boundary slips from fast Flash-Lite models without dropping the whole block
    if (end >= tokens.length) end = tokens.length - 1;
    if (start < 0) start = 0;
    if (i > 0 && start <= prevEnd && prevEnd + 1 <= end) start = prevEnd + 1;
    if (start > end) {
      if (prevEnd + 1 < tokens.length) {
        start = prevEnd + 1;
        end = Math.min(tokens.length - 1, start);
      } else {
        return null;
      }
    }
    prevEnd = end;

    let chunk = decodeThaiDoubleSpaces(tokens.slice(start, end + 1).join(joinSep).trim(), rule);
    if (!chunk) return null;

    const row = sourceRows[i];
    if (sp.cap || (i === 0 && row.remark.includes("涉及截取"))) {
      chunk = capitalizeFirstLetter(chunk);
    }
    const wantsEllipsis =
      !suppressAutoEllipsis && (sp.ellipsis || hasNonLeadingOmission(row));
    if (wantsEllipsis && !chunk.endsWith(rule.ellipsis) && !chunk.endsWith("...") && !chunk.endsWith("…")) {
      chunk = `${chunk} ${rule.ellipsis}`;
    }
    out.push(chunk);
  }
  return repairDanglingSentenceStarters(out, sourceRows);
}

const SINGLE_TEXT_SCHEMA = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" } },
  },
  required: ["lines"],
};

function verifyOrderedSubstrings(sourceText: string, lines: string[]): boolean {
  const norm = (s: string) =>
    s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const full = norm(sourceText);
  if (!full) return false;
  let cursor = 0;
  for (const l of lines) {
    const k = norm(l);
    if (!k) continue;
    const pos = full.indexOf(k, cursor);
    if (pos < 0) return false;
    cursor = pos + k.length;
  }
  return true;
}

async function retrySingleBlockWithTextAlignment(
  req: BatchSplitRequest,
  rule: PunctuationRule,
  gemini: GeminiPoolClient,
): Promise<string[] | null> {
  try {
    const rowsSpec = req.sourceRows
      .map((r, i) => `[${i + 1}] ZH: ${r.chinese} | EN: ${r.english}${r.remark ? ` | 备注: ${r.remark}` : ""}`)
      .join("\n");
    const res = await gemini.generateStructuredJson<{ lines: string[] }>({
      systemInstruction:
        "你是多语种影视字幕逐行切分助手。将给定的目标语定稿原文严格按各行中英文语义边界切分为完全相同行数的数组。严禁改写、重译或编造任何词，所有文字必须原封不动来自定稿原文；不加最外层双引号。",
      userPrompt: `目标语种：${rule.langName}\n${req.referenceEn ? `原段英文参考：${req.referenceEn}\n` : ""}定稿原文：\n${stripOuterDoubleQuotes(req.aiSourceText)}\n\n目标字幕行（共 ${req.sourceRows.length} 行，返回数组长度必须严格等于 ${req.sourceRows.length}）：\n${rowsSpec}`,
      jsonSchema: SINGLE_TEXT_SCHEMA,
    });
    if (
      Array.isArray(res.lines) &&
      res.lines.length === req.sourceRows.length &&
      res.lines.every((l) => l.trim().length > 0) &&
      verifyOrderedSubstrings(req.aiSourceText, res.lines)
    ) {
      return res.lines.map((l) => l.trim());
    }
  } catch {
    // ignore retry failure
  }
  return null;
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
      hasNonLeadingOmission(sourceRows[i]) &&
      !chunk.endsWith(rule.ellipsis) &&
      !chunk.endsWith("...") &&
      !chunk.endsWith("…")
    ) {
      chunk = `${chunk} ${rule.ellipsis}`;
    }
    lines.push(chunk);
    wordCursor = bestEnd;
  }

  return lines;
}

const SYSTEM_PROMPT =
  "你是多语种影视字幕词序号精准定位助手。每个任务提供带 [0][1][2]... 编号的目标语定稿原文（不可更改的字符串流 Fixed String），以及需要 1:1 对齐的若干行中英文字幕。请为每一行返回对应的起止词编号 {start, end}（闭区间，含首尾）。\n" +
  "核心硬性规则：\n" +
  "1. 绝对忠于原文：只输出 JSON 词序号，严禁改写、增删、润色或调整原文语序。若目标语存在倒装句，保持原语序正常分行，并在任务结果中设 hasInversion:true。\n" +
  "2. 【核心重审项】行首/行尾边界词严格切齐：\n" +
  "   - 绝不能把属于下一行开头的连接词或新句首词（如 and/dan/Jika/Mengapa/Sebaliknya/Це/Щоб/Тільки/Отже/比如/例如/所以/破折号引语等）留在上一行行末！\n" +
  "   - 绝不能在最后一行多带下一句的第 1 个词（若本段以句号/问号/感叹号结束，end 必须精准停在句末标点所在的词）。\n" +
  "3. 局部截取与省略：若目标语原文比中/英文长，只选取与中/英文语义完全对应的词段（多余部分舍弃）；若某行备注有省略或含……，可跳过中间词并设 ellipsis:true；若首行备注涉及截取且去掉了句首词，从新句首词开始并设 cap:true。\n" +
  "4. 泰语特殊规则：泰文中的 @ 符号代表双空格断句符，切分时保留 @ 不得删除。";

export async function batchSplitTargetsWithAi(
  requests: BatchSplitRequest[],
  rule: PunctuationRule,
  gemini?: GeminiPoolClient,
): Promise<Map<string, SplitResult>> {
  const resultMap = new Map<string, SplitResult>();
  if (requests.length === 0) return resultMap;

  if (!gemini?.hasKeys) {
    for (const req of requests) {
      resultMap.set(req.id, {
        lines: repairDanglingSentenceStarters(deterministicSplitLines(req.fallbackText, req.sourceRows, rule), req.sourceRows),
        usedAi: false,
      });
    }
    return resultMap;
  }

  // Pack up to 6 blocks (<= 36k chars) per API request to accommodate long passages comfortably
  const batches: BatchSplitRequest[][] = [];
  let curBatch: BatchSplitRequest[] = [];
  let curChars = 0;
  for (const req of requests) {
    const est = req.aiSourceText.length + (req.referenceEn?.length ?? 0) + req.sourceRows.length * 120;
    if (curBatch.length >= 6 || (curBatch.length > 0 && curChars + est > 36000)) {
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
        const prepared = encodeThaiDoubleSpaces(req.aiSourceText, rule);
        const tk = tokenizeForIndexing(prepared);
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
        results: Array<{ id: string; hasInversion?: boolean; spans: TokenSpan[] }>;
      }>({
        systemInstruction: SYSTEM_PROMPT,
        userPrompt: blocksPrompt,
        jsonSchema: BATCH_SPAN_SCHEMA,
      });

      const byId = new Map((res.results ?? []).map((item) => [item.id, item]));
      let aiHits = 0;
      for (const req of batch) {
        const tk = tokenized.get(req.id)!;
        const item = byId.get(req.id);
        const spans = item?.spans;
        const sliced = spans
          ? sliceTokensBySpans(tk.tokens, tk.joinSep, spans, req.sourceRows, rule, Boolean(req.suppressAutoEllipsis))
          : null;
        if (sliced) {
          resultMap.set(req.id, { lines: sliced, usedAi: true, hasInversion: Boolean(item?.hasInversion) });
          aiHits += 1;
        } else {
          const retried = await retrySingleBlockWithTextAlignment(req, rule, gemini);
          if (retried) {
            resultMap.set(req.id, {
              lines: repairDanglingSentenceStarters(retried, req.sourceRows),
              usedAi: true,
            });
            aiHits += 1;
          } else {
            diagLog.warn(
              "AI 词序号校验回退",
              `[${rule.langName}] 任务 ${req.id} (返回 ${spans?.length ?? 0} 段 / 需要 ${req.sourceRows.length} 行，词数 ${tk.tokens.length}) 未通过校验，已回退本地切分`,
            );
            resultMap.set(req.id, {
              lines: repairDanglingSentenceStarters(deterministicSplitLines(req.fallbackText, req.sourceRows, rule), req.sourceRows),
              usedAi: false,
            });
          }
        }
      }
      diagLog.info("AI 批量分句", `[${rule.langName}] 本批 ${batch.length} 块，词序号精准命中 ${aiHits} 块`);
    } catch (err) {
      diagLog.warn("AI 批量分句回退", `[${rule.langName}] 本批 ${batch.length} 块调用失败，已回退本地切分`, err instanceof Error ? err.message : String(err));
      for (const req of batch) {
        resultMap.set(req.id, {
          lines: repairDanglingSentenceStarters(deterministicSplitLines(req.fallbackText, req.sourceRows, rule), req.sourceRows),
          usedAi: false,
        });
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
  opts?: { fullParagraphTarget?: string; referenceEn?: string; isPartial?: boolean; suppressAutoEllipsis?: boolean },
): Promise<SplitResult> {
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
        suppressAutoEllipsis: opts?.suppressAutoEllipsis,
      },
    ],
    rule,
    gemini,
  );
  return (
    map.values().next().value ?? {
      lines: repairDanglingSentenceStarters(deterministicSplitLines(rawTargetParagraph, sourceRows, rule), sourceRows),
      usedAi: false,
    }
  );
}

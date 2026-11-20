import type { GeminiPoolClient } from "../ai/gemini-client";
import { diagLog } from "../platform/diag-log";
import type { PunctuationRule, ScriptRow } from "../types/domain";
import { stripOuterDoubleQuotes } from "./punctuation";
import { parseTruncationSpec } from "./text-matcher";

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

const DIRECT_BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          hasInversion: { type: "boolean" },
          lines: { type: "array", items: { type: "string" } },
        },
        required: ["id", "lines"],
      },
    },
  },
  required: ["results"],
};

const REVIEW_SINGLE_SCHEMA = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" } },
  },
  required: ["lines"],
};

export function capitalizeFirstLetter(text: string): string {
  return text.replace(/^([^\p{L}]*)(\p{L})/u, (_m, pre: string, ch: string) =>
    `${pre}${ch.toUpperCase()}`,
  );
}

function hasExplicitTextTrailingEllipsis(row: ScriptRow): boolean {
  const stripQuotes = (s: string) => (s || "").trim().replace(/["”»'’)\]]+$/u, "").trim();
  const zh = stripQuotes(row.chinese);
  const en = stripQuotes(row.english);
  return (
    /(?:……|\.\.\.|…)$/u.test(zh) ||
    /(?:……|\.\.\.|…|\[\.\.\.\]|\(\.\.\.\))$/u.test(en)
  );
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

export function tokenizeForIndexing(text: string): { tokens: string[]; joinSep: string } {
  const clean = stripOuterDoubleQuotes(text).trim();
  const spaceWords = clean.split(/\s+/).filter(Boolean);
  if (spaceWords.length >= 6 || !/[\u3040-\u30ff\u0e00-\u0e7f\u1780-\u17ff\u1000-\u109f\u4e00-\u9fff]/u.test(clean)) {
    return { tokens: spaceWords, joinSep: " " };
  }
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

const TRAILING_CONJUNCTION_WORDS = new Set([
  // Indonesian / Malay
  "dan", "atau", "tetapi", "tapi", "namun", "melainkan", "jadi", "maka", "jika", "kalau", "bila",
  "apabila", "sekalipun", "meskipun", "walaupun", "karena", "sebab", "serta", "daripada", "untuk",
  "bahwa", "yang", "sehingga", "sebaliknya",
  // Ukrainian / Russian / Slavic
  "й", "і", "та", "а", "але", "проте", "однак", "радше", "то", "отже", "тому", "якщо", "коли",
  "хоча", "бо", "оскільки", "ніж", "щоб", "аби", "який", "яка", "яке", "які", "якою", "що", "чи",
  "незалежно", "и", "но", "или", "если", "хотя", "потому", "поэтому", "чтобы",
  // Romance / Germanic / English
  "and", "or", "but", "so", "if", "when", "while", "although", "because", "since", "than",
  "y", "e", "o", "u", "pero", "sino", "si", "aunque", "porque", "para", "que",
  "et", "ou", "mais", "si", "car", "pour", "und", "oder", "aber", "wenn", "weil", "dass",
]);

const EN_TRAILING_CONJ_RE = /\b(?:and|or|to|that|for|of|in|with)$/i;

/**
 * Bilingual post-split boundary auditor & deterministic repair:
 * 1. Moves trailing conjunctions/clause-starters (e.g. "...триматися, і", "...Sang Pencipta, dan")
 *    from end of line[i] to start of line[i+1] when EN[i] does not end with a conjunction.
 * 2. Moves dangling words after sentence-ending punctuation (. ? ! ;) on line[i] to line[i+1]
 *    when EN[i] ends at that sentence boundary, and trims leaked next-sentence words on the last line.
 * 3. Applies sentence-start capitalization for rows marked with 截取 and explicit trailing ellipsis.
 */
export function auditAndRepairBilingualAlignment(
  rawLines: string[],
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  suppressAutoEllipsis = false,
): string[] {
  const out = rawLines.map((l) => l.trim());
  if (out.length === 0) return out;

  // Pass A: Move dangling words after sentence-ending punctuation (. ? ! ;) when EN[i] ends a sentence
  const afterSentenceSplitRe = /^([\s\S]+?[.!?。！？;；])\s+([^\s].*)$/u;
  for (let i = 0; i < out.length - 1; i += 1) {
    const enTrim = stripOuterDoubleQuotes(sourceRows[i]?.english || "").trim();
    const zhTrim = stripOuterDoubleQuotes(sourceRows[i]?.chinese || "").trim();
    const srcEndsSentence = /[.!?。！？;；]$/u.test(enTrim) || (!enTrim && /[。！？；]$/u.test(zhTrim));
    if (!srcEndsSentence) continue;

    const m = afterSentenceSplitRe.exec(out[i]);
    if (m) {
      const tailWords = m[2].trim().split(/\s+/);
      // Only shift short 1..2 word leaked starters (e.g. "Jika", "Mengapa", "Бог", "Це", "Тільки")
      if (tailWords.length <= 2) {
        out[i] = m[1].trim();
        out[i + 1] = `${m[2].trim()} ${out[i + 1]}`.trim();
      }
    }
  }

  // Pass B: Move trailing conjunctions (", dan", ", і", " й", " то", " якщо") from end of line[i] to start of line[i+1]
  const trailingConjRe = /^([\s\S]+?)([,，;；–—-]?)\s+([\p{L}\p{M}'’-]+)[,，]?$/u;
  for (let i = 0; i < out.length - 1; i += 1) {
    const enCur = stripOuterDoubleQuotes(sourceRows[i]?.english || "").trim();
    if (EN_TRAILING_CONJ_RE.test(enCur)) continue;

    const m = trailingConjRe.exec(out[i]);
    if (!m) continue;
    const prefix = m[1].trim();
    const punctBeforeWord = m[2] || "";
    const lastWordRaw = m[3];
    const lastWordLow = lastWordRaw.toLowerCase();

    if (prefix.length >= 4 && TRAILING_CONJUNCTION_WORDS.has(lastWordLow)) {
      const hadTrailingCommaAfterWord = out[i].endsWith(",") && !lastWordRaw.endsWith(",");
      const movedWord = hadTrailingCommaAfterWord ? `${lastWordRaw},` : lastWordRaw;
      out[i] = `${prefix}${punctBeforeWord}`.trim();
      out[i + 1] = `${movedWord} ${out[i + 1]}`.trim();
    }
  }

  // Pass C: Trim leaked 1-word next-sentence starter on the very last line
  const lastIdx = out.length - 1;
  if (lastIdx >= 0) {
    const srcLast = sourceRows[lastIdx];
    const srcEndsSentence = /[.!?。！？]["”»'’]*$/u.test((srcLast?.english || srcLast?.chinese || "").trim());
    if (srcEndsSentence) {
      const m = /^([\s\S]+?[.!?。！？])\s+([«„“"']?[\p{Lu}\p{Lt}][\p{L}\p{M}'’-]*[,，]?)$/u.exec(out[lastIdx]);
      if (m) {
        out[lastIdx] = m[1].trim();
      }
    }
  }

  // Pass D: Row-level truncation capitalization & explicit ellipsis
  for (let i = 0; i < out.length; i += 1) {
    const row = sourceRows[i];
    if (!row) continue;
    const trunc = parseTruncationSpec(row);
    const enStartsUpper = /^[A-Z]/.test(stripOuterDoubleQuotes(row.english || "").trim());
    if (trunc.hasTruncation && (i === 0 || enStartsUpper || Boolean(trunc.deletedEnPrefix))) {
      out[i] = capitalizeFirstLetter(out[i]);
    }
    if (
      !suppressAutoEllipsis &&
      hasExplicitTextTrailingEllipsis(row) &&
      !out[i].endsWith(rule.ellipsis) &&
      !out[i].endsWith("...") &&
      !out[i].endsWith("…")
    ) {
      out[i] = `${out[i]} ${rule.ellipsis}`;
    }
  }

  return out;
}

/**
 * Projects AI-returned lines back onto the exact verbatim character stream of `sourceText`
 * so zero words, letters, or punctuation marks can ever be altered or hallucinated by AI!
 */
export function projectLinesOntoVerbatimSource(
  sourceText: string,
  aiLines: string[],
): string[] | null {
  const cleanSrc = stripOuterDoubleQuotes(sourceText).replace(/\s+/g, " ").trim();
  if (!cleanSrc || aiLines.length === 0) return null;
  if (aiLines.some((l) => !l || !l.trim())) return null;

  // Build normalized alphanumeric index -> raw index map on cleanSrc
  const normChars: string[] = [];
  const normToRawStart: number[] = [];
  const normToRawEnd: number[] = [];
  const srcCodePoints = [...cleanSrc];
  let rawBytePos = 0;
  for (const ch of srcCodePoints) {
    const nextBytePos = rawBytePos + ch.length;
    const n = ch.normalize("NFKC").toLowerCase();
    if (/[\p{L}\p{N}]/u.test(n)) {
      for (const nc of n) {
        normChars.push(nc);
        normToRawStart.push(rawBytePos);
        normToRawEnd.push(nextBytePos);
      }
    }
    rawBytePos = nextBytePos;
  }
  const fullNorm = normChars.join("");
  if (!fullNorm) return null;

  const normStr = (s: string) =>
    [...s.normalize("NFKC").toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");

  const spansNorm: Array<{ nStart: number; nEnd: number }> = [];
  let cursor = 0;
  for (let i = 0; i < aiLines.length; i += 1) {
    const k = normStr(aiLines[i]);
    if (!k) return null;
    const pos = fullNorm.indexOf(k, cursor);
    if (pos < 0) return null;
    spansNorm.push({ nStart: pos, nEnd: pos + k.length - 1 });
    cursor = pos + k.length;
  }

  // Convert normalized spans back into exact verbatim slices of cleanSrc, preserving trailing punctuation of each line!
  const verbatimLines: string[] = [];
  const firstRawStart = normToRawStart[spansNorm[0].nStart];
  // Include any leading inner quote right before firstRawStart (e.g. ' or " or «)
  let blockStart = firstRawStart;
  while (blockStart > 0 && !/\s/.test(cleanSrc[blockStart - 1])) {
    blockStart -= 1;
  }

  let curRawStart = blockStart;
  for (let i = 0; i < spansNorm.length; i += 1) {
    if (i < spansNorm.length - 1) {
      const curRawWordEnd = normToRawEnd[spansNorm[i].nEnd];
      const nextRawWordStart = normToRawStart[spansNorm[i + 1].nStart];
      const gap = cleanSrc.slice(curRawWordEnd, nextRawWordStart);
      // Split gap at whitespace so trailing punctuation stays on line[i] and leading quote stays on line[i+1]!
      const wsMatch = /\s+/u.exec(gap);
      const cutPos = wsMatch ? curRawWordEnd + wsMatch.index : nextRawWordStart;
      verbatimLines.push(cleanSrc.slice(curRawStart, cutPos).trim());
      curRawStart = wsMatch ? curRawWordEnd + wsMatch.index + wsMatch[0].length : nextRawWordStart;
    } else {
      const lastWordEnd = normToRawEnd[spansNorm[i].nEnd];
      // Include trailing punctuation attached to the final word (up to whitespace)
      let endPos = lastWordEnd;
      while (endPos < cleanSrc.length && !/\s/.test(cleanSrc[endPos])) {
        endPos += 1;
      }
      verbatimLines.push(cleanSrc.slice(curRawStart, endPos).trim());
    }
  }

  return verbatimLines.every((l) => l.length > 0) ? verbatimLines : null;
}

function countQuestionMarks(s: string): number {
  return (s.match(/[?？]/g) || []).length;
}

function hasStructuralBilingualMismatch(lines: string[], sourceRows: ScriptRow[]): boolean {
  if (lines.length !== sourceRows.length || lines.length <= 1) return false;
  const totalTg = lines.reduce((a, b) => a + b.length, 0);
  const totalEn = sourceRows.reduce((a, r) => a + (r.english || r.chinese).length, 0);
  if (totalTg === 0 || totalEn === 0) return false;

  for (let i = 0; i < lines.length; i += 1) {
    const en = (sourceRows[i].english || sourceRows[i].chinese || "").trim();
    const tg = lines[i].trim();
    // Question-mark count mismatch (catches Ukrainian Row 521 2-questions-in-1-row split!)
    if (countQuestionMarks(en) !== countQuestionMarks(tg)) return true;
    // Severe length proportion skew
    if (en.length >= 15) {
      const enShare = en.length / totalEn;
      const tgShare = tg.length / totalTg;
      const ratio = tgShare / Math.max(0.02, enShare);
      if (ratio < 0.36 || ratio > 2.45) return true;
    }
  }
  return false;
}

async function reviewAndFixSplitWithAi(
  draftLines: string[],
  sourceText: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini: GeminiPoolClient,
): Promise<string[] | null> {
  try {
    const tableSpec = sourceRows
      .map(
        (r, i) =>
          `[${i + 1}]\n  中文: ${r.chinese}\n  英文: ${r.english}\n  当前外文切分: ${draftLines[i]}`,
      )
      .join("\n");
    const fullConcat = draftLines.join(" ");
    const res = await gemini.generateStructuredJson<{ lines: string[] }>({
      systemInstruction:
        "你是多语种剧本三语分行校对专家。请逐行核对下面每一行的【中文】【英文】与【当前外文切分】行首、行尾词义和问号/句号数量是否完全切齐。\n" +
        "硬性要求：\n" +
        "1. 严禁修改、增删或调换任何外文单词与标点！把你修正后的全部外文行用空格拼起来，必须与输入的当前外文总串一字不差！\n" +
        "2. 只移动断行位置：严查连接词（如 and/dan/й/і/та/то/якщо/比如/所以）、多问句同行（如英文一行有两个问号，外文也必须两个问号在同一行）的跨行错位，修正后返回严格相同行数的 lines 数组。",
      userPrompt: `目标语种：${rule.langName}（共 ${sourceRows.length} 行）\n不可改动的完整外文串：\n${fullConcat}\n\n逐行三语对照：\n${tableSpec}`,
      jsonSchema: REVIEW_SINGLE_SCHEMA,
    });
    if (Array.isArray(res.lines) && res.lines.length === sourceRows.length) {
      return projectLinesOntoVerbatimSource(sourceText, res.lines);
    }
  } catch {
    // ignore review error and keep draftLines
  }
  return null;
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

    if (end >= tokens.length) end = tokens.length - 1;
    if (start < 0) start = 0;
    // Strict monotonic forward progression: reject backward/duplicate overlaps!
    if (i > 0 && start <= prevEnd) {
      if (prevEnd + 1 <= end) {
        start = prevEnd + 1;
      } else {
        return null;
      }
    }
    if (start > end) return null;
    prevEnd = end;

    let chunk = decodeThaiDoubleSpaces(tokens.slice(start, end + 1).join(joinSep).trim(), rule);
    if (!chunk) return null;
    if (sp.cap) chunk = capitalizeFirstLetter(chunk);
    out.push(chunk);
  }
  return auditAndRepairBilingualAlignment(out, sourceRows, rule, suppressAutoEllipsis);
}

export function deterministicSplitLines(
  rawTargetParagraph: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
): string[] {
  const count = sourceRows.length;
  const cleanTarget = stripOuterDoubleQuotes(rawTargetParagraph);
  if (count <= 1) {
    let single = cleanTarget;
    const trunc0 = parseTruncationSpec(sourceRows[0]);
    if (trunc0.hasTruncation && trunc0.deletedEnPrefix.endsWith(",")) {
      const commaIdx = single.indexOf(",");
      if (commaIdx > 0 && commaIdx < single.length * 0.35) {
        single = capitalizeFirstLetter(single.slice(commaIdx + 1).trim());
      }
    }
    return [single];
  }

  let workingText = cleanTarget;
  const trunc0 = parseTruncationSpec(sourceRows[0]);
  if (trunc0.hasTruncation && trunc0.deletedEnPrefix) {
    const fullLen = Math.max(1, trunc0.fullEnSentence.length);
    const dropRatio = trunc0.deletedEnPrefix.length / fullLen;
    if (dropRatio > 0.05 && dropRatio < 0.6) {
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

    lines.push(words.slice(wordCursor, bestEnd).join(" "));
    wordCursor = bestEnd;
  }

  return auditAndRepairBilingualAlignment(lines, sourceRows, rule);
}

const DIRECT_SPLIT_SYSTEM_PROMPT =
  "你是多语种影视剧本文本 1:1 物理断行专家。每个任务给你一段目标语定稿原文（不可更改的字符串流 Fixed String）以及已分行好的中英文对照行。请将目标语定稿原文严格按每行中英文语义 1:1 切分为完全相同行数的 lines 数组。\n" +
  "硬性铁律：\n" +
  "1. 【零改动原文】：严禁修改、增删、替换任何单词或标点！切分后的各行来自定稿原文的连续原文字串（不加最外层总引号）。若目标语有倒装句，保持原语序正常分行并设 hasInversion:true。\n" +
  "2. 【局部摘录与句首截取】：若定稿原段开头或结尾包含未在中英文行里出现的句子，只截取与中英文行完全对应的那一段（多余句子舍弃，绝不多带下一句第 1 个词！）。若某行标注了『已删句首英文：...』，在目标语中也同步去掉对应的句首词组。\n" +
  "3. 【行首行尾与标点强对齐】：\n" +
  "   - 若某行英文包含两个问号（? ... ?），目标语该行也必须包含对应的两个问句，绝不能拆到下一行导致后续全部错位！\n" +
  "   - 下一行英文以连词/引导词（and, or, if, so, rather, when, although 等）开头时，目标语对应的连词（如 dan/atau/jika/й/і/та/то/якщо/радше 等）必须放在下一行行首，绝不能留在上一行行末！\n" +
  "4. 泰语中的 @ 代表双空格断句符，切分时保留 @ 不得删除。";

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
        lines: deterministicSplitLines(req.fallbackText, req.sourceRows, rule),
        usedAi: false,
      });
    }
    return resultMap;
  }

  // Pack at most 2 blocks (<= 14k chars) per request so Flash-Lite gives maximum per-line precision!
  const batches: BatchSplitRequest[][] = [];
  let curBatch: BatchSplitRequest[] = [];
  let curChars = 0;
  for (const req of requests) {
    const est = req.aiSourceText.length + (req.referenceEn?.length ?? 0) + req.sourceRows.length * 140;
    if (curBatch.length >= 2 || (curBatch.length > 0 && curChars + est > 14000)) {
      batches.push(curBatch);
      curBatch = [];
      curChars = 0;
    }
    curBatch.push(req);
    curChars += est;
  }
  if (curBatch.length > 0) batches.push(curBatch);

  for (const batch of batches) {
    const blocksPrompt = batch
      .map((req) => {
        const preparedSrc = stripOuterDoubleQuotes(encodeThaiDoubleSpaces(req.aiSourceText, rule));
        const rowsSpec = req.sourceRows
          .map((r, i) => {
            const tr = parseTruncationSpec(r);
            const truncNote = tr.deletedEnPrefix
              ? ` | 【注意：句首已截取删去英文 "${tr.deletedEnPrefix}"，请同步截去对应目标语词组】`
              : tr.hasTruncation
                ? ` | 备注: ${r.remark}`
                : "";
            return `  (${i + 1}) ZH: ${r.chinese} | EN: ${r.english}${truncNote}`;
          })
          .join("\n");
        const refEnLine = req.referenceEn ? `原段完整英文参考：\n${req.referenceEn}\n` : "";
        return `### 任务ID: ${req.id}\n${refEnLine}目标语定稿原文（${rule.langName}）：\n${preparedSrc}\n需 1:1 对齐切分的字幕行（必须严格返回 ${req.sourceRows.length} 行）：\n${rowsSpec}`;
      })
      .join("\n\n");

    try {
      const res = await gemini.generateStructuredJson<{
        results: Array<{ id: string; hasInversion?: boolean; lines?: string[]; spans?: TokenSpan[] }>;
      }>({
        systemInstruction: DIRECT_SPLIT_SYSTEM_PROMPT,
        userPrompt: blocksPrompt,
        jsonSchema: DIRECT_BATCH_SCHEMA,
      });

      const byId = new Map((res.results ?? []).map((item) => [item.id, item]));
      let aiHits = 0;

      for (const req of batch) {
        const item = byId.get(req.id);
        const preparedSrc = encodeThaiDoubleSpaces(req.aiSourceText, rule);
        let projected =
          item && Array.isArray(item.lines) && item.lines.length === req.sourceRows.length
            ? projectLinesOntoVerbatimSource(preparedSrc, item.lines)
            : null;

        // Backward-compatible fallback if a caller/mock returned token spans instead of lines
        if (!projected && item && Array.isArray(item.spans)) {
          const tk = tokenizeForIndexing(preparedSrc);
          const spanSliced = sliceTokensBySpans(
            tk.tokens,
            tk.joinSep,
            item.spans,
            req.sourceRows,
            rule,
            Boolean(req.suppressAutoEllipsis),
          );
          if (spanSliced) {
            resultMap.set(req.id, {
              lines: spanSliced,
              usedAi: true,
              hasInversion: Boolean(item.hasInversion),
            });
            aiHits += 1;
            continue;
          }
        }

        if (projected) {
          let decoded = projected.map((l) => decodeThaiDoubleSpaces(l, rule));
          decoded = auditAndRepairBilingualAlignment(
            decoded,
            req.sourceRows,
            rule,
            Boolean(req.suppressAutoEllipsis),
          );

          // Step 3 Closed-Loop Self-Review: if punctuation/question count or length ratio looks skewed,
          // run a targeted 2nd-pass AI review against Chinese & English!
          if (hasStructuralBilingualMismatch(decoded, req.sourceRows)) {
            const reviewed = await reviewAndFixSplitWithAi(
              decoded,
              preparedSrc,
              req.sourceRows,
              rule,
              gemini,
            );
            if (reviewed) {
              decoded = auditAndRepairBilingualAlignment(
                reviewed.map((l) => decodeThaiDoubleSpaces(l, rule)),
                req.sourceRows,
                rule,
                Boolean(req.suppressAutoEllipsis),
              );
            }
          }

          resultMap.set(req.id, {
            lines: decoded,
            usedAi: true,
            hasInversion: Boolean(item?.hasInversion),
          });
          aiHits += 1;
        } else {
          diagLog.warn(
            "AI 分句校验回退",
            `[${rule.langName}] 任务 ${req.id} (返回 ${item?.lines?.length ?? 0} 行 / 需要 ${req.sourceRows.length} 行) 未通过逐字无损校验，已回退本地切分`,
          );
          resultMap.set(req.id, {
            lines: deterministicSplitLines(req.fallbackText, req.sourceRows, rule),
            usedAi: false,
          });
        }
      }
      diagLog.info("AI 批量分句", `[${rule.langName}] 本批 ${batch.length} 块，逐字校验+中英复核命中 ${aiHits} 块`);
    } catch (err) {
      diagLog.warn(
        "AI 批量分句回退",
        `[${rule.langName}] 本批 ${batch.length} 块调用失败，已回退本地切分`,
        err instanceof Error ? err.message : String(err),
      );
      for (const req of batch) {
        resultMap.set(req.id, {
          lines: deterministicSplitLines(req.fallbackText, req.sourceRows, rule),
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
  const hasTrunc = sourceRows.some((r) => parseTruncationSpec(r).hasTruncation);
  const needAi = sourceRows.length > 1 || Boolean(opts?.isPartial) || hasTrunc;
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
      lines: deterministicSplitLines(rawTargetParagraph, sourceRows, rule),
      usedAi: false,
    }
  );
}

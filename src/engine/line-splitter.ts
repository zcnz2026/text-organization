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
  isPartial?: boolean;
  suppressAutoEllipsis?: boolean;
}

export interface SplitResult {
  lines: string[];
  usedAi: boolean;
  failed?: boolean;
  hasInversion?: boolean;
  errorReason?: string;
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
 * 1. Moves trailing conjunctions/clause-starters (e.g. "...триматися, і", "...rencana itu, dan")
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
      // Only shift short 1..2 word leaked starters (e.g. "Jika", "Mengapa", "Це", "Тільки")
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
      const wsMatch = /\s+/u.exec(gap);
      const cutPos = wsMatch ? curRawWordEnd + wsMatch.index : nextRawWordStart;
      verbatimLines.push(cleanSrc.slice(curRawStart, cutPos).trim());
      curRawStart = wsMatch ? curRawWordEnd + wsMatch.index + wsMatch[0].length : nextRawWordStart;
    } else {
      const lastWordEnd = normToRawEnd[spansNorm[i].nEnd];
      let endPos = lastWordEnd;
      while (endPos < cleanSrc.length && !/\s/.test(cleanSrc[endPos])) {
        endPos += 1;
      }
      verbatimLines.push(cleanSrc.slice(curRawStart, endPos).trim());
    }
  }

  return verbatimLines.every((l) => l.length > 0) ? verbatimLines : null;
}

const NO_STANDARD_PUNCT_LANGS = new Set(["th", "lo", "km", "my"]);

function countSrcQuestions(s: string): number {
  return (s.match(/[?？]/g) || []).length;
}

function countTargetQuestions(s: string, langCode: string): number {
  if (langCode === "el") return (s.match(/[?？;;]/g) || []).length;
  if (langCode === "ar") return (s.match(/[?？؟]/g) || []).length;
  if (langCode === "hy") return (s.match(/[?？՞]/g) || []).length;
  return (s.match(/[?？]/g) || []).length;
}

function cleanLineEndingForPunctCheck(s: string): string {
  return stripOuterDoubleQuotes((s || "").trim())
    .replace(/["”»'’)\]]+$/u, "")
    .trim();
}

function hasTrailingEllipsisMark(s: string): boolean {
  return /(?:……|\.\.\.|…|\[\.\.\.\]|\(\.\.\.\))$/u.test(cleanLineEndingForPunctCheck(s));
}

function endsWithStrongSentencePunct(s: string): boolean {
  const c = cleanLineEndingForPunctCheck(s);
  return !hasTrailingEllipsisMark(c) && /[.!?。！？।។။]$/u.test(c);
}

function endsWithCommaOrColonPunct(s: string): boolean {
  const c = cleanLineEndingForPunctCheck(s);
  return !hasTrailingEllipsisMark(c) && /[,，、:：]$/u.test(c);
}

/**
 * Strict 6-point bilingual structural & completeness validator.
 * Returns `null` when all checks pass, or a descriptive Chinese reason when misaligned.
 */
export function detectBilingualMisalignment(
  lines: string[],
  sourceRows: ScriptRow[],
  fullSourceText: string,
  rule: PunctuationRule,
  opts?: { isPartial?: boolean; hasTruncation?: boolean },
): string | null {
  if (lines.length !== sourceRows.length || lines.length === 0) {
    return `行数不匹配（返回 ${lines.length} 行，需 ${sourceRows.length} 行）`;
  }
  if (lines.some((l) => !l || !l.trim())) {
    return "存在空白切分行";
  }

  const isPartial = Boolean(opts?.isPartial);
  const hasTruncation =
    Boolean(opts?.hasTruncation) || sourceRows.some((r) => parseTruncationSpec(r).hasTruncation);
  const hasExplicitOmission = sourceRows.some(
    (r) =>
      r.remark.includes("有省略") ||
      r.chinese.includes("……") ||
      /(?:…|\.\.\.)["”»'’]*$/u.test((r.english || "").trim()),
  );

  // 1. Completeness / anti-dropped-tail & head check against fullSourceText
  const normAlnum = (s: string) =>
    [...stripOuterDoubleQuotes(s || "").normalize("NFKC").toLowerCase()]
      .filter((c) => /[\p{L}\p{N}]/u.test(c))
      .join("");

  const fullNorm = normAlnum(fullSourceText);
  if (fullNorm.length >= 10) {
    let cursor = 0;
    let firstStart = -1;
    let lastEnd = 0;
    let matchedLen = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const k = normAlnum(lines[i]);
      if (!k) return `第 ${i + 1} 行缺少有效文字`;
      const pos = fullNorm.indexOf(k, cursor);
      if (pos < 0) {
        return `第 ${i + 1} 行内容偏离定稿原文`;
      }
      if (i === 0) firstStart = pos;
      lastEnd = pos + k.length;
      matchedLen += k.length;
      cursor = lastEnd;
    }

    if (!isPartial && !hasTruncation && firstStart / fullNorm.length > 0.08) {
      return `句首漏句（仅从定稿原文 ${Math.round((firstStart / fullNorm.length) * 100)}% 处开始）`;
    }
    if (!isPartial && !hasExplicitOmission && lastEnd / fullNorm.length < 0.92) {
      return `句尾漏句（仅覆盖至定稿原文 ${Math.round((lastEnd / fullNorm.length) * 100)}% 处，遗漏尾部内容）`;
    }
    if (!isPartial && !hasTruncation && !hasExplicitOmission && matchedLen / fullNorm.length < 0.92) {
      return `整段覆盖率不足（仅覆盖定稿原文 ${Math.round((matchedLen / fullNorm.length) * 100)}%）`;
    }
  }

  // 2. Per-row question mark count equality
  for (let i = 0; i < lines.length; i += 1) {
    const srcRef = (sourceRows[i]?.english || sourceRows[i]?.chinese || "").trim();
    if (!srcRef) continue;
    const srcQ = countSrcQuestions(srcRef);
    const tgQ = countTargetQuestions(lines[i], rule.langCode);
    if (srcQ !== tgQ) {
      return `第 ${i + 1} 行问号数量不一致（源文 ${srcQ} 个 vs 目标语 ${tgQ} 个）`;
    }
  }

  // 3. Final row sentence-ending punctuation consistency
  if (!NO_STANDARD_PUNCT_LANGS.has(rule.langCode)) {
    const lastIdx = lines.length - 1;
    const lastSrc = (sourceRows[lastIdx]?.english || sourceRows[lastIdx]?.chinese || "").trim();
    const lastTg = lines[lastIdx].trim();
    if (endsWithStrongSentencePunct(lastSrc) && endsWithCommaOrColonPunct(lastTg)) {
      return `第 ${lastIdx + 1} 行（末行）句末标点错位（源文以句号/问号/叹号结束，目标语却以逗号/冒号结束，疑似漏掉末半句）`;
    }
  }

  // 4. Adjacent row period/comma swap & multi-row sentence-end punctuation drift
  if (!NO_STANDARD_PUNCT_LANGS.has(rule.langCode) && lines.length >= 2) {
    let punctContradictions = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const src = (sourceRows[i]?.english || sourceRows[i]?.chinese || "").trim();
      const tg = lines[i].trim();
      if (!src) continue;
      const srcStrong = endsWithStrongSentencePunct(src);
      const srcComma = endsWithCommaOrColonPunct(src);
      const tgStrong = endsWithStrongSentencePunct(tg);
      const tgComma = endsWithCommaOrColonPunct(tg);

      if ((srcStrong && tgComma) || (srcComma && tgStrong)) {
        punctContradictions += 1;
      }

      if (i < lines.length - 1) {
        const nextSrc = (sourceRows[i + 1]?.english || sourceRows[i + 1]?.chinese || "").trim();
        const nextTg = lines[i + 1].trim();
        const nextSrcStrong = endsWithStrongSentencePunct(nextSrc);
        const nextSrcComma = endsWithCommaOrColonPunct(nextSrc);
        const nextTgStrong = endsWithStrongSentencePunct(nextTg);
        const nextTgComma = endsWithCommaOrColonPunct(nextTg);

        if (
          (srcComma && tgStrong && nextSrcStrong && nextTgComma) ||
          (srcStrong && tgComma && nextSrcComma && nextTgStrong)
        ) {
          return `第 ${i + 1}~${i + 2} 行句末句号与逗号交叉错位（跨行顺延错行）`;
        }
      }
    }
    if (punctContradictions >= 2) {
      return `存在 ${punctContradictions} 行句末句号/逗号与源文矛盾（多行顺延错行）`;
    }
  }

  // 5. Per-row length share & extreme short/long mismatch
  if (lines.length >= 2) {
    const stripEllipsisAndQuotes = (s: string) =>
      stripOuterDoubleQuotes((s || "").trim())
        .replace(/(?:……|\.\.\.|…|\[\.\.\.\]|\(\.\.\.\))+$/u, "")
        .trim();

    const enLens = sourceRows.map((r) => stripEllipsisAndQuotes(r.english || "").length);
    const zhLens = sourceRows.map((r) => stripEllipsisAndQuotes(r.chinese || "").length);
    const tgLens = lines.map((l) => stripEllipsisAndQuotes(l || "").length);
    const useEn = enLens.every((len) => len > 0);
    const srcLens = useEn ? enLens : zhLens;
    const totalSrc = srcLens.reduce((a, b) => a + b, 0);
    const totalTg = tgLens.reduce((a, b) => a + b, 0);

    if (totalSrc > 0 && totalTg > 0) {
      for (let i = 0; i < lines.length; i += 1) {
        const enL = enLens[i];
        const zhL = zhLens[i];
        const tgL = tgLens[i];

        if (enL > 0 && enL <= 20 && tgL >= 65) {
          return `第 ${i + 1} 行长短严重错配（英文仅 ${enL} 字符，目标语长达 ${tgL} 字符）`;
        }
        if ((enL >= 15 || zhL >= 6) && tgL <= 3) {
          return `第 ${i + 1} 行目标语过短（仅 ${tgL} 字符）`;
        }

        const srcL = srcLens[i];
        const meetsMinLen = useEn ? enL >= 10 : zhL >= 4;
        if (meetsMinLen) {
          const srcShare = srcL / totalSrc;
          const tgShare = tgL / totalTg;
          const ratio = tgShare / Math.max(0.015, srcShare);
          if (ratio < 0.35 || ratio > 2.55) {
            return `第 ${i + 1} 行长度占比失衡（占比比值 ${ratio.toFixed(2)}，疑似跨行错位）`;
          }
        }
      }
    }
  }

  // 6. Whole-block total length ratio check (catches partial blocks that silently drop half the passage)
  const totalEnChars = sourceRows.reduce(
    (acc, r) => acc + stripOuterDoubleQuotes((r.english || "").trim()).length,
    0,
  );
  const totalTgChars = lines.reduce(
    (acc, l) => acc + stripOuterDoubleQuotes((l || "").trim()).length,
    0,
  );
  if (
    totalEnChars >= 40 &&
    /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(lines.join(""))
  ) {
    const blockRatio = totalTgChars / totalEnChars;
    if (blockRatio < 0.42 || blockRatio > 2.65) {
      return `整块外文与英文总长比例异常（${totalTgChars}/${totalEnChars} = ${blockRatio.toFixed(2)}，疑似漏句或多摘）`;
    }
  }

  return null;
}

export async function reviewAndFixSplitWithAi(
  draftLines: string[],
  sourceText: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini: GeminiPoolClient,
  misalignmentReason = "行间标点或长度占比未对齐",
  referenceEn?: string,
): Promise<string[] | null> {
  try {
    const fullCleanSource = stripOuterDoubleQuotes(sourceText).trim();
    const tableSpec = sourceRows
      .map(
        (r, i) =>
          `[${i + 1}]\n  中文: ${r.chinese}\n  英文: ${r.english}\n  当前错误切分: ${draftLines[i] ?? ""}`,
      )
      .join("\n");
    const refEnBlock = referenceEn ? `原段完整英文参考：\n${referenceEn}\n\n` : "";
    const res = await gemini.generateStructuredJson<{ lines: string[] }>({
      systemInstruction:
        "你是多语种剧本三语分行校对专家。当前外文切分被检出对齐错误，请基于【不可改动的完整外文串】重新与每一行的【中文】【英文】进行 1:1 严格对齐切分。\n" +
        "硬性要求：\n" +
        "1. 严禁修改、增删或调换任何外文单词与标点！所有切分出的行必须连续取自【不可改动的完整外文串】（若上一轮切分提前截断或漏掉了尾部句子，必须从完整外文串中找回补齐！）。\n" +
        "2. 只调整断行边界：严查句号/逗号错位、连接词（如 and/dan/й/і/та/то/якщо）、多问句同行的跨行错位，修正后返回严格等于字幕行数的 lines 数组。",
      userPrompt:
        `目标语种：${rule.langName}（共 ${sourceRows.length} 行）\n` +
        `检出问题：${misalignmentReason}\n` +
        refEnBlock +
        `不可改动的完整外文串：\n${fullCleanSource}\n\n` +
        `逐行三语对照：\n${tableSpec}`,
      jsonSchema: REVIEW_SINGLE_SCHEMA,
    });
    if (Array.isArray(res.lines) && res.lines.length === sourceRows.length) {
      return projectLinesOntoVerbatimSource(sourceText, res.lines);
    }
  } catch {
    // ignore review error; caller will re-run detectBilingualMisalignment and reject if still misaligned
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
  "   - 若某行英文以句号结束，目标语该行也必须在对应完整句句号处结束，绝不能在句中逗号处提前截断导致后续所有行顺延错位或丢掉结尾句！\n" +
  "   - 若某行英文包含问号（?），目标语该行必须包含相同数量的问号，绝不能把问句拆到其他行！\n" +
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
        lines: [],
        usedAi: false,
        failed: true,
        errorReason: "未配置可用 AI 密钥",
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
        const hasTruncInReq = req.sourceRows.some((r) => parseTruncationSpec(r).hasTruncation);
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
              failed: false,
              hasInversion: Boolean(item.hasInversion),
            });
            aiHits += 1;
            continue;
          }
        }

        // If batch item returned wrong line count or failed projection, retry this single block once directly
        let singleRetryErrText = "";
        if (!projected) {
          try {
            const singleRowsSpec = req.sourceRows
              .map((r, idx) => `(${idx + 1}) ZH: ${r.chinese} | EN: ${r.english}`)
              .join("\n");
            const singleRes = await gemini.generateStructuredJson<{ lines: string[] }>({
              systemInstruction: DIRECT_SPLIT_SYSTEM_PROMPT,
              userPrompt: `目标语种：${rule.langName}\n目标语定稿原文：\n${stripOuterDoubleQuotes(preparedSrc)}\n请严格切分为 ${req.sourceRows.length} 行（lines 数组长度必须等于 ${req.sourceRows.length}）：\n${singleRowsSpec}`,
              jsonSchema: REVIEW_SINGLE_SCHEMA,
            });
            if (Array.isArray(singleRes.lines) && singleRes.lines.length === req.sourceRows.length) {
              projected = projectLinesOntoVerbatimSource(preparedSrc, singleRes.lines);
            }
          } catch (retryErr) {
            singleRetryErrText = retryErr instanceof Error ? retryErr.message : String(retryErr);
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

          const alignOpts = {
            isPartial: Boolean(req.isPartial),
            hasTruncation: hasTruncInReq,
          };
          let misalignReason = detectBilingualMisalignment(
            decoded,
            req.sourceRows,
            preparedSrc,
            rule,
            alignOpts,
          );

          // Closed-Loop Self-Review: pass the FULL preparedSrc (never truncated draftLines) + specific reason
          if (misalignReason !== null) {
            const reviewed = await reviewAndFixSplitWithAi(
              decoded,
              preparedSrc,
              req.sourceRows,
              rule,
              gemini,
              misalignReason,
              req.referenceEn,
            );
            if (reviewed) {
              decoded = auditAndRepairBilingualAlignment(
                reviewed.map((l) => decodeThaiDoubleSpaces(l, rule)),
                req.sourceRows,
                rule,
                Boolean(req.suppressAutoEllipsis),
              );
              misalignReason = detectBilingualMisalignment(
                decoded,
                req.sourceRows,
                preparedSrc,
                rule,
                alignOpts,
              );
            }
          }

          if (misalignReason === null) {
            resultMap.set(req.id, {
              lines: decoded,
              usedAi: true,
              failed: false,
              hasInversion: Boolean(item?.hasInversion),
            });
            aiHits += 1;
          } else {
            diagLog.warn(
              "AI 分句双语核对未通过",
              `[${rule.langName}] 任务 ${req.id} (${misalignReason})，已按宁缺毋滥原则留空`,
            );
            resultMap.set(req.id, {
              lines: [],
              usedAi: false,
              failed: true,
              errorReason: `双语核对未通过：${misalignReason}`,
            });
          }
        } else {
          const reason = singleRetryErrText
            ? singleRetryErrText.slice(0, 120)
            : `AI 返回 ${item?.lines?.length ?? 0} 行（需 ${req.sourceRows.length} 行），未过行数/原文逐字校验`;
          diagLog.warn(
            "AI 分句校验未通过",
            `[${rule.langName}] 任务 ${req.id} (${reason})，已按宁缺毋滥原则留空`,
          );
          resultMap.set(req.id, {
            lines: [],
            usedAi: false,
            failed: true,
            errorReason: reason,
          });
        }
      }
      diagLog.info("AI 批量分句", `[${rule.langName}] 本批 ${batch.length} 块，逐字校验+中英复核通过 ${aiHits} 块`);
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      diagLog.warn(
        "AI 批量分句失败",
        `[${rule.langName}] 本批 ${batch.length} 块调用失败，已按宁缺毋滥原则留空`,
        errText,
      );
      for (const req of batch) {
        resultMap.set(req.id, {
          lines: [],
          usedAi: false,
          failed: true,
          errorReason: errText.slice(0, 120),
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
    return { lines: [stripOuterDoubleQuotes(rawTargetParagraph)], usedAi: false, failed: false };
  }
  const map = await batchSplitTargetsWithAi(
    [
      {
        id: `row_${sourceRows[0]?.line || sourceRows[0]?.rowIndex || 0}`,
        fallbackText: rawTargetParagraph,
        aiSourceText: opts?.fullParagraphTarget || rawTargetParagraph,
        referenceEn: opts?.referenceEn,
        sourceRows,
        isPartial: opts?.isPartial,
        suppressAutoEllipsis: opts?.suppressAutoEllipsis,
      },
    ],
    rule,
    gemini,
  );
  return (
    map.values().next().value ?? {
      lines: [],
      usedAi: false,
      failed: true,
      errorReason: "未配置可用 AI 密钥",
    }
  );
}

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

export interface BilingualAlignmentAnalysis {
  hardReason: string | null;
  softReason: string | null;
}

export interface SemanticAuditResult {
  verdict: "accurate" | "fixed" | "unfixable";
  hasInversion?: boolean;
  reason: string;
  fixedLines?: string[];
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

const TOKEN_SPANS_SINGLE_SCHEMA = {
  type: "object",
  properties: {
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
  required: ["spans"],
};

const SEMANTIC_AUDIT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["accurate", "fixed", "unfixable"],
    },
    hasInversion: { type: "boolean" },
    reason: { type: "string" },
    fixedLines: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "reason"],
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

export function hasExplicitRowOmission(row: ScriptRow | undefined): boolean {
  if (!row) return false;
  return (
    (row.remark || "").includes("有省略") ||
    (row.chinese || "").includes("……") ||
    hasExplicitTextTrailingEllipsis(row)
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

function countSrcQuestions(s: string): number {
  return (s.match(/[?？]/g) || []).length;
}

function countTargetQuestions(s: string, langCode: string): number {
  if (langCode === "el") return (s.match(/[?？;;]/g) || []).length;
  if (langCode === "ar") return (s.match(/[?？؟]/g) || []).length;
  if (langCode === "hy") return (s.match(/[?？՞]/g) || []).length;
  return (s.match(/[?？]/g) || []).length;
}

/**
 * Bilingual post-split boundary auditor & deterministic repair:
 * 1. Moves trailing conjunctions/clause-starters (e.g. "...триматися, і", "...rencana itu, dan")
 *    from end of line[i] to start of line[i+1] when EN[i] does not end with a conjunction.
 * 2. Moves dangling words after sentence-ending punctuation (. ? ! ;) on line[i] to line[i+1]
 *    when EN[i] ends at that sentence boundary, and trims leaked next-sentence words on the last line.
 * 3. When the last row has an explicit omission/ellipsis (`…` / `……` / `有省略`) and 0 question marks in source,
 *    trims trailing omitted question sentences that AI accidentally swallowed after the sentence period.
 * 4. Applies sentence-start capitalization for rows marked with 截取 and explicit trailing ellipsis.
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

  // Pass C: Trim leaked 1-word next-sentence starter OR swallowed post-omission question sentences on the last line
  const lastIdx = out.length - 1;
  if (lastIdx >= 0) {
    const srcLast = sourceRows[lastIdx];
    const srcLastRef = (srcLast?.english || srcLast?.chinese || "").trim();

    if (
      hasExplicitRowOmission(srcLast) &&
      countSrcQuestions(srcLastRef) === 0 &&
      countTargetQuestions(out[lastIdx], rule.langCode) > 0
    ) {
      const mOmitQ = /^([^?？;;؟՞]+[.!。！।។။]["”»'’)\]]*)\s+([\s\S]+)$/u.exec(out[lastIdx]);
      if (
        mOmitQ &&
        mOmitQ[1].trim().length >= 12 &&
        countTargetQuestions(mOmitQ[1], rule.langCode) === 0 &&
        countTargetQuestions(mOmitQ[2], rule.langCode) > 0
      ) {
        out[lastIdx] = mOmitQ[1].trim();
      }
    }

    const srcEndsSentence = /[.!?。！？]["”»'’]*$/u.test(srcLastRef);
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

interface NormalizedSourceMap {
  cleanSrc: string;
  fullNorm: string;
  normToRawStart: number[];
  normToRawEnd: number[];
}

function buildNormalizedSourceMap(sourceText: string): NormalizedSourceMap | null {
  const cleanSrc = stripOuterDoubleQuotes(sourceText).replace(/\s+/g, " ").trim();
  if (!cleanSrc) return null;

  const normChars: string[] = [];
  const normToRawStart: number[] = [];
  const normToRawEnd: number[] = [];
  let rawBytePos = 0;
  for (const ch of [...cleanSrc]) {
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
  return { cleanSrc, fullNorm, normToRawStart, normToRawEnd };
}

function normAlnumStr(s: string): string {
  return [...(s || "").normalize("NFKC").toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join("");
}

function sliceCleanSourceByNormSpans(
  map: NormalizedSourceMap,
  spansNorm: Array<{ nStart: number; nEnd: number }>,
): string[] | null {
  const { cleanSrc, normToRawStart, normToRawEnd } = map;
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

/**
 * Projects AI-returned lines back onto the exact verbatim character stream of `sourceText`
 * via 100% exact alphanumeric substring matching.
 */
export function projectLinesOntoVerbatimSource(
  sourceText: string,
  aiLines: string[],
): string[] | null {
  if (aiLines.length === 0 || aiLines.some((l) => !l || !l.trim())) return null;
  const map = buildNormalizedSourceMap(sourceText);
  if (!map) return null;

  const spansNorm: Array<{ nStart: number; nEnd: number }> = [];
  let cursor = 0;
  for (let i = 0; i < aiLines.length; i += 1) {
    const k = normAlnumStr(aiLines[i]);
    if (!k) return null;
    const pos = map.fullNorm.indexOf(k, cursor);
    if (pos < 0) return null;
    spansNorm.push({ nStart: pos, nEnd: pos + k.length - 1 });
    cursor = pos + k.length;
  }

  return sliceCleanSourceByNormSpans(map, spansNorm);
}

function bigramDiceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) {
    return a[0] === b[0] ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const bg = b.slice(i, i + 2);
    const c = counts.get(bg) ?? 0;
    if (c > 0) {
      intersection += 1;
      counts.set(bg, c - 1);
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/**
 * Resilient boundary-anchor verbatim projector:
 * When AI makes minor character typos inside a multi-line block (or a partial sub-segment starting at 65% of a paragraph),
 * locates each line's start/end boundaries on `cleanSrc` using prefix/suffix anchors of adjacent lines
 * and slices the 100% original verbatim `cleanSrc` (automatically healing AI typos back to the manuscript text!).
 */
export function projectLinesByBoundaryAnchors(
  sourceText: string,
  aiLines: string[],
  opts?: { isPartial?: boolean },
): string[] | null {
  const exact = projectLinesOntoVerbatimSource(sourceText, aiLines);
  if (exact) return exact;

  if (aiLines.length === 0 || aiLines.some((l) => !l || !l.trim())) return null;
  const map = buildNormalizedSourceMap(sourceText);
  if (!map) return null;
  const { cleanSrc, fullNorm, normToRawStart, normToRawEnd } = map;

  const lineNorms = aiLines.map(normAlnumStr);
  if (lineNorms.some((k) => !k)) return null;

  const maxStartPos = opts?.isPartial
    ? fullNorm.length
    : Math.max(40, Math.floor(fullNorm.length * 0.35));

  // Locate block start (nStart of line 0)
  let curStart = -1;
  const exact0 = fullNorm.indexOf(lineNorms[0]);
  if (exact0 >= 0 && (exact0 <= maxStartPos || lineNorms[0].length >= 12)) {
    curStart = exact0;
  } else {
    for (const pLen of [24, 16, 10, 6, 4]) {
      if (lineNorms[0].length >= pLen) {
        const pos = fullNorm.indexOf(lineNorms[0].slice(0, pLen));
        if (pos >= 0 && (pos <= maxStartPos || pLen >= 10)) {
          curStart = pos;
          break;
        }
      }
    }
    if (curStart < 0 && lineNorms.length > 1) {
      for (const pLen of [24, 16, 10, 6]) {
        if (lineNorms[1].length >= pLen) {
          const pos1 = fullNorm.indexOf(lineNorms[1].slice(0, pLen));
          if (pos1 >= lineNorms[0].length * 0.6) {
            curStart = Math.max(0, pos1 - lineNorms[0].length);
            break;
          }
        }
      }
    }
    if (curStart < 0) curStart = 0;
  }

  const isWordBoundaryInRaw = (normIdx: number): boolean => {
    if (normIdx <= 0 || normIdx >= fullNorm.length) return true;
    const prevRawEnd = normToRawEnd[normIdx - 1];
    const nextRawStart = normToRawStart[normIdx];
    if (nextRawStart <= prevRawEnd) return false;
    return /[\s,.;:!?。！？，、；：—–\-()"”«»'’]/u.test(cleanSrc.slice(prevRawEnd, nextRawStart));
  };

  const spansNorm: Array<{ nStart: number; nEnd: number }> = [];

  for (let i = 0; i < lineNorms.length; i += 1) {
    const curNorm = lineNorms[i];
    const remainingLines = lineNorms.length - 1 - i;

    if (i === lineNorms.length - 1) {
      let endIdx = -1;
      const exactLast = fullNorm.indexOf(curNorm, curStart);
      if (exactLast === curStart) {
        endIdx = curStart + curNorm.length - 1;
      } else {
        const expectedEnd = curStart + curNorm.length;
        for (const sLen of [24, 16, 10, 6, 4]) {
          if (curNorm.length >= sLen) {
            const suffix = curNorm.slice(-sLen);
            const searchFrom = Math.max(curStart, expectedEnd - sLen - Math.max(12, Math.floor(curNorm.length * 0.35)));
            const pos = fullNorm.indexOf(suffix, searchFrom);
            if (pos >= 0 && pos + sLen <= expectedEnd + Math.max(15, Math.floor(curNorm.length * 0.35))) {
              endIdx = pos + sLen - 1;
              break;
            }
          }
        }
        if (endIdx < 0) {
          endIdx = Math.min(fullNorm.length - 1, curStart + curNorm.length - 1);
        }
      }
      if (endIdx < curStart) return null;
      const actualSlice = fullNorm.slice(curStart, endIdx + 1);
      if (bigramDiceSimilarity(actualSlice, curNorm) < 0.65) return null;
      spansNorm.push({ nStart: curStart, nEnd: endIdx });
      break;
    }

    const nextNorm = lineNorms[i + 1];
    const expectedCut = curStart + curNorm.length;

    if (fullNorm.startsWith(curNorm, curStart)) {
      const checkPrefixLen = Math.min(6, nextNorm.length);
      if (
        fullNorm.startsWith(nextNorm.slice(0, checkPrefixLen), expectedCut) ||
        isWordBoundaryInRaw(expectedCut)
      ) {
        spansNorm.push({ nStart: curStart, nEnd: expectedCut - 1 });
        curStart = expectedCut;
        continue;
      }
    }

    const radius = Math.max(16, Math.ceil(curNorm.length * 0.45));
    const minCut = Math.max(curStart + 1, expectedCut - radius);
    const maxCut = Math.min(fullNorm.length - remainingLines, expectedCut + radius);
    if (minCut > maxCut) return null;

    const candidateCuts = new Set<number>();

    for (const pLen of [nextNorm.length, 24, 16, 12, 8, 5, 3]) {
      if (nextNorm.length < pLen || pLen <= 0) continue;
      const probe = nextNorm.slice(0, pLen);
      let pos = fullNorm.indexOf(probe, minCut);
      while (pos >= 0 && pos <= maxCut) {
        candidateCuts.add(pos);
        pos = fullNorm.indexOf(probe, pos + 1);
      }
      if (candidateCuts.size > 0 && pLen >= 8) break;
    }

    for (const sLen of [curNorm.length, 24, 16, 12, 8, 5, 3]) {
      if (curNorm.length < sLen || sLen <= 0) continue;
      const probe = curNorm.slice(-sLen);
      let pos = fullNorm.indexOf(probe, Math.max(curStart, minCut - sLen));
      while (pos >= 0 && pos + sLen <= maxCut) {
        const cut = pos + sLen;
        if (cut >= minCut) candidateCuts.add(cut);
        pos = fullNorm.indexOf(probe, pos + 1);
      }
      if (candidateCuts.size > 0 && sLen >= 8) break;
    }

    for (let c = minCut; c <= maxCut; c += 1) {
      if (isWordBoundaryInRaw(c)) candidateCuts.add(c);
    }

    let bestCut = -1;
    let bestScore = -1e9;
    for (const cut of candidateCuts) {
      if (cut <= curStart || cut > fullNorm.length - remainingLines) continue;
      const leftActual = fullNorm.slice(curStart, cut);
      const rightPreviewLen = Math.min(nextNorm.length, fullNorm.length - cut, 28);
      const rightActual = fullNorm.slice(cut, cut + rightPreviewLen);
      const rightExpected = nextNorm.slice(0, rightPreviewLen);

      const leftSim = bigramDiceSimilarity(leftActual, curNorm);
      const rightSim = bigramDiceSimilarity(rightActual, rightExpected);

      let prefixMatchLen = 0;
      while (
        prefixMatchLen < rightActual.length &&
        prefixMatchLen < rightExpected.length &&
        rightActual[prefixMatchLen] === rightExpected[prefixMatchLen]
      ) {
        prefixMatchLen += 1;
      }
      let suffixMatchLen = 0;
      while (
        suffixMatchLen < leftActual.length &&
        suffixMatchLen < curNorm.length &&
        leftActual[leftActual.length - 1 - suffixMatchLen] === curNorm[curNorm.length - 1 - suffixMatchLen]
      ) {
        suffixMatchLen += 1;
      }

      const distPenalty = Math.abs(cut - expectedCut) / Math.max(10, curNorm.length);
      const wbBonus = isWordBoundaryInRaw(cut) ? 0.35 : -0.4;
      const score =
        leftSim * 2.2 +
        rightSim * 2.5 +
        Math.min(12, prefixMatchLen) * 0.12 +
        Math.min(12, suffixMatchLen) * 0.12 +
        wbBonus -
        distPenalty * 1.2;

      if (score > bestScore) {
        bestScore = score;
        bestCut = cut;
      }
    }

    if (bestCut <= curStart) return null;
    const chosenSlice = fullNorm.slice(curStart, bestCut);
    if (bigramDiceSimilarity(chosenSlice, curNorm) < 0.65) return null;

    spansNorm.push({ nStart: curStart, nEnd: bestCut - 1 });
    curStart = bestCut;
  }

  return sliceCleanSourceByNormSpans(map, spansNorm);
}

export function projectLinesVerbatimResilient(
  sourceText: string,
  aiLines: string[],
  opts?: { isPartial?: boolean },
): string[] | null {
  return (
    projectLinesOntoVerbatimSource(sourceText, aiLines) ??
    projectLinesByBoundaryAnchors(sourceText, aiLines, opts)
  );
}

const NO_STANDARD_PUNCT_LANGS = new Set(["th", "lo", "km", "my"]);

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
 * Separates bilingual alignment checks into:
 * - `hardReason`: Structural errors (line count, dropped head/tail sentences, question mark mismatch,
 *   final-row comma truncation, adjacent period/comma swap, multi-row punctuation drift) that can NEVER be waived without fixing.
 * - `softReason`: Length ratio / share warnings that may result from syntactic inversion or verse structure,
 *   which can be cleared if the AI semantic referee confirms 1:1 meaning accuracy.
 */
export function analyzeBilingualAlignment(
  lines: string[],
  sourceRows: ScriptRow[],
  fullSourceText: string,
  rule: PunctuationRule,
  opts?: { isPartial?: boolean; hasTruncation?: boolean },
): BilingualAlignmentAnalysis {
  if (lines.length !== sourceRows.length || lines.length === 0) {
    return {
      hardReason: `行数不匹配（返回 ${lines.length} 行，需 ${sourceRows.length} 行）`,
      softReason: null,
    };
  }
  if (lines.some((l) => !l || !l.trim())) {
    return { hardReason: "存在空白切分行", softReason: null };
  }

  const isPartial = Boolean(opts?.isPartial);
  const hasTruncation =
    Boolean(opts?.hasTruncation) || sourceRows.some((r) => parseTruncationSpec(r).hasTruncation);
  const hasExplicitOmission = sourceRows.some((r) => hasExplicitRowOmission(r));

  // Hard Check 1: Completeness / anti-dropped-tail & head check against fullSourceText
  const fullNorm = normAlnumStr(fullSourceText);
  if (fullNorm.length >= 10) {
    let cursor = 0;
    let firstStart = -1;
    let lastEnd = 0;
    let matchedLen = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const k = normAlnumStr(lines[i]);
      if (!k) {
        return { hardReason: `第 ${i + 1} 行缺少有效文字`, softReason: null };
      }
      const pos = fullNorm.indexOf(k, cursor);
      if (pos < 0) {
        return { hardReason: `第 ${i + 1} 行内容偏离定稿原文`, softReason: null };
      }
      if (i === 0) firstStart = pos;
      lastEnd = pos + k.length;
      matchedLen += k.length;
      cursor = lastEnd;
    }

    if (!isPartial && !hasTruncation && firstStart / fullNorm.length > 0.08) {
      return {
        hardReason: `句首漏句（仅从定稿原文 ${Math.round((firstStart / fullNorm.length) * 100)}% 处开始）`,
        softReason: null,
      };
    }
    if (!isPartial && !hasExplicitOmission && lastEnd / fullNorm.length < 0.92) {
      return {
        hardReason: `句尾漏句（仅覆盖至定稿原文 ${Math.round((lastEnd / fullNorm.length) * 100)}% 处，遗漏尾部内容）`,
        softReason: null,
      };
    }
    if (!isPartial && !hasTruncation && !hasExplicitOmission && matchedLen / fullNorm.length < 0.92) {
      return {
        hardReason: `整段覆盖率不足（仅覆盖定稿原文 ${Math.round((matchedLen / fullNorm.length) * 100)}%）`,
        softReason: null,
      };
    }
  }

  // Hard Check 2: Per-row question mark count equality
  for (let i = 0; i < lines.length; i += 1) {
    const srcRef = (sourceRows[i]?.english || sourceRows[i]?.chinese || "").trim();
    if (!srcRef) continue;
    const srcQ = countSrcQuestions(srcRef);
    const tgQ = countTargetQuestions(lines[i], rule.langCode);
    if (srcQ !== tgQ) {
      return {
        hardReason: `第 ${i + 1} 行问号数量不一致（源文 ${srcQ} 个 vs 目标语 ${tgQ} 个）`,
        softReason: null,
      };
    }
  }

  // Hard Check 3: Final row sentence-ending punctuation consistency
  if (!NO_STANDARD_PUNCT_LANGS.has(rule.langCode)) {
    const lastIdx = lines.length - 1;
    const lastSrc = (sourceRows[lastIdx]?.english || sourceRows[lastIdx]?.chinese || "").trim();
    const lastTg = lines[lastIdx].trim();
    if (endsWithStrongSentencePunct(lastSrc) && endsWithCommaOrColonPunct(lastTg)) {
      return {
        hardReason: `第 ${lastIdx + 1} 行（末行）句末标点错位（源文以句号/问号/叹号结束，目标语却以逗号/冒号结束，疑似漏掉末半句）`,
        softReason: null,
      };
    }
  }

  // Hard Check 4: Adjacent row period/comma swap & multi-row sentence-end punctuation drift
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
          return {
            hardReason: `第 ${i + 1}~${i + 2} 行句末句号与逗号交叉错位（跨行顺延错行）`,
            softReason: null,
          };
        }
      }
    }
    if (punctContradictions >= 2) {
      return {
        hardReason: `存在 ${punctContradictions} 行句末句号/逗号与源文矛盾（多行顺延错行）`,
        softReason: null,
      };
    }
  }

  // Soft Check 5: Per-row length share & extreme short/long mismatch (may be caused by clause inversion)
  let softReason: string | null = null;
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
          softReason = `第 ${i + 1} 行长短差异较大（英文 ${enL} 字符 vs 目标语 ${tgL} 字符）`;
          break;
        }
        if ((enL >= 15 || zhL >= 6) && tgL <= 3) {
          softReason = `第 ${i + 1} 行目标语过短（仅 ${tgL} 字符）`;
          break;
        }

        const srcL = srcLens[i];
        const meetsMinLen = useEn ? enL >= 10 : zhL >= 4;
        if (meetsMinLen) {
          const srcShare = srcL / totalSrc;
          const tgShare = tgL / totalTg;
          const ratio = tgShare / Math.max(0.015, srcShare);
          if (ratio < 0.35 || ratio > 2.55) {
            softReason = `第 ${i + 1} 行长度占比失衡（占比比值 ${ratio.toFixed(2)}，疑似跨行错位或语序倒装）`;
            break;
          }
        }
      }
    }
  }

  // Soft Check 6: Whole-block total length ratio check
  if (!softReason) {
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
        softReason = `整块外文与英文总长比例偏离（${totalTgChars}/${totalEnChars} = ${blockRatio.toFixed(2)}）`;
      }
    }
  }

  return { hardReason: null, softReason };
}

export function detectBilingualMisalignment(
  lines: string[],
  sourceRows: ScriptRow[],
  fullSourceText: string,
  rule: PunctuationRule,
  opts?: { isPartial?: boolean; hasTruncation?: boolean },
): string | null {
  const { hardReason, softReason } = analyzeBilingualAlignment(
    lines,
    sourceRows,
    fullSourceText,
    rule,
    opts,
  );
  return hardReason ?? softReason;
}

/**
 * AI Semantic Bilingual Referee & Fixer:
 * Compares the actual meaning of Chinese, English, and Target language row-by-row (switching to an alternate Key).
 * - If a soft length warning was caused by legitimate cross-language syntax / clause inversion while row meanings match,
 *   returns `verdict: "accurate", hasInversion: true`.
 * - If genuine misalignment, dropped sentences, or swallowed post-omission sentences occurred,
 *   re-splits from the FULL sourceText and returns `verdict: "fixed", fixedLines`.
 * - Also backwards-compatible with legacy mocks returning `{ lines: [...] }`.
 */
export async function semanticAuditOrFixWithAi(
  draftLines: string[],
  sourceText: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini: GeminiPoolClient,
  triggerReason = "行间标点或长度占比未对齐",
  referenceEn?: string,
  opts?: { isPartial?: boolean },
): Promise<SemanticAuditResult> {
  try {
    const fullCleanSource = stripOuterDoubleQuotes(sourceText).trim();
    const isPartialOrOmission =
      Boolean(opts?.isPartial) || hasExplicitRowOmission(sourceRows[sourceRows.length - 1]);
    const partialOmitRule = isPartialOrOmission
      ? `\n【重要：本块为长段局部摘录或末行含省略号（…）】若第 ${sourceRows.length} 行外文在句号之后多包含了被剧本省略掉的后续多余句子（如多余问句），请直接截去句号之后被省略的多余句子，返回 verdict:"fixed" 与修正后的 fixedLines！`
      : "";

    const tableSpec = sourceRows
      .map(
        (r, i) =>
          `[${i + 1}]\n  中文: ${r.chinese}\n  英文: ${r.english}\n  当前外文切分: ${draftLines[i] ?? ""}`,
      )
      .join("\n");
    const refEnBlock = referenceEn ? `原段完整英文参考：\n${referenceEn}\n\n` : "";

    const rawRes = await gemini.generateStructuredJson<{
      verdict?: "accurate" | "fixed" | "unfixable";
      hasInversion?: boolean;
      reason?: string;
      fixedLines?: string[];
      lines?: string[];
    }>(
      {
        systemInstruction:
          "你是多语种剧本三语语义审校与重切裁判。请逐行对比下面每一行的【中文】【英文】与【当前外文切分】的实际语义（不要只看字数长短）：\n" +
          "1. 若因跨语种句式差异或从句语序倒装导致某行外文字数与英文长短悬殊，但每一行外文表达的意思与该行中英文对应准确、且未遗漏或多吞原文句子，请返回 verdict:\"accurate\", hasInversion:true。\n" +
          "2. 若确实存在跨行顺延错位、问号/句号错位、遗漏了结尾句/开头句，或末行误吞了省略号之后的多余句子，请基于【不可改动的完整外文串】重新 1:1 切分，返回 verdict:\"fixed\" 及严格等于字幕行数的 fixedLines 数组（严禁修改、增删任何外文单词或标点！）。\n" +
          "3. 若定稿原文与中英文完全对不上无法修复，返回 verdict:\"unfixable\"。" +
          partialOmitRule,
        userPrompt:
          `目标语种：${rule.langName}（共 ${sourceRows.length} 行）\n` +
          `触发核对原因：${triggerReason}${partialOmitRule}\n` +
          refEnBlock +
          `不可改动的完整外文串：\n${fullCleanSource}\n\n` +
          `逐行三语对照：\n${tableSpec}`,
        jsonSchema: SEMANTIC_AUDIT_SCHEMA,
      },
      { preferAlternateKey: true },
    );

    const candidateLines =
      Array.isArray(rawRes.fixedLines) && rawRes.fixedLines.length === sourceRows.length
        ? rawRes.fixedLines
        : Array.isArray(rawRes.lines) && rawRes.lines.length === sourceRows.length
          ? rawRes.lines
          : undefined;

    if (rawRes.verdict === "accurate" && !candidateLines) {
      return {
        verdict: "accurate",
        hasInversion: Boolean(rawRes.hasInversion ?? true),
        reason: rawRes.reason || "AI 语义核对通过",
      };
    }

    if ((rawRes.verdict === "fixed" || (!rawRes.verdict && candidateLines)) && candidateLines) {
      const projected = projectLinesVerbatimResilient(sourceText, candidateLines, {
        isPartial: isPartialOrOmission,
      });
      if (projected) {
        return {
          verdict: "fixed",
          hasInversion: Boolean(rawRes.hasInversion),
          reason: rawRes.reason || "AI 已按完整原文修正断行",
          fixedLines: projected,
        };
      }
    }

    return {
      verdict: "unfixable",
      reason: rawRes.reason || triggerReason,
    };
  } catch (err) {
    return {
      verdict: "unfixable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function reviewAndFixSplitWithAi(
  draftLines: string[],
  sourceText: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini: GeminiPoolClient,
  misalignmentReason = "行间标点或长度占比未对齐",
  referenceEn?: string,
  opts?: { isPartial?: boolean },
): Promise<string[] | null> {
  const res = await semanticAuditOrFixWithAi(
    draftLines,
    sourceText,
    sourceRows,
    rule,
    gemini,
    misalignmentReason,
    referenceEn,
    opts,
  );
  if (res.verdict === "fixed" && res.fixedLines) return res.fixedLines;
  if (res.verdict === "accurate") return draftLines;
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

/**
 * Strategy 2: Token-index span splitting (`[0]w0 [1]w1 ... -> { spans: [{start, end}] }`).
 * Eliminates any possibility of AI spelling/character typos on long 20~30 line blocks
 * and switches to an alternate API key in the pool.
 * When `isPartial` or the last row has an explicit omission/ellipsis, explicitly instructs AI
 * to stop at the end of line K and NEVER stuff trailing omitted sentences into line K!
 */
export async function splitByTokenSpansWithAi(
  preparedSrc: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini: GeminiPoolClient,
  opts?: {
    isPartial?: boolean;
    suppressAutoEllipsis?: boolean;
    referenceEn?: string;
    onlyAcceptSpans?: boolean;
  },
): Promise<{ lines: string[]; hasInversion?: boolean } | null> {
  const tk = tokenizeForIndexing(preparedSrc);
  if (tk.tokens.length === 0) return null;
  const indexedTokens = formatIndexedTokens(tk.tokens);
  const lastRow = sourceRows[sourceRows.length - 1];
  const isPartialOrOmittedTail =
    Boolean(opts?.isPartial) || hasExplicitRowOmission(lastRow);

  const rowsSpec = sourceRows
    .map((r, i) => {
      const tr = parseTruncationSpec(r);
      const truncNote = tr.deletedEnPrefix
        ? ` | 【句首已截取删去英文 "${tr.deletedEnPrefix}"】`
        : "";
      const omitNote =
        i === sourceRows.length - 1 && hasExplicitRowOmission(r)
          ? " | 【此行末尾有省略号：切分到此句结束处立刻停止，严禁把原文后面被省略的句子或问句归入此行！】"
          : "";
      return `  (${i + 1}) ZH: ${r.chinese} | EN: ${r.english}${truncNote}${omitNote}`;
    })
    .join("\n");
  const refEnLine = opts?.referenceEn ? `原段完整英文参考：\n${opts.referenceEn}\n` : "";

  const systemInstruction = isPartialOrOmittedTail
    ? "你是多语种影视剧本文本 1:1 词序号断行专家。下面给出带 `[序号]` 的目标语定稿词序列以及需要对齐的中英文字幕行。\n" +
      "请只输出每一行对应的起止词序号 `{ spans: [{ start, end }] }`（包含 start 与 end 两端词），spans 数组长度必须严格等于字幕行数，且相邻行满足 `next.start = prev.end + 1`。\n" +
      `【重要：本块为长段局部摘录/末行含省略号】定稿原文开头或结尾包含未出现在字幕行中的被省略句子！请只切分与下方 (1)~(${sourceRows.length}) 行语义严格对应的连续区间，到第 ${sourceRows.length} 行语义结束处立刻停止，严禁把后面被省略的多余句子（如后续问句）塞进第 ${sourceRows.length} 行！`
    : "你是多语种影视剧本文本 1:1 词序号断行专家。下面给出带 `[序号]` 的目标语定稿词序列（从 `[0]` 到 `[N]`）以及需要对齐的中英文字幕行。\n" +
      "请只输出每一行对应的起止词序号 `{ spans: [{ start, end }] }`（包含 start 与 end 两端词），spans 数组长度必须严格等于字幕行数，且相邻行满足 `next.start = prev.end + 1`，完整覆盖整段台词不漏尾句！";

  const userHeader = isPartialOrOmittedTail
    ? `目标语种：${rule.langName}（共 ${tk.tokens.length} 个词单元 · 局部摘录/末行有省略，请在第 ${sourceRows.length} 行语义结束处停止，切勿包含后续被省略句子）\n`
    : `目标语种：${rule.langName}（共 ${tk.tokens.length} 个词单元，最后序号 [${tk.tokens.length - 1}]）\n`;

  const res = await gemini.generateStructuredJson<{
    spans?: TokenSpan[];
    lines?: string[];
    hasInversion?: boolean;
  }>(
    {
      systemInstruction,
      userPrompt:
        userHeader +
        refEnLine +
        `带序号的目标语词序列：\n${indexedTokens}\n\n` +
        `请严格切分为 ${sourceRows.length} 行（spans 长度必须等于 ${sourceRows.length}）：\n${rowsSpec}`,
      jsonSchema: TOKEN_SPANS_SINGLE_SCHEMA,
    },
    { preferAlternateKey: true },
  );

  if (Array.isArray(res.spans) && res.spans.length === sourceRows.length) {
    const sliced = sliceTokensBySpans(
      tk.tokens,
      tk.joinSep,
      res.spans,
      sourceRows,
      rule,
      Boolean(opts?.suppressAutoEllipsis),
    );
    if (sliced) {
      return { lines: sliced, hasInversion: Boolean(res.hasInversion) };
    }
  }

  if (!opts?.onlyAcceptSpans && Array.isArray(res.lines) && res.lines.length === sourceRows.length) {
    const projected = projectLinesVerbatimResilient(preparedSrc, res.lines, {
      isPartial: isPartialOrOmittedTail,
    });
    if (projected) {
      return { lines: projected, hasInversion: Boolean(res.hasInversion) };
    }
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
  "2. 【局部摘录、句首截取与末行省略号】：若定稿原段开头或结尾包含未在中英文行里出现的句子（或最后一行带有省略号 … / …… / 有省略），只截取与中英文行完全对应的那一段，到最后一行语义结束处立刻停止，多余后续句子（尤其是后面被省略的问句）一律舍弃，绝不塞进最后一行！若某行标注了『已删句首英文：...』，在目标语中也同步去掉对应的句首词组。\n" +
  "3. 【行首行尾与标点强对齐】：\n" +
  "   - 若某行英文以句号结束，目标语该行也必须在对应完整句句号处结束，绝不能在句中逗号处提前截断导致后续所有行顺延错位或丢掉结尾句！\n" +
  "   - 若某行英文包含问号（?），目标语该行必须包含相同数量的问号，绝不能把问句拆到其他行！\n" +
  "   - 下一行英文以连词/引导词（and, or, if, so, rather, when, although 等）开头时，目标语对应的连词（如 dan/atau/jika/й/і/та/то/якщо/радше 等）必须放在下一行行首，绝不能留在上一行行末！\n" +
  "4. 泰语中的 @ 代表双空格断句符，切分时保留 @ 不得删除。";

function buildMisalignmentDiagDetail(
  req: BatchSplitRequest,
  candidateLines: string[],
  failReason: string,
  auditInfo?: SemanticAuditResult,
): string {
  const cleanSrc = stripOuterDoubleQuotes(req.aiSourceText).replace(/\s+/g, " ").trim();
  const srcPreview =
    cleanSrc.length <= 420
      ? cleanSrc
      : `${cleanSrc.slice(0, 210)} ... [中间省略 ${cleanSrc.length - 420} 字符] ... ${cleanSrc.slice(-210)}`;

  const rowMatch = /第\s*(\d+)\s*行/.exec(failReason);
  const targetIdx = rowMatch
    ? Math.min(req.sourceRows.length - 1, Math.max(0, Number.parseInt(rowMatch[1], 10) - 1))
    : req.sourceRows.length - 1;

  const indicesToShow = new Set<number>([0]);
  if (targetIdx > 0) indicesToShow.add(targetIdx - 1);
  indicesToShow.add(targetIdx);
  if (targetIdx + 1 < req.sourceRows.length) indicesToShow.add(targetIdx + 1);
  indicesToShow.add(req.sourceRows.length - 1);

  const rowLines = [...indicesToShow]
    .sort((a, b) => a - b)
    .map((idx) => {
      const r = req.sourceRows[idx];
      const marker = idx === targetIdx ? "👉 [出错行]" : "   [对照行]";
      return (
        `${marker} 第 ${idx + 1}/${req.sourceRows.length} 行 (剧本行号 Line ${r?.line || idx + 1}):\n` +
        `     中文: ${r?.chinese || "(空)"}\n` +
        `     英文: ${r?.english || "(空)"}\n` +
        `     AI外文: ${candidateLines[idx] ?? "(未生成)"}`
      );
    })
    .join("\n");

  const auditLine = auditInfo
    ? `\n【AI 语义裁判结论】verdict=${auditInfo.verdict} | reason=${auditInfo.reason}`
    : "";

  return (
    `【核对失败原因】${failReason}${auditLine}\n` +
    `【定位到的定稿原文】（共 ${cleanSrc.length} 字符${req.isPartial ? " · 局部摘录" : ""}）：\n${srcPreview}\n` +
    `【问题行与上下文三语比对】：\n${rowLines}`
  );
}

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

  // Upgrade B: Dedicated single-block batch whenever sourceRows.length >= 10 or aiSourceText.length >= 1800
  const batches: BatchSplitRequest[][] = [];
  let curBatch: BatchSplitRequest[] = [];
  let curChars = 0;
  for (const req of requests) {
    const isLongBlock = req.sourceRows.length >= 10 || req.aiSourceText.length >= 1800;
    const est = req.aiSourceText.length + (req.referenceEn?.length ?? 0) + req.sourceRows.length * 140;
    if (isLongBlock || curBatch.length >= 2 || (curBatch.length > 0 && curChars + est > 14000)) {
      if (curBatch.length > 0) {
        batches.push(curBatch);
        curBatch = [];
        curChars = 0;
      }
    }
    curBatch.push(req);
    curChars += est;
    if (isLongBlock) {
      batches.push(curBatch);
      curBatch = [];
      curChars = 0;
    }
  }
  if (curBatch.length > 0) batches.push(curBatch);

  for (const batch of batches) {
    for (const req of batch) {
      const lastRowOmit = hasExplicitRowOmission(req.sourceRows[req.sourceRows.length - 1]);
      diagLog.info(
        "AI 分句",
        `[${rule.langName}] AI 分句开始：${req.id}（${req.sourceRows.length} 行${req.isPartial || lastRowOmit ? "·局部摘录" : ""}）`,
      );
    }

    const blocksPrompt = batch
      .map((req) => {
        const preparedSrc = stripOuterDoubleQuotes(encodeThaiDoubleSpaces(req.aiSourceText, rule));
        const lastRow = req.sourceRows[req.sourceRows.length - 1];
        const isPartialOrOmit = Boolean(req.isPartial) || hasExplicitRowOmission(lastRow);
        const partialBanner = isPartialOrOmit
          ? `【重要提示：本块为长段局部摘录/末行含省略号，请只切分与 (1)~(${req.sourceRows.length}) 行对应的连续句子，在第 ${req.sourceRows.length} 行对应句结束处立刻停止，严禁把后面被省略的句子或问句塞进第 ${req.sourceRows.length} 行！】\n`
          : "";
        const rowsSpec = req.sourceRows
          .map((r, i) => {
            const tr = parseTruncationSpec(r);
            const truncNote = tr.deletedEnPrefix
              ? ` | 【注意：句首已截取删去英文 "${tr.deletedEnPrefix}"，请同步截去对应目标语词组】`
              : tr.hasTruncation
                ? ` | 备注: ${r.remark}`
                : "";
            const omitNote =
              i === req.sourceRows.length - 1 && hasExplicitRowOmission(r)
                ? " | 【末行有省略号：在此句结束处停止，舍弃原文后续被省略句子】"
                : "";
            return `  (${i + 1}) ZH: ${r.chinese} | EN: ${r.english}${truncNote}${omitNote}`;
          })
          .join("\n");
        const refEnLine = req.referenceEn ? `原段完整英文参考：\n${req.referenceEn}\n` : "";
        return `### 任务ID: ${req.id}\n${partialBanner}${refEnLine}目标语定稿原文（${rule.langName}）：\n${preparedSrc}\n需 1:1 对齐切分的字幕行（必须严格返回 ${req.sourceRows.length} 行）：\n${rowsSpec}`;
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
        const isPartialOrOmit =
          Boolean(req.isPartial) ||
          hasExplicitRowOmission(req.sourceRows[req.sourceRows.length - 1]);
        let hasInversion = Boolean(item?.hasInversion);
        let usedTokenSpansStrategy = false;

        // Strategy 1: Direct text split + resilient boundary-anchor verbatim projection
        let projected =
          item && Array.isArray(item.lines) && item.lines.length === req.sourceRows.length
            ? projectLinesVerbatimResilient(preparedSrc, item.lines, { isPartial: isPartialOrOmit })
            : null;

        // Backward-compatible fallback if Pass 1 directly returned token spans
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
              hasInversion,
            });
            aiHits += 1;
            continue;
          }
        }

        // Strategy 2: If Pass 1 returned wrong line count or failed projection, switch Key & retry via Token-Index Spans (`[0]w0 [1]w1 ...`)
        let retryErrText = "";
        if (!projected) {
          usedTokenSpansStrategy = true;
          diagLog.info(
            "AI 换 Key 重试",
            `[${rule.langName}] ${req.id} 切换备用 Key 改用词序号索引模式重试...`,
          );
          try {
            const spanRes = await splitByTokenSpansWithAi(
              preparedSrc,
              req.sourceRows,
              rule,
              gemini,
              {
                isPartial: isPartialOrOmit,
                suppressAutoEllipsis: req.suppressAutoEllipsis,
                referenceEn: req.referenceEn,
              },
            );
            if (spanRes) {
              projected = spanRes.lines;
              if (spanRes.hasInversion) hasInversion = true;
              diagLog.info(
                "AI 换 Key 词序号重试成功",
                `[${rule.langName}] 任务 ${req.id} 经第 2 轮词序号索引模式 (${req.sourceRows.length} 行) 对齐成功`,
              );
            }
          } catch (spanErr) {
            retryErrText = spanErr instanceof Error ? spanErr.message : String(spanErr);
          }
        }

        // Strategy 3: If Strategy 2 still didn't yield projected lines, switch Key & retry single-block text split
        if (!projected) {
          try {
            const singleRowsSpec = req.sourceRows
              .map((r, idx) => `(${idx + 1}) ZH: ${r.chinese} | EN: ${r.english}`)
              .join("\n");
            const singleRes = await gemini.generateStructuredJson<{
              lines?: string[];
              spans?: TokenSpan[];
              hasInversion?: boolean;
            }>(
              {
                systemInstruction: DIRECT_SPLIT_SYSTEM_PROMPT,
                userPrompt:
                  `目标语种：${rule.langName}\n` +
                  `注意：上一轮返回了 ${item?.lines?.length ?? 0} 行，必须严格切分为 ${req.sourceRows.length} 行！\n` +
                  `目标语定稿原文：\n${stripOuterDoubleQuotes(preparedSrc)}\n` +
                  `请严格按以下 ${req.sourceRows.length} 行 1:1 切分：\n${singleRowsSpec}`,
                jsonSchema: REVIEW_SINGLE_SCHEMA,
              },
              { preferAlternateKey: true },
            );
            if (Array.isArray(singleRes.lines) && singleRes.lines.length === req.sourceRows.length) {
              projected = projectLinesVerbatimResilient(preparedSrc, singleRes.lines, {
                isPartial: isPartialOrOmit,
              });
              if (singleRes.hasInversion) hasInversion = true;
            } else if (Array.isArray(singleRes.spans) && singleRes.spans.length === req.sourceRows.length) {
              const tk = tokenizeForIndexing(preparedSrc);
              projected = sliceTokensBySpans(
                tk.tokens,
                tk.joinSep,
                singleRes.spans,
                req.sourceRows,
                rule,
                Boolean(req.suppressAutoEllipsis),
              );
            }
          } catch (singleErr) {
            retryErrText = singleErr instanceof Error ? singleErr.message : String(singleErr);
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
            isPartial: isPartialOrOmit,
            hasTruncation: hasTruncInReq,
          };
          let analysis = analyzeBilingualAlignment(
            decoded,
            req.sourceRows,
            preparedSrc,
            rule,
            alignOpts,
          );

          let passedAlignment = analysis.hardReason === null && analysis.softReason === null;
          let lastAuditRes: SemanticAuditResult | undefined;

          // Upgrade C: When either hardReason or softReason triggers, invoke AI Semantic Referee (on alternate Key)
          if (!passedAlignment) {
            const triggerReason = (analysis.hardReason ?? analysis.softReason)!;
            diagLog.info(
              "AI 语义复核",
              `[${rule.langName}] ${req.id} 触发 AI 语义复核（${triggerReason}），切换备用 Key 对比三语语义...`,
            );
            const auditRes = await semanticAuditOrFixWithAi(
              decoded,
              preparedSrc,
              req.sourceRows,
              rule,
              gemini,
              triggerReason,
              req.referenceEn,
              { isPartial: isPartialOrOmit },
            );
            lastAuditRes = auditRes;

            if (auditRes.verdict === "fixed" && auditRes.fixedLines) {
              const repaired = auditAndRepairBilingualAlignment(
                auditRes.fixedLines.map((l) => decodeThaiDoubleSpaces(l, rule)),
                req.sourceRows,
                rule,
                Boolean(req.suppressAutoEllipsis),
              );
              const recheck = analyzeBilingualAlignment(
                repaired,
                req.sourceRows,
                preparedSrc,
                rule,
                alignOpts,
              );
              if (recheck.hardReason === null) {
                decoded = repaired;
                analysis = recheck;
                passedAlignment = true;
                if (auditRes.hasInversion) hasInversion = true;
                diagLog.info(
                  "AI 语义复核",
                  `[${rule.langName}] ${req.id} 经 AI 语义复核重切通过（${auditRes.reason}）`,
                );
              } else {
                analysis = recheck;
              }
            } else if (auditRes.verdict === "accurate" && analysis.hardReason === null) {
              passedAlignment = true;
              hasInversion = Boolean(auditRes.hasInversion ?? true);
              diagLog.info(
                "AI 语义复核",
                `[${rule.langName}] ${req.id} 经 AI 语义核对确认意思准确（含语序倒装/句式差异，已放行）`,
              );
            }

            // Last-chance rescue for genuine hard structural errors if token-span mode hasn't been tried yet
            if (!passedAlignment && analysis.hardReason !== null && !usedTokenSpansStrategy) {
              try {
                const rescueSpanRes = await splitByTokenSpansWithAi(
                  preparedSrc,
                  req.sourceRows,
                  rule,
                  gemini,
                  {
                    isPartial: isPartialOrOmit,
                    suppressAutoEllipsis: req.suppressAutoEllipsis,
                    referenceEn: req.referenceEn,
                    onlyAcceptSpans: true,
                  },
                );
                if (rescueSpanRes) {
                  const rescueLines = auditAndRepairBilingualAlignment(
                    rescueSpanRes.lines.map((l) => decodeThaiDoubleSpaces(l, rule)),
                    req.sourceRows,
                    rule,
                    Boolean(req.suppressAutoEllipsis),
                  );
                  const rescueCheck = analyzeBilingualAlignment(
                    rescueLines,
                    req.sourceRows,
                    preparedSrc,
                    rule,
                    alignOpts,
                  );
                  if (rescueCheck.hardReason === null) {
                    decoded = rescueLines;
                    analysis = rescueCheck;
                    passedAlignment = true;
                    if (rescueSpanRes.hasInversion) hasInversion = true;
                    diagLog.info(
                      "AI 词序号抢救成功",
                      `[${rule.langName}] ${req.id} 经词序号索引模式抢救通过双语核对`,
                    );
                  }
                }
              } catch {
                // ignore rescue error
              }
            }
          }

          if (passedAlignment) {
            resultMap.set(req.id, {
              lines: decoded,
              usedAi: true,
              failed: false,
              hasInversion,
            });
            aiHits += 1;
          } else {
            const finalFailReason = (analysis.hardReason ?? analysis.softReason) || "行间语义未对齐";
            const detailText = buildMisalignmentDiagDetail(
              req,
              decoded,
              finalFailReason,
              lastAuditRes,
            );
            diagLog.warn(
              "AI 分句双语核对未通过",
              `[${rule.langName}] 任务 ${req.id} (${finalFailReason})，已按宁缺毋滥原则留空`,
              detailText,
            );
            resultMap.set(req.id, {
              lines: [],
              usedAi: false,
              failed: true,
              errorReason: `双语核对未通过：${finalFailReason}`,
            });
          }
        } else {
          const reason = retryErrText
            ? retryErrText.slice(0, 120)
            : `AI 返回 ${item?.lines?.length ?? 0} 行（需 ${req.sourceRows.length} 行），未过行数/原文逐字校验`;
          const detailText = buildMisalignmentDiagDetail(
            req,
            item?.lines ?? [],
            reason,
          );
          diagLog.warn(
            "AI 分句校验未通过",
            `[${rule.langName}] 任务 ${req.id} (${reason})，已按宁缺毋滥原则留空`,
            detailText,
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

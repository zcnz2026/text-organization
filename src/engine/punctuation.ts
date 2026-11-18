import type { PunctuationRule } from "../types/domain";

const ANY_DOUBLE_OPEN_RE = /^[\s]*([«„“""❝「『]+)/u;
const ANY_DOUBLE_CLOSE_RE = /([»”“""❞」』]+)([\s.,。，!?！？।។။]*)$/u;
const APOSTROPHE_BETWEEN_LETTERS_RE = /([\p{L}\p{M}\p{N}])['’ʼ]([\p{L}\p{M}\p{N}])/gu;
const SINGLE_QUOTED_SPAN_RE =
  /(^|[^\p{L}\p{M}\p{N}])['‘‚‹]([^'’‘‚‹›\n]+?)['’‘›](?=[^\p{L}\p{M}\p{N}]|$)/gu;

function normalizeInnerQuotesAndApostrophes(
  text: string,
  rule: PunctuationRule,
): string {
  const sentinel = "\uE000";
  const protectedText = text.replace(
    APOSTROPHE_BETWEEN_LETTERS_RE,
    `$1${sentinel}$2`,
  );
  const replacedSingles = protectedText.replace(
    SINGLE_QUOTED_SPAN_RE,
    (_m, pre: string, inner: string) =>
      `${pre}${rule.singleOpen}${inner}${rule.singleClose}`,
  );
  return replacedSingles.split(sentinel).join(rule.apostrophe);
}

export function stripOuterDoubleQuotes(text: string): string {
  return text
    .trim()
    .replace(/^([«„“""《「『]+)/u, "")
    .replace(/([»”“""》」』]+)([.,。，।។။]?)$/u, "$2")
    .trim();
}

export function formatQuotedBlockLines(
  rawLines: string[],
  rule: PunctuationRule,
  isFullSentence = true,
): string[] {
  if (rawLines.length === 0) return [];
  const lines = rawLines.map((line) =>
    normalizeInnerQuotesAndApostrophes(line.trim(), rule),
  );

  lines[0] = `${rule.doubleOpen}${lines[0].replace(ANY_DOUBLE_OPEN_RE, "")}`;

  const lastIdx = lines.length - 1;
  let last = lines[lastIdx];
  let trailingPunct = "";

  const closeMatch = ANY_DOUBLE_CLOSE_RE.exec(last);
  if (closeMatch) {
    last = last.slice(0, closeMatch.index);
    trailingPunct = closeMatch[2].trim();
  }

  const endCharMatch = /([.,!?…。，！？।។။]+)$/u.exec(last);
  let innerEndPunct = "";
  if (endCharMatch) {
    innerEndPunct = endCharMatch[1];
    last = last.slice(0, endCharMatch.index);
  }

  const effectivePunct = innerEndPunct || trailingPunct;
  const isPeriodLike = /^[.。।។။]+$/u.test(effectivePunct);
  const normalizedPunct = isPeriodLike
    ? "."
    : effectivePunct === "，"
      ? ","
      : effectivePunct;

  const periodChar = rule.sentencePeriodChar ?? ".";
  const putPeriodInside =
    rule.periodMode === "inside" ||
    (rule.periodMode === "sentence_inside_phrase_outside" && isFullSentence);

  if (normalizedPunct === ".") {
    if (periodChar === "") {
      lines[lastIdx] = `${last}${rule.doubleClose}`;
    } else {
      lines[lastIdx] = putPeriodInside
        ? `${last}${periodChar}${rule.doubleClose}`
        : `${last}${rule.doubleClose}${periodChar}`;
    }
  } else if (normalizedPunct === ",") {
    lines[lastIdx] = rule.commaInsideQuote
      ? `${last},${rule.doubleClose}`
      : `${last}${rule.doubleClose},`;
  } else if (normalizedPunct) {
    lines[lastIdx] = `${last}${normalizedPunct}${rule.doubleClose}`;
  } else {
    lines[lastIdx] = `${last}${rule.doubleClose}`;
  }

  return lines;
}

export function formatStandaloneTitle(
  rawTitle: string,
  sourceEnglish: string,
  sourceChinese: string,
  rule: PunctuationRule,
): string {
  const core = normalizeInnerQuotesAndApostrophes(
    stripOuterDoubleQuotes(rawTitle).replace(/[.,。，।។။]+$/u, "").trim(),
    rule,
  );
  const srcEn = (sourceEnglish || "").trim();
  const srcZh = (sourceChinese || "").trim();

  const wantsComma = srcZh.endsWith("，") || srcEn.endsWith(',"') || srcEn.endsWith(",");
  const wantsPeriod =
    !wantsComma &&
    (srcZh.endsWith("。") || srcEn.endsWith('."') || srcEn.endsWith("."));

  const periodChar = rule.sentencePeriodChar ?? ".";
  const periodInside = rule.periodMode === "inside";
  if (wantsComma) {
    return rule.commaInsideQuote
      ? `${rule.doubleOpen}${core},${rule.doubleClose}`
      : `${rule.doubleOpen}${core}${rule.doubleClose},`;
  }
  if (wantsPeriod) {
    if (periodChar === "") {
      return `${rule.doubleOpen}${core}${rule.doubleClose}`;
    }
    return periodInside
      ? `${rule.doubleOpen}${core}${periodChar}${rule.doubleClose}`
      : `${rule.doubleOpen}${core}${rule.doubleClose}${periodChar}`;
  }
  return `${rule.doubleOpen}${core}${rule.doubleClose}`;
}

export function formatBibleBlockAndCitation(
  rawVerseLines: string[],
  rawCitationRef: string,
  rule: PunctuationRule,
): { verseLines: string[]; citationText: string } {
  const cleanRef = (rawCitationRef || "")
    .trim()
    .replace(/^[（(]?/, "(")
    .replace(/[)）]?[.,。，।។။]*$/, ")");

  const lines = rawVerseLines.map((l) =>
    normalizeInnerQuotesAndApostrophes(l.trim(), rule),
  );
  if (lines.length === 0) {
    return { verseLines: [], citationText: cleanRef };
  }

  lines[0] = `${rule.doubleOpen}${lines[0].replace(ANY_DOUBLE_OPEN_RE, "")}`;
  const lastIdx = lines.length - 1;
  let last = lines[lastIdx].replace(ANY_DOUBLE_CLOSE_RE, "");
  last = last.replace(/[.,。，।។။]+$/u, "");

  const periodChar = rule.sentencePeriodChar ?? ".";
  if (rule.bibleCitationMode === "period_inside_quote_no_trailing") {
    lines[lastIdx] = `${last}${periodChar}${rule.doubleClose}`;
    return { verseLines: lines, citationText: cleanRef };
  }

  lines[lastIdx] = `${last}${rule.doubleClose}`;
  return {
    verseLines: lines,
    citationText: periodChar ? `${cleanRef}${periodChar}` : cleanRef,
  };
}

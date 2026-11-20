import type { PunctuationRule } from "../types/domain";

const ANY_DOUBLE_OPEN_RE = /^[\s]*([«„“""❝「『]+\s*)/u;
const ANY_DOUBLE_CLOSE_RE = /(\s*[»”“""❞」』]+)([\s.,。，!?！？।។။։]*)$/u;
const APOSTROPHE_BETWEEN_LETTERS_RE = /([\p{L}\p{M}\p{N}])['’ʼ]([\p{L}\p{M}\p{N}])/gu;

const OPEN_DOUBLE_CHARS = new Set(["«", "„", "“", "❝", "「", "『"]);
const CLOSE_DOUBLE_CHARS = new Set(["»", "”", "❞", "」", "』"]);
const OPEN_SINGLE_CHARS = new Set(["‘", "‚", "‹"]);
const CLOSE_SINGLE_CHARS = new Set(["’", "›"]);

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{L}\p{M}\p{N}]/u.test(ch);
}

/**
 * Multi-line quote-depth normalizer:
 * - Protects intra-word apostrophes (don't, обов'язок, l'homme) and maps them to rule.apostrophe (if set).
 * - If rule.preserveInnerQuotes is true (e.g. Korean), preserves all inner quotes as-is.
 * - Converts inner nested double quotes ("...", “...”, «...», „...“) and inner single quotes
 *   across single or multiple lines into rule.singleOpen/singleClose (depth 1 -> 2)
 *   and rule.tertiaryOpen/tertiaryClose (depth 2 -> 3).
 */
export function normalizeBlockInnerQuotes(
  rawLines: string[],
  rule: PunctuationRule,
): string[] {
  const sentinel = "\uE000";
  const apoReplacement = rule.apostrophe || "'";

  if (rule.preserveInnerQuotes) {
    return rawLines.map((l) => l.trim());
  }

  const sOpen = rule.singleOpen || rule.doubleOpen;
  const sClose = rule.singleClose || rule.doubleClose;
  const tOpen = rule.tertiaryOpen || sOpen;
  const tClose = rule.tertiaryClose || sClose;

  let insideInner = false;
  let insideTertiary = false;

  const processed = rawLines.map((raw) => {
    const protectedText = raw.trim().replace(APOSTROPHE_BETWEEN_LETTERS_RE, `$1${sentinel}$2`);
    const chars = [...protectedText];
    let out = "";

    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i + 1 < chars.length ? chars[i + 1] : undefined;

      // Double-quote characters inside an outer-quoted block -> downgrade to inner (single) or tertiary
      if (ch === '"' || OPEN_DOUBLE_CHARS.has(ch) || CLOSE_DOUBLE_CHARS.has(ch)) {
        const isAmbiguous = ch === '"' || ch === "“";
        let isOpening: boolean;
        if (OPEN_DOUBLE_CHARS.has(ch) && ch !== "“") {
          isOpening = true;
        } else if (CLOSE_DOUBLE_CHARS.has(ch)) {
          isOpening = false;
        } else if (isAmbiguous) {
          // For German/Russian/etc. “ can be closing if insideInner is already open and followed by space/punct/end
          if (ch === "“" && insideInner && (!next || /[\s.,;:!?)\]»”"']/.test(next))) {
            isOpening = false;
          } else {
            isOpening = !insideInner;
          }
        } else {
          isOpening = !insideInner;
        }

        if (isOpening) {
          if (!insideInner) {
            insideInner = true;
            out += sOpen;
          } else if (!insideTertiary) {
            insideTertiary = true;
            out += tOpen;
          } else {
            out += tOpen;
          }
        } else {
          if (insideTertiary) {
            insideTertiary = false;
            out += tClose;
          } else if (insideInner) {
            insideInner = false;
            out += sClose;
          } else {
            out += sClose;
          }
        }
        continue;
      }

      // Single-quote characters (not protected intra-word apostrophes)
      if (ch === "'" || OPEN_SINGLE_CHARS.has(ch) || CLOSE_SINGLE_CHARS.has(ch)) {
        // Keep trailing possessive apostrophe like "Jesus' " or "Gods'" when preceded by letter and not currently closing an open single quote
        if ((ch === "'" || ch === "’") && isWordChar(prev) && !insideInner && !insideTertiary) {
          out += apoReplacement;
          continue;
        }
        const isOpening =
          OPEN_SINGLE_CHARS.has(ch)
            ? true
            : CLOSE_SINGLE_CHARS.has(ch)
              ? false
              : !insideInner && !insideTertiary
                ? true
                : insideInner && !insideTertiary && (!prev || /[\s([{«„“"'-]/.test(prev))
                  ? true
                  : false;

        if (isOpening) {
          if (!insideInner) {
            insideInner = true;
            out += sOpen;
          } else {
            insideTertiary = true;
            out += tOpen;
          }
        } else {
          if (insideTertiary) {
            insideTertiary = false;
            out += tClose;
          } else {
            insideInner = false;
            out += sClose;
          }
        }
        continue;
      }

      out += ch;
    }

    return out.split(sentinel).join(apoReplacement);
  });

  return processed;
}

export function stripOuterDoubleQuotes(text: string): string {
  return text
    .trim()
    .replace(/^([«„“""《「『]+\s*)/u, "")
    .replace(/(\s*[»”“""》」』]+)([.,。，।។။։]?)$/u, "$2")
    .trim();
}

function collapseAdjacentOuterQuote(text: string, closeQuote: string, rule: PunctuationRule): string {
  if (!rule.noAdjacentDoubleQuotes || !closeQuote) return text;
  const esc = closeQuote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${esc}\\s*${esc}$`), closeQuote);
}

function resolveOuterQuotes(rule: PunctuationRule, hasCitation: boolean): { open: string; close: string } {
  if (!hasCitation && rule.noCitationDoubleOpen && rule.noCitationDoubleClose) {
    return { open: rule.noCitationDoubleOpen, close: rule.noCitationDoubleClose };
  }
  return { open: rule.doubleOpen, close: rule.doubleClose };
}

function applyEndingPattern(
  core: string,
  punct: string,
  closeQuote: string,
  rule: PunctuationRule,
  isFullSentence: boolean,
): string {
  const periodChar = rule.sentencePeriodChar ?? ".";

  // Check explicit periodQuotePattern (M column: e.g. ".“", "»։", "”.")
  if (punct === "." && rule.periodQuotePattern) {
    const pat = rule.periodQuotePattern.trim();
    if (pat) {
      if (pat.startsWith(closeQuote.trim())) {
        const suffix = pat.slice(closeQuote.trim().length);
        return `${core}${closeQuote}${suffix}`;
      }
      if (pat.endsWith(closeQuote.trim())) {
        const prefix = pat.slice(0, pat.length - closeQuote.trim().length);
        return `${core}${prefix}${closeQuote}`;
      }
      return `${core}${pat}`;
    }
  }

  // Check explicit exclamQuestionQuotePattern (N column: e.g. "?“\n!“", "?”\n!”")
  if ((punct === "?" || punct === "!") && rule.exclamQuestionQuotePattern) {
    const tokens = rule.exclamQuestionQuotePattern
      .split(/[\r\n,，/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const hit = tokens.find((t) => t.includes(punct));
    if (hit) {
      return `${core}${hit}`;
    }
  }

  const putPeriodInside =
    rule.periodMode === "inside" ||
    (rule.periodMode === "sentence_inside_phrase_outside" && isFullSentence);

  if (punct === ".") {
    if (periodChar === "") return `${core}${closeQuote}`;
    return putPeriodInside
      ? `${core}${periodChar}${closeQuote}`
      : `${core}${closeQuote}${periodChar}`;
  }
  if (punct === ",") {
    return rule.commaInsideQuote
      ? `${core},${closeQuote}`
      : `${core}${closeQuote},`;
  }
  if (punct) {
    return `${core}${punct}${closeQuote}`;
  }
  return `${core}${closeQuote}`;
}

export function formatQuotedBlockLines(
  rawLines: string[],
  rule: PunctuationRule,
  isFullSentence = true,
  hasCitation = true,
): string[] {
  if (rawLines.length === 0) return [];
  const { open: dOpen, close: dClose } = resolveOuterQuotes(rule, hasCitation);

  // Strip outer quotes from first/last line BEFORE running inner-quote depth state machine.
  // Only strip a leading double quote on line 0 if it is NOT an inner quote closed mid-line
  // (e.g. '“Menunggu” berarti...' must keep “Menunggu” as an inner quote!).
  const stripped = rawLines.map((l) => l.trim());
  let strippedLeadingOuter = false;
  const leadingMatch = ANY_DOUBLE_OPEN_RE.exec(stripped[0]);
  if (leadingMatch) {
    const restLine0 = stripped[0].slice(leadingMatch[0].length);
    const closedMidLine0 = /[»”"❞」』]/u.test(restLine0.replace(ANY_DOUBLE_CLOSE_RE, ""));
    if (!closedMidLine0) {
      stripped[0] = restLine0;
      strippedLeadingOuter = true;
    }
  }

  const lastIdx = stripped.length - 1;
  let lastRaw = stripped[lastIdx];
  let trailingPunct = "";
  if (strippedLeadingOuter) {
    const closeMatch = ANY_DOUBLE_CLOSE_RE.exec(lastRaw);
    if (closeMatch) {
      lastRaw = lastRaw.slice(0, closeMatch.index);
      trailingPunct = closeMatch[2].trim();
    }
  }
  stripped[lastIdx] = lastRaw;

  const lines = normalizeBlockInnerQuotes(stripped, rule);

  // Prepend outer opening quote (collapse duplicate if noAdjacentDoubleQuotes)
  if (rule.noAdjacentDoubleQuotes && lines[0].startsWith(dOpen)) {
    lines[0] = lines[0];
  } else {
    lines[0] = `${dOpen}${lines[0]}`;
  }

  let last = lines[lastIdx];
  const endCharMatch = /([.,!?…。，！？।។။։]+)$/u.exec(last);
  let innerEndPunct = "";
  if (endCharMatch) {
    innerEndPunct = endCharMatch[1];
    last = last.slice(0, endCharMatch.index);
  }

  const effectivePunct = innerEndPunct || trailingPunct;
  const isPeriodLike = /^[.。।។။։]+$/u.test(effectivePunct);
  const normalizedPunct = isPeriodLike
    ? "."
    : effectivePunct === "，"
      ? ","
      : effectivePunct;

  lines[lastIdx] = collapseAdjacentOuterQuote(
    applyEndingPattern(last, normalizedPunct, dClose, rule, isFullSentence),
    dClose,
    rule,
  );

  return lines;
}

export function formatStandaloneTitle(
  rawTitle: string,
  sourceEnglish: string,
  sourceChinese: string,
  rule: PunctuationRule,
): string {
  const stripped = stripOuterDoubleQuotes(rawTitle)
    .replace(/[.,。，।។။։]+$/u, "")
    .trim();
  const core = normalizeBlockInnerQuotes([stripped], rule)[0] ?? stripped;
  const srcEn = (sourceEnglish || "").trim();
  const srcZh = (sourceChinese || "").trim();
  const { open: dOpen, close: dClose } = resolveOuterQuotes(rule, false);

  const wantsComma = srcZh.endsWith("，") || srcEn.endsWith(',"') || srcEn.endsWith(",");
  const wantsPeriod =
    !wantsComma &&
    (srcZh.endsWith("。") || srcEn.endsWith('."') || srcEn.endsWith("."));

  if (wantsComma) {
    return `${dOpen}${applyEndingPattern(core, ",", dClose, rule, false)}`;
  }
  if (wantsPeriod) {
    return `${dOpen}${applyEndingPattern(core, ".", dClose, rule, false)}`;
  }
  return `${dOpen}${core}${dClose}`;
}

export function formatBibleBlockAndCitation(
  rawVerseLines: string[],
  rawCitationRef: string,
  rule: PunctuationRule,
): { verseLines: string[]; citationText: string } {
  const cleanRef = (rawCitationRef || "")
    .trim()
    .replace(/^[（(]?/, "(")
    .replace(/[)）]?[.,。，।។။։]*$/, ")");

  if (rawVerseLines.length === 0) {
    return { verseLines: [], citationText: cleanRef };
  }

  const stripped = rawVerseLines.map((l) => l.trim());
  stripped[0] = stripped[0].replace(ANY_DOUBLE_OPEN_RE, "");
  const lastIdx = stripped.length - 1;
  stripped[lastIdx] = stripped[lastIdx]
    .replace(ANY_DOUBLE_CLOSE_RE, "")
    .replace(/[.,。，।។။։]+$/u, "");

  const lines = normalizeBlockInnerQuotes(stripped, rule);
  const { open: dOpen, close: dClose } = resolveOuterQuotes(rule, true);
  lines[0] = `${dOpen}${lines[0]}`;

  const periodChar = rule.sentencePeriodChar ?? ".";
  if (rule.bibleCitationMode === "period_inside_quote_no_trailing") {
    lines[lastIdx] = collapseAdjacentOuterQuote(
      `${lines[lastIdx]}${periodChar}${dClose}`,
      dClose,
      rule,
    );
    return { verseLines: lines, citationText: cleanRef };
  }

  lines[lastIdx] = collapseAdjacentOuterQuote(`${lines[lastIdx]}${dClose}`, dClose, rule);
  return { verseLines: lines, citationText: `${cleanRef}${periodChar}` };
}

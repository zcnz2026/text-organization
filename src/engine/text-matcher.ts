import type {
  ArticleCatalogEntry,
  ArticleParagraph,
  BibleEntry,
  CitationPair,
  HymnEntry,
  IdiomEntry,
  LanguageCatalog,
  RosterEntry,
} from "../catalog/catalog-types";
import type { CitationVariant, ScriptRow } from "../types/domain";
import { stripOuterDoubleQuotes } from "./punctuation";

export interface TruncationSpec {
  hasTruncation: boolean;
  fullEnSentence: string;
  deletedEnPrefix: string;
}

export function parseTruncationSpec(row: ScriptRow): TruncationSpec {
  const combinedMeta = `${row.remark || ""}\n${row.note || ""}`;
  if (!combinedMeta.includes("截取")) {
    return { hasTruncation: false, fullEnSentence: "", deletedEnPrefix: "" };
  }
  const m = /截取[：:\s]*([^\r\n]+)/u.exec(combinedMeta);
  const fullEnSentence = m ? m[1].trim() : "";

  // 1. Prefer explicit strikethrough runs from Google Sheets cell formatting if present
  if (row.strikethroughTexts && row.strikethroughTexts.length > 0) {
    return {
      hasTruncation: true,
      fullEnSentence,
      deletedEnPrefix: row.strikethroughTexts.join(" ").trim(),
    };
  }

  // 2. Otherwise compute deleted prefix by diffing fullEnSentence against row.english
  const keptClean = stripOuterDoubleQuotes(row.english || "")
    .replace(/^(?:……|\.\.\.|…)\s*/u, "")
    .trim();
  if (fullEnSentence && keptClean.length >= 6) {
    const lowFull = fullEnSentence.toLowerCase();
    const probe = keptClean.slice(0, Math.min(28, keptClean.length)).toLowerCase();
    const pos = lowFull.indexOf(probe);
    if (pos > 0) {
      return {
        hasTruncation: true,
        fullEnSentence,
        deletedEnPrefix: fullEnSentence.slice(0, pos).trim(),
      };
    }
  }

  return { hasTruncation: true, fullEnSentence, deletedEnPrefix: "" };
}

/**
 * Extracts ONLY the complete un-truncated target sentence corresponding to the truncated row
 * PLUS the immediately following 1 sentence (merged), instead of dumping the whole paragraph!
 */
export function extractTruncatedSentencePair(
  fullTargetParagraph: string,
  fullEnParagraph: string,
  row: ScriptRow,
): string {
  const targetClean = (fullTargetParagraph || "").replace(/\s+/g, " ").trim();
  if (!targetClean) return "";
  const targetSentences = targetClean
    .split(/(?<=[.!?。！？।។။])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (targetSentences.length <= 2) return targetSentences.join(" ");

  const spec = parseTruncationSpec(row);
  const enClean = (fullEnParagraph || "").replace(/\s+/g, " ").trim();
  const enSentences = enClean
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);

  let targetIdx = 0;
  const searchEn = normMatchKey(spec.fullEnSentence || row.english).slice(0, 28);
  if (searchEn.length >= 6 && enSentences.length > 0) {
    const enIdx = enSentences.findIndex((s) => normMatchKey(s).includes(searchEn));
    if (enIdx >= 0) {
      targetIdx = Math.min(
        targetSentences.length - 1,
        Math.round((enIdx / Math.max(1, enSentences.length - 1)) * (targetSentences.length - 1)),
      );
    }
  }

  const pair = targetSentences.slice(targetIdx, Math.min(targetSentences.length, targetIdx + 2));
  return pair.join(" ");
}

export function normMatchKey(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（(]\s*s\s*[)）]/g, "")
    .replace(/^[\d\-_oO]+\s*/, "")
    .replace(/[《》“”""''‘’«»„‚()（）\[\]【】・·—\-_:：,，.。!?！？\s]+/gu, "");
}

function normBibleRef(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[（(]+|[)）.,。，]+$/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const ZH_VOL_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};

function extractVolumeNumber(...texts: string[]): number | null {
  for (const raw of texts) {
    const s = raw || "";
    const zh = /卷\s*([一二三四五六七八九1-9])/u.exec(s);
    if (zh && ZH_VOL_DIGITS[zh[1]]) return ZH_VOL_DIGITS[zh[1]];
    const en = /\bvol\.?\s*(\d+)\b/i.exec(s);
    if (en) return Number.parseInt(en[1], 10);
  }
  return null;
}

export function findArticleInCatalog(
  articles: ArticleCatalogEntry[],
  filterHint: string,
  zhCite = "",
  enCite = "",
): ArticleCatalogEntry | null {
  const rawParts = filterHint.split(/[・·\n]/).map((p) => p.trim()).filter(Boolean);
  const leafZh = rawParts[rawParts.length - 1] || filterHint;
  const leafKey = normMatchKey(leafZh);
  const fullKey = normMatchKey(filterHint);
  const enClean = enCite
    .replace(/^from\s+the\s+word,\s*vol\.\s*\d+\.[^.]*\./i, "")
    .replace(/^\(the\s+word,\s*vol\.\s*\d+\.[^.]*\./i, "")
    .replace(/[).]+$/g, "")
    .trim();
  const enKey = normMatchKey(enClean);
  const wantVol = extractVolumeNumber(filterHint, zhCite, enCite);

  const searchIn = (pool: ArticleCatalogEntry[]): ArticleCatalogEntry | null => {
    for (const a of pool) {
      const aZh = normMatchKey(a.zhTitle);
      const aEn = normMatchKey(a.enTitle);
      const aSub = normMatchKey(a.zhSubtitleCite);
      const aBrk = normMatchKey(a.zhBracketCite);
      if (leafKey && aZh && (aZh === leafKey || aZh.endsWith(leafKey))) return a;
      if (enKey && aEn && aEn === enKey) return a;
      if (fullKey && aSub && aSub.includes(leafKey) && leafKey.length >= 4) return a;
      if (fullKey && aBrk && aBrk.includes(leafKey) && leafKey.length >= 4) return a;
    }

    if (zhCite.includes("……") || zhCite.includes("...")) {
      const [prefix, suffix] = leafZh.split(/……|\.\.\./).map(normMatchKey);
      for (const a of pool) {
        const aZh = normMatchKey(a.zhTitle);
        if (prefix && aZh.includes(prefix) && (!suffix || aZh.endsWith(suffix))) return a;
      }
    }
    return null;
  };

  if (wantVol !== null) {
    const sameVolPool = articles.filter((a) => {
      const aVol = extractVolumeNumber(a.zhBracketCite, a.zhSubtitleCite, a.enTitle);
      return aVol === wantVol;
    });
    const exactVolHit = searchIn(sameVolPool);
    if (exactVolHit) return exactVolHit;
  }

  return searchIn(articles);
}

export function locateParagraphInManuscript(
  paragraphs: ArticleParagraph[],
  sourceRows: ScriptRow[],
): {
  matchedText: string;
  fullParagraphTarget: string;
  contextWindowTarget: string;
  fullParagraphEn: string;
  isPartial: boolean;
  truncatedStart: boolean;
} | null {
  if (paragraphs.length === 0 || sourceRows.length === 0) return null;
  const firstRow = sourceRows[0];
  const lastRow = sourceRows[sourceRows.length - 1];
  const truncMatch = /涉及截取[：:]\s*(.+)$/u.exec(firstRow.remark.trim());
  const firstEnProbe = normMatchKey(truncMatch ? truncMatch[1] : firstRow.english).slice(0, 32);
  const firstZhProbe = normMatchKey(firstRow.chinese).slice(0, 14);
  const lastZhProbe = normMatchKey(lastRow.chinese).slice(-12);
  const lastEnProbe = normMatchKey(lastRow.english).slice(-28);

  // Additional probes from 2nd row and middle row to disambiguate duplicate opening sentences
  // when the same opening question/phrase appears earlier as a brief intro transition
  const secondRow = sourceRows.length >= 2 ? sourceRows[1] : null;
  const midRow = sourceRows.length >= 4 ? sourceRows[Math.floor(sourceRows.length / 2)] : null;
  const secondZhProbe = secondRow ? normMatchKey(secondRow.chinese).slice(0, 14) : "";
  const secondEnProbe = secondRow ? normMatchKey(secondRow.english).slice(0, 28) : "";
  const midZhProbe = midRow ? normMatchKey(midRow.chinese).slice(0, 14) : "";
  const midEnProbe = midRow ? normMatchKey(midRow.english).slice(0, 28) : "";

  const matchesProbe = (p: ArticleParagraph, zhP: string, enP: string) =>
    (zhP.length >= 4 && normMatchKey(p.chinese).includes(zhP)) ||
    (enP.length >= 8 && normMatchKey(p.english).includes(enP));

  // Score all candidate starting paragraphs
  let bestStart = -1;
  let bestEnd = -1;
  let bestScore = -1;

  for (let i = 0; i < paragraphs.length; i += 1) {
    if (!matchesProbe(paragraphs[i], firstZhProbe, firstEnProbe)) continue;
    let score = 2;
    let candEnd = i;
    const windowMax = Math.min(paragraphs.length, i + 10);

    // Penalize short title rows when looking for a multi-row body passage
    if (sourceRows.length >= 3 && paragraphs[i].target.trim().split(/\s+/).length < sourceRows.length) {
      score -= 1;
    }

    for (let j = i; j < windowMax; j += 1) {
      if (secondZhProbe && matchesProbe(paragraphs[j], secondZhProbe, secondEnProbe)) {
        score += j === i ? 6 : 3;
      }
      if (midZhProbe && matchesProbe(paragraphs[j], midZhProbe, midEnProbe)) {
        score += 3;
      }
      if (matchesProbe(paragraphs[j], lastZhProbe, lastEnProbe)) {
        score += 5;
        candEnd = j;
        break;
      }
    }
    // Prefer tighter spans (e.g. body paragraph starting at i=1 over intro+body spanning 0..1)
    score -= candEnd - i;

    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestEnd = candEnd;
    }
  }

  if (bestStart < 0) return null;
  const startIdx = bestStart;
  const endIdx = bestEnd;

  // If the script has a mid-block omission (…… / 有省略) and multiple paragraphs sit between startIdx and endIdx,
  // select only the paragraphs that match actual script rows so omitted middle paragraphs are NOT pulled in!
  const hasMidOmission = sourceRows.slice(0, -1).some(
    (r) => r.remark.includes("有省略") || r.chinese.includes("……") || r.english.includes("…"),
  );
  let selectedParagraphs = paragraphs.slice(startIdx, endIdx + 1);
  if (hasMidOmission && selectedParagraphs.length > 2) {
    const rowProbes = sourceRows.map((r) => ({
      zh: normMatchKey(r.chinese).slice(0, 12),
      en: normMatchKey(r.english).slice(0, 24),
    }));
    const kept = selectedParagraphs.filter((p, idx) => {
      if (idx === 0 || idx === selectedParagraphs.length - 1) return true;
      const pZh = normMatchKey(p.chinese);
      const pEn = normMatchKey(p.english);
      return rowProbes.some(
        (pr) => (pr.zh.length >= 4 && pZh.includes(pr.zh)) || (pr.en.length >= 8 && pEn.includes(pr.en)),
      );
    });
    if (kept.length >= 2) selectedParagraphs = kept;
  }

  const combinedTarget = selectedParagraphs.map((p) => p.target.trim()).filter(Boolean).join(" ");
  const combinedEn = selectedParagraphs.map((p) => p.english.trim()).filter(Boolean).join(" ");
  const fullSpanZh = normMatchKey(selectedParagraphs.map((p) => p.chinese).join(""));
  const allRowsZh = normMatchKey(sourceRows.map((r) => r.chinese).join(""));

  if (fullSpanZh.length > allRowsZh.length + 10) {
    const startPos = firstZhProbe ? fullSpanZh.indexOf(firstZhProbe) : 0;
    const startRatio = Math.max(0, (startPos >= 0 ? startPos : 0) / Math.max(1, fullSpanZh.length));
    const endPos = lastZhProbe ? fullSpanZh.lastIndexOf(lastZhProbe) : -1;
    const endRatio =
      endPos >= 0
        ? Math.min(1, (endPos + lastZhProbe.length) / Math.max(1, fullSpanZh.length))
        : Math.min(1, startRatio + allRowsZh.length / Math.max(1, fullSpanZh.length));
    if (startRatio > 0.04 || endRatio < 0.94) {
      const margin = combinedTarget.length > 6000 ? 0.12 : 0.18;
      const contextWindowTarget =
        combinedTarget.length > 4000
          ? sliceByClauseRatio(combinedTarget, Math.max(0, startRatio - margin), Math.min(1, endRatio + margin))
          : combinedTarget;
      return {
        matchedText: sliceByClauseRatio(combinedTarget, startRatio, endRatio),
        fullParagraphTarget: combinedTarget,
        contextWindowTarget,
        fullParagraphEn:
          combinedEn.length > 4000
            ? sliceByClauseRatio(combinedEn, Math.max(0, startRatio - margin), Math.min(1, endRatio + margin))
            : combinedEn,
        isPartial: true,
        truncatedStart: Boolean(truncMatch),
      };
    }
  }
  return {
    matchedText: combinedTarget,
    fullParagraphTarget: combinedTarget,
    contextWindowTarget: combinedTarget,
    fullParagraphEn: combinedEn,
    isPartial: false,
    truncatedStart: Boolean(truncMatch),
  };
}

function sliceByClauseRatio(text: string, startRatio: number, endRatio: number): string {
  const clauses = text.split(/(?<=[.!?。！？;；,，—–])\s+/u).map((s) => s.trim()).filter(Boolean);
  if (clauses.length <= 1) return text;
  const totalLen = text.length;
  let acc = 0;
  const picked: string[] = [];
  for (const c of clauses) {
    const mid = (acc + c.length * 0.5) / totalLen;
    if (mid >= startRatio - 0.02 && mid <= endRatio + 0.02) picked.push(c);
    acc += c.length + 1;
  }
  return picked.length > 0 ? picked.join(" ") : clauses[0];
}

function splitBibleTargetAndRef(raw: string): { body: string; ref: string } {
  const trimmed = (raw || "").trim();
  const m = /\(([^()]+?\d+[:.,–\-]\d+[^()]*)\)[.,。]?$/u.exec(trimmed);
  if (!m) return { body: trimmed, ref: "" };
  return { body: trimmed.slice(0, m.index).trim(), ref: m[1].trim() };
}

function mergeBibleRangeRef(
  firstRef: string,
  lastRef: string,
  startVerseNum?: number,
  endVerseNum?: number,
): string {
  if (firstRef && lastRef && firstRef !== lastRef) {
    const endVerse = /(\d+)\s*$/.exec(lastRef)?.[1];
    if (endVerse && !firstRef.endsWith(`–${endVerse}`) && !firstRef.endsWith(`-${endVerse}`)) {
      return `${firstRef}–${endVerse}`;
    }
    return firstRef;
  }
  const single = firstRef || lastRef;
  if (single && startVerseNum && endVerseNum && endVerseNum > startVerseNum) {
    // e.g. parts[0].ref was "" and parts[last].ref was "Roma 7:17" -> upgrade to "Roma 7:15–17"
    if (new RegExp(`[:.,]\\s*${endVerseNum}\\s*$`).test(single)) {
      return single.replace(new RegExp(`([:.,]\\s*)${endVerseNum}\\s*$`), `$1${startVerseNum}–${endVerseNum}`);
    }
    if (new RegExp(`[:.,]\\s*${startVerseNum}\\s*$`).test(single)) {
      return `${single}–${endVerseNum}`;
    }
  }
  return single;
}

function extractChapVerseNums(ref: string): { chap: number; startV: number; endV: number } | null {
  const m = /(\d+)\s*[:：.]\s*(\d+)(?:\s*[-–—]\s*(\d+))?/.exec(ref || "");
  if (!m) return null;
  const chap = Number.parseInt(m[1], 10);
  const startV = Number.parseInt(m[2], 10);
  const endV = m[3] ? Number.parseInt(m[3], 10) : startV;
  return { chap, startV, endV };
}

export function findBibleVerse(
  entries: BibleEntry[],
  refHint: string,
  verseRows: ScriptRow[],
): { text: string; targetCitationRef: string; truncatedStart: boolean; source?: string } | null {
  if (entries.length === 0 || verseRows.length === 0) return null;

  const keyRef = normBibleRef(refHint);
  const cv = extractChapVerseNums(refHint);
  const truncSpec0 = parseTruncationSpec(verseRows[0]);
  const firstEn = normMatchKey(truncSpec0.fullEnSentence || verseRows[0]?.english || "").slice(0, 28);
  const firstZh = normMatchKey(verseRows[0]?.chinese ?? "").slice(0, 14);
  const lastEn = normMatchKey(verseRows[verseRows.length - 1]?.english ?? "").slice(-28);
  const lastZh = normMatchKey(verseRows[verseRows.length - 1]?.chinese ?? "").slice(-14);
  const allRowProbes = verseRows.map((r) => ({
    zh: normMatchKey(r.chinese).slice(0, 12),
    en: normMatchKey(r.english).slice(0, 22),
  }));

  let startIdx = -1;
  if (keyRef) startIdx = entries.findIndex((e) => normBibleRef(e.chapterRef) === keyRef);

  // Range lookup (e.g. "luke 17:24-25" or "romans 7:15-17" even if library uses localized book name like "Lukas 17:24" or "Roma 7:15")
  if (startIdx < 0 && cv && cv.endV > cv.startV && cv.endV - cv.startV <= 8) {
    const bookChapMatch = /^(.+?\d+):(\d+)-(\d+)$/.exec(keyRef);
    let candStart = -1;
    if (bookChapMatch) {
      candStart = entries.findIndex((e) => normBibleRef(e.chapterRef) === `${bookChapMatch[1]}:${cv.startV}`);
    }
    if (candStart < 0) {
      // Match by exact chapter:startV numbers + text confirmation (avoids localized book name mismatch!)
      candStart = entries.findIndex((e) => {
        const eCv = extractChapVerseNums(e.chapterRef || e.targetText);
        if (!eCv || eCv.chap !== cv.chap || eCv.startV !== cv.startV) return false;
        const ez = normMatchKey(e.chinese);
        const ee = normMatchKey(e.english);
        return (firstZh.length >= 4 && ez.includes(firstZh)) || (firstEn.length >= 8 && ee.includes(firstEn));
      });
    }
    if (candStart >= 0) {
      const collected: BibleEntry[] = [entries[candStart]];
      for (let j = candStart + 1; j < Math.min(entries.length, candStart + (cv.endV - cv.startV) + 2); j += 1) {
        const eCv = extractChapVerseNums(entries[j].chapterRef || entries[j].targetText);
        if (eCv && eCv.chap === cv.chap && eCv.startV > cv.startV && eCv.startV <= cv.endV) {
          collected.push(entries[j]);
        }
      }
      if (collected.length >= 2) {
        const parts = collected.map((c) => splitBibleTargetAndRef(c.targetText));
        const mergedBody = parts.map((p) => stripOuterDoubleQuotes(p.body)).join(" ");
        const mergedRef =
          mergeBibleRangeRef(parts[0].ref, parts[parts.length - 1].ref, cv.startV, cv.endV) ||
          refHint.replace(/^[（(]|[)）.,，。]+$/g, "");
        const trunc =
          truncSpec0.hasTruncation ||
          verseRows[0]?.english.trim().startsWith("…") ||
          verseRows[0]?.english.trim().startsWith('"...') ||
          verseRows[0]?.english.trim().startsWith('"…');
        const mergedSource = [...new Set(collected.map((c) => (c.source || "").trim()).filter(Boolean))].join(" / ");
        return {
          text: mergedBody,
          targetCitationRef: `(${mergedRef})`,
          truncatedStart: Boolean(trunc),
          ...(mergedSource ? { source: mergedSource } : {}),
        };
      }
    }
  }

  // Fallback: score all entries by chapter:verse numbers + ALL verse rows (prevents "For as the lightning" matching Matt 24:27 instead of Luke 17:24!)
  if (startIdx < 0) {
    let bestScore = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const ez = normMatchKey(e.chinese);
      const ee = normMatchKey(e.english);
      let score = 0;
      if (firstEn.length >= 8 && ee.includes(firstEn)) score += 4;
      if (firstZh.length >= 5 && ez.includes(firstZh)) score += 5;
      if (score === 0) continue;

      const eCv = extractChapVerseNums(e.chapterRef || e.targetText);
      if (cv && eCv && eCv.chap === cv.chap && eCv.startV === cv.startV) {
        score += 15;
      }
      // Check how many subsequent script rows match i .. i+3
      const windowZh = normMatchKey(entries.slice(i, i + 4).map((x) => x.chinese).join(""));
      const windowEn = normMatchKey(entries.slice(i, i + 4).map((x) => x.english).join(""));
      for (const pr of allRowProbes) {
        if (pr.zh.length >= 4 && windowZh.includes(pr.zh)) score += 3;
        if (pr.en.length >= 8 && windowEn.includes(pr.en)) score += 3;
      }
      if (lastZh.length >= 5 && windowZh.includes(lastZh)) score += 5;
      if (lastEn.length >= 8 && windowEn.includes(lastEn)) score += 5;

      if (score > bestScore) {
        bestScore = score;
        startIdx = i;
      }
    }
  }
  if (startIdx < 0) return null;

  // If the script spans multiple consecutive verses stored as separate rows in the library, auto-extend
  let endIdx = startIdx;
  const startEntry = entries[startIdx];
  const hasLastInStart =
    (lastEn.length >= 8 && normMatchKey(startEntry.english).includes(lastEn)) ||
    (lastZh.length >= 5 && normMatchKey(startEntry.chinese).includes(lastZh));
  if (!hasLastInStart && verseRows.length > 1) {
    for (let j = startIdx + 1; j < Math.min(entries.length, startIdx + 5); j += 1) {
      const e = entries[j];
      if (
        (lastEn.length >= 8 && normMatchKey(e.english).includes(lastEn)) ||
        (lastZh.length >= 5 && normMatchKey(e.chinese).includes(lastZh))
      ) {
        endIdx = j;
        break;
      }
    }
  }

  const slice = entries.slice(startIdx, endIdx + 1);
  const parts = slice.map((c) => splitBibleTargetAndRef(c.targetText));
  const bodyOnly = slice.length > 1 ? parts.map((p) => stripOuterDoubleQuotes(p.body)).join(" ") : parts[0].body;
  const mergedRef =
    slice.length > 1
      ? mergeBibleRangeRef(parts[0].ref, parts[parts.length - 1].ref, cv?.startV, cv?.endV)
      : mergeBibleRangeRef(parts[0].ref, parts[0].ref, cv?.startV, cv?.endV);
  const targetCitationRef = mergedRef
    ? `(${mergedRef})`
    : `(${startEntry.chapterRef || refHint.replace(/^[（(]|[)）.,，。]+$/g, "")})`;
  const trunc =
    truncSpec0.hasTruncation ||
    verseRows[0]?.english.trim().startsWith("…") ||
    verseRows[0]?.english.trim().startsWith('"...') ||
    verseRows[0]?.english.trim().startsWith('"…');
  const mergedSource = [...new Set(slice.map((c) => (c.source || "").trim()).filter(Boolean))].join(" / ");
  return {
    text: bodyOnly,
    targetCitationRef,
    truncatedStart: Boolean(trunc),
    ...(mergedSource ? { source: mergedSource } : {}),
  };
}

export function findIdiomMatch(idioms: IdiomEntry[], chinese: string, english: string): string | null {
  const zhKey = normMatchKey(chinese);
  const enKey = normMatchKey(english);
  for (const item of idioms) {
    if (zhKey && item.zhVariants.some((v) => normMatchKey(v) === zhKey)) return item.targetText;
    if (enKey && item.enVariants.some((v) => normMatchKey(v) === enKey)) return item.targetText;
  }
  return null;
}

export function findHymnMatch(hymns: HymnEntry[], hint: string): HymnEntry | null {
  const titleMatch = /《([^》]+)》/.exec(hint);
  const targetKey = normMatchKey(titleMatch ? titleMatch[1] : hint);
  return hymns.find((h) => normMatchKey(h.zhTitle) === targetKey || normMatchKey(h.enTitle) === targetKey) ?? null;
}

function subseqCoverage(shorter: string, longer: string): number {
  if (!shorter || !longer) return 0;
  let i = 0;
  for (let j = 0; j < longer.length && i < shorter.length; j += 1) {
    if (shorter[i] === longer[j]) i += 1;
  }
  return i / longer.length;
}

function lyricKeyScore(a: string, b: string, allowDouble = true): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (allowDouble && (a === b + b || b === a + a)) return 0.96;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return 0;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  return subseqCoverage(shorter, longer);
}

export function aggregateHymnSublinesForBlock(
  hymnLines: ArticleParagraph[],
  blockRows: ScriptRow[],
): string[] | null {
  if (hymnLines.length === 0 || blockRows.length === 0) return null;
  let cursor = 0;
  const out: string[] = [];

  for (const br of blockRows) {
    const kZh = normMatchKey(br.chinese);
    const kEn = normMatchKey(br.english);

    const findBestFrom = (fromIdx: number, toIdx: number): { text: string; nextIdx: number; score: number } | null => {
      let best: { text: string; nextIdx: number; score: number } | null = null;
      for (let startIdx = fromIdx; startIdx < toIdx; startIdx += 1) {
        let accZh = "";
        let accEn = "";
        const targets: string[] = [];
        for (let span = 1; span <= 5 && startIdx + span - 1 < hymnLines.length; span += 1) {
          const hl = hymnLines[startIdx + span - 1];
          accZh += normMatchKey(hl.chinese);
          accEn += normMatchKey(hl.english);
          targets.push(stripOuterDoubleQuotes(hl.target).trim());
          // Only allow single-line sung-twice shortcut when span === 1; never merge 2 separate repeated LRC rows into 1 non-repeated script row!
          const score = Math.max(
            lyricKeyScore(accZh, kZh, span === 1),
            lyricKeyScore(accEn, kEn, span === 1),
          );
          if (score >= 0.78 && (!best || score > best.score + 0.02)) {
            best = { text: targets.filter(Boolean).join(" "), nextIdx: startIdx + span, score };
            if (score >= 0.99) return best;
          }
          if (kZh && accZh.length > kZh.length * 1.45 && kEn && accEn.length > kEn.length * 1.45) break;
        }
        if (best && best.score >= 0.85) return best;
      }
      return best;
    };

    const forwardHit = findBestFrom(cursor, hymnLines.length);
    if (forwardHit) {
      out.push(forwardHit.text);
      cursor = forwardHit.nextIdx;
      continue;
    }

    const fallbackHit = findBestFrom(0, cursor);
    if (fallbackHit) {
      out.push(fallbackHit.text);
      continue;
    }

    return null;
  }
  return out;
}

/**
 * If the English draft line does NOT repeat its clause twice, collapse an exact doubled
 * target LRC clause (e.g. "Firman Tuhan adalah kebenaran. Firman Tuhan adalah kebenaran."
 * or "watak rusakku ditahirkan, watak rusakku ditahirkan.") down to a single clause.
 */
export function dedupeRepeatedLyricClause(targetLine: string, sourceEnglish: string): string {
  const t = targetLine.trim();
  const enClean = stripOuterDoubleQuotes(sourceEnglish || "").trim();
  if (!t || !enClean) return t;
  // Check if English itself is repeated
  const enHalf = /^(.{6,}?)[,.;!?\s]+\1[.!?"”']*$/i.test(enClean);
  if (enHalf) return t;

  const m = /^(.{6,}?)([,.!?;]+\s+)\1([.!?"”»]*)$/iu.exec(t);
  if (m) {
    const endPunct = m[3] || (m[2].trim().startsWith(".") ? "." : ".");
    return `${m[1].trim()}${endPunct}`;
  }
  return t;
}

export function resolveComboHymnTitle(
  catalog: LanguageCatalog,
  row: ScriptRow,
  rawTargetTitle: string,
): { text: string; fullyComposed: boolean } {
  const cleanTitle = stripOuterDoubleQuotes(rawTargetTitle).trim();
  // Look up prefix phrase dynamically from cloud commonFixedTerms (by English prefix before ':' or Chinese prefix before '《')
  const enPrefix = row.english.includes(":") ? row.english.split(":")[0].trim().toLowerCase() : "";
  const zhPrefix = row.chinese.includes("《") ? row.chinese.split("《")[0].trim().toLowerCase() : "";
  const prefixTarget =
    (enPrefix && (catalog.commonFixedTerms.get(enPrefix) || catalog.commonFixedTerms.get(`${enPrefix}:`))) ||
    (zhPrefix && catalog.commonFixedTerms.get(zhPrefix)) ||
    "";
  if (prefixTarget && cleanTitle) {
    const cleanPrefix = prefixTarget.replace(/[:：]\s*$/u, "").trim();
    const quotedTitle = `${catalog.rule.doubleOpen}${cleanTitle}${catalog.rule.doubleClose}`;
    return { text: `${cleanPrefix}: ${quotedTitle}`, fullyComposed: true };
  }
  return { text: cleanTitle, fullyComposed: false };
}

export function resolveCitationText(
  catalog: LanguageCatalog,
  row: ScriptRow,
  variant: CitationVariant,
): string | null {
  const zhKey = normMatchKey(row.chinese);
  const enKey = normMatchKey(row.english);

  const pickFromPair = (pair: CitationPair): string => {
    if (catalog.rule.singleCitationRowOnly) return pair.subtitleBand || pair.videoEffect;
    return variant === "video_effect"
      ? pair.videoEffect || pair.subtitleBand
      : pair.subtitleBand || pair.videoEffect;
  };

  for (const pair of catalog.citations) {
    if ((zhKey && normMatchKey(pair.keyZh) === zhKey) || (enKey && normMatchKey(pair.keyEn) === enKey)) {
      const picked = pickFromPair(pair);
      if (picked) return picked;
    }
  }

  const hymn = findHymnMatch(catalog.hymns, row.chinese || row.filterCategory);
  if (hymn?.targetCitation) return hymn.targetCitation;
  if (hymn?.targetTitle && (row.chinese.includes("・") || row.chinese.includes("·"))) {
    const cleanTitle = stripOuterDoubleQuotes(hymn.targetTitle).trim();
    const zhCollectionStem = row.chinese.replace(/^[《（(\s]+/, "").split(/[・·]/)[0].trim();
    if (zhCollectionStem) {
      // 1. Exact collection stem entry in citations or commonFixedTerms
      const bookPair = catalog.citations.find(
        (p) => p.keyZh.includes(zhCollectionStem) && !p.keyZh.includes("・") && !p.keyZh.includes("·"),
      );
      const bookStem =
        (bookPair ? pickFromPair(bookPair) : "") ||
        catalog.commonFixedTerms.get(zhCollectionStem.toLowerCase()) ||
        "";
      if (bookStem) {
        if (bookStem.endsWith(catalog.rule.doubleClose)) {
          return `${bookStem.slice(0, -catalog.rule.doubleClose.length)}, ${cleanTitle}${catalog.rule.doubleClose}`;
        }
        return `${bookStem}, ${cleanTitle}`;
      }
      // 2. Derive collection template dynamically from any sibling song citation in the same collection!
      const siblingPair = catalog.citations.find(
        (p) => p.keyZh.includes(zhCollectionStem) && (p.keyZh.includes("・") || p.keyZh.includes("·")),
      );
      if (siblingPair) {
        const sibTarget = pickFromPair(siblingPair);
        // Replace the trailing song title after the last comma / middle-dot while preserving quotes/brackets
        const commaMatch = /^(.+?[,，ㆍ·]\s*)(["“«„'‘<＜]?)([^"”»“'’>＞)）]+)(["”»“'’>＞)）]*.*)$/u.exec(sibTarget);
        if (commaMatch) {
          return `${commaMatch[1]}${commaMatch[2]}${cleanTitle}${commaMatch[4]}`;
        }
      }
    }
  }

  const article = findArticleInCatalog(catalog.articles, row.filterCategory || row.chinese, row.chinese, row.english);
  if (article) {
    const picked =
      variant === "video_effect"
        ? article.targetBracketCite || article.targetCite || article.targetSubtitleBandCite
        : article.targetSubtitleBandCite || article.targetCite || article.targetBracketCite;
    if (picked) return picked;
  }

  const volMatch = /卷([一二三四五六七1-7])/u.exec(row.chinese);
  if (volMatch && article?.targetTitle) {
    for (const pair of catalog.citations) {
      if (pair.keyZh.includes(`卷${volMatch[1]}`)) {
        const stem = pickFromPair(pair);
        if (stem) {
          if (variant === "video_effect" && stem.endsWith(").")) return `${stem.slice(0, -2)}. ${article.targetTitle}).`;
          if (stem.endsWith(catalog.rule.doubleClose)) {
            return `${stem.slice(0, -catalog.rule.doubleClose.length)}. ${article.targetTitle}${catalog.rule.doubleClose}`;
          }
          return `${stem}. ${article.targetTitle}`;
        }
      }
    }
  }
  return null;
}

export function findRosterMatch(
  entries: RosterEntry[],
  chinese: string,
  english: string,
  firstLineOnly = false,
): RosterEntry | null {
  const zhKey = normMatchKey(chinese);
  const enKey = normMatchKey(english);

  for (const e of entries) {
    const eZhFull = normMatchKey(e.chinese);
    const eEnFull = normMatchKey(e.english);
    if ((zhKey && eZhFull === zhKey) || (enKey && eEnFull === enKey)) {
      return firstLineOnly ? { ...e, targetText: e.targetText.split(/\r?\n/)[0].trim() } : e;
    }
    if (firstLineOnly) {
      const eZhLine1 = normMatchKey(e.chinese.split(/\r?\n/)[0]);
      const eEnLine1 = normMatchKey(e.english.split(/\r?\n/)[0]);
      if ((zhKey && eZhLine1 === zhKey) || (enKey && eEnLine1 === enKey)) {
        return { ...e, targetText: e.targetText.split(/\r?\n/)[0].trim() };
      }
    }
  }
  return null;
}

export function lookupPhraseForNoteXx(
  catalog: LanguageCatalog,
  englishPhrase: string,
  enableRoster: boolean,
): { value: string; fromRoster: boolean } | null {
  const key = normMatchKey(englishPhrase);
  if (!key) return null;

  const fixed = catalog.commonFixedTerms.get(englishPhrase.trim().toLowerCase());
  if (fixed) return { value: fixed, fromRoster: false };

  for (const h of catalog.hymns) {
    if (normMatchKey(h.enTitle) === key && h.targetTitle) return { value: h.targetTitle, fromRoster: false };
  }

  for (const a of catalog.articles) {
    const aEnClean = normMatchKey(a.enTitle.replace(/(?:volume|vol\.?|jilid|том|tom)\s*\d+/gi, ""));
    if ((normMatchKey(a.enTitle) === key || aEnClean === key) && a.targetTitle) {
      return {
        value: a.targetTitle.replace(/[,\s]*(?:ТОМ|TOM|VOL\.?|VOLUME|Jilid)\s*\d+$/i, "").trim(),
        fromRoster: false,
      };
    }
  }
  // Fallback: extract book stem "The Word Appears in the Flesh" from catalog citations if present
  if (key === normMatchKey("The Word Appears in the Flesh")) {
    for (const c of catalog.citations) {
      if (c.keyZh.includes("话在肉身显现") || /word appears in the flesh/i.test(c.keyEn)) {
        const val = (c.subtitleBand || c.videoEffect || "").trim();
        if (val) return { value: stripOuterDoubleQuotes(val), fromRoster: false };
      }
    }
  }

  if (enableRoster) {
    const r = findRosterMatch(catalog.rosterEntries, "", englishPhrase, true);
    if (r) return { value: r.targetText, fromRoster: true };
  }
  return null;
}

export function replaceNoteXxPlaceholders(
  noteText: string,
  catalog: LanguageCatalog,
  enableRoster: boolean,
): { updatedNote: string; replacedCount: number; missingCount: number; usedRoster: boolean } {
  const lines = noteText.split(/\r?\n/);
  let replacedCount = 0;
  let missingCount = 0;
  let usedRoster = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "XX" && i > 0) {
      const found = lookupPhraseForNoteXx(catalog, lines[i - 1].trim(), enableRoster);
      if (found) {
        lines[i] = found.value;
        replacedCount += 1;
        if (found.fromRoster) usedRoster = true;
      } else {
        missingCount += 1;
      }
    }
  }
  return { updatedNote: lines.join("\n"), replacedCount, missingCount, usedRoster };
}

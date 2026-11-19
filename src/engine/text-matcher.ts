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

  let startIdx = -1;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const pZh = normMatchKey(paragraphs[i].chinese);
    const pEn = normMatchKey(paragraphs[i].english);
    if ((firstZhProbe.length >= 4 && pZh.includes(firstZhProbe)) || (firstEnProbe.length >= 8 && pEn.includes(firstEnProbe))) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;

  let endIdx = startIdx;
  for (let j = startIdx; j < Math.min(paragraphs.length, startIdx + 5); j += 1) {
    const pZh = normMatchKey(paragraphs[j].chinese);
    const pEn = normMatchKey(paragraphs[j].english);
    if ((lastZhProbe.length >= 4 && pZh.includes(lastZhProbe)) || (lastEnProbe.length >= 8 && pEn.includes(lastEnProbe))) {
      endIdx = j;
      break;
    }
  }

  const combinedTarget = paragraphs.slice(startIdx, endIdx + 1).map((p) => p.target.trim()).filter(Boolean).join(" ");
  const combinedEn = paragraphs.slice(startIdx, endIdx + 1).map((p) => p.english.trim()).filter(Boolean).join(" ");
  const fullParaZh = normMatchKey(paragraphs[startIdx].chinese);
  const allRowsZh = normMatchKey(sourceRows.map((r) => r.chinese).join(""));

  if (endIdx === startIdx && fullParaZh.length > allRowsZh.length + 10) {
    const startPos = firstZhProbe ? fullParaZh.indexOf(firstZhProbe) : 0;
    const startRatio = Math.max(0, (startPos >= 0 ? startPos : 0) / Math.max(1, fullParaZh.length));
    const endPos = lastZhProbe ? fullParaZh.lastIndexOf(lastZhProbe) : -1;
    const endRatio = endPos >= 0 ? Math.min(1, (endPos + lastZhProbe.length) / Math.max(1, fullParaZh.length)) : Math.min(1, startRatio + allRowsZh.length / Math.max(1, fullParaZh.length));
    if (startRatio > 0.04 || endRatio < 0.94) {
      const contextWindowTarget =
        combinedTarget.length > 900
          ? sliceByClauseRatio(combinedTarget, Math.max(0, startRatio - 0.18), Math.min(1, endRatio + 0.18))
          : combinedTarget;
      return {
        matchedText: sliceByClauseRatio(combinedTarget, startRatio, endRatio),
        fullParagraphTarget: combinedTarget,
        contextWindowTarget,
        fullParagraphEn: combinedEn.length > 900 ? sliceByClauseRatio(combinedEn, Math.max(0, startRatio - 0.18), Math.min(1, endRatio + 0.18)) : combinedEn,
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

function mergeBibleRangeRef(firstRef: string, lastRef: string): string {
  if (!firstRef || !lastRef || firstRef === lastRef) return firstRef || lastRef;
  const endVerse = /(\d+)\s*$/.exec(lastRef)?.[1];
  if (endVerse && !firstRef.endsWith(`–${endVerse}`) && !firstRef.endsWith(`-${endVerse}`)) {
    return `${firstRef}–${endVerse}`;
  }
  return firstRef;
}

export function findBibleVerse(
  entries: BibleEntry[],
  refHint: string,
  verseRows: ScriptRow[],
): { text: string; targetCitationRef: string; truncatedStart: boolean } | null {
  if (entries.length === 0 || verseRows.length === 0) return null;

  const keyRef = normBibleRef(refHint);
  const firstEn = normMatchKey(verseRows[0]?.english ?? "").slice(0, 24);
  const firstZh = normMatchKey(verseRows[0]?.chinese ?? "").slice(0, 14);
  const lastEn = normMatchKey(verseRows[verseRows.length - 1]?.english ?? "").slice(-24);
  const lastZh = normMatchKey(verseRows[verseRows.length - 1]?.chinese ?? "").slice(-14);

  let startIdx = -1;
  if (keyRef) startIdx = entries.findIndex((e) => normBibleRef(e.chapterRef) === keyRef);

  // Range lookup (e.g. "romans 7:15-16" -> match consecutive "romans 7:15" + "romans 7:16")
  if (startIdx < 0 && keyRef) {
    const rangeMatch = /^(.+?\d+):(\d+)-(\d+)$/.exec(keyRef);
    if (rangeMatch) {
      const [, bookChap, startV, endV] = rangeMatch;
      const sV = Number.parseInt(startV, 10);
      const eV = Number.parseInt(endV, 10);
      const idx = entries.findIndex((e) => normBibleRef(e.chapterRef) === `${bookChap}:${sV}`);
      if (idx >= 0 && eV > sV && eV - sV <= 6) {
        const collected: BibleEntry[] = [];
        for (let v = sV; v <= eV; v += 1) {
          const hit = entries.find((e) => normBibleRef(e.chapterRef) === `${bookChap}:${v}`);
          if (hit) collected.push(hit);
        }
        if (collected.length >= 2) {
          const parts = collected.map((c) => splitBibleTargetAndRef(c.targetText));
          const mergedBody = parts.map((p) => stripOuterDoubleQuotes(p.body)).join(" ");
          const mergedRef = mergeBibleRangeRef(parts[0].ref, parts[parts.length - 1].ref) || refHint.replace(/^[（(]|[)）.]$/g, "");
          const trunc = verseRows[0]?.remark.includes("涉及截取") || verseRows[0]?.english.includes("…") || verseRows[0]?.english.includes("...");
          return { text: mergedBody, targetCitationRef: `(${mergedRef})`, truncatedStart: Boolean(trunc) };
        }
      }
    }
  }

  // Fallback: match by English or Chinese text of first verse row
  if (startIdx < 0) {
    startIdx = entries.findIndex(
      (e) =>
        (firstEn.length >= 8 && normMatchKey(e.english).includes(firstEn)) ||
        (firstZh.length >= 5 && normMatchKey(e.chinese).includes(firstZh)),
    );
  }
  if (startIdx < 0) return null;

  // If the script spans multiple consecutive verses stored as separate rows in the library (e.g. Rom 7:15 + 7:16), auto-extend
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
      ? mergeBibleRangeRef(parts[0].ref, parts[parts.length - 1].ref)
      : parts[0].ref;
  const targetCitationRef = mergedRef
    ? `(${mergedRef})`
    : `(${startEntry.chapterRef || refHint.replace(/^[（(]|[)）.]$/g, "")})`;
  const trunc =
    verseRows[0]?.remark.includes("涉及截取") ||
    verseRows[0]?.english.includes("…") ||
    verseRows[0]?.english.includes("...");
  return { text: bodyOnly, targetCitationRef, truncatedStart: Boolean(trunc) };
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

function lyricKeyScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a === b + b || b === a + a) return 0.96;
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
          const score = Math.max(lyricKeyScore(accZh, kZh), lyricKeyScore(accEn, kEn));
          if (score >= 0.78 && (!best || score > best.score)) {
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
  if (hymn?.targetTitle && row.chinese.includes("跟随羔羊唱新歌")) {
    const bookPair = catalog.citations.find(
      (p) => p.keyZh.includes("跟随羔羊唱新歌") && !p.keyZh.includes("・") && !p.keyZh.includes("·"),
    );
    const bookStem = bookPair ? pickFromPair(bookPair) : "";
    if (bookStem) {
      if (bookStem.endsWith(catalog.rule.doubleClose)) {
        return `${bookStem.slice(0, -catalog.rule.doubleClose.length)}. ${hymn.targetTitle}${catalog.rule.doubleClose}`;
      }
      return `${bookStem}, ${hymn.targetTitle}`;
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
    const aEnClean = normMatchKey(a.enTitle.replace(/volume\s*\d+/i, ""));
    if ((normMatchKey(a.enTitle) === key || aEnClean === key) && a.targetTitle) {
      return { value: a.targetTitle.replace(/\s*(ТОМ|TOM|VOL\.?)\s*\d+$/i, "").trim(), fromRoster: false };
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

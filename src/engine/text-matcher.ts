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
): { matchedText: string; truncatedStart: boolean } | null {
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
  const fullParaZh = normMatchKey(paragraphs[startIdx].chinese);
  const allRowsZh = normMatchKey(sourceRows.map((r) => r.chinese).join(""));

  if (endIdx === startIdx && fullParaZh.length > allRowsZh.length + 12) {
    const startRatio = Math.max(0, fullParaZh.indexOf(firstZhProbe) / Math.max(1, fullParaZh.length));
    const endPos = fullParaZh.lastIndexOf(lastZhProbe);
    const endRatio = endPos >= 0 ? Math.min(1, (endPos + lastZhProbe.length) / Math.max(1, fullParaZh.length)) : 1;
    if (startRatio > 0.06 || endRatio < 0.92) {
      return { matchedText: sliceBySentenceRatio(combinedTarget, startRatio, endRatio), truncatedStart: Boolean(truncMatch) };
    }
  }
  return { matchedText: combinedTarget, truncatedStart: Boolean(truncMatch) };
}

function sliceBySentenceRatio(text: string, startRatio: number, endRatio: number): string {
  const sentences = text.split(/(?<=[.!?。！？;；])\s+/u).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 1) return text;
  const totalLen = text.length;
  let acc = 0;
  const picked: string[] = [];
  for (const s of sentences) {
    if ((acc + s.length) / totalLen > startRatio - 0.04 && acc / totalLen < endRatio + 0.04) picked.push(s);
    acc += s.length + 1;
  }
  return picked.length > 0 ? picked.join(" ") : text;
}

export function findBibleVerse(
  entries: BibleEntry[],
  refHint: string,
  verseRows: ScriptRow[],
): { text: string; targetCitationRef: string; truncatedStart: boolean } | null {
  const keyRef = normBibleRef(refHint);
  const firstEn = normMatchKey(verseRows[0]?.english ?? "").slice(0, 24);
  let found = keyRef ? entries.find((e) => normBibleRef(e.chapterRef) === keyRef) : undefined;
  if (!found && firstEn.length >= 8) found = entries.find((e) => normMatchKey(e.english).includes(firstEn));
  if (!found) return null;

  const raw = found.targetText.trim();
  const trailingRefMatch = /\(([^()]+?\d+[:.,–\-]\d+[^()]*)\)[.,。]?$/u.exec(raw);
  const targetCitationRef = trailingRefMatch
    ? `(${trailingRefMatch[1].trim()})`
    : `(${found.chapterRef || refHint.replace(/^[（(]|[)）.]$/g, "")})`;
  const bodyOnly = trailingRefMatch ? raw.slice(0, trailingRefMatch.index).trim() : raw;
  const trunc = verseRows[0]?.remark.includes("涉及截取") || verseRows[0]?.english.includes("…");
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
    let matchedTarget: string | null = null;

    const tryMatchAt = (startIdx: number): { text: string; nextIdx: number } | null => {
      let accZh = "";
      let accEn = "";
      const targets: string[] = [];
      for (let span = 1; span <= 5 && startIdx + span - 1 < hymnLines.length; span += 1) {
        const hl = hymnLines[startIdx + span - 1];
        accZh += normMatchKey(hl.chinese);
        accEn += normMatchKey(hl.english);
        targets.push(stripOuterDoubleQuotes(hl.target).trim());
        const zhHit = Boolean(kZh && accZh && (accZh === kZh || (span === 1 && kZh === accZh + accZh)));
        const enHit = Boolean(kEn && accEn && (accEn === kEn || (span === 1 && kEn === accEn + accEn)));
        if (zhHit || enHit) return { text: targets.filter(Boolean).join(" "), nextIdx: startIdx + span };
      }
      return null;
    };

    for (let s = cursor; s < hymnLines.length; s += 1) {
      const m = tryMatchAt(s);
      if (m) {
        matchedTarget = m.text;
        cursor = m.nextIdx;
        break;
      }
    }
    if (matchedTarget === null) {
      for (let s = 0; s < cursor; s += 1) {
        const m = tryMatchAt(s);
        if (m) {
          matchedTarget = m.text;
          break;
        }
      }
    }
    if (matchedTarget === null) return null;
    out.push(matchedTarget);
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

  const article = findArticleInCatalog(catalog.articles, row.filterCategory || row.chinese, row.chinese, row.english);
  if (article) {
    const picked = variant === "video_effect"
      ? article.targetBracketCite || article.targetCite
      : article.targetCite || article.targetBracketCite;
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

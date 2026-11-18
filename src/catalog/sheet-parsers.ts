import type {
  ArticleCatalogEntry,
  BibleEntry,
  CitationPair,
  IdiomEntry,
  RichSheetGrid,
} from "./catalog-types";
import {
  findLangColumn,
  parseHymnCitationsSheet,
  parseHymnSheet,
  parseLordsPrayerSheet,
  parseRosterSheet,
  parseWordCitationsSheet,
  type ParsedLordsPrayerResult,
} from "./citation-parsers";
import {
  colLetterToIndex,
  DEFAULT_LANG_SHEET_COLS,
  DEFAULT_SHARED_SHEETS_CONFIG,
  type PerLanguageSheetColumnConfig,
  type SharedSheetsConfig,
} from "../types/schema-config";

export {
  parseHymnCitationsSheet,
  parseHymnSheet,
  parseLordsPrayerSheet,
  parseRosterSheet,
  parseWordCitationsSheet,
  type ParsedLordsPrayerResult,
};

const txt = (grid: RichSheetGrid, r: number, c: number) =>
  grid[r]?.[c]?.text?.trim() ?? "";

const urlOf = (grid: RichSheetGrid, r: number, c: number) => {
  const cell = grid[r]?.[c];
  if (!cell) return "";
  if (cell.url?.startsWith("http")) return cell.url.trim();
  return cell.text?.trim().startsWith("http") ? cell.text.trim() : "";
};

export function parseArticleCatalogSheet(
  grid: RichSheetGrid,
  cfg?: Partial<PerLanguageSheetColumnConfig>,
): ArticleCatalogEntry[] {
  const entries: ArticleCatalogEntry[] = [];
  if (grid.length < 2) return entries;

  const m = { ...DEFAULT_LANG_SHEET_COLS, ...cfg };
  const colBracket = colLetterToIndex(m.catalogZhBracketCol, 1);
  const colLine = colLetterToIndex(m.catalogZhLineCol, 2);
  const colZh = colLetterToIndex(m.catalogZhTitleCol, 3);
  const colEn = colLetterToIndex(m.catalogEnTitleCol, 4);
  const colTarget = colLetterToIndex(m.catalogTargetTitleCol, 5);
  let colLink = colLetterToIndex(m.catalogDocLinkCol, 6);
  let colTargetCite = colLetterToIndex(m.catalogTargetCiteCol, 7);
  let colTargetBracketCite = colLetterToIndex(m.catalogTargetBracketCiteCol || "I", 8);

  const headerIdx = Math.max(0, (m.catalogHeaderRow || 1) - 1);
  if (!cfg) {
    const hdr = grid[headerIdx] || [];
    const foundLink = hdr.findIndex((c) => /链接|link/i.test(c.text));
    if (foundLink >= 0) {
      colLink = foundLink;
      colTargetCite = foundLink + 1;
      colTargetBracketCite = foundLink + 2;
    }
  }

  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const zhTitle = txt(grid, r, colZh);
    const enTitle = txt(grid, r, colEn);
    const targetTitle = txt(grid, r, colTarget);
    const docUrl = urlOf(grid, r, colLink);
    const zhBracketCite = txt(grid, r, colBracket);
    const zhSubtitleCite = txt(grid, r, colLine);
    const targetCite = txt(grid, r, colTargetCite);
    const targetBracketCite = txt(grid, r, colTargetBracketCite);
    if (!zhTitle && !enTitle && !targetTitle) continue;
    entries.push({
      zhTitle,
      enTitle,
      targetTitle,
      docUrl,
      zhSubtitleCite,
      zhBracketCite,
      targetCite,
      ...(targetBracketCite ? { targetBracketCite } : {}),
    });
  }
  return entries;
}

export function parseBibleLibrarySheet(
  grid: RichSheetGrid,
  cfg?: Partial<PerLanguageSheetColumnConfig>,
): BibleEntry[] {
  const entries: BibleEntry[] = [];
  if (grid.length === 0) return entries;

  const m = { ...DEFAULT_LANG_SHEET_COLS, ...cfg };
  let startRow = Math.max(1, m.bibleHeaderRow || 2);
  let colRef = colLetterToIndex(m.bibleChapterCol, 1);
  let colZh = colLetterToIndex(m.bibleZhCol, 2);
  let colEn = colLetterToIndex(m.bibleEnCol, 3);
  let colTarget = colLetterToIndex(m.bibleTargetCol, 4);

  if (!cfg) {
    startRow = 1;
    for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
      const rowStr = (grid[r] || []).map((c) => c.text.toLowerCase()).join("|");
      if (rowStr.includes("chinese") || rowStr.includes("english") || rowStr.includes("章节")) {
        startRow = r + 1;
        const row = grid[r];
        const fRef = row.findIndex((c) => /章节|chapter|verse/i.test(c.text));
        const fZh = row.findIndex((c) => /chinese|中文/i.test(c.text));
        const fEn = row.findIndex((c) => /english|英文/i.test(c.text));
        if (fRef >= 0) colRef = fRef;
        if (fZh >= 0) colZh = fZh;
        if (fEn >= 0) {
          colEn = fEn;
          colTarget = fEn + 1;
        }
        break;
      }
    }
  } else {
    const hdrStr = (grid[startRow - 1] || []).map((c) => c.text.toLowerCase()).join("|");
    if (!hdrStr.includes("chinese") && !hdrStr.includes("章节") && grid.length > 1) {
      for (let r = 0; r < Math.min(grid.length, 4); r += 1) {
        const s = (grid[r] || []).map((c) => c.text.toLowerCase()).join("|");
        if (s.includes("chinese") || s.includes("english") || s.includes("章节")) {
          startRow = r + 1;
          break;
        }
      }
    }
  }

  for (let r = startRow; r < grid.length; r += 1) {
    const chapterRef = txt(grid, r, colRef);
    const chinese = txt(grid, r, colZh);
    const english = txt(grid, r, colEn);
    const targetText = txt(grid, r, colTarget);
    if (!targetText || (!chapterRef && !english && !chinese)) continue;
    entries.push({ chapterRef, chinese, english, targetText });
  }
  return entries;
}

export function parseIdiomGlossarySheet(
  grid: RichSheetGrid,
  cfg?: Partial<PerLanguageSheetColumnConfig>,
): IdiomEntry[] {
  const entries: IdiomEntry[] = [];
  if (grid.length < 2) return entries;

  const m = { ...DEFAULT_LANG_SHEET_COLS, ...cfg };
  let startRow = Math.max(1, m.idiomHeaderRow || 1);
  let colZh = colLetterToIndex(m.idiomZhCol, 5);
  let colEnA = colLetterToIndex(m.idiomEn1Col, 6);
  let colEnB = colLetterToIndex(m.idiomEn2Col, 8);
  let colTarget = colLetterToIndex(m.idiomTargetCol, 9);

  if (!cfg) {
    for (let r = 0; r < Math.min(grid.length, 4); r += 1) {
      const row = grid[r] || [];
      const fZh = row.findIndex((c) => c.text.includes("中文"));
      if (fZh >= 0) {
        startRow = r + 1;
        colZh = fZh;
        colEnA = fZh + 1;
        const fTarget = row.findIndex(
          (c, idx) =>
            idx > fZh + 1 && !/英文|一致|来源|日期|状态/.test(c.text) && c.text.trim().length > 0,
        );
        if (fTarget >= 0) {
          colTarget = fTarget;
          colEnB = fTarget - 1;
        }
        break;
      }
    }
  }

  const splitVariants = (s: string) =>
    s
      .split(/[\/／\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  for (let r = startRow; r < grid.length; r += 1) {
    const zh = txt(grid, r, colZh);
    const en1 = txt(grid, r, colEnA);
    const en2 = txt(grid, r, colEnB);
    const targetText = txt(grid, r, colTarget);
    if (!targetText || (!zh && !en1 && !en2)) continue;
    entries.push({
      zhVariants: splitVariants(zh),
      enVariants: [...new Set([...splitVariants(en1), ...splitVariants(en2)])],
      targetText,
    });
  }
  return entries;
}

export function parseCommonTermsSheet(
  grid: RichSheetGrid,
  langName: string,
  cfg?: Partial<SharedSheetsConfig>,
): {
  godSaysText: string;
  citations: CitationPair[];
  fixedTerms: Map<string, string>;
} {
  let godSaysText = "";
  const citations: CitationPair[] = [];
  const fixedTerms = new Map<string, string>();
  if (grid.length === 0) return { godSaysText, citations, fixedTerms };

  const m = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...cfg };
  let headerIdx = Math.max(0, (m.commonTermsHeaderRow || 1) - 1);
  let langCol = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const c = findLangColumn(grid[r] || [], langName);
    if (c >= 0) {
      headerIdx = r;
      langCol = c;
      break;
    }
  }
  if (langCol < 0) langCol = 3;

  let colZh = colLetterToIndex(m.commonTermsZhCol, 0);
  let colEn = colLetterToIndex(m.commonTermsEnCol, 1);
  if (!cfg) {
    const hdr = grid[headerIdx] || [];
    const fZh = hdr.findIndex((c) => /中文|chinese/i.test(c.text));
    const fEn = hdr.findIndex((c) => /英文|english/i.test(c.text));
    if (fZh >= 0) colZh = fZh;
    if (fEn >= 0) colEn = fEn;
  }

  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const zh = txt(grid, r, colZh);
    const en = txt(grid, r, colEn);
    const target = txt(grid, r, langCol);
    if (!target) continue;

    const cleanZh = zh.replace(/[：:]$/u, "");
    if (cleanZh === "全能神说" || /^almighty god says:?$/i.test(en)) {
      godSaysText = target;
      continue;
    }

    const isVideoBracket = en.startsWith("(") || zh.startsWith("（") || zh.startsWith("(");
    const isSubtitleFrom =
      en.toLowerCase().startsWith("from ") || zh.startsWith("《") || zh.startsWith("——");

    if (isVideoBracket || isSubtitleFrom) {
      const prev = citations[citations.length - 1];
      if (isVideoBracket && prev && !prev.videoEffect) {
        prev.videoEffect = target;
      } else {
        citations.push({
          keyZh: zh,
          keyEn: en,
          subtitleBand: isSubtitleFrom ? target : "",
          videoEffect: isVideoBracket ? target : "",
        });
      }
    } else {
      if (zh) fixedTerms.set(zh, target);
      if (en) fixedTerms.set(en.toLowerCase(), target);
    }
  }

  return { godSaysText, citations, fixedTerms };
}

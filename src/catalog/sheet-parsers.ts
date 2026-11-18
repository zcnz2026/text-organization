import type {
  ArticleCatalogEntry,
  ArticleParagraph,
  BibleEntry,
  CitationPair,
  HymnEntry,
  IdiomEntry,
  RichSheetGrid,
  RosterEntry,
} from "./catalog-types";
import { normalizeLangKey, resolvePunctuationRule } from "./lang-presets";

const txt = (grid: RichSheetGrid, r: number, c: number) =>
  grid[r]?.[c]?.text?.trim() ?? "";

const urlOf = (grid: RichSheetGrid, r: number, c: number) => {
  const cell = grid[r]?.[c];
  if (!cell) return "";
  if (cell.url?.startsWith("http")) return cell.url.trim();
  return cell.text?.trim().startsWith("http") ? cell.text.trim() : "";
};

function findLangColumn(row: { text: string }[], langName: string): number {
  const rule = resolvePunctuationRule(langName);
  const candidates = new Set(
    [langName, rule.langName, ...rule.aliases].map(normalizeLangKey),
  );
  for (let c = 0; c < row.length; c += 1) {
    const cellKey = normalizeLangKey(row[c]?.text ?? "");
    if (!cellKey) continue;
    for (const cand of candidates) {
      if (cand && (cellKey === cand || cellKey.includes(cand))) return c;
    }
  }
  return -1;
}

export function parseArticleCatalogSheet(grid: RichSheetGrid): ArticleCatalogEntry[] {
  const entries: ArticleCatalogEntry[] = [];
  if (grid.length < 2) return entries;

  let colLink = 6;
  const hdr = grid[0] || [];
  const foundLink = hdr.findIndex((c) => /链接|link/i.test(c.text));
  if (foundLink >= 0) colLink = foundLink;

  for (let r = 1; r < grid.length; r += 1) {
    const zhTitle = txt(grid, r, 3);
    const enTitle = txt(grid, r, 4);
    const targetTitle = txt(grid, r, 5);
    const docUrl = urlOf(grid, r, colLink);
    const zhBracketCite = txt(grid, r, 1);
    const zhSubtitleCite = txt(grid, r, 2);
    const targetCite = txt(grid, r, colLink + 1);
    if (!zhTitle && !enTitle && !targetTitle) continue;
    entries.push({
      zhTitle,
      enTitle,
      targetTitle,
      docUrl,
      zhSubtitleCite,
      zhBracketCite,
      targetCite,
    });
  }
  return entries;
}

export function parseBibleLibrarySheet(grid: RichSheetGrid): BibleEntry[] {
  const entries: BibleEntry[] = [];
  let startRow = 1;
  let colRef = 1;
  let colZh = 2;
  let colEn = 3;
  let colTarget = 4;

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

export function parseIdiomGlossarySheet(grid: RichSheetGrid): IdiomEntry[] {
  const entries: IdiomEntry[] = [];
  if (grid.length < 2) return entries;

  let colZh = 5;
  let colEnA = 6;
  let colEnB = 8;
  let colTarget = 9;

  for (let r = 0; r < Math.min(grid.length, 4); r += 1) {
    const row = grid[r] || [];
    const fZh = row.findIndex((c) => c.text.includes("中文"));
    if (fZh >= 0) {
      colZh = fZh;
      colEnA = fZh + 1;
      const fTarget = row.findIndex(
        (c, idx) => idx > fZh + 1 && !/英文|一致|来源|日期|状态/.test(c.text) && c.text.trim().length > 0,
      );
      if (fTarget >= 0) {
        colTarget = fTarget;
        colEnB = fTarget - 1;
      }
      break;
    }
  }

  const splitVariants = (s: string) =>
    s
      .split(/[\/／\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  for (let r = 1; r < grid.length; r += 1) {
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
): {
  godSaysText: string;
  citations: CitationPair[];
  fixedTerms: Map<string, string>;
} {
  let godSaysText = "";
  const citations: CitationPair[] = [];
  const fixedTerms = new Map<string, string>();
  if (grid.length === 0) return { godSaysText, citations, fixedTerms };

  let headerIdx = 0;
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

  let colZh = 0;
  let colEn = 1;
  const hdr = grid[headerIdx] || [];
  const fZh = hdr.findIndex((c) => /中文|chinese/i.test(c.text));
  const fEn = hdr.findIndex((c) => /英文|english/i.test(c.text));
  if (fZh >= 0) colZh = fZh;
  if (fEn >= 0) colEn = fEn;

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

export function parseRosterSheet(
  grid: RichSheetGrid,
  langName: string,
): RosterEntry[] {
  const entries: RosterEntry[] = [];
  if (grid.length < 3) return entries;

  let headerIdx = 1;
  let langCol = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const c = findLangColumn(grid[r] || [], langName);
    if (c >= 0) {
      headerIdx = r;
      langCol = c;
      break;
    }
  }
  if (langCol < 0) return entries;

  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const chinese = txt(grid, r, 2);
    const english = txt(grid, r, 3);
    const episode = txt(grid, r, 5);
    const targetText = txt(grid, r, langCol);
    if (!targetText || (!chinese && !english)) continue;
    entries.push({ chinese, english, episode, targetText });
  }
  return entries;
}

export function parseLordsPrayerSheet(
  grid: RichSheetGrid,
  langName: string,
): ArticleParagraph[] {
  const result: ArticleParagraph[] = [];
  if (grid.length === 0) return result;

  let headerIdx = 0;
  let langCol = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const c = findLangColumn(grid[r] || [], langName);
    if (c >= 0) {
      headerIdx = r;
      langCol = c;
      break;
    }
  }
  if (langCol < 0) return result;

  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const chinese = txt(grid, r, 0);
    const english = txt(grid, r, 1);
    const target = txt(grid, r, langCol);
    if (target) result.push({ chinese, english, target });
  }
  return result;
}

export function parseHymnSheet(grid: RichSheetGrid): HymnEntry[] {
  const hymns: HymnEntry[] = [];
  let current: HymnEntry | null = null;

  for (let r = 0; r < grid.length; r += 1) {
    const c0 = txt(grid, r, 0);
    const c1 = txt(grid, r, 1);
    const c2 = txt(grid, r, 2);
    if (!c0 && !c1 && !c2) continue;

    if (/^《.+》$/.test(c0) || (c0 && c1 && c2 && c0.length < 40 && !/[，。,.!?]/.test(c0))) {
      current = {
        zhTitle: c0.replace(/^[《“"]+|[》”"]+$/g, ""),
        enTitle: c1.replace(/^["“]+|["”]+$/g, ""),
        targetTitle: c2.replace(/^[«„“""]+|[»”“""]+$/g, ""),
        lines: [],
      };
      hymns.push(current);
      continue;
    }

    if (current && c2) {
      if (c0.includes("跟随羔羊唱新歌") || c1.toLowerCase().startsWith("from follow")) {
        current.targetCitation = c2;
      } else {
        current.lines.push({ chinese: c0, english: c1, target: c2 });
      }
    }
  }
  return hymns;
}

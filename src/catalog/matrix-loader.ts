import type { LanguageResourceLinks, PunctuationRule } from "../types/domain";
import type { RichSheetGrid } from "./catalog-types";
import { applyMatrixRuleOverrides, resolvePunctuationRule } from "./lang-presets";

function cellText(grid: RichSheetGrid, r: number, c: number): string {
  return grid[r]?.[c]?.text?.trim() ?? "";
}

function cellLinkOrText(grid: RichSheetGrid, r: number, c: number): string {
  const cell = grid[r]?.[c];
  if (!cell) return "";
  if (cell.url && cell.url.startsWith("http")) return cell.url.trim();
  const txt = (cell.text || "").trim();
  return txt.startsWith("http") ? txt : "";
}

export interface ParsedResourceMatrix {
  languages: string[];
  linksByLang: Map<string, LanguageResourceLinks>;
  rulesByLang: Map<string, PunctuationRule>;
}

export function parseResourceMatrixGrid(
  grid: RichSheetGrid,
  fallbackRosterUrl = "",
): ParsedResourceMatrix {
  const languages: string[] = [];
  const linksByLang = new Map<string, LanguageResourceLinks>();
  const rulesByLang = new Map<string, PunctuationRule>();

  if (grid.length === 0) {
    return { languages, linksByLang, rulesByLang };
  }

  let langRowIdx = 0;
  for (let r = 0; r < Math.min(grid.length, 4); r += 1) {
    const nonEmpty = (grid[r] || []).slice(1).filter((c) => c.text.trim()).length;
    if (nonEmpty >= 1) {
      langRowIdx = r;
      break;
    }
  }

  const rowIndexByLabel = (patterns: RegExp[]): number => {
    for (let r = langRowIdx + 1; r < grid.length; r += 1) {
      const label = cellText(grid, r, 0);
      if (patterns.some((p) => p.test(label))) return r;
    }
    return -1;
  };

  const rArticle = rowIndexByLabel([/神话单篇/, /单篇稿/]);
  const rBible = rowIndexByLabel([/圣经库/, /圣经/]);
  const rIdiom = rowIndexByLabel([/俗语表/, /俗语/]);
  const rPunctDoc = rowIndexByLabel([/标点符号表/, /标点文档/]);
  const rQuoteShape = rowIndexByLabel([/引号的形状/, /剧本.*引号/]);
  const rEndingPos = rowIndexByLabel([/结尾标点和引号/, /标点和引号的位置/]);
  const rBiblePunct = rowIndexByLabel([/圣经摘自和结尾/, /圣经.*标点/]);
  const rCitation = rowIndexByLabel([/^摘自$/, /摘自链接/]);
  const rGodSays = rowIndexByLabel([/全能神说/]);
  const rHymn = rowIndexByLabel([/诗歌链接/, /^诗歌/]);
  const rPrayer = rowIndexByLabel([/主祷文/]);
  const rRoster = rowIndexByLabel([/人名/, /教会名/]);

  const headerRow = grid[langRowIdx] || [];
  for (let c = 1; c < headerRow.length; c += 1) {
    const langName = cellText(grid, langRowIdx, c);
    if (!langName) continue;
    languages.push(langName);

    const quoteRuleRaw = rQuoteShape >= 0 ? cellText(grid, rQuoteShape, c) : "";
    const endingRuleRaw = rEndingPos >= 0 ? cellText(grid, rEndingPos, c) : "";
    const bibleRuleRaw = rBiblePunct >= 0 ? cellText(grid, rBiblePunct, c) : "";

    const links: LanguageResourceLinks = {
      langName,
      articleCatalogUrl: rArticle >= 0 ? cellLinkOrText(grid, rArticle, c) : "",
      bibleSheetUrl: rBible >= 0 ? cellLinkOrText(grid, rBible, c) : "",
      idiomSheetUrl: rIdiom >= 0 ? cellLinkOrText(grid, rIdiom, c) : "",
      punctuationDocUrl: rPunctDoc >= 0 ? cellLinkOrText(grid, rPunctDoc, c) : "",
      commonTermsUrl: rCitation >= 0 ? cellLinkOrText(grid, rCitation, c) : "",
      godSaysUrl: rGodSays >= 0 ? cellLinkOrText(grid, rGodSays, c) : "",
      hymnSheetUrl: rHymn >= 0 ? cellLinkOrText(grid, rHymn, c) : "",
      lordsPrayerUrl: rPrayer >= 0 ? cellLinkOrText(grid, rPrayer, c) : "",
      rosterSheetUrl:
        (rRoster >= 0 ? cellLinkOrText(grid, rRoster, c) : "") || fallbackRosterUrl,
      quoteRuleRaw,
      endingRuleRaw,
      bibleRuleRaw,
    };

    const baseRule = resolvePunctuationRule(langName);
    const mergedRule = applyMatrixRuleOverrides(
      baseRule,
      quoteRuleRaw,
      endingRuleRaw,
      bibleRuleRaw,
    );

    linksByLang.set(langName, links);
    rulesByLang.set(langName, mergedRule);
  }

  return { languages, linksByLang, rulesByLang };
}

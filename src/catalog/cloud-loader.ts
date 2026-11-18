import type { GoogleDocsClient } from "../google/docs-client";
import type { GoogleSheetsClient } from "../google/sheets-client";
import { parseGoogleResourceUrl } from "../google/url-parser";
import type { LanguageResourceLinks, PunctuationRule } from "../types/domain";
import type {
  ArticleParagraph,
  LanguageCatalog,
  RichSheetGrid,
} from "./catalog-types";
import {
  parseArticleCatalogSheet,
  parseBibleLibrarySheet,
  parseCommonTermsSheet,
  parseHymnSheet,
  parseIdiomGlossarySheet,
  parseLordsPrayerSheet,
  parseRosterSheet,
} from "./sheet-parsers";

export class CloudCatalogLoader {
  private sheets: GoogleSheetsClient;
  private docs: GoogleDocsClient;
  private gridCache = new Map<string, RichSheetGrid>();
  private docCache = new Map<string, ArticleParagraph[]>();

  constructor(sheets: GoogleSheetsClient, docs: GoogleDocsClient) {
    this.sheets = sheets;
    this.docs = docs;
  }

  private async loadGridCached(rawUrl: string): Promise<RichSheetGrid> {
    const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
    if (!parsed || parsed.kind !== "sheet") return [];
    const key = `${parsed.id}:${parsed.gid ?? "first"}`;
    const hit = this.gridCache.get(key);
    if (hit) return hit;

    const { grid } = await this.sheets.fetchRichGrid(parsed.id, parsed.gid);
    this.gridCache.set(key, grid);
    return grid;
  }

  async loadArticleManuscript(rawUrl: string): Promise<ArticleParagraph[]> {
    const parsed = parseGoogleResourceUrl(rawUrl, "doc");
    if (!parsed) return [];
    const hit = this.docCache.get(`${parsed.kind}:${parsed.id}:${parsed.gid ?? ""}`);
    if (hit) return hit;

    let paragraphs: ArticleParagraph[] = [];
    if (parsed.kind === "doc") {
      paragraphs = await this.docs.fetchArticleParagraphs(parsed.id);
    } else {
      const grid = await this.loadGridCached(rawUrl);
      paragraphs = grid
        .filter((r) => (r[2]?.text || r[1]?.text || "").trim().length > 0)
        .map((r) => ({
          chinese: r[0]?.text ?? "",
          english: r.length >= 3 ? (r[1]?.text ?? "") : "",
          target: r.length >= 3 ? (r[2]?.text ?? "") : (r[1]?.text ?? ""),
        }));
    }

    this.docCache.set(`${parsed.kind}:${parsed.id}:${parsed.gid ?? ""}`, paragraphs);
    return paragraphs;
  }

  async buildLanguageCatalog(
    links: LanguageResourceLinks,
    rule: PunctuationRule,
  ): Promise<LanguageCatalog> {
    const [
      articleGrid,
      bibleGrid,
      idiomGrid,
      commonTermsGrid,
      godSaysGrid,
      hymnGrid,
      prayerGrid,
      rosterGrid,
    ] = await Promise.all([
      links.articleCatalogUrl ? this.loadGridCached(links.articleCatalogUrl) : Promise.resolve([]),
      links.bibleSheetUrl ? this.loadGridCached(links.bibleSheetUrl) : Promise.resolve([]),
      links.idiomSheetUrl ? this.loadGridCached(links.idiomSheetUrl) : Promise.resolve([]),
      links.commonTermsUrl ? this.loadGridCached(links.commonTermsUrl) : Promise.resolve([]),
      links.godSaysUrl && links.godSaysUrl !== links.commonTermsUrl
        ? this.loadGridCached(links.godSaysUrl)
        : Promise.resolve([]),
      links.hymnSheetUrl ? this.loadGridCached(links.hymnSheetUrl) : Promise.resolve([]),
      links.lordsPrayerUrl ? this.loadGridCached(links.lordsPrayerUrl) : Promise.resolve([]),
      links.rosterSheetUrl ? this.loadGridCached(links.rosterSheetUrl) : Promise.resolve([]),
    ]);

    const commonA = parseCommonTermsSheet(commonTermsGrid, links.langName);
    const commonB =
      godSaysGrid.length > 0
        ? parseCommonTermsSheet(godSaysGrid, links.langName)
        : { godSaysText: "", citations: [], fixedTerms: new Map<string, string>() };

    const mergedFixed = new Map<string, string>([
      ...commonA.fixedTerms,
      ...commonB.fixedTerms,
    ]);

    return {
      langName: links.langName,
      rule,
      godSaysText: commonB.godSaysText || commonA.godSaysText,
      commonFixedTerms: mergedFixed,
      citations: [...commonA.citations, ...commonB.citations],
      articles: parseArticleCatalogSheet(articleGrid),
      articleDocsCache: new Map(),
      bibleEntries: parseBibleLibrarySheet(bibleGrid),
      idioms: parseIdiomGlossarySheet(idiomGrid),
      hymns: parseHymnSheet(hymnGrid),
      lordsPrayer: parseLordsPrayerSheet(prayerGrid, links.langName),
      rosterEntries: parseRosterSheet(rosterGrid, links.langName),
    };
  }
}

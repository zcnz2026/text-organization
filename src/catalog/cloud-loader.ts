import type {
  GoogleDocsClient,
  ManuscriptColumnOrder,
} from "../google/docs-client";
import type { GoogleSheetsClient } from "../google/sheets-client";
import { parseGoogleResourceUrl } from "../google/url-parser";
import { diagLog } from "../platform/diag-log";
import type { LanguageResourceLinks, PunctuationRule } from "../types/domain";
import {
  type CloudWorkspaceConfig,
  DEFAULT_LANG_SHEET_COLS,
  DEFAULT_SHARED_SHEETS_CONFIG,
  type PerLanguageSheetColumnConfig,
  type SharedSheetsConfig,
} from "../types/schema-config";
import type {
  ArticleParagraph,
  LanguageCatalog,
  RichSheetGrid,
} from "./catalog-types";
import { parseCloudConfigSheets } from "./config-template";
import {
  parseArticleCatalogSheet,
  parseBibleLibrarySheet,
  parseCommonTermsSheet,
  parseHymnCitationsSheet,
  parseHymnSheet,
  parseIdiomGlossarySheet,
  parseLordsPrayerSheet,
  parseRosterSheet,
  parseWordCitationsSheet,
} from "./sheet-parsers";

export interface BuildLanguageCatalogOptions {
  sharedSheets?: Partial<SharedSheetsConfig>;
  langCols?: Partial<PerLanguageSheetColumnConfig>;
  hymnEpisodeKeyword?: string;
}

export class CloudCatalogLoader {
  private sheets: GoogleSheetsClient;
  private docs: GoogleDocsClient;
  private gridCache = new Map<string, RichSheetGrid>();
  private docCache = new Map<string, ArticleParagraph[]>();

  constructor(sheets: GoogleSheetsClient, docs: GoogleDocsClient) {
    this.sheets = sheets;
    this.docs = docs;
  }

  private async loadGridCached(
    rawUrl: string,
    overrideGidOrTitle?: number | string | null,
  ): Promise<RichSheetGrid> {
    const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
    if (!parsed || parsed.kind !== "sheet") return [];
    const targetGid = overrideGidOrTitle ?? parsed.gid;
    const key = `${parsed.id}:${targetGid ?? "first"}`;
    const hit = this.gridCache.get(key);
    if (hit) return hit;

    const { grid } = await this.sheets.fetchRichGrid(parsed.id, targetGid);
    this.gridCache.set(key, grid);
    return grid;
  }

  private async loadBibleGridSafe(rawUrl: string): Promise<RichSheetGrid> {
    if (!rawUrl) return [];
    const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
    if (!parsed || parsed.kind !== "sheet") return [];
    if (parsed.gid !== null) return this.loadGridCached(rawUrl);

    const meta = await this.sheets.getSpreadsheetMeta(parsed.id);
    const tab = meta.sheets.find((s) => {
      const t = s.title.toLowerCase();
      if (/天主教|catholic|目录|catalog|格式/.test(t)) return false;
      return /圣经|bible/.test(t);
    });
    return this.loadGridCached(rawUrl, tab ? tab.sheetId : null);
  }

  private async loadHymnGridWithEpisodeKeyword(
    rawUrl: string,
    episodeKeyword?: string,
  ): Promise<RichSheetGrid> {
    if (!rawUrl) return [];
    const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
    if (!parsed || parsed.kind !== "sheet") return [];

    const kw = (episodeKeyword || "").trim().toLowerCase();
    if (kw) {
      const meta = await this.sheets.getSpreadsheetMeta(parsed.id);
      const exactMatch = meta.sheets.find((s) =>
        s.title.toLowerCase().includes(kw),
      );
      if (exactMatch) {
        return this.loadGridCached(rawUrl, exactMatch.sheetId);
      }
      const numMatch = /(\d+)\s*期/.exec(kw);
      if (numMatch) {
        const epNum = `${numMatch[1]}期`;
        const epTab = meta.sheets.find((s) => s.title.includes(epNum));
        if (epTab) {
          return this.loadGridCached(rawUrl, epTab.sheetId);
        }
      }
    }

    return this.loadGridCached(rawUrl);
  }

  async loadCloudWorkspaceConfig(
    spreadsheetUrlOrId: string,
  ): Promise<CloudWorkspaceConfig> {
    const parsed = parseGoogleResourceUrl(spreadsheetUrlOrId, "sheet");
    if (!parsed || parsed.kind !== "sheet") {
      throw new Error("无效的云端总配置表 Google Sheet 链接或 ID");
    }

    const meta = await this.sheets.getSpreadsheetMeta(parsed.id);
    const sheetsByName = new Map<string, RichSheetGrid>();
    await Promise.all(
      meta.sheets.map(async (tab) => {
        const grid = await this.loadGridCached(spreadsheetUrlOrId, tab.sheetId);
        sheetsByName.set(tab.title, grid);
      }),
    );

    return parseCloudConfigSheets(sheetsByName);
  }

  async loadArticleManuscript(
    rawUrl: string,
    cols?:
      | ManuscriptColumnOrder
      | Pick<
          PerLanguageSheetColumnConfig,
          | "manuscriptZhColIndex"
          | "manuscriptEnColIndex"
          | "manuscriptTargetColIndex"
        >,
  ): Promise<ArticleParagraph[]> {
    const parsed = parseGoogleResourceUrl(rawUrl, "doc");
    if (!parsed) return [];

    const order: ManuscriptColumnOrder =
      cols && "zhCol1Based" in cols
        ? cols
        : {
            zhCol1Based:
              cols?.manuscriptZhColIndex ??
              DEFAULT_LANG_SHEET_COLS.manuscriptZhColIndex,
            enCol1Based:
              cols?.manuscriptEnColIndex ??
              DEFAULT_LANG_SHEET_COLS.manuscriptEnColIndex,
            targetCol1Based:
              cols?.manuscriptTargetColIndex ??
              DEFAULT_LANG_SHEET_COLS.manuscriptTargetColIndex,
          };

    const cacheKey = `${parsed.kind}:${parsed.id}:${parsed.gid ?? ""}:${order.zhCol1Based},${order.enCol1Based},${order.targetCol1Based}`;
    const hit = this.docCache.get(cacheKey);
    if (hit) return hit;

    let paragraphs: ArticleParagraph[] = [];
    if (parsed.kind === "doc") {
      paragraphs = await this.docs.fetchArticleParagraphs(parsed.id, order);
    } else {
      const grid = await this.loadGridCached(rawUrl);
      const zIdx = Math.max(0, order.zhCol1Based - 1);
      const eIdx = Math.max(0, order.enCol1Based - 1);
      const tIdx = Math.max(0, order.targetCol1Based - 1);
      paragraphs = grid
        .filter((r) => (r[tIdx]?.text || r[eIdx]?.text || "").trim().length > 0)
        .map((r) => ({
          chinese: r[zIdx]?.text ?? "",
          english: r.length >= 3 ? (r[eIdx]?.text ?? "") : "",
          target:
            r.length >= 3 ? (r[tIdx]?.text ?? "") : (r[1]?.text ?? ""),
        }));
    }

    this.docCache.set(cacheKey, paragraphs);
    return paragraphs;
  }

  async buildLanguageCatalog(
    links: LanguageResourceLinks,
    rule: PunctuationRule,
    opts?: BuildLanguageCatalogOptions,
  ): Promise<LanguageCatalog> {
    const sharedCfg: SharedSheetsConfig = {
      ...DEFAULT_SHARED_SHEETS_CONFIG,
      ...(opts?.sharedSheets ?? {}),
    };
    const langCols: PerLanguageSheetColumnConfig = {
      ...DEFAULT_LANG_SHEET_COLS,
      ...(opts?.langCols ?? {}),
    };

    const commonUrl = links.commonTermsUrl || sharedCfg.commonTermsUrl;
    const wordCitUrl =
      links.extraCitationSheetUrl || sharedCfg.wordCitationsUrl;
    const hymnCitUrl = sharedCfg.hymnCitationsUrl;
    const prayerUrl = links.lordsPrayerUrl || sharedCfg.lordsPrayerUrl;
    const rosterUrl = links.rosterSheetUrl || sharedCfg.rosterUrl;

    const [
      articleGrid,
      bibleGrid,
      idiomGrid,
      commonTermsGrid,
      godSaysGrid,
      wordCitationsGrid,
      hymnCitationsGrid,
      hymnGrid,
      prayerGrid,
      rosterGrid,
    ] = await Promise.all([
      links.articleCatalogUrl
        ? this.loadGridCached(links.articleCatalogUrl)
        : Promise.resolve([]),
      links.bibleSheetUrl
        ? this.loadBibleGridSafe(links.bibleSheetUrl)
        : Promise.resolve([]),
      links.idiomSheetUrl
        ? this.loadGridCached(links.idiomSheetUrl)
        : Promise.resolve([]),
      commonUrl ? this.loadGridCached(commonUrl) : Promise.resolve([]),
      links.godSaysUrl && links.godSaysUrl !== commonUrl
        ? this.loadGridCached(links.godSaysUrl)
        : Promise.resolve([]),
      wordCitUrl && wordCitUrl !== commonUrl
        ? this.loadGridCached(wordCitUrl)
        : Promise.resolve([]),
      hymnCitUrl && hymnCitUrl !== commonUrl && hymnCitUrl !== wordCitUrl
        ? this.loadGridCached(hymnCitUrl)
        : Promise.resolve([]),
      links.hymnSheetUrl
        ? this.loadHymnGridWithEpisodeKeyword(
            links.hymnSheetUrl,
            opts?.hymnEpisodeKeyword,
          )
        : Promise.resolve([]),
      prayerUrl ? this.loadGridCached(prayerUrl) : Promise.resolve([]),
      rosterUrl ? this.loadGridCached(rosterUrl) : Promise.resolve([]),
    ]);

    const commonA = parseCommonTermsSheet(
      commonTermsGrid,
      links.langName,
      sharedCfg,
    );
    const commonB =
      godSaysGrid.length > 0
        ? parseCommonTermsSheet(godSaysGrid, links.langName, sharedCfg)
        : {
            godSaysText: "",
            citations: [],
            fixedTerms: new Map<string, string>(),
          };

    const wordCites =
      wordCitationsGrid.length > 0
        ? parseWordCitationsSheet(wordCitationsGrid, links.langName, sharedCfg)
        : [];
    const hymnCites =
      hymnCitationsGrid.length > 0
        ? parseHymnCitationsSheet(hymnCitationsGrid, links.langName, sharedCfg)
        : [];

    const mergedFixed = new Map<string, string>([
      ...commonA.fixedTerms,
      ...commonB.fixedTerms,
    ]);

    const parsedPrayer = parseLordsPrayerSheet(
      prayerGrid,
      links.langName,
      sharedCfg,
    );

    const citations = [
      ...commonA.citations,
      ...commonB.citations,
      ...wordCites,
      ...hymnCites,
    ];
    const articles = parseArticleCatalogSheet(articleGrid, opts?.langCols);
    const bibleEntries = parseBibleLibrarySheet(bibleGrid, opts?.langCols);
    const idioms = parseIdiomGlossarySheet(idiomGrid, opts?.langCols);
    const hymns = parseHymnSheet(hymnGrid, langCols);
    const rosterEntries = parseRosterSheet(rosterGrid, links.langName, sharedCfg);

    diagLog.info(
      "资料库加载",
      `[${links.langName}] 目录 ${articles.length} 篇 / 圣经 ${bibleEntries.length} 条 / 俗语 ${idioms.length} 条 / 诗歌 ${hymns.length} 首 / 摘自 ${citations.length} 条`,
    );

    return {
      langName: links.langName,
      rule,
      godSaysText: commonB.godSaysText || commonA.godSaysText,
      commonFixedTerms: mergedFixed,
      citations,
      articles,
      articleDocsCache: new Map(),
      bibleEntries,
      idioms,
      hymns,
      lordsPrayer: parsedPrayer.lines,
      ...(parsedPrayer.fullText
        ? { lordsPrayerFullText: parsedPrayer.fullText }
        : {}),
      rosterEntries,
    };
  }
}

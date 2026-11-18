import { GeminiPoolClient } from "../ai/gemini-client";
import { CloudCatalogLoader } from "../catalog/cloud-loader";
import { buildConfigTemplateXlsx } from "../catalog/config-template";
import { resolvePunctuationRule } from "../catalog/lang-presets";
import { parseResourceMatrixGrid } from "../catalog/matrix-loader";
import { parseCsvToGrid, parseGridToScriptDocument } from "../engine/csv-sheet";
import { runLanguageExtractionPipeline } from "../engine/pipeline";
import { buildMultiSheetXlsx } from "../engine/xlsx-export";
import { GoogleDocsClient } from "../google/docs-client";
import { GoogleSheetsClient } from "../google/sheets-client";
import { parseGoogleResourceUrl } from "../google/url-parser";
import { hostBridge } from "../platform/bridge";
import type { LanguageResourceLinks } from "../types/domain";
import type { CloudWorkspaceConfig } from "../types/schema-config";
import { createSyntheticDemoState } from "./demo-fixture";
import { getLangCols, notifyStateChanged, store } from "./state";

function createCloudClients() {
  const tokenProvider = () => hostBridge.getValidAccessToken();
  return { sheets: new GoogleSheetsClient(tokenProvider), docs: new GoogleDocsClient(tokenProvider) };
}

function triggerXlsxDownload(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function applyCloudWorkspaceConfig(cfg: CloudWorkspaceConfig): number {
  store.sourceColConfig = { ...store.sourceColConfig, ...cfg.sourceCols };
  store.sharedSheets = { ...store.sharedSheets, ...cfg.sharedSheets };
  if (cfg.sharedSheets.rosterUrl) store.settings.rosterSpreadsheetUrl = cfg.sharedSheets.rosterUrl;
  const langs = new Set<string>(store.availableLanguages);
  for (const [lang, link] of Object.entries(cfg.linksByLang)) {
    langs.add(lang);
    store.linksByLang.set(lang, link);
  }
  for (const [lang, cols] of Object.entries(cfg.colsByLang)) {
    langs.add(lang);
    store.colsByLang[lang] = cols;
  }
  if (cfg.rules?.length) {
    store.customRules = cfg.rules;
    for (const r of cfg.rules) langs.add(r.langName);
  }
  store.availableLanguages = [...langs];
  return Object.keys(cfg.linksByLang).length || store.availableLanguages.length;
}

function startBusy(pct: number, text: string): void {
  store.busy = true;
  store.progressPercent = pct;
  store.progressText = text;
  store.notice = null;
  notifyStateChanged();
}

function finishBusy(err?: unknown): void {
  if (err !== undefined) store.notice = { type: "error", message: err instanceof Error ? err.message : String(err) };
  store.busy = false;
  store.progressPercent = 0;
  store.progressText = "";
  notifyStateChanged();
}

function setErr(message: string): void {
  store.notice = { type: "error", message };
  notifyStateChanged();
}

export async function refreshCloudConfigFromSheet(): Promise<void> {
  const rawUrl = store.cloudConfigUrl.trim() || store.settings.resourceMatrixUrl.trim();
  const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
  if (!parsed || parsed.kind !== "sheet") return setErr("请先在左侧粘贴有效的「云端总配置表链接」Google Sheet 地址。");
  startBusy(25, "正在从 Google Sheets 读取 4-Sheet 云端总配置表...");
  try {
    const { sheets, docs } = createCloudClients();
    const cfg = await new CloudCatalogLoader(sheets, docs).loadCloudWorkspaceConfig(rawUrl);
    const count = applyCloudWorkspaceConfig(cfg);
    store.notice = { type: "info", message: `已成功同步云端总配置表（共更新 ${count} 个语种资料链接、表内列映射与标点规则）。` };
    finishBusy();
  } catch (err) { finishBusy(err); }
}

export function downloadConfigTemplateXlsx(): void {
  const linksByLang: Record<string, LanguageResourceLinks> = {};
  for (const [k, v] of store.linksByLang.entries()) linksByLang[k] = v;
  const rules = store.availableLanguages.map((l) => resolvePunctuationRule(l, store.customRules));
  const bytes = buildConfigTemplateXlsx({ sourceCols: store.sourceColConfig, sharedSheets: store.sharedSheets, linksByLang, colsByLang: store.colsByLang, rules });
  triggerXlsxDownload(bytes, "剧本对应语系_标准云端配置表模板.xlsx");
}

export async function loadSampleDemo(): Promise<void> {
  const { doc, runs } = await createSyntheticDemoState();
  store.scriptDoc = doc;
  store.isDemoData = true;
  store.runsByLang = runs;
  store.activePreviewLang = "乌克兰语";
  store.rowFilter = "extractable";
  store.notice = { type: "info", message: "已载入第 39 期报道合成演示样本，可切换筛选标签或直接点击单元格体验微调。" };
  notifyStateChanged();
}

export async function importLocalCsvFile(file: File): Promise<void> {
  try {
    const grid = parseCsvToGrid(await file.text());
    const title = file.name.replace(/\.csv$/i, "");
    store.scriptDoc = parseGridToScriptDocument(grid, title, store.sourceColConfig);
    store.isDemoData = false;
    store.runsByLang.clear();
    store.activePreviewLang = "";
    store.rowFilter = "extractable";
    store.notice = { type: "info", message: `已导入本地剧本「${title}」（共 ${store.scriptDoc.rows.length} 行）。连接云端资源表后即可按语种提取。` };
    notifyStateChanged();
  } catch (err) { finishBusy(err); }
}

export async function loadCloudSourceAndMatrix(): Promise<void> {
  const srcParsed = parseGoogleResourceUrl(store.settings.sourceSpreadsheetUrl, "sheet");
  if (!srcParsed || srcParsed.kind !== "sheet") return setErr("请先在左侧粘贴有效的「源剧本 Google 表格」链接。");
  startBusy(15, "正在从 Google Sheets 读取源剧本...");
  try {
    const { sheets, docs } = createCloudClients();
    const { title, grid } = await sheets.fetchRichGrid(srcParsed.id, srcParsed.gid);
    store.scriptDoc = parseGridToScriptDocument(grid.map((r) => r.map((c) => c.text)), title, store.sourceColConfig);
    store.isDemoData = false;
    store.runsByLang.clear();
    store.progressPercent = 60;
    store.progressText = "正在解析多语种资源总配置表...";
    notifyStateChanged();

    const cfgUrl = store.cloudConfigUrl.trim() || store.settings.resourceMatrixUrl.trim();
    if (cfgUrl) {
      try {
        const cfg = await new CloudCatalogLoader(sheets, docs).loadCloudWorkspaceConfig(cfgUrl);
        if (Object.keys(cfg.linksByLang).length > 0) applyCloudWorkspaceConfig(cfg);
      } catch { /* fallback */ }
    }
    if (store.linksByLang.size === 0) {
      let matrixGrid = null;
      if (cfgUrl) {
        const matParsed = parseGoogleResourceUrl(cfgUrl, "sheet");
        if (matParsed?.kind === "sheet") matrixGrid = (await sheets.fetchRichGrid(matParsed.id, matParsed.gid)).grid;
      } else {
        const tab = (await sheets.getSpreadsheetMeta(srcParsed.id)).sheets.find((t) => /资源|链接|概览|resource/i.test(t.title));
        if (tab) matrixGrid = (await sheets.fetchRichGrid(srcParsed.id, tab.sheetId)).grid;
      }
      if (matrixGrid) {
        const parsed = parseResourceMatrixGrid(matrixGrid, store.sharedSheets.rosterUrl || store.settings.rosterSpreadsheetUrl);
        if (parsed.languages.length > 0) {
          store.availableLanguages = [...new Set([...store.availableLanguages, ...parsed.languages])];
          store.linksByLang = parsed.linksByLang;
          for (const [lang, mergedRule] of parsed.rulesByLang.entries()) {
            if (!store.customRules.some((r) => r.langName === lang)) store.customRules.push(mergedRule);
          }
        }
      }
    }
    store.notice = { type: "info", message: `云端源稿「${title}」读取成功（${store.scriptDoc.rows.length} 行），当前可用 ${store.availableLanguages.length} 个语种配置。` };
    finishBusy();
  } catch (err) { finishBusy(err); }
}

export async function runMultiLanguageExtraction(): Promise<void> {
  if (!store.scriptDoc && store.settings.sourceSpreadsheetUrl.trim()) await loadCloudSourceAndMatrix();
  if (!store.scriptDoc) return setErr("请先读取云端源剧本或导入本地 CSV 源稿。");
  const targetLangs = store.settings.selectedLanguages;
  if (targetLangs.length === 0) return setErr("请至少勾选一个目标输出语种。");
  const outParsed = store.settings.outputSpreadsheetUrl.trim() ? parseGoogleResourceUrl(store.settings.outputSpreadsheetUrl, "sheet") : null;
  startBusy(5, "正在初始化云端资料库加载器...");
  try {
    const { sheets, docs } = createCloudClients();
    const loader = new CloudCatalogLoader(sheets, docs);
    let gemini: GeminiPoolClient | undefined;
    if (store.geminiEnabled && store.geminiSummary.count > 0) {
      const keys = await hostBridge.getPlainGeminiKeys();
      if (keys.length > 0) gemini = new GeminiPoolClient({ apiKeys: keys, model: store.geminiModel, rotation: store.geminiRotation });
    }
    let writtenSheets = 0;
    for (let i = 0; i < targetLangs.length; i += 1) {
      const lang = targetLangs[i];
      const basePct = (i / targetLangs.length) * 100;
      const spanPct = 100 / targetLangs.length;
      store.progressPercent = basePct + spanPct * 0.12;
      store.progressText = `[${i + 1}/${targetLangs.length}] 正在加载「${lang}」云端资料表...`;
      notifyStateChanged();

      const rule = resolvePunctuationRule(lang, store.customRules);
      const rosterFallback = store.sharedSheets.rosterUrl || store.settings.rosterSpreadsheetUrl;
      const baseLinks = store.linksByLang.get(lang) ?? {
        langName: lang, articleCatalogUrl: "", bibleSheetUrl: "", idiomSheetUrl: "", punctuationDocUrl: "",
        commonTermsUrl: "", godSaysUrl: "", hymnSheetUrl: "", lordsPrayerUrl: "", rosterSheetUrl: rosterFallback,
      };
      const epOverrideHymn = store.episodeHymnOverrides[lang]?.trim();
      const links: LanguageResourceLinks = { ...baseLinks, hymnSheetUrl: epOverrideHymn || baseLinks.hymnSheetUrl, rosterSheetUrl: baseLinks.rosterSheetUrl || rosterFallback };
      const langCols = getLangCols(lang);
      const catalog = await loader.buildLanguageCatalog(links, rule, { sharedSheets: store.sharedSheets, langCols, hymnEpisodeKeyword: store.hymnEpisodeKeyword });
      const runOut = await runLanguageExtractionPipeline(store.scriptDoc, catalog, {
        enableRosterPreFill: store.settings.enableRosterPreFill,
        gemini,
        loadArticleDoc: (docUrl) => loader.loadArticleManuscript(docUrl, { zhCol1Based: langCols.manuscriptZhColIndex, enCol1Based: langCols.manuscriptEnColIndex, targetCol1Based: langCols.manuscriptTargetColIndex }),
        onProgress: (done, total, hint) => {
          store.progressPercent = basePct + spanPct * (0.15 + 0.65 * (done / Math.max(1, total)));
          store.progressText = `[${lang}] 正在匹配 (${done}/${total}) ${hint.slice(0, 18)}`;
          notifyStateChanged();
        },
      });
      store.runsByLang.set(lang, runOut);
      store.activePreviewLang = lang;
      if (outParsed?.kind === "sheet") {
        store.progressPercent = basePct + spanPct * 0.88;
        store.progressText = `[${lang}] 正在写入输出 Google 表格 Sheet...`;
        notifyStateChanged();
        await sheets.writeLanguageSheet(outParsed.id, lang, store.scriptDoc, runOut, store.settings.overwriteExistingSheets, store.sourceColConfig.outputHintCol);
        writtenSheets += 1;
      }
    }
    store.notice = { type: "info", message: writtenSheets > 0 ? `已完成 ${targetLangs.length} 个语种摘录，并成功写入专用输出 Google 表格（共 ${writtenSheets} 个独立 Sheet）。` : `已完成 ${targetLangs.length} 个语种摘录预览（未填写输出 Google 表格链接，可核对后写入或导出 Excel）。` };
    finishBusy();
  } catch (err) { finishBusy(err); }
}

export async function syncReviewedSheetsToCloud(): Promise<void> {
  if (!store.scriptDoc || store.runsByLang.size === 0) return;
  const outParsed = parseGoogleResourceUrl(store.settings.outputSpreadsheetUrl, "sheet");
  if (!outParsed || outParsed.kind !== "sheet") return setErr("请先在左侧填写有效的「专用输出 Google 表格」链接。");
  startBusy(15, "正在将当前审校微调结果写入 Google 表格...");
  try {
    const { sheets } = createCloudClients();
    const entries = [...store.runsByLang.entries()];
    for (let i = 0; i < entries.length; i += 1) {
      const [lang, runOut] = entries[i];
      store.progressPercent = Math.round(((i + 0.5) / entries.length) * 100);
      store.progressText = `正在写回「${lang}」Sheet (${i + 1}/${entries.length})...`;
      notifyStateChanged();
      await sheets.writeLanguageSheet(outParsed.id, lang, store.scriptDoc, runOut, store.settings.overwriteExistingSheets, store.sourceColConfig.outputHintCol);
    }
    store.notice = { type: "info", message: `已将当前审校确认后的 ${entries.length} 个语种 Sheet 完整写回专用输出 Google 表格。` };
    finishBusy();
  } catch (err) { finishBusy(err); }
}

export function exportCurrentRunsXlsx(): void {
  if (!store.scriptDoc) return;
  const bytes = buildMultiSheetXlsx(store.scriptDoc, [...store.runsByLang.values()], store.sourceColConfig.outputHintCol);
  triggerXlsxDownload(bytes, `${store.scriptDoc.title || "剧本对应语系"}_多语种摘录.xlsx`);
}

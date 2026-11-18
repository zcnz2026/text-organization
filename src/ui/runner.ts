import { GeminiPoolClient } from "../ai/gemini-client";
import { CloudCatalogLoader } from "../catalog/cloud-loader";
import { resolvePunctuationRule } from "../catalog/lang-presets";
import { parseResourceMatrixGrid } from "../catalog/matrix-loader";
import { parseCsvToGrid, parseGridToScriptDocument } from "../engine/csv-sheet";
import { runLanguageExtractionPipeline } from "../engine/pipeline";
import { buildMultiSheetXlsx } from "../engine/xlsx-export";
import { GoogleDocsClient } from "../google/docs-client";
import { GoogleSheetsClient } from "../google/sheets-client";
import { parseGoogleResourceUrl } from "../google/url-parser";
import { hostBridge } from "../platform/bridge";
import { createSyntheticDemoState } from "./demo-fixture";
import { notifyStateChanged, store } from "./state";

function createCloudClients() {
  const tokenProvider = () => hostBridge.getValidAccessToken();
  const sheets = new GoogleSheetsClient(tokenProvider);
  const docs = new GoogleDocsClient(tokenProvider);
  return { sheets, docs };
}

export async function loadSampleDemo(): Promise<void> {
  const { doc, runs } = await createSyntheticDemoState();
  store.scriptDoc = doc;
  store.isDemoData = true;
  store.runsByLang = runs;
  store.activePreviewLang = "乌克兰语";
  store.rowFilter = "extractable";
  store.notice = {
    type: "info",
    message: "已载入第 39 期报道合成演示样本，可切换筛选标签或直接点击单元格体验微调。",
  };
  notifyStateChanged();
}

export async function importLocalCsvFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    const grid = parseCsvToGrid(text);
    const title = file.name.replace(/\.csv$/i, "");
    store.scriptDoc = parseGridToScriptDocument(grid, title);
    store.isDemoData = false;
    store.runsByLang.clear();
    store.activePreviewLang = "";
    store.rowFilter = "extractable";
    store.notice = {
      type: "info",
      message: `已导入本地剧本「${title}」（共 ${store.scriptDoc.rows.length} 行）。连接云端资源表后即可按语种提取。`,
    };
    notifyStateChanged();
  } catch (err) {
    store.notice = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    notifyStateChanged();
  }
}

export async function loadCloudSourceAndMatrix(): Promise<void> {
  const srcParsed = parseGoogleResourceUrl(
    store.settings.sourceSpreadsheetUrl,
    "sheet",
  );
  if (!srcParsed || srcParsed.kind !== "sheet") {
    store.notice = {
      type: "error",
      message: "请先在左侧粘贴有效的「源剧本 Google 表格」链接。",
    };
    notifyStateChanged();
    return;
  }

  store.busy = true;
  store.progressPercent = 15;
  store.progressText = "正在从 Google Sheets 读取源剧本...";
  store.notice = null;
  notifyStateChanged();

  try {
    const { sheets } = createCloudClients();
    const { title, grid } = await sheets.fetchRichGrid(srcParsed.id, srcParsed.gid);
    const plainGrid = grid.map((r) => r.map((c) => c.text));
    store.scriptDoc = parseGridToScriptDocument(plainGrid, title);
    store.isDemoData = false;
    store.runsByLang.clear();

    store.progressPercent = 60;
    store.progressText = "正在解析多语种资源总配置表...";
    notifyStateChanged();

    let matrixGrid = null;
    if (store.settings.resourceMatrixUrl.trim()) {
      const matParsed = parseGoogleResourceUrl(
        store.settings.resourceMatrixUrl,
        "sheet",
      );
      if (matParsed && matParsed.kind === "sheet") {
        const fetched = await sheets.fetchRichGrid(matParsed.id, matParsed.gid);
        matrixGrid = fetched.grid;
      }
    } else {
      const meta = await sheets.getSpreadsheetMeta(srcParsed.id);
      const resourceTab = meta.sheets.find((t) =>
        /资源|链接|概览|resource/i.test(t.title),
      );
      if (resourceTab) {
        const fetched = await sheets.fetchRichGrid(srcParsed.id, resourceTab.sheetId);
        matrixGrid = fetched.grid;
      }
    }

    if (matrixGrid) {
      const parsedMatrix = parseResourceMatrixGrid(
        matrixGrid,
        store.settings.rosterSpreadsheetUrl,
      );
      if (parsedMatrix.languages.length > 0) {
        store.availableLanguages = parsedMatrix.languages;
        store.linksByLang = parsedMatrix.linksByLang;
        for (const [lang, mergedRule] of parsedMatrix.rulesByLang.entries()) {
          if (!store.customRules.some((r) => r.langName === lang)) {
            store.customRules.push(mergedRule);
          }
        }
        store.settings.selectedLanguages = store.settings.selectedLanguages.filter(
          (l) => parsedMatrix.languages.includes(l),
        );
        if (store.settings.selectedLanguages.length === 0) {
          store.settings.selectedLanguages = parsedMatrix.languages.slice(0, 3);
        }
      }
    }

    store.notice = {
      type: "info",
      message: `云端源稿「${title}」读取成功（${store.scriptDoc.rows.length} 行），识别到 ${store.availableLanguages.length} 个语种配置。`,
    };
  } catch (err) {
    store.notice = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export async function runMultiLanguageExtraction(): Promise<void> {
  if (!store.scriptDoc && store.settings.sourceSpreadsheetUrl.trim()) {
    await loadCloudSourceAndMatrix();
  }
  if (!store.scriptDoc) {
    store.notice = {
      type: "error",
      message: "请先读取云端源剧本或导入本地 CSV 源稿。",
    };
    notifyStateChanged();
    return;
  }

  const targetLangs = store.settings.selectedLanguages;
  if (targetLangs.length === 0) {
    store.notice = { type: "error", message: "请至少勾选一个目标输出语种。" };
    notifyStateChanged();
    return;
  }

  const outParsed = store.settings.outputSpreadsheetUrl.trim()
    ? parseGoogleResourceUrl(store.settings.outputSpreadsheetUrl, "sheet")
    : null;

  store.busy = true;
  store.progressPercent = 5;
  store.progressText = "正在初始化云端资料库加载器...";
  store.notice = null;
  notifyStateChanged();

  try {
    const { sheets, docs } = createCloudClients();
    const loader = new CloudCatalogLoader(sheets, docs);

    let gemini: GeminiPoolClient | undefined;
    if (store.geminiEnabled && store.geminiSummary.count > 0) {
      const keys = await hostBridge.getPlainGeminiKeys();
      if (keys.length > 0) {
        gemini = new GeminiPoolClient({
          apiKeys: keys,
          model: store.geminiModel,
          rotation: store.geminiRotation,
        });
      }
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
      const links = store.linksByLang.get(lang) ?? {
        langName: lang,
        articleCatalogUrl: "",
        bibleSheetUrl: "",
        idiomSheetUrl: "",
        punctuationDocUrl: "",
        commonTermsUrl: "",
        godSaysUrl: "",
        hymnSheetUrl: "",
        lordsPrayerUrl: "",
        rosterSheetUrl: store.settings.rosterSpreadsheetUrl,
      };
      if (!links.rosterSheetUrl && store.settings.rosterSpreadsheetUrl) {
        links.rosterSheetUrl = store.settings.rosterSpreadsheetUrl;
      }

      const catalog = await loader.buildLanguageCatalog(links, rule);
      const runOut = await runLanguageExtractionPipeline(store.scriptDoc, catalog, {
        enableRosterPreFill: store.settings.enableRosterPreFill,
        gemini,
        loadArticleDoc: (docUrl) => loader.loadArticleManuscript(docUrl),
        onProgress: (done, total, hint) => {
          store.progressPercent = basePct + spanPct * (0.15 + 0.65 * (done / Math.max(1, total)));
          store.progressText = `[${lang}] 正在匹配 (${done}/${total}) ${hint.slice(0, 18)}`;
          notifyStateChanged();
        },
      });

      store.runsByLang.set(lang, runOut);
      store.activePreviewLang = lang;

      if (outParsed && outParsed.kind === "sheet") {
        store.progressPercent = basePct + spanPct * 0.88;
        store.progressText = `[${lang}] 正在写入输出 Google 表格 Sheet...`;
        notifyStateChanged();
        await sheets.writeLanguageSheet(
          outParsed.id,
          lang,
          store.scriptDoc,
          runOut,
          store.settings.overwriteExistingSheets,
        );
        writtenSheets += 1;
      }
    }

    store.notice = {
      type: "info",
      message:
        writtenSheets > 0
          ? `已完成 ${targetLangs.length} 个语种摘录，并成功写入专用输出 Google 表格（共 ${writtenSheets} 个独立 Sheet）。`
          : `已完成 ${targetLangs.length} 个语种摘录预览（未填写输出 Google 表格链接，可核对后写入或导出 Excel）。`,
    };
  } catch (err) {
    store.notice = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export async function syncReviewedSheetsToCloud(): Promise<void> {
  if (!store.scriptDoc || store.runsByLang.size === 0) return;
  const outParsed = parseGoogleResourceUrl(
    store.settings.outputSpreadsheetUrl,
    "sheet",
  );
  if (!outParsed || outParsed.kind !== "sheet") {
    store.notice = {
      type: "error",
      message: "请先在左侧填写有效的「专用输出 Google 表格」链接。",
    };
    notifyStateChanged();
    return;
  }

  store.busy = true;
  store.progressPercent = 15;
  store.progressText = "正在将当前审校微调结果写入 Google 表格...";
  store.notice = null;
  notifyStateChanged();

  try {
    const { sheets } = createCloudClients();
    const entries = [...store.runsByLang.entries()];
    for (let i = 0; i < entries.length; i += 1) {
      const [lang, runOut] = entries[i];
      store.progressPercent = Math.round(((i + 0.5) / entries.length) * 100);
      store.progressText = `正在写回「${lang}」Sheet (${i + 1}/${entries.length})...`;
      notifyStateChanged();
      await sheets.writeLanguageSheet(
        outParsed.id,
        lang,
        store.scriptDoc,
        runOut,
        store.settings.overwriteExistingSheets,
      );
    }
    store.notice = {
      type: "info",
      message: `已将当前审校确认后的 ${entries.length} 个语种 Sheet 完整写回专用输出 Google 表格。`,
    };
  } catch (err) {
    store.notice = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export function exportCurrentRunsXlsx(): void {
  if (!store.scriptDoc) return;
  const bytes = buildMultiSheetXlsx(store.scriptDoc, [...store.runsByLang.values()]);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${store.scriptDoc.title || "剧本对应语系"}_多语种摘录.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

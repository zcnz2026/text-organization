import { GeminiPoolClient } from "../ai/gemini-client";
import {
  LineBreakPausedError,
  runSubtitleLineBreakPipeline,
  summarizeRun,
} from "../linebreak/ai-breaker";
import {
  buildSheetCheckpointKey,
  clearSheetAiCheckpoint,
  loadSheetAiCheckpoint,
  saveBatchItemPreviewBundle,
  saveBatchQueueCheckpoint,
  saveSheetAiCheckpoint,
} from "../linebreak/checkpoint-store";
import { writeStatusBackToBatchMasterSheet } from "../linebreak/batch-master";
import {
  inspectGoogleSpreadsheetTabs,
  loadSubtitleWorkbookFromGoogleUrl,
  writeLineBreakRunToGoogleSheet,
} from "../linebreak/google-sheet-io";
import { createSubtitleMeasurer } from "../linebreak/measurer";
import {
  detectLanguageSpecFromText,
  resolveLineBreakSpec,
} from "../linebreak/presets";
import {
  parseCsvToSubtitleWorkbook,
  parseXlsxToSubtitleWorkbook,
} from "../linebreak/xlsx-reader";
import { buildLineBreakResultXlsx } from "../linebreak/xlsx-writer";
import { hostBridge } from "../platform/bridge";
import { diagLog } from "../platform/diag-log";
import {
  beginAbortableLineBreakSession,
  endAbortableLineBreakSession,
} from "./linebreak-batch-runner";
import { promptSingleSheetSelection } from "./linebreak-sheet-picker-dialog";
import { notifyStateChanged, store } from "./state";

function triggerXlsxDownload(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function detectWorkbookLang(wbName: string, sheetName: string, targetHeader: string): string | null {
  return (
    detectLanguageSpecFromText(targetHeader)?.code ??
    detectLanguageSpecFromText(sheetName)?.code ??
    detectLanguageSpecFromText(wbName)?.code ??
    null
  );
}

export async function importLineBreakFromGoogleUrl(): Promise<boolean> {
  const rawUrl = store.lineBreak.sourceSheetUrl.trim();
  if (!rawUrl) {
    store.notice = {
      type: "error",
      message: "请先在左侧「断行源表」粘贴 Google 表格链接。",
    };
    notifyStateChanged();
    return false;
  }

  store.busy = true;
  store.progressPercent = 15;
  store.progressText = "正在检查 Google 表格工作表列表...";
  store.notice = null;
  notifyStateChanged();

  let explicitSheetId: number | undefined;
  try {
    const info = await inspectGoogleSpreadsheetTabs(rawUrl, () => hostBridge.getValidAccessToken());
    if (info.sourceCandidateTabs.length > 1) {
      store.busy = false;
      store.progressPercent = 0;
      store.progressText = "";
      notifyStateChanged();

      const picked = await promptSingleSheetSelection(
        info.spreadsheetTitle,
        info.sourceCandidateTabs,
        info.urlGid,
      );
      if (picked === null) {
        return false;
      }
      explicitSheetId = picked;
      store.busy = true;
    }
  } catch {
    // Public fallback or single sheet will be handled below
  }

  store.progressPercent = 30;
  store.progressText = "正在从 Google Sheets 读取源表格及模板结构...";
  notifyStateChanged();

  try {
    const wb = await loadSubtitleWorkbookFromGoogleUrl(rawUrl, {
      getAccessToken: () => hostBridge.getValidAccessToken(),
      fetchPublicXlsxBytes: (id) => hostBridge.fetchPublicSheetXlsxBytes(id),
      explicitSheetId,
    });

    store.lineBreak.workbook = wb;
    store.lineBreak.run = null;
    store.lineBreak.singlePausedProgress = null;
    store.lineBreak.filter = "all";

    const activeSheet = wb.sheets[wb.activeSheetName];
    const targetHeader =
      activeSheet?.headerRows[activeSheet.headerRows.length - 1]?.[
        activeSheet.columnMap.targetCol
      ] ?? "";
    const detected = detectWorkbookLang(wb.fileName, wb.activeSheetName, targetHeader);
    if (detected) {
      store.lineBreak.langCode = detected;
    }

    const rowCount = activeSheet?.rows.length ?? 0;
    store.notice = {
      type: "info",
      message: `已读取 Google 表格「${wb.fileName} · ${wb.activeSheetName}」（共 ${rowCount} 行，完整保留模板列、隐藏列与公式结构）。确认语种后点击「开始自动断行并预览」。`,
    };
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("LineBreakGoogleImport", msg);
    store.notice = { type: "error", message: msg };
    return false;
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export async function importLineBreakFile(file: File): Promise<void> {
  store.busy = true;
  store.progressPercent = 20;
  store.progressText = `正在读取本地稿件 ${file.name}...`;
  store.notice = null;
  notifyStateChanged();

  try {
    const isCsv = /\.(?:csv|tsv)$/i.test(file.name);
    const wb = isCsv
      ? parseCsvToSubtitleWorkbook(await file.text(), file.name)
      : await parseXlsxToSubtitleWorkbook(new Uint8Array(await file.arrayBuffer()), file.name);

    store.lineBreak.workbook = wb;
    store.lineBreak.run = null;
    store.lineBreak.filter = "all";

    const activeSheet = wb.sheets[wb.activeSheetName];
    const targetHeader =
      activeSheet?.headerRows[activeSheet.headerRows.length - 1]?.[
        activeSheet.columnMap.targetCol
      ] ?? "";
    const detected = detectWorkbookLang(file.name, wb.activeSheetName, targetHeader);
    if (detected) {
      store.lineBreak.langCode = detected;
    }

    const rowCount = activeSheet?.rows.length ?? 0;
    store.notice = {
      type: "info",
      message: `已载入本地稿件「${file.name}」工作表「${wb.activeSheetName}」（共 ${rowCount} 行）。核对语种后点击「开始自动断行并预览」。`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("LineBreakImport", msg);
    store.notice = { type: "error", message: `导入失败：${msg}` };
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export function switchLineBreakSheet(sheetName: string): void {
  const wb = store.lineBreak.workbook;
  if (!wb || !wb.sheets[sheetName]) return;
  wb.activeSheetName = sheetName;
  store.lineBreak.run = null;
  const activeSheet = wb.sheets[sheetName];
  const targetHeader =
    activeSheet.headerRows[activeSheet.headerRows.length - 1]?.[
      activeSheet.columnMap.targetCol
    ] ?? "";
  const detected = detectWorkbookLang(wb.fileName, sheetName, targetHeader);
  if (detected) {
    store.lineBreak.langCode = detected;
  }
  notifyStateChanged();
}

export async function executeSubtitleLineBreak(): Promise<void> {
  if (!store.lineBreak.workbook && store.lineBreak.sourceSheetUrl.trim()) {
    const ok = await importLineBreakFromGoogleUrl();
    if (!ok) return;
  }

  const wb = store.lineBreak.workbook;
  if (!wb) {
    store.notice = {
      type: "error",
      message: "请先在左侧粘贴 Google 表格链接读取，或导入本地 .xlsx / .csv 稿件。",
    };
    notifyStateChanged();
    return;
  }
  const sheet = wb.sheets[wb.activeSheetName];
  if (!sheet || sheet.rows.length === 0) {
    store.notice = { type: "error", message: "当前工作表没有可处理的数据行。" };
    notifyStateChanged();
    return;
  }

  const spec = resolveLineBreakSpec(store.lineBreak.langCode);
  const signal = beginAbortableLineBreakSession();
  store.busy = true;
  store.progressPercent = 10;
  store.progressText = `正在准备 ${spec.name} 断行规则...`;
  store.notice = null;
  notifyStateChanged();

  const ckptKey = buildSheetCheckpointKey(
    wb.sourceSpreadsheetId || wb.fileName,
    sheet.sourceSheetId ?? sheet.sheetName,
    spec.code,
  );

  try {
    let gemini: GeminiPoolClient | undefined;
    const wantsAi = store.lineBreak.useAi && store.geminiEnabled;

    if (wantsAi) {
      try {
        const plainKeys = await hostBridge.getPlainGeminiKeys();
        if (plainKeys.length > 0) {
          gemini = new GeminiPoolClient({
            apiKeys: plainKeys,
            model: store.geminiModel,
            rotation: store.geminiRotation,
          });
        }
      } catch {
        // handled by pauseOnKeyExhausted
      }
    }

    const existingCache = (await loadSheetAiCheckpoint(ckptKey)) ?? undefined;
    const strictKeyPause = wantsAi;

    const run = await runSubtitleLineBreakPipeline(sheet, spec, {
      gemini,
      useAi: strictKeyPause ? true : Boolean(gemini?.hasKeys),
      pauseOnKeyExhausted: strictKeyPause,
      cachedAiRows: existingCache,
      signal,
      onCheckpoint: async (cache, done, total) => {
        store.lineBreak.singlePausedProgress = {
          done,
          total,
          message: `已完成 ${done}/${total}`,
          isKeyError: false,
        };
        await saveSheetAiCheckpoint(ckptKey, cache);
      },
      onProgress: (done, total, text) => {
        store.progressPercent =
          total > 0 ? Math.min(95, Math.round(15 + (done / total) * 80)) : 50;
        store.progressText = text;
        notifyStateChanged();
      },
    });

    await clearSheetAiCheckpoint(ckptKey);
    store.lineBreak.singlePausedProgress = null;
    store.lineBreak.run = run;
    store.notice = {
      type: "info",
      message: `已完成「${spec.name}」断行预览：原始 ${run.totalSourceRows} 行 → 输出 ${run.totalOutputScreens} 屏（同屏 @ ${run.sameScreenAtCount} 处，分屏新增 ${run.insertedScreenRowsCount} 行，绿底免断 ${run.skippedGreenCount} 行，L列待人工核对 ${run.reviewCount} 处）。可直接在原表新建「${sheet.sheetName}_已断行」或导出 .xlsx。`,
    };
  } catch (err) {
    if (err instanceof LineBreakPausedError) {
      await saveSheetAiCheckpoint(ckptKey, err.partialAiCache);
      store.lineBreak.singlePausedProgress = {
        done: err.completedAiRows,
        total: err.totalAiRows,
        message: err.message,
        isKeyError: err.isKeyError,
      };
      store.notice = {
        type: err.isKeyError ? "error" : "info",
        message: err.message,
      };
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("LineBreakRun", msg);
    store.notice = { type: "error", message: `断行执行失败：${msg}` };
  } finally {
    endAbortableLineBreakSession();
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export async function syncLineBreakToGoogleSheet(): Promise<void> {
  const wb = store.lineBreak.workbook;
  const run = store.lineBreak.run;
  if (!wb || !run) return;
  const sheet = wb.sheets[wb.activeSheetName];
  if (!sheet) return;

  const outUrl = store.lineBreak.outputSheetUrl.trim();
  if (!outUrl && !sheet.sourceSpreadsheetId) {
    store.notice = {
      type: "error",
      message: "当前稿件来自本地文件，如需写回云端请展开填写目标 Google 表格链接，或直接点击「导出 Excel (.xlsx)」。",
    };
    notifyStateChanged();
    return;
  }

  store.busy = true;
  store.progressPercent = 35;
  store.progressText = outUrl
    ? "正在按原表模板克隆并写入指定 Google 表格..."
    : `正在写回原始表格并新建「${sheet.sheetName}_已断行」...`;
  store.notice = null;
  notifyStateChanged();

  try {
    const res = await writeLineBreakRunToGoogleSheet(
      outUrl,
      sheet,
      run,
      () => hostBridge.getValidAccessToken(),
      true,
    );
    const bQueue = store.lineBreak.batchQueue;
    const bItem = bQueue?.items.find((i) => i.id === store.lineBreak.batchInspectingItemId);
    if (bQueue && bItem && !outUrl) {
      bItem.status = "completed";
      bItem.outputSheetTitle = res.sheetTitle;
      bItem.outputSheetUrl = res.sheetUrl;
      await saveBatchQueueCheckpoint(bQueue);
      const masterStatus =
        run.reviewCount > 0
          ? `已完成（待人工核对 ${run.reviewCount} 处，见 L 列）`
          : `已完成（共 ${run.totalOutputScreens} 屏，无待核对项）`;
      await writeStatusBackToBatchMasterSheet(
        bQueue,
        bItem,
        masterStatus,
        res.sheetUrl,
        () => hostBridge.getValidAccessToken(),
      );
    }
    store.notice = {
      type: "info",
      message: `已成功写入 Google 表格工作表「${res.sheetTitle}」（共 ${run.totalOutputScreens} 屏，100% 保留原有颜色/字体/格式，L列已写入 ${run.reviewCount} 处待核对备注）。`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("LineBreakGoogleWrite", msg);
    store.notice = { type: "error", message: msg };
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

function syncEditedRunBackToBatchItem(): void {
  const wb = store.lineBreak.workbook;
  const run = store.lineBreak.run;
  const bQueue = store.lineBreak.batchQueue;
  const bItem = bQueue?.items.find((i) => i.id === store.lineBreak.batchInspectingItemId);
  if (!wb || !run || !bQueue || !bItem) return;
  const sheet = wb.sheets[wb.activeSheetName];
  bItem.cachedSheet = sheet;
  bItem.cachedRun = run;
  bItem.reviewCount = run.reviewCount;
  bItem.totalOutputScreens = run.totalOutputScreens;
  if (bItem.status === "completed") {
    bItem.status = "ready_review";
  }
  void saveBatchItemPreviewBundle(bItem.id, sheet, run);
  void saveBatchQueueCheckpoint(bQueue);
}

export function updateLineBreakScreenText(
  sourceRowIndex: number,
  screenIndex: number,
  rawNewText: string,
): void {
  const run = store.lineBreak.run;
  if (!run) return;
  const rowRes = run.results[sourceRowIndex];
  if (!rowRes || !rowRes.screens[screenIndex]) return;

  const measurer = createSubtitleMeasurer(run.langSpec);
  const cleaned =
    rowRes.status === "skip_green"
      ? rawNewText.trim()
      : rawNewText
          .replace(/\r?\n/g, " ")
          .replace(/\s*@\s*/g, "@")
          .trim();

  rowRes.screens[screenIndex] = measurer.analyzeScreen(cleaned);

  if (rowRes.status !== "skip_green" && rowRes.category !== "citation_same_screen") {
    const hasWarn = rowRes.screens.some((s) => s.exceedsSingleLimit || s.ratioOutOfBounds);
    if (hasWarn) {
      rowRes.status = "review_warning";
      rowRes.reason = "人工编辑后存在超限或比例悬殊";
      rowRes.reviewNote = "人工调整后仍超限或比例偏大，请核对";
    } else if (rowRes.screens.length > 1) {
      rowRes.status = "split_multi_screen";
      rowRes.reason = `人工微调 · 共 ${rowRes.screens.length} 屏`;
      rowRes.reviewNote = "";
    } else if (rowRes.screens[0].hasAt) {
      rowRes.status = "broken_same_screen";
      rowRes.reason = "人工微调 · 同屏双行";
      rowRes.reviewNote = "";
    } else {
      rowRes.status = "untouched";
      rowRes.reason = "单屏单行";
      rowRes.reviewNote = "";
    }
  }

  store.lineBreak.run = summarizeRun(run.sheetName, run.langSpec, run.results);
  syncEditedRunBackToBatchItem();
  notifyStateChanged();
}

export function splitScreenBelowManual(sourceRowIndex: number, screenIndex: number): void {
  const run = store.lineBreak.run;
  if (!run) return;
  const rowRes = run.results[sourceRowIndex];
  const cur = rowRes?.screens[screenIndex];
  if (!rowRes || !cur) return;

  const measurer = createSubtitleMeasurer(run.langSpec);
  const atIdx = cur.text.indexOf("@");
  let firstText = cur.text;
  let secondText = "";
  if (atIdx > 0) {
    firstText = cur.text.slice(0, atIdx).trim();
    secondText = cur.text.slice(atIdx + 1).trim();
  } else {
    const words = cur.text.split(/\s+/);
    if (words.length >= 2) {
      const mid = Math.ceil(words.length / 2);
      firstText = words.slice(0, mid).join(" ");
      secondText = words.slice(mid).join(" ");
    } else {
      const mid = Math.ceil(cur.text.length / 2);
      firstText = cur.text.slice(0, mid);
      secondText = cur.text.slice(mid);
    }
  }
  if (!secondText) return;

  rowRes.screens.splice(
    screenIndex,
    1,
    measurer.analyzeScreen(firstText),
    measurer.analyzeScreen(secondText),
  );
  rowRes.status = "split_multi_screen";
  rowRes.reason = `人工分屏 · 共 ${rowRes.screens.length} 屏`;
  rowRes.reviewNote = "";
  store.lineBreak.run = summarizeRun(run.sheetName, run.langSpec, run.results);
  syncEditedRunBackToBatchItem();
  notifyStateChanged();
}

export function mergeScreenWithPreviousManual(sourceRowIndex: number, screenIndex: number): void {
  const run = store.lineBreak.run;
  if (!run || screenIndex <= 0) return;
  const rowRes = run.results[sourceRowIndex];
  if (!rowRes || !rowRes.screens[screenIndex]) return;

  const measurer = createSubtitleMeasurer(run.langSpec);
  const prev = rowRes.screens[screenIndex - 1].text.replace(/@/g, " ").trim();
  const cur = rowRes.screens[screenIndex].text.replace(/@/g, " ").trim();
  const combined = `${prev}@${cur}`.replace(/\s*@\s*/g, "@").trim();

  rowRes.screens.splice(screenIndex - 1, 2, measurer.analyzeScreen(combined));
  rowRes.status = rowRes.screens.length > 1 ? "split_multi_screen" : "broken_same_screen";
  rowRes.reason = "人工合并分屏";
  rowRes.reviewNote = "";
  store.lineBreak.run = summarizeRun(run.sheetName, run.langSpec, run.results);
  syncEditedRunBackToBatchItem();
  notifyStateChanged();
}

export function exportLineBreakXlsx(): void {
  const wb = store.lineBreak.workbook;
  const run = store.lineBreak.run;
  if (!wb || !run) {
    store.notice = { type: "error", message: "请先执行自动断行后再导出 .xlsx 文件。" };
    notifyStateChanged();
    return;
  }
  const sheet = wb.sheets[wb.activeSheetName];
  if (!sheet) return;

  const bytes = buildLineBreakResultXlsx(sheet, run);
  const baseName = wb.fileName.replace(/\.(?:xlsx|csv|tsv)$/i, "");
  const outName = `${baseName}_已断行.xlsx`;
  triggerXlsxDownload(bytes, outName);
}

import { GeminiPoolClient } from "../ai/gemini-client";
import {
  LineBreakPausedError,
  runSubtitleLineBreakPipeline,
} from "../linebreak/ai-breaker";
import {
  loadBatchMasterQueueFromGoogleUrl,
  loadBatchMasterQueueFromXlsxBytes,
  runWithConcurrency,
  writeStatusBackToBatchMasterSheet,
} from "../linebreak/batch-master";
import {
  buildSheetCheckpointKey,
  clearSheetAiCheckpoint,
  loadBatchItemPreviewBundle,
  loadBatchQueueCheckpoint,
  loadSheetAiCheckpoint,
  saveBatchItemPreviewBundle,
  saveBatchQueueCheckpoint,
  saveSheetAiCheckpoint,
} from "../linebreak/checkpoint-store";
import {
  loadSubtitleWorkbookFromGoogleUrl,
  writeLineBreakRunToGoogleSheet,
} from "../linebreak/google-sheet-io";
import { resolveLineBreakSpec } from "../linebreak/presets";
import type { BatchLineBreakItem, BatchMasterQueue } from "../linebreak/types";
import { buildLineBreakResultXlsx } from "../linebreak/xlsx-writer";
import { hostBridge } from "../platform/bridge";
import { diagLog } from "../platform/diag-log";
import { promptBatchMultiSheetConfirmation } from "./linebreak-sheet-picker-dialog";
import { notifyStateChanged, store } from "./state";

let activeAbortController: AbortController | null = null;
let queueSaveChain: Promise<void> = Promise.resolve();
let masterStatusWriteChain: Promise<void> = Promise.resolve();

function persistQueueSerialized(queue: BatchMasterQueue): Promise<void> {
  queueSaveChain = queueSaveChain
    .then(() => saveBatchQueueCheckpoint(queue))
    .catch(() => {});
  return queueSaveChain;
}

function writeMasterStatusSerialized(
  queue: BatchMasterQueue,
  item: BatchLineBreakItem,
  statusText: string,
  resultUrl: string,
): Promise<void> {
  masterStatusWriteChain = masterStatusWriteChain
    .then(() =>
      writeStatusBackToBatchMasterSheet(
        queue,
        item,
        statusText,
        resultUrl,
        () => hostBridge.getValidAccessToken(),
      ),
    )
    .catch(() => {});
  return masterStatusWriteChain;
}

export function pauseActiveLineBreakRun(): void {
  if (activeAbortController) {
    activeAbortController.abort();
  }
}

export function beginAbortableLineBreakSession(): AbortSignal {
  activeAbortController = new AbortController();
  return activeAbortController.signal;
}

export function endAbortableLineBreakSession(): void {
  activeAbortController = null;
}

export async function restoreSavedBatchQueueOnBoot(): Promise<void> {
  const saved = await loadBatchQueueCheckpoint();
  if (saved && saved.items.length > 0 && !store.lineBreak.batchQueue) {
    // Recover any stale in-flight status from previous abrupt tab close
    for (const item of saved.items) {
      if (item.status === "running") item.status = "queued";
      if (item.status === "writing") item.status = "ready_review";
    }
    store.lineBreak.batchQueue = saved;
    if (saved.masterUrl && !store.lineBreak.masterSheetUrl) {
      store.lineBreak.masterSheetUrl = saved.masterUrl;
    }
    notifyStateChanged();
  }
}

function applyConfirmedSheetSelections(selections: Map<string, number>): void {
  const q = store.lineBreak.batchQueue;
  if (!q) return;
  for (const item of q.items) {
    const chosenId = selections.get(item.id);
    if (chosenId !== undefined) {
      item.selectedSheetId = chosenId;
      const tab = item.availableTabs.find((t) => t.sheetId === chosenId);
      if (tab) item.selectedSheetTitle = tab.title;
      item.needsSheetConfirm = false;
      if (item.status === "pending_confirm_sheet") {
        item.status = "queued";
      }
    }
  }
}

export async function importBatchMasterFromGoogleUrl(): Promise<boolean> {
  const url = store.lineBreak.masterSheetUrl.trim();
  if (!url) {
    store.notice = {
      type: "error",
      message: "请先粘贴「批量总表」Google 表格链接（A列为带语种的表格名称，B列为表格链接）。",
    };
    notifyStateChanged();
    return false;
  }

  store.busy = true;
  store.progressPercent = 20;
  store.progressText = "正在读取批量总表并检查各语种表格工作表结构...";
  store.notice = null;
  notifyStateChanged();

  try {
    const queue = await loadBatchMasterQueueFromGoogleUrl(url, {
      getAccessToken: () => hostBridge.getValidAccessToken(),
      fetchPublicXlsxBytes: (id) => hostBridge.fetchPublicSheetXlsxBytes(id),
    });

    store.lineBreak.batchQueue = queue;
    store.lineBreak.batchInspectingItemId = null;
    await persistQueueSerialized(queue);

    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();

    const multiItems = queue.items.filter((it) => it.needsSheetConfirm);
    if (multiItems.length > 0) {
      const confirmed = await promptBatchMultiSheetConfirmation(multiItems);
      if (confirmed) {
        applyConfirmedSheetSelections(confirmed);
        await persistQueueSerialized(queue);
      }
    }

    const pendingConfirmCount = queue.items.filter((it) => it.needsSheetConfirm).length;
    store.notice = {
      type: "info",
      message:
        pendingConfirmCount > 0
          ? `已读取总表共 ${queue.items.length} 个语种任务，其中 ${pendingConfirmCount} 个表格含有多个工作表，请先确认要处理的 Sheet。`
          : `已读取总表共 ${queue.items.length} 个语种任务（默认 ${store.lineBreak.batchConcurrency} 并发）。可选择「开始批量断行预览」或「批量断行并自动写入」。`,
    };
    notifyStateChanged();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("BatchMasterImport", msg);
    store.notice = { type: "error", message: msg };
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
    return false;
  }
}

export async function importBatchMasterLocalFile(file: File): Promise<void> {
  store.busy = true;
  store.progressPercent = 20;
  store.progressText = `正在解析本地批量总表 ${file.name}...`;
  store.notice = null;
  notifyStateChanged();

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const queue = await loadBatchMasterQueueFromXlsxBytes(bytes, {
      getAccessToken: () => hostBridge.getValidAccessToken(),
    });
    store.lineBreak.batchQueue = queue;
    store.lineBreak.batchInspectingItemId = null;
    await persistQueueSerialized(queue);

    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();

    const multiItems = queue.items.filter((it) => it.needsSheetConfirm);
    if (multiItems.length > 0) {
      const confirmed = await promptBatchMultiSheetConfirmation(multiItems);
      if (confirmed) {
        applyConfirmedSheetSelections(confirmed);
        await persistQueueSerialized(queue);
      }
    }

    store.notice = {
      type: "info",
      message: `已从本地总表「${file.name}」读取 ${queue.items.length} 个语种任务。可选择「开始批量断行预览」或「批量断行并自动写入」。`,
    };
    notifyStateChanged();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.notice = { type: "error", message: `读取本地总表失败：${msg}` };
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

export async function confirmPendingMultiSheetItemsInteractive(): Promise<boolean> {
  const q = store.lineBreak.batchQueue;
  if (!q) return false;
  const multiItems = q.items.filter((it) => it.needsSheetConfirm);
  if (multiItems.length === 0) return true;

  const confirmed = await promptBatchMultiSheetConfirmation(multiItems);
  if (!confirmed) return false;
  applyConfirmedSheetSelections(confirmed);
  await persistQueueSerialized(q);
  notifyStateChanged();
  return true;
}

async function buildGeminiClientIfEnabled(): Promise<GeminiPoolClient | undefined> {
  if (!store.lineBreak.useAi || !store.geminiEnabled) return undefined;
  try {
    const plainKeys = await hostBridge.getPlainGeminiKeys();
    if (plainKeys.length > 0) {
      return new GeminiPoolClient({
        apiKeys: plainKeys,
        model: store.geminiModel,
        rotation: store.geminiRotation,
        reviewModel: store.geminiReviewModel || undefined,
        paidUnlimited: store.geminiPaidUnlimited,
      });
    }
  } catch {
    // handled downstream if pauseOnKeyExhausted
  }
  return undefined;
}

/**
 * Writes a single ready batch item to its source Google Sheet (`{原Sheet名}_已断行`)
 * and updates Master Sheet C/D columns without blocking other concurrent items.
 */
async function writeSingleBatchItemInternal(
  queue: BatchMasterQueue,
  item: BatchLineBreakItem,
): Promise<boolean> {
  if (!item.cachedSheet || !item.cachedRun) {
    const bundle = await loadBatchItemPreviewBundle(item.id);
    if (bundle) {
      item.cachedSheet = bundle.sheet;
      item.cachedRun = bundle.run;
    }
  }

  if (!item.cachedSheet || !item.cachedRun) {
    item.status = "error";
    item.errorMessage = "未找到该语种预览缓存，请点击「重跑」重新生成预览";
    await persistQueueSerialized(queue);
    notifyStateChanged();
    return false;
  }

  item.status = "writing";
  item.errorMessage = undefined;
  notifyStateChanged();

  try {
    const writeRes = await writeLineBreakRunToGoogleSheet(
      "",
      item.cachedSheet,
      item.cachedRun,
      () => hostBridge.getValidAccessToken(),
      true,
    );

    item.status = "completed";
    item.errorMessage = undefined;
    item.outputSheetTitle = writeRes.sheetTitle;
    item.outputSheetUrl = writeRes.sheetUrl;

    await persistQueueSerialized(queue);

    const masterStatus =
      item.cachedRun.reviewCount > 0
        ? `已完成（待人工核对 ${item.cachedRun.reviewCount} 处，见 L 列）`
        : `已完成（共 ${item.cachedRun.totalOutputScreens} 屏，无待核对项）`;
    await writeMasterStatusSerialized(queue, item, masterStatus, writeRes.sheetUrl);
    notifyStateChanged();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("BatchWriteError", `${item.label}: ${msg}`);
    // Revert to ready_review so user can retry writing or export .xlsx!
    item.status = "ready_review";
    item.errorMessage = `写入失败：${msg}`;
    await persistQueueSerialized(queue);
    await writeMasterStatusSerialized(queue, item, `写入失败：${msg.slice(0, 80)}`, "");
    notifyStateChanged();
    return false;
  }
}

export interface ExecuteBatchOptions {
  singleTargetId?: string;
  /** When true, each language is immediately written to Google Sheets as soon as its line-breaking completes */
  autoWrite?: boolean;
}

/**
 * Multi-threaded (default 5 concurrent workers) batch runner.
 * Runs in non-blocking mode (`store.lineBreak.batchRunning`), so any already-completed language
 * can be previewed, manually adjusted, written to Google Sheets, or exported immediately
 * without waiting for the rest of the queue!
 */
export async function executeBatchLineBreakQueue(
  arg?: string | ExecuteBatchOptions,
): Promise<void> {
  const opts: ExecuteBatchOptions =
    typeof arg === "string" ? { singleTargetId: arg } : (arg ?? {});
  const singleTargetId = opts.singleTargetId;
  const autoWrite = Boolean(opts.autoWrite);

  if (!store.lineBreak.batchQueue && store.lineBreak.masterSheetUrl.trim()) {
    const ok = await importBatchMasterFromGoogleUrl();
    if (!ok) return;
  }

  const queue = store.lineBreak.batchQueue;
  if (!queue || queue.items.length === 0) {
    store.notice = { type: "error", message: "请先读取批量总表链接或导入本地总表文件。" };
    notifyStateChanged();
    return;
  }

  const unconfirmed = queue.items.filter(
    (it) => it.needsSheetConfirm && (!singleTargetId || it.id === singleTargetId),
  );
  if (unconfirmed.length > 0) {
    const ok = await confirmPendingMultiSheetItemsInteractive();
    if (!ok) {
      store.notice = {
        type: "info",
        message: "请先确认含多个工作表的语种要使用哪个 Sheet，确认后即可开始批量断行。",
      };
      notifyStateChanged();
      return;
    }
  }

  const targets = singleTargetId
    ? queue.items.filter(
        (it) => it.id === singleTargetId && it.status !== "running" && it.status !== "writing",
      )
    : queue.items.filter((it) => {
        if (it.status === "running" || it.status === "writing") return false;
        if (autoWrite) return it.status !== "completed";
        return it.status !== "ready_review" && it.status !== "completed";
      });

  if (targets.length === 0) {
    const readyCount = queue.items.filter((it) => it.status === "ready_review").length;
    store.notice = {
      type: "info",
      message:
        readyCount > 0
          ? `所有语种均已生成断行预览（共 ${readyCount} 个待写入）。核对无误后请点击「确认写入 Google 表格」。`
          : "队列中所有语种均已处理完成！如需重新断行某个语种，请点击该行「重跑」。",
    };
    notifyStateChanged();
    return;
  }

  const isManagedBatch = !singleTargetId;
  let signal: AbortSignal;
  if (isManagedBatch) {
    if (store.lineBreak.batchRunning) return;
    signal = beginAbortableLineBreakSession();
    store.lineBreak.batchRunning = true;
    store.lineBreak.batchAutoWriteRunning = autoWrite;
    store.lineBreak.batchProgressPercent = 4;
    store.lineBreak.batchProgressText = `准备启动 ${Math.min(store.lineBreak.batchConcurrency, targets.length)} 并发任务（共 ${targets.length} 个语种）...`;
    store.notice = null;
    notifyStateChanged();
  } else {
    signal = activeAbortController?.signal ?? new AbortController().signal;
  }

  const gemini = await buildGeminiClientIfEnabled();
  const requireAi = store.lineBreak.useAi && store.geminiEnabled;
  const concurrency = singleTargetId
    ? 1
    : Math.max(1, Math.min(10, store.lineBreak.batchConcurrency || 5));

  const itemFractions = new Map<string, number>();
  for (const it of targets) itemFractions.set(it.id, 0);

  let previewedCount = 0;
  let autoWrittenCount = 0;
  let keyPausedMessage: string | null = null;

  const updateBatchAggregateProgress = () => {
    if (!isManagedBatch) return;
    let sum = 0;
    for (const v of itemFractions.values()) sum += v;
    const pct = Math.min(99, Math.max(4, Math.round((sum / targets.length) * 100)));
    const activeNames = targets
      .filter((t) => t.status === "running" || t.status === "writing")
      .map((t) => `${t.label.slice(0, 10)}${t.status === "writing" ? "(写入中)" : ""}`);
    const doneNum = targets.filter(
      (t) =>
        t.status === "ready_review" ||
        t.status === "completed" ||
        t.status === "error" ||
        t.status === "paused_key",
    ).length;
    store.lineBreak.batchProgressPercent = pct;
    store.lineBreak.batchProgressText =
      activeNames.length > 0
        ? `${autoWrite ? "并行断行并自动写入" : "并行断行预览"}（${concurrency} 并发 · 完成 ${doneNum}/${targets.length}）：${activeNames.slice(0, 3).join("、")}${activeNames.length > 3 ? ` 等 ${activeNames.length} 个` : ""}`
        : `已完成 ${doneNum}/${targets.length}...`;
  };

  try {
    await runWithConcurrency(
      targets,
      concurrency,
      async (item) => {
        if (signal.aborted) return;

        // In autoWrite mode, if an item was already preview-ready, jump straight to writing!
        if (autoWrite && item.status === "ready_review") {
          itemFractions.set(item.id, 0.85);
          updateBatchAggregateProgress();
          const ok = await writeSingleBatchItemInternal(queue, item);
          if (ok) autoWrittenCount += 1;
          itemFractions.set(item.id, 1);
          updateBatchAggregateProgress();
          notifyStateChanged();
          return;
        }

        const spec = resolveLineBreakSpec(item.langCode);
        item.status = "running";
        item.errorMessage = undefined;
        itemFractions.set(item.id, 0.05);
        updateBatchAggregateProgress();
        notifyStateChanged();

        try {
          const wb = await loadSubtitleWorkbookFromGoogleUrl(item.sourceUrl, {
            getAccessToken: () => hostBridge.getValidAccessToken(),
            fetchPublicXlsxBytes: (id) => hostBridge.fetchPublicSheetXlsxBytes(id),
            explicitSheetId: item.availableTabs.length > 0 ? item.selectedSheetId : undefined,
          });

          const sheet = wb.sheets[wb.activeSheetName];
          item.selectedSheetTitle = sheet.sheetName;
          if (sheet.sourceSheetId !== undefined) {
            item.selectedSheetId = sheet.sourceSheetId;
          }
          item.cachedSheet = sheet;

          const ckptKey = buildSheetCheckpointKey(
            item.spreadsheetId || item.id,
            item.selectedSheetId,
            spec.code,
          );
          const existingCache = (await loadSheetAiCheckpoint(ckptKey)) ?? undefined;

          const run = await runSubtitleLineBreakPipeline(sheet, spec, {
            gemini,
            useAi: requireAi,
            pauseOnKeyExhausted: requireAi,
            cachedAiRows: existingCache,
            signal,
            onCheckpoint: async (cache, done, total) => {
              item.doneAiRows = done;
              item.totalAiRows = total;
              await saveSheetAiCheckpoint(ckptKey, cache);
            },
            onProgress: (done, total) => {
              item.doneAiRows = done;
              item.totalAiRows = total;
              const innerRatio = total > 0 ? done / total : 1;
              itemFractions.set(item.id, 0.1 + innerRatio * (autoWrite ? 0.72 : 0.85));
              updateBatchAggregateProgress();
              notifyStateChanged();
            },
          });

          item.cachedRun = run;
          item.reviewCount = run.reviewCount;
          item.totalOutputScreens = run.totalOutputScreens;
          item.doneAiRows = item.totalAiRows;
          item.status = "ready_review";
          previewedCount += 1;

          await clearSheetAiCheckpoint(ckptKey);
          await saveBatchItemPreviewBundle(item.id, sheet, run);
          await persistQueueSerialized(queue);

          if (autoWrite && !signal.aborted) {
            itemFractions.set(item.id, 0.88);
            updateBatchAggregateProgress();
            notifyStateChanged();
            const ok = await writeSingleBatchItemInternal(queue, item);
            if (ok) autoWrittenCount += 1;
          }

          itemFractions.set(item.id, 1);
          updateBatchAggregateProgress();
          notifyStateChanged();
        } catch (err) {
          if (err instanceof LineBreakPausedError) {
            const ckptKey = buildSheetCheckpointKey(
              item.spreadsheetId || item.id,
              item.selectedSheetId,
              spec.code,
            );
            await saveSheetAiCheckpoint(ckptKey, err.partialAiCache);
            item.doneAiRows = err.completedAiRows;
            item.totalAiRows = err.totalAiRows;
            item.status = "paused_key";
            item.errorMessage = err.message;
            await persistQueueSerialized(queue);

            if (err.isKeyError && !keyPausedMessage) {
              keyPausedMessage = `已在「${item.label}」安全保存断点（${err.completedAiRows}/${err.totalAiRows}）：${err.message}。可在「设置 → API 密钥池」补充/更换密钥后点击「继续接续处理」。`;
              if (activeAbortController && !activeAbortController.signal.aborted) {
                activeAbortController.abort();
              }
            }
            updateBatchAggregateProgress();
            notifyStateChanged();
            return;
          }

          const msg = err instanceof Error ? err.message : String(err);
          diagLog.error("BatchItemPreviewError", `${item.label}: ${msg}`);
          item.status = "error";
          item.errorMessage = msg;
          itemFractions.set(item.id, 1);
          await persistQueueSerialized(queue);
          updateBatchAggregateProgress();
          notifyStateChanged();
        }
      },
      () => signal.aborted,
    );

    if (keyPausedMessage) {
      store.notice = { type: "error", message: keyPausedMessage };
    } else if (signal.aborted && isManagedBatch) {
      store.notice = {
        type: "info",
        message: `已暂停批量任务并保存各语种当前进度（已就绪的语种可随时预览或写入，稍后可点击「继续接续处理」）。`,
      };
    } else if (isManagedBatch) {
      const readyCount = queue.items.filter((i) => i.status === "ready_review").length;
      const totalErrors = queue.items.filter((i) => i.status === "error").length;
      const totalReviews = queue.items.reduce((s, i) => s + (i.reviewCount || 0), 0);
      store.notice = {
        type: totalErrors > 0 ? "error" : "info",
        message: autoWrite
          ? `并行断行并自动写入完成：本次成功写入 ${autoWrittenCount} 个语种（累计 L 列核对备注 ${totalReviews} 处${totalErrors > 0 ? `；另有 ${totalErrors} 个异常` : ""}），总表 C/D 列状态已同步更新。`
          : `并行断行预览完成（尚未修改云端表格）：本次生成 ${previewedCount} 个语种预览，当前共 ${readyCount} 个语种待核对写入（累计 L 列核对备注 ${totalReviews} 处${totalErrors > 0 ? `；另有 ${totalErrors} 个读取异常` : ""}）。`,
      };
    }
  } finally {
    if (isManagedBatch) {
      endAbortableLineBreakSession();
      store.lineBreak.batchRunning = false;
      store.lineBreak.batchAutoWriteRunning = false;
      store.lineBreak.batchProgressPercent = 0;
      store.lineBreak.batchProgressText = "";
    }
    notifyStateChanged();
  }
}

/**
 * Stage 2 of Batch Mode: Writes reviewed `ready_review` item(s) to their original Google Sheets
 * as `{原Sheet名}_已断行` and writes status + link back to Master Sheet Col C/D!
 * Runs non-blockingly so it works EVEN WHILE other languages in the queue are still running!
 */
export async function writeConfirmedBatchItemsToGoogleSheets(
  singleTargetId?: string,
): Promise<void> {
  const queue = store.lineBreak.batchQueue;
  if (!queue) return;

  const targets = singleTargetId
    ? queue.items.filter((it) => it.id === singleTargetId && it.status !== "writing" && it.status !== "running")
    : queue.items.filter((it) => it.status === "ready_review");

  if (targets.length === 0) {
    store.notice = {
      type: "info",
      message: "当前没有处于「待确认写入」状态的语种，请先等待至少一个语种断行完成。",
    };
    notifyStateChanged();
    return;
  }

  let writtenCount = 0;
  let errorCount = 0;

  await runWithConcurrency(targets, Math.min(3, targets.length), async (item) => {
    const ok = await writeSingleBatchItemInternal(queue, item);
    if (ok) writtenCount += 1;
    else errorCount += 1;
  });

  store.notice = {
    type: errorCount > 0 ? "error" : "info",
    message:
      errorCount > 0
        ? `已成功写入 ${writtenCount} 个语种，另有 ${errorCount} 个语种写入失败（请检查是否有该原表的编辑权限，或先点「导出.xlsx」）。`
        : `已成功将 ${writtenCount} 个语种写入各自原始表格新建「_已断行」工作表，并将状态同步写回总表 C/D 列！`,
  };
  notifyStateChanged();
}

export async function inspectBatchItemInPreview(itemId: string): Promise<void> {
  const queue = store.lineBreak.batchQueue;
  const item = queue?.items.find((i) => i.id === itemId);
  if (!item) return;

  if (!item.cachedSheet) {
    const bundle = await loadBatchItemPreviewBundle(item.id);
    if (bundle) {
      item.cachedSheet = bundle.sheet;
      item.cachedRun = bundle.run;
    }
  }

  if (!item.cachedSheet) {
    store.notice = { type: "info", message: `正在载入「${item.label}」原样预览...` };
    notifyStateChanged();
    try {
      const wb = await loadSubtitleWorkbookFromGoogleUrl(item.sourceUrl, {
        getAccessToken: () => hostBridge.getValidAccessToken(),
        fetchPublicXlsxBytes: (id) => hostBridge.fetchPublicSheetXlsxBytes(id),
        explicitSheetId: item.availableTabs.length > 0 ? item.selectedSheetId : undefined,
      });
      item.cachedSheet = wb.sheets[wb.activeSheetName];
    } catch (err) {
      store.notice = {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      notifyStateChanged();
      return;
    }
  }

  const sheet = item.cachedSheet!;
  store.lineBreak.workbook = {
    fileName: item.label,
    sourceSpreadsheetId: item.spreadsheetId,
    sheetNames: [sheet.sheetName],
    activeSheetName: sheet.sheetName,
    sheets: { [sheet.sheetName]: sheet },
  };
  store.lineBreak.langCode = item.langCode;
  store.lineBreak.run = item.cachedRun ?? null;
  store.lineBreak.lastManualRowIndex = null;
  store.lineBreak.filter = "all";
  store.lineBreak.batchInspectingItemId = item.id;
  notifyStateChanged();
}

export function exportBatchItemFallbackXlsx(itemId: string): void {
  const item = store.lineBreak.batchQueue?.items.find((i) => i.id === itemId);
  if (!item?.cachedSheet || !item.cachedRun) {
    store.notice = { type: "error", message: "该语种尚未生成断行结果，请先运行断行预览。" };
    notifyStateChanged();
    return;
  }
  const bytes = buildLineBreakResultXlsx(item.cachedSheet, item.cachedRun);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${item.label}_已断行.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

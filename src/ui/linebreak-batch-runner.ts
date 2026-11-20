import { GeminiPoolClient } from "../ai/gemini-client";
import {
  LineBreakPausedError,
  runSubtitleLineBreakPipeline,
} from "../linebreak/ai-breaker";
import {
  loadBatchMasterQueueFromGoogleUrl,
  loadBatchMasterQueueFromXlsxBytes,
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
import { buildLineBreakResultXlsx } from "../linebreak/xlsx-writer";
import { hostBridge } from "../platform/bridge";
import { diagLog } from "../platform/diag-log";
import { promptBatchMultiSheetConfirmation } from "./linebreak-sheet-picker-dialog";
import { notifyStateChanged, store } from "./state";

let activeAbortController: AbortController | null = null;

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
    await saveBatchQueueCheckpoint(queue);

    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();

    const multiItems = queue.items.filter((it) => it.needsSheetConfirm);
    if (multiItems.length > 0) {
      const confirmed = await promptBatchMultiSheetConfirmation(multiItems);
      if (confirmed) {
        applyConfirmedSheetSelections(confirmed);
        await saveBatchQueueCheckpoint(queue);
      }
    }

    const pendingConfirmCount = queue.items.filter((it) => it.needsSheetConfirm).length;
    store.notice = {
      type: "info",
      message:
        pendingConfirmCount > 0
          ? `已读取总表共 ${queue.items.length} 个语种任务，其中 ${pendingConfirmCount} 个表格含有多个工作表，请先确认要处理的 Sheet。`
          : `已读取总表共 ${queue.items.length} 个语种任务。点击「开始批量断行预览（不写原表）」生成预览，核对无误后再写入表格。`,
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
    await saveBatchQueueCheckpoint(queue);

    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();

    const multiItems = queue.items.filter((it) => it.needsSheetConfirm);
    if (multiItems.length > 0) {
      const confirmed = await promptBatchMultiSheetConfirmation(multiItems);
      if (confirmed) {
        applyConfirmedSheetSelections(confirmed);
        await saveBatchQueueCheckpoint(queue);
      }
    }

    store.notice = {
      type: "info",
      message: `已从本地总表「${file.name}」读取 ${queue.items.length} 个语种任务。请先运行批量断行预览，核对无误后再写入表格。`,
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
  await saveBatchQueueCheckpoint(q);
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
      });
    }
  } catch {
    // handled downstream if pauseOnKeyExhausted
  }
  return undefined;
}

/**
 * Stage 1 of Batch Mode: Runs line-breaking & generates local preview ONLY (does NOT write to Google Sheets yet!).
 * Users can inspect/edit any language via「预览核对」, then explicitly trigger Stage 2「确认写入 Google 表格」.
 */
export async function executeBatchLineBreakQueue(singleTargetId?: string): Promise<void> {
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
        message: "请先确认含多个工作表的语种要使用哪个 Sheet，确认后即可开始批量断行预览。",
      };
      notifyStateChanged();
      return;
    }
  }

  const targets = singleTargetId
    ? queue.items.filter((it) => it.id === singleTargetId)
    : queue.items.filter((it) => it.status !== "ready_review" && it.status !== "completed");

  if (targets.length === 0) {
    const readyCount = queue.items.filter((it) => it.status === "ready_review").length;
    store.notice = {
      type: "info",
      message:
        readyCount > 0
          ? `所有语种均已生成断行预览（共 ${readyCount} 个待写入）。核对无误后请点击「确认写入 Google 表格」。`
          : "队列中所有语种均已处理并写入完成！如需重新断行某个语种，请点击该行「重跑」。",
    };
    notifyStateChanged();
    return;
  }

  const signal = beginAbortableLineBreakSession();
  store.busy = true;
  store.notice = null;
  notifyStateChanged();

  const gemini = await buildGeminiClientIfEnabled();
  const requireAi = store.lineBreak.useAi && store.geminiEnabled;
  let previewedCount = 0;

  try {
    for (let idx = 0; idx < targets.length; idx += 1) {
      const item = targets[idx];
      if (signal.aborted) break;

      const spec = resolveLineBreakSpec(item.langCode);
      item.status = "running";
      item.errorMessage = undefined;
      store.progressPercent = Math.max(5, Math.round((idx / targets.length) * 100));
      store.progressText = `[${idx + 1}/${targets.length}] 正在读取「${item.label}」(${spec.name})...`;
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
            store.progressPercent = Math.min(
              98,
              Math.round(((idx + innerRatio) / targets.length) * 100),
            );
            store.progressText = `[${idx + 1}/${targets.length}] ${item.label} (${spec.name}) AI 断行 ${done}/${total}...`;
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
        await saveBatchQueueCheckpoint(queue);
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
          await saveBatchQueueCheckpoint(queue);

          store.notice = {
            type: err.isKeyError ? "error" : "info",
            message: `已在「${item.label}」安全保存断点（${err.completedAiRows}/${err.totalAiRows}）：${err.message}。可在「设置 → API 密钥池」补充/更换密钥后点击「继续接续处理」。`,
          };
          return;
        }

        const msg = err instanceof Error ? err.message : String(err);
        diagLog.error("BatchItemPreviewError", `${item.label}: ${msg}`);
        item.status = "error";
        item.errorMessage = msg;
        await saveBatchQueueCheckpoint(queue);
        notifyStateChanged();
      }
    }

    const readyCount = queue.items.filter((i) => i.status === "ready_review").length;
    const totalErrors = queue.items.filter((i) => i.status === "error").length;
    const totalReviews = queue.items.reduce((s, i) => s + (i.reviewCount || 0), 0);
    store.notice = {
      type: totalErrors > 0 ? "error" : "info",
      message: `批量断行预览完成（尚未修改云端表格）：本次生成 ${previewedCount} 个语种预览，当前共 ${readyCount} 个语种待核对写入（累计 L 列核对备注 ${totalReviews} 处${totalErrors > 0 ? `；另有 ${totalErrors} 个读取异常` : ""}）。请点「预览核对」检查无误后，再点击「确认写入 Google 表格」。`,
    };
  } finally {
    endAbortableLineBreakSession();
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
}

/**
 * Stage 2 of Batch Mode: Writes reviewed `ready_review` item(s) to their original Google Sheets
 * as `{原Sheet名}_已断行` and writes status + link back to Master Sheet Col C/D!
 */
export async function writeConfirmedBatchItemsToGoogleSheets(
  singleTargetId?: string,
): Promise<void> {
  const queue = store.lineBreak.batchQueue;
  if (!queue) return;

  const targets = singleTargetId
    ? queue.items.filter((it) => it.id === singleTargetId)
    : queue.items.filter((it) => it.status === "ready_review");

  if (targets.length === 0) {
    store.notice = {
      type: "info",
      message: "当前没有处于「待确认写入」状态的语种，请先执行断行预览。",
    };
    notifyStateChanged();
    return;
  }

  store.busy = true;
  store.notice = null;
  notifyStateChanged();

  let writtenCount = 0;
  let errorCount = 0;

  try {
    for (let idx = 0; idx < targets.length; idx += 1) {
      const item = targets[idx];
      store.progressPercent = Math.max(10, Math.round(((idx + 0.3) / targets.length) * 100));
      store.progressText = `[${idx + 1}/${targets.length}] 正在将「${item.label}」写回原表新建 ${item.selectedSheetTitle}_已断行...`;
      notifyStateChanged();

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
        errorCount += 1;
        continue;
      }

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
        writtenCount += 1;

        await saveBatchQueueCheckpoint(queue);

        const masterStatus =
          item.cachedRun.reviewCount > 0
            ? `已完成（待人工核对 ${item.cachedRun.reviewCount} 处，见 L 列）`
            : `已完成（共 ${item.cachedRun.totalOutputScreens} 屏，无待核对项）`;
        await writeStatusBackToBatchMasterSheet(
          queue,
          item,
          masterStatus,
          writeRes.sheetUrl,
          () => hostBridge.getValidAccessToken(),
        );
        notifyStateChanged();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagLog.error("BatchWriteError", `${item.label}: ${msg}`);
        // Keep status as ready_review if cachedRun exists so user can retry after granting edit permission or export .xlsx!
        item.errorMessage = `写入失败：${msg}`;
        errorCount += 1;
        await saveBatchQueueCheckpoint(queue);
        await writeStatusBackToBatchMasterSheet(
          queue,
          item,
          `写入失败：${msg.slice(0, 80)}`,
          "",
          () => hostBridge.getValidAccessToken(),
        );
        notifyStateChanged();
      }
    }

    store.notice = {
      type: errorCount > 0 ? "error" : "info",
      message:
        errorCount > 0
          ? `已成功写入 ${writtenCount} 个语种，另有 ${errorCount} 个语种写入失败（请检查是否有该原表的编辑权限，或先点「导出.xlsx」）。`
          : `已成功将 ${writtenCount} 个语种写入各自原始表格新建「_已断行」工作表，并将状态同步写回总表 C/D 列！`,
    };
  } finally {
    store.busy = false;
    store.progressPercent = 0;
    store.progressText = "";
    notifyStateChanged();
  }
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
    store.busy = true;
    store.progressPercent = 30;
    store.progressText = `正在载入「${item.label}」原样预览...`;
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
      store.busy = false;
      store.progressPercent = 0;
      store.progressText = "";
      notifyStateChanged();
      return;
    } finally {
      store.busy = false;
      store.progressPercent = 0;
      store.progressText = "";
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

import { hostBridge } from "../platform/bridge";
import { diagLog } from "../platform/diag-log";
import { checkForUpdates, isVersionDismissed } from "../platform/updater";
import { mountAuthDialogs } from "./auth-dialogs";
import { mountCatalogConfigDialog } from "./catalog-config-dialog";
import { renderHeaderBar } from "./header-bar";
import {
  confirmPendingMultiSheetItemsInteractive,
  executeBatchLineBreakQueue,
  exportBatchItemFallbackXlsx,
  importBatchMasterFromGoogleUrl,
  importBatchMasterLocalFile,
  inspectBatchItemInPreview,
  pauseActiveLineBreakRun,
  restoreSavedBatchQueueOnBoot,
  writeConfirmedBatchItemsToGoogleSheets,
} from "./linebreak-batch-runner";
import { renderLineBreakBatchStage } from "./linebreak-batch-view";
import { renderLineBreakPanel } from "./linebreak-panel";
import { mountLineBreakRulesDialog } from "./linebreak-rules-dialog";
import {
  executeSubtitleLineBreak,
  exportLineBreakXlsx,
  importLineBreakFile,
  importLineBreakFromGoogleUrl,
  mergeScreenWithPreviousManual,
  splitScreenBelowManual,
  switchLineBreakSheet,
  syncLineBreakToGoogleSheet,
  updateLineBreakScreenText,
} from "./linebreak-runner";
import { renderLineBreakStage } from "./linebreak-stage";
import { renderPreviewStage } from "./preview-table";
import { mountRulesDialog } from "./rules-dialog";
import {
  downloadConfigTemplateXlsx,
  exportCurrentRunsXlsx,
  importLocalCsvFile,
  loadCloudSourceAndMatrix,
  refreshCloudConfigFromSheet,
  runMultiLanguageExtraction,
  syncReviewedSheetsToCloud,
} from "./runner";
import { mountSettingsDialog } from "./settings-dialog";
import { mountSourceColsDialog } from "./source-cols-dialog";
import { notifyStateChanged, store, subscribeState } from "./state";
import { renderTaskPanel } from "./task-panel";
import { openUpdateDialog } from "./update-dialog";

function installDialogLightDismissFallback(root: HTMLElement): void {
  if ("closedBy" in HTMLDialogElement.prototype) return;
  const isOutside = (e: PointerEvent, dialog: HTMLDialogElement) => {
    const r = dialog.getBoundingClientRect();
    return (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    );
  };
  root.querySelectorAll<HTMLDialogElement>('dialog[closedby="any"]').forEach((dlg) => {
    let pressedOutside = false;
    dlg.addEventListener("pointerdown", (e) => {
      pressedOutside = isOutside(e, dlg);
    });
    dlg.addEventListener("pointerup", (e) => {
      if (pressedOutside && isOutside(e, dlg)) dlg.close();
    });
  });
}

function escHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatLocalHms(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(11, 19);
  }
}

function mountLiveProcessLogInRail(railContainer: HTMLElement): void {
  const aside = railContainer.querySelector<HTMLElement>("aside.setup-rail");
  if (!aside) return;

  let panel = aside.querySelector<HTMLElement>("#live-process-log-panel");
  let wasNearBottom = true;
  let prevScrollTop = 0;
  const openDetailIndices = new Set<number>();

  if (panel) {
    const prevStream = panel.querySelector<HTMLElement>("#live-log-stream");
    if (prevStream) {
      prevScrollTop = prevStream.scrollTop;
      wasNearBottom =
        prevStream.scrollHeight - prevStream.scrollTop - prevStream.clientHeight <= 36;
      prevStream.querySelectorAll<HTMLDetailsElement>("details[data-log-idx]").forEach((det) => {
        if (det.open) openDetailIndices.add(Number(det.dataset.logIdx));
      });
    }
  } else {
    panel = document.createElement("section");
    panel.id = "live-process-log-panel";
    panel.className = "live-log-panel";
    panel.setAttribute("aria-label", "运行过程日志");
    aside.append(panel);
  }

  const entries = diagLog.getEntries();
  const itemsHtml =
    entries.length === 0
      ? `<div class="live-log-empty">点击上方「开始提取」后，此处将实时显示单篇定位、AI 换 Key 分句与双语核对过程。</div>`
      : entries
          .map((entry, idx) => {
            const lvlCls =
              entry.level === "ERROR"
                ? "live-log-lvl-error"
                : entry.level === "WARN"
                  ? "live-log-lvl-warn"
                  : "live-log-lvl-info";
            const isOpen = openDetailIndices.has(idx) ? " open" : "";
            const detailHtml = entry.detail
              ? `<details class="live-log-detail" data-log-idx="${idx}"${isOpen}><summary>查看比对详情</summary><pre>${escHtml(entry.detail)}</pre></details>`
              : "";
            return `
              <div class="live-log-item">
                <div class="live-log-line">
                  <span class="live-log-time">${escHtml(formatLocalHms(entry.time))}</span>
                  <span class="live-log-lvl ${lvlCls}">${escHtml(entry.level)}</span>
                  <span class="live-log-msg"><span class="live-log-mod">[${escHtml(entry.module)}]</span>${escHtml(entry.message)}</span>
                </div>
                ${detailHtml}
              </div>
            `;
          })
          .join("");

  panel.innerHTML = `
    <div class="live-log-header">
      <div class="live-log-title-wrap">
        <span class="live-log-title">运行过程日志</span>
        <span class="settings-status-pill pill-muted">${entries.length}</span>
      </div>
      <div class="live-log-actions">
        <button type="button" id="btn-live-log-copy" class="seg-option" ${entries.length === 0 ? "disabled" : ""}>复制</button>
        <button type="button" id="btn-live-log-export" class="seg-option" ${entries.length === 0 ? "disabled" : ""}>导出</button>
        <button type="button" id="btn-live-log-clear" class="seg-option" ${entries.length === 0 ? "disabled" : ""}>清空</button>
      </div>
    </div>
    <div id="live-log-stream" class="live-log-stream" role="log" aria-live="polite">
      ${itemsHtml}
    </div>
  `;

  const stream = panel.querySelector<HTMLElement>("#live-log-stream");
  if (stream) {
    if (wasNearBottom) {
      stream.scrollTop = stream.scrollHeight;
    } else {
      stream.scrollTop = prevScrollTop;
    }
  }

  const copyBtn = panel.querySelector<HTMLButtonElement>("#btn-live-log-copy");
  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diagLog.exportText());
      copyBtn.textContent = "已复制";
      setTimeout(() => {
        if (copyBtn.isConnected) copyBtn.textContent = "复制";
      }, 1500);
    } catch {
      diagLog.downloadLogFile();
    }
  });

  panel
    .querySelector("#btn-live-log-export")
    ?.addEventListener("click", () => diagLog.downloadLogFile());

  panel
    .querySelector("#btn-live-log-clear")
    ?.addEventListener("click", () => diagLog.clear());
}

export async function mountWorkbenchApp(appRoot: HTMLElement): Promise<void> {
  hostBridge.initSessionToken();

  document.documentElement.dataset.theme =
    store.settings.themeMode === "system" ? "" : store.settings.themeMode;

  const initIsExtract = store.activeMainTab === "extract";

  appRoot.innerHTML = `
    <div class="app-shell">
      <div id="slot-header"></div>
      <div id="slot-mobile-jump"></div>
      <div class="workbench-tabpanel-host">
        <div
          id="panel-main-extract"
          role="tabpanel"
          aria-labelledby="tab-main-extract"
          ${initIsExtract ? "" : "hidden"}
        >
          <div class="workbench-grid">
            <div id="slot-rail"></div>
            <div id="slot-stage"></div>
          </div>
        </div>
        <div
          id="panel-main-linebreak"
          role="tabpanel"
          aria-labelledby="tab-main-linebreak"
          ${initIsExtract ? "hidden" : ""}
        >
          <div class="workbench-grid">
            <div id="slot-lb-rail"></div>
            <div id="slot-lb-stage"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const slotHeader = appRoot.querySelector<HTMLElement>("#slot-header")!;
  const slotJump = appRoot.querySelector<HTMLElement>("#slot-mobile-jump")!;
  const panelExtract = appRoot.querySelector<HTMLElement>("#panel-main-extract")!;
  const panelLineBreak = appRoot.querySelector<HTMLElement>("#panel-main-linebreak")!;
  const slotRail = appRoot.querySelector<HTMLElement>("#slot-rail")!;
  const slotStage = appRoot.querySelector<HTMLElement>("#slot-stage")!;
  const slotLbRail = appRoot.querySelector<HTMLElement>("#slot-lb-rail")!;
  const slotLbStage = appRoot.querySelector<HTMLElement>("#slot-lb-stage")!;

  const { openOAuthDialog, openGeminiDialog } = mountAuthDialogs(appRoot);
  const { openRulesDialog } = mountRulesDialog(appRoot);
  const { openLineBreakRulesDialog } = mountLineBreakRulesDialog(appRoot);
  const { openSourceColsDialog } = mountSourceColsDialog(appRoot);
  const { openCatalogConfigDialog } = mountCatalogConfigDialog(appRoot, {
    onDownloadTemplateXlsx: downloadConfigTemplateXlsx,
  });
  const { openSettingsDialog } = mountSettingsDialog(appRoot, {
    openOAuthDialog,
    openGeminiDialog,
    openCatalogConfigDialog: () => openCatalogConfigDialog("spec"),
    openRulesDialog,
    openLineBreakRulesDialog: () => openLineBreakRulesDialog(),
  });

  installDialogLightDismissFallback(appRoot);

  const renderAll = () => {
    renderHeaderBar(slotHeader, { openSettingsDialog });

    const isExtract = store.activeMainTab === "extract";
    panelExtract.hidden = !isExtract;
    panelLineBreak.hidden = isExtract;

    if (isExtract) {
      if (store.scriptDoc) {
        slotJump.innerHTML = `
          <div class="mobile-jump-bar">
            <span>已载入剧本：${store.scriptDoc.title}</span>
            <a href="#inspector-main" class="version-link">跳至结果检视表 ↓</a>
          </div>
        `;
      } else {
        slotJump.innerHTML = "";
      }
      renderTaskPanel(slotRail, {
        onRefreshCloudConfig: () => void refreshCloudConfigFromSheet(),
        onDownloadConfigTemplate: downloadConfigTemplateXlsx,
        onOpenSourceColsDialog: openSourceColsDialog,
        onOpenCatalogConfigDialog: () => openCatalogConfigDialog("per-lang"),
        onLoadCloudPreview: () => void loadCloudSourceAndMatrix(),
        onImportLocalCsv: (file) => void importLocalCsvFile(file),
        onRunExtraction: () =>
          void (async () => {
            await runMultiLanguageExtraction();
            let safetyBlankRows = 0;
            let quotaBlankRows = 0;
            for (const run of store.runsByLang.values()) {
              for (const r of run.rows) {
                if (
                  r.status === "missing" &&
                  /已留空|额度|AI\s*密钥|未配置\s*AI|双语核对/i.test(r.hint || "")
                ) {
                  safetyBlankRows += 1;
                  if (/额度|AI\s*密钥|未配置\s*AI|耗尽|不可用/i.test(r.hint || "")) {
                    quotaBlankRows += 1;
                  }
                }
              }
            }
            if (safetyBlankRows > 0 && store.notice) {
              const reasonText =
                quotaBlankRows > 0
                  ? `其中 ${safetyBlankRows} 行因无可用 AI 密钥、今日额度用尽或未通过双语核对已安全留空（宁缺毋滥，绝不强制乱填），请点击右上角「设置 → API 密钥池」检测/补充可用 AIza 密钥后重跑。`
                  : `其中 ${safetyBlankRows} 行因跨行分句未通过双语核对已安全留空（宁缺毋滥，未强制乱填），可在「未找到」筛选标签中人工核对。`;
              if (!store.notice.message.includes("已安全留空")) {
                store.notice = {
                  type: quotaBlankRows > 0 ? "error" : store.notice.type,
                  message: `${store.notice.message} ${reasonText}`,
                };
              }
            }
            notifyStateChanged();
          })(),
        onSyncReviewedCloud: () => void syncReviewedSheetsToCloud(),
        onExportXlsx: exportCurrentRunsXlsx,
      });
      mountLiveProcessLogInRail(slotRail);
      renderPreviewStage(slotStage);
    } else {
      if (store.lineBreak.workbook) {
        slotJump.innerHTML = `
          <div class="mobile-jump-bar">
            <span>已载入断行稿：${store.lineBreak.workbook.fileName}</span>
            <a href="#linebreak-inspector" class="version-link">跳至断行检视表 ↓</a>
          </div>
        `;
      } else {
        slotJump.innerHTML = "";
      }
      renderLineBreakPanel(slotLbRail, {
        onLoadGoogleSheet: () => void importLineBreakFromGoogleUrl(),
        onImportFile: (file) => void importLineBreakFile(file),
        onSwitchSheet: switchLineBreakSheet,
        onRunLineBreak: () => void executeSubtitleLineBreak(),
        onPauseRun: pauseActiveLineBreakRun,
        onSyncGoogleSheet: () => void syncLineBreakToGoogleSheet(),
        onExportXlsx: exportLineBreakXlsx,
        onLoadBatchMaster: () => void importBatchMasterFromGoogleUrl(),
        onImportBatchMasterFile: (file) => void importBatchMasterLocalFile(file),
        onRunBatchAll: () => void executeBatchLineBreakQueue({ autoWrite: false }),
        onRunBatchAutoWrite: () => void executeBatchLineBreakQueue({ autoWrite: true }),
        onWriteBatchAll: () => void writeConfirmedBatchItemsToGoogleSheets(),
        onOpenSettings: openSettingsDialog,
        onOpenGeminiDialog: openGeminiDialog,
        onOpenLineBreakRules: () => openLineBreakRulesDialog(),
      });

      const showBatchQueueView =
        store.lineBreak.mode === "batch" && !store.lineBreak.batchInspectingItemId;

      if (showBatchQueueView) {
        renderLineBreakBatchStage(slotLbStage, {
          onLoadBatchMaster: () => void importBatchMasterFromGoogleUrl(),
          onConfirmMultiSheets: () => void confirmPendingMultiSheetItemsInteractive(),
          onRunBatchAll: () => void executeBatchLineBreakQueue({ autoWrite: false }),
          onRunSingleItem: (itemId) => void executeBatchLineBreakQueue({ singleTargetId: itemId }),
          onWriteBatchAll: () => void writeConfirmedBatchItemsToGoogleSheets(),
          onWriteSingleItem: (itemId) => void writeConfirmedBatchItemsToGoogleSheets(itemId),
          onInspectItem: (itemId) => void inspectBatchItemInPreview(itemId),
          onExportItemXlsx: exportBatchItemFallbackXlsx,
          onOpenGeminiSettings: openGeminiDialog,
        });
      } else {
        renderLineBreakStage(slotLbStage, {
          onEditScreenText: updateLineBreakScreenText,
          onSplitScreen: splitScreenBelowManual,
          onMergeScreen: mergeScreenWithPreviousManual,
          onResumeSingle: () => void executeSubtitleLineBreak(),
          onOpenGeminiSettings: openGeminiDialog,
          onWriteInspectingBatchItem: (itemId) =>
            void writeConfirmedBatchItemsToGoogleSheets(itemId),
        });
      }
    }
  };

  subscribeState(renderAll);
  diagLog.subscribe(() => {
    if (store.activeMainTab === "extract") {
      mountLiveProcessLogInRail(slotRail);
    }
  });
  renderAll();
  void restoreSavedBatchQueueOnBoot();

  try {
    const [auth, gemini] = await Promise.all([
      hostBridge.getAuthStatus(),
      hostBridge.getGeminiKeySummary(),
    ]);
    store.auth = auth;
    store.geminiSummary = gemini;
    notifyStateChanged();
  } catch {
    // Static mode remains usable for local CSV/XLSX inspection
  }

  // Silent background check for newer GitHub releases
  setTimeout(() => {
    void checkForUpdates()
      .then((res) => {
        if (res.hasUpdate) {
          store.availableUpdate = res;
          notifyStateChanged();
          if (!isVersionDismissed(res.latestVersion)) {
            openUpdateDialog(res);
          }
        }
      })
      .catch(() => {
        // Offline or private repo: stay quiet on startup
      });
  }, 1500);
}

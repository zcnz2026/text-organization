import { hostBridge } from "../platform/bridge";
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
        onRunExtraction: () => void runMultiLanguageExtraction(),
        onSyncReviewedCloud: () => void syncReviewedSheetsToCloud(),
        onExportXlsx: exportCurrentRunsXlsx,
      });
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
        onRunBatchAll: () => void executeBatchLineBreakQueue(),
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
          onRunBatchAll: () => void executeBatchLineBreakQueue(),
          onRunSingleItem: (itemId) => void executeBatchLineBreakQueue(itemId),
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
        });
      }
    }
  };

  subscribeState(renderAll);
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

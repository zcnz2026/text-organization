import { hostBridge } from "../platform/bridge";
import { mountAuthDialogs } from "./auth-dialogs";
import { renderHeaderBar } from "./header-bar";
import { renderPreviewStage } from "./preview-table";
import { mountRulesDialog } from "./rules-dialog";
import {
  exportCurrentRunsXlsx,
  importLocalCsvFile,
  loadCloudSourceAndMatrix,
  loadSampleDemo,
  runMultiLanguageExtraction,
  syncReviewedSheetsToCloud,
} from "./runner";
import { notifyStateChanged, store, subscribeState } from "./state";
import { renderTaskPanel } from "./task-panel";

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

  appRoot.innerHTML = `
    <div class="app-shell">
      <div id="slot-header"></div>
      <div id="slot-mobile-jump"></div>
      <div class="workbench-grid">
        <div id="slot-rail"></div>
        <div id="slot-stage"></div>
      </div>
    </div>
  `;

  const slotHeader = appRoot.querySelector<HTMLElement>("#slot-header")!;
  const slotJump = appRoot.querySelector<HTMLElement>("#slot-mobile-jump")!;
  const slotRail = appRoot.querySelector<HTMLElement>("#slot-rail")!;
  const slotStage = appRoot.querySelector<HTMLElement>("#slot-stage")!;

  const { openOAuthDialog, openGeminiDialog } = mountAuthDialogs(appRoot);
  const { openRulesDialog } = mountRulesDialog(appRoot);
  installDialogLightDismissFallback(appRoot);

  const renderAll = () => {
    renderHeaderBar(slotHeader, {
      openOAuthDialog,
      openGeminiDialog,
      openRulesDialog,
    });
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
      onLoadCloudPreview: () => void loadCloudSourceAndMatrix(),
      onImportLocalCsv: (file) => void importLocalCsvFile(file),
      onRunExtraction: () => void runMultiLanguageExtraction(),
      onSyncReviewedCloud: () => void syncReviewedSheetsToCloud(),
      onExportXlsx: exportCurrentRunsXlsx,
    });
    renderPreviewStage(slotStage, {
      onLoadSampleDemo: () => void loadSampleDemo(),
    });
  };

  subscribeState(renderAll);
  renderAll();

  try {
    const [auth, gemini] = await Promise.all([
      hostBridge.getAuthStatus(),
      hostBridge.getGeminiKeySummary(),
    ]);
    store.auth = auth;
    store.geminiSummary = gemini;
    notifyStateChanged();
  } catch {
    // Static mode remains usable for local CSV and demo inspection
  }
}

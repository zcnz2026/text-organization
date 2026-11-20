import { APP_VERSION } from "../platform/version";
import { icons } from "./icons";
import { type MainWorkbenchTab, notifyStateChanged, store } from "./state";
import { openUpdateDialog } from "./update-dialog";

export function renderHeaderBar(
  container: HTMLElement,
  actions: {
    openSettingsDialog: () => void;
  },
): void {
  const oauthConnected = store.auth.authorized;
  const hasKeys = store.geminiSummary.count > 0;
  const activeTab = store.activeMainTab;

  const oauthDotClass = oauthConnected
    ? "status-dot-ok"
    : store.auth.hasClientJson
      ? "status-dot-warn"
      : "status-dot-muted";
  const keyDotClass = hasKeys ? "status-dot-ok" : "status-dot-muted";

  const settingsTooltip = [
    oauthConnected
      ? `Google 已授权 (${store.auth.email || "已连接"})`
      : "Google OAuth 未授权",
    hasKeys
      ? `API 密钥池 (${store.geminiSummary.count} 个)`
      : "API 密钥池未配置",
    "点击打开全局设置与规则库",
  ].join(" · ");

  container.innerHTML = `
    <header class="topbar">
      <div class="brand-group">
        <img src="/app-icon.svg" alt="" class="brand-logo" width="24" height="24" />
        <h1 class="brand-title">文字整理工具</h1>
        <button
          type="button"
          id="btn-check-update"
          class="seg-option"
          title="点击检查 GitHub 最新版本"
        >${store.availableUpdate?.hasUpdate ? `发现新版本 v${esc(store.availableUpdate.latestVersion)}` : `v${esc(APP_VERSION)} · 检查更新`}</button>
      </div>

      <div
        class="tablist-scroller main-tablist"
        role="tablist"
        focusgroup="tablist nomemory"
        aria-label="主功能工作台"
      >
        <button
          type="button"
          role="tab"
          id="tab-main-extract"
          class="tab-btn main-tab-btn"
          data-main-tab="extract"
          aria-selected="${activeTab === "extract"}"
          tabindex="${activeTab === "extract" ? "0" : "-1"}"
          ${activeTab === "extract" ? "focusgroupstart" : ""}
        >
          ${icons.tableGrid}
          <span>剧本摘录整理</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-main-linebreak"
          class="tab-btn main-tab-btn"
          data-main-tab="linebreak"
          aria-selected="${activeTab === "linebreak"}"
          tabindex="${activeTab === "linebreak" ? "0" : "-1"}"
          ${activeTab === "linebreak" ? "focusgroupstart" : ""}
        >
          ${icons.subtitles}
          <span>字幕断行</span>
        </button>
      </div>

      <div class="topbar-actions">
        <button
          type="button"
          id="btn-open-settings"
          class="btn btn-settings-trigger"
          title="${esc(settingsTooltip)}"
        >
          ${icons.settings}
          <span>设置</span>
          <span class="settings-dots" aria-hidden="true">
            <span class="status-dot ${oauthDotClass}"></span>
            <span class="status-dot ${keyDotClass}"></span>
          </span>
        </button>
      </div>
    </header>
  `;

  container
    .querySelector("#btn-check-update")
    ?.addEventListener("click", () => openUpdateDialog(store.availableUpdate));

  container
    .querySelector("#btn-open-settings")
    ?.addEventListener("click", actions.openSettingsDialog);

  const tabBtns = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-main-tab]"),
  );

  const activateTab = (nextTab: MainWorkbenchTab, focusAfter = false) => {
    if (store.activeMainTab === nextTab) return;
    store.activeMainTab = nextTab;
    store.notice = null;
    notifyStateChanged();
    if (focusAfter) {
      const targetBtn = document.querySelector<HTMLButtonElement>(
        `[data-main-tab="${nextTab}"]`,
      );
      targetBtn?.focus();
      targetBtn?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  tabBtns.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.mainTab as MainWorkbenchTab;
      activateTab(tab, false);
      btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    btn.addEventListener("keydown", (e) => {
      let nextIdx = -1;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabBtns.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabBtns.length) % tabBtns.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabBtns.length - 1;
      if (nextIdx >= 0) {
        e.preventDefault();
        const nextTab = tabBtns[nextIdx].dataset.mainTab as MainWorkbenchTab;
        activateTab(nextTab, true);
      }
    });
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

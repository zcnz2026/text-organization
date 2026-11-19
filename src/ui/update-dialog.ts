import {
  checkForUpdates,
  dismissUpdateVersion,
  type UpdateCheckResult,
} from "../platform/updater";
import { APP_VERSION, RELEASES_URL } from "../platform/version";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function openUpdateDialog(prefetched?: UpdateCheckResult | null): void {
  let dlg = document.querySelector<HTMLDialogElement>("#dlg-app-update");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-app-update";
    dlg.setAttribute("closedby", "any");
    document.body.append(dlg);
  }

  const render = (state: {
    loading?: boolean;
    error?: string;
    result?: UpdateCheckResult | null;
  }) => {
    const res = state.result;
    let bodyHtml = "";
    if (state.loading) {
      bodyHtml = `<div class="notice-bar notice-info" style="border-radius:8px">正在连接 GitHub 检查最新版本（当前版本 v${esc(APP_VERSION)}）...</div>`;
    } else if (state.error) {
      bodyHtml = `<div class="notice-bar notice-error" style="border-radius:8px">${esc(state.error)}</div><p class="field-hint">当前版本：v${esc(APP_VERSION)}。您也可以手动访问 GitHub Releases 页面查看新版本。</p>`;
    } else if (res?.hasUpdate) {
      bodyHtml = `
        <div class="notice-bar notice-info" style="border-radius:8px">
          发现新版本 <strong>v${esc(res.latestVersion)}</strong>（当前版本 v${esc(res.currentVersion)}）！
        </div>
        ${
          res.releaseNotes
            ? `<div class="field-group"><span class="field-label">更新说明</span><pre style="margin:0;padding:0.65rem;border-radius:6px;background:var(--bg-subtle);border:1px solid var(--border-subtle);white-space:pre-wrap;max-block-size:220px;overflow-y:auto;font-family:inherit;font-size:var(--text-xs)">${esc(res.releaseNotes)}</pre></div>`
            : `<p class="field-hint">新版本已发布，包含最新功能与修复，建议前往下载对应系统的安装包（Windows / macOS）。</p>`
        }`;
    } else {
      bodyHtml = `
        <div class="notice-bar notice-info" style="border-radius:8px">
          当前已是最新版本 <strong>v${esc(res?.currentVersion || APP_VERSION)}</strong>，无需更新。
        </div>`;
    }

    dlg!.innerHTML = `
      <div class="dialog-header">
        <h2 class="dialog-title">软件版本与自动更新</h2>
        <button type="button" class="seg-option" data-close-upd aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">${bodyHtml}</div>
      <div class="dialog-footer">
        ${
          res?.hasUpdate
            ? `<button type="button" id="btn-upd-later" class="btn">暂不提醒此版本</button>
               <a href="${esc(res.releaseUrl || RELEASES_URL)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">${icons.download}<span>前往下载 v${esc(res.latestVersion)}</span></a>`
            : `<button type="button" id="btn-upd-recheck" class="btn" ${state.loading ? "disabled" : ""}>重新检查</button>
               <button type="button" class="btn btn-primary" data-close-upd>关闭</button>`
        }
      </div>
    `;

    dlg!.querySelectorAll("[data-close-upd]").forEach((b) =>
      b.addEventListener("click", () => dlg?.close()),
    );
    dlg!.querySelector("#btn-upd-later")?.addEventListener("click", () => {
      if (res?.latestVersion) dismissUpdateVersion(res.latestVersion);
      dlg?.close();
    });
    dlg!.querySelector("#btn-upd-recheck")?.addEventListener("click", () => {
      void runCheck();
    });
  };

  const runCheck = async () => {
    render({ loading: true });
    try {
      const result = await checkForUpdates();
      store.availableUpdate = result.hasUpdate ? result : null;
      notifyStateChanged();
      render({ result });
    } catch (err) {
      render({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (prefetched) {
    render({ result: prefetched });
  } else {
    void runCheck();
  }
  if (!dlg.open) dlg.showModal();
}

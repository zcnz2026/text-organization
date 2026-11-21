import {
  checkForUpdates,
  dismissUpdateVersion,
  type InAppUpdateProgress,
  installPendingInAppUpdate,
  type UpdateCheckResult,
} from "../platform/updater";
import { APP_VERSION, RELEASES_URL } from "../platform/version";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function formatBytesMb(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function openUpdateDialog(prefetched?: UpdateCheckResult | null): void {
  let dlg = document.querySelector<HTMLDialogElement>("#dlg-app-update");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-app-update";
    dlg.setAttribute("closedby", "any");
    document.body.append(dlg);
  }

  let currentResult: UpdateCheckResult | null = prefetched ?? null;

  const render = (state: {
    loading?: boolean;
    installing?: boolean;
    progress?: InAppUpdateProgress | null;
    error?: string;
    result?: UpdateCheckResult | null;
  }) => {
    const res = state.result ?? currentResult;
    if (state.result !== undefined) currentResult = state.result;

    let bodyHtml = "";
    if (state.loading) {
      bodyHtml = `<div class="notice-bar notice-info" style="border-radius:8px">正在连接官方 HTTPS 更新源检查签名版本（当前版本 v${esc(APP_VERSION)}）...</div>`;
    } else if (state.installing) {
      const p = state.progress;
      const pct = p?.percent ?? 0;
      const phaseText =
        p?.phase === "relaunching"
          ? "数字签名校验通过，正在自动重启应用至新版本..."
          : p?.phase === "verifying_and_installing"
            ? "下载完成，正在执行 Ed25519 数字签名校验并静默安装..."
            : p && p.totalBytes > 0
              ? `正在安全下载更新包 v${esc(res?.latestVersion || "")}：${pct}%（${formatBytesMb(p.downloadedBytes)} / ${formatBytesMb(p.totalBytes)}）`
              : `正在安全下载更新包 v${esc(res?.latestVersion || "")}...`;

      bodyHtml = `
        <div class="notice-bar notice-info" style="border-radius:8px">
          ${esc(phaseText)}
        </div>
        <div style="margin-block:0.55rem">
          <div style="height:8px;border-radius:999px;background:var(--bg-subtle);border:1px solid var(--border-subtle);overflow:hidden">
            <div style="height:100%;width:${Math.max(4, Math.min(100, pct))}%;background:var(--accent);transition:width 180ms ease"></div>
          </div>
        </div>
        <p class="field-hint">
          安全保障：安装前将使用内置公钥强制校验 Ed25519 数字签名，若文件被篡改将自动拒绝安装；本机 Google 授权与 API 密钥池存储在系统钥匙串中，更新后无损保留。
        </p>`;
    } else if (state.error) {
      bodyHtml = `
        <div class="notice-bar notice-error" style="border-radius:8px">${esc(state.error)}</div>
        <p class="field-hint">当前版本：v${esc(APP_VERSION)}。您可点击「重新检查」，或使用下方备用链接前往 GitHub Releases 手动下载。</p>`;
    } else if (res?.hasUpdate) {
      bodyHtml = `
        <div class="notice-bar notice-info" style="border-radius:8px">
          发现新版本 <strong>v${esc(res.latestVersion)}</strong>（当前版本 v${esc(res.currentVersion)}）！
        </div>
        <div style="display:flex;align-items:center;gap:0.45rem;font-size:var(--text-xs);color:var(--status-ok-fg);background:var(--status-ok-bg);padding:0.45rem 0.65rem;border-radius:6px">
          ${icons.shieldCheck}
          <span>安全更新保障：HTTPS 官方源 + Ed25519 强制数字签名验签，更新后自动保留本机授权、密钥池与全部自定义规则。</span>
        </div>
        ${
          res.releaseNotes
            ? `<div class="field-group"><span class="field-label">更新说明</span><pre style="margin:0;padding:0.65rem;border-radius:6px;background:var(--bg-subtle);border:1px solid var(--border-subtle);white-space:pre-wrap;max-block-size:200px;overflow-y:auto;font-family:inherit;font-size:var(--text-xs)">${esc(res.releaseNotes)}</pre></div>`
            : `<p class="field-hint">新版本已发布，包含最新准确性修复与功能升级。</p>`
        }
        ${
          !res.canInstallInApp
            ? `<p class="field-hint">提示：当前为浏览器预览模式或云端签名更新清单仍在构建中，暂需手动下载安装；桌面版就绪后可直接一键应用内更新。</p>`
            : ""
        }`;
    } else {
      bodyHtml = `
        <div class="notice-bar notice-info" style="border-radius:8px">
          当前已是最新版本 <strong>v${esc(res?.currentVersion || APP_VERSION)}</strong>，无需更新。
        </div>
        <p class="field-hint">已启用安全应用内自动更新（Ed25519 数字签名校验），后续发布新版本时可直接一键原地升级并自动重启。</p>`;
    }

    let footerHtml = "";
    if (state.installing) {
      footerHtml = `<button type="button" class="btn btn-primary" disabled>正在安全更新，请勿关闭窗口...</button>`;
    } else if (res?.hasUpdate) {
      footerHtml = res.canInstallInApp
        ? `<button type="button" id="btn-upd-later" class="btn">暂不提醒此版本</button>
           <a href="${esc(res.releaseUrl || RELEASES_URL)}" target="_blank" rel="noopener noreferrer" class="btn">手动下载</a>
           <button type="button" id="btn-upd-install-now" class="btn btn-primary" autofocus>${icons.download}<span>立即安全更新至 v${esc(res.latestVersion)}</span></button>`
        : `<button type="button" id="btn-upd-later" class="btn">暂不提醒此版本</button>
           <button type="button" id="btn-upd-recheck" class="btn">重新检查</button>
           <a href="${esc(res.releaseUrl || RELEASES_URL)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">${icons.download}<span>前往下载 v${esc(res.latestVersion)}</span></a>`;
    } else {
      footerHtml = `<button type="button" id="btn-upd-recheck" class="btn" ${state.loading ? "disabled" : ""}>重新检查</button>
        <button type="button" class="btn btn-primary" data-close-upd>关闭</button>`;
    }

    dlg!.innerHTML = `
      <div class="dialog-header">
        <h2 class="dialog-title">软件版本与安全自动更新</h2>
        <button type="button" class="seg-option" data-close-upd aria-label="关闭窗口" ${state.installing ? "disabled" : ""}>${icons.close}</button>
      </div>
      <div class="dialog-body">${bodyHtml}</div>
      <div class="dialog-footer">${footerHtml}</div>
    `;

    dlg!.querySelectorAll("[data-close-upd]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!state.installing) dlg?.close();
      }),
    );
    dlg!.querySelector("#btn-upd-later")?.addEventListener("click", () => {
      if (res?.latestVersion) dismissUpdateVersion(res.latestVersion);
      dlg?.close();
    });
    dlg!.querySelector("#btn-upd-recheck")?.addEventListener("click", () => {
      void runCheck();
    });
    dlg!.querySelector("#btn-upd-install-now")?.addEventListener("click", () => {
      void runInAppInstall();
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

  const runInAppInstall = async () => {
    render({
      installing: true,
      progress: { phase: "downloading", downloadedBytes: 0, totalBytes: 0, percent: 0 },
    });
    try {
      await installPendingInAppUpdate((progress) => {
        render({ installing: true, progress });
      });
    } catch (err) {
      render({
        installing: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (prefetched) {
    render({ result: prefetched });
  } else {
    void runCheck();
  }
  if (!dlg.open) dlg.showModal();
}

import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { diagLog } from "./diag-log";
import { APP_VERSION, RELEASES_URL, REPO_NAME, REPO_OWNER } from "./version";

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string;
  /** True when native Tauri v2 signed updater found a verified package ready for 1-click install */
  canInstallInApp: boolean;
}

export interface InAppUpdateProgress {
  phase: "downloading" | "verifying_and_installing" | "relaunching";
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
}

const DISMISSED_VERSION_KEY = "script_lang_dismissed_update_v1";

let pendingNativeUpdate: Update | null = null;

function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function clearPendingNativeUpdate(): Promise<void> {
  if (!pendingNativeUpdate) return;
  const old = pendingNativeUpdate;
  pendingNativeUpdate = null;
  try {
    await old.close();
  } catch {
    // ignore cleanup error
  }
}

function normalizeVer(v: string): number[] {
  return (v || "")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((p) => Number.parseInt(p.replace(/[^\d].*$/, ""), 10) || 0);
}

export function isNewerVersion(remote: string, current: string): boolean {
  const a = normalizeVer(remote);
  const b = normalizeVer(current);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

export function isVersionDismissed(ver: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_VERSION_KEY) === ver;
  } catch {
    return false;
  }
}

export function dismissUpdateVersion(ver: string): void {
  try {
    localStorage.setItem(DISMISSED_VERSION_KEY, ver);
  } catch {
    // ignore
  }
}

export function hasPendingInAppUpdate(): boolean {
  return pendingNativeUpdate !== null;
}

async function checkViaGitHubApi(): Promise<UpdateCheckResult> {
  const apiBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
  try {
    const resp = await globalThis.fetch(`${apiBase}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
        published_at?: string;
      };
      const latest = (data.tag_name ?? "").replace(/^v/i, "").trim();
      if (latest) {
        return {
          hasUpdate: isNewerVersion(latest, APP_VERSION),
          currentVersion: APP_VERSION,
          latestVersion: latest,
          releaseUrl: data.html_url || RELEASES_URL,
          releaseNotes: (data.body || "").trim(),
          publishedAt: data.published_at || "",
          canInstallInApp: false,
        };
      }
    }
  } catch {
    // fall through to tags check
  }

  const tagsResp = await globalThis.fetch(`${apiBase}/tags?per_page=5`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!tagsResp.ok) {
    throw new Error(`无法连接 GitHub 检查更新 (HTTP ${tagsResp.status})`);
  }
  const tags = (await tagsResp.json()) as Array<{ name?: string }>;
  const latestTag = (tags[0]?.name ?? "").replace(/^v/i, "").trim();
  if (!latestTag) {
    return {
      hasUpdate: false,
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      releaseUrl: RELEASES_URL,
      releaseNotes: "",
      publishedAt: "",
      canInstallInApp: false,
    };
  }
  return {
    hasUpdate: isNewerVersion(latestTag, APP_VERSION),
    currentVersion: APP_VERSION,
    latestVersion: latestTag,
    releaseUrl: RELEASES_URL,
    releaseNotes: "",
    publishedAt: "",
    canInstallInApp: false,
  };
}

/**
 * Checks for updates.
 * Inside Tauri desktop builds, queries the cryptographically-signed `latest.json` manifest
 * via `tauri-plugin-updater` first (enforcing HTTPS + Ed25519 signature verification),
 * with safe fallback to GitHub Releases metadata when `latest.json` is unavailable or in Web mode.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  await clearPendingNativeUpdate();

  if (isTauriDesktop()) {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const nativeUpdate = await check({ timeout: 20000 });
      if (nativeUpdate) {
        pendingNativeUpdate = nativeUpdate;
        const cleanLatest = nativeUpdate.version.replace(/^v/i, "").trim();
        const cleanCurrent = (nativeUpdate.currentVersion || APP_VERSION).replace(/^v/i, "").trim();
        return {
          hasUpdate: true,
          currentVersion: cleanCurrent,
          latestVersion: cleanLatest,
          releaseUrl: `${RELEASES_URL}/tag/v${cleanLatest}`,
          releaseNotes: (nativeUpdate.body || "").trim(),
          publishedAt: nativeUpdate.date || "",
          canInstallInApp: true,
        };
      }
      // Native check succeeded and reported up-to-date; still verify against GitHub API
      // in case a brand-new release tag was just pushed and `latest.json` is still building.
      try {
        return await checkViaGitHubApi();
      } catch {
        return {
          hasUpdate: false,
          currentVersion: APP_VERSION,
          latestVersion: APP_VERSION,
          releaseUrl: RELEASES_URL,
          releaseNotes: "",
          publishedAt: "",
          canInstallInApp: false,
        };
      }
    } catch (err) {
      diagLog.warn(
        "自动更新检查",
        "签名更新清单检查暂不可用，已回退 GitHub Releases 版本检查",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return checkViaGitHubApi();
}

/**
 * Downloads, cryptographically verifies (Ed25519 Minisign against embedded pubkey),
 * installs the update package, and restarts the application cleanly.
 */
export async function installPendingInAppUpdate(
  onProgress?: (progress: InAppUpdateProgress) => void,
): Promise<void> {
  if (!isTauriDesktop()) {
    throw new Error("当前为浏览器预览模式，不支持应用内直接安装，请前往 GitHub 下载桌面版。");
  }

  if (!pendingNativeUpdate) {
    const { check } = await import("@tauri-apps/plugin-updater");
    pendingNativeUpdate = await check({ timeout: 20000 });
  }
  if (!pendingNativeUpdate) {
    throw new Error("未检测到可安装的签名更新包，请重新检查或前往 GitHub 手动下载。");
  }

  const update = pendingNativeUpdate;
  let totalBytes = 0;
  let downloadedBytes = 0;

  try {
    onProgress?.({
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: 0,
      percent: 0,
    });

    await update.downloadAndInstall(
      (ev: DownloadEvent) => {
        if (ev.event === "Started") {
          totalBytes = ev.data.contentLength ?? 0;
          downloadedBytes = 0;
          onProgress?.({
            phase: "downloading",
            downloadedBytes,
            totalBytes,
            percent: totalBytes > 0 ? 0 : null,
          });
        } else if (ev.event === "Progress") {
          downloadedBytes += ev.data.chunkLength;
          const pct =
            totalBytes > 0
              ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
              : null;
          onProgress?.({
            phase: "downloading",
            downloadedBytes,
            totalBytes,
            percent: pct,
          });
        } else if (ev.event === "Finished") {
          onProgress?.({
            phase: "verifying_and_installing",
            downloadedBytes: totalBytes || downloadedBytes,
            totalBytes,
            percent: 100,
          });
        }
      },
      { timeout: 120000, restartAfterInstall: true },
    );

    pendingNativeUpdate = null;
    onProgress?.({
      phase: "relaunching",
      downloadedBytes: totalBytes || downloadedBytes,
      totalBytes,
      percent: 100,
    });

    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagLog.error("安全更新失败", "应用内更新下载或数字签名校验失败", msg);
    if (/signature|pubkey|minisign|verify/i.test(msg)) {
      throw new Error(
        `更新包数字签名校验未通过（为保障安全已自动中止安装，未修改本地程序）：${msg}`,
      );
    }
    throw new Error(`应用内更新失败（本地程序与数据未受影响）：${msg}`);
  }
}

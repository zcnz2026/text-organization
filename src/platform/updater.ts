import { APP_VERSION, RELEASES_URL, REPO_NAME, REPO_OWNER } from "./version";

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string;
}

const DISMISSED_VERSION_KEY = "script_lang_dismissed_update_v1";

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

export async function checkForUpdates(): Promise<UpdateCheckResult> {
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
        };
      }
    }
  } catch {
    // fall through to tags check
  }

  // Fallback to tags API if no formal GitHub Release has been published yet
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
    };
  }
  return {
    hasUpdate: isNewerVersion(latestTag, APP_VERSION),
    currentVersion: APP_VERSION,
    latestVersion: latestTag,
    releaseUrl: RELEASES_URL,
    releaseNotes: "",
    publishedAt: "",
  };
}

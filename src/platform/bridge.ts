import type { OAuthSessionInfo } from "../types/config";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function getLocalSessionToken(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("wb_token");
  if (fromQuery) {
    sessionStorage.setItem("wb_session_token", fromQuery);
    url.searchParams.delete("wb_token");
    window.history.replaceState({}, "", url.toString());
    return fromQuery;
  }
  return sessionStorage.getItem("wb_session_token") ?? "";
}

async function callHost<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, payload);
  }

  const token = getLocalSessionToken();
  const resp = await fetch(`/api/${command}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Workbench-Token": token,
    },
    body: JSON.stringify(payload),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    error?: string;
  };
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `本地桥接调用失败 (${resp.status})`);
  }
  return data.result as T;
}

export const hostBridge = {
  initSessionToken(): void {
    getLocalSessionToken();
  },

  getAuthStatus(): Promise<OAuthSessionInfo> {
    return callHost<OAuthSessionInfo>("get_auth_status");
  },

  saveOAuthClientJson(rawJson: string): Promise<OAuthSessionInfo> {
    return callHost<OAuthSessionInfo>("save_oauth_client_json", { rawJson });
  },

  startOAuthLogin(): Promise<OAuthSessionInfo> {
    return callHost<OAuthSessionInfo>("start_oauth_login");
  },

  logoutOAuth(): Promise<OAuthSessionInfo> {
    return callHost<OAuthSessionInfo>("logout_oauth");
  },

  getValidAccessToken(): Promise<string> {
    return callHost<string>("get_valid_access_token");
  },

  getGeminiKeySummary(): Promise<{ count: number; maskedKeys: string[] }> {
    return callHost<{ count: number; maskedKeys: string[] }>("get_gemini_key_summary");
  },

  saveGeminiKeys(rawKeysText: string): Promise<{ count: number; maskedKeys: string[] }> {
    return callHost<{ count: number; maskedKeys: string[] }>("save_gemini_keys", {
      rawKeysText,
    });
  },

  getPlainGeminiKeys(): Promise<string[]> {
    return callHost<string[]>("get_plain_gemini_keys");
  },

  appendDiagLog(line: string): Promise<{ ok: boolean }> {
    return callHost<{ ok: boolean }>("append_diag_log", { line });
  },
};

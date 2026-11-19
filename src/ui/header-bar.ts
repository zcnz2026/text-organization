import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

export function renderHeaderBar(
  container: HTMLElement,
  actions: {
    openOAuthDialog: () => void;
    openGeminiDialog: () => void;
    openCatalogConfigDialog: () => void;
    openRulesDialog: () => void;
  },
): void {
  const oauthConnected = store.auth.authorized;
  const oauthLabel = oauthConnected
    ? `已授权 ${store.auth.email || "Google 账号"}`
    : store.auth.hasClientJson
      ? "已载入凭据 · 点击登录"
      : "Google OAuth 授权";

  const geminiLabel =
    store.geminiSummary.count > 0
      ? `API 密钥池 (${store.geminiSummary.count})`
      : "API 密钥池";

  const theme = store.settings.themeMode;

  container.innerHTML = `
    <header class="topbar">
      <div class="brand-group">
        <img src="/app-icon.svg" alt="" class="brand-logo" width="24" height="24" />
        <h1 class="brand-title">剧本对应语系工作台</h1>
        <a
          href="https://github.com/zcnz2026/text-organization"
          target="_blank"
          rel="noopener noreferrer"
          class="version-link"
          title="打开 GitHub 仓库与版本发布记录"
        >v0.2.3 · 版本库</a>
      </div>
      <div class="topbar-actions">
        <button type="button" id="btn-open-oauth" class="btn ${oauthConnected ? "btn-connected" : ""}">
          ${icons.shieldCheck}
          <span>${esc(oauthLabel)}</span>
        </button>
        <button type="button" id="btn-open-gemini" class="btn">
          ${icons.key}
          <span>${esc(geminiLabel)}</span>
        </button>
        <button type="button" id="btn-open-catalog-cfg" class="btn">
          ${icons.tableGrid}
          <span>资源与列配置清单</span>
        </button>
        <button type="button" id="btn-open-rules" class="btn">
          ${icons.quotes}
          <span>语种标点规则库</span>
        </button>
        <div class="segmented-group" role="group" aria-label="外观模式">
          <button type="button" class="seg-option" data-theme-val="system" aria-pressed="${theme === "system"}">自动</button>
          <button type="button" class="seg-option" data-theme-val="light" aria-pressed="${theme === "light"}">浅色</button>
          <button type="button" class="seg-option" data-theme-val="dark" aria-pressed="${theme === "dark"}">深色</button>
        </div>
      </div>
    </header>
  `;

  container
    .querySelector("#btn-open-oauth")
    ?.addEventListener("click", actions.openOAuthDialog);
  container
    .querySelector("#btn-open-gemini")
    ?.addEventListener("click", actions.openGeminiDialog);
  container
    .querySelector("#btn-open-catalog-cfg")
    ?.addEventListener("click", actions.openCatalogConfigDialog);
  container
    .querySelector("#btn-open-rules")
    ?.addEventListener("click", actions.openRulesDialog);

  container.querySelectorAll<HTMLButtonElement>("[data-theme-val]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.themeVal as "system" | "light" | "dark";
      store.settings.themeMode = val;
      notifyStateChanged();
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

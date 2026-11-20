import { SUPPORTED_GEMINI_MODELS } from "../ai/gemini-client";
import { BUILTIN_PUNCTUATION_RULES } from "../catalog/lang-presets";
import { getActiveLineBreakSpecs } from "../linebreak/presets";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SettingsDialogActions {
  openOAuthDialog: () => void;
  openGeminiDialog: () => void;
  openCatalogConfigDialog: () => void;
  openRulesDialog: () => void;
  openLineBreakRulesDialog: () => void;
}

export function mountSettingsDialog(
  root: HTMLElement,
  actions: SettingsDialogActions,
): {
  openSettingsDialog: () => void;
} {
  const dlg = document.createElement("dialog");
  dlg.id = "dlg-settings";
  dlg.setAttribute("aria-labelledby", "dlg-settings-title");
  dlg.setAttribute("closedby", "any");
  root.append(dlg);

  dlg.addEventListener("close", () => {
    dlg.returnValue = "";
  });

  const renderContent = () => {
    const oauthConnected = store.auth.authorized;
    const oauthStatusText = oauthConnected
      ? `已授权 ${store.auth.email || "Google 账号"}`
      : store.auth.hasClientJson
        ? "已载入客户端凭据 · 待浏览器登录"
        : "尚未配置 OAuth 凭据";

    const keyCount = store.geminiSummary.count;
    const modelLabel =
      SUPPORTED_GEMINI_MODELS.find((m) => m.id === store.geminiModel)?.label ??
      store.geminiModel;
    const geminiStatusText =
      keyCount > 0
        ? `已配置 ${keyCount} 个密钥 · ${modelLabel}${store.geminiEnabled ? "" : "（已暂停）"}`
        : "尚未配置 Gemini API Key";

    const cfgCount = store.linksByLang.size;
    const catalogStatusText =
      cfgCount > 0
        ? `已同步 ${cfgCount} 个语种资料库与列映射配置`
        : "管理 4-Sheet 云端配置表、源稿列与分语种列映射";

    const ruleCount = Math.max(
      BUILTIN_PUNCTUATION_RULES.length,
      store.availableLanguages.length,
    );
    const rulesStatusText = `内置与自定义共 ${ruleCount} 个语种引号及标点转换预设`;

    const theme = store.settings.themeMode;

    dlg.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-settings-title" class="dialog-title">全局设置与规则配置</h2>
        <button type="button" class="seg-option" data-close-settings aria-label="关闭设置窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">
        <div class="settings-list">
          <div class="settings-item-row">
            <div class="settings-item-meta">
              <div class="settings-item-title">
                ${icons.shieldCheck}
                <span>Google OAuth 2.0 授权</span>
                <span class="settings-status-pill ${oauthConnected ? "pill-ok" : store.auth.hasClientJson ? "pill-warn" : "pill-muted"}">
                  ${oauthConnected ? "已连接" : store.auth.hasClientJson ? "待登录" : "未连接"}
                </span>
              </div>
              <span class="field-hint">${esc(oauthStatusText)}</span>
            </div>
            <button type="button" id="btn-settings-oauth" class="btn">
              <span>配置授权</span>
              ${icons.chevronRight}
            </button>
          </div>

          <div class="settings-item-row">
            <div class="settings-item-meta">
              <div class="settings-item-title">
                ${icons.key}
                <span>API 密钥池</span>
                <span class="settings-status-pill ${keyCount > 0 ? "pill-ok" : "pill-muted"}">
                  ${keyCount > 0 ? `${keyCount} 个密钥` : "未配置"}
                </span>
              </div>
              <span class="field-hint">${esc(geminiStatusText)}</span>
            </div>
            <button type="button" id="btn-settings-gemini" class="btn">
              <span>管理密钥池</span>
              ${icons.chevronRight}
            </button>
          </div>

          <div class="settings-item-row">
            <div class="settings-item-meta">
              <div class="settings-item-title">
                ${icons.tableGrid}
                <span>资源与列配置清单</span>
              </div>
              <span class="field-hint">${esc(catalogStatusText)}</span>
            </div>
            <button type="button" id="btn-settings-catalog" class="btn">
              <span>打开配置清单</span>
              ${icons.chevronRight}
            </button>
          </div>

          <div class="settings-item-row">
            <div class="settings-item-meta">
              <div class="settings-item-title">
                ${icons.quotes}
                <span>语种标点规则库</span>
              </div>
              <span class="field-hint">${esc(rulesStatusText)}</span>
            </div>
            <button type="button" id="btn-settings-rules" class="btn">
              <span>管理标点规则</span>
              ${icons.chevronRight}
            </button>
          </div>

          <div class="settings-item-row">
            <div class="settings-item-meta">
              <div class="settings-item-title">
                ${icons.subtitles}
                <span>字幕断行语种与规则库</span>
              </div>
              <span class="field-hint">当前共 ${getActiveLineBreakSpecs().length} 个断行语系 · 支持新增语系、修改单行/双行上限与自定义 AI 规则</span>
            </div>
            <button type="button" id="btn-settings-lb-rules" class="btn">
              <span>管理断行规则</span>
              ${icons.chevronRight}
            </button>
          </div>

          <div class="settings-item-row">
            <div class="settings-item-meta">
              <div class="settings-item-title">
                <span>界面外观模式</span>
              </div>
              <span class="field-hint">跟随系统自动切换或固定浅色 / 深色工作台主题</span>
            </div>
            <div class="segmented-group" role="group" aria-label="外观模式">
              <button type="button" class="seg-option" data-settings-theme="system" aria-pressed="${theme === "system"}">自动</button>
              <button type="button" class="seg-option" data-settings-theme="light" aria-pressed="${theme === "light"}">浅色</button>
              <button type="button" class="seg-option" data-settings-theme="dark" aria-pressed="${theme === "dark"}">深色</button>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-settings autofocus>完成</button>
      </div>
    `;

    dlg.querySelectorAll("[data-close-settings]").forEach((btn) =>
      btn.addEventListener("click", () => dlg.close()),
    );

    dlg.querySelector("#btn-settings-oauth")?.addEventListener("click", () => {
      dlg.close();
      actions.openOAuthDialog();
    });
    dlg.querySelector("#btn-settings-gemini")?.addEventListener("click", () => {
      dlg.close();
      actions.openGeminiDialog();
    });
    dlg.querySelector("#btn-settings-catalog")?.addEventListener("click", () => {
      dlg.close();
      actions.openCatalogConfigDialog();
    });
    dlg.querySelector("#btn-settings-rules")?.addEventListener("click", () => {
      dlg.close();
      actions.openRulesDialog();
    });
    dlg.querySelector("#btn-settings-lb-rules")?.addEventListener("click", () => {
      dlg.close();
      actions.openLineBreakRulesDialog();
    });

    dlg
      .querySelectorAll<HTMLButtonElement>("[data-settings-theme]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.settingsTheme as "system" | "light" | "dark";
          store.settings.themeMode = val;
          notifyStateChanged();
          renderContent();
        });
      });
  };

  return {
    openSettingsDialog: () => {
      renderContent();
      if (!dlg.open) dlg.showModal();
    },
  };
}

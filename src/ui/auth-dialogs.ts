import { SUPPORTED_GEMINI_MODELS } from "../ai/gemini-client";
import { hostBridge } from "../platform/bridge";
import type { GeminiModelId, KeyRotationStrategy } from "../types/config";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mountAuthDialogs(root: HTMLElement): {
  openOAuthDialog: () => void;
  openGeminiDialog: () => void;
} {
  const oauthDialog = document.createElement("dialog");
  oauthDialog.id = "dlg-oauth";
  oauthDialog.setAttribute("aria-labelledby", "dlg-oauth-title");
  oauthDialog.setAttribute("closedby", "any");

  const geminiDialog = document.createElement("dialog");
  geminiDialog.id = "dlg-gemini";
  geminiDialog.setAttribute("aria-labelledby", "dlg-gemini-title");
  geminiDialog.setAttribute("closedby", "any");

  root.append(oauthDialog, geminiDialog);

  for (const dlg of [oauthDialog, geminiDialog]) {
    dlg.addEventListener("close", () => {
      dlg.returnValue = "";
    });
  }

  const renderOAuthContent = (statusMsg = "", isErr = false) => {
    const a = store.auth;
    oauthDialog.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-oauth-title" class="dialog-title">Google OAuth 2.0 桌面授权配置</h2>
        <button type="button" class="seg-option" data-close-dlg aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">
        ${
          statusMsg
            ? `<div class="notice-bar ${isErr ? "notice-error" : "notice-info"}" style="border-radius:8px">${esc(statusMsg)}</div>`
            : ""
        }
        <div class="field-group">
          <span class="field-label">第一步：加载 OAuth 2.0 客户端 JSON 文件</span>
          <span class="field-hint">
            当前状态：${a.hasClientJson ? `已载入客户端凭据 (${esc(a.clientIdMasked)})` : "尚未加载 .json 文件"}
          </span>
          <label class="file-dropzone">
            ${icons.upload}
            <span>点击选择或拖入从 Google Cloud 下载的 OAuth 2.0 客户端 <code>.json</code> 文件</span>
            <input id="inp-oauth-file" type="file" accept=".json,application/json" hidden />
          </label>
        </div>

        <div class="field-group">
          <span class="field-label">第二步：使用有表格权限的 Google 邮箱登录授权</span>
          <span class="field-hint">
            ${
              a.authorized
                ? `当前已授权邮箱：${esc(a.email || "已连接")}（凭据已在本机系统钥匙串/DPAPI 加密保存，自动续期）`
                : "点击下方按钮将打开系统浏览器完成授权，之后可读写该邮箱名下所有有权限的 Google 表格与文档。"
            }
          </span>
          <div style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-block-start:0.25rem">
            <button type="button" id="btn-do-oauth-login" class="btn btn-primary" ${!a.hasClientJson ? "disabled" : ""}>
              ${icons.shieldCheck}
              <span>${a.authorized ? "重新登录 / 切换 Google 账号" : "打开浏览器登录 Google 账号"}</span>
            </button>
            ${
              a.authorized
                ? `<button type="button" id="btn-do-oauth-logout" class="btn">退出当前授权</button>`
                : ""
            }
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-dlg autofocus>完成</button>
      </div>
    `;

    oauthDialog.querySelectorAll("[data-close-dlg]").forEach((b) =>
      b.addEventListener("click", () => oauthDialog.close()),
    );

    const fileInp = oauthDialog.querySelector<HTMLInputElement>("#inp-oauth-file");
    fileInp?.addEventListener("change", async () => {
      const f = fileInp.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        store.auth = await hostBridge.saveOAuthClientJson(text);
        notifyStateChanged();
        renderOAuthContent("OAuth 2.0 客户端 JSON 加载成功，请点击下方按钮登录邮箱。");
      } catch (err) {
        renderOAuthContent(err instanceof Error ? err.message : String(err), true);
      }
    });

    const dropzone = oauthDialog.querySelector<HTMLElement>(".file-dropzone");
    dropzone?.addEventListener("dragover", (e) => e.preventDefault());
    dropzone?.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        store.auth = await hostBridge.saveOAuthClientJson(text);
        notifyStateChanged();
        renderOAuthContent("OAuth 2.0 客户端 JSON 加载成功，请点击下方按钮登录邮箱。");
      } catch (err) {
        renderOAuthContent(err instanceof Error ? err.message : String(err), true);
      }
    });

    oauthDialog
      .querySelector("#btn-do-oauth-login")
      ?.addEventListener("click", async () => {
        renderOAuthContent("正在打开系统浏览器，请在浏览器中完成 Google 邮箱登录授权...");
        try {
          store.auth = await hostBridge.startOAuthLogin();
          notifyStateChanged();
          renderOAuthContent(
            `授权成功！已连接邮箱 ${store.auth.email || "Google 账号"}。`,
          );
        } catch (err) {
          renderOAuthContent(err instanceof Error ? err.message : String(err), true);
        }
      });

    oauthDialog
      .querySelector("#btn-do-oauth-logout")
      ?.addEventListener("click", async () => {
        store.auth = await hostBridge.logoutOAuth();
        notifyStateChanged();
        renderOAuthContent("已退出当前 Google 授权会话。");
      });
  };

  const renderGeminiContent = (statusMsg = "", isErr = false) => {
    const modelOptions = SUPPORTED_GEMINI_MODELS.map(
      (m) =>
        `<option value="${m.id}" ${store.geminiModel === m.id ? "selected" : ""}>${esc(m.label)}</option>`,
    ).join("");

    geminiDialog.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-gemini-title" class="dialog-title">Gemini API 密钥池配置（逐行语义切分辅助）</h2>
        <button type="button" class="seg-option" data-close-gemini aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">
        ${
          statusMsg
            ? `<div class="notice-bar ${isErr ? "notice-error" : "notice-info"}" style="border-radius:8px">${esc(statusMsg)}</div>`
            : ""
        }
        <label class="checkbox-row">
          <input type="checkbox" id="chk-gemini-enable" ${store.geminiEnabled ? "checked" : ""} />
          <span>启用 AI 辅助跨语种逐行时间轴切分与截取对齐（无 Key 或超额时自动切换本地确定性分句）</span>
        </label>

        <div class="field-group">
          <label class="field-label" for="sel-gemini-model">选用模型</label>
          <select id="sel-gemini-model" class="select-input">${modelOptions}</select>
        </div>

        <div class="field-group">
          <label class="field-label" for="sel-gemini-rot">多密钥调度策略</label>
          <select id="sel-gemini-rot" class="select-input">
            <option value="round_robin" ${store.geminiRotation === "round_robin" ? "selected" : ""}>均衡轮换 + 报错自动秒切（推荐）</option>
            <option value="failover" ${store.geminiRotation === "failover" ? "selected" : ""}>顺序主备 + 报错自动秒切</option>
          </select>
        </div>

        <div class="field-group">
          <div class="field-label-row">
            <label class="field-label" for="txt-gemini-keys">API Key 列表（每行一个，支持 AIza... 与 AQ...）</label>
            <span class="field-hint">当前已保存 ${store.geminiSummary.count} 个密钥</span>
          </div>
          ${
            store.geminiSummary.maskedKeys.length > 0
              ? `<div class="field-hint">已加密存储：${esc(store.geminiSummary.maskedKeys.join(" , "))}</div>`
              : ""
          }
          <textarea id="txt-gemini-keys" class="text-area" placeholder="粘贴新的 API Key（一行一个）点击「保存密钥池」即可替换；留空保存可清空密钥"></textarea>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-gemini>取消</button>
        <button type="button" id="btn-save-gemini" class="btn btn-primary" autofocus>保存设置</button>
      </div>
    `;

    geminiDialog.querySelectorAll("[data-close-gemini]").forEach((b) =>
      b.addEventListener("click", () => geminiDialog.close()),
    );

    geminiDialog
      .querySelector("#btn-save-gemini")
      ?.addEventListener("click", async () => {
        store.geminiEnabled =
          geminiDialog.querySelector<HTMLInputElement>("#chk-gemini-enable")
            ?.checked ?? true;
        store.geminiModel =
          (geminiDialog.querySelector<HTMLSelectElement>("#sel-gemini-model")
            ?.value as GeminiModelId) ?? "gemini-3.8-flash";
        store.geminiRotation =
          (geminiDialog.querySelector<HTMLSelectElement>("#sel-gemini-rot")
            ?.value as KeyRotationStrategy) ?? "round_robin";

        const rawKeys =
          geminiDialog
            .querySelector<HTMLTextAreaElement>("#txt-gemini-keys")
            ?.value.trim() ?? "";

        try {
          if (rawKeys.length > 0) {
            store.geminiSummary = await hostBridge.saveGeminiKeys(rawKeys);
          }
          notifyStateChanged();
          geminiDialog.close();
        } catch (err) {
          renderGeminiContent(err instanceof Error ? err.message : String(err), true);
        }
      });
  };

  return {
    openOAuthDialog: () => {
      renderOAuthContent();
      oauthDialog.showModal();
    },
    openGeminiDialog: () => {
      renderGeminiContent();
      geminiDialog.showModal();
    },
  };
}

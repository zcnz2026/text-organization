import { GeminiPoolClient, SUPPORTED_GEMINI_MODELS } from "../ai/gemini-client";
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
            <label class="field-label">已加密存储的密钥池 (${store.geminiSummary.count} 个)</label>
            ${
              store.geminiSummary.count > 0
                ? `<button type="button" id="btn-clear-all-keys" class="seg-option">清空全部</button>`
                : ""
            }
          </div>
          ${
            store.geminiSummary.maskedKeys.length > 0
              ? `<div style="display:flex;flex-direction:column;gap:0.35rem;max-block-size:150px;overflow-y:auto">
                  ${store.geminiSummary.maskedKeys
                    .map(
                      (mk, idx) => `
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.3rem 0.55rem;border:1px solid var(--border-subtle);border-radius:6px;background:var(--bg-subtle)">
                          <span class="mono-cell">#${idx + 1} · ${esc(mk)}</span>
                          <button type="button" class="seg-option" data-del-key-idx="${idx}">删除</button>
                        </div>`,
                    )
                    .join("")}
                </div>`
              : `<div class="field-hint">尚未添加任何 API Key，请在下方输入框新增。</div>`
          }
        </div>

        <div class="field-group">
          <div class="field-label-row">
            <label class="field-label" for="txt-gemini-keys">新增 API Key（支持一次粘贴多个，每行一个，自动去重追加）</label>
          </div>
          <textarea id="txt-gemini-keys" class="text-area" placeholder="粘贴要新增的 AIza... 或 AQ... 密钥（每行一个），点击「+ 追加密钥」加入密钥池"></textarea>
          <div class="btn-row-compact">
            <button type="button" id="btn-add-gemini-keys" class="btn btn-compact">+ 追加到密钥池</button>
            <button type="button" id="btn-test-gemini" class="btn btn-compact">测试当前模型连通性</button>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-gemini>关闭</button>
        <button type="button" id="btn-save-gemini" class="btn btn-primary" autofocus>保存模型与开关</button>
      </div>
    `;

    const syncUiPrefs = () => {
      store.geminiEnabled =
        geminiDialog.querySelector<HTMLInputElement>("#chk-gemini-enable")?.checked ?? true;
      store.geminiModel =
        (geminiDialog.querySelector<HTMLSelectElement>("#sel-gemini-model")?.value as GeminiModelId) ??
        "gemini-3.8-flash";
      store.geminiRotation =
        (geminiDialog.querySelector<HTMLSelectElement>("#sel-gemini-rot")?.value as KeyRotationStrategy) ??
        "round_robin";
    };

    geminiDialog.querySelectorAll("[data-close-gemini]").forEach((b) =>
      b.addEventListener("click", () => geminiDialog.close()),
    );

    geminiDialog.querySelectorAll<HTMLButtonElement>("[data-del-key-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        syncUiPrefs();
        const idx = Number(btn.dataset.delKeyIdx);
        try {
          const existing = await hostBridge.getPlainGeminiKeys();
          if (idx >= 0 && idx < existing.length) {
            existing.splice(idx, 1);
            store.geminiSummary = await hostBridge.saveGeminiKeys(existing.join("\n"));
            notifyStateChanged();
            renderGeminiContent(`已删除第 #${idx + 1} 个密钥，当前剩余 ${store.geminiSummary.count} 个。`);
          }
        } catch (err) {
          renderGeminiContent(err instanceof Error ? err.message : String(err), true);
        }
      });
    });

    geminiDialog.querySelector("#btn-clear-all-keys")?.addEventListener("click", async () => {
      syncUiPrefs();
      try {
        store.geminiSummary = await hostBridge.saveGeminiKeys("");
        notifyStateChanged();
        renderGeminiContent("已清空全部 API 密钥。");
      } catch (err) {
        renderGeminiContent(err instanceof Error ? err.message : String(err), true);
      }
    });

    geminiDialog.querySelector("#btn-add-gemini-keys")?.addEventListener("click", async () => {
      syncUiPrefs();
      const rawNew = geminiDialog.querySelector<HTMLTextAreaElement>("#txt-gemini-keys")?.value.trim() ?? "";
      if (!rawNew) return renderGeminiContent("请先在上方输入框粘贴要新增的 API Key。", true);
      try {
        const existing = await hostBridge.getPlainGeminiKeys();
        const incoming = rawNew
          .split(/[\r\n,;]+/)
          .map((k) => k.trim())
          .filter((k) => k.length >= 16);
        if (incoming.length === 0) {
          return renderGeminiContent("未识别到有效的 API Key（长度需不少于 16 位）。", true);
        }
        const merged = [...new Set([...existing, ...incoming])];
        const addedCount = merged.length - existing.length;
        store.geminiSummary = await hostBridge.saveGeminiKeys(merged.join("\n"));
        notifyStateChanged();
        renderGeminiContent(
          addedCount > 0
            ? `已成功新增 ${addedCount} 个密钥，当前密钥池共 ${store.geminiSummary.count} 个。`
            : `输入的密钥均已在密钥池中（共 ${store.geminiSummary.count} 个）。`,
        );
      } catch (err) {
        renderGeminiContent(err instanceof Error ? err.message : String(err), true);
      }
    });

    geminiDialog.querySelector("#btn-test-gemini")?.addEventListener("click", async () => {
      syncUiPrefs();
      try {
        const keys = await hostBridge.getPlainGeminiKeys();
        if (keys.length === 0) return renderGeminiContent("密钥池为空，请先新增至少一个 API Key。", true);
        renderGeminiContent(`正在测试模型 ${store.geminiModel} 连通性（共 ${keys.length} 个密钥）...`);
        const client = new GeminiPoolClient({
          apiKeys: keys,
          model: store.geminiModel,
          rotation: store.geminiRotation,
        });
        await client.generateStructuredJson<{ ok: boolean }>({
          systemInstruction: "Return JSON {\"ok\": true}.",
          userPrompt: "ping",
          jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        });
        renderGeminiContent(`连通成功！模型 ${store.geminiModel} 可正常用于词序号精准分句。`);
      } catch (err) {
        renderGeminiContent(`连通测试失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    });

    geminiDialog
      .querySelector("#btn-save-gemini")
      ?.addEventListener("click", async () => {
        syncUiPrefs();
        const rawNew = geminiDialog.querySelector<HTMLTextAreaElement>("#txt-gemini-keys")?.value.trim() ?? "";
        try {
          if (rawNew.length > 0) {
            const existing = await hostBridge.getPlainGeminiKeys();
            const incoming = rawNew.split(/[\r\n,;]+/).map((k) => k.trim()).filter((k) => k.length >= 16);
            if (incoming.length > 0) {
              store.geminiSummary = await hostBridge.saveGeminiKeys([...new Set([...existing, ...incoming])].join("\n"));
            }
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

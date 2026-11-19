import { resolvePunctuationRule } from "../catalog/lang-presets";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function openLangPickerDialog(): void {
  let dlg = document.querySelector<HTMLDialogElement>("#dlg-lang-picker");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-lang-picker";
    dlg.className = "dialog-wide";
    dlg.setAttribute("closedby", "any");
    document.body.append(dlg);
  }

  let filterText = "";

  const render = () => {
    const selectedSet = new Set(store.settings.selectedLanguages);
    const q = filterText.trim().toLowerCase();
    const langs = store.availableLanguages.filter((l) => !q || l.toLowerCase().includes(q));

    const gridHtml = langs
      .map((lang) => {
        const rule = resolvePunctuationRule(lang, store.customRules);
        const checked = selectedSet.has(lang) ? "checked" : "";
        return `
          <label class="lang-check-item">
            <span class="lang-check-left">
              <input type="checkbox" data-dlg-lang="${esc(lang)}" ${checked} />
              <span>${esc(lang)}</span>
            </span>
            <span class="lang-quote-sample">${esc(rule.doubleOpen)}…${esc(rule.doubleClose)}</span>
          </label>`;
      })
      .join("");

    dlg!.innerHTML = `
      <div class="dialog-header">
        <h2 class="dialog-title">选择目标输出语种（已选 ${store.settings.selectedLanguages.length}/${store.availableLanguages.length}）</h2>
        <button type="button" class="seg-option" data-close-lp aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">
        <div class="input-inline-row">
          <input id="inp-lp-search" type="search" class="text-input" placeholder="快速筛选语种名称..." value="${esc(filterText)}" />
          <button type="button" id="btn-lp-all" class="btn btn-compact">全选</button>
          <button type="button" id="btn-lp-clear" class="btn btn-compact">清空</button>
        </div>
        <div class="lang-picker-grid">${gridHtml || `<div class="field-hint">未找到匹配的语种</div>`}</div>
        <div class="input-inline-row" style="padding-block-start:0.5rem;border-block-start:1px solid var(--border-subtle)">
          <input id="inp-lp-add" type="text" class="text-input" placeholder="新增其他语种（如：斯瓦希里语、泰语）" />
          <button type="button" id="btn-lp-add" class="btn btn-compact">+ 新增并勾选</button>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn btn-primary" data-close-lp>完成</button>
      </div>
    `;

    dlg!.querySelectorAll("[data-close-lp]").forEach((b) =>
      b.addEventListener("click", () => dlg?.close()),
    );

    const searchInp = dlg!.querySelector<HTMLInputElement>("#inp-lp-search");
    searchInp?.addEventListener("input", () => {
      filterText = searchInp.value;
      render();
      const next = dlg!.querySelector<HTMLInputElement>("#inp-lp-search");
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });

    dlg!.querySelectorAll<HTMLInputElement>("[data-dlg-lang]").forEach((chk) => {
      chk.addEventListener("change", () => {
        const lang = chk.dataset.dlgLang ?? "";
        const next = new Set(store.settings.selectedLanguages);
        if (chk.checked) next.add(lang);
        else next.delete(lang);
        store.settings.selectedLanguages = [...next];
        notifyStateChanged();
        const titleEl = dlg!.querySelector(".dialog-title");
        if (titleEl) {
          titleEl.textContent = `选择目标输出语种（已选 ${store.settings.selectedLanguages.length}/${store.availableLanguages.length}）`;
        }
      });
    });

    dlg!.querySelector("#btn-lp-all")?.addEventListener("click", () => {
      store.settings.selectedLanguages = [...store.availableLanguages];
      notifyStateChanged();
      render();
    });

    dlg!.querySelector("#btn-lp-clear")?.addEventListener("click", () => {
      store.settings.selectedLanguages = [];
      notifyStateChanged();
      render();
    });

    dlg!.querySelector("#btn-lp-add")?.addEventListener("click", () => {
      const val = (dlg!.querySelector<HTMLInputElement>("#inp-lp-add")?.value ?? "").trim();
      if (!val) return;
      if (!store.availableLanguages.includes(val)) store.availableLanguages.push(val);
      if (!store.settings.selectedLanguages.includes(val)) store.settings.selectedLanguages.push(val);
      notifyStateChanged();
      render();
    });
  };

  render();
  if (!dlg.open) dlg.showModal();
}

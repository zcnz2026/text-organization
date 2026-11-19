import { resolvePunctuationRule } from "../catalog/lang-presets";
import { parseGoogleResourceUrl } from "../google/url-parser";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function urlHintBadge(raw: string, fallback = "待填写"): string {
  if (!raw.trim()) return fallback;
  const parsed = parseGoogleResourceUrl(raw, "sheet");
  if (!parsed) return "链接格式不匹配";
  return parsed.gid !== null ? `已识别 gid=${parsed.gid}` : "默认首表";
}

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderTaskPanel(
  container: HTMLElement,
  actions: {
    onRefreshCloudConfig: () => void;
    onDownloadConfigTemplate: () => void;
    onOpenSourceColsDialog: () => void;
    onOpenCatalogConfigDialog: () => void;
    onLoadCloudPreview: () => void;
    onImportLocalCsv: (file: File) => void;
    onRunExtraction: () => void;
    onSyncReviewedCloud: () => void;
    onExportXlsx: () => void;
  },
): void {
  const s = store.settings;
  const selectedSet = new Set(s.selectedLanguages);
  const hasReviewedRuns = store.runsByLang.size > 0;

  const langItemsHtml = store.availableLanguages
    .map((lang) => {
      const rule = resolvePunctuationRule(lang, store.customRules);
      const checked = selectedSet.has(lang) ? "checked" : "";
      return `<label class="lang-check-item"><span class="lang-check-left"><input type="checkbox" data-lang-check="${esc(lang)}" ${checked} ${store.busy ? "disabled" : ""} /><span>${esc(lang)}</span></span><span class="lang-quote-sample">${esc(rule.doubleOpen)}…${esc(rule.doubleClose)}</span></label>`;
    })
    .join("");

  const overrideLangs = s.selectedLanguages.length > 0 ? s.selectedLanguages : store.availableLanguages.slice(0, 4);
  const overrideInputsHtml = overrideLangs
    .map(
      (lang) => `<div class="field-group"><label class="field-label" for="inp-ep-hymn-${esc(lang)}">${esc(lang)} 本期诗歌链接</label><input id="inp-ep-hymn-${esc(lang)}" data-ep-hymn-lang="${esc(lang)}" type="url" class="text-input" placeholder="可选：覆盖该语种本期诗歌 #gid 链接" value="${esc(store.episodeHymnOverrides[lang] ?? "")}" ${store.busy ? "disabled" : ""} /></div>`,
    )
    .join("");

  container.innerHTML = `
    <aside class="setup-rail" aria-label="任务与资源配置">
      <section class="rail-section">
        <h2 class="section-heading">云端配置与任务表格</h2>

        <div class="field-group">
          <div class="field-label-row">
            <label class="field-label" for="inp-cloud-cfg-url">云端总配置表链接</label>
            <span class="field-hint">${esc(urlHintBadge(store.cloudConfigUrl, "可选 · 团队共享"))}</span>
          </div>
          <input id="inp-cloud-cfg-url" type="url" class="text-input" placeholder="粘贴 4-Sheet 云端总配置表链接（留空读本地或源表配置）" value="${esc(store.cloudConfigUrl)}" ${store.busy ? "disabled" : ""} />
          <div class="btn-row-equal">
            <button type="button" id="btn-refresh-cloud-cfg" class="btn btn-compact" ${store.busy ? "disabled" : ""}>${icons.cloudSync}<span>刷新云端配置</span></button>
            <button type="button" id="btn-dl-config-tpl" class="btn btn-compact" ${store.busy ? "disabled" : ""}>${icons.download}<span>导出配置模板 (.xlsx)</span></button>
          </div>
        </div>

        <div class="field-group">
          <div class="field-label-row">
            <label class="field-label" for="inp-source-url">源剧本 Google 表格</label>
            <button type="button" id="btn-open-source-cols" class="seg-option" ${store.busy ? "disabled" : ""}>列位置设置 (A~L)</button>
          </div>
          <input id="inp-source-url" type="url" class="text-input" placeholder="粘贴含 #gid=... 的源剧本链接" value="${esc(s.sourceSpreadsheetUrl)}" ${store.busy ? "disabled" : ""} />
        </div>

        <div class="field-group">
          <div class="field-label-row">
            <label class="field-label" for="inp-output-url">专用输出 Google 表格</label>
            <span class="field-hint">${s.outputSpreadsheetUrl.trim() ? "分语种写入此表" : "待填写"}</span>
          </div>
          <input id="inp-output-url" type="url" class="text-input" placeholder="粘贴有编辑权限的输出专用表格链接" value="${esc(s.outputSpreadsheetUrl)}" ${store.busy ? "disabled" : ""} />
        </div>

        <div class="field-group">
          <div class="field-label-row">
            <label class="field-label" for="inp-hymn-kw">本期诗歌子表匹配词（可选）</label>
            <button type="button" id="btn-rail-open-catalog" class="seg-option" ${store.busy ? "disabled" : ""}>资源与列配置清单</button>
          </div>
          <input id="inp-hymn-kw" type="text" class="text-input" placeholder="如：39期.葡萄牙 或 39期，自动匹配各语种诗歌子表" value="${esc(store.hymnEpisodeKeyword)}" ${store.busy ? "disabled" : ""} />
          <details class="compact-details">
            <summary>单语种临时诗歌链接 (${Object.keys(store.episodeHymnOverrides).length})</summary>
            <div class="compact-details-body">${overrideInputsHtml}</div>
          </details>
        </div>

        <div class="btn-row-equal">
          <button type="button" id="btn-load-cloud" class="btn btn-compact" ${store.busy ? "disabled" : ""}>${icons.cloudSync}<span>读取云端源稿</span></button>
          <label class="btn btn-compact" style="cursor:${store.busy ? "not-allowed" : "pointer"}">
            ${icons.upload}<span>导入本地 CSV</span>
            <input id="inp-local-csv" type="file" accept=".csv" hidden ${store.busy ? "disabled" : ""} />
          </label>
        </div>
      </section>

      <section class="rail-section">
        <div class="field-label-row">
          <h2 class="section-heading">目标输出语种 (${s.selectedLanguages.length}/${store.availableLanguages.length})</h2>
          <div style="display:flex;gap:0.35rem">
            <button type="button" id="btn-select-all-langs" class="seg-option" ${store.busy ? "disabled" : ""}>全选</button>
            <button type="button" id="btn-clear-langs" class="seg-option" ${store.busy ? "disabled" : ""}>清空</button>
          </div>
        </div>
        <div class="lang-grid">${langItemsHtml}</div>
        <div style="display:flex;gap:0.4rem">
          <input id="inp-new-lang" type="text" class="text-input" placeholder="添加其他语种（如：泰语）" ${store.busy ? "disabled" : ""} />
          <button type="button" id="btn-add-lang" class="btn btn-compact" ${store.busy ? "disabled" : ""}>添加</button>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" id="chk-roster" ${s.enableRosterPreFill ? "checked" : ""} ${store.busy ? "disabled" : ""} />
          <span>启用人名/教会名库预填（附核对提示）</span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="chk-overwrite" ${s.overwriteExistingSheets ? "checked" : ""} ${store.busy ? "disabled" : ""} />
          <span>同名语种 Sheet 已存在时覆盖更新</span>
        </label>
      </section>

      <div class="rail-cta-footer">
        ${
          store.busy
            ? `<div class="progress-strip" role="status" aria-live="polite"><div class="field-label-row"><span class="field-label">${esc(store.progressText || "正在执行摘录...")}</span><span class="field-hint">${Math.round(store.progressPercent)}%</span></div><div class="progress-bar-track"><div class="progress-bar-fill" style="width:${Math.max(4, Math.min(100, store.progressPercent))}%"></div></div></div>`
            : ""
        }
        <button type="button" id="btn-run-pipeline" class="btn btn-primary btn-block" ${store.busy || s.selectedLanguages.length === 0 ? "disabled" : ""}>${icons.play}<span>开始提取并预览（不写入表格）</span></button>
        <div class="btn-row-equal">
          ${
            hasReviewedRuns
              ? `<button type="button" id="btn-sync-reviewed" class="btn btn-compact btn-connected" ${store.busy || !s.outputSpreadsheetUrl.trim() ? "disabled" : ""} title="确认右侧预览结果无误后，正式写入专用输出 Google 表格">${icons.cloudSync}<span>确认写入 Google 表格</span></button>`
              : ""
          }
          <button type="button" id="btn-export-xlsx" class="btn btn-compact" ${store.busy || !store.scriptDoc ? "disabled" : ""}>${icons.download}<span>导出 Excel (.xlsx)</span></button>
        </div>
      </div>
    </aside>`;

  const bindInput = (selector: string, setter: (v: string) => void) => {
    const el = container.querySelector<HTMLInputElement>(selector);
    el?.addEventListener("change", () => {
      setter(el.value.trim());
      notifyStateChanged();
    });
  };
  bindInput("#inp-cloud-cfg-url", (v) => {
    store.cloudConfigUrl = v;
    store.settings.resourceMatrixUrl = v;
  });
  bindInput("#inp-source-url", (v) => (store.settings.sourceSpreadsheetUrl = v));
  bindInput("#inp-output-url", (v) => (store.settings.outputSpreadsheetUrl = v));
  bindInput("#inp-hymn-kw", (v) => (store.hymnEpisodeKeyword = v));

  container.querySelectorAll<HTMLInputElement>("[data-ep-hymn-lang]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const lang = inp.dataset.epHymnLang ?? "";
      const v = inp.value.trim();
      if (v) store.episodeHymnOverrides[lang] = v;
      else delete store.episodeHymnOverrides[lang];
      notifyStateChanged();
    });
  });

  container.querySelector("#btn-refresh-cloud-cfg")?.addEventListener("click", actions.onRefreshCloudConfig);
  container.querySelector("#btn-dl-config-tpl")?.addEventListener("click", actions.onDownloadConfigTemplate);
  container.querySelector("#btn-open-source-cols")?.addEventListener("click", actions.onOpenSourceColsDialog);
  container.querySelector("#btn-rail-open-catalog")?.addEventListener("click", actions.onOpenCatalogConfigDialog);
  container.querySelector("#btn-load-cloud")?.addEventListener("click", actions.onLoadCloudPreview);

  const csvInput = container.querySelector<HTMLInputElement>("#inp-local-csv");
  csvInput?.addEventListener("change", () => {
    const file = csvInput.files?.[0];
    if (file) actions.onImportLocalCsv(file);
  });

  container.querySelectorAll<HTMLInputElement>("[data-lang-check]").forEach((chk) => {
    chk.addEventListener("change", () => {
      const lang = chk.dataset.langCheck ?? "";
      const next = new Set(store.settings.selectedLanguages);
      if (chk.checked) next.add(lang);
      else next.delete(lang);
      store.settings.selectedLanguages = [...next];
      notifyStateChanged();
    });
  });

  container.querySelector("#btn-select-all-langs")?.addEventListener("click", () => {
    store.settings.selectedLanguages = [...store.availableLanguages];
    notifyStateChanged();
  });
  container.querySelector("#btn-clear-langs")?.addEventListener("click", () => {
    store.settings.selectedLanguages = [];
    notifyStateChanged();
  });
  container.querySelector("#btn-add-lang")?.addEventListener("click", () => {
    const inp = container.querySelector<HTMLInputElement>("#inp-new-lang");
    const val = (inp?.value ?? "").trim();
    if (!val) return;
    if (!store.availableLanguages.includes(val)) store.availableLanguages.push(val);
    if (!store.settings.selectedLanguages.includes(val)) store.settings.selectedLanguages.push(val);
    notifyStateChanged();
  });
  container.querySelector("#chk-roster")?.addEventListener("change", (e) => {
    store.settings.enableRosterPreFill = (e.target as HTMLInputElement).checked;
    notifyStateChanged();
  });
  container.querySelector("#chk-overwrite")?.addEventListener("change", (e) => {
    store.settings.overwriteExistingSheets = (e.target as HTMLInputElement).checked;
    notifyStateChanged();
  });
  container.querySelector("#btn-run-pipeline")?.addEventListener("click", actions.onRunExtraction);
  container.querySelector("#btn-sync-reviewed")?.addEventListener("click", actions.onSyncReviewedCloud);
  container.querySelector("#btn-export-xlsx")?.addEventListener("click", actions.onExportXlsx);
}

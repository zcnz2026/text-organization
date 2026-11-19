import { icons } from "./icons";
import { openLangPickerDialog } from "./lang-picker-dialog";
import { notifyStateChanged, store } from "./state";

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
  const hasReviewedRuns = store.runsByLang.size > 0;

  const overrideLangs = s.selectedLanguages.length > 0 ? s.selectedLanguages : store.availableLanguages.slice(0, 4);
  const overrideInputsHtml = overrideLangs
    .map(
      (lang) => `<div class="rail-form-row"><label class="rail-row-label" for="inp-ep-hymn-${esc(lang)}">${esc(lang)}</label><input id="inp-ep-hymn-${esc(lang)}" data-ep-hymn-lang="${esc(lang)}" type="url" class="text-input" placeholder="覆盖本期诗歌 #gid 链接" value="${esc(store.episodeHymnOverrides[lang] ?? "")}" ${store.busy ? "disabled" : ""} /></div>`,
    )
    .join("");

  const selectedPreview =
    s.selectedLanguages.length === 0
      ? "未选择语种"
      : s.selectedLanguages.length <= 3
        ? s.selectedLanguages.join("、")
        : `${s.selectedLanguages.slice(0, 3).join("、")} 等 ${s.selectedLanguages.length} 个`;

  container.innerHTML = `
    <aside class="setup-rail" aria-label="任务与资源配置">
      <section class="rail-section">
        <h2 class="section-heading">云端配置与任务表格</h2>

        <div class="rail-form-row rail-form-row-btn">
          <label class="rail-row-label" for="inp-cloud-cfg-url" title="执行提取前会自动刷新最新云端配置">云端配置</label>
          <input id="inp-cloud-cfg-url" type="url" class="text-input" placeholder="云端总配置表链接" value="${esc(store.cloudConfigUrl)}" ${store.busy ? "disabled" : ""} />
          <button type="button" id="btn-open-cloud-cfg" class="btn btn-compact" ${!store.cloudConfigUrl.trim() ? "disabled" : ""} title="在浏览器新标签页打开云端配置表">打开</button>
        </div>

        <div class="rail-form-row">
          <label class="rail-row-label" for="inp-source-url">剧本表</label>
          <input id="inp-source-url" type="url" class="text-input" placeholder="含 #gid=... 的源剧本链接" value="${esc(s.sourceSpreadsheetUrl)}" ${store.busy ? "disabled" : ""} />
        </div>

        <div class="rail-form-row">
          <label class="rail-row-label" for="inp-output-url">输出表格</label>
          <input id="inp-output-url" type="url" class="text-input" placeholder="专用输出 Google 表格链接" value="${esc(s.outputSpreadsheetUrl)}" ${store.busy ? "disabled" : ""} />
        </div>

        <div class="rail-form-row">
          <label class="rail-row-label" for="inp-hymn-kw">诗歌匹配</label>
          <input id="inp-hymn-kw" type="text" class="text-input" placeholder="如：39期.葡萄牙 或 39期" value="${esc(store.hymnEpisodeKeyword)}" ${store.busy ? "disabled" : ""} />
        </div>

        <details class="compact-details">
          <summary>单语种临时诗歌链接 (${Object.keys(store.episodeHymnOverrides).length})</summary>
          <div class="compact-details-body">${overrideInputsHtml}</div>
        </details>

        <div class="btn-row-equal">
          <button type="button" id="btn-load-cloud" class="btn btn-compact" ${store.busy ? "disabled" : ""}>${icons.cloudSync}<span>读取云端源稿</span></button>
          <label class="btn btn-compact" style="cursor:${store.busy ? "not-allowed" : "pointer"}">
            ${icons.upload}<span>导入本地 CSV</span>
            <input id="inp-local-csv" type="file" accept=".csv" hidden ${store.busy ? "disabled" : ""} />
          </label>
        </div>
      </section>

      <section class="rail-section">
        <div class="rail-form-row rail-form-row-btn">
          <span class="rail-row-label">目标语种</span>
          <div class="lang-summary-pill" title="${esc(s.selectedLanguages.join("、"))}">${esc(selectedPreview)}</div>
          <button type="button" id="btn-open-lang-picker" class="btn btn-compact" ${store.busy ? "disabled" : ""}>选择 (${s.selectedLanguages.length})</button>
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

  container.querySelector("#btn-open-cloud-cfg")?.addEventListener("click", () => {
    const url = store.cloudConfigUrl.trim();
    if (url.startsWith("http")) window.open(url, "_blank", "noopener,noreferrer");
  });
  container.querySelector("#btn-open-lang-picker")?.addEventListener("click", openLangPickerDialog);
  container.querySelector("#btn-load-cloud")?.addEventListener("click", actions.onLoadCloudPreview);

  const csvInput = container.querySelector<HTMLInputElement>("#inp-local-csv");
  csvInput?.addEventListener("change", () => {
    const file = csvInput.files?.[0];
    if (file) actions.onImportLocalCsv(file);
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

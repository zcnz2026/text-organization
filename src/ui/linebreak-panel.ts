import { saveBatchQueueCheckpoint } from "../linebreak/checkpoint-store";
import {
  getActiveLineBreakSpecs,
  resolveLineBreakSpec,
} from "../linebreak/presets";
import { colIndexToLetters } from "../linebreak/xlsx-writer";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LineBreakPanelActions {
  onLoadGoogleSheet: () => void;
  onImportFile: (file: File) => void;
  onSwitchSheet: (sheetName: string) => void;
  onRunLineBreak: () => void;
  onPauseRun: () => void;
  onSyncGoogleSheet: () => void;
  onExportXlsx: () => void;
  onLoadBatchMaster: () => void;
  onImportBatchMasterFile: (file: File) => void;
  onRunBatchAll: () => void;
  onWriteBatchAll: () => void;
  onOpenSettings: () => void;
  onOpenGeminiDialog: () => void;
  onOpenLineBreakRules: () => void;
}

export function renderLineBreakPanel(
  container: HTMLElement,
  actions: LineBreakPanelActions,
): void {
  const lb = store.lineBreak;
  const isBatch = lb.mode === "batch";
  const wb = lb.workbook;
  const activeSheet = wb ? wb.sheets[wb.activeSheetName] : null;
  const spec = resolveLineBreakSpec(lb.langCode);
  const keyCount = store.geminiSummary.count;

  const modeSwitcherHtml = `
    <div class="segmented-group" role="group" aria-label="字幕断行工作模式" style="inline-size:100%;display:grid;grid-template-columns:1fr 1fr">
      <button type="button" class="seg-option" data-lb-mode="single" aria-pressed="${!isBatch}" ${store.busy ? "disabled" : ""}>单表精修</button>
      <button type="button" class="seg-option" data-lb-mode="batch" aria-pressed="${isBatch}" ${store.busy ? "disabled" : ""}>总表批量</button>
    </div>
  `;

  if (isBatch) {
    const q = lb.batchQueue;
    const totalCount = q?.items.length ?? 0;
    const readyCount = q?.items.filter((i) => i.status === "ready_review").length ?? 0;
    const completedCount = q?.items.filter((i) => i.status === "completed").length ?? 0;
    const pausedCount = q?.items.filter((i) => i.status === "paused_key").length ?? 0;

    container.innerHTML = `
      <aside class="setup-rail" aria-label="多语种批量断行配置">
        <section class="rail-section">
          ${modeSwitcherHtml}
          <div class="field-label-row" style="margin-block-start:0.5rem">
            <h2 class="section-heading">批量总表导入（A列名称 · B列链接）</h2>
            ${
              q
                ? `<button type="button" id="btn-clear-batch-queue" class="seg-option" ${store.busy ? "disabled" : ""}>清空队列</button>`
                : ""
            }
          </div>

          <div class="rail-form-row rail-form-row-btn">
            <label class="rail-row-label" for="inp-lb-master-url" title="A列为含语种的表格名称，B列为Google表格链接">总表链接</label>
            <input
              id="inp-lb-master-url"
              type="url"
              class="text-input"
              placeholder="粘贴批量总表 Google 表格链接"
              value="${esc(lb.masterSheetUrl)}"
              ${store.busy ? "disabled" : ""}
            />
            <button type="button" id="btn-open-lb-master" class="btn btn-compact" ${!lb.masterSheetUrl.trim() ? "disabled" : ""}>打开</button>
          </div>

          <div class="btn-row-equal">
            <button type="button" id="btn-lb-load-master" class="btn btn-compact" ${store.busy ? "disabled" : ""}>
              ${icons.cloudSync}
              <span>读取批量总表</span>
            </button>
            <label class="btn btn-compact" style="cursor:${store.busy ? "not-allowed" : "pointer"}">
              ${icons.upload}
              <span>导入总表 .xlsx</span>
              <input id="inp-lb-master-file" type="file" accept=".xlsx" hidden ${store.busy ? "disabled" : ""} />
            </label>
          </div>

          ${
            q
              ? `<span class="field-hint">当前队列：共 <strong>${totalCount}</strong> 个语种（待核对写入 ${readyCount}，已写入 ${completedCount}${pausedCount > 0 ? `，断点待续跑 ${pausedCount}` : ""}）</span>`
              : `<span class="field-hint">支持总表含智能芯片与超链接；若某语种表内有多个 Sheet，将弹窗提醒人工选择。</span>`
          }
        </section>

        <section class="rail-section">
          <div class="field-label-row">
            <h2 class="section-heading">引擎与两步写回确认</h2>
            <button type="button" id="btn-lb-open-rules" class="seg-option">管理语系/规则</button>
          </div>
          <label class="checkbox-row">
            <input type="checkbox" id="chk-lb-ai" ${lb.useAi ? "checked" : ""} ${store.busy ? "disabled" : ""} />
            <span>启用大模型意群精断 + 本地硬规则校验闭环</span>
          </label>
          <div class="field-label-row">
            <span class="field-hint">
              ${keyCount > 0 ? `API 密钥池就绪 (${keyCount} 个密钥)` : "尚未配置 API 密钥（跑前请先添加）"}
            </span>
            <button type="button" id="btn-lb-cfg-key" class="seg-option">${keyCount > 0 ? "管理密钥" : "去设置密钥"}</button>
          </div>
          <span class="field-hint">
            第一步仅生成本地断行预览与 <strong>L 列核对备注</strong>（不改云端原表）；人工点击「预览核对」确认无误后，再执行第二步在各语种原表内新建 <code>{原Sheet名}_已断行</code> 并回写总表状态。
          </span>
        </section>

        <div class="rail-cta-footer" style="margin-block-start:auto">
          ${
            store.busy
              ? `
            <div class="progress-strip" role="status" aria-live="polite">
              <div class="field-label-row">
                <span class="field-hint">${esc(store.progressText || "正在批量处理...")}</span>
                <span class="field-hint">${store.progressPercent}%</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width:${store.progressPercent}%"></div>
              </div>
            </div>
            <button type="button" id="btn-pause-linebreak" class="btn btn-block">
              <span>暂停并保存当前断点</span>
            </button>`
              : `
            <button
              type="button"
              id="btn-run-batch-all"
              class="btn btn-primary btn-block"
              ${!q && !lb.masterSheetUrl.trim() ? "disabled" : ""}
            >
              ${icons.play}
              <span>${pausedCount > 0 ? `继续接续处理（断点续跑）` : `开始批量断行预览（不改原表）`}</span>
            </button>
            ${
              readyCount > 0
                ? `<button
                    type="button"
                    id="btn-write-batch-all"
                    class="btn btn-block btn-connected"
                  >
                    ${icons.cloudSync}
                    <span>确认写入 Google 表格 (${readyCount} 个语种)</span>
                  </button>`
                : ""
            }`
          }
        </div>
      </aside>
    `;
  } else {
    const allSpecs = getActiveLineBreakSpecs();
    const tier1 = allSpecs.filter((s) => s.tier === 1);
    const tier2 = allSpecs.filter((s) => s.tier === 2);
    const tier3 = allSpecs.filter((s) => s.tier === 3);

    const renderOpt = (s: (typeof allSpecs)[number]) => {
      const modeTag =
        s.mode === "char"
          ? `${s.singleMax}/${s.doubleMax}字符`
          : `${s.fontFamily} 12pt 尺子`;
      return `<option value="${esc(s.code)}" ${s.code === spec.code ? "selected" : ""}>${esc(s.name)}（${esc(modeTag)}）</option>`;
    };

    const mainHeader = activeSheet
      ? (activeSheet.headerRows[activeSheet.headerRows.length - 1] ?? [])
      : [];
    const formulaColSet = new Set(activeSheet?.detectedFormulaCols ?? []);
    const colCount = activeSheet
      ? Math.max(mainHeader.length, activeSheet.rows[0]?.rawCells.length ?? 0)
      : 0;

    const renderColSelect = (id: string, selectedIdx: number, allowNone: boolean) => {
      const opts: string[] = [];
      if (allowNone) {
        opts.push(`<option value="-1" ${selectedIdx < 0 ? "selected" : ""}>（无 / 不指定）</option>`);
      }
      for (let c = 0; c < colCount; c += 1) {
        const letStr = colIndexToLetters(c);
        const rawLabel = (mainHeader[c] ?? "").trim();
        const label = formulaColSet.has(c) ? "公式列" : rawLabel;
        const text = label ? `${letStr} 列 · ${label.slice(0, 16)}` : `${letStr} 列`;
        opts.push(`<option value="${c}" ${c === selectedIdx ? "selected" : ""}>${esc(text)}</option>`);
      }
      return `<select id="${id}" class="select-input">${opts.join("")}</select>`;
    };

    const ruleSummary =
      spec.mode === "char"
        ? `按字符数断行 · 单行 ≤${spec.singleMax}（微超免断 ≤${spec.softNoBreakMax}）· 同屏双行 ≤${spec.doubleMax}`
        : `按视觉尺子断行 · ${spec.fontFamily} ${spec.fontSizePt}pt Regular${spec.dir === "rtl" ? " · 从右向左 (RTL)" : ""}`;

    const canWriteCloud = Boolean(activeSheet?.sourceSpreadsheetId || lb.outputSheetUrl.trim());
    const syncLabel = lb.outputSheetUrl.trim()
      ? "写入指定 Google 表格"
      : `写回原表 (${activeSheet?.sheetName ?? "Sheet"}_已断行)`;

    container.innerHTML = `
      <aside class="setup-rail" aria-label="字幕断行任务配置">
        <section class="rail-section">
          ${modeSwitcherHtml}
          <div class="field-label-row" style="margin-block-start:0.5rem">
            <h2 class="section-heading">Google 表格与稿件导入</h2>
          </div>

          <div class="rail-form-row rail-form-row-btn">
            <label class="rail-row-label" for="inp-lb-source-url" title="粘贴待断行 Google 表格链接（若含多个 Sheet 会提示您选择）">断行源表</label>
            <input
              id="inp-lb-source-url"
              type="url"
              class="text-input"
              placeholder="粘贴 Google 表格链接"
              value="${esc(lb.sourceSheetUrl)}"
              ${store.busy ? "disabled" : ""}
            />
            <button type="button" id="btn-open-lb-source" class="btn btn-compact" ${!lb.sourceSheetUrl.trim() ? "disabled" : ""}>打开</button>
          </div>

          <div class="btn-row-equal">
            <button type="button" id="btn-lb-load-gsheet" class="btn btn-compact" ${store.busy ? "disabled" : ""}>
              ${icons.cloudSync}
              <span>读取 Google 表格</span>
            </button>
            <label class="btn btn-compact" style="cursor:${store.busy ? "not-allowed" : "pointer"}">
              ${icons.upload}
              <span>导入本地 .xlsx</span>
              <input id="inp-lb-file" type="file" accept=".xlsx,.csv,.tsv" hidden ${store.busy ? "disabled" : ""} />
            </label>
          </div>

          ${
            wb
              ? `<span class="field-hint">当前已载入：<strong>${esc(wb.fileName)}</strong> · ${esc(wb.activeSheetName)}（${activeSheet?.rows.length ?? 0} 行）</span>`
              : ""
          }

          ${
            wb && wb.sheetNames.length > 1
              ? `
            <div class="field-group">
              <label class="field-label" for="sel-lb-sheet">切换工作表 (Sheet)</label>
              <select id="sel-lb-sheet" class="select-input">
                ${wb.sheetNames
                  .map(
                    (sn) =>
                      `<option value="${esc(sn)}" ${sn === wb.activeSheetName ? "selected" : ""}>${esc(sn)}（${wb.sheets[sn]?.rows.length ?? 0} 行）</option>`,
                  )
                  .join("")}
              </select>
            </div>`
              : ""
          }

          <details class="compact-details" ${lb.outputSheetUrl.trim() ? "open" : ""}>
            <summary>另存到其他表格（默认写回原表新建 _已断行）</summary>
            <div class="rail-form-row rail-form-row-btn" style="margin-block-start:0.4rem">
              <label class="rail-row-label" for="inp-lb-output-url">另存链接</label>
              <input
                id="inp-lb-output-url"
                type="url"
                class="text-input"
                placeholder="留空则直接写回原表新建 _已断行"
                value="${esc(lb.outputSheetUrl)}"
                ${store.busy ? "disabled" : ""}
              />
              <button type="button" id="btn-open-lb-output" class="btn btn-compact" ${!lb.outputSheetUrl.trim() ? "disabled" : ""}>打开</button>
            </div>
          </details>
        </section>

        <section class="rail-section">
          <div class="field-label-row">
            <h2 class="section-heading">断行语种与规则</h2>
            <button type="button" id="btn-lb-open-rules" class="seg-option">新增语系/改规则</button>
          </div>
          <div class="field-group">
            <label class="field-label" for="sel-lb-lang">目标断行语种</label>
            <select id="sel-lb-lang" class="select-input">
              <optgroup label="第一梯队 · 常用字符数语种">
                ${tier1.map(renderOpt).join("")}
              </optgroup>
              <optgroup label="常规字符数语种">
                ${tier2.map(renderOpt).join("")}
              </optgroup>
              <optgroup label="按视觉尺子断行 · 特殊文字语种">
                ${tier3.map(renderOpt).join("")}
              </optgroup>
            </select>
            <span class="field-hint">${esc(ruleSummary)}</span>
          </div>

          <label class="checkbox-row">
            <input type="checkbox" id="chk-lb-ai" ${lb.useAi ? "checked" : ""} />
            <span>启用大模型语法/意群精断 + 本地硬规则校验闭环</span>
          </label>
          <div class="field-label-row">
            <span class="field-hint">
              ${keyCount > 0 ? `API 密钥池就绪 (${keyCount} 个密钥)` : "尚未配置 API 密钥"}
            </span>
            <button type="button" id="btn-lb-cfg-key" class="seg-option">${keyCount > 0 ? "管理密钥" : "去设置密钥"}</button>
          </div>
        </section>

        ${
          activeSheet && colCount > 0
            ? `
          <section class="rail-section">
            <details class="compact-details">
              <summary>列映射核对（已识别 ${colIndexToLetters(activeSheet.columnMap.targetCol)} 列为目标字幕，L 列写核对备注）</summary>
              <div class="col-grid-2" style="margin-block-start:0.5rem">
                <div class="field-group">
                  <label class="field-label" for="sel-col-target">目标字幕列 (G)</label>
                  ${renderColSelect("sel-col-target", activeSheet.columnMap.targetCol, false)}
                </div>
                <div class="field-group">
                  <label class="field-label" for="sel-col-role">角色列 (D)</label>
                  ${renderColSelect("sel-col-role", activeSheet.columnMap.characterCol, true)}
                </div>
                <div class="field-group">
                  <label class="field-label" for="sel-col-zh">中文列 (E)</label>
                  ${renderColSelect("sel-col-zh", activeSheet.columnMap.chineseCol, true)}
                </div>
                <div class="field-group">
                  <label class="field-label" for="sel-col-en">英文列 (F)</label>
                  ${renderColSelect("sel-col-en", activeSheet.columnMap.englishCol, true)}
                </div>
              </div>
            </details>
          </section>`
            : ""
        }

        <div class="rail-cta-footer" style="margin-block-start:auto">
          ${
            store.busy
              ? `
            <div class="progress-strip" role="status" aria-live="polite">
              <div class="field-label-row">
                <span class="field-hint">${esc(store.progressText || "正在处理...")}</span>
                <span class="field-hint">${store.progressPercent}%</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" style="width:${store.progressPercent}%"></div>
              </div>
            </div>
            <button type="button" id="btn-pause-linebreak" class="btn btn-block">
              <span>暂停并保存断点</span>
            </button>`
              : `
            <button
              type="button"
              id="btn-run-linebreak"
              class="btn btn-primary btn-block"
              ${!activeSheet && !lb.sourceSheetUrl.trim() ? "disabled" : ""}
            >
              ${icons.play}
              <span>${lb.singlePausedProgress ? `继续接续处理 (${lb.singlePausedProgress.done}/${lb.singlePausedProgress.total})` : `开始自动断行并预览（不改原稿）`}</span>
            </button>`
          }
          <div class="btn-row-equal">
            ${
              lb.run
                ? `<button
                    type="button"
                    id="btn-sync-lb-gsheet"
                    class="btn btn-compact btn-connected"
                    ${store.busy || !canWriteCloud ? "disabled" : ""}
                    title="克隆原表样式写入新建工作表，同名覆盖并写入 L 列核对备注"
                  >${icons.cloudSync}<span>${esc(syncLabel)}</span></button>`
                : ""
            }
            <button
              type="button"
              id="btn-export-linebreak"
              class="btn btn-compact"
              ${store.busy || !lb.run ? "disabled" : ""}
            >
              ${icons.download}
              <span>导出 Excel (.xlsx)</span>
            </button>
          </div>
        </div>
      </aside>
    `;
  }

  const persistUrlsSilently = () => {
    try {
      localStorage.setItem(
        "script_lang_ui_tab_prefs_v1",
        JSON.stringify({
          activeMainTab: store.activeMainTab,
          lbMode: store.lineBreak.mode,
          lbLangCode: store.lineBreak.langCode,
          lbUseAi: store.lineBreak.useAi,
          lbSourceUrl: store.lineBreak.sourceSheetUrl,
          lbOutputUrl: store.lineBreak.outputSheetUrl,
          lbMasterUrl: store.lineBreak.masterSheetUrl,
        }),
      );
    } catch {
      // ignore
    }
  };

  container.querySelectorAll<HTMLButtonElement>("[data-lb-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextMode = btn.dataset.lbMode === "batch" ? "batch" : "single";
      store.lineBreak.mode = nextMode;
      if (nextMode === "batch") {
        store.lineBreak.batchInspectingItemId = null;
      }
      notifyStateChanged();
    });
  });

  const masterInp = container.querySelector<HTMLInputElement>("#inp-lb-master-url");
  const openMasterBtn = container.querySelector<HTMLButtonElement>("#btn-open-lb-master");
  const runBatchBtn = container.querySelector<HTMLButtonElement>("#btn-run-batch-all");
  masterInp?.addEventListener("input", () => {
    const v = masterInp.value.trim();
    store.lineBreak.masterSheetUrl = v;
    if (openMasterBtn) openMasterBtn.disabled = !v;
    if (runBatchBtn && !store.busy) runBatchBtn.disabled = !lb.batchQueue && !v;
    persistUrlsSilently();
  });

  container.querySelector("#btn-open-lb-master")?.addEventListener("click", () => {
    const u = store.lineBreak.masterSheetUrl.trim();
    if (u.startsWith("http")) window.open(u, "_blank", "noopener,noreferrer");
  });

  container.querySelector("#btn-lb-load-master")?.addEventListener("click", actions.onLoadBatchMaster);

  const masterFileInp = container.querySelector<HTMLInputElement>("#inp-lb-master-file");
  masterFileInp?.addEventListener("change", () => {
    const f = masterFileInp.files?.[0];
    if (f) actions.onImportBatchMasterFile(f);
  });

  container.querySelector("#btn-clear-batch-queue")?.addEventListener("click", () => {
    store.lineBreak.batchQueue = null;
    store.lineBreak.batchInspectingItemId = null;
    void saveBatchQueueCheckpoint(null);
    notifyStateChanged();
  });

  container.querySelector("#btn-run-batch-all")?.addEventListener("click", actions.onRunBatchAll);
  container.querySelector("#btn-write-batch-all")?.addEventListener("click", actions.onWriteBatchAll);
  container.querySelector("#btn-pause-linebreak")?.addEventListener("click", actions.onPauseRun);

  const srcInp = container.querySelector<HTMLInputElement>("#inp-lb-source-url");
  const openSrcBtn = container.querySelector<HTMLButtonElement>("#btn-open-lb-source");
  const runBtn = container.querySelector<HTMLButtonElement>("#btn-run-linebreak");
  srcInp?.addEventListener("input", () => {
    const v = srcInp.value.trim();
    store.lineBreak.sourceSheetUrl = v;
    if (openSrcBtn) openSrcBtn.disabled = !v;
    if (runBtn && !store.busy) runBtn.disabled = !activeSheet && !v;
    persistUrlsSilently();
  });

  const outInp = container.querySelector<HTMLInputElement>("#inp-lb-output-url");
  const openOutBtn = container.querySelector<HTMLButtonElement>("#btn-open-lb-output");
  const syncBtn = container.querySelector<HTMLButtonElement>("#btn-sync-lb-gsheet");
  outInp?.addEventListener("input", () => {
    const v = outInp.value.trim();
    store.lineBreak.outputSheetUrl = v;
    if (openOutBtn) openOutBtn.disabled = !v;
    if (syncBtn && !store.busy) {
      syncBtn.disabled = !Boolean(activeSheet?.sourceSpreadsheetId || v);
    }
    persistUrlsSilently();
  });

  container.querySelector("#btn-open-lb-source")?.addEventListener("click", () => {
    const u = store.lineBreak.sourceSheetUrl.trim();
    if (u.startsWith("http")) window.open(u, "_blank", "noopener,noreferrer");
  });

  container.querySelector("#btn-open-lb-output")?.addEventListener("click", () => {
    const u = store.lineBreak.outputSheetUrl.trim();
    if (u.startsWith("http")) window.open(u, "_blank", "noopener,noreferrer");
  });

  container
    .querySelector("#btn-lb-load-gsheet")
    ?.addEventListener("click", actions.onLoadGoogleSheet);

  const fileInp = container.querySelector<HTMLInputElement>("#inp-lb-file");
  fileInp?.addEventListener("change", () => {
    const f = fileInp.files?.[0];
    if (f) actions.onImportFile(f);
  });

  container.querySelector("#btn-lb-cfg-key")?.addEventListener("click", actions.onOpenGeminiDialog);
  container.querySelector("#btn-lb-open-rules")?.addEventListener("click", actions.onOpenLineBreakRules);

  container
    .querySelector<HTMLSelectElement>("#sel-lb-sheet")
    ?.addEventListener("change", (e) => {
      actions.onSwitchSheet((e.currentTarget as HTMLSelectElement).value);
    });

  container
    .querySelector<HTMLSelectElement>("#sel-lb-lang")
    ?.addEventListener("change", (e) => {
      store.lineBreak.langCode = (e.currentTarget as HTMLSelectElement).value;
      store.lineBreak.run = null;
      store.lineBreak.singlePausedProgress = null;
      notifyStateChanged();
    });

  container
    .querySelector<HTMLInputElement>("#chk-lb-ai")
    ?.addEventListener("change", (e) => {
      store.lineBreak.useAi = (e.currentTarget as HTMLInputElement).checked;
      notifyStateChanged();
    });

  const bindCol = (
    selId: string,
    key: "targetCol" | "characterCol" | "chineseCol" | "englishCol",
  ) => {
    container.querySelector<HTMLSelectElement>(selId)?.addEventListener("change", (e) => {
      if (!activeSheet) return;
      activeSheet.columnMap[key] = parseInt((e.currentTarget as HTMLSelectElement).value, 10);
      store.lineBreak.run = null;
      notifyStateChanged();
    });
  };
  bindCol("#sel-col-target", "targetCol");
  bindCol("#sel-col-role", "characterCol");
  bindCol("#sel-col-zh", "chineseCol");
  bindCol("#sel-col-en", "englishCol");

  container.querySelector("#btn-run-linebreak")?.addEventListener("click", () => actions.onRunLineBreak());
  container
    .querySelector("#btn-sync-lb-gsheet")
    ?.addEventListener("click", actions.onSyncGoogleSheet);
  container.querySelector("#btn-export-linebreak")?.addEventListener("click", actions.onExportXlsx);
}

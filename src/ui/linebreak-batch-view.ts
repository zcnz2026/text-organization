import { saveBatchQueueCheckpoint } from "../linebreak/checkpoint-store";
import { getActiveLineBreakSpecs, resolveLineBreakSpec } from "../linebreak/presets";
import type { BatchLineBreakItem } from "../linebreak/types";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LineBreakBatchStageActions {
  onLoadBatchMaster: () => void;
  onConfirmMultiSheets: () => void;
  onRunBatchAll: () => void;
  onRunSingleItem: (itemId: string) => void;
  onWriteBatchAll: () => void;
  onWriteSingleItem: (itemId: string) => void;
  onInspectItem: (itemId: string) => void;
  onExportItemXlsx: (itemId: string) => void;
  onOpenGeminiSettings: () => void;
}

function renderStatusCell(item: BatchLineBreakItem): string {
  switch (item.status) {
    case "pending_confirm_sheet":
      return `<span class="settings-status-pill pill-warn">待选 Sheet (${item.availableTabs.length})</span>`;
    case "queued":
      return `<span class="settings-status-pill pill-muted">待断行预览</span>`;
    case "running":
      return `<span class="settings-status-pill pill-info">断行中 ${item.doneAiRows}/${item.totalAiRows || "..."}</span>`;
    case "paused_key":
      return `<span class="settings-status-pill pill-warn" title="${esc(item.errorMessage ?? "")}">已存断点 (${item.doneAiRows}/${item.totalAiRows})</span>`;
    case "ready_review":
      return `<span class="settings-status-pill pill-info">预览就绪 · 待确认写入</span>`;
    case "completed":
      return item.outputSheetUrl
        ? `<a href="${esc(item.outputSheetUrl)}" target="_blank" rel="noopener noreferrer" class="settings-status-pill pill-ok" style="text-decoration:none" title="点击在浏览器打开新建的工作表">已写入 ${esc(item.outputSheetTitle || "_已断行")} ↗</a>`
        : `<span class="settings-status-pill pill-ok">已写入 ${esc(item.outputSheetTitle || "_已断行")}</span>`;
    case "error":
      return `<span class="settings-status-pill pill-err" title="${esc(item.errorMessage ?? "")}">异常（悬停看原因）</span>`;
  }
}

export function renderLineBreakBatchStage(
  container: HTMLElement,
  actions: LineBreakBatchStageActions,
): void {
  const lb = store.lineBreak;
  const queue = lb.batchQueue;

  const noticeHtml = store.notice
    ? `
      <div class="notice-bar ${store.notice.type === "error" ? "notice-error" : "notice-info"}" role="status">
        <span>${esc(store.notice.message)}</span>
        <button type="button" id="btn-dismiss-batch-notice" class="seg-option">关闭</button>
      </div>`
    : "";

  if (!queue || queue.items.length === 0) {
    container.innerHTML = `
      <main class="inspector-stage" id="linebreak-inspector">
        ${noticeHtml}
        <div class="empty-guide">
          <h2>多语种总表批量断行（先核对预览 · 确认后再写入）</h2>
          <p>按照您的「测试断行」总表格式（<strong>A 列：带语系的表格名称</strong>，<strong>B 列：各语种 Google 表格链接</strong>），安全分两步完成所有语种断行：</p>
          <ol>
            <li><strong>第一步（只读预览，不改云端）</strong>：自动识别各行语种（多 Sheet 自动提醒人工确认），批量生成断行结果与 <code>L</code> 列核对备注；</li>
            <li><strong>第二步（人工抽查核对 → 确认写入）</strong>：点击任意语种的「预览核对」可在右侧原样表中检查微调，确认无误后可<strong>单表确认写入</strong>或<strong>一键全部写入</strong>各自原始表格新建 <code>{原Sheet名}_已断行</code>（同步回写总表 <code>C/D</code> 列状态）；</li>
            <li>若中途 API Key 额度耗尽，自动精确保存行级断点，换上新 Key 后点击「继续接续处理」无缝接着跑。</li>
          </ol>
        </div>
      </main>
    `;
    container.querySelector("#btn-dismiss-batch-notice")?.addEventListener("click", () => {
      store.notice = null;
      notifyStateChanged();
    });
    return;
  }

  const totalCount = queue.items.length;
  const readyCount = queue.items.filter((i) => i.status === "ready_review").length;
  const completedCount = queue.items.filter((i) => i.status === "completed").length;
  const pausedCount = queue.items.filter((i) => i.status === "paused_key").length;
  const unconfirmedCount = queue.items.filter((i) => i.needsSheetConfirm).length;
  const totalReviews = queue.items.reduce((s, i) => s + (i.reviewCount || 0), 0);

  const allSpecs = getActiveLineBreakSpecs();
  const renderLangOptions = (selectedCode: string) =>
    allSpecs
      .map(
        (s) =>
          `<option value="${esc(s.code)}" ${s.code === selectedCode ? "selected" : ""}>${esc(s.name)} (${s.mode === "char" ? `${s.singleMax}/${s.doubleMax}` : "尺子"})</option>`,
      )
      .join("");

  const rowsHtml = queue.items
    .map((item) => {
      const spec = resolveLineBreakSpec(item.langCode);
      const hasMultiTabs = item.availableTabs.length > 1;
      const sheetCellHtml = hasMultiTabs
        ? `
          <div class="batch-inline-cell">
            <select class="select-input select-compact batch-sel-sheet" data-item-id="${esc(item.id)}" ${store.busy ? "disabled" : ""}>
              ${item.availableTabs
                .map(
                  (t) =>
                    `<option value="${t.sheetId}" ${t.sheetId === item.selectedSheetId ? "selected" : ""}>${esc(t.title)}</option>`,
                )
                .join("")}
            </select>
            ${
              item.needsSheetConfirm
                ? `<button type="button" class="btn btn-compact batch-btn-confirm-one" data-item-id="${esc(item.id)}" ${store.busy ? "disabled" : ""}>确认</button>`
                : ""
            }
          </div>`
        : `<span class="batch-sheet-name">${esc(item.selectedSheetTitle || spec.name)}</span>`;

      const hasRunResult =
        item.status === "ready_review" || item.status === "completed" || Boolean(item.cachedRun);
      const reviewCellHtml = hasRunResult
        ? item.reviewCount > 0
          ? `<span class="batch-review-warn">待核对 ${item.reviewCount} 处</span>`
          : `<span class="field-hint">无待核对项</span>`
        : `<span class="field-hint">—</span>`;

      const canWriteThis = item.status === "ready_review";

      return `
        <tr>
          <th scope="row" class="batch-col-num">${item.masterExcelRow}</th>
          <td>
            <div class="batch-title-row">
              <strong class="batch-doc-title" title="${esc(item.label)}">${esc(item.label)}</strong>
              <a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="batch-ext-link" title="在浏览器打开原始 Google 表格">原表 ↗</a>
            </div>
          </td>
          <td>
            <select class="select-input select-compact batch-sel-lang" data-item-id="${esc(item.id)}" ${store.busy ? "disabled" : ""}>
              ${renderLangOptions(spec.code)}
            </select>
          </td>
          <td>${sheetCellHtml}</td>
          <td>
            ${renderStatusCell(item)}
            ${
              item.errorMessage
                ? `<div class="batch-err-subtext" title="${esc(item.errorMessage)}">${esc(item.errorMessage)}</div>`
                : ""
            }
          </td>
          <td>${reviewCellHtml}</td>
          <td class="batch-actions-td">
            <div class="batch-actions-row">
              <button
                type="button"
                class="btn btn-compact ${item.status === "ready_review" ? "btn-primary" : ""} batch-btn-preview"
                data-item-id="${esc(item.id)}"
                ${store.busy ? "disabled" : ""}
              >预览核对</button>
              ${
                canWriteThis
                  ? `<button type="button" class="btn btn-compact btn-connected batch-btn-write-one" data-item-id="${esc(item.id)}" ${store.busy ? "disabled" : ""} title="确认无误，写入该原始表格新建 _已断行">确认写入</button>`
                  : ""
              }
              ${
                hasRunResult
                  ? `<button type="button" class="btn btn-compact batch-btn-xlsx" data-item-id="${esc(item.id)}" ${store.busy ? "disabled" : ""} title="下载本地 .xlsx 文件">导出.xlsx</button>`
                  : ""
              }
              <button type="button" class="btn btn-compact batch-btn-rerun" data-item-id="${esc(item.id)}" ${store.busy ? "disabled" : ""}>
                ${item.status === "paused_key" ? "续跑" : hasRunResult ? "重跑" : "单跑"}
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <main class="inspector-stage" id="linebreak-inspector">
      ${noticeHtml}

      ${
        unconfirmedCount > 0
          ? `<div class="notice-bar notice-info" role="region" aria-label="多工作表确认提示">
              <span>检测到 <strong>${unconfirmedCount}</strong> 个语种表格内含有多个工作表，请先人工确认要断行的 Sheet。</span>
              <button type="button" id="btn-open-multisheet-confirm" class="btn btn-compact btn-primary" ${store.busy ? "disabled" : ""}>集中确认多工作表 (${unconfirmedCount})</button>
            </div>`
          : ""
      }

      ${
        pausedCount > 0 && !store.busy
          ? `<div class="notice-bar notice-error" role="region" aria-label="断点接续提示">
              <span>当前有 <strong>${pausedCount}</strong> 个语种保存在中途断点（已完成的行不会重复消耗额度）。补充或更换可用 API Key 后即可无缝接续处理！</span>
              <div style="display:flex;gap:0.4rem;flex-shrink:0">
                <button type="button" id="btn-batch-open-keys" class="btn btn-compact">${icons.key}<span>更换/添加 Key</span></button>
                <button type="button" id="btn-batch-resume-now" class="btn btn-compact btn-primary">${icons.play}<span>继续接续处理</span></button>
              </div>
            </div>`
          : ""
      }

      <div class="batch-queue-header">
        <div class="batch-summary-left">
          <strong class="batch-queue-title">批量总表队列${queue.masterSheetTitle ? ` · ${esc(queue.masterSheetTitle)}` : ""}</strong>
          <span class="col-chip">共 ${totalCount} 个语种</span>
          ${readyCount > 0 ? `<span class="col-chip">待确认写入 ${readyCount}</span>` : ""}
          <span class="col-chip">已写入 ${completedCount}/${totalCount}</span>
          <span class="col-chip">L列待核对 ${totalReviews} 处</span>
        </div>
        ${
          readyCount > 0
            ? `<button type="button" id="btn-batch-write-all-top" class="btn btn-compact btn-connected" ${store.busy ? "disabled" : ""}>
                ${icons.cloudSync}
                <span>确认写入全部已断行表格 (${readyCount})</span>
              </button>`
            : ""
        }
      </div>

      <div tabindex="0" role="region" aria-labelledby="batch-queue-caption" class="table-wrapper">
        <table class="batch-queue-table font-${store.tableFontSize}">
          <caption id="batch-queue-caption">多语种批量断行任务队列</caption>
          <colgroup>
            <col style="inline-size:58px" />
            <col style="inline-size:220px" />
            <col style="inline-size:158px" />
            <col style="inline-size:160px" />
            <col style="inline-size:175px" />
            <col style="inline-size:120px" />
            <col style="inline-size:275px" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="batch-col-num">行号</th>
              <th scope="col">A列 表格名称</th>
              <th scope="col">断行语种</th>
              <th scope="col">源工作表</th>
              <th scope="col">当前状态</th>
              <th scope="col">L列核对备注</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </main>
  `;

  container.querySelector("#btn-dismiss-batch-notice")?.addEventListener("click", () => {
    store.notice = null;
    notifyStateChanged();
  });

  container.querySelector("#btn-open-multisheet-confirm")?.addEventListener("click", () => {
    actions.onConfirmMultiSheets();
  });

  container.querySelector("#btn-batch-open-keys")?.addEventListener("click", () => {
    actions.onOpenGeminiSettings();
  });

  container.querySelector("#btn-batch-resume-now")?.addEventListener("click", () => {
    actions.onRunBatchAll();
  });

  container.querySelector("#btn-batch-write-all-top")?.addEventListener("click", () => {
    actions.onWriteBatchAll();
  });

  container.querySelectorAll<HTMLSelectElement>(".batch-sel-lang").forEach((sel) => {
    sel.addEventListener("change", () => {
      const item = queue.items.find((i) => i.id === sel.dataset.itemId);
      if (item) {
        item.langCode = sel.value;
        item.langDetected = true;
        void saveBatchQueueCheckpoint(queue);
        notifyStateChanged();
      }
    });
  });

  container.querySelectorAll<HTMLSelectElement>(".batch-sel-sheet").forEach((sel) => {
    sel.addEventListener("change", () => {
      const item = queue.items.find((i) => i.id === sel.dataset.itemId);
      if (item) {
        const chosenId = Number(sel.value);
        item.selectedSheetId = chosenId;
        const tab = item.availableTabs.find((t) => t.sheetId === chosenId);
        if (tab) item.selectedSheetTitle = tab.title;
        item.needsSheetConfirm = false;
        if (item.status === "pending_confirm_sheet") item.status = "queued";
        void saveBatchQueueCheckpoint(queue);
        notifyStateChanged();
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".batch-btn-confirm-one").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = queue.items.find((i) => i.id === btn.dataset.itemId);
      if (item) {
        item.needsSheetConfirm = false;
        if (item.status === "pending_confirm_sheet") item.status = "queued";
        void saveBatchQueueCheckpoint(queue);
        notifyStateChanged();
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".batch-btn-preview").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.itemId;
      if (id) actions.onInspectItem(id);
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".batch-btn-write-one").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.itemId;
      if (id) actions.onWriteSingleItem(id);
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".batch-btn-xlsx").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.itemId;
      if (id) actions.onExportItemXlsx(id);
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".batch-btn-rerun").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.itemId;
      if (id) actions.onRunSingleItem(id);
    });
  });
}

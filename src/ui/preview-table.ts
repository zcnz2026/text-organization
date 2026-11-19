import { classifyScriptTasks } from "../engine/classifier";
import { diagLog } from "../platform/diag-log";
import type { ProcessedRowResult } from "../types/domain";
import { icons } from "./icons";
import {
  notifyStateChanged,
  type RowFilterMode,
  store,
  type TableFontSize,
} from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimeRange(inTime: string, outTime: string): string {
  const a = inTime.trim();
  const b = outTime.trim();
  if (!a && !b) return "—";
  const short = (t: string) => (t.length >= 8 ? t.slice(0, 8) : t);
  return b ? `${short(a)}\n${short(b)}` : short(a);
}

function wireTablistArrowKeys(tablist: HTMLElement): void {
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  tabs.forEach((tab, idx) => {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(idx + delta + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });
}

export function renderPreviewStage(
  container: HTMLElement,
  actions: {
    onLoadSampleDemo: () => void;
  },
): void {
  const noticeHtml = store.notice
    ? `
      <div class="notice-bar ${store.notice.type === "error" ? "notice-error" : "notice-info"}" role="status">
        <span>${esc(store.notice.message)}</span>
        <div style="display:flex;gap:0.35rem;flex-shrink:0">
          ${store.notice.type === "error" ? '<button type="button" id="btn-export-diag" class="seg-option">导出日志</button>' : ""}
          <button type="button" id="btn-dismiss-notice" class="seg-option" aria-label="关闭提示">关闭</button>
        </div>
      </div>
    `
    : "";

  if (!store.scriptDoc) {
    container.innerHTML = `
      <main id="inspector-main" class="inspector-stage">
        ${noticeHtml}
        <div class="empty-guide">
          <h2>准备开始多语种剧本摘录</h2>
          <p>按以下三步即可批量生成各语种工作表并直接写入 Google 表格：</p>
          <ol>
            <li>点击顶部「Google OAuth 授权」，选择你准备好的 OAuth 2.0 客户端 <code>.json</code> 文件并完成浏览器邮箱登录；</li>
            <li>在左侧粘贴源剧本链接与专用输出表格链接，点击「读取云端源稿与语种」；</li>
            <li>勾选需要生成的语种，点击「开始提取并写入 Google 表格」，右侧可逐行核对与点击微调。</li>
          </ol>
          <div style="display:flex;gap:0.65rem;flex-wrap:wrap;padding-block-start:0.4rem">
            <button type="button" id="btn-load-demo" class="btn">
              ${icons.sparkle}
              <span>载入 39 期演示样本预览效果</span>
            </button>
          </div>
        </div>
      </main>
    `;
    container
      .querySelector("#btn-export-diag")
      ?.addEventListener("click", () => diagLog.downloadLogFile());
    container
      .querySelector("#btn-dismiss-notice")
      ?.addEventListener("click", () => {
        store.notice = null;
        notifyStateChanged();
      });
    container
      .querySelector("#btn-load-demo")
      ?.addEventListener("click", actions.onLoadSampleDemo);
    return;
  }

  const doc = store.scriptDoc;
  const runLangs = [...store.runsByLang.keys()];
  const activeLang =
    runLangs.includes(store.activePreviewLang)
      ? store.activePreviewLang
      : runLangs[0] || "";
  const activeRun = activeLang ? store.runsByLang.get(activeLang) : undefined;

  const extractableRowSet = new Set<number>();
  for (const t of classifyScriptTasks(doc.rows)) {
    for (const idx of t.rowIndices) extractableRowSet.add(idx);
    if (t.citationRowIndex !== undefined) extractableRowSet.add(t.citationRowIndex);
  }

  const query = store.searchQuery.trim().toLowerCase();
  const visibleRows = doc.rows.filter((r) => {
    const res = activeRun?.rows[r.rowIndex];
    if (store.rowFilter === "extractable" && !extractableRowSet.has(r.rowIndex)) {
      return false;
    }
    if (store.rowFilter === "matched" && res?.status !== "matched") {
      return false;
    }
    if (
      store.rowFilter === "review" &&
      res?.status !== "warning" &&
      res?.status !== "missing"
    ) {
      return false;
    }
    if (query) {
      const hay = `${r.line} ${r.chinese} ${r.english} ${res?.targetLanguage ?? ""} ${res?.hint ?? ""} ${r.filterCategory}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const matchedTotal = activeRun?.matchedCount ?? 0;
  const reviewTotal = (activeRun?.warningCount ?? 0) + (activeRun?.missingCount ?? 0);

  const langTabsHtml =
    runLangs.length > 0
      ? `
        <div class="tablist-scroller" role="tablist" aria-label="语种结果切换">
          ${runLangs
            .map((lang, idx) => {
              const r = store.runsByLang.get(lang)!;
              const warnSum = r.warningCount + r.missingCount;
              const suffix = warnSum > 0 ? ` · ${warnSum}待核` : ` · ${r.matchedCount}`;
              return `<button type="button" id="lang-tab-${idx}" role="tab" class="tab-btn" data-lang-tab="${esc(lang)}" aria-selected="${lang === activeLang}">${esc(lang)}${esc(suffix)}</button>`;
            })
            .join("")}
        </div>
      `
      : `<div style="padding-block:0.5rem;font-weight:600">${esc(doc.title)}${store.isDemoData ? "（合成演示数据）" : ""}</div>`;

  const filterTabs: Array<{ id: RowFilterMode; label: string }> = [
    { id: "extractable", label: `待摘录行 (${extractableRowSet.size})` },
    { id: "all", label: `全部行 (${doc.rows.length})` },
    { id: "matched", label: `已匹配 (${matchedTotal})` },
    { id: "review", label: `需复查 (${reviewTotal})` },
  ];

  const rowsHtml = visibleRows
    .slice(0, 400)
    .map((r) => {
      const res: ProcessedRowResult = activeRun?.rows[r.rowIndex] ?? {
        rowIndex: r.rowIndex,
        targetLanguage: r.targetLanguage,
        note: r.note,
        status: "untouched",
        hint: "",
      };
      const cellCls =
        res.status === "missing"
          ? "cell-missing"
          : res.status === "warning"
            ? "cell-warning"
            : res.status === "matched"
              ? "cell-matched"
              : "";
      const statusLabel =
        res.status === "missing"
          ? `<span class="status-text-missing">${esc(res.hint || "未找到")}</span>`
          : res.status === "warning"
            ? `<span class="status-text-warning">${esc(res.hint || "请核对")}</span>`
            : res.status === "matched"
              ? `<span class="status-text-matched">${esc(res.hint || "已精准提取")}</span>`
              : `<span class="field-hint">${esc(r.filterCategory || "常规台词")}</span>`;

      const plainHint =
        res.status === "missing"
          ? res.hint || "未找到"
          : res.status === "warning"
            ? res.hint || "请核对"
            : res.status === "matched"
              ? res.hint || "已精准提取"
              : r.filterCategory || "常规台词";
      const timeText = formatTimeRange(r.inTime, r.outTime);

      return `
        <tr>
          <th scope="row" title="${esc(r.line || `#${r.rowIndex + 1}`)}">${esc(r.line || `#${r.rowIndex + 1}`)}</th>
          <td data-col="时间轴" class="cell-timecode" title="${esc(timeText)}">${esc(store.tableWrapMode === "nowrap" ? timeText.replace(/\n/g, " ~ ") : timeText)}</td>
          <td data-col="角色/类型" title="${esc(r.character)}">${esc(r.character)}</td>
          <td data-col="中文原稿" title="${esc(r.chinese)}">${esc(r.chinese)}</td>
          <td data-col="English 底稿" class="col-source-end" title="${esc(r.english)}">${esc(r.english)}</td>
          <td data-col="目标语种译文" class="${cellCls}" title="${esc(res.targetLanguage)}">
            <div class="editable-cell" contenteditable="${Boolean(activeRun)}" data-edit-row="${r.rowIndex}" data-edit-field="targetLanguage" spellcheck="false">${esc(res.targetLanguage)}</div>
          </td>
          <td data-col="Note" title="${esc(res.note)}">
            <div class="editable-cell" contenteditable="${Boolean(activeRun)}" data-edit-row="${r.rowIndex}" data-edit-field="note" spellcheck="false">${esc(res.note)}</div>
          </td>
          <td data-col="工具提示" class="${cellCls}" title="${esc(plainHint)}">${statusLabel}</td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <main id="inspector-main" class="inspector-stage">
      ${noticeHtml}
      <div class="inspector-header">
        ${langTabsHtml}
        <div class="tablist-scroller" role="tablist" aria-label="行状态筛选">
          ${filterTabs
            .map(
              (f) =>
                `<button type="button" id="flt-tab-${f.id}" role="tab" class="tab-btn" data-filter-tab="${f.id}" aria-selected="${store.rowFilter === f.id}">${esc(f.label)}</button>`,
            )
            .join("")}
        </div>
      </div>

      <div id="script-tabpanel" role="tabpanel" aria-label="剧本对照检视内容">
        <div class="inspector-toolbar">
          <span class="field-hint">
            当前剧本：${esc(doc.title)}${store.isDemoData ? " · 合成演示" : ""} · 显示 ${visibleRows.length} 行（表头右边缘可拖动调宽）
          </span>
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
            <div class="segmented" role="group" aria-label="行显示方式">
              <button type="button" class="seg-option" data-wrap-mode="nowrap" aria-pressed="${store.tableWrapMode === "nowrap"}">单行紧凑</button>
              <button type="button" class="seg-option" data-wrap-mode="wrap" aria-pressed="${store.tableWrapMode === "wrap"}">自动换行</button>
            </div>
            <div class="segmented" role="group" aria-label="表格字号">
              <button type="button" class="seg-option" data-font-size="sm" aria-pressed="${store.tableFontSize === "sm"}">小字</button>
              <button type="button" class="seg-option" data-font-size="md" aria-pressed="${store.tableFontSize === "md"}">中字</button>
              <button type="button" class="seg-option" data-font-size="lg" aria-pressed="${store.tableFontSize === "lg"}">大字</button>
            </div>
            <div style="display:flex;align-items:center;gap:0.4rem;min-inline-size:180px;max-inline-size:260px">
              ${icons.search}
              <input id="inp-table-search" type="search" class="text-input" placeholder="搜索行号、原文或提示..." value="${esc(store.searchQuery)}" />
            </div>
          </div>
        </div>

        <div tabindex="0" role="region" aria-labelledby="script-table-caption" class="table-wrapper">
          <table class="script-table ${store.tableWrapMode === "nowrap" ? "is-nowrap" : "is-wrap"} font-${store.tableFontSize}">
            <caption id="script-table-caption">${esc(doc.title)} 摘录对照检视表</caption>
            <colgroup>
              ${store.tableColWidths.map((w, idx) => `<col data-col-idx="${idx}" style="inline-size:${w}px" />`).join("")}
            </colgroup>
            <thead>
              <tr>
                ${[
                  "行号",
                  "时间轴",
                  "角色/类型",
                  "中文原稿",
                  "English 底稿",
                  activeLang ? `${activeLang}（摘录结果）` : "Target Language",
                  "Note（提前贴上）",
                  "【工具提示】",
                ]
                  .map(
                    (label, idx) =>
                      `<th${idx === 4 ? ' class="col-source-end"' : ""}><span>${esc(label)}</span><span class="col-resizer" data-resize-col="${idx}" title="按住左右拖动调整列宽"></span></th>`,
                  )
                  .join("")}
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">当前筛选条件下没有匹配的行</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  `;

  container.querySelectorAll<HTMLElement>('[role="tablist"]').forEach(wireTablistArrowKeys);

  container
    .querySelector("#btn-export-diag")
    ?.addEventListener("click", () => diagLog.downloadLogFile());

  container
    .querySelector("#btn-dismiss-notice")
    ?.addEventListener("click", () => {
      store.notice = null;
      notifyStateChanged();
    });

  container.querySelectorAll<HTMLButtonElement>("[data-lang-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.activePreviewLang = btn.dataset.langTab ?? "";
      btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      notifyStateChanged();
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-filter-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.rowFilter = (btn.dataset.filterTab as RowFilterMode) ?? "all";
      btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      notifyStateChanged();
    });
  });

  const searchEl = container.querySelector<HTMLInputElement>("#inp-table-search");
  searchEl?.addEventListener("input", () => {
    store.searchQuery = searchEl.value;
    renderPreviewStage(container, actions);
    const nextSearch = container.querySelector<HTMLInputElement>("#inp-table-search");
    if (nextSearch) {
      nextSearch.focus();
      nextSearch.setSelectionRange(nextSearch.value.length, nextSearch.value.length);
    }
  });

  container.querySelectorAll<HTMLButtonElement>("[data-wrap-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.tableWrapMode = btn.dataset.wrapMode === "wrap" ? "wrap" : "nowrap";
      notifyStateChanged();
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-font-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.tableFontSize = (btn.dataset.fontSize as TableFontSize) || "sm";
      notifyStateChanged();
    });
  });

  container.querySelectorAll<HTMLElement>("[data-resize-col]").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const idx = Number(handle.dataset.resizeCol);
      const startX = e.clientX;
      const startW = store.tableColWidths[idx] ?? 160;
      const colEl = container.querySelector<HTMLElement>(`col[data-col-idx="${idx}"]`);
      handle.classList.add("is-dragging");
      const onMove = (ev: PointerEvent) => {
        const nextW = Math.max(48, Math.min(720, Math.round(startW + (ev.clientX - startX))));
        store.tableColWidths[idx] = nextW;
        if (colEl) colEl.style.inlineSize = `${nextW}px`;
      };
      const onUp = () => {
        handle.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });

  if (activeRun) {
    container.querySelectorAll<HTMLElement>("[data-edit-row]").forEach((cell) => {
      cell.addEventListener("blur", () => {
        const rIdx = Number(cell.dataset.editRow);
        const field = cell.dataset.editField as "targetLanguage" | "note";
        const targetRow = activeRun.rows[rIdx];
        if (!targetRow) return;
        targetRow[field] = cell.innerText;
      });
    });
  }
}

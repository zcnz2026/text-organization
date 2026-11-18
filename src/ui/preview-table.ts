import { classifyScriptTasks } from "../engine/classifier";
import type { ProcessedRowResult } from "../types/domain";
import { icons } from "./icons";
import { notifyStateChanged, type RowFilterMode, store } from "./state";

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
        <button type="button" id="btn-dismiss-notice" class="seg-option" aria-label="关闭提示">关闭</button>
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

      return `
        <tr>
          <th scope="row">${esc(r.line || `#${r.rowIndex + 1}`)}</th>
          <td data-col="时间轴" class="cell-timecode cell-pre">${esc(formatTimeRange(r.inTime, r.outTime))}</td>
          <td data-col="角色/类型">${esc(r.character)}</td>
          <td data-col="中文原稿" class="cell-pre">${esc(r.chinese)}</td>
          <td data-col="English 底稿" class="cell-pre col-source-end">${esc(r.english)}</td>
          <td data-col="目标语种译文" class="cell-pre ${cellCls}">
            <div class="editable-cell" contenteditable="${Boolean(activeRun)}" data-edit-row="${r.rowIndex}" data-edit-field="targetLanguage" spellcheck="false">${esc(res.targetLanguage)}</div>
          </td>
          <td data-col="Note" class="cell-pre">
            <div class="editable-cell" contenteditable="${Boolean(activeRun)}" data-edit-row="${r.rowIndex}" data-edit-field="note" spellcheck="false">${esc(res.note)}</div>
          </td>
          <td data-col="工具提示" class="${cellCls}">${statusLabel}</td>
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
            当前剧本：${esc(doc.title)}${store.isDemoData ? " · 合成演示样本（可直接加载真实表格替换）" : ""} · 显示 ${visibleRows.length} 行${activeRun ? "（点击目标语种单元格可直接微调，完成后点左侧「写回审校结果」）" : ""}
          </span>
          <div style="display:flex;align-items:center;gap:0.45rem;min-inline-size:0;flex:1 1 200px;max-inline-size:320px">
            ${icons.search}
            <input id="inp-table-search" type="search" class="text-input" placeholder="搜索行号、原文、篇目或提示..." value="${esc(store.searchQuery)}" />
          </div>
        </div>

        <div tabindex="0" role="region" aria-labelledby="script-table-caption" class="table-wrapper">
          <table class="script-table">
            <caption id="script-table-caption">${esc(doc.title)} 摘录对照检视表</caption>
            <thead>
              <tr>
                <th>行号</th>
                <th style="inline-size:84px">时间轴</th>
                <th style="min-inline-size:126px">角色/类型</th>
                <th style="inline-size:20%">中文原稿</th>
                <th style="inline-size:20%" class="col-source-end">English 底稿</th>
                <th style="inline-size:23%">${esc(activeLang ? `${activeLang}（摘录结果）` : "Target Language")}</th>
                <th style="inline-size:14%">Note（提前贴上）</th>
                <th style="inline-size:145px">【工具提示】</th>
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

import { diagLog } from "../platform/diag-log";
import type { LanguageRunOutput, ScriptSheetDocument } from "../types/domain";
import { icons } from "./icons";

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function openMissingLogDialog(
  doc: ScriptSheetDocument,
  activeLang: string,
  runOut?: LanguageRunOutput,
): void {
  let dlg = document.querySelector<HTMLDialogElement>("#dlg-missing-log");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-missing-log";
    dlg.className = "dialog-wide";
    dlg.setAttribute("closedby", "any");
    document.body.append(dlg);
  }

  const missingRows = runOut ? runOut.rows.filter((r) => r.status === "missing") : [];
  const warningRows = runOut ? runOut.rows.filter((r) => r.status === "warning") : [];

  const formatLine = (r: { rowIndex: number; hint: string; status: string }) => {
    const src = doc.rows[r.rowIndex];
    const lineNo = src?.line || `#${r.rowIndex + 1}`;
    const srcText = (src?.chinese || src?.english || "").replace(/\s+/g, " ").trim();
    const cat = src?.filterCategory ? ` [${src.filterCategory}]` : "";
    const tag = r.status === "missing" ? "未找到" : "需核对";
    return `行 ${lineNo}${cat} (${tag}) | 原文: ${srcText.slice(0, 60)} | 原因: ${r.hint || "未匹配"}`;
  };

  const plainReport = [
    `=== ${doc.title} · ${activeLang || "当前语种"} 缺失与核对日志 ===`,
    `未找到: ${missingRows.length} 行 | 需核对: ${warningRows.length} 行`,
    "",
    ...missingRows.map(formatLine),
    ...(warningRows.length > 0 ? ["", "--- 需核对行 ---", ...warningRows.map(formatLine)] : []),
  ].join("\n");

  const rowsHtml = [...missingRows, ...warningRows]
    .map((r) => {
      const src = doc.rows[r.rowIndex];
      const lineNo = src?.line || `#${r.rowIndex + 1}`;
      const srcText = (src?.chinese || src?.english || "").replace(/\s+/g, " ").trim();
      const cls = r.status === "missing" ? "status-text-missing" : "status-text-warning";
      return `<tr><td class="mono-cell">${esc(lineNo)}</td><td><span class="${cls}">${r.status === "missing" ? "未找到" : "需核对"}</span></td><td>${esc(src?.filterCategory || "—")}</td><td>${esc(srcText.slice(0, 56))}</td><td>${esc(r.hint || "—")}</td></tr>`;
    })
    .join("");

  dlg.innerHTML = `
    <div class="dialog-header">
      <h2 class="dialog-title">缺失与核对诊断日志 · ${esc(activeLang || doc.title)}</h2>
      <button type="button" class="seg-option" data-close-mlog aria-label="关闭窗口">${icons.close}</button>
    </div>
    <div class="dialog-body">
      <div class="btn-row-compact" style="justify-content:space-between">
        <span class="field-hint">未找到 <strong>${missingRows.length}</strong> 行 · 需核对 <strong>${warningRows.length}</strong> 行（详细运行日志已同步写入本地 <code>logs/workbench.log</code>）</span>
        <div class="btn-row-compact">
          <button type="button" id="btn-copy-mlog" class="btn btn-compact">复制明细</button>
          <button type="button" id="btn-dl-mlog" class="btn btn-compact btn-primary">${icons.download}<span>下载诊断日志 (.log)</span></button>
        </div>
      </div>
      <div class="spec-table-wrap">
        <table class="spec-table">
          <thead><tr><th>行号</th><th>状态</th><th>筛选列</th><th>中文/英文原文</th><th>未找到原因与建议</th></tr></thead>
          <tbody>${rowsHtml || `<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--text-muted)">太棒了！当前语种没有未找到或需核对的行。</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;

  dlg.querySelector("[data-close-mlog]")?.addEventListener("click", () => dlg?.close());
  dlg.querySelector("#btn-dl-mlog")?.addEventListener("click", () => diagLog.downloadLogFile());
  dlg.querySelector("#btn-copy-mlog")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(plainReport);
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制明细"), 1500);
    } catch {
      btn.textContent = "复制失败";
    }
  });

  if (!dlg.open) dlg.showModal();
}

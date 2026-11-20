import type { BatchLineBreakItem, SheetTabCandidate } from "../linebreak/types";
import { icons } from "./icons";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let sharedPickerDialog: HTMLDialogElement | null = null;

function ensurePickerDialog(): HTMLDialogElement {
  if (sharedPickerDialog && document.body.contains(sharedPickerDialog)) {
    return sharedPickerDialog;
  }
  const dlg = document.createElement("dialog");
  dlg.id = "dlg-lb-sheet-picker";
  dlg.setAttribute("aria-labelledby", "dlg-lb-sheet-picker-title");
  dlg.setAttribute("closedby", "any");
  document.body.append(dlg);
  sharedPickerDialog = dlg;
  return dlg;
}

/**
 * Prompts the user to pick one worksheet when a single Google Sheet contains multiple candidate tabs.
 * Returns the chosen `sheetId`, or `null` if cancelled.
 */
export function promptSingleSheetSelection(
  spreadsheetTitle: string,
  tabs: SheetTabCandidate[],
  defaultSheetId: number | null,
): Promise<number | null> {
  const dlg = ensurePickerDialog();
  const initialId =
    defaultSheetId !== null && tabs.some((t) => t.sheetId === defaultSheetId)
      ? defaultSheetId
      : (tabs[0]?.sheetId ?? 0);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: number | null) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(val);
    };

    dlg.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-lb-sheet-picker-title" class="dialog-title">检测到多个工作表 · 请选择待断行 Sheet</h2>
        <button type="button" class="seg-option" data-cancel-picker aria-label="关闭">${icons.close}</button>
      </div>
      <div class="dialog-body">
        <p class="field-hint" style="margin-block-end:0.75rem">
          表格 <strong>${esc(spreadsheetTitle)}</strong> 中包含 ${tabs.length} 个工作表，请人工确认本次要读取并断行的工作表：
        </p>
        <div class="settings-list" role="radiogroup" aria-label="工作表列表">
          ${tabs
            .map(
              (t) => `
            <label class="settings-item-row" style="cursor:pointer">
              <div style="display:flex;align-items:center;gap:0.6rem">
                <input type="radio" name="single-sheet-pick" value="${t.sheetId}" ${t.sheetId === initialId ? "checked" : ""} />
                <strong>${esc(t.title)}</strong>
                ${t.sheetId === defaultSheetId ? `<span class="settings-status-pill pill-ok">链接指定 gid</span>` : ""}
              </div>
              <span class="field-hint">gid=${t.sheetId}</span>
            </label>`,
            )
            .join("")}
        </div>
      </div>
      <div class="dialog-footer" style="display:flex;justify-content:flex-end;gap:0.5rem;padding:0.75rem 1.25rem;border-block-start:1px solid var(--border-subtle)">
        <button type="button" class="btn" data-cancel-picker>取消</button>
        <button type="button" class="btn btn-primary" id="btn-confirm-single-sheet">确认使用所选 Sheet</button>
      </div>
    `;

    dlg.querySelectorAll("[data-cancel-picker]").forEach((el) => {
      el.addEventListener("click", () => finish(null));
    });
    dlg.querySelector("#btn-confirm-single-sheet")?.addEventListener("click", () => {
      const checked = dlg.querySelector<HTMLInputElement>('input[name="single-sheet-pick"]:checked');
      finish(checked ? Number(checked.value) : initialId);
    });
    dlg.addEventListener("close", () => finish(null), { once: true });

    dlg.showModal();
  });
}

/**
 * Prompts the user to review and confirm target sheets for all batch items whose Google Sheet
 * contains multiple candidate worksheets (Requirement #3).
 */
export function promptBatchMultiSheetConfirmation(
  multiSheetItems: BatchLineBreakItem[],
): Promise<Map<string, number> | null> {
  if (multiSheetItems.length === 0) {
    return Promise.resolve(new Map());
  }
  const dlg = ensurePickerDialog();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: Map<string, number> | null) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(val);
    };

    dlg.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-lb-sheet-picker-title" class="dialog-title">多工作表人工确认（共 ${multiSheetItems.length} 个表格含多个 Sheet）</h2>
        <button type="button" class="seg-option" data-cancel-batch-picker aria-label="关闭">${icons.close}</button>
      </div>
      <div class="dialog-body">
        <p class="field-hint" style="margin-block-end:0.75rem">
          以下语种原始表格中含有多个工作表，请逐一确认要断行的源工作表（处理完成后将在同表格内新建 <code>{所选Sheet}_已断行</code>）：
        </p>
        <div class="settings-list" style="max-block-size:58vh;overflow-y:auto">
          ${multiSheetItems
            .map(
              (item) => `
            <div class="settings-item-row" style="gap:1rem">
              <div class="settings-item-meta">
                <div class="settings-item-title">
                  <span>第 ${item.masterExcelRow} 行 · <strong>${esc(item.label)}</strong></span>
                </div>
                <span class="field-hint">文档名：${esc(item.spreadsheetTitle)}（共 ${item.availableTabs.length} 个候选 Sheet）</span>
              </div>
              <select class="select-input" data-batch-item-sheet="${esc(item.id)}" style="min-inline-size:190px;max-inline-size:260px">
                ${item.availableTabs
                  .map(
                    (t) =>
                      `<option value="${t.sheetId}" ${t.sheetId === item.selectedSheetId ? "selected" : ""}>${esc(t.title)} (gid=${t.sheetId})</option>`,
                  )
                  .join("")}
              </select>
            </div>`,
            )
            .join("")}
        </div>
      </div>
      <div class="dialog-footer" style="display:flex;justify-content:flex-end;gap:0.5rem;padding:0.75rem 1.25rem;border-block-start:1px solid var(--border-subtle)">
        <button type="button" class="btn" data-cancel-batch-picker>稍后手动选</button>
        <button type="button" class="btn btn-primary" id="btn-confirm-batch-sheets">确认以上工作表选择</button>
      </div>
    `;

    dlg.querySelectorAll("[data-cancel-batch-picker]").forEach((el) => {
      el.addEventListener("click", () => finish(null));
    });
    dlg.querySelector("#btn-confirm-batch-sheets")?.addEventListener("click", () => {
      const map = new Map<string, number>();
      dlg.querySelectorAll<HTMLSelectElement>("select[data-batch-item-sheet]").forEach((sel) => {
        const id = sel.dataset.batchItemSheet!;
        map.set(id, Number(sel.value));
      });
      finish(map);
    });
    dlg.addEventListener("close", () => finish(null), { once: true });

    dlg.showModal();
  });
}

import {
  DEFAULT_SOURCE_COL_CONFIG,
  indexToColLetter,
  type SourceScriptColumnConfig,
} from "../types/schema-config";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COL_FIELDS: Array<{
  key: Exclude<
    keyof SourceScriptColumnConfig,
    "autoDetectByHeader" | "headerRowNumber" | "outputHintCol"
  >;
  label: string;
  defaultCol: string;
}> = [
  { key: "lineCol", label: "Line (A)", defaultCol: "A" },
  { key: "inTimeCol", label: "In Time (B)", defaultCol: "B" },
  { key: "outTimeCol", label: "Out Time (C)", defaultCol: "C" },
  { key: "characterCol", label: "Character (D)", defaultCol: "D" },
  { key: "chineseCol", label: "Chinese (E)", defaultCol: "E" },
  { key: "englishCol", label: "English底 (F)", defaultCol: "F" },
  { key: "targetLangCol", label: "Target Language (G)", defaultCol: "G" },
  { key: "noteCol", label: "Note (H)", defaultCol: "H" },
  { key: "remarkCol", label: "备注 (I)", defaultCol: "I" },
  { key: "sendRemarkCol", label: "送翻备注 (J)", defaultCol: "J" },
  { key: "filterCol", label: "筛选列 (K)", defaultCol: "K" },
  { key: "needExtractCol", label: "需要摘 (L)", defaultCol: "L" },
];

export function mountSourceColsDialog(root: HTMLElement): {
  openSourceColsDialog: () => void;
} {
  const dialog = document.createElement("dialog");
  dialog.id = "dlg-source-cols";
  dialog.setAttribute("aria-labelledby", "dlg-source-cols-title");
  dialog.setAttribute("closedby", "any");
  root.append(dialog);

  dialog.addEventListener("close", () => {
    dialog.returnValue = "";
  });

  let draft: SourceScriptColumnConfig = { ...store.sourceColConfig };

  const render = (notice = "", previewHeaders: string[] = []) => {
    const colInputsHtml = COL_FIELDS.map(
      (f) => `
        <div class="field-group">
          <label class="field-label" for="inp-sc-${f.key}">${esc(f.label)}</label>
          <input
            id="inp-sc-${f.key}"
            data-col-key="${f.key}"
            class="text-input mono-input"
            value="${esc(String(draft[f.key] || f.defaultCol))}"
            placeholder="${esc(f.defaultCol)}"
          />
        </div>
      `,
    ).join("");

    const previewHtml =
      previewHeaders.length > 0
        ? `<div class="header-preview-strip">${previewHeaders
            .map(
              (h, idx) =>
                `<span class="col-chip">${esc(indexToColLetter(idx))}: ${esc(h || "(空)")}</span>`,
            )
            .join("")}</div>`
        : "";

    dialog.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-source-cols-title" class="dialog-title">源剧本与输出列位置设置</h2>
        <button type="button" class="seg-option" data-close-sc aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">
        ${notice ? `<div class="notice-bar notice-info" style="border-radius:8px">${esc(notice)}</div>` : ""}
        <div class="col-grid-2">
          <label class="checkbox-row">
            <input type="checkbox" id="chk-sc-auto" ${draft.autoDetectByHeader ? "checked" : ""} />
            <span>优先按表头列名自动识别（表头不标准时使用下方指定列号）</span>
          </label>
          <div class="field-group">
            <label class="field-label" for="inp-sc-hdr-row">表头所在行号</label>
            <input
              id="inp-sc-hdr-row"
              type="number"
              min="1"
              max="20"
              class="text-input mono-input"
              value="${draft.headerRowNumber || 2}"
            />
          </div>
        </div>

        <div class="col-grid-4">
          ${colInputsHtml}
        </div>

        <div class="field-group">
          <label class="field-label" for="inp-sc-out-hint">输出【工具提示】列 (AUTO 自动末列，或填 M/N 等)</label>
          <input
            id="inp-sc-out-hint"
            class="text-input mono-input"
            value="${esc(draft.outputHintCol || "AUTO")}"
            placeholder="AUTO"
          />
        </div>

        <div class="btn-row-compact">
          <button type="button" id="btn-sc-preview" class="btn">
            ${icons.search}
            <span>从当前已加载剧本读取首行表头预览</span>
          </button>
          <button type="button" id="btn-sc-reset" class="btn">恢复默认 (A~L)</button>
        </div>
        ${previewHtml}
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-sc>取消</button>
        <button type="button" id="btn-sc-save" class="btn btn-primary" autofocus>保存设置</button>
      </div>
    `;

    dialog.querySelectorAll("[data-close-sc]").forEach((b) =>
      b.addEventListener("click", () => dialog.close()),
    );

    const syncDraftFromDom = () => {
      draft.autoDetectByHeader =
        dialog.querySelector<HTMLInputElement>("#chk-sc-auto")?.checked ?? true;
      draft.headerRowNumber = Math.max(
        1,
        Number(
          dialog.querySelector<HTMLInputElement>("#inp-sc-hdr-row")?.value || 2,
        ),
      );
      for (const f of COL_FIELDS) {
        const val =
          dialog
            .querySelector<HTMLInputElement>(`#inp-sc-${f.key}`)
            ?.value.trim()
            .toUpperCase() || f.defaultCol;
        draft[f.key] = val;
      }
      draft.outputHintCol =
        dialog
          .querySelector<HTMLInputElement>("#inp-sc-out-hint")
          ?.value.trim()
          .toUpperCase() || "AUTO";
    };

    dialog.querySelector("#btn-sc-preview")?.addEventListener("click", () => {
      syncDraftFromDom();
      const doc = store.scriptDoc;
      if (!doc || doc.headerRows.length === 0) {
        render("当前尚未加载任何源剧本，请先读取云端源稿或导入本地 CSV。");
        return;
      }
      const lastHdr = doc.headerRows[doc.headerRows.length - 1] ?? [];
      render(
        `已读取「${doc.title}」第 ${doc.headerRows.length} 行表头（共 ${lastHdr.length} 列）。`,
        lastHdr,
      );
    });

    dialog.querySelector("#btn-sc-reset")?.addEventListener("click", () => {
      draft = { ...DEFAULT_SOURCE_COL_CONFIG };
      render("已恢复默认列位置 (A~L) 及 AUTO 末列提示。");
    });

    dialog.querySelector("#btn-sc-save")?.addEventListener("click", () => {
      syncDraftFromDom();
      store.sourceColConfig = { ...draft };
      notifyStateChanged();
      dialog.close();
    });
  };

  return {
    openSourceColsDialog: () => {
      draft = { ...store.sourceColConfig };
      render();
      dialog.showModal();
    },
  };
}

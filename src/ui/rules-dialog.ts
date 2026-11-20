import { resolvePunctuationRule } from "../catalog/lang-presets";
import type {
  BibleCitationMode,
  PeriodPlacementMode,
  PunctuationRule,
} from "../types/domain";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mountRulesDialog(root: HTMLElement): {
  openRulesDialog: () => void;
} {
  const dialog = document.createElement("dialog");
  dialog.id = "dlg-rules";
  dialog.setAttribute("aria-labelledby", "dlg-rules-title");
  dialog.setAttribute("closedby", "any");
  root.append(dialog);

  dialog.addEventListener("close", () => {
    dialog.returnValue = "";
  });

  let activeLang = store.availableLanguages[0] || "乌克兰语";

  const render = (savedNotice = "") => {
    const rule: PunctuationRule = resolvePunctuationRule(
      activeLang,
      store.customRules,
    );

    const langOpts = store.availableLanguages
      .map(
        (l) =>
          `<option value="${esc(l)}" ${l === activeLang ? "selected" : ""}>${esc(l)}</option>`,
      )
      .join("");

    dialog.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-rules-title" class="dialog-title">各语种剧本标点与摘自规范库（35+ 语系）</h2>
        <button type="button" class="seg-option" data-close-rules aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-body">
        ${savedNotice ? `<div class="notice-bar notice-info" style="border-radius:8px">${esc(savedNotice)}</div>` : ""}
        <div class="field-group">
          <label class="field-label" for="sel-rule-lang">选择语种</label>
          <select id="sel-rule-lang" class="select-input">${langOpts}</select>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.55rem">
          <div class="field-group">
            <label class="field-label" for="inp-dbl-open">左双引号</label>
            <input id="inp-dbl-open" class="text-input" value="${esc(rule.doubleOpen)}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-dbl-close">右双引号</label>
            <input id="inp-dbl-close" class="text-input" value="${esc(rule.doubleClose)}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-sgl-open">内层左单引号</label>
            <input id="inp-sgl-open" class="text-input" value="${esc(rule.singleOpen)}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-sgl-close">内层右单引号</label>
            <input id="inp-sgl-close" class="text-input" value="${esc(rule.singleClose)}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-tert-open">三级引号左 (G列)</label>
            <input id="inp-tert-open" class="text-input" value="${esc(rule.tertiaryOpen ?? "")}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-tert-close">三级引号右 (H列)</label>
            <input id="inp-tert-close" class="text-input" value="${esc(rule.tertiaryClose ?? "")}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-apos">撇号形状</label>
            <input id="inp-apos" class="text-input" value="${esc(rule.apostrophe)}" placeholder="无则留空" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-ellipsis">剧本省略号</label>
            <input id="inp-ellipsis" class="text-input" value="${esc(rule.ellipsis)}" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.55rem">
          <div class="field-group">
            <label class="field-label" for="inp-period-pat">句号+引号位置 (M列)</label>
            <input id="inp-period-pat" class="text-input" value="${esc(rule.periodQuotePattern ?? "")}" placeholder="如 .“ / »։ / ”." />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-exclam-pat">问号/感叹号+引号 (N列)</label>
            <input id="inp-exclam-pat" class="text-input" value="${esc((rule.exclamQuestionQuotePattern ?? "").replace(/\n/g, " / "))}" placeholder="如 ?“ / !“" />
          </div>
          <div class="field-group">
            <label class="field-label" for="inp-period-char">句末句号字符 (无填无)</label>
            <input id="inp-period-char" class="text-input" value="${esc(rule.sentencePeriodChar === "" ? "无" : (rule.sentencePeriodChar ?? "."))}" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="sel-period-mode">神话正文句号与右引号位置</label>
          <select id="sel-period-mode" class="select-input">
            <option value="outside" ${rule.periodMode === "outside" ? "selected" : ""}>句号总在引号外面（如乌语、西语）</option>
            <option value="inside" ${rule.periodMode === "inside" ? "selected" : ""}>句号总在引号里面（如印地语、德语）</option>
            <option value="sentence_inside_phrase_outside" ${rule.periodMode === "sentence_inside_phrase_outside" ? "selected" : ""}>整句在引号内、短语/标题在引号外（如印尼语、葡语、克语）</option>
          </select>
        </div>

        <div class="field-group">
          <label class="field-label" for="sel-bible-mode">圣经摘自与句末句点规范</label>
          <select id="sel-bible-mode" class="select-input">
            <option value="same_as_english" ${rule.bibleCitationMode === "same_as_english" ? "selected" : ""}>同英文：正文引号后不加句号，括号出处外加句号 (Luke 17:24–25).</option>
            <option value="period_inside_quote_no_trailing" ${rule.bibleCitationMode === "period_inside_quote_no_trailing" ? "selected" : ""}>句号在正文引号内，括号出处外不加句号（如法语、缅甸语、克罗地亚语）</option>
          </select>
        </div>

        <label class="checkbox-row">
          <input type="checkbox" id="chk-comma-in" ${rule.commaInsideQuote ? "checked" : ""} />
          <span>逗号放在引号里面</span>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" id="chk-single-cite" ${rule.singleCitationRowOnly ? "checked" : ""} />
          <span>摘自仅有一排通用格式（不区分字幕带版与视频特效版，如韩语）</span>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" id="chk-preserve-inner" ${rule.preserveInnerQuotes ? "checked" : ""} />
          <span>内层引号保持单篇/圣经库原样不修改（如韩语）</span>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" id="chk-no-adj-dbl" ${rule.noAdjacentDoubleQuotes ? "checked" : ""} />
          <span>禁止两个双引号挨在一起（如阿拉伯语、保加利亚语）</span>
        </label>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-rules>关闭</button>
        <button type="button" id="btn-save-rule" class="btn btn-primary" autofocus>保存当前语种规则</button>
      </div>
    `;

    dialog.querySelectorAll("[data-close-rules]").forEach((b) =>
      b.addEventListener("click", () => dialog.close()),
    );

    dialog.querySelector("#sel-rule-lang")?.addEventListener("change", (e) => {
      activeLang = (e.target as HTMLSelectElement).value;
      render();
    });

    dialog.querySelector("#btn-save-rule")?.addEventListener("click", () => {
      const pcRaw = dialog.querySelector<HTMLInputElement>("#inp-period-char")?.value.trim() ?? ".";
      const exRaw = dialog.querySelector<HTMLInputElement>("#inp-exclam-pat")?.value.trim() ?? "";
      const updated: PunctuationRule = {
        ...rule,
        langName: activeLang,
        doubleOpen: dialog.querySelector<HTMLInputElement>("#inp-dbl-open")?.value ?? '"',
        doubleClose: dialog.querySelector<HTMLInputElement>("#inp-dbl-close")?.value ?? '"',
        singleOpen: dialog.querySelector<HTMLInputElement>("#inp-sgl-open")?.value ?? "",
        singleClose: dialog.querySelector<HTMLInputElement>("#inp-sgl-close")?.value ?? "",
        tertiaryOpen: dialog.querySelector<HTMLInputElement>("#inp-tert-open")?.value ?? "",
        tertiaryClose: dialog.querySelector<HTMLInputElement>("#inp-tert-close")?.value ?? "",
        apostrophe: dialog.querySelector<HTMLInputElement>("#inp-apos")?.value ?? "",
        ellipsis: dialog.querySelector<HTMLInputElement>("#inp-ellipsis")?.value ?? "…",
        periodQuotePattern: dialog.querySelector<HTMLInputElement>("#inp-period-pat")?.value.trim() || undefined,
        exclamQuestionQuotePattern: exRaw ? exRaw.replace(/\s*\/\s*/g, "\n") : undefined,
        sentencePeriodChar: /^(无|none)$/i.test(pcRaw) ? "" : pcRaw || ".",
        periodMode:
          (dialog.querySelector<HTMLSelectElement>("#sel-period-mode")
            ?.value as PeriodPlacementMode) ?? "outside",
        bibleCitationMode:
          (dialog.querySelector<HTMLSelectElement>("#sel-bible-mode")
            ?.value as BibleCitationMode) ?? "same_as_english",
        commaInsideQuote:
          dialog.querySelector<HTMLInputElement>("#chk-comma-in")?.checked ?? false,
        singleCitationRowOnly:
          dialog.querySelector<HTMLInputElement>("#chk-single-cite")?.checked ?? false,
        preserveInnerQuotes:
          dialog.querySelector<HTMLInputElement>("#chk-preserve-inner")?.checked ?? false,
        noAdjacentDoubleQuotes:
          dialog.querySelector<HTMLInputElement>("#chk-no-adj-dbl")?.checked ?? false,
      };
      const idx = store.customRules.findIndex((r) => r.langName === activeLang);
      if (idx >= 0) store.customRules[idx] = updated;
      else store.customRules.push(updated);
      notifyStateChanged();
      render(`已保存「${activeLang}」的标点与摘自规则。`);
    });
  };

  return {
    openRulesDialog: () => {
      if (!store.availableLanguages.includes(activeLang)) {
        activeLang = store.availableLanguages[0] || "乌克兰语";
      }
      render();
      dialog.showModal();
    },
  };
}

import {
  getActiveLineBreakSpecs,
  getBuiltinLineBreakSpec,
  resolveLineBreakSpec,
} from "../linebreak/presets";
import {
  exportLineBreakCustomizationsJson,
  getGlobalLineBreakRules,
  hasCustomOverrideForLang,
  importLineBreakCustomizationsJson,
  removeCustomOrResetLangSpec,
  resetAllLineBreakCustomizations,
  saveGlobalLineBreakRules,
  upsertCustomLineBreakSpec,
} from "../linebreak/rule-registry";
import type { LineBreakLanguageSpec } from "../linebreak/types";
import { icons } from "./icons";
import { notifyStateChanged, store } from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mountLineBreakRulesDialog(root: HTMLElement): {
  openLineBreakRulesDialog: (initialLangCode?: string) => void;
} {
  const dlg = document.createElement("dialog");
  dlg.id = "dlg-lb-rules";
  dlg.className = "dialog-wide";
  dlg.setAttribute("aria-labelledby", "dlg-lb-rules-title");
  dlg.setAttribute("closedby", "any");
  root.append(dlg);

  let activeTab: "langs" | "global" = "langs";
  let selectedCode = store.lineBreak.langCode || "it";
  let creatingNew = false;
  let flashNotice = "";

  const render = () => {
    const allSpecs = getActiveLineBreakSpecs();
    if (!creatingNew && !allSpecs.some((s) => s.code === selectedCode)) {
      selectedCode = allSpecs[0]?.code ?? "it";
    }

    const editingSpec: LineBreakLanguageSpec = creatingNew
      ? {
          code: "",
          name: "",
          aliases: [],
          mode: "char",
          tier: 2,
          fontFamily: "Times New Roman",
          fontSizePt: 12,
          dir: "ltr",
          singleMax: 46,
          doubleMax: 84,
          softNoBreakMax: 50,
          earlySplitSentenceMin: 73,
          compactSameScreenMax: 92,
          rulerText: "",
          sentenceEndChars: [".", "?", "!", "…"],
          notes: "",
          customPromptRule: "",
          isCustom: true,
        }
      : resolveLineBreakSpec(selectedCode);

    const isBuiltin = !creatingNew && Boolean(getBuiltinLineBreakSpec(editingSpec.code));
    const isModifiedBuiltin = isBuiltin && hasCustomOverrideForLang(editingSpec.code);
    const globalCfg = getGlobalLineBreakRules();

    const langSelectOpts = allSpecs
      .map((s) => {
        const tag = s.isCustom
          ? " · 自定义新增"
          : hasCustomOverrideForLang(s.code)
            ? " · 已修改参数"
            : "";
        return `<option value="${esc(s.code)}" ${!creatingNew && s.code === editingSpec.code ? "selected" : ""}>${esc(s.name)} (${esc(s.code)} · ${s.mode === "char" ? `${s.singleMax}/${s.doubleMax}字符` : "尺子"})${tag}</option>`;
      })
      .join("");

    dlg.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-lb-rules-title" class="dialog-title">字幕断行语种与规则配置库（支持新增语系与修改规则）</h2>
        <button type="button" class="seg-option" data-close-lb-rules aria-label="关闭">${icons.close}</button>
      </div>

      <div class="dialog-tabs-bar" role="tablist" aria-label="字幕断行配置分类">
        <button type="button" role="tab" class="tab-btn" data-lb-rule-tab="langs" aria-selected="${activeTab === "langs"}">各语种规格与新增语系 (${allSpecs.length})</button>
        <button type="button" role="tab" class="tab-btn" data-lb-rule-tab="global" aria-selected="${activeTab === "global"}">全局比例与通用断行要求</button>
      </div>

      <div class="dialog-body">
        ${flashNotice ? `<div class="notice-bar notice-info" style="border-radius:6px">${esc(flashNotice)}</div>` : ""}

        ${
          activeTab === "langs"
            ? `
          <div class="field-label-row" style="gap:0.6rem;flex-wrap:wrap">
            <div style="flex:1;min-inline-size:220px">
              <label class="field-label" for="sel-edit-lb-lang">选择已有语种修改，或点击右侧新增语系</label>
              <select id="sel-edit-lb-lang" class="select-input" style="margin-block-start:0.25rem" ${creatingNew ? "disabled" : ""}>
                ${langSelectOpts}
              </select>
            </div>
            <button type="button" id="btn-start-new-lang" class="btn ${creatingNew ? "btn-primary" : ""}" style="align-self:flex-end">
              ${creatingNew ? "正在新增语系（点此取消返回）" : "+ 新增断行语系"}
            </button>
          </div>

          <div class="col-grid-3">
            <div class="field-group">
              <label class="field-label" for="inp-lbr-name">语种显示名称 *</label>
              <input id="inp-lbr-name" class="text-input" placeholder="例如：孟加拉语" value="${esc(editingSpec.name)}" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-code">唯一语种代号 *</label>
              <input id="inp-lbr-code" class="text-input mono-input" placeholder="例如：bn 或 es-eu" value="${esc(editingSpec.code)}" ${isBuiltin ? "readonly title='内置语种代号固定，可直接修改右侧参数'" : ""} />
            </div>
            <div class="field-group">
              <label class="field-label" for="sel-lbr-mode">长度度量方式</label>
              <select id="sel-lbr-mode" class="select-input">
                <option value="char" ${editingSpec.mode === "char" ? "selected" : ""}>按字符数 (LEN)</option>
                <option value="ruler" ${editingSpec.mode === "ruler" ? "selected" : ""}>按视觉尺子宽度 (Ruler)</option>
              </select>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label" for="inp-lbr-aliases">批量总表自动识别别名（用逗号分隔，总表 A 列包含任一词即自动匹配该语种）</label>
            <input id="inp-lbr-aliases" class="text-input" placeholder="例如：孟加拉, 孟语, bengali" value="${esc(editingSpec.aliases.join(", "))}" />
          </div>

          <div class="col-grid-5">
            <div class="field-group">
              <label class="field-label" for="inp-lbr-single">单行上限</label>
              <input id="inp-lbr-single" type="number" min="10" max="120" class="text-input mono-input" value="${editingSpec.singleMax}" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-double">同屏双行上限</label>
              <input id="inp-lbr-double" type="number" min="20" max="200" class="text-input mono-input" value="${editingSpec.doubleMax}" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-soft">微超免断上限</label>
              <input id="inp-lbr-soft" type="number" min="10" max="130" class="text-input mono-input" value="${editingSpec.softNoBreakMax}" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-early">双句分屏起点</label>
              <input id="inp-lbr-early" type="number" min="20" max="180" class="text-input mono-input" value="${editingSpec.earlySplitSentenceMin}" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-compact">紧凑同屏豁免</label>
              <input id="inp-lbr-compact" type="number" min="20" max="220" class="text-input mono-input" value="${editingSpec.compactSameScreenMax}" />
            </div>
          </div>

          <div class="col-grid-4">
            <div class="field-group">
              <label class="field-label" for="inp-lbr-font">标准测量字体</label>
              <input id="inp-lbr-font" class="text-input" value="${esc(editingSpec.fontFamily)}" placeholder="Times New Roman / Arial" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-pt">字号 (pt)</label>
              <input id="inp-lbr-pt" type="number" min="8" max="24" class="text-input mono-input" value="${editingSpec.fontSizePt}" />
            </div>
            <div class="field-group">
              <label class="field-label" for="sel-lbr-dir">文字排列方向</label>
              <select id="sel-lbr-dir" class="select-input">
                <option value="ltr" ${editingSpec.dir === "ltr" ? "selected" : ""}>从左向右 (LTR)</option>
                <option value="rtl" ${editingSpec.dir === "rtl" ? "selected" : ""}>从右向左 (RTL)</option>
              </select>
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-punct">句末标点符号（空格分隔）</label>
              <input id="inp-lbr-punct" class="text-input mono-input" value="${esc(editingSpec.sentenceEndChars.join(" "))}" placeholder=". ? ! …" />
            </div>
          </div>

          <div class="col-grid-2">
            <div class="field-group">
              <label class="field-label" for="inp-lbr-ruler">视觉尺子 1 倍基准文本（按尺子度量语种填写）</label>
              <input id="inp-lbr-ruler" class="text-input" value="${esc(editingSpec.rulerText ?? "")}" placeholder="粘贴该语种 1 倍标准宽度示范句" />
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-lbr-px">固定尺子像素宽（可选，如阿语 320）</label>
              <input id="inp-lbr-px" type="number" min="0" max="1200" class="text-input mono-input" value="${editingSpec.fixedRulerPx ?? ""}" placeholder="留空则按左侧尺子文本自动测算" />
            </div>
          </div>

          <div class="field-group">
            <label class="field-label" for="inp-lbr-prompt">该语种专属断行补充要求（将直接附加给大模型，随时补充特殊语法禁断规则）</label>
            <textarea id="inp-lbr-prompt" class="text-area" style="min-block-size:74px" placeholder="例如：1. 严禁在某某连词后切分；2. 某类专有名词短语一律保持在同一行...">${esc(editingSpec.customPromptRule ?? "")}</textarea>
          </div>
          `
            : `
          <div class="col-grid-3">
            <div class="field-group">
              <label class="field-label" for="inp-glb-min-ratio">同屏上下行最小比值（防上极短下极长）</label>
              <input id="inp-glb-min-ratio" type="number" step="0.01" min="0.1" max="0.95" class="text-input mono-input" value="${globalCfg.minLineRatio}" />
              <span class="field-hint">默认 0.33（即上行不少于下行的 1/3）</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-glb-max-ratio">同屏上下行最大比值（防上极长下极短）</label>
              <input id="inp-glb-max-ratio" type="number" step="0.1" min="1.1" max="6.0" class="text-input mono-input" value="${globalCfg.maxLineRatio}" />
              <span class="field-hint">默认 2.7</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="inp-glb-short-warn">短碎屏 L 列告警阈值</label>
              <input id="inp-glb-short-warn" type="number" min="5" max="35" class="text-input mono-input" value="${globalCfg.minShortScreenWarn}" />
              <span class="field-hint">默认 15（分屏后某屏短于此值自动提示防琐碎）</span>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label" for="inp-glb-prompt">全局通用断行补充规则（对所有语种同时生效，直接注入大模型指令）</label>
            <textarea id="inp-glb-prompt" class="text-area" style="min-block-size:110px" placeholder="后续如果团队新增统一断行规定（例如：“引出说话内容的冒号后一律优先分屏”、“排比短句尽量合并同屏”等），直接写在这里保存即可对全语种生效，无需改代码。">${esc(globalCfg.globalCustomPrompt)}</textarea>
          </div>

          <div class="settings-item-row" style="padding-block-start:0.5rem">
            <div class="settings-item-meta">
              <span class="field-label">规则配置团队共享（JSON 导入 / 导出）</span>
              <span class="field-hint">可将您新增的语系与修改后的断行规则导出为 .json 发给团队同事一键导入同步。</span>
            </div>
            <div style="display:flex;gap:0.45rem;flex-wrap:wrap">
              <button type="button" id="btn-export-lb-rules-json" class="btn btn-compact">${icons.download}<span>导出配置 .json</span></button>
              <label class="btn btn-compact" style="cursor:pointer">
                ${icons.upload}
                <span>导入配置 .json</span>
                <input id="inp-import-lb-rules-json" type="file" accept=".json" hidden />
              </label>
            </div>
          </div>
          `
        }
      </div>

      <div class="dialog-footer" style="justify-content:space-between">
        <div>
          ${
            activeTab === "langs" && !creatingNew && (editingSpec.isCustom || isModifiedBuiltin)
              ? `<button type="button" id="btn-reset-one-lang" class="btn btn-compact">
                  ${editingSpec.isCustom ? "删除此自定义语系" : "恢复该语种默认参数"}
                </button>`
              : activeTab === "global"
                ? `<button type="button" id="btn-reset-all-lb-rules" class="btn btn-compact">恢复全部默认规则</button>`
                : ""
          }
        </div>
        <div style="display:flex;gap:0.5rem">
          <button type="button" class="btn" data-close-lb-rules>关闭</button>
          <button type="button" id="btn-save-lb-rules" class="btn btn-primary">
            ${activeTab === "langs" ? (creatingNew ? "保存新增语系" : "保存此语种参数") : "保存全局断行规则"}
          </button>
        </div>
      </div>
    `;

    dlg.querySelectorAll("[data-close-lb-rules]").forEach((el) => {
      el.addEventListener("click", () => dlg.close());
    });

    dlg.querySelectorAll<HTMLButtonElement>("[data-lb-rule-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.lbRuleTab === "global" ? "global" : "langs";
        flashNotice = "";
        render();
      });
    });

    dlg.querySelector<HTMLSelectElement>("#sel-edit-lb-lang")?.addEventListener("change", (e) => {
      selectedCode = (e.currentTarget as HTMLSelectElement).value;
      creatingNew = false;
      flashNotice = "";
      render();
    });

    dlg.querySelector("#btn-start-new-lang")?.addEventListener("click", () => {
      creatingNew = !creatingNew;
      flashNotice = "";
      render();
    });

    dlg.querySelector("#btn-reset-one-lang")?.addEventListener("click", () => {
      removeCustomOrResetLangSpec(editingSpec.code);
      creatingNew = false;
      flashNotice = editingSpec.isCustom
        ? `已删除自定义语系「${editingSpec.name}」`
        : `已将「${editingSpec.name}」恢复为内置默认规格`;
      selectedCode = getActiveLineBreakSpecs()[0]?.code ?? "it";
      notifyStateChanged();
      render();
    });

    dlg.querySelector("#btn-reset-all-lb-rules")?.addEventListener("click", () => {
      resetAllLineBreakCustomizations();
      flashNotice = "已将所有语种规格与全局比例恢复为系统默认设置";
      notifyStateChanged();
      render();
    });

    dlg.querySelector("#btn-export-lb-rules-json")?.addEventListener("click", () => {
      const blob = new Blob([exportLineBreakCustomizationsJson()], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "字幕断行语种与规则配置.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
    });

    const importInp = dlg.querySelector<HTMLInputElement>("#inp-import-lb-rules-json");
    importInp?.addEventListener("change", async () => {
      const f = importInp.files?.[0];
      if (!f) return;
      try {
        const res = importLineBreakCustomizationsJson(await f.text());
        flashNotice = `成功导入断行规则配置（含 ${res.specCount} 项自定义/覆盖语种）`;
        notifyStateChanged();
        render();
      } catch (err) {
        flashNotice = `导入失败：${err instanceof Error ? err.message : String(err)}`;
        render();
      }
    });

    dlg.querySelector("#btn-save-lb-rules")?.addEventListener("click", () => {
      if (activeTab === "global") {
        const minR = parseFloat(
          dlg.querySelector<HTMLInputElement>("#inp-glb-min-ratio")?.value ?? "0.33",
        );
        const maxR = parseFloat(
          dlg.querySelector<HTMLInputElement>("#inp-glb-max-ratio")?.value ?? "2.7",
        );
        const shortW = parseInt(
          dlg.querySelector<HTMLInputElement>("#inp-glb-short-warn")?.value ?? "15",
          10,
        );
        const prompt =
          dlg.querySelector<HTMLTextAreaElement>("#inp-glb-prompt")?.value ?? "";

        saveGlobalLineBreakRules({
          minLineRatio: minR,
          maxLineRatio: maxR,
          minShortScreenWarn: shortW,
          globalCustomPrompt: prompt,
        });
        flashNotice = "已保存全局断行比例与通用补充规则，后续运行立即生效！";
        notifyStateChanged();
        render();
        return;
      }

      const name = (dlg.querySelector<HTMLInputElement>("#inp-lbr-name")?.value ?? "").trim();
      const rawCode = (dlg.querySelector<HTMLInputElement>("#inp-lbr-code")?.value ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-");

      if (!name || !rawCode) {
        flashNotice = "请填写「语种显示名称」与「唯一语种代号」（例如 bn）";
        render();
        return;
      }

      const mode =
        dlg.querySelector<HTMLSelectElement>("#sel-lbr-mode")?.value === "ruler"
          ? "ruler"
          : "char";
      const aliases = (dlg.querySelector<HTMLInputElement>("#inp-lbr-aliases")?.value ?? "")
        .split(/[,，;；]+/)
        .map((a) => a.trim())
        .filter(Boolean);
      const singleMax = Math.max(
        10,
        parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-single")?.value ?? "46", 10) || 46,
      );
      const doubleMax = Math.max(
        singleMax + 4,
        parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-double")?.value ?? "84", 10) || 84,
      );
      const softNoBreakMax = Math.max(
        singleMax,
        parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-soft")?.value ?? "50", 10) || 50,
      );
      const earlySplitSentenceMin = Math.max(
        20,
        parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-early")?.value ?? "73", 10) || 73,
      );
      const compactSameScreenMax = Math.max(
        doubleMax,
        parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-compact")?.value ?? "92", 10) || 92,
      );
      const fontFamily =
        (dlg.querySelector<HTMLInputElement>("#inp-lbr-font")?.value ?? "").trim() ||
        (mode === "ruler" ? "Arial" : "Times New Roman");
      const fontSizePt = Math.max(
        8,
        parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-pt")?.value ?? "12", 10) || 12,
      );
      const dir =
        dlg.querySelector<HTMLSelectElement>("#sel-lbr-dir")?.value === "rtl" ? "rtl" : "ltr";
      const sentenceEndChars = (dlg.querySelector<HTMLInputElement>("#inp-lbr-punct")?.value ?? "")
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const rulerText = (dlg.querySelector<HTMLInputElement>("#inp-lbr-ruler")?.value ?? "").trim();
      const rawPx = parseInt(dlg.querySelector<HTMLInputElement>("#inp-lbr-px")?.value ?? "", 10);
      const customPromptRule = (
        dlg.querySelector<HTMLTextAreaElement>("#inp-lbr-prompt")?.value ?? ""
      ).trim();

      if (mode === "ruler" && !rulerText && !(Number.isFinite(rawPx) && rawPx > 0)) {
        flashNotice = "按尺子度量的语种请填写「1 倍基准文本」或「固定尺子像素宽」";
        render();
        return;
      }

      const builtinBase = getBuiltinLineBreakSpec(rawCode);
      const nextSpec: LineBreakLanguageSpec = {
        code: rawCode,
        name,
        aliases,
        mode,
        tier: builtinBase?.tier ?? (mode === "ruler" ? 3 : 2),
        fontFamily,
        fontSizePt,
        dir,
        singleMax,
        doubleMax,
        softNoBreakMax,
        earlySplitSentenceMin,
        compactSameScreenMax,
        rulerText: rulerText || undefined,
        fixedRulerPx: Number.isFinite(rawPx) && rawPx > 0 ? rawPx : undefined,
        sentenceEndChars: sentenceEndChars.length > 0 ? sentenceEndChars : [".", "?", "!", "…"],
        isJapanese: builtinBase?.isJapanese,
        customPromptRule: customPromptRule || undefined,
        isCustom: !builtinBase,
      };

      upsertCustomLineBreakSpec(nextSpec);
      selectedCode = rawCode;
      store.lineBreak.langCode = rawCode;
      creatingNew = false;
      flashNotice = `已保存「${name} (${rawCode})」断行规格，下拉列表与批量总表识别已同步更新！`;
      notifyStateChanged();
      render();
    });
  };

  return {
    openLineBreakRulesDialog: (initialLangCode?: string) => {
      if (initialLangCode) {
        selectedCode = initialLangCode;
      } else {
        selectedCode = store.lineBreak.langCode || "it";
      }
      creatingNew = false;
      flashNotice = "";
      render();
      if (!dlg.open) dlg.showModal();
    },
  };
}

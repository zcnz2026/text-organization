import type { LanguageResourceLinks } from "../types/domain";
import { DEFAULT_LANG_SHEET_COLS, DEFAULT_SHARED_SHEETS_CONFIG, type PerLanguageSheetColumnConfig, type SharedSheetsConfig } from "../types/schema-config";
import { icons } from "./icons";
import { getLangCols, notifyStateChanged, store } from "./state";

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type ConfigTabId = "spec" | "shared" | "per-lang";

const SPEC_ROWS = [
  ["A1 源剧本", "当前期报道源表 (#gid)", "表头行2；A=Line, B=In Time, C=Out Time, D=Character, E=Chinese, F=English底, G=Target Language, H=Note, I=备注, J=送翻备注, K=筛选列, L=需要摘"],
  ["A2 专用输出表", "多语种结果输出表", "每个语种新建/覆盖一个独立 Sheet；默认末列 (AUTO) 写入【工具提示】并同步三色审校底色"],
  ["B1 新常用语(含全能神说)", "多语种公共总表", "表头行1；A=中文, B=英文, C=备注，后续列按语种列名匹配（含「全能神说」及固定词条）"],
  ["B2 话在肉身显现单篇摘自202210", "多语种公共总表", "表头行2；A=中文破折号, B=中文字幕带, C=英文视频朗诵, D=英文字幕带，E+列按语种匹配双版摘自"],
  ["B3 诗歌LRC摘自新版", "多语种公共总表", "表头行1；A=中文, B=英文，C+列为「<语种>的摘自」"],
  ["B4 主祷文202605按行排布", "多语种公共总表", "表头行1；支持 A=语种名 + B=整段主祷文（自动按行切分并对齐末行阿们），或按列排布"],
  ["B5 报道人名教会名库", "多语种公共总表", "表头行2；C=中文名, D=英文名, F=期数，后续列按语种名匹配预填并标黄提示核对"],
  ["C1 六本书新摘自", "分语种独立 Sheet", "表头行1；B~I 列：B=中文括号版, C=中文横线版, D=中文篇名, E=英文篇名, F=目标语篇名, G=单篇文档链接, H=字幕带版摘自, I=括号版摘自"],
  ["C2 单篇.docx三列表", "Google Docs / Drive .docx", "文档内三列表格：第1列=中文, 第2列=英文, 第3列=目标语（自动忽略修订删除线与 You(s) 差异）"],
  ["C3 唯一圣经库", "分语种独立 Sheet", "表头行2；B=章节, C=中文经文, D=英文经文, E=目标语经文（严格单一圣经库，绝不混查天主教版）"],
  ["C4 新俗语表", "分语种独立 Sheet", "表头行1；F=中文, G=英文1, I=英文2, J=目标语俗语译文"],
  ["C5 诗歌歌词表", "分语种独立 Sheet", "表头行1/2；A=中文, B=英文, C=目标语歌词（兼容黄底神话诗歌标题与教会诗歌多子行 LRC 聚合）"],
];

const inpCell = (id: string, label: string, val: string | number, isNum = false) =>
  `<div class="field-group"><label class="field-label" for="${id}">${esc(label)}</label><input id="${id}" ${isNum ? 'type="number"' : ""} class="text-input mono-input" value="${esc(String(val))}" /></div>`;

const urlCell = (id: string, label: string, val: string, ph: string) =>
  `<div class="field-group"><label class="field-label" for="${id}">${esc(label)}</label><input id="${id}" class="text-input" value="${esc(val)}" placeholder="${esc(ph)}" /></div>`;

const inpGrid = (cls: string, items: Array<[string, string, string | number, boolean?]>) =>
  `<div class="${cls}">${items.map(([id, lb, v, n]) => inpCell(id, lb, v, n)).join("")}</div>`;

export function mountCatalogConfigDialog(
  root: HTMLElement,
  actions: { onDownloadTemplateXlsx: () => void },
): { openCatalogConfigDialog: (initialTab?: ConfigTabId) => void } {
  const dialog = document.createElement("dialog");
  dialog.id = "dlg-catalog-config";
  dialog.className = "dialog-wide";
  dialog.setAttribute("aria-labelledby", "dlg-catalog-title");
  dialog.setAttribute("closedby", "any");
  root.append(dialog);
  dialog.addEventListener("close", () => {
    dialog.returnValue = "";
  });

  let activeTab: ConfigTabId = "spec";
  let activeLang = store.availableLanguages[0] || "乌克兰语";

  const render = (notice = "") => {
    const sh: SharedSheetsConfig = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...store.sharedSheets };
    const lk: LanguageResourceLinks = {
      langName: activeLang,
      articleCatalogUrl: "",
      bibleSheetUrl: "",
      idiomSheetUrl: "",
      punctuationDocUrl: "",
      commonTermsUrl: "",
      godSaysUrl: "",
      hymnSheetUrl: "",
      lordsPrayerUrl: "",
      rosterSheetUrl: "",
      extraCitationSheetUrl: "",
      ...(store.linksByLang.get(activeLang) ?? {}),
    };
    const lc: PerLanguageSheetColumnConfig = { ...DEFAULT_LANG_SHEET_COLS, ...getLangCols(activeLang) };

    const tabSpecHtml = `
      <div class="btn-row-compact" style="justify-content:space-between">
        <span class="field-hint">所有模块链接与列号均可在此维护，或导出 3-Sheet 简明中文模板（1_资料表链接 / 2_表内列位置定位 / 3_标点规则）上传至 Google 云端供团队共享。</span>
        <button type="button" id="btn-dl-cfg-tpl" class="btn btn-primary">${icons.download}<span>导出标准云端配置表模板 (.xlsx)</span></button>
      </div>
      <div class="spec-table-wrap">
        <table class="spec-table">
          <thead><tr><th>模块编号与名称</th><th>载体类型</th><th>默认表头行与列映射规范</th></tr></thead>
          <tbody>${SPEC_ROWS.map((r) => `<tr><td class="mono-cell">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join("")}</tbody>
        </table>
      </div>`;

    const tabSharedHtml = `
      <div class="config-section-list">
        <div class="config-row-block">${urlCell("sh-b1-url", "B1 新常用语（含全能神说）Google Sheet 链接", sh.commonTermsUrl, "粘贴 B1 公共常用词汇表链接 (#gid=...)")}${inpGrid("col-grid-4", [["sh-b1-hr", "表头行", sh.commonTermsHeaderRow, true], ["sh-b1-zh", "中文列", sh.commonTermsZhCol], ["sh-b1-en", "英文列", sh.commonTermsEnCol], ["sh-b1-nt", "备注列", sh.commonTermsNoteCol]])}</div>
        <div class="config-row-block">${urlCell("sh-b2-url", "B2 话在肉身显现单篇摘自 (202210) Google Sheet 链接", sh.wordCitationsUrl, "粘贴 B2 单篇摘自总表链接 (#gid=...)")}${inpGrid("col-grid-5", [["sh-b2-hr", "表头行", sh.wordCitationsHeaderRow, true], ["sh-b2-zd", "中文破折号", sh.wordCitationsZhDashCol], ["sh-b2-zb", "中文字幕带", sh.wordCitationsZhBandCol], ["sh-b2-er", "英文朗诵", sh.wordCitationsEnReadCol], ["sh-b2-eb", "英文字幕带", sh.wordCitationsEnBandCol]])}</div>
        <div class="config-row-block">${urlCell("sh-b3-url", "B3 诗歌 LRC 摘自新版 Google Sheet 链接", sh.hymnCitationsUrl, "粘贴 B3 诗歌摘自总表链接 (#gid=...)")}${inpGrid("col-grid-3", [["sh-b3-hr", "表头行", sh.hymnCitationsHeaderRow, true], ["sh-b3-zh", "中文列", sh.hymnCitationsZhCol], ["sh-b3-en", "英文列", sh.hymnCitationsEnCol]])}</div>
        <div class="config-row-block">${urlCell("sh-b4-url", "B4 主祷文 (202605 按行排布) Google Sheet 链接", sh.lordsPrayerUrl, "粘贴 B4 主祷文总表链接 (#gid=...)")}${inpGrid("col-grid-3", [["sh-b4-hr", "表头行", sh.lordsPrayerHeaderRow, true], ["sh-b4-zh", "A列(语种/中文)", sh.lordsPrayerZhCol], ["sh-b4-en", "B列(主祷文/英文)", sh.lordsPrayerEnCol]])}</div>
        <div class="config-row-block">${urlCell("sh-b5-url", "B5 报道人名教会名库 Google Sheet 链接", sh.rosterUrl, "粘贴 B5 报道人名与教会名总表链接 (#gid=...)")}${inpGrid("col-grid-4", [["sh-b5-hr", "表头行", sh.rosterHeaderRow, true], ["sh-b5-zh", "中文列(C)", sh.rosterZhCol], ["sh-b5-en", "英文列(D)", sh.rosterEnCol], ["sh-b5-ep", "期数列(F)", sh.rosterEpisodeCol]])}</div>
      </div>`;

    const langOpts = store.availableLanguages.map((l) => `<option value="${esc(l)}" ${l === activeLang ? "selected" : ""}>${esc(l)}</option>`).join("");

    const tabPerLangHtml = `
      <div class="col-grid-2">
        <div class="field-group"><label class="field-label" for="sel-cfg-lang">当前配置语种</label><select id="sel-cfg-lang" class="select-input">${langOpts}</select></div>
        <div class="field-group"><label class="field-label" for="inp-cfg-add-lang">+ 新增语种</label><div style="display:flex;gap:0.4rem"><input id="inp-cfg-add-lang" class="text-input" placeholder="输入语种名称（如：斯瓦希里语）" /><button type="button" id="btn-cfg-add-lang" class="btn">+ 新增语种</button></div></div>
      </div>
      <div class="config-section-list">
        <div class="config-row-block">
          <div class="col-grid-2">${urlCell("pl-cat-url", "书籍目录与单篇链接 Sheet", lk.articleCatalogUrl, "六本书新摘自 Sheet 链接")}${urlCell("pl-extra-cite", "摘自补充 Sheet", lk.extraCitationSheetUrl ?? "", "额外摘自子表链接（可选）")}</div>
          ${inpGrid("col-grid-5", [["pl-c1-hr", "目录表头行", lc.catalogHeaderRow, true], ["pl-c1-b", "中括号(B)", lc.catalogZhBracketCol], ["pl-c1-c", "中横线(C)", lc.catalogZhLineCol], ["pl-c1-d", "中文篇名(D)", lc.catalogZhTitleCol], ["pl-c1-e", "英文篇名(E)", lc.catalogEnTitleCol], ["pl-c1-f", "外文篇名(F)", lc.catalogTargetTitleCol], ["pl-c1-g", "单篇链接(G)", lc.catalogDocLinkCol], ["pl-c1-h", "字幕摘自(H)", lc.catalogTargetCiteCol], ["pl-c1-i", "括号摘自(I)", lc.catalogTargetBracketCiteCol || "I"]])}
          ${inpGrid("col-grid-3", [["pl-c2-zh", "单篇.docx 中文列序(1)", lc.manuscriptZhColIndex, true], ["pl-c2-en", "单篇.docx 英文列序(2)", lc.manuscriptEnColIndex, true], ["pl-c2-tg", "单篇.docx 目标列序(3)", lc.manuscriptTargetColIndex, true]])}
        </div>
        <div class="config-row-block">${urlCell("pl-bib-url", "圣经经文库 Sheet", lk.bibleSheetUrl, "唯一圣经库 Sheet 链接 (#gid=...)")}${inpGrid("col-grid-5", [["pl-c3-hr", "表头行", lc.bibleHeaderRow, true], ["pl-c3-b", "章节列(B)", lc.bibleChapterCol], ["pl-c3-c", "中文列(C)", lc.bibleZhCol], ["pl-c3-d", "英文列(D)", lc.bibleEnCol], ["pl-c3-e", "目标语列(E)", lc.bibleTargetCol]])}</div>
        <div class="config-row-block">${urlCell("pl-idm-url", "新俗语表 Sheet", lk.idiomSheetUrl, "新俗语表 Sheet 链接 (#gid=...)")}${inpGrid("col-grid-5", [["pl-c4-hr", "表头行", lc.idiomHeaderRow, true], ["pl-c4-f", "中文列(F)", lc.idiomZhCol], ["pl-c4-g", "英文1列(G)", lc.idiomEn1Col], ["pl-c4-i", "英文2列(I)", lc.idiomEn2Col], ["pl-c4-j", "目标语列(J)", lc.idiomTargetCol]])}</div>
        <div class="config-row-block"><div class="col-grid-2">${urlCell("pl-hym-url", "默认诗歌歌词表 Sheet", lk.hymnSheetUrl, "诗歌歌词总表链接")}${urlCell("pl-hym-ep", "本期临时诗歌子表链接（可选）", store.episodeHymnOverrides[activeLang] ?? "", "仅对当期任务生效的临时诗歌 #gid 链接")}</div>${inpGrid("col-grid-4", [["pl-c5-hr", "表头行", lc.hymnHeaderRow, true], ["pl-c5-a", "中文列(A)", lc.hymnZhCol], ["pl-c5-b", "英文列(B)", lc.hymnEnCol], ["pl-c5-c", "目标语列(C)", lc.hymnTargetCol]])}</div>
      </div>`;

    dialog.innerHTML = `
      <div class="dialog-header">
        <h2 id="dlg-catalog-title" class="dialog-title">资源表格配置清单与列设置中心</h2>
        <button type="button" class="seg-option" data-close-cc aria-label="关闭窗口">${icons.close}</button>
      </div>
      <div class="dialog-tabs-bar" role="tablist" aria-label="资源与列配置分类">
        <button type="button" role="tab" class="tab-btn" data-cc-tab="spec" aria-selected="${activeTab === "spec"}">配置规范清单</button>
        <button type="button" role="tab" class="tab-btn" data-cc-tab="shared" aria-selected="${activeTab === "shared"}">公共总表设置 (B1~B5)</button>
        <button type="button" role="tab" class="tab-btn" data-cc-tab="per-lang" aria-selected="${activeTab === "per-lang"}">分语种资料表与列设置 (C1~C5)</button>
      </div>
      <div class="dialog-body" role="tabpanel">
        ${notice ? `<div class="notice-bar notice-info" style="border-radius:8px">${esc(notice)}</div>` : ""}
        ${activeTab === "spec" ? tabSpecHtml : activeTab === "shared" ? tabSharedHtml : tabPerLangHtml}
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-cc>关闭</button>
        ${activeTab !== "spec" ? `<button type="button" id="btn-cc-save" class="btn btn-primary" autofocus>保存当前设置</button>` : ""}
      </div>`;

    dialog.querySelectorAll("[data-close-cc]").forEach((b) => b.addEventListener("click", () => dialog.close()));
    dialog.querySelectorAll<HTMLButtonElement>("[data-cc-tab]").forEach((btn) =>
      btn.addEventListener("click", () => {
        activeTab = (btn.dataset.ccTab as ConfigTabId) || "spec";
        render();
      }),
    );
    dialog.querySelector("#btn-dl-cfg-tpl")?.addEventListener("click", actions.onDownloadTemplateXlsx);
    dialog.querySelector("#sel-cfg-lang")?.addEventListener("change", (e) => {
      activeLang = (e.target as HTMLSelectElement).value;
      render();
    });
    dialog.querySelector("#btn-cfg-add-lang")?.addEventListener("click", () => {
      const val = dialog.querySelector<HTMLInputElement>("#inp-cfg-add-lang")?.value.trim() ?? "";
      if (!val) return;
      if (!store.availableLanguages.includes(val)) store.availableLanguages.push(val);
      activeLang = val;
      notifyStateChanged();
      render(`已新增语种「${val}」，请在下方配置其资料表与列号。`);
    });

    dialog.querySelector("#btn-cc-save")?.addEventListener("click", () => {
      const val = (id: string, fb = "") => dialog.querySelector<HTMLInputElement>(id)?.value.trim() || fb;
      const col = (id: string, fb: string) => val(id, fb).toUpperCase();
      const num = (id: string, fb: number) => Math.max(1, Number(dialog.querySelector<HTMLInputElement>(id)?.value || fb));

      if (activeTab === "shared") {
        store.sharedSheets = {
          ...store.sharedSheets,
          commonTermsUrl: val("#sh-b1-url"),
          commonTermsHeaderRow: num("#sh-b1-hr", 1),
          commonTermsZhCol: col("#sh-b1-zh", "A"),
          commonTermsEnCol: col("#sh-b1-en", "B"),
          commonTermsNoteCol: col("#sh-b1-nt", "C"),
          wordCitationsUrl: val("#sh-b2-url"),
          wordCitationsHeaderRow: num("#sh-b2-hr", 2),
          wordCitationsZhDashCol: col("#sh-b2-zd", "A"),
          wordCitationsZhBandCol: col("#sh-b2-zb", "B"),
          wordCitationsEnReadCol: col("#sh-b2-er", "C"),
          wordCitationsEnBandCol: col("#sh-b2-eb", "D"),
          hymnCitationsUrl: val("#sh-b3-url"),
          hymnCitationsHeaderRow: num("#sh-b3-hr", 1),
          hymnCitationsZhCol: col("#sh-b3-zh", "A"),
          hymnCitationsEnCol: col("#sh-b3-en", "B"),
          lordsPrayerUrl: val("#sh-b4-url"),
          lordsPrayerHeaderRow: num("#sh-b4-hr", 1),
          lordsPrayerZhCol: col("#sh-b4-zh", "A"),
          lordsPrayerEnCol: col("#sh-b4-en", "B"),
          rosterUrl: val("#sh-b5-url"),
          rosterHeaderRow: num("#sh-b5-hr", 2),
          rosterZhCol: col("#sh-b5-zh", "C"),
          rosterEnCol: col("#sh-b5-en", "D"),
          rosterEpisodeCol: col("#sh-b5-ep", "F"),
        };
        notifyStateChanged();
        render("已保存公共总表 (B1~B5) 链接与列映射配置。");
      } else if (activeTab === "per-lang") {
        store.linksByLang.set(activeLang, {
          ...lk,
          langName: activeLang,
          articleCatalogUrl: val("#pl-cat-url"),
          extraCitationSheetUrl: val("#pl-extra-cite"),
          bibleSheetUrl: val("#pl-bib-url"),
          idiomSheetUrl: val("#pl-idm-url"),
          hymnSheetUrl: val("#pl-hym-url"),
        });
        const epHymn = val("#pl-hym-ep");
        if (epHymn) store.episodeHymnOverrides[activeLang] = epHymn;
        else delete store.episodeHymnOverrides[activeLang];

        store.colsByLang[activeLang] = {
          catalogHeaderRow: num("#pl-c1-hr", 1),
          catalogZhBracketCol: col("#pl-c1-b", "B"),
          catalogZhLineCol: col("#pl-c1-c", "C"),
          catalogZhTitleCol: col("#pl-c1-d", "D"),
          catalogEnTitleCol: col("#pl-c1-e", "E"),
          catalogTargetTitleCol: col("#pl-c1-f", "F"),
          catalogDocLinkCol: col("#pl-c1-g", "G"),
          catalogTargetCiteCol: col("#pl-c1-h", "H"),
          catalogTargetBracketCiteCol: col("#pl-c1-i", "I"),
          manuscriptZhColIndex: num("#pl-c2-zh", 1),
          manuscriptEnColIndex: num("#pl-c2-en", 2),
          manuscriptTargetColIndex: num("#pl-c2-tg", 3),
          bibleHeaderRow: num("#pl-c3-hr", 2),
          bibleChapterCol: col("#pl-c3-b", "B"),
          bibleZhCol: col("#pl-c3-c", "C"),
          bibleEnCol: col("#pl-c3-d", "D"),
          bibleTargetCol: col("#pl-c3-e", "E"),
          idiomHeaderRow: num("#pl-c4-hr", 1),
          idiomZhCol: col("#pl-c4-f", "F"),
          idiomEn1Col: col("#pl-c4-g", "G"),
          idiomEn2Col: col("#pl-c4-i", "I"),
          idiomTargetCol: col("#pl-c4-j", "J"),
          hymnHeaderRow: num("#pl-c5-hr", 1),
          hymnZhCol: col("#pl-c5-a", "A"),
          hymnEnCol: col("#pl-c5-b", "B"),
          hymnTargetCol: col("#pl-c5-c", "C"),
        };
        notifyStateChanged();
        render(`已保存「${activeLang}」的分语种资料表与列设置。`);
      }
    });
  };

  return {
    openCatalogConfigDialog: (initialTab = "spec") => {
      activeTab = initialTab;
      if (!store.availableLanguages.includes(activeLang)) activeLang = store.availableLanguages[0] || "乌克兰语";
      render();
      dialog.showModal();
    },
  };
}

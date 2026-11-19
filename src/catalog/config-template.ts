import type { RichSheetGrid } from "./catalog-types";
import { buildStyledXlsxWorkbook, type StyledSheetTab } from "./config-xlsx-writer";
import { BUILTIN_PUNCTUATION_RULES, resolvePunctuationRule } from "./lang-presets";
import type {
  BibleCitationMode,
  LanguageResourceLinks,
  PeriodPlacementMode,
  PunctuationRule,
} from "../types/domain";
import {
  type CloudWorkspaceConfig,
  DEFAULT_LANG_SHEET_COLS,
  DEFAULT_SHARED_SHEETS_CONFIG,
  DEFAULT_SOURCE_COL_CONFIG,
  type PerLanguageSheetColumnConfig,
  type SharedSheetsConfig,
  type SourceScriptColumnConfig,
} from "../types/schema-config";

export const CONFIG_TEMPLATE_SHEET_NAMES = {
  links: "1_资料表链接",
  cols: "2_表内列位置定位",
  rules: "3_标点规则(内置可微调)",
} as const;

const SHARED_LINK_ROWS: Array<{
  label: string;
  field: keyof Pick<
    SharedSheetsConfig,
    "commonTermsUrl" | "wordCitationsUrl" | "hymnCitationsUrl" | "lordsPrayerUrl" | "rosterUrl"
  >;
  note: string;
}> = [
  { label: "公共-新常用语", field: "commonTermsUrl", note: "含「全能神说」及书卷级摘自（词汇表-新常用语）" },
  { label: "公共-话在肉身显现摘自", field: "wordCitationsUrl", note: "词汇表-话在肉身显现摘自202210（视频朗诵/字幕带）" },
  { label: "公共-诗歌LRC摘自", field: "hymnCitationsUrl", note: "词汇表-诗歌LRC摘自新版" },
  { label: "公共-主祷文", field: "lordsPrayerUrl", note: "主祷文202605（A列语种、B列整段全文）" },
  { label: "公共-人名教会名库", field: "rosterUrl", note: "报道人名与教会名库（可选，按最新期号匹配）" },
];

type TableRowPair = { guide: string[]; values: string[] };

function makePair(scope: string, tableName: string, guideCols: string[], valueCols: string[]): TableRowPair {
  return {
    guide: [`${scope}(说明)`, tableName, ...guideCols],
    values: [scope, tableName, ...valueCols],
  };
}

function buildSourcePair(scope: string, s: SourceScriptColumnConfig): TableRowPair {
  return makePair(
    scope,
    "源剧本",
    ["表头行", "Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘", "输出工具提示列"],
    [String(s.headerRowNumber), s.lineCol, s.inTimeCol, s.outTimeCol, s.characterCol, s.chineseCol, s.englishCol, s.targetLangCol, s.noteCol, s.remarkCol, s.sendRemarkCol, s.filterCol, s.needExtractCol, s.outputHintCol],
  );
}

function buildPerLangPairs(scope: string, c: PerLanguageSheetColumnConfig): TableRowPair[] {
  return [
    makePair(scope, "六本书新摘自", ["表头行", "中文括号摘自", "中文字幕带摘自", "中文篇目", "英文篇目", "外文篇目", "神话单篇链接", "外文单行摘自", "外文括号摘自"], [String(c.catalogHeaderRow), c.catalogZhBracketCol, c.catalogZhLineCol, c.catalogZhTitleCol, c.catalogEnTitleCol, c.catalogTargetTitleCol, c.catalogDocLinkCol, c.catalogTargetCiteCol, c.catalogTargetBracketCiteCol]),
    makePair(scope, "单篇神话文档", ["固定填1", "中文列序号", "英文列序号", "外文列序号"], ["1", String(c.manuscriptZhColIndex), String(c.manuscriptEnColIndex), String(c.manuscriptTargetColIndex)]),
    makePair(scope, "圣经经文库", ["表头行", "英文章节", "中文经文", "英文经文", "外文经文"], [String(c.bibleHeaderRow), c.bibleChapterCol, c.bibleZhCol, c.bibleEnCol, c.bibleTargetCol]),
    makePair(scope, "新俗语表", ["表头行", "中文", "最新英文", "对应英文", "外文"], [String(c.idiomHeaderRow), c.idiomZhCol, c.idiomEn1Col, c.idiomEn2Col, c.idiomTargetCol]),
    makePair(scope, "诗歌歌词表", ["表头行", "中文", "英文", "外文"], [String(c.hymnHeaderRow), c.hymnZhCol, c.hymnEnCol, c.hymnTargetCol]),
  ];
}

function buildSharedPairs(sh: SharedSheetsConfig): TableRowPair[] {
  return [
    makePair("公共", "新常用语", ["表头行", "中文", "英文", "备注"], [String(sh.commonTermsHeaderRow), sh.commonTermsZhCol, sh.commonTermsEnCol, sh.commonTermsNoteCol]),
    makePair("公共", "话在肉身显现摘自", ["表头行", "中文破折号", "中文字幕带", "英文视频朗诵", "英文字幕带"], [String(sh.wordCitationsHeaderRow), sh.wordCitationsZhDashCol, sh.wordCitationsZhBandCol, sh.wordCitationsEnReadCol, sh.wordCitationsEnBandCol]),
    makePair("公共", "诗歌LRC摘自", ["表头行", "中文", "英文"], [String(sh.hymnCitationsHeaderRow), sh.hymnCitationsZhCol, sh.hymnCitationsEnCol]),
    makePair("公共", "主祷文", ["表头行", "语种/中文列", "全文/英文列"], [String(sh.lordsPrayerHeaderRow), sh.lordsPrayerZhCol, sh.lordsPrayerEnCol]),
    makePair("公共", "人名教会名库", ["表头行", "中文", "英文", "期数"], [String(sh.rosterHeaderRow), sh.rosterZhCol, sh.rosterEnCol, sh.rosterEpisodeCol]),
  ];
}

const PERIOD_TO_ZH: Record<PeriodPlacementMode, string> = {
  outside: "引号外",
  inside: "引号内",
  sentence_inside_phrase_outside: "整句在内短语在外",
};

const BIBLE_TO_ZH: Record<BibleCitationMode, string> = {
  same_as_english: "同英文规则",
  period_inside_quote_no_trailing: "引号内且末尾无句点",
};

export function buildConfigTemplateXlsx(current?: Partial<CloudWorkspaceConfig>): Uint8Array {
  const sourceCols = { ...DEFAULT_SOURCE_COL_CONFIG, ...(current?.sourceCols ?? {}) };
  const sharedSheets = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...(current?.sharedSheets ?? {}) };
  const rulesList = current?.rules?.length ? current.rules : BUILTIN_PUNCTUATION_RULES;
  const langs = [
    ...new Set([
      ...rulesList.map((r) => r.langName),
      ...BUILTIN_PUNCTUATION_RULES.map((r) => r.langName),
      ...Object.keys(current?.linksByLang ?? {}),
      ...Object.keys(current?.colsByLang ?? {}),
    ]),
  ];

  const linksTab: StyledSheetTab = {
    title: CONFIG_TEMPLATE_SHEET_NAMES.links,
    colWidths: [20, 42, 38, 36, 36, 36],
    rows: [
      { style: 1, cells: ["语系", "六本书新摘自（公共行放总表链接）", "圣经经文库（唯一指定）", "新俗语表", "诗歌歌词表（默认总表）", "备注 / 摘自补充链接"] },
      ...SHARED_LINK_ROWS.map((item) => ({
        style: 3,
        cells: [item.label, sharedSheets[item.field] ?? "", "", "", "", item.note],
      })),
      ...langs.map((l) => {
        const lk = current?.linksByLang?.[l];
        return {
          style: 0,
          cells: [l, lk?.articleCatalogUrl ?? "", lk?.bibleSheetUrl ?? "", lk?.idiomSheetUrl ?? "", lk?.hymnSheetUrl ?? "", lk?.extraCitationSheetUrl ?? ""],
        };
      }),
    ],
  };

  const colPairs: TableRowPair[] = [
    buildSourcePair("默认", sourceCols),
    ...buildPerLangPairs("默认", DEFAULT_LANG_SHEET_COLS),
    ...buildSharedPairs(sharedSheets),
  ];

  for (const [lang, cfg] of Object.entries(current?.colsByLang ?? {})) {
    const merged = { ...DEFAULT_LANG_SHEET_COLS, ...cfg };
    const diffs = buildPerLangPairs(lang, merged).filter((p, idx) => {
      const def = buildPerLangPairs("默认", DEFAULT_LANG_SHEET_COLS)[idx];
      return p.values.slice(2).join("|") !== def.values.slice(2).join("|");
    });
    colPairs.push(...diffs);
  }
  if (!Object.keys(current?.colsByLang ?? {}).length) {
    colPairs.push(
      makePair("乌克兰语", "圣经经文库", ["表头行(示例:某语种列位不同时照此复制两行)", "英文章节", "中文经文", "英文经文", "乌克兰语经文"], ["2", "B", "C", "D", "E"]),
    );
  }

  const colsTab: StyledSheetTab = {
    title: CONFIG_TEMPLATE_SHEET_NAMES.cols,
    colWidths: [18, 18, 10, 12, 12, 12, 12, 12, 12, 14, 12, 12, 12, 12, 12, 14],
    rows: [
      { style: 1, cells: ["语系（默认=全语种通用）", "表格名称", "表头行", "列1", "列2", "列3", "列4", "列5", "列6", "列7", "列8", "列9", "列10", "列11", "列12", "列13"] },
      ...colPairs.flatMap((p) => [
        { style: 2, cells: p.guide },
        { style: 0, cells: p.values },
      ]),
    ],
  };

  const rulesTab: StyledSheetTab = {
    title: CONFIG_TEMPLATE_SHEET_NAMES.rules,
    colWidths: [14, 18, 8, 8, 8, 8, 8, 10, 12, 18, 18, 14, 12],
    rows: [
      { style: 1, cells: ["语系", "识别别名", "左双引号", "右双引号", "内层左单引号", "内层右单引号", "撇号", "剧本省略号", "逗号在引号内", "句号位置", "圣经摘自句点", "仅单排通用摘自", "句末句号(无填无)"] },
      ...langs.map((l) => {
        const r = resolvePunctuationRule(l, rulesList);
        return {
          style: 0,
          cells: [r.langName, r.aliases.join("、"), r.doubleOpen, r.doubleClose, r.singleOpen, r.singleClose, r.apostrophe, r.ellipsis, r.commaInsideQuote ? "是" : "否", PERIOD_TO_ZH[r.periodMode], BIBLE_TO_ZH[r.bibleCitationMode], r.singleCitationRowOnly ? "是" : "否", r.sentencePeriodChar === "" ? "无" : (r.sentencePeriodChar ?? ".")],
        };
      }),
    ],
  };

  return buildStyledXlsxWorkbook([linksTab, colsTab, rulesTab]);
}

const cellStr = (g: RichSheetGrid | undefined, r: number, c: number, raw = false) =>
  raw ? (g?.[r]?.[c]?.text ?? "") : (g?.[r]?.[c]?.text ?? "").trim();

const cellUrl = (g: RichSheetGrid | undefined, r: number, c: number) => {
  const cell = g?.[r]?.[c];
  return cell?.url?.startsWith("http") ? cell.url.trim() : (cell?.text ?? "").trim();
};

const isColOrNumToken = (s: string) => /^([A-Za-z]{1,2}|\d+|AUTO)$/i.test(s.trim());
const intVal = (s: string, fb: number) => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
};
const colVal = (s: string, fb: string) => (/^[A-Za-z]{1,2}$|^AUTO$/i.test(s) ? s.toUpperCase() : fb);

function findSheet(map: Map<string, RichSheetGrid>, exact: string, prefixes: string[]): RichSheetGrid | undefined {
  if (map.has(exact)) return map.get(exact);
  for (const [k, v] of map.entries()) {
    const tk = k.trim();
    if (tk === exact || prefixes.some((p) => tk.startsWith(p))) return v;
  }
  return undefined;
}

function isGuideRow(scope: string, values: string[]): boolean {
  if (/[（()）]|说明|表头|备注|示例|标题/i.test(scope)) return true;
  const nonEmpty = values.filter(Boolean);
  return nonEmpty.length > 0 && nonEmpty.every((v) => !isColOrNumToken(v));
}

function applyColumnRow(
  scope: string,
  tableName: string,
  vals: string[],
  sourceCols: SourceScriptColumnConfig,
  sharedSheets: SharedSheetsConfig,
  defaultLangCols: PerLanguageSheetColumnConfig,
  langOverrides: Map<string, Partial<PerLanguageSheetColumnConfig>>,
): void {
  const isDefault = /^(默认|通用|全部|ALL|公共)$/i.test(scope);
  const t = tableName.replace(/\s+/g, "");

  if (t.includes("源剧本") || t.includes("剧本")) {
    const next: SourceScriptColumnConfig = {
      ...sourceCols,
      headerRowNumber: intVal(vals[0], sourceCols.headerRowNumber),
      lineCol: colVal(vals[1], sourceCols.lineCol),
      inTimeCol: colVal(vals[2], sourceCols.inTimeCol),
      outTimeCol: colVal(vals[3], sourceCols.outTimeCol),
      characterCol: colVal(vals[4], sourceCols.characterCol),
      chineseCol: colVal(vals[5], sourceCols.chineseCol),
      englishCol: colVal(vals[6], sourceCols.englishCol),
      targetLangCol: colVal(vals[7], sourceCols.targetLangCol),
      noteCol: colVal(vals[8], sourceCols.noteCol),
      remarkCol: colVal(vals[9], sourceCols.remarkCol),
      sendRemarkCol: colVal(vals[10], sourceCols.sendRemarkCol),
      filterCol: colVal(vals[11], sourceCols.filterCol),
      needExtractCol: colVal(vals[12], sourceCols.needExtractCol),
      outputHintCol: colVal(vals[13], sourceCols.outputHintCol),
    };
    const changedFromDefault = (["lineCol", "inTimeCol", "outTimeCol", "characterCol", "chineseCol", "englishCol", "targetLangCol", "noteCol", "remarkCol", "sendRemarkCol", "filterCol", "needExtractCol"] as const).some(
      (k) => next[k] !== DEFAULT_SOURCE_COL_CONFIG[k],
    );
    if (changedFromDefault) next.autoDetectByHeader = false;
    Object.assign(sourceCols, next);
    return;
  }

  if (t.includes("新常用语") || t.includes("常用语")) {
    sharedSheets.commonTermsHeaderRow = intVal(vals[0], sharedSheets.commonTermsHeaderRow);
    sharedSheets.commonTermsZhCol = colVal(vals[1], sharedSheets.commonTermsZhCol);
    sharedSheets.commonTermsEnCol = colVal(vals[2], sharedSheets.commonTermsEnCol);
    sharedSheets.commonTermsNoteCol = colVal(vals[3], sharedSheets.commonTermsNoteCol);
    return;
  }
  if (t.includes("话在肉身显现")) {
    sharedSheets.wordCitationsHeaderRow = intVal(vals[0], sharedSheets.wordCitationsHeaderRow);
    sharedSheets.wordCitationsZhDashCol = colVal(vals[1], sharedSheets.wordCitationsZhDashCol);
    sharedSheets.wordCitationsZhBandCol = colVal(vals[2], sharedSheets.wordCitationsZhBandCol);
    sharedSheets.wordCitationsEnReadCol = colVal(vals[3], sharedSheets.wordCitationsEnReadCol);
    sharedSheets.wordCitationsEnBandCol = colVal(vals[4], sharedSheets.wordCitationsEnBandCol);
    return;
  }
  if (t.includes("诗歌LRC") || t.includes("诗歌摘自")) {
    sharedSheets.hymnCitationsHeaderRow = intVal(vals[0], sharedSheets.hymnCitationsHeaderRow);
    sharedSheets.hymnCitationsZhCol = colVal(vals[1], sharedSheets.hymnCitationsZhCol);
    sharedSheets.hymnCitationsEnCol = colVal(vals[2], sharedSheets.hymnCitationsEnCol);
    return;
  }
  if (t.includes("主祷文")) {
    sharedSheets.lordsPrayerHeaderRow = intVal(vals[0], sharedSheets.lordsPrayerHeaderRow);
    sharedSheets.lordsPrayerZhCol = colVal(vals[1], sharedSheets.lordsPrayerZhCol);
    sharedSheets.lordsPrayerEnCol = colVal(vals[2], sharedSheets.lordsPrayerEnCol);
    return;
  }
  if (t.includes("人名") || t.includes("教会名")) {
    sharedSheets.rosterHeaderRow = intVal(vals[0], sharedSheets.rosterHeaderRow);
    sharedSheets.rosterZhCol = colVal(vals[1], sharedSheets.rosterZhCol);
    sharedSheets.rosterEnCol = colVal(vals[2], sharedSheets.rosterEnCol);
    sharedSheets.rosterEpisodeCol = colVal(vals[3], sharedSheets.rosterEpisodeCol);
    return;
  }

  const patch: Partial<PerLanguageSheetColumnConfig> = {};
  if (t.includes("六本书") || t.includes("书籍目录")) {
    patch.catalogHeaderRow = intVal(vals[0], defaultLangCols.catalogHeaderRow);
    patch.catalogZhBracketCol = colVal(vals[1], defaultLangCols.catalogZhBracketCol);
    patch.catalogZhLineCol = colVal(vals[2], defaultLangCols.catalogZhLineCol);
    patch.catalogZhTitleCol = colVal(vals[3], defaultLangCols.catalogZhTitleCol);
    patch.catalogEnTitleCol = colVal(vals[4], defaultLangCols.catalogEnTitleCol);
    patch.catalogTargetTitleCol = colVal(vals[5], defaultLangCols.catalogTargetTitleCol);
    patch.catalogDocLinkCol = colVal(vals[6], defaultLangCols.catalogDocLinkCol);
    patch.catalogTargetCiteCol = colVal(vals[7], defaultLangCols.catalogTargetCiteCol);
    patch.catalogTargetBracketCiteCol = colVal(vals[8], defaultLangCols.catalogTargetBracketCiteCol);
  } else if (t.includes("单篇") || t.includes("神话文档")) {
    patch.manuscriptZhColIndex = intVal(vals[1], defaultLangCols.manuscriptZhColIndex);
    patch.manuscriptEnColIndex = intVal(vals[2], defaultLangCols.manuscriptEnColIndex);
    patch.manuscriptTargetColIndex = intVal(vals[3], defaultLangCols.manuscriptTargetColIndex);
  } else if (t.includes("圣经")) {
    patch.bibleHeaderRow = intVal(vals[0], defaultLangCols.bibleHeaderRow);
    patch.bibleChapterCol = colVal(vals[1], defaultLangCols.bibleChapterCol);
    patch.bibleZhCol = colVal(vals[2], defaultLangCols.bibleZhCol);
    patch.bibleEnCol = colVal(vals[3], defaultLangCols.bibleEnCol);
    patch.bibleTargetCol = colVal(vals[4], defaultLangCols.bibleTargetCol);
  } else if (t.includes("俗语")) {
    patch.idiomHeaderRow = intVal(vals[0], defaultLangCols.idiomHeaderRow);
    patch.idiomZhCol = colVal(vals[1], defaultLangCols.idiomZhCol);
    patch.idiomEn1Col = colVal(vals[2], defaultLangCols.idiomEn1Col);
    patch.idiomEn2Col = colVal(vals[3], defaultLangCols.idiomEn2Col);
    patch.idiomTargetCol = colVal(vals[4], defaultLangCols.idiomTargetCol);
  } else if (t.includes("诗歌")) {
    patch.hymnHeaderRow = intVal(vals[0], defaultLangCols.hymnHeaderRow);
    patch.hymnZhCol = colVal(vals[1], defaultLangCols.hymnZhCol);
    patch.hymnEnCol = colVal(vals[2], defaultLangCols.hymnEnCol);
    patch.hymnTargetCol = colVal(vals[3], defaultLangCols.hymnTargetCol);
  } else {
    return;
  }

  if (isDefault) Object.assign(defaultLangCols, patch);
  else langOverrides.set(scope, { ...(langOverrides.get(scope) ?? {}), ...patch });
}

function parsePeriodMode(raw: string, fallback: PeriodPlacementMode): PeriodPlacementMode {
  if (raw === "inside" || raw === "引号内") return "inside";
  if (raw === "outside" || raw === "引号外") return "outside";
  if (raw === "sentence_inside_phrase_outside" || raw.includes("整句在内")) return "sentence_inside_phrase_outside";
  return fallback;
}

function parseBibleMode(raw: string, fallback: BibleCitationMode): BibleCitationMode {
  if (raw === "same_as_english" || raw.includes("同英文")) return "same_as_english";
  if (raw === "period_inside_quote_no_trailing" || raw.includes("无句点")) return "period_inside_quote_no_trailing";
  return fallback;
}

export function parseCloudConfigSheets(sheetsByName: Map<string, RichSheetGrid>): CloudWorkspaceConfig {
  const sourceCols: SourceScriptColumnConfig = { ...DEFAULT_SOURCE_COL_CONFIG };
  const sharedSheets: SharedSheetsConfig = { ...DEFAULT_SHARED_SHEETS_CONFIG };
  const defaultLangCols: PerLanguageSheetColumnConfig = { ...DEFAULT_LANG_SHEET_COLS };
  const linksByLang: Record<string, LanguageResourceLinks> = {};
  const langOverrides = new Map<string, Partial<PerLanguageSheetColumnConfig>>();
  const rulesMap = new Map<string, PunctuationRule>(BUILTIN_PUNCTUATION_RULES.map((r) => [r.langName, { ...r }]));

  const gLinks = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.links, ["1_资料表链接", "2_各语种资料表链接"]);
  if (gLinks) {
    for (let r = 1; r < gLinks.length; r += 1) {
      const langName = cellStr(gLinks, r, 0);
      if (!langName) continue;
      const url1 = cellUrl(gLinks, r, 1);
      if (/^公共|【公共】/.test(langName)) {
        if (langName.includes("新常用语") || langName.includes("常用词汇")) sharedSheets.commonTermsUrl = url1;
        else if (langName.includes("话在肉身显现")) sharedSheets.wordCitationsUrl = url1;
        else if (langName.includes("诗歌")) sharedSheets.hymnCitationsUrl = url1;
        else if (langName.includes("主祷文")) sharedSheets.lordsPrayerUrl = url1;
        else if (langName.includes("人名") || langName.includes("教会名")) sharedSheets.rosterUrl = url1;
        continue;
      }
      const extraRaw = cellUrl(gLinks, r, 5);
      linksByLang[langName] = {
        langName,
        articleCatalogUrl: url1,
        bibleSheetUrl: cellUrl(gLinks, r, 2),
        idiomSheetUrl: cellUrl(gLinks, r, 3),
        hymnSheetUrl: cellUrl(gLinks, r, 4),
        extraCitationSheetUrl: extraRaw.startsWith("http") ? extraRaw : undefined,
        punctuationDocUrl: "",
        commonTermsUrl: "",
        godSaysUrl: "",
        lordsPrayerUrl: "",
        rosterSheetUrl: "",
      };
    }
  }

  const gCols = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.cols, ["2_表内列位置定位", "2_列位置"]);
  if (gCols) {
    for (let r = 1; r < gCols.length; r += 1) {
      const scope = cellStr(gCols, r, 0);
      const tableName = cellStr(gCols, r, 1);
      if (!scope || !tableName) continue;
      const vals = Array.from({ length: 14 }, (_v, idx) => cellStr(gCols, r, idx + 2));
      if (isGuideRow(scope, vals)) continue;
      applyColumnRow(scope, tableName, vals, sourceCols, sharedSheets, defaultLangCols, langOverrides);
    }
  }

  const colsByLang: Record<string, PerLanguageSheetColumnConfig> = {};
  const allLangNames = new Set([...Object.keys(linksByLang), ...langOverrides.keys()]);
  for (const l of allLangNames) {
    colsByLang[l] = { ...defaultLangCols, ...(langOverrides.get(l) ?? {}) };
  }

  const gRules = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.rules, ["3_标点规则", "4_各语种剧本标点规则"]);
  if (gRules) {
    const legacyOffset = cellStr(gRules, 0, 0).includes("代码") ? 1 : 0;
    for (let r = 1; r < gRules.length; r += 1) {
      const langName = cellStr(gRules, r, legacyOffset);
      if (!langName) continue;
      const base = resolvePunctuationRule(langName);
      const aliasCell = cellStr(gRules, r, legacyOffset + 1);
      const aliases = aliasCell ? aliasCell.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : base.aliases;
      const pc = cellStr(gRules, r, legacyOffset + 12);
      rulesMap.set(langName, {
        langCode: legacyOffset ? cellStr(gRules, r, 0) || base.langCode : base.langCode,
        langName,
        aliases: aliases.includes(langName) ? aliases : [langName, ...aliases],
        doubleOpen: cellStr(gRules, r, legacyOffset + 2, true) || base.doubleOpen,
        doubleClose: cellStr(gRules, r, legacyOffset + 3, true) || base.doubleClose,
        singleOpen: cellStr(gRules, r, legacyOffset + 4, true) || base.singleOpen,
        singleClose: cellStr(gRules, r, legacyOffset + 5, true) || base.singleClose,
        apostrophe: cellStr(gRules, r, legacyOffset + 6) || base.apostrophe,
        ellipsis: cellStr(gRules, r, legacyOffset + 7) || base.ellipsis,
        commaInsideQuote: /^(true|1|是|yes)$/i.test(cellStr(gRules, r, legacyOffset + 8)),
        periodMode: parsePeriodMode(cellStr(gRules, r, legacyOffset + 9), base.periodMode),
        bibleCitationMode: parseBibleMode(cellStr(gRules, r, legacyOffset + 10), base.bibleCitationMode),
        singleCitationRowOnly: /^(true|1|是|yes)$/i.test(cellStr(gRules, r, legacyOffset + 11)),
        sentencePeriodChar: /^(none|无)$/i.test(pc) ? "" : pc || base.sentencePeriodChar || ".",
      });
    }
  }

  return { sourceCols, sharedSheets, linksByLang, colsByLang, rules: [...rulesMap.values()] };
}

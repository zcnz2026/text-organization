import type { RichSheetGrid } from "./catalog-types";
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
  shared: "1_公共总表与源稿默认列",
  links: "2_各语种资料表链接",
  cols: "3_各语种表内列位置映射",
  rules: "4_各语种剧本标点规则",
} as const;

const SHARED_ROWS: Array<{
  key: string;
  sec: "source" | "shared";
  field: keyof SourceScriptColumnConfig | keyof SharedSheetsConfig;
  kind?: "bool" | "num";
  desc: string;
}> = [
  { key: "autoDetectByHeader", sec: "source", field: "autoDetectByHeader", kind: "bool", desc: "A1 源剧本：是否优先按表头自动识别列 (TRUE/FALSE)" },
  { key: "headerRowNumber", sec: "source", field: "headerRowNumber", kind: "num", desc: "A1 源剧本：表头所在行号 (默认 2)" },
  { key: "lineCol", sec: "source", field: "lineCol", desc: "A1 源剧本：Line 行号列 (默认 A)" },
  { key: "inTimeCol", sec: "source", field: "inTimeCol", desc: "A1 源剧本：In Time 入点列 (默认 B)" },
  { key: "outTimeCol", sec: "source", field: "outTimeCol", desc: "A1 源剧本：Out Time 出点列 (默认 C)" },
  { key: "characterCol", sec: "source", field: "characterCol", desc: "A1 源剧本：Character 角色列 (默认 D)" },
  { key: "chineseCol", sec: "source", field: "chineseCol", desc: "A1 源剧本：Chinese 中文列 (默认 E)" },
  { key: "englishCol", sec: "source", field: "englishCol", desc: "A1 源剧本：English底 英文列 (默认 F)" },
  { key: "targetLangCol", sec: "source", field: "targetLangCol", desc: "A1 源剧本：Target Language 目标外文列 (默认 G)" },
  { key: "noteCol", sec: "source", field: "noteCol", desc: "A1 源剧本：Note 字幕条/图卡列 (默认 H)" },
  { key: "remarkCol", sec: "source", field: "remarkCol", desc: "A1 源剧本：备注 出处说明列 (默认 I)" },
  { key: "sendRemarkCol", sec: "source", field: "sendRemarkCol", desc: "A1 源剧本：送翻备注列 (默认 J)" },
  { key: "filterCol", sec: "source", field: "filterCol", desc: "A1 源剧本：筛选分类列 (默认 K)" },
  { key: "needExtractCol", sec: "source", field: "needExtractCol", desc: "A1 源剧本：需要摘标记列 (默认 L)" },
  { key: "outputHintCol", sec: "source", field: "outputHintCol", desc: "A2 输出表：【工具提示】列位置 (AUTO 自动末列，或指定如 M)" },
  { key: "overviewMatrixUrl", sec: "shared", field: "overviewMatrixUrl", desc: "B0 概览总表链接（可选）" },
  { key: "commonTermsUrl", sec: "shared", field: "commonTermsUrl", desc: "B1 新常用语表链接（含「全能神说」及书卷级摘自）" },
  { key: "commonTermsHeaderRow", sec: "shared", field: "commonTermsHeaderRow", kind: "num", desc: "B1 新常用语表：表头行号 (默认 1)" },
  { key: "commonTermsZhCol", sec: "shared", field: "commonTermsZhCol", desc: "B1 新常用语表：中文列 (默认 A)" },
  { key: "commonTermsEnCol", sec: "shared", field: "commonTermsEnCol", desc: "B1 新常用语表：英文列 (默认 B)" },
  { key: "commonTermsNoteCol", sec: "shared", field: "commonTermsNoteCol", desc: "B1 新常用语表：说明列 (默认 C)" },
  { key: "wordCitationsUrl", sec: "shared", field: "wordCitationsUrl", desc: "B2 《话在肉身显现》单篇摘自总表链接 (202210)" },
  { key: "wordCitationsHeaderRow", sec: "shared", field: "wordCitationsHeaderRow", kind: "num", desc: "B2 话在肉身显现摘自表：语种表头行号 (默认 2)" },
  { key: "wordCitationsZhDashCol", sec: "shared", field: "wordCitationsZhDashCol", desc: "B2 话在肉身显现摘自表：中文破折号列 (默认 A)" },
  { key: "wordCitationsZhBandCol", sec: "shared", field: "wordCitationsZhBandCol", desc: "B2 话在肉身显现摘自表：中文字幕带列 (默认 B)" },
  { key: "wordCitationsEnReadCol", sec: "shared", field: "wordCitationsEnReadCol", desc: "B2 话在肉身显现摘自表：英文视频朗诵列 (默认 C)" },
  { key: "wordCitationsEnBandCol", sec: "shared", field: "wordCitationsEnBandCol", desc: "B2 话在肉身显现摘自表：英文字幕带列 (默认 D)" },
  { key: "hymnCitationsUrl", sec: "shared", field: "hymnCitationsUrl", desc: "B3 《诗歌LRC摘自》新版总表链接" },
  { key: "hymnCitationsHeaderRow", sec: "shared", field: "hymnCitationsHeaderRow", kind: "num", desc: "B3 诗歌LRC摘自表：表头行号 (默认 1)" },
  { key: "hymnCitationsZhCol", sec: "shared", field: "hymnCitationsZhCol", desc: "B3 诗歌LRC摘自表：中文列 (默认 A)" },
  { key: "hymnCitationsEnCol", sec: "shared", field: "hymnCitationsEnCol", desc: "B3 诗歌LRC摘自表：英文列 (默认 B)" },
  { key: "lordsPrayerUrl", sec: "shared", field: "lordsPrayerUrl", desc: "B4 《主祷文》多语种总表链接 (202605)" },
  { key: "lordsPrayerHeaderRow", sec: "shared", field: "lordsPrayerHeaderRow", kind: "num", desc: "B4 主祷文表：表头行号 (默认 1)" },
  { key: "lordsPrayerZhCol", sec: "shared", field: "lordsPrayerZhCol", desc: "B4 主祷文表：语种/中文列 (默认 A)" },
  { key: "lordsPrayerEnCol", sec: "shared", field: "lordsPrayerEnCol", desc: "B4 主祷文表：全文/英文列 (默认 B)" },
  { key: "rosterUrl", sec: "shared", field: "rosterUrl", desc: "B5 《报道人名教会名》总库链接" },
  { key: "rosterHeaderRow", sec: "shared", field: "rosterHeaderRow", kind: "num", desc: "B5 人名教会名库：表头行号 (默认 2)" },
  { key: "rosterZhCol", sec: "shared", field: "rosterZhCol", desc: "B5 人名教会名库：中文列 (默认 C)" },
  { key: "rosterEnCol", sec: "shared", field: "rosterEnCol", desc: "B5 人名教会名库：英文列 (默认 D)" },
  { key: "rosterEpisodeCol", sec: "shared", field: "rosterEpisodeCol", desc: "B5 人名教会名库：期数列 (默认 F)" },
];

const escXml = (s: string) =>
  (s || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function colRef(colIdx: number, rowNum: number): string {
  let n = colIdx + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return `${out}${rowNum}`;
}

function zipFiles(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nb = enc.encode(f.name);
    let crc = 0xffffffff;
    for (let i = 0; i < f.data.length; i += 1) {
      crc ^= f.data[i];
      for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const len = f.data.length;
    const lh = new Uint8Array(30 + nb.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, len, true);
    lv.setUint32(22, len, true);
    lv.setUint16(26, nb.length, true);
    lh.set(nb, 30);
    local.push(lh, f.data);
    const ch = new Uint8Array(46 + nb.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, len, true);
    cv.setUint32(24, len, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nb, 46);
    central.push(ch);
    offset += lh.length + len;
  }
  const cSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cSize + 22);
  let pos = 0;
  for (const p of [...local, ...central, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

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

  const tabs = [
    {
      title: CONFIG_TEMPLATE_SHEET_NAMES.shared,
      rows: [
        ["配置项键名 (请勿修改 A 列)", "当前配置值 (可修改 URL、列字母或行号)", "规范说明与默认取值"],
        ...SHARED_ROWS.map((item) => {
          const val = (item.sec === "source" ? sourceCols : sharedSheets)[item.field as never] as unknown;
          return [item.key, typeof val === "boolean" ? (val ? "TRUE" : "FALSE") : String(val ?? ""), item.desc];
        }),
      ],
    },
    {
      title: CONFIG_TEMPLATE_SHEET_NAMES.links,
      rows: [
        ["语种名称", "C1 书籍目录与单篇链接 Sheet URL", "C3 唯一圣经经文库 Sheet URL", "C4 新俗语表 Sheet URL", "C5 默认诗歌歌词表 Sheet URL", "C6 摘自补充 Sheet URL", "标点规范文档 URL", "独立常用语 URL", "独立全能神说 URL", "独立主祷文 URL", "独立人名库 URL"],
        ...langs.map((l) => {
          const lk = current?.linksByLang?.[l];
          return [l, lk?.articleCatalogUrl ?? "", lk?.bibleSheetUrl ?? "", lk?.idiomSheetUrl ?? "", lk?.hymnSheetUrl ?? "", lk?.extraCitationSheetUrl ?? "", lk?.punctuationDocUrl ?? "", lk?.commonTermsUrl ?? "", lk?.godSaysUrl ?? "", lk?.lordsPrayerUrl ?? "", lk?.rosterSheetUrl ?? ""];
        }),
      ],
    },
    {
      title: CONFIG_TEMPLATE_SHEET_NAMES.cols,
      rows: [
        ["语种名称", "目录表头行(1)", "目录中文括号摘自列(B)", "目录中文字幕带摘自列(C)", "目录中文篇目列(D)", "目录英文篇目列(E)", "目录外文篇目列(F)", "目录单篇链接列(G)", "目录外文字幕带摘自列(H)", "目录外文括号特效摘自列(I)", "单篇.docx中文列(1)", "单篇.docx英文列(2)", "单篇.docx外文列(3)", "圣经表头行(2)", "圣经章节列(B)", "圣经中文列(C)", "圣经英文列(D)", "圣经外文列(E)", "俗语表头行(1)", "俗语中文列(F)", "俗语英文1列(G)", "俗语英文2列(I)", "俗语外文列(J)", "诗歌表头行(1)", "诗歌中文列(A)", "诗歌英文列(B)", "诗歌外文列(C)"],
        ...langs.map((l) => {
          const c = { ...DEFAULT_LANG_SHEET_COLS, ...(current?.colsByLang?.[l] ?? {}) };
          return [l, String(c.catalogHeaderRow), c.catalogZhBracketCol, c.catalogZhLineCol, c.catalogZhTitleCol, c.catalogEnTitleCol, c.catalogTargetTitleCol, c.catalogDocLinkCol, c.catalogTargetCiteCol, c.catalogTargetBracketCiteCol, String(c.manuscriptZhColIndex), String(c.manuscriptEnColIndex), String(c.manuscriptTargetColIndex), String(c.bibleHeaderRow), c.bibleChapterCol, c.bibleZhCol, c.bibleEnCol, c.bibleTargetCol, String(c.idiomHeaderRow), c.idiomZhCol, c.idiomEn1Col, c.idiomEn2Col, c.idiomTargetCol, String(c.hymnHeaderRow), c.hymnZhCol, c.hymnEnCol, c.hymnTargetCol];
        }),
      ],
    },
    {
      title: CONFIG_TEMPLATE_SHEET_NAMES.rules,
      rows: [
        ["语种代码", "语种名称", "识别别名", "左双引号", "右双引号", "内层左单引号", "内层右单引号", "撇号形状", "剧本省略号", "逗号在引号内", "句号位置模式", "圣经摘自句点模式", "仅单排通用摘自", "句末句号字符(无填NONE)"],
        ...langs.map((l) => {
          const r = resolvePunctuationRule(l, rulesList);
          return [r.langCode, r.langName, r.aliases.join(", "), r.doubleOpen, r.doubleClose, r.singleOpen, r.singleClose, r.apostrophe, r.ellipsis, r.commaInsideQuote ? "TRUE" : "FALSE", r.periodMode, r.bibleCitationMode, r.singleCitationRowOnly ? "TRUE" : "FALSE", r.sentencePeriodChar === "" ? "NONE" : (r.sentencePeriodChar ?? ".")];
        }),
      ],
    },
  ];

  const enc = new TextEncoder();
  const sheetFiles = tabs.map((tab, idx) => {
    const rowsXml = tab.rows
      .map((r, rIdx) => `<row r="${rIdx + 1}">${r.map((v, cIdx) => `<c r="${colRef(cIdx, rIdx + 1)}"${rIdx === 0 ? ' s="1"' : ""} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`).join("")}</row>`)
      .join("");
    const ws = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rowsXml}</sheetData></worksheet>`;
    return { name: `xl/worksheets/sheet${idx + 1}.xml`, data: enc.encode(ws) };
  });

  const stylesId = tabs.length + 1;
  return zipFiles([
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${tabs.map((_t, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) },
    { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs.map((t, i) => `<sheet name="${escXml(t.title)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tabs.map((_t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF3"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs></styleSheet>`) },
    ...sheetFiles,
  ]);
}

const cellStr = (g: RichSheetGrid | undefined, r: number, c: number, raw = false) =>
  raw ? (g?.[r]?.[c]?.text ?? "") : (g?.[r]?.[c]?.text ?? "").trim();

const cellUrl = (g: RichSheetGrid | undefined, r: number, c: number) => {
  const cell = g?.[r]?.[c];
  return cell?.url?.startsWith("http") ? cell.url.trim() : (cell?.text ?? "").trim();
};

function findSheet(map: Map<string, RichSheetGrid>, exact: string, prefix: string): RichSheetGrid | undefined {
  if (map.has(exact)) return map.get(exact);
  for (const [k, v] of map.entries()) if (k.trim() === exact || k.trim().startsWith(prefix)) return v;
  return undefined;
}

export function parseCloudConfigSheets(sheetsByName: Map<string, RichSheetGrid>): CloudWorkspaceConfig {
  const sourceCols: SourceScriptColumnConfig = { ...DEFAULT_SOURCE_COL_CONFIG };
  const sharedSheets: SharedSheetsConfig = { ...DEFAULT_SHARED_SHEETS_CONFIG };
  const linksByLang: Record<string, LanguageResourceLinks> = {};
  const colsByLang: Record<string, PerLanguageSheetColumnConfig> = {};
  const rulesMap = new Map<string, PunctuationRule>(BUILTIN_PUNCTUATION_RULES.map((r) => [r.langName, { ...r }]));

  const gShared = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.shared, "1_");
  if (gShared) {
    const kv = new Map<string, string>();
    for (let r = 1; r < gShared.length; r += 1) {
      const k = cellStr(gShared, r, 0);
      if (k) kv.set(k, cellUrl(gShared, r, 1) || cellStr(gShared, r, 1));
    }
    for (const def of SHARED_ROWS) {
      if (!kv.has(def.key)) continue;
      const raw = kv.get(def.key) ?? "";
      const tgt = (def.sec === "source" ? sourceCols : sharedSheets) as unknown as Record<string, unknown>;
      if (def.kind === "bool") tgt[def.field] = /^true|1|是|yes$/i.test(raw);
      else if (def.kind === "num") {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) tgt[def.field] = n;
      } else if (raw) tgt[def.field] = raw;
    }
  }

  const gLinks = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.links, "2_");
  if (gLinks) {
    for (let r = 1; r < gLinks.length; r += 1) {
      const langName = cellStr(gLinks, r, 0);
      if (!langName) continue;
      linksByLang[langName] = {
        langName,
        articleCatalogUrl: cellUrl(gLinks, r, 1),
        bibleSheetUrl: cellUrl(gLinks, r, 2),
        idiomSheetUrl: cellUrl(gLinks, r, 3),
        hymnSheetUrl: cellUrl(gLinks, r, 4),
        extraCitationSheetUrl: cellUrl(gLinks, r, 5) || undefined,
        punctuationDocUrl: cellUrl(gLinks, r, 6),
        commonTermsUrl: cellUrl(gLinks, r, 7),
        godSaysUrl: cellUrl(gLinks, r, 8),
        lordsPrayerUrl: cellUrl(gLinks, r, 9),
        rosterSheetUrl: cellUrl(gLinks, r, 10),
      };
    }
  }

  const gCols = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.cols, "3_");
  if (gCols) {
    const intOr = (r: number, c: number, fb: number) => {
      const n = Number.parseInt(cellStr(gCols, r, c), 10);
      return Number.isFinite(n) && n > 0 ? n : fb;
    };
    const strOr = (r: number, c: number, fb: string) => cellStr(gCols, r, c) || fb;
    const d = DEFAULT_LANG_SHEET_COLS;
    for (let r = 1; r < gCols.length; r += 1) {
      const langName = cellStr(gCols, r, 0);
      if (!langName) continue;
      colsByLang[langName] = {
        catalogHeaderRow: intOr(r, 1, d.catalogHeaderRow),
        catalogZhBracketCol: strOr(r, 2, d.catalogZhBracketCol),
        catalogZhLineCol: strOr(r, 3, d.catalogZhLineCol),
        catalogZhTitleCol: strOr(r, 4, d.catalogZhTitleCol),
        catalogEnTitleCol: strOr(r, 5, d.catalogEnTitleCol),
        catalogTargetTitleCol: strOr(r, 6, d.catalogTargetTitleCol),
        catalogDocLinkCol: strOr(r, 7, d.catalogDocLinkCol),
        catalogTargetCiteCol: strOr(r, 8, d.catalogTargetCiteCol),
        catalogTargetBracketCiteCol: strOr(r, 9, d.catalogTargetBracketCiteCol),
        manuscriptZhColIndex: intOr(r, 10, d.manuscriptZhColIndex),
        manuscriptEnColIndex: intOr(r, 11, d.manuscriptEnColIndex),
        manuscriptTargetColIndex: intOr(r, 12, d.manuscriptTargetColIndex),
        bibleHeaderRow: intOr(r, 13, d.bibleHeaderRow),
        bibleChapterCol: strOr(r, 14, d.bibleChapterCol),
        bibleZhCol: strOr(r, 15, d.bibleZhCol),
        bibleEnCol: strOr(r, 16, d.bibleEnCol),
        bibleTargetCol: strOr(r, 17, d.bibleTargetCol),
        idiomHeaderRow: intOr(r, 18, d.idiomHeaderRow),
        idiomZhCol: strOr(r, 19, d.idiomZhCol),
        idiomEn1Col: strOr(r, 20, d.idiomEn1Col),
        idiomEn2Col: strOr(r, 21, d.idiomEn2Col),
        idiomTargetCol: strOr(r, 22, d.idiomTargetCol),
        hymnHeaderRow: intOr(r, 23, d.hymnHeaderRow),
        hymnZhCol: strOr(r, 24, d.hymnZhCol),
        hymnEnCol: strOr(r, 25, d.hymnEnCol),
        hymnTargetCol: strOr(r, 26, d.hymnTargetCol),
      };
    }
  }

  const gRules = findSheet(sheetsByName, CONFIG_TEMPLATE_SHEET_NAMES.rules, "4_");
  if (gRules) {
    for (let r = 1; r < gRules.length; r += 1) {
      const langCode = cellStr(gRules, r, 0);
      const langName = cellStr(gRules, r, 1);
      if (!langName) continue;
      const base = resolvePunctuationRule(langName);
      const aliases = cellStr(gRules, r, 2)
        ? cellStr(gRules, r, 2).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : base.aliases;
      const pm = cellStr(gRules, r, 10) as PeriodPlacementMode;
      const bm = cellStr(gRules, r, 11) as BibleCitationMode;
      const pc = cellStr(gRules, r, 13);
      rulesMap.set(langName, {
        langCode: langCode || base.langCode,
        langName,
        aliases: aliases.includes(langName) ? aliases : [langName, ...aliases],
        doubleOpen: cellStr(gRules, r, 3, true) || base.doubleOpen,
        doubleClose: cellStr(gRules, r, 4, true) || base.doubleClose,
        singleOpen: cellStr(gRules, r, 5, true) || base.singleOpen,
        singleClose: cellStr(gRules, r, 6, true) || base.singleClose,
        apostrophe: cellStr(gRules, r, 7) || base.apostrophe,
        ellipsis: cellStr(gRules, r, 8) || base.ellipsis,
        commaInsideQuote: /^true|1|是|yes$/i.test(cellStr(gRules, r, 9)),
        periodMode: pm === "outside" || pm === "inside" || pm === "sentence_inside_phrase_outside" ? pm : base.periodMode,
        bibleCitationMode: bm === "same_as_english" || bm === "period_inside_quote_no_trailing" ? bm : base.bibleCitationMode,
        singleCitationRowOnly: /^true|1|是|yes$/i.test(cellStr(gRules, r, 12)),
        sentencePeriodChar: pc.toUpperCase() === "NONE" ? "" : pc || base.sentencePeriodChar || ".",
      });
    }
  }

  return { sourceCols, sharedSheets, linksByLang, colsByLang, rules: [...rulesMap.values()] };
}

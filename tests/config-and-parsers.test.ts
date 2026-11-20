import { describe, expect, it } from "vitest";
import type { RichSheetGrid } from "../src/catalog/catalog-types";
import {
  buildConfigTemplateXlsx,
  CONFIG_TEMPLATE_SHEET_NAMES,
  parseCloudConfigSheets,
} from "../src/catalog/config-template";
import {
  BUILTIN_PUNCTUATION_RULES,
  resolvePunctuationRule,
} from "../src/catalog/lang-presets";
import {
  parseArticleCatalogSheet,
  parseHymnCitationsSheet,
  parseHymnSheet,
  parseLordsPrayerSheet,
  parseWordCitationsSheet,
} from "../src/catalog/sheet-parsers";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import {
  batchSplitTargetsWithAi,
  sliceTokensBySpans,
  tokenizeForIndexing,
} from "../src/engine/line-splitter";
import {
  runLanguageExtractionPipeline,
  splitLordsPrayerFullText,
} from "../src/engine/pipeline";
import {
  formatQuotedBlockLines,
  formatStandaloneTitle,
} from "../src/engine/punctuation";
import {
  aggregateHymnSublinesForBlock,
  findArticleInCatalog,
  findBibleVerse,
  locateParagraphInManuscript,
  normMatchKey,
  resolveCitationText,
} from "../src/engine/text-matcher";
import { parseDocxDocumentXml } from "../src/google/docx-drive-client";
import { parseGoogleResourceUrl } from "../src/google/url-parser";
import { isNewerVersion } from "../src/platform/updater";
import type { ScriptRow } from "../src/types/domain";
import { DEFAULT_LANG_SHEET_COLS } from "../src/types/schema-config";

function toRichGrid(rows: Array<Array<string | { text: string; url?: string }>>): RichSheetGrid {
  return rows.map((r) =>
    r.map((cell) => (typeof cell === "string" ? { text: cell } : cell)),
  );
}

function extractWorksheetsFromUncompressedXlsx(zipBytes: Uint8Array): Map<string, RichSheetGrid> {
  const view = new DataView(
    zipBytes.buffer,
    zipBytes.byteOffset,
    zipBytes.byteLength,
  );
  const dec = new TextDecoder("utf-8");

  let eocdPos = -1;
  for (let i = zipBytes.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  expect(eocdPos).toBeGreaterThanOrEqual(0);

  const entryCount = view.getUint16(eocdPos + 10, true);
  let cdOffset = view.getUint32(eocdPos + 16, true);
  const entries = new Map<string, string>();

  for (let idx = 0; idx < entryCount; idx += 1) {
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const fileName = dec.decode(
      zipBytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen),
    );
    cdOffset += 46 + nameLen + extraLen + commentLen;

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = zipBytes.subarray(dataStart, dataStart + compSize);
    entries.set(fileName, dec.decode(rawSlice));
  }

  const unesc = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");

  const workbookXml = entries.get("xl/workbook.xml") ?? "";
  const sheetNames: string[] = [];
  for (const m of workbookXml.matchAll(/<sheet\s+name="([^"]+)"/g)) {
    sheetNames.push(unesc(m[1]));
  }

  const sheetsByName = new Map<string, RichSheetGrid>();
  sheetNames.forEach((name, idx) => {
    const wsXml = entries.get(`xl/worksheets/sheet${idx + 1}.xml`) ?? "";
    const rows: RichSheetGrid = [];
    for (const rm of wsXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowCells: Array<{ text: string }> = [];
      for (const cm of rm[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
        rowCells.push({ text: unesc(cm[1]) });
      }
      rows.push(rowCells);
    }
    sheetsByName.set(name, rows);
  });

  return sheetsByName;
}

function makeScriptRow(partial: Partial<ScriptRow> & { rowIndex: number }): ScriptRow {
  return {
    rowIndex: partial.rowIndex,
    rawCells: [],
    line: partial.line ?? String(partial.rowIndex + 1),
    inTime: partial.inTime ?? "",
    outTime: partial.outTime ?? "",
    character: partial.character ?? "",
    chinese: partial.chinese ?? "",
    english: partial.english ?? "",
    targetLanguage: partial.targetLanguage ?? "",
    note: partial.note ?? "",
    remark: partial.remark ?? "",
    sendRemark: partial.sendRemark ?? "",
    filterCategory: partial.filterCategory ?? "",
    needExtract: partial.needExtract ?? "",
  };
}

describe("Cloud Configuration 3-Sheet Template & Round-Trip Parser", () => {
  it("builds valid 3-tab .xlsx bytes and round-trips custom settings across all 3 tabs", () => {
    const customBytes = buildConfigTemplateXlsx({
      sourceCols: {
        autoDetectByHeader: false,
        headerRowNumber: 3,
        lineCol: "B",
        inTimeCol: "C",
        outTimeCol: "D",
        characterCol: "E",
        chineseCol: "F",
        englishCol: "G",
        targetLangCol: "H",
        noteCol: "I",
        remarkCol: "J",
        sendRemarkCol: "K",
        filterCol: "L",
        needExtractCol: "M",
        outputHintCol: "N",
      },
      sharedSheets: {
        overviewMatrixUrl: "https://docs.google.com/spreadsheets/d/overview123",
        commonTermsUrl: "https://docs.google.com/spreadsheets/d/common123",
        commonTermsHeaderRow: 2,
        commonTermsZhCol: "B",
        commonTermsEnCol: "C",
        commonTermsNoteCol: "D",
        wordCitationsUrl: "https://docs.google.com/spreadsheets/d/wordcite123",
        wordCitationsHeaderRow: 2,
        wordCitationsZhDashCol: "A",
        wordCitationsZhBandCol: "B",
        wordCitationsEnReadCol: "C",
        wordCitationsEnBandCol: "D",
        hymnCitationsUrl: "https://docs.google.com/spreadsheets/d/hymncite123",
        hymnCitationsHeaderRow: 1,
        hymnCitationsZhCol: "A",
        hymnCitationsEnCol: "B",
        lordsPrayerUrl: "https://docs.google.com/spreadsheets/d/prayer123",
        lordsPrayerHeaderRow: 1,
        lordsPrayerZhCol: "A",
        lordsPrayerEnCol: "B",
        rosterUrl: "https://docs.google.com/spreadsheets/d/roster123",
        rosterHeaderRow: 2,
        rosterZhCol: "C",
        rosterEnCol: "D",
        rosterEpisodeCol: "F",
      },
      linksByLang: {
        乌克兰语: {
          langName: "乌克兰语",
          articleCatalogUrl: "https://docs.google.com/spreadsheets/d/uk_cat#gid=11",
          bibleSheetUrl: "https://docs.google.com/spreadsheets/d/uk_bible#gid=22",
          idiomSheetUrl: "https://docs.google.com/spreadsheets/d/uk_idiom#gid=33",
          hymnSheetUrl: "https://docs.google.com/spreadsheets/d/uk_hymn#gid=44",
          extraCitationSheetUrl: "https://docs.google.com/spreadsheets/d/uk_extra#gid=55",
          punctuationDocUrl: "https://docs.google.com/document/d/uk_punct",
          commonTermsUrl: "",
          godSaysUrl: "",
          lordsPrayerUrl: "",
          rosterSheetUrl: "",
        },
        斯瓦希里语: {
          langName: "斯瓦希里语",
          articleCatalogUrl: "https://docs.google.com/spreadsheets/d/sw_cat",
          bibleSheetUrl: "https://docs.google.com/spreadsheets/d/sw_bible",
          idiomSheetUrl: "",
          hymnSheetUrl: "",
          punctuationDocUrl: "",
          commonTermsUrl: "",
          godSaysUrl: "",
          lordsPrayerUrl: "",
          rosterSheetUrl: "",
        },
      },
      colsByLang: {
        乌克兰语: {
          ...DEFAULT_LANG_SHEET_COLS,
          catalogTargetCiteCol: "J",
          catalogTargetBracketCiteCol: "K",
          manuscriptZhColIndex: 2,
          manuscriptEnColIndex: 1,
          manuscriptTargetColIndex: 3,
          bibleHeaderRow: 3,
        },
      },
    });

    expect(customBytes.byteLength).toBeGreaterThan(2000);
    const extractedTabs = extractWorksheetsFromUncompressedXlsx(customBytes);
    expect([...extractedTabs.keys()]).toEqual([
      CONFIG_TEMPLATE_SHEET_NAMES.links,
      CONFIG_TEMPLATE_SHEET_NAMES.cols,
      CONFIG_TEMPLATE_SHEET_NAMES.rules,
    ]);

    const parsed = parseCloudConfigSheets(extractedTabs);
    expect(parsed.sourceCols.autoDetectByHeader).toBe(false);
    expect(parsed.sourceCols.headerRowNumber).toBe(3);
    expect(parsed.sourceCols.chineseCol).toBe("F");
    expect(parsed.sourceCols.outputHintCol).toBe("N");

    expect(parsed.sharedSheets.commonTermsUrl).toBe(
      "https://docs.google.com/spreadsheets/d/common123",
    );
    expect(parsed.sharedSheets.wordCitationsUrl).toBe(
      "https://docs.google.com/spreadsheets/d/wordcite123",
    );
    expect(parsed.sharedSheets.commonTermsHeaderRow).toBe(2);

    expect(parsed.linksByLang["乌克兰语"].articleCatalogUrl).toBe(
      "https://docs.google.com/spreadsheets/d/uk_cat#gid=11",
    );
    expect(parsed.linksByLang["乌克兰语"].extraCitationSheetUrl).toBe(
      "https://docs.google.com/spreadsheets/d/uk_extra#gid=55",
    );
    expect(parsed.linksByLang["斯瓦希里语"].bibleSheetUrl).toBe(
      "https://docs.google.com/spreadsheets/d/sw_bible",
    );

    expect(parsed.colsByLang["乌克兰语"].catalogTargetCiteCol).toBe("J");
    expect(parsed.colsByLang["乌克兰语"].catalogTargetBracketCiteCol).toBe("K");
    expect(parsed.colsByLang["乌克兰语"].manuscriptZhColIndex).toBe(2);
    expect(parsed.colsByLang["乌克兰语"].manuscriptEnColIndex).toBe(1);
    expect(parsed.colsByLang["乌克兰语"].bibleHeaderRow).toBe(3);

    expect(parsed.rules.length).toBeGreaterThanOrEqual(28);
    const frRule = parsed.rules.find((r) => r.langName === "法语")!;
    expect(frRule.doubleOpen).toBe("« ");
    expect(frRule.doubleClose).toBe(" »");
    const jaRule = parsed.rules.find((r) => r.langName === "日语")!;
    expect(jaRule.sentencePeriodChar).toBe("");
  });

  it("ignores free-form human guide rows and applies language overrides in 2-row positioning sheet", () => {
    const sheets = new Map<string, RichSheetGrid>([
      [
        CONFIG_TEMPLATE_SHEET_NAMES.links,
        toRichGrid([
          ["语系", "六本书新摘自", "圣经经文库", "新俗语表", "诗歌歌词表", "备注"],
          ["乌克兰语", "https://docs.google.com/spreadsheets/d/uk_cat", "https://docs.google.com/spreadsheets/d/uk_bib", "", "", ""],
          ["西班牙语", "https://docs.google.com/spreadsheets/d/es_cat", "https://docs.google.com/spreadsheets/d/es_bib", "", "", ""],
        ]),
      ],
      [
        CONFIG_TEMPLATE_SHEET_NAMES.cols,
        toRichGrid([
          ["语系", "表格名称", "表头行", "列1", "列2", "列3", "列4"],
          ["乌克兰语圣经经文表头", "圣经经文库", "表头行", "英文章节B列", "C列中文经文", "D列英文经文", "F列乌克兰语经文"],
          ["乌克兰语", "圣经经文库", "3", "B", "C", "D", "F"],
        ]),
      ],
    ]);
    const parsed = parseCloudConfigSheets(sheets);
    expect(parsed.colsByLang["乌克兰语"].bibleHeaderRow).toBe(3);
    expect(parsed.colsByLang["乌克兰语"].bibleTargetCol).toBe("F");
    expect(parsed.colsByLang["西班牙语"].bibleHeaderRow).toBe(2);
    expect(parsed.colsByLang["西班牙语"].bibleTargetCol).toBe("E");
  });
});

describe("27+ Language Punctuation Presets from 整理剧本各语言标点符号用法.xlsx", () => {
  it("includes all 28 preset languages with accurate script ellipsis, nested quotes, and period characters", () => {
    expect(BUILTIN_PUNCTUATION_RULES.length).toBeGreaterThanOrEqual(28);

    // Script ellipsis [...] vs (...) vs ... vs ……
    for (const lang of ["罗马尼亚语", "希腊语", "法语", "葡语", "西语", "荷兰语"]) {
      expect(resolvePunctuationRule(lang).ellipsis).toBe("[…]");
    }
    for (const lang of ["波兰语", "越南语"]) {
      expect(resolvePunctuationRule(lang).ellipsis).toBe("(…)");
    }
    for (const lang of ["印尼语", "希伯来语", "缅甸语", "印地语", "高棉语", "阿拉伯语", "老挝语", "俄语"]) {
      expect(resolvePunctuationRule(lang).ellipsis).toBe("...");
    }
    expect(resolvePunctuationRule("日语").ellipsis).toBe("……");
    expect(resolvePunctuationRule("韩语").ellipsis).toBe("…");

    // Nested single quotes
    const ro = resolvePunctuationRule("罗马尼亚语");
    expect([ro.doubleOpen, ro.doubleClose, ro.singleOpen, ro.singleClose]).toEqual(["„", "”", "«", "»"]);
    const el = resolvePunctuationRule("希腊语");
    expect([el.doubleOpen, el.doubleClose, el.singleOpen, el.singleClose]).toEqual(["«", "»", "“", "”"]);
    const pl = resolvePunctuationRule("波兰语");
    expect([pl.doubleOpen, pl.doubleClose, pl.singleOpen, pl.singleClose]).toEqual(["„", "”", "»", "«"]);
    const ru = resolvePunctuationRule("俄语");
    expect([ru.doubleOpen, ru.doubleClose, ru.singleOpen, ru.singleClose]).toEqual(["«", "»", "„", "“"]);
    const de = resolvePunctuationRule("德语");
    expect([de.doubleOpen, de.doubleClose, de.singleOpen, de.singleClose]).toEqual(["„", "“", "‚", "‘"]);

    // Script-forced straight quotes for Filipino & Tamil
    for (const lang of ["菲律宾语", "泰米尔语"]) {
      const rule = resolvePunctuationRule(lang);
      expect([rule.doubleOpen, rule.doubleClose, rule.singleOpen, rule.singleClose]).toEqual(['"', '"', "'", "'"]);
    }

    // Language-specific sentencePeriodChar: ।, ។, ။, and empty string for Ja/Th
    const hi = resolvePunctuationRule("印地语");
    expect(hi.sentencePeriodChar).toBe("।");
    expect(formatQuotedBlockLines(["“आज मौसम बहुत अच्छा है।”"], hi)).toEqual(['"आज मौसम बहुत अच्छा है।"']);

    const ne = resolvePunctuationRule("尼泊尔语");
    expect(ne.sentencePeriodChar).toBe("।");
    expect(formatStandaloneTitle("बिहानको घाम", '"Morning Sun."', "《晨光》。", ne)).toBe("“बिहानको घाम।”");

    const km = resolvePunctuationRule("高棉语");
    expect(km.sentencePeriodChar).toBe("។");
    expect(formatQuotedBlockLines(["«ថ្ងៃនេះអាកាសធាតុល្អ។»"], km)).toEqual(["«ថ្ងៃនេះអាកាសធាតុល្អ។»"]);

    const my = resolvePunctuationRule("缅甸语");
    expect(my.sentencePeriodChar).toBe("။");
    expect(formatQuotedBlockLines(["“ဒီနေ့ရာသီဥတုကောင်းတယ်။”"], my)).toEqual(["“ဒီနေ့ရာသီဥတုကောင်းတယ်။”"]);

    const ja = resolvePunctuationRule("日语");
    expect(ja.sentencePeriodChar).toBe("");
    expect(formatQuotedBlockLines(["「今日はとても良い天気です。」"], ja)).toEqual(["「今日はとても良い天気です」"]);

    // Nested quote transformation inside block
    const plOut = formatQuotedBlockLines(["\"To jest 'ważna' notatka.\""], pl);
    expect(plOut).toEqual(["„To jest »ważna« notatka”."]);
  });
});

describe("parseDocxDocumentXml 3-column table extraction & You(s) matching", () => {
  it("extracts 3-column paragraphs ignoring <w:del> track changes and matches You(s)/Your(s) in manuscript", () => {
    const sampleXml = `
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>你们应当认真准备，</w:t></w:r><w:del><w:r><w:delText>旧删除文字</w:delText></w:r></w:del><w:r><w:t>完成这项计划。</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>You(s) should carefully prepare and finish your(s) project well.</w:t></w:r><w:del><w:r><w:t>DELETED EN</w:t></w:r></w:del></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Ви повинні старанно підготуватися</w:t></w:r><w:del><w:r><w:t>СТАРИЙ ТЕКСТ</w:t></w:r></w:del><w:r><w:t> і добре завершити свій проєкт.</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>
    `;

    const paragraphs = parseDocxDocumentXml(sampleXml, 1, 2, 3);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].chinese).toBe("你们应当认真准备，完成这项计划。");
    expect(paragraphs[0].english).toBe(
      "You(s) should carefully prepare and finish your(s) project well.",
    );
    expect(paragraphs[0].target).toBe(
      "Ви повинні старанно підготуватися і добре завершити свій проєкт.",
    );

    // Verify normMatchKey strips (s) so script English without (s) matches .docx English with You(s)/your(s)
    expect(normMatchKey("You(s) should finish your(s) project")).toBe(
      normMatchKey("You should finish your project"),
    );

    const scriptRow = makeScriptRow({
      rowIndex: 0,
      chinese: "",
      english: "You should carefully prepare and finish your project well.",
    });
    const located = locateParagraphInManuscript(paragraphs, [scriptRow]);
    expect(located).not.toBeNull();
    expect(located?.matchedText).toBe(
      "Ви повинні старанно підготуватися і добре завершити свій проєкт.",
    );
  });
});

describe("parseLordsPrayerSheet row-per-language & 8-row pipeline splitting", () => {
  it("parses A=语种, B=整段文本 layout and splits cleanly across 8 script rows with final line aligned", async () => {
    const grid = toRichGrid([
      ["语种", "全文"],
      [
        "西班牙语",
        "¡Buenos días a todos! Hoy comenzamos un nuevo camino juntos, buscando aprender con calma y claridad. Queremos avanzar paso a paso, cuidar cada detalle, escuchar con atención y mantener la armonía. No nos detengamos ante las dudas, sino sigamos adelante con firmeza, porque el esfuerzo constante trae buenos frutos cada día. ¡Amén!",
      ],
    ]);

    const parsed = parseLordsPrayerSheet(grid, "西语");
    expect(parsed.fullText).toContain("¡Buenos días a todos!");
    expect(parsed.fullText.endsWith("¡Amén!")).toBe(true);

    const blockRows: ScriptRow[] = [
      makeScriptRow({ rowIndex: 0, chinese: "大家好，", english: "Good morning everyone," }),
      makeScriptRow({ rowIndex: 1, chinese: "今天我们一起开启新旅程，", english: "Today we begin a new journey together," }),
      makeScriptRow({ rowIndex: 2, chinese: "以平静清晰的心态去学习，", english: "seeking to learn with calm and clarity," }),
      makeScriptRow({ rowIndex: 3, chinese: "我们希望一步步前进，", english: "We want to move forward step by step," }),
      makeScriptRow({ rowIndex: 4, chinese: "关注每个细节并保持和谐。", english: "caring for every detail and keeping harmony." }),
      makeScriptRow({ rowIndex: 5, chinese: "不要因疑虑而停步，要坚定前行，", english: "Do not stop at doubts, but move forward firmly," }),
      makeScriptRow({ rowIndex: 6, chinese: "因为持续努力每天都会结出硕果！", english: "for steady effort brings good fruit every day!" }),
      makeScriptRow({ rowIndex: 7, chinese: "阿们！", english: "Amen!" }),
    ];

    const esRule = resolvePunctuationRule("西语");
    const split8 = await splitLordsPrayerFullText(parsed.fullText, blockRows, esRule);
    expect(split8).toHaveLength(8);
    expect(split8[0]).toBe("¡Buenos días a todos!");
    expect(split8[7]).toBe("¡Amén!");
    expect(split8.every((line) => line.length > 0)).toBe(true);
  });
});

describe("parseWordCitationsSheet dual-column & catalog H/I citation columns", () => {
  it("parses dual-column per language and resolves H/I columns from article catalog", () => {
    const wordCiteGrid = toRichGrid([
      ["单篇摘自总表", "", "", "", "乌克兰语", "", "西班牙语", ""],
      [
        "中文破折号",
        "中文字幕带",
        "英文视频朗诵",
        "英文字幕带",
        "乌语视频朗诵",
        "乌语字幕带",
        "西语视频朗诵",
        "西语字幕带",
      ],
      [
        "——《文集・卷一　总论・第一篇》",
        "《文集・卷一　总论・第一篇》",
        "(Collection, Vol. 1. Overview. Essay One).",
        "from Collection, Vol. 1. Overview. Essay One",
        "(Збірка, т. 1. Огляд. Нарис 1).",
        "зі «Збірка, т. 1. Огляд. Нарис 1»",
        "(Colección, Vol. 1. Resumen. Ensayo 1).",
        "de «Colección, Vol. 1. Resumen. Ensayo 1»",
      ],
    ]);

    const ukPairs = parseWordCitationsSheet(wordCiteGrid, "乌克兰语");
    expect(ukPairs.length).toBeGreaterThanOrEqual(1);
    expect(ukPairs[0].videoEffect).toBe("(Збірка, т. 1. Огляд. Нарис 1).");
    expect(ukPairs[0].subtitleBand).toBe("зі «Збірка, т. 1. Огляд. Нарис 1»");

    const hymnCiteGrid = toRichGrid([
      ["中文", "英文", "乌克兰语的摘自"],
      [
        "《歌集・晨光之歌》",
        "from Songbook, Song of Morning Light",
        "з «Пісенник. Пісня ранкового світла»",
      ],
    ]);
    const hymnPairs = parseHymnCitationsSheet(hymnCiteGrid, "乌语");
    expect(hymnPairs).toHaveLength(1);
    expect(hymnPairs[0].subtitleBand).toContain("Пісня ранкового світла");

    const catalogGrid = toRichGrid([
      ["序号", "中文括号摘自", "中文字幕带摘自", "中文篇目", "英文篇目", "乌语篇目", "单篇链接", "乌语字幕带摘自(H)", "乌语括号特效摘自(I)"],
      [
        "1",
        "（《文集・卷二　专题・第三篇》）",
        "——《文集・卷二　专题・第三篇》",
        "第三篇",
        "Essay Three",
        "Нарис 3",
        { text: "查看单篇", url: "https://docs.google.com/document/d/mock_doc_essay_3" },
        "зі «Збірка, т. 2. Тема. Нарис 3»",
        "(Збірка, т. 2. Тема. Нарис 3).",
      ],
    ]);

    const articles = parseArticleCatalogSheet(catalogGrid, DEFAULT_LANG_SHEET_COLS);
    expect(articles).toHaveLength(1);
    expect(articles[0].targetCite).toBe("зі «Збірка, т. 2. Тема. Нарис 3»");
    expect(articles[0].targetBracketCite).toBe("(Збірка, т. 2. Тема. Нарис 3).");

    const mockCatalog = {
      langName: "乌克兰语",
      rule: resolvePunctuationRule("乌克兰语"),
      godSaysText: "",
      commonFixedTerms: new Map<string, string>(),
      citations: [],
      articles,
      articleDocsCache: new Map(),
      bibleEntries: [],
      idioms: [],
      hymns: [],
      lordsPrayer: [],
      rosterEntries: [],
    };

    const citeRow = makeScriptRow({
      rowIndex: 0,
      chinese: "（《文集・卷二　专题・第三篇》）",
      english: "(Collection, Vol. 2. Topic. Essay Three).",
      filterCategory: "卷二　专题・第三篇",
    });

    expect(resolveCitationText(mockCatalog, citeRow, "video_effect")).toBe(
      "(Збірка, т. 2. Тема. Нарис 3).",
    );
    expect(resolveCitationText(mockCatalog, citeRow, "subtitle_band")).toBe(
      "зі «Збірка, т. 2. Тема. Нарис 3»",
    );
  });
});

describe("parseHymnSheet & LRC multi-subline aggregation", () => {
  it("keeps title-only entries separate, parses LRC sub-lines ignoring stanza markers, and aggregates multi-sublines", async () => {
    const hymnGrid = toRichGrid([
      ["专题一", "", ""],
      ["中文", "英文", "乌克兰语"],
      [
        "神话诗歌标题：《山谷微风》",
        "Title Only: Valley Breeze",
        "Вітер у долині",
      ],
      [
        "这是不应被收录为歌词的注释行，",
        "Placeholder line that should stay excluded,",
        "Рядок-заповнювач",
      ],
      [
        "教会诗歌：《晨光之歌》",
        "Song: Song of Morning Light",
        "Пісня ранкового світла",
      ],
      ["I", "I", "I"],
      [
        "清晨阳光洒在青翠的山坡，唤醒沉睡的大地，",
        "Morning sunlight falls on green hills, waking the sleeping earth.",
        "Ранкове сонце падає на зелені пагорби, пробуджуючи сплячу землю.",
      ],
      [
        "微风吹过清澈的溪水，",
        "A gentle breeze blows over the clear stream,",
        "Легкий вітер дме над прозорим струмком,",
      ],
      [
        "树叶在阳光下轻轻摇曳，",
        "while leaves sway softly in the sunlight.",
        "а листя тихо гойдається на сонці.",
      ],
      [
        "鸟儿在林间欢快地歌唱，",
        "Birds sing joyfully in the woods;",
        "Птахи радісно співають у лісі;",
      ],
      [
        "新的一天充满了希望。",
        "a new day is full of hope.",
        "новий день сповнений надії.",
      ],
      [
        "《歌集・晨光之歌》",
        "from Songbook, Song of Morning Light",
        "з «Пісенник. Пісня ранкового світла»",
      ],
    ]);

    const hymns = parseHymnSheet(hymnGrid);
    expect(hymns).toHaveLength(2);
    expect(hymns[0].zhTitle).toBe("山谷微风");
    expect(hymns[0].lines).toHaveLength(0);

    expect(hymns[1].zhTitle).toBe("晨光之歌");
    expect(hymns[1].lines).toHaveLength(5);
    expect(hymns[1].targetCitation).toBe("з «Пісенник. Пісня ранкового світла»");

    const blockRows: ScriptRow[] = [
      makeScriptRow({
        rowIndex: 0,
        line: "56",
        character: "Hymn",
        chinese: "“清晨阳光洒在青翠的山坡，唤醒沉睡的大地，",
        english: '"Morning sunlight falls on green hills, waking the sleeping earth.',
        filterCategory: "诗歌《晨光之歌》",
        needExtract: "需要摘",
      }),
      makeScriptRow({
        rowIndex: 1,
        line: "57",
        character: "Hymn",
        chinese: "微风吹过清澈的溪水，树叶在阳光下轻轻摇曳，",
        english: "A gentle breeze blows over the clear stream, while leaves sway softly in the sunlight.",
        filterCategory: "诗歌《晨光之歌》",
        needExtract: "需要摘",
      }),
      makeScriptRow({
        rowIndex: 2,
        line: "58",
        character: "Hymn",
        chinese: "鸟儿在林间欢快地歌唱，新的一天充满了希望。”",
        english: 'Birds sing joyfully in the woods; a new day is full of hope."',
        filterCategory: "诗歌《晨光之歌》",
        needExtract: "需要摘",
      }),
    ];

    const aggregated = aggregateHymnSublinesForBlock(hymns[1].lines, blockRows);
    expect(aggregated).toEqual([
      "Ранкове сонце падає на зелені пагорби, пробуджуючи сплячу землю.",
      "Легкий вітер дме над прозорим струмком, а листя тихо гойдається на сонці.",
      "Птахи радісно співають у лісі; новий день сповнений надії.",
    ]);
  });
});

describe("Custom SourceScriptColumnConfig remapped columns", () => {
  it("parses script document with swapped column letters when autoDetectByHeader is false", async () => {
    const grid: string[][] = [
      ["Meta Row", "", "", "", "", ""],
      ["Col1_EN", "Col2_ZH", "Col3_LINE", "Col4_FILTER", "Col5_EXTRACT", "Col6_TARGET"],
      [
        "Almighty God says:",
        "全能神说：",
        "101",
        "固定词",
        "需要摘",
        "",
      ],
    ];

    const doc = parseGridToScriptDocument(grid, "CustomLayout", {
      autoDetectByHeader: false,
      headerRowNumber: 2,
      englishCol: "A",
      chineseCol: "B",
      lineCol: "C",
      filterCol: "D",
      needExtractCol: "E",
      targetLangCol: "F",
      inTimeCol: "G",
      outTimeCol: "H",
      characterCol: "I",
      noteCol: "J",
      remarkCol: "K",
      sendRemarkCol: "L",
      outputHintCol: "M",
    });

    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0].line).toBe("101");
    expect(doc.rows[0].chinese).toBe("全能神说：");
    expect(doc.rows[0].english).toBe("Almighty God says:");
    expect(doc.rows[0].filterCategory).toBe("固定词");
    expect(doc.rows[0].needExtract).toBe("需要摘");

    const out = await runLanguageExtractionPipeline(
      doc,
      {
        langName: "乌克兰语",
        rule: resolvePunctuationRule("乌克兰语"),
        godSaysText: "Тестовий префікс",
        commonFixedTerms: new Map(),
        citations: [],
        articles: [],
        articleDocsCache: new Map(),
        bibleEntries: [],
        idioms: [],
        hymns: [],
        lordsPrayer: [],
        rosterEntries: [],
      },
      { enableRosterPreFill: false },
    );

    expect(out.rows[0].targetLanguage).toBe("Тестовий префікс:");
    expect(out.rows[0].status).toBe("matched");
  });

  it("disambiguates same-title articles across Vol.6 vs Vol.7 and parses drive.google.com/open?id= URLs", () => {
    const parsedUrl = parseGoogleResourceUrl(
      "https://drive.google.com/open?id=1MockDriveFileIdVol7Example00001&usp=drive_fs",
      "doc",
    );
    expect(parsedUrl).toEqual({ kind: "doc", id: "1MockDriveFileIdVol7Example00001", gid: null });

    const matched = findArticleInCatalog(
      [
        {
          zhBracketCite: "《文集・卷六　专题・同名篇目（三）》",
          zhSubtitleCite: "——《文集・卷六　专题・同名篇目（三）》",
          zhTitle: "同名篇目（三）",
          enTitle: "Same Title Essay (3)",
          targetTitle: "Нарис (3)",
          docUrl: "https://docs.google.com/document/d/vol6_doc_id",
          targetCite: "«Збірка, т. 6. ...»",
        },
        {
          zhBracketCite: "《文集・卷七　专题・同名篇目（三）》",
          zhSubtitleCite: "——《文集・卷七　专题・同名篇目（三）》",
          zhTitle: "同名篇目（三）",
          enTitle: "Same Title Essay (3)",
          targetTitle: "Нарис (3)",
          docUrl: "https://drive.google.com/open?id=1MockDriveFileIdVol7Example00001&usp=drive_fs",
          targetCite: "«Збірка, т. 7. ...»",
        },
      ],
      "卷七　专题・同名篇目（三）",
    );
    expect(matched?.docUrl).toContain("1MockDriveFileIdVol7Example00001");
  });

  it("parses shifted Indonesian hymn sheet (B/C/D) both via per-lang config and auto-header detection", () => {
    const cfg = parseCloudConfigSheets(
      new Map<string, RichSheetGrid>([
        [
          CONFIG_TEMPLATE_SHEET_NAMES.cols,
          toRichGrid([
            ["语系", "表格名称", "表头行", "列1", "列2", "列3"],
            ["印尼语(说明)", "诗歌LRC摘自", "表头行", "中文", "英文", "外文"],
            ["印尼语", "诗歌LRC摘自", "2", "B", "C", "D"],
          ]),
        ],
      ]),
    );
    expect(cfg.colsByLang["印尼语"].hymnZhCol).toBe("B");
    expect(cfg.colsByLang["印尼语"].hymnEnCol).toBe("C");
    expect(cfg.colsByLang["印尼语"].hymnTargetCol).toBe("D");

    const idHymnGrid = toRichGrid([
      ["", "专题备注", "", ""],
      ["", "中文", "英文", "印尼语"],
      ["", "神话诗歌标题：", "", ""],
      ["", "《山谷微风》", "Valley Breeze", "Angin Lembah"],
      ["", "教会诗歌：", "", ""],
      ["", "《晨光之歌》", "Song of Morning Light", "Lagu Cahaya Pagi"],
      ["", "I", "1", ""],
      ["", "清晨阳光洒在青翠的山坡，", "Morning sunlight falls on green hills,", "Sinar matahari pagi jatuh di bukit hijau,"],
    ]);
    const hymns = parseHymnSheet(idHymnGrid);
    expect(hymns).toHaveLength(2);
    expect(hymns[1].zhTitle).toBe("晨光之歌");
    expect(hymns[1].targetTitle).toBe("Lagu Cahaya Pagi");
    expect(hymns[1].lines).toHaveLength(1);
  });

  it("allows blank/missing columns in catalog and derives zhTitle from citation columns (Indonesian layout)", () => {
    const cfg = parseCloudConfigSheets(
      new Map<string, RichSheetGrid>([
        [
          CONFIG_TEMPLATE_SHEET_NAMES.cols,
          toRichGrid([
            ["语系", "表格名称", "表头行", "列1", "列2", "列3", "列4", "列5", "列6", "列7", "列8", "列9"],
            ["印尼语(说明)", "六本书新摘自", "表头行", "中文括号摘自", "中文字幕带摘自", "中文篇目", "英文篇目", "外文篇目", "单篇链接", "外文单行摘自", "外文括号摘自", "外文字幕带摘自"],
            ["印尼语", "六本书新摘自", "1", "B", "C", "", "D", "E", "F", "G", "H", "I"],
          ]),
        ],
      ]),
    );
    expect(cfg.colsByLang["印尼语"].catalogZhTitleCol).toBe("");
    expect(cfg.colsByLang["印尼语"].catalogDocLinkCol).toBe("F");
    expect(cfg.colsByLang["印尼语"].catalogTargetSubtitleBandCiteCol).toBe("I");

    const idCatalogGrid = toRichGrid([
      ["", "中文括号版摘自", "中文单独一行的摘自", "英语新标题", "印尼标题", "单篇稿链接", "单独一行+书名的摘自", "括号版+书名的摘自", "字幕带用的摘自"],
      [
        "",
        "《文集・卷一　总论・论工作与责任的区别》",
        "——《文集・卷一　总论・论工作与责任的区别》",
        "The Difference Between Work and Responsibility",
        "Perbedaan antara Pekerjaan dan Tanggung Jawab",
        { text: "https://docs.google.com/document/d/id_doc_mock", url: "https://docs.google.com/document/d/id_doc_mock" },
        "—Koleksi, Jilid 1. Ikhtisar",
        "(Koleksi, Jilid 1. Ikhtisar)",
        "Dikutip dari Koleksi, Jilid 1. Ikhtisar",
      ],
    ]);
    const entries = parseArticleCatalogSheet(idCatalogGrid, cfg.colsByLang["印尼语"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].zhTitle).toBe("论工作与责任的区别");
    expect(entries[0].docUrl).toBe("https://docs.google.com/document/d/id_doc_mock");
    expect(entries[0].targetCite).toContain("—Koleksi");
    expect(entries[0].targetBracketCite).toContain("(Koleksi");
    expect(entries[0].targetSubtitleBandCite).toContain("Dikutip dari Koleksi");
  });

  it("does not split hymn at unpunctuated lyric line and aggregates multi-sublines accurately", () => {
    const ukHymnGrid = toRichGrid([
      ["", "专题示例", "", ""],
      ["", "教会诗歌：", "", ""],
      ["", "《晨光之歌》", "Song of Morning Light", "Пісня ранкового світла"],
      ["", "I", "1", ""],
      ["", "清晨阳光洒在青翠山坡，", "Morning sunlight falls on green hills,", "Ранкове сонце падає на зелені пагорби,"],
      ["", "微风吹过清澈溪水，", "a gentle breeze blows over the stream,", "легкий вітер дме над струмком,"],
      ["", "树叶轻轻摇曳。", "and leaves sway softly.", "і листя тихо гойдається."],
      ["", "每天早起漫步林间", "Each morning I walk in the woods", "Щоранку я гуляю в лісі"],
      ["", "听见清脆鸟鸣，", "listening to clear birdsong,", "слухаючи дзвінкий спів птахів,"],
      ["", "心里充满喜悦。", "my heart is full of joy.", "і серце сповнюється радістю."],
      ["", "晨光之歌真美妙。", "The morning song is lovely.", "Пісня ранку чудова."],
      ["", "晨光之歌真美妙。", "The morning song is lovely.", "Пісня ранку чудова."],
    ]);

    const hymns = parseHymnSheet(ukHymnGrid);
    expect(hymns).toHaveLength(1);
    expect(hymns[0].lines).toHaveLength(8);

    const scriptRows = [
      makeScriptRow({ rowIndex: 0, chinese: "“清晨阳光洒在青翠山坡，", english: '"Morning sunlight falls on green hills,' }),
      makeScriptRow({ rowIndex: 1, chinese: "微风吹过清澈溪水，树叶轻轻摇曳。", english: "a gentle breeze blows over the stream, and leaves sway softly." }),
      makeScriptRow({ rowIndex: 2, chinese: "每天早起漫步林间听见清脆鸟鸣，心里充满喜悦。", english: "Each morning I walk in the woods listening to clear birdsong, my heart is full of joy." }),
      makeScriptRow({ rowIndex: 3, chinese: "晨光之歌很美妙。", english: "The morning song is lovely." }),
      makeScriptRow({ rowIndex: 4, chinese: "晨光之歌很美妙。”", english: 'The morning song is lovely."' }),
    ];

    const agg = aggregateHymnSublinesForBlock(hymns[0].lines, scriptRows);
    expect(agg).not.toBeNull();
    expect(agg![0]).toBe("Ранкове сонце падає на зелені пагорби,");
    expect(agg![1]).toBe("легкий вітер дме над струмком, і листя тихо гойдається.");
    expect(agg![2]).toBe("Щоранку я гуляю в лісі слухаючи дзвінкий спів птахів, і серце сповнюється радістю.");
    expect(agg![3]).toBe("Пісня ранку чудова.");
    expect(agg![4]).toBe("Пісня ранку чудова.");
  });

  it("matches single-row verse and merges multi-row consecutive verses with leading ellipsis", () => {
    const ukBible = [
      {
        chapterRef: "Luke\n17:24–25",
        chinese: "“第一句示例经文，照亮四方。第二句示例经文，继续前行。”（路17:24-25）",
        english: '"First synthetic verse shining everywhere. Second synthetic verse moving ahead." (Luke 17:24–25).',
        targetText: "«Перший тестовий рядок світить усюди. Другий тестовий рядок іде вперед...» (Луки 17:24–25).",
      },
      {
        chapterRef: "Romans\n7:15",
        chinese: "我所计划的，还未完成；我所忽略的，反而先做了。",
        english: "For what I planned, I have not done; what I overlooked, I did instead.",
        targetText: "«Бо те, що я планував, я не зробив, а те, що пропустив, зробив» (До Римлян 7:15).",
      },
      {
        chapterRef: "Romans\n7:16",
        chinese: "若我所做的并非本意，我就承认规章是好的。",
        english: "If then I do what I did not intend, I agree that the rule is good.",
        targetText: "«А коли роблю не за наміром, то визнаю, що правило добре» (До Римлян 7:16).",
      },
    ];

    const lukeHit = findBibleVerse(ukBible, "(Luke 17:24–25).", [
      makeScriptRow({ rowIndex: 0, chinese: "“第一句示例经文，", english: '"First synthetic verse' }),
      makeScriptRow({ rowIndex: 1, chinese: "照亮四方。", english: "shining everywhere." }),
      makeScriptRow({ rowIndex: 2, chinese: "第二句示例经文，继续前行”", english: 'Second synthetic verse moving ahead"' }),
    ]);
    expect(lukeHit).not.toBeNull();
    expect(lukeHit!.targetCitationRef).toBe("(Луки 17:24–25)");
    expect(lukeHit!.text).toContain("Перший тестовий рядок");

    const romHit = findBibleVerse(ukBible, "新约", [
      makeScriptRow({ rowIndex: 0, chinese: "“我所计划的，还未完成，", english: '"... what I planned, I have not done;' }),
      makeScriptRow({ rowIndex: 1, chinese: "我所忽略的，反而先做了，", english: "what I overlooked, I did instead." }),
      makeScriptRow({ rowIndex: 2, chinese: "若我所做的并非本意，我就承认规章是好的。”", english: 'If then I do what I did not intend, I agree that the rule is good."' }),
    ]);
    expect(romHit).not.toBeNull();
    expect(romHit!.truncatedStart).toBe(true);
    expect(romHit!.targetCitationRef).toBe("(До Римлян 7:15–16)");
    expect(romHit!.text).toContain("Бо те, що я планував");
    expect(romHit!.text).toContain("А коли роблю не за наміром");
  });

  it("slices single-row half-sentence excerpts at clause boundary (non-AI) and marks isPartial for AI semantic alignment", () => {
    const paragraphs = [
      {
        chinese: "在日常工作里有个常见的问题，这是很多人都会遇到的问题，而且是一个很关键的问题，这个常见的问题就是时间规划不够清晰。",
        english: "There is a common issue in daily work, an issue which many people encounter, and a very key one at that. This common issue is that time planning is not clear enough.",
        target: "У щоденній роботі є спільна проблема — проблема, з якою стикаються багато людей, і дуже важлива проблема. Ця спільна проблема полягає в нечіткому плануванні часу.",
      },
    ];
    const row452 = [
      makeScriptRow({
        rowIndex: 0,
        line: "452",
        chinese: "“在日常工作里有个常见的问题，",
        english: '"There is a common issue in daily work,',
      }),
    ];
    const loc = locateParagraphInManuscript(paragraphs, row452);
    expect(loc).not.toBeNull();
    expect(loc!.isPartial).toBe(true);
    expect(loc!.matchedText).not.toContain("важлива проблема.");
    expect(loc!.fullParagraphTarget).toContain("Ця спільна проблема");
  });

  it("batches multiple split tasks via token-index spans with 100% verbatim fidelity", async () => {
    const rule = resolvePunctuationRule("乌克兰语");
    const targetText =
      "У щоденній роботі є спільна проблема — проблема, з якою стикаються багато людей.";
    const { tokens, joinSep } = tokenizeForIndexing(targetText);
    const sliced = sliceTokensBySpans(
      tokens,
      joinSep,
      [{ start: 0, end: 5 }],
      [makeScriptRow({ rowIndex: 0, line: "452", chinese: "“在日常工作里有个常见的问题，" })],
      rule,
    );
    expect(sliced).toEqual(["У щоденній роботі є спільна проблема"]);

    let apiCalls = 0;
    const mockGemini = {
      hasKeys: true,
      async generateStructuredJson() {
        apiCalls += 1;
        return {
          results: [
            { id: "blk_1", spans: [{ start: 0, end: 5 }] },
            { id: "blk_2", spans: [{ start: 0, end: 2 }, { start: 3, end: 5, ellipsis: true }] },
          ],
        };
      },
    } as never;

    const batchRes = await batchSplitTargetsWithAi(
      [
        {
          id: "blk_1",
          fallbackText: targetText,
          aiSourceText: targetText,
          sourceRows: [makeScriptRow({ rowIndex: 0, line: "452", chinese: "“在日常工作里有个常见的问题，" })],
        },
        {
          id: "blk_2",
          fallbackText: targetText,
          aiSourceText: targetText,
          sourceRows: [
            makeScriptRow({ rowIndex: 1, line: "453", chinese: "前一半" }),
            makeScriptRow({ rowIndex: 2, line: "454", chinese: "后一半……", remark: "有省略" }),
          ],
        },
      ],
      rule,
      mockGemini,
    );

    expect(apiCalls).toBe(1);
    expect(batchRes.get("blk_1")?.usedAi).toBe(true);
    expect(batchRes.get("blk_1")?.lines).toEqual(["У щоденній роботі є спільна проблема"]);
    expect(batchRes.get("blk_2")?.lines[1]).toContain(rule.ellipsis);
  });

  it("compares semver versions accurately for auto-update checks", () => {
    expect(isNewerVersion("v0.2.6", "0.2.5")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.2.5")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.2.5", "0.2.5")).toBe(false);
    expect(isNewerVersion("0.2.4", "0.2.5")).toBe(false);
  });
});

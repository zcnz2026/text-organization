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
  locateParagraphInManuscript,
  normMatchKey,
  resolveCitationText,
} from "../src/engine/text-matcher";
import { parseDocxDocumentXml } from "../src/google/docx-drive-client";
import { parseGoogleResourceUrl } from "../src/google/url-parser";
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
    for (const lang of ["日语", "韩语"]) {
      expect(resolvePunctuationRule(lang).ellipsis).toBe("……");
    }

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
    expect(formatQuotedBlockLines(["“ईश्वर के वचन सत्य हैं।”"], hi)).toEqual(['"ईश्वर के वचन सत्य हैं।"']);

    const ne = resolvePunctuationRule("尼泊尔语");
    expect(ne.sentencePeriodChar).toBe("।");
    expect(formatStandaloneTitle("परमेश्वरका वचनहरू", '"Words."', "《神的话》。", ne)).toBe("“परमेश्वरका वचनहरू।”");

    const km = resolvePunctuationRule("高棉语");
    expect(km.sentencePeriodChar).toBe("។");
    expect(formatQuotedBlockLines(["«ព្រះបន្ទូលរបស់ព្រះជាម្ចាស់។»"], km)).toEqual(["«ព្រះបន្ទូលរបស់ព្រះជាម្ចាស់។»"]);

    const my = resolvePunctuationRule("缅甸语");
    expect(my.sentencePeriodChar).toBe("။");
    expect(formatQuotedBlockLines(["“ဘုရားသခင်၏ နှုတ်ကပတ်တော်။”"], my)).toEqual(["“ဘုရားသခင်၏ နှုတ်ကပတ်တော်။”"]);

    const ja = resolvePunctuationRule("日语");
    expect(ja.sentencePeriodChar).toBe("");
    expect(formatQuotedBlockLines(["「神の言葉はすべて真理である。」"], ja)).toEqual(["「神の言葉はすべて真理である」"]);

    // Nested quote transformation inside block
    const plOut = formatQuotedBlockLines(["\"To jest 'prawda' Boża.\""], pl);
    expect(plOut).toEqual(["„To jest »prawda« Boża”."]);
  });
});

describe("parseDocxDocumentXml 3-column table extraction & You(s) matching", () => {
  it("extracts 3-column paragraphs ignoring <w:del> track changes and matches You(s)/Your(s) in manuscript", () => {
    const sampleXml = `
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>你们应当真心顺服神，</w:t></w:r><w:del><w:r><w:delText>旧删除文字</w:delText></w:r></w:del><w:r><w:t>尽好本分。</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>You(s) should truly submit to God and fulfill your(s) duty well.</w:t></w:r><w:del><w:r><w:t>DELETED EN</w:t></w:r></w:del></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Ви повинні щиро коритися Богові</w:t></w:r><w:del><w:r><w:t>СТАРИЙ ТЕКСТ</w:t></w:r></w:del><w:r><w:t> і добре виконувати свій обов'язок.</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>
    `;

    const paragraphs = parseDocxDocumentXml(sampleXml, 1, 2, 3);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].chinese).toBe("你们应当真心顺服神，尽好本分。");
    expect(paragraphs[0].english).toBe(
      "You(s) should truly submit to God and fulfill your(s) duty well.",
    );
    expect(paragraphs[0].target).toBe(
      "Ви повинні щиро коритися Богові і добре виконувати свій обов'язок.",
    );

    // Verify normMatchKey strips (s) so script English without (s) matches .docx English with You(s)/your(s)
    expect(normMatchKey("You(s) should fulfill your(s) duty")).toBe(
      normMatchKey("You should fulfill your duty"),
    );

    const scriptRow = makeScriptRow({
      rowIndex: 0,
      chinese: "",
      english: "You should truly submit to God and fulfill your duty well.",
    });
    const located = locateParagraphInManuscript(paragraphs, [scriptRow]);
    expect(located).not.toBeNull();
    expect(located?.matchedText).toBe(
      "Ви повинні щиро коритися Богові і добре виконувати свій обов'язок.",
    );
  });
});

describe("parseLordsPrayerSheet row-per-language & 8-row pipeline splitting", () => {
  it("parses A=语种, B=整段主祷文 layout and splits cleanly across 8 script rows with final Amen aligned", async () => {
    const grid = toRichGrid([
      ["语种", "定稿主祷文全文"],
      [
        "西班牙语",
        "¡Oh, Dios Todopoderoso! Tú eres el Señor Jesús que ha regresado, Tú eres Aquel a quien hemos estado esperando. Deseamos seguirte, recibir Tus palabras, Tu provisión y Tu guía. No nos dejes caer en la tentación, y líbranos del maligno, porque Tuyo es el reino, el poder y la gloria, por los siglos de los siglos. ¡Amén!",
      ],
    ]);

    const parsed = parseLordsPrayerSheet(grid, "西语");
    expect(parsed.fullText).toContain("¡Oh, Dios Todopoderoso!");
    expect(parsed.fullText.endsWith("¡Amén!")).toBe(true);

    const blockRows: ScriptRow[] = [
      makeScriptRow({ rowIndex: 0, chinese: "全能神啊，", english: "Almighty God," }),
      makeScriptRow({ rowIndex: 1, chinese: "你是重归的主耶稣，", english: "You are the returned Lord Jesus," }),
      makeScriptRow({ rowIndex: 2, chinese: "你是我们巴望已久的那一位，", english: "You are the One we have been waiting for," }),
      makeScriptRow({ rowIndex: 3, chinese: "我们愿跟随你，", english: "We wish to follow You," }),
      makeScriptRow({ rowIndex: 4, chinese: "接受你的话语、你的供应与你的带领。", english: "to receive Your words, Your provision, and Your leadership." }),
      makeScriptRow({ rowIndex: 5, chinese: "不叫我们遇见试探，救我们脱离凶恶，", english: "Lead us not into temptation, but deliver us from evil," }),
      makeScriptRow({ rowIndex: 6, chinese: "因为国度、权柄、荣耀，全是你的，直到永远！", english: "for Yours is the kingdom, and the power, and the glory, forever!" }),
      makeScriptRow({ rowIndex: 7, chinese: "阿们！", english: "Amen!" }),
    ];

    const esRule = resolvePunctuationRule("西语");
    const split8 = await splitLordsPrayerFullText(parsed.fullText, blockRows, esRule);
    expect(split8).toHaveLength(8);
    expect(split8[0]).toBe("¡Oh, Dios Todopoderoso!");
    expect(split8[7]).toBe("¡Amén!");
    expect(split8.every((line) => line.length > 0)).toBe(true);
  });
});

describe("parseWordCitationsSheet dual-column & 六本书新摘自 H/I citation columns", () => {
  it("parses dual-column per language in 话在肉身显现摘自202210 and resolves H/I columns from 六本书新摘自", () => {
    const wordCiteGrid = toRichGrid([
      ["《话在肉身显现》单篇摘自总表", "", "", "", "乌克兰语", "", "西班牙语", ""],
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
        "——《话・卷一　神的显现与作工・基督的实质是顺服天父的旨意》",
        "《话・卷一　神的显现与作工・基督的实质是顺服天父的旨意》",
        "(The Word, Vol. 1. The Appearance and Work of God. The Substance of Christ Is Obedience to the Will of the Heavenly Father).",
        "from The Word, Vol. 1. The Appearance and Work of God. The Substance of Christ Is Obedience to the Will of the Heavenly Father",
        "(Слово, т. 1. Явлення й робота Бога. Сутність Христа — це покора волі Небесного Отця).",
        "зі «Слово, т. 1. Явлення й робота Бога. Сутність Христа — це покора волі Небесного Отця»",
        "(La Palabra, Vol. 1. La aparición y obra de Dios. La sustancia de Cristo es la obediencia a la voluntad del Padre celestial).",
        "de «La Palabra, Vol. 1. La aparición y obra de Dios. La sustancia de Cristo es la obediencia a la voluntad del Padre celestial»",
      ],
    ]);

    const ukPairs = parseWordCitationsSheet(wordCiteGrid, "乌克兰语");
    expect(ukPairs.length).toBeGreaterThanOrEqual(1);
    expect(ukPairs[0].videoEffect).toBe(
      "(Слово, т. 1. Явлення й робота Бога. Сутність Христа — це покора волі Небесного Отця).",
    );
    expect(ukPairs[0].subtitleBand).toBe(
      "зі «Слово, т. 1. Явлення й робота Бога. Сутність Христа — це покора волі Небесного Отця»",
    );

    const hymnCiteGrid = toRichGrid([
      ["中文", "英文", "乌克兰语的摘自"],
      [
        "《跟随羔羊唱新歌・神的话语都是真理》",
        "from Follow the Lamb and Sing New Songs, All God's Words Are the Truth",
        "з «Ідіть за Агнцем і співайте нових пісень. Усі Божі слова — це істина»",
      ],
    ]);
    const hymnPairs = parseHymnCitationsSheet(hymnCiteGrid, "乌语");
    expect(hymnPairs).toHaveLength(1);
    expect(hymnPairs[0].subtitleBand).toContain("Усі Божі слова — це істина");

    // 六本书新摘自 B~I columns (H = targetCite subtitle_band, I = targetBracketCite video_effect)
    const catalogGrid = toRichGrid([
      ["序号", "中文括号摘自", "中文字幕带摘自", "中文篇目", "英文篇目", "乌语篇目", "单篇链接", "乌语字幕带摘自(H)", "乌语括号特效摘自(I)"],
      [
        "1",
        "（《话・卷二　关于认识神・独一无二的神自己　三》）",
        "——《话・卷二　关于认识神・独一无二的神自己　三》",
        "独一无二的神自己　三",
        "God Himself, the Unique III",
        "Сам Бог, Унікальний III",
        { text: "查看单篇", url: "https://docs.google.com/document/d/doc_unique_3" },
        "зі «Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III»",
        "(Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III).",
      ],
    ]);

    const articles = parseArticleCatalogSheet(catalogGrid, DEFAULT_LANG_SHEET_COLS);
    expect(articles).toHaveLength(1);
    expect(articles[0].targetCite).toBe(
      "зі «Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III»",
    );
    expect(articles[0].targetBracketCite).toBe(
      "(Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III).",
    );

    const mockCatalog = {
      langName: "乌克兰语",
      rule: resolvePunctuationRule("乌克兰语"),
      godSaysText: "Всемогутній Бог каже",
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
      chinese: "（《话・卷二　关于认识神・独一无二的神自己　三》）",
      english: "(The Word, Vol. 2. On Knowing God. God Himself, the Unique III).",
      filterCategory: "卷二　关于认识神・独一无二的神自己　三",
    });

    expect(resolveCitationText(mockCatalog, citeRow, "video_effect")).toBe(
      "(Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III).",
    );
    expect(resolveCitationText(mockCatalog, citeRow, "subtitle_band")).toBe(
      "зі «Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III»",
    );
  });
});

describe("parseHymnSheet (神话诗歌标题 vs 教会诗歌 LRC sub-lines) & 39期 Line 57/58 aggregation", () => {
  it("keeps 神话诗歌标题 title-only, parses 教会诗歌 LRC sub-lines ignoring stanza markers, and aggregates multi-sublines for 39期 Line 57/58", async () => {
    const hymnGrid = toRichGrid([
      ["39期.葡萄牙", "", ""],
      ["中文", "英文", "乌克兰语"],
      [
        "神话诗歌标题：《神主宰着全人类的命运》",
        "Hymn of God's Words: God Holds Sovereignty Over the Destiny of All Mankind",
        "Бог володарює над долею всього людства",
      ],
      [
        "作为人类中的一员，",
        "As members of mankind,",
        "Як представники людства (不应作为诗歌行收录，应走单篇提取)",
      ],
      [
        "教会诗歌：《神的话语都是真理》",
        "Church Hymn: All God's Words Are the Truth",
        "Усі Божі слова — це істина",
      ],
      ["I", "I", "I"],
      [
        "神来在人间与人同生活，发表了许多真理，",
        "God has come to earth to live with man, expressing many truths.",
        "Бог прийшов на землю жити з людиною, висловлюючи багато істин.",
      ],
      [
        "从此我不再渺茫中寻觅，",
        "No longer do I search in uncertainty,",
        "Відтепер я більше не шукаю в непевності,",
      ],
      [
        "因有神话带领我，",
        "for I have God's words to guide me.",
        "бо маю Божі слова, що ведуть мене.",
      ],
      [
        "每天吃喝神话活在神前，",
        "Each day, I eat and drink God's words and live before God;",
        "Щодня я їм і п'ю Божі слова та живу перед Богом;",
      ],
      [
        "有圣灵开启光照，",
        "the Holy Spirit enlightens and illuminates me.",
        "Святий Дух просвітлює і осяює мене.",
      ],
      [
        "《跟随羔羊唱新歌・神的话语都是真理》",
        "from Follow the Lamb and Sing New Songs, All God's Words Are the Truth",
        "з «Ідіть за Агнцем і співайте нових пісень. Усі Божі слова — це істина»",
      ],
    ]);

    const hymns = parseHymnSheet(hymnGrid);
    expect(hymns).toHaveLength(2);
    expect(hymns[0].zhTitle).toBe("神主宰着全人类的命运");
    expect(hymns[0].lines).toHaveLength(0);

    expect(hymns[1].zhTitle).toBe("神的话语都是真理");
    expect(hymns[1].lines).toHaveLength(5);
    expect(hymns[1].targetCitation).toBe(
      "з «Ідіть за Агнцем і співайте нових пісень. Усі Божі слова — це істина»",
    );

    // 39期 Line 56, 57, 58: Line 57 combines sub-lines 2+3, Line 58 combines sub-lines 4+5
    const blockRows: ScriptRow[] = [
      makeScriptRow({
        rowIndex: 0,
        line: "56",
        character: "Hymn",
        chinese: "“神来在人间与人同生活，发表了许多真理，",
        english: '"God has come to earth to live with man, expressing many truths.',
        filterCategory: "教会诗歌《神的话语都是真理》",
        needExtract: "需要摘",
      }),
      makeScriptRow({
        rowIndex: 1,
        line: "57",
        character: "Hymn",
        chinese: "从此我不再渺茫中寻觅，因有神话带领我，",
        english: "No longer do I search in uncertainty, for I have God's words to guide me.",
        filterCategory: "教会诗歌《神的话语都是真理》",
        needExtract: "需要摘",
      }),
      makeScriptRow({
        rowIndex: 2,
        line: "58",
        character: "Hymn",
        chinese: "每天吃喝神话活在神前，有圣灵开启光照，”",
        english:
          'Each day, I eat and drink God\'s words and live before God; the Holy Spirit enlightens and illuminates me."',
        filterCategory: "教会诗歌《神的话语都是真理》",
        needExtract: "需要摘",
      }),
    ];

    const aggregated = aggregateHymnSublinesForBlock(hymns[1].lines, blockRows);
    expect(aggregated).toEqual([
      "Бог прийшов на землю жити з людиною, висловлюючи багато істин.",
      "Відтепер я більше не шукаю в непевності, бо маю Божі слова, що ведуть мене.",
      "Щодня я їм і п'ю Божі слова та живу перед Богом; Святий Дух просвітлює і осяює мене.",
    ]);
  });
});

describe("Custom SourceScriptColumnConfig remapped columns", () => {
  it("parses script document with swapped column letters when autoDetectByHeader is false", async () => {
    // Swapped layout: Row 1 is metadata, Row 2 is custom header, Chinese is in Col B, English in Col A, Line in Col C, Filter in Col D, NeedExtract in Col E, Target in Col F
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
        godSaysText: "Всемогутній Бог каже",
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

    expect(out.rows[0].targetLanguage).toBe("Всемогутній Бог каже:");
    expect(out.rows[0].status).toBe("matched");
  });

  it("disambiguates same-title articles across Vol.6 vs Vol.7 and parses drive.google.com/open?id= URLs", () => {
    const parsedUrl = parseGoogleResourceUrl(
      "https://drive.google.com/open?id=1tJc8nsQfpCTDpAQfjnM6V8WblmvYrNQ5&usp=drive_fs",
      "doc",
    );
    expect(parsedUrl).toEqual({ kind: "doc", id: "1tJc8nsQfpCTDpAQfjnM6V8WblmvYrNQ5", gid: null });

    const matched = findArticleInCatalog(
      [
        {
          zhBracketCite: "《话・卷六　关于追求真理・怎样追求真理（三）》",
          zhSubtitleCite: "——《话・卷六　关于追求真理・怎样追求真理（三）》",
          zhTitle: "怎样追求真理（三）",
          enTitle: "How to Pursue the Truth (3)",
          targetTitle: "Як прагнути до істини (3)",
          docUrl: "https://docs.google.com/document/d/vol6_doc_id",
          targetCite: "«Слово, т. 6. ...»",
        },
        {
          zhBracketCite: "《话・卷七　关于追求真理・怎样追求真理（三）》",
          zhSubtitleCite: "——《话・卷七　关于追求真理・怎样追求真理（三）》",
          zhTitle: "怎样追求真理（三）",
          enTitle: "How to Pursue the Truth (3)",
          targetTitle: "Як прагнути до істини (3)",
          docUrl: "https://drive.google.com/open?id=1tJc8nsQfpCTDpAQfjnM6V8WblmvYrNQ5&usp=drive_fs",
          targetCite: "«Слово, т. 7. ...»",
        },
      ],
      "卷七　关于追求真理・怎样追求真理（三）",
    );
    expect(matched?.docUrl).toContain("1tJc8nsQfpCTDpAQfjnM6V8WblmvYrNQ5");
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
      ["", "20261103通知外文排查", "", ""],
      ["", "中文", "英文", "印尼语"],
      ["", "神话诗歌标题：", "", ""],
      ["", "《神希望能追求真理剩存下来》", "God Wishes Man Will Pursue the Truth and Survive", "Tuhan Berharap Manusia Akan Mengejar Kebenaran dan Bertahan Hidup"],
      ["", "教会诗歌：", "", ""],
      ["", "《神的话语都是真理》", "All God's Words Are the Truth", "Semua Firman Tuhan Adalah Kebenaran"],
      ["", "I", "1", ""],
      ["", "神来在人间与人同生活，发表了许多真理，", "God has come to earth to live with man, expressing many truths.", "Tuhan telah datang ke bumi untuk hidup bersama manusia, mengungkapkan banyak kebenaran."],
    ]);
    // Works even with default A/B/C config thanks to auto-header shift detection
    const hymns = parseHymnSheet(idHymnGrid);
    expect(hymns).toHaveLength(2);
    expect(hymns[1].zhTitle).toBe("神的话语都是真理");
    expect(hymns[1].targetTitle).toBe("Semua Firman Tuhan Adalah Kebenaran");
    expect(hymns[1].lines).toHaveLength(1);
  });

  it("allows blank/missing columns in 六本书新摘自 and derives zhTitle from citation columns (Indonesian layout)", () => {
    const cfg = parseCloudConfigSheets(
      new Map<string, RichSheetGrid>([
        [
          CONFIG_TEMPLATE_SHEET_NAMES.cols,
          toRichGrid([
            ["语系", "表格名称", "表头行", "列1", "列2", "列3", "列4", "列5", "列6", "列7", "列8", "列9"],
            ["印尼语(说明)", "六本书新摘自", "表头行", "中文括号摘自", "中文字幕带摘自", "中文篇目", "英文篇目", "外文篇目", "神话单篇链接", "外文单行摘自", "外文括号摘自", "外文字幕带摘自"],
            ["印尼语", "六本书新摘自", "1", "B", "C", "", "D", "E", "F", "G", "H", "I"],
          ]),
        ],
      ]),
    );
    expect(cfg.colsByLang["印尼语"].catalogZhTitleCol).toBe("");
    expect(cfg.colsByLang["印尼语"].catalogDocLinkCol).toBe("F");
    expect(cfg.colsByLang["印尼语"].catalogTargetSubtitleBandCiteCol).toBe("I");

    const idCatalogGrid = toRichGrid([
      ["", "中文括号版摘自", "中文单独一行的摘自", "英语新标题", "印尼标题", "神话单篇稿链接", "单独一行+书名的摘自", "括号版+书名的摘自", "字幕带用的摘自"],
      [
        "",
        "《话・卷一　神的显现与作工・道成肉身的神的职分与人的本分的区别》",
        "——《话・卷一　神的显现与作工・道成肉身的神的职分与人的本分的区别》",
        "The Difference Between the Ministry of God Incarnate and the Duty of Man",
        "Perbedaan antara Pelayanan Tuhan yang Berinkarnasi dan Tugas Manusia",
        { text: "https://docs.google.com/document/d/id_doc_362", url: "https://docs.google.com/document/d/id_doc_362" },
        "—Firman, Jilid 1. Penampakan dan Pekerjaan Tuhan",
        "(Firman, Jilid 1. Penampakan dan Pekerjaan Tuhan)",
        "Dikutip dari Firman, Jilid 1. Penampakan dan Pekerjaan Tuhan",
      ],
    ]);
    const entries = parseArticleCatalogSheet(idCatalogGrid, cfg.colsByLang["印尼语"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].zhTitle).toBe("道成肉身的神的职分与人的本分的区别");
    expect(entries[0].docUrl).toBe("https://docs.google.com/document/d/id_doc_362");
    expect(entries[0].targetCite).toContain("—Firman");
    expect(entries[0].targetBracketCite).toContain("(Firman");
    expect(entries[0].targetSubtitleBandCite).toContain("Dikutip dari Firman");
  });
});

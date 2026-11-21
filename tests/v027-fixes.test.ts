import { describe, expect, it } from "vitest";
import { BUILTIN_PUNCTUATION_RULES, resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseBibleLibrarySheet } from "../src/catalog/sheet-parsers";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import {
  auditAndRepairBilingualAlignment,
  projectLinesOntoVerbatimSource,
  sliceTokensBySpans,
  tokenizeForIndexing,
} from "../src/engine/line-splitter";
import { runLanguageExtractionPipeline } from "../src/engine/pipeline";
import {
  formatBibleBlockAndCitation,
  formatQuotedBlockLines,
  formatStandaloneTitle,
} from "../src/engine/punctuation";
import {
  dedupeRepeatedLyricClause,
  extractTruncatedSentencePair,
  findBibleVerse,
  locateParagraphInManuscript,
  parseTruncationSpec,
} from "../src/engine/text-matcher";
import { buildMultiSheetXlsx } from "../src/engine/xlsx-export";
import type { ScriptRow } from "../src/types/domain";

function makeRow(rowIndex: number, chinese: string, english: string, remark = ""): ScriptRow {
  return {
    rowIndex,
    rawCells: [],
    line: String(rowIndex),
    inTime: "",
    outTime: "",
    character: "",
    chinese,
    english,
    targetLanguage: "",
    note: "",
    remark,
    sendRemark: "",
    filterCategory: "",
    needExtract: "需要摘",
  };
}

describe("quote nesting, disambiguation, span boundary repair & source column", () => {
  it("downgrades nested inner double quotes across multiple lines for Indonesian and Ukrainian", () => {
    const idRule = resolvePunctuationRule("印尼语");
    const idOut = formatQuotedBlockLines(
      [
        "“Menunggu” berarti menunggu waktu yang tepat,",
        "“Apa yang akan terjadi dengan rencanaku?",
        "Apakah langkah ini akan membawa hasil?”",
      ],
      idRule,
      true,
    );
    expect(idOut[0]).toBe('"\'Menunggu\' berarti menunggu waktu yang tepat,');
    expect(idOut[1]).toBe("'Apa yang akan terjadi dengan rencanaku?");
    expect(idOut[2]).toBe("Apakah langkah ini akan membawa hasil?'\"");

    const ukRule = resolvePunctuationRule("乌克兰语");
    const ukOut = formatQuotedBlockLines(
      [
        "Щоб виконати роботу, він запитує:",
        "«Що буде з моїм планом?",
        "Чи принесе це результат?».",
      ],
      ukRule,
      true,
    );
    expect(ukOut[0]).toBe("«Щоб виконати роботу, він запитує:");
    expect(ukOut[1]).toBe('"Що буде з моїм планом?');
    expect(ukOut[2]).toBe('Чи принесе це результат?"».');
  });

  it("applies Korean citation-dependent outer quotes and preserves inner quotes", () => {
    const koRule = resolvePunctuationRule("韩语");
    const withCite = formatQuotedBlockLines(["그는 “성실하게 일하라”고 말했습니다."], koRule, true, true);
    expect(withCite[0]).toBe("『그는 “성실하게 일하라”고 말했습니다.』");
    const withoutCite = formatQuotedBlockLines(["그는 “성실하게 일하라”고 말했습니다."], koRule, true, false);
    expect(withoutCite[0]).toBe("“그는 “성실하게 일하라”고 말했습니다.”");
  });

  it("formats French and Burmese citations with period inside quotes", () => {
    const frRule = resolvePunctuationRule("法语");
    const frRes = formatBibleBlockAndCitation(
      ["Au commencement, la lumière brilla sur la terre."],
      "(Livre 1:1)",
      frRule,
    );
    expect(frRes.verseLines[0]).toBe("« Au commencement, la lumière brilla sur la terre. »");
    expect(frRes.citationText).toBe("(Livre 1:1)");
  });

  it("includes all 7 additional languages from 3_标点规则", () => {
    expect(BUILTIN_PUNCTUATION_RULES.length).toBeGreaterThanOrEqual(35);
    for (const lang of ["意大利语", "马扎尔语", "塞尔维亚语", "保加利亚语", "斯洛伐克语", "格鲁吉亚", "亚美尼亚"]) {
      const rule = resolvePunctuationRule(lang);
      expect(rule.langName).toBe(lang);
    }
    expect(resolvePunctuationRule("格鲁吉亚").periodQuotePattern).toBe(".“");
    expect(resolvePunctuationRule("亚美尼亚").periodQuotePattern).toBe("»։");
    expect(resolvePunctuationRule("老挝语").periodQuotePattern).toBe("”.");
  });

  it("disambiguates duplicate opening sentence in manuscript using second-row probe", () => {
    const paragraphs = [
      {
        chinese: "今天我们讨论这样一个问题：“为什么需要坚持学习？”这是之前提过的话题。",
        english: 'Today we will discuss this question: "Why must people keep learning?" This was mentioned before.',
        target: 'Hari ini kita membahas: "Mengapa orang harus terus belajar?" Ini sudah dibahas sebelumnya.',
      },
      {
        chinese: "为什么需要坚持学习？最主要的原因，从长远来看，持续学习关系到稳步成长。",
        english: "Why must people keep learning? The most important reason, seen from the long run, is that learning relates to steady growth.",
        target: "Mengapa orang harus terus belajar? Alasan terpenting adalah, dilihat dari jangka panjang, belajar berkaitan dengan pertumbuhan yang stabil.",
      },
    ];
    const rows = [
      makeRow(1, "“为什么需要坚持学习？", '"Why must people keep learning?'),
      makeRow(2, "最主要的原因，从长远来看，", "The most important reason, seen from the long run,"),
      makeRow(3, "持续学习关系到稳步成长。”", 'is that learning relates to steady growth."'),
    ];
    const located = locateParagraphInManuscript(paragraphs, rows);
    expect(located).not.toBeNull();
    expect(located?.matchedText).toContain("Alasan terpenting adalah");
    expect(located?.matchedText).not.toContain("Hari ini kita membahas");
  });

  it("repairs dangling sentence-starter words and leaked trailing words after AI span slicing", () => {
    const idRule = resolvePunctuationRule("印尼语");
    const srcText = "Guru memberimu nilai sempurna. Jika engkau tidak menyelesaikan tugas ini, hasilnya tidak akan memuaskan. Oleh sebab itu";
    const tk = tokenizeForIndexing(srcText);
    const rows = [
      makeRow(1, "老师给你满分。", "The teacher will give you a full score."),
      makeRow(2, "如果你不完成这项任务，结果不会理想。", "If you don't finish this task, the result won't be ideal."),
    ];
    const olehIdx = tk.tokens.indexOf("Oleh");
    const spans = [
      { start: 0, end: 4 },
      { start: 5, end: olehIdx },
    ];
    const sliced = sliceTokensBySpans(tk.tokens, tk.joinSep, spans, rows, idRule);
    expect(sliced).toEqual([
      "Guru memberimu nilai sempurna.",
      "Jika engkau tidak menyelesaikan tugas ini, hasilnya tidak akan memuaskan.",
    ]);
  });

  it("extracts per-language Bible source/version column and auto-detects source header", () => {
    const mk = (t: string) => ({ text: t });
    const grid = [
      [mk("目录"), mk("英文章节"), mk("Chinese"), mk("English"), mk("Ukrainian"), mk("备注"), mk(""), mk(""), mk("版本备注")],
      [mk("卷一"), mk("Gen 1:1"), mk("太初有光。"), mk("In the beginning there was light."), mk("«На початку було світло» (Кн 1:1)."), mk(""), mk(""), mk(""), mk("标准版")],
    ];
    const entries = parseBibleLibrarySheet(grid, {
      bibleHeaderRow: 1,
      bibleChapterCol: "B",
      bibleZhCol: "C",
      bibleEnCol: "D",
      bibleTargetCol: "E",
      bibleSourceCol: "I",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("标准版");

    const hit = findBibleVerse(entries, "Gen 1:1", [makeRow(1, "太初有光。", "In the beginning...")]);
    expect(hit?.source).toBe("标准版");

    const autoEntries = parseBibleLibrarySheet(grid, {
      bibleHeaderRow: 1,
      bibleChapterCol: "B",
      bibleZhCol: "C",
      bibleEnCol: "D",
      bibleTargetCol: "E",
      bibleSourceCol: "",
    });
    expect(autoEntries[0].source).toBe("标准版");
  });

  it("extracts inline single-row verses without dropping trailing citation and exports xlsx headers", async () => {
    const inlineGrid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ["1", "", "", "Reader", "“春天的阳光洒满山岗，", '"Spring sunlight fills the hills,', "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["2", "", "", "Reader", "万物都在悄然生长。”", 'and all things quietly grow."', "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["10", "", "", "Host", "“太初有光，照亮大地。”（创1:1）", '"In the beginning light shone on the earth." (Genesis 1:1).', "No need to translate!", "", "", "", "创世记 1:1", "需要摘"],
    ];
    const inlineDoc = parseGridToScriptDocument(inlineGrid, "inline-test");
    const inlineOut = await runLanguageExtractionPipeline(
      inlineDoc,
      {
        langName: "乌克兰语",
        rule: resolvePunctuationRule("乌克兰语"),
        godSaysText: "",
        commonFixedTerms: new Map(),
        citations: [],
        articles: [
          {
            zhTitle: "第一篇",
            enTitle: "Essay 1",
            targetTitle: "Нарис 1",
            docUrl: "mock://essay1",
            zhSubtitleCite: "",
            zhBracketCite: "",
            targetCite: "",
          },
        ],
        articleDocsCache: new Map([
          [
            "mock://essay1",
            [
              {
                chinese: "春天的阳光洒满山岗，万物都在悄然生长。",
                english: "Spring sunlight fills the hills, and all things quietly grow.",
                target: "Весняне сонце заливає пагорби, і все тихо росте.",
              },
            ],
          ],
        ]),
        bibleEntries: [
          {
            chapterRef: "Genesis 1:1",
            chinese: "“太初有光，照亮大地。”（创1:1）",
            english: '"In the beginning light shone on the earth" (Genesis 1:1).',
            targetText: "«На початку світло осяяло землю» (Буття 1:1).",
            source: "标准译本",
          },
        ],
        idioms: [],
        hymns: [],
        lordsPrayer: [],
        rosterEntries: [],
      },
      {
        enableRosterPreFill: false,
        gemini: {
          hasKeys: true,
          async generateStructuredJson(input: { userPrompt: string }) {
            const idMatch = /任务ID:\s*(\S+)/.exec(input.userPrompt);
            return {
              results: [
                {
                  id: idMatch?.[1] ?? "task_0",
                  lines: [
                    "Весняне сонце заливає пагорби,",
                    "і все тихо росте.",
                  ],
                },
              ],
            };
          },
        } as never,
      },
    );

    // Non-truncated multi-row split blocks keep hint clean (no full-paragraph dump)
    expect(inlineOut.rows[0].hint).toBe("");
    expect(inlineOut.rows[1].hint).toBe("");
    expect(inlineOut.rows[2].targetLanguage).toBe("«На початку світло осяяло землю» (Буття 1:1).");
    expect(inlineOut.rows[2].bibleSource).toBe("标准译本");

    const xlsxBytes = buildMultiSheetXlsx(inlineDoc, [inlineOut]);
    const xlsxStr = new TextDecoder().decode(xlsxBytes);
    expect(xlsxStr).toContain("【工具提示】");
    expect(xlsxStr).toContain("【圣经来源】");
    expect(xlsxStr).toContain("标准译本");
  });

  it("extracts only truncated sentence + following sentence for 截取 hints and capitalizes Cyrillic start", () => {
    const fullEn =
      "Introductory background sentence one. On a large-scale, the foremost reason is that, looking at it from this perspective, it relates to planning. Furthermore, this is part of the overall blueprint. Trailing unrelated sentence four. Trailing sentence five.";
    const fullUk =
      "Вступне речення один. Говорячи загалом, найголовніша причина полягає в тому, що це стосується планування. Крім того, це частина загального задуму. Четверте речення. П'яте речення.";
    const row = makeRow(
      5,
      "最主要的一条就是从这方面来看，",
      "The foremost reason is that, looking at it from this perspective,",
      "涉及截取：On a large-scale, the foremost reason is that, looking at it from this perspective,",
    );

    const spec = parseTruncationSpec(row);
    expect(spec.hasTruncation).toBe(true);
    expect(spec.deletedEnPrefix).toBe("On a large-scale,");

    const pair = extractTruncatedSentencePair(fullUk, fullEn, row);
    expect(pair).toBe(
      "Говорячи загалом, найголовніша причина полягає в тому, що це стосується планування. Крім того, це частина загального задуму.",
    );
    expect(pair).not.toContain("Вступне речення");
    expect(pair).not.toContain("П'яте речення");

    const ukRule = resolvePunctuationRule("乌克兰语");
    const repaired = auditAndRepairBilingualAlignment(
      ["найголовніша причина полягає в тому, що це стосується планування та", "частини задуму."],
      [
        row,
        makeRow(6, "与整体规划息息相关。", "and relates to part of the blueprint."),
      ],
      ukRule,
    );
    expect(repaired[0]).toBe("Найголовніша причина полягає в тому, що це стосується планування");
    expect(repaired[1]).toBe("та частини задуму.");
  });

  it("projects AI text slices verbatim onto source and disambiguates multi-verse ranges & punctuation", () => {
    const src = "Коли ти стикаєшся з труднощами, й не знаєш, як діяти далі, яке рішення прийняти?";
    const projected = projectLinesOntoVerbatimSource(src, [
      "Коли ти стикаєшся з труднощами",
      "й не знаєш, як діяти далі,",
      "яке рішення прийняти?",
    ]);
    expect(projected).toEqual([
      "Коли ти стикаєшся з труднощами,",
      "й не знаєш, як діяти далі,",
      "яке рішення прийняти?",
    ]);

    // Multi-verse range lookup with localized book name + empty first ref -> preserves 15–17
    const entries = [
      {
        chapterRef: "Mat 24:27",
        chinese: "闪电从东边发出，直照到西边。",
        english: "For as the lightning comes out of the east and shines to the west.",
        targetText: '"Sama seperti kilat memancar dari timur" (Matius 24:27).',
      },
      {
        chapterRef: "Luk 17:24",
        chinese: "因为人子在他日子，好像闪电从天这边一闪直照到天那边。",
        english: "For as the lightning that lightens out of one part under heaven shines to the other part.",
        targetText: '"Sebab sama seperti kilat memancar dari ujung langit"',
      },
      {
        chapterRef: "Luk 17:25",
        chinese: "只是他必须先受许多苦，又被这世代弃绝。",
        english: "But first must He suffer many things, and be rejected of this generation.",
        targetText: '"Tetapi Ia harus menanggung banyak penderitaan dahulu" (Lukas 17:25).',
      },
    ];
    const hit = findBibleVerse(entries, "(Luke 17:24–25).", [
      makeRow(1, "“因为人子在他日子，", '"For as the lightning,'),
      makeRow(2, "只是他必须先受许多苦”", 'But first must He suffer many things"'),
    ]);
    expect(hit?.targetCitationRef).toBe("(Lukas 17:24–25)");
    expect(hit?.text).toContain("menanggung banyak penderitaan");

    // Ukrainian ?». / !». and standalone title English-first punctuation and lyric dedupe
    const ukRule = resolvePunctuationRule("乌克兰语");
    expect(formatQuotedBlockLines(["Це дуже важливе питання!"], ukRule, true)[0]).toBe(
      "«Це дуже важливе питання!».",
    );
    expect(
      formatStandaloneTitle("Назва твору", '"Title of the Work."', "《作品标题》，", ukRule),
    ).toBe("«Назва твору».");
    expect(
      dedupeRepeatedLyricClause(
        "Світло осяює шлях. Світло осяює шлях.",
        "Light illuminates the path.",
      ),
    ).toBe("Світло осяює шлях.");
  });
});

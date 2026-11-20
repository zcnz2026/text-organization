import { describe, expect, it } from "vitest";
import { BUILTIN_PUNCTUATION_RULES, resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseBibleLibrarySheet } from "../src/catalog/sheet-parsers";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import { sliceTokensBySpans, tokenizeForIndexing } from "../src/engine/line-splitter";
import { runLanguageExtractionPipeline } from "../src/engine/pipeline";
import { formatBibleBlockAndCitation, formatQuotedBlockLines } from "../src/engine/punctuation";
import { findBibleVerse, locateParagraphInManuscript } from "../src/engine/text-matcher";
import { buildMultiSheetXlsx } from "../src/engine/xlsx-export";
import type { ScriptRow } from "../src/types/domain";
import { createSyntheticDemoState } from "../src/ui/demo-fixture";

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

describe("v0.2.7 feedback fixes", () => {
  it("downgrades nested inner double quotes across multiple lines for Indonesian and Ukrainian", () => {
    const idRule = resolvePunctuationRule("印尼语");
    const idOut = formatQuotedBlockLines(
      [
        '“Menunggu” berarti menunggu waktu Tuhan,',
        '“Apa yang akan terjadi dengan statusku?',
        'Apakah melakukan hal ini akan meningkatkan statusku?”',
      ],
      idRule,
      true,
    );
    expect(idOut[0]).toBe('"\'Menunggu\' berarti menunggu waktu Tuhan,');
    expect(idOut[1]).toBe("'Apa yang akan terjadi dengan statusku?");
    expect(idOut[2]).toBe("Apakah melakukan hal ini akan meningkatkan statusku?'\"");

    const ukRule = resolvePunctuationRule("乌克兰语");
    const ukOut = formatQuotedBlockLines(
      [
        "Щоб виконати обов'язок, він думає:",
        "«Що буде з моїм статусом?",
        "Чи підвищить це мій статус?».",
      ],
      ukRule,
      true,
    );
    expect(ukOut[0]).toBe("«Щоб виконати обов'язок, він думає:");
    expect(ukOut[1]).toBe('"Що буде з моїм статусом?');
    expect(ukOut[2]).toBe('Чи підвищить це мій статус?"».');
  });

  it("applies Korean citation-dependent outer quotes and preserves inner quotes", () => {
    const koRule = resolvePunctuationRule("韩语");
    const withCite = formatQuotedBlockLines(["하나님께서 “진리를 추구하라”고 말씀하셨다."], koRule, true, true);
    expect(withCite[0]).toBe("『하나님께서 “진리를 추구하라”고 말씀하셨다.』");
    const withoutCite = formatQuotedBlockLines(["하나님께서 “진리를 추구하라”고 말씀하셨다."], koRule, true, false);
    expect(withoutCite[0]).toBe("“하나님께서 “진리를 추구하라”고 말씀하셨다.”");
  });

  it("formats French and Burmese Bible citations with period inside quotes", () => {
    const frRule = resolvePunctuationRule("法语");
    const frRes = formatBibleBlockAndCitation(
      ["Au commencement, Dieu créa les cieux et la terre."],
      "(Genèse 1:1)",
      frRule,
    );
    expect(frRes.verseLines[0]).toBe("« Au commencement, Dieu créa les cieux et la terre. »");
    expect(frRes.citationText).toBe("(Genèse 1:1)");
  });

  it("includes all 7 new languages from updated 3_标点规则 CSV", () => {
    expect(BUILTIN_PUNCTUATION_RULES.length).toBeGreaterThanOrEqual(35);
    for (const lang of ["意大利语", "马扎尔语", "塞尔维亚语", "保加利亚语", "斯洛伐克语", "格鲁吉亚", "亚美尼亚"]) {
      const rule = resolvePunctuationRule(lang);
      expect(rule.langName).toBe(lang);
    }
    expect(resolvePunctuationRule("格鲁吉亚").periodQuotePattern).toBe(".“");
    expect(resolvePunctuationRule("亚美尼亚").periodQuotePattern).toBe("»։");
    expect(resolvePunctuationRule("老挝语").periodQuotePattern).toBe("”.");
  });

  it("disambiguates duplicate opening sentence in manuscript (e.g. 为什么人必须追求真理？)", () => {
    const paragraphs = [
      {
        chinese: "今天我们交通这样一个问题：“为什么人必须追求真理？”这是以前说过的话题。",
        english: 'Today we will fellowship on this question: "Why must people pursue the truth?" This was mentioned before.',
        target: 'Hari ini kita membahas: "Mengapa manusia harus mengejar kebenaran?" Ini sudah dibahas sebelumnya.',
      },
      {
        chinese: "为什么人必须追求真理？最主要的原因，从神那儿来看，追求真理关乎到神的经营。",
        english: "Why must people pursue the truth? The most important reason, seen from God's perspective, is that pursuing the truth relates to His management.",
        target: "Mengapa manusia harus mengejar kebenaran? Alasan terpenting adalah, dilihat dari perspektif Tuhan, mengejar kebenaran berkaitan dengan pengelolaan-Nya.",
      },
    ];
    const rows = [
      makeRow(1, "“为什么人必须追求真理？", '"Why must people pursue the truth?'),
      makeRow(2, "最主要的原因，从神那儿来看，", "The most important reason, seen from God's perspective,"),
      makeRow(3, "追求真理关乎到神的经营。”", 'is that pursuing the truth relates to His management."'),
    ];
    const located = locateParagraphInManuscript(paragraphs, rows);
    expect(located).not.toBeNull();
    expect(located?.matchedText).toContain("Alasan terpenting adalah");
    expect(located?.matchedText).not.toContain("Hari ini kita membahas");
  });

  it("repairs dangling sentence-starter words and leaked trailing words after AI span slicing", () => {
    const idRule = resolvePunctuationRule("印尼语");
    const srcText = "Tuhan memberimu nilai sempurna. Jika engkau tidak melakukan hal-hal ini, Tuhan tidak menyukai orang-orang semacam ini. Oleh sebab itu";
    const tk = tokenizeForIndexing(srcText);
    const rows = [
      makeRow(1, "神给你满分。", "God will give you a full score."),
      makeRow(2, "如果你不这么做，神不喜欢这样的人。", "If you don't do this, God dislikes such people."),
    ];
    // Simulate AI off-by-one: line 1 steals "Jika", line 2 leaks "Oleh"
    const olehIdx = tk.tokens.indexOf("Oleh");
    const spans = [
      { start: 0, end: 4 }, // "Tuhan memberimu nilai sempurna. Jika"
      { start: 5, end: olehIdx }, // "engkau tidak melakukan hal-hal ini, Tuhan tidak menyukai orang-orang semacam ini. Oleh"
    ];
    const sliced = sliceTokensBySpans(tk.tokens, tk.joinSep, spans, rows, idRule);
    expect(sliced).toEqual([
      "Tuhan memberimu nilai sempurna.",
      "Jika engkau tidak melakukan hal-hal ini, Tuhan tidak menyukai orang-orang semacam ini.",
    ]);
  });

  it("extracts per-language Bible source/version column (e.g. Ukrainian col I / Romanian col G)", () => {
    const mk = (t: string) => ({ text: t });
    const grid = [
      [mk("目录"), mk("英文章节"), mk("Chinese"), mk("English"), mk("Ukrainian"), mk("备注"), mk(""), mk(""), mk("圣经网或译者翻译")],
      [mk("创世记"), mk("Genesis 1:1"), mk("起初，神创造天地。"), mk("In the beginning God created the heaven and the earth."), mk("«На початку Бог створив Небо та землю» (Буття 1:1)."), mk(""), mk(""), mk(""), mk("圣经网")],
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
    expect(entries[0].source).toBe("圣经网");

    const hit = findBibleVerse(entries, "Genesis 1:1", [makeRow(1, "起初，神创造天地。", "In the beginning...")]);
    expect(hit?.source).toBe("圣经网");

    // Also auto-detects "圣经网或译者翻译" / "版本备注" header when bibleSourceCol is omitted ("")
    const autoEntries = parseBibleLibrarySheet(grid, {
      bibleHeaderRow: 1,
      bibleChapterCol: "B",
      bibleZhCol: "C",
      bibleEnCol: "D",
      bibleTargetCol: "E",
      bibleSourceCol: "",
    });
    expect(autoEntries[0].source).toBe("圣经网");
  });

  it("extracts inline single-row Bible verses without dropping trailing citation and populates demo bibleSource", async () => {
    const { doc, runs } = await createSyntheticDemoState();
    const uk = runs.get("乌克兰语")!;
    const bibleRows = uk.rows.filter((r) => Boolean(r.bibleSource));
    expect(bibleRows.length).toBeGreaterThanOrEqual(2);
    expect(bibleRows[0].bibleSource).toBe("圣经网");

    // Verify full-sentence split hint on multi-row God's words block in demo
    const splitHintRow = uk.rows.find((r) => r.hint.includes("完整原文："));
    expect(splitHintRow).toBeDefined();

    // Verify xlsx always contains both 【工具提示】 and 【圣经来源】 headers
    const xlsxBytes = buildMultiSheetXlsx(doc, [uk]);
    const xlsxStr = new TextDecoder().decode(xlsxBytes);
    expect(xlsxStr).toContain("【工具提示】");
    expect(xlsxStr).toContain("【圣经来源】");
    expect(xlsxStr).toContain("圣经网");

    // Verify inline single-row Bible citation is preserved when there is no separate Subtitle row
    const inlineGrid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ["10", "", "", "Host", "“起初，神创造天地。”（创1:1）", '"In the beginning God created the heaven and the earth." (Genesis 1:1).', "No need to translate!", "", "", "", "创世记 1:1", "需要摘"],
    ];
    const inlineDoc = parseGridToScriptDocument(inlineGrid, "inline-bible");
    const inlineOut = await runLanguageExtractionPipeline(
      inlineDoc,
      {
        langName: "乌克兰语",
        rule: resolvePunctuationRule("乌克兰语"),
        godSaysText: "",
        commonFixedTerms: new Map(),
        citations: [],
        articles: [],
        articleDocsCache: new Map(),
        bibleEntries: [
          {
            chapterRef: "Genesis 1:1",
            chinese: "“起初，神创造天地。”（创1:1）",
            english: '"In the beginning God created the heaven and the earth" (Genesis 1:1).',
            targetText: "«На початку Бог створив Небо та землю» (Буття 1:1).",
            source: "圣经网",
          },
        ],
        idioms: [],
        hymns: [],
        lordsPrayer: [],
        rosterEntries: [],
      },
      { enableRosterPreFill: false },
    );
    expect(inlineOut.rows[0].targetLanguage).toBe("«На початку Бог створив Небо та землю» (Буття 1:1).");
    expect(inlineOut.rows[0].bibleSource).toBe("圣经网");
  });
});

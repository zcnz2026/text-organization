import { describe, expect, it } from "vitest";
import type { LanguageCatalog } from "../src/catalog/catalog-types";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import { runLanguageExtractionPipeline } from "../src/engine/pipeline";

describe("synthetic end-to-end extraction pipeline", () => {
  it("runs cleanly across multi-category synthetic rows without real manuscript excerpts", async () => {
    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ["1", "", "", "Title", "北方分会工作纪实", "", "", "Northern Branch\nXX", "", "提前贴上名称", "", ""],
      ["2", "00:01:00:00", "00:01:03:00", "Host", "《晨光之歌》。", '"Song of Morning Light."', "No need to translate!", "Song of Morning Light\nXX", "", "提前贴上", "含诗歌标题", "需要摘"],
      ["3", "00:02:00:00", "00:02:04:00", "Reader", "“春天的阳光洒满山岗，", '"Spring sunlight fills the hills,', "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["4", "00:02:04:00", "00:02:08:00", "Reader", "万物都在悄然生长。”", 'and all things quietly grow."', "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["5", "00:02:08:00", "00:02:10:00", "Subtitle", "《卷一・第一篇》", "from Vol. 1, Essay 1", "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["6", "00:03:00:00", "00:03:03:00", "Caption", "千里之行，始于足下", "A journey of a thousand miles begins with a single step", "No need to translate!", "", "", "", "俗语", ""],
    ];

    const doc = parseGridToScriptDocument(grid, "SyntheticTest");
    const ukCatalog: LanguageCatalog = {
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
          zhSubtitleCite: "《卷一・第一篇》",
          zhBracketCite: "",
          targetCite: "з «Том 1. Нарис 1»",
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
      bibleEntries: [],
      idioms: [
        {
          zhVariants: ["千里之行，始于足下"],
          enVariants: ["A journey of a thousand miles begins with a single step"],
          targetText: "Подорож у тисячу миль починається з одного кроку",
        },
      ],
      hymns: [
        {
          zhTitle: "晨光之歌",
          enTitle: "Song of Morning Light",
          targetTitle: "Пісня ранкового світла",
          lines: [],
        },
      ],
      lordsPrayer: [],
      rosterEntries: [
        {
          chinese: "北方分会",
          english: "Northern Branch",
          episode: "10期",
          targetText: "Північне відділення",
        },
      ],
    };

    const out = await runLanguageExtractionPipeline(doc, ukCatalog, {
      enableRosterPreFill: true,
    });
    expect(out.missingCount).toBe(0);
    expect(out.matchedCount).toBeGreaterThanOrEqual(5);
    expect(out.rows[0].note).toContain("Північне відділення");
    expect(out.rows[1].targetLanguage).toBe("«Пісня ранкового світла».");
    expect(out.rows[2].targetLanguage.startsWith("«Весняне")).toBe(true);
    expect(out.rows[3].targetLanguage.endsWith("росте».")).toBe(true);
    expect(out.rows[4].targetLanguage).toBe("з «Том 1. Нарис 1»");
    expect(out.rows[5].targetLanguage).toBe("Подорож у тисячу миль починається з одного кроку");
  });
});

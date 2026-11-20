import type { LanguageCatalog } from "../catalog/catalog-types";
import { resolvePunctuationRule } from "../catalog/lang-presets";
import { parseGridToScriptDocument } from "../engine/csv-sheet";
import { runLanguageExtractionPipeline } from "../engine/pipeline";
import type { LanguageRunOutput, ScriptSheetDocument } from "../types/domain";

const DEMO_GRID: string[][] = [
  [
    "Line",
    "In Time",
    "Out Time",
    "Character",
    "Chinese",
    "English底",
    "Target Language",
    "Note",
    "备注",
    "送翻备注",
    "筛选列",
    "需要摘",
  ],
  [
    "3",
    "",
    "",
    "Title Ⅲ",
    "葡萄牙・布拉加全能神教会的经历见证：活着尽好受造之物的本分才有意义",
    "",
    "",
    "As for the church name, please use the provided one:\nThe Church of Almighty God in Braga, Portugal\nXX",
    "教会名：30期图解Line 101",
    "提前贴上教会名",
    "",
    "",
  ],
  [
    "53",
    "00:02:52:02",
    "00:02:54:11",
    "Bruno Rodrigues (M)",
    "《神的话语都是真理》。",
    "\"All God's Words Are the Truth.\"",
    "No need to translate!",
    "All God's Words Are the Truth\nXX",
    "",
    "提前贴上",
    "含诗歌标题",
    "需要摘",
  ],
  [
    "74",
    "00:05:33:10",
    "00:05:38:06",
    "Sandra Queiros (F)",
    "请大家打开《话在肉身显现》第二卷《关于认识神》",
    "The Word Appears in the Flesh\n\"On Knowing God\"",
    "",
    "The Word Appears in the Flesh\nXX\nOn Knowing God\nXX",
    "",
    "提前贴上",
    "含书名、卷名",
    "需要摘",
  ],
  [
    "255",
    "00:19:23:02",
    "00:19:25:15",
    "Laydinha Castro (F)",
    "全能神说：",
    "Almighty God says:",
    "No need to translate!",
    "",
    "",
    "",
    "卷一　神的显现与作工・附篇二　神主宰着全人类的命运",
    "需要摘",
  ],
  [
    "256",
    "00:19:25:15",
    "00:19:31:25",
    "Laydinha Castro (F)",
    "“作为人类中的一员，作为敬虔基督徒中的一员，",
    "\"As members of mankind and as pious Christians,",
    "No need to translate!",
    "",
    "",
    "",
    "卷一　神的显现与作工・附篇二　神主宰着全人类的命运",
    "需要摘",
  ],
  [
    "257",
    "00:19:31:25",
    "00:19:38:02",
    "Laydinha Castro (F)",
    "我们都有责任、有义务为完成神的托付而献上我们的身心。”",
    "it is the responsibility and obligation of us all to offer up our minds and bodies.\"",
    "No need to translate!",
    "",
    "",
    "",
    "卷一　神的显现与作工・附篇二　神主宰着全人类的命运",
    "需要摘",
  ],
  [
    "258",
    "00:19:38:02",
    "00:19:41:06",
    "Subtitle",
    "《话・卷一　神的显现与作工・附篇二　神主宰着全人类的命运》",
    "from The Word, Vol. 1. The Appearance and Work of God. Appendix 2: God Holds Sovereignty Over the Destiny of All Mankind",
    "No need to translate!",
    "",
    "",
    "",
    "卷一　神的显现与作工・附篇二　神主宰着全人类的命运",
    "需要摘",
  ],
  [
    "661",
    "00:46:43:00",
    "00:46:47:10",
    "Caption",
    "人不为己，天诛地灭",
    "Every man for himself and the devil take the hindmost",
    "No need to translate!",
    "",
    "37期",
    "",
    "撒但毒素",
    "",
  ],
  [
    "692",
    "00:47:02:10",
    "00:47:06:15",
    "Probin Boro (M)",
    "“我所愿意的，我并不做，",
    "\"… what I would, that do I not;",
    "No need to translate!",
    "",
    "涉及截取：For what I would, that do I not; but what I hate, that do I.",
    "",
    "新约",
    "",
  ],
  [
    "693",
    "00:47:06:15",
    "00:47:10:02",
    "Probin Boro (M)",
    "我所恨恶的，我倒去做。”",
    "but what I hate, that do I.\"",
    "No need to translate!",
    "",
    "",
    "",
    "新约",
    "",
  ],
  [
    "694",
    "00:47:10:02",
    "00:47:12:18",
    "Subtitle",
    "（罗马书7:15）",
    "(Romans 7:15).",
    "No need to translate!",
    "",
    "",
    "",
    "新约",
    "",
  ],
];

export async function createSyntheticDemoState(): Promise<{
  doc: ScriptSheetDocument;
  runs: Map<string, LanguageRunOutput>;
}> {
  const doc = parseGridToScriptDocument(DEMO_GRID, "39期教会生活（演示样本）");
  const ukCatalog: LanguageCatalog = {
    langName: "乌克兰语",
    rule: resolvePunctuationRule("乌克兰语"),
    godSaysText: "Всемогутній Бог каже",
    commonFixedTerms: new Map(),
    citations: [],
    articles: [
      {
        zhTitle: "话在肉身显现",
        enTitle: "The Word Appears in the Flesh VOLUME 1",
        targetTitle: "Слово являється у плоті ТОМ 1",
        docUrl: "",
        zhSubtitleCite: "",
        zhBracketCite: "",
        targetCite: "",
      },
      {
        zhTitle: "关于认识神",
        enTitle: "On Knowing God",
        targetTitle: "Про пізнання Бога",
        docUrl: "",
        zhSubtitleCite: "",
        zhBracketCite: "",
        targetCite: "",
      },
      {
        zhTitle: "附篇二　神主宰着全人类的命运",
        enTitle: "Appendix 2: God Holds Sovereignty Over the Destiny of All Mankind",
        targetTitle: "Додаток 2: Бог володарює над долею всього людства",
        docUrl: "demo://appendix2",
        zhSubtitleCite: "",
        zhBracketCite: "",
        targetCite:
          "зі «Слово, т. 1. Явлення й робота Бога. Додаток 2: Бог володарює над долею всього людства»",
      },
    ],
    articleDocsCache: new Map([
      [
        "demo://appendix2",
        [
          {
            chinese:
              "作为人类中的一员，作为敬虔基督徒中的一员，我们都有责任、有义务为完成神的托付而献上我们的身心。",
            english:
              "As members of mankind and as pious Christians, it is the responsibility and obligation of us all to offer up our minds and bodies.",
            target:
              "Як представники людства і як побожні християни, ми всі маємо обов’язок і відповідальність присвятити свій розум і тіло виконанню Божого доручення.",
          },
        ],
      ],
    ]),
    bibleEntries: [
      {
        chapterRef: "Romans 7:15",
        chinese: "因为我所愿意的，我并不做；我所恨恶的，我倒去做。",
        english: "For what I would, that do I not; but what I hate, that do I.",
        targetText:
          "«Бо те, чого хочу, не роблю, а те, що ненавиджу, роблю» (Римлян 7:15).",
        source: "圣经网",
      },
    ],
    idioms: [
      {
        zhVariants: ["人不为己，天诛地灭"],
        enVariants: ["Every man for himself and the devil take the hindmost"],
        targetText: "Кожен сам за себе, а невдаху нехай чорт забере",
      },
    ],
    hymns: [
      {
        zhTitle: "神的话语都是真理",
        enTitle: "All God's Words Are the Truth",
        targetTitle: "Усі Божі слова — це істина",
        lines: [],
      },
    ],
    lordsPrayer: [],
    rosterEntries: [
      {
        chinese: "葡萄牙・布拉加全能神教会\n教会生活实况报道",
        english:
          "The Church of Almighty God in Braga, Portugal\nAn On-the-Scene Report on Church Life",
        episode: "30期",
        targetText:
          "Церква Всемогутнього Бога в Бразі, Португалія\nРепортаж із місця подій про церковне життя",
      },
    ],
  };

  const ukOut = await runLanguageExtractionPipeline(doc, ukCatalog, {
    enableRosterPreFill: true,
  });
  const runs = new Map<string, LanguageRunOutput>([["乌克兰语", ukOut]]);
  return { doc, runs };
}

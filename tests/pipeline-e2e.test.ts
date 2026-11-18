import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LanguageCatalog } from "../src/catalog/catalog-types";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseCsvToGrid, parseGridToScriptDocument } from "../src/engine/csv-sheet";
import { runLanguageExtractionPipeline } from "../src/engine/pipeline";

const SAMPLE_CSV = path.resolve(
  __dirname,
  "../../剧本/对应句子/演示稿 - 39期教会生活.csv",
);

function buildMockUkrainianCatalog(): LanguageCatalog {
  return {
    langName: "乌克兰语",
    rule: resolvePunctuationRule("乌克兰语"),
    godSaysText: "Всемогутній Бог каже",
    commonFixedTerms: new Map(),
    citations: [
      {
        keyZh: "《话・卷一　神的显现与作工》",
        keyEn: "from The Word, Vol. 1. The Appearance and Work of God",
        subtitleBand: "зі «Слово, т. 1. Явлення й робота Бога»",
        videoEffect: "(Слово, т. 1. Явлення й робота Бога).",
      },
    ],
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
        zhTitle: "独一无二的神自己　三",
        enTitle: "God Himself, the Unique III",
        targetTitle: "Сам Бог, Унікальний III",
        docUrl: "https://docs.google.com/document/d/mock_unique_3_doc_id/edit",
        zhSubtitleCite: "——《话・卷二　关于认识神・独一无二的神自己　三》",
        zhBracketCite: "（《话・卷二　关于认识神・独一无二的神自己　三》）",
        targetCite: "зі «Слово, т. 2. Про пізнання Бога. Сам Бог, Унікальний III»",
      },
      {
        zhTitle: "附篇二　神主宰着全人类的命运",
        enTitle: "Appendix 2: God Holds Sovereignty Over the Destiny of All Mankind",
        targetTitle: "Додаток 2: Бог володарює над долею всього людства",
        docUrl: "https://docs.google.com/document/d/mock_appendix_2_doc_id/edit",
        zhSubtitleCite: "——《话・卷一　神的显现与作工・附篇二　神主宰着全人类的命运》",
        zhBracketCite: "",
        targetCite:
          "зі «Слово, т. 1. Явлення й робота Бога. Додаток 2: Бог володарює над долею всього людства»",
      },
    ],
    articleDocsCache: new Map([
      [
        "https://docs.google.com/document/d/mock_appendix_2_doc_id/edit",
        [
          {
            chinese:
              "作为人类中的一员，作为敬虔基督徒中的一员，我们都有责任、有义务为完成神的托付而献上我们的身心，因为我们的全人都是从神而来，都是因神的主宰而有的。若我们的身心不是为了神的托付，不是为了人类正义的事业，那我们的灵魂将愧对于为神的托付而殉道的人，更愧对于供应我们全部的神。",
            english:
              "As members of mankind and as pious Christians, it is the responsibility and obligation of us all to offer up our minds and bodies for the fulfillment of God's commission, because our entire being came from God, and it exists thanks to the sovereignty of God. If our minds and bodies are not dedicated to God's commission and not dedicated to the just cause of mankind, then our souls will feel ashamed before those who were martyred for God's commission, and much more ashamed before God, who has provided us with everything.",
            target:
              "Як представники людства і як побожні християни, ми всі маємо обов’язок і відповідальність присвятити свій розум і тіло виконанню Божого доручення, бо все наше єство походить від Бога й існує завдяки Божому володарюванню. Якщо наш розум і тіло присвячені не Божому дорученню і не праведній справі людства, тоді наші душі почуватимуться осоромленими перед тими, хто прийняв мученицьку смерть за Боже доручення, а тим більше перед Богом, Який забезпечив нас усім.",
          },
        ],
      ],
    ]),
    bibleEntries: [
      {
        chapterRef: "Luke 17:24–25",
        chinese:
          "因为人子在他降临的日子，好像闪电从天这边一闪直照到天那边。只是他必须先受许多苦，又被这世代弃绝。",
        english:
          "For as the lightning, that lightens out of the one part under heaven, shines to the other part under heaven; so shall also the Son of man be in His day. But first must He suffer many things, and be rejected of this generation.",
        targetText:
          "«Бо як блискавка, що блискає з одного краю піднебесної, світить аж до другого краю піднебесної, так буде і Син Людський у Свій день. Але перше належить Йому багато постраждати й бути відкинутим цим поколінням» (Луки 17:24–25).",
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
        targetCitation: "з «Ідіть за Агнцем і співайте нових пісень. Усі Божі слова — це істина»",
      },
    ],
    lordsPrayer: [
      { chinese: "全能神啊，", english: "Almighty God,", target: "Всемогутній Боже," },
      { chinese: "", english: "", target: "Ти — Господь Ісус, Який повернувся," },
      { chinese: "", english: "", target: "Ти — Той, на Кого ми чекали," },
      { chinese: "", english: "", target: "Ми бажаємо йти за Тобою," },
      { chinese: "", english: "", target: "приймати Твої слова, Твоє забезпечення й Твоє провідництво." },
      { chinese: "", english: "", target: "Не введи нас у спокусу, але визволи нас від лукавого," },
      { chinese: "", english: "", target: "бо Твоє є Царство, і сила, і слава навіки!" },
      { chinese: "阿们！", english: "Amen!", target: "Амінь!" },
    ],
    rosterEntries: [
      {
        chinese: "葡萄牙・布拉加全能神教会\n教会生活实况报道",
        english:
          "The Church of Almighty God in Braga, Portugal\nAn On-the-Scene Report on Church Life",
        episode: "30期",
        targetText:
          "Церква Всемогутнього Бога в Бразі, Португалія\nРепортаж із місця подій про церковне життя",
      },
      {
        chinese: "葡萄牙・布拉加全能神教会\n教会生活实况报道",
        english:
          "The Church of Almighty God in Braga, Portugal\nAn On-the-Scene Report on Church Life",
        episode: "8期",
        targetText: "СТАРИЙ ВАРІАНТ 8 ВИПУСК",
      },
      {
        chinese: "葡萄牙",
        english: "Portugal",
        episode: "35期",
        targetText: "Португалія",
      },
      {
        chinese: "布鲁诺・罗德里格什",
        english: "Bruno Rodrigues",
        episode: "18期",
        targetText: "Бруну Родрігеш",
      },
    ],
  };
}

import { createSyntheticDemoState } from "../src/ui/demo-fixture";

describe("synthetic end-to-end extraction pipeline", () => {
  it("runs cleanly on built-in multi-category fixture for CI", async () => {
    const { runs } = await createSyntheticDemoState();
    const uk = runs.get("乌克兰语")!;
    expect(uk.matchedCount).toBeGreaterThanOrEqual(8);
    expect(uk.missingCount).toBe(0);
  });
});

describe.skipIf(!fs.existsSync(SAMPLE_CSV))("end-to-end extraction pipeline on real 39期 script", () => {
  it("extracts, splits, formats quotes, replaces Note XX, respects latest roster episode, and leaves Amen untouched", async () => {
    const raw = fs.readFileSync(SAMPLE_CSV, "utf-8");
    const script = parseGridToScriptDocument(parseCsvToGrid(raw), "39期");
    const catalog = buildMockUkrainianCatalog();

    const out = await runLanguageExtractionPipeline(script, catalog, {
      enableRosterPreFill: true,
    });

    const rowByLine = (lineVal: string) => {
      const idx = script.rows.findIndex((r) => r.line === lineVal);
      return out.rows[idx];
    };

    const r3 = rowByLine("3");
    expect(r3.targetLanguage).toBe("");
    expect(r3.note).toContain("Церква Всемогутнього Бога в Бразі, Португалія");
    expect(r3.note).not.toContain("СТАРИЙ ВАРІАНТ");

    const r4 = rowByLine("4");
    expect(r4.targetLanguage).toBe(
      "Церква Всемогутнього Бога в Бразі, Португалія\nРепортаж із місця подій про церковне життя",
    );

    const r53 = rowByLine("53");
    expect(r53.targetLanguage).toBe("«Усі Божі слова — це істина».");
    expect(r53.note).toContain("Усі Божі слова — це істина");

    const r54Amen = rowByLine("54");
    expect(r54Amen.targetLanguage).toBe("No need to translate!");
    expect(r54Amen.status).toBe("untouched");

    const r74 = rowByLine("74");
    expect(r74.targetLanguage).toBe("");
    expect(r74.note).toContain("Слово являється у плоті");
    expect(r74.note).toContain("Про пізнання Бога");

    const r76 = rowByLine("76");
    expect(r76.targetLanguage).toBe("«Сам Бог, Унікальний III».");

    const r218 = rowByLine("218");
    const r224 = rowByLine("224");
    expect(r218.targetLanguage.startsWith("«Як представники людства")).toBe(true);
    expect(r224.targetLanguage.endsWith("усім».")).toBe(true);

    const r225Cite = rowByLine("225");
    expect(r225Cite.targetLanguage).toBe(
      "зі «Слово, т. 1. Явлення й робота Бога. Додаток 2: Бог володарює над долею всього людства»",
    );

    const r255Prefix = rowByLine("255");
    expect(r255Prefix.targetLanguage).toBe("Всемогутній Бог каже:");

    const r653Prayer = rowByLine("653");
    const r660PrayerEnd = rowByLine("660");
    expect(r653Prayer.targetLanguage).toBe("Всемогутній Боже,");
    expect(r660PrayerEnd.targetLanguage).toBe("Амінь!");

    const idiomIdx = script.rows.findIndex((r) => r.chinese.includes("人不为己"));
    expect(out.rows[idiomIdx].targetLanguage).toBe(
      "Кожен сам за себе, а невдаху нехай чорт забере",
    );

    const lukeVerseIdx = script.rows.findIndex((r) =>
      r.chinese.includes("因为人子在他降临的日子"),
    );
    const lukeCiteIdx = script.rows.findIndex((r) =>
      r.chinese.includes("路加福音17:24-25"),
    );
    expect(out.rows[lukeVerseIdx].targetLanguage.startsWith("«Бо як блискавка")).toBe(true);
    expect(out.rows[lukeCiteIdx].targetLanguage).toBe("(Луки 17:24–25).");
  });
});

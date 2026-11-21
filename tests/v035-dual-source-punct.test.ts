import { beforeEach, describe, expect, it } from "vitest";
import { resetTodayKeyUsage } from "../src/ai/key-usage-store";
import type { LanguageCatalog } from "../src/catalog/catalog-types";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import {
  analyzeBilingualAlignment,
  batchSplitTargetsWithAi,
} from "../src/engine/line-splitter";
import {
  formatAiFailureHint,
  runLanguageExtractionPipeline,
} from "../src/engine/pipeline";
import type { ScriptRow } from "../src/types/domain";

function makeRow(
  rowIndex: number,
  chinese: string,
  english: string,
  opts?: { line?: string; remark?: string },
): ScriptRow {
  return {
    rowIndex,
    rawCells: [],
    line: opts?.line ?? String(450 + rowIndex),
    inTime: "",
    outTime: "",
    character: "Speaker",
    chinese,
    english,
    targetLanguage: "No need to translate!",
    note: "",
    remark: opts?.remark ?? "",
    sendRemark: "",
    filterCategory: "卷一・第一篇",
    needExtract: "需要摘",
  };
}

describe("v0.3.5 dual-source (Chinese + English) punctuation check & soft-warning yellow highlight", () => {
  beforeEach(() => {
    resetTodayKeyUsage();
  });

  it("1. passes directly with zero error when Ukrainian matches Chinese 2-question-mark count while English merged into 1 question mark (R457 scenario)", async () => {
    const ukRule = resolvePunctuationRule("乌克兰语");

    const rows3: ScriptRow[] = [
      makeRow(
        0,
        "“在日常工程测试中，每个小组都会面临严格的技术标准，",
        '"In daily engineering tests, every team faces strict technical standards,',
        { line: "456" },
      ),
      makeRow(
        1,
        "他们能不能达到更高的精度？能不能达到零误差的要求？",
        "can they achieve higher precision and zero-defect requirements?",
        { line: "457" },
      ),
      makeRow(
        2,
        "这需要全组人员在每个环节都保持高度专注。”",
        'This requires the entire team to stay highly focused at every step."',
        { line: "458" },
      ),
    ];

    const ukLines3 = [
      "У щоденних інженерних випробуваннях кожна група стикається з суворими технічними стандартами,",
      "чи можуть вони досягти вищої точності? Чи можуть вони досягти вимоги нульової похибки?",
      "Це вимагає від усієї команди високої концентрації на кожному етапі.",
    ];
    const fullUkText = ukLines3.join(" ");

    // Row 2 has ZH=2?, EN=1?, UK=2? -> must match Chinese and produce NO hardReason and NO softReason!
    const analysis = analyzeBilingualAlignment(ukLines3, rows3, fullUkText, ukRule);
    expect(analysis.hardReason).toBeNull();
    expect(analysis.softReason).toBeNull();

    let apiCalls = 0;
    const mockGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson(input: { userPrompt: string }) {
        apiCalls += 1;
        const idMatch = /任务ID:\s*(\S+)/.exec(input.userPrompt);
        return {
          results: [{ id: idMatch?.[1] ?? "task_0", lines: ukLines3 }],
        };
      },
    } as never;

    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ...rows3.map((r) => [
        r.line,
        "",
        "",
        "Speaker",
        r.chinese,
        r.english,
        "No need to translate!",
        "",
        "",
        "",
        "卷一・第一篇",
        "需要摘",
      ]),
    ];
    const doc = parseGridToScriptDocument(grid, "UkrainianDualQuestionTest");
    const ukCatalog: LanguageCatalog = {
      langName: "乌克兰语",
      rule: ukRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "第一篇",
          enTitle: "Essay 1",
          targetTitle: "Нарис 1",
          docUrl: "mock://uk_r457",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://uk_r457",
          [
            {
              chinese: rows3.map((r) => r.chinese).join(""),
              english: rows3.map((r) => r.english).join(" "),
              target: fullUkText,
            },
          ],
        ],
      ]),
      bibleEntries: [],
      idioms: [],
      hymns: [],
      lordsPrayer: [],
      rosterEntries: [],
    };

    const out = await runLanguageExtractionPipeline(doc, ukCatalog, {
      enableRosterPreFill: false,
      gemini: mockGemini,
    });

    // Only 1 AI call needed (no unnecessary semantic audit call!), all 3 rows matched green!
    expect(apiCalls).toBe(1);
    expect(out.missingCount).toBe(0);
    expect(out.matchedCount).toBe(3);
    expect(out.rows[1].status).toBe("matched");
    expect(out.rows[1].targetLanguage).toContain(
      "чи можуть вони досягти вищої точності? Чи можуть вони досягти вимоги нульової похибки?",
    );
  });

  it("2. treats rhetorical question split (1? vs 2?) or unidirectional comma->period style differences as softReason, and fills target text with yellow warning when AI confirms meaning", async () => {
    const idRule = resolvePunctuationRule("印尼语");

    // 2A: Unidirectional comma -> period style difference in Indonesian (no adjacent opposite swap)
    // plus rhetorical 1? in ZH/EN translated as 2? in Indonesian on row 2
    const rows3: ScriptRow[] = [
      makeRow(
        0,
        "“在第一阶段，团队已经完成了全部基础设备的安装调试，",
        '"In the first stage, the team has completed the installation and debugging of all basic equipment,',
      ),
      makeRow(
        1,
        "在第二阶段，我们还需要测试系统的稳定性，难道这样还不够稳妥吗？",
        "in the second stage, we also need to test system stability, is this arrangement not reliable enough?",
      ),
      makeRow(
        2,
        "现在所有准备工作都已经顺利结束。”",
        'now all preparation work has been smoothly concluded."',
      ),
    ];

    const idLines3 = [
      "Pada tahap pertama, tim telah menyelesaikan pemasangan dan pengujian semua peralatan dasar.",
      "Pada tahap kedua, kita juga perlu menguji stabilitas sistem? Bukankah pengaturan ini sudah cukup andal?",
      "Sekarang seluruh pekerjaan persiapan telah selesai dengan lancar.",
    ];
    const fullIdText = idLines3.join(" ");

    const analysis = analyzeBilingualAlignment(idLines3, rows3, fullIdText, idRule);
    expect(analysis.hardReason).toBeNull();
    expect(analysis.softReason).not.toBeNull();

    let callStep = 0;
    const refereeGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson(input: { userPrompt: string }) {
        callStep += 1;
        if (callStep === 1) {
          const idMatch = /任务ID:\s*(\S+)/.exec(input.userPrompt);
          return {
            results: [{ id: idMatch?.[1] ?? "task_0", lines: idLines3 }],
          };
        }
        return {
          verdict: "accurate",
          reason: "第1行句尾断句为句号、第2行反问句拆为两个问号均属定稿标点风格差异，三语逐行语义完全对应",
        };
      },
    } as never;

    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ...rows3.map((r) => [
        r.line,
        "",
        "",
        "Speaker",
        r.chinese,
        r.english,
        "No need to translate!",
        "",
        "",
        "",
        "卷一・标点风格篇",
        "需要摘",
      ]),
    ];
    const doc = parseGridToScriptDocument(grid, "PunctStyleYellowTest");
    const idCatalog: LanguageCatalog = {
      langName: "印尼语",
      rule: idRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "标点风格篇",
          enTitle: "Punctuation Style Essay",
          targetTitle: "Esai Gaya Tanda Baca",
          docUrl: "mock://id_punct_style",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://id_punct_style",
          [
            {
              chinese: rows3.map((r) => r.chinese).join(""),
              english: rows3.map((r) => r.english).join(" "),
              target: fullIdText,
            },
          ],
        ],
      ]),
      bibleEntries: [],
      idioms: [],
      hymns: [],
      lordsPrayer: [],
      rosterEntries: [],
    };

    const out = await runLanguageExtractionPipeline(doc, idCatalog, {
      enableRosterPreFill: false,
      gemini: refereeGemini,
    });

    // Must fill the verbatim target text and mark yellow "warning" instead of wiping the block!
    expect(out.missingCount).toBe(0);
    expect(out.warningCount).toBe(3);
    expect(out.rows[0].status).toBe("warning");
    expect(out.rows[0].targetLanguage).toContain("Pada tahap pertama");
    expect(out.rows[0].hint).toBe("仅标点差异，已通过 AI 语义核对，请人工顺便确认");
    expect(out.rows[1].status).toBe("warning");
    expect(out.rows[1].targetLanguage).toContain("Bukankah pengaturan ini sudah cukup andal?");
    expect(out.rows[2].status).toBe("warning");
    expect(out.rows[2].targetLanguage).toContain("selesai dengan lancar.");
  });

  it("3. still enforces hardReason on genuine statement<->question line shift or adjacent period/comma opposite swap even if AI claims accurate", async () => {
    const idRule = resolvePunctuationRule("印尼语");

    // 3A: Genuine statement (0? in both ZH and EN) vs question (1? in Target) due to line shift
    const rowsShift: ScriptRow[] = [
      makeRow(0, "“所有成员都已经检查今天早上的日程了吗？", '"Have all members checked the schedule this morning?'),
      makeRow(1, "我们必须在会议开始前准备好完整报告。”", 'We must prepare the full report before the meeting starts."'),
    ];
    const shiftedLines = [
      "Apakah semua anggota",
      "sudah memeriksa jadwal pagi ini? Kita harus menyiapkan laporan lengkap sebelum rapat dimulai.",
    ];
    const fullShiftText =
      "Apakah semua anggota sudah memeriksa jadwal pagi ini? Kita harus menyiapkan laporan lengkap sebelum rapat dimulai.";

    const shiftAnalysis = analyzeBilingualAlignment(shiftedLines, rowsShift, fullShiftText, idRule);
    expect(shiftAnalysis.hardReason).not.toBeNull();
    expect(shiftAnalysis.hardReason).toContain("问号数量不一致");

    // 3B: Adjacent period/comma opposite swap (Row 1: ZH/EN comma vs Target period; Row 2: ZH/EN period vs Target comma; Row 3: period)
    const rowsSwap: ScriptRow[] = [
      makeRow(0, "“当第一阶段完成时，", '"When the first stage is completed,'),
      makeRow(1, "我们就立刻启动第二阶段。", "we will start the second stage immediately."),
      makeRow(2, "随后所有成员都将进入新岗位。”", 'Then all members will enter their new posts."'),
    ];
    const swappedLines = [
      "Ketika tahap pertama selesai, kita akan segera memulai.",
      "Tahap kedua,",
      "kemudian semua anggota akan memasuki posisi baru mereka.",
    ];
    const fullSwapText = swappedLines.join(" ");

    const swapAnalysis = analyzeBilingualAlignment(swappedLines, rowsSwap, fullSwapText, idRule);
    expect(swapAnalysis.hardReason).not.toBeNull();
    expect(swapAnalysis.hardReason).toContain("句末句号与逗号交叉错位");

    const dishonestGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        return {
          results: [{ id: "hard_shift", lines: shiftedLines }],
          verdict: "accurate",
          reason: "Falsely claiming accurate",
        };
      },
    } as never;

    const map = await batchSplitTargetsWithAi(
      [
        {
          id: "hard_shift",
          fallbackText: fullShiftText,
          aiSourceText: fullShiftText,
          sourceRows: rowsShift,
          isPartial: false,
        },
      ],
      idRule,
      dishonestGemini,
    );
    const res = map.get("hard_shift")!;
    expect(res.usedAi).toBe(false);
    expect(res.failed).toBe(true);
    expect(res.lines).toEqual([]);
  });

  it("4. formatAiFailureHint explicitly states '原文已定位，但 AI 分句未通过严格双语核对' and points to left live process log", () => {
    const hint = formatAiFailureHint(
      {
        lines: [],
        usedAi: false,
        failed: true,
        errorReason: "双语核对未通过：第 2 行问号数量不一致（源文 0 个 vs 目标语 1 个）",
      },
      true,
    );
    expect(hint).toContain("原文已定位，但 AI 分句未通过严格双语核对");
    expect(hint).toContain("请展开左侧「运行过程日志」查看定位原文与对照");
  });
});

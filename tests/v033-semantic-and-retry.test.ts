import { beforeEach, describe, expect, it } from "vitest";
import { GeminiPoolClient } from "../src/ai/gemini-client";
import { resetTodayKeyUsage } from "../src/ai/key-usage-store";
import type { LanguageCatalog } from "../src/catalog/catalog-types";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import {
  analyzeBilingualAlignment,
  batchSplitTargetsWithAi,
  projectLinesByBoundaryAnchors,
  projectLinesOntoVerbatimSource,
  tokenizeForIndexing,
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
  opts?: { line?: string; remark?: string; filterCategory?: string; needExtract?: string },
): ScriptRow {
  return {
    rowIndex,
    rawCells: [],
    line: opts?.line ?? String(rowIndex + 1),
    inTime: "",
    outTime: "",
    character: "Speaker",
    chinese,
    english,
    targetLanguage: "No need to translate!",
    note: "",
    remark: opts?.remark ?? "",
    sendRemark: "",
    filterCategory: opts?.filterCategory ?? "卷一・第一篇",
    needExtract: opts?.needExtract ?? "需要摘",
  };
}

function build28LineIndonesianFixture(): {
  rows: ScriptRow[];
  exactTargetLines: string[];
  fullTargetText: string;
} {
  const rows: ScriptRow[] = [];
  const exactTargetLines: string[] = [];

  for (let i = 0; i < 28; i += 1) {
    const n = i + 1;
    const isLast = i === 27;
    const punct = isLast ? "." : i % 3 === 2 ? "." : ",";
    rows.push(
      makeRow(
        i,
        `${i === 0 ? "“" : ""}第${n}阶段的工程质量核查已经按计划顺利推进并记录在册${isLast ? "。”" : punct === "." ? "。" : "，"}`,
        `${i === 0 ? '"' : ""}Phase ${n} engineering quality inspection has progressed smoothly according to the schedule and been recorded${isLast ? '."' : punct}`,
      ),
    );
    exactTargetLines.push(
      `Pemeriksaan kualitas teknis tahap ke-${n} telah berjalan lancar sesuai jadwal mingguan dan tercatat rapi${punct}`,
    );
  }

  return {
    rows,
    exactTargetLines,
    fullTargetText: exactTargetLines.join(" "),
  };
}

describe("v0.3.3 resilient boundary-anchor projection, alternate-key token-span retry & AI semantic referee", () => {
  beforeEach(() => {
    resetTodayKeyUsage();
  });

  it("1. 28-line long block with 1 character typo on line 14 recovers 100% verbatim manuscript text via boundary anchors", async () => {
    const idRule = resolvePunctuationRule("印尼语");
    const { rows, exactTargetLines, fullTargetText } = build28LineIndonesianFixture();

    // Introduce a 1-letter typo inside line 14 (index 13): "kualitas" -> "kualtas"
    const aiLinesWithTypo = [...exactTargetLines];
    aiLinesWithTypo[13] = aiLinesWithTypo[13].replace("kualitas", "kualtas");

    // Exact substring matcher fails because of the 1-character typo
    expect(projectLinesOntoVerbatimSource(fullTargetText, aiLinesWithTypo)).toBeNull();

    // Resilient boundary-anchor projector locates the exact boundaries and restores 100% original manuscript text!
    const anchored = projectLinesByBoundaryAnchors(fullTargetText, aiLinesWithTypo);
    expect(anchored).not.toBeNull();
    expect(anchored).toHaveLength(28);
    expect(anchored![13]).toBe(exactTargetLines[13]);
    expect(anchored).toEqual(exactTargetLines);

    let apiCalls = 0;
    const mockGemini = {
      hasKeys: true,
      keyCount: 3,
      async generateStructuredJson() {
        apiCalls += 1;
        return {
          results: [{ id: "long_28", lines: aiLinesWithTypo }],
        };
      },
    } as never;

    const resMap = await batchSplitTargetsWithAi(
      [
        {
          id: "long_28",
          fallbackText: fullTargetText,
          aiSourceText: fullTargetText,
          sourceRows: rows,
          isPartial: false,
        },
      ],
      idRule,
      mockGemini,
    );

    const split = resMap.get("long_28")!;
    expect(apiCalls).toBe(1);
    expect(split.usedAi).toBe(true);
    expect(split.failed).toBe(false);
    expect(split.lines).toHaveLength(28);
    expect(split.lines[13]).toContain("kualitas");
    expect(split.lines).toEqual(exactTargetLines);
  });

  it("2. 28-line long block returning wrong line count (26 lines) on Pass 1 switches to alternate Key (#2) and succeeds via Token-Index Spans", async () => {
    const idRule = resolvePunctuationRule("印尼语");
    const { rows, exactTargetLines, fullTargetText } = build28LineIndonesianFixture();

    // Compute exact token spans for the 28 lines
    const tk = tokenizeForIndexing(fullTargetText);
    const spans28: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const line of exactTargetLines) {
      const wordCount = line.split(/\s+/).filter(Boolean).length;
      spans28.push({ start: cursor, end: cursor + wordCount - 1 });
      cursor += wordCount;
    }
    expect(cursor).toBe(tk.tokens.length);

    const key1 = "AIzaSyMockPoolKeyNumber00000001";
    const key2 = "AIzaSyMockPoolKeyNumber00000002";
    const key3 = "AIzaSyMockPoolKeyNumber00000003";
    const usedKeys: string[] = [];
    const prompts: string[] = [];

    const poolClient = new GeminiPoolClient({
      apiKeys: [key1, key2, key3],
      model: "gemini-3.5-flash-lite",
      rotation: "failover",
      fetchFn: async (_input, init) => {
        const apiKey = (init?.headers as Record<string, string>)["x-goog-api-key"];
        usedKeys.push(apiKey);
        const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>;
        };
        const userPrompt = bodyObj.contents?.[0]?.parts?.[0]?.text ?? "";
        prompts.push(userPrompt);

        if (usedKeys.length === 1) {
          // Call 1 on key1: returns 26 lines instead of 28
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          results: [{ id: "long_28_retry", lines: exactTargetLines.slice(0, 26) }],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }

        // Call 2 on key2: token-index spans mode
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        spans: spans28,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const resMap = await batchSplitTargetsWithAi(
      [
        {
          id: "long_28_retry",
          fallbackText: fullTargetText,
          aiSourceText: fullTargetText,
          sourceRows: rows,
          isPartial: false,
        },
      ],
      idRule,
      poolClient,
    );

    // Must have switched from key1 to key2 even in failover mode because preferAlternateKey: true!
    expect(usedKeys).toEqual([key1, key2]);
    expect(prompts[1]).toContain("[0]Pemeriksaan");
    const split = resMap.get("long_28_retry")!;
    expect(split.usedAi).toBe(true);
    expect(split.failed).toBe(false);
    expect(split.lines).toEqual(exactTargetLines);
  });

  it("3. approves 7x length-ratio inverted block when AI semantic referee confirms row meanings match (verdict: 'accurate')", async () => {
    const idRule = resolvePunctuationRule("印尼语");

    // Row 1 EN is very short (19 chars: "In the early stage,"), Row 2 EN is very long (134 chars),
    // while Indonesian places a 94-char inverted clause on Row 1 and 68 chars on Row 2 -> ratio > 5.0!
    const rows3: ScriptRow[] = [
      makeRow(0, "“在最初的阶段，", '"In the early stage,'),
      makeRow(
        1,
        "每当现场技术团队在复杂环境中遇到突发信号干扰时，整个系统都会自动启动备用通道，",
        "whenever the field engineering team encounters sudden signal interference in a complex environment, the system activates backup channels,",
      ),
      makeRow(
        2,
        "从而确保所有测量数据都能安全完整地保存下来。”",
        'thereby ensuring that all measurement data can be saved safely and completely."',
      ),
    ];

    const invertedLines3 = [
      "Pada tahap awal ketika tim teknis lapangan menghadapi gangguan sinyal mendadak di lingkungan rumit,",
      "seluruh sistem secara otomatis mengaktifkan saluran cadangan,",
      "sehingga memastikan semua data pengukuran dapat disimpan dengan aman dan lengkap.",
    ];
    const fullTarget = invertedLines3.join(" ");

    const analysis = analyzeBilingualAlignment(invertedLines3, rows3, fullTarget, idRule);
    expect(analysis.hardReason).toBeNull();
    expect(analysis.softReason).not.toBeNull();

    let callCount = 0;
    const semanticRefereeGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson(input: { userPrompt: string }) {
        callCount += 1;
        if (callCount === 1) {
          const idMatch = /任务ID:\s*(\S+)/.exec(input.userPrompt);
          return {
            results: [{ id: idMatch?.[1] ?? "blk_inv", lines: invertedLines3 }],
          };
        }
        // Call 2: Semantic referee confirms the 3 rows match the exact meaning despite clause inversion
        return {
          verdict: "accurate",
          hasInversion: true,
          reason: "第1~2行因从句语序倒装导致字数占比不同，但三语语义逐行对应准确且无漏句",
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
        "卷一・倒装篇",
        "需要摘",
      ]),
    ];
    const doc = parseGridToScriptDocument(grid, "InversionTest");
    const catalog: LanguageCatalog = {
      langName: "印尼语",
      rule: idRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "倒装篇",
          enTitle: "Inversion Essay",
          targetTitle: "Esai Inversi",
          docUrl: "mock://inv",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://inv",
          [
            {
              chinese: rows3.map((r) => r.chinese).join(""),
              english: rows3.map((r) => r.english).join(" "),
              target: fullTarget,
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

    const out = await runLanguageExtractionPipeline(doc, catalog, {
      enableRosterPreFill: false,
      gemini: semanticRefereeGemini,
    });

    expect(callCount).toBe(2);
    expect(out.missingCount).toBe(0);
    expect(out.matchedCount).toBe(3);
    expect(out.rows[0].status).toBe("matched");
    expect(out.rows[0].hint).toBe("含语序倒装，已通过 AI 语义核对");
    expect(out.rows[0].targetLanguage).toContain("Pada tahap awal");
    expect(out.rows[2].targetLanguage).toContain("aman dan lengkap.");
  });

  it("4. never waives genuine hard structural errors (dropped tail / question mark mismatch) even if AI claims verdict: 'accurate', but accepts valid verdict: 'fixed'", async () => {
    const idRule = resolvePunctuationRule("印尼语");
    const fullTarget =
      "Apakah semua anggota sudah memeriksa jadwal pagi ini? " +
      "Kita harus menyiapkan laporan lengkap sebelum rapat dimulai, " +
      "dan menyerahkan hasilnya kepada koordinator tepat waktu.";

    const rows3: ScriptRow[] = [
      makeRow(0, "“所有成员都已经检查今天早上的日程了吗？", '"Have all members checked the schedule this morning?'),
      makeRow(1, "我们必须在会议开始前准备好完整报告，", "We must prepare the full report before the meeting starts,"),
      makeRow(2, "并按时把结果交给协调员。”", 'and submit the results to the coordinator on time."'),
    ];

    // Hard structural error: Row 1 loses its question mark (split too early) and the final clause is dropped!
    const hardBrokenDraft = [
      "Apakah semua anggota",
      "sudah memeriksa jadwal pagi ini?",
      "Kita harus menyiapkan laporan lengkap sebelum rapat dimulai,",
    ];

    const analysis = analyzeBilingualAlignment(hardBrokenDraft, rows3, fullTarget, idRule);
    expect(analysis.hardReason).not.toBeNull();

    // 4A: AI falsely claims verdict: "accurate" on a hard structural error -> MUST be rejected and left blank!
    const dishonestGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        return {
          results: [{ id: "hard_err", lines: hardBrokenDraft }],
          verdict: "accurate",
          hasInversion: true,
          reason: "Falsely claiming accurate",
        };
      },
    } as never;

    const mapRejected = await batchSplitTargetsWithAi(
      [
        {
          id: "hard_err",
          fallbackText: fullTarget,
          aiSourceText: fullTarget,
          sourceRows: rows3,
          isPartial: false,
        },
      ],
      idRule,
      dishonestGemini,
    );
    const rejected = mapRejected.get("hard_err")!;
    expect(rejected.usedAi).toBe(false);
    expect(rejected.failed).toBe(true);
    expect(rejected.lines).toEqual([]);

    // 4B: AI returns verdict: "fixed" with properly aligned lines -> passes recheck and succeeds!
    const correctFixedLines = [
      "Apakah semua anggota sudah memeriksa jadwal pagi ini?",
      "Kita harus menyiapkan laporan lengkap sebelum rapat dimulai,",
      "dan menyerahkan hasilnya kepada koordinator tepat waktu.",
    ];
    let step = 0;
    const fixingGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        step += 1;
        if (step === 1) {
          return { results: [{ id: "hard_fix", lines: hardBrokenDraft }] };
        }
        return {
          verdict: "fixed",
          reason: "已修复问号行与末尾漏句",
          fixedLines: correctFixedLines,
        };
      },
    } as never;

    const mapFixed = await batchSplitTargetsWithAi(
      [
        {
          id: "hard_fix",
          fallbackText: fullTarget,
          aiSourceText: fullTarget,
          sourceRows: rows3,
          isPartial: false,
        },
      ],
      idRule,
      fixingGemini,
    );
    const fixed = mapFixed.get("hard_fix")!;
    expect(fixed.usedAi).toBe(true);
    expect(fixed.failed).toBe(false);
    expect(fixed.lines).toEqual(correctFixedLines);
  });

  it("5. produces accurate non-misleading hints when key pool is healthy vs. when keys/quota fail", () => {
    // Healthy key pool, alignment failed after multi-round retries -> must NOT blame the key pool!
    const alignFailHint = formatAiFailureHint(
      {
        lines: [],
        usedAi: false,
        failed: true,
        errorReason: "双语核对未通过：第 2 行问号数量不一致（源文 1 个 vs 目标语 0 个）",
      },
      true,
    );
    expect(alignFailHint).toContain("经多轮换 Key 重试仍未通过双语核对");
    expect(alignFailHint).toContain("请人工核对");
    expect(alignFailHint).not.toContain("请检查密钥池");

    // Genuine HTTP / network failure -> instructs checking the key pool
    const httpFailHint = formatAiFailureHint(
      {
        lines: [],
        usedAi: false,
        failed: true,
        errorReason: "Gemini HTTP 403: API key not valid",
      },
      true,
    );
    expect(httpFailHint).toContain("请检查密钥池或补充额度后重跑");

    // Genuine daily quota exhaustion -> instructs adding new key or waiting for daily reset
    const quotaFailHint = formatAiFailureHint(
      {
        lines: [],
        usedAi: false,
        failed: true,
        errorReason: "所有可用 API Key 今日调用均已达 500 次上限",
      },
      true,
    );
    expect(quotaFailHint).toContain("AI 密钥今日额度已用尽");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { GeminiPoolClient } from "../src/ai/gemini-client";
import {
  DAILY_KEY_QUOTA_LIMIT,
  getKeyUsageView,
  getTotalTodayCallsSummary,
  isKeyOverDailyLimit,
  keyFingerprint,
  recordKeyCallSuccess,
  resetTodayKeyUsage,
} from "../src/ai/key-usage-store";
import type { LanguageCatalog } from "../src/catalog/catalog-types";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import {
  batchSplitTargetsWithAi,
  detectBilingualMisalignment,
} from "../src/engine/line-splitter";
import { runLanguageExtractionPipeline } from "../src/engine/pipeline";
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

describe("v0.3.2 strict bilingual alignment (宁缺毋滥) & key pool diagnostics", () => {
  beforeEach(() => {
    resetTodayKeyUsage();
  });

  it("Scenario 1: detects 7-row cascading misalignment + dropped tail sentences, passes FULL source text to AI review, and leaves blank if review still fails", async () => {
    const idRule = resolvePunctuationRule("印尼语");

    const fullIndonesianParagraph =
      "Pertama, setiap anggota tim harus memahami rencana kerja mingguan dengan jelas. " +
      "Kedua, ketika jadwal berubah secara mendadak di lapangan, kita harus segera menyesuaikan langkah kerja dan memberi tahu rekan lainnya. " +
      "Ketiga, kita perlu mencatat semua masukan teknis dengan rapi. " +
      "Keempat, jangan menunda pemeriksaan kualitas hingga hari terakhir, " +
      "bagaimana mungkin proyek besar dapat selesai tepat waktu tanpa pemeriksaan rutin? " +
      "Kelima, setiap bagian wajib menyerahkan laporan ringkas sebelum rapat ditutup, " +
      "apakah semua anggota sudah menyetujui jadwal baru ini? Mari kita mulai bekerja sesuai rencana.";

    const rows7: ScriptRow[] = [
      makeRow(0, "“第一，每位团队成员都必须清楚了解每周工作计划。", '"First, every team member must clearly understand the weekly work plan.'),
      makeRow(
        1,
        "第二，当现场日程突然发生变化时，我们必须立即调整工作步骤并通知其他同事。",
        "Second, when the schedule changes suddenly in the field, we must immediately adjust our work steps and inform other colleagues.",
      ),
      makeRow(2, "第三，我们需要把所有技术反馈都整齐记录下来。", "Third, we need to record all technical feedback neatly."),
      makeRow(3, "第四，不要把质量检查推迟到最后一天，", "Fourth, do not delay quality inspection until the last day,"),
      makeRow(
        4,
        "没有日常检查，大型项目怎么可能按时完成呢？",
        "how could a large project be completed on time without routine inspection?",
      ),
      makeRow(
        5,
        "第五，各部门必须在会议结束前提交简明报告，",
        "Fifth, every department must submit a concise report before the meeting closes,",
      ),
      makeRow(
        6,
        "所有成员都已经同意这份新日程了吗？让我们按计划开始工作吧。”",
        'have all members agreed to this new schedule? Let us start working according to the plan."',
      ),
    ];

    // Bad draft from Pass 1: Row 2 truncated early at comma ("di lapangan,"), shifting Rows 3..7 and dropping the last 2 sentences!
    const badCascadingDraft = [
      "Pertama, setiap anggota tim harus memahami rencana kerja mingguan dengan jelas.",
      "Kedua, ketika jadwal berubah secara mendadak di lapangan,",
      "kita harus segera menyesuaikan langkah kerja dan memberi tahu rekan lainnya.",
      "Ketiga, kita perlu mencatat semua masukan teknis dengan rapi.",
      "Keempat, jangan menunda pemeriksaan kualitas hingga hari terakhir,",
      "bagaimana mungkin proyek besar dapat selesai tepat waktu tanpa pemeriksaan rutin?",
      "Kelima, setiap bagian wajib menyerahkan laporan ringkas sebelum rapat ditutup,",
    ];

    const correctLines7 = [
      "Pertama, setiap anggota tim harus memahami rencana kerja mingguan dengan jelas.",
      "Kedua, ketika jadwal berubah secara mendadak di lapangan, kita harus segera menyesuaikan langkah kerja dan memberi tahu rekan lainnya.",
      "Ketiga, kita perlu mencatat semua masukan teknis dengan rapi.",
      "Keempat, jangan menunda pemeriksaan kualitas hingga hari terakhir,",
      "bagaimana mungkin proyek besar dapat selesai tepat waktu tanpa pemeriksaan rutin?",
      "Kelima, setiap bagian wajib menyerahkan laporan ringkas sebelum rapat ditutup,",
      "apakah semua anggota sudah menyetujui jadwal baru ini? Mari kita mulai bekerja sesuai rencana.",
    ];

    const reason = detectBilingualMisalignment(
      badCascadingDraft,
      rows7,
      fullIndonesianParagraph,
      idRule,
    );
    expect(reason).not.toBeNull();

    // Case 1A: Self-review receives the COMPLETE fullIndonesianParagraph (including the dropped tail) and recovers alignment
    const promptsReceived: string[] = [];
    let callIdx = 0;
    const recoveringGemini = {
      hasKeys: true,
      async generateStructuredJson(input: { userPrompt: string }) {
        callIdx += 1;
        promptsReceived.push(input.userPrompt);
        if (callIdx === 1) {
          return {
            results: [{ id: "blk_7", lines: badCascadingDraft }],
          };
        }
        return {
          lines: correctLines7,
        };
      },
    } as never;

    const recoveredMap = await batchSplitTargetsWithAi(
      [
        {
          id: "blk_7",
          fallbackText: fullIndonesianParagraph,
          aiSourceText: fullIndonesianParagraph,
          sourceRows: rows7,
          isPartial: false,
        },
      ],
      idRule,
      recoveringGemini,
    );

    expect(callIdx).toBe(2);
    // Verify reviewAndFixSplitWithAi received the missing tail sentences in the full source string!
    expect(promptsReceived[1]).toContain(
      "apakah semua anggota sudah menyetujui jadwal baru ini? Mari kita mulai bekerja sesuai rencana.",
    );
    const recovered = recoveredMap.get("blk_7")!;
    expect(recovered.usedAi).toBe(true);
    expect(recovered.failed).toBe(false);
    expect(recovered.lines).toEqual(correctLines7);

    // Case 1B: If AI review STILL returns misaligned lines, pipeline MUST leave all 7 rows blank ("") and status="missing" (never green matched!)
    const stillBadGemini = {
      hasKeys: true,
      async generateStructuredJson() {
        return {
          results: [{ id: "task_1_seg0", lines: badCascadingDraft }],
          lines: badCascadingDraft,
        };
      },
    } as never;

    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ...rows7.map((r) => [
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
    const doc = parseGridToScriptDocument(grid, "Cascading7RowTest");
    const idCatalog: LanguageCatalog = {
      langName: "印尼语",
      rule: idRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "第一篇",
          enTitle: "Essay 1",
          targetTitle: "Esai 1",
          docUrl: "mock://id_essay1",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://id_essay1",
          [
            {
              chinese: rows7.map((r) => r.chinese).join(""),
              english: rows7.map((r) => r.english).join(" "),
              target: fullIndonesianParagraph,
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

    const failedOut = await runLanguageExtractionPipeline(doc, idCatalog, {
      enableRosterPreFill: false,
      gemini: stillBadGemini,
    });

    expect(failedOut.matchedCount).toBe(0);
    expect(failedOut.missingCount).toBe(7);
    for (const r of failedOut.rows) {
      expect(r.targetLanguage).toBe("");
      expect(r.status).toBe("missing");
      expect(r.hint).toContain("AI 分句未通过严格双语核对");
      expect(r.hint).toContain("已留空");
    }
  });

  it("Scenario 2: detects final-row period/comma swap + dropped trailing half-sentence and refuses to mark green", async () => {
    const idRule = resolvePunctuationRule("印尼语");
    const fullTarget =
      "Kita harus menyelesaikan seluruh jadwal pelatihan hari ini dengan tertib. " +
      "Ini sudah cukup, dan hal ini akan memberikan hasil terbaik bagi seluruh tim.";

    const rows3: ScriptRow[] = [
      makeRow(0, "“我们今天必须按秩序完成全部培训日程。", '"We must finish the entire training schedule today in good order.'),
      makeRow(1, "这就足够了，", "This is enough,"),
      makeRow(2, "而且这会给整个团队带来最好的结果。”", 'and this will bring the best result for the whole team."'),
    ];

    // Shifted end: row 2 got a full sentence ending in period, row 3 got "Ini sudah cukup," (comma ending, dropping the last clause!)
    const badTailDraft = [
      "Kita harus menyelesaikan seluruh jadwal pelatihan",
      "hari ini dengan tertib.",
      "Ini sudah cukup,",
    ];

    const reason = detectBilingualMisalignment(badTailDraft, rows3, fullTarget, idRule);
    expect(reason).not.toBeNull();

    const alwaysMisalignedGemini = {
      hasKeys: true,
      async generateStructuredJson() {
        return {
          results: [{ id: "blk_tail", lines: badTailDraft }],
          lines: badTailDraft,
        };
      },
    } as never;

    const map = await batchSplitTargetsWithAi(
      [
        {
          id: "blk_tail",
          fallbackText: fullTarget,
          aiSourceText: fullTarget,
          sourceRows: rows3,
          isPartial: false,
        },
      ],
      idRule,
      alwaysMisalignedGemini,
    );
    const res = map.get("blk_tail")!;
    expect(res.usedAi).toBe(false);
    expect(res.failed).toBe(true);
    expect(res.lines).toEqual([]);
  });

  it("Scenario 3: leaves multi-row/partial blocks strictly blank on missing key, 500 quota exhaustion, or API error while extracting 1:1 non-AI items normally", async () => {
    const ukRule = resolvePunctuationRule("乌克兰语");
    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      // Row 0: 1:1 standalone title (no AI needed)
      ["1", "", "", "Host", "《晨光之歌》。", '"Song of Morning Light."', "No need to translate!", "Song of Morning Light\nXX", "", "提前贴上", "含诗歌标题", "需要摘"],
      // Row 1: 1:1 single-row complete paragraph (no AI needed)
      ["2", "", "", "Reader", "“今日的日程已经全部准备完毕。”", '"Today\'s schedule has been completely prepared."', "No need to translate!", "", "", "", "卷一・单行篇", "需要摘"],
      // Rows 2..3: 2-row multi-line paragraph (requires AI -> must stay blank when no key / quota full!)
      ["3", "", "", "Reader", "“春天的阳光洒满山岗，", '"Spring sunlight fills the hills,', "No need to translate!", "", "", "", "卷一・多行篇", "需要摘"],
      ["4", "", "", "Reader", "万物都在悄然生长。”", 'and all things quietly grow."', "No need to translate!", "", "", "", "卷一・多行篇", "需要摘"],
      // Row 4: 1:1 citation subtitle (no AI needed)
      ["5", "", "", "Subtitle", "《卷一・多行篇》", "from Vol. 1, Multi-Line Essay", "No need to translate!", "", "", "", "卷一・多行篇", "需要摘"],
      // Row 5: 1:1 idiom (no AI needed)
      ["6", "", "", "Caption", "千里之行，始于足下", "A journey of a thousand miles begins with a single step", "No need to translate!", "", "", "", "俗语", ""],
    ];

    const doc = parseGridToScriptDocument(grid, "NoAiFallbackTest");
    const buildCatalog = (): LanguageCatalog => ({
      langName: "乌克兰语",
      rule: ukRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "单行篇",
          enTitle: "Single-Line Essay",
          targetTitle: "Однорядковий нарис",
          docUrl: "mock://single",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
        {
          zhTitle: "多行篇",
          enTitle: "Multi-Line Essay",
          targetTitle: "Багаторядковий нарис",
          docUrl: "mock://multi",
          zhSubtitleCite: "《卷一・多行篇》",
          zhBracketCite: "",
          targetCite: "з «Том 1. Багаторядковий нарис»",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://single",
          [
            {
              chinese: "今日的日程已经全部准备完毕。",
              english: "Today's schedule has been completely prepared.",
              target: "Сьогоднішній розклад повністю підготовлено.",
            },
          ],
        ],
        [
          "mock://multi",
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
      rosterEntries: [],
    });

    // 3A: No AI key configured
    const outNoKey = await runLanguageExtractionPipeline(doc, buildCatalog(), {
      enableRosterPreFill: false,
    });
    expect(outNoKey.rows[0].status).toBe("matched");
    expect(outNoKey.rows[0].targetLanguage).toBe("«Пісня ранкового світла».");
    expect(outNoKey.rows[1].status).toBe("matched");
    expect(outNoKey.rows[1].targetLanguage).toBe("«Сьогоднішній розклад повністю підготовлено».");
    // Multi-row block rows 2 & 3 MUST be left blank and missing!
    expect(outNoKey.rows[2].targetLanguage).toBe("");
    expect(outNoKey.rows[2].status).toBe("missing");
    expect(outNoKey.rows[2].hint).toContain("未配置可用 AI 密钥（已留空，不强制估算）");
    expect(outNoKey.rows[3].targetLanguage).toBe("");
    expect(outNoKey.rows[3].status).toBe("missing");
    // Citation and idiom still matched!
    expect(outNoKey.rows[4].status).toBe("matched");
    expect(outNoKey.rows[4].targetLanguage).toBe("з «Том 1. Багаторядковий нарис»");
    expect(outNoKey.rows[5].status).toBe("matched");
    expect(outNoKey.rows[5].targetLanguage).toBe("Подорож у тисячу миль починається з одного кроку");

    // 3B: Key over 500 daily quota limit
    const exhaustedKey = "AIzaSyExhaustedQuotaKey00000001";
    for (let i = 0; i < DAILY_KEY_QUOTA_LIMIT; i += 1) {
      recordKeyCallSuccess(exhaustedKey, 10);
    }
    expect(isKeyOverDailyLimit(exhaustedKey)).toBe(true);

    const quotaClient = new GeminiPoolClient({
      apiKeys: [exhaustedKey],
      model: "gemini-3.5-flash-lite",
      rotation: "round_robin",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const outQuota = await runLanguageExtractionPipeline(doc, buildCatalog(), {
      enableRosterPreFill: false,
      gemini: quotaClient,
    });
    expect(outQuota.rows[2].targetLanguage).toBe("");
    expect(outQuota.rows[2].status).toBe("missing");
    expect(outQuota.rows[2].hint).toContain("AI 密钥今日额度已用尽（已留空，不强制估算）");
    expect(outQuota.rows[3].targetLanguage).toBe("");
    expect(outQuota.rows[3].status).toBe("missing");
  });

  it("Scenario 4: never wraps blanked sub-segments in empty quotes when another sub-segment in the same block succeeds", async () => {
    const ukRule = resolvePunctuationRule("乌克兰语");
    // A 3-row block split into 2 sub-segments by an omission ("……" / "有省略"):
    // Sub-segment 0 is 1 full paragraph row (succeeds without AI)
    // Sub-segment 1 is 2 rows (fails when no AI key is provided)
    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ["1", "", "", "Reader", "“今日的日程已经全部准备完毕。……", '"Today\'s schedule has been completely prepared. ...', "No need to translate!", "", "有省略", "", "卷一・混合篇", "需要摘"],
      ["2", "", "", "Reader", "春天的阳光洒满山岗，", "Spring sunlight fills the hills,", "No need to translate!", "", "", "", "卷一・混合篇", "需要摘"],
      ["3", "", "", "Reader", "万物都在悄然生长。”", 'and all things quietly grow."', "No need to translate!", "", "", "", "卷一・混合篇", "需要摘"],
    ];

    const doc = parseGridToScriptDocument(grid, "PartialBlankQuoteTest");
    const catalog: LanguageCatalog = {
      langName: "乌克兰语",
      rule: ukRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "混合篇",
          enTitle: "Mixed Essay",
          targetTitle: "Змішаний нарис",
          docUrl: "mock://mixed",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://mixed",
          [
            {
              chinese: "今日的日程已经全部准备完毕。",
              english: "Today's schedule has been completely prepared.",
              target: "Сьогоднішній розклад повністю підготовлено.",
            },
            {
              chinese: "春天的阳光洒满山岗，万物都在悄然生长。",
              english: "Spring sunlight fills the hills, and all things quietly grow.",
              target: "Весняне сонце заливає пагорби, і все тихо росте.",
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
    });

    // Sub-segment 0 (1 complete paragraph row) succeeded and got outer quotes
    expect(out.rows[0].targetLanguage).toBe("«Сьогоднішній розклад повністю підготовлено».");
    // Sub-segment 1 (rows 1 & 2) failed and MUST be strictly "" (never "«»" or "“”"!)
    expect(out.rows[1].targetLanguage).toBe("");
    expect(out.rows[1].status).toBe("missing");
    expect(out.rows[2].targetLanguage).toBe("");
    expect(out.rows[2].status).toBe("missing");
  });

  it("Scenario 5: tracks daily 500-call quota without storing plaintext keys, rotates past full keys, tests all keys individually, and retries transient 429s", async () => {
    resetTodayKeyUsage();
    const key1 = "AQ.Ab8RN6MockUnbilledVertexKey0001";
    const key2 = "AQ.Ab8RN6MockUnbilledVertexKey0002";
    const key3 = "AIzaSyMockWorkingStudioKey00000003";

    // 5A: testAllKeysIndividually tests every key (2 x 403 + 1 x 200 -> 3 reports, 1 ok, 2 failed)
    const testClient = new GeminiPoolClient({
      apiKeys: [key1, key2, key3],
      model: "gemini-3.5-flash-lite",
      rotation: "round_robin",
      fetchFn: async (input, init) => {
        const url = String(input);
        const apiKeyHeader = (init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"] ?? "";
        if (url.includes(encodeURIComponent(key1)) || url.includes(encodeURIComponent(key2)) || apiKeyHeader === key1 || apiKeyHeader === key2) {
          return new Response(
            JSON.stringify({
              error: {
                message: "This API method requires billing to be enabled.",
                status: "PERMISSION_DENIED",
              },
            }),
            { status: 403 },
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const progressSteps: number[] = [];
    const reports = await testClient.testAllKeysIndividually((_rep, done) => {
      progressSteps.push(done);
    });

    expect(reports).toHaveLength(3);
    expect(progressSteps).toEqual([1, 2, 3]);
    expect(reports[0].ok).toBe(false);
    expect(reports[0].status).toBe(403);
    expect(reports[1].ok).toBe(false);
    expect(reports[1].status).toBe(403);
    expect(reports[2].ok).toBe(true);
    expect(reports[2].status).toBe(200);

    expect(getKeyUsageView(key1).lastStatus).toBe("invalid");
    expect(getKeyUsageView(key1).lastError).toContain("未开启结算");
    expect(getKeyUsageView(key2).lastStatus).toBe("invalid");
    expect(getKeyUsageView(key3).lastStatus).toBe("ok");
    expect(getKeyUsageView(key3).callsToday).toBe(1);

    // Verify fingerprint is non-reversible and plaintext keys are never in fingerprint or summary
    expect(keyFingerprint(key3)).toMatch(/^k_[0-9a-f]{16}$/);
    expect(keyFingerprint(key3)).not.toContain("AIza");

    // 5B: Daily 500 limit auto-skip to next available key
    resetTodayKeyUsage();
    const fullKey = "AIzaSyDailyFullKey00000000000001";
    const freshKey = "AIzaSyDailyFreshKey0000000000002";
    for (let i = 0; i < DAILY_KEY_QUOTA_LIMIT; i += 1) {
      recordKeyCallSuccess(fullKey, 5);
    }
    expect(isKeyOverDailyLimit(fullKey)).toBe(true);
    expect(getKeyUsageView(fullKey).lastStatus).toBe("quota_full");
    expect(getKeyUsageView(fullKey).remaining).toBe(0);

    const usedHeaderKeys: string[] = [];
    const poolClient = new GeminiPoolClient({
      apiKeys: [fullKey, freshKey],
      model: "gemini-3.5-flash-lite",
      rotation: "failover",
      fetchFn: async (_input, init) => {
        const k = (init?.headers as Record<string, string>)["x-goog-api-key"];
        usedHeaderKeys.push(k);
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const res = await poolClient.generateStructuredJson<{ ok: boolean }>({
      systemInstruction: "test",
      userPrompt: "ping",
      jsonSchema: { type: "object" },
    });
    expect(res.ok).toBe(true);
    // Must skip fullKey and call freshKey directly!
    expect(usedHeaderKeys).toEqual([freshKey]);
    const summary = getTotalTodayCallsSummary(2, [fullKey, freshKey]);
    expect(summary.totalCallsToday).toBe(DAILY_KEY_QUOTA_LIMIT + 1);
    expect(summary.totalCapacity).toBe(DAILY_KEY_QUOTA_LIMIT * 2);

    // 5C: Multi-key transient 429 rate-limit retry succeeds on round 2
    resetTodayKeyUsage();
    const rateKey = "AIzaSyTransientRateLimitKey00001";
    let attempts = 0;
    const retryClient = new GeminiPoolClient({
      apiKeys: [rateKey],
      model: "gemini-3.5-flash-lite",
      rotation: "round_robin",
      retryDelayMs: 1,
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({ error: { message: "Resource exhausted (RPM limit)" } }),
            { status: 429 },
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"recovered":true}' }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const recoveredJson = await retryClient.generateStructuredJson<{ recovered: boolean }>({
      systemInstruction: "test",
      userPrompt: "ping",
      jsonSchema: { type: "object" },
    });
    expect(recoveredJson.recovered).toBe(true);
    expect(attempts).toBe(2);
    expect(getKeyUsageView(rateKey).lastStatus).toBe("ok");

    // 5D: resetTodayKeyUsage resets everything to 0
    resetTodayKeyUsage();
    expect(getKeyUsageView(rateKey).callsToday).toBe(0);
    expect(getKeyUsageView(fullKey).callsToday).toBe(0);
  });
});

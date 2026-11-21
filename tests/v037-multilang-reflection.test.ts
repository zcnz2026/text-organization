import { beforeEach, describe, expect, it } from "vitest";
import { resetTodayKeyUsage } from "../src/ai/key-usage-store";
import type { LanguageCatalog } from "../src/catalog/catalog-types";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";
import {
  analyzeBilingualAlignment,
  batchSplitTargetsWithAi,
  cleanLineEndingForPunctCheck,
  endsWithStrongSentencePunct,
  semanticAuditOrFixWithAi,
} from "../src/engine/line-splitter";
import { runLanguageExtractionPipeline } from "../src/engine/pipeline";
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
    line: opts?.line ?? String(560 + rowIndex),
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

function buildSpanish13RowShiftFixture() {
  const rows13: ScriptRow[] = [
    // Row 1 (idx 0): Sentence 1 (complete sentence anchor)
    makeRow(
      0,
      "“在年度工程规划中，每个技术部门都有明确的分工。",
      '"In annual engineering planning, every technical department has a clear division of labor.',
      { line: "560" },
    ),
    // Row 2 (idx 1): Sentence 2 (complete sentence anchor)
    makeRow(
      1,
      "我们不需要去承担超出本职范围的额外指标。",
      "We do not need to take on extra indicators beyond our own scope of duty.",
      { line: "561" },
    ),
    // Rows 3..5 (idx 2..4): Sentence 3 (3 clauses, ending at Row 5)
    makeRow(
      2,
      "当你发现某项测试流程存在微小的偏差时，",
      "When you discover that a certain testing process has a minor deviation,",
      { line: "562" },
    ),
    makeRow(
      3,
      "只要按照标准手册及时校准仪器并如实登记，",
      "as long as you calibrate the instruments in time according to the manual and record it truthfully,",
      { line: "563" },
    ),
    makeRow(
      4,
      "就能保证整个实验环节平稳运行。",
      "you can ensure that the entire experimental link operates smoothly.",
      { line: "564" },
    ),
    // Rows 6..7 (idx 5..6): Sentence 4 (2 short clauses: 18 chars + 31 chars)
    makeRow(
      5,
      "这样做就足够了，",
      "Doing this is enough,",
      { line: "565" },
    ),
    makeRow(
      6,
      "完全能够达到预期的技术目标。",
      "and it will fully meet the expected technical goal.",
      { line: "566" },
    ),
    // Row 8 (idx 7): Sentence 5 (142-char long sentence ending with period in EN, comma in ZH)
    makeRow(
      7,
      "在日常操作中千万不要盲目追求花哨的捷径，也不要试图跳过基础的安全检查步骤去抢进度，",
      "In daily operations you must never blindly pursue flashy shortcuts, nor should you ever try to skip basic safety inspection steps just to rush the schedule.",
      { line: "567" },
    ),
    // Row 9 (idx 8): Sentence 6 (128-char long sentence ending with period in both ZH and EN)
    makeRow(
      8,
      "因为任何一次看似省时的违规操作，最终都会给整个工程带来难以估量的返工代价。",
      "For any seemingly time-saving irregular operation will ultimately bring immeasurable rework costs to the entire engineering project.",
      { line: "568" },
    ),
    // Rows 10..13 (idx 9..12): Sentence 7 (4 clauses ending at Row 13)
    makeRow(
      9,
      "只要每一位工程师都能脚踏实地守住自己的岗位标准，",
      "As long as every engineer can steadily uphold their own post standards,",
      { line: "569" },
    ),
    makeRow(
      10,
      "认真核对每一组基础测量数据，",
      "carefully verify every single set of basic measurement data,",
      { line: "570" },
    ),
    makeRow(
      11,
      "及时与上下游团队保持透明顺畅的沟通，",
      "maintain transparent and smooth communication with upstream and downstream teams in time,",
      { line: "571" },
    ),
    makeRow(
      12,
      "我们的年度质量体系就能长期保持稳定可靠。”",
      'our annual quality system will remain stable and reliable for a long time."',
      { line: "572" },
    ),
  ];

  const correctSpanish13 = [
    "En la planificación anual de ingeniería, cada departamento técnico tiene una división clara del trabajo.",
    "No necesitamos asumir indicadores adicionales más allá de nuestro propio ámbito de responsabilidad.",
    "Cuando descubras que un determinado proceso de prueba presenta una pequeña desviación,",
    "siempre que calibres los instrumentos a tiempo según el manual estándar y lo registres con veracidad,",
    "podrás garantizar que todo el enlace experimental funcione sin contratiempos.",
    "Esto es suficiente",
    "y cumplirá plenamente el objetivo técnico esperado.",
    "En las operaciones diarias nunca debes buscar ciegamente atajos llamativos, ni intentar saltarte los pasos básicos de inspección de seguridad solo para acelerar el cronograma.",
    "Porque cualquier operación irregular que parezca ahorrar tiempo acabará trayendo costos de retrabajo incalculables para todo el proyecto de ingeniería.",
    "Siempre que cada ingeniero pueda mantener con firmeza los estándares de su propio puesto,",
    "verificar cuidadosamente cada conjunto de datos básicos de medición,",
    "mantener a tiempo una comunicación transparente y fluida con los equipos,",
    "nuestro sistema anual de calidad se mantendrá estable y confiable durante mucho tiempo.",
  ];

  // Shifted 13 lines (100% verbatim coverage of the exact same text!):
  // Sentence 3 is over-split into 5 rows (rows 3..7), pushing "Esto es suficiente" (18 chars) and
  // "y cumplirá plenamente el objetivo técnico esperado." (51 chars, ending with period!) into the
  // 156-char Row 8 and 132-char Row 9 slots, and compressing the last 4 clauses into Rows 12..13!
  const shiftedSpanish13 = [
    "En la planificación anual de ingeniería, cada departamento técnico tiene una división clara del trabajo.",
    "No necesitamos asumir indicadores adicionales más allá de nuestro propio ámbito de responsabilidad.",
    "Cuando descubras que un determinado proceso de prueba",
    "presenta una pequeña desviación,",
    "siempre que calibres los instrumentos a tiempo",
    "según el manual estándar y lo registres con veracidad,",
    "podrás garantizar que todo el enlace experimental funcione sin contratiempos.",
    "Esto es suficiente",
    "y cumplirá plenamente el objetivo técnico esperado.",
    "En las operaciones diarias nunca debes buscar ciegamente atajos llamativos, ni intentar saltarte los pasos básicos de inspección de seguridad solo para acelerar el cronograma.",
    "Porque cualquier operación irregular que parezca ahorrar tiempo acabará trayendo costos de retrabajo incalculables para todo el proyecto de ingeniería.",
    "Siempre que cada ingeniero pueda mantener con firmeza los estándares de su propio puesto, verificar cuidadosamente cada conjunto de datos básicos de medición,",
    "mantener a tiempo una comunicación transparente y fluida con los equipos, nuestro sistema anual de calidad se mantendrá estable y confiable durante mucho tiempo.",
  ];

  return {
    rows13,
    correctSpanish13,
    shiftedSpanish13,
    fullSpanishText: correctSpanish13.join(" "),
  };
}

describe("v0.3.7 24-language cumulative sentence-anchor guard, consecutive collapse check & row-by-row CoT reflection", () => {
  beforeEach(() => {
    resetTodayKeyUsage();
  });

  it("1. catches Spanish 13-row middle over-split + tail compression (100% coverage) as hardReason, blocks lazy accurate verdict, and rescues or leaves blank", async () => {
    const esRule = resolvePunctuationRule("西语");
    const { rows13, correctSpanish13, shiftedSpanish13, fullSpanishText } =
      buildSpanish13RowShiftFixture();

    // 1A: Correct 13-row alignment passes with hardReason === null and softReason === null
    const cleanCheck = analyzeBilingualAlignment(
      correctSpanish13,
      rows13,
      fullSpanishText,
      esRule,
    );
    expect(cleanCheck.hardReason).toBeNull();
    expect(cleanCheck.softReason).toBeNull();

    // 1B: Shifted 13-row alignment (despite 100% head-to-tail text coverage and Row 9 ending with period)
    // MUST be caught as an unwaivable hardReason!
    const shiftedCheck = analyzeBilingualAlignment(
      shiftedSpanish13,
      rows13,
      fullSpanishText,
      esRule,
    );
    expect(shiftedCheck.hardReason).not.toBeNull();
    expect(shiftedCheck.hardReason).toMatch(/累积进度错位|连续出现同向长度失衡/);

    // 1C: Even if a lazy model returns verdict: "accurate" on every retry, pipeline MUST reject it and leave all 13 rows blank ("") + status="missing"
    const lazyBadGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        return {
          results: [{ id: "task_0", lines: shiftedSpanish13 }],
          lines: shiftedSpanish13,
          verdict: "accurate",
          hasInversion: true,
          reason: "Lazily claiming inversion",
        };
      },
    } as never;

    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ...rows13.map((r) => [
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
    const doc = parseGridToScriptDocument(grid, "Spanish13RowShiftTest");
    const buildEsCatalog = (): LanguageCatalog => ({
      langName: "西语",
      rule: esRule,
      godSaysText: "",
      commonFixedTerms: new Map(),
      citations: [],
      articles: [
        {
          zhTitle: "第一篇",
          enTitle: "Essay 1",
          targetTitle: "Ensayo 1",
          docUrl: "mock://es_13",
          zhSubtitleCite: "",
          zhBracketCite: "",
          targetCite: "",
        },
      ],
      articleDocsCache: new Map([
        [
          "mock://es_13",
          [
            {
              chinese: rows13.map((r) => r.chinese).join(""),
              english: rows13.map((r) => r.english).join(" "),
              target: fullSpanishText,
            },
          ],
        ],
      ]),
      bibleEntries: [],
      idioms: [],
      hymns: [],
      lordsPrayer: [],
      rosterEntries: [],
    });

    const failedOut = await runLanguageExtractionPipeline(doc, buildEsCatalog(), {
      enableRosterPreFill: false,
      gemini: lazyBadGemini,
    });

    expect(failedOut.matchedCount).toBe(0);
    expect(failedOut.missingCount).toBe(13);
    for (const r of failedOut.rows) {
      expect(r.targetLanguage).toBe("");
      expect(r.status).toBe("missing");
    }

    // 1D: When CoT reflection or divide-and-conquer sentence-checkpoint rescue returns the fixed 13 lines, all 13 rows pass!
    let rescueStep = 0;
    const rescuingGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson(input: { userPrompt: string }) {
        rescueStep += 1;
        if (rescueStep === 1) {
          const idMatch = /任务ID:\s*(\S+)/.exec(input.userPrompt);
          return {
            results: [{ id: idMatch?.[1] ?? "task_0", lines: shiftedSpanish13 }],
          };
        }
        return {
          rowAudits: rows13.map((_, idx) => ({
            row: idx + 1,
            semanticMatch: idx >= 2 ? "wrong_sentence" : "exact",
          })),
          verdict: "fixed",
          reason: "第3~13行发生跨句顺延错位，已按完整句硬锚点重新1:1对齐",
          fixedLines: correctSpanish13,
        };
      },
    } as never;

    const rescuedOut = await runLanguageExtractionPipeline(doc, buildEsCatalog(), {
      enableRosterPreFill: false,
      gemini: rescuingGemini,
    });

    expect(rescuedOut.missingCount).toBe(0);
    expect(rescuedOut.matchedCount).toBe(13);
    expect(rescuedOut.rows[5].targetLanguage).toBe("Esto es suficiente");
    expect(rescuedOut.rows[6].targetLanguage).toBe(
      "y cumplirá plenamente el objetivo técnico esperado.",
    );
    expect(rescuedOut.rows[7].targetLanguage).toContain("atajos llamativos");
    expect(rescuedOut.rows[12].targetLanguage).toContain("estable y confiable");
  });

  it("2. distinguishes true intra-sentence adjacent 2-row clause inversion (merged 2-row ratio ~1.0, anchor drift < 0.05) from wrong_sentence CoT audits", async () => {
    const idRule = resolvePunctuationRule("印尼语");

    // 4-row block with 2 complete sentences:
    // Sentence 1 (Rows 1..2): Row 1 EN is short (19 chars), Row 2 EN is long (134 chars);
    // Indonesian inverts the subordinate clause within Sentence 1 (96 chars + 60 chars),
    // so Row 1 single-row ratio is ~4.5x, but Rows 1+2 merged ratio is ~1.01x and cumulative drift at Row 2 (sentence end) is < 0.03!
    // Sentence 2 (Rows 3..4): balanced lengths.
    const rows4: ScriptRow[] = [
      makeRow(0, "“在最初的阶段，", '"In the early stage,'),
      makeRow(
        1,
        "每当现场技术团队在复杂环境中遇到突发信号干扰时，整个系统都会自动启动备用通道。",
        "whenever the field engineering team encounters sudden signal interference in a complex environment, the system activates backup channels.",
      ),
      makeRow(
        2,
        "这样不仅能够有效避免通信中断，",
        "This not only effectively prevents communication interruptions,",
      ),
      makeRow(
        3,
        "还能确保所有测量数据都安全完整地保存下来。”",
        'but also ensures that all measurement data can be saved safely and completely."',
      ),
    ];

    const invertedLines4 = [
      "Pada tahap awal ketika tim teknis lapangan menghadapi gangguan sinyal mendadak di lingkungan rumit,",
      "seluruh sistem secara otomatis mengaktifkan saluran cadangan.",
      "Hal ini tidak hanya secara efektif mencegah gangguan komunikasi,",
      "tetapi juga memastikan semua data pengukuran dapat disimpan dengan aman dan lengkap.",
    ];
    const fullIdText = invertedLines4.join(" ");

    // Must NOT trigger Hard Check 5A or 5B (hardReason === null), only softReason!
    const analysis = analyzeBilingualAlignment(invertedLines4, rows4, fullIdText, idRule);
    expect(analysis.hardReason).toBeNull();
    expect(analysis.softReason).not.toBeNull();

    // 2A: If CoT rowAudits contains any "wrong_sentence", semanticAuditOrFixWithAi MUST reject verdict: "accurate"!
    const contradictedGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        return {
          rowAudits: [
            { row: 1, semanticMatch: "wrong_sentence" },
            { row: 2, semanticMatch: "wrong_sentence" },
            { row: 3, semanticMatch: "exact" },
            { row: 4, semanticMatch: "exact" },
          ],
          verdict: "accurate",
          reason: "Contradictory accurate verdict despite wrong_sentence in rowAudits",
        };
      },
    } as never;

    const rejectedAudit = await semanticAuditOrFixWithAi(
      invertedLines4,
      fullIdText,
      rows4,
      idRule,
      contradictedGemini,
      analysis.softReason!,
    );
    expect(rejectedAudit.verdict).toBe("unfixable");

    // 2B: When CoT rowAudits confirms "adjacent_clause_inversion" + "exact" (zero "wrong_sentence"), approves cleanly!
    let calls = 0;
    const validCoTGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        calls += 1;
        if (calls === 1) {
          return { results: [{ id: "inv_4", lines: invertedLines4 }] };
        }
        return {
          rowAudits: [
            { row: 1, semanticMatch: "adjacent_clause_inversion" },
            { row: 2, semanticMatch: "adjacent_clause_inversion" },
            { row: 3, semanticMatch: "exact" },
            { row: 4, semanticMatch: "exact" },
          ],
          verdict: "accurate",
          hasInversion: true,
          reason: "第1~2行属于同一完整句内部的从句语序倒装，双行合并语义与中英文完全一致",
        };
      },
    } as never;

    const map = await batchSplitTargetsWithAi(
      [
        {
          id: "inv_4",
          fallbackText: fullIdText,
          aiSourceText: fullIdText,
          sourceRows: rows4,
          isPartial: false,
        },
      ],
      idRule,
      validCoTGemini,
    );
    const res = map.get("inv_4")!;
    expect(res.usedAi).toBe(true);
    expect(res.failed).toBe(false);
    expect(res.hasInversion).toBe(true);
    expect(res.lines).toEqual(invertedLines4);
  });

  it("3. recognizes strong sentence-end punctuation across all 24 languages (period outside/inside quotes, Greek ;/;, Arabic ؟, Hindi/Nepali ।, Burmese ။)", () => {
    const strongSamples = [
      // Period outside closing guillemets / quotes (Russian, Ukrainian, French, Spanish, Polish)
      "«Це дуже важливий технічний висновок».",
      "« C'est une étape essentielle du projet ».",
      '"Este resultado cumple con el estándar".',
      "„To jest ostateczna decyzja zespołu”.",
      // Period inside German / Croatian / Slovak / Hungarian closing quotes („...“ / ‚...‘ / »...«)
      "„Dies ist ein vollständiger Satz.“",
      "„Ovo je važan zaključak projekta.“",
      "A terv sikeresen lezárult: »Minden készen áll?«",
      // Greek question mark (; and ;) inside and outside quotes
      "Πώς μπορούμε να βελτιώσουμε την ποιότητα;",
      "«Πώς μπορούμε να βελτιώσουμε την ποιότητα;»",
      // Arabic question mark (؟) inside and outside quotes
      "كيف يمكننا تحسين جودة المشروع؟",
      '"كيف يمكننا تحسين جودة المشروع؟"',
      // Armenian question mark (՞) and full stop
      "Ինչպե՞ս կարող ենք բարելավել որակը՞",
      // Hindi / Nepali danda (।) and Burmese (။) inside/outside quotes
      '"यह परियोजना समय पर पूरी हो गई है।"',
      "“यो आयोजना समयमै सम्पन्न भयो।”",
      "“စီမံကိန်းကို အချိန်မီ ပြီးစီးခဲ့ပါသည်။”",
      // CJK brackets
      "「すべての準備が完了しました。」",
      "『모든 준비가 완료되었습니다.』",
    ];

    for (const sample of strongSamples) {
      expect(endsWithStrongSentencePunct(sample)).toBe(true);
    }

    const nonStrongSamples = [
      "«Це лише перша частина речення,",
      '"Cuando terminemos la primera fase,',
      "„Wenn wir den ersten Schritt abschließen,",
      "Oleh karena itu, mereka selalu menjaga jadwal. ...",
      "这是带省略号的半句……",
    ];

    for (const sample of nonStrongSamples) {
      expect(endsWithStrongSentencePunct(sample)).toBe(false);
    }

    expect(cleanLineEndingForPunctCheck("«Це важливий висновок».")).toBe(
      "Це важливий висновок.",
    );
    expect(cleanLineEndingForPunctCheck("„Dies ist ein Satz.“")).toBe(
      "Dies ist ein Satz.",
    );
  });
});

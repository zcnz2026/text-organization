import { beforeEach, describe, expect, it } from "vitest";
import { resetTodayKeyUsage } from "../src/ai/key-usage-store";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import {
  analyzeBilingualAlignment,
  auditAndRepairBilingualAlignment,
  batchSplitTargetsWithAi,
  projectLinesByBoundaryAnchors,
  projectLinesOntoVerbatimSource,
  splitByTokenSpansWithAi,
} from "../src/engine/line-splitter";
import { diagLog, sanitizeLogText } from "../src/platform/diag-log";
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

describe("v0.3.4 partial omission anti-swallowed-questions, >65% boundary anchors & live diagLog details", () => {
  beforeEach(() => {
    resetTodayKeyUsage();
    diagLog.clear();
  });

  it("1. prevents and self-heals 26-row partial omission block from swallowing 2 trailing omitted questions into row 26", async () => {
    const idRule = resolvePunctuationRule("印尼语");

    const rows26: ScriptRow[] = [];
    const clean26TargetLines: string[] = [];

    for (let i = 0; i < 25; i += 1) {
      const n = i + 1;
      const p = i % 2 === 1 ? "." : ",";
      rows26.push(
        makeRow(
          i,
          `${i === 0 ? "“" : ""}第${n}项日常工程核查记录已经按照季度规范整理完毕${p === "." ? "。" : "，"}`,
          `${i === 0 ? '"' : ""}Routine engineering inspection record ${n} has been organized according to quarterly standards${p}`,
        ),
      );
      clean26TargetLines.push(
        `Catatan pemeriksaan teknis rutin ke-${n} telah disusun rapi sesuai standar kuartalan${p}`,
      );
    }

    // Row 26 (index 25): ends with a period + ellipsis `…` (0 question marks in source!)
    rows26.push(
      makeRow(
        25,
        "因此，他们总是想在汇报时维持表面的完整。……",
        "For this reason, they always want to keep up a formal appearance during reports. …",
        { line: "475", remark: "有省略" },
      ),
    );
    const row26CleanSentence =
      "Oleh karena itu, mereka selalu ingin menjaga penampilan formal saat menyampaikan laporan.";
    clean26TargetLines.push(row26CleanSentence);

    // In the full manuscript paragraph, row 26 is immediately followed by 2 omitted questions + 3 more sentences
    const omittedQuestionsInManuscript =
      "Bagaimana mungkin masalah teknis dapat diselesaikan dengan cara seperti itu? " +
      "Bukankah hal itu hanya akan membuang waktu seluruh tim?";
    const postOmissionTail =
      "Kita harus berani mencatat setiap kekurangan secara jujur, " +
      "memperbaiki langkah kerja yang keliru, " +
      "dan memastikan hasil akhir benar-benar dapat dipertanggungjawabkan.";

    const fullManuscriptParagraph = [
      ...clean26TargetLines,
      omittedQuestionsInManuscript,
      postOmissionTail,
    ].join(" ");

    // 1A: Verify splitByTokenSpansWithAi prompt for partial/omission block NEVER says "完整覆盖整段台词不漏尾句"
    let capturedSysPrompt = "";
    let capturedUserPrompt = "";
    const spySpanGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson(input: { systemInstruction: string; userPrompt: string }) {
        capturedSysPrompt = input.systemInstruction;
        capturedUserPrompt = input.userPrompt;
        return { spans: [] };
      },
    } as never;

    await splitByTokenSpansWithAi(fullManuscriptParagraph, rows26, idRule, spySpanGemini, {
      isPartial: true,
    });

    expect(capturedSysPrompt).not.toContain("完整覆盖整段台词不漏尾句");
    expect(capturedSysPrompt).toContain("到第 26 行语义结束处立刻停止");
    expect(capturedUserPrompt).not.toContain("最后序号");
    expect(capturedUserPrompt).toContain("此行末尾有省略号");

    // 1B: Even if AI accidentally swallows the 2 omitted questions into Row 26, auditAndRepairBilingualAlignment + batchSplitTargetsWithAi self-heals it!
    const aiLinesSwallowingOmittedQuestions = [...clean26TargetLines];
    aiLinesSwallowingOmittedQuestions[25] = `${row26CleanSentence} ${omittedQuestionsInManuscript}`;

    const repairedDirect = auditAndRepairBilingualAlignment(
      aiLinesSwallowingOmittedQuestions,
      rows26,
      idRule,
    );
    expect(repairedDirect[25]).toBe(`${row26CleanSentence} ${idRule.ellipsis}`);
    expect(repairedDirect[25]).not.toContain("?");

    const checkAfterRepair = analyzeBilingualAlignment(
      repairedDirect,
      rows26,
      fullManuscriptParagraph,
      idRule,
      { isPartial: true },
    );
    expect(checkAfterRepair.hardReason).toBeNull();

    const mockBatchGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        return {
          results: [{ id: "seg_26_omit", lines: aiLinesSwallowingOmittedQuestions }],
        };
      },
    } as never;

    const batchMap = await batchSplitTargetsWithAi(
      [
        {
          id: "seg_26_omit",
          fallbackText: fullManuscriptParagraph,
          aiSourceText: fullManuscriptParagraph,
          sourceRows: rows26,
          isPartial: true,
        },
      ],
      idRule,
      mockBatchGemini,
    );

    const res26 = batchMap.get("seg_26_omit")!;
    expect(res26.usedAi).toBe(true);
    expect(res26.failed).toBe(false);
    expect(res26.lines).toHaveLength(26);
    expect(res26.lines[25]).toBe(`${row26CleanSentence} ...`);
  });

  it("2. projectLinesByBoundaryAnchors with isPartial: true accurately locates a 3-row sub-segment starting >65% into a long paragraph even with typos", () => {
    const prefixPart =
      "Pada bagian pertama laporan ini kita telah membahas jadwal persiapan awal secara terperinci. " +
      "Selanjutnya setiap kelompok kerja diminta mengumpulkan data pengamatan lapangan selama tiga minggu berturut-turut. " +
      "Semua catatan tersebut kemudian diverifikasi oleh tim pengawas kualitas di kantor pusat agar tidak ada kekeliruan. " +
      "Apakah langkah pemeriksaan tambahan masih diperlukan sebelum tahap akhir dimulai? " +
      "Tentu saja kita perlu memeriksa kembali seluruh peralatan utama.";

    const tailLine1 = "Setelah seluruh pemeriksaan awal selesai dilakukan dengan cermat,";
    const tailLine2 = "kita harus segera menyusun jadwal pelaksanaan tahap berikutnya,";
    const tailLine3 = "dan memastikan setiap anggota memahami tugasnya masing-masing.";

    const fullParagraph = `${prefixPart} ${tailLine1} ${tailLine2} ${tailLine3}`;

    // Introduce 1-letter typos in tailLine1 ("pemeriksaan" -> "pemriksaan") and tailLine2 ("pelaksanaan" -> "pelaksnaan")
    // so exact indexOf fails AND curStart must use the partial prefix search >65% into fullParagraph!
    const aiLinesWithTypos = [
      tailLine1.replace("pemeriksaan", "pemriksaan"),
      tailLine2.replace("pelaksanaan", "pelaksnaan"),
      tailLine3,
    ];

    expect(projectLinesOntoVerbatimSource(fullParagraph, aiLinesWithTypos)).toBeNull();

    const projected = projectLinesByBoundaryAnchors(fullParagraph, aiLinesWithTypos, {
      isPartial: true,
    });
    expect(projected).not.toBeNull();
    expect(projected).toEqual([tailLine1, tailLine2, tailLine3]);
  });

  it("3. diagLog notifies subscribers in real time, redacts AQ. & AIza keys, and logs full side-by-side comparison details on alignment failure", async () => {
    const events: number[] = [];
    const unsubscribe = diagLog.subscribe(() => {
      events.push(diagLog.getEntries().length);
    });

    diagLog.info(
      "密钥测试",
      "Testing keys AQ.Ab8RN6MockVertexSecretKey1234567890 and AIzaSyMockStudioSecretKey1234567890",
    );
    expect(events).toEqual([1]);
    const firstEntry = diagLog.getEntries()[0];
    expect(firstEntry.message).not.toContain("AQ.Ab8RN6");
    expect(firstEntry.message).not.toContain("AIzaSyMock");
    expect(firstEntry.message).toContain("[REDACTED_API_KEY]");
    expect(
      sanitizeLogText("Key1=AQ.Ab8RN6MockVertexSecretKey1234567890 Key2=AIzaSyMockStudioSecretKey1234567890"),
    ).toBe("Key1=[REDACTED_API_KEY] Key2=[REDACTED_API_KEY]");

    // Trigger an unfixable alignment failure and verify detailed comparison report is logged
    const idRule = resolvePunctuationRule("印尼语");
    const fullTarget =
      "Apakah rencana kerja minggu depan sudah disetujui oleh semua anggota tim? " +
      "Mari kita siapkan dokumen pendukung sebelum rapat dimulai.";
    const rows2: ScriptRow[] = [
      makeRow(0, "“下周的工作计划已经得到所有团队成员同意了吗？", '"Has next week\'s work plan been approved by all team members?', { line: "501" }),
      makeRow(1, "让我们在会议开始前准备好支持文档。”", 'Let us prepare the supporting documents before the meeting starts."', { line: "502" }),
    ];
    // Broken split: question mark moved to line 2
    const brokenDraft = [
      "Apakah rencana kerja minggu depan",
      "sudah disetujui oleh semua anggota tim? Mari kita siapkan dokumen pendukung sebelum rapat dimulai.",
    ];

    const brokenGemini = {
      hasKeys: true,
      keyCount: 2,
      async generateStructuredJson() {
        return {
          results: [{ id: "fail_diag_blk", lines: brokenDraft }],
          verdict: "unfixable",
          reason: "第 1 行与第 2 行问句边界跨行错位",
        };
      },
    } as never;

    await batchSplitTargetsWithAi(
      [
        {
          id: "fail_diag_blk",
          fallbackText: fullTarget,
          aiSourceText: fullTarget,
          sourceRows: rows2,
          isPartial: false,
        },
      ],
      idRule,
      brokenGemini,
    );

    const warnEntry = diagLog
      .getEntries()
      .find((e) => e.level === "WARN" && e.module === "AI 分句双语核对未通过");
    expect(warnEntry).toBeDefined();
    expect(warnEntry!.detail).toContain("【核对失败原因】");
    expect(warnEntry!.detail).toContain("【AI 语义裁判结论】verdict=unfixable");
    expect(warnEntry!.detail).toContain("【定位到的定稿原文】");
    expect(warnEntry!.detail).toContain("👉 [出错行]");
    expect(warnEntry!.detail).toContain("Line 501");
    expect(warnEntry!.detail).toContain("AI外文: Apakah rencana kerja minggu depan");

    diagLog.clear();
    expect(diagLog.getEntries()).toHaveLength(0);
    unsubscribe();
  });
});

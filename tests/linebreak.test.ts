import { describe, expect, it } from "vitest";
import { GeminiPoolClient } from "../src/ai/gemini-client";
import {
  LineBreakPausedError,
  runSubtitleLineBreakPipeline,
} from "../src/linebreak/ai-breaker";
import {
  loadBatchMasterQueueFromGoogleUrl,
  writeStatusBackToBatchMasterSheet,
} from "../src/linebreak/batch-master";
import {
  loadSubtitleWorkbookFromGoogleUrl,
  writeLineBreakRunToGoogleSheet,
} from "../src/linebreak/google-sheet-io";
import { createSubtitleMeasurer } from "../src/linebreak/measurer";
import {
  detectLanguageSpecFromText,
  getActiveLineBreakSpecs,
  resolveLineBreakSpec,
} from "../src/linebreak/presets";
import {
  resetAllLineBreakCustomizations,
  saveGlobalLineBreakRules,
  upsertCustomLineBreakSpec,
} from "../src/linebreak/rule-registry";
import type { ImportedSubtitleSheet, ImportedSubtitleWorkbook } from "../src/linebreak/types";
import { parseXlsxToSubtitleWorkbook, unzipXlsxXmlEntries } from "../src/linebreak/xlsx-reader";
import { buildLineBreakResultXlsx } from "../src/linebreak/xlsx-writer";

function makeMockItalianWorkbook(): ImportedSubtitleWorkbook {
  const sheetName = "意语";
  const headerRows = [
    ["", "", "", "", "", "", "", "0", "L", "L", "", "", "", "", ""],
    [
      "Line",
      "In Time",
      "Out Time",
      "Character",
      "Chinese",
      "English",
      "Target Language",
      "15",
      "L",
      "L",
      "",
      "录制备注",
      "备注",
      "筛选列",
      "字幕备注",
    ],
  ];

  const v = "Host A (F)";
  const rawData: Array<{ cells: string[]; green?: boolean; boldG?: boolean }> = [
    { cells: ["1", "00:00:01:00", "00:00:03:00", v, "大家好！", "Hello everyone!", "Ciao a tutti gli amici!", "", "", "", "", "", "", "", ""] },
    { cells: ["2", "00:00:03:00", "00:00:05:00", v, "今天天气很好。", "The weather is nice.", "Oggi fa bel tempo.", "", "", "", "", "", "", "", ""] },
    { cells: ["3", "00:00:05:00", "00:00:09:00", v, "去年春天，我开始负责整理每周的项目进度表。", "Last spring I began organizing the weekly project schedule.", "Nella primavera scorsa ho iniziato a gestire il programma.", "", "", "", "", "", "", "", ""] },
    { cells: ["4", "00:00:09:00", "00:00:13:00", v, "每天清晨我们都会核对各项计划并做好详细记录。", "Every morning we review the plans and keep detailed notes.", "Ogni mattina controlliamo tutti i piani e scriviamo gli appunti dettagliati.", "", "", "", "", "", "", "", ""] },
    { cells: ["5", "00:00:13:00", "00:00:16:00", v, "随着时间推移，团队效率提升了许多。", "Over time, team efficiency improved a lot.", "Col tempo, il lavoro è migliorato molto.", "", "", "", "", "", "", "", ""] },
    { cells: ["6", "00:00:16:00", "00:00:21:00", v, "许多刚加入的新同事都喜欢在上午开会前一起交流最近学到的整理经验。", "Many new colleagues who just joined like discussing recent lessons before the morning meeting.", "Molti nuovi colleghi che sono appena arrivati in ufficio amano discutere insieme ogni mattina", "", "", "", "", "", "", "", ""] },
    { cells: ["7", "00:00:21:00", "00:00:24:00", v, "希望大家都能顺利完成本周任务。", "Hope everyone completes this week's work smoothly.", "e sperano di finire bene il lavoro settimanale.", "", "", "", "", "", "", "", ""] },
    { cells: ["8", "00:00:24:00", "00:00:28:00", v, "大家一起复盘了上个月的文档排版流程，总结了不少实用技巧。", "Everyone reviewed last month's layout process and summarized useful tips.", "Tutti i colleghi hanno rivisto il processo di impaginazione del mese scorso con molta attenzione", "", "", "", "", "", "", "", ""] },
    { cells: ["9", "00:00:28:00", "00:00:32:00", v, "这样可以帮大家少走弯路，节省很多时间。", "This helps everyone avoid detours and save a lot of time.", "e questo ha aiutato tutto il gruppo a risparmiare molto tempo durante il lavoro quotidiano.", "", "", "", "", "", "", "", ""] },
    { cells: ["10", "00:00:32:00", "00:00:36:00", v, "慢慢地，我们也养成了先核对再提交的好习惯。", "Gradually, we built a good habit of checking before submitting.", "A poco a poco, abbiamo preso la buona abitudine di controllare prima di inviare.", "", "", "", "", "", "", "", ""] },
    {
      cells: [
        "11",
        "00:00:36:00",
        "00:00:40:00",
        v,
        "“做事要脚踏实地，认真对待每一个细节。”",
        '"Work steadily and pay close attention to every single detail."',
        '"Lavorare con calma e prestare attenzione a ogni piccolo dettaglio"',
        "",
        "",
        "",
        "",
        "",
        "",
        "卷一　总论・第一篇",
        "",
      ],
      boldG: true,
    },
    {
      cells: [
        "12",
        "00:00:40:00",
        "00:00:43:00",
        "Subtitle",
        "《文集・卷一　总论・第一篇》",
        "from Collection, Vol. 1. Overview. Essay One",
        'Raccolta, Vol. 1: Guida pratica alla scrittura chiara, "Primo capitolo (1)"',
        "",
        "",
        "",
        "",
        "不用录制",
        "",
        "卷一　总论・第一篇",
        "",
      ],
      green: true,
      boldG: true,
    },
  ];

  const sheet: ImportedSubtitleSheet = {
    sheetName,
    frozenRowCount: 2,
    colWidths: [8.25, 10.63, 10.63, 12.88, 24.25, 24.25, 30.38, 5.75, 9, 9, 20.75, 20.75, 19.25, 17, 13],
    colHidden: [false, false, false, false, false, false, false, false, false, false, false, true, true, true, true],
    headerRows,
    headerFillRgb: [
      Array(15).fill(null),
      [null, null, null, null, null, null, null, null, null, null, null, "FFFF00", null, null, null],
    ],
    headerFontRgb: [Array(15).fill(null), Array(15).fill(null)],
    headerBold: [
      Array(15).fill(false),
      [true, true, true, true, true, true, true, false, false, false, true, true, true, true, true],
    ],
    detectedFormulaCols: [7, 8, 9],
    columnMap: {
      lineCol: 0,
      inTimeCol: 1,
      outTimeCol: 2,
      characterCol: 3,
      chineseCol: 4,
      englishCol: 5,
      targetCol: 6,
      citationCol: -1,
      noteCol: 12,
    },
    rows: rawData.map((r, idx) => ({
      rowIndex: idx,
      excelRowNumber: idx + 3,
      rawCells: r.cells,
      cellFillRgb: r.cells.map((_, cIdx) => (r.green && (cIdx < 7 || cIdx > 9) ? "00FF00" : null)),
      cellFontRgb: Array(15).fill(null),
      cellBold: r.cells.map((_, cIdx) => Boolean(r.boldG && cIdx >= 4 && cIdx <= 6)),
      isGreenHighlight: Boolean(r.green),
      isGrayHighlight: false,
    })),
  };

  return {
    fileName: "意语-测试表",
    sheetNames: [sheetName],
    activeSheetName: sheetName,
    sheets: { [sheetName]: sheet },
  };
}

describe("Subtitle Line-Break Engine, Exact Template & Google Sheet IO", () => {
  it("resolves all priority, standard, and ruler language specs accurately", () => {
    const itSpec = resolveLineBreakSpec("意语-测试表");
    expect(itSpec.code).toBe("it");
    expect(itSpec.mode).toBe("char");
    expect(itSpec.singleMax).toBe(46);
    expect(itSpec.doubleMax).toBe(84);

    const esSpec = resolveLineBreakSpec("美西语");
    expect(esSpec.code).toBe("es");
    expect(esSpec.tier).toBe(1);

    const frSpec = resolveLineBreakSpec("法语");
    expect(frSpec.code).toBe("fr");
    expect(frSpec.tier).toBe(1);

    const hiSpec = resolveLineBreakSpec("印地语");
    expect(hiSpec.code).toBe("hi");
    expect(hiSpec.mode).toBe("ruler");
    expect(hiSpec.fixedRulerPx).toBe(342);

    const arSpec = resolveLineBreakSpec("阿拉伯语");
    expect(arSpec.dir).toBe("rtl");
    expect(arSpec.fixedRulerPx).toBe(320);
  });

  it("preserves exact 15-col Google Sheet template (Row 1 & Row 2 H/I/J formulas, Col K, hidden M..P, bold text, green skip)", async () => {
    const wb = makeMockItalianWorkbook();
    const sheet = wb.sheets[wb.activeSheetName];
    const spec = resolveLineBreakSpec("it");

    const run = await runSubtitleLineBreakPipeline(sheet, spec, { useAi: false });

    expect(run.results[0].status).toBe("untouched");
    expect(run.results[1].status).toBe("untouched");
    expect(run.results[2].screens).toHaveLength(1);
    expect(run.results[2].screens[0].hasAt).toBe(true);
    expect(run.results[5].screens.length).toBe(2);
    expect(run.results[10].screens[0].hasAt).toBe(true);
    expect(run.results[11].status).toBe("skip_green");

    const xlsxBytes = buildLineBreakResultXlsx(sheet, run);
    const xmlMap = await unzipXlsxXmlEntries(xlsxBytes);
    const wsXml = xmlMap.get("xl/worksheets/sheet1.xml") ?? "";

    expect(wsXml).toContain('ySplit="2" topLeftCell="A3"');
    expect(wsXml).toContain("<f>len(G1)</f>");
    expect(wsXml).toContain("<f>len(G2)</f>");
    expect(wsXml).toContain('SEARCH("@",G2)-1');
    expect(wsXml).not.toContain("前后比值");
    expect(wsXml).not.toContain("总字符数");

    const expectedLastRow = 2 + run.totalOutputScreens;
    expect(wsXml).toContain(`sqref="H1:J${expectedLastRow}"`);
    expect(wsXml).toContain("<formula>47</formula><formula>84</formula>");
    expect(wsXml).toContain("<formula>84</formula>");

    expect(wsXml).toContain('<col min="12" max="12" width="24" customWidth="1"/>');
    expect(wsXml).toContain('<col min="13" max="13" width="20.75" customWidth="1" hidden="1"/>');
    expect(wsXml).toContain('<col min="16" max="16" width="13" customWidth="1" hidden="1"/>');

    const reparsed = await parseXlsxToSubtitleWorkbook(xlsxBytes, "out.xlsx");
    const outSheet = reparsed.sheets[reparsed.activeSheetName];
    expect(outSheet.headerRows).toHaveLength(2);
    expect(outSheet.headerRows[1].length).toBe(16);
    expect(outSheet.detectedFormulaCols).toEqual([7, 8, 9]);
    expect(outSheet.columnMap.targetCol).toBe(6);
    expect(outSheet.headerRows[1][11]).toBe("核对备注");
    expect(outSheet.colHidden[11]).toBe(false);
    expect(outSheet.colHidden.slice(12, 16)).toEqual([true, true, true, true]);
    expect(outSheet.headerFillRgb[1][12]).toBe("FFFF00");
    expect(outSheet.rows[outSheet.rows.length - 2].cellBold[6]).toBe(true);
  });

  it("keeps non-green Subtitle citation rows on 1 screen with 1 @", async () => {
    const wb = makeMockItalianWorkbook();
    const sheet = wb.sheets[wb.activeSheetName];
    sheet.rows[11].isGreenHighlight = false;
    sheet.rows[11].cellFillRgb = Array(15).fill(null);

    const spec = resolveLineBreakSpec("it");
    const run = await runSubtitleLineBreakPipeline(sheet, spec, { useAi: false });
    expect(run.results[11].category).toBe("citation_same_screen");
    expect(run.results[11].status).toBe("citation_broken");
    expect(run.results[11].screens).toHaveLength(1);
    expect(run.results[11].screens[0].hasAt).toBe(true);
  });

  it("enforces closed-loop validation when AI returns an over-46 split", async () => {
    const wb = makeMockItalianWorkbook();
    const sheet = wb.sheets[wb.activeSheetName];
    const spec = resolveLineBreakSpec("it");

    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: [{ id: "r_10", screenEnds: [10], atSplits: [9] }],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const gemini = new GeminiPoolClient({
      apiKeys: ["AIzaSyTestFakeKey123"],
      model: "gemini-3.5-flash-lite",
      rotation: "round_robin",
      fetchFn: mockFetch,
    });

    const run = await runSubtitleLineBreakPipeline(sheet, spec, { gemini, useAi: true });
    const r10 = run.results[10];
    expect(r10.screens).toHaveLength(1);
    expect(r10.screens[0].hasAt).toBe(true);
    expect(r10.screens[0].beforeAtLen!).toBeLessThanOrEqual(46);
    expect(r10.screens[0].afterAtLen!).toBeLessThanOrEqual(46);
    expect(r10.screens[0].exceedsSingleLimit).toBe(false);
  });

  it("loads a Google Sheet URL via Sheets API v4, decodes proto3 colors, and clones template via :copyTo", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.includes("fields=spreadsheetId,properties.title")) {
        return new Response(
          JSON.stringify({
            spreadsheetId: "1MockSourceSheetId0000001",
            properties: { title: "意语-测试表" },
            sheets: [
              { properties: { sheetId: 112233, title: "意语", index: 0, gridProperties: { frozenRowCount: 2 } } },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("ranges=") && method === "GET") {
        return new Response(
          JSON.stringify({
            sheets: [
              {
                data: [
                  {
                    columnMetadata: [
                      { pixelSize: 62 },
                      { pixelSize: 80 },
                      { pixelSize: 95 },
                      { pixelSize: 96 },
                      { pixelSize: 182 },
                      { pixelSize: 95 },
                      { pixelSize: 228 },
                      { pixelSize: 43 },
                      { pixelSize: 68 },
                      { pixelSize: 95 },
                      { pixelSize: 155 },
                      { pixelSize: 155, hiddenByUser: true },
                    ],
                    rowData: [
                      {
                        values: [
                          {}, {}, {}, {}, {}, {}, {},
                          { formattedValue: "0", userEnteredValue: { formulaValue: "=len(G1)" } },
                          { formattedValue: "L", userEnteredValue: { formulaValue: '=IF(H1>46,LEN(LEFT(G1,SEARCH("@",G1)-1)),"L")' } },
                          { formattedValue: "L", userEnteredValue: { formulaValue: '=IF(H1>46,LEN(RIGHT(G1,LEN(G1)-SEARCH("@",G1))),"L")' } },
                        ],
                      },
                      {
                        values: [
                          { formattedValue: "Line", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "In Time", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "Out Time", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "Character", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "Chinese", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "English", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "Target Language", effectiveFormat: { textFormat: { bold: true } } },
                          { formattedValue: "15", userEnteredValue: { formulaValue: "=len(G2)" } },
                          { formattedValue: "L", userEnteredValue: { formulaValue: '=IF(H2>46,LEN(LEFT(G2,SEARCH("@",G2)-1)),"L")' } },
                          { formattedValue: "L", userEnteredValue: { formulaValue: '=IF(H2>46,LEN(RIGHT(G2,LEN(G2)-SEARCH("@",G2))),"L")' } },
                          {},
                          { formattedValue: "录制备注", effectiveFormat: { backgroundColor: { red: 1, green: 1, blue: 0 }, textFormat: { bold: true } } },
                        ],
                      },
                      {
                        values: [
                          { formattedValue: "3" },
                          { formattedValue: "00:00:05:00" },
                          { formattedValue: "00:00:09:00" },
                          { formattedValue: "Host A (F)" },
                          { formattedValue: "去年春天，我开始负责整理每周的项目进度表。", effectiveFormat: { textFormat: { foregroundColor: {} } } },
                          { formattedValue: "Last spring I began organizing the weekly project schedule.", effectiveFormat: { textFormat: { foregroundColor: { red: 0.8 } } } },
                          { formattedValue: "Nella primavera scorsa ho iniziato a gestire il programma.", effectiveFormat: { textFormat: { foregroundColor: { red: 0.8 } } } },
                          { formattedValue: "58", userEnteredValue: { formulaValue: "=len(G3)" } },
                          { formattedValue: "#VALUE!", userEnteredValue: { formulaValue: '=IF(H3>46,LEN(LEFT(G3,SEARCH("@",G3)-1)),"L")' } },
                          { formattedValue: "#VALUE!", userEnteredValue: { formulaValue: '=IF(H3>46,LEN(RIGHT(G3,LEN(G3)-SEARCH("@",G3))),"L")' } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("fields=sheets.properties(sheetId,title)")) {
        return new Response(JSON.stringify({ sheets: [] }), { status: 200 });
      }
      if (url.endsWith(":copyTo")) {
        return new Response(JSON.stringify({ sheetId: 999 }), { status: 200 });
      }
      return new Response(JSON.stringify({ replies: [] }), { status: 200 });
    };

    const gUrl =
      "https://docs.google.com/spreadsheets/d/1MockSourceSheetId0000001/edit?gid=112233#gid=112233";
    const wb = await loadSubtitleWorkbookFromGoogleUrl(gUrl, {
      getAccessToken: async () => "fake-oauth-token",
      fetchFn: mockFetch,
    });

    expect(wb.fileName).toBe("意语-测试表");
    expect(wb.activeSheetName).toBe("意语");
    const sheet = wb.sheets["意语"];
    expect(sheet.sourceSheetId).toBe(112233);
    expect(sheet.columnMap.targetCol).toBe(6);
    expect(sheet.detectedFormulaCols).toEqual([7, 8, 9]);
    expect(sheet.colHidden[11]).toBe(true);
    expect(sheet.rows[0].cellFontRgb[4]).toBeNull();
    expect(sheet.rows[0].cellFontRgb[5]).toBe("CC0000");
    expect(sheet.rows[0].cellFontRgb[6]).toBe("CC0000");
    expect(sheet.headerFillRgb[1][11]).toBe("FFFF00");

    const spec = resolveLineBreakSpec("it");
    const run = await runSubtitleLineBreakPipeline(sheet, spec, { useAi: false });

    const outRes = await writeLineBreakRunToGoogleSheet(
      "https://docs.google.com/spreadsheets/d/1MockOutputSheetId000002/edit",
      sheet,
      run,
      async () => "fake-oauth-token",
      true,
      mockFetch,
    );

    expect(outRes.sheetTitle).toBe("意语");
    expect(calls.some((c) => c.url.includes("/sheets/112233:copyTo"))).toBe(true);
    expect(calls.some((c) => c.url.includes("values:batchUpdate"))).toBe(true);
  });

  it("splits two independent sentences in the 76-84 range into 2 screens and handles Japanese rules", async () => {
    const elSpec = resolveLineBreakSpec("希腊语");
    const measurer = createSubtitleMeasurer(elSpec);
    const twoSentEl = "Πώς μπορούμε να οργανώσουμε το πρόγραμμά μας; Πρέπει να ξεκινήσουμε με ένα σαφές σχέδιο.";

    const wb = makeMockItalianWorkbook();
    const sheet = wb.sheets[wb.activeSheetName];
    sheet.rows = [
      {
        rowIndex: 0,
        excelRowNumber: 3,
        rawCells: ["1", "", "", "Host", "", "", twoSentEl],
        cellFillRgb: Array(7).fill(null),
        cellFontRgb: Array(7).fill(null),
        cellBold: Array(7).fill(false),
        isGreenHighlight: false,
        isGrayHighlight: false,
      },
    ];
    const runEl = await runSubtitleLineBreakPipeline(sheet, elSpec, { useAi: false });
    expect(runEl.results[0].screens.length).toBe(2);
    expect(measurer.measure(runEl.results[0].screens[0].text)).toBeLessThanOrEqual(46);

    const jaSpec = resolveLineBreakSpec("日语");
    sheet.rows[0].rawCells[6] = "これは最初の文です。次の文も続きます。";
    const runJa = await runSubtitleLineBreakPipeline(sheet, jaSpec, { useAi: false });
    expect(runJa.results[0].screens[0].text).toBe("これは最初の文です@次の文も続きます");
  });

  it("auto-detects 12 languages from Master Sheet titles without false-matching ASCII words", () => {
    const cases: Array<[string, string]> = [
      ["意语-批量表", "it"],
      ["印尼语-批量表", "id"],
      ["美西语-批量表", "es"],
      ["希腊语-批量表", "el"],
      ["俄语-批量表", "ru"],
      ["葡语-批量表", "pt"],
      ["法语-批量表", "fr"],
      ["印地语-批量表", "hi"],
      ["高棉语-批量表", "km"],
      ["阿拉伯-批量表", "ar"],
      ["缅甸语-批量表", "my"],
      ["泰语-批量表", "th"],
    ];
    for (const [label, expectedCode] of cases) {
      expect(detectLanguageSpecFromText(label)?.code).toBe(expectedCode);
    }
    expect(detectLanguageSpecFromText("video_edit_guide_2026")).toBeNull();
  });

  it("loads Batch Master Sheet (Smart Chips + headerless Row 1), flags multi-sheet items, writes in-place _已断行 + Col L, and writes status back to C:D", async () => {
    const writeCalls: Array<{ url: string; body: unknown }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "POST") writeCalls.push({ url, body });

      if (url.includes("/spreadsheets/1MasterSheetId123?") && url.includes("fields=spreadsheetId")) {
        return new Response(
          JSON.stringify({
            spreadsheetId: "1MasterSheetId123",
            properties: { title: "批量总表" },
            sheets: [{ properties: { sheetId: 0, title: "总表", hidden: false } }],
          }),
          { status: 200 },
        );
      }

      if (url.includes("/spreadsheets/1MasterSheetId123?ranges=")) {
        return new Response(
          JSON.stringify({
            sheets: [
              {
                data: [
                  {
                    rowData: [
                      {
                        values: [
                          { formattedValue: "意语-批量表" },
                          { formattedValue: "https://docs.google.com/spreadsheets/d/1ItDocId111111111/edit?gid=112233#gid=112233" },
                        ],
                      },
                      {
                        values: [
                          { formattedValue: "缅甸语-批量表" },
                          {
                            formattedValue: "缅甸语-批量表",
                            chipRuns: [
                              {
                                chip: {
                                  richLinkProperties: {
                                    uri: "https://docs.google.com/spreadsheets/d/1MyDocId222222222/edit",
                                  },
                                },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("/spreadsheets/1ItDocId111111111?")) {
        return new Response(
          JSON.stringify({
            spreadsheetId: "1ItDocId111111111",
            properties: { title: "意语-批量表" },
            sheets: [
              { properties: { sheetId: 112233, title: "意语", hidden: false, gridProperties: { columnCount: 15 } } },
              { properties: { sheetId: 999111, title: "意语_已断行", hidden: false, gridProperties: { columnCount: 16 } } },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("/spreadsheets/1MyDocId222222222?")) {
        return new Response(
          JSON.stringify({
            spreadsheetId: "1MyDocId222222222",
            properties: { title: "缅甸语-批量表" },
            sheets: [
              { properties: { sheetId: 101, title: "原稿备份", hidden: false } },
              { properties: { sheetId: 102, title: "缅甸语定稿", hidden: false } },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.endsWith(":copyTo")) {
        return new Response(JSON.stringify({ sheetId: 777888, gridProperties: { columnCount: 15 } }), { status: 200 });
      }

      return new Response(JSON.stringify({ replies: [] }), { status: 200 });
    };

    const queue = await loadBatchMasterQueueFromGoogleUrl(
      "https://docs.google.com/spreadsheets/d/1MasterSheetId123/edit#gid=0",
      { getAccessToken: async () => "fake-token", fetchFn: mockFetch },
    );

    expect(queue.items).toHaveLength(2);
    expect(queue.items[0].masterExcelRow).toBe(1);
    expect(queue.items[0].langCode).toBe("it");
    expect(queue.items[0].needsSheetConfirm).toBe(false);
    expect(queue.items[0].status).toBe("queued");

    expect(queue.items[1].masterExcelRow).toBe(2);
    expect(queue.items[1].langCode).toBe("my");
    expect(queue.items[1].needsSheetConfirm).toBe(true);
    expect(queue.items[1].status).toBe("pending_confirm_sheet");

    const wb = makeMockItalianWorkbook();
    const sheet = wb.sheets[wb.activeSheetName];
    sheet.sourceSpreadsheetId = "1ItDocId111111111";
    sheet.sourceSheetId = 112233;
    const run = await runSubtitleLineBreakPipeline(sheet, resolveLineBreakSpec("it"), { useAi: false });

    const writeRes = await writeLineBreakRunToGoogleSheet(
      "",
      sheet,
      run,
      async () => "fake-token",
      true,
      mockFetch,
    );
    expect(writeRes.sheetTitle).toBe("意语_已断行");
    expect(writeRes.sheetUrl).toContain("gid=777888");
    const structCall = writeCalls.find((c) => c.url.endsWith("1ItDocId111111111:batchUpdate"));
    const structJson = JSON.stringify(structCall?.body ?? {});
    expect(structJson).toContain('"deleteSheet":{"sheetId":999111}');
    expect(structJson).toContain('"startIndex":11,"endIndex":12');

    await writeStatusBackToBatchMasterSheet(
      queue,
      queue.items[0],
      "已完成（待人工核对 1 处，见 L 列）",
      writeRes.sheetUrl,
      async () => "fake-token",
      mockFetch,
    );
    const masterWrite = writeCalls.find((c) => c.url.includes("1MasterSheetId123/values:batchUpdate"));
    expect(JSON.stringify(masterWrite?.body)).toContain("C1:D1");
    expect(JSON.stringify(masterWrite?.body)).toContain("已完成（待人工核对 1 处，见 L 列）");
  });

  it("pauses cleanly on API Key exhaustion (LineBreakPausedError) and resumes from exact batch checkpoint", async () => {
    const wb = makeMockItalianWorkbook();
    const sheet = wb.sheets[wb.activeSheetName];
    const spec = resolveLineBreakSpec("it");

    const longSentence = "Nella primavera scorsa ho iniziato a gestire il programma.";
    sheet.rows = Array.from({ length: 25 }, (_, i) => ({
      rowIndex: i,
      excelRowNumber: i + 3,
      rawCells: [String(i + 1), "", "", "Host", "中文", "English", longSentence],
      cellFillRgb: Array(7).fill(null),
      cellFontRgb: Array(7).fill(null),
      cellBold: Array(7).fill(false),
      isGreenHighlight: false,
      isGrayHighlight: false,
    }));

    let apiCallCount = 0;
    const failingOnBatch2Fetch: typeof fetch = async () => {
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        items: Array.from({ length: 20 }, (_, i) => ({
                          id: `r_${i}`,
                          screenEnds: [9],
                          atSplits: [4],
                        })),
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
      return new Response(JSON.stringify({ error: { message: "Quota exceeded for quota metric" } }), {
        status: 429,
      });
    };

    const client1 = new GeminiPoolClient({
      apiKeys: ["AIzaSyKey1ExhaustsSoon"],
      model: "gemini-3.5-flash-lite",
      rotation: "round_robin",
      fetchFn: failingOnBatch2Fetch,
    });

    let caughtPause: LineBreakPausedError | null = null;
    try {
      await runSubtitleLineBreakPipeline(sheet, spec, {
        gemini: client1,
        useAi: true,
        pauseOnKeyExhausted: true,
      });
    } catch (err) {
      if (err instanceof LineBreakPausedError) caughtPause = err;
    }

    expect(caughtPause).not.toBeNull();
    expect(caughtPause!.completedAiRows).toBe(20);
    expect(caughtPause!.totalAiRows).toBe(25);
    expect(Object.keys(caughtPause!.partialAiCache)).toHaveLength(20);

    let resumeApiCalls = 0;
    const resumeFetch: typeof fetch = async (_inp, init) => {
      resumeApiCalls += 1;
      const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      const promptText = parsedBody.contents?.[0]?.parts?.[0]?.text ?? "";
      expect(promptText).not.toContain('id="r_0"');
      expect(promptText).toContain('id="r_20"');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: Array.from({ length: 5 }, (_, i) => ({
                        id: `r_${20 + i}`,
                        screenEnds: [9],
                        atSplits: [4],
                      })),
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client2 = new GeminiPoolClient({
      apiKeys: ["AIzaSyFreshKey2"],
      model: "gemini-3.5-flash-lite",
      rotation: "round_robin",
      fetchFn: resumeFetch,
    });

    const completedRun = await runSubtitleLineBreakPipeline(sheet, spec, {
      gemini: client2,
      useAi: true,
      pauseOnKeyExhausted: true,
      cachedAiRows: caughtPause!.partialAiCache,
    });

    expect(resumeApiCalls).toBe(1);
    expect(completedRun.results).toHaveLength(25);
    expect(completedRun.results.every((r) => r.screens[0].hasAt)).toBe(true);
  });

  it("supports adding new custom languages, modifying built-in thresholds, and injecting custom AI rules", async () => {
    try {
      upsertCustomLineBreakSpec({
        code: "bn",
        name: "孟加拉语",
        aliases: ["孟加拉", "孟语", "bengali"],
        mode: "char",
        tier: 2,
        fontFamily: "Arial",
        fontSizePt: 12,
        dir: "ltr",
        singleMax: 42,
        doubleMax: 78,
        softNoBreakMax: 44,
        earlySplitSentenceMin: 68,
        compactSameScreenMax: 84,
        sentenceEndChars: ["।", "?", "!"],
        customPromptRule: "严禁在孟加拉语复合助动词中间断开",
        isCustom: true,
      });

      saveGlobalLineBreakRules({
        minLineRatio: 0.4,
        maxLineRatio: 2.5,
        globalCustomPrompt: "引语冒号后一律优先分屏",
      });

      expect(getActiveLineBreakSpecs().some((s) => s.code === "bn")).toBe(true);
      const detected = detectLanguageSpecFromText("孟加拉语-批量表");
      expect(detected?.code).toBe("bn");
      expect(detected?.singleMax).toBe(42);

      let capturedSysPrompt = "";
      const mockFetch: typeof fetch = async (_inp, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          systemInstruction?: { parts?: Array<{ text?: string }> };
        };
        capturedSysPrompt = body.systemInstruction?.parts?.[0]?.text ?? "";
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ items: [{ id: "r_0", screenEnds: [9], atSplits: [4] }] }) }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      };

      const wb = makeMockItalianWorkbook();
      const sheet = wb.sheets[wb.activeSheetName];
      sheet.rows = [sheet.rows[2]];
      sheet.rows[0].rowIndex = 0;

      const gemini = new GeminiPoolClient({
        apiKeys: ["AIzaSyFakeKeyCustom"],
        model: "gemini-3.5-flash-lite",
        rotation: "round_robin",
        fetchFn: mockFetch,
      });

      await runSubtitleLineBreakPipeline(sheet, resolveLineBreakSpec("bn"), {
        gemini,
        useAi: true,
      });

      expect(capturedSysPrompt).toContain("单行上限 = 42");
      expect(capturedSysPrompt).toContain("引语冒号后一律优先分屏");
      expect(capturedSysPrompt).toContain("严禁在孟加拉语复合助动词中间断开");
    } finally {
      resetAllLineBreakCustomizations();
    }
  });
});

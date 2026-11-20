import type { TokenProvider } from "../google/sheets-client";
import { parseGoogleResourceUrl } from "../google/url-parser";
import type {
  ImportedSubtitleSheet,
  ImportedSubtitleWorkbook,
  SheetTabCandidate,
  SubtitleLineBreakRun,
} from "./types";
import {
  parseXlsxToSubtitleWorkbook,
  structureParsedSubtitleSheet,
} from "./xlsx-reader";
import { colIndexToLetters, resolveTemplateColumnPlan } from "./xlsx-writer";

function quoteSheetRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function floatColorToHex6(c?: { red?: number; green?: number; blue?: number }): string | null {
  if (!c) return null;
  // In Google Sheets API v4 (proto3 JSON), omitted channels are 0.0 (e.g. #CC0000 is { red: 0.8 }).
  const r = Math.round((c.red ?? 0) * 255);
  const g = Math.round((c.green ?? 0) * 255);
  const b = Math.round((c.blue ?? 0) * 255);
  if (r >= 253 && g >= 253 && b >= 253) return null;
  if (r === 0 && g === 0 && b === 0) return null;
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0").toUpperCase();
  return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}

async function authedSheetsJson<T>(
  token: string,
  url: string,
  init?: RequestInit,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<T> {
  const resp = await fetchFn(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Google Sheets API 请求失败 (HTTP ${resp.status}): ${detail.slice(0, 180)}`);
  }
  return (await resp.json()) as T;
}

export interface LoadGoogleSheetOptions {
  getAccessToken?: TokenProvider;
  fetchPublicXlsxBytes?: (spreadsheetId: string) => Promise<Uint8Array>;
  /** Explicit sheetId chosen by user when a spreadsheet contains multiple tabs */
  explicitSheetId?: number;
  fetchFn?: typeof fetch;
}

export interface SpreadsheetTabInspection {
  spreadsheetId: string;
  spreadsheetTitle: string;
  urlGid: number | null;
  tabs: SheetTabCandidate[];
  /** Candidate source tabs (visible and not ending with "_已断行") */
  sourceCandidateTabs: SheetTabCandidate[];
}

export async function inspectGoogleSpreadsheetTabs(
  rawUrl: string,
  getAccessToken: TokenProvider,
  fetchFn?: typeof fetch,
): Promise<SpreadsheetTabInspection> {
  const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
  if (!parsed || parsed.kind !== "sheet") {
    throw new Error("请输入有效的 Google 表格链接");
  }
  const token = await getAccessToken();
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(parsed.id)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,hidden)`;
  const meta = await authedSheetsJson<{
    spreadsheetId: string;
    properties?: { title?: string };
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        hidden?: boolean;
      };
    }>;
  }>(token, metaUrl, undefined, fetchFn);

  const tabs: SheetTabCandidate[] = (meta.sheets ?? []).map((s, idx) => {
    const title = s.properties?.title ?? `Sheet${idx + 1}`;
    return {
      sheetId: s.properties?.sheetId ?? idx,
      title,
      hidden: Boolean(s.properties?.hidden),
      isProcessedOutput: /_已断行(?:_\d+)?$/.test(title),
    };
  });

  const visibleNonOutput = tabs.filter((t) => !t.hidden && !t.isProcessedOutput);
  const sourceCandidateTabs =
    visibleNonOutput.length > 0 ? visibleNonOutput : tabs.filter((t) => !t.hidden);

  return {
    spreadsheetId: parsed.id,
    spreadsheetTitle: meta.properties?.title?.trim() || "未命名表格",
    urlGid: parsed.gid,
    tabs,
    sourceCandidateTabs: sourceCandidateTabs.length > 0 ? sourceCandidateTabs : tabs,
  };
}

/**
 * Imports a Google Sheet by URL or #gid,
 * preserving 100% of its exact template structure: Row 1 & Row 2 formulas, cell fills (green/yellow),
 * bold text runs, column widths, hidden columns (L..O), and frozen rows.
 */
export async function loadSubtitleWorkbookFromGoogleUrl(
  rawUrl: string,
  options: LoadGoogleSheetOptions,
): Promise<ImportedSubtitleWorkbook> {
  const parsed = parseGoogleResourceUrl(rawUrl, "sheet");
  if (!parsed || parsed.kind !== "sheet") {
    throw new Error("请输入有效的 Google 表格链接（支持含 ?gid=... 或 #gid=...）");
  }
  const effectiveGid =
    options.explicitSheetId !== undefined ? options.explicitSheetId : parsed.gid;

  let oauthErr: unknown = null;
  if (options.getAccessToken) {
    try {
      const token = await options.getAccessToken();
      if (token) {
        return await fetchViaSheetsApiV4(parsed.id, effectiveGid, token, options.fetchFn);
      }
    } catch (err) {
      oauthErr = err;
    }
  }

  // Fallback for link-shared sheets when OAuth is not logged in yet
  if (options.fetchPublicXlsxBytes) {
    try {
      const bytes = await options.fetchPublicXlsxBytes(parsed.id);
      const wb = await parseXlsxToSubtitleWorkbook(bytes, `GoogleSheet_${parsed.id.slice(0, 8)}.xlsx`);
      wb.sourceSpreadsheetId = parsed.id;
      for (const s of Object.values(wb.sheets)) {
        s.sourceSpreadsheetId = parsed.id;
      }
      return wb;
    } catch {
      // Fall through to report OAuth / permission error clearly
    }
  }

  if (oauthErr instanceof Error) {
    throw oauthErr;
  }
  throw new Error("请先点击右上角「设置 → Google OAuth 2.0 授权」登录有该表格查看权限的 Google 账号。");
}

async function fetchViaSheetsApiV4(
  spreadsheetId: string,
  gid: number | null,
  token: string,
  fetchFn?: typeof fetch,
): Promise<ImportedSubtitleWorkbook> {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,index,hidden,gridProperties.frozenRowCount)`;
  const meta = await authedSheetsJson<{
    spreadsheetId: string;
    properties?: { title?: string };
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        index?: number;
        hidden?: boolean;
        gridProperties?: { frozenRowCount?: number };
      };
    }>;
  }>(token, metaUrl, undefined, fetchFn);

  const tabs = (meta.sheets ?? []).map((s, idx) => ({
    sheetId: s.properties?.sheetId ?? idx,
    title: s.properties?.title ?? `Sheet${idx + 1}`,
    hidden: Boolean(s.properties?.hidden),
    frozenRowCount: s.properties?.gridProperties?.frozenRowCount ?? 2,
  }));
  if (tabs.length === 0) {
    throw new Error("目标 Google 表格中没有任何工作表");
  }

  const defaultTab =
    tabs.find((t) => !t.hidden && !/_已断行(?:_\d+)?$/.test(t.title)) ??
    tabs.find((t) => !t.hidden) ??
    tabs[0];
  const targetTab =
    gid !== null ? (tabs.find((t) => t.sheetId === gid) ?? defaultTab) : defaultTab;

  const rangeParam = encodeURIComponent(quoteSheetRange(targetTab.title));
  const fields =
    "sheets(properties(sheetId,title,gridProperties.frozenRowCount),data(columnMetadata(pixelSize,hiddenByUser),rowData(values(formattedValue,userEnteredValue,effectiveFormat(backgroundColor,textFormat(bold,foregroundColor))))))";
  const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?ranges=${rangeParam}&fields=${encodeURIComponent(fields)}`;

  const full = await authedSheetsJson<{
    sheets?: Array<{
      data?: Array<{
        columnMetadata?: Array<{ pixelSize?: number; hiddenByUser?: boolean }>;
        rowData?: Array<{
          values?: Array<{
            formattedValue?: string;
            userEnteredValue?: { formulaValue?: string };
            effectiveFormat?: {
              backgroundColor?: { red?: number; green?: number; blue?: number };
              textFormat?: {
                bold?: boolean;
                foregroundColor?: { red?: number; green?: number; blue?: number };
              };
            };
          }>;
        }>;
      }>;
    }>;
  }>(token, dataUrl, undefined, fetchFn);

  const gridData = full.sheets?.[0]?.data?.[0];
  const colMeta = gridData?.columnMetadata ?? [];
  const rowData = gridData?.rowData ?? [];

  let maxCols = colMeta.length;
  for (const r of rowData) {
    if ((r.values?.length ?? 0) > maxCols) maxCols = r.values!.length;
  }

  const formulaColCounts = new Map<number, number>();
  const parsedRows = rowData.map((r, rIdx) => {
    const cells: string[] = Array(maxCols).fill("");
    const fills: Array<string | null> = Array(maxCols).fill(null);
    const fontColors: Array<string | null> = Array(maxCols).fill(null);
    const bolds: boolean[] = Array(maxCols).fill(false);

    (r.values ?? []).forEach((v, cIdx) => {
      cells[cIdx] = v.formattedValue ?? "";
      fills[cIdx] = floatColorToHex6(v.effectiveFormat?.backgroundColor);
      fontColors[cIdx] = floatColorToHex6(v.effectiveFormat?.textFormat?.foregroundColor);
      bolds[cIdx] = Boolean(v.effectiveFormat?.textFormat?.bold);
      const fVal = v.userEnteredValue?.formulaValue ?? "";
      if (fVal && /\b(?:LEN|SEARCH|LEFT|RIGHT)\s*\(/i.test(fVal)) {
        formulaColCounts.set(cIdx, (formulaColCounts.get(cIdx) ?? 0) + 1);
      }
    });

    return { excelRow: rIdx + 1, cells, fills, fontColors, bolds };
  });

  const detectedFormulaCols = [...formulaColCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([col]) => col)
    .sort((a, b) => a - b);

  // Extract exact data-row formula template (e.g. from row 3+) if present so custom thresholds are preserved
  let sourceFormulaTemplates: [string, string, string] | null = null;
  if (detectedFormulaCols.length >= 3) {
    const [fc0, fc1, fc2] = detectedFormulaCols;
    for (let rIdx = 2; rIdx < rowData.length; rIdx += 1) {
      const vals = rowData[rIdx]?.values ?? [];
      const f0 = vals[fc0]?.userEnteredValue?.formulaValue ?? "";
      const f1 = vals[fc1]?.userEnteredValue?.formulaValue ?? "";
      const f2 = vals[fc2]?.userEnteredValue?.formulaValue ?? "";
      if (f0.startsWith("=") && f1.startsWith("=") && f2.startsWith("=")) {
        const rowNum = rIdx + 1;
        const rowRe = new RegExp(`(\\$?[A-Za-z]+)${rowNum}\\b`, "g");
        sourceFormulaTemplates = [
          f0.replace(rowRe, "$1{ROW}"),
          f1.replace(rowRe, "$1{ROW}"),
          f2.replace(rowRe, "$1{ROW}"),
        ];
        break;
      }
    }
  }

  const colWidths = Array.from({ length: maxCols }, (_, i) => {
    const px = colMeta[i]?.pixelSize;
    return px ? Math.round((px / 7.5) * 100) / 100 : null;
  });
  const colHidden = Array.from({ length: maxCols }, (_, i) =>
    Boolean(colMeta[i]?.hiddenByUser),
  );

  const sheet = structureParsedSubtitleSheet(
    targetTab.title,
    parsedRows,
    detectedFormulaCols,
    {
      sourceSpreadsheetId: spreadsheetId,
      sourceSheetId: targetTab.sheetId,
      frozenRowCount: targetTab.frozenRowCount,
      colWidths,
      colHidden,
    },
  );
  sheet.sourceFormulaTemplates = sourceFormulaTemplates;

  const docTitle = meta.properties?.title?.trim() || targetTab.title;
  return {
    fileName: docTitle,
    sourceSpreadsheetId: spreadsheetId,
    sheetNames: [targetTab.title],
    activeSheetName: targetTab.title,
    sheets: { [targetTab.title]: sheet },
  };
}

/**
 * Writes the line-broken result into a Google Sheet by cloning the original template sheet
 * via `:copyTo` (preserving 100% of original fonts, bold text, cell fills, hidden columns,
 * column widths, row heights, and conditional formatting), inserting split-screen rows with
 * `inheritFromBefore: true`, updating Target Language (RAW), and populating H1:J{lastRow} formulas!
 */
export async function writeLineBreakRunToGoogleSheet(
  outputUrl: string,
  sheet: ImportedSubtitleSheet,
  run: SubtitleLineBreakRun,
  getAccessToken: TokenProvider,
  overwriteExisting = true,
  fetchFn?: typeof fetch,
): Promise<{ spreadsheetId: string; sheetId: number; sheetTitle: string; sheetUrl: string }> {
  const trimmedOut = (outputUrl || "").trim();
  let destId = "";
  if (trimmedOut) {
    const outParsed = parseGoogleResourceUrl(trimmedOut, "sheet");
    if (!outParsed || outParsed.kind !== "sheet") {
      throw new Error("请填写有效的输出 Google 表格链接");
    }
    destId = outParsed.id;
  } else if (sheet.sourceSpreadsheetId) {
    destId = sheet.sourceSpreadsheetId;
  } else {
    throw new Error("当前稿件来自本地文件，请填写目标 Google 表格链接或直接点击「导出 Excel (.xlsx)」");
  }

  const token = await getAccessToken();
  const spec = run.langSpec;

  const destMeta = await authedSheetsJson<{
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        gridProperties?: { columnCount?: number };
      };
    }>;
  }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}?fields=sheets.properties(sheetId,title,gridProperties.columnCount)`,
    undefined,
    fetchFn,
  );
  const existingSheets = (destMeta.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? 0,
    title: s.properties?.title ?? "",
    columnCount: s.properties?.gridProperties?.columnCount ?? 15,
  }));

  const isSameDocAsSource = sheet.sourceSpreadsheetId === destId;
  const baseDesiredTitle = isSameDocAsSource
    ? `${sheet.sheetName}_已断行`
    : sheet.sheetName || spec.name;
  let finalTitle = baseDesiredTitle.slice(0, 95);
  const colliding = existingSheets.find(
    (s) => s.title === finalTitle && (!isSameDocAsSource || s.sheetId !== sheet.sourceSheetId),
  );
  if (colliding && !overwriteExisting) {
    finalTitle = `${finalTitle}_${new Date().toISOString().slice(11, 16).replace(":", "")}`;
  }

  const includeCharFormulas = spec.mode === "char" || sheet.detectedFormulaCols.length >= 3;
  const plan = resolveTemplateColumnPlan(sheet, includeCharFormulas);
  const totalOutRows = sheet.headerRows.length + run.totalOutputScreens;

  let destSheetId = 0;
  let clonedFromTemplate = false;
  let clonedColCount = Math.max(sheet.colWidths.length, 11);

  // Step 1: Clone original Google Sheet tab via :copyTo so 100% of template formatting is preserved!
  if (sheet.sourceSpreadsheetId && sheet.sourceSheetId !== undefined) {
    try {
      const copied = await authedSheetsJson<{
        sheetId: number;
        gridProperties?: { columnCount?: number };
      }>(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.sourceSpreadsheetId)}/sheets/${sheet.sourceSheetId}:copyTo`,
        {
          method: "POST",
          body: JSON.stringify({ destinationSpreadsheetId: destId }),
        },
        fetchFn,
      );
      destSheetId = copied.sheetId;
      if (copied.gridProperties?.columnCount) {
        clonedColCount = copied.gridProperties.columnCount;
      } else {
        const srcEntry = existingSheets.find((s) => s.sheetId === sheet.sourceSheetId);
        if (srcEntry) clonedColCount = srcEntry.columnCount;
      }
      clonedFromTemplate = true;
    } catch {
      clonedFromTemplate = false;
    }
  }

  const buildFormulaRow = (r: number, gLet: string, hLet: string): [string, string, string] => {
    if (sheet.sourceFormulaTemplates) {
      return [
        sheet.sourceFormulaTemplates[0].replace(/\{ROW\}/g, String(r)),
        sheet.sourceFormulaTemplates[1].replace(/\{ROW\}/g, String(r)),
        sheet.sourceFormulaTemplates[2].replace(/\{ROW\}/g, String(r)),
      ];
    }
    return [
      `=len(${gLet}${r})`,
      `=IF(${hLet}${r}>${spec.singleMax},LEN(LEFT(${gLet}${r},SEARCH("@",${gLet}${r})-1)),"L")`,
      `=IF(${hLet}${r}>${spec.singleMax},LEN(RIGHT(${gLet}${r},LEN(${gLet}${r})-SEARCH("@",${gLet}${r}))),"L")`,
    ];
  };

  if (clonedFromTemplate) {
    const batchReqs: Record<string, unknown>[] = [];
    if (colliding && overwriteExisting) {
      batchReqs.push({ deleteSheet: { sheetId: colliding.sheetId } });
    }
    batchReqs.push({
      updateSheetProperties: {
        properties: {
          sheetId: destSheetId,
          title: finalTitle,
        },
        fields: "title",
      },
    });

    let curCols = clonedColCount;

    // If raw net script lacked H/I/J formula columns, insert 3 columns right after Target Language
    if (sheet.detectedFormulaCols.length < 3 && plan.formulaCols) {
      const insStart = sheet.columnMap.targetCol + 1;
      if (insStart < curCols) {
        batchReqs.push({
          insertDimension: {
            range: {
              sheetId: destSheetId,
              dimension: "COLUMNS",
              startIndex: insStart,
              endIndex: insStart + 3,
            },
            inheritFromBefore: false,
          },
        });
      } else {
        batchReqs.push({
          appendDimension: {
            sheetId: destSheetId,
            dimension: "COLUMNS",
            length: 3,
          },
        });
      }
      curCols += 3;
    }

    // Insert or append visible Col L (plan.outReviewCol) without overwriting hidden 给录制人员备注 (now M..P!)
    if (plan.insertedReviewColAt !== null) {
      if (plan.insertedReviewColAt < curCols) {
        batchReqs.push({
          insertDimension: {
            range: {
              sheetId: destSheetId,
              dimension: "COLUMNS",
              startIndex: plan.insertedReviewColAt,
              endIndex: plan.insertedReviewColAt + 1,
            },
            inheritFromBefore: true,
          },
        });
        curCols += 1;
      } else {
        const needed = plan.totalOutCols - curCols;
        if (needed > 0) {
          batchReqs.push({
            appendDimension: {
              sheetId: destSheetId,
              dimension: "COLUMNS",
              length: needed,
            },
          });
          if (curCols > 0) {
            batchReqs.push({
              copyPaste: {
                source: {
                  sheetId: destSheetId,
                  startRowIndex: 0,
                  endRowIndex: Math.max(sheet.headerRows.length + sheet.rows.length, 3),
                  startColumnIndex: curCols - 1,
                  endColumnIndex: curCols,
                },
                destination: {
                  sheetId: destSheetId,
                  startRowIndex: 0,
                  endRowIndex: Math.max(sheet.headerRows.length + sheet.rows.length, 3),
                  startColumnIndex: curCols,
                  endColumnIndex: curCols + needed,
                },
                pasteType: "PASTE_FORMAT",
              },
            });
          }
          curCols += needed;
        }
      }
    }

    // Ensure Col L (outReviewCol) is visible with clean width (195px)
    batchReqs.push({
      updateDimensionProperties: {
        range: {
          sheetId: destSheetId,
          dimension: "COLUMNS",
          startIndex: plan.outReviewCol,
          endIndex: plan.outReviewCol + 1,
        },
        properties: {
          pixelSize: 195,
          hiddenByUser: false,
        },
        fields: "pixelSize,hiddenByUser",
      },
    });

    // Style L2 header ("核对备注") bold centered to match A2:G2 headers
    const mainHeaderZeroIdx = Math.max(0, sheet.headerRows.length - 1);
    batchReqs.push({
      repeatCell: {
        range: {
          sheetId: destSheetId,
          startRowIndex: mainHeaderZeroIdx,
          endRowIndex: mainHeaderZeroIdx + 1,
          startColumnIndex: plan.outReviewCol,
          endColumnIndex: plan.outReviewCol + 1,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat.bold)",
      },
    });

    // Insert split-screen rows bottom-to-top with inheritFromBefore: true (preserves font/bold/wrap/borders!)
    const headerOffset = sheet.headerRows.length;
    let shiftBelow = 0;
    const expandedSpans: Array<{ start: number; extra: number }> = [];
    for (let i = 0; i < sheet.rows.length; i += 1) {
      const extraScreens = (run.results[i]?.screens.length ?? 1) - 1;
      const curStart = headerOffset + i + shiftBelow;
      if (extraScreens > 0) {
        expandedSpans.push({ start: curStart + 1, extra: extraScreens });
      }
      shiftBelow += extraScreens;
    }

    for (let i = sheet.rows.length - 1; i >= 0; i -= 1) {
      const extraScreens = (run.results[i]?.screens.length ?? 1) - 1;
      if (extraScreens > 0) {
        const srcZeroRow = headerOffset + i;
        batchReqs.push({
          insertDimension: {
            range: {
              sheetId: destSheetId,
              dimension: "ROWS",
              startIndex: srcZeroRow + 1,
              endIndex: srcZeroRow + 1 + extraScreens,
            },
            inheritFromBefore: true,
          },
        });
      }
    }

    // Clear any inherited cell background color (e.g. yellow D291) on newly inserted split-screen rows
    for (const sp of expandedSpans) {
      batchReqs.push({
        repeatCell: {
          range: {
            sheetId: destSheetId,
            startRowIndex: sp.start,
            endRowIndex: sp.start + sp.extra,
            startColumnIndex: 0,
            endColumnIndex: plan.totalOutCols,
          },
          cell: { userEnteredFormat: {} },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
    }

    // Add conditional formatting only if source lacked H/I/J formula columns (cloned template already has H1:J CF!)
    if (plan.formulaCols && sheet.detectedFormulaCols.length < 3) {
      batchReqs.push(
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId: destSheetId,
                  startRowIndex: 0,
                  endRowIndex: totalOutRows,
                  startColumnIndex: plan.formulaCols[0],
                  endColumnIndex: plan.formulaCols[2] + 1,
                },
              ],
              booleanRule: {
                condition: {
                  type: "NUMBER_BETWEEN",
                  values: [
                    { userEnteredValue: String(spec.singleMax + 1) },
                    { userEnteredValue: String(spec.doubleMax) },
                  ],
                },
                format: { backgroundColor: { red: 1, green: 1, blue: 0 } },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId: destSheetId,
                  startRowIndex: 0,
                  endRowIndex: totalOutRows,
                  startColumnIndex: plan.formulaCols[0],
                  endColumnIndex: plan.formulaCols[2] + 1,
                },
              ],
              booleanRule: {
                condition: {
                  type: "NUMBER_GREATER",
                  values: [{ userEnteredValue: String(spec.doubleMax) }],
                },
                format: { backgroundColor: { red: 1, green: 0, blue: 1 } },
              },
            },
            index: 1,
          },
        },
      );
    }

    await authedSheetsJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}:batchUpdate`,
      { method: "POST", body: JSON.stringify({ requests: batchReqs }) },
      fetchFn,
    );

    // Write ONLY modified Target Language cells (leaving unchanged cells 100% untouched!) + Col L review remarks
    const qTitle = quoteSheetRange(finalTitle);
    const gLet = colIndexToLetters(plan.outTargetCol);
    const lLet = colIndexToLetters(plan.outReviewCol);
    const startDataRow1Based = sheet.headerRows.length + 1;
    const rawValueUpdates: Array<{ range: string; values: string[][] }> = [
      {
        range: `${qTitle}!${lLet}${mainHeaderZeroIdx + 1}`,
        values: [["核对备注"]],
      },
    ];

    const reviewColValues: string[][] = [];
    let curRow1Based = startDataRow1Based;

    for (let i = 0; i < sheet.rows.length; i += 1) {
      const origRawTarget = sheet.rows[i].rawCells[sheet.columnMap.targetCol] ?? "";
      const proc = run.results[i];
      const screens = proc?.screens.length ? proc.screens : [{ text: origRawTarget }];
      for (let sIdx = 0; sIdx < screens.length; sIdx += 1) {
        const scText = screens[sIdx].text;
        if (sIdx > 0 || scText !== origRawTarget) {
          rawValueUpdates.push({
            range: `${qTitle}!${gLet}${curRow1Based}`,
            values: [[scText]],
          });
        }
        reviewColValues.push([sIdx === 0 ? (proc?.reviewNote ?? "") : ""]);
        curRow1Based += 1;
      }
    }

    if (reviewColValues.length > 0) {
      rawValueUpdates.push({
        range: `${qTitle}!${lLet}${startDataRow1Based}:${lLet}${totalOutRows}`,
        values: reviewColValues,
      });
    }

    await authedSheetsJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}/values:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "RAW",
          data: rawValueUpdates,
        }),
      },
      fetchFn,
    );

    // Populate H:J formulas (keep H1:J2 untouched when source already had formulas so Row 1 notes/rulers stay intact!)
    if (plan.formulaCols) {
      const hLet = colIndexToLetters(plan.formulaCols[0]);
      const jLet = colIndexToLetters(plan.formulaCols[2]);
      const formulaStartRow = sheet.detectedFormulaCols.length >= 3 ? startDataRow1Based : 1;
      const formulaGrid: string[][] = [];
      for (let r = formulaStartRow; r <= totalOutRows; r += 1) {
        formulaGrid.push(buildFormulaRow(r, gLet, hLet));
      }
      if (formulaGrid.length > 0) {
        await authedSheetsJson(
          token,
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}/values:batchUpdate`,
          {
            method: "POST",
            body: JSON.stringify({
              valueInputOption: "USER_ENTERED",
              data: [
                {
                  range: `${qTitle}!${hLet}${formulaStartRow}:${jLet}${totalOutRows}`,
                  values: formulaGrid,
                },
              ],
            }),
          },
          fetchFn,
        );
      }
    }

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${destId}/edit?gid=${destSheetId}#gid=${destSheetId}`;
    return { spreadsheetId: destId, sheetId: destSheetId, sheetTitle: finalTitle, sheetUrl };
  }

  // Fallback when source came from local .xlsx/.csv rather than a Google Sheet
  const createReqs: Record<string, unknown>[] = [];
  if (colliding && overwriteExisting) {
    createReqs.push({ deleteSheet: { sheetId: colliding.sheetId } });
  }
  createReqs.push({
    addSheet: {
      properties: {
        title: finalTitle,
        gridProperties: {
          rowCount: Math.max(totalOutRows + 5, 50),
          columnCount: plan.totalOutCols,
          frozenRowCount: Math.max(1, sheet.frozenRowCount || sheet.headerRows.length),
        },
      },
    },
  });

  const addRes = await authedSheetsJson<{
    replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
  }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}:batchUpdate`,
    { method: "POST", body: JSON.stringify({ requests: createReqs }) },
    fetchFn,
  );
  destSheetId = addRes.replies?.find((r) => r.addSheet)?.addSheet?.properties?.sheetId ?? 0;

  const qTitle = quoteSheetRange(finalTitle);
  const fullGrid: string[][] = [];
  const formulaSet = new Set<number>(plan.formulaCols ?? []);

  sheet.headerRows.forEach((hRow, hIdx) => {
    const isMainHeader = hIdx === sheet.headerRows.length - 1;
    const arr = Array(plan.totalOutCols).fill("");
    for (let outCol = 0; outCol < plan.totalOutCols; outCol += 1) {
      if (formulaSet.has(outCol)) continue;
      if (outCol === plan.outReviewCol) {
        arr[outCol] = isMainHeader ? "核对备注" : "";
        continue;
      }
      const srcCol = plan.outToSrcCol[outCol];
      if (srcCol >= 0) arr[outCol] = hRow[srcCol] ?? "";
    }
    fullGrid.push(arr);
  });

  sheet.rows.forEach((srcRow, idx) => {
    const proc = run.results[idx];
    const screens = proc?.screens.length
      ? proc.screens
      : [{ text: srcRow.rawCells[sheet.columnMap.targetCol] ?? "" }];
    screens.forEach((sc, sIdx) => {
      const arr = Array(plan.totalOutCols).fill("");
      if (sIdx === 0) {
        for (let outCol = 0; outCol < plan.totalOutCols; outCol += 1) {
          if (formulaSet.has(outCol)) continue;
          if (outCol === plan.outReviewCol) {
            arr[outCol] = proc?.reviewNote ?? "";
            continue;
          }
          const srcCol = plan.outToSrcCol[outCol];
          if (srcCol >= 0) {
            arr[outCol] = srcCol === sheet.columnMap.targetCol ? sc.text : (srcRow.rawCells[srcCol] ?? "");
          }
        }
      } else {
        arr[plan.outTargetCol] = sc.text;
      }
      fullGrid.push(arr);
    });
  });

  await authedSheetsJson(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}/values/${encodeURIComponent(`${qTitle}!A1`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: fullGrid }) },
    fetchFn,
  );

  if (plan.formulaCols) {
    const gLet = colIndexToLetters(plan.outTargetCol);
    const hLet = colIndexToLetters(plan.formulaCols[0]);
    const jLet = colIndexToLetters(plan.formulaCols[2]);
    const formulaGrid: string[][] = [];
    for (let r = 1; r <= fullGrid.length; r += 1) {
      formulaGrid.push(buildFormulaRow(r, gLet, hLet));
    }
    await authedSheetsJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(destId)}/values:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "USER_ENTERED",
          data: [{ range: `${qTitle}!${hLet}1:${jLet}${fullGrid.length}`, values: formulaGrid }],
        }),
      },
      fetchFn,
    );
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${destId}/edit?gid=${destSheetId}#gid=${destSheetId}`;
  return { spreadsheetId: destId, sheetId: destSheetId, sheetTitle: finalTitle, sheetUrl };
}

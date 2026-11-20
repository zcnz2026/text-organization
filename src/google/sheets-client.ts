import type { RichSheetGrid } from "../catalog/catalog-types";
import { diagLog } from "../platform/diag-log";
import type {
  LanguageRunOutput,
  ScriptSheetDocument,
} from "../types/domain";
import { colLetterToIndex, indexToColLetter } from "../types/schema-config";

export interface SheetTabInfo {
  sheetId: number;
  title: string;
  index: number;
}

export interface SpreadsheetMeta {
  spreadsheetId: string;
  title: string;
  sheets: SheetTabInfo[];
}

export type TokenProvider = () => Promise<string>;

function quoteSheetRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export class GoogleSheetsClient {
  private getToken: TokenProvider;
  private fetchFn: typeof fetch;

  constructor(getToken: TokenProvider, fetchFn?: typeof fetch) {
    this.getToken = getToken;
    this.fetchFn = fetchFn
      ? (input, init) => fetchFn(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const token = await this.getToken();
    const resp = await this.fetchFn(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      diagLog.error("Google Sheets API", `HTTP ${resp.status} ${url.split("?")[0]}`, detail.slice(0, 400));
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `Google 表格权限不足或授权已过期 (HTTP ${resp.status})，请确认当前登录邮箱拥有该表格访问权限。详情: ${detail.slice(0, 140)}`,
        );
      }
      throw new Error(`Google Sheets 请求失败 (HTTP ${resp.status}): ${detail.slice(0, 160)}`);
    }
    return (await resp.json()) as T;
  }

  async getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,index)`;
    const data = await this.request<{
      spreadsheetId: string;
      properties?: { title?: string };
      sheets?: Array<{
        properties?: { sheetId?: number; title?: string; index?: number };
      }>;
    }>(url);

    return {
      spreadsheetId: data.spreadsheetId,
      title: data.properties?.title ?? "",
      sheets: (data.sheets ?? []).map((s, idx) => ({
        sheetId: s.properties?.sheetId ?? idx,
        title: s.properties?.title ?? `Sheet${idx + 1}`,
        index: s.properties?.index ?? idx,
      })),
    };
  }

  async resolveSheetTitle(
    spreadsheetId: string,
    gidOrTitle?: number | string | null,
  ): Promise<{ sheetId: number; title: string; meta: SpreadsheetMeta }> {
    const meta = await this.getSpreadsheetMeta(spreadsheetId);
    if (meta.sheets.length === 0) throw new Error("目标 Google 表格中没有任何工作表");
    if (typeof gidOrTitle === "number") {
      const found = meta.sheets.find((s) => s.sheetId === gidOrTitle);
      if (!found) throw new Error(`未在表格中找到 gid=${gidOrTitle} 对应的子表`);
      return { ...found, meta };
    }
    if (typeof gidOrTitle === "string" && gidOrTitle.trim()) {
      const want = gidOrTitle.trim().toLowerCase();
      const found = meta.sheets.find((s) => s.title.trim().toLowerCase() === want);
      if (found) return { ...found, meta };
    }
    return { ...meta.sheets[0], meta };
  }

  async fetchRichGrid(
    spreadsheetId: string,
    gidOrTitle?: number | string | null,
  ): Promise<{ title: string; sheetId: number; grid: RichSheetGrid }> {
    const target = await this.resolveSheetTitle(spreadsheetId, gidOrTitle);
    const rangeParam = encodeURIComponent(quoteSheetRange(target.title));
    const fields =
      "sheets(data(rowData(values(formattedValue,hyperlink,textFormatRuns/format/link/uri,chipRuns/chip/richLinkProperties/uri))))";
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?ranges=${rangeParam}&fields=${encodeURIComponent(fields)}`;
    const data = await this.request<{
      sheets?: Array<{
        data?: Array<{
          rowData?: Array<{
            values?: Array<{
              formattedValue?: string;
              hyperlink?: string;
              textFormatRuns?: Array<{ format?: { link?: { uri?: string } } }>;
              chipRuns?: Array<{ chip?: { richLinkProperties?: { uri?: string } } }>;
            }>;
          }>;
        }>;
      }>;
    }>(url);

    const rowData = data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const grid: RichSheetGrid = rowData.map((r) =>
      (r.values ?? []).map((v) => {
        const chipUri = v.chipRuns?.find((c) => c.chip?.richLinkProperties?.uri)?.chip?.richLinkProperties?.uri;
        const runUri = v.textFormatRuns?.find((t) => t.format?.link?.uri)?.format?.link?.uri;
        return {
          text: v.formattedValue ?? "",
          url: v.hyperlink || chipUri || runUri || undefined,
        };
      }),
    );
    return { title: target.title, sheetId: target.sheetId, grid };
  }

  async writeLanguageSheet(
    outputSpreadsheetId: string,
    sheetTitle: string,
    doc: ScriptSheetDocument,
    run: LanguageRunOutput,
    overwrite = true,
    outputHintCol = "AUTO",
  ): Promise<{ sheetId: number; sheetTitle: string }> {
    const meta = await this.getSpreadsheetMeta(outputSpreadsheetId);
    const maxBaseCols = Math.max(
      12,
      ...doc.headerRows.map((r) => r.length),
      ...doc.rows.map((r) => r.rawCells.length),
    );
    const cleanHint = (outputHintCol || "AUTO").trim().toUpperCase();
    const hintColIdx =
      cleanHint && cleanHint !== "AUTO"
        ? colLetterToIndex(cleanHint, maxBaseCols)
        : maxBaseCols;
    const hasBibleSource = run.rows.some((r) => Boolean(r.bibleSource));
    const bibleSourceColIdx = hasBibleSource ? hintColIdx + 1 : -1;
    const totalCols = Math.max(maxBaseCols + 1, hintColIdx + 1, bibleSourceColIdx + 1);
    const totalRows = doc.headerRows.length + doc.rows.length + 2;

    let finalTitle = sheetTitle.slice(0, 95);
    const existing = meta.sheets.find((s) => s.title === finalTitle);
    let sheetId = 0;
    let clonedFromSource = false;

    if (!overwrite && existing) {
      finalTitle = `${finalTitle}_${new Date().toISOString().slice(11, 16).replace(":", "")}`;
    }

    // Prefer cloning the original Google Sheet directly via copyTo to preserve 100% of fonts,
    // colors, font sizes, column widths, row heights, borders, and wraps.
    if (doc.sourceSpreadsheetId && doc.sourceSheetId !== undefined) {
      try {
        const copied = await this.request<{ sheetId: number; title: string }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(doc.sourceSpreadsheetId)}/sheets/${doc.sourceSheetId}:copyTo`,
          {
            method: "POST",
            body: JSON.stringify({ destinationSpreadsheetId: outputSpreadsheetId }),
          },
        );
        sheetId = copied.sheetId;
        const setupReqs: Record<string, unknown>[] = [];
        if (existing && overwrite) {
          setupReqs.push({ deleteSheet: { sheetId: existing.sheetId } });
        }
        setupReqs.push({
          updateSheetProperties: {
            properties: {
              sheetId,
              title: finalTitle,
              gridProperties: {
                rowCount: Math.max(totalRows, 100),
                columnCount: totalCols,
              },
            },
            fields: "title,gridProperties(rowCount,columnCount)",
          },
        });
        await this.request(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}:batchUpdate`,
          {
            method: "POST",
            body: JSON.stringify({ requests: setupReqs }),
          },
        );
        clonedFromSource = true;
      } catch {
        clonedFromSource = false;
      }
    }

    if (clonedFromSource) {
      // Write ONLY Target Language, Note, 【工具提示】, and optional 【圣经来源】 columns
      // using RAW so Google Sheets preserves leading straight single quotes (') verbatim.
      const headerRowNum = doc.headerRows.length;
      const startDataRow = headerRowNum + 1;
      const endDataRow = headerRowNum + doc.rows.length;
      const qTitle = quoteSheetRange(finalTitle);
      const targetColL = indexToColLetter(doc.columnMap.targetLanguage);
      const noteColL = indexToColLetter(doc.columnMap.note);
      const hintColL = indexToColLetter(hintColIdx);

      const valueRanges: Array<{ range: string; values: string[][] }> = [
        {
          range: `${qTitle}!${targetColL}${startDataRow}:${targetColL}${endDataRow}`,
          values: run.rows.map((r) => [r.targetLanguage ?? ""]),
        },
        {
          range: `${qTitle}!${noteColL}${startDataRow}:${noteColL}${endDataRow}`,
          values: run.rows.map((r) => [r.note ?? ""]),
        },
        {
          range: `${qTitle}!${hintColL}${headerRowNum}:${hintColL}${endDataRow}`,
          values: [["【工具提示】"], ...run.rows.map((r) => [r.hint || ""])],
        },
      ];

      if (hasBibleSource && bibleSourceColIdx >= 0) {
        const srcColL = indexToColLetter(bibleSourceColIdx);
        valueRanges.push({
          range: `${qTitle}!${srcColL}${headerRowNum}:${srcColL}${endDataRow}`,
          values: [["【圣经来源】"], ...run.rows.map((r) => [r.bibleSource || ""])],
        });
      }

      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}/values:batchUpdate`,
        {
          method: "POST",
          body: JSON.stringify({
            valueInputOption: "RAW",
            data: valueRanges,
          }),
        },
      );
    } else {
      if (existing && overwrite) {
        sheetId = existing.sheetId;
        await this.request(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}:batchUpdate`,
          {
            method: "POST",
            body: JSON.stringify({
              requests: [
                {
                  updateSheetProperties: {
                    properties: {
                      sheetId,
                      gridProperties: {
                        rowCount: Math.max(totalRows, 100),
                        columnCount: totalCols,
                        frozenRowCount: doc.headerRows.length,
                      },
                    },
                    fields: "gridProperties(rowCount,columnCount,frozenRowCount)",
                  },
                },
                {
                  repeatCell: {
                    range: { sheetId },
                    cell: { userEnteredFormat: {} },
                    fields: "userEnteredFormat.backgroundColor",
                  },
                },
              ],
            }),
          },
        );
        await this.request(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}/values/${encodeURIComponent(quoteSheetRange(finalTitle))}:clear`,
          { method: "POST", body: "{}" },
        );
      } else {
        const addRes = await this.request<{
          replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
        }>(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}:batchUpdate`,
          {
            method: "POST",
            body: JSON.stringify({
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: finalTitle,
                      gridProperties: {
                        rowCount: Math.max(totalRows, 100),
                        columnCount: totalCols,
                        frozenRowCount: doc.headerRows.length,
                      },
                    },
                  },
                },
              ],
            }),
          },
        );
        sheetId = addRes.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
      }

      const outValues: string[][] = doc.headerRows.map((hr, idx) => {
        const padded = [...hr];
        while (padded.length < totalCols) padded.push("");
        padded[hintColIdx] = idx === doc.headerRows.length - 1 ? "【工具提示】" : "";
        if (hasBibleSource && bibleSourceColIdx >= 0) {
          padded[bibleSourceColIdx] = idx === doc.headerRows.length - 1 ? "【圣经来源】" : "";
        }
        return padded;
      });

      for (let i = 0; i < doc.rows.length; i += 1) {
        const src = doc.rows[i];
        const res = run.rows[i];
        const rowArr = [...src.rawCells];
        while (rowArr.length < totalCols) rowArr.push("");
        rowArr[doc.columnMap.targetLanguage] = res.targetLanguage;
        rowArr[doc.columnMap.note] = res.note;
        rowArr[hintColIdx] = res.hint || "";
        if (hasBibleSource && bibleSourceColIdx >= 0) {
          rowArr[bibleSourceColIdx] = res.bibleSource || "";
        }
        outValues.push(rowArr);
      }

      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}/values/${encodeURIComponent(`${quoteSheetRange(finalTitle)}!A1`)}?valueInputOption=RAW`,
        {
          method: "PUT",
          body: JSON.stringify({ values: outValues }),
        },
      );
    }

    // Apply status background colors ONLY to the 【工具提示】 column (preserve all original column styles!)
    const colorRequests: Record<string, unknown>[] = [];
    if (!clonedFromSource) {
      colorRequests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: doc.headerRows.length - 1,
            endRowIndex: doc.headerRows.length,
            startColumnIndex: 0,
            endColumnIndex: totalCols,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.91, green: 0.94, blue: 0.96 },
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat.bold)",
        },
      });
    } else {
      colorRequests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: doc.headerRows.length - 1,
            endRowIndex: doc.headerRows.length,
            startColumnIndex: hintColIdx,
            endColumnIndex: hasBibleSource ? bibleSourceColIdx + 1 : hintColIdx + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.91, green: 0.94, blue: 0.96 },
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat.bold)",
        },
      });
    }

    const headerOffset = doc.headerRows.length;
    for (let i = 0; i < run.rows.length; i += 1) {
      const st = run.rows[i].status;
      if (st === "untouched") continue;
      const bg =
        st === "missing"
          ? { red: 0.99, green: 0.89, blue: 0.89 }
          : st === "warning"
            ? { red: 1.0, green: 0.96, blue: 0.84 }
            : { red: 0.93, green: 0.98, blue: 0.95 };

      colorRequests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: headerOffset + i,
            endRowIndex: headerOffset + i + 1,
            startColumnIndex: hintColIdx,
            endColumnIndex: hintColIdx + 1,
          },
          cell: { userEnteredFormat: { backgroundColor: bg } },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
    }

    if (colorRequests.length > 0) {
      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}:batchUpdate`,
        {
          method: "POST",
          body: JSON.stringify({ requests: colorRequests }),
        },
      );
    }

    return { sheetId, sheetTitle: finalTitle };
  }
}

import type { RichSheetGrid } from "../catalog/catalog-types";
import type {
  LanguageRunOutput,
  ScriptSheetDocument,
} from "../types/domain";

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

  constructor(getToken: TokenProvider, fetchFn: typeof fetch = fetch) {
    this.getToken = getToken;
    this.fetchFn = fetchFn;
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
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `Google 表格权限不足或授权已过期 (HTTP ${resp.status})，请确认当前登录邮箱拥有该表格访问权限`,
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
    if (meta.sheets.length === 0) {
      throw new Error("目标 Google 表格中没有任何工作表");
    }

    if (typeof gidOrTitle === "number") {
      const found = meta.sheets.find((s) => s.sheetId === gidOrTitle);
      if (!found) {
        throw new Error(`未在表格中找到 gid=${gidOrTitle} 对应的子表`);
      }
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
  ): Promise<{ title: string; grid: RichSheetGrid }> {
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
              chipRuns?: Array<{
                chip?: { richLinkProperties?: { uri?: string } };
              }>;
            }>;
          }>;
        }>;
      }>;
    }>(url);

    const rowData = data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const grid: RichSheetGrid = rowData.map((r) =>
      (r.values ?? []).map((v) => {
        const chipUri = v.chipRuns?.find((c) => c.chip?.richLinkProperties?.uri)
          ?.chip?.richLinkProperties?.uri;
        const runUri = v.textFormatRuns?.find((t) => t.format?.link?.uri)?.format
          ?.link?.uri;
        return {
          text: v.formattedValue ?? "",
          url: v.hyperlink || chipUri || runUri || undefined,
        };
      }),
    );

    return { title: target.title, grid };
  }

  async writeLanguageSheet(
    outputSpreadsheetId: string,
    sheetTitle: string,
    doc: ScriptSheetDocument,
    run: LanguageRunOutput,
    overwrite = true,
  ): Promise<{ sheetId: number; sheetTitle: string }> {
    const meta = await this.getSpreadsheetMeta(outputSpreadsheetId);
    const maxBaseCols = Math.max(
      12,
      ...doc.headerRows.map((r) => r.length),
      ...doc.rows.map((r) => r.rawCells.length),
    );
    const hintColIdx = maxBaseCols;
    const totalCols = maxBaseCols + 1;
    const totalRows = doc.headerRows.length + doc.rows.length + 2;

    let finalTitle = sheetTitle.slice(0, 95);
    const existing = meta.sheets.find((s) => s.title === finalTitle);
    let sheetId: number;

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
      if (existing) {
        finalTitle = `${finalTitle}_${new Date().toISOString().slice(11, 16).replace(":", "")}`;
      }
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
      while (padded.length < maxBaseCols) padded.push("");
      padded.push(idx === doc.headerRows.length - 1 ? "【工具提示】" : "");
      return padded;
    });

    for (let i = 0; i < doc.rows.length; i += 1) {
      const src = doc.rows[i];
      const res = run.rows[i];
      const rowArr = [...src.rawCells];
      while (rowArr.length < maxBaseCols) rowArr.push("");
      rowArr[doc.columnMap.targetLanguage] = res.targetLanguage;
      rowArr[doc.columnMap.note] = res.note;
      rowArr.push(res.hint || "");
      outValues.push(rowArr);
    }

    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(outputSpreadsheetId)}/values/${encodeURIComponent(`${quoteSheetRange(finalTitle)}!A1`)}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ values: outValues }),
      },
    );

    const colorRequests: Record<string, unknown>[] = [
      {
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
      },
    ];

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

      for (const colIdx of [doc.columnMap.targetLanguage, hintColIdx]) {
        colorRequests.push({
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: headerOffset + i,
              endRowIndex: headerOffset + i + 1,
              startColumnIndex: colIdx,
              endColumnIndex: colIdx + 1,
            },
            cell: { userEnteredFormat: { backgroundColor: bg } },
            fields: "userEnteredFormat.backgroundColor",
          },
        });
      }
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

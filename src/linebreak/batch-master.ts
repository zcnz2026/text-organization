import type { TokenProvider } from "../google/sheets-client";
import { parseGoogleResourceUrl } from "../google/url-parser";
import { inspectGoogleSpreadsheetTabs } from "./google-sheet-io";
import { detectLanguageSpecFromText, getActiveLineBreakSpecs } from "./presets";
import type { BatchLineBreakItem, BatchMasterQueue } from "./types";
import { parseXlsxFirstSheetRawRows } from "./xlsx-reader";

function quoteSheetRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

interface RawMasterRow {
  excelRow: number;
  colAText: string;
  colBText: string;
  extractedUrl: string;
}

interface GridCellValue {
  formattedValue?: string;
  hyperlink?: string;
  chipRuns?: Array<{
    chip?: {
      richLinkProperties?: {
        uri?: string;
      };
    };
  }>;
}

function extractCellUrl(cell?: GridCellValue): string {
  if (!cell) return "";
  const candidates = [
    cell.hyperlink ?? "",
    ...(cell.chipRuns ?? []).map((cr) => cr.chip?.richLinkProperties?.uri ?? ""),
    cell.formattedValue ?? "",
  ];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    const parsed = parseGoogleResourceUrl(trimmed, "sheet");
    if (parsed && parsed.kind === "sheet") {
      return trimmed;
    }
  }
  return "";
}

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  if (items.length === 0) return [];
  const maxWorkers = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: maxWorkers }, async () => {
    while (cursor < items.length) {
      if (shouldStop?.()) return;
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function hydrateBatchItems(
  rawRows: RawMasterRow[],
  getAccessToken?: TokenProvider,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<BatchLineBreakItem[]> {
  return runWithConcurrency(rawRows, 4, async (row, idx) => {
    const parsed = parseGoogleResourceUrl(row.extractedUrl, "sheet");
    const spreadsheetId = parsed?.id ?? "";
    const urlGid = parsed?.gid ?? null;
    const label = row.colAText.trim() || `第 ${row.excelRow} 行表格`;

    const detectedFromLabel = detectLanguageSpecFromText(label);
    let langSpec = detectedFromLabel ?? getActiveLineBreakSpecs()[0];
    let langDetected = Boolean(detectedFromLabel);

    let spreadsheetTitle = label;
    let availableTabs: BatchLineBreakItem["availableTabs"] = [];
    let selectedSheetId = urlGid ?? 0;
    let selectedSheetTitle = "";
    let needsSheetConfirm = false;
    let errorMessage: string | undefined;

    if (getAccessToken && spreadsheetId) {
      try {
        const info = await inspectGoogleSpreadsheetTabs(row.extractedUrl, getAccessToken, fetchFn);
        spreadsheetTitle = info.spreadsheetTitle;
        availableTabs = info.sourceCandidateTabs;

        const gidMatch =
          urlGid !== null ? availableTabs.find((t) => t.sheetId === urlGid) : undefined;
        const chosen = gidMatch ?? availableTabs[0];
        if (chosen) {
          selectedSheetId = chosen.sheetId;
          selectedSheetTitle = chosen.title;
        }

        // Requirement #3: whenever a spreadsheet has multiple candidate sheets, alert and require human confirmation!
        if (availableTabs.length > 1) {
          needsSheetConfirm = true;
        }

        if (!langDetected) {
          const fallbackDetect =
            detectLanguageSpecFromText(selectedSheetTitle) ??
            detectLanguageSpecFromText(spreadsheetTitle);
          if (fallbackDetect) {
            langSpec = fallbackDetect;
            langDetected = true;
          }
        }
      } catch (err) {
        errorMessage =
          err instanceof Error
            ? `无法读取表格元数据：${err.message}`
            : "无法读取该表格元数据（请检查权限）";
      }
    }

    return {
      id: `batch_${row.excelRow}_${idx}`,
      masterExcelRow: row.excelRow,
      label,
      sourceUrl: row.extractedUrl,
      spreadsheetId,
      spreadsheetTitle,
      langCode: langSpec.code,
      langDetected,
      availableTabs,
      selectedSheetId,
      selectedSheetTitle: selectedSheetTitle || "默认工作表",
      needsSheetConfirm,
      status: errorMessage
        ? "error"
        : needsSheetConfirm
          ? "pending_confirm_sheet"
          : "queued",
      doneAiRows: 0,
      totalAiRows: 0,
      reviewCount: 0,
      totalOutputScreens: 0,
      errorMessage,
    };
  });
}

export interface LoadBatchMasterOptions {
  getAccessToken?: TokenProvider;
  fetchPublicXlsxBytes?: (spreadsheetId: string) => Promise<Uint8Array>;
  fetchFn?: typeof fetch;
}

/**
 * Loads the Batch Master Sheet (e.g. "测试断行" where Col A = spreadsheet name with language, Col B = Google Sheet URL).
 * Handles headerless master sheets (Row 1 is already a language entry), Smart Chips, hyperlinks, and multi-sheet inspection.
 */
export async function loadBatchMasterQueueFromGoogleUrl(
  masterUrl: string,
  options: LoadBatchMasterOptions,
): Promise<BatchMasterQueue> {
  const parsed = parseGoogleResourceUrl(masterUrl, "sheet");
  if (!parsed || parsed.kind !== "sheet") {
    throw new Error("请输入有效的批量总表 Google 表格链接");
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  if (options.getAccessToken) {
    const token = await options.getAccessToken();
    if (token) {
      const metaResp = await fetchFn(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(parsed.id)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,hidden)`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!metaResp.ok) {
        const detail = await metaResp.text().catch(() => "");
        throw new Error(`读取批量总表失败 (HTTP ${metaResp.status}): ${detail.slice(0, 160)}`);
      }
      const meta = (await metaResp.json()) as {
        properties?: { title?: string };
        sheets?: Array<{ properties?: { sheetId?: number; title?: string; hidden?: boolean } }>;
      };
      const tabs = (meta.sheets ?? []).map((s, idx) => ({
        sheetId: s.properties?.sheetId ?? idx,
        title: s.properties?.title ?? `Sheet${idx + 1}`,
        hidden: Boolean(s.properties?.hidden),
      }));
      const targetTab =
        parsed.gid !== null
          ? (tabs.find((t) => t.sheetId === parsed.gid) ?? tabs[0])
          : (tabs.find((t) => !t.hidden) ?? tabs[0]);

      if (!targetTab) {
        throw new Error("批量总表中未找到工作表");
      }

      const rangeParam = encodeURIComponent(quoteSheetRange(targetTab.title));
      const fields =
        "sheets.data.rowData.values(formattedValue,hyperlink,chipRuns.chip.richLinkProperties.uri)";
      const dataResp = await fetchFn(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(parsed.id)}?ranges=${rangeParam}&fields=${encodeURIComponent(fields)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!dataResp.ok) {
        const detail = await dataResp.text().catch(() => "");
        throw new Error(`读取总表内容失败 (HTTP ${dataResp.status}): ${detail.slice(0, 160)}`);
      }
      const full = (await dataResp.json()) as {
        sheets?: Array<{
          data?: Array<{
            rowData?: Array<{ values?: GridCellValue[] }>;
          }>;
        }>;
      };

      const rowData = full.sheets?.[0]?.data?.[0]?.rowData ?? [];
      const rawRows: RawMasterRow[] = [];

      rowData.forEach((r, rIdx) => {
        const colA = r.values?.[0];
        const colB = r.values?.[1];
        const colAText = (colA?.formattedValue ?? "").trim();
        const colBText = (colB?.formattedValue ?? "").trim();
        const url = extractCellUrl(colB) || extractCellUrl(colA);
        if (!url) return;
        rawRows.push({
          excelRow: rIdx + 1,
          colAText: colAText || colBText,
          colBText,
          extractedUrl: url,
        });
      });

      if (rawRows.length === 0) {
        throw new Error("未在总表 A/B 列识别到有效的 Google 表格链接，请检查总表格式");
      }

      const items = await hydrateBatchItems(rawRows, options.getAccessToken, fetchFn);
      return {
        masterUrl: masterUrl.trim(),
        masterSpreadsheetId: parsed.id,
        masterSheetTitle: targetTab.title,
        items,
      };
    }
  }

  if (options.fetchPublicXlsxBytes) {
    const bytes = await options.fetchPublicXlsxBytes(parsed.id);
    const q = await loadBatchMasterQueueFromXlsxBytes(bytes, options);
    q.masterUrl = masterUrl.trim();
    q.masterSpreadsheetId = parsed.id;
    return q;
  }

  throw new Error("请先在右上角「设置 → Google OAuth 2.0 授权」登录账号后再读取批量总表");
}

export async function loadBatchMasterQueueFromXlsxBytes(
  bytes: Uint8Array,
  options: LoadBatchMasterOptions,
): Promise<BatchMasterQueue> {
  const sheetRows = await parseXlsxFirstSheetRawRows(bytes);
  const rawRows: RawMasterRow[] = [];

  sheetRows.forEach((r, idx) => {
    const a = (r[0] ?? "").trim();
    const b = (r[1] ?? "").trim();
    const parsedB = parseGoogleResourceUrl(b, "sheet");
    const parsedA = parseGoogleResourceUrl(a, "sheet");
    const url = parsedB?.kind === "sheet" ? b : parsedA?.kind === "sheet" ? a : "";
    if (!url) return;
    rawRows.push({
      excelRow: idx + 1,
      colAText: a || b,
      colBText: b,
      extractedUrl: url,
    });
  });

  if (rawRows.length === 0) {
    throw new Error("未在本地总表 A/B 列识别到有效的 Google 表格链接");
  }

  const items = await hydrateBatchItems(
    rawRows,
    options.getAccessToken,
    options.fetchFn ?? globalThis.fetch,
  );
  return {
    masterUrl: "",
    items,
  };
}

/**
 * Writes processing status & result tab URL back into Col C & Col D of the Master Google Sheet
 * without touching Col A or Col B formatting / Smart Chips!
 */
export async function writeStatusBackToBatchMasterSheet(
  queue: BatchMasterQueue,
  item: BatchLineBreakItem,
  statusText: string,
  resultUrl: string,
  getAccessToken: TokenProvider,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!queue.masterSpreadsheetId || !queue.masterSheetTitle) return;
  const token = await getAccessToken();
  if (!token) return;

  const qTitle = quoteSheetRange(queue.masterSheetTitle);
  const rowNum = item.masterExcelRow;
  const data: Array<{ range: string; values: string[][] }> = [
    {
      range: `${qTitle}!C${rowNum}:D${rowNum}`,
      values: [[statusText, resultUrl]],
    },
  ];

  // Only populate C1:D1 header if Row 1 was a header row (NOT a data row like in "测试断行")
  const row1IsData = queue.items.some((it) => it.masterExcelRow === 1);
  if (!row1IsData && rowNum > 1) {
    data.unshift({
      range: `${qTitle}!C1:D1`,
      values: [["断行处理状态", "结果Sheet链接"]],
    });
  }

  await fetchFn(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(queue.masterSpreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption: "RAW",
        data,
      }),
    },
  ).catch(() => {
    // Master sheet might be read-only for some users; ignore write-back failure gracefully
  });
}

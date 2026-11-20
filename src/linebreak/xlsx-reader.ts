import { parseCsvToGrid } from "../engine/csv-sheet";
import { colLetterToIndex } from "../types/schema-config";
import { isGreenFillRgb } from "./tokenizer";
import type {
  ImportedSubtitleRow,
  ImportedSubtitleSheet,
  ImportedSubtitleWorkbook,
  SubtitleSheetColumnMap,
} from "./types";

const MAX_XLSX_XML_BYTES = 48 * 1024 * 1024;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  void writer.write(copy);
  void writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_XLSX_XML_BYTES) {
      await reader.cancel();
      throw new Error(".xlsx 解压体积超过安全上限 (48MB)");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

export async function unzipXlsxXmlEntries(
  zipBytes: Uint8Array,
): Promise<Map<string, string>> {
  const view = new DataView(
    zipBytes.buffer,
    zipBytes.byteOffset,
    zipBytes.byteLength,
  );
  const dec = new TextDecoder("utf-8");

  let eocdPos = -1;
  for (
    let i = zipBytes.byteLength - 22;
    i >= Math.max(0, zipBytes.byteLength - 65558);
    i -= 1
  ) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error("无效的 .xlsx 文件（未找到 ZIP 目录尾记录）");
  }

  const entryCount = view.getUint16(eocdPos + 10, true);
  let cdOffset = view.getUint32(eocdPos + 16, true);
  const entries = new Map<string, string>();

  for (let idx = 0; idx < entryCount; idx += 1) {
    if (cdOffset + 46 > zipBytes.byteLength || view.getUint32(cdOffset, true) !== 0x02014b50) {
      break;
    }
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const fileName = dec.decode(
      zipBytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen),
    );
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (!/\.(?:xml|rels)$/i.test(fileName)) continue;

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = zipBytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries.set(fileName, dec.decode(rawSlice));
    } else if (method === 8) {
      const inflated = await inflateRawBytes(rawSlice);
      entries.set(fileName, dec.decode(inflated));
    }
  }
  return entries;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) ?? [];
  return items.map((si) => {
    const tNodes = si.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) ?? [];
    return tNodes
      .map((t) =>
        decodeXmlEntities(t.replace(/^<t(?:\s[^>]*)?>/, "").replace(/<\/t>$/, "")),
      )
      .join("");
  });
}

interface ParsedCellXf {
  fillRgb: string | null;
  fontRgb: string | null;
  bold: boolean;
}

function parseStylesMeta(stylesXml: string | undefined): ParsedCellXf[] {
  if (!stylesXml) return [];

  const fontsBlock = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)?.[1] ?? "";
  const fontTags = fontsBlock.match(/<font\b[\s\S]*?<\/font>/g) ?? [];
  const fontMetaById = fontTags.map((fXml) => {
    let bold = false;
    if (/<b\s*\/>/.test(fXml)) bold = true;
    else {
      const bVal = /<b\b[^>]*\bval="([^"]+)"/.exec(fXml)?.[1];
      bold = bVal ? bVal !== "0" && bVal.toLowerCase() !== "false" : false;
    }
    const cMatch = /<color\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(fXml);
    const hex6 = cMatch ? cMatch[1].slice(-6).toUpperCase() : null;
    const fontRgb = hex6 && hex6 !== "000000" && hex6 !== "FFFFFF" ? hex6 : null;
    return { bold, fontRgb };
  });

  const fillsBlock = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml)?.[1] ?? "";
  const fillTags = fillsBlock.match(/<fill\b[\s\S]*?<\/fill>/g) ?? [];
  const fillRgbByFillId: Array<string | null> = fillTags.map((fXml) => {
    const patMatch = /patternType="([^"]+)"/.exec(fXml);
    if (!patMatch || patMatch[1] === "none" || patMatch[1] === "gray125" || patMatch[1] === "lightGray") {
      return null;
    }
    const rgbMatch = /<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(fXml);
    if (!rgbMatch) return null;
    const hex6 = rgbMatch[1].slice(-6).toUpperCase();
    return hex6 === "000000" || hex6 === "FFFFFF" ? null : hex6;
  });

  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  const xfTags = cellXfsBlock.match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  return xfTags.map((xfXml) => {
    const fillIdMatch = /\bfillId="(\d+)"/.exec(xfXml);
    const fontIdMatch = /\bfontId="(\d+)"/.exec(xfXml);
    const fillRgb = fillIdMatch ? (fillRgbByFillId[parseInt(fillIdMatch[1], 10)] ?? null) : null;
    const fMeta = fontIdMatch ? fontMetaById[parseInt(fontIdMatch[1], 10)] : undefined;
    return {
      fillRgb,
      fontRgb: fMeta?.fontRgb ?? null,
      bold: fMeta?.bold ?? false,
    };
  });
}

function parseWorkbookSheetTargets(
  workbookXml: string,
  relsXml: string,
): Array<{ name: string; xmlPath: string }> {
  const relMap = new Map<string, string>();
  const relTags = relsXml.match(/<Relationship\b[^>]*\/?>/g) ?? [];
  for (const rTag of relTags) {
    const id = /\bId="([^"]+)"/.exec(rTag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rTag)?.[1];
    if (id && target) {
      const normalized = target.startsWith("/")
        ? target.slice(1)
        : target.startsWith("xl/")
          ? target
          : `xl/${target}`;
      relMap.set(id, normalized);
    }
  }

  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/?>/g) ?? [];
  const out: Array<{ name: string; xmlPath: string }> = [];
  for (const sTag of sheetTags) {
    const rawName = /\bname="([^"]+)"/.exec(sTag)?.[1] ?? "Sheet1";
    const rId = /\br:id="([^"]+)"/.exec(sTag)?.[1] ?? "";
    const xmlPath = relMap.get(rId);
    if (xmlPath) {
      out.push({ name: decodeXmlEntities(rawName), xmlPath });
    }
  }
  return out;
}

function parseWorksheetColsMeta(
  wsXml: string,
  maxCols: number,
): { colWidths: Array<number | null>; colHidden: boolean[]; frozenRowCount: number } {
  const defColWMatch = /<sheetFormatPr\b[^>]*\bdefaultColWidth="([0-9.]+)"/.exec(wsXml)?.[1];
  const defColW = defColWMatch ? parseFloat(defColWMatch) : null;
  const colWidths: Array<number | null> = Array(maxCols).fill(defColW);
  const colHidden: boolean[] = Array(maxCols).fill(false);

  const colsBlock = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(wsXml)?.[1] ?? "";
  const colTags = colsBlock.match(/<col\b[^>]*\/?>/g) ?? [];
  for (const tag of colTags) {
    const min = parseInt(/\bmin="(\d+)"/.exec(tag)?.[1] ?? "0", 10);
    const max = parseInt(/\bmax="(\d+)"/.exec(tag)?.[1] ?? "0", 10);
    const widthStr = /\bwidth="([0-9.]+)"/.exec(tag)?.[1];
    const hiddenAttr = /\bhidden="([^"]+)"/.exec(tag)?.[1];
    const isHidden = hiddenAttr === "1" || hiddenAttr === "true";
    const w = widthStr ? parseFloat(widthStr) : defColW;
    if (min >= 1 && max >= min) {
      for (let c1 = min; c1 <= Math.min(max, maxCols); c1 += 1) {
        colWidths[c1 - 1] = w;
        colHidden[c1 - 1] = isHidden;
      }
    }
  }

  const ySplitStr = /<pane\b[^>]*\bySplit="([0-9.]+)"/.exec(wsXml)?.[1];
  const frozenRowCount = ySplitStr ? Math.round(parseFloat(ySplitStr)) : 2;
  return { colWidths, colHidden, frozenRowCount };
}

function parseWorksheet(
  sheetName: string,
  wsXml: string,
  sharedStrings: string[],
  stylesMeta: ParsedCellXf[],
): ImportedSubtitleSheet {
  const rowTags = wsXml.match(/<row\b[\s\S]*?<\/row>/g) ?? [];
  const parsedRows: Array<{
    excelRow: number;
    cells: string[];
    fills: Array<string | null>;
    fontColors: Array<string | null>;
    bolds: boolean[];
  }> = [];
  const formulaColCounts = new Map<number, number>();
  let maxCols = 0;

  for (let idx = 0; idx < rowTags.length; idx += 1) {
    const rXml = rowTags[idx];
    const rNumAttr = /^<row\b[^>]*\br="(\d+)"/.exec(rXml)?.[1];
    const excelRow = rNumAttr ? parseInt(rNumAttr, 10) : idx + 1;
    const cTags = rXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];

    const cells: string[] = [];
    const fills: Array<string | null> = [];
    const fontColors: Array<string | null> = [];
    const bolds: boolean[] = [];

    for (let cPos = 0; cPos < cTags.length; cPos += 1) {
      const cXml = cTags[cPos];
      const refAttr = /\br="([A-Z]+)\d+"/.exec(cXml)?.[1];
      const colIdx = refAttr ? colLetterToIndex(refAttr, cPos) : cPos;
      const sAttr = /\bs="(\d+)"/.exec(cXml)?.[1];
      const tAttr = /\bt="([^"]+)"/.exec(cXml)?.[1] ?? "";
      const xf = sAttr ? stylesMeta[parseInt(sAttr, 10)] : undefined;
      const fillRgb = xf?.fillRgb ?? null;
      const fontRgb = xf?.fontRgb ?? null;
      const isBold = xf?.bold ?? false;

      const fMatch = /<f(?:\s([^>]*))?>([\s\S]*?)<\/f>/.exec(cXml);
      if (fMatch) {
        const fAttrs = fMatch[1] ?? "";
        const fText = decodeXmlEntities(fMatch[2]);
        if (/\b(?:LEN|SEARCH|LEFT|RIGHT)\s*\(/i.test(fText)) {
          const bonus = /\bt="shared"/.test(fAttrs) ? 5 : 1;
          formulaColCounts.set(colIdx, (formulaColCounts.get(colIdx) ?? 0) + bonus);
        }
      }

      let val = "";
      if (tAttr === "s") {
        const vStr = /<v>([\s\S]*?)<\/v>/.exec(cXml)?.[1] ?? "";
        const sIdx = parseInt(vStr.trim(), 10);
        val = Number.isNaN(sIdx) ? "" : (sharedStrings[sIdx] ?? "");
      } else if (tAttr === "inlineStr") {
        const tNodes = cXml.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) ?? [];
        val = tNodes
          .map((t) => decodeXmlEntities(t.replace(/^<t(?:\s[^>]*)?>/, "").replace(/<\/t>$/, "")))
          .join("");
      } else {
        const vStr = /<v>([\s\S]*?)<\/v>/.exec(cXml)?.[1];
        val = vStr !== undefined ? decodeXmlEntities(vStr) : "";
      }

      while (cells.length <= colIdx) {
        cells.push("");
        fills.push(null);
        fontColors.push(null);
        bolds.push(false);
      }
      cells[colIdx] = val;
      fills[colIdx] = fillRgb;
      fontColors[colIdx] = fontRgb;
      bolds[colIdx] = isBold;
    }

    if (cells.length > maxCols) maxCols = cells.length;
    parsedRows.push({ excelRow, cells, fills, fontColors, bolds });
  }

  // Ensure dense rows 1..N (if Row 1 was completely empty and omitted in XML, restore Row 1)
  if (parsedRows.length > 0 && parsedRows[0].excelRow === 2) {
    parsedRows.unshift({
      excelRow: 1,
      cells: Array(maxCols).fill(""),
      fills: Array(maxCols).fill(null),
      fontColors: Array(maxCols).fill(null),
      bolds: Array(maxCols).fill(false),
    });
  }

  for (const r of parsedRows) {
    while (r.cells.length < maxCols) {
      r.cells.push("");
      r.fills.push(null);
      r.fontColors.push(null);
      r.bolds.push(false);
    }
  }

  const detectedFormulaCols = [...formulaColCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([col]) => col)
    .sort((a, b) => a - b);

  const meta = parseWorksheetColsMeta(wsXml, maxCols);
  return structureParsedSubtitleSheet(sheetName, parsedRows, detectedFormulaCols, meta);
}

export function structureParsedSubtitleSheet(
  sheetName: string,
  parsedRows: Array<{
    excelRow: number;
    cells: string[];
    fills: Array<string | null>;
    fontColors?: Array<string | null>;
    bolds: boolean[];
  }>,
  detectedFormulaCols: number[],
  meta?: {
    sourceSpreadsheetId?: string;
    sourceSheetId?: number;
    frozenRowCount?: number;
    colWidths?: Array<number | null>;
    colHidden?: boolean[];
  },
): ImportedSubtitleSheet {
  let headerEndIdx = 1;
  for (let i = 0; i < Math.min(4, parsedRows.length); i += 1) {
    const joined = parsedRows[i].cells.join(" ");
    if (/\b(?:Line|In\s*Time|Character|Chinese|English|Target\s*Language)\b|字幕|角色|中文/i.test(joined)) {
      headerEndIdx = i + 1;
      break;
    }
  }

  const maxCols = parsedRows[0]?.cells.length ?? 0;
  if (parsedRows.length === 0) {
    return {
      sheetName,
      sourceSpreadsheetId: meta?.sourceSpreadsheetId,
      sourceSheetId: meta?.sourceSheetId,
      frozenRowCount: meta?.frozenRowCount ?? 2,
      colWidths: [],
      colHidden: [],
      headerRows: [],
      headerFillRgb: [],
      headerFontRgb: [],
      headerBold: [],
      detectedFormulaCols: [],
      columnMap: defaultColMap(6),
      rows: [],
    };
  }

  const headerSlice = parsedRows.slice(0, headerEndIdx);
  const mainHeader = headerSlice[headerSlice.length - 1]?.cells ?? [];
  const dataSlice = parsedRows.slice(headerEndIdx);

  const columnMap = detectSubtitleColumnMap(
    mainHeader,
    dataSlice.slice(0, 25).map((r) => r.cells),
    new Set(detectedFormulaCols),
  );

  const rows: ImportedSubtitleRow[] = dataSlice.map((r, idx) => {
    const targetFill = r.fills[columnMap.targetCol] ?? null;
    const greenCount = r.fills.filter((f) => isGreenFillRgb(f)).length;
    const isGreenHighlight = isGreenFillRgb(targetFill) || greenCount >= 3;
    const isGrayHighlight = targetFill === "D9D9D9" || targetFill === "CCCCCC";
    return {
      rowIndex: idx,
      excelRowNumber: r.excelRow,
      rawCells: r.cells,
      cellFillRgb: r.fills,
      cellFontRgb: r.fontColors ?? Array(maxCols).fill(null),
      cellBold: r.bolds,
      isGreenHighlight,
      isGrayHighlight,
    };
  });

  return {
    sheetName,
    sourceSpreadsheetId: meta?.sourceSpreadsheetId,
    sourceSheetId: meta?.sourceSheetId,
    frozenRowCount: meta?.frozenRowCount ?? headerEndIdx,
    colWidths: meta?.colWidths ?? Array(maxCols).fill(null),
    colHidden: meta?.colHidden ?? Array(maxCols).fill(false),
    headerRows: headerSlice.map((h) => h.cells),
    headerFillRgb: headerSlice.map((h) => h.fills),
    headerFontRgb: headerSlice.map((h) => h.fontColors ?? Array(maxCols).fill(null)),
    headerBold: headerSlice.map((h) => h.bolds),
    detectedFormulaCols,
    columnMap,
    rows,
  };
}

function defaultColMap(targetCol: number): SubtitleSheetColumnMap {
  return {
    lineCol: 0,
    inTimeCol: 1,
    outTimeCol: 2,
    characterCol: 3,
    chineseCol: 4,
    englishCol: 5,
    targetCol,
    citationCol: -1,
    noteCol: -1,
  };
}

export function detectSubtitleColumnMap(
  headerRow: string[],
  sampleDataRows: string[][],
  formulaCols: Set<number>,
): SubtitleSheetColumnMap {
  const findCol = (re: RegExp, excludeRe?: RegExp): number => {
    for (let i = 0; i < headerRow.length; i += 1) {
      if (formulaCols.has(i)) continue;
      const h = (headerRow[i] ?? "").trim();
      if (!h) continue;
      if (excludeRe && excludeRe.test(h)) continue;
      if (re.test(h)) return i;
    }
    return -1;
  };

  const lineCol = findCol(/^(?:line|序号|行号|#)$/i);
  const inTimeCol = findCol(/in\s*time|开始时间|入点/i);
  const outTimeCol = findCol(/out\s*time|结束时间|出点/i);
  const characterCol = findCol(/character|角色|说话人|speaker/i);
  const chineseCol = findCol(/chinese|中文|中文原稿/i);
  const englishCol = findCol(/^english|英文|英语/i);
  const citationCol = findCol(/摘自/i);
  const noteCol = findCol(/^(?:note|备注)$/i);

  // Top-priority match for standard template header "Target Language" or "*字幕" (excluding 字幕备注 / 原声)
  let targetCol = findCol(
    /^target\s*language$|字幕|译文|断行/i,
    /原声|音频|摘自|备注|公式|筛选/i,
  );

  if (targetCol < 0) {
    const reserved = new Set(
      [lineCol, inTimeCol, outTimeCol, characterCol, chineseCol, englishCol, citationCol, noteCol, ...formulaCols].filter(
        (c) => c >= 0,
      ),
    );
    let bestCol = -1;
    let bestAvgLen = 0;
    const startSearch = Math.max(0, englishCol >= 0 ? englishCol + 1 : chineseCol >= 0 ? chineseCol + 1 : 0);
    for (let c = startSearch; c < headerRow.length; c += 1) {
      if (reserved.has(c)) continue;
      const h = (headerRow[c] ?? "").trim();
      if (/原声|音频|录制|备注|筛选|note/i.test(h)) continue;
      const nonEmpty = sampleDataRows.map((r) => (r[c] ?? "").trim()).filter(Boolean);
      if (nonEmpty.length === 0) continue;
      const avg = nonEmpty.reduce((s, v) => s + v.length, 0) / nonEmpty.length;
      if (avg > bestAvgLen) {
        bestAvgLen = avg;
        bestCol = c;
      }
    }
    targetCol = bestCol >= 0 ? bestCol : Math.min(6, Math.max(0, headerRow.length - 1));
  }

  return {
    lineCol,
    inTimeCol,
    outTimeCol,
    characterCol,
    chineseCol,
    englishCol,
    targetCol,
    citationCol,
    noteCol,
  };
}

export async function parseXlsxToSubtitleWorkbook(
  bytes: Uint8Array,
  fileName: string,
): Promise<ImportedSubtitleWorkbook> {
  const entries = await unzipXlsxXmlEntries(bytes);
  const workbookXml = entries.get("xl/workbook.xml");
  const relsXml = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) {
    throw new Error("无效的 .xlsx 文件：缺少 workbook.xml 结构");
  }

  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const stylesMeta = parseStylesMeta(entries.get("xl/styles.xml"));
  const targets = parseWorkbookSheetTargets(workbookXml, relsXml);
  if (targets.length === 0) {
    throw new Error(".xlsx 文件中未找到任何工作表");
  }

  const sheetNames: string[] = [];
  const sheets: Record<string, ImportedSubtitleSheet> = {};

  for (const t of targets) {
    const wsXml = entries.get(t.xmlPath);
    if (!wsXml) continue;
    sheetNames.push(t.name);
    sheets[t.name] = parseWorksheet(t.name, wsXml, sharedStrings, stylesMeta);
  }

  const preferred =
    sheetNames.find((n) => sheets[n].rows.length >= 15 && sheets[n].columnMap.inTimeCol >= 0) ??
    sheetNames[0];

  return {
    fileName,
    sheetNames,
    activeSheetName: preferred,
    sheets,
  };
}

export function parseCsvToSubtitleWorkbook(
  csvText: string,
  fileName: string,
): ImportedSubtitleWorkbook {
  const grid = parseCsvToGrid(csvText);
  const sheetName = fileName.replace(/\.(?:csv|tsv)$/i, "") || "Sheet1";
  const parsedRows = grid.map((cells, idx) => ({
    excelRow: idx + 1,
    cells,
    fills: cells.map(() => null),
    bolds: cells.map(() => false),
  }));
  const sheet = structureParsedSubtitleSheet(sheetName, parsedRows, []);
  return {
    fileName,
    sheetNames: [sheetName],
    activeSheetName: sheetName,
    sheets: { [sheetName]: sheet },
  };
}

export async function parseXlsxFirstSheetRawRows(bytes: Uint8Array): Promise<string[][]> {
  const entries = await unzipXlsxXmlEntries(bytes);
  const workbookXml = entries.get("xl/workbook.xml");
  const relsXml = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) {
    throw new Error("无效的 .xlsx 文件：缺少 workbook.xml 结构");
  }
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const targets = parseWorkbookSheetTargets(workbookXml, relsXml);
  if (targets.length === 0) return [];
  const wsXml = entries.get(targets[0].xmlPath);
  if (!wsXml) return [];

  // Also parse optional worksheet hyperlinks in case URLs were attached as links
  const sheetFileName = targets[0].xmlPath.split("/").pop() ?? "sheet1.xml";
  const wsRelsXml = entries.get(`xl/worksheets/_rels/${sheetFileName}.rels`) ?? "";
  const relIdToTarget = new Map<string, string>();
  for (const m of wsRelsXml.matchAll(/<Relationship\s+([^>]+?)\/?>/g)) {
    const attrs = m[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const tgt = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && tgt) relIdToTarget.set(id, decodeXmlEntities(tgt));
  }
  const cellRefToUrl = new Map<string, string>();
  for (const m of wsXml.matchAll(/<hyperlink\s+([^>]+?)\/?>/g)) {
    const attrs = m[1];
    const ref = /\bref="([A-Z]+\d+)"/i.exec(attrs)?.[1]?.toUpperCase();
    const rId = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    if (ref && rId && relIdToTarget.has(rId)) {
      cellRefToUrl.set(ref, relIdToTarget.get(rId)!);
    }
  }

  const out: string[][] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rMatch: RegExpExecArray | null;
  while ((rMatch = rowRe.exec(wsXml)) !== null) {
    const rNumStr = /\br="(\d+)"/.exec(rMatch[1])?.[1];
    const rIdx = rNumStr ? Math.max(0, parseInt(rNumStr, 10) - 1) : out.length;
    while (out.length <= rIdx) out.push([]);

    const cells = out[rIdx];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRe.exec(rMatch[2])) !== null) {
      const attrs = cMatch[1];
      const inner = cMatch[2] ?? "";
      const refFull = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1]?.toUpperCase() ?? "";
      const colLet = /^([A-Z]+)/.exec(refFull)?.[1] ?? "";
      const colIdx = colLet ? colLetterToIndex(colLet) : cells.length;
      const tAttr = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";

      let val = "";
      if (tAttr === "s") {
        const sIdx = parseInt((/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "").trim(), 10);
        val = Number.isNaN(sIdx) ? "" : (sharedStrings[sIdx] ?? "");
      } else if (tAttr === "inlineStr") {
        const tNodes = inner.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) ?? [];
        val = tNodes
          .map((t) => decodeXmlEntities(t.replace(/^<t(?:\s[^>]*)?>/, "").replace(/<\/t>$/, "")))
          .join("");
      } else {
        const vStr = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        val = vStr !== undefined ? decodeXmlEntities(vStr) : "";
      }

      const linkUrl = refFull ? cellRefToUrl.get(refFull) : undefined;
      while (cells.length <= colIdx) cells.push("");
      cells[colIdx] = val || linkUrl || "";
      if (colIdx === 0 && linkUrl && !cells[1]) {
        while (cells.length <= 1) cells.push("");
        cells[1] = linkUrl;
      }
    }
  }
  return out;
}

import type {
  ScriptColumnMap,
  ScriptRow,
  ScriptSheetDocument,
} from "../types/domain";
import {
  colLetterToIndex,
  DEFAULT_SOURCE_COL_CONFIG,
  type SourceScriptColumnConfig,
} from "../types/schema-config";

export function parseCsvToGrid(csvText: string): string[][] {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function findCol(headers: string[], patterns: RegExp[], fallback: number): number {
  for (const pat of patterns) {
    const idx = headers.findIndex((h) => pat.test(h.trim()));
    if (idx >= 0) return idx;
  }
  return fallback;
}

export function parseGridToScriptDocument(
  grid: string[][],
  title = "Script",
  colConfig?: Partial<SourceScriptColumnConfig>,
): ScriptSheetDocument {
  const cfg: SourceScriptColumnConfig = {
    ...DEFAULT_SOURCE_COL_CONFIG,
    ...(colConfig ?? {}),
  };

  const fb = {
    line: colLetterToIndex(cfg.lineCol, 0),
    inTime: colLetterToIndex(cfg.inTimeCol, 1),
    outTime: colLetterToIndex(cfg.outTimeCol, 2),
    character: colLetterToIndex(cfg.characterCol, 3),
    chinese: colLetterToIndex(cfg.chineseCol, 4),
    english: colLetterToIndex(cfg.englishCol, 5),
    targetLanguage: colLetterToIndex(cfg.targetLangCol, 6),
    note: colLetterToIndex(cfg.noteCol, 7),
    remark: colLetterToIndex(cfg.remarkCol, 8),
    sendRemark: colLetterToIndex(cfg.sendRemarkCol, 9),
    filterCategory: colLetterToIndex(cfg.filterCol, 10),
    needExtract: colLetterToIndex(cfg.needExtractCol, 11),
  };

  let headerIdx = 0;
  let columnMap: ScriptColumnMap;

  if (colConfig && cfg.autoDetectByHeader === false) {
    headerIdx = Math.min(
      Math.max(0, (cfg.headerRowNumber || 1) - 1),
      Math.max(0, grid.length - 1),
    );
    columnMap = { ...fb };
  } else {
    headerIdx = colConfig?.headerRowNumber
      ? Math.min(Math.max(0, cfg.headerRowNumber - 1), Math.max(0, grid.length - 1))
      : 0;
    for (let i = 0; i < Math.min(grid.length, 6); i += 1) {
      const joined = grid[i].join("|").toLowerCase();
      if (
        joined.includes("chinese") ||
        (joined.includes("line") && joined.includes("english"))
      ) {
        headerIdx = i;
        break;
      }
    }

    const hdr = grid[headerIdx] || [];
    columnMap = {
      line: findCol(hdr, [/^line$/i, /^行号$/], fb.line),
      inTime: findCol(hdr, [/^in\s*time$/i], fb.inTime),
      outTime: findCol(hdr, [/^out\s*time$/i], fb.outTime),
      character: findCol(hdr, [/^character$/i, /^角色$/], fb.character),
      chinese: findCol(hdr, [/^chinese$/i, /^中文/], fb.chinese),
      english: findCol(hdr, [/^english/i, /^英文/], fb.english),
      targetLanguage: findCol(hdr, [/^target\s*language$/i, /^目标语/], fb.targetLanguage),
      note: findCol(hdr, [/^note$/i], fb.note),
      remark: findCol(hdr, [/^备注$/], fb.remark),
      sendRemark: findCol(hdr, [/^送翻备注$/], fb.sendRemark),
      filterCategory: findCol(hdr, [/^筛选列$/], fb.filterCategory),
      needExtract: findCol(hdr, [/^需要摘$/], fb.needExtract),
    };
  }

  const get = (r: string[], idx: number) =>
    idx >= 0 && idx < r.length ? (r[idx] ?? "") : "";

  const rows: ScriptRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const r = grid[i];
    rows.push({
      rowIndex: i - (headerIdx + 1),
      rawCells: [...r],
      line: get(r, columnMap.line),
      inTime: get(r, columnMap.inTime),
      outTime: get(r, columnMap.outTime),
      character: get(r, columnMap.character),
      chinese: get(r, columnMap.chinese),
      english: get(r, columnMap.english),
      targetLanguage: get(r, columnMap.targetLanguage),
      note: get(r, columnMap.note),
      remark: get(r, columnMap.remark),
      sendRemark: get(r, columnMap.sendRemark),
      filterCategory: get(r, columnMap.filterCategory),
      needExtract: get(r, columnMap.needExtract),
    });
  }

  return {
    title,
    headerRows: grid.slice(0, headerIdx + 1),
    columnMap,
    rows,
  };
}

import type {
  ScriptColumnMap,
  ScriptRow,
  ScriptSheetDocument,
} from "../types/domain";

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
): ScriptSheetDocument {
  let headerIdx = 0;
  for (let i = 0; i < Math.min(grid.length, 6); i += 1) {
    const joined = grid[i].join("|").toLowerCase();
    if (joined.includes("chinese") || (joined.includes("line") && joined.includes("english"))) {
      headerIdx = i;
      break;
    }
  }

  const hdr = grid[headerIdx] || [];
  const columnMap: ScriptColumnMap = {
    line: findCol(hdr, [/^line$/i, /^行号$/], 0),
    inTime: findCol(hdr, [/^in\s*time$/i], 1),
    outTime: findCol(hdr, [/^out\s*time$/i], 2),
    character: findCol(hdr, [/^character$/i, /^角色$/], 3),
    chinese: findCol(hdr, [/^chinese$/i, /^中文/], 4),
    english: findCol(hdr, [/^english/i, /^英文/], 5),
    targetLanguage: findCol(hdr, [/^target\s*language$/i, /^目标语/], 6),
    note: findCol(hdr, [/^note$/i], 7),
    remark: findCol(hdr, [/^备注$/], 8),
    sendRemark: findCol(hdr, [/^送翻备注$/], 9),
    filterCategory: findCol(hdr, [/^筛选列$/], 10),
    needExtract: findCol(hdr, [/^需要摘$/], 11),
  };

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

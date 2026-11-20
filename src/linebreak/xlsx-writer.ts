import type {
  ImportedSubtitleSheet,
  SubtitleLineBreakRun,
} from "./types";

function escXml(s: string): string {
  return (s || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function colIndexToLetters(colIdx: number): string {
  let n = colIdx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createStoredZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const len = f.data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, len, true);
    lv.setUint32(22, len, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    localParts.push(lh, f.data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, len, true);
    cv.setUint32(24, len, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + len;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const p of [...localParts, ...centralParts, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

interface StyleKey {
  bold: boolean;
  fontRgb: string | null;
  fillRgb: string | null;
  bordered: boolean;
  align: "center" | "text" | "formula" | "rtl";
}

class StyleRegistry {
  private fontMap = new Map<string, number>();
  private fontList: Array<{ bold: boolean; rgb: string | null }> = [];
  private fillIds = new Map<string, number>();
  private fillList: string[] = [];
  private xfMap = new Map<string, number>();
  private xfEntries: Array<{
    fontId: number;
    fillId: number;
    borderId: number;
    align: StyleKey["align"];
  }> = [];

  constructor() {
    this.getStyleIndex({
      bold: false,
      fontRgb: null,
      fillRgb: null,
      bordered: false,
      align: "text",
    });
  }

  private getFontId(bold: boolean, fontRgb: string | null): number {
    const cleanRgb =
      fontRgb && fontRgb.length >= 6 && fontRgb.slice(-6).toUpperCase() !== "000000"
        ? fontRgb.slice(-6).toUpperCase()
        : null;
    const fKey = `${bold ? 1 : 0}|${cleanRgb ?? ""}`;
    const existing = this.fontMap.get(fKey);
    if (existing !== undefined) return existing;
    const id = this.fontList.length;
    this.fontList.push({ bold, rgb: cleanRgb });
    this.fontMap.set(fKey, id);
    return id;
  }

  getStyleIndex(key: StyleKey): number {
    const normFill = key.fillRgb ? key.fillRgb.slice(-6).toUpperCase() : null;
    const fontId = this.getFontId(key.bold, key.fontRgb);
    const borderId = key.bordered ? 1 : 0;
    const idKey = `${fontId}|${normFill ?? ""}|${borderId}|${key.align}`;
    const existing = this.xfMap.get(idKey);
    if (existing !== undefined) return existing;

    let fillId = 0;
    if (normFill && normFill !== "FFFFFF" && normFill !== "000000") {
      const fIdx = this.fillIds.get(normFill);
      if (fIdx !== undefined) {
        fillId = fIdx;
      } else {
        fillId = 2 + this.fillList.length;
        this.fillList.push(normFill);
        this.fillIds.set(normFill, fillId);
      }
    }

    const xfIdx = this.xfEntries.length;
    this.xfEntries.push({ fontId, fillId, borderId, align: key.align });
    this.xfMap.set(idKey, xfIdx);
    return xfIdx;
  }

  buildStylesXml(fontFamily: string, fontSizePt: number, hasFormulaCf: boolean): string {
    const fontsXml = this.fontList
      .map((f) => {
        const bTag = f.bold ? "<b/>" : "";
        const cTag = f.rgb ? `<color rgb="FF${f.rgb}"/>` : `<color rgb="FF000000"/>`;
        return `<font>${bTag}<sz val="${fontSizePt}"/><name val="${escXml(fontFamily)}"/>${cTag}</font>`;
      })
      .join("");

    const fillsXml = [
      `<fill><patternFill patternType="none"/></fill>`,
      `<fill><patternFill patternType="gray125"/></fill>`,
      ...this.fillList.map(
        (hex) =>
          `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor rgb="FF${hex}"/></patternFill></fill>`,
      ),
    ].join("");

    const xfsXml = this.xfEntries
      .map((xf) => {
        const applyFill = xf.fillId > 0 ? ` applyFill="1"` : "";
        const applyBorder = xf.borderId > 0 ? ` applyBorder="1"` : "";
        let alignTag = `<alignment wrapText="1" vertical="center"/>`;
        if (xf.align === "center") {
          alignTag = `<alignment wrapText="1" horizontal="center" vertical="center"/>`;
        } else if (xf.align === "formula") {
          alignTag = `<alignment horizontal="center"/>`;
        } else if (xf.align === "rtl") {
          alignTag = `<alignment wrapText="1" horizontal="right" vertical="center" readingOrder="2"/>`;
        }
        return `<xf numFmtId="0" fontId="${xf.fontId}" fillId="${xf.fillId}" borderId="${xf.borderId}" xfId="0" applyFont="1"${applyFill}${applyBorder} applyAlignment="1">${alignTag}</xf>`;
      })
      .join("");

    const dxfsXml = hasFormulaCf
      ? `<dxfs count="2">
    <dxf><fill><patternFill patternType="solid"><bgColor rgb="FFFFFF00"/><fgColor rgb="FFFFFF00"/></patternFill></fill></dxf>
    <dxf><fill><patternFill patternType="solid"><bgColor rgb="FFFF00FF"/><fgColor rgb="FFFF00FF"/></patternFill></fill></dxf>
  </dxfs>`
      : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="${this.fontList.length}">${fontsXml}</fonts>
  <fills count="${2 + this.fillList.length}">${fillsXml}</fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${this.xfEntries.length}">${xfsXml}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  ${dxfsXml}
</styleSheet>`;
  }
}

export interface TemplateColumnPlan {
  totalOutCols: number;
  outTargetCol: number;
  outReviewCol: number;
  /** Non-null when a new column was spliced in at this outCol index (e.g. 11 = Col L) */
  insertedReviewColAt: number | null;
  formulaCols: [number, number, number] | null;
  outToSrcCol: number[];
  colWidths: Array<number | null>;
  colHidden: boolean[];
}

const REVIEW_HEADER_RE = /^(?:断行备注|核对备注|AI备注|复查备注|断行核对)$/i;

export function resolveTemplateColumnPlan(
  sheet: ImportedSubtitleSheet,
  includeCharFormulas: boolean,
): TemplateColumnPlan {
  const srcColCount = Math.max(
    sheet.columnMap.targetCol + 1,
    ...sheet.headerRows.map((r) => r.length),
    ...sheet.rows.map((r) => r.rawCells.length),
  );

  const outToSrcCol: number[] = [];
  const colWidths: Array<number | null> = [];
  const colHidden: boolean[] = [];
  let formulaCols: [number, number, number] | null = null;

  if (sheet.detectedFormulaCols.length >= 3) {
    formulaCols = [
      sheet.detectedFormulaCols[0],
      sheet.detectedFormulaCols[1],
      sheet.detectedFormulaCols[2],
    ];
    for (let i = 0; i < srcColCount; i += 1) {
      outToSrcCol.push(i);
      colWidths.push(sheet.colWidths[i] ?? null);
      colHidden.push(sheet.colHidden[i] ?? false);
    }
  } else if (includeCharFormulas) {
    for (let c = 0; c <= sheet.columnMap.targetCol; c += 1) {
      outToSrcCol.push(c);
      colWidths.push(sheet.colWidths[c] ?? (c === sheet.columnMap.targetCol ? 30.38 : null));
      colHidden.push(sheet.colHidden[c] ?? false);
    }
    const fStart = outToSrcCol.length;
    outToSrcCol.push(-1, -1, -1);
    colWidths.push(5.75, 9.0, 9.0);
    colHidden.push(false, false, false);
    formulaCols = [fStart, fStart + 1, fStart + 2];

    for (let c = sheet.columnMap.targetCol + 1; c < srcColCount; c += 1) {
      outToSrcCol.push(c);
      colWidths.push(sheet.colWidths[c] ?? null);
      colHidden.push(sheet.colHidden[c] ?? false);
    }
  } else {
    for (let i = 0; i < srcColCount; i += 1) {
      outToSrcCol.push(i);
      colWidths.push(sheet.colWidths[i] ?? null);
      colHidden.push(sheet.colHidden[i] ?? false);
    }
  }

  // Place review remark column at Col L (index 11) on all standard templates (or right after formulas on wider sheets)
  const lastCoreCol = Math.max(sheet.columnMap.targetCol, ...(formulaCols ?? []));
  const desiredReviewCol = Math.max(11, lastCoreCol + 1);
  let insertedReviewColAt: number | null = null;

  if (outToSrcCol.length <= desiredReviewCol) {
    // Pad any intermediate visible columns (e.g. Col K at index 10) up to desiredReviewCol (Col L at index 11)
    while (outToSrcCol.length < desiredReviewCol) {
      outToSrcCol.push(-1);
      colWidths.push(20.75);
      colHidden.push(false);
    }
    insertedReviewColAt = desiredReviewCol;
    outToSrcCol.push(-2);
    colWidths.push(24.0);
    colHidden.push(false);
  } else {
    const existingSrc = outToSrcCol[desiredReviewCol];
    const mainHeaderRow = sheet.headerRows[sheet.headerRows.length - 1] ?? [];
    const existingHeader = existingSrc >= 0 ? (mainHeaderRow[existingSrc] ?? "").trim() : "";
    const isReusableReviewCol =
      existingSrc >= 0 &&
      (REVIEW_HEADER_RE.test(existingHeader) ||
        (!colHidden[desiredReviewCol] &&
          sheet.headerRows.every((hr) => !(hr[existingSrc] ?? "").trim()) &&
          sheet.rows.every((r) => !(r.rawCells[existingSrc] ?? "").trim())));

    if (isReusableReviewCol) {
      colWidths[desiredReviewCol] = Math.max(colWidths[desiredReviewCol] ?? 24.0, 22.0);
      colHidden[desiredReviewCol] = false;
    } else {
      // Splice new visible Col L right before hidden remarks (shifting original hidden L..O -> M..P untouched!)
      insertedReviewColAt = desiredReviewCol;
      outToSrcCol.splice(desiredReviewCol, 0, -2);
      colWidths.splice(desiredReviewCol, 0, 24.0);
      colHidden.splice(desiredReviewCol, 0, false);
    }
  }

  return {
    totalOutCols: outToSrcCol.length,
    outTargetCol: sheet.columnMap.targetCol,
    outReviewCol: desiredReviewCol,
    insertedReviewColAt,
    formulaCols,
    outToSrcCol,
    colWidths,
    colHidden,
  };
}

export function buildExactTemplateFormulaCellsXml(
  rowNum: number,
  targetColIdx: number,
  formulaCols: [number, number, number],
  subtitleText: string,
  singleMax: number,
  styleIdx: number,
): string[] {
  const gRef = `${colIndexToLetters(targetColIdx)}${rowNum}`;
  const hRef = `${colIndexToLetters(formulaCols[0])}${rowNum}`;
  const iRef = `${colIndexToLetters(formulaCols[1])}${rowNum}`;
  const jRef = `${colIndexToLetters(formulaCols[2])}${rowNum}`;

  const lenVal = subtitleText.length;
  const atIdx = subtitleText.indexOf("@");

  const fH = `len(${gRef})`;
  const fI = `IF(${hRef}&gt;${singleMax},LEN(LEFT(${gRef},SEARCH("@",${gRef})-1)),"L")`;
  const fJ = `IF(${hRef}&gt;${singleMax},LEN(RIGHT(${gRef},LEN(${gRef})-SEARCH("@",${gRef}))),"L")`;

  const sAttr = styleIdx > 0 ? ` s="${styleIdx}"` : "";
  const cellH = `<c r="${hRef}"${sAttr}><f>${fH}</f><v>${lenVal}</v></c>`;

  let cellI: string;
  let cellJ: string;
  if (lenVal <= singleMax) {
    cellI = `<c r="${iRef}"${sAttr} t="str"><f>${fI}</f><v>L</v></c>`;
    cellJ = `<c r="${jRef}"${sAttr} t="str"><f>${fJ}</f><v>L</v></c>`;
  } else if (atIdx >= 0) {
    const leftLen = atIdx;
    const rightLen = subtitleText.length - atIdx - 1;
    cellI = `<c r="${iRef}"${sAttr}><f>${fI}</f><v>${leftLen}</v></c>`;
    cellJ = `<c r="${jRef}"${sAttr}><f>${fJ}</f><v>${rightLen}</v></c>`;
  } else {
    cellI = `<c r="${iRef}"${sAttr} t="e"><f>${fI}</f><v>#VALUE!</v></c>`;
    cellJ = `<c r="${jRef}"${sAttr} t="e"><f>${fJ}</f><v>#VALUE!</v></c>`;
  }

  return [cellH, cellI, cellJ];
}

export function buildLineBreakResultXlsx(
  sheet: ImportedSubtitleSheet,
  run: SubtitleLineBreakRun,
): Uint8Array {
  const enc = new TextEncoder();
  const spec = run.langSpec;
  const includeCharFormulas = spec.mode === "char" || sheet.detectedFormulaCols.length >= 3;
  const plan = resolveTemplateColumnPlan(sheet, includeCharFormulas);
  const formulaSet = new Set<number>(plan.formulaCols ?? []);
  const styles = new StyleRegistry();
  const isRtl = spec.dir === "rtl";

  const alignForSrcCol = (srcCol: number, isHeader: boolean): StyleKey["align"] => {
    if (isHeader) return "center";
    if (srcCol === sheet.columnMap.targetCol && isRtl) return "rtl";
    if (
      srcCol === sheet.columnMap.lineCol ||
      srcCol === sheet.columnMap.inTimeCol ||
      srcCol === sheet.columnMap.outTimeCol ||
      srcCol === sheet.columnMap.characterCol
    ) {
      return "center";
    }
    return "text";
  };

  const formulaStyleIdx = styles.getStyleIndex({
    bold: false,
    fontRgb: null,
    fillRgb: null,
    bordered: true,
    align: "formula",
  });

  const rowsXml: string[] = [];
  let rNum = 1;

  const headerRows =
    sheet.headerRows.length > 0
      ? sheet.headerRows
      : [
          Array(plan.totalOutCols).fill(""),
          ["Line", "In Time", "Out Time", "Character", "Chinese", "English（标you）", "Target Language"],
        ];

  headerRows.forEach((hRow, hIdx) => {
    const isMainHeader = hIdx === headerRows.length - 1;
    const hFills = sheet.headerFillRgb[hIdx] ?? [];
    const hFonts = sheet.headerFontRgb?.[hIdx] ?? [];
    const hBolds = sheet.headerBold[hIdx] ?? [];
    const targetValInHeader = hRow[sheet.columnMap.targetCol] ?? "";
    const outCells: string[] = [];

    for (let outCol = 0; outCol < plan.totalOutCols; outCol += 1) {
      if (formulaSet.has(outCol)) continue;
      const srcCol = plan.outToSrcCol[outCol];
      const isReviewCol = outCol === plan.outReviewCol;
      const val = isReviewCol
        ? isMainHeader
          ? (srcCol >= 0 && (hRow[srcCol] ?? "").trim() ? hRow[srcCol] : "核对备注")
          : ""
        : srcCol >= 0
          ? (hRow[srcCol] ?? "")
          : "";
      const fillRgb = srcCol >= 0 ? (hFills[srcCol] ?? null) : null;
      const fontRgb = srcCol >= 0 ? (hFonts[srcCol] ?? null) : null;
      const bold = srcCol >= 0 ? (hBolds[srcCol] ?? isMainHeader) : isMainHeader;
      const st = styles.getStyleIndex({
        bold,
        fontRgb,
        fillRgb,
        bordered: true,
        align: alignForSrcCol(srcCol, isMainHeader),
      });
      outCells.push(renderCell(outCol, rNum, val, st, false));
    }

    if (plan.formulaCols) {
      outCells.push(
        ...buildExactTemplateFormulaCellsXml(
          rNum,
          plan.outTargetCol,
          plan.formulaCols,
          targetValInHeader,
          spec.singleMax,
          formulaStyleIdx,
        ),
      );
    }

    outCells.sort((a, b) => extractColOrder(a) - extractColOrder(b));
    rowsXml.push(`<row r="${rNum}">${outCells.join("")}</row>`);
    rNum += 1;
  });

  // Render data rows + inserted split-screen rows (every cell A..O rendered with thin border!)
  sheet.rows.forEach((srcRow, idx) => {
    const proc = run.results[idx];
    const screens = proc?.screens.length
      ? proc.screens
      : [{ text: srcRow.rawCells[sheet.columnMap.targetCol] ?? "" }];
    const targetWasBold = Boolean(srcRow.cellBold[sheet.columnMap.targetCol]);
    const targetFontRgb = srcRow.cellFontRgb?.[sheet.columnMap.targetCol] ?? null;

    screens.forEach((sc, sIdx) => {
      const outCells: string[] = [];
      const subText = sc.text;

      for (let outCol = 0; outCol < plan.totalOutCols; outCol += 1) {
        if (formulaSet.has(outCol)) continue;
        const srcCol = plan.outToSrcCol[outCol];
        const isTarget = outCol === plan.outTargetCol;
        const isReviewCol = outCol === plan.outReviewCol;

        if (sIdx === 0) {
          const val = isTarget
            ? subText
            : isReviewCol
              ? (proc?.reviewNote ?? "")
              : srcCol >= 0
                ? (srcRow.rawCells[srcCol] ?? "")
                : "";
          const fillRgb =
            srcCol >= 0
              ? (srcRow.cellFillRgb[srcCol] ?? null)
              : srcRow.isGreenHighlight
                ? "00FF00"
                : null;
          const fontRgb =
            isReviewCol && proc?.reviewNote
              ? "B42318"
              : srcCol >= 0
                ? (srcRow.cellFontRgb?.[srcCol] ?? null)
                : null;
          const bold = srcCol >= 0 ? (srcRow.cellBold[srcCol] ?? false) : false;
          const isNumericLine =
            srcCol === sheet.columnMap.lineCol && /^-?\d+(?:\.\d+)?$/.test(val.trim());
          const st = styles.getStyleIndex({
            bold,
            fontRgb,
            fillRgb,
            bordered: true,
            align: alignForSrcCol(srcCol, false),
          });
          outCells.push(renderCell(outCol, rNum, val, st, isNumericLine));
        } else {
          // Split-screen inserted row: empty bordered cells on A..F & K..P, subtitle on G
          const val = isTarget ? subText : "";
          const bold = isTarget ? targetWasBold : false;
          const fontRgb = isTarget ? targetFontRgb : null;
          const st = styles.getStyleIndex({
            bold,
            fontRgb,
            fillRgb: null,
            bordered: true,
            align: isTarget ? (isRtl ? "rtl" : "text") : alignForSrcCol(srcCol, false),
          });
          outCells.push(renderCell(outCol, rNum, val, st, false));
        }
      }

      if (plan.formulaCols) {
        outCells.push(
          ...buildExactTemplateFormulaCellsXml(
            rNum,
            plan.outTargetCol,
            plan.formulaCols,
            subText,
            spec.singleMax,
            formulaStyleIdx,
          ),
        );
      }

      outCells.sort((a, b) => extractColOrder(a) - extractColOrder(b));
      rowsXml.push(`<row r="${rNum}">${outCells.join("")}</row>`);
      rNum += 1;
    });
  });

  const lastRow = Math.max(1, rNum - 1);

  const colDefs: string[] = [];
  for (let c = 0; c < plan.totalOutCols; c += 1) {
    const w =
      plan.colWidths[c] ??
      (c === plan.outTargetCol
        ? spec.fixedRulerPx
          ? Math.round((spec.fixedRulerPx / 7) * 10) / 10
          : 30.38
        : 12.63);
    const hid = plan.colHidden[c];
    const hAttr = hid ? ` hidden="1"` : "";
    colDefs.push(`<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"${hAttr}/>`);
  }
  const colsXml = colDefs.length > 0 ? `<cols>${colDefs.join("")}</cols>` : "";

  let cfXml = "";
  if (plan.formulaCols) {
    const startLet = colIndexToLetters(plan.formulaCols[0]);
    const endLet = colIndexToLetters(plan.formulaCols[2]);
    cfXml = `<conditionalFormatting sqref="${startLet}1:${endLet}${lastRow}">
  <cfRule type="cellIs" dxfId="0" priority="1" operator="between"><formula>${spec.singleMax + 1}</formula><formula>${spec.doubleMax}</formula></cfRule>
</conditionalFormatting>
<conditionalFormatting sqref="${startLet}1:${endLet}${lastRow}">
  <cfRule type="cellIs" dxfId="1" priority="2" operator="greaterThan"><formula>${spec.doubleMax}</formula></cfRule>
</conditionalFormatting>`;
  }

  const frozenRows = Math.max(1, sheet.frozenRowCount || headerRows.length);
  const safeSheetTitle = escXml(
    (sheet.sheetName || spec.name).replace(/[:\\/?*[\]]/g, "_").slice(0, 31) || "Sheet1",
  );

  const wsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="${frozenRows}" topLeftCell="A${frozenRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr customHeight="1" defaultColWidth="12.63" defaultRowHeight="15.75"/>
  ${colsXml}
  <sheetData>${rowsXml.join("")}</sheetData>
  ${cfXml}
</worksheet>`;

  const stylesXml = styles.buildStylesXml(spec.fontFamily, spec.fontSizePt, Boolean(plan.formulaCols));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${safeSheetTitle}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return createStoredZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/styles.xml", data: enc.encode(stylesXml) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(wsXml) },
  ]);
}

function renderCell(
  colIdx: number,
  rowNum: number,
  val: string,
  styleIdx: number,
  asNumeric: boolean,
): string {
  const sAttr = styleIdx > 0 ? ` s="${styleIdx}"` : "";
  const ref = `${colIndexToLetters(colIdx)}${rowNum}`;
  if (!val) {
    return `<c r="${ref}"${sAttr}/>`;
  }
  if (asNumeric) {
    return `<c r="${ref}"${sAttr}><v>${escXml(val.trim())}</v></c>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
}

function extractColOrder(cellXml: string): number {
  const m = /^<c r="([A-Z]+)\d+"/.exec(cellXml);
  if (!m) return 0;
  let idx = 0;
  for (let i = 0; i < m[1].length; i += 1) {
    idx = idx * 26 + (m[1].charCodeAt(i) - 64);
  }
  return idx;
}

import type {
  LanguageRunOutput,
  ScriptSheetDocument,
} from "../types/domain";
import { colLetterToIndex } from "../types/schema-config";

function escXml(s: string): string {
  return (s || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colLetters(colIdx: number): string {
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

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...localParts, ...centralParts, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function buildMultiSheetXlsx(
  doc: ScriptSheetDocument,
  runs: LanguageRunOutput[],
  outputHintCol = "AUTO",
): Uint8Array {
  const enc = new TextEncoder();
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
  const totalCols = Math.max(maxBaseCols + 1, hintColIdx + 1);

  const sheetFiles: Array<{ name: string; data: Uint8Array }> = [];
  const sheetEntriesXml: string[] = [];
  const sheetRelsXml: string[] = [];

  const activeRuns: LanguageRunOutput[] =
    runs.length > 0
      ? runs
      : [
          {
            langName: doc.title || "源剧本预览",
            rows: doc.rows.map((r) => ({
              rowIndex: r.rowIndex,
              targetLanguage: r.targetLanguage,
              note: r.note,
              status: "untouched",
              hint: "",
            })),
            matchedCount: 0,
            warningCount: 0,
            missingCount: 0,
          },
        ];

  activeRuns.forEach((run, sIdx) => {
    const safeTitle = escXml(run.langName.replace(/[:\\/?*\[\]]/g, "_").slice(0, 31) || `Sheet${sIdx + 1}`);
    sheetEntriesXml.push(
      `<sheet name="${safeTitle}" sheetId="${sIdx + 1}" r:id="rId${sIdx + 1}"/>`,
    );
    sheetRelsXml.push(
      `<Relationship Id="rId${sIdx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sIdx + 1}.xml"/>`,
    );

    const rowsXml: string[] = [];
    let rNum = 1;

    doc.headerRows.forEach((hr, hIdx) => {
      const padded = [...hr];
      while (padded.length < totalCols) padded.push("");
      padded[hintColIdx] = hIdx === doc.headerRows.length - 1 ? "【工具提示】" : "";
      const cells = padded
        .map(
          (val, cIdx) =>
            `<c r="${colLetters(cIdx)}${rNum}" s="1" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`,
        )
        .join("");
      rowsXml.push(`<row r="${rNum}">${cells}</row>`);
      rNum += 1;
    });

    doc.rows.forEach((src, i) => {
      const res = run.rows[i];
      const arr = [...src.rawCells];
      while (arr.length < totalCols) arr.push("");
      arr[doc.columnMap.targetLanguage] = res.targetLanguage;
      arr[doc.columnMap.note] = res.note;
      arr[hintColIdx] = res.hint || "";

      const styleFor = (cIdx: number) => {
        if (cIdx !== doc.columnMap.targetLanguage && cIdx !== hintColIdx) return 0;
        if (res.status === "missing") return 2;
        if (res.status === "warning") return 3;
        if (res.status === "matched") return 4;
        return 0;
      };

      const cells = arr
        .map((val, cIdx) => {
          const st = styleFor(cIdx);
          const sAttr = st > 0 ? ` s="${st}"` : "";
          return `<c r="${colLetters(cIdx)}${rNum}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
        })
        .join("");
      rowsXml.push(`<row r="${rNum}">${cells}</row>`);
      rNum += 1;
    });

    const wsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="${doc.headerRows.length}" topLeftCell="A${doc.headerRows.length + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetData>${rowsXml.join("")}</sheetData>
</worksheet>`;
    sheetFiles.push({
      name: `xl/worksheets/sheet${sIdx + 1}.xml`,
      data: enc.encode(wsXml),
    });
  });

  const stylesId = activeRuns.length + 1;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF3"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFECFDF5"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellXfs count="5">
    <xf fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf fontId="0" fillId="3" borderId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf fontId="0" fillId="4" borderId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf fontId="0" fillId="5" borderId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
  </cellXfs>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${activeRuns.map((_r, idx) => `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntriesXml.join("")}</sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRelsXml.join("")}
  <Relationship Id="rId${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return createStoredZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/styles.xml", data: enc.encode(stylesXml) },
    ...sheetFiles,
  ]);
}

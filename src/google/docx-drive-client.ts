import type { ArticleParagraph } from "../catalog/catalog-types";

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractParagraphTextFromWordXml(xmlBlock: string): string {
  const withoutDeletions = xmlBlock.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
  const pMatches = withoutDeletions.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  const lines: string[] = [];

  for (const pXml of pMatches) {
    const withBreaks = pXml.replace(/<w:(?:br|cr)\b[^>]*\/?>/g, "\n");
    const runs = withBreaks.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) ?? [];
    const text = runs
      .map((r) => {
        const inner = r.replace(/^<w:t(?:\s[^>]*)?>/, "").replace(/<\/w:t>$/, "");
        return decodeXmlEntities(inner);
      })
      .join("")
      .trim();
    if (text) lines.push(text);
  }

  return lines.join("\n").trim();
}

export function parseDocxDocumentXml(
  documentXml: string,
  zhCol1Based = 1,
  enCol1Based = 2,
  targetCol1Based = 3,
): ArticleParagraph[] {
  const results: ArticleParagraph[] = [];
  const tables = documentXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) ?? [];

  if (tables.length > 0) {
    for (const tbl of tables) {
      const rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
      for (const tr of rows) {
        const cells = (tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map(
          extractParagraphTextFromWordXml,
        );
        const target = cells[targetCol1Based - 1] ?? "";
        const zh = cells[zhCol1Based - 1] ?? "";
        const en = cells[enCol1Based - 1] ?? "";
        if (target) {
          results.push({ chinese: zh, english: en, target });
        } else if (cells.length === 2 && cells[1]) {
          results.push({ chinese: cells[0], english: "", target: cells[1] });
        }
      }
    }
    if (results.length > 0) return results;
  }

  const allText = extractParagraphTextFromWordXml(documentXml);
  for (const line of allText.split(/\n+/)) {
    if (line.trim()) {
      results.push({ chinese: "", english: "", target: line.trim() });
    }
  }
  return results;
}

const MAX_DOCX_XML_BYTES = 32 * 1024 * 1024;

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
    if (total > MAX_DOCX_XML_BYTES) {
      await reader.cancel();
      throw new Error(".docx 文档解压体积超过安全上限 (32MB)");
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

export async function extractDocumentXmlFromDocxBytes(
  zipBytes: Uint8Array,
): Promise<string> {
  const view = new DataView(
    zipBytes.buffer,
    zipBytes.byteOffset,
    zipBytes.byteLength,
  );
  const dec = new TextDecoder("utf-8");

  let eocdPos = -1;
  for (let i = zipBytes.byteLength - 22; i >= Math.max(0, zipBytes.byteLength - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error("无效的 .docx 压缩结构");
  }

  const entryCount = view.getUint16(eocdPos + 10, true);
  let cdOffset = view.getUint32(eocdPos + 16, true);

  for (let idx = 0; idx < entryCount; idx += 1) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
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

    if (fileName === "word/document.xml") {
      if (localHeaderOffset + 30 > zipBytes.byteLength) {
        throw new Error("无效的 .docx 偏移量");
      }
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      if (dataStart < 0 || dataStart + compSize > zipBytes.byteLength) {
        throw new Error("无效的 .docx 数据边界");
      }
      const rawSlice = zipBytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        return dec.decode(rawSlice);
      }
      if (method === 8) {
        const inflated = await inflateRawBytes(rawSlice);
        return dec.decode(inflated);
      }
      throw new Error(`不支持的 .docx 压缩算法 (${method})`);
    }
  }

  throw new Error(".docx 文件内未找到 word/document.xml");
}

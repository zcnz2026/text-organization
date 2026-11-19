import type { ArticleParagraph } from "../catalog/catalog-types";
import {
  extractDocumentXmlFromDocxBytes,
  parseDocxDocumentXml,
} from "./docx-drive-client";
import type { TokenProvider } from "./sheets-client";

interface DocStructuralElement {
  paragraph?: {
    elements?: Array<{ textRun?: { content?: string } }>;
  };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{
        content?: DocStructuralElement[];
      }>;
    }>;
  };
}

export interface ManuscriptColumnOrder {
  zhCol1Based: number;
  enCol1Based: number;
  targetCol1Based: number;
}

const DEFAULT_MANUSCRIPT_COLS: ManuscriptColumnOrder = {
  zhCol1Based: 1,
  enCol1Based: 2,
  targetCol1Based: 3,
};

function extractElementsText(elements: DocStructuralElement[] = []): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.paragraph?.elements) {
      const line = el.paragraph.elements
        .map((e) => e.textRun?.content ?? "")
        .join("")
        .replace(/\u000b/g, "\n")
        .trim();
      if (line) parts.push(line);
    }
  }
  return parts.join("\n").trim();
}

export class GoogleDocsClient {
  private getToken: TokenProvider;
  private fetchFn: typeof fetch;

  constructor(getToken: TokenProvider, fetchFn?: typeof fetch) {
    this.getToken = getToken;
    this.fetchFn = fetchFn
      ? (input, init) => fetchFn(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  async fetchArticleParagraphs(
    documentId: string,
    cols: ManuscriptColumnOrder = DEFAULT_MANUSCRIPT_COLS,
  ): Promise<ArticleParagraph[]> {
    const token = await this.getToken();
    const docsUrl = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`;
    const resp = await this.fetchFn(docsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.ok) {
      const doc = (await resp.json()) as {
        body?: { content?: DocStructuralElement[] };
      };
      return this.parseNativeDocBody(doc.body?.content ?? [], cols);
    }

    if (resp.status === 400 || resp.status === 404 || resp.status === 415) {
      return this.fetchDriveDocxParagraphs(documentId, token, cols);
    }

    throw new Error(`单篇文档读取失败 (HTTP ${resp.status})`);
  }

  private parseNativeDocBody(
    bodyContent: DocStructuralElement[],
    cols: ManuscriptColumnOrder,
  ): ArticleParagraph[] {
    const paragraphs: ArticleParagraph[] = [];
    for (const block of bodyContent) {
      if (block.table?.tableRows) {
        for (const tr of block.table.tableRows) {
          const cells = (tr.tableCells ?? []).map((tc) =>
            extractElementsText(tc.content),
          );
          const target = cells[cols.targetCol1Based - 1] ?? "";
          if (target) {
            paragraphs.push({
              chinese: cells[cols.zhCol1Based - 1] ?? "",
              english: cells[cols.enCol1Based - 1] ?? "",
              target,
            });
          } else if (cells.length === 2 && cells[1]) {
            paragraphs.push({ chinese: cells[0], english: "", target: cells[1] });
          }
        }
      } else if (block.paragraph) {
        const txt = extractElementsText([block]);
        if (txt) {
          paragraphs.push({ chinese: "", english: "", target: txt });
        }
      }
    }
    return paragraphs;
  }

  private async fetchDriveDocxParagraphs(
    fileId: string,
    token: string,
    cols: ManuscriptColumnOrder,
  ): Promise<ArticleParagraph[]> {
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const resp = await this.fetchFn(driveUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(
        `云端硬盘 .docx 单篇下载失败 (HTTP ${resp.status})，请确认已开启 Google Drive API 并重新点击授权登录`,
      );
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const xml = await extractDocumentXmlFromDocxBytes(buf);
    return parseDocxDocumentXml(
      xml,
      cols.zhCol1Based,
      cols.enCol1Based,
      cols.targetCol1Based,
    );
  }
}

import type { ArticleParagraph } from "../catalog/catalog-types";
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

  constructor(getToken: TokenProvider, fetchFn: typeof fetch = fetch) {
    this.getToken = getToken;
    this.fetchFn = fetchFn;
  }

  async fetchArticleParagraphs(documentId: string): Promise<ArticleParagraph[]> {
    const token = await this.getToken();
    const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`;
    const resp = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`单篇 Google 文档读取失败 (HTTP ${resp.status})`);
    }

    const doc = (await resp.json()) as {
      body?: { content?: DocStructuralElement[] };
    };
    const bodyContent = doc.body?.content ?? [];
    const paragraphs: ArticleParagraph[] = [];

    for (const block of bodyContent) {
      if (block.table?.tableRows) {
        for (const tr of block.table.tableRows) {
          const cells = (tr.tableCells ?? []).map((tc) =>
            extractElementsText(tc.content),
          );
          if (cells.length >= 3 && cells[2]) {
            paragraphs.push({
              chinese: cells[0],
              english: cells[1],
              target: cells[2],
            });
          } else if (cells.length === 2 && cells[1]) {
            paragraphs.push({
              chinese: cells[0],
              english: "",
              target: cells[1],
            });
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
}

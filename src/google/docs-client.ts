import type { ArticleParagraph } from "../catalog/catalog-types";
import { diagLog } from "../platform/diag-log";
import {
  extractDocumentXmlFromDocxBytes,
  parseDocxDocumentXml,
} from "./docx-drive-client";
import type { TokenProvider } from "./sheets-client";

function formatGoogleApi403Message(apiLabel: string, resourceId: string, status: number, rawBody: string): string {
  let apiMessage = "";
  let reason = "";
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
        details?: Array<{ reason?: string }>;
      };
    };
    apiMessage = parsed.error?.message ?? "";
    reason =
      parsed.error?.details?.find((d) => d.reason)?.reason ??
      parsed.error?.errors?.[0]?.reason ??
      parsed.error?.status ??
      "";
  } catch {
    apiMessage = rawBody.slice(0, 200);
  }

  diagLog.error(apiLabel, `HTTP ${status} (id=${resourceId}, reason=${reason || "unknown"})`, apiMessage || rawBody.slice(0, 300));

  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(`${reason} ${apiMessage}`)) {
    return `${apiLabel}尚未在您的 Google Cloud 项目中启用 (HTTP ${status})，请在 Google Cloud 控制台启用 ${apiLabel} 后重试。原始信息: ${apiMessage.slice(0, 140)}`;
  }
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient.*scope|insufficientPermissions/i.test(`${reason} ${apiMessage}`)) {
    return `当前 Google 登录令牌权限范围不足 (HTTP ${status})，请点击右上角「退出登录」后重新授权，并在 Google 授权页勾选全部权限复选框。原始信息: ${apiMessage.slice(0, 140)}`;
  }
  return `${apiLabel}读取失败 (HTTP ${status}, 文档ID: ${resourceId})：${apiMessage.slice(0, 180) || "无权访问该文档，请确认当前登录邮箱对该单篇文档拥有查看权限"}`;
}

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
      diagLog.info("Google Docs API", `文档 ${documentId} 非原生 Docs (HTTP ${resp.status})，尝试按 Drive .docx 下载`);
      return this.fetchDriveDocxParagraphs(documentId, token, cols);
    }

    const rawBody = await resp.text().catch(() => "");
    throw new Error(formatGoogleApi403Message("Google Docs API", documentId, resp.status, rawBody));
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
      const rawBody = await resp.text().catch(() => "");
      throw new Error(formatGoogleApi403Message("Google Drive API (.docx)", fileId, resp.status, rawBody));
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

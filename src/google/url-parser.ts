export interface ParsedGoogleUrl {
  kind: "sheet" | "doc";
  id: string;
  gid: number | null;
}

const SHEET_RE = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{15,})/i;
const DOC_RE = /(?:docs\.google\.com\/document\/d\/|drive\.google\.com\/file\/d\/)([A-Za-z0-9_-]{15,})/i;
const BARE_ID_RE = /^[A-Za-z0-9_-]{25,64}$/;
const GID_RE = /[?#&]gid=(\d+)/i;

export function parseGoogleResourceUrl(
  rawInput: string,
  defaultKind: "sheet" | "doc" = "sheet",
): ParsedGoogleUrl | null {
  const input = (rawInput || "").trim();
  if (!input) return null;

  const sheetMatch = SHEET_RE.exec(input);
  if (sheetMatch) {
    const gidMatch = GID_RE.exec(input);
    return {
      kind: "sheet",
      id: sheetMatch[1],
      gid: gidMatch ? Number.parseInt(gidMatch[1], 10) : null,
    };
  }

  const docMatch = DOC_RE.exec(input);
  if (docMatch) {
    return { kind: "doc", id: docMatch[1], gid: null };
  }

  if (BARE_ID_RE.test(input)) {
    return { kind: defaultKind, id: input, gid: null };
  }

  return null;
}

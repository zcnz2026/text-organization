import { describe, expect, it } from "vitest";
import { parseGoogleResourceUrl } from "../src/google/url-parser";

describe("parseGoogleResourceUrl", () => {
  it("extracts spreadsheetId and gid from hash or query parameter", () => {
    const res = parseGoogleResourceUrl(
      "https://docs.google.com/spreadsheets/d/1MockSheetIdExample000001/edit?gid=123456#gid=123456",
    );
    expect(res).toEqual({
      kind: "sheet",
      id: "1MockSheetIdExample000001",
      gid: 123456,
    });
  });

  it("extracts spreadsheetId with null gid when no gid is present", () => {
    const res = parseGoogleResourceUrl(
      "https://docs.google.com/spreadsheets/d/1MockSheetIdExample000002/edit?usp=sharing",
    );
    expect(res).toEqual({
      kind: "sheet",
      id: "1MockSheetIdExample000002",
      gid: null,
    });
  });

  it("extracts documentId from Google Docs URL", () => {
    const res = parseGoogleResourceUrl(
      "https://docs.google.com/document/d/1MockDocIdExample000003/edit?tab=t.0",
    );
    expect(res).toEqual({
      kind: "doc",
      id: "1MockDocIdExample000003",
      gid: null,
    });
  });

  it("returns null on empty or unrelated URL", () => {
    expect(parseGoogleResourceUrl("")).toBeNull();
    expect(parseGoogleResourceUrl("https://example.com/foo")).toBeNull();
  });
});

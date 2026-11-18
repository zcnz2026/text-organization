import { describe, expect, it } from "vitest";
import { parseGoogleResourceUrl } from "../src/google/url-parser";

describe("parseGoogleResourceUrl", () => {
  it("extracts spreadsheetId and gid from hash or query parameter", () => {
    const res = parseGoogleResourceUrl(
      "https://docs.google.com/spreadsheets/d/1bqJ-lypXlwcYpGqEWfKWkImxXFTvbhAzSfjcQdDHkEU/edit?gid=841200255#gid=841200255",
    );
    expect(res).toEqual({
      kind: "sheet",
      id: "1bqJ-lypXlwcYpGqEWfKWkImxXFTvbhAzSfjcQdDHkEU",
      gid: 841200255,
    });
  });

  it("extracts spreadsheetId with null gid when no gid is present", () => {
    const res = parseGoogleResourceUrl(
      "https://docs.google.com/spreadsheets/d/14B0BYtBSjuWcGit7N0rE0R8XBVYceo1AUxz7j5zO8CE/edit?usp=sharing",
    );
    expect(res).toEqual({
      kind: "sheet",
      id: "14B0BYtBSjuWcGit7N0rE0R8XBVYceo1AUxz7j5zO8CE",
      gid: null,
    });
  });

  it("extracts documentId from Google Docs URL", () => {
    const res = parseGoogleResourceUrl(
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_123456/edit?tab=t.0",
    );
    expect(res).toEqual({
      kind: "doc",
      id: "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456",
      gid: null,
    });
  });

  it("returns null on empty or unrelated URL", () => {
    expect(parseGoogleResourceUrl("")).toBeNull();
    expect(parseGoogleResourceUrl("https://example.com/foo")).toBeNull();
  });
});

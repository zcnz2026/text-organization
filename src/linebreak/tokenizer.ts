import type { LineBreakLanguageSpec } from "./types";

export interface SubtitleToken {
  text: string;
  sepAfter: string;
}

const NO_SPACE_LANGS = new Set(["th", "my", "km", "lo", "ja"]);

export function isGreenFillRgb(rgb: string | null | undefined): boolean {
  if (!rgb) return false;
  const clean = rgb.replace(/^#/, "").slice(-6).toUpperCase();
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  // Bright green (#00FF00) and Google Sheets green highlights (#93C47D, #6AA84F, #B6D7A8, #D9EAD3)
  return g >= 165 && g - r >= 30 && g - b >= 30;
}

export function normalizeSourceSubtitle(raw: string, spec: LineBreakLanguageSpec): string {
  const noSpace = NO_SPACE_LANGS.has(spec.code);
  let s = (raw || "").replace(/\r\n/g, "\n").trim();
  s = s.replace(/\s*@\s*/g, noSpace ? "" : " ");
  if (!noSpace) {
    s = s.replace(/[ \t]+/g, " ");
  }
  if (spec.isJapanese) {
    // Japanese rule 2: strip trailing period/comma, keep ？ ！ … 」 』 ）
    s = s.replace(/[。、，,]+$/u, "");
  }
  return s.trim();
}

export function tokenizeSubtitle(cleanText: string, spec: LineBreakLanguageSpec): SubtitleToken[] {
  if (!cleanText) return [];

  if (NO_SPACE_LANGS.has(spec.code)) {
    return tokenizeNoSpaceScript(cleanText, spec.code);
  }

  const rawParts = cleanText.split(/([ \t\n]+)/);
  const prelim: SubtitleToken[] = [];
  for (let i = 0; i < rawParts.length; i += 2) {
    const word = rawParts[i] ?? "";
    const sep = rawParts[i + 1] ?? "";
    if (!word) continue;
    prelim.push({ text: word, sepAfter: sep ? " " : "" });
  }

  // Bind orphanable French / guillemet / colon / question / exclamation tokens to neighbors
  const merged: SubtitleToken[] = [];
  for (let i = 0; i < prelim.length; i += 1) {
    const cur = prelim[i];
    if (/^[«“„"¿¡([（]+$/u.test(cur.text) && i + 1 < prelim.length) {
      prelim[i + 1] = {
        text: `${cur.text}${cur.sepAfter}${prelim[i + 1].text}`,
        sepAfter: prelim[i + 1].sepAfter,
      };
      continue;
    }
    if (/^[:;?!»”"')\].…؟।။។։]+$/u.test(cur.text) && merged.length > 0) {
      const prev = merged[merged.length - 1];
      merged[merged.length - 1] = {
        text: `${prev.text}${prev.sepAfter}${cur.text}`,
        sepAfter: cur.sepAfter,
      };
      continue;
    }
    merged.push(cur);
  }
  if (merged.length > 0) {
    merged[merged.length - 1].sepAfter = "";
  }
  return merged;
}

function tokenizeNoSpaceScript(text: string, langCode: string): SubtitleToken[] {
  try {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      const seg = new Intl.Segmenter(langCode, { granularity: "word" });
      const rawSegs = Array.from(seg.segment(text));
      const out: SubtitleToken[] = [];
      for (const item of rawSegs) {
        const s = item.segment;
        if (!s) continue;
        if (/^\s+$/u.test(s)) {
          if (out.length > 0) out[out.length - 1].sepAfter += s;
          continue;
        }
        if (!item.isWordLike && out.length > 0 && !/^[「『（(“‘«]+$/u.test(s)) {
          const prev = out[out.length - 1];
          prev.text = `${prev.text}${prev.sepAfter}${s}`;
          prev.sepAfter = "";
        } else if (
          out.length > 0 &&
          /^[「『（(“‘«]+$/u.test(out[out.length - 1].text) &&
          out[out.length - 1].sepAfter === ""
        ) {
          out[out.length - 1].text += s;
        } else {
          out.push({ text: s, sepAfter: "" });
        }
      }
      if (out.length > 0) return out;
    }
  } catch {
    // Fallback below
  }

  // Safe grapheme-cluster fallback (never splits base char from combining vowel marks \p{M})
  const clusters = text.match(/\P{M}\p{M}*/gu) ?? [...text];
  const chunks: SubtitleToken[] = [];
  for (let i = 0; i < clusters.length; i += 3) {
    chunks.push({ text: clusters.slice(i, i + 3).join(""), sepAfter: "" });
  }
  return chunks;
}

export function renderTokenSlice(
  tokens: SubtitleToken[],
  start: number,
  end: number,
  atIndex: number | null,
  spec: LineBreakLanguageSpec,
): string {
  const joinSub = (a: number, b: number, isBeforeBreak: boolean): string => {
    let out = "";
    for (let i = a; i < b; i += 1) {
      out += tokens[i].text;
      if (i < b - 1) out += tokens[i].sepAfter;
    }
    out = out.trim();
    if (spec.isJapanese) {
      if (isBeforeBreak) {
        // Japanese rule 4: drop mid-sentence period when breaking right after it
        out = out.replace(/。$/u, "");
      } else {
        out = out.replace(/[。、]+$/u, "");
      }
    }
    return out;
  };

  if (atIndex !== null && atIndex > start && atIndex < end) {
    const left = joinSub(start, atIndex, true);
    const right = joinSub(atIndex, end, false);
    return `${left}@${right}`;
  }
  return joinSub(start, end, false);
}

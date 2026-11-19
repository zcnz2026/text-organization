import type {
  ArticleParagraph,
  CitationPair,
  HymnEntry,
  RichSheetGrid,
  RosterEntry,
} from "./catalog-types";
import { normalizeLangKey, resolvePunctuationRule } from "./lang-presets";
import {
  colLetterToIndex,
  DEFAULT_LANG_SHEET_COLS,
  DEFAULT_SHARED_SHEETS_CONFIG,
  type PerLanguageSheetColumnConfig,
  type SharedSheetsConfig,
} from "../types/schema-config";

const txt = (grid: RichSheetGrid, r: number, c: number) =>
  grid[r]?.[c]?.text?.trim() ?? "";

function getLangCandidates(langName: string): Set<string> {
  const rule = resolvePunctuationRule(langName);
  const expanded: string[] = [];
  for (const item of [langName, rule.langName, ...rule.aliases]) {
    const clean = normalizeLangKey(item);
    if (!clean) continue;
    expanded.push(clean);
    if (clean.endsWith("语") && clean.length >= 3) expanded.push(clean.slice(0, -1));
  }
  return new Set(expanded);
}

export function matchesLanguageCell(cellText: string, langName: string): boolean {
  const cellKey = normalizeLangKey(cellText);
  if (!cellKey) return false;
  for (const cand of getLangCandidates(langName)) {
    if (cand && (cellKey === cand || cellKey.includes(cand))) return true;
  }
  return false;
}

export function findLangColumn(row: { text: string }[], langName: string): number {
  for (let c = 0; c < row.length; c += 1) {
    if (matchesLanguageCell(row[c]?.text ?? "", langName)) return c;
  }
  return -1;
}

export function parseWordCitationsSheet(
  grid: RichSheetGrid,
  langName: string,
  cfg?: Partial<SharedSheetsConfig>,
): CitationPair[] {
  const pairs: CitationPair[] = [];
  if (grid.length < 2) return pairs;
  const m = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...cfg };
  const colZhDash = colLetterToIndex(m.wordCitationsZhDashCol, 0);
  const colZhBand = colLetterToIndex(m.wordCitationsZhBandCol, 1);
  const colEnRead = colLetterToIndex(m.wordCitationsEnReadCol, 2);
  const colEnBand = colLetterToIndex(m.wordCitationsEnBandCol, 3);

  let headerIdx = Math.max(0, (m.wordCitationsHeaderRow || 2) - 1);
  let colRead = -1;
  let colBand = -1;

  for (let r = headerIdx; r < Math.min(grid.length, 5); r += 1) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      const hText = row[c]?.text ?? "";
      if (!matchesLanguageCell(hText, langName)) continue;
      headerIdx = r;
      if (/视频|朗诵|特效|括号|read|video/i.test(hText)) {
        if (colRead < 0) colRead = c;
      } else if (/字幕|带|band|subtitle/i.test(hText)) {
        if (colBand < 0) colBand = c;
      } else if (colRead < 0) {
        colRead = c;
        const nextText = row[c + 1]?.text ?? "";
        if (matchesLanguageCell(nextText, langName) || /字幕|带|band|subtitle/i.test(nextText)) {
          colBand = c + 1;
        }
      } else if (colBand < 0) {
        colBand = c;
      }
    }
    if (colRead >= 0 || colBand >= 0) break;
  }

  if (colRead < 0 && colBand < 0) {
    for (let r = 0; r < headerIdx; r += 1) {
      const c = findLangColumn(grid[r] || [], langName);
      if (c >= 0) {
        headerIdx = r;
        colRead = c;
        const nextText = grid[r]?.[c + 1]?.text ?? "";
        colBand = matchesLanguageCell(nextText, langName) || !nextText ? c + 1 : c;
        break;
      }
    }
  }

  if (colRead < 0 && colBand < 0) return pairs;
  if (colRead < 0) colRead = colBand;
  if (colBand < 0) colBand = colRead;

  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const zhDash = txt(grid, r, colZhDash);
    const zhBand = txt(grid, r, colZhBand);
    const enRead = txt(grid, r, colEnRead);
    const enBand = txt(grid, r, colEnBand);
    const videoEffect = txt(grid, r, colRead);
    const subtitleBand = txt(grid, r, colBand);
    if ((!videoEffect && !subtitleBand) || (!zhDash && !zhBand && !enRead && !enBand)) continue;

    if (zhBand || enBand) {
      pairs.push({
        keyZh: zhBand || zhDash,
        keyEn: enBand || enRead,
        subtitleBand: subtitleBand || videoEffect,
        videoEffect: videoEffect || subtitleBand,
      });
    }
    if ((zhDash && zhDash !== zhBand) || (enRead && enRead !== enBand)) {
      pairs.push({
        keyZh: zhDash || zhBand,
        keyEn: enRead || enBand,
        subtitleBand: subtitleBand || videoEffect,
        videoEffect: videoEffect || subtitleBand,
      });
    }
  }
  return pairs;
}

export function parseHymnCitationsSheet(
  grid: RichSheetGrid,
  langName: string,
  cfg?: Partial<SharedSheetsConfig>,
): CitationPair[] {
  const pairs: CitationPair[] = [];
  if (grid.length < 2) return pairs;
  const m = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...cfg };
  const colZh = colLetterToIndex(m.hymnCitationsZhCol, 0);
  const colEn = colLetterToIndex(m.hymnCitationsEnCol, 1);

  let headerIdx = Math.max(0, (m.hymnCitationsHeaderRow || 1) - 1);
  let langCol = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const c = findLangColumn(grid[r] || [], langName);
    if (c >= 0) {
      headerIdx = r;
      langCol = c;
      break;
    }
  }
  if (langCol < 0) return pairs;

  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const zh = txt(grid, r, colZh);
    const en = txt(grid, r, colEn);
    const target = txt(grid, r, langCol);
    if (target && (zh || en)) {
      pairs.push({ keyZh: zh, keyEn: en, subtitleBand: target, videoEffect: target });
    }
  }
  return pairs;
}

const STANZA_RE = /^(?:[IVXⅠⅡⅢⅣⅤⅥⅦⅧ]+|\d+|[（(]?\d+[)）]?|\d+[.、])$/i;

function stripHymnBanner(s: string): string {
  return s
    .replace(/^(?:神话语?诗歌(?:标题)?|教会诗歌(?:标题)?)[：:\s]*/u, "")
    .replace(/^(?:hymn\s+of\s+god'?s\s+words|church\s+hymn)[：:\s]*/i, "")
    .replace(/^[《“"«„]+|[》”"»“]+$/g, "")
    .trim();
}

export function parseHymnSheet(
  grid: RichSheetGrid,
  cfg?: Partial<PerLanguageSheetColumnConfig>,
): HymnEntry[] {
  const hymns: HymnEntry[] = [];
  const m = { ...DEFAULT_LANG_SHEET_COLS, ...cfg };
  let colZh = colLetterToIndex(m.hymnZhCol, 0);
  let colEn = colLetterToIndex(m.hymnEnCol, 1);
  let colTarget = colLetterToIndex(m.hymnTargetCol, 2);

  // Auto-detect shifted columns (e.g. A blank, B=中文, C=英文, D=外文)
  let detectedByHeader = false;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const row = grid[r] ?? [];
    const zhIdx = row.findIndex((c) => /^中文$|^chinese$/i.test((c?.text ?? "").trim()));
    const enIdx = row.findIndex((c) => /^英文$|^english$/i.test((c?.text ?? "").trim()));
    if (zhIdx >= 0 && enIdx > zhIdx) {
      colZh = zhIdx;
      colEn = enIdx;
      const tgIdx = row.findIndex((c, idx) => idx > enIdx && (c?.text ?? "").trim().length > 0);
      colTarget = tgIdx > enIdx ? tgIdx : enIdx + 1;
      detectedByHeader = true;
      break;
    }
  }
  if (!detectedByHeader && !cfg?.hymnZhCol && colZh === 0) {
    let col0Hits = 0;
    let col123Hits = 0;
    for (let r = 0; r < Math.min(grid.length, 60); r += 1) {
      if (txt(grid, r, 0)) col0Hits += 1;
      if (txt(grid, r, 1) && txt(grid, r, 2) && txt(grid, r, 3)) col123Hits += 1;
    }
    if (col0Hits <= 1 && col123Hits >= 3) {
      colZh = 1;
      colEn = 2;
      colTarget = 3;
    }
  }

  let current: HymnEntry | null = null;
  let inWordHymnSection = false;
  let currentIsWordHymnTitleOnly = false;
  let expectTitleRow = false;
  let sawBlankRow = false;

  for (let r = 0; r < grid.length; r += 1) {
    const c0 = txt(grid, r, colZh);
    const c1 = txt(grid, r, colEn);
    const c2 = txt(grid, r, colTarget);
    if (!c0 && !c1 && !c2) {
      sawBlankRow = true;
      continue;
    }
    if (r < 4 && (/^中文$|^chinese$/i.test(c0) || /^英文$|^english$/i.test(c1))) continue;
    if (STANZA_RE.test(c0) && (!c1 || STANZA_RE.test(c1)) && (!c2 || STANZA_RE.test(c2))) {
      sawBlankRow = false;
      continue;
    }

    const isCitationRow =
      c0.includes("跟随羔羊唱新歌") ||
      c0.startsWith("——《") ||
      /^《话[・·]/u.test(c0) ||
      c1.toLowerCase().startsWith("from ");
    if (isCitationRow) {
      if (current && c2) current.targetCitation = c2;
      sawBlankRow = false;
      continue;
    }

    const isWordBanner = /^神话语?诗歌(?:标题)?[：:]/u.test(c0);
    const isChurchBanner = /^教会诗歌(?:标题)?[：:]/u.test(c0);
    if (isWordBanner) {
      inWordHymnSection = true;
      expectTitleRow = true;
    }
    if (isChurchBanner) {
      inWordHymnSection = false;
      expectTitleRow = true;
    }

    const looksLikeBareTitle =
      (!current || expectTitleRow || sawBlankRow || currentIsWordHymnTitleOnly) &&
      Boolean(c0 && c1 && c2 && c0.length < 40 && !/[，。,.!?！？；;]/.test(c0));

    if (isWordBanner || isChurchBanner || /^《.+》$/.test(c0) || looksLikeBareTitle) {
      const zhTitle = stripHymnBanner(c0);
      const enTitle = stripHymnBanner(c1);
      const targetTitle = stripHymnBanner(c2);
      if (zhTitle || enTitle || targetTitle) {
        current = { zhTitle, enTitle, targetTitle, lines: [] };
        currentIsWordHymnTitleOnly = isWordBanner || inWordHymnSection;
        hymns.push(current);
        expectTitleRow = false;
      }
      sawBlankRow = false;
      continue;
    }

    sawBlankRow = false;
    if (current && c2 && !currentIsWordHymnTitleOnly) {
      const cleanStanza = (v: string) => v.replace(/^(?:[IVXⅠⅡⅢⅣ]+|\d+)[.、\s]+/i, "").trim();
      current.lines.push({ chinese: cleanStanza(c0), english: cleanStanza(c1), target: cleanStanza(c2) });
    }
  }
  return hymns;
}

export interface ParsedLordsPrayerResult extends Array<ArticleParagraph> {
  lines: ArticleParagraph[];
  fullText: string;
}

export function parseLordsPrayerSheet(
  grid: RichSheetGrid,
  langName: string,
  cfg?: Partial<SharedSheetsConfig>,
): ParsedLordsPrayerResult {
  const lines: ArticleParagraph[] = [];
  let fullText = "";
  const attach = (arr: ArticleParagraph[], full: string): ParsedLordsPrayerResult => {
    const out = [...arr] as ParsedLordsPrayerResult;
    out.lines = arr;
    out.fullText = full;
    return out;
  };
  if (grid.length === 0) return attach(lines, fullText);
  const m = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...cfg };
  const colA = colLetterToIndex(m.lordsPrayerZhCol, 0);
  const colB = colLetterToIndex(m.lordsPrayerEnCol, 1);

  for (let r = 0; r < grid.length; r += 1) {
    const cellA = txt(grid, r, colA);
    const cellB = txt(grid, r, colB);
    if (cellA && cellB && matchesLanguageCell(cellA, langName)) {
      fullText = cellB;
      const splitLines = cellB.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (splitLines.length > 1) {
        for (const sl of splitLines) lines.push({ chinese: "", english: "", target: sl });
      }
      return attach(lines, fullText);
    }
  }

  let headerIdx = Math.max(0, (m.lordsPrayerHeaderRow || 1) - 1);
  let langCol = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const c = findLangColumn(grid[r] || [], langName);
    if (c >= 0) {
      headerIdx = r;
      langCol = c;
      break;
    }
  }
  if (langCol < 0) return attach(lines, fullText);
  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const target = txt(grid, r, langCol);
    if (target) lines.push({ chinese: txt(grid, r, colA), english: txt(grid, r, colB), target });
  }
  return attach(lines, lines.map((l) => l.target).join(" "));
}

export function parseRosterSheet(
  grid: RichSheetGrid,
  langName: string,
  cfg?: Partial<SharedSheetsConfig>,
): RosterEntry[] {
  const entries: RosterEntry[] = [];
  if (grid.length < 2) return entries;
  const m = { ...DEFAULT_SHARED_SHEETS_CONFIG, ...cfg };
  const colZh = colLetterToIndex(m.rosterZhCol, 2);
  const colEn = colLetterToIndex(m.rosterEnCol, 3);
  const colEp = colLetterToIndex(m.rosterEpisodeCol, 5);

  let headerIdx = Math.max(0, (m.rosterHeaderRow || 2) - 1);
  let langCol = -1;
  for (let r = 0; r < Math.min(grid.length, 5); r += 1) {
    const c = findLangColumn(grid[r] || [], langName);
    if (c >= 0) {
      headerIdx = r;
      langCol = c;
      break;
    }
  }
  if (langCol < 0) return entries;
  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const chinese = txt(grid, r, colZh);
    const english = txt(grid, r, colEn);
    const targetText = txt(grid, r, langCol);
    if (targetText && (chinese || english)) {
      entries.push({ chinese, english, episode: txt(grid, r, colEp), targetText });
    }
  }
  return entries;
}

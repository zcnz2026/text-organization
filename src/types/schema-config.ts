import type { LanguageResourceLinks, PunctuationRule } from "./domain";

export interface SourceScriptColumnConfig {
  autoDetectByHeader: boolean;
  headerRowNumber: number;
  lineCol: string;
  inTimeCol: string;
  outTimeCol: string;
  characterCol: string;
  chineseCol: string;
  englishCol: string;
  targetLangCol: string;
  noteCol: string;
  remarkCol: string;
  sendRemarkCol: string;
  filterCol: string;
  needExtractCol: string;
  outputHintCol: string;
}

export interface SharedSheetsConfig {
  overviewMatrixUrl: string;
  commonTermsUrl: string;
  commonTermsHeaderRow: number;
  commonTermsZhCol: string;
  commonTermsEnCol: string;
  commonTermsNoteCol: string;

  wordCitationsUrl: string;
  wordCitationsHeaderRow: number;
  wordCitationsZhDashCol: string;
  wordCitationsZhBandCol: string;
  wordCitationsEnReadCol: string;
  wordCitationsEnBandCol: string;

  hymnCitationsUrl: string;
  hymnCitationsHeaderRow: number;
  hymnCitationsZhCol: string;
  hymnCitationsEnCol: string;

  lordsPrayerUrl: string;
  lordsPrayerHeaderRow: number;
  lordsPrayerZhCol: string;
  lordsPrayerEnCol: string;

  rosterUrl: string;
  rosterHeaderRow: number;
  rosterZhCol: string;
  rosterEnCol: string;
  rosterEpisodeCol: string;
}

export interface PerLanguageSheetColumnConfig {
  catalogHeaderRow: number;
  catalogZhBracketCol: string;
  catalogZhLineCol: string;
  catalogZhTitleCol: string;
  catalogEnTitleCol: string;
  catalogTargetTitleCol: string;
  catalogDocLinkCol: string;
  catalogTargetCiteCol: string;
  catalogTargetBracketCiteCol: string;
  catalogTargetSubtitleBandCiteCol: string;

  manuscriptZhColIndex: number;
  manuscriptEnColIndex: number;
  manuscriptTargetColIndex: number;

  bibleHeaderRow: number;
  bibleChapterCol: string;
  bibleZhCol: string;
  bibleEnCol: string;
  bibleTargetCol: string;
  bibleSourceCol: string;

  idiomHeaderRow: number;
  idiomZhCol: string;
  idiomEn1Col: string;
  idiomEn2Col: string;
  idiomTargetCol: string;

  hymnHeaderRow: number;
  hymnZhCol: string;
  hymnEnCol: string;
  hymnTargetCol: string;
}

export interface CloudWorkspaceConfig {
  sourceCols: SourceScriptColumnConfig;
  sharedSheets: SharedSheetsConfig;
  linksByLang: Record<string, LanguageResourceLinks>;
  colsByLang: Record<string, PerLanguageSheetColumnConfig>;
  rules: PunctuationRule[];
}

export const DEFAULT_SOURCE_COL_CONFIG: SourceScriptColumnConfig = {
  autoDetectByHeader: true,
  headerRowNumber: 2,
  lineCol: "A",
  inTimeCol: "B",
  outTimeCol: "C",
  characterCol: "D",
  chineseCol: "E",
  englishCol: "F",
  targetLangCol: "G",
  noteCol: "H",
  remarkCol: "I",
  sendRemarkCol: "J",
  filterCol: "K",
  needExtractCol: "L",
  outputHintCol: "AUTO",
};

export const DEFAULT_SHARED_SHEETS_CONFIG: SharedSheetsConfig = {
  overviewMatrixUrl: "",
  commonTermsUrl: "",
  commonTermsHeaderRow: 1,
  commonTermsZhCol: "A",
  commonTermsEnCol: "B",
  commonTermsNoteCol: "C",

  wordCitationsUrl: "",
  wordCitationsHeaderRow: 2,
  wordCitationsZhDashCol: "A",
  wordCitationsZhBandCol: "B",
  wordCitationsEnReadCol: "C",
  wordCitationsEnBandCol: "D",

  hymnCitationsUrl: "",
  hymnCitationsHeaderRow: 1,
  hymnCitationsZhCol: "A",
  hymnCitationsEnCol: "B",

  lordsPrayerUrl: "",
  lordsPrayerHeaderRow: 1,
  lordsPrayerZhCol: "A",
  lordsPrayerEnCol: "B",

  rosterUrl: "",
  rosterHeaderRow: 2,
  rosterZhCol: "C",
  rosterEnCol: "D",
  rosterEpisodeCol: "F",
};

export const DEFAULT_LANG_SHEET_COLS: PerLanguageSheetColumnConfig = {
  catalogHeaderRow: 1,
  catalogZhBracketCol: "B",
  catalogZhLineCol: "C",
  catalogZhTitleCol: "D",
  catalogEnTitleCol: "E",
  catalogTargetTitleCol: "F",
  catalogDocLinkCol: "G",
  catalogTargetCiteCol: "H",
  catalogTargetBracketCiteCol: "I",
  catalogTargetSubtitleBandCiteCol: "",

  manuscriptZhColIndex: 1,
  manuscriptEnColIndex: 2,
  manuscriptTargetColIndex: 3,

  bibleHeaderRow: 2,
  bibleChapterCol: "B",
  bibleZhCol: "C",
  bibleEnCol: "D",
  bibleTargetCol: "E",
  bibleSourceCol: "",

  idiomHeaderRow: 1,
  idiomZhCol: "F",
  idiomEn1Col: "G",
  idiomEn2Col: "I",
  idiomTargetCol: "J",

  hymnHeaderRow: 1,
  hymnZhCol: "A",
  hymnEnCol: "B",
  hymnTargetCol: "C",
};

export function colLetterToIndex(col: string, fallback = 0): number {
  const clean = (col || "").trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(clean)) return fallback;
  let n = 0;
  for (let i = 0; i < clean.length; i += 1) {
    n = n * 26 + (clean.charCodeAt(i) - 64);
  }
  return n - 1;
}

export function indexToColLetter(idx: number): string {
  let n = idx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

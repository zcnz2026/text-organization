export type CitationVariant = "subtitle_band" | "video_effect";

export type PeriodPlacementMode =
  | "outside"
  | "inside"
  | "sentence_inside_phrase_outside";

export type BibleCitationMode =
  | "same_as_english"
  | "period_inside_quote_no_trailing";

export interface PunctuationRule {
  langCode: string;
  langName: string;
  aliases: string[];
  doubleOpen: string;
  doubleClose: string;
  singleOpen: string;
  singleClose: string;
  tertiaryOpen?: string;
  tertiaryClose?: string;
  apostrophe: string;
  ellipsis: string;
  commaInsideQuote: boolean;
  periodMode: PeriodPlacementMode;
  periodQuotePattern?: string;
  exclamQuestionQuotePattern?: string;
  bibleCitationMode: BibleCitationMode;
  singleCitationRowOnly: boolean;
  sentencePeriodChar?: string;
  preserveInnerQuotes?: boolean;
  noAdjacentDoubleQuotes?: boolean;
  noCitationDoubleOpen?: string;
  noCitationDoubleClose?: string;
  notes?: string;
}

export interface LanguageResourceLinks {
  langName: string;
  articleCatalogUrl: string;
  bibleSheetUrl: string;
  idiomSheetUrl: string;
  punctuationDocUrl: string;
  commonTermsUrl: string;
  godSaysUrl: string;
  hymnSheetUrl: string;
  lordsPrayerUrl: string;
  rosterSheetUrl: string;
  extraCitationSheetUrl?: string;
  quoteRuleRaw?: string;
  endingRuleRaw?: string;
  bibleRuleRaw?: string;
}

export interface ScriptColumnMap {
  line: number;
  inTime: number;
  outTime: number;
  character: number;
  chinese: number;
  english: number;
  targetLanguage: number;
  note: number;
  remark: number;
  sendRemark: number;
  filterCategory: number;
  needExtract: number;
}

export interface ScriptRow {
  rowIndex: number;
  rawCells: string[];
  line: string;
  inTime: string;
  outTime: string;
  character: string;
  chinese: string;
  english: string;
  targetLanguage: string;
  note: string;
  remark: string;
  sendRemark: string;
  filterCategory: string;
  needExtract: string;
}

export type BlockKind =
  | "god_words_prefix"
  | "god_words_body"
  | "citation_subtitle"
  | "hymn_lyrics"
  | "bible_verses"
  | "idiom"
  | "lords_prayer"
  | "standalone_title"
  | "combo_title"
  | "inline_note_xx"
  | "roster_match";

export interface ExtractionTask {
  id: string;
  kind: BlockKind;
  rowIndices: number[];
  sourceHint: string;
  citationRowIndex?: number;
  citationVariant?: CitationVariant;
}

export type ReviewStatus = "untouched" | "matched" | "warning" | "missing";

export interface ProcessedRowResult {
  rowIndex: number;
  targetLanguage: string;
  note: string;
  status: ReviewStatus;
  hint: string;
  bibleSource?: string;
}

export interface LanguageRunOutput {
  langName: string;
  rows: ProcessedRowResult[];
  matchedCount: number;
  warningCount: number;
  missingCount: number;
}

export interface ScriptSheetDocument {
  title: string;
  headerRows: string[][];
  columnMap: ScriptColumnMap;
  rows: ScriptRow[];
  sourceSpreadsheetId?: string;
  sourceSheetId?: number;
}

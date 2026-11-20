export type LineBreakMeasureMode = "char" | "ruler";

export interface LineBreakLanguageSpec {
  code: string;
  name: string;
  aliases: string[];
  mode: LineBreakMeasureMode;
  tier: 1 | 2 | 3;
  fontFamily: string;
  fontSizePt: number;
  dir: "ltr" | "rtl";
  /** Single-line character limit (for mode="char") */
  singleMax: number;
  /** Same-screen two-line character limit (for mode="char") */
  doubleMax: number;
  /** Buffer upper bound where single line is tolerated if breaking violates 1:3 ratio (e.g. 50) */
  softNoBreakMax: number;
  /** Threshold where two independent sentences should split into two screens early (e.g. 76) */
  earlySplitSentenceMin: number;
  /** Buffer upper bound where a tight single clause may stay on one screen (e.g. 90) */
  compactSameScreenMax: number;
  /** Standard 1x ruler sample string (validated on screen at fontSizePt Regular) */
  rulerText?: string;
  /** Explicit pixel width for 1x ruler when specified (e.g. Arabic 320px) */
  fixedRulerPx?: number;
  /** Native sentence-ending punctuation marks for two-sentence detection */
  sentenceEndChars: string[];
  /** Japanese special punctuation & 22-char rules */
  isJapanese?: boolean;
  notes?: string;
  /** Optional per-language custom instruction appended to AI system prompt */
  customPromptRule?: string;
  /** True when added as a new user-defined language */
  isCustom?: boolean;
}

export interface GlobalLineBreakRuleConfig {
  /** Minimum allowed top/bottom line length ratio (default 0.33, i.e. 1:3) */
  minLineRatio: number;
  /** Maximum allowed top/bottom line length ratio (default 2.7) */
  maxLineRatio: number;
  /** Minimum screen length below which L-column warns about fragmented split screens (default 15) */
  minShortScreenWarn: number;
  /** Global custom prompt rules injected into AI system instruction across all languages */
  globalCustomPrompt: string;
}

export interface SubtitleSheetColumnMap {
  lineCol: number;
  inTimeCol: number;
  outTimeCol: number;
  characterCol: number;
  chineseCol: number;
  englishCol: number;
  targetCol: number;
  citationCol: number;
  noteCol: number;
}

export interface ImportedSubtitleRow {
  /** 0-based index within data rows */
  rowIndex: number;
  /** 1-based Excel/Sheet row number in source sheet */
  excelRowNumber: number;
  rawCells: string[];
  /** Hex RGB (6 chars uppercase, e.g. "00FF00", "FFFF00") per cell if filled */
  cellFillRgb: Array<string | null>;
  /** Hex RGB (6 chars uppercase, e.g. "0000FF", "CC0000") per cell font color if non-black */
  cellFontRgb: Array<string | null>;
  /** Whether each cell has bold font formatting (e.g. God's words in E/F/G) */
  cellBold: boolean[];
  isGreenHighlight: boolean;
  isGrayHighlight: boolean;
}

export interface ImportedSubtitleWorkbook {
  fileName: string;
  sourceSpreadsheetId?: string;
  sheetNames: string[];
  activeSheetName: string;
  sheets: Record<string, ImportedSubtitleSheet>;
}

export interface ImportedSubtitleSheet {
  sheetName: string;
  sourceSpreadsheetId?: string;
  sourceSheetId?: number;
  frozenRowCount: number;
  /** Excel character width per column (null = default) */
  colWidths: Array<number | null>;
  /** Hidden flag per column (e.g. cols L..O hidden in template) */
  colHidden: boolean[];
  headerRows: string[][];
  headerFillRgb: Array<Array<string | null>>;
  headerFontRgb: Array<Array<string | null>>;
  headerBold: boolean[][];
  /** Indices of columns in source sheet that are pre-existing H/I/J LEN/SEARCH helper formulas */
  detectedFormulaCols: number[];
  /** Optional formula templates extracted from a source data row (with row index placeholder "{ROW}") */
  sourceFormulaTemplates?: [string, string, string] | null;
  columnMap: SubtitleSheetColumnMap;
  rows: ImportedSubtitleRow[];
}

export type SubtitleRowCategory =
  | "skip_green"
  | "skip_empty"
  | "skip_title_graphic"
  | "citation_same_screen"
  | "short_keep"
  | "needs_break";

export type BreakOutcomeStatus =
  | "untouched"
  | "broken_same_screen"
  | "split_multi_screen"
  | "citation_broken"
  | "soft_kept_single"
  | "compact_kept_double"
  | "skip_green"
  | "review_warning";

export interface ScreenLineMetrics {
  text: string;
  rawCharLen: number;
  measuredTotal: number;
  hasAt: boolean;
  beforeAtLen: number | null;
  afterAtLen: number | null;
  measuredBeforeAt: number | null;
  measuredAfterAt: number | null;
  ratio: number | null;
  exceedsSingleLimit: boolean;
  ratioOutOfBounds: boolean;
}

export interface ProcessedSubtitleRow {
  sourceRowIndex: number;
  category: SubtitleRowCategory;
  status: BreakOutcomeStatus;
  usedAi: boolean;
  screens: ScreenLineMetrics[];
  reason: string;
  /** Non-empty only when human review/verification is needed (written to Col L) */
  reviewNote: string;
  /** True when user manually edited text, split, or merged this row in preview */
  manuallyEdited?: boolean;
}

export interface SubtitleLineBreakRun {
  langSpec: LineBreakLanguageSpec;
  sheetName: string;
  results: ProcessedSubtitleRow[];
  totalSourceRows: number;
  totalOutputScreens: number;
  sameScreenAtCount: number;
  insertedScreenRowsCount: number;
  skippedGreenCount: number;
  reviewCount: number;
}

export interface SheetTabCandidate {
  sheetId: number;
  title: string;
  hidden: boolean;
  isProcessedOutput: boolean;
}

export type BatchItemStatus =
  | "pending_confirm_sheet"
  | "queued"
  | "running"
  | "writing"
  | "paused_key"
  | "ready_review"
  | "completed"
  | "error";

export interface BatchLineBreakItem {
  id: string;
  /** 1-based row number in the Master Sheet */
  masterExcelRow: number;
  /** Name in Col A of the Master Sheet (e.g. "意语-批量表") */
  label: string;
  /** URL in Col B of the Master Sheet */
  sourceUrl: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  langCode: string;
  langDetected: boolean;
  /** All visible candidate tabs found in the target spreadsheet */
  availableTabs: SheetTabCandidate[];
  selectedSheetId: number;
  selectedSheetTitle: string;
  /** True when >1 candidate source tabs exist and human hasn't confirmed yet */
  needsSheetConfirm: boolean;
  status: BatchItemStatus;
  doneAiRows: number;
  totalAiRows: number;
  reviewCount: number;
  totalOutputScreens: number;
  outputSheetUrl?: string;
  outputSheetTitle?: string;
  errorMessage?: string;
  /** Cached workbook & run in memory for instant 1:1 preview in UI */
  cachedSheet?: ImportedSubtitleSheet;
  cachedRun?: SubtitleLineBreakRun;
}

export interface BatchMasterQueue {
  masterUrl: string;
  masterSpreadsheetId?: string;
  masterSheetTitle?: string;
  items: BatchLineBreakItem[];
}

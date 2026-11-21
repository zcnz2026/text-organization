import { BUILTIN_PUNCTUATION_RULES } from "../catalog/lang-presets";
import type {
  BatchMasterQueue,
  ImportedSubtitleWorkbook,
  SubtitleLineBreakRun,
} from "../linebreak/types";
import type { UpdateCheckResult } from "../platform/updater";
import type {
  GeminiModelId,
  KeyRotationStrategy,
  OAuthSessionInfo,
  WorkbenchSettings,
} from "../types/config";
import type {
  LanguageResourceLinks,
  LanguageRunOutput,
  PunctuationRule,
  ScriptSheetDocument,
} from "../types/domain";
import {
  DEFAULT_LANG_SHEET_COLS,
  DEFAULT_SHARED_SHEETS_CONFIG,
  DEFAULT_SOURCE_COL_CONFIG,
  type PerLanguageSheetColumnConfig,
  type SharedSheetsConfig,
  type SourceScriptColumnConfig,
} from "../types/schema-config";

const SETTINGS_STORAGE_KEY = "script_lang_workbench_settings_v1";
const CUSTOM_RULES_KEY = "script_lang_custom_rules_v1";
const AI_SETTINGS_KEY = "script_lang_ai_config_v1";
const SCHEMA_STORAGE_KEY = "script_lang_schema_config_v1";
const UI_TAB_STORAGE_KEY = "script_lang_ui_tab_prefs_v1";

export type MainWorkbenchTab = "extract" | "linebreak";
export type LineBreakWorkMode = "single" | "batch";
export type LineBreakRowFilter = "all" | "changed" | "review" | "special";
export type RowFilterMode = "all" | "extractable" | "missing" | "matched" | "review";
export type TableWrapMode = "nowrap" | "wrap";
export type TableFontSize = "sm" | "md" | "lg";

export interface LineBreakUiState {
  mode: LineBreakWorkMode;
  sourceSheetUrl: string;
  outputSheetUrl: string;
  masterSheetUrl: string;
  batchQueue: BatchMasterQueue | null;
  /** Non-empty when user clicked "预览核对" on a specific batch item while in batch mode */
  batchInspectingItemId: string | null;
  /** Concurrent workers for batch mode (default 5, range 1..10) */
  batchConcurrency: number;
  /** True while background batch line-breaking workers are running (does NOT block preview/write of completed items!) */
  batchRunning: boolean;
  /** True when current background batch run is in "完成即写" auto-write mode */
  batchAutoWriteRunning: boolean;
  batchProgressPercent: number;
  batchProgressText: string;
  /** Source row index most recently manually edited/split/merged, highlighted visually */
  lastManualRowIndex: number | null;
  singlePausedProgress: {
    done: number;
    total: number;
    message: string;
    isKeyError: boolean;
  } | null;
  workbook: ImportedSubtitleWorkbook | null;
  langCode: string;
  useAi: boolean;
  showHiddenCols: boolean;
  /** User-resized column widths in px keyed by column letter (e.g. { E: 260, G: 340 }) */
  customColWidths: Record<string, number>;
  /** Columns manually hidden by the user in preview (e.g. ["B", "C", "D", "K"]) */
  userHiddenCols: string[];
  run: SubtitleLineBreakRun | null;
  filter: LineBreakRowFilter;
  searchQuery: string;
}

const LB_COL_PREFS_STORAGE_KEY = "script_lang_lb_col_prefs_v1";

function loadLineBreakColPrefs(): {
  customColWidths: Record<string, number>;
  userHiddenCols: string[];
} {
  try {
    const raw = localStorage.getItem(LB_COL_PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        customColWidths?: Record<string, number>;
        userHiddenCols?: string[];
      };
      return {
        customColWidths:
          parsed.customColWidths && typeof parsed.customColWidths === "object"
            ? parsed.customColWidths
            : {},
        userHiddenCols: Array.isArray(parsed.userHiddenCols) ? parsed.userHiddenCols : [],
      };
    }
  } catch {
    // ignore
  }
  return { customColWidths: {}, userHiddenCols: [] };
}

export function saveLineBreakColPrefs(): void {
  try {
    localStorage.setItem(
      LB_COL_PREFS_STORAGE_KEY,
      JSON.stringify({
        customColWidths: store.lineBreak.customColWidths,
        userHiddenCols: store.lineBreak.userHiddenCols,
      }),
    );
  } catch {
    // ignore
  }
}

export const DEFAULT_TABLE_COL_WIDTHS = [48, 84, 92, 160, 170, 195, 130, 185, 105];

const COL_WIDTHS_STORAGE_KEY = "script_lang_col_widths_v4";

function loadSavedColWidths(): number[] {
  try {
    const raw = localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length === DEFAULT_TABLE_COL_WIDTHS.length && arr.every((n) => typeof n === "number" && n >= 36)) {
        return arr;
      }
    }
  } catch {
    // ignore storage errors
  }
  return [...DEFAULT_TABLE_COL_WIDTHS];
}

export function saveTableColWidths(): void {
  try {
    localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(store.tableColWidths));
  } catch {
    // ignore
  }
}

export interface AppState {
  settings: WorkbenchSettings;
  cloudConfigUrl: string;
  sourceColConfig: SourceScriptColumnConfig;
  sharedSheets: SharedSheetsConfig;
  colsByLang: Record<string, PerLanguageSheetColumnConfig>;
  hymnEpisodeKeyword: string;
  episodeHymnOverrides: Record<string, string>;
  auth: OAuthSessionInfo;
  geminiSummary: { count: number; maskedKeys: string[] };
  geminiModel: GeminiModelId;
  geminiReviewModel: string;
  geminiPaidUnlimited: boolean;
  geminiRotation: KeyRotationStrategy;
  geminiEnabled: boolean;
  availableLanguages: string[];
  customRules: PunctuationRule[];
  linksByLang: Map<string, LanguageResourceLinks>;
  scriptDoc: ScriptSheetDocument | null;
  runsByLang: Map<string, LanguageRunOutput>;
  activePreviewLang: string;
  rowFilter: RowFilterMode;
  tableWrapMode: TableWrapMode;
  tableFontSize: TableFontSize;
  tableColWidths: number[];
  searchQuery: string;
  activeMainTab: MainWorkbenchTab;
  lineBreak: LineBreakUiState;
  busy: boolean;
  progressPercent: number;
  progressText: string;
  notice: { type: "info" | "error"; message: string } | null;
  availableUpdate: UpdateCheckResult | null;
}

interface PersistedSchemaBundle {
  cloudConfigUrl: string;
  sourceColConfig: SourceScriptColumnConfig;
  sharedSheets: SharedSheetsConfig;
  colsByLang: Record<string, PerLanguageSheetColumnConfig>;
  linksByLangObj: Record<string, LanguageResourceLinks>;
  availableLanguages: string[];
  hymnEpisodeKeyword: string;
  episodeHymnOverrides: Record<string, string>;
}

function loadSavedSettings(): WorkbenchSettings {
  const defaults: WorkbenchSettings = {
    sourceSpreadsheetUrl: "",
    sourceSheetName: "",
    resourceMatrixUrl: "",
    rosterSpreadsheetUrl: "",
    outputSpreadsheetUrl: "",
    selectedLanguages: ["乌克兰语", "西语", "印尼语"],
    enableRosterPreFill: true,
    overwriteExistingSheets: true,
    themeMode: "system",
  };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function loadSchemaBundle(): PersistedSchemaBundle {
  const presetLangs = BUILTIN_PUNCTUATION_RULES.map((r) => r.langName);
  const defaults: PersistedSchemaBundle = {
    cloudConfigUrl: "",
    sourceColConfig: { ...DEFAULT_SOURCE_COL_CONFIG },
    sharedSheets: { ...DEFAULT_SHARED_SHEETS_CONFIG },
    colsByLang: {},
    linksByLangObj: {},
    availableLanguages: presetLangs,
    hymnEpisodeKeyword: "",
    episodeHymnOverrides: {},
  };
  try {
    const raw = localStorage.getItem(SCHEMA_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedSchemaBundle>;
    const mergedLangs = Array.from(
      new Set([...presetLangs, ...(parsed.availableLanguages ?? [])]),
    );
    return {
      cloudConfigUrl: parsed.cloudConfigUrl ?? "",
      sourceColConfig: {
        ...DEFAULT_SOURCE_COL_CONFIG,
        ...(parsed.sourceColConfig ?? {}),
      },
      sharedSheets: {
        ...DEFAULT_SHARED_SHEETS_CONFIG,
        ...(parsed.sharedSheets ?? {}),
      },
      colsByLang: parsed.colsByLang ?? {},
      linksByLangObj: parsed.linksByLangObj ?? {},
      availableLanguages: mergedLangs,
      hymnEpisodeKeyword: parsed.hymnEpisodeKeyword ?? "",
      episodeHymnOverrides: parsed.episodeHymnOverrides ?? {},
    };
  } catch {
    return defaults;
  }
}

function loadCustomRules(): PunctuationRule[] {
  try {
    const raw = localStorage.getItem(CUSTOM_RULES_KEY);
    return raw ? (JSON.parse(raw) as PunctuationRule[]) : [];
  } catch {
    return [];
  }
}

function loadAiPrefs(): {
  enabled: boolean;
  model: GeminiModelId;
  reviewModel: string;
  paidUnlimited: boolean;
  rotation: KeyRotationStrategy;
} {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        enabled?: boolean;
        model?: string;
        reviewModel?: string;
        paidUnlimited?: boolean;
        rotation?: KeyRotationStrategy;
      };
      const rawModel = typeof parsed.model === "string" ? parsed.model.trim() : "";
      const model: GeminiModelId = rawModel || "gemini-3.8-flash";
      return {
        enabled: parsed.enabled ?? true,
        model,
        reviewModel: typeof parsed.reviewModel === "string" ? parsed.reviewModel.trim() : "",
        paidUnlimited: Boolean(parsed.paidUnlimited),
        rotation: parsed.rotation === "failover" ? "failover" : "round_robin",
      };
    }
  } catch {
    // ignore
  }
  return {
    enabled: true,
    model: "gemini-3.8-flash",
    reviewModel: "",
    paidUnlimited: false,
    rotation: "round_robin",
  };
}

function loadUiTabPrefs(): {
  activeMainTab: MainWorkbenchTab;
  lbMode: LineBreakWorkMode;
  lbLangCode: string;
  lbUseAi: boolean;
  lbSourceUrl: string;
  lbOutputUrl: string;
  lbMasterUrl: string;
  lbBatchConcurrency: number;
} {
  try {
    const raw = localStorage.getItem(UI_TAB_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        activeMainTab?: string;
        lbMode?: string;
        lbLangCode?: string;
        lbUseAi?: boolean;
        lbSourceUrl?: string;
        lbOutputUrl?: string;
        lbMasterUrl?: string;
        lbBatchConcurrency?: number;
      };
      const conc = Number(parsed.lbBatchConcurrency);
      return {
        activeMainTab: parsed.activeMainTab === "linebreak" ? "linebreak" : "extract",
        lbMode: parsed.lbMode === "batch" ? "batch" : "single",
        lbLangCode: parsed.lbLangCode || "it",
        lbUseAi: parsed.lbUseAi ?? true,
        lbSourceUrl: parsed.lbSourceUrl ?? "",
        lbOutputUrl: parsed.lbOutputUrl ?? "",
        lbMasterUrl: parsed.lbMasterUrl ?? "",
        lbBatchConcurrency: Number.isFinite(conc) && conc >= 1 && conc <= 10 ? Math.round(conc) : 5,
      };
    }
  } catch {
    // ignore
  }
  return {
    activeMainTab: "extract",
    lbMode: "single",
    lbLangCode: "it",
    lbUseAi: true,
    lbSourceUrl: "",
    lbOutputUrl: "",
    lbMasterUrl: "",
    lbBatchConcurrency: 5,
  };
}

const uiTabPrefs = loadUiTabPrefs();
const aiPrefs = loadAiPrefs();
const savedSettings = loadSavedSettings();
const schemaBundle = loadSchemaBundle();

if (!schemaBundle.cloudConfigUrl && savedSettings.resourceMatrixUrl) {
  schemaBundle.cloudConfigUrl = savedSettings.resourceMatrixUrl;
}
if (!schemaBundle.sharedSheets.rosterUrl && savedSettings.rosterSpreadsheetUrl) {
  schemaBundle.sharedSheets.rosterUrl = savedSettings.rosterSpreadsheetUrl;
}

const lbColPrefs = loadLineBreakColPrefs();

export const store: AppState = {
  settings: savedSettings,
  cloudConfigUrl: schemaBundle.cloudConfigUrl,
  sourceColConfig: schemaBundle.sourceColConfig,
  sharedSheets: schemaBundle.sharedSheets,
  colsByLang: schemaBundle.colsByLang,
  hymnEpisodeKeyword: schemaBundle.hymnEpisodeKeyword,
  episodeHymnOverrides: schemaBundle.episodeHymnOverrides,
  auth: {
    hasClientJson: false,
    authorized: false,
    email: "",
    clientIdMasked: "",
    expiresAt: 0,
  },
  geminiSummary: { count: 0, maskedKeys: [] },
  geminiModel: aiPrefs.model,
  geminiReviewModel: aiPrefs.reviewModel,
  geminiPaidUnlimited: aiPrefs.paidUnlimited,
  geminiRotation: aiPrefs.rotation,
  geminiEnabled: aiPrefs.enabled,
  availableLanguages: schemaBundle.availableLanguages,
  customRules: loadCustomRules(),
  linksByLang: new Map(Object.entries(schemaBundle.linksByLangObj)),
  scriptDoc: null,
  runsByLang: new Map(),
  activePreviewLang: "",
  rowFilter: "extractable",
  tableWrapMode: "wrap",
  tableFontSize: "sm",
  tableColWidths: loadSavedColWidths(),
  searchQuery: "",
  activeMainTab: uiTabPrefs.activeMainTab,
  lineBreak: {
    mode: uiTabPrefs.lbMode,
    sourceSheetUrl: uiTabPrefs.lbSourceUrl,
    outputSheetUrl: uiTabPrefs.lbOutputUrl,
    masterSheetUrl: uiTabPrefs.lbMasterUrl,
    batchQueue: null,
    batchInspectingItemId: null,
    batchConcurrency: uiTabPrefs.lbBatchConcurrency,
    batchRunning: false,
    batchAutoWriteRunning: false,
    batchProgressPercent: 0,
    batchProgressText: "",
    lastManualRowIndex: null,
    singlePausedProgress: null,
    workbook: null,
    langCode: uiTabPrefs.lbLangCode,
    useAi: uiTabPrefs.lbUseAi,
    showHiddenCols: false,
    customColWidths: lbColPrefs.customColWidths,
    userHiddenCols: lbColPrefs.userHiddenCols,
    run: null,
    filter: "all",
    searchQuery: "",
  },
  busy: false,
  progressPercent: 0,
  progressText: "",
  notice: null,
  availableUpdate: null,
};

export function getLangCols(lang: string): PerLanguageSheetColumnConfig {
  return {
    ...DEFAULT_LANG_SHEET_COLS,
    ...(store.colsByLang[lang] ?? {}),
  };
}

const listeners = new Set<() => void>();

export function subscribeState(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyStateChanged(): void {
  try {
    store.settings.resourceMatrixUrl = store.cloudConfigUrl;
    if (store.sharedSheets.rosterUrl) {
      store.settings.rosterSpreadsheetUrl = store.sharedSheets.rosterUrl;
    }
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(store.settings));
    localStorage.setItem(CUSTOM_RULES_KEY, JSON.stringify(store.customRules));
    localStorage.setItem(
      AI_SETTINGS_KEY,
      JSON.stringify({
        enabled: store.geminiEnabled,
        model: store.geminiModel,
        reviewModel: store.geminiReviewModel,
        paidUnlimited: store.geminiPaidUnlimited,
        rotation: store.geminiRotation,
      }),
    );
    const linksByLangObj: Record<string, LanguageResourceLinks> = {};
    for (const [k, v] of store.linksByLang.entries()) {
      linksByLangObj[k] = v;
    }
    const bundle: PersistedSchemaBundle = {
      cloudConfigUrl: store.cloudConfigUrl,
      sourceColConfig: store.sourceColConfig,
      sharedSheets: store.sharedSheets,
      colsByLang: store.colsByLang,
      linksByLangObj,
      availableLanguages: store.availableLanguages,
      hymnEpisodeKeyword: store.hymnEpisodeKeyword,
      episodeHymnOverrides: store.episodeHymnOverrides,
    };
    localStorage.setItem(SCHEMA_STORAGE_KEY, JSON.stringify(bundle));
    localStorage.setItem(
      UI_TAB_STORAGE_KEY,
      JSON.stringify({
        activeMainTab: store.activeMainTab,
        lbMode: store.lineBreak.mode,
        lbLangCode: store.lineBreak.langCode,
        lbUseAi: store.lineBreak.useAi,
        lbSourceUrl: store.lineBreak.sourceSheetUrl,
        lbOutputUrl: store.lineBreak.outputSheetUrl,
        lbMasterUrl: store.lineBreak.masterSheetUrl,
        lbBatchConcurrency: store.lineBreak.batchConcurrency,
      }),
    );
  } catch {
    // ignore storage quota errors
  }
  document.documentElement.dataset.theme =
    store.settings.themeMode === "system" ? "" : store.settings.themeMode;
  for (const fn of listeners) fn();
}

import { BUILTIN_PUNCTUATION_RULES } from "../catalog/lang-presets";
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

export type RowFilterMode = "all" | "extractable" | "missing" | "matched" | "review";
export type TableWrapMode = "nowrap" | "wrap";
export type TableFontSize = "sm" | "md" | "lg";

export const DEFAULT_TABLE_COL_WIDTHS = [50, 86, 96, 175, 185, 210, 145, 175];

const COL_WIDTHS_STORAGE_KEY = "script_lang_col_widths_v3";

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
  geminiRotation: KeyRotationStrategy;
  geminiEnabled: boolean;
  availableLanguages: string[];
  customRules: PunctuationRule[];
  linksByLang: Map<string, LanguageResourceLinks>;
  scriptDoc: ScriptSheetDocument | null;
  isDemoData: boolean;
  runsByLang: Map<string, LanguageRunOutput>;
  activePreviewLang: string;
  rowFilter: RowFilterMode;
  tableWrapMode: TableWrapMode;
  tableFontSize: TableFontSize;
  tableColWidths: number[];
  searchQuery: string;
  busy: boolean;
  progressPercent: number;
  progressText: string;
  notice: { type: "info" | "error"; message: string } | null;
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
  rotation: KeyRotationStrategy;
} {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: boolean; model?: string; rotation?: KeyRotationStrategy };
      const model: GeminiModelId =
        parsed.model === "gemini-3.1-flash-lite" ? "gemini-3.1-flash-lite" : "gemini-3.5-flash-lite";
      return {
        enabled: parsed.enabled ?? true,
        model,
        rotation: parsed.rotation === "failover" ? "failover" : "round_robin",
      };
    }
  } catch {
    // ignore
  }
  return {
    enabled: true,
    model: "gemini-3.5-flash-lite",
    rotation: "round_robin",
  };
}

const aiPrefs = loadAiPrefs();
const savedSettings = loadSavedSettings();
const schemaBundle = loadSchemaBundle();

if (!schemaBundle.cloudConfigUrl && savedSettings.resourceMatrixUrl) {
  schemaBundle.cloudConfigUrl = savedSettings.resourceMatrixUrl;
}
if (!schemaBundle.sharedSheets.rosterUrl && savedSettings.rosterSpreadsheetUrl) {
  schemaBundle.sharedSheets.rosterUrl = savedSettings.rosterSpreadsheetUrl;
}

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
  geminiRotation: aiPrefs.rotation,
  geminiEnabled: aiPrefs.enabled,
  availableLanguages: schemaBundle.availableLanguages,
  customRules: loadCustomRules(),
  linksByLang: new Map(Object.entries(schemaBundle.linksByLangObj)),
  scriptDoc: null,
  isDemoData: false,
  runsByLang: new Map(),
  activePreviewLang: "",
  rowFilter: "extractable",
  tableWrapMode: "wrap",
  tableFontSize: "sm",
  tableColWidths: loadSavedColWidths(),
  searchQuery: "",
  busy: false,
  progressPercent: 0,
  progressText: "",
  notice: null,
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
  } catch {
    // ignore storage quota errors
  }
  document.documentElement.dataset.theme =
    store.settings.themeMode === "system" ? "" : store.settings.themeMode;
  for (const fn of listeners) fn();
}

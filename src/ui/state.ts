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

const SETTINGS_STORAGE_KEY = "script_lang_workbench_settings_v1";
const CUSTOM_RULES_KEY = "script_lang_custom_rules_v1";
const AI_SETTINGS_KEY = "script_lang_ai_config_v1";

export type RowFilterMode = "all" | "extractable" | "matched" | "review";

export interface AppState {
  settings: WorkbenchSettings;
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
  searchQuery: string;
  busy: boolean;
  progressPercent: number;
  progressText: string;
  notice: { type: "info" | "error"; message: string } | null;
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
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {
    enabled: true,
    model: "gemini-3.8-flash",
    rotation: "round_robin",
  };
}

const aiPrefs = loadAiPrefs();

export const store: AppState = {
  settings: loadSavedSettings(),
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
  availableLanguages: BUILTIN_PUNCTUATION_RULES.slice(0, 8).map((r) => r.langName),
  customRules: loadCustomRules(),
  linksByLang: new Map(),
  scriptDoc: null,
  isDemoData: false,
  runsByLang: new Map(),
  activePreviewLang: "",
  rowFilter: "extractable",
  searchQuery: "",
  busy: false,
  progressPercent: 0,
  progressText: "",
  notice: null,
};

const listeners = new Set<() => void>();

export function subscribeState(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyStateChanged(): void {
  try {
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
  } catch {
    // ignore storage quota errors
  }
  document.documentElement.dataset.theme =
    store.settings.themeMode === "system" ? "" : store.settings.themeMode;
  for (const fn of listeners) fn();
}

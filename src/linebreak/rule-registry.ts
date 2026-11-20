import type {
  GlobalLineBreakRuleConfig,
  LineBreakLanguageSpec,
} from "./types";

const LB_CUSTOM_RULES_STORAGE_KEY = "script_lang_linebreak_rules_v1";

export const DEFAULT_GLOBAL_LINEBREAK_RULES: GlobalLineBreakRuleConfig = {
  minLineRatio: 0.33,
  maxLineRatio: 2.7,
  minShortScreenWarn: 15,
  globalCustomPrompt: "",
};

interface PersistedLineBreakRuleStore {
  /** Overrides to built-in language codes + newly added custom language specs */
  customSpecsByCode: Record<string, LineBreakLanguageSpec>;
  globalConfig: GlobalLineBreakRuleConfig;
}

let cachedStore: PersistedLineBreakRuleStore | null = null;

function loadStore(): PersistedLineBreakRuleStore {
  if (cachedStore) return cachedStore;
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(LB_CUSTOM_RULES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedLineBreakRuleStore>;
        cachedStore = {
          customSpecsByCode:
            parsed.customSpecsByCode && typeof parsed.customSpecsByCode === "object"
              ? parsed.customSpecsByCode
              : {},
          globalConfig: {
            ...DEFAULT_GLOBAL_LINEBREAK_RULES,
            ...(parsed.globalConfig ?? {}),
          },
        };
        return cachedStore;
      }
    }
  } catch {
    // ignore storage errors
  }
  cachedStore = {
    customSpecsByCode: {},
    globalConfig: { ...DEFAULT_GLOBAL_LINEBREAK_RULES },
  };
  return cachedStore;
}

function persistStore(): void {
  if (!cachedStore) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LB_CUSTOM_RULES_STORAGE_KEY, JSON.stringify(cachedStore));
    }
  } catch {
    // ignore quota errors
  }
}

export function getGlobalLineBreakRules(): GlobalLineBreakRuleConfig {
  return { ...loadStore().globalConfig };
}

export function saveGlobalLineBreakRules(next: Partial<GlobalLineBreakRuleConfig>): void {
  const st = loadStore();
  const minR = Number(next.minLineRatio ?? st.globalConfig.minLineRatio);
  const maxR = Number(next.maxLineRatio ?? st.globalConfig.maxLineRatio);
  const shortW = Number(next.minShortScreenWarn ?? st.globalConfig.minShortScreenWarn);

  st.globalConfig = {
    minLineRatio: Number.isFinite(minR) && minR > 0.05 && minR <= 1 ? minR : 0.33,
    maxLineRatio: Number.isFinite(maxR) && maxR >= 1 && maxR < 10 ? maxR : 2.7,
    minShortScreenWarn: Number.isFinite(shortW) && shortW >= 0 && shortW <= 45 ? shortW : 15,
    globalCustomPrompt: (next.globalCustomPrompt ?? st.globalConfig.globalCustomPrompt).trim(),
  };
  persistStore();
}

export function getCustomLineBreakSpecsMap(): Record<string, LineBreakLanguageSpec> {
  return loadStore().customSpecsByCode;
}

export function hasCustomOverrideForLang(code: string): boolean {
  return Boolean(loadStore().customSpecsByCode[code]);
}

export function upsertCustomLineBreakSpec(spec: LineBreakLanguageSpec): void {
  const st = loadStore();
  const cleanCode = spec.code.trim();
  if (!cleanCode) return;
  st.customSpecsByCode[cleanCode] = {
    ...spec,
    code: cleanCode,
    name: spec.name.trim() || cleanCode,
    aliases: spec.aliases.map((a) => a.trim()).filter(Boolean),
    sentenceEndChars:
      spec.sentenceEndChars.length > 0 ? spec.sentenceEndChars : [".", "?", "!", "…"],
  };
  persistStore();
}

export function removeCustomOrResetLangSpec(code: string): void {
  const st = loadStore();
  delete st.customSpecsByCode[code];
  persistStore();
}

export function resetAllLineBreakCustomizations(): void {
  cachedStore = {
    customSpecsByCode: {},
    globalConfig: { ...DEFAULT_GLOBAL_LINEBREAK_RULES },
  };
  persistStore();
}

export function exportLineBreakCustomizationsJson(): string {
  return JSON.stringify(loadStore(), null, 2);
}

export function importLineBreakCustomizationsJson(rawJson: string): {
  specCount: number;
} {
  const parsed = JSON.parse(rawJson) as Partial<PersistedLineBreakRuleStore>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("无效的断行规则配置文件格式");
  }
  const specs =
    parsed.customSpecsByCode && typeof parsed.customSpecsByCode === "object"
      ? parsed.customSpecsByCode
      : {};
  cachedStore = {
    customSpecsByCode: specs,
    globalConfig: {
      ...DEFAULT_GLOBAL_LINEBREAK_RULES,
      ...(parsed.globalConfig ?? {}),
    },
  };
  persistStore();
  return { specCount: Object.keys(specs).length };
}

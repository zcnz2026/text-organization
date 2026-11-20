import { getCustomLineBreakSpecsMap } from "./rule-registry";
import type { LineBreakLanguageSpec } from "./types";

const STD_SENTENCE_ENDS = [".", "?", "!", "…"];

function charSpec(
  code: string,
  name: string,
  aliases: string[],
  tier: 1 | 2 | 3,
  opts?: Partial<LineBreakLanguageSpec>,
): LineBreakLanguageSpec {
  return {
    code,
    name,
    aliases,
    mode: "char",
    tier,
    fontFamily: "Times New Roman",
    fontSizePt: 12,
    dir: "ltr",
    singleMax: 46,
    doubleMax: 84,
    softNoBreakMax: 50,
    earlySplitSentenceMin: 73,
    compactSameScreenMax: 92,
    sentenceEndChars: STD_SENTENCE_ENDS,
    ...opts,
  };
}

function rulerSpec(
  code: string,
  name: string,
  aliases: string[],
  tier: 1 | 2 | 3,
  rulerText: string,
  opts?: Partial<LineBreakLanguageSpec>,
): LineBreakLanguageSpec {
  return {
    code,
    name,
    aliases,
    mode: "ruler",
    tier,
    fontFamily: "Arial",
    fontSizePt: 12,
    dir: "ltr",
    singleMax: 46,
    doubleMax: 84,
    softNoBreakMax: 49,
    earlySplitSentenceMin: 76,
    compactSameScreenMax: 90,
    rulerText,
    sentenceEndChars: STD_SENTENCE_ENDS,
    ...opts,
  };
}

/**
 * Complete 34-language line-breaking specifications synced from《字幕断行说明文档.xlsx》
 * and confirmed meeting decisions (Windows Hindi ruler, tier priorities).
 */
export const LINEBREAK_LANGUAGE_SPECS: LineBreakLanguageSpec[] = [
  // Tier 1: Core priority character-count languages (Italian benchmark + Spanish/French urgent + highlighted blue)
  charSpec("it", "意大利语", ["意语", "意大利", "italian", "it"], 1, {
    notes: "核心标杆语种：单行 ≤46，同屏双行 47~84，比例 0.33~2.7",
  }),
  charSpec("es", "美西语", ["西语", "西班牙语", "拉美西语", "欧西语", "西班牙", "美西", "spanish", "es"], 1, {
    sentenceEndChars: [".", "?", "!", "…"],
    notes: "重点紧缺断行语种：单行 ≤46，双行 ≤84（注意保留句首 ¿ ¡ 与词组完整）",
  }),
  charSpec("fr", "法语", ["法文", "法国", "french", "fr"], 1, {
    notes: "重点紧缺断行语种：单行 ≤46，双行 ≤84（注意法语双标点前窄空格与书名号 « » 不拆开）",
  }),
  charSpec("id", "印尼语", ["印度尼西亚语", "印尼", "indonesian", "id"], 1),
  charSpec("el", "希腊语", ["希语", "希腊", "greek", "el"], 1, {
    sentenceEndChars: [".", ";", "!", "…", "?"],
    notes: "希腊语问号为分号「;」，识别双句分屏时自动兼容",
  }),
  charSpec("ru", "俄语", ["俄文", "俄罗斯", "russian", "ru"], 1),
  charSpec("pt", "葡语", ["葡萄牙语", "巴葡", "欧葡", "葡文", "葡萄牙", "portuguese", "pt"], 1),
  charSpec("en", "英文", ["英语", "english", "en"], 1, {
    singleMax: 51,
    doubleMax: 84,
    softNoBreakMax: 54,
    earlySplitSentenceMin: 76,
    compactSameScreenMax: 92,
    notes: "英文单行上限 51 字符，双行最多不超过 84 字符",
  }),

  // Tier 2: Other standard character-count languages
  charSpec("de", "德语", ["德文", "德国", "german", "de"], 2),
  charSpec("pl", "波兰语", ["波语", "波兰", "polish", "pl"], 2),
  charSpec("bg", "保加利亚语", ["保加利亚", "保加", "保语", "bulgarian", "bg"], 2),
  charSpec("vi", "越南语", ["越语", "越南", "vietnamese", "vi"], 2),
  charSpec("tl", "菲律宾语", ["菲语", "菲律宾", "他加禄语", "tagalog", "filipino", "tl"], 2),
  charSpec("hu", "马扎尔语", ["马扎尔", "匈牙利语", "匈牙利", "hungarian", "hu"], 2),
  charSpec("sk", "斯洛伐克语", ["斯洛伐克", "斯语", "slovak", "sk"], 2),
  charSpec("ro", "罗马尼亚语", ["罗语", "罗马尼亚", "romanian", "ro"], 2),
  charSpec("sr", "塞尔维亚语", ["塞尔语", "塞尔维亚", "塞语", "serbian", "sr"], 2),
  charSpec("uk", "乌克兰语", ["乌克兰", "乌语", "ukrainian", "uk"], 2, {
    fontFamily: "Arial",
  }),
  charSpec("hr", "克罗地亚语", ["克罗地亚", "克罗", "克语", "croatian", "hr"], 2),
  charSpec("nl", "荷兰语", ["荷兰", "荷语", "dutch", "nl"], 2),
  charSpec("sw", "斯瓦希里语", ["斯瓦希里", "swahili", "sw"], 2),
  charSpec("hmn", "苗语（常规稿）", ["苗语", "苗文", "hmong", "hmn"], 2, {
    singleMax: 46,
    doubleMax: 90,
    softNoBreakMax: 50,
    earlySplitSentenceMin: 80,
    compactSameScreenMax: 96,
    notes: "正常稿单行 46，双行最多 90",
  }),
  charSpec("hmn-report", "苗语（50/100宽幅）", ["苗语宽幅", "苗语50", "苗语迫害报道"], 2, {
    singleMax: 50,
    doubleMax: 100,
    softNoBreakMax: 54,
    earlySplitSentenceMin: 88,
    compactSameScreenMax: 105,
    notes: "宽幅规格：单行 50 字符，同屏双行 100 字符",
  }),
  charSpec("he", "希伯来语", ["希伯来", "hebrew", "he"], 2, {
    fontFamily: "Arial",
    dir: "rtl",
    singleMax: 46,
    doubleMax: 75,
    softNoBreakMax: 49,
    earlySplitSentenceMin: 68,
    compactSameScreenMax: 80,
    notes: "从右向左排列，单行 46，双行 75",
  }),
  charSpec("ja", "日语", ["日文", "日本", "japanese", "ja"], 2, {
    fontFamily: "Noto Sans JP",
    singleMax: 22,
    doubleMax: 42,
    softNoBreakMax: 24,
    earlySplitSentenceMin: 36,
    compactSameScreenMax: 44,
    sentenceEndChars: ["。", "？", "！", "…", "?", "!"],
    isJapanese: true,
    notes: "单行上限 22 字符；标点后断行；去句末句逗保留？！…；句中有句号优先断行并删中间句号",
  }),

  // Tier 3: Visual Ruler languages (12pt Regular calibrated pixel width measurement)
  rulerSpec("hi", "印地语", ["印地", "hindi", "hi"], 3, "", {
    fixedRulerPx: 342,
    sentenceEndChars: ["।", ".", "?", "!", "…"],
    notes: "Windows 断行+字幕检查尺子（Arial 12号 Regular 342px），兼容天城文句号「।」",
  }),
  rulerSpec("ar", "阿拉伯语", ["阿拉伯", "阿语", "arabic", "ar"], 3, "", {
    dir: "rtl",
    fixedRulerPx: 320,
    sentenceEndChars: [".", "؟", "!", "…", "?"],
    notes: "列宽 320px，12号 Arial Regular，从右向左排列（RTL），兼容阿语问号「؟」",
  }),
  rulerSpec("my", "缅甸语", ["缅语", "缅甸", "burmese", "myanmar", "my"], 3, "", {
    fixedRulerPx: 347,
    sentenceEndChars: ["။", ".", "?", "!"],
    notes: "Arial 12号 Regular 尺子 (347px)，兼容缅文句号「။」",
  }),
  rulerSpec("th", "泰语", ["泰文", "泰国", "thai", "th"], 3, "", {
    fixedRulerPx: 287,
    notes: "Arial 12号 Regular 尺子 (287px)，按泰语义群分词不拆词",
  }),
  rulerSpec("ne", "尼泊尔语", ["尼泊尔", "nepali", "ne"], 3, "", {
    fixedRulerPx: 353,
    sentenceEndChars: ["।", ".", "?", "!"],
    notes: "Arial 12号 Regular 尺子 (353px)，兼容句号「।」",
  }),
  rulerSpec("ko", "韩语", ["朝鲜语", "韩文", "korean", "ko"], 3, "", {
    fixedRulerPx: 342,
    notes: "Arial 12号 Regular 尺子 (342px)，同屏双行",
  }),
  rulerSpec("lo", "老挝语", ["老挝", "老挝文", "lao", "lo"], 3, "", {
    fixedRulerPx: 326,
    notes: "Arial 12号 Regular 尺子 (326px)",
  }),
  rulerSpec("hy", "亚美尼亚语", ["亚美尼亚", "armenian", "hy"], 3, "", {
    fixedRulerPx: 376,
    sentenceEndChars: ["։", "՞", "՜", ".", "?", "!"],
    notes: "Arial 12号 Regular 尺子 (376px)，兼容亚美尼亚句号「։」",
  }),
  rulerSpec("mn", "蒙古语", ["蒙语", "蒙文", "蒙古", "mongolian", "mn"], 3, "", {
    fontFamily: "Times New Roman",
    fixedRulerPx: 328,
    notes: "Times New Roman 12号 Regular 尺子 (328px)",
  }),
  rulerSpec("km", "高棉语", ["柬埔寨语", "高棉", "khmer", "km"], 3, "", {
    fontFamily: "Khmer",
    fixedRulerPx: 368,
    sentenceEndChars: ["។", "?", "!"],
    notes: "Khmer 12号 Regular 尺子 (368px)",
  }),
];

function normKey(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HAN_RE = /[\u4e00-\u9fff]/;

export function getBuiltinLineBreakSpec(code: string): LineBreakLanguageSpec | undefined {
  return LINEBREAK_LANGUAGE_SPECS.find((s) => s.code === code);
}

/**
 * Returns all active language specs (34 built-in specs with any user overrides applied + newly added custom languages).
 */
export function getActiveLineBreakSpecs(): LineBreakLanguageSpec[] {
  const customMap = getCustomLineBreakSpecsMap();
  const seen = new Set<string>();
  const merged: LineBreakLanguageSpec[] = [];

  for (const builtin of LINEBREAK_LANGUAGE_SPECS) {
    seen.add(builtin.code);
    merged.push(customMap[builtin.code] ? { ...builtin, ...customMap[builtin.code], isCustom: false } : builtin);
  }
  for (const [code, custom] of Object.entries(customMap)) {
    if (!seen.has(code)) {
      merged.push({ ...custom, isCustom: true });
    }
  }
  return merged;
}

export function detectLanguageSpecFromText(nameOrCode: string): LineBreakLanguageSpec | null {
  const raw = (nameOrCode || "").trim();
  if (!raw) return null;
  const q = normKey(raw);
  const allSpecs = getActiveLineBreakSpecs();

  // 1. Exact match on code, name, or alias
  for (const spec of allSpecs) {
    if (
      normKey(spec.code) === q ||
      normKey(spec.name) === q ||
      spec.aliases.some((a) => normKey(a) === q)
    ) {
      return spec;
    }
  }

  // 2. Longest-first substring match for CJK names/aliases, and word-boundary match for ASCII names/aliases
  const candidates: Array<{ key: string; isHan: boolean; spec: LineBreakLanguageSpec }> = [];
  for (const spec of allSpecs) {
    for (const label of [spec.name, ...spec.aliases]) {
      const k = normKey(label);
      if (k.length < 2) continue;
      candidates.push({ key: k, isHan: HAN_RE.test(k), spec });
    }
  }
  candidates.sort((a, b) => b.key.length - a.key.length);

  for (const cand of candidates) {
    if (cand.isHan) {
      if (q.includes(cand.key)) return cand.spec;
    } else if (cand.key.length >= 3) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(cand.key)}([^a-z0-9]|$)`, "i");
      if (re.test(raw)) return cand.spec;
    }
  }

  return null;
}

export function resolveLineBreakSpec(nameOrCode: string): LineBreakLanguageSpec {
  return detectLanguageSpecFromText(nameOrCode) ?? getActiveLineBreakSpecs()[0];
}

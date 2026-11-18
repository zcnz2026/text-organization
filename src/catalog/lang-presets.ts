import type {
  BibleCitationMode,
  PeriodPlacementMode,
  PunctuationRule,
} from "../types/domain";

function r(
  langCode: string,
  langName: string,
  aliases: string[],
  doubleOpen: string,
  doubleClose: string,
  singleOpen: string,
  singleClose: string,
  apostrophe: string,
  ellipsis: string,
  commaInsideQuote: boolean,
  periodMode: PeriodPlacementMode,
  opts?: {
    bibleCitationMode?: BibleCitationMode;
    singleCitationRowOnly?: boolean;
    sentencePeriodChar?: string;
    notes?: string;
  },
): PunctuationRule {
  return {
    langCode,
    langName,
    aliases,
    doubleOpen,
    doubleClose,
    singleOpen,
    singleClose,
    apostrophe,
    ellipsis,
    commaInsideQuote,
    periodMode,
    bibleCitationMode: opts?.bibleCitationMode ?? "same_as_english",
    singleCitationRowOnly: opts?.singleCitationRowOnly ?? false,
    ...(opts?.sentencePeriodChar !== undefined ? { sentencePeriodChar: opts.sentencePeriodChar } : {}),
    ...(opts?.notes ? { notes: opts.notes } : {}),
  };
}

export const BUILTIN_PUNCTUATION_RULES: PunctuationRule[] = [
  r("uk", "乌克兰语", ["乌克兰语", "乌语", "乌克兰", "ukrainian", "uk"], "«", "»", '"', '"', "'", "…", false, "outside"),
  r("es", "西语", ["西语", "西班牙语", "西班牙", "spanish", "es"], '"', '"', "'", "'", "'", "[…]", false, "outside"),
  r("id", "印尼语", ["印尼语", "印度尼西亚语", "印尼", "indonesian", "id"], '"', '"', "'", "'", "'", "...", true, "sentence_inside_phrase_outside"),
  r("pl", "波兰语", ["波兰语", "波语", "波兰", "polish", "pl"], "„", "”", "»", "«", "’", "(…)", false, "outside"),
  r("el", "希腊语", ["希腊语", "希语", "希腊", "greek", "el"], "«", "»", "“", "”", "’", "[…]", false, "outside"),
  r("hi", "印地语", ["印地语", "印地", "hindi", "hi"], '"', '"', "'", "'", "'", "...", true, "inside", { sentencePeriodChar: "।" }),
  r("hr", "克罗地亚语", ["克罗地亚语", "克罗", "克语", "克罗地亚", "croatian", "hr"], "„", "“", "‚", "‘", "’", "…", false, "sentence_inside_phrase_outside", { bibleCitationMode: "period_inside_quote_no_trailing" }),
  r("ko", "韩语", ["韩语", "朝鲜语", "韩文", "korean", "ko"], "“", "”", "‘", "’", "’", "……", true, "inside", { singleCitationRowOnly: true }),
  r("pt", "葡语", ["葡语", "葡萄牙语", "葡萄牙", "portuguese", "pt"], "“", "”", "‘", "’", "’", "[…]", false, "sentence_inside_phrase_outside"),
  r("fr", "法语", ["法语", "法文", "法国", "french", "fr"], "« ", " »", "“", "”", "’", "[…]", false, "outside"),
  r("ru", "俄语", ["俄语", "俄文", "俄罗斯", "russian", "ru"], "«", "»", "„", "“", "'", "...", false, "outside"),
  r("tl", "菲律宾语", ["菲律宾语", "菲语", "菲律宾", "他加禄语", "tagalog", "filipino", "tl", "fil"], '"', '"', "'", "'", "'", "…", true, "inside"),
  r("ro", "罗马尼亚语", ["罗马尼亚语", "罗语", "罗马尼亚", "romanian", "ro"], "„", "”", "«", "»", "’", "[…]", true, "inside"),
  r("ja", "日语", ["日语", "日文", "日本", "japanese", "ja"], "「", "」", "『", "』", "’", "……", true, "inside", { sentencePeriodChar: "" }),
  r("ta", "泰米尔语", ["泰米尔语", "泰米尔", "tamil", "ta"], '"', '"', "'", "'", "’", "…", true, "inside"),
  r("he", "希伯来语", ["希伯来语", "希伯来", "希伯来文", "hebrew", "he", "iw"], '"', '"', "'", "'", "'", "...", false, "outside"),
  r("de", "德语", ["德语", "德文", "德国", "german", "de"], "„", "“", "‚", "‘", "’", "…", false, "inside"),
  r("my", "缅甸语", ["缅甸语", "缅语", "缅甸", "burmese", "myanmar", "my"], "“", "”", "‘", "’", "’", "...", true, "inside", { sentencePeriodChar: "။" }),
  r("vi", "越南语", ["越南语", "越语", "越南", "vietnamese", "vi"], "“", "”", "‘", "’", "’", "(…)", false, "outside"),
  r("nl", "荷兰语", ["荷兰语", "荷兰", "荷语", "dutch", "nl"], "“", "”", "‘", "’", "’", "[…]", false, "outside"),
  r("mn", "蒙文", ["蒙文", "蒙古语", "蒙语", "蒙古", "mongolian", "mn"], "“", "”", "‘", "’", "’", "…", false, "outside"),
  r("th", "泰语", ["泰语", "泰文", "泰国", "thai", "th"], "“", "”", "‘", "’", "’", "…", true, "inside", { sentencePeriodChar: "" }),
  r("km", "高棉语", ["高棉语", "柬埔寨语", "高棉", "柬语", "khmer", "km"], "«", "»", "'", "'", "'", "...", true, "inside", { sentencePeriodChar: "។" }),
  r("ne", "尼泊尔语", ["尼泊尔语", "尼泊尔", "nepali", "ne"], "“", "”", "‘", "’", "’", "…", true, "inside", { sentencePeriodChar: "।" }),
  r("ar", "阿拉伯语", ["阿拉伯语", "阿语", "阿拉伯", "arabic", "ar"], '"', '"', '"', '"', "'", "...", false, "outside"),
  r("hmn", "苗语", ["苗语", "苗文", "hmong", "hmn"], "“", "”", "‘", "’", "’", "…", true, "inside"),
  r("lo", "老挝语", ["老挝语", "老挝", "老挝文", "lao", "lo"], "“", "”", "‘", "’", "’", "...", true, "inside"),
  r("en", "英文", ["英文", "英语", "english", "en"], "“", "”", "‘", "’", "’", "…", true, "inside"),
];

export function normalizeLangKey(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, "");
}

export function resolvePunctuationRule(
  langName: string,
  customRules: PunctuationRule[] = [],
): PunctuationRule {
  const key = normalizeLangKey(langName);
  const all = [...customRules, ...BUILTIN_PUNCTUATION_RULES];
  for (const rule of all) {
    if (
      normalizeLangKey(rule.langName) === key ||
      normalizeLangKey(rule.langCode) === key ||
      rule.aliases.some((a) => normalizeLangKey(a) === key)
    ) {
      return { ...rule };
    }
  }
  return {
    langCode: key || "default",
    langName: langName.trim() || "默认语种",
    aliases: [langName.trim()],
    doubleOpen: '"',
    doubleClose: '"',
    singleOpen: "'",
    singleClose: "'",
    apostrophe: "'",
    ellipsis: "…",
    commaInsideQuote: true,
    periodMode: "inside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
    sentencePeriodChar: ".",
  };
}

export function applyMatrixRuleOverrides(
  base: PunctuationRule,
  quoteRaw?: string,
  endingRaw?: string,
  bibleRaw?: string,
): PunctuationRule {
  const next = { ...base };
  const q = (quoteRaw || "").trim();
  if (q.includes("«»") || q.includes("«")) {
    next.doubleOpen = "«";
    next.doubleClose = "»";
  } else if (q.includes("„“")) {
    next.doubleOpen = "„";
    next.doubleClose = "“";
  } else if (q.includes("„”")) {
    next.doubleOpen = "„";
    next.doubleClose = "”";
  } else if (q.includes("「」")) {
    next.doubleOpen = "「";
    next.doubleClose = "」";
  } else if (q.includes("竖形") && q.includes("双引号")) {
    next.doubleOpen = '"';
    next.doubleClose = '"';
  }
  if (q.includes('单引号竖形的 "') || q.includes('单引号竖形的"')) {
    next.singleOpen = '"';
    next.singleClose = '"';
  } else if (q.includes("单引号蝌蚪")) {
    next.singleOpen = "‘";
    next.singleClose = "’";
  }
  if (q.includes("撇号也是用竖形")) next.apostrophe = "'";
  if (q.includes("撇号也是用蝌蚪")) next.apostrophe = "’";

  const e = (endingRaw || "").trim();
  if (e.includes("都在引号外面")) {
    next.commaInsideQuote = false;
    next.periodMode = "outside";
  } else if (e.includes("整个句子都在引号内") && e.includes("标题")) {
    next.periodMode = "sentence_inside_phrase_outside";
  } else if (e.includes("都放到引号的里面") || e.includes("都在引号里面")) {
    next.commaInsideQuote = true;
    next.periodMode = "inside";
  }

  const b = (bibleRaw || "").trim();
  if (b.includes("挪到括号外") || b.includes("放到引号里面")) {
    next.bibleCitationMode = "period_inside_quote_no_trailing";
  } else if (b.includes("和英文一样")) {
    next.bibleCitationMode = "same_as_english";
  }
  return next;
}

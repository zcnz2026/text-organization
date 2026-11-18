import type { PunctuationRule } from "../types/domain";

export const BUILTIN_PUNCTUATION_RULES: PunctuationRule[] = [
  {
    langCode: "uk",
    langName: "乌克兰语",
    aliases: ["乌克兰语", "乌语", "乌克兰", "ukrainian", "uk"],
    doubleOpen: "«",
    doubleClose: "»",
    singleOpen: '"',
    singleClose: '"',
    apostrophe: "'",
    ellipsis: "…",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "es",
    langName: "西语",
    aliases: ["西语", "西班牙语", "spanish", "es"],
    doubleOpen: '"',
    doubleClose: '"',
    singleOpen: "'",
    singleClose: "'",
    apostrophe: "'",
    ellipsis: "...",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "id",
    langName: "印尼语",
    aliases: ["印尼语", "印度尼西亚语", "印尼", "indonesian", "id"],
    doubleOpen: '"',
    doubleClose: '"',
    singleOpen: "'",
    singleClose: "'",
    apostrophe: "'",
    ellipsis: "...",
    commaInsideQuote: true,
    periodMode: "sentence_inside_phrase_outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "pl",
    langName: "波语",
    aliases: ["波语", "波兰语", "波兰", "polish", "pl"],
    doubleOpen: "„",
    doubleClose: "”",
    singleOpen: "‚",
    singleClose: "’",
    apostrophe: "’",
    ellipsis: "…",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "el",
    langName: "希腊语",
    aliases: ["希腊语", "希语", "希腊", "greek", "el"],
    doubleOpen: "«",
    doubleClose: "»",
    singleOpen: "‘",
    singleClose: "’",
    apostrophe: "’",
    ellipsis: "…",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "hi",
    langName: "印地",
    aliases: ["印地", "印地语", "hindi", "hi"],
    doubleOpen: '"',
    doubleClose: '"',
    singleOpen: "'",
    singleClose: "'",
    apostrophe: "'",
    ellipsis: "...",
    commaInsideQuote: true,
    periodMode: "inside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "hr",
    langName: "克罗",
    aliases: ["克罗", "克罗地亚语", "克语", "克罗地亚", "croatian", "hr"],
    doubleOpen: "„",
    doubleClose: "“",
    singleOpen: "‚",
    singleClose: "‘",
    apostrophe: "’",
    ellipsis: "…",
    commaInsideQuote: false,
    periodMode: "sentence_inside_phrase_outside",
    bibleCitationMode: "period_inside_quote_no_trailing",
    singleCitationRowOnly: false,
  },
  {
    langCode: "ko",
    langName: "韩语",
    aliases: ["韩语", "朝鲜语", "韩文", "korean", "ko"],
    doubleOpen: "“",
    doubleClose: "”",
    singleOpen: "‘",
    singleClose: "’",
    apostrophe: "’",
    ellipsis: "……",
    commaInsideQuote: true,
    periodMode: "inside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: true,
  },
  {
    langCode: "pt",
    langName: "葡语",
    aliases: ["葡语", "葡萄牙语", "portuguese", "pt"],
    doubleOpen: '"',
    doubleClose: '"',
    singleOpen: "'",
    singleClose: "'",
    apostrophe: "'",
    ellipsis: "...",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "fr",
    langName: "法语",
    aliases: ["法语", "法文", "french", "fr"],
    doubleOpen: "« ",
    doubleClose: " »",
    singleOpen: "“",
    singleClose: "”",
    apostrophe: "’",
    ellipsis: "…",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "ru",
    langName: "俄语",
    aliases: ["俄语", "俄文", "russian", "ru"],
    doubleOpen: "«",
    doubleClose: "»",
    singleOpen: "„",
    singleClose: "“",
    apostrophe: "'",
    ellipsis: "…",
    commaInsideQuote: false,
    periodMode: "outside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
  {
    langCode: "tl",
    langName: "菲律宾语",
    aliases: ["菲律宾语", "菲语", "他加禄语", "tagalog", "filipino", "tl"],
    doubleOpen: '"',
    doubleClose: '"',
    singleOpen: "'",
    singleClose: "'",
    apostrophe: "'",
    ellipsis: "...",
    commaInsideQuote: true,
    periodMode: "inside",
    bibleCitationMode: "same_as_english",
    singleCitationRowOnly: false,
  },
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

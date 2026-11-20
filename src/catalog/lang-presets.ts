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
    tertiaryOpen?: string;
    tertiaryClose?: string;
    periodQuotePattern?: string;
    exclamQuestionQuotePattern?: string;
    bibleCitationMode?: BibleCitationMode;
    singleCitationRowOnly?: boolean;
    sentencePeriodChar?: string;
    preserveInnerQuotes?: boolean;
    noAdjacentDoubleQuotes?: boolean;
    noCitationDoubleOpen?: string;
    noCitationDoubleClose?: string;
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
    ...(opts?.tertiaryOpen !== undefined ? { tertiaryOpen: opts.tertiaryOpen } : {}),
    ...(opts?.tertiaryClose !== undefined ? { tertiaryClose: opts.tertiaryClose } : {}),
    apostrophe,
    ellipsis,
    commaInsideQuote,
    periodMode,
    ...(opts?.periodQuotePattern ? { periodQuotePattern: opts.periodQuotePattern } : {}),
    ...(opts?.exclamQuestionQuotePattern ? { exclamQuestionQuotePattern: opts.exclamQuestionQuotePattern } : {}),
    bibleCitationMode: opts?.bibleCitationMode ?? "same_as_english",
    singleCitationRowOnly: opts?.singleCitationRowOnly ?? false,
    ...(opts?.sentencePeriodChar !== undefined ? { sentencePeriodChar: opts.sentencePeriodChar } : {}),
    ...(opts?.preserveInnerQuotes ? { preserveInnerQuotes: true } : {}),
    ...(opts?.noAdjacentDoubleQuotes ? { noAdjacentDoubleQuotes: true } : {}),
    ...(opts?.noCitationDoubleOpen ? { noCitationDoubleOpen: opts.noCitationDoubleOpen } : {}),
    ...(opts?.noCitationDoubleClose ? { noCitationDoubleClose: opts.noCitationDoubleClose } : {}),
    ...(opts?.notes ? { notes: opts.notes } : {}),
  };
}

export const BUILTIN_PUNCTUATION_RULES: PunctuationRule[] = [
  r("en", "英文", ["英文", "英语", "english", "en"], '"', '"', "'", "'", "'", "…", true, "inside", { tertiaryOpen: '"', tertiaryClose: '"' }),
  r("es", "西语", ["西语", "西班牙语", "西班牙", "spanish", "es"], '"', '"', "'", "'", "'", "[…]", false, "outside", { tertiaryOpen: '"', tertiaryClose: '"' }),
  r("pt", "葡语", ["葡语", "葡萄牙语", "葡萄牙", "portuguese", "pt"], '"', '"', "'", "'", "'", "[…]", false, "sentence_inside_phrase_outside", { tertiaryOpen: '"', tertiaryClose: '"' }),
  r("fr", "法语", ["法语", "法文", "法国", "french", "fr"], "« ", " »", '"', '"', "'", "[…]", false, "outside", { tertiaryOpen: "'", tertiaryClose: "'", bibleCitationMode: "period_inside_quote_no_trailing" }),
  r("it", "意大利语", ["意大利语", "意语", "意大利", "italian", "it"], '"', '"', "'", "'", "'", "[…]", false, "outside", { tertiaryOpen: '"', tertiaryClose: '"' }),
  r("ru", "俄语", ["俄语", "俄文", "俄罗斯", "russian", "ru"], "«", "»", "„", "“", "", "...", false, "outside", { tertiaryOpen: "«", tertiaryClose: "»" }),
  r("uk", "乌克兰语", ["乌克兰语", "乌语", "乌克兰", "ukrainian", "uk"], "«", "»", '"', '"', "'", "…", false, "outside", { tertiaryOpen: "'", tertiaryClose: "'", notes: "三层引号用法：« ' \" \" ' »" }),
  r("pl", "波兰语", ["波兰语", "波语", "波兰", "polish", "pl"], "„", "”", "»", "«", "", "(…)", false, "outside", { tertiaryOpen: "„", tertiaryClose: "”" }),
  r("tl", "菲律宾语", ["菲律宾语", "菲语", "菲律宾", "他加禄语", "tagalog", "filipino", "tl", "fil"], '"', '"', "'", "'", "'", "…", true, "inside", { tertiaryOpen: '"', tertiaryClose: '"' }),
  r("ne", "尼泊尔语", ["尼泊尔语", "尼泊尔", "nepali", "ne"], "“", "”", "‘", "’", "", "…", true, "inside", { tertiaryOpen: "“", tertiaryClose: "”", sentencePeriodChar: "।" }),
  r("ro", "罗马尼亚语", ["罗马尼亚语", "罗语", "罗马尼亚", "romanian", "ro"], "„", "”", "«", "»", "", "[…]", true, "inside", { tertiaryOpen: "„", tertiaryClose: "”" }),
  r("hi", "印地语", ["印地语", "印地", "hindi", "hi"], '"', '"', "'", "'", "'", "...", true, "inside", { tertiaryOpen: '"', tertiaryClose: '"', sentencePeriodChar: "।" }),
  r("id", "印尼语", ["印尼语", "印度尼西亚语", "印尼", "indonesian", "id"], '"', '"', "'", "'", "'", "...", true, "sentence_inside_phrase_outside", { tertiaryOpen: '"', tertiaryClose: '"' }),
  r("my", "缅甸语", ["缅甸语", "缅语", "缅甸", "burmese", "myanmar", "my"], "“", "”", "‘", "’", "", "...", true, "inside", { tertiaryOpen: "“", tertiaryClose: "”", sentencePeriodChar: "။", bibleCitationMode: "period_inside_quote_no_trailing" }),
  r("hu", "马扎尔语", ["马扎尔语", "匈牙利", "匈牙利语", "hungarian", "hu"], "„", "”", "»", "«", "", "[...]", false, "outside", { tertiaryOpen: "’", tertiaryClose: "’" }),
  r("vi", "越南语", ["越南语", "越语", "越南", "vietnamese", "vi"], "“", "”", "‘", "’", "’", "(…)", false, "outside", { tertiaryOpen: "“", tertiaryClose: "”" }),
  r("el", "希腊语", ["希腊语", "希语", "希腊", "greek", "el"], "«", "»", "“", "”", "’", "[…]", false, "outside", { tertiaryOpen: "‘", tertiaryClose: "’" }),
  r("ko", "韩语", ["韩语", "朝鲜语", "韩文", "korean", "ko"], "『", "』", "", "", "", "…", true, "inside", { singleCitationRowOnly: true, preserveInnerQuotes: true, noCitationDoubleOpen: "“", noCitationDoubleClose: "”", notes: "有摘自用『』，无摘自用“”，内层引号保持原样不修改" }),
  r("de", "德语", ["德语", "德文", "德国", "german", "de"], "„", "“", "‚", "‘", "", "…", false, "inside", { tertiaryOpen: "„", tertiaryClose: "“" }),
  r("ar", "阿拉伯语", ["阿拉伯语", "阿语", "阿拉伯", "arabic", "ar"], '"', '"', '"', '"', "", "...", false, "outside", { noAdjacentDoubleQuotes: true, notes: "均用竖形双引号，不出现两个双引号挨一起" }),
  r("sr", "塞尔维亚语", ["塞尔维亚语", "塞尔维亚", "serbian", "sr"], "„", "”", "’", "’", "", "(…)", false, "outside", { tertiaryOpen: "„", tertiaryClose: "”" }),
  r("bg", "保加利亚语", ["保加利亚语", "保加利亚", "bulgarian", "bg"], "„", "“", "„", "“", "", "[…]", false, "outside", { noAdjacentDoubleQuotes: true, notes: "不出现两个双引号挨一起" }),
  r("sk", "斯洛伐克语", ["斯洛伐克语", "斯洛伐克", "slovak", "sk"], "„", "“", "‚", "‘", "", "…", false, "outside", { tertiaryOpen: "„", tertiaryClose: "“" }),
  r("hr", "克罗地亚语", ["克罗地亚语", "克罗", "克语", "克罗地亚", "croatian", "hr"], "„", "“", "‚", "’", "’", "(…)", false, "sentence_inside_phrase_outside", { tertiaryOpen: "‚", tertiaryClose: "’", bibleCitationMode: "period_inside_quote_no_trailing" }),
  r("nl", "荷兰语", ["荷兰语", "荷兰", "荷语", "dutch", "nl"], "“", "”", "‘", "’", "’", "[…]", false, "outside", { tertiaryOpen: "“", tertiaryClose: "”" }),
  r("km", "高棉语", ["高棉语", "柬埔寨语", "高棉", "柬语", "khmer", "km"], "«", "»", '"', '"', "'", "...", true, "inside", { tertiaryOpen: "«", tertiaryClose: "»", sentencePeriodChar: "។" }),
  r("th", "泰语", ["泰语", "泰文", "泰国", "thai", "th"], '"', '"', "'", "'", "", "…", true, "inside", { tertiaryOpen: '"', tertiaryClose: '"', sentencePeriodChar: "" }),
  r("ka", "格鲁吉亚", ["格鲁吉亚", "格鲁吉亚语", "georgian", "ka"], "„", "“", "«", "»", "", "…", false, "outside", { tertiaryOpen: "„", tertiaryClose: "“", periodQuotePattern: ".“", exclamQuestionQuotePattern: "?“\n!“" }),
  r("hy", "亚美尼亚", ["亚美尼亚", "亚美尼亚语", "armenian", "hy"], "«", "»", "", "", "", "…", false, "outside", { periodQuotePattern: "»։", sentencePeriodChar: "։" }),
  r("lo", "老挝语", ["老挝语", "老挝", "老挝文", "lao", "lo"], "“", "”", "‘", "’", "", "...", true, "inside", { tertiaryOpen: "“", tertiaryClose: "”", periodQuotePattern: "”.", exclamQuestionQuotePattern: "?”\n!”" }),
  r("ja", "日语", ["日语", "日文", "日本", "japanese", "ja"], "「", "」", "『", "』", "’", "……", true, "inside", { sentencePeriodChar: "" }),
  r("ta", "泰米尔语", ["泰米尔语", "泰米尔", "tamil", "ta"], '"', '"', "'", "'", "’", "…", true, "inside"),
  r("he", "希伯来语", ["希伯来语", "希伯来", "希伯来文", "hebrew", "he", "iw"], '"', '"', "'", "'", "'", "...", false, "outside"),
  r("mn", "蒙文", ["蒙文", "蒙古语", "蒙语", "蒙古", "mongolian", "mn"], "“", "”", "‘", "’", "’", "…", false, "outside"),
  r("hmn", "苗语", ["苗语", "苗文", "hmong", "hmn"], "“", "”", "‘", "’", "’", "…", true, "inside"),
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

import type { SubtitleMeasurer } from "./measurer";
import {
  isGreenFillRgb,
  normalizeSourceSubtitle,
  renderTokenSlice,
  type SubtitleToken,
  tokenizeSubtitle,
} from "./tokenizer";
import type {
  BreakOutcomeStatus,
  ImportedSubtitleRow,
  LineBreakLanguageSpec,
  ProcessedSubtitleRow,
  SubtitleRowCategory,
  SubtitleSheetColumnMap,
} from "./types";

export { isGreenFillRgb, normalizeSourceSubtitle, renderTokenSlice, type SubtitleToken, tokenizeSubtitle };

export interface IndexBreakPlan {
  /** End-exclusive token indices for each screen, e.g. [7, 14] for 2 screens over 14 tokens */
  screenEnds: number[];
  /** Optional token split index (within full token array) for '@' inside each screen, or null */
  atSplits: Array<number | null>;
  compactSameScreen?: boolean;
}

// Short proclitics / articles / prepositions that must NOT stand right before a break
const NON_FINAL_WORDS = new Set([
  // Italian
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
  "del", "dello", "della", "dei", "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle", "dal", "dalla",
  "nel", "nella", "nei", "nelle", "sul", "sulla", "non", "più", "molto", "così", "che",
  // Spanish
  "el", "los", "las", "unos", "unas", "de", "del", "en", "por", "para", "sin", "sobre", "no", "muy", "más", "tan",
  "mi", "tu", "su", "mis", "tus", "sus",
  // French
  "les", "des", "du", "au", "aux", "dans", "sur", "par", "pour", "sans", "avec", "ne", "pas", "très", "plus",
  "ce", "cet", "cette", "ces", "mon", "ton", "son", "ma", "ta", "sa", "mes", "tes", "ses",
  // Portuguese
  "o", "os", "as", "um", "uma", "do", "dos", "das", "no", "na", "nos", "nas", "ao", "aos", "pelo", "pela", "não",
  // English
  "the", "an", "of", "to", "for", "with", "on", "at", "by", "from", "into", "is", "are", "was", "were", "have", "has",
  // Indonesian
  "di", "ke", "dari", "yang", "dan", "untuk", "pada", "dalam", "tidak", "akan", "telah",
  // Russian / Ukrainian
  "в", "во", "на", "с", "со", "к", "ко", "по", "из", "за", "от", "до", "у", "о", "об", "не", "ни",
  // Greek
  "ο", "η", "το", "οι", "τα", "του", "της", "των", "τον", "την", "σε", "με", "για", "από", "δεν", "μην", "θα", "να",
]);

// Clause starters / conjunctions that are good places to break BEFORE
const CLAUSE_STARTERS = new Set([
  // Italian
  "che", "perché", "quando", "dove", "mentre", "come", "se", "anche", "ma", "però", "oppure", "quindi", "così", "e", "ed",
  // Spanish
  "que", "porque", "cuando", "donde", "mientras", "como", "si", "aunque", "pero", "sino", "y", "e", "o",
  // French
  "qui", "parce", "quand", "lorsque", "comme", "mais", "ou", "et", "donc", "car",
  // English
  "that", "which", "who", "whom", "because", "when", "where", "while", "if", "although", "but", "and", "or", "so",
  // Portuguese
  "porque", "quando", "onde", "enquanto", "mas", "ou",
  // Indonesian
  "karena", "ketika", "bahwa", "tetapi", "namun", "atau", "sehingga", "agar", "supaya",
  // Russian
  "что", "чтобы", "когда", "где", "если", "потому", "который", "которая", "которые", "но", "а", "или", "и",
  // Greek
  "ότι", "επειδή", "όταν", "όπου", "ενώ", "αν", "αλλά", "όμως", "και", "ή",
  // Hindi / Nepali
  "कि", "जो", "क्योंकि", "जब", "जहाँ", "लेकिन", "परंतु", "और", "या",
]);

export function classifySubtitleRow(
  row: ImportedSubtitleRow,
  colMap: SubtitleSheetColumnMap,
  measurer: SubtitleMeasurer,
): SubtitleRowCategory {
  if (row.isGreenHighlight) return "skip_green";
  const rawTarget = (row.rawCells[colMap.targetCol] ?? "").trim();
  if (!rawTarget) return "skip_empty";

  const role = (row.rawCells[colMap.characterCol] ?? "").trim();
  const citation = colMap.citationCol >= 0 ? (row.rawCells[colMap.citationCol] ?? "").trim() : "";

  if (citation === "摘自" || /^subtitle$/i.test(role)) {
    return "citation_same_screen";
  }

  const clean = normalizeSourceSubtitle(rawTarget, measurer.spec);
  const measured = measurer.measure(clean);

  // Non-green Title I/II/III or multiline Caption graphic cards should not be broken without human confirmation
  if (
    measured > measurer.singleLimit &&
    (/^title\b/i.test(role) || (/^caption\b/i.test(role) && /[\r\n]/.test(rawTarget)))
  ) {
    return "skip_title_graphic";
  }

  if (measurer.spec.isJapanese && clean.slice(0, -1).includes("。") && measured >= 12) {
    return "needs_break";
  }

  if (measured <= measurer.singleLimit) {
    return "short_keep";
  }
  return "needs_break";
}

const ABBREV_RE = /\b(?:Vol|Ep|Mr|Mrs|Ms|Dr|St|No|vs|etc|cap|art|n)\.\s*$/i;

export function findIndependentSentenceSplits(
  tokens: SubtitleToken[],
  measurer: SubtitleMeasurer,
): number[] {
  const endChars = measurer.spec.sentenceEndChars;
  if (endChars.length === 0 || tokens.length < 2) return [];
  const splits: number[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const prevText = tokens[i - 1].text.trim();
    if (ABBREV_RE.test(`${prevText} `)) continue;
    const stripped = prevText.replace(/["”»’')\]」』）]+$/u, "");
    const endsSentence = endChars.some((ch) => ch && stripped.endsWith(ch));
    if (!endsSentence) continue;

    const leftStr = renderTokenSlice(tokens, 0, i, null, measurer.spec);
    const rightStr = renderTokenSlice(tokens, i, tokens.length, null, measurer.spec);
    if (measurer.measure(leftStr) >= 8 && measurer.measure(rightStr) >= 8) {
      splits.push(i);
    }
  }
  return splits;
}

function linguisticBreakBonus(tokens: SubtitleToken[], splitIdx: number, spec: LineBreakLanguageSpec): number {
  const leftWordRaw = tokens[splitIdx - 1].text.trim();
  const rightWordRaw = tokens[splitIdx].text.trim();
  const leftStripped = leftWordRaw.replace(/["”»’')\]」』）]+$/u, "");
  const leftLower = leftWordRaw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
  const rightLower = rightWordRaw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();

  let score = 0;
  if (!ABBREV_RE.test(`${leftWordRaw} `) && spec.sentenceEndChars.some((c) => c && leftStripped.endsWith(c))) {
    score += 42;
  } else if (/[,;:\u2014\u2013、，；：।။។؟]$/u.test(leftStripped)) {
    score += 28;
  } else if (/["»”」』）)]$/u.test(leftWordRaw)) {
    score += 14;
  }

  if (CLAUSE_STARTERS.has(rightLower)) score += 16;
  if (/^["«„“「『（(]/u.test(rightWordRaw)) score += 14;

  if (NON_FINAL_WORDS.has(leftLower) && !/[,;:.?!।။។؟]$/u.test(leftStripped)) {
    score -= 55;
  }
  return score;
}

export function solveCitationSameScreen(
  tokens: SubtitleToken[],
  measurer: SubtitleMeasurer,
): IndexBreakPlan {
  const n = tokens.length;
  const full = renderTokenSlice(tokens, 0, n, null, measurer.spec);
  if (n <= 1 || measurer.measure(full) <= measurer.singleLimit) {
    return { screenEnds: [n], atSplits: [null] };
  }

  let bestIdx = Math.floor(n / 2);
  let bestScore = -1e9;

  for (let i = 1; i < n; i += 1) {
    const left = renderTokenSlice(tokens, 0, i, null, measurer.spec);
    const right = renderTokenSlice(tokens, i, n, null, measurer.spec);
    const mL = measurer.measure(left);
    const mR = measurer.measure(right);
    const ratio = mR > 0 ? mL / mR : 99;

    let score = 0;
    if (/^["«„“「『]/u.test(tokens[i].text)) score += 60;
    if (/[:,・—]$/u.test(tokens[i - 1].text)) score += 45;
    score += linguisticBreakBonus(tokens, i, measurer.spec);
    if (ratio >= measurer.minRatio && ratio <= measurer.maxRatio) score += 30;
    else score -= 40;
    score -= Math.abs(mL - mR) * 0.45;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return { screenEnds: [n], atSplits: [bestIdx] };
}

function findBestAtInsideRange(
  tokens: SubtitleToken[],
  start: number,
  end: number,
  measurer: SubtitleMeasurer,
  singleCapOverride?: number,
): { atIdx: number | null; valid: boolean; score: number } {
  const sliceStr = renderTokenSlice(tokens, start, end, null, measurer.spec);
  const totalM = measurer.measure(sliceStr);
  const cap = singleCapOverride ?? measurer.singleLimit;

  const jpHasInternalPeriod =
    Boolean(measurer.spec.isJapanese) && sliceStr.slice(0, -1).includes("。") && totalM >= 12;

  if (totalM <= measurer.singleLimit && !jpHasInternalPeriod) {
    return { atIdx: null, valid: true, score: 100 };
  }
  if (end - start < 2) {
    return { atIdx: null, valid: totalM <= cap, score: -500 };
  }

  let bestIdx: number | null = null;
  let bestScore = -1e9;
  let bestValid = false;

  for (let k = start + 1; k < end; k += 1) {
    const candidate = renderTokenSlice(tokens, start, end, k, measurer.spec);
    const atPos = candidate.indexOf("@");
    const mL = measurer.measure(candidate.slice(0, atPos));
    const mR = measurer.measure(candidate.slice(atPos + 1));
    const ratio = mR > 0 ? mL / mR : 99;

    const withinCap = mL <= cap && mR <= cap;
    const withinRatio = ratio >= measurer.minRatio && ratio <= measurer.maxRatio;
    const valid = withinCap && withinRatio;

    let score = linguisticBreakBonus(tokens, k, measurer.spec);
    const idealDiff = mR - mL;
    if (idealDiff >= -4 && idealDiff <= 12) score += 12;
    score -= Math.abs(mL - mR) * 0.6;

    if (!withinCap) score -= 400 + Math.max(0, mL - cap, mR - cap) * 20;
    if (!withinRatio) score -= 220;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = k;
      bestValid = valid;
    }
  }

  if (totalM <= measurer.softNoBreakLimit && (!bestValid || bestScore < -20)) {
    return { atIdx: null, valid: true, score: 40 };
  }

  return { atIdx: bestIdx, valid: bestValid, score: bestScore };
}

export function solveOptimalBreakDeterministic(
  tokens: SubtitleToken[],
  measurer: SubtitleMeasurer,
): IndexBreakPlan {
  const n = tokens.length;
  if (n === 0) return { screenEnds: [], atSplits: [] };

  const fullText = renderTokenSlice(tokens, 0, n, null, measurer.spec);
  const totalM = measurer.measure(fullText);

  if (totalM <= measurer.singleLimit && !(measurer.spec.isJapanese && fullText.slice(0, -1).includes("。"))) {
    return { screenEnds: [n], atSplits: [null] };
  }

  const sentenceSplits = findIndependentSentenceSplits(tokens, measurer);
  const preferEarlyTwoScreen =
    totalM >= measurer.earlySplitMin &&
    totalM <= measurer.doubleLimit &&
    sentenceSplits.length > 0;

  if (totalM <= measurer.doubleLimit && !preferEarlyTwoScreen) {
    const oneScreen = findBestAtInsideRange(tokens, 0, n, measurer);
    if (oneScreen.valid || totalM < measurer.earlySplitMin - 6) {
      return { screenEnds: [n], atSplits: [oneScreen.atIdx] };
    }
  }

  const maxScreens = Math.min(n, Math.max(2, Math.ceil(totalM / (measurer.doubleLimit * 0.72))));
  for (let screenCount = 2; screenCount <= maxScreens; screenCount += 1) {
    const plan = solveKScreenSplit(tokens, measurer, screenCount);
    if (plan.allValid || screenCount === maxScreens) {
      return { screenEnds: plan.screenEnds, atSplits: plan.atSplits };
    }
  }

  const fallbackOne = findBestAtInsideRange(tokens, 0, n, measurer);
  return { screenEnds: [n], atSplits: [fallbackOne.atIdx] };
}

function solveKScreenSplit(
  tokens: SubtitleToken[],
  measurer: SubtitleMeasurer,
  kScreens: number,
): { screenEnds: number[]; atSplits: Array<number | null>; allValid: boolean; score: number } {
  const n = tokens.length;
  const dp: number[][] = Array.from({ length: kScreens + 1 }, () => Array(n + 1).fill(-1e12));
  const parentPos: number[][] = Array.from({ length: kScreens + 1 }, () => Array(n + 1).fill(0));
  const chosenAt: Array<Array<number | null>> = Array.from({ length: kScreens + 1 }, () =>
    Array(n + 1).fill(null),
  );
  const segValid: boolean[][] = Array.from({ length: kScreens + 1 }, () => Array(n + 1).fill(false));

  dp[0][0] = 0;
  const targetPerScreen = measurer.measure(renderTokenSlice(tokens, 0, n, null, measurer.spec)) / kScreens;

  for (let s = 1; s <= kScreens; s += 1) {
    for (let end = s; end <= n - (kScreens - s); end += 1) {
      const startMin = s === 1 ? 0 : s - 1;
      const startMax = s === 1 ? 0 : end - 1;
      for (let start = startMin; start <= startMax; start += 1) {
        if (dp[s - 1][start] <= -1e11) continue;
        const segText = renderTokenSlice(tokens, start, end, null, measurer.spec);
        const segM = measurer.measure(segText);
        const inner = findBestAtInsideRange(tokens, start, end, measurer);
        const boundaryBonus = start > 0 ? linguisticBreakBonus(tokens, start, measurer.spec) * 1.45 : 0;
        const balancePenalty = Math.abs(segM - targetPerScreen) * 0.55;
        const overDoublePenalty = segM > measurer.doubleLimit ? (segM - measurer.doubleLimit) * 35 : 0;
        const shortScreenPenalty = segM < 12 ? (12 - segM) * 15 : 0;

        const totalScore =
          dp[s - 1][start] +
          inner.score +
          boundaryBonus -
          balancePenalty -
          overDoublePenalty -
          shortScreenPenalty;

        if (totalScore > dp[s][end]) {
          dp[s][end] = totalScore;
          parentPos[s][end] = start;
          chosenAt[s][end] = inner.atIdx;
          segValid[s][end] =
            (s === 1 ? true : segValid[s - 1][start]) &&
            inner.valid &&
            segM <= measurer.doubleLimit;
        }
      }
    }
  }

  const screenEnds: number[] = [];
  const atSplits: Array<number | null> = [];
  let cur = n;
  for (let s = kScreens; s >= 1; s -= 1) {
    screenEnds.unshift(cur);
    atSplits.unshift(chosenAt[s][cur]);
    cur = parentPos[s][cur];
  }

  return {
    screenEnds,
    atSplits,
    allValid: segValid[kScreens][n],
    score: dp[kScreens][n],
  };
}

export function evaluateAndFinalizePlan(
  sourceRowIndex: number,
  category: SubtitleRowCategory,
  tokens: SubtitleToken[],
  plan: IndexBreakPlan,
  measurer: SubtitleMeasurer,
  usedAi: boolean,
): ProcessedSubtitleRow {
  const n = tokens.length;
  const fullText = renderTokenSlice(tokens, 0, n, null, measurer.spec);
  const fullM = measurer.measure(fullText);

  const validEnds =
    plan.screenEnds.length >= 1 &&
    plan.screenEnds[plan.screenEnds.length - 1] === n &&
    plan.screenEnds.every(
      (v, idx) => Number.isInteger(v) && v > (idx === 0 ? 0 : plan.screenEnds[idx - 1]) && v <= n,
    );

  let safePlan = validEnds ? plan : solveOptimalBreakDeterministic(tokens, measurer);

  // Anti-fragmentation guard (from《断行问题总结.xlsx》):
  // 1) If <= doubleLimit (84) and < earlySplitMin (73) without 2 independent sentences or colon intro, keep 1 screen if valid
  if (category === "needs_break" && safePlan.screenEnds.length > 1 && fullM <= measurer.doubleLimit) {
    const hasTwoSent =
      findIndependentSentenceSplits(tokens, measurer).length > 0 ||
      /[:：]/.test(fullText.slice(0, -2));
    let tmpPrev = 0;
    const minSegM = Math.min(
      ...safePlan.screenEnds.map((end) => {
        const m = measurer.measure(renderTokenSlice(tokens, tmpPrev, end, null, measurer.spec));
        tmpPrev = end;
        return m;
      }),
    );
    if ((fullM < measurer.earlySplitMin && !hasTwoSent) || minSegM < 14) {
      const sameScreen = findBestAtInsideRange(tokens, 0, n, measurer);
      if (sameScreen.valid) {
        safePlan = { screenEnds: [n], atSplits: [sameScreen.atIdx] };
      }
    }
  }

  // 2) If 85..92 and splitting leaves a tiny 1-2 word orphan screen (<15), prefer compact same-screen + reviewNote
  if (
    category === "needs_break" &&
    safePlan.screenEnds.length > 1 &&
    fullM > measurer.doubleLimit &&
    fullM <= measurer.compactSameScreenLimit
  ) {
    let tmpPrev = 0;
    const minSegM = Math.min(
      ...safePlan.screenEnds.map((end) => {
        const m = measurer.measure(renderTokenSlice(tokens, tmpPrev, end, null, measurer.spec));
        tmpPrev = end;
        return m;
      }),
    );
    if (minSegM < measurer.minShortScreenWarn) {
      const compactOne = findBestAtInsideRange(tokens, 0, n, measurer, measurer.singleLimit + 2);
      if (compactOne.valid && compactOne.atIdx !== null) {
        safePlan = {
          screenEnds: [n],
          atSplits: [compactOne.atIdx],
          compactSameScreen: true,
        };
      }
    }
  }

  let prev = 0;
  const screens = safePlan.screenEnds.map((end, idx) => {
    const plainSeg = renderTokenSlice(tokens, prev, end, null, measurer.spec);
    const plainM = measurer.measure(plainSeg);
    const jpInternalPeriod =
      Boolean(measurer.spec.isJapanese) && plainSeg.slice(0, -1).includes("。") && plainM >= 12;

    // Never allow '@' on a screen already <= singleLimit (fixes "46不用断行" pitfall)
    const rawAt = plainM <= measurer.singleLimit && !jpInternalPeriod ? null : (safePlan.atSplits[idx] ?? null);
    const validAt = rawAt !== null && rawAt > prev && rawAt < end ? rawAt : null;
    const screenStr = renderTokenSlice(tokens, prev, end, validAt, measurer.spec);
    prev = end;
    return measurer.analyzeScreen(screenStr);
  });

  if (category === "citation_same_screen") {
    const sc0 = screens[0];
    let citeNote = "";
    if (sc0 && !sc0.hasAt && sc0.measuredTotal > measurer.singleLimit) {
      citeNote = `出处行超${measurer.singleLimit}未加@，请核对`;
    } else if (
      sc0?.hasAt &&
      ((sc0.measuredBeforeAt ?? 0) > measurer.singleLimit + 6 ||
        (sc0.measuredAfterAt ?? 0) > measurer.singleLimit + 6)
    ) {
      citeNote = `出处行较长（@前${sc0.measuredBeforeAt}/@后${sc0.measuredAfterAt}），请核对`;
    }
    return {
      sourceRowIndex,
      category,
      status: "citation_broken",
      usedAi,
      screens,
      reason: "出处行（摘自）：同屏双行不拆屏",
      reviewNote: citeNote,
    };
  }

  const isSoftSingle =
    screens.length === 1 &&
    !screens[0].hasAt &&
    fullM > measurer.singleLimit &&
    fullM <= measurer.softNoBreakLimit;

  const isCompactDouble =
    (Boolean(safePlan.compactSameScreen) || screens.length === 1) &&
    screens.length === 1 &&
    screens[0].hasAt &&
    fullM > measurer.doubleLimit &&
    fullM <= measurer.compactSameScreenLimit &&
    (screens[0].measuredBeforeAt ?? 0) <= measurer.singleLimit + 2 &&
    (screens[0].measuredAfterAt ?? 0) <= measurer.singleLimit + 2 &&
    !screens[0].ratioOutOfBounds;

  const hasHardViolation = screens.some((sc) => {
    if (isSoftSingle || isCompactDouble) return false;
    return sc.exceedsSingleLimit || sc.ratioOutOfBounds || sc.measuredTotal > measurer.doubleLimit;
  });

  if (hasHardViolation && usedAi) {
    let p = 0;
    const repairedScreens = safePlan.screenEnds.map((end) => {
      const rep = findBestAtInsideRange(tokens, p, end, measurer);
      const s = renderTokenSlice(tokens, p, end, rep.atIdx, measurer.spec);
      p = end;
      return measurer.analyzeScreen(s);
    });
    const stillBad = repairedScreens.some(
      (sc) => sc.exceedsSingleLimit || sc.ratioOutOfBounds || sc.measuredTotal > measurer.doubleLimit,
    );
    if (!stillBad) {
      return finalizeStatus(sourceRowIndex, category, repairedScreens, measurer, fullM, true, false, false);
    }
    const detPlan = solveOptimalBreakDeterministic(tokens, measurer);
    return evaluateAndFinalizePlan(sourceRowIndex, category, tokens, detPlan, measurer, false);
  }

  return finalizeStatus(sourceRowIndex, category, screens, measurer, fullM, usedAi, isSoftSingle, isCompactDouble);
}

function buildReviewNote(
  screens: ReturnType<SubtitleMeasurer["analyzeScreen"]>[],
  measurer: SubtitleMeasurer,
  fullM: number,
  isSoftSingle: boolean,
  isCompactDouble: boolean,
): string {
  const notes: string[] = [];

  if (isSoftSingle) {
    notes.push(`${measurer.singleLimit + 1}-${measurer.softNoBreakLimit}微超未加@（共${fullM}，防比例悬殊），请核对`);
  } else if (isCompactDouble) {
    notes.push(`超${measurer.doubleLimit}保留同屏（共${fullM}，语义紧凑防碎屏），请核对`);
  } else {
    for (let i = 0; i < screens.length; i += 1) {
      const sc = screens[i];
      const prefix = screens.length > 1 ? `第${i + 1}屏` : "";
      if (!sc.hasAt && sc.measuredTotal > measurer.singleLimit) {
        notes.push(`${prefix}超${measurer.singleLimit}未加@（${sc.measuredTotal}），请补断行`);
      } else if (sc.hasAt) {
        const b = sc.measuredBeforeAt ?? 0;
        const a = sc.measuredAfterAt ?? 0;
        if (b > measurer.singleLimit || a > measurer.singleLimit) {
          notes.push(`${prefix}单行超${measurer.singleLimit}（@前${b}/@后${a}），请核对`);
        }
        if (sc.ratioOutOfBounds) {
          notes.push(`${prefix}@前后长度差较大（${b}:${a}），请核对美观度`);
        }
      }
      if (sc.measuredTotal > measurer.doubleLimit) {
        notes.push(`${prefix}总长超${measurer.doubleLimit}（${sc.measuredTotal}），请核对是否分屏`);
      }
    }
  }

  if (screens.length >= 3) {
    notes.push(`拆为${screens.length}屏，请核对是否分屏琐碎`);
  } else if (screens.length === 2) {
    const minM = Math.min(...screens.map((s) => s.measuredTotal));
    if (minM < measurer.minShortScreenWarn) {
      notes.push(`含较短分屏（${minM}），请核对是否琐碎`);
    }
  }

  return notes.join("；");
}

function finalizeStatus(
  sourceRowIndex: number,
  category: SubtitleRowCategory,
  screens: ReturnType<SubtitleMeasurer["analyzeScreen"]>[],
  measurer: SubtitleMeasurer,
  fullM: number,
  usedAi: boolean,
  isSoftSingle: boolean,
  isCompactDouble: boolean,
): ProcessedSubtitleRow {
  const reviewNote = buildReviewNote(screens, measurer, fullM, isSoftSingle, isCompactDouble);
  const anyWarn = screens.some((s) => s.exceedsSingleLimit || s.ratioOutOfBounds);
  let status: BreakOutcomeStatus = "broken_same_screen";
  let reason = usedAi ? "AI 意群断行" : "规则意群断行";

  if (isSoftSingle) {
    status = "soft_kept_single";
    reason = "微超单行上限但硬断破坏意群/比例，保留单行";
  } else if (isCompactDouble) {
    status = "compact_kept_double";
    reason = "结构紧凑微超双行上限，保留同屏双行";
  } else if (anyWarn || reviewNote) {
    status = reviewNote && !anyWarn && screens.length > 1 ? "split_multi_screen" : "review_warning";
    reason = reviewNote || "存在超限或长短比悬殊，建议人工复查微调";
  } else if (screens.length > 1) {
    status = "split_multi_screen";
    reason = `${usedAi ? "AI " : ""}语义分 ${screens.length} 屏`;
  } else if (!screens[0]?.hasAt) {
    status = "untouched";
    reason = "未超单行上限";
  }

  return {
    sourceRowIndex,
    category,
    status,
    usedAi,
    screens,
    reason,
    reviewNote,
  };
}

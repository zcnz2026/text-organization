import { getGlobalLineBreakRules } from "./rule-registry";
import type { LineBreakLanguageSpec, ScreenLineMetrics } from "./types";

export interface SubtitleMeasurer {
  spec: LineBreakLanguageSpec;
  /** Single-line limit in normalized units (always 46 for ruler specs, spec.singleMax for char specs) */
  readonly singleLimit: number;
  /** Same-screen two-line limit in normalized units (84 for ruler specs — leaving visual breathing room below 2x=92!) */
  readonly doubleLimit: number;
  readonly softNoBreakLimit: number;
  readonly earlySplitMin: number;
  readonly compactSameScreenLimit: number;
  readonly minRatio: number;
  readonly maxRatio: number;
  readonly minShortScreenWarn: number;
  readonly globalCustomPrompt: string;
  /** Measure a plain string (without '@') in normalized units */
  measure(text: string): number;
  /** Compute full metrics for a single screen string (may contain at most 1 '@') */
  analyzeScreen(screenText: string): ScreenLineMetrics;
}

let sharedCanvasCtx: CanvasRenderingContext2D | null | undefined;

function getCanvas2d(): CanvasRenderingContext2D | null {
  if (sharedCanvasCtx !== undefined) return sharedCanvasCtx;
  if (typeof document !== "undefined") {
    try {
      const c = document.createElement("canvas");
      sharedCanvasCtx = c.getContext("2d");
      return sharedCanvasCtx;
    } catch {
      sharedCanvasCtx = null;
      return null;
    }
  }
  sharedCanvasCtx = null;
  return null;
}

/**
 * Deterministic visual width fallback for headless Node/Vitest environments where
 * HTMLCanvasElement 2D layout is unavailable. Ignores zero-width joiners and
 * non-spacing combining marks (\p{Mn}, \p{Me}, \p{Cf}) that inflate UTF-16 LEN()
 * in Hindi, Burmese, Thai, Khmer, Arabic, and Nepali.
 */
export function estimateVisualUnitsFallback(text: string): number {
  let units = 0;
  for (const ch of text) {
    if (/[\p{Mn}\p{Me}\p{Cf}]/u.test(ch)) {
      continue;
    }
    if (/[\p{Mc}]/u.test(ch)) {
      units += 0.45;
    } else if (ch === " ") {
      units += 0.55;
    } else if (/[.,;:!'|lI1¡¿]/u.test(ch)) {
      units += 0.5;
    } else if (/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uff60]/u.test(ch)) {
      units += 1.75;
    } else {
      units += 1.0;
    }
  }
  return units;
}

function measureRawPixelsOrFallback(text: string, spec: LineBreakLanguageSpec): number {
  if (!text) return 0;
  const ctx = getCanvas2d();
  if (ctx) {
    // Strictly Regular (400) weight per audio [22:47]: bold source text must be measured as Regular
    ctx.font = `normal 400 ${spec.fontSizePt}pt "${spec.fontFamily}", Arial, sans-serif`;
    const w = ctx.measureText(text).width;
    if (w > 0) return w;
  }
  return estimateVisualUnitsFallback(text) * 8.2;
}

/**
 * Creates a unified measurer:
 * - For "char" languages: exact Excel LEN() character count.
 * - For "ruler" languages: measures pixel width at 12pt Regular and normalizes
 *   1x ruler width -> 46.0 equivalent units (so 1x ruler = 46, 2x ruler = 92,
 *   and doubleLimit = 84 naturally preserves the ~8.7% bottom visual breathing room
 *   described in audio [21:27]!).
 */
export function createSubtitleMeasurer(spec: LineBreakLanguageSpec): SubtitleMeasurer {
  if (spec.mode === "char") {
    const measure = (text: string) => text.length;
    return buildMeasurerObject(spec, measure);
  }

  const rulerBasePx =
    spec.rulerText && spec.rulerText.trim().length > 0
      ? measureRawPixelsOrFallback(spec.rulerText, spec)
      : (spec.fixedRulerPx ?? 320);

  const safeRulerPx = rulerBasePx > 1 ? rulerBasePx : 320;

  const measure = (text: string): number => {
    if (!text) return 0;
    const px = measureRawPixelsOrFallback(text, spec);
    return Math.round(((px / safeRulerPx) * 46) * 10) / 10;
  };

  return buildMeasurerObject(spec, measure);
}

function buildMeasurerObject(
  spec: LineBreakLanguageSpec,
  measure: (text: string) => number,
): SubtitleMeasurer {
  const globalRules = getGlobalLineBreakRules();
  const singleLimit = spec.singleMax;
  const doubleLimit = spec.doubleMax;
  const softNoBreakLimit = spec.softNoBreakMax;
  const earlySplitMin = spec.earlySplitSentenceMin;
  const compactSameScreenLimit = spec.compactSameScreenMax;
  const minRatio = globalRules.minLineRatio;
  const maxRatio = globalRules.maxLineRatio;
  const minShortScreenWarn = globalRules.minShortScreenWarn;
  const globalCustomPrompt = globalRules.globalCustomPrompt;

  return {
    spec,
    singleLimit,
    doubleLimit,
    softNoBreakLimit,
    earlySplitMin,
    compactSameScreenLimit,
    minRatio,
    maxRatio,
    minShortScreenWarn,
    globalCustomPrompt,
    measure,
    analyzeScreen(screenText: string): ScreenLineMetrics {
      const clean = screenText.trim();
      const rawCharLen = clean.length;
      const atIdx = clean.indexOf("@");
      if (atIdx < 0) {
        const measuredTotal = measure(clean);
        return {
          text: clean,
          rawCharLen,
          measuredTotal,
          hasAt: false,
          beforeAtLen: null,
          afterAtLen: null,
          measuredBeforeAt: null,
          measuredAfterAt: null,
          ratio: null,
          exceedsSingleLimit: measuredTotal > singleLimit,
          ratioOutOfBounds: false,
        };
      }

      const left = clean.slice(0, atIdx);
      const right = clean.slice(atIdx + 1);
      const mLeft = measure(left);
      const mRight = measure(right);
      const measuredTotal =
        spec.mode === "char"
          ? rawCharLen
          : Math.round((mLeft + mRight) * 10) / 10;
      const ratio =
        mRight > 0 ? Math.round((mLeft / mRight) * 100) / 100 : 99;
      const ratioOutOfBounds = ratio > maxRatio || ratio < minRatio;
      const exceedsSingleLimit = mLeft > singleLimit || mRight > singleLimit;

      return {
        text: clean,
        rawCharLen,
        measuredTotal,
        hasAt: true,
        beforeAtLen: left.length,
        afterAtLen: right.length,
        measuredBeforeAt: mLeft,
        measuredAfterAt: mRight,
        ratio,
        exceedsSingleLimit,
        ratioOutOfBounds,
      };
    },
  };
}

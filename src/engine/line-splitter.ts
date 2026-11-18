import type { GeminiPoolClient } from "../ai/gemini-client";
import type { PunctuationRule, ScriptRow } from "../types/domain";
import { stripOuterDoubleQuotes } from "./punctuation";

const SPLIT_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["lines"],
};

function capitalizeFirstLetter(text: string): string {
  return text.replace(/^([^\p{L}]*)(\p{L})/u, (_m, pre: string, ch: string) =>
    `${pre}${ch.toUpperCase()}`,
  );
}

function verifyTokensSubsequence(sourceText: string, candidateLines: string[]): boolean {
  const norm = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const fullNorm = norm(sourceText);
  const candNorm = norm(candidateLines.join(""));
  if (!candNorm) return false;
  return fullNorm.includes(candNorm) || candNorm === fullNorm;
}

export function deterministicSplitLines(
  rawTargetParagraph: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
): string[] {
  const count = sourceRows.length;
  const cleanTarget = stripOuterDoubleQuotes(rawTargetParagraph);
  if (count <= 1) return [cleanTarget];

  let workingText = cleanTarget;
  const firstRem = sourceRows[0]?.remark ?? "";
  const truncMatch = /涉及截取[：:]\s*(.+)$/u.exec(firstRem);
  if (truncMatch && sourceRows[0].english) {
    const fullOriginEn = truncMatch[1].trim();
    const keptEn = stripOuterDoubleQuotes(sourceRows[0].english);
    const dropRatio = Math.max(
      0,
      (fullOriginEn.length - keptEn.length) / Math.max(1, fullOriginEn.length),
    );
    if (dropRatio > 0.08 && dropRatio < 0.6) {
      const commaIdx = workingText.indexOf(",");
      if (commaIdx > 0 && commaIdx < workingText.length * 0.45) {
        workingText = capitalizeFirstLetter(workingText.slice(commaIdx + 1).trim());
      }
    }
  }

  const words = workingText.split(/\s+/).filter(Boolean);
  if (words.length < count) {
    const chars = [...workingText];
    const step = Math.max(1, Math.ceil(chars.length / count));
    return sourceRows.map((_r, idx) =>
      chars.slice(idx * step, idx === count - 1 ? chars.length : (idx + 1) * step).join("").trim(),
    );
  }

  const weights = sourceRows.map((r) =>
    Math.max(4, stripOuterDoubleQuotes(r.english || r.chinese).length),
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const lines: string[] = [];
  let wordCursor = 0;
  let accWeight = 0;

  for (let i = 0; i < count; i += 1) {
    accWeight += weights[i];
    if (i === count - 1) {
      lines.push(words.slice(wordCursor).join(" "));
      break;
    }

    const idealEnd = Math.round((accWeight / totalWeight) * words.length);
    const remainingRows = count - 1 - i;
    const maxEnd = words.length - remainingRows;
    const minEnd = wordCursor + 1;
    let bestEnd = Math.min(maxEnd, Math.max(minEnd, idealEnd));

    const searchRadius = Math.min(4, Math.floor((maxEnd - minEnd) / 2));
    for (let offset = 0; offset <= searchRadius; offset += 1) {
      for (const candidate of [bestEnd + offset, bestEnd - offset]) {
        if (candidate >= minEnd && candidate <= maxEnd) {
          if (/[,.;:!?—–]$/.test(words[candidate - 1])) {
            bestEnd = candidate;
            offset = searchRadius + 1;
            break;
          }
        }
      }
    }

    let chunk = words.slice(wordCursor, bestEnd).join(" ");
    if (
      (sourceRows[i].remark.includes("有省略") ||
        sourceRows[i].chinese.includes("……") ||
        sourceRows[i].english.includes("…")) &&
      !chunk.endsWith(rule.ellipsis) &&
      !chunk.endsWith("...")
    ) {
      chunk = `${chunk} ${rule.ellipsis}`;
    }
    lines.push(chunk);
    wordCursor = bestEnd;
  }

  return lines;
}

export async function splitTargetIntoScriptLines(
  rawTargetParagraph: string,
  sourceRows: ScriptRow[],
  rule: PunctuationRule,
  gemini?: GeminiPoolClient,
): Promise<{ lines: string[]; usedAi: boolean }> {
  if (sourceRows.length <= 1) {
    return { lines: [stripOuterDoubleQuotes(rawTargetParagraph)], usedAi: false };
  }

  if (gemini?.hasKeys) {
    try {
      const rowSpec = sourceRows
        .map(
          (r, idx) =>
            `[${idx + 1}] ZH: ${r.chinese} | EN: ${r.english}${r.remark ? ` | 备注: ${r.remark}` : ""}`,
        )
        .join("\n");

      const res = await gemini.generateStructuredJson<{ lines: string[] }>({
        systemInstruction:
          "你是多语种影视字幕逐行对齐助手。将给定的目标语种定稿段落严格按各行中英文语义边界切分为完全相同行数的数组。严禁改写、增删或重译原文任何词汇；若某行备注有省略则在该行末尾补省略号；若首行备注涉及截取则去掉被截取的前导词并将新句首字母大写；不加最外层起止双引号。",
        userPrompt: `目标语种：${rule.langName}\n待切分定稿原文：\n${stripOuterDoubleQuotes(rawTargetParagraph)}\n\n目标字幕行（共 ${sourceRows.length} 行）：\n${rowSpec}`,
        jsonSchema: SPLIT_SCHEMA,
      });

      if (
        Array.isArray(res.lines) &&
        res.lines.length === sourceRows.length &&
        res.lines.every((l) => l.trim().length > 0) &&
        verifyTokensSubsequence(rawTargetParagraph, res.lines)
      ) {
        return { lines: res.lines.map((l) => l.trim()), usedAi: true };
      }
    } catch {
      // Fallback cleanly to deterministic clause splitter
    }
  }

  return {
    lines: deterministicSplitLines(rawTargetParagraph, sourceRows, rule),
    usedAi: false,
  };
}

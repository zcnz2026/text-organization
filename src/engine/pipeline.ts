import type { GeminiPoolClient } from "../ai/gemini-client";
import type { ArticleParagraph, LanguageCatalog } from "../catalog/catalog-types";
import type {
  ExtractionTask,
  LanguageRunOutput,
  ProcessedRowResult,
  PunctuationRule,
  ScriptRow,
  ScriptSheetDocument,
} from "../types/domain";
import { classifyScriptTasks } from "./classifier";
import {
  type BatchSplitRequest,
  batchSplitTargetsWithAi,
  deterministicSplitLines,
  type SplitResult,
  splitTargetIntoScriptLines,
} from "./line-splitter";
import {
  formatBibleBlockAndCitation,
  formatQuotedBlockLines,
  formatStandaloneTitle,
  stripOuterDoubleQuotes,
} from "./punctuation";
import {
  aggregateHymnSublinesForBlock,
  dedupeRepeatedLyricClause,
  extractTruncatedSentencePair,
  findArticleInCatalog,
  findBibleVerse,
  findHymnMatch,
  findIdiomMatch,
  findRosterMatch,
  locateParagraphInManuscript,
  lookupPhraseForNoteXx,
  parseTruncationSpec,
  replaceNoteXxPlaceholders,
  resolveCitationText,
  resolveComboHymnTitle,
} from "./text-matcher";

export interface PipelineOptions {
  enableRosterPreFill: boolean;
  gemini?: GeminiPoolClient;
  loadArticleDoc?: (docUrl: string) => Promise<ArticleParagraph[]>;
  onProgress?: (doneTasks: number, totalTasks: number, label: string) => void;
}

function alignAmenExclamation(line: string, srcRow: ScriptRow): string {
  const wantsExclam = /[!！]["”»'’]*$/u.test((srcRow.english || srcRow.chinese || "").trim());
  if (!wantsExclam) return line;
  return line.replace(/[.。]$/u, "!");
}

export async function splitLordsPrayerFullText(
  fullText: string,
  blockRows: ScriptRow[],
  rule: PunctuationRule,
  gemini?: GeminiPoolClient,
): Promise<string[]> {
  const clean = fullText.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (blockRows.length <= 1) return [alignAmenExclamation(clean, blockRows[0])];

  const lastRow = blockRows[blockRows.length - 1];
  const isLastRowAmen =
    /阿们|阿們/u.test(lastRow.chinese) || /^amen[!！.。]*$/i.test(lastRow.english.trim());

  let bodyText = clean;
  let amenTail = "";
  let firstLineLead = "";

  if (isLastRowAmen) {
    const tailMatch = /(?:^|\s+)([^\s]+(?:[!！.。।។။]+)?)\s*$/u.exec(bodyText);
    if (tailMatch && tailMatch.index > 0) {
      amenTail = alignAmenExclamation(tailMatch[1].trim(), lastRow);
      bodyText = bodyText.slice(0, tailMatch.index).trim();
    }
  }

  const firstRow = blockRows[0];
  if (blockRows.length >= 3 && (firstRow.chinese.trim().length <= 8 || firstRow.english.trim().length <= 18)) {
    const leadMatch =
      /^(¡[^!！]+[!！]|[^,，!！.。：:\n]+(?:[,，]\s*[^,，!！.。：:\n]+)?[!！：:]|[^,，!！.。：:\n]+[,，!！：:])\s+(.+)$/u.exec(
        bodyText,
      );
    if (leadMatch && leadMatch[1].split(/\s+/).length <= 5) {
      firstLineLead = leadMatch[1].trim();
      bodyText = leadMatch[2].trim();
    }
  }

  const midRows = blockRows.slice(firstLineLead ? 1 : 0, amenTail ? blockRows.length - 1 : blockRows.length);
  if (midRows.length === 0) return [firstLineLead, amenTail].filter(Boolean);
  const midSplit = await splitTargetIntoScriptLines(bodyText, midRows, rule, gemini, {
    suppressAutoEllipsis: true,
  });
  return [...(firstLineLead ? [firstLineLead] : []), ...midSplit.lines, ...(amenTail ? [amenTail] : [])];
}

interface DeferredAiSplit {
  req: BatchSplitRequest;
  apply: (split: SplitResult) => void;
}

export async function runLanguageExtractionPipeline(
  script: ScriptSheetDocument,
  catalog: LanguageCatalog,
  options: PipelineOptions,
): Promise<LanguageRunOutput> {
  const results: ProcessedRowResult[] = script.rows.map((r) => ({
    rowIndex: r.rowIndex,
    targetLanguage: r.targetLanguage,
    note: r.note,
    status: "untouched",
    hint: "",
  }));

  const tasks = classifyScriptTasks(script.rows);
  const deferredSplits: DeferredAiSplit[] = [];
  const postBatchHooks: Array<() => void> = [];

  const ensureManuscript = async (docUrl: string): Promise<ArticleParagraph[]> => {
    if (!docUrl) return [];
    const cached = catalog.articleDocsCache.get(docUrl);
    if (cached) return cached;
    if (!options.loadArticleDoc) return [];
    const loaded = await options.loadArticleDoc(docUrl);
    catalog.articleDocsCache.set(docUrl, loaded);
    return loaded;
  };

  for (let tIdx = 0; tIdx < tasks.length; tIdx += 1) {
    const task = tasks[tIdx];
    options.onProgress?.(tIdx + 1, tasks.length + (options.gemini?.hasKeys ? 1 : 0), task.sourceHint);
    await processSingleTask(task, script.rows, catalog, results, options, ensureManuscript, deferredSplits, postBatchHooks);
  }

  if (deferredSplits.length > 0) {
    options.onProgress?.(tasks.length, tasks.length + 1, `AI 语义对齐分句与双语复核 (${deferredSplits.length} 块)...`);
    const batchMap = await batchSplitTargetsWithAi(
      deferredSplits.map((d) => d.req),
      catalog.rule,
      options.gemini,
    );
    for (const d of deferredSplits) {
      const hit = batchMap.get(d.req.id) ?? {
        lines: deterministicSplitLines(d.req.fallbackText, d.req.sourceRows, catalog.rule),
        usedAi: false,
      };
      d.apply(hit);
    }
  }

  for (const hook of postBatchHooks) {
    hook();
  }

  let matchedCount = 0;
  let warningCount = 0;
  let missingCount = 0;
  for (const r of results) {
    if (r.status === "matched") matchedCount += 1;
    else if (r.status === "warning") warningCount += 1;
    else if (r.status === "missing") missingCount += 1;
  }
  return { langName: catalog.langName, rows: results, matchedCount, warningCount, missingCount };
}

async function processSingleTask(
  task: ExtractionTask,
  rows: ScriptRow[],
  catalog: LanguageCatalog,
  results: ProcessedRowResult[],
  options: PipelineOptions,
  ensureManuscript: (url: string) => Promise<ArticleParagraph[]>,
  deferredSplits: DeferredAiSplit[],
  postBatchHooks: Array<() => void>,
): Promise<void> {
  const firstIdx = task.rowIndices[0];
  const firstRow = rows[firstIdx];

  if (task.kind === "god_words_prefix") {
    if (catalog.godSaysText) {
      const hasColon = /[:：]$/.test(firstRow.english.trim() || firstRow.chinese.trim());
      const base = catalog.godSaysText.replace(/[:：]$/u, "");
      results[firstIdx].targetLanguage = hasColon ? `${base}:` : base;
      results[firstIdx].status = "matched";
    } else {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = "常用词汇表中未找到「全能神说」";
    }
    return;
  }

  if (task.kind === "citation_subtitle") {
    const cite = resolveCitationText(catalog, firstRow, task.citationVariant ?? "subtitle_band");
    if (cite) {
      results[firstIdx].targetLanguage = cite;
      results[firstIdx].status = "matched";
    } else {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = "未匹配到对应摘自格式";
    }
    return;
  }

  if (task.kind === "idiom") {
    const idiom = findIdiomMatch(catalog.idioms, firstRow.chinese, firstRow.english);
    if (idiom) {
      results[firstIdx].targetLanguage = idiom;
      results[firstIdx].status = "matched";
    } else {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = "新俗语表中未找到该词条";
    }
    return;
  }

  if (task.kind === "lords_prayer") {
    const blockRows = task.rowIndices.map((idx) => rows[idx]);
    const fullText = catalog.lordsPrayerFullText?.trim() ?? "";
    if (catalog.lordsPrayer.length === 0 && !fullText) {
      for (const idx of task.rowIndices) {
        results[idx].status = "missing";
        results[idx].hint = "未加载到该语种主祷文定稿";
      }
      return;
    }
    if (catalog.lordsPrayer.length === blockRows.length) {
      task.rowIndices.forEach((rIdx, k) => {
        const line = catalog.lordsPrayer[k].target;
        results[rIdx].targetLanguage = k === blockRows.length - 1 ? alignAmenExclamation(line, blockRows[k]) : line;
        results[rIdx].status = "matched";
      });
      return;
    }
    const sourceFull = fullText || catalog.lordsPrayer.map((p) => p.target).join(" ");
    if (options.gemini?.hasKeys && blockRows.length > 1) {
      deferredSplits.push({
        req: {
          id: task.id,
          fallbackText: sourceFull,
          aiSourceText: sourceFull,
          sourceRows: blockRows,
          suppressAutoEllipsis: true,
        },
        apply: (split) => {
          task.rowIndices.forEach((rIdx, k) => {
            const rawL = split.lines[k] ?? "";
            results[rIdx].targetLanguage =
              k === blockRows.length - 1 ? alignAmenExclamation(rawL, blockRows[k]) : rawL;
            results[rIdx].status = "matched";
            if (k === 0 && split.hasInversion) {
              results[rIdx].hint = "含倒装句，已保持原语序";
            }
          });
        },
      });
      return;
    }
    const splitLines = await splitLordsPrayerFullText(sourceFull, blockRows, catalog.rule, undefined);
    task.rowIndices.forEach((rIdx, k) => {
      results[rIdx].targetLanguage = splitLines[k] ?? "";
      results[rIdx].status = "matched";
    });
    return;
  }

  if (task.kind === "bible_verses") {
    const verseRows = task.rowIndices.map((idx) => rows[idx]);
    const matched = findBibleVerse(catalog.bibleEntries, task.sourceHint, verseRows);
    if (!matched) {
      for (const idx of task.rowIndices) {
        results[idx].status = "missing";
        results[idx].hint = "指定圣经库中未找到该经文（不自动混查其他圣经版本）";
      }
      if (task.citationRowIndex !== undefined) {
        results[task.citationRowIndex].status = "missing";
        results[task.citationRowIndex].hint = "指定圣经库未找到对应章节出处";
      }
      return;
    }

    const applyBibleSplit = (split: SplitResult) => {
      const linesCopy = [...split.lines];
      if (matched.truncatedStart && linesCopy.length > 0 && !linesCopy[0].startsWith(catalog.rule.ellipsis)) {
        linesCopy[0] = `${catalog.rule.ellipsis} ${linesCopy[0]}`;
      }
      const formatted = formatBibleBlockAndCitation(linesCopy, matched.targetCitationRef, catalog.rule);
      const lastSrcRow = verseRows[verseRows.length - 1];
      const hasInlineRefInSrc =
        task.citationRowIndex === undefined &&
        (/\([^()]+\d+[:.]\d+[^()]*\)[.,;"”']*$/i.test(lastSrcRow.english.trim()) ||
          /[（(][^）()]+\d+[:：]\d+[^）()]*[）)][，,。.”"]*$/u.test(lastSrcRow.chinese.trim()));
      if (hasInlineRefInSrc && formatted.verseLines.length > 0 && formatted.citationText) {
        const li = formatted.verseLines.length - 1;
        formatted.verseLines[li] = `${formatted.verseLines[li]} ${formatted.citationText}`;
      }

      task.rowIndices.forEach((rIdx, k) => {
        results[rIdx].targetLanguage = formatted.verseLines[k];
        if (matched.source) results[rIdx].bibleSource = matched.source;
        const rowTrunc = parseTruncationSpec(verseRows[k]);
        if (rowTrunc.hasTruncation || (k === 0 && matched.truncatedStart)) {
          results[rIdx].status = "warning";
          const pairText = extractTruncatedSentencePair(matched.text, "", verseRows[k]);
          results[rIdx].hint = pairText
            ? `涉及截取（原完整句）：${pairText}`
            : "涉及经文截取，请核对切分与省略号";
        } else {
          results[rIdx].status = "matched";
          if (k === 0 && split.hasInversion) {
            results[rIdx].hint = "含倒装句，已保持原语序";
          }
        }
      });
      if (task.citationRowIndex !== undefined) {
        results[task.citationRowIndex].targetLanguage = formatted.citationText;
        if (matched.source) results[task.citationRowIndex].bibleSource = matched.source;
        results[task.citationRowIndex].status = "matched";
      }
    };

    if (options.gemini?.hasKeys && (verseRows.length > 1 || matched.truncatedStart)) {
      deferredSplits.push({
        req: { id: task.id, fallbackText: matched.text, aiSourceText: matched.text, sourceRows: verseRows },
        apply: applyBibleSplit,
      });
      return;
    }

    const split = await splitTargetIntoScriptLines(matched.text, verseRows, catalog.rule, undefined);
    applyBibleSplit(split);
    return;
  }

  if (task.kind === "hymn_lyrics") {
    const blockRows = task.rowIndices.map((idx) => rows[idx]);
    const hymn = findHymnMatch(catalog.hymns, task.sourceHint);
    if (hymn && hymn.lines.length > 0) {
      const rawLines =
        hymn.lines.length === blockRows.length
          ? hymn.lines.map((l) => stripOuterDoubleQuotes(l.target))
          : aggregateHymnSublinesForBlock(hymn.lines, blockRows) ??
            (await splitTargetIntoScriptLines(hymn.lines.map((l) => l.target).join(" "), blockRows, catalog.rule, options.gemini)).lines;
      const deduped = rawLines.map((line, k) => dedupeRepeatedLyricClause(line, blockRows[k]?.english ?? ""));
      const quoted = formatQuotedBlockLines(deduped, catalog.rule, true);
      task.rowIndices.forEach((rIdx, k) => {
        results[rIdx].targetLanguage = quoted[k];
        const trunc = parseTruncationSpec(blockRows[k]);
        results[rIdx].status = trunc.hasTruncation ? "warning" : "matched";
        if (trunc.hasTruncation) {
          results[rIdx].hint = "歌词涉及原文截取，请核对";
        }
      });
      return;
    }
    if (task.sourceHint.includes("卷")) {
      await extractFromArticleManuscript(task, rows, catalog, results, options, ensureManuscript, deferredSplits, postBatchHooks);
      return;
    }
    for (const idx of task.rowIndices) {
      results[idx].status = "missing";
      results[idx].hint = "诗歌表中未找到该首诗歌";
    }
    return;
  }

  if (task.kind === "god_words_body") {
    await extractFromArticleManuscript(task, rows, catalog, results, options, ensureManuscript, deferredSplits, postBatchHooks);
    return;
  }

  if (task.kind === "standalone_title") {
    const noteRes = replaceNoteXxPlaceholders(firstRow.note, catalog, options.enableRosterPreFill);
    results[firstIdx].note = noteRes.updatedNote;
    const noteLines = firstRow.note.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const rawTitle =
      (noteLines.length >= 2 && lookupPhraseForNoteXx(catalog, noteLines[0], options.enableRosterPreFill)?.value) ||
      findHymnMatch(catalog.hymns, firstRow.chinese)?.targetTitle ||
      findArticleInCatalog(catalog.articles, firstRow.chinese, firstRow.chinese, firstRow.english)?.targetTitle ||
      "";
    if (rawTitle) {
      results[firstIdx].targetLanguage = formatStandaloneTitle(rawTitle, firstRow.english, firstRow.chinese, catalog.rule);
      results[firstIdx].status = "matched";
    } else {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = "未找到对应外文标题";
    }
    return;
  }

  if (task.kind === "combo_title") {
    const hymn = findHymnMatch(catalog.hymns, firstRow.chinese);
    const fallbackArticleTitle =
      !hymn?.targetTitle && firstRow.chinese.includes("诗歌")
        ? findArticleInCatalog(catalog.articles, firstRow.chinese, firstRow.chinese, firstRow.english)?.targetTitle
        : "";
    const targetSongTitle = hymn?.targetTitle || fallbackArticleTitle || "";
    if (targetSongTitle) {
      const composed = resolveComboHymnTitle(catalog, firstRow, targetSongTitle);
      if (composed.fullyComposed) {
        results[firstIdx].targetLanguage = composed.text;
        results[firstIdx].status = "matched";
      } else {
        results[firstIdx].targetLanguage = formatStandaloneTitle(targetSongTitle, "", "", catalog.rule);
        results[firstIdx].status = "warning";
        results[firstIdx].hint = "已填入目标语种歌名，固定前缀待组合";
      }
    } else {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = "诗歌表中未找到对应歌名";
    }
    return;
  }

  if (task.kind === "inline_note_xx") {
    const noteRes = replaceNoteXxPlaceholders(firstRow.note, catalog, options.enableRosterPreFill);
    results[firstIdx].note = noteRes.updatedNote;
    if (noteRes.missingCount > 0) {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = `Note 中有 ${noteRes.missingCount} 处 XX 未匹配到外文名称`;
    } else if (noteRes.replacedCount > 0) {
      results[firstIdx].status = noteRes.usedRoster ? "warning" : "matched";
      results[firstIdx].hint = noteRes.usedRoster ? "Note 名称摘自人名/教会名库，请顺便核对" : "";
    }
    return;
  }

  if (task.kind === "roster_match" && options.enableRosterPreFill) {
    const matched = findRosterMatch(catalog.rosterEntries, firstRow.chinese, firstRow.english, false);
    if (matched) {
      results[firstIdx].targetLanguage = matched.targetText;
      results[firstIdx].status = "warning";
      results[firstIdx].hint = `摘自人名/教会名库（${matched.episode || "最新期"}），请顺便核对`;
    }
  }
}

/**
 * Splits a block into contiguous sub-segments whenever:
 * - the previous row had an omission ("有省略" or trailing …… / …), OR
 * - the current row (k > 0) starts a newly truncated sentence ("截取").
 * This guarantees multi-jump hymns/excerpts (like 《神希望人能追求真理剩存下来》) locate each jump cleanly!
 */
function splitBlockIntoContiguousSubSegments(rowIndices: number[], rows: ScriptRow[]): number[][] {
  const segments: number[][] = [];
  let cur: number[] = [];
  for (let k = 0; k < rowIndices.length; k += 1) {
    const rIdx = rowIndices[k];
    const row = rows[rIdx];
    const prevRow = k > 0 ? rows[rowIndices[k - 1]] : null;
    const prevHadOmission = Boolean(
      prevRow &&
        (prevRow.remark.includes("有省略") ||
          prevRow.chinese.includes("……") ||
          /(?:…|\.\.\.)["”»'’]*$/u.test(prevRow.english.trim())),
    );
    const curStartsTruncation = k > 0 && parseTruncationSpec(row).hasTruncation;

    if (cur.length > 0 && (prevHadOmission || curStartsTruncation)) {
      segments.push(cur);
      cur = [];
    }
    cur.push(rIdx);
  }
  if (cur.length > 0) segments.push(cur);
  return segments;
}

async function extractFromArticleManuscript(
  task: ExtractionTask,
  rows: ScriptRow[],
  catalog: LanguageCatalog,
  results: ProcessedRowResult[],
  options: PipelineOptions,
  ensureManuscript: (url: string) => Promise<ArticleParagraph[]>,
  deferredSplits: DeferredAiSplit[],
  postBatchHooks: Array<() => void>,
): Promise<void> {
  const nextRow = rows[task.rowIndices[task.rowIndices.length - 1] + 1];
  const article = findArticleInCatalog(catalog.articles, task.sourceHint, nextRow?.chinese ?? "", nextRow?.english ?? "");

  if (!article) {
    for (const idx of task.rowIndices) {
      results[idx].status = "missing";
      results[idx].hint = `六本书目录中未找到篇目：${task.sourceHint}`;
    }
    return;
  }

  const paragraphs = await ensureManuscript(article.docUrl);
  const subSegments = splitBlockIntoContiguousSubSegments(task.rowIndices, rows);
  const isHymnTask = task.kind === "hymn_lyrics";

  const hasFollowingCitation = Boolean(
    nextRow && /摘自|卷|话|from the word|\(the word/i.test(`${nextRow.chinese} ${nextRow.english}`),
  );

  // Locate each sub-segment; if sub-segment 0 is a 1-row opener before multi-row sub-segment 1,
  // anchor sub-segment 1 first so sub-segment 0 prefers paragraphs near sub-segment 1 (avoiding intro false matches!).
  const locatedBySeg: Array<ReturnType<typeof locateParagraphInManuscript>> = new Array(subSegments.length).fill(null);

  for (let s = subSegments.length - 1; s >= 0; s -= 1) {
    const segRows = subSegments[s].map((idx) => rows[idx]);
    let pool = paragraphs;
    if (s === 0 && subSegments.length > 1 && segRows.length === 1 && locatedBySeg[1]) {
      const nextTarget = locatedBySeg[1]!.fullParagraphTarget;
      const anchorIdx = paragraphs.findIndex((p) => p.target && nextTarget.includes(p.target.trim().slice(0, 40)));
      if (anchorIdx > 0) {
        const nearPool = paragraphs.slice(Math.max(0, anchorIdx - 3), anchorIdx + 2);
        const nearHit = locateParagraphInManuscript(nearPool, segRows);
        if (nearHit) {
          locatedBySeg[s] = nearHit;
          continue;
        }
      }
    }
    locatedBySeg[s] = locateParagraphInManuscript(pool, segRows);
  }

  if (locatedBySeg.every((loc) => !loc)) {
    for (const idx of task.rowIndices) {
      results[idx].status = "missing";
      results[idx].hint = article.docUrl ? `单篇《${article.zhTitle}》中未定位到对应段落` : `篇目《${article.zhTitle}》缺少单篇链接`;
    }
    return;
  }

  // Collect unquoted split lines per row across all sub-segments, then format outer quotes across the whole task block!
  const unquotedByRowIndex = new Map<number, string>();
  let pendingSegments = 0;

  const finalizeWholeBlockQuotes = () => {
    const orderedRaw = task.rowIndices.map((rIdx) => unquotedByRowIndex.get(rIdx) ?? "");
    if (orderedRaw.every((s) => !s)) return;
    const quoted = formatQuotedBlockLines(orderedRaw, catalog.rule, true, hasFollowingCitation);
    task.rowIndices.forEach((rIdx, k) => {
      if (unquotedByRowIndex.has(rIdx)) {
        results[rIdx].targetLanguage = quoted[k];
      }
    });
  };

  for (let s = 0; s < subSegments.length; s += 1) {
    const segIndices = subSegments[s];
    const segRows = segIndices.map((idx) => rows[idx]);
    const located = locatedBySeg[s];
    if (!located) {
      for (const rIdx of segIndices) {
        results[rIdx].status = "missing";
        results[rIdx].hint = `单篇《${article.zhTitle}》中未定位到该子段`;
      }
      continue;
    }

    const applySegSplit = (split: SplitResult) => {
      segIndices.forEach((rIdx, k) => {
        unquotedByRowIndex.set(rIdx, split.lines[k] ?? "");
        const row = segRows[k];
        const truncSpec = parseTruncationSpec(row);
        const rowExplicitOmit =
          !isHymnTask &&
          (row.remark.includes("有省略") || row.chinese.includes("……") || /(?:…|\.\.\.)["”»'’]*$/u.test(row.english.trim()));

        if (truncSpec.hasTruncation) {
          results[rIdx].status = "warning";
          const sentencePair = extractTruncatedSentencePair(
            located.fullParagraphTarget,
            located.fullParagraphEn,
            row,
          );
          results[rIdx].hint = sentencePair
            ? `涉及截取（原完整句）：${sentencePair}`
            : "涉及截取，请核对句首切分与大小写";
        } else if (rowExplicitOmit) {
          results[rIdx].status = "warning";
          results[rIdx].hint = "此处原文中间有省略，请核对省略号衔接";
        } else if (located.isPartial && !split.usedAi) {
          results[rIdx].status = "warning";
          results[rIdx].hint = options.gemini?.hasKeys
            ? "AI 分句调用失败（已回退子句估算），请点「缺失日志」下载查看具体报错原因"
            : "局部半句截取（未配置 API 密钥，已按子句估算）";
        } else {
          results[rIdx].status = "matched";
          results[rIdx].hint = k === 0 && split.hasInversion ? "含倒装句，已保持原语序" : "";
        }
      });
    };

    const hasTruncInSeg = segRows.some((r) => parseTruncationSpec(r).hasTruncation);
    const needAi = segRows.length > 1 || located.isPartial || hasTruncInSeg;

    if (options.gemini?.hasKeys && needAi) {
      pendingSegments += 1;
      deferredSplits.push({
        req: {
          id: `${task.id}_seg${s}`,
          fallbackText: located.matchedText,
          aiSourceText: located.contextWindowTarget,
          referenceEn: located.fullParagraphEn,
          sourceRows: segRows,
          suppressAutoEllipsis: isHymnTask,
        },
        apply: applySegSplit,
      });
    } else {
      const split = await splitTargetIntoScriptLines(located.matchedText, segRows, catalog.rule, undefined, {
        fullParagraphTarget: located.contextWindowTarget,
        referenceEn: located.fullParagraphEn,
        isPartial: located.isPartial,
        suppressAutoEllipsis: isHymnTask,
      });
      applySegSplit(split);
    }
  }

  if (pendingSegments > 0) {
    postBatchHooks.push(finalizeWholeBlockQuotes);
  } else {
    finalizeWholeBlockQuotes();
  }
}

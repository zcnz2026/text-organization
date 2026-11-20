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
  findArticleInCatalog,
  findBibleVerse,
  findHymnMatch,
  findIdiomMatch,
  findRosterMatch,
  locateParagraphInManuscript,
  lookupPhraseForNoteXx,
  replaceNoteXxPlaceholders,
  resolveCitationText,
} from "./text-matcher";

export interface PipelineOptions {
  enableRosterPreFill: boolean;
  gemini?: GeminiPoolClient;
  loadArticleDoc?: (docUrl: string) => Promise<ArticleParagraph[]>;
  onProgress?: (doneTasks: number, totalTasks: number, label: string) => void;
}

export async function splitLordsPrayerFullText(
  fullText: string,
  blockRows: ScriptRow[],
  rule: PunctuationRule,
  gemini?: GeminiPoolClient,
): Promise<string[]> {
  const clean = fullText.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (blockRows.length <= 1) return [clean];

  const lastRow = blockRows[blockRows.length - 1];
  const isLastRowAmen =
    /阿们|阿們/u.test(lastRow.chinese) || /^amen[!！.。]*$/i.test(lastRow.english.trim());

  let bodyText = clean;
  let amenTail = "";
  let firstLineLead = "";

  if (isLastRowAmen) {
    const tailMatch = /(?:^|\s+)([^\s]+(?:[!！.。।។။]+)?)\s*$/u.exec(bodyText);
    if (tailMatch && tailMatch.index > 0) {
      amenTail = tailMatch[1].trim();
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

function buildSplitFullHint(
  prefix: string,
  fullText: string,
  hasInversion?: boolean,
): string {
  const inv = hasInversion ? "（含倒装句，已保持原语序）" : "";
  const cleanFull = fullText.replace(/\s+/g, " ").trim();
  const base = prefix ? `${prefix}${inv}` : `长句/段落拆分${inv}`;
  return cleanFull ? `${base}｜完整原文：${cleanFull}` : base;
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
    await processSingleTask(task, script.rows, catalog, results, options, ensureManuscript, deferredSplits);
  }

  if (deferredSplits.length > 0) {
    options.onProgress?.(tasks.length, tasks.length + 1, `AI 批量语义分句 (${deferredSplits.length} 块)...`);
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
        results[rIdx].targetLanguage = catalog.lordsPrayer[k].target;
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
            results[rIdx].targetLanguage = split.lines[k] ?? "";
            results[rIdx].status = "matched";
            if (k === 0) {
              results[rIdx].hint = buildSplitFullHint(
                split.usedAi ? "AI 已按词序号精准切分主祷文" : "主祷文长段拆分",
                sourceFull,
                split.hasInversion,
              );
            } else {
              results[rIdx].hint = "同上完整句";
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
      if (blockRows.length > 1) {
        results[rIdx].hint = k === 0 ? buildSplitFullHint("主祷文长段拆分", sourceFull) : "同上完整句";
      }
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
      const isMulti = task.rowIndices.length > 1;
      task.rowIndices.forEach((rIdx, k) => {
        results[rIdx].targetLanguage = formatted.verseLines[k];
        if (matched.source) results[rIdx].bibleSource = matched.source;
        results[rIdx].status = matched.truncatedStart ? "warning" : "matched";
        if (k === 0) {
          const baseHint = matched.truncatedStart
            ? "涉及经文句首截取，请核对切分与省略号"
            : split.usedAi
              ? "AI 已按词序号精准分句"
              : isMulti
                ? "长句/段落拆分，请核对断行"
                : "";
          results[rIdx].hint = isMulti
            ? buildSplitFullHint(baseHint, matched.text, split.hasInversion)
            : baseHint;
        } else if (isMulti) {
          results[rIdx].hint = "同上完整句";
        }
      });
      if (task.citationRowIndex !== undefined) {
        results[task.citationRowIndex].targetLanguage = formatted.citationText;
        if (matched.source) results[task.citationRowIndex].bibleSource = matched.source;
        results[task.citationRowIndex].status = "matched";
      }
    };

    if (options.gemini?.hasKeys && verseRows.length > 1) {
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
      const quoted = formatQuotedBlockLines(rawLines, catalog.rule, true);
      task.rowIndices.forEach((rIdx, k) => {
        results[rIdx].targetLanguage = quoted[k];
        const hasTrunc = blockRows[k].remark.includes("涉及截取");
        results[rIdx].status = hasTrunc ? "warning" : "matched";
        if (hasTrunc) results[rIdx].hint = "歌词涉及原文截取，请核对";
      });
      return;
    }
    if (task.sourceHint.includes("卷")) {
      await extractFromArticleManuscript(task, rows, catalog, results, options, ensureManuscript, deferredSplits);
      return;
    }
    for (const idx of task.rowIndices) {
      results[idx].status = "missing";
      results[idx].hint = "诗歌表中未找到该首诗歌";
    }
    return;
  }

  if (task.kind === "god_words_body") {
    await extractFromArticleManuscript(task, rows, catalog, results, options, ensureManuscript, deferredSplits);
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
    if (hymn?.targetTitle) {
      results[firstIdx].targetLanguage = formatStandaloneTitle(hymn.targetTitle, "", "", catalog.rule);
      results[firstIdx].status = "warning";
      results[firstIdx].hint = "已填入目标语种歌名，固定前缀待组合";
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

async function extractFromArticleManuscript(
  task: ExtractionTask,
  rows: ScriptRow[],
  catalog: LanguageCatalog,
  results: ProcessedRowResult[],
  options: PipelineOptions,
  ensureManuscript: (url: string) => Promise<ArticleParagraph[]>,
  deferredSplits: DeferredAiSplit[],
): Promise<void> {
  const blockRows = task.rowIndices.map((idx) => rows[idx]);
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
  const located = locateParagraphInManuscript(paragraphs, blockRows);
  if (!located) {
    for (const idx of task.rowIndices) {
      results[idx].status = "missing";
      results[idx].hint = article.docUrl ? `单篇《${article.zhTitle}》中未定位到对应段落` : `篇目《${article.zhTitle}》缺少单篇链接`;
    }
    return;
  }

  const hasFollowingCitation = Boolean(
    nextRow && /摘自|卷|话|from the word|\(the word/i.test(`${nextRow.chinese} ${nextRow.english}`),
  );

  const applyArticleSplit = (split: SplitResult) => {
    const quoted = formatQuotedBlockLines(split.lines, catalog.rule, true, hasFollowingCitation);
    const hasOmission = blockRows.some((r) => r.remark.includes("有省略") || r.chinese.includes("……"));
    const isMulti = task.rowIndices.length > 1;
    const fullForHint = located.matchedText || located.fullParagraphTarget;

    task.rowIndices.forEach((rIdx, k) => {
      results[rIdx].targetLanguage = quoted[k];
      const rowTrunc = blockRows[k].remark.includes("涉及截取");
      const rowOmit = blockRows[k].remark.includes("有省略") || blockRows[k].chinese.includes("……");
      let rowHint = "";
      if (rowTrunc) {
        results[rIdx].status = "warning";
        rowHint = split.usedAi ? "AI 已按词序号精准截取，请顺便核对首字母" : "涉及句首截取（未启用AI），请核对外文截取位置";
      } else if (rowOmit) {
        results[rIdx].status = "warning";
        rowHint = "此处原文中间有省略，请核对省略号衔接";
      } else if (located.isPartial && !split.usedAi) {
        results[rIdx].status = "warning";
        rowHint = options.gemini?.hasKeys
          ? "AI 分句调用失败（已回退子句估算），请点「缺失日志」下载查看具体报错原因"
          : "局部半句截取（未配置 API 密钥，已按子句估算）";
      } else {
        results[rIdx].status = hasOmission && !split.usedAi ? "warning" : "matched";
        if (split.usedAi && k === 0) rowHint = "AI 已按词序号精准分句";
      }

      if (isMulti) {
        if (k === 0) {
          results[rIdx].hint = buildSplitFullHint(rowHint || "长句/段落拆分，请核对断行", fullForHint, split.hasInversion);
        } else {
          results[rIdx].hint = rowHint ? `${rowHint}｜同上完整句` : "同上完整句";
        }
      } else {
        results[rIdx].hint = rowHint;
      }
    });
  };

  const needAi = blockRows.length > 1 || located.isPartial;
  if (options.gemini?.hasKeys && needAi) {
    deferredSplits.push({
      req: {
        id: task.id,
        fallbackText: located.matchedText,
        aiSourceText: located.contextWindowTarget,
        referenceEn: located.fullParagraphEn,
        sourceRows: blockRows,
      },
      apply: applyArticleSplit,
    });
    return;
  }

  const split = await splitTargetIntoScriptLines(located.matchedText, blockRows, catalog.rule, undefined, {
    fullParagraphTarget: located.contextWindowTarget,
    referenceEn: located.fullParagraphEn,
    isPartial: located.isPartial,
  });
  applyArticleSplit(split);
}

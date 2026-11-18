import type { GeminiPoolClient } from "../ai/gemini-client";
import type { ArticleParagraph, LanguageCatalog } from "../catalog/catalog-types";
import type {
  ExtractionTask,
  LanguageRunOutput,
  ProcessedRowResult,
  ScriptRow,
  ScriptSheetDocument,
} from "../types/domain";
import { classifyScriptTasks } from "./classifier";
import { splitTargetIntoScriptLines } from "./line-splitter";
import {
  formatBibleBlockAndCitation,
  formatQuotedBlockLines,
  formatStandaloneTitle,
  stripOuterDoubleQuotes,
} from "./punctuation";
import {
  findArticleInCatalog,
  findBibleVerse,
  findHymnMatch,
  findIdiomMatch,
  findRosterMatch,
  locateParagraphInManuscript,
  lookupPhraseForNoteXx,
  normMatchKey,
  replaceNoteXxPlaceholders,
  resolveCitationText,
} from "./text-matcher";

export interface PipelineOptions {
  enableRosterPreFill: boolean;
  gemini?: GeminiPoolClient;
  loadArticleDoc?: (docUrl: string) => Promise<ArticleParagraph[]>;
  onProgress?: (doneTasks: number, totalTasks: number, label: string) => void;
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
    options.onProgress?.(tIdx + 1, tasks.length, task.sourceHint);
    await processSingleTask(task, script.rows, catalog, results, options, ensureManuscript);
  }

  let matchedCount = 0;
  let warningCount = 0;
  let missingCount = 0;
  for (const r of results) {
    if (r.status === "matched") matchedCount += 1;
    else if (r.status === "warning") warningCount += 1;
    else if (r.status === "missing") missingCount += 1;
  }

  return {
    langName: catalog.langName,
    rows: results,
    matchedCount,
    warningCount,
    missingCount,
  };
}

async function processSingleTask(
  task: ExtractionTask,
  rows: ScriptRow[],
  catalog: LanguageCatalog,
  results: ProcessedRowResult[],
  options: PipelineOptions,
  ensureManuscript: (url: string) => Promise<ArticleParagraph[]>,
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
    const cite = resolveCitationText(
      catalog,
      firstRow,
      task.citationVariant ?? "subtitle_band",
    );
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
    if (catalog.lordsPrayer.length === 0) {
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
    const joined = catalog.lordsPrayer.map((p) => p.target).join(" ");
    const split = await splitTargetIntoScriptLines(
      joined,
      blockRows,
      catalog.rule,
      options.gemini,
    );
    task.rowIndices.forEach((rIdx, k) => {
      results[rIdx].targetLanguage = split.lines[k];
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

    const split = await splitTargetIntoScriptLines(
      matched.text,
      verseRows,
      catalog.rule,
      options.gemini,
    );
    if (matched.truncatedStart && split.lines.length > 0 && !split.lines[0].startsWith(catalog.rule.ellipsis)) {
      split.lines[0] = `${catalog.rule.ellipsis} ${split.lines[0]}`;
    }

    const formatted = formatBibleBlockAndCitation(
      split.lines,
      matched.targetCitationRef,
      catalog.rule,
    );

    task.rowIndices.forEach((rIdx, k) => {
      results[rIdx].targetLanguage = formatted.verseLines[k];
      results[rIdx].status = matched.truncatedStart ? "warning" : "matched";
      if (matched.truncatedStart && k === 0) {
        results[rIdx].hint = "涉及经文句首截取，请核对切分与省略号";
      }
    });

    if (task.citationRowIndex !== undefined) {
      results[task.citationRowIndex].targetLanguage = formatted.citationText;
      results[task.citationRowIndex].status = "matched";
    }
    return;
  }

  if (task.kind === "hymn_lyrics") {
    const blockRows = task.rowIndices.map((idx) => rows[idx]);
    const hymn = findHymnMatch(catalog.hymns, task.sourceHint);

    if (hymn && hymn.lines.length > 0) {
      let rawLines: string[];
      if (hymn.lines.length === blockRows.length) {
        rawLines = hymn.lines.map((l) => stripOuterDoubleQuotes(l.target));
      } else {
        const matchedByLine = blockRows.map((br) => {
          const kZh = normMatchKey(br.chinese);
          const kEn = normMatchKey(br.english);
          return hymn.lines.find(
            (hl) =>
              (kZh && normMatchKey(hl.chinese) === kZh) ||
              (kEn && normMatchKey(hl.english) === kEn),
          );
        });
        if (matchedByLine.every(Boolean)) {
          rawLines = matchedByLine.map((m) => stripOuterDoubleQuotes(m!.target));
        } else {
          const split = await splitTargetIntoScriptLines(
            hymn.lines.map((l) => l.target).join(" "),
            blockRows,
            catalog.rule,
            options.gemini,
          );
          rawLines = split.lines;
        }
      }
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
      await extractFromArticleManuscript(
        task,
        rows,
        catalog,
        results,
        options,
        ensureManuscript,
      );
      return;
    }

    for (const idx of task.rowIndices) {
      results[idx].status = "missing";
      results[idx].hint = "诗歌表中未找到该首诗歌";
    }
    return;
  }

  if (task.kind === "god_words_body") {
    await extractFromArticleManuscript(
      task,
      rows,
      catalog,
      results,
      options,
      ensureManuscript,
    );
    return;
  }

  if (task.kind === "standalone_title") {
    const noteRes = replaceNoteXxPlaceholders(
      firstRow.note,
      catalog,
      options.enableRosterPreFill,
    );
    results[firstIdx].note = noteRes.updatedNote;

    let rawTitle = "";
    const noteLines = firstRow.note.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (noteLines.length >= 2) {
      const found = lookupPhraseForNoteXx(
        catalog,
        noteLines[0],
        options.enableRosterPreFill,
      );
      if (found) rawTitle = found.value;
    }
    if (!rawTitle) {
      const hymn = findHymnMatch(catalog.hymns, firstRow.chinese);
      if (hymn?.targetTitle) rawTitle = hymn.targetTitle;
    }
    if (!rawTitle) {
      const art = findArticleInCatalog(
        catalog.articles,
        firstRow.chinese,
        firstRow.chinese,
        firstRow.english,
      );
      if (art?.targetTitle) rawTitle = art.targetTitle;
    }

    if (rawTitle) {
      results[firstIdx].targetLanguage = formatStandaloneTitle(
        rawTitle,
        firstRow.english,
        firstRow.chinese,
        catalog.rule,
      );
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
      results[firstIdx].targetLanguage = formatStandaloneTitle(
        hymn.targetTitle,
        "",
        "",
        catalog.rule,
      );
      results[firstIdx].status = "warning";
      results[firstIdx].hint = "已填入目标语种歌名，固定前缀待组合";
    } else {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = "诗歌表中未找到对应歌名";
    }
    return;
  }

  if (task.kind === "inline_note_xx") {
    const noteRes = replaceNoteXxPlaceholders(
      firstRow.note,
      catalog,
      options.enableRosterPreFill,
    );
    results[firstIdx].note = noteRes.updatedNote;
    if (noteRes.missingCount > 0) {
      results[firstIdx].status = "missing";
      results[firstIdx].hint = `Note 中有 ${noteRes.missingCount} 处 XX 未匹配到外文名称`;
    } else if (noteRes.replacedCount > 0) {
      results[firstIdx].status = noteRes.usedRoster ? "warning" : "matched";
      results[firstIdx].hint = noteRes.usedRoster
        ? "Note 名称摘自人名/教会名库，请顺便核对"
        : "";
    }
    return;
  }

  if (task.kind === "roster_match" && options.enableRosterPreFill) {
    const matched = findRosterMatch(
      catalog.rosterEntries,
      firstRow.chinese,
      firstRow.english,
      false,
    );
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
): Promise<void> {
  const blockRows = task.rowIndices.map((idx) => rows[idx]);
  const nextRow = rows[task.rowIndices[task.rowIndices.length - 1] + 1];
  const article = findArticleInCatalog(
    catalog.articles,
    task.sourceHint,
    nextRow?.chinese ?? "",
    nextRow?.english ?? "",
  );

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
      results[idx].hint = article.docUrl
        ? `单篇《${article.zhTitle}》中未定位到对应段落`
        : `篇目《${article.zhTitle}》缺少单篇链接`;
    }
    return;
  }

  const split = await splitTargetIntoScriptLines(
    located.matchedText,
    blockRows,
    catalog.rule,
    options.gemini,
  );
  const quoted = formatQuotedBlockLines(split.lines, catalog.rule, true);
  const hasOmission = blockRows.some(
    (r) => r.remark.includes("有省略") || r.chinese.includes("……"),
  );

  task.rowIndices.forEach((rIdx, k) => {
    results[rIdx].targetLanguage = quoted[k];
    const rowTrunc = blockRows[k].remark.includes("涉及截取");
    const rowOmit =
      blockRows[k].remark.includes("有省略") || blockRows[k].chinese.includes("……");
    if (rowTrunc) {
      results[rIdx].status = "warning";
      results[rIdx].hint = "涉及句首截取，请核对外文截取位置与首字母大小写";
    } else if (rowOmit) {
      results[rIdx].status = "warning";
      results[rIdx].hint = "此处原文中间有省略，请核对省略号衔接";
    } else {
      results[rIdx].status = hasOmission && !split.usedAi ? "warning" : "matched";
    }
  });
}

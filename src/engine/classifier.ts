import type {
  CitationVariant,
  ExtractionTask,
  ScriptRow,
} from "../types/domain";

function detectCitationVariant(row: ScriptRow): CitationVariant {
  const en = row.english.trim();
  const zh = row.chinese.trim();
  if (en.startsWith("(") || zh.startsWith("（") || zh.startsWith("(")) {
    return "video_effect";
  }
  return "subtitle_band";
}

function isSubtitleRow(row: ScriptRow): boolean {
  const ch = row.character.trim().toLowerCase();
  const ln = row.line.trim().toLowerCase();
  return ch === "subtitle" || ln === "subtitle";
}

const BIBLE_BOOK_OR_CAT_RE =
  /圣经|新约|旧约|经文|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|撒母耳记|列王纪|历代志|以斯拉记|尼希米记|以斯帖记|约伯记|诗篇|箴言|传道书|雅歌|以赛亚书|耶利米|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|哥林多|加拉太书|以弗所书|腓立比书|歌罗西书|帖撒罗尼迦|提摩太|提多书|腓利门书|希伯来书|雅各书|彼得[前后]书|约翰[一二三]书|犹大书|启示录/u;

function isBibleCategory(filt: string): boolean {
  const f = filt.trim();
  if (!f || f.includes("神话") || f.includes("诗歌")) return false;
  return BIBLE_BOOK_OR_CAT_RE.test(f);
}

function extractInlineBibleRef(row: ScriptRow): string {
  const en = row.english.trim();
  const enM = /\(([1-3]?\s*[A-Za-z][A-Za-z\s.]*?\d+[:.]\d+[^()]*)\)[.,;"”']*$/i.exec(en);
  if (enM) return enM[1].trim();
  const zh = row.chinese.trim();
  const zhM = /[（(]([^）()]+\d+[:：]\d+[^）()]*)[）)][，,。.；”"]*$/u.exec(zh);
  if (zhM) return zhM[1].trim();
  return "";
}

function isBibleCitationRow(row: ScriptRow): boolean {
  if (isSubtitleRow(row)) return true;
  const zh = row.chinese.trim();
  const en = row.english.trim();
  const zhCite = /^[（(][^）)]+\d+[:：]\d+[^）)]*[）)][，,。.]?$/u.test(zh);
  const enCite = /^\([A-Za-z0-9\s.]+\d+[:.]\d+[^)]*\)[.,]?$/i.test(en);
  return zhCite || enCite;
}

function isIdiomCategory(filt: string): boolean {
  const f = filt.trim();
  return f.includes("撒但毒素") || f.includes("俗语");
}

function isLordsPrayerCategory(filt: string): boolean {
  return filt.includes("主祷文");
}

function isGodWordsPrefix(row: ScriptRow): boolean {
  const zh = row.chinese.trim().replace(/[：:]$/u, "");
  const en = row.english.trim().replace(/[:]$/u, "").toLowerCase();
  return zh === "全能神说" || en === "almighty god says";
}

function isComboHymnRow(row: ScriptRow): boolean {
  const zh = row.chinese.trim();
  const filt = row.filterCategory.trim();
  const rem = row.remark.trim();
  if (rem.includes("自己组合")) return true;
  if (
    row.targetLanguage.trim() === "No need to translate!" &&
    /^合唱.*诗歌《.+》$/u.test(zh) &&
    !filt.includes("往期")
  ) {
    return true;
  }
  return false;
}

function isStandaloneTitleRow(row: ScriptRow): boolean {
  const filt = row.filterCategory.trim();
  if (["神话标题", "诗歌标题", "神话诗歌标题"].includes(filt)) return true;
  if (filt === "含诗歌标题" && row.note.includes("XX") && !isComboHymnRow(row)) {
    return true;
  }
  return false;
}

function isHymnLyricsRow(row: ScriptRow): boolean {
  if (isSubtitleRow(row) || isComboHymnRow(row) || isStandaloneTitleRow(row)) {
    return false;
  }
  const ch = row.character.trim().toLowerCase();
  const filt = row.filterCategory.trim();
  return ch === "hymn" || (filt.includes("诗歌") && row.needExtract.trim() === "需要摘");
}

function isGodWordsArticleRow(row: ScriptRow): boolean {
  if (isSubtitleRow(row) || isGodWordsPrefix(row) || isHymnLyricsRow(row)) {
    return false;
  }
  const filt = row.filterCategory.trim();
  return (
    row.needExtract.trim() === "需要摘" &&
    (filt.startsWith("卷") || filt.includes("神的显现与作工") || filt.includes("话在肉身显现"))
  );
}

function closesOuterQuote(row: ScriptRow): boolean {
  const zh = row.chinese.trim();
  const en = row.english.trim();
  return /[”"»]$/.test(zh) || /["”»][.,!?]?$/.test(en);
}

function opensOuterQuote(row: ScriptRow): boolean {
  const zh = row.chinese.trim();
  const en = row.english.trim();
  return /^[“"«]/.test(zh) || /^["“«]/.test(en);
}

export function classifyScriptTasks(rows: ScriptRow[]): ExtractionTask[] {
  const tasks: ExtractionTask[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}_${seq++}`;

  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const filt = row.filterCategory.trim();
    const tl = row.targetLanguage.trim();

    if (isBibleCategory(filt)) {
      const verseIndices: number[] = [];
      let citationRowIndex: number | undefined;
      while (i < rows.length && isBibleCategory(rows[i].filterCategory.trim())) {
        if (isBibleCitationRow(rows[i])) {
          citationRowIndex = rows[i].rowIndex;
          i += 1;
          break;
        }
        verseIndices.push(rows[i].rowIndex);
        i += 1;
      }
      if (verseIndices.length > 0) {
        const inlineRef =
          extractInlineBibleRef(rows[verseIndices[verseIndices.length - 1]]) ||
          extractInlineBibleRef(rows[verseIndices[0]]);
        const refHint =
          citationRowIndex !== undefined
            ? rows[citationRowIndex].english || rows[citationRowIndex].chinese
            : inlineRef || filt;
        tasks.push({
          id: nextId("bible"),
          kind: "bible_verses",
          rowIndices: verseIndices,
          sourceHint: refHint.trim(),
          citationRowIndex,
          citationVariant: "video_effect",
        });
      }
      continue;
    }

    if (isLordsPrayerCategory(filt)) {
      const indices: number[] = [];
      while (
        i < rows.length &&
        isLordsPrayerCategory(rows[i].filterCategory.trim())
      ) {
        indices.push(rows[i].rowIndex);
        i += 1;
      }
      tasks.push({
        id: nextId("prayer"),
        kind: "lords_prayer",
        rowIndices: indices,
        sourceHint: filt,
      });
      continue;
    }

    if (isHymnLyricsRow(row)) {
      const indices: number[] = [];
      const groupFilt = filt;
      while (
        i < rows.length &&
        isHymnLyricsRow(rows[i]) &&
        rows[i].filterCategory.trim() === groupFilt
      ) {
        indices.push(rows[i].rowIndex);
        i += 1;
      }
      tasks.push({
        id: nextId("hymn"),
        kind: "hymn_lyrics",
        rowIndices: indices,
        sourceHint: groupFilt,
      });
      continue;
    }

    if (isGodWordsPrefix(row)) {
      tasks.push({
        id: nextId("prefix"),
        kind: "god_words_prefix",
        rowIndices: [row.rowIndex],
        sourceHint: "全能神说",
      });
      i += 1;
      continue;
    }

    if (isGodWordsArticleRow(row)) {
      const indices: number[] = [];
      const groupFilt = filt;
      while (
        i < rows.length &&
        isGodWordsArticleRow(rows[i]) &&
        rows[i].filterCategory.trim() === groupFilt
      ) {
        if (
          indices.length > 0 &&
          closesOuterQuote(rows[indices[indices.length - 1]]) &&
          opensOuterQuote(rows[i])
        ) {
          break;
        }
        indices.push(rows[i].rowIndex);
        i += 1;
      }
      tasks.push({
        id: nextId("god_words"),
        kind: "god_words_body",
        rowIndices: indices,
        sourceHint: groupFilt,
      });
      continue;
    }

    if (isSubtitleRow(row) && (row.needExtract.trim() === "需要摘" || tl === "No need to translate!")) {
      tasks.push({
        id: nextId("cite"),
        kind: "citation_subtitle",
        rowIndices: [row.rowIndex],
        sourceHint: filt || row.chinese.trim(),
        citationVariant: detectCitationVariant(row),
      });
      i += 1;
      continue;
    }

    if (isIdiomCategory(filt)) {
      tasks.push({
        id: nextId("idiom"),
        kind: "idiom",
        rowIndices: [row.rowIndex],
        sourceHint: row.chinese.trim(),
      });
      i += 1;
      continue;
    }

    if (isStandaloneTitleRow(row)) {
      tasks.push({
        id: nextId("title"),
        kind: "standalone_title",
        rowIndices: [row.rowIndex],
        sourceHint: filt,
      });
      i += 1;
      continue;
    }

    if (isComboHymnRow(row)) {
      tasks.push({
        id: nextId("combo"),
        kind: "combo_title",
        rowIndices: [row.rowIndex],
        sourceHint: row.chinese.trim(),
      });
      i += 1;
      continue;
    }

    if (tl === "" && row.note.includes("XX")) {
      tasks.push({
        id: nextId("note_xx"),
        kind: "inline_note_xx",
        rowIndices: [row.rowIndex],
        sourceHint: row.sendRemark.trim() || filt || "Note XX",
      });
      i += 1;
      continue;
    }

    if (
      tl === "No need to translate!" &&
      ["含固定表达", "往期重复国家名", "往期重复人名"].includes(filt)
    ) {
      tasks.push({
        id: nextId("roster"),
        kind: "roster_match",
        rowIndices: [row.rowIndex],
        sourceHint: filt,
      });
      i += 1;
      continue;
    }

    i += 1;
  }

  return tasks;
}

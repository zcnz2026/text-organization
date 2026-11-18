import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyScriptTasks } from "../src/engine/classifier";
import { parseCsvToGrid, parseGridToScriptDocument } from "../src/engine/csv-sheet";

const SAMPLE_CSV = path.resolve(
  __dirname,
  "../../剧本/对应句子/演示稿 - 39期教会生活.csv",
);

describe("classifier on synthetic multi-category script", () => {
  it("classifies prefixes, scripture, idioms, standalone titles, and Note XX rows", () => {
    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ["3", "", "", "Title", "教会经历", "", "", "Church Name\nXX", "", "提前贴上教会名", "", ""],
      ["53", "", "", "Host", "《神的话语都是真理》。", "\"All God's Words Are the Truth.\"", "No need to translate!", "All God's Words Are the Truth\nXX", "", "提前贴上", "含诗歌标题", "需要摘"],
      ["255", "", "", "Speaker", "全能神说：", "Almighty God says:", "No need to translate!", "", "", "", "卷一　神的显现与作工・第一篇", "需要摘"],
      ["256", "", "", "Speaker", "“神的话语是真理。”", "\"God's words are the truth.\"", "No need to translate!", "", "", "", "卷一　神的显现与作工・第一篇", "需要摘"],
      ["257", "", "", "Subtitle", "《话・卷一　神的显现与作工・第一篇》", "from The Word, Vol. 1", "No need to translate!", "", "", "", "卷一　神的显现与作工・第一篇", "需要摘"],
      ["Caption", "", "", "", "人不为己，天诛地灭", "Every man for himself", "No need to translate!", "", "", "", "撒但毒素", ""],
      ["Voice", "", "", "", "“起初神创造天地。”", "\"In the beginning...\"", "No need to translate!", "", "", "", "新约", ""],
      ["Subtitle", "", "", "", "（创世记1:1）", "(Genesis 1:1).", "No need to translate!", "", "", "", "新约", ""],
    ];
    const doc = parseGridToScriptDocument(grid, "Synthetic");
    const tasks = classifyScriptTasks(doc.rows);
    expect(tasks.map((t) => t.kind)).toEqual([
      "inline_note_xx",
      "standalone_title",
      "god_words_prefix",
      "god_words_body",
      "citation_subtitle",
      "idiom",
      "bible_verses",
    ]);
  });
});

describe.skipIf(!fs.existsSync(SAMPLE_CSV))("classifier on real 39期教会生活 script", () => {
  it("parses header and classifies all 8 extraction categories including unflagged idioms & scripture", () => {
    const raw = fs.readFileSync(SAMPLE_CSV, "utf-8");
    const grid = parseCsvToGrid(raw);
    const doc = parseGridToScriptDocument(grid, "39期教会生活");

    expect(doc.headerRows.length).toBe(2);
    expect(doc.rows.length).toBe(698);

    const tasks = classifyScriptTasks(doc.rows);
    const byKind = (kind: string) => tasks.filter((t) => t.kind === kind);

    expect(byKind("god_words_prefix").length).toBe(3);
    expect(byKind("god_words_body").length).toBe(8);
    expect(byKind("hymn_lyrics").length).toBe(3);
    expect(byKind("lords_prayer").length).toBe(1);
    expect(byKind("idiom").length).toBe(4);
    expect(byKind("bible_verses").length).toBe(2);
    expect(byKind("standalone_title").length).toBe(4);
    expect(byKind("combo_title").length).toBe(6);
    expect(byKind("inline_note_xx").length).toBe(4);
    expect(byKind("roster_match").length).toBe(5);
    expect(byKind("citation_subtitle").length).toBe(11);
  });
});

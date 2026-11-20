import { describe, expect, it } from "vitest";
import { classifyScriptTasks } from "../src/engine/classifier";
import { parseGridToScriptDocument } from "../src/engine/csv-sheet";

describe("classifier on synthetic multi-category script", () => {
  it("classifies prefixes, scripture, idioms, standalone titles, and Note XX rows", () => {
    const grid = [
      ["Line", "In Time", "Out Time", "Character", "Chinese", "English底", "Target Language", "Note", "备注", "送翻备注", "筛选列", "需要摘"],
      ["3", "", "", "Title", "专题纪实标题", "", "", "Branch Name\nXX", "", "提前贴上名称", "", ""],
      ["53", "", "", "Host", "《晨光之歌》。", '"Song of Morning Light."', "No need to translate!", "Song of Morning Light\nXX", "", "提前贴上", "含诗歌标题", "需要摘"],
      ["255", "", "", "Speaker", "全能神说：", "Almighty God says:", "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["256", "", "", "Speaker", "“春风拂过山川大地。”", '"Spring breeze sweeps across the land."', "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["257", "", "", "Subtitle", "《卷一・第一篇》", "from Vol. 1, Article 1", "No need to translate!", "", "", "", "卷一・第一篇", "需要摘"],
      ["Caption", "", "", "", "千里之行，始于足下", "A journey of a thousand miles begins with a single step", "No need to translate!", "", "", "", "俗语", ""],
      ["Voice", "", "", "", "“光照射在黑暗里。”", '"The light shines in the darkness."', "No need to translate!", "", "", "", "新约", ""],
      ["Subtitle", "", "", "", "（约翰福音1:5）", "(John 1:5).", "No need to translate!", "", "", "", "新约", ""],
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

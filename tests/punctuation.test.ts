import { describe, expect, it } from "vitest";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import {
  formatBibleBlockAndCitation,
  formatQuotedBlockLines,
  formatStandaloneTitle,
} from "../src/engine/punctuation";

describe("punctuation engine across languages", () => {
  it("formats Ukrainian block with «» outer quotes, straight single quotes, straight apostrophe, and period outside", () => {
    const uk = resolvePunctuationRule("乌克兰语");
    const out = formatQuotedBlockLines(
      [
        "«Коли людина працює на землі,",
        "так зване ‘терпіння’ приносить добрий плід.»",
      ],
      uk,
    );
    expect(out[0]).toBe("«Коли людина працює на землі,");
    expect(out[1]).toBe('так зване "терпіння" приносить добрий плід».');
  });

  it("places period inside quotes for Indonesian full sentences, but outside for standalone titles", () => {
    const idRule = resolvePunctuationRule("印尼语");
    const block = formatQuotedBlockLines(
      ["“Kita harus belajar bersabar,", "dan bekerja dengan tekun”. "],
      idRule,
    );
    expect(block[0]).toBe('"Kita harus belajar bersabar,');
    expect(block[1]).toBe('dan bekerja dengan tekun."');

    const title = formatStandaloneTitle(
      "Lagu Cahaya Pagi",
      '"Song of Morning Light."',
      "《晨光之歌》。",
      idRule,
    );
    expect(title).toBe('"Lagu Cahaya Pagi".');
  });

  it("formats Ukrainian vs Croatian citation ending punctuation accurately", () => {
    const uk = resolvePunctuationRule("乌克兰语");
    const ukBible = formatBibleBlockAndCitation(
      [
        "“На початку було світло,",
        "і світло осяяло всю землю.”",
      ],
      "(Книга 1:1–2)",
      uk,
    );
    expect(ukBible.verseLines[0]).toBe("«На початку було світло,");
    expect(ukBible.verseLines[1]).toBe("і світло осяяло всю землю»");
    expect(ukBible.citationText).toBe("(Книга 1:1–2).");

    const hr = resolvePunctuationRule("克罗");
    const hrBible = formatBibleBlockAndCitation(
      [
        '"U početku bijaše svjetlo,',
        'i svjetlo obasja svu zemlju"',
      ],
      "(Knj 1,1).",
      hr,
    );
    expect(hrBible.verseLines[0]).toBe("„U početku bijaše svjetlo,");
    expect(hrBible.verseLines[1]).toBe("i svjetlo obasja svu zemlju.“");
    expect(hrBible.citationText).toBe("(Knj 1,1)");
  });

  it("marks Korean as singleCitationRowOnly", () => {
    const ko = resolvePunctuationRule("韩语");
    expect(ko.singleCitationRowOnly).toBe(true);
  });
});

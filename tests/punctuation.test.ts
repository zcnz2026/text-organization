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
        "«Коли стикаєшся з проблемами в обов’язку,",
        "так зване ‘очікування’ веде до істини.»",
      ],
      uk,
    );
    expect(out[0]).toBe("«Коли стикаєшся з проблемами в обов'язку,");
    expect(out[1]).toBe('так зване "очікування" веде до істини».');
  });

  it("places period inside quotes for Indonesian full sentences, but outside for standalone titles", () => {
    const idRule = resolvePunctuationRule("印尼语");
    const block = formatQuotedBlockLines(
      ["“Manusia harus belajar menunggu,", "dan belajar taat”. "],
      idRule,
    );
    expect(block[0]).toBe('"Manusia harus belajar menunggu,');
    expect(block[1]).toBe('dan belajar taat."');

    const title = formatStandaloneTitle(
      "Semua Firman Tuhan Adalah Kebenaran",
      '"All God\'s Words Are the Truth."',
      "《神的话语都是真理》。",
      idRule,
    );
    expect(title).toBe('"Semua Firman Tuhan Adalah Kebenaran".');
  });

  it("formats Ukrainian vs Croatian Bible verse ending and citation punctuation accurately", () => {
    const uk = resolvePunctuationRule("乌克兰语");
    const ukBible = formatBibleBlockAndCitation(
      [
        "“Бо як блискавка блискає з одного краю піднебесної,",
        "але перше належить Йому багато постраждати.”",
      ],
      "(Буття 17:24–25)",
      uk,
    );
    expect(ukBible.verseLines[0]).toBe(
      "«Бо як блискавка блискає з одного краю піднебесної,",
    );
    expect(ukBible.verseLines[1]).toBe(
      "але перше належить Йому багато постраждати»",
    );
    expect(ukBible.citationText).toBe("(Буття 17:24–25).");

    const hr = resolvePunctuationRule("克罗");
    const hrBible = formatBibleBlockAndCitation(
      [
        '"Jer kao što munja izlazi od istoka,',
        'tako će biti i s dolaskom Sina Čovječjega"',
      ],
      "(Mt 24,27).",
      hr,
    );
    expect(hrBible.verseLines[0]).toBe("„Jer kao što munja izlazi od istoka,");
    expect(hrBible.verseLines[1]).toBe(
      "tako će biti i s dolaskom Sina Čovječjega.“",
    );
    expect(hrBible.citationText).toBe("(Mt 24,27)");
  });

  it("marks Korean as singleCitationRowOnly", () => {
    const ko = resolvePunctuationRule("韩语");
    expect(ko.singleCitationRowOnly).toBe(true);
  });
});

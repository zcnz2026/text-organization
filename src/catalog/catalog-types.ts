import type { PunctuationRule } from "../types/domain";

export interface HyperlinkedCell {
  text: string;
  url?: string;
}

export type RichSheetGrid = HyperlinkedCell[][];

export interface CitationPair {
  keyZh: string;
  keyEn: string;
  subtitleBand: string;
  videoEffect: string;
}

export interface ArticleCatalogEntry {
  zhTitle: string;
  enTitle: string;
  targetTitle: string;
  docUrl: string;
  zhSubtitleCite: string;
  zhBracketCite: string;
  targetCite: string;
  targetBracketCite?: string;
}

export interface ArticleParagraph {
  chinese: string;
  english: string;
  target: string;
}

export interface BibleEntry {
  chapterRef: string;
  chinese: string;
  english: string;
  targetText: string;
}

export interface IdiomEntry {
  zhVariants: string[];
  enVariants: string[];
  targetText: string;
}

export interface HymnEntry {
  zhTitle: string;
  enTitle: string;
  targetTitle: string;
  lines: ArticleParagraph[];
  targetCitation?: string;
}

export interface RosterEntry {
  chinese: string;
  english: string;
  episode: string;
  targetText: string;
}

export interface LanguageCatalog {
  langName: string;
  rule: PunctuationRule;
  godSaysText: string;
  commonFixedTerms: Map<string, string>;
  citations: CitationPair[];
  articles: ArticleCatalogEntry[];
  articleDocsCache: Map<string, ArticleParagraph[]>;
  bibleEntries: BibleEntry[];
  idioms: IdiomEntry[];
  hymns: HymnEntry[];
  lordsPrayer: ArticleParagraph[];
  lordsPrayerFullText?: string;
  rosterEntries: RosterEntry[];
}

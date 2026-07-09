import { normalizeText } from "./text-utils";

export type NarrationSegmentKind = "speech" | "silence";
export type SilenceReason = "sentence" | "paragraph" | "chapter";

export interface NarrationPlanOptions {
  locale?: string;
  minSpeechChars?: number;
  maxSpeechChars?: number;
  sentenceSilenceSeconds?: number;
  paragraphPauseMs?: number;
  chapterPauseMs?: number;
}

export interface SpeechNarrationSegment {
  id: string;
  kind: "speech";
  speechIndex: number;
  text: string;
  textLength: number;
  paragraphIndex: number;
}

export interface SilenceNarrationSegment {
  id: string;
  kind: "silence";
  silenceIndex: number;
  durationMs: number;
  reason: SilenceReason;
  paragraphIndex: number | null;
}

export type NarrationSegment = SpeechNarrationSegment | SilenceNarrationSegment;

export interface ChapterPlan {
  index: number;
  title: string;
  segments: NarrationSegment[];
  speechSegmentCount: number;
  totalSpeechChars: number;
  sentenceSilenceSeconds: number;
}

export interface NarrationPlan {
  chapters: ChapterPlan[];
  totalSpeechChars: number;
  options: Required<NarrationPlanOptions>;
}

export interface ChapterPlanInput {
  index: number;
  title: string;
  text: string;
}

export const DEFAULT_NARRATION_OPTIONS: Required<NarrationPlanOptions> = {
  locale: "es",
  minSpeechChars: 700,
  maxSpeechChars: 1800,
  sentenceSilenceSeconds: 0.25,
  paragraphPauseMs: 650,
  chapterPauseMs: 1200
};

type SegmenterResult = Iterable<{ segment: string }>;
type SegmenterFactory = new (
  locale?: string,
  options?: { granularity?: "grapheme" | "word" | "sentence" }
) => { segment(input: string): SegmenterResult };
type IntlWithSegmenter = typeof Intl & { Segmenter?: SegmenterFactory };

const ABBREVIATION_PATTERN =
  /\b(Sr|Sra|Srta|Dr|Dra|Prof|Profa|Lic|Ing|Ud|Uds|etc|p\.\s*ej|e\.g|i\.e)\.$/i;

function resolveOptions(options: NarrationPlanOptions = {}): Required<NarrationPlanOptions> {
  return {
    locale: options.locale ?? DEFAULT_NARRATION_OPTIONS.locale,
    minSpeechChars: options.minSpeechChars ?? DEFAULT_NARRATION_OPTIONS.minSpeechChars,
    maxSpeechChars: options.maxSpeechChars ?? DEFAULT_NARRATION_OPTIONS.maxSpeechChars,
    sentenceSilenceSeconds: options.sentenceSilenceSeconds ?? DEFAULT_NARRATION_OPTIONS.sentenceSilenceSeconds,
    paragraphPauseMs: options.paragraphPauseMs ?? DEFAULT_NARRATION_OPTIONS.paragraphPauseMs,
    chapterPauseMs: options.chapterPauseMs ?? DEFAULT_NARRATION_OPTIONS.chapterPauseMs
  };
}

export function splitParagraphs(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\n{2,}/g)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

function segmentWithIntl(text: string, locale: string): string[] | null {
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter;
  if (typeof Segmenter !== "function") {
    return null;
  }

  const segmenter = new Segmenter(locale, { granularity: "sentence" });
  const sentences = Array.from(segmenter.segment(text))
    .map((part) => part.segment.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences : null;
}

function segmentWithRegex(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑÜ0-9"“'¿¡])/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function shouldMergeWithNext(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (ABBREVIATION_PATTERN.test(trimmed)) {
    return true;
  }
  return /\b[A-ZÁÉÍÓÚÑ]\.$/.test(trimmed);
}

function mergeAbbreviationSplits(sentences: string[]): string[] {
  const merged: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }

    current = current ? `${current} ${trimmed}` : trimmed;
    if (shouldMergeWithNext(current)) {
      continue;
    }

    merged.push(current);
    current = "";
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

export function splitSentences(text: string, locale = DEFAULT_NARRATION_OPTIONS.locale): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return [];
  }

  const segmented = segmentWithIntl(trimmed, locale) ?? segmentWithRegex(trimmed);
  return mergeAbbreviationSplits(segmented);
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) {
    return [sentence];
  }

  const words = sentence.split(/\s+/g).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (current.length + word.length + 1 <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }

    chunks.push(current);
    current = word;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [sentence.slice(0, maxChars)];
}

function packSentences(sentences: string[], options: Required<NarrationPlanOptions>): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences.flatMap((item) => splitLongSentence(item, options.maxSpeechChars))) {
    if (!current) {
      current = sentence;
      continue;
    }

    if (current.length + sentence.length + 1 <= options.maxSpeechChars) {
      current = `${current} ${sentence}`;
      continue;
    }

    if (current.length < options.minSpeechChars && sentence.length < options.maxSpeechChars) {
      current = `${current} ${sentence}`;
      continue;
    }

    chunks.push(current);
    current = sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function buildChapterPlan(input: ChapterPlanInput, options: NarrationPlanOptions = {}): ChapterPlan {
  const resolved = resolveOptions(options);
  const paragraphs = splitParagraphs(input.text);
  const segments: NarrationSegment[] = [];
  let speechIndex = 0;
  let silenceIndex = 0;
  let totalSpeechChars = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const speechChunks = packSentences(splitSentences(paragraph, resolved.locale), resolved);

    speechChunks.forEach((chunk, chunkIndex) => {
      totalSpeechChars += chunk.length;
      segments.push({
        id: `chapter-${input.index}-speech-${speechIndex}`,
        kind: "speech",
        speechIndex,
        text: chunk,
        textLength: chunk.length,
        paragraphIndex
      });
      speechIndex += 1;

      if (chunkIndex < speechChunks.length - 1) {
        segments.push({
          id: `chapter-${input.index}-silence-${silenceIndex}`,
          kind: "silence",
          silenceIndex,
          durationMs: Math.round(resolved.sentenceSilenceSeconds * 1000),
          reason: "sentence",
          paragraphIndex
        });
        silenceIndex += 1;
      }
    });

    if (speechChunks.length > 0 && paragraphIndex < paragraphs.length - 1) {
      segments.push({
        id: `chapter-${input.index}-silence-${silenceIndex}`,
        kind: "silence",
        silenceIndex,
        durationMs: resolved.paragraphPauseMs,
        reason: "paragraph",
        paragraphIndex
      });
      silenceIndex += 1;
    }
  });

  if (speechIndex > 0 && resolved.chapterPauseMs > 0) {
    segments.push({
      id: `chapter-${input.index}-silence-${silenceIndex}`,
      kind: "silence",
      silenceIndex,
      durationMs: resolved.chapterPauseMs,
      reason: "chapter",
      paragraphIndex: null
    });
  }

  return {
    index: input.index,
    title: input.title,
    segments,
    speechSegmentCount: speechIndex,
    totalSpeechChars,
    sentenceSilenceSeconds: resolved.sentenceSilenceSeconds
  };
}

export function buildNarrationPlan(chapters: ChapterPlanInput[], options: NarrationPlanOptions = {}): NarrationPlan {
  const resolved = resolveOptions(options);
  const chapterPlans = chapters.map((chapter) => buildChapterPlan(chapter, resolved));
  return {
    chapters: chapterPlans,
    totalSpeechChars: chapterPlans.reduce((sum, chapter) => sum + chapter.totalSpeechChars, 0),
    options: resolved
  };
}

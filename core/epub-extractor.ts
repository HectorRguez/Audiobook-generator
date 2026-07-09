import fs from "node:fs/promises";
import path from "node:path";
import { convert } from "html-to-text";
import type { EpubExtractionResult } from "./types";

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

type UnknownRecord = Record<string, unknown>;

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function pickText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const text = (value as UnknownRecord)["#text"];
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

interface HeadingMatch {
  level: number;
  text: string;
}

function documentTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match || !match[1]) {
    return null;
  }
  const value = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return value || null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractHeadings(html: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const matches = html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi);
  for (const match of matches) {
    const level = Number(match[1]);
    const text = stripHtml(match[2] || "");
    if (!Number.isInteger(level) || level < 1 || level > 6 || !text) {
      continue;
    }
    headings.push({ level, text });
  }
  return headings;
}

function lowestHeading(html: string): string | null {
  const headings = extractHeadings(html);
  if (headings.length === 0) {
    return null;
  }
  const deepestLevel = Math.max(...headings.map((heading) => heading.level));
  const candidate = headings.find((heading) => heading.level === deepestLevel);
  return candidate?.text || null;
}

function extractLeadParagraph(html: string): string | null {
  const matches = html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi);
  for (const match of matches) {
    const paragraph = stripHtml(match[1] || "");
    if (!paragraph) {
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 14) {
      continue;
    }
    if (paragraph.length > 120) {
      continue;
    }
    if (!/[A-Za-z\u00C0-\u024F]/.test(paragraph)) {
      continue;
    }
    return paragraph;
  }
  return null;
}

function cleanTitle(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return stripHtml(value);
}

function isNumberOnlyTitle(value: string): boolean {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) || /^(?=[IVXLCDM]+$)[IVXLCDM]+$/i.test(trimmed);
}

function isOrdinalTitle(value: string): boolean {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  return isNumberOnlyTitle(trimmed)
    || /^(chapter|cap[ií]tulo|parte|part)\s+[\divxlcdm]+$/i.test(trimmed);
}

function isParatextHint(value: string): boolean {
  if (!value) {
    return false;
  }

  return /\b(cover|cubierta|portada|title|t[ií]tulo|credits?|cr[eé]ditos|copyright|colophon|info|synopsis|sinopsis|resumen|toc|contents?|table of contents|[ií]ndice|index|notes?|notas|appendix|appendices|ap[eé]ndice|acknowledg(e)?ments?)\b/i.test(value);
}

function isChapterHint(value: string): boolean {
  if (!value) {
    return false;
  }

  return /\b(chapter|cap[ií]tulo|part|parte|libro|book)\b/i.test(value) || /cap[ií]tulo\d+/i.test(value);
}

function composeChapterTitle(options: {
  flowTitle: string;
  headingTitle: string;
  docTitleValue: string;
  leadParagraph: string;
  fallbackIndex: number;
}): string {
  const candidates = [options.flowTitle, options.headingTitle, options.docTitleValue].filter(Boolean);
  const strong = candidates.find((value) => !isOrdinalTitle(value) && !isParatextHint(value) && !isNumberOnlyTitle(value));
  if (strong) {
    return strong;
  }

  if (options.leadParagraph) {
    return options.leadParagraph;
  }

  const nonNumeric = candidates.find((value) => !isNumberOnlyTitle(value) && !isParatextHint(value));
  if (nonNumeric) {
    return nonNumeric;
  }

  return `Chapter ${options.fallbackIndex + 1}`;
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/&lt;\/?[^&]+&gt;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isLowSignalText(text: string): boolean {
  if (!text) {
    return true;
  }

  const letters = (text.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  if (letters < 20) {
    return true;
  }
  if (digits > letters * 2) {
    return true;
  }

  const lower = text.toLowerCase();
  if (lower.includes("project gutenberg license")) {
    return true;
  }

  return false;
}

interface Epub2Instance {
  metadata?: Record<string, unknown>;
  flow?: Array<Record<string, unknown>>;
  getChapterRaw?: (chapterId: string, callback: (error: Error | null, text: string | Buffer) => void) => void;
  getChapter?: (chapterId: string, callback: (error: Error | null, text: string | Buffer) => void) => void;
  on?: (event: "error" | "end", listener: (value?: unknown) => void) => void;
  parse?: () => void;
}

type Epub2Constructor = {
  new (epubPath: string, imageRoot?: string, chapterRoot?: string): Epub2Instance;
  createAsync?: (epubPath: string, imageRoot?: string, chapterRoot?: string) => Promise<Epub2Instance>;
};

async function loadEpub2Constructor(): Promise<Epub2Constructor> {
  try {
    const moduleRef = await dynamicImport("epub2");
    const moduleRecord = moduleRef as Record<string, unknown>;
    const candidate = moduleRecord.EPub ?? moduleRecord.default ?? moduleRecord;
    if (typeof candidate !== "function") {
      throw new Error("Invalid `epub2` export shape.");
    }
    return candidate as unknown as Epub2Constructor;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load dependency \`epub2\`: ${message}`);
  }
}

async function openEpubWithDependency(epubPath: string): Promise<Epub2Instance> {
  const EpubCtor = await loadEpub2Constructor();
  if (typeof EpubCtor.createAsync === "function") {
    return EpubCtor.createAsync(epubPath, "/images/", "/links/");
  }

  const instance = new EpubCtor(epubPath, "/images/", "/links/");
  if (typeof instance.on !== "function" || typeof instance.parse !== "function") {
    throw new Error("`epub2` parser instance missing required EventEmitter API.");
  }

  await new Promise<void>((resolve, reject) => {
    instance.on?.("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    instance.on?.("end", () => resolve());
    instance.parse?.();
  });

  return instance;
}

async function getChapterHtml(instance: Epub2Instance, chapterId: string): Promise<string> {
  const readChapter = typeof instance.getChapterRaw === "function"
    ? instance.getChapterRaw.bind(instance)
    : typeof instance.getChapter === "function"
      ? instance.getChapter.bind(instance)
      : null;

  if (!readChapter) {
    throw new Error("EPUB parser does not expose getChapterRaw/getChapter.");
  }

  return new Promise<string>((resolve, reject) => {
    readChapter(chapterId, (error, text) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof text === "string") {
        resolve(text);
        return;
      }
      if (Buffer.isBuffer(text)) {
        resolve(text.toString("utf8"));
        return;
      }
      resolve("");
    });
  });
}

async function extractEpubWithDependency(epubPath: string, workDir: string): Promise<EpubExtractionResult> {
  const instance = await openEpubWithDependency(epubPath);

  const metadata = instance.metadata ?? {};
  const title = pickText(metadata.title) || path.basename(epubPath, ".epub");
  const author = pickText(metadata.creator) || null;

  const chaptersDir = path.join(workDir, "chapters");
  await fs.mkdir(chaptersDir, { recursive: true });

  interface ChapterCandidate {
    id: string;
    href: string;
    flowTitle: string;
    headingTitle: string;
    docTitleValue: string;
    leadParagraph: string;
    text: string;
    textLength: number;
  }

  const candidates: ChapterCandidate[] = [];

  const flow = asArray(instance.flow);
  for (const item of flow) {
    const chapterId = typeof item.id === "string" ? item.id : null;
    if (!chapterId) {
      continue;
    }

    let html: string;
    try {
      // eslint-disable-next-line no-await-in-loop
      html = await getChapterHtml(instance, chapterId);
    } catch {
      continue;
    }

    const text = normalizeExtractedText(convert(html, {
      wordwrap: false,
      selectors: [{ selector: "img", format: "skip" }]
    }));

    if (isLowSignalText(text)) {
      continue;
    }

    const href = typeof item.href === "string" ? item.href : "";
    candidates.push({
      id: chapterId,
      href,
      flowTitle: cleanTitle(typeof item.title === "string" ? item.title : ""),
      headingTitle: cleanTitle(lowestHeading(html)),
      docTitleValue: cleanTitle(documentTitle(html)),
      leadParagraph: cleanTitle(extractLeadParagraph(html)),
      text,
      textLength: text.length
    });
  }

  const chapterHintCount = candidates.filter((candidate) => {
    const haystack = `${candidate.id} ${candidate.href} ${candidate.flowTitle} ${candidate.headingTitle} ${candidate.docTitleValue}`;
    return isChapterHint(haystack) || (isOrdinalTitle(candidate.flowTitle) && candidate.textLength >= 2000);
  }).length;
  const hasStructuredChapters = chapterHintCount >= 3;

  const filtered = candidates.filter((candidate) => {
    if (!hasStructuredChapters) {
      return true;
    }

    const haystack = `${candidate.id} ${candidate.href} ${candidate.flowTitle} ${candidate.headingTitle} ${candidate.docTitleValue}`;
    if (isChapterHint(haystack)) {
      return true;
    }
    return !isParatextHint(haystack);
  });

  const chapters: EpubExtractionResult["chapters"] = [];
  let totalChars = 0;

  for (const candidate of filtered) {
    const chapterTitle = composeChapterTitle({
      flowTitle: candidate.flowTitle,
      headingTitle: candidate.headingTitle,
      docTitleValue: candidate.docTitleValue,
      leadParagraph: candidate.leadParagraph,
      fallbackIndex: chapters.length
    });

    totalChars += candidate.textLength;
    const textPath = path.join(chaptersDir, `${String(chapters.length + 1).padStart(4, "0")}.txt`);
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(textPath, candidate.text, "utf8");

    chapters.push({
      index: chapters.length,
      title: chapterTitle,
      textPath,
      textLength: candidate.textLength
    });
  }

  if (chapters.length === 0) {
    throw new Error("EPUB parser produced zero readable chapters.");
  }

  return {
    title,
    author,
    chapters,
    totalChars
  };
}

export async function extractEpub(epubPath: string, workDir: string): Promise<EpubExtractionResult> {
  return extractEpubWithDependency(epubPath, workDir);
}

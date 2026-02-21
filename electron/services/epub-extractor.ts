import fs from "node:fs/promises";
import path from "node:path";
import { convert } from "html-to-text";
import type { EpubExtractionResult } from "../types";

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

function firstHeading(html: string): string | null {
  const match = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!match) {
    return null;
  }
  const headingContent = match[1];
  if (!headingContent) {
    return null;
  }

  const heading = headingContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return heading || null;
}

function documentTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match || !match[1]) {
    return null;
  }
  const value = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return value || null;
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

  const chapters: EpubExtractionResult["chapters"] = [];
  let totalChars = 0;

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

    totalChars += text.length;
    const flowTitle = typeof item.title === "string" ? item.title.trim() : "";
    const chapterTitle = flowTitle || firstHeading(html) || documentTitle(html) || `Chapter ${chapters.length + 1}`;
    const textPath = path.join(chaptersDir, `${String(chapters.length + 1).padStart(4, "0")}.txt`);
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(textPath, text, "utf8");

    chapters.push({
      index: chapters.length,
      title: chapterTitle,
      textPath,
      textLength: text.length
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

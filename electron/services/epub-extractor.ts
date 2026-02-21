import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { convert } from "html-to-text";
import type { EpubExtractionResult } from "../types";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true
});

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

export async function extractEpub(epubPath: string, workDir: string): Promise<EpubExtractionResult> {
  const zip = new AdmZip(epubPath);
  const entries = zip.getEntries();

  const entryMap = new Map<string, { entryName: string; getData: () => Buffer }>();
  for (const entry of entries) {
    entryMap.set(entry.entryName, entry);
  }

  const readEntryText = (entryName: string): string => {
    const entry = entryMap.get(entryName);
    if (!entry) {
      throw new Error(`Missing EPUB entry: ${entryName}`);
    }
    return entry.getData().toString("utf8");
  };

  const containerXml = readEntryText("META-INF/container.xml");
  const container = xmlParser.parse(containerXml) as UnknownRecord;
  const rootfiles = asArray(((container.container as UnknownRecord | undefined)?.rootfiles as UnknownRecord | undefined)?.rootfile as UnknownRecord | UnknownRecord[] | undefined);
  const rootfile = rootfiles[0] as UnknownRecord | undefined;

  const opfPathValue = rootfile?.["full-path"];
  if (typeof opfPathValue !== "string" || !opfPathValue) {
    throw new Error("Invalid EPUB: container.xml rootfile missing.");
  }

  const opfPath = opfPathValue;
  const opfDir = path.posix.dirname(opfPath);
  const opfXml = readEntryText(opfPath);
  const opf = xmlParser.parse(opfXml) as UnknownRecord;

  const pkg = opf.package as UnknownRecord | undefined;
  const metadata = (pkg?.metadata as UnknownRecord | undefined) ?? {};
  const title = pickText(metadata.title) || path.basename(epubPath, ".epub");
  const author = pickText(metadata.creator) || null;

  const manifestItems = asArray((pkg?.manifest as UnknownRecord | undefined)?.item as UnknownRecord | UnknownRecord[] | undefined);
  const manifestById = new Map<string, { href: string }>();
  for (const item of manifestItems) {
    const id = item.id;
    const href = item.href;
    if (typeof id === "string" && typeof href === "string") {
      manifestById.set(id, { href });
    }
  }

  const spine = asArray((pkg?.spine as UnknownRecord | undefined)?.itemref as UnknownRecord | UnknownRecord[] | undefined);
  const chaptersDir = path.join(workDir, "chapters");
  await fs.mkdir(chaptersDir, { recursive: true });

  const chapters: EpubExtractionResult["chapters"] = [];
  let totalChars = 0;

  for (const itemRef of spine) {
    const idref = typeof itemRef.idref === "string" ? itemRef.idref : null;
    if (!idref) {
      continue;
    }

    const manifestItem = manifestById.get(idref);
    if (!manifestItem) {
      continue;
    }

    const itemPath = path.posix.normalize(path.posix.join(opfDir, manifestItem.href));
    const html = readEntryText(itemPath);

    const text = convert(html, {
      wordwrap: false,
      selectors: [{ selector: "img", format: "skip" }]
    }).replace(/\n{3,}/g, "\n\n").trim();

    if (!text) {
      continue;
    }

    totalChars += text.length;
    const chapterTitle = firstHeading(html) || `Chapter ${chapters.length + 1}`;
    const textPath = path.join(chaptersDir, `${String(chapters.length + 1).padStart(4, "0")}.txt`);
    await fs.writeFile(textPath, text, "utf8");

    chapters.push({
      index: chapters.length,
      title: chapterTitle,
      textPath,
      textLength: text.length
    });
  }

  if (chapters.length === 0) {
    throw new Error("EPUB extraction produced zero chapters.");
  }

  return {
    title,
    author,
    chapters,
    totalChars
  };
}

const fs = require("node:fs/promises");
const path = require("node:path");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const { convert } = require("html-to-text");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true
});

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function pickText(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    if (typeof value["#text"] === "string") {
      return value["#text"];
    }
  }
  return "";
}

function firstHeading(html) {
  const match = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!match) {
    return null;
  }

  const heading = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return heading || null;
}

async function extractEpub(epubPath, workDir) {
  const zip = new AdmZip(epubPath);
  const entries = zip.getEntries();

  const entryMap = new Map();
  for (const entry of entries) {
    entryMap.set(entry.entryName, entry);
  }

  const readEntryText = (entryName) => {
    const entry = entryMap.get(entryName);
    if (!entry) {
      throw new Error(`Missing EPUB entry: ${entryName}`);
    }
    return entry.getData().toString("utf8");
  };

  const containerXml = readEntryText("META-INF/container.xml");
  const container = xmlParser.parse(containerXml);
  const rootfiles = asArray(container?.container?.rootfiles?.rootfile);
  const rootfile = rootfiles[0];

  if (!rootfile || !rootfile["full-path"]) {
    throw new Error("Invalid EPUB: container.xml rootfile missing.");
  }

  const opfPath = rootfile["full-path"];
  const opfDir = path.posix.dirname(opfPath);
  const opfXml = readEntryText(opfPath);
  const opf = xmlParser.parse(opfXml);

  const pkg = opf.package;
  const metadata = pkg?.metadata || {};
  const title = pickText(metadata.title) || path.basename(epubPath, ".epub");
  const author = pickText(metadata.creator) || null;

  const manifestItems = asArray(pkg?.manifest?.item);
  const manifestById = new Map();
  for (const item of manifestItems) {
    if (item.id && item.href) {
      manifestById.set(item.id, item);
    }
  }

  const spine = asArray(pkg?.spine?.itemref);
  const chaptersDir = path.join(workDir, "chapters");
  await fs.mkdir(chaptersDir, { recursive: true });

  const chapters = [];
  let totalChars = 0;

  for (let idx = 0; idx < spine.length; idx += 1) {
    const itemRef = spine[idx];
    const manifestItem = manifestById.get(itemRef.idref);
    if (!manifestItem) {
      continue;
    }

    const href = manifestItem.href;
    const itemPath = path.posix.normalize(path.posix.join(opfDir, href));
    const html = readEntryText(itemPath);

    const text = convert(html, {
      wordwrap: false,
      selectors: [{ selector: "img", format: "skip" }]
    })
      .replace(/\n{3,}/g, "\n\n")
      .trim();

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

module.exports = {
  extractEpub
};

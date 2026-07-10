import fs from "node:fs/promises";
import path from "node:path";

interface DownloadsMetadata {
  version: string;
  platforms: Array<{
    label: string;
    file: string;
    url: string;
  }>;
  voices: Array<{
    id: string;
    name: string;
    demoUrl: string;
  }>;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`site/downloads.json field ${field} must be a non-empty string`);
  }
}

function validateDownloadsJson(value: unknown): asserts value is DownloadsMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("site/downloads.json must be an object");
  }
  const metadata = value as DownloadsMetadata;
  assertNonEmptyString(metadata.version, "version");
  if (!Array.isArray(metadata.platforms) || metadata.platforms.length === 0) {
    throw new Error("site/downloads.json platforms must be a non-empty array");
  }
  for (const [index, platform] of metadata.platforms.entries()) {
    assertNonEmptyString(platform.label, `platforms[${index}].label`);
    assertNonEmptyString(platform.file, `platforms[${index}].file`);
    assertNonEmptyString(platform.url, `platforms[${index}].url`);
  }
  if (!Array.isArray(metadata.voices) || metadata.voices.length === 0) {
    throw new Error("site/downloads.json voices must be a non-empty array");
  }
  for (const [index, voice] of metadata.voices.entries()) {
    assertNonEmptyString(voice.id, `voices[${index}].id`);
    assertNonEmptyString(voice.name, `voices[${index}].name`);
    assertNonEmptyString(voice.demoUrl, `voices[${index}].demoUrl`);
  }
}

async function main(): Promise<void> {
  const siteDir = path.join(process.cwd(), "site");
  const distDir = path.join(process.cwd(), "dist-site");
  const downloads = JSON.parse(await fs.readFile(path.join(siteDir, "downloads.json"), "utf8")) as unknown;
  validateDownloadsJson(downloads);
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.cp(siteDir, distDir, { recursive: true });
  await fs.mkdir(path.join(distDir, "voice-demos"), { recursive: true });
  console.log(`Built GitHub Pages site at ${distDir}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

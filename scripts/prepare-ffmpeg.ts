import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import extractZip from "extract-zip";

interface FfmpegAsset {
  version: string;
  archiveName: string;
  url: string;
  sha256: string;
}

interface PreparedAssetManifest {
  version: string;
  archiveUrl: string;
  archiveSha256: string;
  ffmpegSha256: string;
  ffprobeSha256: string;
}

const DOWNLOAD_ATTEMPTS = 4;

function parseArg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (value) {
      return value;
    }
  }

  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing --${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadAsset(target: string): Promise<FfmpegAsset> {
  const configPath = path.join("runtime", "ffmpeg-assets.json");
  const document = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
  if (!isRecord(document) || !isRecord(document[target])) {
    throw new Error(`No pinned FFmpeg asset is configured for ${target}`);
  }

  const candidate = document[target];
  const fields: Array<keyof FfmpegAsset> = ["version", "archiveName", "url", "sha256"];
  for (const field of fields) {
    if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
      throw new Error(`runtime/ffmpeg-assets.json ${target}.${field} must be a non-empty string`);
    }
  }

  const asset = candidate as unknown as FfmpegAsset;
  if (path.basename(asset.archiveName) !== asset.archiveName) {
    throw new Error(`FFmpeg archiveName must not contain a path: ${asset.archiveName}`);
  }
  if (new URL(asset.url).protocol !== "https:") {
    throw new Error(`FFmpeg asset URL must use HTTPS: ${asset.url}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error(`FFmpeg SHA-256 is invalid for ${target}`);
  }
  return asset;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fsSync.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function ensureArchive(asset: FfmpegAsset, archivePath: string): Promise<void> {
  if (fsSync.existsSync(archivePath)) {
    const cachedHash = await sha256File(archivePath);
    if (cachedHash === asset.sha256) {
      console.log(`Using verified cached FFmpeg archive ${asset.archiveName}`);
      return;
    }
    console.warn(`Discarding FFmpeg archive with unexpected SHA-256: ${cachedHash}`);
    await fs.rm(archivePath, { force: true });
  }

  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  const partialPath = `${archivePath}.partial`;
  const failures: string[] = [];

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    await fs.rm(partialPath, { force: true });
    try {
      const response = await fetch(asset.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(300_000),
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "audiobook-generator-runtime-builder"
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await fs.writeFile(partialPath, Buffer.from(await response.arrayBuffer()));
      const downloadedHash = await sha256File(partialPath);
      if (downloadedHash !== asset.sha256) {
        throw new Error(`SHA-256 ${downloadedHash} does not match ${asset.sha256}`);
      }

      await fs.rename(partialPath, archivePath);
      console.log(`Downloaded and verified ${asset.archiveName}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`attempt ${attempt}: ${message}`);
      await fs.rm(partialPath, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await delay(2 ** attempt * 1_000);
      }
    }
  }

  throw new Error(`Failed to download verified FFmpeg asset (${failures.join("; ")})`);
}

async function findFile(root: string, fileName: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, fileName);
      if (nested) {
        return nested;
      }
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
      return entryPath;
    }
  }
  return null;
}

async function isPreparedAssetValid(
  outputDir: string,
  asset: FfmpegAsset
): Promise<boolean> {
  const manifestPath = path.join(outputDir, "asset-manifest.json");
  const ffmpegPath = path.join(outputDir, "ffmpeg.exe");
  const ffprobePath = path.join(outputDir, "ffprobe.exe");
  if (![manifestPath, ffmpegPath, ffprobePath].every((candidate) => fsSync.existsSync(candidate))) {
    return false;
  }

  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PreparedAssetManifest;
    return manifest.version === asset.version
      && manifest.archiveUrl === asset.url
      && manifest.archiveSha256 === asset.sha256
      && manifest.ffmpegSha256 === await sha256File(ffmpegPath)
      && manifest.ffprobeSha256 === await sha256File(ffprobePath);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const target = parseArg("target");
  const cacheRoot = path.resolve(parseArg("cache", path.join(".cache", "runtime-tools")));
  const outputDir = path.resolve(parseArg("out", path.join(cacheRoot, target)));
  const asset = await loadAsset(target);
  const archivePath = path.join(cacheRoot, "archives", asset.archiveName);

  await ensureArchive(asset, archivePath);
  if (await isPreparedAssetValid(outputDir, asset)) {
    console.log(`Using verified cached FFmpeg ${asset.version} tools at ${outputDir}`);
    return;
  }

  const extractDir = path.join(cacheRoot, `.extract-${target}-${process.pid}`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });

  try {
    await extractZip(archivePath, { dir: extractDir });
    const ffmpegSource = await findFile(extractDir, "ffmpeg.exe");
    const ffprobeSource = await findFile(extractDir, "ffprobe.exe");
    if (!ffmpegSource || !ffprobeSource) {
      throw new Error(`FFmpeg archive does not contain both ffmpeg.exe and ffprobe.exe`);
    }

    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
    const ffmpegPath = path.join(outputDir, "ffmpeg.exe");
    const ffprobePath = path.join(outputDir, "ffprobe.exe");
    await fs.copyFile(ffmpegSource, ffmpegPath);
    await fs.copyFile(ffprobeSource, ffprobePath);

    const manifest: PreparedAssetManifest = {
      version: asset.version,
      archiveUrl: asset.url,
      archiveSha256: asset.sha256,
      ffmpegSha256: await sha256File(ffmpegPath),
      ffprobeSha256: await sha256File(ffprobePath)
    };
    await fs.writeFile(
      path.join(outputDir, "asset-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
  }

  console.log(`Prepared verified FFmpeg ${asset.version} tools at ${outputDir}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

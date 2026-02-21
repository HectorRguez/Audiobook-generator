import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import AdmZip from "adm-zip";
import type {
  BootstrapStatus,
  RuntimeAssets,
  RuntimeVoiceAsset,
  SidecarManifest,
  SidecarPlatformConfig
} from "../types";

function getManifestPath(): string {
  return path.join(__dirname, "..", "assets", "sidecar-manifest.json");
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function exists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  progress: number | null;
}

async function downloadToFile(
  url: string,
  outputPath: string,
  options: { onProgress?: (state: DownloadProgress) => void } = {}
): Promise<void> {
  const { onProgress } = options;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : null;
  let downloadedBytes = 0;

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  onProgress?.({
    downloadedBytes: 0,
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    progress: totalBytes && totalBytes > 0 ? 0 : null
  });

  const reader = response.body.getReader();
  const output = fs.createWriteStream(outputPath);
  let streamError: Error | null = null;

  output.once("error", (error) => {
    streamError = error;
  });

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      downloadedBytes += value.length;
      const progress = totalBytes && totalBytes > 0
        ? Math.max(0, Math.min(1, downloadedBytes / totalBytes))
        : null;
      onProgress?.({
        downloadedBytes,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
        progress
      });

      if (!output.write(Buffer.from(value))) {
        // eslint-disable-next-line no-await-in-loop
        await once(output, "drain");
      }
      if (streamError) {
        throw streamError;
      }
    }
  } finally {
    reader.releaseLock();
  }

  output.end();
  await Promise.race([
    once(output, "finish"),
    once(output, "error").then((args) => {
      const [error] = args as [Error];
      throw error;
    })
  ]);

  onProgress?.({
    downloadedBytes,
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    progress: 1
  });
}

function fileNameFromUrl(url: string, fallbackName: string): string {
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(path.posix.basename(parsed.pathname || ""));
    if (base) {
      return base;
    }
  } catch {
    // Ignore malformed URL edge cases.
  }
  return fallbackName;
}

function extractWithTar(archivePath: string, extractTarget: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archivePath, "-C", extractTarget], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tar extraction failed (${code}): ${stderr}`));
    });
  });
}

async function extractArchive(archivePath: string, extractTarget: string, archiveType: string): Promise<void> {
  const normalizedType = archiveType.toLowerCase();

  if (normalizedType === "zip") {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(extractTarget, true);
    return;
  }

  if (["tar.gz", "tgz", "tar.xz", "tar"].includes(normalizedType)) {
    await extractWithTar(archivePath, extractTarget);
    return;
  }

  throw new Error(`Unsupported archiveType: ${archiveType}`);
}

function deriveVoiceConfigUrl(modelUrl: string): string | null {
  if (!modelUrl.includes(".onnx")) {
    return null;
  }

  const match = modelUrl.match(/^(.*)\.onnx(\?.*)?$/);
  if (!match) {
    return null;
  }

  const prefix = match[1];
  const query = match[2] || "";
  return `${prefix}.onnx.json${query}`;
}

function resolvePaths(
  baseDir: string,
  pathsConfig: SidecarPlatformConfig["paths"]
): Omit<RuntimeAssets, "source" | "voicesById"> {
  return {
    piperExe: path.join(baseDir, pathsConfig.piperExe),
    ffmpegExe: path.join(baseDir, pathsConfig.ffmpegExe),
    defaultVoiceModel: path.join(baseDir, pathsConfig.defaultVoiceModel),
    defaultVoiceConfig: pathsConfig.defaultVoiceConfig
      ? path.join(baseDir, pathsConfig.defaultVoiceConfig)
      : null
  };
}

function voiceIdFromModelPath(modelPath: string): string {
  const fileName = path.basename(modelPath);
  if (fileName.toLowerCase().endsWith(".onnx")) {
    return fileName.slice(0, -".onnx".length);
  }
  return fileName || "voice-default";
}

function parseVoiceId(voiceId: string): { locale: string; speaker: string; quality: string } {
  const match = voiceId.match(/^([a-z]{2}_[A-Z]{2})-(.+)-([a-z_]+)$/);
  if (match) {
    return {
      locale: match[1] || "unknown",
      speaker: match[2] || voiceId,
      quality: match[3] || "unknown"
    };
  }

  return {
    locale: "unknown",
    speaker: voiceId,
    quality: "unknown"
  };
}

function resolveVoices(
  baseDir: string,
  platformConfig: SidecarPlatformConfig,
  defaults: { modelPath: string; configPath: string | null }
): Record<string, RuntimeVoiceAsset> {
  const voicesById: Record<string, RuntimeVoiceAsset> = {};

  for (const voice of platformConfig.voices || []) {
    const modelPath = path.join(baseDir, voice.modelPath);
    const configPath = voice.configPath ? path.join(baseDir, voice.configPath) : null;
    voicesById[voice.id] = {
      id: voice.id,
      name: voice.name,
      locale: voice.locale,
      speaker: voice.speaker,
      quality: voice.quality,
      modelPath,
      configPath
    };
  }

  if (Object.keys(voicesById).length > 0) {
    return voicesById;
  }

  const fallbackId = voiceIdFromModelPath(defaults.modelPath);
  const fallbackParts = parseVoiceId(fallbackId);
  return {
    [fallbackId]: {
      id: fallbackId,
      name: fallbackId,
      locale: fallbackParts.locale,
      speaker: fallbackParts.speaker,
      quality: fallbackParts.quality,
      modelPath: defaults.modelPath,
      configPath: defaults.configPath
    }
  };
}

function allVoiceFilesExist(voicesById: Record<string, RuntimeVoiceAsset>): boolean {
  return Object.values(voicesById).every(
    (voice) => isFile(voice.modelPath) && (!voice.configPath || isFile(voice.configPath))
  );
}

async function ensureExecutableBinaries(paths: Omit<RuntimeAssets, "source" | "voicesById">): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const executablePaths = [paths.piperExe, paths.ffmpegExe];
  for (const executablePath of executablePaths) {
    if (!isFile(executablePath)) {
      continue;
    }
    // Ensure sidecar binaries can be spawned on Linux/macOS even if archive permissions were lost.
    // eslint-disable-next-line no-await-in-loop
    await fsp.chmod(executablePath, 0o755);
  }
}

function readManifest(): Promise<SidecarManifest> {
  return fsp.readFile(getManifestPath(), "utf8").then((raw) => JSON.parse(raw) as SidecarManifest);
}

export interface ManifestVoiceInfo {
  id: string;
  name: string;
  locale: string;
  speaker: string;
  quality: string;
}

export async function listPlatformManifestVoices(): Promise<ManifestVoiceInfo[]> {
  const manifest = await readManifest();
  const key = platformKey();
  const platformConfig = manifest.platforms[key];
  if (!platformConfig) {
    return [];
  }

  return (platformConfig.voices || []).map((voice) => ({
    id: voice.id,
    name: voice.name,
    locale: voice.locale,
    speaker: voice.speaker,
    quality: voice.quality
  }));
}

export interface EnsureRuntimeAssetsOptions {
  appDataDir: string;
  onStatus?: (status: BootstrapStatus) => void;
}

export async function ensureRuntimeAssets(options: EnsureRuntimeAssetsOptions): Promise<RuntimeAssets> {
  const { appDataDir, onStatus } = options;

  if (process.env.PIPER_BIN && process.env.FFMPEG_BIN && process.env.PIPER_VOICE_MODEL) {
    const envVoiceId = process.env.PIPER_VOICE_ID || voiceIdFromModelPath(process.env.PIPER_VOICE_MODEL);
    const envVoiceParts = parseVoiceId(envVoiceId);
    return {
      piperExe: process.env.PIPER_BIN,
      ffmpegExe: process.env.FFMPEG_BIN,
      defaultVoiceModel: process.env.PIPER_VOICE_MODEL,
      defaultVoiceConfig: process.env.PIPER_VOICE_CONFIG || null,
      voicesById: {
        [envVoiceId]: {
          id: envVoiceId,
          name: envVoiceId,
          locale: envVoiceParts.locale,
          speaker: envVoiceParts.speaker,
          quality: envVoiceParts.quality,
          modelPath: process.env.PIPER_VOICE_MODEL,
          configPath: process.env.PIPER_VOICE_CONFIG || null
        }
      },
      source: "env"
    };
  }

  const manifest = await readManifest();
  const key = platformKey();
  const platformConfig = manifest.platforms[key];

  if (!platformConfig) {
    throw new Error(`Unsupported platform for sidecar bootstrap: ${key}`);
  }

  const runtimeRoot = path.join(appDataDir, "runtime-assets", manifest.version, key);
  const markerPath = path.join(runtimeRoot, ".ready.json");
  const paths = resolvePaths(runtimeRoot, platformConfig.paths);
  const voicesById = resolveVoices(runtimeRoot, platformConfig, {
    modelPath: paths.defaultVoiceModel,
    configPath: paths.defaultVoiceConfig
  });

  const allPathsExist = Object.values(paths)
    .filter((targetPath): targetPath is string => Boolean(targetPath))
    .every((targetPath) => isFile(targetPath));
  const allVoicesExist = allVoiceFilesExist(voicesById);

  if (allPathsExist && allVoicesExist) {
    await ensureExecutableBinaries(paths);
    if (!exists(markerPath)) {
      await fsp.writeFile(markerPath, JSON.stringify({ version: manifest.version, readyAt: Date.now() }, null, 2));
    }
    return { ...paths, voicesById, source: "cache" };
  }

  await fsp.mkdir(runtimeRoot, { recursive: true });
  const downloadsDir = path.join(runtimeRoot, "downloads");
  await fsp.mkdir(downloadsDir, { recursive: true });
  const totalItems = platformConfig.archives.length;

  for (let idx = 0; idx < platformConfig.archives.length; idx += 1) {
    const archive = platformConfig.archives[idx];
    if (!archive) {
      continue;
    }
    const itemIndex = idx + 1;
    const archiveType = (archive.archiveType || "zip").toLowerCase();
    const extractTarget = path.join(runtimeRoot, archive.extractTo);
    await fsp.mkdir(extractTarget, { recursive: true });

    if (archiveType === "none") {
      const fileName = fileNameFromUrl(archive.url, `${archive.id}.bin`);
      const targetPath = path.join(extractTarget, fileName);
      await downloadToFile(archive.url, targetPath, {
        onProgress: (downloadState) => {
          onStatus?.({
            phase: "downloading",
            assetId: archive.id,
            itemIndex,
            totalItems,
            message: `Downloading ${archive.id}`,
            progress: downloadState.progress,
            downloadedBytes: downloadState.downloadedBytes,
            totalBytes: downloadState.totalBytes
          });
        }
      });
      continue;
    }

    const archivePath = path.join(downloadsDir, `${archive.id}.archive`);
    await downloadToFile(archive.url, archivePath, {
      onProgress: (downloadState) => {
        onStatus?.({
          phase: "downloading",
          assetId: archive.id,
          itemIndex,
          totalItems,
          message: `Downloading ${archive.id}`,
          progress: downloadState.progress,
          downloadedBytes: downloadState.downloadedBytes,
          totalBytes: downloadState.totalBytes
        });
      }
    });

    onStatus?.({
      phase: "extracting",
      assetId: archive.id,
      itemIndex,
      totalItems,
      message: `Extracting ${archive.id}`,
      progress: 1
    });

    await extractArchive(archivePath, extractTarget, archiveType);
  }

  if (paths.defaultVoiceConfig && !exists(paths.defaultVoiceConfig) && exists(paths.defaultVoiceModel)) {
    const defaultModelFileName = path.basename(paths.defaultVoiceModel);
    const voiceArchive = platformConfig.archives.find((archive) => {
      if (archive.id === "voice-default") {
        return true;
      }
      const archiveFileName = fileNameFromUrl(archive.url, "");
      return archiveFileName === defaultModelFileName;
    });
    const configUrl = voiceArchive ? deriveVoiceConfigUrl(voiceArchive.url) : null;
    if (configUrl) {
      await fsp.mkdir(path.dirname(paths.defaultVoiceConfig), { recursive: true });
      await downloadToFile(configUrl, paths.defaultVoiceConfig);
    }
  }

  const requiredPaths = Object.values(paths).filter((targetPath): targetPath is string => Boolean(targetPath));
  for (const required of requiredPaths) {
    if (!isFile(required)) {
      throw new Error(`Runtime asset missing after bootstrap: ${required}`);
    }
  }
  for (const voice of Object.values(voicesById)) {
    if (!isFile(voice.modelPath)) {
      throw new Error(`Voice model missing after bootstrap: ${voice.id}`);
    }
    if (voice.configPath && !isFile(voice.configPath)) {
      throw new Error(`Voice config missing after bootstrap: ${voice.id}`);
    }
  }

  await ensureExecutableBinaries(paths);

  await fsp.writeFile(markerPath, JSON.stringify({ version: manifest.version, readyAt: Date.now() }, null, 2));

  return { ...paths, voicesById, source: "download" };
}

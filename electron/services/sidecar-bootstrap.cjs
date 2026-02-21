const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const AdmZip = require("adm-zip");

function getManifestPath() {
  return path.join(__dirname, "..", "assets", "sidecar-manifest.json");
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath));
}

function fileNameFromUrl(url, fallbackName) {
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(path.posix.basename(parsed.pathname || ""));
    if (base) {
      return base;
    }
  } catch {
    // ignore
  }
  return fallbackName;
}

function extractWithTar(archivePath, extractTarget) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archivePath, "-C", extractTarget], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
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

async function extractArchive(archivePath, extractTarget, archiveType) {
  const normalizedType = (archiveType || "zip").toLowerCase();

  if (normalizedType === "zip") {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(extractTarget, true);
    return;
  }

  if ([ "tar.gz", "tgz", "tar.xz", "tar" ].includes(normalizedType)) {
    await extractWithTar(archivePath, extractTarget);
    return;
  }

  throw new Error(`Unsupported archiveType: ${archiveType}`);
}

function deriveVoiceConfigUrl(modelUrl) {
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

function resolvePaths(baseDir, pathsConfig) {
  return {
    piperExe: path.join(baseDir, pathsConfig.piperExe),
    ffmpegExe: path.join(baseDir, pathsConfig.ffmpegExe),
    defaultVoiceModel: path.join(baseDir, pathsConfig.defaultVoiceModel),
    defaultVoiceConfig: pathsConfig.defaultVoiceConfig
      ? path.join(baseDir, pathsConfig.defaultVoiceConfig)
      : null
  };
}

async function ensureRuntimeAssets(options) {
  const { appDataDir, onStatus } = options;

  if (process.env.PIPER_BIN && process.env.FFMPEG_BIN && process.env.PIPER_VOICE_MODEL) {
    return {
      piperExe: process.env.PIPER_BIN,
      ffmpegExe: process.env.FFMPEG_BIN,
      defaultVoiceModel: process.env.PIPER_VOICE_MODEL,
      defaultVoiceConfig: process.env.PIPER_VOICE_CONFIG || null,
      source: "env"
    };
  }

  const manifest = JSON.parse(await fsp.readFile(getManifestPath(), "utf8"));
  const key = platformKey();
  const platformConfig = manifest.platforms[key];

  if (!platformConfig) {
    throw new Error(`Unsupported platform for sidecar bootstrap: ${key}`);
  }

  const runtimeRoot = path.join(appDataDir, "runtime-assets", manifest.version, key);
  const markerPath = path.join(runtimeRoot, ".ready.json");
  const paths = resolvePaths(runtimeRoot, platformConfig.paths);

  const allPathsExist = Object.values(paths)
    .filter(Boolean)
    .every((targetPath) => exists(targetPath));

  if (exists(markerPath) && allPathsExist) {
    return { ...paths, source: "cache" };
  }

  await fsp.mkdir(runtimeRoot, { recursive: true });
  const downloadsDir = path.join(runtimeRoot, "downloads");
  await fsp.mkdir(downloadsDir, { recursive: true });

  for (const archive of platformConfig.archives) {
    const archiveType = (archive.archiveType || "zip").toLowerCase();
    if (onStatus) {
      onStatus({ phase: "downloading", assetId: archive.id, message: `Downloading ${archive.id}` });
    }

    const extractTarget = path.join(runtimeRoot, archive.extractTo);
    await fsp.mkdir(extractTarget, { recursive: true });
    if (archiveType === "none") {
      const fileName = fileNameFromUrl(archive.url, `${archive.id}.bin`);
      const targetPath = path.join(extractTarget, fileName);
      await downloadToFile(archive.url, targetPath);
      continue;
    }

    const archivePath = path.join(downloadsDir, `${archive.id}.archive`);
    await downloadToFile(archive.url, archivePath);

    if (onStatus) {
      onStatus({ phase: "extracting", assetId: archive.id, message: `Extracting ${archive.id}` });
    }

    await extractArchive(archivePath, extractTarget, archiveType);
  }

  if (paths.defaultVoiceConfig && !exists(paths.defaultVoiceConfig) && exists(paths.defaultVoiceModel)) {
    const voiceArchive = platformConfig.archives.find((archive) => archive.id === "voice-default");
    const configUrl = voiceArchive ? deriveVoiceConfigUrl(voiceArchive.url) : null;
    if (configUrl) {
      await fsp.mkdir(path.dirname(paths.defaultVoiceConfig), { recursive: true });
      await downloadToFile(configUrl, paths.defaultVoiceConfig);
    }
  }

  const requiredPaths = Object.values(paths).filter(Boolean);
  for (const required of requiredPaths) {
    if (!exists(required)) {
      throw new Error(`Runtime asset missing after bootstrap: ${required}`);
    }
  }

  await fsp.writeFile(markerPath, JSON.stringify({ version: manifest.version, readyAt: Date.now() }, null, 2));

  return { ...paths, source: "download" };
}

module.exports = {
  ensureRuntimeAssets,
  platformKey
};

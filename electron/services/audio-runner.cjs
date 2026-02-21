const fs = require("node:fs/promises");
const path = require("node:path");
const sanitize = require("sanitize-filename");
const { runCommand } = require("./process-utils.cjs");

let parseFileCached = null;

async function getParseFile() {
  if (parseFileCached) {
    return parseFileCached;
  }

  const moduleRef = await import("music-metadata");
  parseFileCached = moduleRef.parseFile;
  return parseFileCached;
}

function quoteForConcat(filePath) {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

async function runPiperChunk(options) {
  const {
    piperExe,
    voiceModel,
    voiceConfig,
    text,
    outWavPath,
    abortSignal,
    onSpawn,
    onLog
  } = options;

  await fs.mkdir(path.dirname(outWavPath), { recursive: true });

  const args = ["--model", voiceModel, "--output_file", outWavPath];
  if (voiceConfig) {
    args.push("--config", voiceConfig);
  }

  await runCommand({
    command: piperExe,
    args,
    stdinText: text,
    abortSignal,
    onSpawn,
    onStderr: (line) => {
      if (onLog) {
        onLog(line.trim());
      }
    }
  });
}

async function concatWavs(options) {
  const { ffmpegExe, inputWavs, outWavPath, tempDir, abortSignal, onSpawn } = options;

  if (inputWavs.length === 0) {
    throw new Error("concatWavs requires at least one input WAV.");
  }

  await fs.mkdir(tempDir, { recursive: true });
  const concatListPath = path.join(tempDir, `concat-${Date.now()}.txt`);
  const concatContent = inputWavs.map(quoteForConcat).join("\n");
  await fs.writeFile(concatListPath, concatContent, "utf8");

  await runCommand({
    command: ffmpegExe,
    args: ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outWavPath],
    abortSignal,
    onSpawn
  });

  await fs.rm(concatListPath, { force: true });
}

async function encodeFinalAudio(options) {
  const { ffmpegExe, inputWavPath, outputPath, format, metadata, abortSignal, onSpawn } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const metadataArgs = [];
  if (metadata?.title) {
    metadataArgs.push("-metadata", `title=${metadata.title}`);
  }
  if (metadata?.author) {
    metadataArgs.push("-metadata", `artist=${metadata.author}`);
  }

  const args = ["-y", "-i", inputWavPath, ...metadataArgs];

  if (format === "m4b") {
    args.push("-c:a", "aac", "-b:a", "128k", outputPath);
  } else {
    args.push("-c:a", "libmp3lame", "-q:a", "2", outputPath);
  }

  await runCommand({
    command: ffmpegExe,
    args,
    abortSignal,
    onSpawn
  });
}

async function getDurationMs(filePath) {
  const parseFile = await getParseFile();
  const metadata = await parseFile(filePath);
  const durationSec = metadata.format.duration || 0;
  return Math.round(durationSec * 1000);
}

function buildOutputPaths(options) {
  const { outputDir, title, author, format } = options;
  const safeTitle = sanitize(title || "Untitled") || "Untitled";
  const safeAuthor = sanitize(author || "Unknown") || "Unknown";
  const folderName = `${safeTitle} - ${safeAuthor}`;
  const fileBase = `${safeTitle}`;
  const extension = format === "m4b" ? "m4b" : "mp3";

  const destinationDir = path.join(outputDir, folderName);
  const finalPath = path.join(destinationDir, `${fileBase}.${extension}`);
  return { destinationDir, finalPath };
}

module.exports = {
  runPiperChunk,
  concatWavs,
  encodeFinalAudio,
  getDurationMs,
  buildOutputPaths
};

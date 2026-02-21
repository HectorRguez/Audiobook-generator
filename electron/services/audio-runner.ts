import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import sanitize from "sanitize-filename";
import { runCommand } from "./process-utils";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OutputFormat } from "../types";

let parseFileCached: ((filePath: string) => Promise<{ format: { duration?: number } }>) | null = null;
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

async function getParseFile() {
  if (parseFileCached) {
    return parseFileCached;
  }

  const moduleRef = await dynamicImport("music-metadata");
  const parseFile = (moduleRef as { parseFile?: unknown }).parseFile;
  if (typeof parseFile !== "function") {
    throw new Error("music-metadata parseFile export is unavailable.");
  }
  parseFileCached = parseFile as (filePath: string) => Promise<{ format: { duration?: number } }>;
  return parseFileCached;
}

function quoteForConcat(filePath: string): string {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

function buildFfmpegEnv(ffmpegExe: string): NodeJS.ProcessEnv | null {
  if (process.platform === "win32") {
    return null;
  }

  const binDir = path.dirname(ffmpegExe);
  const libDir = path.resolve(binDir, "..", "lib");
  if (!fsSync.existsSync(libDir)) {
    return null;
  }

  const current = process.env.LD_LIBRARY_PATH;
  const ldLibraryPath = current ? `${libDir}${path.delimiter}${current}` : libDir;
  return {
    ...process.env,
    LD_LIBRARY_PATH: ldLibraryPath
  };
}

export interface RunPiperChunkOptions {
  piperExe: string;
  voiceModel: string;
  voiceConfig: string | null;
  useCuda?: boolean;
  text: string;
  outWavPath: string;
  abortSignal?: AbortSignal;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  onLog?: (line: string) => void;
}

export async function runPiperChunk(options: RunPiperChunkOptions): Promise<void> {
  const {
    piperExe,
    voiceModel,
    voiceConfig,
    useCuda,
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
  if (useCuda) {
    args.push("--cuda");
  }

  const runOptions: Parameters<typeof runCommand>[0] = {
    command: piperExe,
    args,
    stdinText: text,
    onStderr: (line) => {
      onLog?.(line.trim());
    }
  };
  if (abortSignal) {
    runOptions.abortSignal = abortSignal;
  }
  if (onSpawn) {
    runOptions.onSpawn = onSpawn;
  }

  await runCommand(runOptions);
}

export interface ConcatWavsOptions {
  ffmpegExe: string;
  inputWavs: string[];
  outWavPath: string;
  tempDir: string;
  abortSignal?: AbortSignal;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}

export async function concatWavs(options: ConcatWavsOptions): Promise<void> {
  const { ffmpegExe, inputWavs, outWavPath, tempDir, abortSignal, onSpawn } = options;

  if (inputWavs.length === 0) {
    throw new Error("concatWavs requires at least one input WAV.");
  }

  await fs.mkdir(tempDir, { recursive: true });
  const concatListPath = path.join(tempDir, `concat-${Date.now()}.txt`);
  const concatContent = inputWavs.map(quoteForConcat).join("\n");
  await fs.writeFile(concatListPath, concatContent, "utf8");

  const runOptions: Parameters<typeof runCommand>[0] = {
    command: ffmpegExe,
    args: ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outWavPath]
  };
  const ffmpegEnv = buildFfmpegEnv(ffmpegExe);
  if (ffmpegEnv) {
    runOptions.env = ffmpegEnv;
  }
  if (abortSignal) {
    runOptions.abortSignal = abortSignal;
  }
  if (onSpawn) {
    runOptions.onSpawn = onSpawn;
  }

  await runCommand(runOptions);

  await fs.rm(concatListPath, { force: true });
}

export interface EncodeFinalAudioOptions {
  ffmpegExe: string;
  inputWavPath: string;
  outputPath: string;
  format: OutputFormat;
  metadata?: {
    title?: string | null;
    author?: string | null;
  };
  abortSignal?: AbortSignal;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}

export async function encodeFinalAudio(options: EncodeFinalAudioOptions): Promise<void> {
  const { ffmpegExe, inputWavPath, outputPath, format, metadata, abortSignal, onSpawn } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const metadataArgs: string[] = [];
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

  const runOptions: Parameters<typeof runCommand>[0] = {
    command: ffmpegExe,
    args
  };
  const ffmpegEnv = buildFfmpegEnv(ffmpegExe);
  if (ffmpegEnv) {
    runOptions.env = ffmpegEnv;
  }
  if (abortSignal) {
    runOptions.abortSignal = abortSignal;
  }
  if (onSpawn) {
    runOptions.onSpawn = onSpawn;
  }

  await runCommand(runOptions);
}

export async function getDurationMs(filePath: string): Promise<number> {
  const parseFile = await getParseFile();
  const metadata = await parseFile(filePath);
  const durationSec = metadata.format.duration ?? 0;
  return Math.round(durationSec * 1000);
}

export function buildOutputPaths(options: {
  outputDir: string;
  title: string;
  author: string | null;
  format: OutputFormat;
}): { destinationDir: string; finalPath: string } {
  const { outputDir, title, author, format } = options;
  const safeTitle = sanitize(title || "Untitled") || "Untitled";
  const safeAuthor = sanitize(author || "Unknown") || "Unknown";
  const folderName = `${safeTitle} - ${safeAuthor}`;
  const fileBase = safeTitle;
  const extension = format === "m4b" ? "m4b" : "mp3";

  const destinationDir = path.join(outputDir, folderName);
  const finalPath = path.join(destinationDir, `${fileBase}.${extension}`);
  return { destinationDir, finalPath };
}

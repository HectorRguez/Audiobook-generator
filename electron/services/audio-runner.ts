import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import sanitize from "sanitize-filename";
import { runCommand } from "./process-utils";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OutputFormat } from "../types";
import type { SpeechSegmentInput, SynthesisMetrics, TtsEngine } from "../../core/tts-engine";

let parseFileCached: ((filePath: string) => Promise<{ format: { duration?: number; sampleRate?: number } }>) | null = null;
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
  parseFileCached = parseFile as (filePath: string) => Promise<{ format: { duration?: number; sampleRate?: number } }>;
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
  sentenceSilenceSeconds?: number;
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
    sentenceSilenceSeconds,
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
  if (typeof sentenceSilenceSeconds === "number" && Number.isFinite(sentenceSilenceSeconds)) {
    args.push("--sentence-silence", String(sentenceSilenceSeconds));
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

export type PiperEngineMode = "auto" | "single-cli" | "persistent-cli";

export interface PiperCliTtsEngineOptions {
  piperExe: string;
  voiceModel: string;
  voiceConfig: string | null;
  useCuda?: boolean;
  sentenceSilenceSeconds?: number;
  mode?: PiperEngineMode;
  batchSize?: number;
}

export class PiperCliTtsEngine implements TtsEngine {
  readonly id = "piper-cli";

  private readonly piperExe: string;
  private readonly voiceModel: string;
  private readonly voiceConfig: string | null;
  private readonly useCuda: boolean;
  private readonly sentenceSilenceSeconds: number | undefined;
  private readonly mode: PiperEngineMode;
  private readonly batchSize: number;
  private jsonInputSupport: Promise<boolean> | null = null;

  constructor(options: PiperCliTtsEngineOptions) {
    this.piperExe = options.piperExe;
    this.voiceModel = options.voiceModel;
    this.voiceConfig = options.voiceConfig;
    this.useCuda = Boolean(options.useCuda);
    this.sentenceSilenceSeconds = options.sentenceSilenceSeconds;
    this.mode = options.mode ?? "auto";
    this.batchSize = options.batchSize ?? 16;
  }

  async synthesizeSpeechSegments(options: {
    segments: SpeechSegmentInput[];
    startIndex?: number;
    abortSignal?: AbortSignal;
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
    onLog?: (line: string) => void;
    onSegmentComplete?: (segment: SpeechSegmentInput, elapsedMs: number) => void;
  }): Promise<SynthesisMetrics> {
    const started = Date.now();
    const pending = options.segments.filter((segment) => segment.speechIndex >= (options.startIndex ?? 0));
    if (pending.length === 0) {
      return {
        engine: this.id,
        mode: this.mode === "single-cli" ? "single-cli" : "persistent-cli",
        segmentCount: 0,
        characterCount: 0,
        elapsedMs: 0
      };
    }

    if (this.mode !== "single-cli" && await this.supportsJsonInput()) {
      try {
        await this.synthesizePersistentCli(pending, options);
        return {
          engine: this.id,
          mode: "persistent-cli",
          segmentCount: pending.length,
          characterCount: countChars(pending),
          elapsedMs: Date.now() - started
        };
      } catch (error: unknown) {
        if (this.mode === "persistent-cli" || !isJsonInputUnsupportedError(error)) {
          throw error;
        }
        options.onLog?.("Piper JSON input is unavailable; falling back to one process per segment.");
      }
    }

    await this.synthesizeSingleCli(pending, options);
    return {
      engine: this.id,
      mode: "single-cli",
      segmentCount: pending.length,
      characterCount: countChars(pending),
      elapsedMs: Date.now() - started
    };
  }

  private async supportsJsonInput(): Promise<boolean> {
    if (!this.jsonInputSupport) {
      this.jsonInputSupport = runCommand({
        command: this.piperExe,
        args: ["--help"]
      })
        .then((result) => `${result.stdout}\n${result.stderr}`.toLowerCase().includes("--json-input"))
        .catch(() => false);
    }
    return this.jsonInputSupport;
  }

  private buildBaseArgs(): string[] {
    const args = ["--model", this.voiceModel];
    if (this.voiceConfig) {
      args.push("--config", this.voiceConfig);
    }
    if (this.useCuda) {
      args.push("--cuda");
    }
    if (typeof this.sentenceSilenceSeconds === "number" && Number.isFinite(this.sentenceSilenceSeconds)) {
      args.push("--sentence-silence", String(this.sentenceSilenceSeconds));
    }
    return args;
  }

  private async synthesizePersistentCli(
    segments: SpeechSegmentInput[],
    options: {
      abortSignal?: AbortSignal;
      onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
      onLog?: (line: string) => void;
      onSegmentComplete?: (segment: SpeechSegmentInput, elapsedMs: number) => void;
    }
  ): Promise<void> {
    for (let offset = 0; offset < segments.length; offset += this.batchSize) {
      const batch = segments.slice(offset, offset + this.batchSize);
      const batchStarted = Date.now();
      await Promise.all(batch.map((segment) => fs.mkdir(path.dirname(segment.outputPath), { recursive: true })));
      const stdinText = batch
        .map((segment) => JSON.stringify({ text: segment.text, output_file: segment.outputPath }))
        .join("\n")
        .concat("\n");

      const runOptions: Parameters<typeof runCommand>[0] = {
        command: this.piperExe,
        args: [...this.buildBaseArgs(), "--json-input"],
        stdinText,
        onStderr: (line) => options.onLog?.(line.trim())
      };
      if (options.abortSignal) {
        runOptions.abortSignal = options.abortSignal;
      }
      if (options.onSpawn) {
        runOptions.onSpawn = options.onSpawn;
      }

      await runCommand(runOptions);
      const elapsedPerSegment = Math.max(1, Math.round((Date.now() - batchStarted) / batch.length));
      batch.forEach((segment) => options.onSegmentComplete?.(segment, elapsedPerSegment));
    }
  }

  private async synthesizeSingleCli(
    segments: SpeechSegmentInput[],
    options: {
      abortSignal?: AbortSignal;
      onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
      onLog?: (line: string) => void;
      onSegmentComplete?: (segment: SpeechSegmentInput, elapsedMs: number) => void;
    }
  ): Promise<void> {
    for (const segment of segments) {
      const started = Date.now();
      const runOptions: RunPiperChunkOptions = {
        piperExe: this.piperExe,
        voiceModel: this.voiceModel,
        voiceConfig: this.voiceConfig,
        useCuda: this.useCuda,
        text: segment.text,
        outWavPath: segment.outputPath
      };
      if (typeof this.sentenceSilenceSeconds === "number") {
        runOptions.sentenceSilenceSeconds = this.sentenceSilenceSeconds;
      }
      if (options.abortSignal) {
        runOptions.abortSignal = options.abortSignal;
      }
      if (options.onSpawn) {
        runOptions.onSpawn = options.onSpawn;
      }
      if (options.onLog) {
        runOptions.onLog = options.onLog;
      }
      // eslint-disable-next-line no-await-in-loop
      await runPiperChunk(runOptions);
      options.onSegmentComplete?.(segment, Date.now() - started);
    }
  }
}

function countChars(segments: SpeechSegmentInput[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

function isJsonInputUnsupportedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return text.includes("json-input") || text.includes("unrecognized argument");
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

export interface CreateSilenceWavOptions {
  ffmpegExe: string;
  outWavPath: string;
  durationMs: number;
  sampleRate: number;
  abortSignal?: AbortSignal;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}

export async function createSilenceWav(options: CreateSilenceWavOptions): Promise<void> {
  const { ffmpegExe, outWavPath, durationMs, sampleRate, abortSignal, onSpawn } = options;
  await fs.mkdir(path.dirname(outWavPath), { recursive: true });

  const seconds = Math.max(0.001, durationMs / 1000);
  const runOptions: Parameters<typeof runCommand>[0] = {
    command: ffmpegExe,
    args: [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${sampleRate}:cl=mono`,
      "-t",
      seconds.toFixed(3),
      "-acodec",
      "pcm_s16le",
      outWavPath
    ]
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
  const info = await getAudioInfo(filePath);
  return info.durationMs;
}

export async function getAudioInfo(filePath: string): Promise<{ durationMs: number; sampleRate: number | null }> {
  const parseFile = await getParseFile();
  const metadata = await parseFile(filePath);
  const durationSec = metadata.format.duration ?? 0;
  const sampleRate = typeof metadata.format.sampleRate === "number" && Number.isFinite(metadata.format.sampleRate)
    ? metadata.format.sampleRate
    : null;
  return {
    durationMs: Math.round(durationSec * 1000),
    sampleRate
  };
}

export async function readVoiceSampleRate(voiceConfig: string | null): Promise<number | null> {
  if (!voiceConfig) {
    return null;
  }

  try {
    const raw = await fs.readFile(voiceConfig, "utf8");
    const parsed = JSON.parse(raw) as { audio?: { sample_rate?: unknown } };
    const sampleRate = parsed.audio?.sample_rate;
    if (typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0) {
      return sampleRate;
    }
  } catch {
    return null;
  }

  return null;
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

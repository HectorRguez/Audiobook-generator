import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { extractEpub } from "./epub-extractor";
import { splitIntoChunks } from "./text-utils";
import { EtaEstimator } from "./eta-estimator";
import { killChild } from "./process-utils";
import {
  runPiperChunk,
  concatWavs,
  encodeFinalAudio,
  getDurationMs,
  buildOutputPaths
} from "./audio-runner";
import type {
  AppSettings,
  BootstrapStatus,
  ChapterRow,
  JobDetail,
  JobRow,
  OutputRow,
  RuntimeAssets
} from "../types";
import { Repository } from "../db/repository";
import type { EnsureRuntimeAssetsOptions } from "./sidecar-bootstrap";

class PausedError extends Error {
  readonly code = "JOB_PAUSED";

  constructor() {
    super("Paused by user");
  }
}

class CanceledError extends Error {
  readonly code = "JOB_CANCELED";

  constructor() {
    super("Canceled by user");
  }
}

function isEpubPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".epub");
}

function asError(error: unknown): Error & { code?: string } {
  if (error instanceof Error) {
    return error as Error & { code?: string };
  }
  return new Error(String(error));
}

interface QueueManagerOptions {
  repo: Repository;
  appDataDir: string;
  ensureRuntimeAssets: (options: EnsureRuntimeAssetsOptions) => Promise<RuntimeAssets>;
}

interface ChapterProcessContext {
  workDir: string;
  assets: RuntimeAssets;
  etaEstimator: EtaEstimator;
  totalChars: number;
}

export class QueueManager extends EventEmitter {
  private readonly repo: Repository;
  private readonly appDataDir: string;
  private readonly ensureRuntimeAssetsFn: (options: EnsureRuntimeAssetsOptions) => Promise<RuntimeAssets>;

  private isPumping = false;
  private currentJobId: string | null = null;
  private currentChild: ChildProcessWithoutNullStreams | null = null;
  private readonly pauseRequested = new Set<string>();
  private readonly cancelRequested = new Set<string>();

  private runtimeAssets: RuntimeAssets | null = null;
  private runtimeAssetsPromise: Promise<RuntimeAssets> | null = null;

  constructor(options: QueueManagerOptions) {
    super();
    this.repo = options.repo;
    this.appDataDir = options.appDataDir;
    this.ensureRuntimeAssetsFn = options.ensureRuntimeAssets;
  }

  private emitQueueUpdated(jobs: JobRow[]): void {
    this.emit("queueUpdated", jobs);
  }

  private emitJobUpdated(job: JobDetail): void {
    this.emit("jobUpdated", job);
  }

  private emitGeneratedUpdated(outputs: OutputRow[]): void {
    this.emit("generatedUpdated", outputs);
  }

  private emitLog(jobId: string, level: string, message: string): void {
    this.emit("logEvent", { jobId, level, message, ts: Date.now() });
  }

  private emitBootstrap(status: BootstrapStatus): void {
    this.emit("bootstrapStatusUpdated", status);
  }

  private emitSettingsUpdated(settings: Partial<AppSettings>): void {
    this.emit("settingsUpdated", settings);
  }

  async initialize(): Promise<void> {
    this.repo.recoverInterruptedWork();
    this.emitQueue();
    this.emitGeneratedAudios();
    void this.pump();
  }

  async bootstrapAssets(): Promise<RuntimeAssets> {
    if (this.runtimeAssets) {
      return this.runtimeAssets;
    }

    if (!this.runtimeAssetsPromise) {
      this.runtimeAssetsPromise = this.ensureRuntimeAssetsFn({
        appDataDir: this.appDataDir,
        onStatus: (status) => this.emitBootstrap(status)
      })
        .then((result) => {
          this.runtimeAssets = result;
          this.emitBootstrap({
            phase: "ready",
            message: `Runtime assets ready (${result.source}).`
          });
          return result;
        })
        .catch((error: unknown) => {
          const err = asError(error);
          this.emitBootstrap({
            phase: "error",
            message: err.message
          });
          throw err;
        })
        .finally(() => {
          this.runtimeAssetsPromise = null;
        });
    }

    return this.runtimeAssetsPromise;
  }

  private emitQueue(): void {
    this.emitQueueUpdated(this.repo.listJobs());
  }

  private emitGeneratedAudios(): void {
    this.emitGeneratedUpdated(this.repo.listOutputs());
  }

  private emitJob(jobId: string): void {
    const detail = this.repo.getJobDetail(jobId);
    if (detail) {
      this.emitJobUpdated(detail);
    }
  }

  private log(jobId: string, level: string, message: string): void {
    this.repo.addLog(jobId, level, message);
    this.emitLog(jobId, level, message);
  }

  getSettings(): Partial<AppSettings> {
    return this.repo.getSettings();
  }

  setSettings(patch: Partial<AppSettings>): Partial<AppSettings> {
    const settings = this.repo.setSettings(patch);
    this.emitSettingsUpdated(settings);
    return settings;
  }

  listJobs(): JobRow[] {
    return this.repo.listJobs();
  }

  listGeneratedAudios(): OutputRow[] {
    return this.repo.listOutputs();
  }

  getGeneratedAudio(outputId: string): OutputRow | null {
    return this.repo.getOutput(outputId);
  }

  getGeneratedAudiosByJob(jobId: string): OutputRow[] {
    return this.repo.getOutputsByJob(jobId);
  }

  getJob(jobId: string): JobDetail | null {
    return this.repo.getJobDetail(jobId);
  }

  async enqueueEpubFiles(filePaths: string[]): Promise<JobRow[]> {
    const validPaths = filePaths.filter(isEpubPath);
    if (validPaths.length === 0) {
      throw new Error("Only .epub files are supported.");
    }

    const settings = this.repo.getSettings();
    const rows = this.repo.enqueueEpubFiles(validPaths, {
      voiceId: settings.defaultVoiceId || "es_ES-carlfm-high",
      outputFormat: settings.defaultOutputFormat || "mp3",
      outputDir: settings.defaultOutputDir || path.join(this.appDataDir, "outputs"),
      jobSettings: {
        keepIntermediates: Boolean(settings.keepIntermediates)
      }
    });

    this.emitQueue();
    void this.pump();
    return rows;
  }

  reorderQueue(jobIdsInOrder: string[]): void {
    this.repo.reorderQueue(jobIdsInOrder);
    this.emitQueue();
  }

  pauseJob(jobId: string): void {
    const job = this.repo.getJob(jobId);
    if (!job) {
      return;
    }

    if (this.currentJobId === jobId) {
      this.pauseRequested.add(jobId);
      this.log(jobId, "info", "Pause requested; stopping after current chunk.");
      return;
    }

    if (job.status === "queued") {
      this.repo.setJobPaused(jobId);
      this.emitQueue();
      this.emitJob(jobId);
    }
  }

  resumeJob(jobId: string): void {
    const job = this.repo.getJob(jobId);
    if (!job) {
      return;
    }

    if (!["paused", "error"].includes(job.status)) {
      return;
    }

    this.pauseRequested.delete(jobId);
    this.cancelRequested.delete(jobId);
    this.repo.updateJob({ id: jobId, status: "queued", error_message: null, eta_seconds: null });

    const chapters = this.repo.listChapters(jobId);
    chapters.forEach((chapter) => {
      if (chapter.status === "error") {
        this.repo.updateChapter(jobId, chapter.idx, { status: "queued", error_message: null });
      }
    });

    this.emitQueue();
    this.emitJob(jobId);
    void this.pump();
  }

  cancelJob(jobId: string): void {
    const job = this.repo.getJob(jobId);
    if (!job) {
      return;
    }

    this.cancelRequested.add(jobId);
    this.pauseRequested.delete(jobId);

    if (this.currentJobId === jobId && this.currentChild) {
      killChild(this.currentChild);
    }

    if (job.status === "queued" || job.status === "paused") {
      this.repo.setJobCanceled(jobId);
      this.emitQueue();
      this.emitJob(jobId);
    }
  }

  deleteJob(jobId: string): void {
    if (this.currentJobId === jobId) {
      throw new Error("Cannot delete an actively processing job.");
    }

    this.repo.deleteJob(jobId);
    this.emitQueue();
    this.emitGeneratedAudios();
  }

  private checkControlFlags(jobId: string): void {
    if (this.cancelRequested.has(jobId)) {
      throw new CanceledError();
    }
    if (this.pauseRequested.has(jobId)) {
      throw new PausedError();
    }
  }

  private async ensureJobChapters(job: JobRow, workDir: string): Promise<ChapterRow[]> {
    const existingChapters = this.repo.listChapters(job.id);
    if (existingChapters.length > 0) {
      return existingChapters;
    }

    this.repo.updateJob({ id: job.id, status: "extracting", progress: 0.01, started_at: Date.now() });
    this.emitQueue();
    this.emitJob(job.id);
    this.log(job.id, "info", "Extracting EPUB chapters.");

    const extraction = await extractEpub(job.source_path, workDir);
    this.repo.replaceChapters(job.id, extraction.chapters);
    this.repo.updateJob({
      id: job.id,
      status: "processing",
      total_chars: extraction.totalChars,
      processed_chars: 0,
      progress: 0.02,
      error_message: null,
      eta_seconds: null,
      started_at: Date.now()
    });

    this.emitQueue();
    this.emitJob(job.id);
    return this.repo.listChapters(job.id);
  }

  private async ensureTotalChars(jobId: string, chapters: ChapterRow[], fallback: number): Promise<number> {
    if (fallback > 0) {
      return fallback;
    }

    let totalChars = 0;
    for (const chapter of chapters) {
      const text = await fsp.readFile(chapter.text_path, "utf8");
      totalChars += text.length;
    }
    this.repo.updateJob({ id: jobId, total_chars: totalChars });
    return totalChars;
  }

  private async processChapter(job: JobRow, chapter: ChapterRow, context: ChapterProcessContext): Promise<void> {
    const { workDir, assets, etaEstimator, totalChars } = context;
    const text = await fsp.readFile(chapter.text_path, "utf8");
    const chunks = splitIntoChunks(text);

    if (chunks.length === 0) {
      this.repo.updateChapter(job.id, chapter.idx, {
        status: "encoded",
        chunk_cursor: 0,
        total_chunks: 0,
        duration_ms: 0,
        audio_path: null,
        error_message: null
      });
      return;
    }

    const chapterAudioDir = path.join(workDir, "audio", "chunks", `${chapter.idx}`);
    await fsp.mkdir(chapterAudioDir, { recursive: true });

    this.repo.updateChapter(job.id, chapter.idx, {
      status: "processing",
      total_chunks: chunks.length,
      error_message: null
    });

    const resumeCursor = Math.min(chapter.chunk_cursor, chunks.length);
    let processedChars = this.repo.getJob(job.id)?.processed_chars ?? 0;

    for (let chunkIdx = resumeCursor; chunkIdx < chunks.length; chunkIdx += 1) {
      this.checkControlFlags(job.id);

      const chunkText = chunks[chunkIdx];
      if (!chunkText) {
        continue;
      }
      const chunkPath = path.join(chapterAudioDir, `chunk_${String(chunkIdx).padStart(5, "0")}.wav`);
      const started = Date.now();

      await runPiperChunk({
        piperExe: assets.piperExe,
        voiceModel: assets.defaultVoiceModel,
        voiceConfig: assets.defaultVoiceConfig,
        text: chunkText,
        outWavPath: chunkPath,
        onSpawn: (child) => {
          this.currentChild = child;
        }
      });

      const elapsedMs = Date.now() - started;
      etaEstimator.addSample(chunkText.length, elapsedMs);
      processedChars += chunkText.length;
      const etaSeconds = etaEstimator.estimateSeconds(totalChars, processedChars);
      const progress = totalChars > 0 ? Math.min(0.96, processedChars / totalChars) : 0;

      this.repo.updateChapter(job.id, chapter.idx, {
        status: "processing",
        chunk_cursor: chunkIdx + 1,
        total_chunks: chunks.length,
        error_message: null
      });

      this.repo.updateJob({
        id: job.id,
        status: "processing",
        current_chapter_idx: chapter.idx,
        processed_chars: processedChars,
        total_chars: totalChars,
        progress,
        eta_seconds: etaSeconds,
        error_message: null
      });

      this.emitQueue();
      this.emitJob(job.id);
    }

    const chunkFiles: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      chunkFiles.push(path.join(chapterAudioDir, `chunk_${String(i).padStart(5, "0")}.wav`));
    }

    const chapterWavDir = path.join(workDir, "audio", "chapters");
    await fsp.mkdir(chapterWavDir, { recursive: true });
    const chapterWavPath = path.join(chapterWavDir, `chapter_${String(chapter.idx).padStart(5, "0")}.wav`);

    await concatWavs({
      ffmpegExe: assets.ffmpegExe,
      inputWavs: chunkFiles,
      outWavPath: chapterWavPath,
      tempDir: path.join(workDir, "tmp"),
      onSpawn: (child) => {
        this.currentChild = child;
      }
    });

    const durationMs = await getDurationMs(chapterWavPath).catch(() => 0);
    this.repo.updateChapter(job.id, chapter.idx, {
      status: "encoded",
      chunk_cursor: chunks.length,
      total_chunks: chunks.length,
      duration_ms: durationMs,
      audio_path: chapterWavPath,
      error_message: null
    });

    this.emitJob(job.id);
  }

  private async finalizeJob(job: JobRow, workDir: string, assets: RuntimeAssets): Promise<void> {
    const chapters = this.repo.listChapters(job.id);
    const chapterWavs = chapters
      .filter((chapter) => chapter.status === "encoded" && Boolean(chapter.audio_path))
      .sort((a, b) => a.idx - b.idx)
      .map((chapter) => chapter.audio_path as string);

    if (chapterWavs.length === 0) {
      throw new Error("No chapter audio generated.");
    }

    this.repo.updateJob({ id: job.id, status: "encoding", progress: 0.98, eta_seconds: null });
    this.emitQueue();
    this.emitJob(job.id);

    const mergedWavPath = path.join(workDir, "audio", "merged.wav");
    await concatWavs({
      ffmpegExe: assets.ffmpegExe,
      inputWavs: chapterWavs,
      outWavPath: mergedWavPath,
      tempDir: path.join(workDir, "tmp"),
      onSpawn: (child) => {
        this.currentChild = child;
      }
    });

    const { destinationDir, finalPath } = buildOutputPaths({
      outputDir: job.output_dir,
      title: job.title,
      author: job.author,
      format: job.output_format
    });

    await fsp.mkdir(destinationDir, { recursive: true });
    await encodeFinalAudio({
      ffmpegExe: assets.ffmpegExe,
      inputWavPath: mergedWavPath,
      outputPath: finalPath,
      format: job.output_format,
      metadata: { title: job.title, author: job.author },
      onSpawn: (child) => {
        this.currentChild = child;
      }
    });

    const durationMs = await getDurationMs(finalPath).catch(() => 0);
    const sizeBytes = Number((await fsp.stat(finalPath)).size || 0);

    this.repo.addOutput({
      jobId: job.id,
      title: job.title,
      filePath: finalPath,
      format: job.output_format,
      durationMs,
      sizeBytes
    });

    this.repo.updateJob({
      id: job.id,
      status: "done",
      progress: 1,
      eta_seconds: 0,
      completed_at: Date.now(),
      current_chapter_idx: chapters.length
    });

    this.log(job.id, "info", `Job finished: ${finalPath}`);
    this.emitGeneratedAudios();
    this.emitQueue();
    this.emitJob(job.id);

    const keepIntermediates = Boolean(this.repo.getSetting("keepIntermediates", false));
    if (!keepIntermediates) {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  private async processJob(job: JobRow): Promise<void> {
    this.currentJobId = job.id;
    this.currentChild = null;

    const assets = await this.bootstrapAssets();
    const workDir = path.join(this.appDataDir, "work", job.id);
    await fsp.mkdir(workDir, { recursive: true });

    this.log(job.id, "info", "Starting job processing.");

    const chapters = await this.ensureJobChapters(job, workDir);
    const totalChars = await this.ensureTotalChars(job.id, chapters, job.total_chars);
    const etaEstimator = new EtaEstimator();

    for (const chapter of this.repo.listChapters(job.id)) {
      if (chapter.status === "encoded") {
        continue;
      }

      this.checkControlFlags(job.id);
      await this.processChapter(job, chapter, {
        workDir,
        assets,
        etaEstimator,
        totalChars
      });
    }

    this.checkControlFlags(job.id);
    await this.finalizeJob(job, workDir, assets);
  }

  async pump(): Promise<void> {
    if (this.isPumping) {
      return;
    }

    this.isPumping = true;

    while (true) {
      const nextJob = this.repo.getNextQueuedJob();
      if (!nextJob) {
        break;
      }

      try {
        await this.processJob(nextJob);
      } catch (error: unknown) {
        const err = asError(error);
        if (err instanceof PausedError || err.code === "JOB_PAUSED") {
          this.repo.setJobPaused(nextJob.id);
          this.log(nextJob.id, "info", "Job paused.");
        } else if (err instanceof CanceledError || err.code === "JOB_CANCELED") {
          this.repo.setJobCanceled(nextJob.id);
          this.log(nextJob.id, "info", "Job canceled.");
        } else {
          this.repo.setJobError(nextJob.id, err.message || "Unexpected error");
          this.log(nextJob.id, "error", err.stack || err.message || String(err));
        }

        this.emitQueue();
        this.emitJob(nextJob.id);
      } finally {
        this.pauseRequested.delete(nextJob.id);
        this.cancelRequested.delete(nextJob.id);
        this.currentChild = null;
        this.currentJobId = null;
      }
    }

    this.isPumping = false;
  }
}

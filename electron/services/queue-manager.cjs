const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { extractEpub } = require("./epub-extractor.cjs");
const { splitIntoChunks } = require("./text-utils.cjs");
const { EtaEstimator } = require("./eta-estimator.cjs");
const { killChild } = require("./process-utils.cjs");
const {
  runPiperChunk,
  concatWavs,
  encodeFinalAudio,
  getDurationMs,
  buildOutputPaths
} = require("./audio-runner.cjs");

class PausedError extends Error {
  constructor() {
    super("Paused by user");
    this.code = "JOB_PAUSED";
  }
}

class CanceledError extends Error {
  constructor() {
    super("Canceled by user");
    this.code = "JOB_CANCELED";
  }
}

function isEpubPath(filePath) {
  return typeof filePath === "string" && filePath.toLowerCase().endsWith(".epub");
}

class QueueManager extends EventEmitter {
  constructor(options) {
    super();
    this.repo = options.repo;
    this.appDataDir = options.appDataDir;
    this.ensureRuntimeAssets = options.ensureRuntimeAssets;

    this.isPumping = false;
    this.currentJobId = null;
    this.currentChild = null;
    this.pauseRequested = new Set();
    this.cancelRequested = new Set();

    this.runtimeAssets = null;
    this.runtimeAssetsPromise = null;
  }

  async initialize() {
    this.repo.recoverInterruptedWork();
    this.emitQueue();
    this.emitGeneratedAudios();
    void this.pump();
  }

  async bootstrapAssets() {
    if (this.runtimeAssets) {
      return this.runtimeAssets;
    }

    if (!this.runtimeAssetsPromise) {
      this.runtimeAssetsPromise = this.ensureRuntimeAssets({
        appDataDir: this.appDataDir,
        onStatus: (status) => this.emit("bootstrapStatusUpdated", status)
      })
        .then((result) => {
          this.runtimeAssets = result;
          this.emit("bootstrapStatusUpdated", {
            phase: "ready",
            message: `Runtime assets ready (${result.source}).`
          });
          return result;
        })
        .catch((error) => {
          this.emit("bootstrapStatusUpdated", {
            phase: "error",
            message: error.message
          });
          throw error;
        })
        .finally(() => {
          this.runtimeAssetsPromise = null;
        });
    }

    return this.runtimeAssetsPromise;
  }

  emitQueue() {
    this.emit("queueUpdated", this.repo.listJobs());
  }

  emitGeneratedAudios() {
    this.emit("generatedUpdated", this.repo.listOutputs());
  }

  emitJob(jobId) {
    const detail = this.repo.getJobDetail(jobId);
    if (detail) {
      this.emit("jobUpdated", detail);
    }
  }

  log(jobId, level, message) {
    this.repo.addLog(jobId, level, message);
    this.emit("logEvent", { jobId, level, message, ts: Date.now() });
  }

  getSettings() {
    return this.repo.getSettings();
  }

  setSettings(patch) {
    const settings = this.repo.setSettings(patch);
    this.emit("settingsUpdated", settings);
    return settings;
  }

  listJobs() {
    return this.repo.listJobs();
  }

  listGeneratedAudios() {
    return this.repo.listOutputs();
  }

  getGeneratedAudio(outputId) {
    return this.repo.getOutput(outputId);
  }

  getGeneratedAudiosByJob(jobId) {
    return this.repo.getOutputsByJob(jobId);
  }

  getJob(jobId) {
    return this.repo.getJobDetail(jobId);
  }

  async enqueueEpubFiles(filePaths) {
    const validPaths = filePaths.filter(isEpubPath);
    if (validPaths.length === 0) {
      throw new Error("Only .epub files are supported.");
    }

    const settings = this.repo.getSettings();
    const rows = this.repo.enqueueEpubFiles(validPaths, {
      voiceId: settings.defaultVoiceId || "es_ES-davefx-medium",
      outputFormat: settings.defaultOutputFormat || "mp3",
      outputDir: settings.defaultOutputDir,
      jobSettings: {
        keepIntermediates: Boolean(settings.keepIntermediates)
      }
    });

    this.emitQueue();
    void this.pump();
    return rows;
  }

  reorderQueue(jobIdsInOrder) {
    this.repo.reorderQueue(jobIdsInOrder);
    this.emitQueue();
  }

  pauseJob(jobId) {
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

  resumeJob(jobId) {
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

  cancelJob(jobId) {
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

  deleteJob(jobId) {
    if (this.currentJobId === jobId) {
      throw new Error("Cannot delete an actively processing job.");
    }

    this.repo.deleteJob(jobId);
    this.emitQueue();
    this.emitGeneratedAudios();
  }

  checkControlFlags(jobId) {
    if (this.cancelRequested.has(jobId)) {
      throw new CanceledError();
    }
    if (this.pauseRequested.has(jobId)) {
      throw new PausedError();
    }
  }

  async ensureJobChapters(job, workDir) {
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

  async ensureTotalChars(jobId, chapters, fallback) {
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

  async processChapter(job, chapter, context) {
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
    let processedChars = this.repo.getJob(job.id).processed_chars;

    for (let chunkIdx = resumeCursor; chunkIdx < chunks.length; chunkIdx += 1) {
      this.checkControlFlags(job.id);

      const chunkText = chunks[chunkIdx];
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

    const chunkFiles = [];
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

  async finalizeJob(job, workDir, assets) {
    const chapters = this.repo.listChapters(job.id);
    const chapterWavs = chapters
      .filter((chapter) => chapter.status === "encoded" && chapter.audio_path)
      .sort((a, b) => a.idx - b.idx)
      .map((chapter) => chapter.audio_path);

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

  async processJob(job) {
    this.currentJobId = job.id;
    this.currentChild = null;

    const assets = await this.bootstrapAssets();
    const workDir = path.join(this.appDataDir, "work", job.id);
    await fsp.mkdir(workDir, { recursive: true });

    this.log(job.id, "info", "Starting job processing.");

    const chapters = await this.ensureJobChapters(job, workDir);
    const totalChars = await this.ensureTotalChars(job.id, chapters, job.total_chars);
    const etaEstimator = new EtaEstimator();

    const latestJob = this.repo.getJob(job.id);
    if (latestJob.processed_chars > 0 && totalChars > 0) {
      etaEstimator.addSample(latestJob.processed_chars, Math.max(1, (Date.now() - latestJob.created_at)));
    }

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

  async pump() {
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
      } catch (error) {
        if (error instanceof PausedError || error.code === "JOB_PAUSED") {
          this.repo.setJobPaused(nextJob.id);
          this.log(nextJob.id, "info", "Job paused.");
        } else if (error instanceof CanceledError || error.code === "JOB_CANCELED") {
          this.repo.setJobCanceled(nextJob.id);
          this.log(nextJob.id, "info", "Job canceled.");
        } else {
          this.repo.setJobError(nextJob.id, error.message || "Unexpected error");
          this.log(nextJob.id, "error", error.stack || error.message || String(error));
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

module.exports = {
  QueueManager
};

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

function nowTs() {
  return Date.now();
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

class Repository {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    this.db.exec(schema);

    this.initSettingsStmt = this.db.prepare(
      "INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (@key, @value_json, @updated_at)"
    );
    this.getSettingStmt = this.db.prepare("SELECT value_json FROM settings WHERE key = ?");
    this.setSettingStmt = this.db.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (@key, @value_json, @updated_at)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
    );

    this.insertJobStmt = this.db.prepare(
      `INSERT INTO jobs (
        id, source_path, source_name, title, author, status, progress, queue_position,
        voice_id, output_format, output_dir, error_message, current_chapter_idx,
        eta_seconds, total_chars, processed_chars, settings_json, created_at, updated_at
      ) VALUES (
        @id, @source_path, @source_name, @title, @author, @status, @progress, @queue_position,
        @voice_id, @output_format, @output_dir, @error_message, @current_chapter_idx,
        @eta_seconds, @total_chars, @processed_chars, @settings_json, @created_at, @updated_at
      )`
    );

    this.maxQueuePosStmt = this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS max_pos FROM jobs");

    this.listJobsStmt = this.db.prepare(
      `SELECT * FROM jobs
       ORDER BY
         CASE status
           WHEN 'processing' THEN 0
           WHEN 'extracting' THEN 1
           WHEN 'encoding' THEN 2
           WHEN 'queued' THEN 3
           WHEN 'paused' THEN 4
           WHEN 'error' THEN 5
           WHEN 'canceled' THEN 6
           ELSE 7
         END,
         queue_position ASC,
         created_at ASC`
    );

    this.getJobStmt = this.db.prepare("SELECT * FROM jobs WHERE id = ?");
    this.getChaptersStmt = this.db.prepare("SELECT * FROM chapters WHERE job_id = ? ORDER BY idx ASC");

    this.updateJobFieldsStmt = this.db.prepare(
      `UPDATE jobs SET
        status = COALESCE(@status, status),
        progress = COALESCE(@progress, progress),
        error_message = @error_message,
        current_chapter_idx = COALESCE(@current_chapter_idx, current_chapter_idx),
        eta_seconds = @eta_seconds,
        total_chars = COALESCE(@total_chars, total_chars),
        processed_chars = COALESCE(@processed_chars, processed_chars),
        settings_json = COALESCE(@settings_json, settings_json),
        started_at = COALESCE(@started_at, started_at),
        completed_at = COALESCE(@completed_at, completed_at),
        updated_at = @updated_at
      WHERE id = @id`
    );

    this.nextQueuedStmt = this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC LIMIT 1"
    );

    this.deleteJobStmt = this.db.prepare("DELETE FROM jobs WHERE id = ?");
    this.insertChapterStmt = this.db.prepare(
      `INSERT INTO chapters (
        id, job_id, idx, title, text_path, status, chunk_cursor, total_chunks,
        duration_ms, audio_path, error_message, created_at, updated_at
      ) VALUES (
        @id, @job_id, @idx, @title, @text_path, @status, @chunk_cursor, @total_chunks,
        @duration_ms, @audio_path, @error_message, @created_at, @updated_at
      )`
    );

    this.deleteChaptersForJobStmt = this.db.prepare("DELETE FROM chapters WHERE job_id = ?");
    this.updateChapterStmt = this.db.prepare(
      `UPDATE chapters SET
        status = COALESCE(@status, status),
        chunk_cursor = COALESCE(@chunk_cursor, chunk_cursor),
        total_chunks = COALESCE(@total_chunks, total_chunks),
        duration_ms = COALESCE(@duration_ms, duration_ms),
        audio_path = COALESCE(@audio_path, audio_path),
        error_message = @error_message,
        updated_at = @updated_at
      WHERE job_id = @job_id AND idx = @idx`
    );

    this.insertOutputStmt = this.db.prepare(
      `INSERT INTO outputs (id, job_id, title, file_path, format, duration_ms, size_bytes, created_at)
       VALUES (@id, @job_id, @title, @file_path, @format, @duration_ms, @size_bytes, @created_at)`
    );

    this.listOutputsStmt = this.db.prepare("SELECT * FROM outputs ORDER BY created_at DESC");
    this.getOutputStmt = this.db.prepare("SELECT * FROM outputs WHERE id = ?");
    this.getOutputsByJobStmt = this.db.prepare("SELECT * FROM outputs WHERE job_id = ?");

    this.insertLogStmt = this.db.prepare(
      "INSERT INTO logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)"
    );

    this.recoverJobsStmt = this.db.prepare(
      "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status IN ('extracting', 'processing', 'encoding')"
    );

    this.recoverChaptersStmt = this.db.prepare(
      "UPDATE chapters SET status = 'queued', updated_at = ? WHERE status = 'processing'"
    );
  }

  close() {
    this.db.close();
  }

  ensureDefaults(defaults) {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      Object.entries(defaults).forEach(([key, value]) => {
        this.initSettingsStmt.run({ key, value_json: JSON.stringify(value), updated_at: ts });
      });
    });
    tx();
  }

  getSettings() {
    const rows = this.db.prepare("SELECT key, value_json FROM settings").all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = safeJsonParse(row.value_json, null);
    }
    return settings;
  }

  setSettings(patch) {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      Object.entries(patch).forEach(([key, value]) => {
        this.setSettingStmt.run({ key, value_json: JSON.stringify(value), updated_at: ts });
      });
    });
    tx();
    return this.getSettings();
  }

  getSetting(key, fallback) {
    const row = this.getSettingStmt.get(key);
    if (!row) {
      return fallback;
    }
    return safeJsonParse(row.value_json, fallback);
  }

  recoverInterruptedWork() {
    const ts = nowTs();
    this.recoverJobsStmt.run(ts);
    this.recoverChaptersStmt.run(ts);
  }

  nextQueuePosition() {
    return Number(this.maxQueuePosStmt.get().max_pos || 0) + 1;
  }

  enqueueEpubFiles(paths, options) {
    const ts = nowTs();
    const startPos = this.nextQueuePosition();
    const rows = [];

    const tx = this.db.transaction(() => {
      paths.forEach((sourcePath, index) => {
        const sourceName = path.basename(sourcePath);
        const title = sourceName.replace(/\.epub$/i, "");
        const id = crypto.randomUUID();
        const row = {
          id,
          source_path: sourcePath,
          source_name: sourceName,
          title,
          author: null,
          status: "queued",
          progress: 0,
          queue_position: startPos + index,
          voice_id: options.voiceId,
          output_format: options.outputFormat,
          output_dir: options.outputDir,
          error_message: null,
          current_chapter_idx: 0,
          eta_seconds: null,
          total_chars: 0,
          processed_chars: 0,
          settings_json: JSON.stringify(options.jobSettings || {}),
          created_at: ts,
          updated_at: ts
        };
        this.insertJobStmt.run(row);
        rows.push(row);
      });
    });

    tx();
    return rows;
  }

  reorderQueue(jobIdsInOrder) {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      jobIdsInOrder.forEach((jobId, idx) => {
        this.db
          .prepare("UPDATE jobs SET queue_position = ?, updated_at = ? WHERE id = ?")
          .run(idx + 1, ts, jobId);
      });
    });
    tx();
  }

  listJobs() {
    return this.listJobsStmt.all();
  }

  getJob(jobId) {
    return this.getJobStmt.get(jobId) || null;
  }

  getJobDetail(jobId) {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }
    const chapters = this.getChaptersStmt.all(jobId);
    return { ...job, chapters };
  }

  getNextQueuedJob() {
    return this.nextQueuedStmt.get() || null;
  }

  updateJob(patch) {
    this.updateJobFieldsStmt.run({
      id: patch.id,
      status: patch.status ?? null,
      progress: patch.progress ?? null,
      error_message: patch.error_message ?? null,
      current_chapter_idx: patch.current_chapter_idx ?? null,
      eta_seconds: patch.eta_seconds ?? null,
      total_chars: patch.total_chars ?? null,
      processed_chars: patch.processed_chars ?? null,
      settings_json: patch.settings_json ? JSON.stringify(patch.settings_json) : null,
      started_at: patch.started_at ?? null,
      completed_at: patch.completed_at ?? null,
      updated_at: nowTs()
    });
  }

  setJobError(jobId, message) {
    this.updateJob({ id: jobId, status: "error", error_message: message, eta_seconds: null });
  }

  setJobPaused(jobId) {
    this.updateJob({ id: jobId, status: "paused", eta_seconds: null });
  }

  setJobCanceled(jobId) {
    this.updateJob({ id: jobId, status: "canceled", eta_seconds: null, completed_at: nowTs() });
  }

  replaceChapters(jobId, chapters) {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      this.deleteChaptersForJobStmt.run(jobId);
      chapters.forEach((chapter, idx) => {
        this.insertChapterStmt.run({
          id: crypto.randomUUID(),
          job_id: jobId,
          idx,
          title: chapter.title,
          text_path: chapter.textPath,
          status: "queued",
          chunk_cursor: 0,
          total_chunks: 0,
          duration_ms: null,
          audio_path: null,
          error_message: null,
          created_at: ts,
          updated_at: ts
        });
      });
    });
    tx();
  }

  listChapters(jobId) {
    return this.getChaptersStmt.all(jobId);
  }

  updateChapter(jobId, idx, patch) {
    this.updateChapterStmt.run({
      job_id: jobId,
      idx,
      status: patch.status ?? null,
      chunk_cursor: patch.chunk_cursor ?? null,
      total_chunks: patch.total_chunks ?? null,
      duration_ms: patch.duration_ms ?? null,
      audio_path: patch.audio_path ?? null,
      error_message: patch.error_message ?? null,
      updated_at: nowTs()
    });
  }

  addOutput(output) {
    this.insertOutputStmt.run({
      id: crypto.randomUUID(),
      job_id: output.jobId,
      title: output.title,
      file_path: output.filePath,
      format: output.format,
      duration_ms: output.durationMs,
      size_bytes: output.sizeBytes,
      created_at: nowTs()
    });
  }

  listOutputs() {
    return this.listOutputsStmt.all();
  }

  getOutput(outputId) {
    return this.getOutputStmt.get(outputId) || null;
  }

  getOutputsByJob(jobId) {
    return this.getOutputsByJobStmt.all(jobId);
  }

  addLog(jobId, level, message) {
    this.insertLogStmt.run(jobId, nowTs(), level, message);
  }

  deleteJob(jobId) {
    this.deleteJobStmt.run(jobId);
  }
}

module.exports = {
  Repository
};

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type {
  AppSettings,
  ChapterExtraction,
  ChapterRow,
  ChapterStatus,
  JobDetail,
  JobRow,
  JobStatus,
  OutputFormat,
  OutputRow
} from "../types";

type JsonRecord = Record<string, unknown>;

type PreparedStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

interface DatabaseHandle {
  prepare: (sql: string) => unknown;
  exec: (sql: string) => void;
  pragma: (sql: string) => void;
  transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => T;
  close: () => void;
}

interface JobPatch {
  id: string;
  status?: JobStatus | null;
  progress?: number | null;
  error_message?: string | null;
  current_chapter_idx?: number | null;
  eta_seconds?: number | null;
  total_chars?: number | null;
  processed_chars?: number | null;
  settings_json?: JsonRecord | null;
  started_at?: number | null;
  completed_at?: number | null;
}

interface ChapterPatch {
  status?: ChapterStatus | null;
  chunk_cursor?: number | null;
  total_chunks?: number | null;
  duration_ms?: number | null;
  audio_path?: string | null;
  error_message?: string | null;
}

interface EnqueueOptions {
  voiceId: string;
  outputFormat: OutputFormat;
  outputDir: string;
  jobSettings?: JsonRecord;
}

interface OutputInsert {
  jobId: string;
  title: string;
  filePath: string;
  format: OutputFormat;
  durationMs: number;
  sizeBytes: number;
}

function nowTs(): number {
  return Date.now();
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asStatement(stmt: unknown): PreparedStatement {
  return stmt as PreparedStatement;
}

function asJobRow(row: unknown): JobRow | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  return row as JobRow;
}

function asChapterRows(rows: unknown[]): ChapterRow[] {
  return rows as ChapterRow[];
}

function asOutputRows(rows: unknown[]): OutputRow[] {
  return rows as OutputRow[];
}

export class Repository {
  private readonly db: DatabaseHandle;

  private readonly initSettingsStmt: PreparedStatement;
  private readonly getSettingStmt: PreparedStatement;
  private readonly setSettingStmt: PreparedStatement;

  private readonly insertJobStmt: PreparedStatement;
  private readonly maxQueuePosStmt: PreparedStatement;
  private readonly listJobsStmt: PreparedStatement;
  private readonly getJobStmt: PreparedStatement;
  private readonly getChaptersStmt: PreparedStatement;
  private readonly updateJobFieldsStmt: PreparedStatement;
  private readonly nextQueuedStmt: PreparedStatement;
  private readonly deleteJobStmt: PreparedStatement;

  private readonly insertChapterStmt: PreparedStatement;
  private readonly deleteChaptersForJobStmt: PreparedStatement;
  private readonly updateChapterStmt: PreparedStatement;

  private readonly insertOutputStmt: PreparedStatement;
  private readonly listOutputsStmt: PreparedStatement;
  private readonly getOutputStmt: PreparedStatement;
  private readonly getOutputsByJobStmt: PreparedStatement;
  private readonly deleteOutputStmt: PreparedStatement;

  private readonly insertLogStmt: PreparedStatement;
  private readonly recoverJobsStmt: PreparedStatement;
  private readonly recoverChaptersStmt: PreparedStatement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    this.db.exec(schema);

    this.initSettingsStmt = asStatement(
      this.db.prepare("INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (@key, @value_json, @updated_at)")
    );
    this.getSettingStmt = asStatement(this.db.prepare("SELECT value_json FROM settings WHERE key = ?"));
    this.setSettingStmt = asStatement(
      this.db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (@key, @value_json, @updated_at)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
      )
    );

    this.insertJobStmt = asStatement(
      this.db.prepare(
        `INSERT INTO jobs (
          id, source_path, source_name, title, author, status, progress, queue_position,
          voice_id, output_format, output_dir, error_message, current_chapter_idx,
          eta_seconds, total_chars, processed_chars, settings_json, created_at, updated_at
        ) VALUES (
          @id, @source_path, @source_name, @title, @author, @status, @progress, @queue_position,
          @voice_id, @output_format, @output_dir, @error_message, @current_chapter_idx,
          @eta_seconds, @total_chars, @processed_chars, @settings_json, @created_at, @updated_at
        )`
      )
    );

    this.maxQueuePosStmt = asStatement(this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS max_pos FROM jobs"));

    this.listJobsStmt = asStatement(
      this.db.prepare(
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
      )
    );

    this.getJobStmt = asStatement(this.db.prepare("SELECT * FROM jobs WHERE id = ?"));
    this.getChaptersStmt = asStatement(this.db.prepare("SELECT * FROM chapters WHERE job_id = ? ORDER BY idx ASC"));

    this.updateJobFieldsStmt = asStatement(
      this.db.prepare(
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
      )
    );

    this.nextQueuedStmt = asStatement(
      this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC LIMIT 1")
    );

    this.deleteJobStmt = asStatement(this.db.prepare("DELETE FROM jobs WHERE id = ?"));
    this.insertChapterStmt = asStatement(
      this.db.prepare(
        `INSERT INTO chapters (
          id, job_id, idx, title, text_path, status, chunk_cursor, total_chunks,
          duration_ms, audio_path, error_message, created_at, updated_at
        ) VALUES (
          @id, @job_id, @idx, @title, @text_path, @status, @chunk_cursor, @total_chunks,
          @duration_ms, @audio_path, @error_message, @created_at, @updated_at
        )`
      )
    );

    this.deleteChaptersForJobStmt = asStatement(this.db.prepare("DELETE FROM chapters WHERE job_id = ?"));
    this.updateChapterStmt = asStatement(
      this.db.prepare(
        `UPDATE chapters SET
          status = COALESCE(@status, status),
          chunk_cursor = COALESCE(@chunk_cursor, chunk_cursor),
          total_chunks = COALESCE(@total_chunks, total_chunks),
          duration_ms = COALESCE(@duration_ms, duration_ms),
          audio_path = COALESCE(@audio_path, audio_path),
          error_message = @error_message,
          updated_at = @updated_at
        WHERE job_id = @job_id AND idx = @idx`
      )
    );

    this.insertOutputStmt = asStatement(
      this.db.prepare(
        `INSERT INTO outputs (id, job_id, title, file_path, format, duration_ms, size_bytes, created_at)
         VALUES (@id, @job_id, @title, @file_path, @format, @duration_ms, @size_bytes, @created_at)`
      )
    );

    this.listOutputsStmt = asStatement(this.db.prepare("SELECT * FROM outputs ORDER BY created_at DESC"));
    this.getOutputStmt = asStatement(this.db.prepare("SELECT * FROM outputs WHERE id = ?"));
    this.getOutputsByJobStmt = asStatement(this.db.prepare("SELECT * FROM outputs WHERE job_id = ?"));
    this.deleteOutputStmt = asStatement(this.db.prepare("DELETE FROM outputs WHERE id = ?"));

    this.insertLogStmt = asStatement(this.db.prepare("INSERT INTO logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)"));

    this.recoverJobsStmt = asStatement(
      this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status IN ('extracting', 'processing', 'encoding')")
    );

    this.recoverChaptersStmt = asStatement(
      this.db.prepare("UPDATE chapters SET status = 'queued', updated_at = ? WHERE status = 'processing'")
    );
  }

  close(): void {
    this.db.close();
  }

  ensureDefaults(defaults: Partial<AppSettings>): void {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      Object.entries(defaults).forEach(([key, value]) => {
        this.initSettingsStmt.run({ key, value_json: JSON.stringify(value), updated_at: ts });
      });
    });
    tx();
  }

  getSettings(): Partial<AppSettings> {
    const rows = asStatement(this.db.prepare("SELECT key, value_json FROM settings")).all() as Array<{
      key: string;
      value_json: string;
    }>;
    const settings: Partial<AppSettings> = {};
    for (const row of rows) {
      const value = safeJsonParse<unknown>(row.value_json, null);
      if (row.key === "defaultOutputDir" && typeof value === "string") {
        settings.defaultOutputDir = value;
      }
      if (row.key === "defaultVoiceId" && typeof value === "string") {
        settings.defaultVoiceId = value;
      }
      if (row.key === "defaultOutputFormat" && (value === "mp3" || value === "m4b")) {
        settings.defaultOutputFormat = value;
      }
      if (row.key === "keepIntermediates" && typeof value === "boolean") {
        settings.keepIntermediates = value;
      }
      if (row.key === "maxConcurrentJobs" && typeof value === "number") {
        settings.maxConcurrentJobs = value;
      }
    }
    return settings;
  }

  setSettings(patch: Partial<AppSettings>): Partial<AppSettings> {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      Object.entries(patch).forEach(([key, value]) => {
        this.setSettingStmt.run({ key, value_json: JSON.stringify(value), updated_at: ts });
      });
    });
    tx();
    return this.getSettings();
  }

  getSetting<T>(key: keyof AppSettings | string, fallback: T): T {
    const row = this.getSettingStmt.get(key) as { value_json: string } | undefined;
    if (!row) {
      return fallback;
    }
    return safeJsonParse(row.value_json, fallback);
  }

  recoverInterruptedWork(): void {
    const ts = nowTs();
    this.recoverJobsStmt.run(ts);
    this.recoverChaptersStmt.run(ts);
  }

  nextQueuePosition(): number {
    const row = this.maxQueuePosStmt.get() as { max_pos: number | null };
    return Number(row.max_pos ?? 0) + 1;
  }

  enqueueEpubFiles(paths: string[], options: EnqueueOptions): JobRow[] {
    const ts = nowTs();
    const startPos = this.nextQueuePosition();
    const rows: JobRow[] = [];

    const tx = this.db.transaction(() => {
      paths.forEach((sourcePath, index) => {
        const sourceName = path.basename(sourcePath);
        const title = sourceName.replace(/\.epub$/i, "");
        const id = crypto.randomUUID();
        const row: JobRow = {
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
          settings_json: JSON.stringify(options.jobSettings ?? {}),
          created_at: ts,
          updated_at: ts,
          started_at: null,
          completed_at: null
        };
        this.insertJobStmt.run(row);
        rows.push(row);
      });
    });

    tx();
    return rows;
  }

  reorderQueue(jobIdsInOrder: string[]): void {
    const ts = nowTs();
    const tx = this.db.transaction(() => {
      jobIdsInOrder.forEach((jobId, idx) => {
        asStatement(this.db.prepare("UPDATE jobs SET queue_position = ?, updated_at = ? WHERE id = ?")).run(
          idx + 1,
          ts,
          jobId
        );
      });
    });
    tx();
  }

  listJobs(): JobRow[] {
    return this.listJobsStmt.all() as JobRow[];
  }

  getJob(jobId: string): JobRow | null {
    return asJobRow(this.getJobStmt.get(jobId));
  }

  getJobDetail(jobId: string): JobDetail | null {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }
    const chapters = this.getChaptersStmt.all(jobId) as ChapterRow[];
    return { ...job, chapters };
  }

  getNextQueuedJob(): JobRow | null {
    return asJobRow(this.nextQueuedStmt.get());
  }

  updateJob(patch: JobPatch): void {
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

  setJobError(jobId: string, message: string): void {
    this.updateJob({ id: jobId, status: "error", error_message: message, eta_seconds: null });
  }

  setJobPaused(jobId: string): void {
    this.updateJob({ id: jobId, status: "paused", eta_seconds: null });
  }

  setJobCanceled(jobId: string): void {
    this.updateJob({ id: jobId, status: "canceled", eta_seconds: null, completed_at: nowTs() });
  }

  replaceChapters(jobId: string, chapters: ChapterExtraction[]): void {
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

  listChapters(jobId: string): ChapterRow[] {
    return asChapterRows(this.getChaptersStmt.all(jobId));
  }

  updateChapter(jobId: string, idx: number, patch: ChapterPatch): void {
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

  addOutput(output: OutputInsert): void {
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

  listOutputs(): OutputRow[] {
    return asOutputRows(this.listOutputsStmt.all());
  }

  getOutput(outputId: string): OutputRow | null {
    const row = this.getOutputStmt.get(outputId) as OutputRow | undefined;
    return row ?? null;
  }

  getOutputsByJob(jobId: string): OutputRow[] {
    return asOutputRows(this.getOutputsByJobStmt.all(jobId));
  }

  deleteOutput(outputId: string): void {
    this.deleteOutputStmt.run(outputId);
  }

  addLog(jobId: string, level: string, message: string): void {
    this.insertLogStmt.run(jobId, nowTs(), level, message);
  }

  deleteJob(jobId: string): void {
    this.deleteJobStmt.run(jobId);
  }
}

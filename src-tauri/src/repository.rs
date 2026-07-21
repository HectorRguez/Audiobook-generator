use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

use crate::models::{
    AppSettings, Chapter, ChapterExtraction, ChapterForUi, GeneratedAudio, JobDetail, QueueJob,
    DEFAULT_VOICE_ID,
};

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_name TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  queue_position INTEGER NOT NULL,
  voice_id TEXT NOT NULL,
  output_format TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  error_message TEXT,
  current_chapter_idx INTEGER NOT NULL DEFAULT 0,
  eta_seconds INTEGER,
  total_chars INTEGER NOT NULL DEFAULT 0,
  processed_chars INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  source_fingerprint TEXT,
  narration_language TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_position ON jobs(queue_position);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  text_path TEXT NOT NULL,
  status TEXT NOT NULL,
  chunk_cursor INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  audio_path TEXT,
  error_message TEXT,
  plan_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE(job_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_chapters_job ON chapters(job_id);

CREATE TABLE IF NOT EXISTS outputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  format TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outputs_created ON outputs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_logs_job_ts ON logs(job_id, ts DESC);
"#;

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !names.iter().any(|name| name == column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn row_to_job(row: &Row<'_>) -> rusqlite::Result<QueueJob> {
    Ok(QueueJob {
        id: row.get("id")?,
        source_path: row.get("source_path")?,
        source_name: row.get("source_name")?,
        title: row.get("title")?,
        author: row.get("author")?,
        status: row.get("status")?,
        progress: row.get("progress")?,
        queue_position: row.get("queue_position")?,
        voice_id: row.get("voice_id")?,
        output_format: row.get("output_format")?,
        output_dir: row.get("output_dir")?,
        error_message: row.get("error_message")?,
        current_chapter_idx: row.get("current_chapter_idx")?,
        eta_seconds: row.get("eta_seconds")?,
        total_chars: row.get("total_chars")?,
        processed_chars: row.get("processed_chars")?,
        settings_json: row.get("settings_json")?,
        source_fingerprint: row.get("source_fingerprint")?,
        narration_language: row.get("narration_language")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
    })
}

fn row_to_chapter(row: &Row<'_>) -> rusqlite::Result<Chapter> {
    Ok(Chapter {
        id: row.get("id")?,
        job_id: row.get("job_id")?,
        idx: row.get("idx")?,
        title: row.get("title")?,
        text_path: row.get("text_path")?,
        status: row.get("status")?,
        chunk_cursor: row.get("chunk_cursor")?,
        total_chunks: row.get("total_chunks")?,
        duration_ms: row.get("duration_ms")?,
        audio_path: row.get("audio_path")?,
        error_message: row.get("error_message")?,
        plan_fingerprint: row.get("plan_fingerprint")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_output(row: &Row<'_>) -> rusqlite::Result<GeneratedAudio> {
    Ok(GeneratedAudio {
        id: row.get("id")?,
        job_id: row.get("job_id")?,
        title: row.get("title")?,
        file_path: row.get("file_path")?,
        format: row.get("format")?,
        duration_ms: row.get("duration_ms")?,
        size_bytes: row.get("size_bytes")?,
        created_at: row.get("created_at")?,
    })
}

#[derive(Debug)]
pub struct Repository {
    db_path: PathBuf,
    default_output_dir: PathBuf,
}

impl Repository {
    pub fn new(db_path: PathBuf, default_output_dir: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let repo = Self {
            db_path,
            default_output_dir,
        };
        repo.with_conn(|conn| {
            conn.execute_batch(SCHEMA)?;
            ensure_column(conn, "jobs", "source_fingerprint", "TEXT")?;
            ensure_column(conn, "jobs", "narration_language", "TEXT")?;
            ensure_column(conn, "chapters", "plan_fingerprint", "TEXT")?;
            Ok(())
        })?;
        repo.ensure_defaults()?;
        repo.recover_interrupted_work()?;
        Ok(repo)
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = Connection::open(&self.db_path)
            .with_context(|| format!("Failed to open {}", self.db_path.display()))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        f(&conn)
    }

    pub fn ensure_defaults(&self) -> Result<()> {
        let defaults = [
            (
                "defaultOutputDir",
                Value::String(self.default_output_dir.to_string_lossy().to_string()),
            ),
            (
                "defaultVoiceId",
                Value::String(DEFAULT_VOICE_ID.to_string()),
            ),
            ("defaultOutputFormat", Value::String("mp3".to_string())),
            ("keepIntermediates", Value::Bool(false)),
            ("maxConcurrentJobs", Value::Number(1.into())),
        ];
        self.with_conn(|conn| {
            let ts = now_ts();
            for (key, value) in defaults {
                conn.execute(
          "INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
          params![key, value.to_string(), ts],
        )?;
            }
            conn.execute(
                "UPDATE settings SET value_json = ?1, updated_at = ?2
                 WHERE key = 'defaultVoiceId' AND value_json IN (?3, ?4)",
                params![
                    Value::String(DEFAULT_VOICE_ID.to_string()).to_string(),
                    ts,
                    Value::String("es_ES-carlfm-high".to_string()).to_string(),
                    Value::String("es_ES-miro-high".to_string()).to_string(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn recover_interrupted_work(&self) -> Result<()> {
        self.with_conn(|conn| {
      let ts = now_ts();
      conn.execute(
        "UPDATE jobs SET status = 'queued', updated_at = ?1 WHERE status IN ('extracting', 'processing', 'encoding')",
        params![ts],
      )?;
      conn.execute(
        "UPDATE chapters SET status = 'queued', updated_at = ?1 WHERE status = 'processing'",
        params![ts],
      )?;
      Ok(())
    })
    }

    pub fn get_settings(&self) -> Result<AppSettings> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT key, value_json FROM settings")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut settings = AppSettings::default();
            for row in rows {
                let (key, raw) = row?;
                let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                match (key.as_str(), value) {
                    ("defaultOutputDir", Value::String(value)) => {
                        settings.default_output_dir = Some(value)
                    }
                    ("defaultVoiceId", Value::String(value)) => {
                        settings.default_voice_id = Some(value)
                    }
                    ("defaultOutputFormat", Value::String(value)) => {
                        settings.default_output_format = Some(value)
                    }
                    ("keepIntermediates", Value::Bool(value)) => {
                        settings.keep_intermediates = Some(value)
                    }
                    ("maxConcurrentJobs", Value::Number(value)) => {
                        settings.max_concurrent_jobs = value.as_i64()
                    }
                    _ => {}
                }
            }
            Ok(settings)
        })
    }

    pub fn set_settings(&self, patch: AppSettings) -> Result<AppSettings> {
        self.with_conn(|conn| {
      let ts = now_ts();
            let set = |key: &str, value: Value| -> Result<()> {
        conn.execute(
          "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
          params![key, value.to_string(), ts],
        )?;
        Ok(())
      };
      if let Some(value) = patch.default_output_dir {
        set("defaultOutputDir", Value::String(value))?;
      }
      if let Some(value) = patch.default_voice_id {
        set("defaultVoiceId", Value::String(value))?;
      }
      if let Some(value) = patch.default_output_format {
        set("defaultOutputFormat", Value::String(value))?;
      }
      if let Some(value) = patch.keep_intermediates {
        set("keepIntermediates", Value::Bool(value))?;
      }
      if let Some(value) = patch.max_concurrent_jobs {
        set("maxConcurrentJobs", Value::Number(value.into()))?;
      }
      Ok(())
    })?;
        self.get_settings()
    }

    pub fn next_queue_position(&self) -> Result<i64> {
        self.with_conn(|conn| {
            let value: i64 = conn.query_row(
                "SELECT COALESCE(MAX(queue_position), 0) + 1 FROM jobs",
                [],
                |row| row.get(0),
            )?;
            Ok(value)
        })
    }

    pub fn enqueue_epub_files(&self, paths: &[String]) -> Result<Vec<QueueJob>> {
        let settings = self.get_settings()?;
        let start_pos = self.next_queue_position()?;
        self.with_conn(|conn| {
      let ts = now_ts();
      let mut rows = Vec::new();
      for (index, source_path) in paths.iter().filter(|path| path.to_lowercase().ends_with(".epub")).enumerate() {
        let source = Path::new(source_path);
        let source_name = source
          .file_name()
          .and_then(|value| value.to_str())
          .unwrap_or("book.epub")
          .to_string();
        let title = source_name.trim_end_matches(".epub").to_string();
        let id = Uuid::new_v4().to_string();
        let row = QueueJob {
          id,
          source_path: source_path.clone(),
          source_name,
          title,
          author: None,
          status: "queued".to_string(),
          progress: 0.0,
          queue_position: start_pos + index as i64,
          voice_id: settings.default_voice_id.clone().unwrap_or_else(|| DEFAULT_VOICE_ID.to_string()),
          output_format: settings.default_output_format.clone().unwrap_or_else(|| "mp3".to_string()),
          output_dir: settings
            .default_output_dir
            .clone()
            .unwrap_or_else(|| self.default_output_dir.to_string_lossy().to_string()),
          error_message: None,
          current_chapter_idx: 0,
          eta_seconds: None,
          total_chars: 0,
          processed_chars: 0,
          settings_json: "{}".to_string(),
          source_fingerprint: None,
          narration_language: None,
          created_at: ts,
          updated_at: ts,
          started_at: None,
          completed_at: None,
        };
        conn.execute(
          "INSERT INTO jobs (
            id, source_path, source_name, title, author, status, progress, queue_position,
            voice_id, output_format, output_dir, error_message, current_chapter_idx,
            eta_seconds, total_chars, processed_chars, settings_json, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
          params![
            row.id,
            row.source_path,
            row.source_name,
            row.title,
            row.author,
            row.status,
            row.progress,
            row.queue_position,
            row.voice_id,
            row.output_format,
            row.output_dir,
            row.error_message,
            row.current_chapter_idx,
            row.eta_seconds,
            row.total_chars,
            row.processed_chars,
            row.settings_json,
            row.created_at,
            row.updated_at
          ],
        )?;
        rows.push(row);
      }
      Ok(rows)
    })
    }

    pub fn list_jobs(&self) -> Result<Vec<QueueJob>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM jobs ORDER BY
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
          created_at ASC",
            )?;
            let rows = stmt.query_map([], row_to_job)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
    }

    pub fn get_job(&self, job_id: &str) -> Result<Option<QueueJob>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT * FROM jobs WHERE id = ?1",
                params![job_id],
                row_to_job,
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn get_next_queued_job(&self) -> Result<Option<QueueJob>> {
        self.with_conn(|conn| {
      conn.query_row(
        "SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC LIMIT 1",
        [],
        row_to_job,
      )
      .optional()
      .map_err(Into::into)
    })
    }

    pub fn get_job_detail(&self, job_id: &str) -> Result<Option<JobDetail>> {
        let Some(job) = self.get_job(job_id)? else {
            return Ok(None);
        };
        let chapters = self
            .list_chapters(job_id)?
            .into_iter()
            .map(|chapter| ChapterForUi {
                id: chapter.id,
                job_id: chapter.job_id,
                idx: chapter.idx,
                title: chapter.title,
                status: chapter.status,
                chunk_cursor: chapter.chunk_cursor,
                total_chunks: chapter.total_chunks,
                duration_ms: chapter.duration_ms,
                error_message: chapter.error_message,
            })
            .collect();
        Ok(Some(JobDetail { job, chapters }))
    }

    pub fn update_job_status(&self, job_id: &str, status: &str, error: Option<&str>) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE jobs SET status = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4",
                params![status, error, now_ts(), job_id],
            )?;
            Ok(())
        })
    }

    pub fn update_job_extraction(
        &self,
        job_id: &str,
        title: &str,
        author: Option<&str>,
        total_chars: i64,
        source_fingerprint: &str,
        narration_language: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE jobs SET title = ?1, author = ?2, total_chars = ?3,
                 source_fingerprint = ?4, narration_language = ?5, updated_at = ?6
                 WHERE id = ?7",
                params![
                    title,
                    author,
                    total_chars,
                    source_fingerprint,
                    narration_language,
                    now_ts(),
                    job_id
                ],
            )?;
            Ok(())
        })
    }

    pub fn update_job_voice(&self, job_id: &str, voice_id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE jobs SET voice_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![voice_id, now_ts(), job_id],
            )?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_job_progress(
        &self,
        job_id: &str,
        status: &str,
        current_chapter_idx: i64,
        processed_chars: i64,
        total_chars: i64,
        progress: f64,
        eta_seconds: Option<i64>,
    ) -> Result<()> {
        self.with_conn(|conn| {
      conn.execute(
        "UPDATE jobs SET status = ?1, current_chapter_idx = ?2, processed_chars = ?3, total_chars = ?4,
         progress = ?5, eta_seconds = ?6, error_message = NULL, updated_at = ?7 WHERE id = ?8",
        params![status, current_chapter_idx, processed_chars, total_chars, progress, eta_seconds, now_ts(), job_id],
      )?;
      Ok(())
    })
    }

    pub fn finish_job(&self, job_id: &str, current_chapter_idx: i64) -> Result<()> {
        self.with_conn(|conn| {
      conn.execute(
        "UPDATE jobs SET status = 'done', progress = 1, eta_seconds = 0, completed_at = ?1, current_chapter_idx = ?2, updated_at = ?1 WHERE id = ?3",
        params![now_ts(), current_chapter_idx, job_id],
      )?;
      Ok(())
    })
    }

    pub fn replace_chapters(&self, job_id: &str, chapters: &[ChapterExtraction]) -> Result<()> {
        self.with_conn(|conn| {
            let ts = now_ts();
            conn.execute("DELETE FROM chapters WHERE job_id = ?1", params![job_id])?;
            for chapter in chapters {
                conn.execute(
                    "INSERT INTO chapters (
            id, job_id, idx, title, text_path, status, chunk_cursor, total_chunks,
            duration_ms, audio_path, error_message, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, 0, NULL, NULL, NULL, ?6, ?6)",
                    params![
                        Uuid::new_v4().to_string(),
                        job_id,
                        chapter.index,
                        chapter.title,
                        chapter.text_path,
                        ts
                    ],
                )?;
            }
            Ok(())
        })
    }

    pub fn list_chapters(&self, job_id: &str) -> Result<Vec<Chapter>> {
        self.with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT * FROM chapters WHERE job_id = ?1 ORDER BY idx ASC")?;
            let rows = stmt.query_map(params![job_id], row_to_chapter)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
    }

    pub fn update_chapter_processing(
        &self,
        job_id: &str,
        idx: i64,
        cursor: i64,
        total: i64,
    ) -> Result<()> {
        self.with_conn(|conn| {
      conn.execute(
        "UPDATE chapters SET status = 'processing', chunk_cursor = ?1, total_chunks = ?2, error_message = NULL, updated_at = ?3 WHERE job_id = ?4 AND idx = ?5",
        params![cursor, total, now_ts(), job_id, idx],
      )?;
      Ok(())
    })
    }

    pub fn reset_chapter_plan(
        &self,
        job_id: &str,
        idx: i64,
        fingerprint: &str,
        total: i64,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE chapters SET status = 'queued', chunk_cursor = 0, total_chunks = ?1,
                 duration_ms = NULL, audio_path = NULL, error_message = NULL,
                 plan_fingerprint = ?2, updated_at = ?3 WHERE job_id = ?4 AND idx = ?5",
                params![total, fingerprint, now_ts(), job_id, idx],
            )?;
            Ok(())
        })
    }

    pub fn finish_chapter(
        &self,
        job_id: &str,
        idx: i64,
        total: i64,
        duration_ms: i64,
        audio_path: &Path,
    ) -> Result<()> {
        self.with_conn(|conn| {
      conn.execute(
        "UPDATE chapters SET status = 'encoded', chunk_cursor = ?1, total_chunks = ?1, duration_ms = ?2, audio_path = ?3, error_message = NULL, updated_at = ?4 WHERE job_id = ?5 AND idx = ?6",
        params![total, duration_ms, audio_path.to_string_lossy(), now_ts(), job_id, idx],
      )?;
      Ok(())
    })
    }

    pub fn add_output(
        &self,
        job: &QueueJob,
        file_path: &Path,
        duration_ms: i64,
        size_bytes: i64,
    ) -> Result<()> {
        self.with_conn(|conn| {
      conn.execute("DELETE FROM outputs WHERE job_id = ?1", params![job.id])?;
      conn.execute(
        "INSERT INTO outputs (id, job_id, title, file_path, format, duration_ms, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
          Uuid::new_v4().to_string(),
          job.id,
          job.title,
          file_path.to_string_lossy(),
          job.output_format,
          duration_ms,
          size_bytes,
          now_ts()
        ],
      )?;
      Ok(())
    })
    }

    pub fn list_outputs(&self) -> Result<Vec<GeneratedAudio>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM outputs ORDER BY created_at DESC")?;
            let rows = stmt.query_map([], row_to_output)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
    }

    pub fn get_output(&self, output_id: &str) -> Result<Option<GeneratedAudio>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT * FROM outputs WHERE id = ?1",
                params![output_id],
                row_to_output,
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn get_outputs_by_job(&self, job_id: &str) -> Result<Vec<GeneratedAudio>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM outputs WHERE job_id = ?1")?;
            let rows = stmt.query_map(params![job_id], row_to_output)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
    }

    pub fn delete_output(&self, output_id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM outputs WHERE id = ?1", params![output_id])?;
            Ok(())
        })
    }

    pub fn delete_job(&self, job_id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM jobs WHERE id = ?1", params![job_id])?;
            Ok(())
        })
    }

    pub fn set_job_paused(&self, job_id: &str) -> Result<()> {
        self.update_job_status(job_id, "paused", None)
    }

    pub fn set_job_canceled(&self, job_id: &str) -> Result<()> {
        self.with_conn(|conn| {
      conn.execute(
        "UPDATE jobs SET status = 'canceled', eta_seconds = NULL, completed_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now_ts(), job_id],
      )?;
      Ok(())
    })
    }

    pub fn add_log(&self, job_id: &str, level: &str, message: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO logs (job_id, ts, level, message) VALUES (?1, ?2, ?3, ?4)",
                params![job_id, now_ts(), level, message],
            )?;
            Ok(())
        })
    }

    pub fn reorder_queue(&self, job_ids: &[String]) -> Result<()> {
        self.with_conn(|conn| {
      let ts = now_ts();
      for (idx, job_id) in job_ids.iter().enumerate() {
        conn.execute(
          "UPDATE jobs SET queue_position = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('queued', 'paused', 'error')",
          params![idx as i64 + 1, ts, job_id],
        )?;
      }
      Ok(())
    })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_lists_jobs() {
        let tmp = tempfile::tempdir().unwrap();
        let repo =
            Repository::new(tmp.path().join("db.sqlite"), tmp.path().join("outputs")).unwrap();
        let jobs = repo
            .enqueue_epub_files(&[tmp.path().join("book.epub").to_string_lossy().to_string()])
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].voice_id, DEFAULT_VOICE_ID);
        assert_eq!(repo.list_jobs().unwrap().len(), 1);
    }

    #[test]
    fn migrates_retired_default_voices_to_sharvard() {
        let tmp = tempfile::tempdir().unwrap();
        let repo =
            Repository::new(tmp.path().join("db.sqlite"), tmp.path().join("outputs")).unwrap();

        for retired_voice in ["es_ES-carlfm-high", "es_ES-miro-high"] {
            repo.set_settings(AppSettings {
                default_voice_id: Some(retired_voice.to_string()),
                default_output_dir: None,
                default_output_format: None,
                keep_intermediates: None,
                max_concurrent_jobs: None,
            })
            .unwrap();
            repo.ensure_defaults().unwrap();
            assert_eq!(
                repo.get_settings().unwrap().default_voice_id.as_deref(),
                Some(DEFAULT_VOICE_ID)
            );
        }
    }

    #[test]
    fn preserves_resume_cursor_and_plan_across_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("db.sqlite");
        let output_path = tmp.path().join("outputs");
        let text_path = tmp.path().join("chapter.txt");
        fs::write(&text_path, "Chapter text long enough for a narration plan.").unwrap();

        let repo = Repository::new(db_path.clone(), output_path.clone()).unwrap();
        let job = repo
            .enqueue_epub_files(&[tmp.path().join("book.epub").to_string_lossy().to_string()])
            .unwrap()
            .remove(0);
        repo.replace_chapters(
            &job.id,
            &[ChapterExtraction {
                index: 0,
                title: "Chapter 1".to_string(),
                text_path: text_path.to_string_lossy().to_string(),
            }],
        )
        .unwrap();
        repo.reset_chapter_plan(&job.id, 0, "plan-v1", 4).unwrap();
        repo.update_chapter_processing(&job.id, 0, 2, 4).unwrap();
        drop(repo);

        let reopened = Repository::new(db_path, output_path).unwrap();
        let chapter = reopened.list_chapters(&job.id).unwrap().remove(0);
        assert_eq!(chapter.status, "queued");
        assert_eq!(chapter.chunk_cursor, 2);
        assert_eq!(chapter.total_chunks, 4);
        assert_eq!(chapter.plan_fingerprint.as_deref(), Some("plan-v1"));
    }
}

use anyhow::{anyhow, Result};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    audio,
    epub::extract_epub,
    models::{AppSettings, JobDetail, QueueJob, QueueLogEvent, VoiceInfo},
    piper_http::PiperHttpEngine,
    repository::Repository,
    runtime::{load_runtime_assets, RuntimeAssets},
    text::split_into_chunks,
};

#[derive(Clone)]
pub struct QueueManager {
    app: AppHandle,
    repo: Arc<Mutex<Repository>>,
    runtime: Arc<RuntimeAssets>,
    piper: Arc<AsyncMutex<PiperHttpEngine>>,
    is_pumping: Arc<AtomicBool>,
    pause_requested: Arc<Mutex<HashSet<String>>>,
    cancel_requested: Arc<Mutex<HashSet<String>>>,
}

impl QueueManager {
    pub fn new(app: AppHandle) -> Result<Self> {
        let app_data = app.path().app_data_dir()?;
        let documents = dirs::document_dir().unwrap_or_else(|| app_data.clone());
        let repo = Repository::new(
            app_data.join("db").join("app.sqlite"),
            documents.join("Audiobooks"),
        )?;
        let runtime = load_runtime_assets(&app)?;
        Ok(Self {
            app,
            repo: Arc::new(Mutex::new(repo)),
            runtime: Arc::new(runtime),
            piper: Arc::new(AsyncMutex::new(PiperHttpEngine::new())),
            is_pumping: Arc::new(AtomicBool::new(false)),
            pause_requested: Arc::new(Mutex::new(HashSet::new())),
            cancel_requested: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn repo(&self) -> std::sync::MutexGuard<'_, Repository> {
        self.repo.lock().expect("repository mutex poisoned")
    }

    pub fn list_voices(&self) -> Vec<VoiceInfo> {
        self.runtime.voice_infos()
    }

    pub fn emit_queue(&self) {
        if let Ok(jobs) = self.repo().list_jobs() {
            let _ = self.app.emit("queueUpdated", jobs);
        }
    }

    pub fn emit_generated(&self) {
        if let Ok(outputs) = self.repo().list_outputs() {
            let _ = self.app.emit("generatedUpdated", outputs);
        }
    }

    pub fn emit_job(&self, job_id: &str) {
        if let Ok(Some(job)) = self.repo().get_job_detail(job_id) {
            let _ = self.app.emit("jobUpdated", job);
        }
    }

    pub fn emit_settings(&self, settings: AppSettings) {
        let _ = self.app.emit("settingsUpdated", settings);
    }

    pub fn set_settings(&self, patch: AppSettings) -> Result<AppSettings> {
        let settings = self.repo().set_settings(patch)?;
        self.emit_settings(settings.clone());
        Ok(settings)
    }

    pub fn log(&self, job_id: &str, level: &str, message: &str) {
        let _ = self.repo().add_log(job_id, level, message);
        let _ = self.app.emit(
            "logEvent",
            QueueLogEvent {
                job_id: job_id.to_string(),
                level: level.to_string(),
                message: message.to_string(),
                ts: now_ts(),
            },
        );
    }

    pub fn enqueue_epub_files(&self, paths: Vec<String>) -> Result<Vec<QueueJob>> {
        let rows = self.repo().enqueue_epub_files(&paths)?;
        self.emit_queue();
        self.start_pump();
        Ok(rows)
    }

    pub fn start_pump(&self) {
        if self.is_pumping.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.pump().await;
            manager.is_pumping.store(false, Ordering::SeqCst);
        });
    }

    async fn pump(&self) {
        loop {
            let next_job = match self.repo().get_next_queued_job() {
                Ok(Some(job)) => job,
                _ => break,
            };
            if let Err(error) = self.process_job(next_job.clone()).await {
                if self.is_cancel_requested(&next_job.id) {
                    let _ = self.repo().set_job_canceled(&next_job.id);
                    self.log(&next_job.id, "info", "Job canceled.");
                } else if self.is_pause_requested(&next_job.id) {
                    let _ = self.repo().set_job_paused(&next_job.id);
                    self.log(&next_job.id, "info", "Job paused.");
                } else {
                    let _ = self.repo().update_job_status(
                        &next_job.id,
                        "error",
                        Some(&error.to_string()),
                    );
                    self.log(&next_job.id, "error", &error.to_string());
                }
            }
            self.pause_requested.lock().unwrap().remove(&next_job.id);
            self.cancel_requested.lock().unwrap().remove(&next_job.id);
            self.emit_queue();
            self.emit_job(&next_job.id);
        }
    }

    async fn process_job(&self, mut job: QueueJob) -> Result<()> {
        self.repo().update_job_status(&job.id, "processing", None)?;
        self.emit_queue();
        self.emit_job(&job.id);

        let runtime = Arc::clone(&self.runtime);
        let app_data = self.app.path().app_data_dir()?;
        let work_dir = app_data.join("work").join(&job.id);
        fs::create_dir_all(&work_dir)?;

        self.log(&job.id, "info", "Extracting EPUB chapters.");
        self.repo().update_job_status(&job.id, "extracting", None)?;
        let extraction = extract_epub(Path::new(&job.source_path), &work_dir)?;
        self.repo()
            .replace_chapters(&job.id, &extraction.chapters)?;
        self.repo().update_job_metadata(
            &job.id,
            &extraction.title,
            extraction.author.as_deref(),
            extraction.total_chars,
        )?;
        job.title = extraction.title;
        job.author = extraction.author;
        job.total_chars = extraction.total_chars;

        let preferred_voice_id = if runtime.voice(&job.voice_id).is_some() {
            job.voice_id.clone()
        } else {
            runtime
                .default_voice_id()
                .ok_or_else(|| anyhow!("Runtime has no Spanish voices."))?
        };
        let voice = runtime
            .narration_voice(&preferred_voice_id, &extraction.language)
            .ok_or_else(|| anyhow!("No bundled voice supports {}.", extraction.language))?;
        self.repo().update_job_voice(&job.id, &voice.id)?;
        job.voice_id = voice.id.clone();
        self.log(
            &job.id,
            "info",
            &format!("Starting job processing with voice {}.", voice.name),
        );
        self.emit_job(&job.id);

        let chapters = self.repo().list_chapters(&job.id)?;
        let mut processed_chars = 0_i64;
        for chapter in chapters {
            self.check_control(&job.id)?;
            let chapter_wav = self
                .process_chapter(
                    &job,
                    &chapter.text_path,
                    chapter.idx,
                    &chapter.title,
                    &runtime,
                    &voice,
                    &work_dir,
                    processed_chars,
                )
                .await?;
            processed_chars += chapter_wav.processed_chars;
        }

        self.finalize_job(&job, &runtime, &work_dir).await?;
        let keep_intermediates = self
            .repo()
            .get_settings()?
            .keep_intermediates
            .unwrap_or(false);
        if !keep_intermediates {
            let _ = fs::remove_dir_all(&work_dir);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn process_chapter(
        &self,
        job: &QueueJob,
        text_path: &str,
        chapter_idx: i64,
        _chapter_title: &str,
        runtime: &RuntimeAssets,
        voice: &crate::runtime::ResolvedVoiceAsset,
        work_dir: &Path,
        processed_before_chapter: i64,
    ) -> Result<ChapterProcessResult> {
        let text = fs::read_to_string(text_path)?;
        let chunks = split_into_chunks(&text, 800, 2000);
        if chunks.is_empty() {
            return Ok(ChapterProcessResult { processed_chars: 0 });
        }

        let chapter_dir = work_dir
            .join("audio")
            .join("chunks")
            .join(chapter_idx.to_string());
        fs::create_dir_all(&chapter_dir)?;
        let mut wavs = Vec::new();
        let mut processed = 0_i64;
        let started = Instant::now();

        for (chunk_idx, chunk) in chunks.iter().enumerate() {
            self.check_control(&job.id)?;
            let chunk_path = chapter_dir.join(format!("chunk_{chunk_idx:05}.wav"));
            {
                let mut piper = self.piper.lock().await;
                piper.ensure_started(runtime, voice).await?;
                piper.synthesize_to_file(chunk, &chunk_path).await?;
            }

            processed += chunk.len() as i64;
            let total_processed = processed_before_chapter + processed;
            let elapsed_seconds = started.elapsed().as_secs_f64().max(0.001);
            let chars_per_second = processed as f64 / elapsed_seconds;
            let remaining = (job.total_chars - total_processed).max(0) as f64;
            let eta = if chars_per_second > 0.0 {
                Some((remaining / chars_per_second).ceil() as i64)
            } else {
                None
            };
            let progress = if job.total_chars > 0 {
                (total_processed as f64 / job.total_chars as f64).min(0.96)
            } else {
                0.0
            };
            self.repo().update_chapter_processing(
                &job.id,
                chapter_idx,
                chunk_idx as i64 + 1,
                chunks.len() as i64,
            )?;
            self.repo().update_job_progress(
                &job.id,
                "processing",
                chapter_idx,
                total_processed,
                job.total_chars,
                progress,
                eta,
            )?;
            self.emit_queue();
            self.emit_job(&job.id);
            wavs.push(chunk_path);
        }

        let chapter_wav_dir = work_dir.join("audio").join("chapters");
        let chapter_wav = chapter_wav_dir.join(format!("chapter_{chapter_idx:05}.wav"));
        audio::concat_wavs(
            &runtime.ffmpeg_exe,
            &wavs,
            &chapter_wav,
            &work_dir.join("tmp"),
        )
        .await?;
        let duration = audio::duration_ms(&runtime.ffprobe_exe, &chapter_wav)
            .await
            .unwrap_or(0);
        self.repo().finish_chapter(
            &job.id,
            chapter_idx,
            chunks.len() as i64,
            duration,
            &chapter_wav,
        )?;
        self.emit_job(&job.id);
        Ok(ChapterProcessResult {
            processed_chars: processed,
        })
    }

    async fn finalize_job(
        &self,
        job: &QueueJob,
        runtime: &RuntimeAssets,
        work_dir: &Path,
    ) -> Result<()> {
        self.repo().update_job_status(&job.id, "encoding", None)?;
        self.emit_queue();
        self.emit_job(&job.id);

        let chapters = self.repo().list_chapters(&job.id)?;
        let chapter_wavs: Vec<PathBuf> = chapters
            .iter()
            .filter_map(|chapter| chapter.audio_path.as_ref().map(PathBuf::from))
            .collect();
        if chapter_wavs.is_empty() {
            return Err(anyhow!("No chapter audio generated."));
        }
        let merged_wav = work_dir.join("audio").join("merged.wav");
        audio::concat_wavs(
            &runtime.ffmpeg_exe,
            &chapter_wavs,
            &merged_wav,
            &work_dir.join("tmp"),
        )
        .await?;
        let (destination_dir, final_path) = audio::output_paths(
            Path::new(&job.output_dir),
            &job.title,
            job.author.as_deref(),
            &job.output_format,
        );
        fs::create_dir_all(&destination_dir)?;
        audio::encode_final_audio(
            &runtime.ffmpeg_exe,
            &merged_wav,
            &final_path,
            &job.output_format,
            &job.title,
            job.author.as_deref(),
        )
        .await?;
        let duration = audio::duration_ms(&runtime.ffprobe_exe, &final_path)
            .await
            .unwrap_or(0);
        let size = fs::metadata(&final_path)
            .map(|meta| meta.len() as i64)
            .unwrap_or(0);
        self.repo().add_output(job, &final_path, duration, size)?;
        self.repo().finish_job(&job.id, chapters.len() as i64)?;
        self.log(
            &job.id,
            "info",
            &format!("Job finished: {}", final_path.display()),
        );
        self.emit_generated();
        self.emit_queue();
        self.emit_job(&job.id);
        Ok(())
    }

    pub fn pause_job(&self, job_id: &str) -> Result<Option<JobDetail>> {
        self.pause_requested
            .lock()
            .unwrap()
            .insert(job_id.to_string());
        self.log(
            job_id,
            "info",
            "Pause requested; stopping after current chunk.",
        );
        if let Some(job) = self.repo().get_job(job_id)? {
            if job.status == "queued" {
                self.repo().set_job_paused(job_id)?;
            }
        }
        self.emit_queue();
        self.emit_job(job_id);
        self.repo().get_job_detail(job_id)
    }

    pub fn resume_job(&self, job_id: &str) -> Result<Option<JobDetail>> {
        self.pause_requested.lock().unwrap().remove(job_id);
        self.cancel_requested.lock().unwrap().remove(job_id);
        self.repo().update_job_status(job_id, "queued", None)?;
        self.emit_queue();
        self.emit_job(job_id);
        self.start_pump();
        self.repo().get_job_detail(job_id)
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<Option<JobDetail>> {
        self.cancel_requested
            .lock()
            .unwrap()
            .insert(job_id.to_string());
        if let Some(job) = self.repo().get_job(job_id)? {
            if ["queued", "paused", "error", "canceled"].contains(&job.status.as_str()) {
                self.repo().delete_job(job_id)?;
                self.emit_queue();
                self.emit_generated();
                return Ok(None);
            }
        }
        self.repo().get_job_detail(job_id)
    }

    fn is_pause_requested(&self, job_id: &str) -> bool {
        self.pause_requested.lock().unwrap().contains(job_id)
    }

    fn is_cancel_requested(&self, job_id: &str) -> bool {
        self.cancel_requested.lock().unwrap().contains(job_id)
    }

    fn check_control(&self, job_id: &str) -> Result<()> {
        if self.is_cancel_requested(job_id) {
            return Err(anyhow!("Canceled by user"));
        }
        if self.is_pause_requested(job_id) {
            return Err(anyhow!("Paused by user"));
        }
        Ok(())
    }
}

struct ChapterProcessResult {
    processed_chars: i64,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

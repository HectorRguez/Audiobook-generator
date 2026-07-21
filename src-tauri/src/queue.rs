use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
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
    models::{AppSettings, Chapter, JobDetail, QueueJob, QueueLogEvent, VoiceInfo},
    narration::{build_chapter_plan, ChapterPlan, NarrationSegment, SENTENCE_SILENCE_MS},
    piper_http::PiperHttpEngine,
    repository::Repository,
    runtime::{load_runtime_assets, ResolvedVoiceAsset, RuntimeAssets},
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

        let source_fingerprint = sha256_file(Path::new(&job.source_path))?;
        let existing_chapters = self.repo().list_chapters(&job.id)?;
        let can_reuse_extraction = job.source_fingerprint.as_deref()
            == Some(source_fingerprint.as_str())
            && job.narration_language.is_some()
            && !existing_chapters.is_empty()
            && existing_chapters
                .iter()
                .all(|chapter| Path::new(&chapter.text_path).is_file());

        let narration_language = if can_reuse_extraction {
            self.log(&job.id, "info", "Reusing verified EPUB extraction.");
            job.narration_language.clone().unwrap()
        } else {
            self.log(&job.id, "info", "Extracting EPUB chapters.");
            self.repo().update_job_status(&job.id, "extracting", None)?;
            let extraction = extract_epub(Path::new(&job.source_path), &work_dir)?;
            self.repo()
                .replace_chapters(&job.id, &extraction.chapters)?;
            self.repo().update_job_extraction(
                &job.id,
                &extraction.title,
                extraction.author.as_deref(),
                extraction.total_chars,
                &source_fingerprint,
                &extraction.language,
            )?;
            job.title = extraction.title;
            job.author = extraction.author;
            job.total_chars = extraction.total_chars;
            job.source_fingerprint = Some(source_fingerprint);
            job.narration_language = Some(extraction.language.clone());
            extraction.language
        };

        let preferred_voice_id = if runtime.voice(&job.voice_id).is_some() {
            job.voice_id.clone()
        } else {
            runtime
                .default_voice_id()
                .ok_or_else(|| anyhow!("Runtime has no Spanish voices."))?
        };
        let voice = runtime
            .narration_voice(&preferred_voice_id, &narration_language)
            .ok_or_else(|| anyhow!("No bundled voice supports {narration_language}."))?;
        self.repo().update_job_voice(&job.id, &voice.id)?;
        job.voice_id = voice.id.clone();
        self.log(
            &job.id,
            "info",
            &format!("Starting job processing with voice {}.", voice.name),
        );
        self.emit_job(&job.id);

        let synthesis_fingerprint = synthesis_fingerprint(&runtime, &voice)?;
        let chapters = self.repo().list_chapters(&job.id)?;
        let mut processed_chars = 0_i64;
        for chapter in chapters {
            self.check_control(&job.id)?;
            let chapter_wav = self
                .process_chapter(
                    &job,
                    &chapter,
                    &runtime,
                    &voice,
                    &synthesis_fingerprint,
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
        chapter: &Chapter,
        runtime: &RuntimeAssets,
        voice: &ResolvedVoiceAsset,
        synthesis_fingerprint: &str,
        work_dir: &Path,
        processed_before_chapter: i64,
    ) -> Result<ChapterProcessResult> {
        let text = fs::read_to_string(&chapter.text_path)?;
        let plan = build_chapter_plan(&text);
        if plan.speech_segment_count == 0 {
            return Ok(ChapterProcessResult { processed_chars: 0 });
        }

        let chapter_idx = chapter.idx;
        let plan_fingerprint = chapter_plan_fingerprint(&plan, synthesis_fingerprint);

        let chapter_dir = work_dir
            .join("audio")
            .join("chunks")
            .join(chapter_idx.to_string());
        let chapter_wav_dir = work_dir.join("audio").join("chapters");
        let chapter_wav = chapter_wav_dir.join(format!("chapter_{chapter_idx:05}.wav"));
        let plan_matches = chapter.plan_fingerprint.as_deref() == Some(&plan_fingerprint);
        if !plan_matches {
            let _ = fs::remove_dir_all(&chapter_dir);
            let _ = fs::remove_file(&chapter_wav);
            self.repo().reset_chapter_plan(
                &job.id,
                chapter_idx,
                &plan_fingerprint,
                plan.speech_segment_count as i64,
            )?;
        } else if chapter.status == "encoded"
            && audio::wav_is_valid(&chapter_wav, voice.sample_rate)
        {
            self.log(
                &job.id,
                "info",
                &format!("Reusing completed chapter {}.", chapter_idx + 1),
            );
            return Ok(ChapterProcessResult {
                processed_chars: plan.total_speech_chars as i64,
            });
        }

        fs::create_dir_all(&chapter_dir)?;
        let silence_dir = work_dir.join("audio").join("silence");
        let mut wavs = Vec::new();
        let mut processed = 0_i64;
        let mut sample_rate = voice.sample_rate;
        let started = Instant::now();
        let mut reused_segments = 0_usize;

        for segment in &plan.segments {
            self.check_control(&job.id)?;
            match segment {
                NarrationSegment::Speech {
                    speech_index, text, ..
                } => {
                    let chunk_path = chapter_dir.join(format!("chunk_{speech_index:05}.wav"));
                    if plan_matches && audio::wav_is_valid(&chunk_path, voice.sample_rate) {
                        reused_segments += 1;
                    } else {
                        self.synthesize_with_retry(job, runtime, voice, text, &chunk_path)
                            .await?;
                    }

                    if sample_rate.is_none() {
                        sample_rate = audio::wav_sample_rate(&chunk_path);
                    }

                    processed += text.chars().count() as i64;
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
                        *speech_index as i64 + 1,
                        plan.speech_segment_count as i64,
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
                NarrationSegment::Silence { duration_ms, .. } => {
                    let rate = sample_rate.ok_or_else(|| {
                        anyhow!("Unable to determine voice sample rate for narration pauses.")
                    })?;
                    let silence_path =
                        silence_dir.join(format!("silence_{rate}_{duration_ms}ms.wav"));
                    audio::ensure_silence_wav(&silence_path, rate, *duration_ms).await?;
                    wavs.push(silence_path);
                }
            }
        }

        if reused_segments > 0 {
            self.log(
                &job.id,
                "info",
                &format!(
                    "Chapter {} reused {reused_segments}/{} verified speech segments.",
                    chapter_idx + 1,
                    plan.speech_segment_count
                ),
            );
        }
        audio::concat_wavs(&wavs, &chapter_wav).await?;
        let duration = audio::duration_ms(&chapter_wav).unwrap_or(0);
        self.repo().finish_chapter(
            &job.id,
            chapter_idx,
            plan.speech_segment_count as i64,
            duration,
            &chapter_wav,
        )?;
        self.emit_job(&job.id);
        Ok(ChapterProcessResult {
            processed_chars: processed,
        })
    }

    async fn synthesize_with_retry(
        &self,
        job: &QueueJob,
        runtime: &RuntimeAssets,
        voice: &ResolvedVoiceAsset,
        text: &str,
        output: &Path,
    ) -> Result<()> {
        let mut last_error = None;
        for attempt in 1..=2 {
            let result = async {
                let bytes = {
                    let mut piper = self.piper.lock().await;
                    piper.ensure_started(runtime, voice).await?;
                    piper.synthesize(text).await?
                };
                audio::write_wav_atomically(output, &bytes, voice.sample_rate)
            }
            .await;

            match result {
                Ok(()) => return Ok(()),
                Err(error) => {
                    last_error = Some(error);
                    self.piper.lock().await.stop().await;
                    if attempt == 1 {
                        self.log(
                            &job.id,
                            "warn",
                            "Piper synthesis failed; restarting the local server and retrying once.",
                        );
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("Piper synthesis failed.")))
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
        audio::concat_wavs(&chapter_wavs, &merged_wav).await?;
        let duration = audio::duration_ms(&merged_wav).unwrap_or(0);
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

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("Failed to open {} for fingerprinting", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn synthesis_fingerprint(runtime: &RuntimeAssets, voice: &ResolvedVoiceAsset) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(b"audiobook-generator-synthesis-v1\0");
    hash.update(runtime.piper_version.as_bytes());
    hash.update(b"\0");
    hash.update(voice.id.as_bytes());
    hash.update(b"\0");
    hash.update(SENTENCE_SILENCE_MS.to_le_bytes());
    hash.update(fs::read(&voice.model_path)?);
    hash.update(fs::read(&voice.config_path)?);
    Ok(format!("{:x}", hash.finalize()))
}

fn chapter_plan_fingerprint(plan: &ChapterPlan, synthesis_fingerprint: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"audiobook-generator-narration-plan-v1\0");
    hash.update(synthesis_fingerprint.as_bytes());
    for segment in &plan.segments {
        match segment {
            NarrationSegment::Speech {
                speech_index,
                text,
                paragraph_index,
            } => {
                hash.update(b"speech\0");
                hash.update(speech_index.to_le_bytes());
                hash.update(paragraph_index.to_le_bytes());
                hash.update(text.len().to_le_bytes());
                hash.update(text.as_bytes());
            }
            NarrationSegment::Silence {
                duration_ms,
                reason,
            } => {
                hash.update(b"silence\0");
                hash.update(duration_ms.to_le_bytes());
                hash.update(format!("{reason:?}").as_bytes());
            }
        }
    }
    format!("{:x}", hash.finalize())
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_fingerprint_is_stable_and_covers_text_and_synthesis_identity() {
        let first = build_chapter_plan("First paragraph.\n\nSecond paragraph.");
        let changed = build_chapter_plan("First paragraph.\n\nChanged paragraph.");

        let fingerprint = chapter_plan_fingerprint(&first, "voice-a");
        assert_eq!(fingerprint, chapter_plan_fingerprint(&first, "voice-a"));
        assert_ne!(fingerprint, chapter_plan_fingerprint(&changed, "voice-a"));
        assert_ne!(fingerprint, chapter_plan_fingerprint(&first, "voice-b"));
    }
}

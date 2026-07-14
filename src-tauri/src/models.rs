use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueJob {
    pub id: String,
    pub source_path: String,
    pub source_name: String,
    pub title: String,
    pub author: Option<String>,
    pub status: String,
    pub progress: f64,
    pub queue_position: i64,
    pub voice_id: String,
    pub output_format: String,
    pub output_dir: String,
    pub error_message: Option<String>,
    pub current_chapter_idx: i64,
    pub eta_seconds: Option<i64>,
    pub total_chars: i64,
    pub processed_chars: i64,
    pub settings_json: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub id: String,
    pub job_id: String,
    pub idx: i64,
    pub title: String,
    pub text_path: String,
    pub status: String,
    pub chunk_cursor: i64,
    pub total_chunks: i64,
    pub duration_ms: Option<i64>,
    pub audio_path: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterForUi {
    pub id: String,
    pub job_id: String,
    pub idx: i64,
    pub title: String,
    pub status: String,
    pub chunk_cursor: i64,
    pub total_chunks: i64,
    pub duration_ms: Option<i64>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobDetail {
    #[serde(flatten)]
    pub job: QueueJob,
    pub chapters: Vec<ChapterForUi>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedAudio {
    pub id: String,
    pub job_id: String,
    pub title: String,
    pub file_path: String,
    pub format: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueLogEvent {
    pub job_id: String,
    pub level: String,
    pub message: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_output_dir: Option<String>,
    pub default_voice_id: Option<String>,
    pub default_output_format: Option<String>,
    pub keep_intermediates: Option<bool>,
    pub max_concurrent_jobs: Option<i64>,
    pub use_nvidia_gpu: Option<bool>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_output_dir: None,
            default_voice_id: Some("es_ES-carlfm-high".to_string()),
            default_output_format: Some("mp3".to_string()),
            keep_intermediates: Some(false),
            max_concurrent_jobs: Some(1),
            use_nvidia_gpu: Some(false),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub model_path: Option<String>,
    pub locale: Option<String>,
    pub speaker: Option<String>,
    pub quality: Option<String>,
    pub source_url: Option<String>,
    pub model_card_url: Option<String>,
    pub license_id: Option<String>,
    pub license_name: Option<String>,
    pub license_url: Option<String>,
    pub usage_note: Option<String>,
    pub attribution: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChapterExtraction {
    pub index: i64,
    pub title: String,
    pub text_path: String,
}

#[derive(Debug, Clone)]
pub struct EpubExtractionResult {
    pub title: String,
    pub author: Option<String>,
    pub chapters: Vec<ChapterExtraction>,
    pub total_chars: i64,
}

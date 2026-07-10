export type JobStatus =
  | "queued"
  | "extracting"
  | "processing"
  | "encoding"
  | "done"
  | "error"
  | "paused"
  | "canceled";

export interface QueueJob {
  id: string;
  source_path: string;
  source_name: string;
  title: string;
  author: string | null;
  status: JobStatus;
  progress: number;
  queue_position: number;
  voice_id: string;
  output_format: "mp3" | "m4b";
  output_dir: string;
  error_message: string | null;
  current_chapter_idx: number;
  eta_seconds: number | null;
  total_chars: number;
  processed_chars: number;
  created_at: number;
  updated_at: number;
}

export interface Chapter {
  id: string;
  job_id: string;
  idx: number;
  title: string;
  status: string;
  chunk_cursor: number;
  total_chunks: number;
  duration_ms: number | null;
  error_message: string | null;
}

export interface JobDetail extends QueueJob {
  chapters: Chapter[];
}

export interface GeneratedAudio {
  id: string;
  job_id: string;
  title: string;
  file_path: string;
  format: "mp3" | "m4b";
  duration_ms: number;
  size_bytes: number;
  created_at: number;
}

export interface LogEvent {
  jobId: string;
  level: string;
  message: string;
  ts: number;
}

export interface BootstrapStatus {
  phase: "downloading" | "extracting" | "ready" | "error";
  message: string;
  assetId?: string;
  itemIndex?: number;
  totalItems?: number;
  progress?: number | null;
  downloadedBytes?: number;
  totalBytes?: number | null;
}

export interface AppSettings {
  defaultOutputDir: string;
  defaultVoiceId: string;
  defaultOutputFormat: "mp3" | "m4b";
  keepIntermediates: boolean;
  maxConcurrentJobs: number;
  useNvidiaGpu: boolean;
}

export interface VoiceInfo {
  id: string;
  name: string;
  modelPath: string | null;
  locale?: string;
  speaker?: string;
  quality?: string;
  sourceUrl?: string | null;
  modelCardUrl?: string | null;
  licenseId?: string | null;
  licenseName?: string | null;
  licenseUrl?: string | null;
  usageNote?: string | null;
  attribution?: string | null;
}

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes?: string | null;
  date?: string | null;
}

export interface UpdateStatus {
  phase: "downloading" | "installing" | "error";
  version?: string | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  message?: string | null;
}

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type JobStatus =
  | "queued"
  | "extracting"
  | "processing"
  | "encoding"
  | "done"
  | "error"
  | "paused"
  | "canceled";

export type ChapterStatus = "queued" | "processing" | "encoded" | "error";
export type OutputFormat = "mp3" | "m4b";

export interface JobRow {
  id: string;
  source_path: string;
  source_name: string;
  title: string;
  author: string | null;
  status: JobStatus;
  progress: number;
  queue_position: number;
  voice_id: string;
  output_format: OutputFormat;
  output_dir: string;
  error_message: string | null;
  current_chapter_idx: number;
  eta_seconds: number | null;
  total_chars: number;
  processed_chars: number;
  settings_json: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface ChapterRow {
  id: string;
  job_id: string;
  idx: number;
  title: string;
  text_path: string;
  status: ChapterStatus;
  chunk_cursor: number;
  total_chunks: number;
  duration_ms: number | null;
  audio_path: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface OutputRow {
  id: string;
  job_id: string;
  title: string;
  file_path: string;
  format: OutputFormat;
  duration_ms: number;
  size_bytes: number;
  created_at: number;
}

export interface JobDetail extends JobRow {
  chapters: ChapterRow[];
}

export interface VoiceInfo {
  id: string;
  name: string;
  modelPath: string | null;
  locale?: string;
  speaker?: string;
  quality?: "x_low" | "low" | "medium" | "high" | string;
  sourceUrl?: string | null;
  modelCardUrl?: string | null;
  licenseId?: string | null;
  licenseName?: string | null;
  licenseUrl?: string | null;
  usageNote?: string | null;
  attribution?: string | null;
}

export interface AppSettings {
  defaultOutputDir: string;
  defaultVoiceId: string;
  defaultOutputFormat: OutputFormat;
  keepIntermediates: boolean;
  maxConcurrentJobs: number;
  useNvidiaGpu: boolean;
}

export interface ChapterExtraction {
  index: number;
  title: string;
  textPath: string;
  textLength: number;
}

export interface EpubExtractionResult {
  title: string;
  author: string | null;
  chapters: ChapterExtraction[];
  totalChars: number;
}

export interface QueueLogEvent {
  jobId: string;
  level: string;
  message: string;
  ts: number;
}

export interface QueueManagerEvents {
  queueUpdated: (jobs: JobRow[]) => void;
  jobUpdated: (job: JobDetail) => void;
  generatedUpdated: (outputs: OutputRow[]) => void;
  logEvent: (event: QueueLogEvent) => void;
  settingsUpdated: (settings: Partial<AppSettings>) => void;
}

export interface RunningProcessRef {
  currentChild: ChildProcessWithoutNullStreams | null;
}

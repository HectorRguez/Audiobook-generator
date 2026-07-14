import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  AppSettings,
  GeneratedAudio,
  JobDetail,
  LogEvent,
  QueueJob,
  UpdateInfo,
  UpdateStatus,
  VoiceInfo
} from "@/lib/contracts";

export interface DesktopApi {
  pickEpubFiles: () => Promise<string[]>;
  enqueueEpubFiles: (paths: string[]) => Promise<{ id: string }[]>;
  listJobs: () => Promise<QueueJob[]>;
  getJob: (jobId: string) => Promise<JobDetail | null>;
  reorderQueue: (jobIdsInOrder: string[]) => Promise<QueueJob[]>;
  pauseJob: (jobId: string) => Promise<JobDetail | null>;
  resumeJob: (jobId: string) => Promise<JobDetail | null>;
  cancelJob: (jobId: string) => Promise<JobDetail | null>;
  deleteJob: (jobId: string, deleteOutputs?: boolean) => Promise<QueueJob[]>;
  listGeneratedAudios: () => Promise<GeneratedAudio[]>;
  deleteGeneratedAudio: (outputId: string) => Promise<GeneratedAudio[]>;
  getGeneratedPlaybackUrl: (outputId: string) => Promise<string>;
  downloadGeneratedAudio: (outputId: string) => Promise<{ canceled: boolean; filePath?: string }>;
  openOutputFolder: (jobId: string) => Promise<void>;
  getSettings: () => Promise<AppSettings>;
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  listVoices: () => Promise<VoiceInfo[]>;
  checkForUpdate: () => Promise<UpdateInfo | null>;
  installUpdate: () => Promise<void>;
  onQueueUpdated: (callback: (jobs: QueueJob[]) => void) => () => void;
  onJobUpdated: (callback: (job: JobDetail) => void) => () => void;
  onGeneratedUpdated: (callback: (outputs: GeneratedAudio[]) => void) => () => void;
  onLogEvent: (callback: (event: LogEvent) => void) => () => void;
  onSettingsUpdated: (callback: (settings: Partial<AppSettings>) => void) => () => void;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function subscribe<T>(eventName: string, callback: (payload: T) => void): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  void listen<T>(eventName, (event) => {
    if (active) {
      callback(event.payload);
    }
  }).then((nextUnlisten) => {
    if (!active) {
      nextUnlisten();
      return;
    }
    unlisten = nextUnlisten;
  });

  return () => {
    active = false;
    unlisten?.();
  };
}

export function createTauriApi(): DesktopApi | null {
  if (!isTauriRuntime()) {
    return null;
  }

  return {
    pickEpubFiles: () => invokeCommand<string[]>("pick_epub_files"),
    enqueueEpubFiles: (paths) => invokeCommand("enqueue_epub_files", { filePaths: paths }),
    listJobs: () => invokeCommand<QueueJob[]>("list_jobs"),
    getJob: (jobId) => invokeCommand<JobDetail | null>("get_job", { jobId }),
    reorderQueue: (jobIdsInOrder) => invokeCommand<QueueJob[]>("reorder_queue", { jobIdsInOrder }),
    pauseJob: (jobId) => invokeCommand<JobDetail | null>("pause_job", { jobId }),
    resumeJob: (jobId) => invokeCommand<JobDetail | null>("resume_job", { jobId }),
    cancelJob: (jobId) => invokeCommand<JobDetail | null>("cancel_job", { jobId }),
    deleteJob: (jobId, deleteOutputs) => invokeCommand<QueueJob[]>("delete_job", { jobId, deleteOutputs }),
    listGeneratedAudios: () => invokeCommand<GeneratedAudio[]>("list_generated"),
    deleteGeneratedAudio: (outputId) => invokeCommand<GeneratedAudio[]>("delete_generated", { outputId }),
    getGeneratedPlaybackUrl: async (outputId) => {
      const filePath = await invokeCommand<string>("get_generated_playback_url", { outputId });
      return convertFileSrc(filePath);
    },
    downloadGeneratedAudio: async (outputId) => {
      const output = await invokeCommand<GeneratedAudio | null>("get_generated_audio", { outputId });
      if (!output) {
        throw new Error("Generated audio not found.");
      }
      const destination = await save({
        defaultPath: output.file_path.split(/[\\/]/).pop() || `${output.title}.${output.format}`
      });
      if (!destination) {
        return { canceled: true as const };
      }
      await invokeCommand<void>("download_generated", { outputId, destinationPath: destination });
      return { canceled: false as const, filePath: destination };
    },
    openOutputFolder: async (jobId) => {
      const job = await invokeCommand<JobDetail | null>("get_job", { jobId });
      if (job) {
        await openPath(job.output_dir);
      }
    },
    getSettings: () => invokeCommand<AppSettings>("get_settings"),
    setSettings: (patch) => invokeCommand<AppSettings>("set_settings", { patch }),
    listVoices: () => invokeCommand<VoiceInfo[]>("list_voices"),
    checkForUpdate: () => invokeCommand<UpdateInfo | null>("check_for_update"),
    installUpdate: () => invokeCommand<void>("install_update"),
    onQueueUpdated: (callback) => subscribe<QueueJob[]>("queueUpdated", callback),
    onJobUpdated: (callback) => subscribe<JobDetail>("jobUpdated", callback),
    onGeneratedUpdated: (callback) => subscribe<GeneratedAudio[]>("generatedUpdated", callback),
    onLogEvent: (callback) => subscribe<LogEvent>("logEvent", callback),
    onSettingsUpdated: (callback) => subscribe<Partial<AppSettings>>("settingsUpdated", callback),
    onUpdateStatus: (callback) => subscribe<UpdateStatus>("updateStatusUpdated", callback)
  };
}

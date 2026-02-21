import { contextBridge, ipcRenderer } from "electron";
import { commands, events } from "./ipc/channels";
import type {
  AppSettings,
  BootstrapStatus,
  JobDetail,
  JobRow,
  OutputRow,
  QueueLogEvent,
  RuntimeAssets,
  VoiceInfo
} from "./types";

interface DownloadResult {
  canceled: boolean;
  filePath?: string;
}

interface PreloadApi {
  pickEpubFiles: () => Promise<string[]>;
  enqueueEpubFiles: (paths: string[]) => Promise<JobRow[]>;
  listJobs: () => Promise<JobRow[]>;
  getJob: (jobId: string) => Promise<JobDetail | null>;
  reorderQueue: (jobIdsInOrder: string[]) => Promise<JobRow[]>;
  pauseJob: (jobId: string) => Promise<JobDetail | null>;
  resumeJob: (jobId: string) => Promise<JobDetail | null>;
  cancelJob: (jobId: string) => Promise<JobDetail | null>;
  deleteJob: (jobId: string, deleteOutputs?: boolean) => Promise<JobRow[]>;
  listGeneratedAudios: () => Promise<OutputRow[]>;
  deleteGeneratedAudio: (outputId: string) => Promise<OutputRow[]>;
  getGeneratedPlaybackUrl: (outputId: string) => Promise<string>;
  downloadGeneratedAudio: (outputId: string) => Promise<DownloadResult>;
  openOutputFolder: (jobId: string) => Promise<void>;
  getSettings: () => Promise<Partial<AppSettings>>;
  setSettings: (patch: Partial<AppSettings>) => Promise<Partial<AppSettings>>;
  listVoices: () => Promise<VoiceInfo[]>;
  bootstrapAssets: () => Promise<RuntimeAssets>;
  onQueueUpdated: (callback: (jobs: JobRow[]) => void) => () => void;
  onJobUpdated: (callback: (job: JobDetail) => void) => () => void;
  onGeneratedUpdated: (callback: (outputs: OutputRow[]) => void) => () => void;
  onLogEvent: (callback: (event: QueueLogEvent) => void) => () => void;
  onBootstrapStatus: (callback: (status: BootstrapStatus) => void) => () => void;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: PreloadApi = {
  pickEpubFiles: () => ipcRenderer.invoke(commands.PICK_EPUB_FILES),
  enqueueEpubFiles: (paths) => ipcRenderer.invoke(commands.ENQUEUE_EPUB_FILES, paths),
  listJobs: () => ipcRenderer.invoke(commands.LIST_JOBS),
  getJob: (jobId) => ipcRenderer.invoke(commands.GET_JOB, jobId),
  reorderQueue: (jobIdsInOrder) => ipcRenderer.invoke(commands.REORDER_QUEUE, jobIdsInOrder),
  pauseJob: (jobId) => ipcRenderer.invoke(commands.PAUSE_JOB, jobId),
  resumeJob: (jobId) => ipcRenderer.invoke(commands.RESUME_JOB, jobId),
  cancelJob: (jobId) => ipcRenderer.invoke(commands.CANCEL_JOB, jobId),
  deleteJob: (jobId, deleteOutputs) => ipcRenderer.invoke(commands.DELETE_JOB, jobId, deleteOutputs),
  listGeneratedAudios: () => ipcRenderer.invoke(commands.LIST_GENERATED),
  deleteGeneratedAudio: (outputId) => ipcRenderer.invoke(commands.DELETE_GENERATED, outputId),
  getGeneratedPlaybackUrl: (outputId) => ipcRenderer.invoke(commands.GET_GENERATED_PLAYBACK_URL, outputId),
  downloadGeneratedAudio: (outputId) => ipcRenderer.invoke(commands.DOWNLOAD_GENERATED, outputId),
  openOutputFolder: (jobId) => ipcRenderer.invoke(commands.OPEN_OUTPUT_FOLDER, jobId),
  getSettings: () => ipcRenderer.invoke(commands.GET_SETTINGS),
  setSettings: (patch) => ipcRenderer.invoke(commands.SET_SETTINGS, patch),
  listVoices: () => ipcRenderer.invoke(commands.LIST_VOICES),
  bootstrapAssets: () => ipcRenderer.invoke(commands.BOOTSTRAP_ASSETS),

  onQueueUpdated: (callback) => subscribe(events.QUEUE_UPDATED, callback),
  onJobUpdated: (callback) => subscribe(events.JOB_UPDATED, callback),
  onGeneratedUpdated: (callback) => subscribe(events.GENERATED_UPDATED, callback),
  onLogEvent: (callback) => subscribe(events.LOG_EVENT, callback),
  onBootstrapStatus: (callback) => subscribe(events.BOOTSTRAP_STATUS, callback)
};

contextBridge.exposeInMainWorld("audiobook", api);

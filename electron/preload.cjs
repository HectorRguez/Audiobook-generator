const { contextBridge, ipcRenderer } = require("electron");

const events = {
  QUEUE_UPDATED: "queue-updated",
  JOB_UPDATED: "job-updated",
  GENERATED_UPDATED: "generated-updated",
  LOG_EVENT: "log-event",
  BOOTSTRAP_STATUS: "bootstrap-status"
};

const commands = {
  PICK_EPUB_FILES: "pick-epub-files",
  ENQUEUE_EPUB_FILES: "enqueue-epub-files",
  LIST_JOBS: "list-jobs",
  GET_JOB: "get-job",
  REORDER_QUEUE: "reorder-queue",
  PAUSE_JOB: "pause-job",
  RESUME_JOB: "resume-job",
  CANCEL_JOB: "cancel-job",
  DELETE_JOB: "delete-job",
  LIST_GENERATED: "list-generated-audios",
  DOWNLOAD_GENERATED: "download-generated-audio",
  OPEN_OUTPUT_FOLDER: "open-output-folder",
  GET_SETTINGS: "get-settings",
  SET_SETTINGS: "set-settings",
  LIST_VOICES: "list-voices",
  BOOTSTRAP_ASSETS: "bootstrap-assets"
};

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld("audiobook", {
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
});

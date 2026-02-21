const { contextBridge, ipcRenderer } = require("electron");
const { commands, events } = require("./ipc/channels.cjs");

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

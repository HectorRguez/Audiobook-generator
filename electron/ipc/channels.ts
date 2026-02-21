export const events = {
  QUEUE_UPDATED: "queue-updated",
  JOB_UPDATED: "job-updated",
  GENERATED_UPDATED: "generated-updated",
  LOG_EVENT: "log-event",
  BOOTSTRAP_STATUS: "bootstrap-status"
} as const;

export const commands = {
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
} as const;

export type EventChannel = (typeof events)[keyof typeof events];
export type CommandChannel = (typeof commands)[keyof typeof commands];

import type {
  AppSettings,
  BootstrapStatus,
  GeneratedAudio,
  JobDetail,
  LogEvent,
  QueueJob,
  VoiceInfo
} from "@/lib/contracts";

declare global {
  interface Window {
    audiobook: {
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
      bootstrapAssets: () => Promise<unknown>;
      onQueueUpdated: (callback: (jobs: QueueJob[]) => void) => () => void;
      onJobUpdated: (callback: (job: JobDetail) => void) => () => void;
      onGeneratedUpdated: (callback: (outputs: GeneratedAudio[]) => void) => () => void;
      onLogEvent: (callback: (event: LogEvent) => void) => () => void;
      onBootstrapStatus: (callback: (status: BootstrapStatus) => void) => () => void;
    };
  }
}

export {};

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import prettyMilliseconds from "pretty-ms";
import {
  Clock3,
  Download,
  FileAudio2,
  FolderOpen,
  GripVertical,
  Pause,
  Play,
  Plus,
  Trash2,
  XCircle
} from "lucide-react";
import type {
  BootstrapStatus,
  GeneratedAudio,
  JobDetail,
  JobStatus,
  LogEvent,
  QueueJob
} from "@/lib/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

function statusVariant(status: JobStatus) {
  if (status === "error" || status === "canceled") {
    return "destructive" as const;
  }
  if (status === "done") {
    return "default" as const;
  }
  return "secondary" as const;
}

function formatEta(seconds: number | null) {
  if (seconds === null || Number.isNaN(seconds)) {
    return "Estimating...";
  }

  if (seconds <= 0) {
    return "0h 0m";
  }

  const ms = Math.ceil(seconds) * 1000;
  return prettyMilliseconds(ms, {
    compact: false,
    unitCount: 2,
    secondsDecimalDigits: 0
  });
}

function formatDuration(ms: number) {
  return prettyMilliseconds(ms, { compact: false, unitCount: 2, secondsDecimalDigits: 0 });
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 0; i < units.length - 1 && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i + 1];
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatBootstrapAssetName(assetId?: string) {
  if (!assetId) {
    return "Runtime asset";
  }

  if (assetId === "piper") {
    return "Piper engine";
  }
  if (assetId === "ffmpeg") {
    return "FFmpeg";
  }
  if (assetId === "voice-default") {
    return "Spanish voice (davefx medium)";
  }
  return assetId;
}

function formatBootstrapPhase(phase: BootstrapStatus["phase"]) {
  if (phase === "downloading") {
    return "Downloading";
  }
  if (phase === "extracting") {
    return "Extracting";
  }
  if (phase === "ready") {
    return "Ready";
  }
  return "Error";
}

function reorder(list: QueueJob[], fromId: string, toId: string) {
  const fromIndex = list.findIndex((item) => item.id === fromId);
  const toIndex = list.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return list;
  }

  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return list;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

export function Dashboard() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
  const [generated, setGenerated] = useState<GeneratedAudio[]>([]);
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(true);

  function getApi() {
    return (window as { audiobook?: Window["audiobook"] }).audiobook;
  }

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    const [nextJobs, nextGenerated] = await Promise.all([
      api.listJobs(),
      api.listGeneratedAudios()
    ]);

    setJobs(nextJobs);
    setGenerated(nextGenerated);
  }, []);

  useEffect(() => {
    let attached = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let unsubs: Array<() => void> = [];

    const attachApi = (api: NonNullable<ReturnType<typeof getApi>>) => {
      if (attached) {
        return;
      }
      attached = true;
      setBridgeReady(true);
      void refresh();

      unsubs = [
        api.onQueueUpdated((payload) => setJobs(payload)),
        api.onGeneratedUpdated((payload) => setGenerated(payload)),
        api.onJobUpdated((payload) => {
          setJobDetails((current) => ({ ...current, [payload.id]: payload }));
        }),
        api.onBootstrapStatus((payload) => setBootstrapStatus(payload)),
        api.onLogEvent((payload) => {
          setLogs((current) => [...current.slice(-200), payload]);
        })
      ];

      void api.bootstrapAssets().catch((error: unknown) => {
        setBootstrapStatus({
          phase: "error",
          message: error instanceof Error ? error.message : "Failed to bootstrap runtime assets"
        });
      });
    };

    const currentApi = getApi();
    if (currentApi) {
      attachApi(currentApi);
    } else {
      setBridgeReady(false);
      setBootstrapStatus({
        phase: "error",
        message: "Electron bridge unavailable in this view. Use the Electron app window started by `npm run dev`."
      });
      pollTimer = setInterval(() => {
        const api = getApi();
        if (!api) {
          return;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        attachApi(api);
      }, 400);
    }

    return () => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [refresh]);

  const queueJobs = useMemo(
    () => jobs.filter((job) => !["done", "canceled"].includes(job.status)),
    [jobs]
  );

  const activeJob = useMemo(
    () =>
      jobs.find((job) => ["extracting", "processing", "encoding"].includes(job.status)) ||
      jobs.find((job) => job.status === "queued") ||
      null,
    [jobs]
  );

  const activeLog = useMemo(() => {
    if (!activeJob) {
      return null;
    }
    return [...logs].reverse().find((entry) => entry.jobId === activeJob.id) || null;
  }, [activeJob, logs]);
  const activeJobDetail = activeJob ? jobDetails[activeJob.id] : undefined;

  const bootstrapDownloadVisible = Boolean(
    bootstrapStatus && (bootstrapStatus.phase === "downloading" || bootstrapStatus.phase === "extracting")
  );
  const bootstrapProgressValue = bootstrapStatus?.progress === null || bootstrapStatus?.progress === undefined
    ? (bootstrapStatus?.phase === "extracting" ? 100 : 10)
    : Math.round(bootstrapStatus.progress * 100);

  async function addFiles() {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    setIsBusy(true);
    try {
      const filePaths = await api.pickEpubFiles();
      if (filePaths.length > 0) {
        await api.enqueueEpubFiles(filePaths);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDrop(files: FileList) {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    const paths = Array.from(files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((value): value is string => typeof value === "string" && value.toLowerCase().endsWith(".epub"));

    if (paths.length === 0) {
      return;
    }

    setIsBusy(true);
    try {
      await api.enqueueEpubFiles(paths);
    } finally {
      setIsBusy(false);
    }
  }

  async function reorderQueue(targetId: string) {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    if (!draggingId || draggingId === targetId) {
      return;
    }

    const next = reorder(queueJobs, draggingId, targetId);
    setJobs((current) => {
      const map = new Map(current.map((job) => [job.id, job]));
      return next.map((job) => map.get(job.id) ?? job).concat(current.filter((job) => !next.find((item) => item.id === job.id)));
    });
    setDraggingId(null);

    await api.reorderQueue(next.map((job) => job.id));
  }

  return (
    <main className="h-screen w-full p-4 lg:p-6">
      <div className="mx-auto flex h-full max-w-[1800px] flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Audiobook Generator</h1>
            <p className="text-sm text-muted-foreground">EPUB queue with durable state and chapter-level checkpoints.</p>
          </div>
          <div className="flex items-center gap-2">
            {!bridgeReady && <Badge variant="destructive">Desktop bridge unavailable</Badge>}
            {bootstrapStatus && !bootstrapDownloadVisible && (
              <Badge variant={bootstrapStatus.phase === "error" ? "destructive" : "secondary"}>
                {bootstrapStatus.phase}: {bootstrapStatus.message}
              </Badge>
            )}
            <Button onClick={addFiles} disabled={isBusy}>
              <Plus className="mr-2 h-4 w-4" /> Add EPUB Files
            </Button>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[1.3fr_1fr_1.2fr]">
          <Card
            className="min-h-0"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void handleDrop(event.dataTransfer.files);
            }}
          >
            <CardHeader>
              <CardTitle>Processing Queue</CardTitle>
              <CardDescription>Drag rows to reorder. Drop EPUB files here to enqueue.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 overflow-y-auto pb-4">
              {queueJobs.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 bg-background/30 p-4 text-sm text-muted-foreground">
                  Queue is empty. Add one or more EPUB files.
                </p>
              ) : (
                queueJobs.map((job) => (
                  <div
                    key={job.id}
                    draggable
                    onDragStart={() => setDraggingId(job.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => void reorderQueue(job.id)}
                    className="rounded-lg border border-border/70 bg-background/50 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <p className="truncate text-sm font-medium">{job.title}</p>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{job.source_name}</p>
                      </div>
                      <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      {job.status === "queued" || job.status === "processing" || job.status === "extracting" || job.status === "encoding" ? (
                        <Button size="sm" variant="secondary" onClick={() => void getApi()?.pauseJob(job.id)}>
                          <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                        </Button>
                      ) : null}

                      {(job.status === "paused" || job.status === "error") && (
                        <Button size="sm" variant="secondary" onClick={() => void getApi()?.resumeJob(job.id)}>
                          <Play className="mr-1 h-3.5 w-3.5" /> Resume
                        </Button>
                      )}

                      {!["done", "canceled"].includes(job.status) && (
                        <Button size="sm" variant="destructive" onClick={() => void getApi()?.cancelJob(job.id)}>
                          <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
                        </Button>
                      )}

                      <Button size="sm" variant="ghost" onClick={() => void getApi()?.deleteJob(job.id, false)}>
                        <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="min-h-0">
            <CardHeader>
              <CardTitle>Now Processing</CardTitle>
              <CardDescription>Current book progress and estimated time left.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!activeJob ? (
                <p className="text-sm text-muted-foreground">No active processing job.</p>
              ) : (
                <>
                  <div className="rounded-xl border border-border/70 bg-background/40 p-4">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div className="relative rounded-2xl border border-border/70 bg-background/80 p-6">
                        <FileAudio2 className="h-14 w-14 text-primary" />
                        <Badge variant={statusVariant(activeJob.status)} className="absolute -right-3 -top-3">
                          {activeJob.status}
                        </Badge>
                      </div>
                      <p className="line-clamp-2 text-sm font-semibold">{activeJob.title}</p>
                      <p className="line-clamp-1 text-xs text-muted-foreground">{activeJob.source_name}</p>
                    </div>

                    <div className="mt-4 space-y-2">
                      <Progress value={Math.round((activeJob.progress || 0) * 100)} />
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{Math.round((activeJob.progress || 0) * 100)}%</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="h-3.5 w-3.5" />
                          {formatEta(activeJob.eta_seconds)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Chapter</p>
                      <p className="text-base font-semibold">#{activeJob.current_chapter_idx + 1}</p>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Characters</p>
                      <p className="text-base font-semibold">{activeJob.processed_chars.toLocaleString()}</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/70 bg-background/40 p-3 text-xs text-muted-foreground">
                    <p>
                      {activeJob.processed_chars.toLocaleString()} / {activeJob.total_chars.toLocaleString()} chars
                    </p>
                    {activeLog && <p className="mt-1">Latest: {activeLog.message}</p>}
                  </div>

                  {activeJobDetail?.chapters && (
                    <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-background/40 p-2">
                      {activeJobDetail.chapters.map((chapter) => (
                        <div key={chapter.id} className="flex items-center justify-between rounded-md px-2 py-1 text-xs">
                          <span className="truncate">{chapter.title}</span>
                          <span className="text-muted-foreground">
                            {chapter.chunk_cursor}/{chapter.total_chunks}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="min-h-0">
            <CardHeader>
              <CardTitle>Generated Audios</CardTitle>
              <CardDescription>Newest first. Export any completed audiobook.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 overflow-y-auto pb-4">
              {generated.length === 0 ? (
                <p className="text-sm text-muted-foreground">No generated audiobooks yet.</p>
              ) : (
                generated.map((output) => (
                  <div key={output.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/50 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{output.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDuration(output.duration_ms)} • {formatFileSize(output.size_bytes)} • {output.format.toUpperCase()}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="secondary" onClick={() => void getApi()?.downloadGeneratedAudio(output.id)}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void getApi()?.openOutputFolder(output.job_id)}>
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </section>
      </div>
      {bootstrapDownloadVisible && bootstrapStatus && (
        <div className="pointer-events-none fixed bottom-5 right-5 z-50 w-[360px]">
          <Card className="border-border/80 bg-card/95 shadow-xl backdrop-blur">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Runtime Assets {bootstrapStatus.itemIndex ?? 0}/{bootstrapStatus.totalItems ?? 0}
              </CardTitle>
              <CardDescription className="line-clamp-1">
                {formatBootstrapPhase(bootstrapStatus.phase)} {formatBootstrapAssetName(bootstrapStatus.assetId)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Progress value={bootstrapProgressValue} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{bootstrapProgressValue}%</span>
                <span>
                  {typeof bootstrapStatus.downloadedBytes === "number" ? formatFileSize(bootstrapStatus.downloadedBytes) : "0 B"}
                  {" / "}
                  {typeof bootstrapStatus.totalBytes === "number" ? formatFileSize(bootstrapStatus.totalBytes) : "Unknown"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

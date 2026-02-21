"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  Download,
  FileAudio2,
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

  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
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
    return "Spanish voice (es_ES-carlfm-high)";
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
  const [playbackUrls, setPlaybackUrls] = useState<Record<string, string>>({});
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [queueOrder, setQueueOrder] = useState<QueueJob[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(true);
  const [showQueueBottomFade, setShowQueueBottomFade] = useState(false);
  const [showGeneratedBottomFade, setShowGeneratedBottomFade] = useState(false);
  const [generatedDeleteTarget, setGeneratedDeleteTarget] = useState<GeneratedAudio | null>(null);
  const [deletingGeneratedId, setDeletingGeneratedId] = useState<string | null>(null);
  const queueContentRef = useRef<HTMLDivElement | null>(null);
  const generatedContentRef = useRef<HTMLDivElement | null>(null);

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

  const runningJob = useMemo(
    () => jobs.find((job) => ["extracting", "processing", "encoding"].includes(job.status)) || null,
    [jobs]
  );

  const activeJob = useMemo(
    () =>
      runningJob ||
      jobs.find((job) => ["queued", "paused", "error"].includes(job.status)) ||
      null,
    [jobs, runningJob]
  );

  const queueJobs = useMemo(
    () =>
      jobs.filter(
        (job) => ["queued", "paused", "error"].includes(job.status) && job.id !== activeJob?.id
      ),
    [activeJob?.id, jobs]
  );
  const visibleQueueJobs = draggingId ? queueOrder : queueJobs;

  const activeLog = useMemo(() => {
    if (!activeJob) {
      return null;
    }
    return [...logs].reverse().find((entry) => entry.jobId === activeJob.id) || null;
  }, [activeJob, logs]);
  const activeJobDetail = activeJob ? jobDetails[activeJob.id] : undefined;

  useEffect(() => {
    if (draggingId) {
      return;
    }
    setQueueOrder(queueJobs);
  }, [draggingId, queueJobs]);

  const bootstrapBlockingVisible = Boolean(
    bootstrapStatus && (bootstrapStatus.phase === "downloading" || bootstrapStatus.phase === "extracting")
  );
  const bootstrapProgressValue = bootstrapStatus?.progress === null || bootstrapStatus?.progress === undefined
    ? (bootstrapStatus?.phase === "extracting" ? 100 : 10)
    : Math.round(bootstrapStatus.progress * 100);

  const updateBottomFade = useCallback(
    (node: HTMLDivElement | null, setVisible: (value: boolean) => void) => {
      if (!node) {
        setVisible(false);
        return;
      }
      setVisible(node.scrollTop + node.clientHeight < node.scrollHeight - 2);
    },
    []
  );

  useEffect(() => {
    const api = getApi();
    if (!api || bootstrapBlockingVisible) {
      return;
    }

    const missingOutputIds = generated
      .map((output) => output.id)
      .filter((outputId) => !playbackUrls[outputId]);

    if (missingOutputIds.length === 0) {
      return;
    }

    missingOutputIds.forEach((outputId) => {
      void api.getGeneratedPlaybackUrl(outputId).then((url) => {
        setPlaybackUrls((current) => (current[outputId] ? current : { ...current, [outputId]: url }));
      }).catch(() => {
        // Keep download action usable even if preview URL generation fails.
      });
    });
  }, [bootstrapBlockingVisible, generated, playbackUrls]);

  useEffect(() => {
    const node = queueContentRef.current;
    if (!node) {
      setShowQueueBottomFade(false);
      return;
    }

    const handleUpdate = () => updateBottomFade(node, setShowQueueBottomFade);
    handleUpdate();

    node.addEventListener("scroll", handleUpdate, { passive: true });
    window.addEventListener("resize", handleUpdate);
    const resizeObserver = new ResizeObserver(handleUpdate);
    resizeObserver.observe(node);

    return () => {
      node.removeEventListener("scroll", handleUpdate);
      window.removeEventListener("resize", handleUpdate);
      resizeObserver.disconnect();
    };
  }, [updateBottomFade, visibleQueueJobs]);

  useEffect(() => {
    const node = generatedContentRef.current;
    if (!node) {
      setShowGeneratedBottomFade(false);
      return;
    }

    const handleUpdate = () => updateBottomFade(node, setShowGeneratedBottomFade);
    handleUpdate();

    node.addEventListener("scroll", handleUpdate, { passive: true });
    window.addEventListener("resize", handleUpdate);
    const resizeObserver = new ResizeObserver(handleUpdate);
    resizeObserver.observe(node);

    return () => {
      node.removeEventListener("scroll", handleUpdate);
      window.removeEventListener("resize", handleUpdate);
      resizeObserver.disconnect();
    };
  }, [generated, updateBottomFade]);

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

  async function handleDeleteGenerated(outputId: string) {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    setDeletingGeneratedId(outputId);
    try {
      await api.deleteGeneratedAudio(outputId);
      setPlaybackUrls((current) => {
        if (!current[outputId]) {
          return current;
        }
        const next = { ...current };
        delete next[outputId];
        return next;
      });
    } finally {
      setDeletingGeneratedId((current) => (current === outputId ? null : current));
    }
  }

  function handleQueueDragStart(jobId: string) {
    setDraggingId(jobId);
    setDragOverId(jobId);
    setQueueOrder(queueJobs);
  }

  function handleQueueDragEnter(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      return;
    }
    setDragOverId(targetId);
    setQueueOrder((current) => reorder(current.length > 0 ? current : queueJobs, draggingId, targetId));
  }

  function resetQueueDragState() {
    setDraggingId(null);
    setDragOverId(null);
    setQueueOrder(queueJobs);
  }

  async function commitQueueOrder() {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      resetQueueDragState();
      return;
    }

    const nextOrder = queueOrder.length > 0 ? queueOrder : queueJobs;
    if (nextOrder.length > 1) {
      await api.reorderQueue(nextOrder.map((job) => job.id));
    }
    resetQueueDragState();
  }

  return (
    <main className="h-screen w-full p-4 lg:p-6">
      <div className="mx-auto flex h-full max-w-[1800px] flex-col gap-4">
        <header className="flex flex-col gap-3">
          <h1 className="text-center text-2xl font-semibold">Audiobook Generator</h1>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!bridgeReady && <Badge variant="destructive">Desktop bridge unavailable</Badge>}
            {bootstrapStatus?.phase === "error" && !bootstrapBlockingVisible && (
              <Badge variant="destructive">
                {bootstrapStatus.phase}: {bootstrapStatus.message}
              </Badge>
            )}
            <Button onClick={addFiles} disabled={isBusy || bootstrapBlockingVisible}>
              <Plus className="mr-2 h-4 w-4" /> Add EPUB Files
            </Button>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-3">
          <Card
            className="flex h-full min-h-0 flex-col"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length > 0) {
                void handleDrop(event.dataTransfer.files);
              }
            }}
          >
            <CardHeader>
              <CardTitle>Processing Queue</CardTitle>
              <CardDescription>Drag rows to reorder. Drop EPUB files here to enqueue.</CardDescription>
            </CardHeader>
            <CardContent ref={queueContentRef} className="relative min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
              {visibleQueueJobs.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 bg-background/30 p-4 text-sm text-muted-foreground">
                  Queue is empty. Add one or more EPUB files.
                </p>
              ) : (
                visibleQueueJobs.map((job) => (
                  <div
                    key={job.id}
                    draggable
                    onDragStart={() => handleQueueDragStart(job.id)}
                    onDragEnter={() => handleQueueDragEnter(job.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void commitQueueOrder();
                    }}
                    onDragEnd={() => {
                      if (!draggingId) {
                        return;
                      }
                      resetQueueDragState();
                    }}
                    className={`rounded-lg border border-border/70 bg-background/50 p-3 transition-all duration-150 ${
                      dragOverId === job.id ? "scale-[1.01] border-primary/50 shadow-sm" : ""
                    }`}
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
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={bootstrapBlockingVisible}
                        onClick={() => void getApi()?.deleteJob(job.id, false)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                    {job.error_message && (
                      <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                        {job.error_message}
                      </p>
                    )}
                  </div>
                ))
              )}
              <div
                className={`pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-background/30 via-background/10 to-transparent transition-opacity duration-200 ${
                  showQueueBottomFade ? "opacity-100" : "opacity-0"
                }`}
              />
            </CardContent>
          </Card>

          <section className="min-h-0 px-1 py-2">
            <div className={activeJob ? "flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1" : "flex h-full items-center justify-center"}>
              {!activeJob ? (
                <FileAudio2 className="h-14 w-14 text-muted-foreground/50" />
              ) : (
                <>
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="relative overflow-visible rounded-2xl border border-border/70 bg-background/80 p-6">
                      <FileAudio2 className="h-14 w-14 text-primary" />
                      <Badge variant={statusVariant(activeJob.status)} className="absolute right-2 top-2">
                        {activeJob.status}
                      </Badge>
                    </div>
                    <p className="line-clamp-2 text-sm font-semibold">{activeJob.title}</p>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{activeJob.source_name}</p>
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {["queued", "extracting", "processing", "encoding"].includes(activeJob.status) && (
                      <Button size="sm" variant="secondary" onClick={() => void getApi()?.pauseJob(activeJob.id)}>
                        <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                      </Button>
                    )}
                    {["paused", "error"].includes(activeJob.status) && (
                      <Button size="sm" variant="secondary" onClick={() => void getApi()?.resumeJob(activeJob.id)}>
                        <Play className="mr-1 h-3.5 w-3.5" /> Resume
                      </Button>
                    )}
                    {!["done", "canceled"].includes(activeJob.status) && (
                      <Button size="sm" variant="destructive" onClick={() => void getApi()?.cancelJob(activeJob.id)}>
                        <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Progress value={Math.round((activeJob.progress || 0) * 100)} />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{Math.round((activeJob.progress || 0) * 100)}%</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatEta(activeJob.eta_seconds)}
                      </span>
                    </div>
                  </div>

                  {activeLog && (
                    <div className="rounded-lg border border-primary/35 bg-primary/10 p-3">
                      <p className="text-sm text-foreground">{activeLog.message}</p>
                    </div>
                  )}

                  {activeJobDetail?.chapters && (
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-background/40 p-2">
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
            </div>
          </section>

          <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
              <CardTitle>Generated Audios</CardTitle>
              <CardDescription>Newest first. Export any completed audiobook.</CardDescription>
            </CardHeader>
            <CardContent ref={generatedContentRef} className="relative min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
              {generated.length === 0 ? (
                <p className="text-sm text-muted-foreground">No generated audiobooks yet.</p>
              ) : (
                generated.map((output) => (
                  <div key={output.id} className="rounded-lg border border-border/70 bg-background/50 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{output.title}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={bootstrapBlockingVisible}
                          onClick={() => void getApi()?.downloadGeneratedAudio(output.id)}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={bootstrapBlockingVisible || deletingGeneratedId === output.id}
                          onClick={() => setGeneratedDeleteTarget(output)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <audio
                      controls
                      preload="metadata"
                      className="audio-preview mt-2 h-9 w-full bg-transparent"
                      src={playbackUrls[output.id]}
                      controlsList="nodownload noplaybackrate noremoteplayback"
                      onContextMenu={(event) => event.preventDefault()}
                    />
                  </div>
                ))
              )}
              <div
                className={`pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-background/30 via-background/10 to-transparent transition-opacity duration-200 ${
                  showGeneratedBottomFade ? "opacity-100" : "opacity-0"
                }`}
              />
            </CardContent>
          </Card>
        </section>
      </div>
      {bootstrapBlockingVisible && bootstrapStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <Card className="w-[min(560px,92vw)] border-border/80 bg-card/95 shadow-2xl">
            <CardHeader className="pb-2 text-center">
              <CardTitle className="text-base">
                Preparing Runtime Assets ({bootstrapStatus.itemIndex ?? 0}/{bootstrapStatus.totalItems ?? 0})
              </CardTitle>
              <CardDescription>
                {formatBootstrapPhase(bootstrapStatus.phase)} {formatBootstrapAssetName(bootstrapStatus.assetId)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Progress value={bootstrapProgressValue} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{bootstrapProgressValue}%</span>
                <span>
                  {typeof bootstrapStatus.downloadedBytes === "number" ? formatFileSize(bootstrapStatus.downloadedBytes) : "0 B"}
                  {" / "}
                  {typeof bootstrapStatus.totalBytes === "number" ? formatFileSize(bootstrapStatus.totalBytes) : "Unknown"}
                </span>
              </div>
              <p className="text-center text-xs text-muted-foreground">
                The app is temporarily locked until required binaries and voice files finish downloading.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      {generatedDeleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <Card className="w-[min(560px,92vw)] border-border/80 bg-card/95 shadow-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Delete generated audio?</CardTitle>
              <CardDescription>
                You are about to delete "{generatedDeleteTarget.title}".
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This action is permanent. You will not be able to download this audio after deleting it.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setGeneratedDeleteTarget(null)}
                  disabled={deletingGeneratedId === generatedDeleteTarget.id}
                >
                  Keep Audio
                </Button>
                <Button
                  variant="destructive"
                  disabled={deletingGeneratedId === generatedDeleteTarget.id}
                  onClick={() => {
                    const target = generatedDeleteTarget;
                    setGeneratedDeleteTarget(null);
                    void handleDeleteGenerated(target.id);
                  }}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete Permanently
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

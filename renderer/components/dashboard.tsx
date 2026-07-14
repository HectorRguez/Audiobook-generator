"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Clock3,
  Download,
  FileAudio2,
  GripVertical,
  Pause,
  Play,
  Plus,
  Settings,
  Trash2,
  XCircle
} from "lucide-react";
import type {
  AppSettings,
  GeneratedAudio,
  JobDetail,
  JobStatus,
  LogEvent,
  QueueJob,
  UpdateInfo,
  UpdateStatus,
  VoiceInfo
} from "@/lib/contracts";
import { createTauriApi, type DesktopApi } from "@/lib/tauri-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function statusVariant(status: JobStatus) {
  if (status === "error" || status === "canceled") {
    return "destructive" as const;
  }
  if (status === "done") {
    return "default" as const;
  }
  return "secondary" as const;
}

type UiLocale = "en" | "es";

interface UiStrings {
  appTitle: string;
  addEpubFiles: string;
  settings: string;
  bridgeUnavailableBadge: string;
  queueTitle: string;
  queueDescription: string;
  queueEmpty: string;
  generatedTitle: string;
  generatedDescription: string;
  noGenerated: string;
  pause: string;
  resume: string;
  cancel: string;
  estimatingEta: string;
  deleteGeneratedTitle: string;
  deleteGeneratedSubtitlePrefix: string;
  deleteGeneratedPermanentWarning: string;
  keepAudio: string;
  deletePermanently: string;
  settingsTitle: string;
  languageLabel: string;
  languageSpanish: string;
  languageEnglish: string;
  voiceLabel: string;
  updateAvailable: string;
  updateAction: string;
  updateDownloading: string;
  updateInstalling: string;
  updateWaitForIdle: string;
  updateFailed: string;
  gpuAccelerationLabel: string;
  gpuAccelerationEnabled: string;
  gpuAccelerationDisabled: string;
  close: string;
  reorderAriaPrefix: string;
  deleteQueueAriaPrefix: string;
  downloadAudioAriaPrefix: string;
  deleteAudioAriaPrefix: string;
  logPauseRequested: string;
  logExtractingChapters: string;
  logJobPaused: string;
  logJobCanceled: string;
  logStartingWithVoice: string;
  logJobFinished: string;
  logNvidiaEnabled: string;
  logNvidiaMissing: string;
  logCudaUnsupported: string;
  logNvidiaFallback: string;
  logModeCpu: string;
  logModeGpu: string;
  statusLabels: Record<JobStatus, string>;
}

function formatEta(seconds: number | null, uiStrings: UiStrings) {
  if (seconds === null || Number.isNaN(seconds)) {
    return uiStrings.estimatingEta;
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

function humanizeSpeakerName(value: string): string {
  const cleaned = value.replace(/[_-]+/g, " ").trim();
  if (!cleaned) {
    return value;
  }
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
}

function displayVoiceName(voice: VoiceInfo): string {
  if (voice.name && voice.name.trim().length > 0) {
    return voice.name.trim();
  }

  const match = voice.id.match(/^[a-z]{2}_[A-Z]{2}-(.+)-([a-z_]+)$/);
  if (match) {
    return humanizeSpeakerName(match[1] || voice.id);
  }

  return humanizeSpeakerName(voice.id);
}

function localizeStatus(status: JobStatus, uiStrings: UiStrings) {
  return uiStrings.statusLabels[status] ?? status;
}

function localizeKnownLogMessage(message: string, uiStrings: UiStrings) {
  if (message === "Pause requested; stopping after current chunk.") {
    return uiStrings.logPauseRequested;
  }
  if (message === "Extracting EPUB chapters.") {
    return uiStrings.logExtractingChapters;
  }
  if (message === "Job paused.") {
    return uiStrings.logJobPaused;
  }
  if (message === "Job canceled.") {
    return uiStrings.logJobCanceled;
  }
  if (message.startsWith("Starting job processing with voice ")) {
    const match = message.match(/^Starting job processing with voice (.+) \((.+)\)\.$/);
    if (match) {
      const voiceName = (match[1] || "-").trim();
      const modeRaw = (match[2] || "").trim();
      const mode = modeRaw === "NVIDIA GPU" ? uiStrings.logModeGpu : uiStrings.logModeCpu;
      return uiStrings.logStartingWithVoice.replace("{voice}", voiceName).replace("{mode}", mode);
    }
    const voiceName = message.replace("Starting job processing with voice ", "").replace(/\.$/, "").trim();
    return uiStrings.logStartingWithVoice
      .replace("{voice}", voiceName || "-")
      .replace("{mode}", uiStrings.logModeCpu);
  }
  if (message.startsWith("Job finished: ")) {
    const outputPath = message.replace("Job finished: ", "").trim();
    return uiStrings.logJobFinished.replace("{path}", outputPath || "-");
  }
  if (message === "NVIDIA GPU acceleration enabled for this job.") {
    return uiStrings.logNvidiaEnabled;
  }
  if (message === "NVIDIA GPU was requested but no NVIDIA GPU was detected. Using CPU.") {
    return uiStrings.logNvidiaMissing;
  }
  if (message === "Current Piper binary does not expose CUDA mode. Using CPU.") {
    return uiStrings.logCudaUnsupported;
  }
  if (message === "NVIDIA GPU acceleration failed; falling back to CPU.") {
    return uiStrings.logNvidiaFallback;
  }
  return message;
}

const UI_STRINGS: Record<UiLocale, UiStrings> = {
  en: {
    appTitle: "Audiobook Generator",
    addEpubFiles: "Add EPUB Files",
    settings: "Settings",
    bridgeUnavailableBadge: "Desktop runtime unavailable",
    queueTitle: "Processing Queue",
    queueDescription: "Drag rows to reorder. Drop EPUB files here to enqueue.",
    queueEmpty: "Queue is empty. Add one or more EPUB files.",
    generatedTitle: "Generated Audios",
    generatedDescription: "Newest first. Export any completed audiobook.",
    noGenerated: "No generated audiobooks yet.",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel",
    estimatingEta: "Estimating...",
    deleteGeneratedTitle: "Delete generated audio?",
    deleteGeneratedSubtitlePrefix: "You are about to delete",
    deleteGeneratedPermanentWarning: "This action is permanent. You will not be able to download this audio after deleting it.",
    keepAudio: "Keep Audio",
    deletePermanently: "Delete Permanently",
    settingsTitle: "Settings",
    languageLabel: "Language",
    languageSpanish: "Spanish",
    languageEnglish: "English",
    voiceLabel: "Voice",
    updateAvailable: "Update {version} is available.",
    updateAction: "Update and restart",
    updateDownloading: "Downloading update...",
    updateInstalling: "Installing update...",
    updateWaitForIdle: "Pause or finish the active job before updating.",
    updateFailed: "Update failed: {message}",
    gpuAccelerationLabel: "NVIDIA GPU acceleration",
    gpuAccelerationEnabled: "Enabled",
    gpuAccelerationDisabled: "Disabled",
    close: "Close",
    reorderAriaPrefix: "Reorder",
    deleteQueueAriaPrefix: "Delete queue item",
    downloadAudioAriaPrefix: "Download generated audio",
    deleteAudioAriaPrefix: "Delete generated audio",
    logPauseRequested: "Pause requested; stopping after current chunk.",
    logExtractingChapters: "Extracting EPUB chapters.",
    logJobPaused: "Job paused.",
    logJobCanceled: "Job canceled.",
    logStartingWithVoice: "Starting job processing with voice {voice} ({mode}).",
    logJobFinished: "Job finished: {path}",
    logNvidiaEnabled: "NVIDIA GPU acceleration enabled for this job.",
    logNvidiaMissing: "NVIDIA GPU was requested but no NVIDIA GPU was detected. Using CPU.",
    logCudaUnsupported: "Current Piper binary does not expose CUDA mode. Using CPU.",
    logNvidiaFallback: "NVIDIA GPU acceleration failed; falling back to CPU.",
    logModeCpu: "CPU",
    logModeGpu: "NVIDIA GPU",
    statusLabels: {
      queued: "Queued",
      extracting: "Extracting",
      processing: "Processing",
      encoding: "Encoding",
      done: "Done",
      error: "Error",
      paused: "Paused",
      canceled: "Canceled"
    }
  },
  es: {
    appTitle: "Generador de Audiolibros",
    addEpubFiles: "Agregar archivos EPUB",
    settings: "Ajustes",
    bridgeUnavailableBadge: "Runtime de escritorio no disponible",
    queueTitle: "Cola de procesamiento",
    queueDescription: "Arrastra filas para reordenar. Suelta archivos EPUB aqui para encolarlos.",
    queueEmpty: "La cola esta vacia. Agrega uno o mas archivos EPUB.",
    generatedTitle: "Audios generados",
    generatedDescription: "Mas recientes primero. Exporta cualquier audiolibro completado.",
    noGenerated: "Todavia no hay audiolibros generados.",
    pause: "Pausar",
    resume: "Reanudar",
    cancel: "Cancelar",
    estimatingEta: "Estimando...",
    deleteGeneratedTitle: "Eliminar audio generado?",
    deleteGeneratedSubtitlePrefix: "Estas a punto de eliminar",
    deleteGeneratedPermanentWarning: "Esta accion es permanente. No podras descargar este audio despues de eliminarlo.",
    keepAudio: "Conservar audio",
    deletePermanently: "Eliminar permanentemente",
    settingsTitle: "Ajustes",
    languageLabel: "Idioma",
    languageSpanish: "Espanol",
    languageEnglish: "Ingles",
    voiceLabel: "Voz",
    updateAvailable: "La actualizacion {version} esta disponible.",
    updateAction: "Actualizar y reiniciar",
    updateDownloading: "Descargando actualizacion...",
    updateInstalling: "Instalando actualizacion...",
    updateWaitForIdle: "Pausa o termina el trabajo activo antes de actualizar.",
    updateFailed: "La actualizacion fallo: {message}",
    gpuAccelerationLabel: "Aceleracion GPU NVIDIA",
    gpuAccelerationEnabled: "Activada",
    gpuAccelerationDisabled: "Desactivada",
    close: "Cerrar",
    reorderAriaPrefix: "Reordenar",
    deleteQueueAriaPrefix: "Eliminar elemento de la cola",
    downloadAudioAriaPrefix: "Descargar audio generado",
    deleteAudioAriaPrefix: "Eliminar audio generado",
    logPauseRequested: "Pausa solicitada; se detendra al finalizar el fragmento actual.",
    logExtractingChapters: "Extrayendo capitulos del EPUB.",
    logJobPaused: "Trabajo pausado.",
    logJobCanceled: "Trabajo cancelado.",
    logStartingWithVoice: "Iniciando procesamiento con la voz {voice} ({mode}).",
    logJobFinished: "Trabajo finalizado: {path}",
    logNvidiaEnabled: "Aceleracion GPU NVIDIA activada para este trabajo.",
    logNvidiaMissing: "Se solicito GPU NVIDIA pero no se detecto ninguna GPU NVIDIA. Se usara CPU.",
    logCudaUnsupported: "El binario actual de Piper no expone modo CUDA. Se usara CPU.",
    logNvidiaFallback: "La aceleracion GPU NVIDIA fallo; cambiando a CPU.",
    logModeCpu: "CPU",
    logModeGpu: "GPU NVIDIA",
    statusLabels: {
      queued: "En cola",
      extracting: "Extrayendo",
      processing: "Procesando",
      encoding: "Codificando",
      done: "Completado",
      error: "Error",
      paused: "Pausado",
      canceled: "Cancelado"
    }
  }
};

function resolveUiLocale(locales: readonly string[]): UiLocale {
  for (const locale of locales) {
    const normalized = locale.toLowerCase();
    if (normalized.startsWith("es")) {
      return "es";
    }
    if (normalized.startsWith("en")) {
      return "en";
    }
  }
  return "es";
}

interface SortableQueueRowProps {
  job: QueueJob;
  uiStrings: UiStrings;
  onDelete: (jobId: string) => void;
}

function SortableQueueRow({ job, uiStrings, onDelete }: SortableQueueRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: job.id
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
      className={`relative rounded-lg border border-border/70 bg-background/50 p-3 transition-shadow ${
        isDragging ? "invisible" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="touch-none cursor-grab rounded p-0.5 text-muted-foreground transition hover:text-foreground active:cursor-grabbing"
              aria-label={`${uiStrings.reorderAriaPrefix}: ${job.title}`}
              title={`${uiStrings.reorderAriaPrefix}: ${job.title}`}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4 shrink-0" />
            </button>
            <p className="truncate text-sm font-medium">{job.title}</p>
          </div>
          <p className="truncate text-xs text-muted-foreground">{job.source_name}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${uiStrings.deleteQueueAriaPrefix}: ${job.title}`}
          title={`${uiStrings.deleteQueueAriaPrefix}: ${job.title}`}
          onClick={() => onDelete(job.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {job.error_message && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {job.error_message}
        </p>
      )}
    </div>
  );
}

function QueueRowDragOverlay({ job }: { job: QueueJob }) {
  return (
    <div className="w-full rounded-lg border border-primary/60 bg-background/95 p-3 shadow-2xl ring-1 ring-primary/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">{job.title}</p>
          </div>
          <p className="truncate text-xs text-muted-foreground">{job.source_name}</p>
        </div>
      </div>
      {job.error_message && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {job.error_message}
        </p>
      )}
    </div>
  );
}

function DisabledQueueRow({ job, uiStrings }: { job: QueueJob; uiStrings: UiStrings }) {
  return (
    <div
      aria-disabled="true"
      className="pointer-events-none select-none rounded-lg border border-border/60 bg-muted/60 p-3 opacity-65 saturate-0 transition-none"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/70" />
            <p className="truncate text-sm font-medium text-muted-foreground">{job.title}</p>
          </div>
          <p className="truncate text-xs text-muted-foreground">{job.source_name}</p>
        </div>
        <Badge variant={statusVariant(job.status)}>{localizeStatus(job.status, uiStrings)}</Badge>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
  const [generated, setGenerated] = useState<GeneratedAudio[]>([]);
  const [playbackUrls, setPlaybackUrls] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [activeQueueDragId, setActiveQueueDragId] = useState<string | null>(null);
  const [queueOrderIds, setQueueOrderIds] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(true);
  const [showQueueBottomFade, setShowQueueBottomFade] = useState(false);
  const [showGeneratedBottomFade, setShowGeneratedBottomFade] = useState(false);
  const [generatedDeleteTarget, setGeneratedDeleteTarget] = useState<GeneratedAudio | null>(null);
  const [deletingGeneratedId, setDeletingGeneratedId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [uiLocale, setUiLocale] = useState<UiLocale>("es");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [defaultVoiceId, setDefaultVoiceId] = useState("");
  const [useNvidiaGpu, setUseNvidiaGpu] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const queueOrderIdsRef = useRef<string[]>([]);
  const queueContentRef = useRef<HTMLDivElement | null>(null);
  const generatedContentRef = useRef<HTMLDivElement | null>(null);

  function getApi(): DesktopApi | null {
    return createTauriApi();
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

  const refreshVoiceSettings = useCallback(async (api: NonNullable<ReturnType<typeof getApi>>) => {
    const [voiceList, settings] = await Promise.all([
      api.listVoices().catch(() => [] as VoiceInfo[]),
      api.getSettings().catch(() => ({} as Partial<AppSettings>))
    ]);
    setVoices(voiceList);

    const storedVoiceId = typeof settings.defaultVoiceId === "string" ? settings.defaultVoiceId : "";
    const fallbackVoiceId = voiceList[0]?.id || "";
    const hasStoredVoice = voiceList.some((voice) => voice.id === storedVoiceId);
    const resolvedVoiceId = hasStoredVoice ? storedVoiceId : fallbackVoiceId;
    setDefaultVoiceId(resolvedVoiceId);
    setUseNvidiaGpu(Boolean(settings.useNvidiaGpu));
    if (resolvedVoiceId && resolvedVoiceId !== storedVoiceId) {
      void api.setSettings({ defaultVoiceId: resolvedVoiceId });
    }
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
      void refreshVoiceSettings(api);
      void api.checkForUpdate().then((availableUpdate) => {
        if (availableUpdate) {
          setUpdateInfo(availableUpdate);
        }
      }).catch(() => {
        // Startup and offline use should not be blocked by update checks.
      });

      unsubs = [
        api.onQueueUpdated((payload) => setJobs(payload)),
        api.onGeneratedUpdated((payload) => setGenerated(payload)),
        api.onJobUpdated((payload) => {
          setJobDetails((current) => ({ ...current, [payload.id]: payload }));
        }),
        api.onUpdateStatus((payload) => setUpdateStatus(payload)),
        api.onLogEvent((payload) => {
          setLogs((current) => [...current.slice(-200), payload]);
        })
      ];

    };

    const currentApi = getApi();
    if (currentApi) {
      attachApi(currentApi);
    } else {
      setBridgeReady(false);
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
  }, [refresh, refreshVoiceSettings]);

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
  const processingQueueJob = runningJob;
  const queueJobIds = useMemo(() => queueJobs.map((job) => job.id), [queueJobs]);
  const queueJobsById = useMemo(
    () => new Map(queueJobs.map((job) => [job.id, job] as const)),
    [queueJobs]
  );
  const visibleQueueJobs = useMemo(() => {
    const ids = queueOrderIds.length > 0 ? queueOrderIds : queueJobIds;
    return ids
      .map((jobId) => queueJobsById.get(jobId))
      .filter((job): job is QueueJob => Boolean(job));
  }, [queueJobIds, queueJobsById, queueOrderIds]);
  const queueDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6
      }
    })
  );
  const draggedQueueJob = useMemo(
    () => (activeQueueDragId ? queueJobsById.get(activeQueueDragId) ?? null : null),
    [activeQueueDragId, queueJobsById]
  );

  const activeLog = useMemo(() => {
    if (!activeJob) {
      return null;
    }
    return [...logs].reverse().find((entry) => entry.jobId === activeJob.id) || null;
  }, [activeJob, logs]);
  const activeJobDetail = activeJob ? jobDetails[activeJob.id] : undefined;
  const uiStrings = UI_STRINGS[uiLocale];
  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === defaultVoiceId) || voices[0] || null,
    [defaultVoiceId, voices]
  );
  const updateProgressValue = updateStatus?.phase === "downloading" && updateStatus.totalBytes
    ? Math.min(100, Math.round(((updateStatus.downloadedBytes || 0) / updateStatus.totalBytes) * 100))
    : null;
  const isUpdating = updateStatus?.phase === "downloading" || updateStatus?.phase === "installing";

  useEffect(() => {
    if (typeof window === "undefined") {
      setUiLocale("es");
      return;
    }

    const storedLocale = window.localStorage.getItem("ui-locale");
    if (storedLocale === "es" || storedLocale === "en") {
      setUiLocale(storedLocale);
      return;
    }

    const browserLocales = navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
    setUiLocale(resolveUiLocale(browserLocales));
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("ui-locale", uiLocale);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = uiLocale;
      document.title = uiStrings.appTitle;
    }
  }, [uiLocale, uiStrings.appTitle]);

  useEffect(() => {
    if (activeQueueDragId) {
      return;
    }
    setQueueOrderIds(queueJobIds);
  }, [activeQueueDragId, queueJobIds]);

  useEffect(() => {
    queueOrderIdsRef.current = queueOrderIds;
  }, [queueOrderIds]);

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
    if (!api) {
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
  }, [generated, playbackUrls]);

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

  async function handleVoiceChange(nextVoiceId: string) {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    const previous = defaultVoiceId;
    setDefaultVoiceId(nextVoiceId);
    setSettingsBusy(true);
    try {
      await api.setSettings({ defaultVoiceId: nextVoiceId });
    } catch {
      setDefaultVoiceId(previous);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleGpuAccelerationChange(nextValue: boolean) {
    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      return;
    }

    const previous = useNvidiaGpu;
    setUseNvidiaGpu(nextValue);
    setSettingsBusy(true);
    try {
      await api.setSettings({ useNvidiaGpu: nextValue });
    } catch {
      setUseNvidiaGpu(previous);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleInstallUpdate() {
    const api = getApi();
    if (!api || !updateInfo || runningJob || isUpdating) {
      return;
    }

    setUpdateStatus({
      phase: "downloading",
      version: updateInfo.version,
      downloadedBytes: 0,
      totalBytes: null
    });
    try {
      await api.installUpdate();
    } catch (error) {
      setUpdateStatus({
        phase: "error",
        version: updateInfo.version,
        message: error instanceof Error ? error.message : String(error)
      });
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

  function handleQueueDragStart(event: DragStartEvent) {
    const dragId = String(event.active.id);
    if (!queueJobsById.has(dragId)) {
      return;
    }
    setActiveQueueDragId(dragId);
    setQueueOrderIds((current) => (current.length > 0 ? current : queueJobIds));
  }

  function handleQueueDragOver(event: DragOverEvent) {
    if (!event.over) {
      return;
    }
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId === overId) {
      return;
    }

    setQueueOrderIds((current) => {
      const base = current.length > 0 ? current : queueJobIds;
      const from = base.indexOf(activeId);
      const to = base.indexOf(overId);
      if (from < 0 || to < 0 || from === to) {
        return base;
      }
      return arrayMove(base, from, to);
    });
  }

  function handleQueueDragCancel() {
    setActiveQueueDragId(null);
    setQueueOrderIds(queueJobIds);
  }

  async function handleQueueDragEnd(event: DragEndEvent) {
    setActiveQueueDragId(null);

    const api = getApi();
    if (!api) {
      setBridgeReady(false);
      setQueueOrderIds(queueJobIds);
      return;
    }

    if (!event.over) {
      setQueueOrderIds(queueJobIds);
      return;
    }

    const nextOrder = queueOrderIdsRef.current.length > 0 ? queueOrderIdsRef.current : queueJobIds;
    const reorderIds = nextOrder.filter((jobId) => queueJobsById.has(jobId));
    if (reorderIds.length > 1) {
      await api.reorderQueue(reorderIds);
    }
    setQueueOrderIds(reorderIds);
  }

  return (
    <main className="h-screen w-full p-4 lg:p-6">
      <div className="mx-auto flex h-full max-w-[1800px] flex-col gap-4">
        <header className="flex items-start gap-3">
          <h1 className="text-left text-2xl font-semibold">{uiStrings.appTitle}</h1>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {!bridgeReady && <Badge variant="destructive">{uiStrings.bridgeUnavailableBadge}</Badge>}
            <Button onClick={addFiles} disabled={isBusy}>
              <Plus className="h-4 w-4" /> {uiStrings.addEpubFiles}
            </Button>
            <Button className="ml-1" variant="outline" onClick={() => setIsSettingsOpen(true)}>
              <Settings className="h-4 w-4" /> {uiStrings.settings}
            </Button>
          </div>
        </header>

        {updateInfo && (
          <section className="flex flex-wrap items-center gap-3 border-y border-border/70 px-1 py-3">
            <Download className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-[240px] flex-1">
              <p className="text-sm font-medium">
                {uiStrings.updateAvailable.replace("{version}", updateInfo.version)}
              </p>
              {runningJob && <p className="text-xs text-muted-foreground">{uiStrings.updateWaitForIdle}</p>}
              {updateStatus?.phase === "downloading" && (
                <p className="text-xs text-muted-foreground">
                  {uiStrings.updateDownloading}
                  {updateStatus.downloadedBytes !== null && updateStatus.downloadedBytes !== undefined
                    ? ` ${formatFileSize(updateStatus.downloadedBytes)}`
                    : ""}
                  {updateStatus.totalBytes ? ` / ${formatFileSize(updateStatus.totalBytes)}` : ""}
                </p>
              )}
              {updateStatus?.phase === "installing" && (
                <p className="text-xs text-muted-foreground">{uiStrings.updateInstalling}</p>
              )}
              {updateStatus?.phase === "error" && (
                <p className="text-xs text-destructive">
                  {uiStrings.updateFailed.replace("{message}", updateStatus.message || "Unknown error")}
                </p>
              )}
              {updateProgressValue !== null && <Progress className="mt-2 h-1.5" value={updateProgressValue} />}
            </div>
            <Button
              size="sm"
              onClick={() => void handleInstallUpdate()}
              disabled={Boolean(runningJob) || isUpdating}
            >
              <Download className="h-4 w-4" /> {uiStrings.updateAction}
            </Button>
          </section>
        )}

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
              <CardTitle>{uiStrings.queueTitle}</CardTitle>
              <CardDescription>{uiStrings.queueDescription}</CardDescription>
            </CardHeader>
            <CardContent ref={queueContentRef} className="relative min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
              {!processingQueueJob && visibleQueueJobs.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 bg-background/30 p-4 text-sm text-muted-foreground">
                  {uiStrings.queueEmpty}
                </p>
              ) : (
                <>
                  {processingQueueJob && (
                    <div className="relative z-10">
                      <DisabledQueueRow job={processingQueueJob} uiStrings={uiStrings} />
                    </div>
                  )}
                  {visibleQueueJobs.length > 0 && (
                    <DndContext
                      sensors={queueDragSensors}
                      collisionDetection={closestCenter}
                      modifiers={[restrictToVerticalAxis]}
                      onDragStart={handleQueueDragStart}
                      onDragOver={handleQueueDragOver}
                      onDragCancel={handleQueueDragCancel}
                      onDragEnd={(event) => {
                        void handleQueueDragEnd(event);
                      }}
                    >
                      <SortableContext
                        items={visibleQueueJobs.map((job) => job.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="space-y-2">
                          {visibleQueueJobs.map((job) => (
                            <SortableQueueRow
                              key={job.id}
                              job={job}
                              uiStrings={uiStrings}
                              onDelete={(jobId) => void getApi()?.deleteJob(jobId, false)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                      <DragOverlay zIndex={2000}>
                        {draggedQueueJob ? <QueueRowDragOverlay job={draggedQueueJob} /> : null}
                      </DragOverlay>
                    </DndContext>
                  )}
                </>
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
                    </div>
                    <p className="line-clamp-2 text-sm font-semibold">{activeJob.title}</p>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{activeJob.source_name}</p>
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {["queued", "extracting", "processing", "encoding"].includes(activeJob.status) && (
                      <Button size="sm" variant="secondary" onClick={() => void getApi()?.pauseJob(activeJob.id)}>
                        <Pause className="mr-1 h-3.5 w-3.5" /> {uiStrings.pause}
                      </Button>
                    )}
                    {["paused", "error"].includes(activeJob.status) && (
                      <Button size="sm" variant="secondary" onClick={() => void getApi()?.resumeJob(activeJob.id)}>
                        <Play className="mr-1 h-3.5 w-3.5" /> {uiStrings.resume}
                      </Button>
                    )}
                    {!["done", "canceled"].includes(activeJob.status) && (
                      <Button size="sm" variant="destructive" onClick={() => void getApi()?.cancelJob(activeJob.id)}>
                        <XCircle className="mr-1 h-3.5 w-3.5" /> {uiStrings.cancel}
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Progress value={Math.round((activeJob.progress || 0) * 100)} />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{Math.round((activeJob.progress || 0) * 100)}%</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatEta(activeJob.eta_seconds, uiStrings)}
                      </span>
                    </div>
                  </div>

                  {activeLog && (
                    <div className="rounded-lg border border-primary/35 bg-primary/10 p-3">
                      <p className="text-sm text-foreground">{localizeKnownLogMessage(activeLog.message, uiStrings)}</p>
                    </div>
                  )}

                  {activeJobDetail?.chapters && (
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-background/40 px-2 pb-2 pt-3">
                      {activeJobDetail.chapters.map((chapter, index) => (
                        <div key={chapter.id} className="flex items-center justify-between rounded-md px-2 py-1 text-xs">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="w-6 shrink-0 text-right text-muted-foreground">{index + 1}.</span>
                            <span className="truncate">{chapter.title}</span>
                          </div>
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
              <CardTitle>{uiStrings.generatedTitle}</CardTitle>
              <CardDescription>{uiStrings.generatedDescription}</CardDescription>
            </CardHeader>
            <CardContent ref={generatedContentRef} className="relative min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
              {generated.length === 0 ? (
                <p className="text-sm text-muted-foreground">{uiStrings.noGenerated}</p>
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
                          variant="ghost"
                          aria-label={`${uiStrings.downloadAudioAriaPrefix}: ${output.title}`}
                          title={`${uiStrings.downloadAudioAriaPrefix}: ${output.title}`}
                          onClick={() => void getApi()?.downloadGeneratedAudio(output.id)}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={deletingGeneratedId === output.id}
                          aria-label={`${uiStrings.deleteAudioAriaPrefix}: ${output.title}`}
                          title={`${uiStrings.deleteAudioAriaPrefix}: ${output.title}`}
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
      {generatedDeleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <Card className="w-[min(560px,92vw)] border-border/80 bg-card/95 shadow-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{uiStrings.deleteGeneratedTitle}</CardTitle>
              <CardDescription>
                {uiStrings.deleteGeneratedSubtitlePrefix} &quot;{generatedDeleteTarget.title}&quot;.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {uiStrings.deleteGeneratedPermanentWarning}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setGeneratedDeleteTarget(null)}
                  disabled={deletingGeneratedId === generatedDeleteTarget.id}
                >
                  {uiStrings.keepAudio}
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
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> {uiStrings.deletePermanently}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <Card className="w-[min(560px,92vw)] border-border/80 bg-card/95 shadow-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{uiStrings.settingsTitle}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="ui-language" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {uiStrings.languageLabel}
                </label>
                <Select
                  value={uiLocale}
                  onValueChange={(value) => setUiLocale(value as UiLocale)}
                >
                  <SelectTrigger id="ui-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">{uiStrings.languageSpanish}</SelectItem>
                    <SelectItem value="en">{uiStrings.languageEnglish}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label htmlFor="default-voice" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {uiStrings.voiceLabel}
                </label>
                <Select
                  value={selectedVoice?.id || ""}
                  onValueChange={(value) => {
                    void handleVoiceChange(value);
                  }}
                  disabled={settingsBusy || voices.length === 0}
                >
                  <SelectTrigger id="default-voice">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {displayVoiceName(voice)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label htmlFor="gpu-acceleration" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {uiStrings.gpuAccelerationLabel}
                </label>
                <Select
                  value={useNvidiaGpu ? "enabled" : "disabled"}
                  onValueChange={(value) => {
                    void handleGpuAccelerationChange(value === "enabled");
                  }}
                  disabled={settingsBusy}
                >
                  <SelectTrigger id="gpu-acceleration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="enabled">{uiStrings.gpuAccelerationEnabled}</SelectItem>
                    <SelectItem value="disabled">{uiStrings.gpuAccelerationDisabled}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => setIsSettingsOpen(false)}>
                  {uiStrings.close}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell
} from "electron";
import { autoUpdater } from "electron-updater";
import { Repository } from "./db/repository";
import { QueueManager } from "./services/queue-manager";
import { ensureRuntimeAssets } from "./services/sidecar-bootstrap";
import { commands, events } from "./ipc/channels";
import type { AppSettings, VoiceInfo } from "./types";

let mainWindow: BrowserWindow | null = null;
let repo: Repository | null = null;
let queueManager: QueueManager | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "audiobook",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const DEV_URL = process.env.ELECTRON_START_URL || "http://127.0.0.1:3000";
const EMBEDDED_GH_TOKEN =
  "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";

let hasStartedAutoUpdateCheck = false;
let isQuitting = false;

function rendererIndexPath(): string {
  return path.join(app.getAppPath(), "renderer", "out", "index.html");
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    await window.loadURL(DEV_URL);
    return;
  }

  const indexPath = rendererIndexPath();
  await window.loadURL(pathToFileURL(indexPath).toString());
}

function createWindow(): void {
  const appIconPath = path.join(app.getAppPath(), "renderer", "public", "app-icon.png");
  const windowOptions = {
    width: 1680,
    height: 980,
    minWidth: 1280,
    minHeight: 760,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  if (process.platform !== "darwin") {
    Object.assign(windowOptions, { icon: appIconPath });
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload error at ${preloadPath}:`, error);
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
  });

  void loadRenderer(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function initUpdater(): void {
  if (hasStartedAutoUpdateCheck) {
    return;
  }

  hasStartedAutoUpdateCheck = true;

  if (!app.isPackaged || process.platform !== "win32") {
    return;
  }

  if (!process.env.GH_TOKEN) {
    process.env.GH_TOKEN = EMBEDDED_GH_TOKEN;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  const sanitizeUpdaterError = (error: unknown): string => {
    const text = error instanceof Error ? error.message : String(error);
    return text.replaceAll(EMBEDDED_GH_TOKEN, "[REDACTED]");
  };

  autoUpdater.on("error", (error) => {
    console.error(`Auto-update failed: ${sanitizeUpdaterError(error)}`);
  });

  autoUpdater.on("update-available", (info) => {
    console.info(`Update available: ${info.version}`);
  });

  autoUpdater.on("update-not-available", () => {
    console.info("No updates available.");
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.info(`Update downloaded (${info.version}). Installing now.`);
    setTimeout(() => {
      if (!isQuitting) {
        autoUpdater.quitAndInstall(false, true);
      }
    }, 500);
  });

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error(`Auto-update check failed: ${sanitizeUpdaterError(error)}`);
  });
}

function requireQueueManager(): QueueManager {
  if (!queueManager) {
    throw new Error("Queue manager is not initialized.");
  }
  return queueManager;
}

function registerIpcHandlers(): void {
  ipcMain.handle(commands.PICK_EPUB_FILES, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "EPUB files", extensions: ["epub"] }]
    });

    if (result.canceled) {
      return [] as string[];
    }

    return result.filePaths;
  });

  ipcMain.handle(commands.ENQUEUE_EPUB_FILES, async (_event, filePaths: unknown) => {
    const qm = requireQueueManager();
    return qm.enqueueEpubFiles(Array.isArray(filePaths) ? (filePaths as string[]) : []);
  });

  ipcMain.handle(commands.LIST_JOBS, async () => requireQueueManager().listJobs());
  ipcMain.handle(commands.GET_JOB, async (_event, jobId: string) => requireQueueManager().getJob(jobId));

  ipcMain.handle(commands.REORDER_QUEUE, async (_event, jobIdsInOrder: unknown) => {
    const qm = requireQueueManager();
    qm.reorderQueue(Array.isArray(jobIdsInOrder) ? (jobIdsInOrder as string[]) : []);
    return qm.listJobs();
  });

  ipcMain.handle(commands.PAUSE_JOB, async (_event, jobId: string) => {
    const qm = requireQueueManager();
    qm.pauseJob(jobId);
    return qm.getJob(jobId);
  });

  ipcMain.handle(commands.RESUME_JOB, async (_event, jobId: string) => {
    const qm = requireQueueManager();
    qm.resumeJob(jobId);
    return qm.getJob(jobId);
  });

  ipcMain.handle(commands.CANCEL_JOB, async (_event, jobId: string) => {
    const qm = requireQueueManager();
    qm.cancelJob(jobId);
    return qm.getJob(jobId);
  });

  ipcMain.handle(commands.DELETE_JOB, async (_event, jobId: string, deleteOutputs: boolean) => {
    const qm = requireQueueManager();
    if (deleteOutputs) {
      const outputs = qm.getGeneratedAudiosByJob(jobId);
      await Promise.all(outputs.map((output) => fs.rm(output.file_path, { force: true }).catch(() => {})));
    }
    qm.deleteJob(jobId);
    return qm.listJobs();
  });

  ipcMain.handle(commands.LIST_GENERATED, async () => requireQueueManager().listGeneratedAudios());
  ipcMain.handle(commands.DELETE_GENERATED, async (_event, outputId: string) => {
    const qm = requireQueueManager();
    const output = qm.getGeneratedAudio(outputId);
    if (!output) {
      return qm.listGeneratedAudios();
    }
    await fs.rm(output.file_path, { force: true }).catch(() => {});
    qm.deleteGeneratedAudio(outputId);
    return qm.listGeneratedAudios();
  });
  ipcMain.handle(commands.GET_GENERATED_PLAYBACK_URL, async (_event, outputId: string) => {
    const qm = requireQueueManager();
    const output = qm.getGeneratedAudio(outputId);
    if (!output) {
      throw new Error("Generated audio not found.");
    }
    return `audiobook://generated/${encodeURIComponent(outputId)}`;
  });

  ipcMain.handle(commands.DOWNLOAD_GENERATED, async (_event, outputId: string) => {
    const qm = requireQueueManager();
    const output = qm.getGeneratedAudio(outputId);
    if (!output) {
      throw new Error("Generated audio not found.");
    }

    const result = await dialog.showSaveDialog({
      title: "Export audiobook",
      defaultPath: path.basename(output.file_path)
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true as const };
    }

    await fs.copyFile(output.file_path, result.filePath);
    return { canceled: false as const, filePath: result.filePath };
  });

  ipcMain.handle(commands.OPEN_OUTPUT_FOLDER, async (_event, jobId: string) => {
    const qm = requireQueueManager();
    const job = qm.getJob(jobId);
    if (!job) {
      return;
    }
    await shell.openPath(job.output_dir);
  });

  ipcMain.handle(commands.GET_SETTINGS, async () => requireQueueManager().getSettings());
  ipcMain.handle(commands.SET_SETTINGS, async (_event, patch: Partial<AppSettings>) => requireQueueManager().setSettings(patch || {}));

  ipcMain.handle(commands.LIST_VOICES, async (): Promise<VoiceInfo[]> => {
    return requireQueueManager().listVoices();
  });

  ipcMain.handle(commands.BOOTSTRAP_ASSETS, async () => requireQueueManager().bootstrapAssets());
}

function registerCustomProtocols(): void {
  protocol.handle("audiobook", async (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname !== "generated") {
        return new Response("Not found", { status: 404 });
      }

      const outputId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      if (!outputId) {
        return new Response("Missing output id", { status: 400 });
      }

      const output = requireQueueManager().getGeneratedAudio(outputId);
      if (!output) {
        return new Response("Generated audio not found", { status: 404 });
      }

      return net.fetch(pathToFileURL(output.file_path).toString());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unexpected protocol error";
      return new Response(message, { status: 500 });
    }
  });
}

function wireQueueEvents(): void {
  const qm = requireQueueManager();
  qm.on("queueUpdated", (payload) => sendToRenderer(events.QUEUE_UPDATED, payload));
  qm.on("jobUpdated", (payload) => sendToRenderer(events.JOB_UPDATED, payload));
  qm.on("generatedUpdated", (payload) => sendToRenderer(events.GENERATED_UPDATED, payload));
  qm.on("logEvent", (payload) => sendToRenderer(events.LOG_EVENT, payload));
  qm.on("bootstrapStatusUpdated", (payload) => sendToRenderer(events.BOOTSTRAP_STATUS, payload));
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "db", "app.sqlite");

  repo = new Repository(dbPath);

  const defaultOutputDir = path.join(app.getPath("documents"), "Audiobooks");
  repo.ensureDefaults({
    defaultOutputDir,
    defaultVoiceId: "es_ES-carlfm-high",
    defaultOutputFormat: "mp3",
    keepIntermediates: false,
    maxConcurrentJobs: 1,
    useNvidiaGpu: false
  });

  queueManager = new QueueManager({
    repo,
    appDataDir: userData,
    ensureRuntimeAssets
  });

  wireQueueEvents();
  registerIpcHandlers();
  await queueManager.initialize();
}

app.whenReady().then(async () => {
  await bootstrap();
  registerCustomProtocols();
  createWindow();
  initUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error: unknown) => {
  console.error("Failed to bootstrap Electron app:", error);
  app.quit();
});

process.on("unhandledRejection", (error: unknown) => {
  console.error("Unhandled rejection in main process:", error);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  repo?.close();
});

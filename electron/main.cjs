const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell
} = require("electron");
const { autoUpdater } = require("electron-updater");
const { Repository } = require("./db/repository.cjs");
const { QueueManager } = require("./services/queue-manager.cjs");
const { ensureRuntimeAssets } = require("./services/sidecar-bootstrap.cjs");
const { commands, events } = require("./ipc/channels.cjs");

let mainWindow = null;
let repo = null;
let queueManager = null;

const DEV_URL = process.env.ELECTRON_START_URL || "http://127.0.0.1:3000";

function rendererIndexPath() {
  return path.join(app.getAppPath(), "renderer", "out", "index.html");
}

async function loadRenderer(window) {
  if (!app.isPackaged) {
    await window.loadURL(DEV_URL);
    return;
  }

  const indexPath = rendererIndexPath();
  await window.loadURL(pathToFileURL(indexPath).toString());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1280,
    minHeight: 760,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void loadRenderer(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function initUpdater() {
  if (!app.isPackaged || process.platform !== "win32") {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("error", (error) => {
    console.error("Auto-updater error", error);
  });

  autoUpdater.on("update-available", (info) => {
    console.info(`Update available: ${info.version}`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.info(`Update downloaded: ${info.version}`);
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
  });

  void autoUpdater.checkForUpdates().catch((error) => {
    console.error("Failed to check for updates", error);
  });
}

function registerIpcHandlers() {
  ipcMain.handle(commands.PICK_EPUB_FILES, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "EPUB files", extensions: ["epub"] }]
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths;
  });

  ipcMain.handle(commands.ENQUEUE_EPUB_FILES, async (_event, filePaths) => {
    return queueManager.enqueueEpubFiles(filePaths || []);
  });

  ipcMain.handle(commands.LIST_JOBS, async () => queueManager.listJobs());
  ipcMain.handle(commands.GET_JOB, async (_event, jobId) => queueManager.getJob(jobId));

  ipcMain.handle(commands.REORDER_QUEUE, async (_event, jobIdsInOrder) => {
    queueManager.reorderQueue(jobIdsInOrder || []);
    return queueManager.listJobs();
  });

  ipcMain.handle(commands.PAUSE_JOB, async (_event, jobId) => {
    queueManager.pauseJob(jobId);
    return queueManager.getJob(jobId);
  });

  ipcMain.handle(commands.RESUME_JOB, async (_event, jobId) => {
    queueManager.resumeJob(jobId);
    return queueManager.getJob(jobId);
  });

  ipcMain.handle(commands.CANCEL_JOB, async (_event, jobId) => {
    queueManager.cancelJob(jobId);
    return queueManager.getJob(jobId);
  });

  ipcMain.handle(commands.DELETE_JOB, async (_event, jobId, deleteOutputs) => {
    if (deleteOutputs) {
      const outputs = queueManager.getGeneratedAudiosByJob(jobId);
      await Promise.all(outputs.map((output) => fs.rm(output.file_path, { force: true }).catch(() => {})));
    }
    queueManager.deleteJob(jobId);
    return queueManager.listJobs();
  });

  ipcMain.handle(commands.LIST_GENERATED, async () => queueManager.listGeneratedAudios());

  ipcMain.handle(commands.DOWNLOAD_GENERATED, async (_event, outputId) => {
    const output = queueManager.getGeneratedAudio(outputId);
    if (!output) {
      throw new Error("Generated audio not found.");
    }

    const result = await dialog.showSaveDialog({
      title: "Export audiobook",
      defaultPath: path.basename(output.file_path)
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await fs.copyFile(output.file_path, result.filePath);
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle(commands.OPEN_OUTPUT_FOLDER, async (_event, jobId) => {
    const job = queueManager.getJob(jobId);
    if (!job) {
      return;
    }
    await shell.openPath(job.output_dir);
  });

  ipcMain.handle(commands.GET_SETTINGS, async () => queueManager.getSettings());
  ipcMain.handle(commands.SET_SETTINGS, async (_event, patch) => queueManager.setSettings(patch || {}));

  ipcMain.handle(commands.LIST_VOICES, async () => {
    return [
      {
        id: "es_ES-davefx-medium",
        name: "Español (es_ES-davefx-medium)",
        modelPath: process.env.PIPER_VOICE_MODEL || null
      }
    ];
  });

  ipcMain.handle(commands.BOOTSTRAP_ASSETS, async () => {
    return queueManager.bootstrapAssets();
  });
}

function wireQueueEvents() {
  queueManager.on("queueUpdated", (payload) => sendToRenderer(events.QUEUE_UPDATED, payload));
  queueManager.on("jobUpdated", (payload) => sendToRenderer(events.JOB_UPDATED, payload));
  queueManager.on("generatedUpdated", (payload) => sendToRenderer(events.GENERATED_UPDATED, payload));
  queueManager.on("logEvent", (payload) => sendToRenderer(events.LOG_EVENT, payload));
  queueManager.on("bootstrapStatusUpdated", (payload) => sendToRenderer(events.BOOTSTRAP_STATUS, payload));
}

async function bootstrap() {
  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "db", "app.sqlite");

  repo = new Repository(dbPath);

  const defaultOutputDir = path.join(app.getPath("documents"), "Audiobooks");
  repo.ensureDefaults({
    defaultOutputDir,
    defaultVoiceId: "es_ES-davefx-medium",
    defaultOutputFormat: "mp3",
    keepIntermediates: false,
    maxConcurrentJobs: 1
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
  createWindow();
  initUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error("Failed to bootstrap Electron app:", error);
  app.quit();
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection in main process:", error);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (repo) {
    repo.close();
  }
});

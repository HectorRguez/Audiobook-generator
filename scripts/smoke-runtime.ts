import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import type { Readable } from "node:stream";

interface RuntimeManifest {
  pythonExe: string;
  piperServerEntrypoint: string;
  ffmpegExe: string;
  voices: Array<{
    id: string;
    locale: string;
    modelPath: string;
    configPath: string;
  }>;
}

const SMOKE_TEXT: Record<"en" | "es", string> = {
  en: "A short English voice test for the audiobook generator.",
  es: "Prueba corta de voz para el generador de audiolibros."
};

function parseArg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) {
    return match.slice(prefix.length);
  }
  const flagIndex = process.argv.indexOf(`--${name}`);
  const flagValue = process.argv[flagIndex + 1];
  if (flagIndex >= 0 && flagValue) {
    return flagValue;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing --${name}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function spawnServer(
  root: string,
  manifest: RuntimeManifest,
  voice: RuntimeManifest["voices"][number],
  port: number
): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(path.resolve(root, manifest.pythonExe), [
    "-m",
    manifest.piperServerEntrypoint,
    "--model",
    path.resolve(root, voice.modelPath),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--sentence-silence",
    "0.25"
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

async function waitForReady(port: number, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/voices`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Piper /voices.\n${diagnostics()}`);
}

function validateWav(bytes: Buffer, voiceId: string): void {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Piper returned an invalid WAV header for ${voiceId}`);
  }
  let offset = 12;
  let sampleRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && chunkStart + chunkSize <= bytes.length) {
      sampleRate = bytes.readUInt32LE(chunkStart + 4);
    } else if (chunkId === "data") {
      dataBytes = Math.min(chunkSize, bytes.length - chunkStart);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (sampleRate <= 0 || dataBytes <= 0) {
    throw new Error(`Piper returned an empty or malformed WAV for ${voiceId}`);
  }
}

function toolEnv(command: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const libDir = path.join(path.dirname(command), "lib");
  const key = process.platform === "win32" ? "PATH" : "LD_LIBRARY_PATH";
  env[key] = [libDir, env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: toolEnv(command),
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}`));
      }
    });
  });
}

async function smokeFinalEncoders(root: string, manifest: RuntimeManifest, wavPath: string): Promise<void> {
  const ffmpeg = path.resolve(root, manifest.ffmpegExe);
  const outputs = [
    { path: path.join(".cache", "runtime-smoke", "ffmpeg-smoke.mp3"), args: ["-c:a", "libmp3lame", "-q:a", "2"] },
    { path: path.join(".cache", "runtime-smoke", "ffmpeg-smoke.m4b"), args: ["-c:a", "aac", "-b:a", "128k"] }
  ];
  for (const output of outputs) {
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", wavPath, ...output.args, output.path]);
    if ((await fs.stat(output.path)).size < 1_000) {
      throw new Error(`FFmpeg produced an unexpectedly small ${path.extname(output.path)} file`);
    }
  }
  console.log("Runtime smoke test passed for bundled MP3 and M4B encoding.");
}

async function smokeVoice(
  root: string,
  manifest: RuntimeManifest,
  voice: RuntimeManifest["voices"][number]
): Promise<void> {
  const port = await freePort();
  const server = spawnServer(root, manifest, voice, port);
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    await waitForReady(port, () => `stdout:\n${stdout}\nstderr:\n${stderr}`);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: voice.locale.toLowerCase().startsWith("en") ? SMOKE_TEXT.en : SMOKE_TEXT.es
      })
    });
    if (!response.ok) {
      throw new Error(`Piper HTTP synthesis failed for ${voice.id} with ${response.status}: ${await response.text()}`);
    }
    const outDir = path.join(".cache", "runtime-smoke");
    await fs.mkdir(outDir, { recursive: true });
    const wavPath = path.join(outDir, `${voice.id}.wav`);
    const wavBytes = Buffer.from(await response.arrayBuffer());
    validateWav(wavBytes, voice.id);
    await fs.writeFile(wavPath, wavBytes);
    if (/Traceback|Error processing line/.test(stderr)) {
      throw new Error(`Embedded Python reported a startup error for ${voice.id}:\n${stderr}`);
    }
    console.log(`Runtime smoke test passed for ${voice.id}: ${wavPath}`);
  } finally {
    server.kill();
    await Promise.race([
      once(server, "close"),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    if (server.exitCode !== 0 && (stdout || stderr)) {
      console.error(`Piper stdout:\n${stdout}\nPiper stderr:\n${stderr}`);
    }
  }
}

async function main(): Promise<void> {
  const root = parseArg("runtime", path.join("runtime", "dist", `${process.platform}-${process.arch}`));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "runtime-manifest.json"), "utf8")) as RuntimeManifest;
  if (manifest.voices.length === 0) {
    throw new Error("Runtime manifest has no voices.");
  }

  const voices = process.argv.includes("--all-voices")
    ? manifest.voices
    : manifest.voices.slice(0, 1);
  let firstWav: string | undefined;
  for (const voice of voices) {
    await smokeVoice(root, manifest, voice);
    firstWav ||= path.join(".cache", "runtime-smoke", `${voice.id}.wav`);
  }
  if (firstWav) {
    await smokeFinalEncoders(root, manifest, firstWav);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

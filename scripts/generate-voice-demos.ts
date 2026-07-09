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
    modelPath: string;
    configPath: string;
  }>;
}

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
    "--config",
    path.resolve(root, voice.configPath),
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
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
      // Retry until the server starts or the deadline expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Piper /voices.\n${diagnostics()}`);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false
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

async function stopServer(server: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (server.exitCode !== null || server.killed) {
    return;
  }
  server.kill();
  await Promise.race([
    once(server, "close"),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
}

async function synthesizeDemo(
  root: string,
  manifest: RuntimeManifest,
  voice: RuntimeManifest["voices"][number],
  outDir: string
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
        text: "Una muestra breve de esta voz para el generador de audiolibros."
      })
    });
    if (!response.ok) {
      throw new Error(`Piper HTTP synthesis failed for ${voice.id} with ${response.status}: ${await response.text()}`);
    }

    const cacheDir = path.join(".cache", "voice-demos");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    const wavPath = path.join(cacheDir, `${voice.id}.wav`);
    const mp3Path = path.join(outDir, `${voice.id}.mp3`);
    await fs.writeFile(wavPath, Buffer.from(await response.arrayBuffer()));
    await run(path.resolve(root, manifest.ffmpegExe), [
      "-y",
      "-i",
      wavPath,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "48k",
      mp3Path
    ]);
    console.log(`Generated ${mp3Path}`);
  } finally {
    await stopServer(server);
    if (server.exitCode !== 0 && (stdout || stderr)) {
      console.error(`Piper stdout:\n${stdout}\nPiper stderr:\n${stderr}`);
    }
  }
}

async function main(): Promise<void> {
  const root = parseArg("runtime", path.join("runtime", "dist", `${process.platform}-${process.arch}`));
  const outDir = parseArg("out", path.join("dist-site", "voice-demos"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "runtime-manifest.json"), "utf8")) as RuntimeManifest;
  if (manifest.voices.length === 0) {
    throw new Error("Runtime manifest has no voices.");
  }
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  for (const voice of manifest.voices) {
    await synthesizeDemo(root, manifest, voice, outDir);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

interface VoiceDefinition {
  id: string;
  name: string;
  locale: string;
  quality: string;
  sampleRate: number;
  modelUrl: string;
  configUrl: string;
  sourceUrl: string;
  modelCardUrl: string;
  licenseId: string;
  licenseName: string;
  licenseUrl: string;
  usageNote: string;
  attribution: string;
}

interface PythonAssetSelection {
  assetName: string;
  downloadUrl: string;
  pythonBuildStandaloneVersion: string;
}

const TARGET_TRIPLES: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu"
};

const PIPER_VERSION = "1.4.2";
const PYTHON_VERSION = "3.10.20";
const PYTHON_ABI_VERSION = "3.10";
const PIPER_SOURCE_URL = `https://github.com/OHF-Voice/piper1-gpl/archive/refs/tags/v${PIPER_VERSION}.tar.gz`;
const VOICE_STRING_FIELDS: Array<keyof VoiceDefinition> = [
  "id",
  "name",
  "locale",
  "quality",
  "modelUrl",
  "configUrl",
  "sourceUrl",
  "modelCardUrl",
  "licenseId",
  "licenseName",
  "licenseUrl",
  "usageNote",
  "attribution"
];

function parseVoiceDefinitions(value: unknown): VoiceDefinition[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { voices?: unknown }).voices)) {
    throw new Error("runtime/voices.json must contain a voices array.");
  }

  const voices = (value as { voices: unknown[] }).voices;
  for (const [index, candidate] of voices.entries()) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`runtime/voices.json voices[${index}] must be an object.`);
    }
    const voice = candidate as Partial<VoiceDefinition>;
    for (const field of VOICE_STRING_FIELDS) {
      if (typeof voice[field] !== "string" || (voice[field] as string).trim() === "") {
        throw new Error(`runtime/voices.json voices[${index}].${field} must be a non-empty string.`);
      }
    }
    if (!Number.isInteger(voice.sampleRate) || (voice.sampleRate || 0) <= 0) {
      throw new Error(`runtime/voices.json voices[${index}].sampleRate must be a positive integer.`);
    }
    if (voice.licenseId !== "LicenseRef-Public-Domain") {
      const licensePath = path.join("runtime", "licenses", `${voice.licenseId}.txt`);
      if (!fsSync.existsSync(licensePath)) {
        throw new Error(`Missing bundled license text for ${voice.id}: ${licensePath}`);
      }
    }
  }

  return voices as VoiceDefinition[];
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

function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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

function runForOutput(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function download(url: string, target: string): Promise<void> {
  if (fsSync.existsSync(target)) {
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partialPath = `${target}.partial`;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await fs.rm(partialPath, { force: true });
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(300_000),
        headers: { "User-Agent": "audiobook-generator-runtime-builder" }
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(partialPath, buffer);
      await fs.rename(partialPath, target);
      return;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
      }
    }
  }
  throw new Error(`Failed to download ${url}: ${failures.join("; ")}`);
}

async function copyCachedDownload(url: string, cachePath: string, target: string): Promise<void> {
  await download(url, cachePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(cachePath, target);
}

async function selectPythonAsset(target: string): Promise<PythonAssetSelection> {
  const triple = TARGET_TRIPLES[target];
  if (!triple) {
    throw new Error(`Unsupported runtime target: ${target}`);
  }
  const releaseRef = process.env.PYTHON_BUILD_STANDALONE_RELEASE || "20260718";
  const url = releaseRef === "latest"
    ? "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
    : `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${releaseRef}`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "audiobook-generator-runtime-builder"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to read python-build-standalone release metadata: ${response.status}`);
  }
  const release = await response.json() as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  const asset = release.assets.find((candidate) => {
    return candidate.name.startsWith(`cpython-${PYTHON_VERSION}+`)
      && candidate.name.includes(triple)
      && candidate.name.includes("install_only")
      && candidate.name.endsWith(".tar.gz");
  });
  if (!asset) {
    throw new Error(`No python-build-standalone asset found for ${target} (${triple}) in ${release.tag_name}`);
  }
  return {
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
    pythonBuildStandaloneVersion: release.tag_name
  };
}

async function findPythonExe(root: string, target: string): Promise<string> {
  const candidates = target.startsWith("win32")
    ? ["python/python.exe", "python/install/python.exe", "python/install/bin/python.exe"]
    : [
      "python/bin/python3",
      `python/bin/python${PYTHON_ABI_VERSION}`,
      "python/install/bin/python3",
      "python/bin/python"
    ];
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    if (fsSync.existsSync(full)) {
      return candidate;
    }
  }
  throw new Error(`Could not find embedded Python executable under ${root}`);
}

async function copyTool(toolName: string, envName: string, targetPath: string): Promise<string> {
  const source = resolveWindowsToolShim(toolName, process.env[envName] || await which(toolName));
  if (!source) {
    throw new Error(`${toolName} not found. Set ${envName}.`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(source, targetPath);
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o755);
  }
  return source;
}

function resolveWindowsToolShim(toolName: string, source: string | null): string | null {
  if (!source || process.platform !== "win32") {
    return source;
  }

  const normalized = source.replace(/\//g, "\\").toLowerCase();
  const isChocolateyShim = normalized.includes("\\chocolatey\\bin\\")
    && normalized.endsWith(`\\${toolName}.exe`);
  if (!isChocolateyShim) {
    return source;
  }

  const chocolateyRoot = process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey";
  const realBinary = path.join(
    chocolateyRoot,
    "lib",
    "ffmpeg",
    "tools",
    "ffmpeg",
    "bin",
    `${toolName}.exe`
  );
  if (fsSync.existsSync(realBinary)) {
    return realBinary;
  }

  throw new Error(
    `${toolName} resolved to Chocolatey shim ${source}, but the real binary was not found at ${realBinary}.`
  );
}

function which(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null);
    });
  });
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (relative === "runtime-manifest.json") {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        hash.update(relative);
        hash.update(await fs.readFile(full));
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function installPiper(pythonExe: string, target: string): Promise<void> {
  const lockPath = path.join("runtime", "requirements", `${target}.txt`);
  if (fsSync.existsSync(lockPath)) {
    await run(pythonExe, ["-m", "pip", "install", "--require-hashes", "-r", lockPath]);
    return;
  }
  await run(pythonExe, ["-m", "pip", "install", "piper-tts[http]==1.4.2"]);
}

async function pruneUnusedPythonComponents(
  pythonRoot: string,
  pythonExe: string,
  target: string
): Promise<void> {
  const removableNames = [
    /^__pycache__$/i,
    /^_crypt(?:\.|$)/i,
    /^_distutils_hack$/i,
    /^_tkinter(?:\.|$)/i,
    /^distutils-precedence\.pth$/i,
    /^ensurepip$/i,
    /^idlelib$/i,
    /^itcl\d/i,
    /^isympy\.py$/i,
    /^lib2to3$/i,
    /^libtcl/i,
    /^libtk/i,
    /^mpmath(?:-|$)/i,
    /^pip(?:-|$)/i,
    /^pydoc_data$/i,
    /^setuptools(?:-|$)/i,
    /^sympy(?:-|$)/i,
    /^tcl\d/i,
    /^test$/i,
    /^tests$/i,
    /^thread\d/i,
    /^tk\d/i,
    /^tkinter$/i,
    /^turtledemo$/i
  ];
  async function findRemovablePaths(directory: string, matches: string[]): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (removableNames.some((pattern) => pattern.test(entry.name))) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        await findRemovablePaths(fullPath, matches);
      }
    }
  }

  const removablePaths: string[] = [];
  await findRemovablePaths(pythonRoot, removablePaths);
  removablePaths.sort((left, right) => right.length - left.length);
  for (const removablePath of removablePaths) {
    await fs.rm(removablePath, { recursive: true, force: true });
  }

  for (const directory of [path.join(pythonRoot, "include"), path.join(pythonRoot, "share")]) {
    await fs.rm(directory, { recursive: true, force: true });
  }

  if (target.startsWith("linux")) {
    for (const name of [
      "libpython3.so",
      `libpython${PYTHON_ABI_VERSION}.so`,
      `libpython${PYTHON_ABI_VERSION}.so.1.0`,
      "pkgconfig"
    ]) {
      await fs.rm(path.join(pythonRoot, "lib", name), { recursive: true, force: true });
    }
  }

  const binDir = path.join(pythonRoot, "bin");
  if (fsSync.existsSync(binDir)) {
    const executableNames = new Set([
      path.basename(pythonExe),
      "python",
      "python3",
      `python${PYTHON_ABI_VERSION}`
    ]);
    for (const entry of await fs.readdir(binDir)) {
      if (!executableNames.has(entry)) {
        await fs.rm(path.join(binDir, entry), { recursive: true, force: true });
      }
    }
  }

  const sitePackages = path.join(
    pythonRoot,
    "lib",
    `python${PYTHON_ABI_VERSION}`,
    "site-packages"
  );
  for (const relative of [
    "onnxruntime/backend",
    "onnxruntime/datasets",
    "onnxruntime/quantization",
    "onnxruntime/tools",
    "onnxruntime/transformers",
    "piper/train"
  ]) {
    await fs.rm(path.join(sitePackages, relative), { recursive: true, force: true });
  }

  const remainingPaths: string[] = [];
  await findRemovablePaths(pythonRoot, remainingPaths);
  if (remainingPaths.length > 0) {
    throw new Error(`Failed to remove unused Python components: ${remainingPaths.join(", ")}`);
  }
}

async function stripLinuxRuntime(pythonRoot: string, target: string): Promise<void> {
  if (!target.startsWith("linux")) {
    return;
  }

  const candidates: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()
        && (entry.name.startsWith("python3.") || entry.name.endsWith(".so") || entry.name.includes(".so."))) {
        candidates.push(fullPath);
      }
    }
  }
  await walk(pythonRoot);
  for (const candidate of candidates) {
    await run("strip", ["--strip-unneeded", candidate]);
  }
}

const SKIPPED_LINUX_LIBS = [
  "ld-linux",
  "libBrokenLocale.so",
  "libanl.so",
  "libc.so",
  "libdl.so",
  "libgcc_s.so",
  "libm.so",
  "libmvec.so",
  "libnsl.so",
  "libpthread.so",
  "libresolv.so",
  "librt.so",
  "libthread_db.so",
  "libutil.so"
];

function shouldBundleLinuxLibrary(libraryPath: string): boolean {
  const name = path.basename(libraryPath);
  return !SKIPPED_LINUX_LIBS.some((prefix) => name.startsWith(prefix));
}

async function linkedLinuxLibraries(binaryPath: string): Promise<string[]> {
  const result = await runForOutput("ldd", [binaryPath]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes("not found")) {
    throw new Error(`Unresolved shared library while inspecting ${binaryPath}:\n${output}`);
  }
  if (result.code !== 0 && !output.includes("not a dynamic executable")) {
    throw new Error(`ldd failed for ${binaryPath}:\n${output}`);
  }

  const libraries = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/=>\s+(\/\S+)/) ?? line.match(/^\s*(\/\S+)/);
    const libraryPath = match?.[1];
    if (!libraryPath || !shouldBundleLinuxLibrary(libraryPath)) {
      continue;
    }
    if (fsSync.existsSync(libraryPath) && fsSync.statSync(libraryPath).isFile()) {
      libraries.add(libraryPath);
    }
  }
  return [...libraries].sort();
}

async function copyLinuxFfmpegLibraries(toolSources: string[], targetDir: string): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }

  const libDir = path.join(targetDir, "lib");
  const libraries = new Set<string>();
  for (const source of toolSources) {
    for (const libraryPath of await linkedLinuxLibraries(source)) {
      libraries.add(libraryPath);
    }
  }

  if (libraries.size === 0) {
    return;
  }

  await fs.mkdir(libDir, { recursive: true });
  for (const libraryPath of [...libraries].sort()) {
    await fs.copyFile(libraryPath, path.join(libDir, path.basename(libraryPath)));
  }
}

async function main(): Promise<void> {
  const target = parseArg("target", `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`);
  const outRoot = parseArg("out", path.join("runtime", "dist", target));
  await fs.rm(outRoot, { recursive: true, force: true });
  await fs.mkdir(outRoot, { recursive: true });

  const pythonAsset = await selectPythonAsset(target);
  const archivePath = path.join(".cache", "runtime", pythonAsset.assetName);
  await download(pythonAsset.downloadUrl, archivePath);
  await run("tar", ["-xzf", path.resolve(archivePath), "-C", path.resolve(outRoot)]);

  const pythonExeRelative = await findPythonExe(outRoot, target);
  const pythonExe = path.resolve(outRoot, pythonExeRelative);
  await installPiper(pythonExe, target);
  const pythonRoot = path.join(outRoot, "python");
  await pruneUnusedPythonComponents(pythonRoot, pythonExe, target);
  await stripLinuxRuntime(pythonRoot, target);

  const ffmpegDir = path.join(outRoot, "ffmpeg");
  const ffmpegSource = await copyTool("ffmpeg", "FFMPEG_BIN", path.join(ffmpegDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
  await copyLinuxFfmpegLibraries([ffmpegSource], ffmpegDir);
  const ffmpegLicenseSource = path.join(path.dirname(ffmpegSource), "FFmpeg-LICENSE.txt");

  const voicesConfig = parseVoiceDefinitions(
    JSON.parse(await fs.readFile(path.join("runtime", "voices.json"), "utf8")) as unknown
  );
  const manifestVoices = [];
  for (const voice of voicesConfig) {
    const modelPath = path.join("voices", `${voice.id}.onnx`);
    const configPath = path.join("voices", `${voice.id}.onnx.json`);
    await copyCachedDownload(
      voice.modelUrl,
      path.join(".cache", "runtime", "voices", `${voice.id}.onnx`),
      path.join(outRoot, modelPath)
    );
    await copyCachedDownload(
      voice.configUrl,
      path.join(".cache", "runtime", "voices", `${voice.id}.onnx.json`),
      path.join(outRoot, configPath)
    );
    manifestVoices.push({
      id: voice.id,
      name: voice.name,
      locale: voice.locale,
      quality: voice.quality,
      modelPath,
      configPath,
      sampleRate: voice.sampleRate,
      sourceUrl: voice.sourceUrl,
      modelCardUrl: voice.modelCardUrl,
      licenseId: voice.licenseId,
      licenseName: voice.licenseName,
      licenseUrl: voice.licenseUrl,
      usageNote: voice.usageNote,
      attribution: voice.attribution
    });
  }

  const licensesDir = path.join(outRoot, "licenses");
  await fs.cp(path.join("runtime", "licenses"), licensesDir, { recursive: true });
  if (fsSync.existsSync(ffmpegLicenseSource)) {
    await fs.copyFile(ffmpegLicenseSource, path.join(licensesDir, "FFmpeg-LICENSE.txt"));
  }
  await copyCachedDownload(
    PIPER_SOURCE_URL,
    path.join(".cache", "runtime", `piper1-gpl-${PIPER_VERSION}.tar.gz`),
    path.join(licensesDir, "source", `piper1-gpl-${PIPER_VERSION}.tar.gz`)
  );
  await fs.writeFile(
    path.join(outRoot, "THIRD_PARTY_NOTICES.txt"),
    [
      `Piper ${PIPER_VERSION} is licensed under GPL-3.0.`,
      `Source: https://github.com/OHF-Voice/piper1-gpl/tree/v${PIPER_VERSION}`,
      `Corresponding source archive: licenses/source/piper1-gpl-${PIPER_VERSION}.tar.gz`,
      "License text: licenses/PIPER-GPL-3.0.txt",
      "Voice models have separate terms. See licenses/VOICE_MODELS.md and runtime-manifest.json.",
      "FFmpeg is copied from the build environment or configured FFMPEG_BIN.",
      "Bundled FFmpeg license details: licenses/FFmpeg-LICENSE.txt.",
      "Linux FFmpeg shared libraries are copied into ffmpeg/lib when the source tools are dynamically linked."
    ].join("\n"),
    "utf8"
  );

  const versionResult = await runForOutput(pythonExe, ["--version"]);
  if (versionResult.code !== 0) {
    throw new Error(`Embedded Python version check failed: ${versionResult.stderr}`);
  }
  const pythonVersion = `${versionResult.stdout}\n${versionResult.stderr}`
    .match(/Python\s+([^\s]+)/)?.[1] || "unknown";
  const manifestBase = {
    target,
    pythonVersion,
    pythonBuildStandaloneVersion: pythonAsset.pythonBuildStandaloneVersion,
    piperVersion: PIPER_VERSION,
    runtimeSha256: "",
    pythonExe: pythonExeRelative,
    piperServerEntrypoint: "piper.http_server",
    ffmpegExe: path.join("ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    voices: manifestVoices
  };
  const runtimeSha256 = await hashDirectory(outRoot);
  await fs.writeFile(
    path.join(outRoot, "runtime-manifest.json"),
    JSON.stringify({ ...manifestBase, runtimeSha256 }, null, 2),
    "utf8"
  );
  console.log(`Prepared runtime bundle at ${outRoot}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

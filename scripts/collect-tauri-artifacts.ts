import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

interface ArtifactFileSpec {
  extension: string;
  fileName: string;
  updaterSignature?: boolean;
}

const ARTIFACT_SPECS: Record<string, ArtifactFileSpec[]> = {
  "win32-x64": [
    {
      extension: ".exe",
      fileName: "Audiobook-Generator-windows-x64.exe",
      updaterSignature: true
    }
  ],
  "linux-x64": [
    {
      extension: ".deb",
      fileName: "Audiobook-Generator-linux-x64.deb"
    }
  ]
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

async function walk(dir: string): Promise<string[]> {
  if (!fsSync.existsSync(dir)) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function readAppVersion(): Promise<string> {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json is missing a valid version.");
  }
  return packageJson.version;
}

async function main(): Promise<void> {
  const target = parseArg("target");
  const bundleRoot = parseArg("bundle-root", path.join("src-tauri", "target", "release", "bundle"));
  const outDir = parseArg("out", "dist-upload");
  const skipSignatures = process.argv.includes("--skip-signatures");
  const specs = ARTIFACT_SPECS[target];
  if (!specs) {
    throw new Error(`Unsupported artifact target: ${target}`);
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const files = await walk(bundleRoot);
  const appVersion = await readAppVersion();
  const checksumLines: string[] = [];

  for (const spec of specs) {
    const extensionCandidates = files.filter((filePath) => filePath.endsWith(spec.extension));
    const candidates = extensionCandidates
      .filter((filePath) => path.basename(filePath).includes(`_${appVersion}_`))
      .sort((a, b) => a.localeCompare(b));
    const source = candidates[0];
    if (!source) {
      const available = extensionCandidates.map((filePath) => path.basename(filePath)).join(", ");
      throw new Error(
        `No ${spec.extension} bundle for version ${appVersion} found under ${bundleRoot}. Available: ${available || "none"}`
      );
    }

    const destination = path.join(outDir, spec.fileName);
    await fs.copyFile(source, destination);
    const hash = await sha256File(destination);
    checksumLines.push(`${hash}  ${spec.fileName}`);
    console.log(`Collected ${source} -> ${destination}`);

    if (spec.updaterSignature && !skipSignatures) {
      const signatureSource = `${source}.sig`;
      if (!fsSync.existsSync(signatureSource)) {
        throw new Error(`No updater signature found at ${signatureSource}`);
      }
      const signatureDestination = `${destination}.sig`;
      await fs.copyFile(signatureSource, signatureDestination);
      console.log(`Collected ${signatureSource} -> ${signatureDestination}`);
    }
  }

  await fs.writeFile(
    path.join(outDir, `checksums-${target}.txt`),
    `${checksumLines.join("\n")}\n`,
    "utf8"
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

interface ArtifactSpec {
  extension: string;
  fileName: string;
}

const ARTIFACT_SPECS: Record<string, ArtifactSpec> = {
  "win32-x64": {
    extension: ".exe",
    fileName: "Audiobook-Generator-windows-x64.exe"
  },
  "linux-x64": {
    extension: ".AppImage",
    fileName: "Audiobook-Generator-linux-x64.AppImage"
  },
  "darwin-x64": {
    extension: ".dmg",
    fileName: "Audiobook-Generator-darwin-x64.dmg"
  },
  "darwin-arm64": {
    extension: ".dmg",
    fileName: "Audiobook-Generator-darwin-arm64.dmg"
  }
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

async function main(): Promise<void> {
  const target = parseArg("target");
  const bundleRoot = parseArg("bundle-root", path.join("src-tauri", "target", "release", "bundle"));
  const outDir = parseArg("out", "dist-upload");
  const spec = ARTIFACT_SPECS[target];
  if (!spec) {
    throw new Error(`Unsupported artifact target: ${target}`);
  }

  const candidates = (await walk(bundleRoot))
    .filter((filePath) => filePath.endsWith(spec.extension))
    .sort((a, b) => a.localeCompare(b));
  const source = candidates[0];
  if (!source) {
    throw new Error(`No ${spec.extension} bundle found under ${bundleRoot}`);
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const destination = path.join(outDir, spec.fileName);
  await fs.copyFile(source, destination);

  const hash = await sha256File(destination);
  await fs.writeFile(
    path.join(outDir, `checksums-${target}.txt`),
    `${hash}  ${spec.fileName}\n`,
    "utf8"
  );
  console.log(`Collected ${source} -> ${destination}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

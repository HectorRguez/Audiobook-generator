import fs from "node:fs/promises";
import path from "node:path";

interface PlatformSpec {
  fileName: string;
  signatureFileName: string;
}

const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  "windows-x86_64": {
    fileName: "Audiobook-Generator-windows-x64.exe",
    signatureFileName: "Audiobook-Generator-windows-x64.exe.sig"
  },
  "linux-x86_64": {
    fileName: "Audiobook-Generator-linux-x64.AppImage",
    signatureFileName: "Audiobook-Generator-linux-x64.AppImage.sig"
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

function versionFromTag(tag: string): string {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Tag must contain a semantic version: ${tag}`);
  }
  return version;
}

async function main(): Promise<void> {
  const tag = parseArg("tag");
  const version = versionFromTag(tag);
  const assetsDir = parseArg("assets", "updater-signatures");
  const outPath = parseArg("out", path.join(assetsDir, "latest.json"));
  const repository = parseArg("repository", process.env.GITHUB_REPOSITORY || "HectorRguez/Audiobook-generator");
  const publishDate = parseArg("date", new Date().toISOString());
  const releaseBaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const platforms: Record<string, { signature: string; url: string }> = {};

  for (const [platform, spec] of Object.entries(PLATFORM_SPECS)) {
    const signature = (await fs.readFile(path.join(assetsDir, spec.signatureFileName), "utf8")).trim();
    if (!signature) {
      throw new Error(`Updater signature is empty: ${spec.signatureFileName}`);
    }
    platforms[platform] = {
      signature,
      url: `${releaseBaseUrl}/${spec.fileName}`
    };
  }

  const manifest = {
    version,
    notes: `Release notes: https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    pub_date: publishDate,
    platforms
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Built updater manifest at ${outPath}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

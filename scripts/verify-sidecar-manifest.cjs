const fs = require("node:fs");
const path = require("node:path");

const manifestPath = path.join(__dirname, "..", "electron", "assets", "sidecar-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (!manifest.version || typeof manifest.version !== "string") {
  throw new Error("Manifest version is required.");
}

for (const [platformKey, platformConfig] of Object.entries(manifest.platforms || {})) {
  if (!Array.isArray(platformConfig.archives) || platformConfig.archives.length === 0) {
    throw new Error(`Platform ${platformKey} has no archives.`);
  }

  for (const archive of platformConfig.archives) {
    if (!archive.id || !archive.url || !archive.extractTo) {
      throw new Error(`Invalid archive entry in ${platformKey}: ${JSON.stringify(archive)}`);
    }

    if (!archive.url.startsWith("https://")) {
      throw new Error(`Archive URL must use https: ${archive.url}`);
    }

    if (archive.url.includes("postdownload")) {
      throw new Error(`Archive URL must be a direct file URL, not postdownload: ${archive.url}`);
    }

    if (archive.archiveType && ![ "none", "zip", "tar.gz", "tgz", "tar.xz", "tar" ].includes(archive.archiveType)) {
      throw new Error(`Unsupported archiveType for ${platformKey}/${archive.id}: ${archive.archiveType}`);
    }
  }

  if (!platformConfig.paths?.piperExe || !platformConfig.paths?.ffmpegExe || !platformConfig.paths?.defaultVoiceModel) {
    throw new Error(`Platform ${platformKey} missing required paths block.`);
  }
}

console.log(`Validated sidecar manifest ${manifest.version}.`);

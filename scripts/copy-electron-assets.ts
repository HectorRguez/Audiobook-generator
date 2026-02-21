import fs from "node:fs/promises";
import path from "node:path";

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function main(): Promise<void> {
  const root = process.cwd();
  const distElectron = path.join(root, "dist-electron");

  await ensureDir(path.join(distElectron, "db"));
  await fs.copyFile(path.join(root, "electron", "db", "schema.sql"), path.join(distElectron, "db", "schema.sql"));

  await fs.rm(path.join(distElectron, "assets"), { recursive: true, force: true });
  await fs.cp(path.join(root, "electron", "assets"), path.join(distElectron, "assets"), {
    recursive: true,
    force: true
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});

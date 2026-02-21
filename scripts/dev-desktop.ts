import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

const NEXT_BIN = require.resolve("next/dist/bin/next");
const ELECTRON_BIN = require("electron") as string;

async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start = 3000, attempts = 200): Promise<number> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset;
    // eslint-disable-next-line no-await-in-loop
    const free = await canBind(candidate);
    if (free) {
      return candidate;
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: Error) => {
      reject(new Error(`No free port found in range ${start}-${start + attempts - 1}: ${error.message}`));
    });

    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire ephemeral port.")));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });

    server.listen(0, "127.0.0.1");
  });
}

async function waitForTcp(port: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const open = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();

      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(1000);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, "127.0.0.1");
    });

    if (open) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for renderer on port ${port}`);
}

function spawnChild(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ChildProcess {
  return spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...(options.env || {}) },
    cwd: options.cwd || process.cwd(),
    shell: false
  });
}

async function main(): Promise<void> {
  const port = await findFreePort(3000, 300);
  const url = `http://127.0.0.1:${port}`;

  console.log(`[dev-desktop] Using renderer port ${port}`);

  const renderer = spawnChild(process.execPath, [NEXT_BIN, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: "./renderer"
  });
  let electron: ChildProcess | null = null;
  let shuttingDown = false;

  const shutdown = (exitCode = 0): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (electron && !electron.killed) {
      electron.kill("SIGTERM");
    }
    if (!renderer.killed) {
      renderer.kill("SIGTERM");
    }

    setTimeout(() => process.exit(exitCode), 100);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  renderer.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev-desktop] Renderer exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      shutdown(code ?? 1);
    }
  });

  await waitForTcp(port);

  electron = spawnChild(ELECTRON_BIN, ["."], {
    env: {
      ELECTRON_START_URL: url
    }
  });

  electron.once("exit", (code) => {
    shutdown(code ?? 0);
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[dev-desktop]", message);
  process.exit(1);
});

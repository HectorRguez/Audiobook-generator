const net = require("node:net");
const { spawn } = require("node:child_process");

const NEXT_BIN = require.resolve("next/dist/bin/next");
const ELECTRON_BIN = require("electron");

async function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start = 3000, attempts = 200) {
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

    server.once("error", (error) => {
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

async function waitForTcp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const open = await new Promise((resolve) => {
      const socket = new net.Socket();

      const finish = (value) => {
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

function spawnChild(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...(options.env || {}) },
    cwd: options.cwd || process.cwd(),
    shell: false
  });
}

async function main() {
  const port = await findFreePort(3000, 300);
  const url = `http://127.0.0.1:${port}`;

  console.log(`[dev-desktop] Using renderer port ${port}`);

  const renderer = spawnChild(process.execPath, [NEXT_BIN, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: "./renderer"
  });
  let electron = null;
  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (electron && !electron.killed) {
      electron.kill("SIGTERM");
    }
    if (renderer && !renderer.killed) {
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

main().catch((error) => {
  console.error("[dev-desktop]", error.message);
  process.exit(1);
});

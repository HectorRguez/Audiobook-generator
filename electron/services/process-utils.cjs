const { spawn } = require("node:child_process");
const kill = require("tree-kill");

function killChild(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  try {
    kill(child.pid);
  } catch {
    // ignore
  }
}

function runCommand(options) {
  const {
    command,
    args,
    cwd,
    env,
    stdinText,
    onSpawn,
    onStdout,
    onStderr,
    abortSignal,
    windowsHide = true
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide,
      stdio: ["pipe", "pipe", "pipe"]
    });

    if (onSpawn) {
      onSpawn(child);
    }

    let stderr = "";
    let stdout = "";
    let finished = false;

    const cleanupAbort = () => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };

    const finalize = (fn) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanupAbort();
      fn();
    };

    const onAbort = () => {
      killChild(child);
      finalize(() => reject(new Error(`Command aborted: ${command}`)));
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      if (onStdout) {
        onStdout(text);
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      if (onStderr) {
        onStderr(text);
      }
    });

    child.on("error", (error) => {
      finalize(() => reject(error));
    });

    child.on("close", (code) => {
      if (code === 0) {
        finalize(() => resolve({ stdout, stderr }));
        return;
      }

      const error = new Error(`Command failed (${code}): ${command} ${args.join(" ")}`);
      error.stderr = stderr;
      error.stdout = stdout;
      error.code = code;
      finalize(() => reject(error));
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

module.exports = {
  runCommand,
  killChild
};

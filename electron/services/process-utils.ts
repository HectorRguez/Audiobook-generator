import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import kill from "tree-kill";

export interface RunCommandOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinText?: string;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  abortSignal?: AbortSignal;
  windowsHide?: boolean;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

interface CommandError extends Error {
  stderr?: string;
  stdout?: string;
  code?: number | null;
}

export function killChild(child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (typeof child.pid !== "number") {
    return;
  }

  try {
    kill(child.pid);
  } catch {
    // Ignore process kill races.
  }
}

export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
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

    onSpawn?.(child);

    let stderr = "";
    let stdout = "";
    let finished = false;

    const cleanupAbort = () => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };

    const finalize = (fn: () => void) => {
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

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onStderr?.(text);
    });

    child.on("error", (error) => {
      finalize(() => reject(error));
    });

    child.on("close", (code) => {
      if (code === 0) {
        finalize(() => resolve({ stdout, stderr }));
        return;
      }

      const stderrLine = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      const suffix = stderrLine ? ` :: ${stderrLine}` : "";
      const error: CommandError = new Error(`Command failed (${code ?? "unknown"}): ${command} ${args.join(" ")}${suffix}`);
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

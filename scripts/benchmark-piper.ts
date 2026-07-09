import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChapterPlan } from "../core/narration-plan";
import { PiperCliTtsEngine, runPiperChunk } from "../electron/services/audio-runner";
import { runCommand } from "../electron/services/process-utils";
import type { SpeechSegmentInput } from "../core/tts-engine";

interface BenchmarkResult {
  mode: "single-cli" | "persistent-cli" | "http";
  ok: boolean;
  elapsedMs: number;
  startupMs: number;
  segmentCount: number;
  characterCount: number;
  charsPerSecond: number;
  error?: string;
}

interface BenchmarkReport {
  createdAt: string;
  selectedMode: "single-cli" | "persistent-cli" | "http";
  selectionReason: string;
  sampleTextChars: number;
  results: BenchmarkResult[];
}

const SAMPLE_TEXT = process.env.PIPER_BENCHMARK_TEXT || [
  "El señor García llegó temprano. La sala estaba en silencio, pero la novela apenas comenzaba.",
  "Después de una pausa, continuó leyendo con calma. Cada párrafo necesitaba respirar sin cortar la voz.",
  "Esta prueba compara el coste de arrancar el motor, procesar varios segmentos y escribir los archivos WAV."
].join("\n\n");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function countChars(segments: SpeechSegmentInput[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

function resultFromError(mode: BenchmarkResult["mode"], started: number, segments: SpeechSegmentInput[], error: unknown): BenchmarkResult {
  const elapsedMs = Date.now() - started;
  return {
    mode,
    ok: false,
    elapsedMs,
    startupMs: 0,
    segmentCount: segments.length,
    characterCount: countChars(segments),
    charsPerSecond: 0,
    error: error instanceof Error ? error.message : String(error)
  };
}

function resultFromTiming(
  mode: BenchmarkResult["mode"],
  started: number,
  startupMs: number,
  segments: SpeechSegmentInput[]
): BenchmarkResult {
  const elapsedMs = Date.now() - started;
  const characterCount = countChars(segments);
  return {
    mode,
    ok: true,
    elapsedMs,
    startupMs,
    segmentCount: segments.length,
    characterCount,
    charsPerSecond: elapsedMs > 0 ? Math.round((characterCount / elapsedMs) * 1000) : 0
  };
}

async function supportsJsonInput(piperExe: string): Promise<boolean> {
  const result = await runCommand({ command: piperExe, args: ["--help"] });
  return `${result.stdout}\n${result.stderr}`.toLowerCase().includes("--json-input");
}

async function benchmarkSingleCli(options: {
  piperExe: string;
  voiceModel: string;
  voiceConfig: string | null;
  segments: SpeechSegmentInput[];
}): Promise<BenchmarkResult> {
  const started = Date.now();
  try {
    let startupMs = 0;
    for (const segment of options.segments) {
      const segmentStarted = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await runPiperChunk({
        piperExe: options.piperExe,
        voiceModel: options.voiceModel,
        voiceConfig: options.voiceConfig,
        text: segment.text,
        outWavPath: segment.outputPath,
        sentenceSilenceSeconds: 0.25
      });
      if (segment.speechIndex === 0) {
        startupMs = Date.now() - segmentStarted;
      }
    }
    return resultFromTiming("single-cli", started, startupMs, options.segments);
  } catch (error: unknown) {
    return resultFromError("single-cli", started, options.segments, error);
  }
}

async function benchmarkPersistentCli(options: {
  piperExe: string;
  voiceModel: string;
  voiceConfig: string | null;
  segments: SpeechSegmentInput[];
}): Promise<BenchmarkResult> {
  const started = Date.now();
  try {
    if (!await supportsJsonInput(options.piperExe)) {
      throw new Error("Piper binary does not advertise --json-input support.");
    }
    let firstSegmentMs = 0;
    const engine = new PiperCliTtsEngine({
      piperExe: options.piperExe,
      voiceModel: options.voiceModel,
      voiceConfig: options.voiceConfig,
      mode: "persistent-cli",
      batchSize: 16,
      sentenceSilenceSeconds: 0.25
    });
    await engine.synthesizeSpeechSegments({
      segments: options.segments,
      onSegmentComplete: (_segment, elapsedMs) => {
        if (firstSegmentMs === 0) {
          firstSegmentMs = elapsedMs;
        }
      }
    });
    return resultFromTiming("persistent-cli", started, firstSegmentMs, options.segments);
  } catch (error: unknown) {
    return resultFromError("persistent-cli", started, options.segments, error);
  }
}

async function benchmarkHttp(options: {
  httpUrl: string | null;
  segments: SpeechSegmentInput[];
}): Promise<BenchmarkResult> {
  const started = Date.now();
  try {
    if (!options.httpUrl) {
      throw new Error("PIPER_HTTP_URL is not set.");
    }

    let startupMs = 0;
    for (const segment of options.segments) {
      const segmentStarted = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(new URL("/synthesize", options.httpUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: segment.text })
      });
      if (!response.ok) {
        throw new Error(`HTTP synthesize failed (${response.status}).`);
      }

      // eslint-disable-next-line no-await-in-loop
      await fsp.writeFile(segment.outputPath, Buffer.from(await response.arrayBuffer()));
      if (segment.speechIndex === 0) {
        startupMs = Date.now() - segmentStarted;
      }
    }
    return resultFromTiming("http", started, startupMs, options.segments);
  } catch (error: unknown) {
    return resultFromError("http", started, options.segments, error);
  }
}

function selectMode(results: BenchmarkResult[]): Pick<BenchmarkReport, "selectedMode" | "selectionReason"> {
  const single = results.find((result) => result.mode === "single-cli" && result.ok);
  const persistent = results.find((result) => result.mode === "persistent-cli" && result.ok);
  const http = results.find((result) => result.mode === "http" && result.ok);

  if (http && persistent && http.elapsedMs <= persistent.elapsedMs * 0.8) {
    return {
      selectedMode: "http",
      selectionReason: "HTTP was at least 20% faster than persistent CLI."
    };
  }

  if (persistent) {
    return {
      selectedMode: "persistent-cli",
      selectionReason: "Persistent CLI is available and HTTP was not at least 20% faster."
    };
  }

  if (single) {
    return {
      selectedMode: "single-cli",
      selectionReason: "Persistent CLI was unavailable, so single CLI is the fallback."
    };
  }

  return {
    selectedMode: "single-cli",
    selectionReason: "All benchmark modes failed; single CLI remains the conservative default."
  };
}

async function main(): Promise<void> {
  const piperExe = requiredEnv("PIPER_BIN");
  const voiceModel = requiredEnv("PIPER_VOICE_MODEL");
  const voiceConfig = process.env.PIPER_VOICE_CONFIG || null;
  const httpUrl = process.env.PIPER_HTTP_URL || null;
  const outPath = process.argv[2] || path.join(process.cwd(), ".cache", `piper-benchmark-${Date.now()}.json`);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "piper-benchmark-"));
  const chapterPlan = buildChapterPlan({ index: 0, title: "Benchmark", text: SAMPLE_TEXT });
  const segments: SpeechSegmentInput[] = chapterPlan.segments
    .filter((segment) => segment.kind === "speech")
    .map((segment) => ({
      speechIndex: segment.speechIndex,
      text: segment.text,
      outputPath: path.join(tmpRoot, `${segment.speechIndex}.wav`)
    }));

  const results = [
    await benchmarkSingleCli({ piperExe, voiceModel, voiceConfig, segments }),
    await benchmarkPersistentCli({
      piperExe,
      voiceModel,
      voiceConfig,
      segments: segments.map((segment) => ({ ...segment, outputPath: path.join(tmpRoot, `persistent-${segment.speechIndex}.wav`) }))
    }),
    await benchmarkHttp({
      httpUrl,
      segments: segments.map((segment) => ({ ...segment, outputPath: path.join(tmpRoot, `http-${segment.speechIndex}.wav`) }))
    })
  ];

  const selection = selectMode(results);
  const report: BenchmarkReport = {
    createdAt: new Date().toISOString(),
    ...selection,
    sampleTextChars: SAMPLE_TEXT.length,
    results
  };

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Wrote Piper benchmark report: ${outPath}`);
  console.log(`Selected mode: ${report.selectedMode} (${report.selectionReason})`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface SpeechSegmentInput {
  speechIndex: number;
  text: string;
  outputPath: string;
}

export interface SynthesisMetrics {
  engine: string;
  mode: "single-cli" | "persistent-cli" | "http";
  segmentCount: number;
  characterCount: number;
  elapsedMs: number;
}

export interface SynthesizeSpeechSegmentsOptions {
  segments: SpeechSegmentInput[];
  startIndex?: number;
  abortSignal?: AbortSignal;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  onLog?: (line: string) => void;
  onSegmentComplete?: (segment: SpeechSegmentInput, elapsedMs: number) => void;
}

export interface TtsEngine {
  readonly id: string;
  synthesizeSpeechSegments(options: SynthesizeSpeechSegmentsOptions): Promise<SynthesisMetrics>;
}

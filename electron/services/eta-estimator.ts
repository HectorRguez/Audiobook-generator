import { ema } from "moving-averages";

export class EtaEstimator {
  private readonly maxSamples: number;
  private readonly smoothingWindow: number;
  private readonly samples: number[];

  constructor(maxSamples = 30, smoothingWindow = 8) {
    this.maxSamples = maxSamples;
    this.smoothingWindow = smoothingWindow;
    this.samples = [];
  }

  addSample(chars: number, elapsedMs: number): void {
    if (!chars || !elapsedMs || elapsedMs <= 0) {
      return;
    }

    const charsPerSecond = chars / (elapsedMs / 1000);
    if (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0) {
      return;
    }

    this.samples.push(charsPerSecond);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  estimateSeconds(totalChars: number, processedChars: number): number | null {
    if (!Number.isFinite(totalChars) || totalChars <= 0) {
      return null;
    }

    const remainingChars = Math.max(0, totalChars - processedChars);
    if (remainingChars === 0) {
      return 0;
    }

    if (this.samples.length === 0) {
      return null;
    }

    // moving-averages `ema` expects a period/window integer, not an alpha fraction.
    const period = Math.max(1, Math.min(this.smoothingWindow, this.samples.length));
    const emaSeries = ema(this.samples, period) as number[];
    const currentRate = [...emaSeries].reverse().find((value) => Number.isFinite(value) && value > 0);
    if (typeof currentRate !== "number") {
      return null;
    }

    if (!Number.isFinite(currentRate) || currentRate <= 0) {
      return null;
    }

    return Math.ceil(remainingChars / currentRate);
  }
}

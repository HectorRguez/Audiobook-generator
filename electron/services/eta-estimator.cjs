const movingAverages = require("moving-averages");

class EtaEstimator {
  constructor(maxSamples = 30) {
    this.maxSamples = maxSamples;
    this.samples = [];
  }

  addSample(chars, elapsedMs) {
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

  estimateSeconds(totalChars, processedChars) {
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

    const emaSeries = movingAverages.ema(this.samples, 0.35);
    const currentRate = emaSeries[emaSeries.length - 1];

    if (!Number.isFinite(currentRate) || currentRate <= 0) {
      return null;
    }

    return Math.ceil(remainingChars / currentRate);
  }
}

module.exports = {
  EtaEstimator
};

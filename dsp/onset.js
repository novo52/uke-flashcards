// Online onset detection with SuperFlux (Böck & Widmer, DAFx 2013): positive
// log-spectral difference against a frequency-max-filtered earlier frame, then
// adaptive-threshold peak picking with one frame of lookahead.
import { FFT, hann } from './fft.js';

export class OnsetDetector {
  constructor(sampleRate, size, hop, opts = {}) {
    const half = size / 2;
    this.size = size;
    this.fft = new FFT(size);
    this.window = hann(size);
    this.windowed = new Float64Array(size);
    this.mag = new Float64Array(half + 1);
    this.loBin = Math.max(1, Math.round((150 * size) / sampleRate));
    this.hiBin = Math.min(half - 1, Math.round((Math.min(10000, sampleRate * 0.45) * size) / sampleRate));
    this.norm = 4 / size; // a full-scale sinusoid peaks at 1
    this.lambda = opts.lambda ?? 500;
    this.lag = opts.lag ?? 2;
    this.spectra = Array.from({ length: this.lag + 1 }, () => new Float64Array(half + 1));
    this.specPos = 0;

    const frames = (sec) => Math.max(1, Math.round((sec * sampleRate) / hop));
    this.preMax = frames(0.03);
    this.preAvg = frames(0.1);
    this.minGap = frames(opts.minInterval ?? 0.05);
    this.delta = opts.delta ?? 0.05;
    this.fluxLen = 64;
    this.flux = new Float64Array(this.fluxLen);
    this.frame = 0;
    this.lastOnset = -Infinity;
  }

  F(i) {
    return this.flux[((i % this.fluxLen) + this.fluxLen) % this.fluxLen];
  }

  // Feeds the newest `size` samples. Returns true when the frame one hop
  // earlier is an onset.
  process(frame) {
    const { size, window, windowed, mag, spectra, lag, loBin, hiBin } = this;
    for (let i = 0; i < size; i++) windowed[i] = frame[i] * window[i];
    this.fft.magnitude(windowed, mag);

    const cur = spectra[this.specPos];
    const ref = spectra[(this.specPos + 1) % (lag + 1)]; // written `lag` frames ago
    for (let k = 0; k < mag.length; k++) cur[k] = Math.log10(1 + this.lambda * this.norm * mag[k]);
    let sum = 0;
    for (let k = loBin; k <= hiBin; k++) {
      const r = Math.max(ref[k - 1], ref[k], ref[k + 1]);
      const d = cur[k] - r;
      if (d > 0) sum += d;
    }
    this.specPos = (this.specPos + 1) % (lag + 1);
    const flux = sum / (hiBin - loBin + 1);
    this.flux[this.frame % this.fluxLen] = flux;

    const j = this.frame - 1;
    this.frame++;
    if (j < this.preAvg + lag) return false;
    const fj = this.F(j);
    if (fj < flux) return false;
    for (let i = 1; i <= this.preMax; i++) if (this.F(j - i) >= fj) return false;
    let mean = 0;
    for (let i = j - this.preAvg; i <= j + 1; i++) mean += this.F(i);
    mean /= this.preAvg + 2;
    if (fj < mean + this.delta) return false;
    if (j - this.lastOnset < this.minGap) return false;
    this.lastOnset = j;
    return true;
  }
}

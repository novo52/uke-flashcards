// Real-time note detection by non-negative decomposition of each spectrum onto
// fixed per-note templates (Dessein, Cont & Lemaitre, "Real-time polyphonic
// music transcription with non-negative matrix factorization and
// beta-divergence", ISMIR 2010). A template holds a note's whole harmonic
// profile, so a strong partial is attributed to the note that produced it.
//
// Spectra are pooled into semitone bands, which keeps the problem small and
// tolerates a few tens of cents of detuning. Templates exist for two window
// lengths because onset-synchronous windows shorten the analysis after a strum.
import { FFT, hann } from './fft.js';
import { freqToMidi, midiToFreq } from './notes.js';

// Multiplicative updates for β = 0.5, the value Dessein et al. found best.
const BAND_LO = 52; // lowest band, MIDI
const BAND_HI = 120; // highest band, MIDI (~8.4 kHz)

export class NoteDecomposer {
  constructor(sampleRate, size, opts = {}) {
    this.sampleRate = sampleRate;
    this.size = size;
    this.minMidi = opts.minMidi ?? 55;
    this.maxMidi = opts.maxMidi ?? 88;
    this.iterations = opts.iterations ?? 30;
    this.sparsity = opts.sparsity ?? 0.02;
    // A note is reported when its share of the frame's energy reaches
    // `absThreshold` and `relThreshold` of the strongest note's share.
    this.absThreshold = opts.absThreshold ?? 0.06;
    this.relThreshold = opts.relThreshold ?? 0.2;
    this.maxNotes = opts.maxNotes ?? 4;
    // Generic templates give partial h an amplitude of h^-rolloff.
    this.rolloff = opts.rolloff ?? 1;
    // Window lengths with their own template set; analysis uses the nearest.
    this.lengths = opts.templateLengths ?? [size / 2, size];

    this.fft = new FFT(size);
    this.windows = new Map();
    this.windowed = new Float64Array(size);
    this.mag = new Float64Array(size / 2 + 1);

    const hi = Math.min(BAND_HI, Math.floor(freqToMidi(sampleRate * 0.45)) - 1);
    this.bands = hi - BAND_LO + 1;
    this.binLo = Math.ceil(midiToFreq(BAND_LO) / (sampleRate / size));
    this.binHi = Math.floor(midiToFreq(hi) / (sampleRate / size));
    this.binBand = new Int32Array(this.binHi + 1);
    this.binFrac = new Float64Array(this.binHi + 1);
    for (let k = this.binLo; k <= this.binHi; k++) {
      const x = freqToMidi((k * sampleRate) / size) - BAND_LO;
      this.binBand[k] = Math.floor(x);
      this.binFrac[k] = x - Math.floor(x);
    }

    // Columns: one per note, then a flat column that absorbs broadband noise.
    this.notes = this.maxMidi - this.minMidi + 1;
    this.cols = this.notes + 1;
    this.W = this.lengths.map(() => new Float64Array(this.cols * this.bands));
    this.learned = new Uint8Array(this.notes); // notes with calibrated templates
    this.resetTemplates();

    this.v = new Float64Array(this.bands);
    this.lam = new Float64Array(this.bands);
    this.a = new Float64Array(this.bands);
    this.b = new Float64Array(this.bands);
    this.h = new Float64Array(this.cols).fill(1 / this.cols);
  }

  windowOf(length) {
    let w = this.windows.get(length);
    if (!w) this.windows.set(length, (w = hann(length)));
    return w;
  }

  // Semitone-band magnitudes of the last `length` samples of `frame` into `out`.
  feature(frame, length, out) {
    const { size, windowed, mag, binBand, binFrac } = this;
    const w = this.windowOf(length);
    const start = size - length;
    windowed.fill(0, 0, start);
    for (let i = start; i < size; i++) windowed[i] = frame[i] * w[i - start];
    this.fft.magnitude(windowed, mag);
    out.fill(0);
    for (let k = this.binLo; k <= this.binHi; k++) {
      const d = binBand[k];
      out[d] += (1 - binFrac[k]) * mag[k];
      if (d + 1 < out.length) out[d + 1] += binFrac[k] * mag[k];
    }
    return out;
  }

  // Generic plucked-string profile, used until a note is calibrated.
  syntheticFeature(midi, length) {
    const f0 = midiToFreq(midi);
    const sig = new Float64Array(this.size);
    for (let h = 1; h * f0 < this.sampleRate * 0.45 && h <= 20; h++) {
      const w = (2 * Math.PI * h * f0) / this.sampleRate;
      const amp = h ** -this.rolloff;
      for (let i = 0; i < this.size; i++) sig[i] += amp * Math.sin(w * i + h);
    }
    return this.feature(sig, length, new Float64Array(this.bands));
  }

  // Restores the generic template of every note, discarding calibration.
  resetTemplates() {
    for (let s = 0; s < this.lengths.length; s++) {
      for (let m = this.minMidi; m <= this.maxMidi; m++) this.setTemplate(s, m, this.syntheticFeature(m, this.lengths[s]));
      this.W[s].fill(1 / this.bands, this.notes * this.bands);
    }
    this.learned.fill(0);
  }

  setTemplate(set, midi, feat) {
    let sum = 0;
    for (let d = 0; d < this.bands; d++) sum += feat[d];
    const col = (midi - this.minMidi) * this.bands;
    for (let d = 0; d < this.bands; d++) this.W[set][col + d] = feat[d] / (sum || 1);
  }

  startCalibration() {
    this.calSums = this.lengths.map(() => new Float64Array(this.notes * this.bands));
    this.calCounts = new Uint32Array(this.notes);
    this.calFeature = new Float64Array(this.bands);
  }

  // Adds `frame` (a full-size window in which only `midi` sounds) to that note's
  // calibration sums, once per template window length.
  accumulate(midi, frame) {
    const m = midi - this.minMidi;
    if (!this.calSums || m < 0 || m >= this.notes) return;
    const { bands, calFeature } = this;
    this.lengths.forEach((length, s) => {
      this.feature(frame, length, calFeature);
      let sum = 0;
      for (let d = 0; d < bands; d++) sum += calFeature[d];
      if (sum <= 0) return;
      const sums = this.calSums[s];
      for (let d = 0; d < bands; d++) sums[m * bands + d] += calFeature[d] / sum;
    });
    this.calCounts[m]++;
  }

  // Frames gathered per note so far, indexed from `minMidi`.
  calibrationCounts() {
    return this.calCounts ? Array.from(this.calCounts) : [];
  }

  // Installs a template for every note heard in at least `minFrames` frames,
  // keeping earlier templates for the others, and returns exportTemplates().
  finishCalibration(minFrames = 20) {
    if (this.calSums) {
      for (let m = 0; m < this.notes; m++) {
        if (this.calCounts[m] < minFrames) continue;
        const col = this.calSums.map((sums) => sums.subarray(m * this.bands, (m + 1) * this.bands));
        col.forEach((feat, s) => this.setTemplate(s, m + this.minMidi, feat));
        this.learned[m] = 1;
      }
    }
    this.calSums = null;
    this.calCounts = null;
    return this.exportTemplates();
  }

  // Calibrated templates as { [midi]: [shortWindowBands, longWindowBands] }.
  exportTemplates() {
    const out = {};
    for (let m = 0; m < this.notes; m++) {
      if (!this.learned[m]) continue;
      const col = m * this.bands;
      out[m + this.minMidi] = this.W.map((W) => Array.from(W.subarray(col, col + this.bands)));
    }
    return out;
  }

  importTemplates(data) {
    for (const [key, sets] of Object.entries(data ?? {})) {
      const midi = Number(key);
      const m = midi - this.minMidi;
      if (m < 0 || m >= this.notes || sets.length !== this.lengths.length) continue;
      if (sets.some((feat) => feat.length !== this.bands)) continue;
      sets.forEach((feat, s) => this.setTemplate(s, midi, feat));
      this.learned[m] = 1;
    }
  }

  templateSet(length) {
    let best = 0;
    for (let s = 1; s < this.lengths.length; s++) {
      if (Math.abs(this.lengths[s] - length) < Math.abs(this.lengths[best] - length)) best = s;
    }
    return best;
  }

  // Returns [{ midi, cents, salience }] for the last `length` samples of
  // `frame`, strongest first; `salience` is the note's share of the energy.
  // `restart` discards the previous frame's activations (used after an onset).
  analyze(frame, length = this.size, restart = false) {
    const { v, lam, a, b, h, bands, cols } = this;
    const W = this.W[this.templateSet(length)];
    this.feature(frame, length, v);
    let sum = 0;
    for (let d = 0; d < bands; d++) sum += v[d];
    if (sum <= 0) return [];
    for (let d = 0; d < bands; d++) v[d] /= sum;

    for (let m = 0; m < cols; m++) h[m] = restart ? 1 / cols : h[m] + 1e-3;
    for (let it = 0; it < this.iterations; it++) {
      lam.fill(1e-9);
      for (let m = 0; m < cols; m++) {
        const hm = h[m];
        const col = m * bands;
        for (let d = 0; d < bands; d++) lam[d] += W[col + d] * hm;
      }
      for (let d = 0; d < bands; d++) {
        const r = 1 / Math.sqrt(lam[d]); // lam^(β - 1)
        b[d] = r;
        a[d] = (v[d] * r) / lam[d]; // v * lam^(β - 2)
      }
      for (let m = 0; m < cols; m++) {
        const col = m * bands;
        let num = 0;
        let den = 0;
        for (let d = 0; d < bands; d++) {
          num += W[col + d] * a[d];
          den += W[col + d] * b[d];
        }
        h[m] *= num / (den + (m < this.notes ? this.sparsity : 0));
      }
    }

    let top = 0;
    for (let m = 0; m < this.notes; m++) if (h[m] > top) top = h[m];
    const notes = [];
    for (let m = 0; m < this.notes; m++) {
      if (h[m] >= this.absThreshold && h[m] >= this.relThreshold * top) {
        const midi = m + this.minMidi;
        notes.push({ midi, cents: this.cents(midi), salience: h[m] });
      }
    }
    return notes.sort((x, y) => y.salience - x.salience).slice(0, this.maxNotes);
  }

  // Deviation of the fundamental from equal temperament, from the interpolated
  // magnitude peak nearest the nominal frequency (valid after `feature`).
  cents(midi) {
    const { mag } = this;
    const binHz = this.sampleRate / this.size;
    const lo = Math.max(1, Math.floor(midiToFreq(midi - 0.5) / binHz));
    const hi = Math.ceil(midiToFreq(midi + 0.5) / binHz);
    let k = lo;
    for (let i = lo; i <= hi; i++) if (mag[i] > mag[k]) k = i;
    const l = Math.log(mag[k - 1] + 1e-30);
    const c = Math.log(mag[k] + 1e-30);
    const r = Math.log(mag[k + 1] + 1e-30);
    const den = l - 2 * c + r;
    const p = den < 0 ? (0.5 * (l - r)) / den : 0;
    return Math.round((freqToMidi((k + p) * binHz) - midi) * 100);
  }
}

// Template-free multiple-pitch estimation by iterative harmonic summation and
// subtraction (after Klapuri, "Multiple fundamental frequency estimation by
// summing harmonic amplitudes", ISMIR 2006), working on interpolated spectral
// peaks so that adjacent semitones are separated even where FFT bins are wider
// than a semitone. It needs no knowledge of the instrument's timbre, which makes
// it the labeller for calibration: it is reliable on single notes, while
// NoteDecomposer is the more accurate detector for chords.
import { FFT, hann } from './fft.js';
import { freqToMidi, midiToFreq } from './notes.js';

const MAX_PEAKS = 256;
// Spectral whitening exponent: magnitudes are divided by their local RMS^(1 - NU).
const NU = 0.33;

export class PitchEstimator {
  constructor(sampleRate, size, opts = {}) {
    this.sampleRate = sampleRate;
    this.size = size;
    this.a4 = opts.a4 ?? 440;
    this.minMidi = opts.minMidi ?? 55;
    this.maxMidi = opts.maxMidi ?? 88;
    this.harmonics = opts.harmonics ?? 8;
    // Greedy candidates considered, and notes reported (one per string).
    this.maxPolyphony = opts.maxPolyphony ?? 6;
    this.maxNotes = opts.maxNotes ?? 4;
    // A further note is accepted while its salience is at least this fraction of the strongest note's.
    this.relThreshold = opts.relThreshold ?? 0.25;
    // Peaks weaker than this fraction of the strongest whitened peak are ignored.
    this.peakThreshold = opts.peakThreshold ?? 0.05;
    // Partials h >= 2 must lie within this many semitones of h times the measured fundamental.
    this.harmonicTolerance = opts.harmonicTolerance ?? 0.3;

    const half = size / 2;
    this.binHz = sampleRate / size;
    this.fft = new FFT(size);
    this.windows = new Map([[size, hann(size)]]);
    this.windowed = new Float64Array(size);
    this.mag = new Float64Array(half + 1);
    this.white = new Float64Array(half + 1);
    this.prefix = new Float64Array(half + 2);
    this.lowBin = Math.max(2, Math.floor(midiToFreq(this.minMidi - 1, this.a4) / this.binHz));
    this.highBin = Math.min(half - 2, Math.ceil(Math.min(10000, sampleRate * 0.45) / this.binHz));
    this.maxPeakMidi = freqToMidi(this.highBin * this.binHz, this.a4);

    // Whitening band of each bin: +-1/6 octave, at least +-2 bins.
    this.bandLo = new Int32Array(half + 1);
    this.bandHi = new Int32Array(half + 1);
    for (let k = 0; k <= half; k++) {
      this.bandLo[k] = Math.max(0, Math.min(k - 2, Math.floor(k * 2 ** (-1 / 6))));
      this.bandHi[k] = Math.min(half, Math.max(k + 2, Math.ceil(k * 2 ** (1 / 6))));
    }

    this.peakMidi = new Float64Array(MAX_PEAKS);
    this.peakAmp = new Float64Array(MAX_PEAKS);
    this.resid = new Float64Array(MAX_PEAKS);
    this.peakCount = 0;

    const H = this.harmonics;
    this.harmOffset = new Float64Array(H + 1);
    for (let h = 1; h <= H; h++) this.harmOffset[h] = 12 * Math.log2(h);
    this.matched = new Int32Array(H + 2).fill(-1);
    this.matchedAmp = new Float64Array(H + 2);
  }

  // Returns the notes sounding in the last `length` samples of `frame` (length
  // `size`, oldest sample first), strongest first, as [{ midi, cents, salience }].
  analyze(frame, length = this.size) {
    this.findPeaks(frame, length);
    const { peakMidi, peakAmp, resid, peakCount } = this;
    resid.set(peakAmp.subarray(0, peakCount));

    // Greedy selection: repeatedly take the most salient fundamental and remove its partials.
    const chosen = [];
    let first = 0;
    for (let iter = 0; iter < this.maxPolyphony; iter++) {
      let best = -1;
      let bestS = 0;
      for (let i = 0; i < peakCount; i++) {
        const pm = peakMidi[i];
        if (pm < this.minMidi - 0.5 || pm > this.maxMidi + 0.5 || resid[i] <= 0) continue;
        const s = this.salience(i);
        if (s > bestS) {
          bestS = s;
          best = i;
        }
      }
      if (best < 0) break;
      if (iter === 0) first = bestS;
      else if (bestS < this.relThreshold * first) break;
      chosen.push(best);
      this.salience(best); // refill matched partials for the winner
      this.subtract();
    }

    // Greedy order can pick a strong upper partial before its fundamental.
    // Re-scoring from the lowest note up lets each note claim its partials
    // first, so such a partial is left with little salience of its own.
    chosen.sort((a, b) => a - b);
    resid.set(peakAmp.subarray(0, peakCount));
    const scores = chosen.map((i) => {
      const s = this.salience(i);
      this.subtract();
      return s;
    });
    const top = Math.max(0, ...scores);
    const notes = [];
    chosen.forEach((i, k) => {
      const midi = Math.round(peakMidi[i]);
      if (scores[k] < this.relThreshold * top || notes.some((n) => n.midi === midi)) return;
      notes.push({ midi, cents: Math.round((peakMidi[i] - midi) * 100), salience: scores[k] });
    });
    return notes.sort((a, b) => b.salience - a.salience).slice(0, this.maxNotes);
  }

  windowOf(length) {
    let w = this.windows.get(length);
    if (!w) this.windows.set(length, (w = hann(length)));
    return w;
  }

  findPeaks(frame, length) {
    const { size, windowed, mag, white, prefix, bandLo, bandHi } = this;
    const half = size / 2;
    const window = this.windowOf(length);
    const start = size - length;
    windowed.fill(0, 0, start);
    for (let i = start; i < size; i++) windowed[i] = frame[i] * window[i - start];
    this.fft.magnitude(windowed, mag);

    prefix[0] = 0;
    for (let k = 0; k <= half; k++) prefix[k + 1] = prefix[k] + mag[k] * mag[k];
    let maxEnv = 0;
    for (let k = 0; k <= half; k++) {
      const lo = bandLo[k];
      const hi = bandHi[k];
      const env = Math.sqrt((prefix[hi + 1] - prefix[lo]) / (hi - lo + 1));
      white[k] = env;
      if (env > maxEnv) maxEnv = env;
    }
    const floor = maxEnv * 1e-3 + 1e-12;
    let maxWhite = 0;
    for (let k = 0; k <= half; k++) {
      white[k] = mag[k] * Math.pow(Math.max(white[k], floor), NU - 1);
      if (k >= this.lowBin && k <= this.highBin && white[k] > maxWhite) maxWhite = white[k];
    }

    let count = 0;
    if (maxWhite > 0) {
      const thr = maxWhite * this.peakThreshold;
      for (let k = this.lowBin; k <= this.highBin && count < MAX_PEAKS; k++) {
        const m = mag[k];
        if (m > mag[k - 1] && m >= mag[k + 1] && white[k] >= thr) {
          // Parabolic interpolation on log magnitude.
          const a = Math.log(mag[k - 1] + 1e-30);
          const b = Math.log(m + 1e-30);
          const c = Math.log(mag[k + 1] + 1e-30);
          const denom = a - 2 * b + c;
          const p = denom < 0 ? (0.5 * (a - c)) / denom : 0;
          this.peakMidi[count] = freqToMidi((k + p) * this.binHz, this.a4);
          this.peakAmp[count] = white[k];
          count++;
        }
      }
    }
    this.peakCount = count;
  }

  nearestPeak(target, tol) {
    const { peakMidi, peakCount } = this;
    let lo = 0;
    let hi = peakCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (peakMidi[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestD = tol;
    for (let i = lo - 1; i <= lo; i++) {
      if (i < 0 || i >= peakCount) continue;
      const d = Math.abs(peakMidi[i] - target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // Weighted sum of residual partial amplitudes for the fundamental at peak `fi`.
  // Records the matched partials for `subtract`. Candidates with fewer than two
  // partials score zero, which rejects isolated noise peaks.
  salience(fi) {
    const { peakMidi, resid, matched, matchedAmp, harmOffset } = this;
    const H = this.harmonics;
    const tol = this.harmonicTolerance;
    const pm1 = peakMidi[fi];
    const f0 = midiToFreq(pm1, this.a4);
    let s = 0;
    let hits = 0;
    matched.fill(-1);
    matchedAmp.fill(0);
    for (let h = 1; h <= H; h++) {
      const target = pm1 + harmOffset[h];
      if (target > this.maxPeakMidi) break;
      const idx = h === 1 ? fi : this.nearestPeak(target, tol);
      if (idx < 0) continue;
      const amp = resid[idx];
      matched[h] = idx;
      matchedAmp[h] = amp;
      if (amp <= 0) continue;
      hits++;
      const d = (peakMidi[idx] - target) / tol;
      s += ((f0 + 52) / (h * f0 + 320)) * amp * (1 - d * d);
    }
    return hits >= 2 ? s : 0;
  }

  // Removes the last salience() candidate's partials from the residual, limiting
  // each partial to the local average of its neighbours so that partials shared
  // with other notes keep the other notes' share (spectral smoothness).
  subtract() {
    const { resid, matched, matchedAmp } = this;
    const H = this.harmonics;
    for (let h = 1; h <= H; h++) {
      const idx = matched[h];
      if (idx < 0) continue;
      if (h === 1) {
        resid[idx] = 0;
        continue;
      }
      const a = matchedAmp[h];
      const avg = (matchedAmp[h - 1] + a + matchedAmp[h + 1]) / 3;
      resid[idx] = Math.max(0, resid[idx] - Math.min(a, avg));
    }
  }
}

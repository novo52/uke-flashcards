// Synthetic plucked-nylon ukulele for offline tests: additive partials with a
// plucking-position comb, per-partial exponential decay, slight inharmonicity,
// a short noise burst at the attack, and per-string detuning.
import { midiToFreq, UKE_TUNING } from '../dsp/notes.js';

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Adds one plucked note into `out` from `start` to `stop` (seconds).
export function pluck(out, sr, { start, stop, midi, cents = 0, amp = 0.2, rolloff = 1.1, random }) {
  const f0 = midiToFreq(midi + cents / 100);
  const s0 = Math.round(start * sr);
  const s1 = Math.min(out.length, Math.round(stop * sr));
  const fade = Math.round(0.01 * sr);
  const B = 1e-4;
  const pos = 0.1 + random() * 0.2; // plucking point along the string
  for (let h = 1; h <= 14; h++) {
    const f = h * f0 * Math.sqrt(1 + B * h * h);
    if (f > sr * 0.45) break;
    const a = (amp * Math.abs(Math.sin(Math.PI * h * pos))) / h ** rolloff;
    const tau = 1.0 / (1 + 0.5 * (h - 1));
    const w = (2 * Math.PI * f) / sr;
    const ph = random() * 2 * Math.PI;
    for (let i = s0; i < s1; i++) {
      const n = i - s0;
      const env = Math.min(1, n / (0.002 * sr)) * Math.exp(-n / sr / tau) * Math.min(1, (s1 - i) / fade);
      out[i] += a * env * Math.sin(ph + w * n);
    }
  }
  const burst = Math.round(0.004 * sr);
  for (let n = 0; n < burst && s0 + n < s1; n++) out[s0 + n] += amp * 0.3 * (random() * 2 - 1) * (1 - n / burst);
}

// Renders strums of fret shapes (G C E A order, -1 = muted).
// `events`: [{ t, frets }]. Each string rings until it is next plucked, or with
// `damp` until the next event.
export function renderStrums(events, { sr = 48000, tail = 1, seed = 1, spread = 0.008, noiseDb = -60, damp = false, rolloff } = {}) {
  const random = rng(seed);
  const duration = events[events.length - 1].t + tail;
  const out = new Float32Array(Math.ceil(duration * sr));
  const plucks = [];
  events.forEach((ev, i) => {
    const end = damp && i + 1 < events.length ? events[i + 1].t : Infinity;
    ev.frets.forEach((fret, s) => {
      if (fret < 0) return;
      plucks.push({ s, start: ev.t + s * spread, end, midi: UKE_TUNING[s] + fret });
    });
  });
  for (const p of plucks) {
    const next = plucks.find((q) => q.s === p.s && q.start > p.start);
    pluck(out, sr, {
      start: p.start,
      stop: Math.min(p.end, next ? next.start : duration),
      midi: p.midi,
      cents: (random() - 0.5) * 16,
      amp: 0.12 + random() * 0.1,
      rolloff,
      random,
    });
  }
  const noise = 10 ** (noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) out[i] += noise * (random() * 2 - 1);
  return out;
}

export function runAnalyzer(analyzer, signal, block = 128) {
  const frames = [];
  for (let i = 0; i + block <= signal.length; i += block) {
    for (const f of analyzer.push(signal.subarray(i, i + block), i)) frames.push(f);
  }
  return frames;
}

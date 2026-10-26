// Scores strums against a song's strum targets.
//
// Each target is judged on two things:
// - timing: the strum's attack, minus the latency offset, against the target time;
// - chord: the chord the strum settled on. A strum whose fingers land after
//   the pick still counts as the right chord, for fewer points the later the
//   fingers were (`fingers` from the analyzer).
// A judgment is final STRUM_FINAL seconds after its strum, after the
// analyzer's last possible revision of the chord.
import { parseChord } from '../dsp/chords.js';

export const TIMING = [
  { name: 'Perfect', within: 0.035, points: 100 },
  { name: 'Great', within: 0.07, points: 75 },
  { name: 'Good', within: 0.12, points: 50 },
];
const WINDOW = TIMING[TIMING.length - 1].within;
// Fingers forming the chord within FINGERS_GRACE of the pick cost nothing; the
// penalty grows to FINGERS_MAX_PENALTY of the points at FINGERS_LATE.
export const FINGERS_GRACE = 0.06;
export const FINGERS_LATE = 0.35;
const FINGERS_MAX_PENALTY = 0.5;
// A chord with the right root that is missing or adds a tone (C5 or Cmaj7 for C).
const CLOSE_FACTOR = 0.5;
const STRUM_FINAL = 0.45;
// A target is missed once a strum within the window would have been reported
// (the analyzer reports a strum up to 0.3 s after its attack).
const MISS_AFTER = WINDOW + 0.35;
// Streak length per multiplier step, and the top multiplier.
const STREAK_STEP = 8;
const MAX_MULTIPLIER = 4;

const popcount = (m) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};

// 'right', 'close' or 'wrong' for a detected chord name against a target.
export function compareChord(target, played) {
  const want = parseChord(target);
  const got = played ? parseChord(played) : null;
  if (!want || !got) return 'wrong';
  if (got.mask === want.mask) return 'right';
  // A power chord (root and fifth) is right played as any chord holding both.
  if (want.suffix === '5' && got.root === want.root && (got.mask & want.mask) === want.mask) return 'right';
  const shared = got.mask & want.mask;
  const nested = shared === got.mask || shared === want.mask;
  return got.root === want.root && nested && popcount(shared) >= 2 ? 'close' : 'wrong';
}

// 'right', 'close' or 'wrong' for a strum against a single-note target with
// pitch class `note`: the note alone is right, the note among others close.
export function compareNote(note, played, mask) {
  const m = mask ?? (played ? parseChord(played)?.mask : 0);
  const bit = 1 << note;
  return m === bit ? 'right' : m & bit ? 'close' : 'wrong';
}

export function fingersFactor(fingers) {
  const late = Math.min(1, Math.max(0, ((fingers ?? 0) - FINGERS_GRACE) / (FINGERS_LATE - FINGERS_GRACE)));
  return 1 - FINGERS_MAX_PENALTY * late;
}

export class Scorer {
  // `targets`: [{ t, chord, note?, label?, ... }] sorted by time, on the
  // strums' clock. `chord` is the chord that should sound, or `note` the pitch
  // class of a single note; `label`, when given, is the name shown to the
  // player (the shape, when playing with a capo); `accept`, when given, the
  // mask of a chosen voicing that also counts as right.
  constructor(targets) {
    this.targets = targets.map((target, index) => ({ ...target, index, judgment: null }));
    this.next = 0; // first target that may still be unjudged
    this.pending = []; // judgments awaiting a possible chord revision
    this.judgments = [];
    this.extra = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
  }

  get multiplier() {
    return Math.min(MAX_MULTIPLIER, 1 + Math.floor(this.streak / STREAK_STEP));
  }

  // A strum from the analyzer, `t` already corrected for latency. Returns the
  // provisional judgment, or null for a strum that matches no target.
  strum({ t, chord, mask, fingers }) {
    let best = null;
    for (let i = this.next; i < this.targets.length; i++) {
      const target = this.targets[i];
      if (target.t > t + WINDOW) break;
      if (target.judgment || target.t < t - WINDOW) continue;
      if (!best || Math.abs(target.t - t) < Math.abs(best.t - t)) best = target;
    }
    if (!best) {
      this.extra++;
      return null;
    }
    const dt = t - best.t;
    const timing = TIMING.find((x) => Math.abs(dt) <= x.within);
    const j = { target: best, t, dt, timing: timing.name, base: timing.points, chord, mask, fingers: fingers ?? 0, final: false };
    this.rate(j);
    best.judgment = j;
    this.pending.push(j);
    return j;
  }

  // A later reading of the same strum's chord (the analyzer's strumUpdate).
  update({ t, chord, mask, fingers }) {
    const j = this.pending.find((x) => Math.abs(x.t - t) < 1e-6);
    if (!j) return null;
    j.chord = chord;
    j.mask = mask;
    j.fingers = fingers ?? j.fingers;
    this.rate(j);
    return j;
  }

  rate(j) {
    j.result = j.target.note !== undefined ? compareNote(j.target.note, j.chord, j.mask) : compareChord(j.target.chord, j.chord);
    if (j.result !== 'right' && j.mask && j.target.accept === j.mask) j.result = 'right';
    j.lateFingers = j.result !== 'wrong' && j.fingers > FINGERS_GRACE;
    const chordFactor = j.result === 'right' ? 1 : j.result === 'close' ? CLOSE_FACTOR : 0;
    j.points = Math.round(j.base * chordFactor * fingersFactor(j.fingers));
  }

  // Finalises judgments and records misses up to `now` (the strums' clock).
  // Returns the judgments finalised by this call, misses included.
  advance(now) {
    const done = [];
    while (this.pending.length && now - this.pending[0].t >= STRUM_FINAL) {
      const j = this.pending.shift();
      this.finish(j);
      done.push(j);
    }
    for (; this.next < this.targets.length; this.next++) {
      const target = this.targets[this.next];
      if (target.judgment) continue;
      if (now - target.t <= MISS_AFTER) break;
      const j = { target, t: null, dt: null, timing: 'Miss', base: 0, chord: null, fingers: 0, result: 'miss', points: 0, final: false };
      target.judgment = j;
      this.finish(j);
      done.push(j);
    }
    return done;
  }

  finish(j) {
    j.final = true;
    if (j.result === 'right' || j.result === 'close') {
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else this.streak = 0;
    j.multiplier = this.multiplier;
    this.score += j.points * j.multiplier;
    this.judgments.push(j);
  }

  // Moves every target and strum `dt` seconds later, for a song resumed after a pause.
  shift(dt) {
    for (const target of this.targets) target.t += dt;
    for (const j of [...this.judgments, ...this.pending]) if (j.t !== null) j.t += dt;
  }

  get finished() {
    return this.next >= this.targets.length && !this.pending.length;
  }

  // Totals over the finalised judgments.
  summary() {
    const js = this.judgments;
    const hits = js.filter((j) => j.t !== null);
    const count = (pred) => js.filter(pred).length;
    const dts = hits.map((j) => j.dt);
    const mean = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : 0;
    const sd = dts.length > 1 ? Math.sqrt(dts.reduce((a, b) => a + (b - mean) ** 2, 0) / (dts.length - 1)) : 0;
    // Chord changes the fingers were late on, by the change they came from.
    const changes = new Map();
    for (const j of hits) {
      const prev = this.targets[j.target.index - 1];
      if (!j.target.change || !prev || j.result === 'wrong') continue;
      const key = `${prev.label ?? prev.chord} → ${j.target.label ?? j.target.chord}`;
      const c = changes.get(key) ?? { change: key, count: 0, late: 0, fingers: 0 };
      c.count++;
      c.fingers += j.fingers;
      if (j.lateFingers) c.late++;
      changes.set(key, c);
    }
    const slowChanges = [...changes.values()]
      .map((c) => ({ ...c, fingers: c.fingers / c.count }))
      .filter((c) => c.late)
      .sort((a, b) => b.fingers - a.fingers);
    const late = hits.filter((j) => j.lateFingers);
    return {
      targets: this.targets.length,
      score: this.score,
      accuracy: js.length ? js.reduce((a, j) => a + j.points, 0) / (100 * js.length) : 0,
      timing: Object.fromEntries([...TIMING.map((x) => x.name), 'Miss'].map((name) => [name, count((j) => j.timing === name)])),
      chords: { right: count((j) => j.result === 'right'), close: count((j) => j.result === 'close'), wrong: count((j) => j.result === 'wrong') },
      lateFingers: late.length,
      meanFingers: late.length ? late.reduce((a, j) => a + j.fingers, 0) / late.length : 0,
      slowChanges,
      meanOffset: mean,
      spread: sd,
      extra: this.extra,
      bestStreak: this.bestStreak,
    };
  }
}

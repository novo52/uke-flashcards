import { NOTE_NAMES } from './notes.js';

// `prior` is a complexity cost: when two chords explain the same pitch classes
// equally well (Am7 / C6), the simpler or more common one wins.
const QUALITIES = [
  { suffix: '', intervals: [0, 4, 7], prior: 0 },
  { suffix: 'm', intervals: [0, 3, 7], prior: 0 },
  { suffix: '7', intervals: [0, 4, 7, 10], prior: 0.02 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], prior: 0.02 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], prior: 0.03 },
  { suffix: 'sus4', intervals: [0, 5, 7], prior: 0.03 },
  { suffix: 'dim', intervals: [0, 3, 6], prior: 0.03 },
  { suffix: '6', intervals: [0, 4, 7, 9], prior: 0.04 },
  { suffix: 'sus2', intervals: [0, 2, 7], prior: 0.04 },
  { suffix: 'aug', intervals: [0, 4, 8], prior: 0.04 },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10], prior: 0.04 },
  { suffix: 'm6', intervals: [0, 3, 7, 9], prior: 0.05 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], prior: 0.05 },
  { suffix: '7sus4', intervals: [0, 5, 7, 10], prior: 0.05 },
  { suffix: 'add9', intervals: [0, 2, 4, 7], prior: 0.05 },
  { suffix: '9', intervals: [0, 2, 4, 7, 10], prior: 0.06 },
  { suffix: '5', intervals: [0, 7], prior: 0.06 },
];

// Cost of a template tone that is not sounding. A missing fifth is common on a
// four-string instrument; a missing root or third changes what the chord is.
const MISSING_COST = { 0: 0.3, 3: 0.2, 4: 0.2, 7: 0.06 };
const DEFAULT_MISSING_COST = 0.18;
const PRESENT = 0.04;
const MIN_SCORE = 0.3;

const Q = QUALITIES.length;
const w = new Float64Array(12);
const scores = new Float64Array(12 * Q);
const NAMES = [];
const MASKS = []; // pitch-class bitmask (bit 0 = C) of each name
for (let root = 0; root < 12; root++) {
  for (const q of QUALITIES) {
    NAMES.push(NOTE_NAMES[root] + q.suffix);
    MASKS.push(q.intervals.reduce((m, iv) => m | (1 << ((root + iv) % 12)), 0));
  }
}

// `weights`: 12 non-negative pitch-class weights (index 0 = C).
// Returns { name, root, suffix, mask, score, complete, alternatives } or null,
// where `mask` holds the chord's pitch classes (bit 0 = C) and `complete` means
// a chord of three or more tones with every tone sounding. Scores live in
// preallocated buffers because this runs on the audio thread every hop.
export function recognizeChord(weights) {
  let total = 0;
  for (let pc = 0; pc < 12; pc++) total += weights[pc];
  if (total <= 0) return null;
  let present = 0;
  let loudest = 0;
  for (let pc = 0; pc < 12; pc++) {
    w[pc] = weights[pc] / total;
    if (w[pc] >= PRESENT) present++;
    if (w[pc] > w[loudest]) loudest = pc;
  }
  if (present === 1) return { name: NOTE_NAMES[loudest], root: loudest, suffix: null, mask: 1 << loudest, score: 1, complete: false, alternatives: [] };

  let best = 0;
  for (let root = 0; root < 12; root++) {
    for (let qi = 0; qi < Q; qi++) {
      const q = QUALITIES[qi];
      let inside = 0;
      let missing = 0;
      for (const iv of q.intervals) {
        const x = w[(root + iv) % 12];
        inside += x;
        if (x < PRESENT) missing += MISSING_COST[iv] ?? DEFAULT_MISSING_COST;
      }
      const i = root * Q + qi;
      scores[i] = inside - 1.5 * (1 - inside) - missing - q.prior + 0.08 * w[root];
      if (scores[i] > scores[best]) best = i;
    }
  }
  const score = scores[best];
  if (score < MIN_SCORE) return null;

  // Up to three runners-up within 0.08 of the winner.
  const alternatives = [];
  scores[best] = -Infinity;
  for (let k = 0; k < 3; k++) {
    let next = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[next]) next = i;
    if (scores[next] < score - 0.08) break;
    alternatives.push(NAMES[next]);
    scores[next] = -Infinity;
  }
  const root = Math.floor(best / Q);
  const q = QUALITIES[best % Q];
  const complete = q.intervals.length >= 3 && q.intervals.every((iv) => w[(root + iv) % 12] >= PRESENT);
  return { name: NAMES[best], root, suffix: q.suffix, mask: MASKS[best], score, complete, alternatives };
}

const LETTERS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Chord-sheet spellings of the recognised qualities, and extended chords
// reduced to the quality a ukulele voicing of them sounds like.
const SUFFIX_ALIASES = {
  M: '', maj: '', major: '', min: 'm', mi: 'm', '-': 'm', minor: 'm', M7: 'maj7', ma7: 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7',
  'min7': 'm7', 'mi7': 'm7', '-7': 'm7', sus: 'sus4', add2: 'add9', '2': 'sus2', '°': 'dim', o: 'dim', '°7': 'dim7', o7: 'dim7',
  'ø': 'm7b5', 'ø7': 'm7b5', '+': 'aug', '7sus': '7sus4', maj9: 'maj7', m9: 'm7', m11: 'm7', '11': '7', '13': '7', '7b9': '7', '7#9': '7',
};

// `name` moved by `semitones`, in the recogniser's spelling ("G" + 1 → "Ab").
export function transposeChord(name, semitones) {
  const c = parseChord(name);
  if (!c) return null;
  const root = (((c.root + semitones) % 12) + 12) % 12;
  return NAMES[root * Q + QUALITIES.findIndex((q) => q.suffix === c.suffix)];
}

// Parses a chord-sheet name ("Bb", "F#m7", "D/F#", "Dsus2") into
// { name, root, suffix, mask } in the recogniser's spelling, or null. A slash
// bass is dropped, and a suffix outside the recognised qualities is reduced
// to its longest recognised prefix ("D7sus2" → "D7").
export function parseChord(text) {
  if (!text) return null;
  const m = /^([A-G])([#b♯♭]?)([^/]*)/.exec(text.trim());
  if (!m) return null;
  const root = (LETTERS[m[1]] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? 11 : 0)) % 12;
  let rest = m[3].replace(/[()]/g, '');
  for (let alias = true; ; rest = rest.slice(0, -1), alias = false) {
    const suffix = alias && rest in SUFFIX_ALIASES ? SUFFIX_ALIASES[rest] : rest;
    const qi = QUALITIES.findIndex((q) => q.suffix === suffix);
    if (qi >= 0) return { name: NAMES[root * Q + qi], root, suffix, mask: MASKS[root * Q + qi] };
    if (!rest) return null;
  }
}

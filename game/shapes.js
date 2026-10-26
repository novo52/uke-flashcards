// Ukulele chord shapes (G C E A string order) for the chord diagrams.
import { parseChord, recognizeChord } from '../dsp/chords.js';
import { UKE_TUNING, NOTE_NAMES } from '../dsp/notes.js';

// Common first-position shapes; other chords are found by search.
const COMMON = {
  C: [0, 0, 0, 3], Cm: [0, 3, 3, 3], C7: [0, 0, 0, 1], Cmaj7: [0, 0, 0, 2], Cm7: [3, 3, 3, 3],
  'C#': [1, 1, 1, 4], 'C#m': [1, 1, 0, 4], D: [2, 2, 2, 0], Dm: [2, 2, 1, 0], D7: [2, 2, 2, 3], Dm7: [2, 2, 1, 3],
  Eb: [0, 3, 3, 1], E: [4, 4, 4, 2], Em: [0, 4, 3, 2], E7: [1, 2, 0, 2], Em7: [0, 2, 0, 2],
  F: [2, 0, 1, 0], Fm: [1, 0, 1, 3], F7: [2, 3, 1, 3], Fmaj7: [2, 4, 1, 3], 'F#m': [2, 1, 2, 0], 'F#': [3, 1, 2, 1],
  G: [0, 2, 3, 2], Gm: [0, 2, 3, 1], G7: [0, 2, 1, 2], Gmaj7: [0, 2, 2, 2],
  Ab: [5, 3, 4, 3], A: [2, 1, 0, 0], Am: [2, 0, 0, 0], A7: [0, 1, 0, 0], Am7: [0, 0, 0, 0],
  Bb: [3, 2, 1, 1], B: [4, 3, 2, 2], Bm: [4, 2, 2, 2], B7: [2, 3, 2, 2], Bm7: [2, 2, 2, 2],
};

const cache = new Map();

// Where to play pitch class `pc` (frets relative to any capo), as frets with
// -1 for the strings not played. `held`, the frets of the chord the hand is
// on, puts the note where that hand changes least: a place the chord already
// sounds it, an open string the chord leaves free, then a spare finger within
// the chord's four-fret reach (also above a held fret on the same string,
// since the higher fret sounds). Otherwise, and without `held`, the lowest fret.
export function noteShape(pc, held = null) {
  const fretted = held?.filter((f) => f > 0) ?? [];
  const spare = fretted.length > 0 && new Set(fingersFor(held).fingers.filter((f) => f > 0)).size < 4;
  const reach = [Math.max(1, Math.max(...fretted) - 3), Math.min(...fretted) + 3];
  const cost = (s, fret) => {
    if (!held) return fret;
    if (held[s] === fret) return 0;
    if (fret === 0) return held[s] > 0 ? 100 : 1;
    if (spare && fret >= reach[0] && fret <= reach[1] && !(held[s] > fret)) return 2 + fret / 100;
    return 100 + fret;
  };
  let best = null;
  UKE_TUNING.forEach((open, s) => {
    for (let fret = (((pc - open) % 12) + 12) % 12; fret <= 12; fret += 12) {
      const c = cost(s, fret);
      if (!best || c < best.c || (c === best.c && s > best.s)) best = { s, fret, c };
    }
  });
  return UKE_TUNING.map((_, s) => (s === best.s ? best.fret : -1));
}

// The chord to finger for `name`: a power chord (root and fifth) is played as
// the major chord, which scoring accepts for it and which sits better on four
// strings.
export function playedAs(name) {
  const chord = parseChord(name);
  return chord?.suffix === '5' ? chord.name.slice(0, -1) : chord?.name ?? null;
}

// Frets for `name`: the voicing chosen for it, else the default; null when it
// is not a chord the recogniser knows.
export function shapeFor(name) {
  const key = parseChord(name)?.name;
  return (key && loadChoices()[key]) ?? defaultShape(name);
}

function defaultShape(name) {
  const played = playedAs(name);
  const chord = played && parseChord(played);
  if (!chord) return null;
  if (COMMON[chord.name]) return COMMON[chord.name];
  if (!cache.has(chord.name)) cache.set(chord.name, search(chord) ?? search(chord, true));
  return cache.get(chord.name);
}

// Fingerings from chords-db (data/uke-fingerings.json): frets key -> fingers.
const fingerings = new Map();

export function setFingerings(data) {
  fingerings.clear();
  for (const [frets, fingers] of data.positions) fingerings.set(frets.join(','), fingers);
}

// The finger on each string (1 index to 4 little, 0 open or not played) for a
// voicing: from chords-db when it lists the voicing, else estimated (`source`
// says which). The estimate gives each fretted string its own finger in fret
// order, with a barre of the index finger when all four strings are fretted and
// several share the lowest fret.
export function fingersFor(frets) {
  const known = fingerings.get(frets.join(','));
  if (known) return { fingers: known, source: 'chords-db' };
  const fretted = frets.map((f, s) => ({ f, s })).filter((x) => x.f > 0).sort((a, b) => a.f - b.f || a.s - b.s);
  const fingers = frets.map(() => 0);
  const lowest = fretted[0]?.f;
  const barre = fretted.length === 4 && fretted.filter((x) => x.f === lowest).length > 1;
  let next = 1;
  for (const x of fretted) fingers[x.s] = barre && x.f === lowest ? 1 : barre ? ++next : next++;
  return { fingers, source: 'estimate' };
}

const STORAGE_KEY = 'uke.voicings.v1';
let choices = null;

function loadChoices() {
  if (!choices) {
    try {
      choices = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY)) ?? {};
    } catch {
      choices = {};
    }
  }
  return choices;
}

// Remembers `frets` as the way to play `name` (null: back to the default).
export function chooseShape(name, frets) {
  const key = parseChord(name)?.name;
  if (!key) return;
  const all = loadChoices();
  if (frets) all[key] = frets;
  else delete all[key];
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Choices then last for this page only.
  }
}

export function chosenShape(name) {
  const key = parseChord(name)?.name;
  return (key && loadChoices()[key]) ?? null;
}

// The chord the recogniser names for a voicing (frets relative to any capo).
export function voicingChord(frets) {
  const w = new Array(12).fill(0);
  frets.forEach((f, s) => {
    if (f >= 0) w[(UKE_TUNING[s] + f) % 12] += 1;
  });
  return recognizeChord(w);
}

// The pitch-class mask a strum of the voicing chosen for `name` is heard as,
// or null when none is chosen.
export function chosenMask(name) {
  const frets = chosenShape(name);
  return frets ? voicingChord(frets)?.mask ?? null : null;
}

// Ways to play `name`, easiest first, the default one leading: voicings of
// the chord, the chord without its fifth (four-tone chords), and for a power
// chord the major and minor chords too. Each is { frets, chord } with the
// chord the recogniser hears in it.
export function voicings(name, limit = 10) {
  const chord = parseChord(name);
  if (!chord) return [];
  const members = [chord];
  if (chord.suffix === '5') members.push(parseChord(NOTE_NAMES[chord.root]), parseChord(`${NOTE_NAMES[chord.root]}m`));
  const fifth = 1 << ((chord.root + 7) % 12);
  const rules = [];
  for (const m of members) {
    rules.push({ allow: m.mask, required: m.mask });
    let tones = 0;
    for (let x = m.mask; x; x &= x - 1) tones++;
    if (tones >= 4 && m.mask & fifth) rules.push({ allow: m.mask, required: m.mask & ~fifth });
  }
  const found = new Map();
  const frets = [0, 0, 0, 0];
  // The cost of `frets` as a voicing of the chord, or undefined when it is not one.
  const rate = (frets) => {
    let sounding = 0;
    for (let i = 0; i < 4; i++) if (frets[i] >= 0) sounding |= 1 << ((UKE_TUNING[i] + frets[i]) % 12);
    if (!(sounding & (1 << chord.root))) return;
    if (!rules.some((r) => !(sounding & ~r.allow) && (sounding & r.required) === r.required)) return;
    // Only an outer string is easy to leave out.
    const muted = frets.filter((f) => f < 0).length;
    if (muted > 1 || frets[1] < 0 || frets[2] < 0) return;
    const fretted = frets.filter((f) => f > 0);
    const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
    if (span > 3) return;
    return fretted.reduce((a, b) => a + b, 0) + 2 * span + 3 * muted;
  };
  const visit = (s) => {
    if (s === 4) {
      const cost = rate(frets);
      if (cost !== undefined) found.set(frets.join(','), { frets: [...frets], cost });
      return;
    }
    for (let f = -1; f <= 10; f++) {
      frets[s] = f;
      visit(s + 1);
    }
  };
  visit(0);
  const preferred = defaultShape(name);
  // The usual shape first, then the voicings chords-db lists, then the rest.
  const listed = [];
  for (const key of fingerings.keys()) {
    const f = key.split(',').map(Number);
    const cost = rate(f);
    if (cost !== undefined) listed.push({ frets: f, cost: cost - 1000 });
  }
  const list = [...listed, ...found.values()];
  if (preferred) list.push({ frets: preferred, cost: -Infinity });
  list.sort((a, b) => a.cost - b.cost);
  const seen = new Set();
  const unique = [];
  for (const v of list) {
    const key = v.frets.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...v, chord: voicingChord(v.frets)?.name ?? null });
  }
  // A voicing with a string left out is kept only when it is easier than
  // every full voicing of the same chord.
  const easiest = new Map();
  for (const v of unique) if (!v.frets.includes(-1) && !easiest.has(v.chord)) easiest.set(v.chord, v.cost);
  return unique
    .filter((v) => !v.frets.includes(-1) || !(easiest.get(v.chord) <= v.cost))
    .slice(0, limit)
    .map(({ frets: f, chord: c }) => ({ frets: f, chord: c }));
}

// The lowest compact voicing that sounds every chord tone (five-tone chords
// leave out the fifth). With `mute`, one string may be left unplayed.
function search({ root, mask }, mute = false) {
  let tones = 0;
  for (let m = mask; m; m &= m - 1) tones++;
  const required = tones > 4 ? mask & ~(1 << ((root + 7) % 12)) : mask;
  let best = null;
  let bestCost = Infinity;
  const frets = [0, 0, 0, 0];
  const visit = (s) => {
    if (s === 4) {
      let sounding = 0;
      for (let i = 0; i < 4; i++) if (frets[i] >= 0) sounding |= 1 << ((UKE_TUNING[i] + frets[i]) % 12);
      if ((sounding & ~mask) || (sounding & required) !== required) return;
      if (frets.filter((f) => f < 0).length > 1) return;
      const fretted = frets.filter((f) => f > 0);
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
      if (span > 3) return;
      const cost = frets.reduce((a, b) => a + Math.max(b, 0), 0) + 2 * span;
      if (cost < bestCost) {
        bestCost = cost;
        best = [...frets];
      }
      return;
    }
    for (let f = mute ? -1 : 0; f <= 7; f++) {
      frets[s] = f;
      visit(s + 1);
    }
  };
  visit(0);
  return best;
}

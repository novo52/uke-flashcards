// Chord flashcards in the manner of keybr.com: lessons are lines of chord
// progressions, played from memory while the analyzer listens.
//
// - Each chord's speed is its change time (from the previous right strum to its
//   own), averaged per lesson and smoothed across lessons with an exponential
//   filter (alpha 0.1, as keybr). A chord not played for days is taken to
//   have slowed (keybr has no such decay; see `currentTime`). Confidence is
//   the target time over the current time; 1 means at target speed.
// - Chords unlock in CURRICULUM order, at least *Start with* of them: the next
//   one only once every unlocked chord has reached confidence 1 at its best.
//   An unlocked chord stays unlocked.
// - The focused chord is the least confident unlocked one below 1 (a new chord
//   has no confidence yet, so it is focused first). Every progression in a
//   lesson contains it.
// - Lessons are phrases generated as keybr generates words: a walk over an
//   order-4 chain (three chords predict the next) counted from real songs
//   (data/chord-chain.json, from Chordonomicon; see
//   tools/build-chord-chain.mjs), keeping only unlocked chords. Changes come up
//   in proportion to how often songs make them; a context with no unlocked
//   continuation backs off to a shorter one.
import { parseChord } from '../dsp/chords.js';
import { compareChord } from './score.js';
import { shapeFor, chosenMask } from './shapes.js';
import { drawDiagram } from './diagram.js';

// Easy, common shapes first, grouped by the keys songs use them in.
export const CURRICULUM = [
  'C', 'Am', 'F', 'G', 'G7', 'Dm', 'Em', 'A7', 'D', 'A', 'C7', 'E7', 'D7', 'Bb',
  'Am7', 'Fmaj7', 'Cmaj7', 'Gm', 'Dm7', 'Em7', 'Bm', 'B7', 'F7', 'E', 'Cm', 'Eb',
];
const MIN_CHORDS = 2;
const ALPHA = 0.1;
const LESSON_CHORDS = 16; // a lesson ends with the phrase that reaches this
const MIN_PHRASE = 3;
const MAX_PHRASE = 8;
const KEEP_SAMPLES = 100; // lesson samples kept per chord
const KEEP_PAIR = 8; // change times kept per pair of chords
const REVEAL_AFTER = 6; // seconds before the shape is shown unasked
const UPDATE_WAIT = 0.45; // seconds the analyzer may still revise a strum's chord
const MIN_CHANGE = 0.25; // seconds after a right strum before the next can count
// A chord not played for a while is taken to have slowed down, by up to
// MAX_SLOWDOWN of its time; about two-thirds of that after FORGET_DAYS.
const FORGET_DAYS = 14;
const MAX_SLOWDOWN = 0.5;
const DAY_MS = 86400000;
const END = '_'; // phrase boundary in the chain

// Counts by context length: tables[k] maps the last k chords ('a b', with END
// for the phrase start) to { next: count }; tables[3] is the chain as built,
// the shorter ones its sums, for backing off.
let tables = null;

export function setChordChain({ chain }) {
  tables = [new Map(), new Map(), new Map(), new Map()];
  for (const [context, next] of Object.entries(chain)) {
    const words = context.split(' ');
    for (let k = 0; k <= 3; k++) {
      const key = words.slice(3 - k).join(' ');
      let row = tables[k].get(key);
      if (!row) tables[k].set(key, (row = {}));
      for (const [chord, n] of Object.entries(next)) row[chord] = (row[chord] ?? 0) + n;
    }
  }
}

const median = (xs) => {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const cpm = (seconds) => 60 / seconds;
const localDay = (ms = Date.now()) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Progress as saved: see `Deck.data`.
export function emptyProgress() {
  return {
    version: 2,
    revision: 0, // raised on every save; the server keeps the highest
    savedAt: null,
    target: 2, // seconds per change
    unlocked: [],
    chords: {}, // name -> { samples: [{ lesson, time, hits, misses }], filtered, best }
    pairs: {}, // 'C>Am' -> recent change times
    lessons: [], // { at, cpm, accuracy, score, chords, seconds }
    daily: {}, // 'YYYY-MM-DD' -> seconds practised
    // startChords: chords unlocked from the start, at least MIN_CHORDS (keybr's alphabet size). goalMinutes: 0 turns the daily goal off.
    settings: { showShapes: false, favourSlow: false, goalMinutes: 15, startChords: MIN_CHORDS },
  };
}

// Progress from the first flashcard format (`uke.flashcards.v1`): its chords
// stay unlocked and their change times become lesson samples.
export function migrateV1(v1) {
  const data = emptyProgress();
  data.revision = 1;
  data.target = v1.target ?? 2;
  data.unlocked = [...(v1.introduced ?? [])];
  data.pairs = { ...(v1.pairs ?? {}) };
  for (const name of data.unlocked) {
    const chord = { samples: [], filtered: null, best: null };
    for (const time of v1.chords?.[name]?.times ?? []) addSample(chord, { lesson: null, time, hits: 1, misses: 0 });
    data.chords[name] = chord;
  }
  return data;
}

// How far a chord has gone stale since it was last played: 0 when just
// played, approaching 1 after a long break.
function staleness(chord, now) {
  const at = chord.samples.findLast((s) => s.at != null)?.at;
  return at != null ? 1 -Math.exp(-Math.max(0, now - at) / (FORGET_DAYS * DAY_MS)) : 0;
}

// The chord's change time now: the smoothed time, longer the more stale.
export function currentTime(chord, now = Date.now()) {
  return chord?.filtered == null ? null : chord.filtered * (1 + MAX_SLOWDOWN * staleness(chord, now));
}

// After a break the stale estimate is trusted less, so the new sample weighs
// more (at least ALPHA).
function addSample(chord, sample, now = null) {
  const s = now === null ? 0 : staleness(chord, now);
  const alpha = Math.max(ALPHA, s);
  const base = now === null ? chord.filtered : currentTime(chord, now);
  chord.filtered = base === null ? sample.time : alpha * sample.time + (1 - alpha) * base;
  chord.best = Math.min(chord.best ?? Infinity, chord.filtered);
  chord.samples = [...chord.samples, { ...sample, at: now, filtered: chord.filtered }].slice(-KEEP_SAMPLES);
}

export class Deck {
  constructor(data = null, { random = Math.random, now = Date.now } = {}) {
    this.data = data ?? emptyProgress();
    this.random = random;
    this.now = now;
  }

  confidence(time) {
    return time === null || time === undefined ? null : this.data.target / time;
  }

  // Every curriculum chord: { name, included, focused, confidence, bestConfidence, chord }.
  // Unlocks chords as earned.
  keys() {
    const d = this.data;
    const keys = CURRICULUM.map((name) => {
      const chord = d.chords[name] ?? null;
      const time = currentTime(chord, this.now());
      return { name, chord, time, confidence: this.confidence(time), bestConfidence: this.confidence(chord?.best), included: d.unlocked.includes(name), focused: false };
    });
    const minChords = Math.max(MIN_CHORDS, d.settings?.startChords ?? 0);
    for (const key of keys) {
      if (key.included) continue;
      const included = keys.filter((k) => k.included);
      if (included.length < minChords || (key.bestConfidence ?? 0) >= 1 || included.every((k) => (k.bestConfidence ?? 0) >= 1)) {
        key.included = true;
        d.unlocked.push(key.name);
      }
    }
    const weakest = keys
      .filter((k) => k.included && (k.confidence ?? 0) < 1)
      .sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))[0];
    if (weakest) weakest.focused = true;
    return keys;
  }

  // With *Favour slow changes*, a change slower than the target comes up to
  // 3 times as often.
  slowBoost(a, b) {
    if (!this.data.settings.favourSlow) return 1;
    const slow = median(this.data.pairs[`${a}>${b}`]);
    return slow ? Math.min(3, Math.max(1, slow / this.data.target)) : 1;
  }

  // [chord, weight] pairs that can follow `phrase` (the chords so far): the
  // counts of the longest context with an unlocked continuation, never the
  // chord just played. END is allowed once the phrase is MIN_PHRASE long and
  // grows likelier with its length, as keybr's word ends.
  continuations(phrase, allowed) {
    const padded = [END, END, END, ...phrase];
    const prev = phrase.at(-1);
    for (let k = 3; k >= 0 && tables; k--) {
      const row = tables[k].get(padded.slice(padded.length - k).join(' '));
      if (!row) continue;
      const out = [];
      for (const [chord, n] of Object.entries(row)) {
        if (chord === END) {
          if (phrase.length >= MIN_PHRASE) out.push([chord, n * 1.3 ** phrase.length]);
        } else if (allowed.has(chord) && chord !== prev) out.push([chord, n * this.slowBoost(prev, chord)]);
      }
      if (out.length) return out;
    }
    // Without the table: any unlocked chord.
    const any = [...allowed].filter((c) => c !== prev).map((c) => [c, 1]);
    return phrase.length >= MIN_PHRASE ? [...any, [END, any.length / 2]] : any;
  }

  pickWeighted(entries) {
    let r = this.random() * entries.reduce((a, [, w]) => a + w, 0);
    for (const [item, w] of entries) if ((r -= w) < 0) return item;
    return entries.at(-1)[0];
  }

  phrase(allowed, start = []) {
    const p = [...start];
    while (p.length < MAX_PHRASE) {
      const next = this.pickWeighted(this.continuations(p, allowed));
      if (next === END) break;
      p.push(next);
    }
    return p;
  }

  // A lesson: phrases of the unlocked chords, LESSON_CHORDS or a few more.
  // Phrases are drawn as songs make them until one holds the focused chord;
  // failing that, one starts from it (as keybr starts a word from a prefix
  // holding the focused letter). A phrase never starts on the chord the last
  // one ended on.
  lesson() {
    const keys = this.keys();
    const allowed = new Set(keys.filter((k) => k.included).map((k) => k.name));
    const focus = keys.find((k) => k.focused)?.name ?? null;
    const phrases = [];
    let count = 0;
    while (count < LESSON_CHORDS) {
      const last = phrases.at(-1)?.at(-1);
      let p = null;
      for (let i = 0; i < 100 && !p; i++) {
        const q = this.phrase(allowed);
        if (q[0] !== last && (!focus || q.includes(focus))) p = q;
      }
      if (!p) {
        p = this.phrase(allowed, focus ? [focus] : []);
        if (p[0] === last) p = p.slice(1);
      }
      if (!p.length) continue;
      phrases.push(p);
      count += p.length;
    }
    return { progressions: phrases, focus };
  }

  // Records a finished lesson. `steps`: one per chord played, { name, time
  // (seconds from the previous right strum, null for the first), miss }.
  // Returns the lesson's { cpm, accuracy, score } and the chords it unlocked.
  record(steps, seconds) {
    const d = this.data;
    const before = new Set(d.unlocked);
    const lessonIndex = d.lessons.length;
    const byChord = new Map();
    for (const [i, s] of steps.entries()) {
      const c = byChord.get(s.name) ?? { hits: 0, misses: 0, times: [] };
      c.hits++;
      if (s.miss) c.misses++;
      else if (s.time !== null) {
        c.times.push(s.time);
        const from = steps[i - 1]?.name;
        if (from) d.pairs[`${from}>${s.name}`] = [...(d.pairs[`${from}>${s.name}`] ?? []), s.time].slice(-KEEP_PAIR);
      }
      byChord.set(s.name, c);
    }
    for (const [name, c] of byChord) {
      d.chords[name] ??= { samples: [], filtered: null, best: null };
      if (c.times.length) addSample(d.chords[name], { lesson: lessonIndex, time: c.times.reduce((a, b) => a + b, 0) / c.times.length, hits: c.hits, misses: c.misses }, this.now());
    }
    const timed = steps.filter((s) => s.time !== null);
    const total = timed.reduce((a, s) => a + s.time, 0);
    const misses = steps.filter((s) => s.miss).length;
    const speed = total > 0 ? cpm(total / timed.length) : 0;
    const result = {
      at: this.now(),
      cpm: speed,
      accuracy: steps.length ? (steps.length - misses) / steps.length : 0,
      score: Math.round(((speed * byChord.size) / (misses + 1)) * (steps.length / LESSON_CHORDS)),
      chords: byChord.size,
      seconds,
    };
    d.lessons.push(result);
    const day = localDay(this.now());
    d.daily[day] = (d.daily[day] ?? 0) + seconds;
    const unlocked = this.keys().filter((k) => k.included && !before.has(k.name)).map((k) => k.name);
    return { ...result, unlocked };
  }

  // Lesson metrics with the difference from the average of earlier lessons.
  metrics() {
    const ls = this.data.lessons;
    const last = ls.at(-1);
    if (!last) return null;
    const avg = (f) => (ls.length > 1 ? ls.slice(0, -1).reduce((a, l) => a + f(l), 0) / (ls.length - 1) : f(last));
    return {
      cpm: last.cpm, cpmDelta: last.cpm - avg((l) => l.cpm),
      accuracy: last.accuracy, accuracyDelta: last.accuracy - avg((l) => l.accuracy),
      score: last.score, scoreDelta: last.score - avg((l) => l.score),
    };
  }

  // Lessons in a row at full accuracy, now and at best.
  streak() {
    let run = 0;
    let best = 0;
    for (const l of this.data.lessons) {
      run = l.accuracy >= 1 ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return { run, best };
  }

  // Change speed per lesson of `name`, in changes per minute per lesson, with
  // the lessons left to the target, from a line fitted to its last 10 samples;
  // null while the fit explains less than half the variation.
  learningRate(name) {
    const samples = (this.data.chords[name]?.samples ?? []).slice(-10);
    if (samples.length < 3) return null;
    const xs = samples.map((_, i) => i);
    const ys = samples.map((s) => cpm(s.filtered));
    const mx = xs.reduce((a, b) => a + b) / xs.length;
    const my = ys.reduce((a, b) => a + b) / ys.length;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
    if (syy === 0) return null;
    const slope = sxy / sxx;
    if ((sxy * sxy) / (sxx * syy) < 0.5) return null;
    const gap = cpm(this.data.target) - ys.at(-1);
    return { slope, remaining: slope > 0 && gap > 0 ? Math.ceil(gap / slope) : null };
  }

  slowChanges(n = 5) {
    return Object.entries(this.data.pairs)
      .map(([key, times]) => ({ key, median: median(times) }))
      .filter((p) => p.median > this.data.target)
      .sort((a, b) => b.median - a.median)
      .slice(0, n);
  }

  practisedToday() {
    return this.data.daily[localDay(this.now())] ?? 0;
  }
}

export class CardMode {
  // `store`: { load(), save(data, { replace }) }, where the progress is kept.
  constructor({ els, clock, ensureAudio, setStatus, store }) {
    Object.assign(this, { els, clock, ensureAudio, setStatus, store });
    this.deck = new Deck();
    const chain = fetch('data/chord-chain.json')
      .then((res) => res.json())
      .then(setChordChain)
      .catch(() => setStatus('Flashcards: no chord table; progressions are random.'));
    this.ready = Promise.all([store.load(), chain]).then(([data]) => this.load(data));
    this.run = null; // { lesson, chords, index, steps, since, start, revealed, missed, pending }
    // The diagram scales with the window.
    new ResizeObserver(() => this.showShape()).observe(els.diagram);
    els.board.addEventListener('click', () => (this.run ? null : this.start()));
    els.board.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.run) this.reveal();
        else this.start();
      } else if (e.code === 'Escape') this.stop();
    });
    els.listen.addEventListener('change', () => (els.listen.checked ? this.start() : this.stop()));
    els.target.addEventListener('change', () => {
      this.deck.data.target = Number(els.target.value);
      this.save();
      this.showIndicators();
    });
    els.shapes.addEventListener('change', () => {
      this.deck.data.settings.showShapes = els.shapes.checked;
      this.save();
      this.showShape();
    });
    els.favourSlow.addEventListener('change', () => {
      this.deck.data.settings.favourSlow = els.favourSlow.checked;
      this.save();
      if (!this.run) this.newLesson();
    });
    // Lowering it keeps the chords already unlocked.
    els.startChords.addEventListener('change', () => {
      this.deck.data.settings.startChords = Number(els.startChords.value);
      this.save();
      if (!this.run) this.newLesson();
    });
    els.goalMinutes.addEventListener('change', () => {
      this.deck.data.settings.goalMinutes = Number(els.goalMinutes.value);
      this.save();
      this.showIndicators();
    });
    els.reset.addEventListener('click', () => {
      if (!confirm('Start the flashcards over? The current progress is kept as a backup.')) return;
      this.stop();
      const settings = this.deck.data.settings;
      const target = this.deck.data.target;
      this.deck = new Deck({ ...emptyProgress(), revision: this.deck.data.revision + 1, target, settings });
      this.save({ replace: true });
      this.newLesson();
    });
  }

  // Replaces the progress shown, as when a newer copy arrives from elsewhere.
  // A lesson in progress is ended unrecorded.
  load(data) {
    if (data) this.deck = new Deck(data);
    this.stop();
    this.applySettings();
    this.newLesson();
  }

  applySettings() {
    this.els.target.value = String(this.deck.data.target);
    this.els.shapes.checked = this.deck.data.settings.showShapes;
    this.els.favourSlow.checked = !!this.deck.data.settings.favourSlow;
    this.els.startChords.value = String(Math.max(MIN_CHORDS, this.deck.data.settings.startChords ?? 0));
    this.els.goalMinutes.value = String(this.deck.data.settings.goalMinutes ?? 15);
  }

  save(options) {
    const d = this.deck.data;
    d.revision++;
    d.savedAt = new Date().toISOString();
    this.store.save(d, options).catch((err) => this.setStatus(`Flashcards: ${err.message}`));
  }

  newLesson() {
    const lesson = this.deck.lesson();
    this.lesson = { ...lesson, chords: lesson.progressions.flat() };
    this.showIndicators();
    this.showText();
    this.showShape();
  }

  async start() {
    if (this.run) return;
    await this.ready;
    const audio = await this.ensureAudio();
    this.els.listen.checked = !!audio;
    if (!audio) return;
    // Flashcards name chords as they sound, so no capo is set.
    audio.node.port.postMessage({ type: 'configure', capo: 0 });
    this.run = { index: 0, steps: [], since: this.clock() || null, start: null, lastAttack: null };
    this.beginChord();
    this.els.board.classList.add('active');
    this.els.board.focus();
    this.showText();
  }

  // Ends the lesson in progress, unrecorded.
  stop() {
    this.els.listen.checked = false;
    if (!this.run) return;
    this.run = null;
    this.els.board.classList.remove('active');
    this.newLesson();
  }

  get current() {
    return this.lesson.chords[this.run.index];
  }

  beginChord() {
    const r = this.run;
    const name = this.current;
    // A chord never played before is shown from the start.
    const fresh = !this.deck.data.chords[name]?.samples.length && !r.steps.some((s) => s.name === name);
    Object.assign(r, { revealed: fresh, missed: false, pending: null, shownAt: this.clock() || null });
    this.els.hint.textContent = fresh ? `New chord: ${name}` : '';
    this.showShape();
  }

  // Shows the shape; the chord then counts as missed.
  reveal() {
    const r = this.run;
    if (!r || r.revealed) return;
    r.revealed = true;
    r.missed = true;
    this.showText();
    this.showShape();
  }

  heardRight(name, heard) {
    return compareChord(name, heard) === 'right' || (chosenMask(name) !== null && parseChord(heard)?.mask === chosenMask(name));
  }

  onFrame(f) {
    const r = this.run;
    if (!r) return;
    r.since ??= f.t;
    r.shownAt ??= f.t;
    const strum = f.strum ?? f.strumUpdate;
    if (strum?.chord && strum.t >= r.since) {
      if (this.heardRight(this.current, strum.chord)) return this.hit(strum);
      // The chord just played, heard again (a second attack while it rings,
      // or a strum before the hand moves), is not a wrong chord.
      const previous = r.previous && this.heardRight(r.previous, strum.chord);
      // A strum read wrong may still settle on the chord once late fingers land.
      if (f.strum && !previous) r.pending = { t: strum.t, chord: strum.chord };
      else if (f.strumUpdate && r.pending?.t === strum.t) r.pending = previous ? null : { ...r.pending, chord: strum.chord };
    }
    if (r.pending && f.t > r.pending.t + UPDATE_WAIT) {
      this.els.hint.textContent = `Heard ${r.pending.chord}`;
      r.pending = null;
      this.reveal();
    }
  }

  hit(strum) {
    const r = this.run;
    const name = this.current;
    const time = r.lastAttack === null ? null : strum.t - r.lastAttack;
    r.steps.push({ name, time, miss: r.missed });
    r.start ??= strum.t;
    r.lastAttack = strum.t;
    r.previous = name;
    // Strums from here on belong to the next chord; the analyzer can report a
    // ringing chord's second attack up to ~0.2 s after the first.
    r.since = strum.t + MIN_CHANGE;
    r.index++;
    if (r.index < this.lesson.chords.length) {
      this.beginChord();
      this.showText();
      return;
    }
    const result = this.deck.record(r.steps, strum.t - r.start);
    this.save();
    this.lesson = null;
    this.newLesson();
    this.run = { index: 0, steps: [], since: r.since, start: null, lastAttack: null, previous: name };
    this.beginChord();
    this.showText();
    this.els.hint.textContent = result.unlocked.length ? `New chord: ${result.unlocked.join(', ')}` : this.els.hint.textContent;
  }

  render() {
    const r = this.run;
    if (!r || r.shownAt === null) return;
    if (!r.revealed && this.clock() - r.shownAt > REVEAL_AFTER) this.reveal();
  }

  // ---- Display, after keybr's practice page ---------------------------------

  showText() {
    const r = this.run;
    const spans = [];
    let i = 0;
    this.lesson.progressions.forEach((p, pi) => {
      if (pi) spans.push(Object.assign(document.createElement('span'), { className: 'kbSep', textContent: '·' }));
      p.forEach((name, ci) => {
        const span = document.createElement('span');
        span.textContent = name;
        const step = r?.steps[i];
        span.className = step ? (step.miss ? 'kbMiss' : 'kbHit') : r && i === r.index ? `kbCursor${r.missed ? ' kbMiss' : ''}` : '';
        spans.push(span);
        if (ci < p.length - 1) spans.push(document.createTextNode(' '));
        i++;
      });
    });
    this.els.text.replaceChildren(...spans);
    this.els.overlay.hidden = !!r;
  }

  showShape() {
    const r = this.run;
    const name = r ? this.current : null;
    const show = name && (r.revealed || this.deck.data.settings.showShapes);
    drawDiagram(this.els.diagram, show ? name : '', show ? shapeFor(name) : null);
    this.els.diagram.classList.toggle('kbHidden', !show);
  }

  keyTile(key, size = '') {
    const tile = document.createElement('span');
    tile.className = `kbKey ${size} ${key.included ? (key.confidence === null ? 'uncalibrated' : 'included') : 'excluded'}${key.focused ? ' focused' : ''}`;
    tile.textContent = key.name;
    if (key.included && key.confidence !== null) {
      // keybr's dark-theme slow (#8c1818) to fast (#448154) key colour.
      const c = Math.min(1, key.confidence);
      const mix = (a, b) => Math.round(a + (b - a) * c);
      tile.style.backgroundColor = `rgb(${mix(0x8c, 0x44)}, ${mix(0x18, 0x81)}, ${mix(0x18, 0x54)})`;
    }
    tile.title = !key.included ? 'Locked' : key.confidence === null ? 'Not calibrated' : `${cpm(key.time).toFixed(1)} cpm, best ${cpm(key.chord.best).toFixed(1)} cpm`;
    return tile;
  }

  showIndicators() {
    const deck = this.deck;
    const els = this.els;
    const value = (text, delta, unit = '', digits = 1) => {
      const v = document.createElement('span');
      v.className = 'kbNum';
      v.textContent = text;
      const d = document.createElement('span');
      d.className = `kbNum ${delta > 0 ? 'more' : delta < 0 ? 'less' : ''}`;
      d.textContent = ` (${delta > 0 ? '+' : ''}${delta.toFixed(digits)}${unit})`;
      return [v, d];
    };
    const label = (text) => Object.assign(document.createElement('span'), { className: 'kbLabel', textContent: text });
    const m = deck.metrics();
    els.metrics.replaceChildren(...(m
      ? [label('Speed: '), ...value(`${m.cpm.toFixed(1)}cpm`, m.cpmDelta, 'cpm'), label(' Accuracy: '), ...value(`${Math.round(m.accuracy * 100)}%`, m.accuracyDelta * 100, '%', 0), label(' Score: '), ...value(String(m.score), m.scoreDelta, '', 0)]
      : [label('Speed: '), ...value('0.0cpm', 0, 'cpm'), label(' Accuracy: '), ...value('0%', 0, '%', 0), label(' Score: '), ...value('0', 0, '', 0)]));

    const keys = deck.keys();
    els.keys.replaceChildren(...keys.map((k) => this.keyTile(k)));

    const focus = keys.find((k) => k.focused);
    if (!focus) els.current.replaceChildren(label('Every chord is at the target speed.'));
    else if (focus.confidence === null) els.current.replaceChildren(this.keyTile(focus), label(' Not calibrated, need more samples.'));
    else {
      const rate = deck.learningRate(focus.name);
      const c = focus.chord;
      els.current.replaceChildren(
        this.keyTile(focus),
        label(' Last speed: '), Object.assign(document.createElement('span'), { className: 'kbNum', textContent: `${cpm(focus.time).toFixed(1)}cpm${focus.time > c.filtered * 1.01 ? ' (rusty)' : ''}` }),
        label(' Top speed: '), Object.assign(document.createElement('span'), { className: 'kbNum', textContent: `${cpm(c.best).toFixed(1)}cpm` }),
        label(' Learning rate: '), Object.assign(document.createElement('span'), {
          className: 'kbNum',
          textContent: rate ? `${rate.slope >= 0 ? '+' : ''}${rate.slope.toFixed(1)}cpm/lesson${rate.remaining ? `, about ${rate.remaining} lessons to go` : ''}` : 'not enough lessons yet',
        }),
      );
    }

    const slow = deck.slowChanges();
    els.slow.replaceChildren(label(slow.length ? '' : 'None slower than the target.'), ...slow.map((p) => {
      const [from, to] = p.key.split('>');
      return Object.assign(document.createElement('span'), { className: 'kbNum kbPair', textContent: `${from}→${to} ${cpm(p.median).toFixed(1)}cpm` });
    }));

    const { run, best } = deck.streak();
    els.streak.replaceChildren(label(best ? `${run} lessons in a row at 100% (best ${best}).` : 'No accuracy streaks.'));

    const goal = deck.data.settings.goalMinutes ?? 15;
    const done = deck.practisedToday() / 60;
    if (!goal) {
      els.goal.replaceChildren(label(`Off · ${Math.round(done)} minutes today.`));
      return;
    }
    const bar = document.createElement('span');
    bar.className = 'kbGoal';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, (done / goal) * 100)}%`;
    bar.append(fill);
    els.goal.replaceChildren(Object.assign(document.createElement('span'), { className: 'kbNum', textContent: `${Math.round(Math.min(1, done / goal) * 100)}%/${goal} minutes ` }), bar);
  }
}

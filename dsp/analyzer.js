// Frame-synchronous analysis: feed raw audio blocks, get one result per hop.
// Pure JS with no allocation in the per-sample path, so it runs both inside the
// AudioWorklet and offline under Node for tests.
import { PitchEstimator } from './pitch.js';
import { NoteDecomposer } from './decompose.js';
import { OnsetDetector } from './onset.js';
import { recognizeChord } from './chords.js';
import { NoiseFloor } from './noise.js';
import { UKE_TUNING } from './notes.js';

const pow2 = (x) => 2 ** Math.round(Math.log2(x));

// Note tracking hysteresis, in hops: score +1 per detection (capped), -1 per
// miss; a note turns on at NOTE_ON and off at zero.
const NOTE_ON = 2;
const NOTE_SCORE_CAP = 5;
// A new chord label must win this many consecutive hops before it is shown.
const CHORD_HOLD = 3;
// A strum is reported once its chord is stable, or after this long regardless.
const STRUM_TIMEOUT = 0.3;
// Fingers often land after the pick: after a strum is reported, a different
// chord that then holds for SETTLE_HOLD hops within STRUM_SETTLE seconds of
// the attack replaces it (a `strumUpdate` for the same strum).
const STRUM_SETTLE = 0.4;
const SETTLE_HOLD = 10;
// Levels above the room's noise floor needed for notes and for attacks.
const NOTE_MARGIN_DB = 10;
const ONSET_MARGIN_DB = 30;
// The noise floor learns only from frames this long after the last attack.
const NOISE_AFTER_ONSET = 3;
// Notes are reported only this long after an accepted attack, so handling
// noise and strings ringing in sympathy between songs show nothing.
const NOTE_AFTER_ONSET = 4;
// Notes weaker than this (relative to the strongest) are shown but do not
// count towards the chord name.
const CHORD_MIN_STRENGTH = 0.15;
// A ringing string's 3rd and 5th partials (an octave and a fifth, two octaves
// and a third above it) can outgrow its template and read as notes of their
// own, which add a pitch class (open C ringing in F reads as Csus4). A note at
// one of these intervals above a note at least this many times stronger counts
// as its partial and is left out of the chord name.
const PARTIAL_INTERVALS = [19, 28];
const PARTIAL_RATIO = 1.5;
// Calibration learns from this many seconds after each attack.
const CALIBRATION_SPAN = 0.4;

export class Analyzer {
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.hop = pow2(sampleRate * 0.0053); // 256 at 44.1/48 kHz
    this.pitchSize = pow2(sampleRate * 0.085); // 4096 at 44.1/48 kHz
    this.onsetSize = this.pitchSize / 4;
    // Minimum level for anything to be detected; the noise floor can raise it.
    this.gateDb = opts.gateDb ?? -55;
    // A strum's chord is read this long after the attack. Fingers landing a
    // moment after the pick leave open-string pitches ringing for up to
    // ~150 ms on a real instrument (recordings/2026-10-18_20-27-43).
    this.strumDelay = opts.strumDelay ?? 0.15;
    this.noise = new NoiseFloor(sampleRate / this.hop);
    this.framesSeen = 0;

    this.decomposer = new NoteDecomposer(sampleRate, this.pitchSize, opts);
    // Labels single notes while calibrating; see pitch.js.
    this.labeller = new PitchEstimator(sampleRate, this.pitchSize, {
      minMidi: this.decomposer.minMidi,
      maxMidi: this.decomposer.maxMidi,
    });
    this.calibrating = false;
    this.onset = new OnsetDetector(sampleRate, this.onsetSize, this.hop, opts);
    // Delay from an attack to the end of the hop that detects it, measured on
    // synthetic plucks (test/analyzer.test.js).
    this.onsetLatency = opts.onsetLatency ?? (this.onsetSize * 0.6 + this.hop) / sampleRate;

    this.ring = new Float32Array(this.pitchSize);
    this.frame = new Float32Array(this.pitchSize);
    this.writePos = 0;
    this.sinceHop = 0;
    this.clock = -1; // absolute index of the next sample
    this.results = [];

    this.noteScore = new Int8Array(128);
    this.noteOn = new Uint8Array(128);
    this.noteStrength = new Float64Array(128);
    this.noteCents = new Int16Array(128);
    this.minPitchSize = this.pitchSize / 2;
    this.strumPitchSize = (this.pitchSize * 3) / 4;
    this.onsetClock = -Infinity;
    this.freshOnset = false;
    this.chord = null;
    this.chordLive = false;
    this.pendingChord = null;
    this.pendingCount = 0;
    this.strum = null; // { t, name, count } awaiting a stable chord
    this.settle = null; // { t, chord, name, count } a reported strum still settling
    // The chord reading since the last attack, when it took over, and the
    // open-string pitch classes heard after the attack before it took over.
    // A finger landing after the pick lets its open string sound first.
    this.runName = null;
    this.runMask = 0;
    this.runSince = 0;
    this.runOpen = 0;
    this.strumOpen = 0;
    this.openStrings = UKE_TUNING; // pitches of the unfretted strings, capo included
  }

  configure({ gateDb, capo }) {
    if (gateDb !== undefined) this.gateDb = gateDb;
    if (capo !== undefined) this.openStrings = UKE_TUNING.map((m) => m + capo);
  }

  // Calibration: while on, every frame holding exactly one clear note adds its
  // spectrum to that note's template. Play single notes, letting each ring.
  startCalibration() {
    this.decomposer.startCalibration();
    this.calibrating = true;
  }

  // Returns the learned templates (see NoteDecomposer.exportTemplates).
  stopCalibration() {
    this.calibrating = false;
    return this.decomposer.finishCalibration();
  }

  calibrate(frame) {
    const found = this.labeller.analyze(frame);
    if (found.length === 1) this.decomposer.accumulate(found[0].midi, frame);
  }

  // `startFrame`: absolute sample index of block[0] (AudioWorklet `currentFrame`).
  // Returns the results produced by this block; the array is reused across calls.
  push(block, startFrame) {
    if (startFrame !== undefined) this.clock = startFrame;
    else if (this.clock < 0) this.clock = 0;
    const out = this.results;
    out.length = 0;
    const { ring, hop } = this;
    const n = ring.length;
    for (let i = 0; i < block.length; i++) {
      ring[this.writePos] = block[i];
      if (++this.writePos === n) this.writePos = 0;
      this.clock++;
      if (++this.sinceHop === hop) {
        this.sinceHop = 0;
        out.push(this.processFrame());
      }
    }
    return out;
  }

  processFrame() {
    const { ring, frame, writePos, sampleRate, pitchSize, onsetSize } = this;
    frame.set(ring.subarray(writePos), 0);
    frame.set(ring.subarray(0, writePos), pitchSize - writePos);
    const onsetFrame = frame.subarray(pitchSize - onsetSize);
    const t = this.clock / sampleRate;
    const levelDb = rmsDb(onsetFrame);
    // The first frames still hold the buffer's initial zeros.
    const quiet = (this.clock - this.onsetClock) / sampleRate > NOISE_AFTER_ONSET;
    if (++this.framesSeen > pitchSize / this.hop && quiet) this.noise.update(levelDb);
    const noiseDb = this.noise.db;
    const noteGate = Math.max(this.gateDb, noiseDb + NOTE_MARGIN_DB);
    const onsetGate = Math.max(this.gateDb, noiseDb + ONSET_MARGIN_DB);
    const previousChord = this.chord?.name ?? null;

    let onset = null;
    let strum = null;
    if (this.onset.process(onsetFrame) && levelDb > onsetGate) {
      onset = t - this.onsetLatency;
      this.onsetClock = Math.round(onset * sampleRate);
      this.freshOnset = true;
      if (this.strum) strum = this.finishStrum();
      this.strum = { t: onset, name: null, count: 0 };
      this.settle = null;
      this.runName = null;
      this.strumOpen = 0;
    }

    // After an onset only audio from the attack onwards is analysed, so the
    // previous chord and the attack transient cannot leak into the new one.
    // Until enough of it has arrived the frame is `pending` and has no notes.
    // Whole hops, so only a handful of window lengths (and cached windows) exist.
    const length = Math.min(pitchSize, Math.floor((this.clock - this.onsetClock) / this.hop) * this.hop);
    const pending = length < this.minPitchSize;
    const pitchT = t - length / 2 / sampleRate;
    let notes = [];
    let strumUpdate = null;
    if (!pending) {
      const playing = (this.clock - this.onsetClock) / sampleRate < NOTE_AFTER_ONSET;
      const loud = playing && rmsDb(frame.subarray(pitchSize - length)) > noteGate;
      const detected = loud ? this.decomposer.analyze(frame, length, this.freshOnset) : [];
      // Calibrate on the bright early part of each note, which is what strums are judged on.
      const sinceOnset = (this.clock - this.onsetClock) / sampleRate;
      if (this.calibrating && loud && length === pitchSize && sinceOnset < CALIBRATION_SPAN) this.calibrate(frame);
      notes = this.trackNotes(detected, this.freshOnset);
      this.freshOnset = false;
      const cand = notes.length ? recognizeChord(this.chordWeights(notes)) : null;
      this.lastCand = cand;
      const name = cand?.name ?? null;
      if (name !== this.runName) {
        this.runName = name;
        this.runMask = cand?.mask ?? 0;
        this.runSince = t;
        this.runOpen = this.strumOpen;
      }
      for (const n of notes) if (n.strength >= CHORD_MIN_STRENGTH && this.openStrings.includes(n.midi)) this.strumOpen |= 1 << n.midi % 12;
      // While a strum settles the label keeps the previous chord; the strum
      // sets it when it resolves.
      if (!this.strum) this.updateChord(cand);
      // A strum takes 10-40 ms to cross all strings, so its chord is read
      // from windows long enough to contain the last string.
      else if (!strum) strum = this.advanceStrum(length >= this.strumPitchSize ? cand : null, t);
      if (this.settle && !this.strum && !strum) strumUpdate = this.advanceSettle(cand, t);
      this.chordLive = cand !== null && this.chord !== null && cand.name === this.chord.name;
    }

    return {
      t,
      pitchT,
      levelDb,
      noiseDb,
      onset,
      pending,
      notes,
      chord: this.chord && { name: this.chord.name, alternatives: this.chord.alternatives },
      chordLive: this.chordLive,
      chordChanged: (this.chord?.name ?? null) !== previousChord,
      strum,
      strumUpdate,
    };
  }

  // `restart`: the frame is the first one after an onset; its notes replace
  // the tracked ones immediately instead of going through the hysteresis.
  trackNotes(detected, restart) {
    const { noteScore, noteOn, noteStrength, noteCents } = this;
    if (restart) {
      noteScore.fill(0);
      noteOn.fill(0);
      for (const n of detected) noteScore[n.midi] = NOTE_ON - 1;
    }
    const first = detected.length ? detected[0].salience : 1;
    const seen = new Uint8Array(128);
    for (const n of detected) {
      seen[n.midi] = 1;
      noteStrength[n.midi] = n.salience / first;
      noteCents[n.midi] = n.cents;
    }
    const notes = [];
    for (let m = this.decomposer.minMidi; m <= this.decomposer.maxMidi; m++) {
      if (seen[m]) noteScore[m] = Math.min(NOTE_SCORE_CAP, Math.max(noteScore[m], 0) + 1);
      else {
        noteScore[m] = Math.max(0, noteScore[m] - 1);
        noteStrength[m] *= 0.8;
      }
      if (noteScore[m] >= NOTE_ON) noteOn[m] = 1;
      else if (noteScore[m] === 0) noteOn[m] = 0;
      if (noteOn[m]) {
        notes.push({ midi: m, cents: noteCents[m], strength: noteStrength[m] });
      }
    }
    return notes;
  }

  // Pitch-class weights for naming the chord, leaving out faint notes.
  chordWeights(notes) {
    const w = new Array(12).fill(0);
    for (const n of notes) {
      if (n.strength < CHORD_MIN_STRENGTH) continue;
      if (notes.some((p) => PARTIAL_INTERVALS.includes(n.midi - p.midi) && p.strength >= PARTIAL_RATIO * n.strength)) continue;
      w[n.midi % 12] += Math.sqrt(n.strength);
    }
    return w;
  }

  updateChord(cand) {
    if (!cand) return;
    if (this.chord && cand.name === this.chord.name) {
      this.chord = cand;
      this.pendingChord = null;
      return;
    }
    if (this.pendingChord && this.pendingChord.name === cand.name) this.pendingCount++;
    else {
      this.pendingChord = cand;
      this.pendingCount = 1;
    }
    if (this.pendingCount < CHORD_HOLD) return;
    this.chord = cand;
    this.pendingChord = null;
  }

  advanceStrum(cand, t) {
    const s = this.strum;
    if (cand) {
      if (cand.name === s.name) s.count++;
      else {
        s.name = cand.name;
        s.count = 1;
      }
      if (s.count >= CHORD_HOLD && t - s.t >= this.strumDelay) return this.finishStrum();
    }
    if (t - s.t > STRUM_TIMEOUT) return this.finishStrum();
    return null;
  }

  // Watches a reported strum for the chord the fingers settle into.
  advanceSettle(cand, t) {
    const s = this.settle;
    if (t - s.t > STRUM_SETTLE) {
      this.settle = null;
      return null;
    }
    // Notes fading out leave partial chords (Am decaying to C+E); only a
    // complete chord counts as the fingers settling.
    if (!cand || cand.name === s.chord || !cand.complete) {
      s.count = 0;
      return null;
    }
    if (cand.name === s.name) s.count++;
    else {
      s.name = cand.name;
      s.count = 1;
    }
    if (s.count < SETTLE_HOLD) return null;
    s.chord = cand.name;
    s.count = 0;
    return { t: s.t, chord: cand.name, mask: cand.mask, fingers: this.fingers(s.t) };
  }

  // How long after the pick the fingers formed the strum's chord, in seconds:
  // the time from the first readable frame to when the current reading took
  // over, counted only when an open string outside the chord sounded before
  // it. Otherwise 0, since a reading that settles late for other reasons
  // (a quiet string, the attack transient) says nothing about the fingers.
  fingers(attack) {
    if (!(this.runOpen & ~this.runMask)) return 0;
    return Math.max(0, this.runSince - attack - (this.minPitchSize + this.hop) / this.sampleRate);
  }

  finishStrum() {
    const s = this.strum;
    this.strum = null;
    this.settle = { t: s.t, chord: s.name, name: null, count: 0 };
    if (s.name) {
      this.chord = this.lastCand?.name === s.name ? this.lastCand : { name: s.name, alternatives: [] };
      this.pendingChord = null;
    }
    const current = s.name && this.runName === s.name;
    // `mask`: the pitch classes of the reported chord (one bit for a single note).
    return { t: s.t, chord: s.name, mask: current ? this.runMask : null, fingers: current ? this.fingers(s.t) : null };
  }
}

function rmsDb(x) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / x.length + 1e-20);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../dsp/analyzer.js';
import { UKE_TUNING } from '../dsp/notes.js';
import { renderStrums, runAnalyzer } from './synth.js';

const SHAPES = {
  C: [0, 0, 0, 3], Am: [2, 0, 0, 0], F: [2, 0, 1, 0], G: [0, 2, 3, 2], G7: [0, 2, 1, 2],
  Dm: [2, 2, 1, 0], Em: [0, 4, 3, 2], E7: [1, 2, 0, 2], A: [2, 1, 0, 0], D: [2, 2, 2, 0],
  Bb: [3, 2, 1, 1], C7: [0, 0, 0, 1], D7: [2, 2, 2, 3], A7: [0, 1, 0, 0], Cmaj7: [0, 0, 0, 2],
  Bm: [4, 2, 2, 2], Fm: [1, 0, 1, 3], Gm: [0, 2, 3, 1], Dm7: [2, 2, 1, 3], Cm: [0, 3, 3, 3],
};

function strumTest(names, interval, sr, seed) {
  const events = names.map((name, i) => ({ t: 0.3 + i * interval, frets: SHAPES[name], name }));
  const signal = renderStrums(events, { sr, seed });
  const frames = runAnalyzer(new Analyzer(sr), signal);
  const strums = frames.filter((f) => f.strum).map((f) => f.strum);
  const errors = [];
  const wrong = [];
  for (const ev of events) {
    const hits = strums.filter((s) => Math.abs(s.t - ev.t) < interval / 2);
    assert.equal(hits.length, 1, `expected one strum near ${ev.t.toFixed(3)} s, got ${hits.length}`);
    errors.push(hits[0].t - ev.t);
    if (hits[0].chord !== ev.name) wrong.push(`${ev.name}→${hits[0].chord}`);
  }
  assert.equal(strums.length, events.length, 'spurious strums');
  return { errors, wrong };
}

for (const sr of [44100, 48000]) {
  test(`every shape strummed at 0.5 s intervals (${sr} Hz)`, () => {
    const { errors, wrong } = strumTest(Object.keys(SHAPES), 0.5, sr, 7);
    assert.deepEqual(wrong, []);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const worst = Math.max(...errors.map(Math.abs));
    assert.ok(Math.abs(mean) < 0.003, `mean onset error ${(mean * 1000).toFixed(1)} ms`);
    assert.ok(worst < 0.012, `worst onset error ${(worst * 1000).toFixed(1)} ms`);
  });
}

test('fast changes at 0.25 s intervals', () => {
  const names = ['C', 'Am', 'F', 'G7', 'C', 'Dm', 'G', 'Em', 'A7', 'D', 'Bb', 'C7'];
  const { wrong } = strumTest(names, 0.25, 48000, 3);
  assert.deepEqual(wrong, []);
});

test('single notes on every string, frets 0-12', () => {
  const sr = 48000;
  const events = [];
  for (let s = 0; s < 4; s++) {
    for (let fret = 0; fret <= 12; fret++) {
      const frets = [-1, -1, -1, -1];
      frets[s] = fret;
      events.push({ t: 0.3 + events.length * 0.4, frets, midi: UKE_TUNING[s] + fret });
    }
  }
  const signal = renderStrums(events, { sr, seed: 11, damp: true });
  const frames = runAnalyzer(new Analyzer(sr), signal);
  const wrong = [];
  for (const ev of events) {
    const f = frames.find((x) => x.pitchT >= ev.t + 0.15);
    const got = f.notes.map((n) => n.midi);
    if (got.length !== 1 || got[0] !== ev.midi) wrong.push(`${ev.midi}→[${got}]`);
  }
  assert.deepEqual(wrong, []);
});

test('silence produces nothing', () => {
  const signal = new Float32Array(48000);
  for (let i = 0; i < signal.length; i++) signal[i] = (Math.random() * 2 - 1) * 1e-4;
  const frames = runAnalyzer(new Analyzer(48000), signal);
  assert.ok(frames.every((f) => f.notes.length === 0 && f.onset === null));
});

test('calibration learns templates that survive a JSON round trip', () => {
  const sr = 48000;
  const rolloff = 1.8; // a darker instrument than the generic templates assume
  const singles = [];
  for (let s = 0; s < 4; s++) {
    for (let fret = 0; fret <= 5; fret++) {
      const frets = [-1, -1, -1, -1];
      frets[s] = fret;
      singles.push({ t: 0.3 + singles.length * 0.5, frets });
    }
  }
  const cal = new Analyzer(sr);
  cal.startCalibration();
  runAnalyzer(cal, renderStrums(singles, { sr, seed: 21, damp: true, rolloff }));
  const templates = JSON.parse(JSON.stringify(cal.stopCalibration()));
  const learned = Object.keys(templates).map(Number).sort((a, b) => a - b);
  const expected = [...new Set(singles.map((e) => UKE_TUNING[e.frets.findIndex((f) => f >= 0)] + Math.max(...e.frets)))];
  assert.deepEqual(learned, expected.sort((a, b) => a - b));

  const names = ['C', 'Am', 'F', 'G7', 'Dm', 'Em', 'A7', 'Bb'];
  const events = names.map((name, i) => ({ t: 0.3 + i * 0.5, frets: SHAPES[name], name }));
  const an = new Analyzer(sr);
  an.decomposer.importTemplates(templates);
  const strums = runAnalyzer(an, renderStrums(events, { sr, seed: 4, rolloff })).filter((f) => f.strum);
  assert.deepEqual(strums.map((f) => f.strum.chord), names);
});

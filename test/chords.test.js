import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeChord } from '../dsp/chords.js';
import { NOTE_NAMES } from '../dsp/notes.js';

const weights = (...names) => {
  const w = new Array(12).fill(0);
  for (const n of names) w[NOTE_NAMES.indexOf(n)] += 1;
  return w;
};

test('triads and sevenths', () => {
  assert.equal(recognizeChord(weights('G', 'C', 'E', 'C')).name, 'C');
  assert.equal(recognizeChord(weights('A', 'C', 'E', 'A')).name, 'Am');
  assert.equal(recognizeChord(weights('G', 'D', 'F', 'B')).name, 'G7');
  assert.equal(recognizeChord(weights('G', 'C', 'E', 'B')).name, 'Cmaj7');
  assert.equal(recognizeChord(weights('A', 'D', 'F', 'C')).name, 'Dm7');
  assert.equal(recognizeChord(weights('Ab', 'D', 'E', 'B')).name, 'E7');
});

test('ambiguous voicing lists the alternative', () => {
  const c = recognizeChord(weights('G', 'C', 'E', 'A'));
  assert.ok(['Am7', 'C6'].includes(c.name));
  assert.ok(c.alternatives.includes(c.name === 'Am7' ? 'C6' : 'Am7'));
});

test('single pitch class is a note, silence is null', () => {
  assert.deepEqual(recognizeChord(weights('A', 'A')).name, 'A');
  assert.equal(recognizeChord(weights('A', 'A')).suffix, null);
  assert.equal(recognizeChord(new Array(12).fill(0)), null);
});

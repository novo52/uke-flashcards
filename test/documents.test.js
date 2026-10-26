import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport } from '../sync/documents.js';
import { emptyProgress } from '../game/cards.js';

const progress = { ...emptyProgress(), revision: 9, unlocked: ['C', 'Am'], lessons: [{}, {}] };
const calibration = { savedAt: '2026-10-26T00:00:00.000Z', templates: { 60: [[1], [2]] } };

test('reads an export with progress and calibration', () => {
  const parsed = parseImport(JSON.stringify({ app: 'uke-flashcards', flashcards: progress, calibration }));
  assert.equal(parsed.flashcards.revision, 9);
  assert.deepEqual(parsed.calibration, calibration);
  assert.equal(parsed.summary, 'flashcard progress (2 lessons, 2 chords unlocked) and calibration (1 notes)');
});

test('reads a bare progress file, in either format', () => {
  assert.equal(parseImport(JSON.stringify(progress)).calibration, null);
  const v1 = parseImport(JSON.stringify({ introduced: ['C', 'Am', 'F'], chords: {} }));
  assert.deepEqual(v1.flashcards.unlocked, ['C', 'Am', 'F']);
});

test('reads an export holding only a cleared calibration', () => {
  const parsed = parseImport(JSON.stringify({ app: 'uke-flashcards', flashcards: null, calibration: { savedAt: 'x', templates: null } }));
  assert.equal(parsed.flashcards, null);
  assert.equal(parsed.calibration.templates, null);
});

test('rejects files with neither', () => {
  assert.equal(parseImport('{"a":1}'), null);
  assert.equal(parseImport('not json'), null);
});

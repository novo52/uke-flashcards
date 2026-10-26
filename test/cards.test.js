import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Deck, CURRICULUM, migrateV1, currentTime, setChordChain } from '../game/cards.js';
import { rng } from './synth.js';

const chain = JSON.parse(readFileSync(new URL('../data/chord-chain.json', import.meta.url)));
setChordChain(chain);

const DAY = 86400000;

// Plays one lesson with `timeOf(name)` seconds per change and no misses.
function playLesson(deck, timeOf = () => 1) {
  const { progressions } = deck.lesson();
  const steps = progressions.flat().map((name, i) => ({ name, time: i ? timeOf(name) : null, miss: false }));
  return { progressions, result: deck.record(steps, 30) };
}

test('flashcards start with C and Am, focused on the first', () => {
  const deck = new Deck(null, { random: rng(1) });
  const keys = deck.keys();
  assert.deepEqual(keys.filter((k) => k.included).map((k) => k.name), ['C', 'Am']);
  assert.equal(keys.find((k) => k.focused).name, 'C');
});

test('flashcard lessons: every progression holds the focused chord, no chord twice running', () => {
  const deck = new Deck(null, { random: rng(2) });
  for (let i = 0; i < 30; i++) {
    const { progressions, focus } = deck.lesson();
    for (const p of progressions) if (focus) assert.ok(p.includes(focus), `${p} lacks ${focus}`);
    const flat = progressions.flat();
    for (let j = 1; j < flat.length; j++) assert.notEqual(flat[j], flat[j - 1], flat.join(' '));
    playLesson(deck, () => 1);
  }
});

test('flashcards unlock chords only at the target speed, without limit in one session', () => {
  const slow = new Deck(null, { random: rng(3) });
  for (let i = 0; i < 30; i++) playLesson(slow, () => 3);
  assert.deepEqual(slow.data.unlocked, ['C', 'Am']);

  const fast = new Deck(null, { random: rng(3) });
  const unlocked = [];
  for (let i = 0; i < 300; i++) unlocked.push(...playLesson(fast, () => 1.5).result.unlocked);
  assert.deepEqual(fast.data.unlocked, CURRICULUM);
  assert.deepEqual(unlocked, CURRICULUM.slice(2));
});

test('flashcards focus on the slowest chord', () => {
  const deck = new Deck(null, { random: rng(4) });
  for (let i = 0; i < 10; i++) playLesson(deck, (n) => (n === 'C' ? 1.5 : 2.5));
  assert.equal(deck.keys().find((k) => k.focused).name, 'Am');
});

test('flashcard changes come up as often as songs make them', () => {
  const deck = new Deck(null, { random: rng(6) });
  deck.data.unlocked = ['C', 'Am', 'F', 'G'];
  const allowed = new Set(deck.data.unlocked);
  // What follows a phrase opening on C, against the corpus counts.
  const seen = {};
  for (let i = 0; i < 4000; i++) {
    const next = deck.pickWeighted(deck.continuations(['C'], allowed));
    seen[next] = (seen[next] ?? 0) + 1;
  }
  const row = chain.chain['_ _ C'];
  const total = row.G + row.F + row.Am;
  for (const c of ['G', 'F', 'Am']) assert.ok(Math.abs(seen[c] / 4000 - row[c] / total) < 0.03, `${c}: ${seen[c]}`);
  // A context with no unlocked continuation backs off to a shorter one.
  assert.ok(deck.continuations(['G', 'C', 'F'], new Set(['C', 'Am', 'F', 'G'])).length > 0);
});

test('a chord not played for days slows down, and the next lesson counts for more', () => {
  let now = 0;
  const deck = new Deck(null, { random: rng(5), now: () => now });
  for (let i = 0; i < 20; i++) playLesson(deck, () => 1.5);
  const c = deck.data.chords.C;
  assert.ok(Math.abs(currentTime(c, now) - 1.5) < 1e-9);
  now = 30 * DAY;
  assert.ok(currentTime(c, now) > 1.5 * 1.4);
  playLesson(deck, () => 1.5);
  assert.ok(Math.abs(deck.data.chords.C.filtered - 1.5) < 0.1, deck.data.chords.C.filtered);
});

test('flashcard progress from the first format is kept', () => {
  const data = migrateV1({ target: 1.5, introduced: ['C', 'Am', 'F'], chords: { C: { times: [1, 1, 1] }, Am: { times: [2] }, F: { times: [] } }, pairs: { 'C>Am': [2] } });
  const deck = new Deck(data);
  const keys = deck.keys();
  assert.deepEqual(keys.filter((k) => k.included).map((k) => k.name), ['C', 'Am', 'F']);
  assert.equal(deck.data.chords.C.filtered, 1);
  assert.equal(deck.data.target, 1.5);
  assert.equal(keys.find((k) => k.focused).name, 'F');
});

// Builds data/chord-chain.json, the chord transition table the
// flashcards generate progressions from, out of the Chordonomicon dataset
// (Kantarelis et al. 2024, CC BY-NC 4.0, https://huggingface.co/datasets/ailsntua/Chordonomicon):
//
//   node tools/build-chord-chain.mjs path/to/chordonomicon_v2.csv
//
// Like keybr's letter table it is an order-4 chain: for every three chords
// (with '_' standing for a phrase boundary) the count of each chord that
// follows. Section tags (<verse_1>, …) and chords outside the flashcard
// curriculum end a phrase; a chord repeated in a row counts once. Chords keep
// their key as written.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseChord } from '../dsp/chords.js';
import { CURRICULUM } from '../game/cards.js';

const ORDER = 4;
const MIN_COUNT = 3; // rarer chains are dropped
const OUT = new URL('../data/chord-chain.json', import.meta.url);

// Chordonomicon spelling ("Fsmin7", "Gno3d", "Gadd13", "A/Cs") in the
// recogniser's spelling, or null.
function normalize(token) {
  const m = /^([A-G])(s|b)?([^/]*)/.exec(token);
  if (!m) return null;
  const suffix = m[3].replace(/^min/, 'm').replace(/^no3d$/, '5').replace(/^add13$/, '6');
  return parseChord(`${m[1]}${m[2] === 's' ? '#' : m[2] ?? ''}${suffix}`)?.name ?? null;
}

const vocabulary = new Set(CURRICULUM.map((n) => parseChord(n).name));
const counts = new Map(); // 'a b c' -> Map(next -> count)
let songs = 0;
let phrases = 0;

function addPhrase(chords) {
  if (chords.length < 2) return;
  phrases++;
  const seq = [...Array(ORDER - 1).fill('_'), ...chords, '_'];
  for (let i = ORDER - 1; i < seq.length; i++) {
    const context = seq.slice(i - ORDER + 1, i).join(' ');
    let next = counts.get(context);
    if (!next) counts.set(context, (next = new Map()));
    next.set(seq[i], (next.get(seq[i]) ?? 0) + 1);
  }
}

const path = process.argv[2];
if (!path) throw new Error('usage: node tools/build-chord-chain.mjs chordonomicon_v2.csv');
const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
let header = true;
for await (const line of lines) {
  if (header) {
    header = false;
    continue;
  }
  // id,chords,…: the chord field holds no commas.
  const field = line.split(',', 2)[1];
  if (!field) continue;
  songs++;
  let phrase = [];
  for (const token of field.split(' ')) {
    const chord = token.startsWith('<') ? null : normalize(token);
    if (chord && vocabulary.has(chord)) {
      if (phrase.at(-1) !== chord) phrase.push(chord);
    } else if (token) {
      addPhrase(phrase);
      phrase = [];
    }
  }
  addPhrase(phrase);
}

const chain = {};
for (const [context, next] of [...counts].sort()) {
  const kept = Object.fromEntries([...next].filter(([, n]) => n >= MIN_COUNT).sort((a, b) => b[1] - a[1]));
  if (Object.keys(kept).length) chain[context] = kept;
}
const source = 'Chordonomicon (Kantarelis et al. 2024), CC BY-NC 4.0, https://huggingface.co/datasets/ailsntua/Chordonomicon';
await writeFile(OUT, `${JSON.stringify({ source, order: ORDER, songs, phrases, chain })}\n`);
console.log(`${songs} songs, ${phrases} phrases, ${Object.keys(chain).length} contexts`);

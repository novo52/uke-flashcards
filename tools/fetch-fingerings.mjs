// Downloads the ukulele chord fingerings of chords-db (MIT, github.com/tombatossals/chords-db)
// into data/uke-fingerings.json: each voicing's frets (absolute, -1 = not played) and the
// finger on each string (0 = open or not played).
import { writeFile, mkdir } from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/tombatossals/chords-db/master/lib/ukulele.json';
const OUT = new URL('../data/uke-fingerings.json', import.meta.url);

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE}: ${response.status}`);
const db = await response.json();
const seen = new Map();
for (const chords of Object.values(db.chords)) {
  for (const chord of chords) {
    for (const p of chord.positions) {
      const frets = p.frets.map((f) => (f > 0 ? f + p.baseFret - 1 : f));
      const key = frets.join(',');
      if (!seen.has(key)) seen.set(key, [frets, p.fingers]);
    }
  }
}
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ source: 'chords-db by David Rubert, MIT licence, https://github.com/tombatossals/chords-db', positions: [...seen.values()] }));
console.log(`${seen.size} voicings written to ${OUT.pathname}`);

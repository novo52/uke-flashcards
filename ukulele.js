// A ukulele drawn as SVG, strings laid out as in tablature: headstock on the left, A string on top, G at the bottom. A marker on each position shows how well its pitch is learned.
import { midiToName, UKE_TUNING } from './dsp/notes.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 320;
const MID = H / 2;
const NUT_X = 140;
const SCALE = 750; // nut to saddle
const SADDLE_X = NUT_X + SCALE;
const NECK_END_X = 560;
const FRETS = 15;
// Per string, in G C E A order.
const STRING_NAMES = ['G', 'C', 'E', 'A'];
const STRING_WIDTHS = [1.6, 2.3, 1.9, 1.5];
// Per row, top to bottom; string s is on row 3 - s.
const NUT_OFFSETS = [-27, -9, 9, 27];
const SADDLE_OFFSETS = [-36, -12, 12, 36];

export const fretX = (i) => NUT_X + SCALE * (1 - 2 ** (-i / 12));
const stringY = (s, x) => {
  const row = 3 - s;
  return MID + NUT_OFFSETS[row] + ((SADDLE_OFFSETS[row] - NUT_OFFSETS[row]) * (x - NUT_X)) / SCALE;
};
const neckHalf = (x) => 40 + (8 * (x - NUT_X)) / (NECK_END_X - NUT_X);
// Where a finger presses: just behind the fret wire. Open strings are marked left of the nut.
const markerX = (fret) => (fret === 0 ? NUT_X - 16 : fretX(fret) - 0.38 * (fretX(fret) - fretX(fret - 1)));

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

export class UkuleleView {
  // Marks every string at frets 0 to `maxFret`.
  constructor(svg, maxFret = 12) {
    this.svg = svg;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.replaceChildren();
    this.drawBody();
    this.drawNeck();
    this.drawStrings();
    this.markers = []; // { midi, circle, text }
    UKE_TUNING.forEach((open, string) => {
      for (let fret = 0; fret <= maxFret; fret++) {
        const midi = open + fret;
        const g = el('g', { class: 'ukeMarker', transform: `translate(${markerX(fret)} ${stringY(string, markerX(fret))})` }, svg);
        el('title', {}, g).textContent = `${midiToName(midi)}: ${STRING_NAMES[string]} string, ${fret ? `fret ${fret}` : 'open'}`;
        const circle = el('circle', { r: 8 }, g);
        const text = el('text', { y: 3.5, 'text-anchor': 'middle' }, g);
        this.markers.push({ midi, circle, text });
      }
    });
  }

  // `learned(midi)`: 0 (not heard) to 1 (fully learned).
  show(learned) {
    for (const { midi, circle, text } of this.markers) {
      const p = Math.max(0, Math.min(1, learned(midi)));
      circle.setAttribute('fill', `rgba(77, 214, 140, ${0.08 + 0.82 * p})`);
      text.textContent = p >= 1 ? '✓' : '';
    }
  }

  drawBody() {
    const svg = this.svg;
    const bouts = [{ cx: 650, rx: 112, ry: 108 }, { cx: 845, rx: 145, ry: 138 }];
    // Outlines first, then fills over them, so the two bouts read as one figure-eight.
    for (const b of bouts) el('ellipse', { cx: b.cx, cy: MID, rx: b.rx + 4, ry: b.ry + 4, fill: '#5a3d22' }, svg);
    for (const b of bouts) el('ellipse', { cx: b.cx, cy: MID, rx: b.rx, ry: b.ry, fill: '#c08a4f' }, svg);
    el('circle', { cx: 700, cy: MID, r: 46, fill: 'none', stroke: '#7a5530', 'stroke-width': 6 }, svg);
    el('circle', { cx: 700, cy: MID, r: 40, fill: '#1e1610' }, svg);
    el('rect', { x: SADDLE_X - 14, y: MID - 44, width: 30, height: 88, rx: 6, fill: '#3b2616' }, svg);
    el('line', { x1: SADDLE_X, y1: MID - 38, x2: SADDLE_X, y2: MID + 38, stroke: '#e8e0d0', 'stroke-width': 3 }, svg);
  }

  drawNeck() {
    const svg = this.svg;
    // Headstock and tuning pegs.
    el('path', { d: `M ${NUT_X} ${MID - 40} L 56 ${MID - 50} Q 40 ${MID} 56 ${MID + 50} L ${NUT_X} ${MID + 40} Z`, fill: '#3a2617' }, svg);
    for (const [x, side] of [[76, -1], [110, -1], [76, 1], [110, 1]]) {
      el('rect', { x: x - 5, y: side < 0 ? MID - 68 : MID + 50, width: 10, height: 18, rx: 3, fill: '#bbb' }, svg);
      el('circle', { cx: x, cy: MID + side * 32, r: 6, fill: '#d8d8d8' }, svg);
    }
    // Fretboard.
    const top = (x) => MID - neckHalf(x);
    const bottom = (x) => MID + neckHalf(x);
    el('path', { d: `M ${NUT_X} ${top(NUT_X)} L ${NECK_END_X + 40} ${top(NECK_END_X)} L ${NECK_END_X + 40} ${bottom(NECK_END_X)} L ${NUT_X} ${bottom(NUT_X)} Z`, fill: '#2a1d14' }, svg);
    for (const [fret, dy] of [[5, 0], [7, 0], [10, 0], [12, -14], [12, 14]]) {
      el('circle', { cx: (fretX(fret - 1) + fretX(fret)) / 2, cy: MID + dy, r: 4.5, fill: '#d9cfc0', opacity: 0.8 }, svg);
    }
    for (let i = 1; i <= FRETS; i++) {
      const x = fretX(i);
      el('line', { x1: x, y1: top(x), x2: x, y2: bottom(x), stroke: '#b9b2a8', 'stroke-width': 2.2 }, svg);
      if (i <= 12) el('text', { class: 'ukeFretNo', x: (fretX(i - 1) + x) / 2, y: MID + 72, 'text-anchor': 'middle' }, svg).textContent = String(i);
    }
    el('line', { x1: NUT_X, y1: top(NUT_X) - 1, x2: NUT_X, y2: bottom(NUT_X) + 1, stroke: '#efe9dc', 'stroke-width': 6 }, svg);
    el('text', { class: 'ukeFretNo', x: markerX(0), y: MID + 72, 'text-anchor': 'middle' }, svg).textContent = 'open';
  }

  drawStrings() {
    const svg = this.svg;
    STRING_NAMES.forEach((name, s) => {
      const pegX = s === 0 || s === 3 ? 76 : 110;
      const pegY = MID + (s >= 2 ? -32 : 32);
      el('line', { x1: pegX, y1: pegY, x2: NUT_X, y2: stringY(s, NUT_X), stroke: '#cfcfcf', 'stroke-width': STRING_WIDTHS[s] }, svg);
      el('line', { class: 'ukeString', x1: NUT_X, y1: stringY(s, NUT_X), x2: SADDLE_X, y2: stringY(s, SADDLE_X), stroke: '#e6e6e6', 'stroke-width': STRING_WIDTHS[s] }, svg);
      el('text', { class: 'ukeStringName', x: 22, y: stringY(s, NUT_X) + 6, 'text-anchor': 'middle' }, svg).textContent = name;
    });
  }
}

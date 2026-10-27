// The progress page, after keybr's profile: a summary, speed and accuracy over lessons, each chord's speed, and a practice calendar, all drawn from the flashcard progress.
import { CURRICULUM, cpm, currentTime } from './game/cards.js';
import { setupAccount } from './sync/account.js';
import { progressDoc } from './sync/documents.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
const CAL_WEEKS = 26;
// Minutes at which a calendar day moves up a step; the last colour is for CAL_STEPS.at(-1) and more.
const CAL_STEPS = [1, 5, 15, 30];
const CAL_COLOURS = ['#404040', '#3b5745', '#3f7752', '#43985f', '#52bd78'];

const el = (name, attrs = {}, parent = null) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};
const text = (parent, x, y, content, attrs = {}) => {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = content;
  return t;
};
const html = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const fmtDuration = (seconds) => {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const pct = (x) => `${Math.round(x * 100)}%`;
const localDay = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Exponential smoothing: `smoothness` 0 follows every point, near 1 shows only the long-term trend.
function smooth(ys, smoothness) {
  const alpha = 1 - smoothness;
  let s = null;
  return ys.map((y) => (s = s === null ? y : alpha * y + (1 - alpha) * s));
}

// A rounded step (1, 2 or 5 times a power of ten) giving about `count` ticks up to `max`.
function niceTicks(max, count = 4) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(v);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

// A line over points [{ y, raw, tip }] by index, with raw values as faint dots, an optional labelled reference line, and a crosshair tooltip.
function lineChart(container, { points, format, reference = null, yMax = null }) {
  container.replaceChildren();
  const width = container.clientWidth || 600;
  const height = 200;
  const m = { left: 40, right: 64, top: 10, bottom: 24 };
  const top = Math.max(yMax ?? 0, reference?.y ?? 0, ...points.map((p) => Math.max(p.y, p.raw ?? 0)));
  const ticks = yMax !== null ? niceTicks(yMax) : niceTicks(top || 1);
  const yTop = ticks.at(-1);
  const n = points.length;
  const x = (i) => m.left + (n > 1 ? (i / (n - 1)) * (width - m.left - m.right) : (width - m.left - m.right) / 2);
  const y = (v) => m.top + (1 - v / yTop) * (height - m.top - m.bottom);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img' }, container);

  for (const t of ticks) {
    el('line', { class: 'grid', x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }, svg);
    text(svg, m.left - 6, y(t) + 4, format(t), { 'text-anchor': 'end' });
  }
  const xTicks = n > 1 ? niceTicks(n - 1, Math.min(6, n - 1)).filter((t) => t <= n - 1) : [0];
  for (const t of xTicks) text(svg, x(t), height - 6, String(t + 1), { 'text-anchor': 'middle' });
  if (reference) {
    el('line', { class: 'ref', x1: m.left, x2: width - m.right, y1: y(reference.y), y2: y(reference.y) }, svg);
    text(svg, width - m.right + 6, y(reference.y) + 4, reference.label, { class: 'ref-label' });
  }
  for (const [i, p] of points.entries()) if (p.raw != null) el('circle', { class: 'raw', cx: x(i), cy: y(p.raw), r: 2.5 }, svg);
  el('path', { class: 'line', d: points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('') }, svg);
  const last = points.at(-1);
  // The end label sits under the reference label when the two would overlap.
  const endY = reference && Math.abs(y(last.y) - y(reference.y)) < 12 ? y(reference.y) + 16 : y(last.y) + 4;
  text(svg, width - m.right + 6, endY, format(last.y), { class: 'end-label' });

  const cross = el('line', { class: 'cross', y1: m.top, y2: height - m.bottom, visibility: 'hidden' }, svg);
  const hot = el('circle', { class: 'hot', r: 4, visibility: 'hidden' }, svg);
  const tip = html('div', { className: 'tip', hidden: true });
  container.append(tip);
  const hit = el('rect', { x: m.left - 8, y: 0, width: width - m.left - m.right + 16, height, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(n > 1 ? ((px - m.left) / (width - m.left - m.right)) * (n - 1) : 0)));
    for (const node of [cross, hot]) node.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    hot.setAttribute('cx', x(i));
    hot.setAttribute('cy', y(points[i].y));
    tip.replaceChildren(...points[i].tip());
    tip.hidden = false;
    const left = (x(i) / width) * box.width;
    tip.style.left = `${Math.min(left + 12, box.width - tip.offsetWidth)}px`;
    tip.style.top = `${(y(points[i].y) / height) * box.height - tip.offsetHeight - 10}px`;
  });
  hit.addEventListener('pointerleave', () => {
    for (const node of [cross, hot]) node.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

const tipLines = (title, ...rows) => [html('div', { textContent: title }), ...rows.map(([k, v]) => html('div', {}, [html('span', { textContent: `${k} ` }), v]))];

function summary(d) {
  const ls = d.lessons;
  const mean = (f) => ls.reduce((a, l) => a + f(l), 0) / ls.length;
  const seconds = Object.values(d.daily ?? {}).reduce((a, b) => a + b, 0);
  const tiles = [
    ['Practice time', fmtDuration(seconds)],
    ['Lessons', String(ls.length)],
    ['Top speed', `${Math.max(...ls.map((l) => l.cpm)).toFixed(1)} cpm`],
    ['Average speed', `${mean((l) => l.cpm).toFixed(1)} cpm`],
    ['Top accuracy', pct(Math.max(...ls.map((l) => l.accuracy)))],
    ['Average accuracy', pct(mean((l) => l.accuracy))],
    ['Chords unlocked', `${d.unlocked.length} of ${CURRICULUM.length}`],
  ];
  $('summary').replaceChildren(...tiles.map(([k, v]) => html('div', { className: 'tile' }, [html('span', { textContent: k }), html('b', { textContent: v })])));
}

function lessonCharts(d, smoothness) {
  const ls = d.lessons;
  const speed = smooth(ls.map((l) => l.cpm), smoothness);
  const target = cpm(d.target);
  lineChart($('speedChart'), {
    points: ls.map((l, i) => ({ y: speed[i], raw: l.cpm, tip: () => tipLines(`Lesson ${i + 1} · ${fmtDate(l.at)}`, ['Speed', `${l.cpm.toFixed(1)} cpm`], ['Smoothed', `${speed[i].toFixed(1)} cpm`], ['Accuracy', pct(l.accuracy)]) })),
    format: (v) => v.toFixed(0),
    reference: { y: target, label: `target ${target.toFixed(0)}` },
  });
  const accuracy = smooth(ls.map((l) => l.accuracy * 100), smoothness);
  lineChart($('accuracyChart'), {
    points: ls.map((l, i) => ({ y: accuracy[i], raw: l.accuracy * 100, tip: () => tipLines(`Lesson ${i + 1} · ${fmtDate(l.at)}`, ['Accuracy', pct(l.accuracy)], ['Smoothed', `${accuracy[i].toFixed(0)}%`]) })),
    format: (v) => `${v.toFixed(0)}%`,
    yMax: 100,
  });
}

// The stored speed is already smoothed across lessons (alpha 0.1), so the smoothness slider does not apply here.
function chordChart(d, name) {
  const samples = (d.chords[name]?.samples ?? []).filter((s) => s.filtered != null);
  const target = cpm(d.target);
  if (!samples.length) {
    $('chordChart').replaceChildren(html('p', { className: 'sub', textContent: `${name} has no timed changes yet.` }));
    return;
  }
  lineChart($('chordChart'), {
    points: samples.map((s, i) => ({
      y: cpm(s.filtered),
      raw: cpm(s.time),
      tip: () => tipLines(`${name} · ${s.at ? fmtDate(s.at) : 'imported'}`, ['Lesson average', `${cpm(s.time).toFixed(1)} cpm`], ['Smoothed', `${cpm(s.filtered).toFixed(1)} cpm`], ['Played', `${s.hits}×, ${s.misses} shown`]),
    })),
    format: (v) => v.toFixed(0),
    reference: { y: target, label: `target ${target.toFixed(0)}` },
  });
}

function chordTable(d) {
  const now = Date.now();
  const head = html('tr', {}, ['Chord', 'Now', 'Best', 'Lessons', 'Accuracy', 'Last played'].map((h) => html('th', { textContent: h })));
  const rows = d.unlocked.map((name) => {
    const c = d.chords[name];
    const samples = c?.samples ?? [];
    const hits = samples.reduce((a, s) => a + s.hits, 0);
    const misses = samples.reduce((a, s) => a + s.misses, 0);
    const time = currentTime(c, now);
    const at = samples.findLast((s) => s.at != null)?.at;
    const cells = [name, time ? `${cpm(time).toFixed(1)} cpm` : '–', c?.best ? `${cpm(c.best).toFixed(1)} cpm` : '–', String(samples.length), hits ? pct((hits - misses) / hits) : '–', at ? fmtDate(at) : '–'];
    return html('tr', {}, cells.map((v) => html('td', { textContent: v })));
  });
  $('chordTable').replaceChildren(head, ...rows);
}

function calendar(d) {
  const container = $('calendar');
  container.replaceChildren();
  const cell = 11;
  const gap = 2;
  const m = { left: 26, top: 16 };
  // Columns are weeks starting on Monday, ending with the current week.
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS);
  const start = monday.getTime() - (CAL_WEEKS - 1) * 7 * DAY_MS;
  const width = m.left + CAL_WEEKS * (cell + gap);
  const height = m.top + 7 * (cell + gap);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' }, container);
  ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((label, r) => label && text(svg, 0, m.top + r * (cell + gap) + cell - 1, label));
  const tip = html('div', { className: 'tip', hidden: true });
  container.append(tip);
  let lastMonth = null;
  for (let w = 0; w < CAL_WEEKS; w++) {
    const weekStart = new Date(start + w * 7 * DAY_MS);
    if (weekStart.getMonth() !== lastMonth) {
      lastMonth = weekStart.getMonth();
      if (w < CAL_WEEKS - 2) text(svg, m.left + w * (cell + gap), 10, weekStart.toLocaleDateString([], { month: 'short' }));
    }
    for (let r = 0; r < 7; r++) {
      const ms = start + (w * 7 + r) * DAY_MS;
      if (ms > today.getTime()) continue;
      const minutes = (d.daily?.[localDay(ms)] ?? 0) / 60;
      const level = CAL_STEPS.filter((s) => minutes >= s).length;
      const rect = el('rect', { x: m.left + w * (cell + gap), y: m.top + r * (cell + gap), width: cell, height: cell, rx: 2, fill: CAL_COLOURS[level] }, svg);
      rect.addEventListener('pointerenter', () => {
        tip.replaceChildren(html('div', { textContent: fmtDate(ms) }), html('div', {}, [html('span', { textContent: 'Practised ' }), minutes ? fmtDuration(minutes * 60) : 'not at all']));
        tip.hidden = false;
        tip.style.left = `${Math.min(Number(rect.getAttribute('x')) + 14, width - tip.offsetWidth)}px`;
        tip.style.top = `${Number(rect.getAttribute('y')) - tip.offsetHeight - 4}px`;
      });
      rect.addEventListener('pointerleave', () => (tip.hidden = true));
    }
  }
  const labels = ['0', ...CAL_STEPS.map((s, i) => (i < CAL_STEPS.length - 1 ? `${s}–${CAL_STEPS[i + 1]}` : `${s}+`))];
  $('calLegend').replaceChildren(html('span', { textContent: 'Minutes:' }), ...CAL_COLOURS.flatMap((c, i) => [html('i', { style: `background:${c}`, title: `${labels[i]} min` }), html('span', { textContent: labels[i] })]));
}

function lessonTable(d) {
  const head = html('tr', {}, ['Lesson', 'Date', 'Speed', 'Accuracy', 'Score', 'Chords', 'Time'].map((h) => html('th', { textContent: h })));
  const rows = d.lessons.map((l, i) => html('tr', {}, [String(i + 1), fmtDate(l.at), `${l.cpm.toFixed(1)} cpm`, pct(l.accuracy), String(l.score), String(l.chords), fmtDuration(l.seconds)].map((v) => html('td', { textContent: v })))).reverse();
  $('lessonTable').replaceChildren(head, ...rows);
}

function render() {
  const d = progressDoc.local;
  const has = !!d?.lessons?.length;
  $('empty').hidden = has;
  $('content').hidden = !has;
  if (!has) return;
  summary(d);
  lessonCharts(d, Number($('smooth').value));
  // Only chords with a timed change have a line to draw.
  const timed = d.unlocked.filter((name) => d.chords[name]?.samples?.some((s) => s.filtered != null));
  const pick = $('chordPick');
  const chosen = timed.includes(pick.value) ? pick.value : timed[0];
  pick.replaceChildren(...timed.map((name) => html('option', { value: name, textContent: name })));
  pick.value = chosen ?? '';
  if (chosen) chordChart(d, chosen);
  else $('chordChart').replaceChildren(html('p', { className: 'sub', textContent: 'No chord has a timed change yet.' }));
  chordTable(d);
  calendar(d);
  lessonTable(d);
}

progressDoc.onPull = render;
const account = setupAccount({ setStatus: (t) => ($('status').textContent = t) });
// The controls redraw only their own chart: rebuilding the whole page moves the scroll position.
$('smooth').addEventListener('input', () => lessonCharts(progressDoc.local, Number($('smooth').value)));
$('chordPick').addEventListener('change', () => chordChart(progressDoc.local, $('chordPick').value));
// Charts are drawn to the page's width, so only a width change redraws them.
let drawnWidth = null;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === drawnWidth) return;
  drawnWidth = entry.contentRect.width;
  render();
}).observe(document.querySelector('.page'));
render();
account.start();

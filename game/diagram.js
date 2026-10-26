import { fingersFor } from './shapes.js';

// A chord box: four strings (G C E A from left), five frets, dots on the
// fretted positions.
export function drawDiagram(canvas, title, frets) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 40 || h < 60) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#e8eaf0';
  g.font = '600 15px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(title, w / 2, 16);
  if (!frets) return;
  const top = 30;
  const left = 18;
  const sw = (w - 2 * left) / 3;
  const fh = (h - top - 8) / 5;
  const base = Math.max(...frets) > 5 ? Math.min(...frets.filter((f) => f > 0)) : 1;
  g.strokeStyle = '#8a92a6';
  g.lineWidth = 1;
  for (let s = 0; s < 4; s++) {
    g.beginPath();
    g.moveTo(left + s * sw, top);
    g.lineTo(left + s * sw, top + 5 * fh);
    g.stroke();
  }
  for (let f = 0; f <= 5; f++) {
    g.lineWidth = f === 0 && base === 1 ? 4 : 1;
    g.beginPath();
    g.moveTo(left, top + f * fh);
    g.lineTo(left + 3 * sw, top + f * fh);
    g.stroke();
  }
  if (base > 1) {
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(String(base), left - 5, top + fh / 2 + 4);
    g.textAlign = 'center';
  }
  g.fillStyle = '#ffcc4d';
  g.strokeStyle = '#ffcc4d';
  g.font = '11px system-ui, sans-serif';
  const { fingers } = fingersFor(frets);
  const single = frets.filter((f) => f >= 0).length === 1;
  const r = Math.min(sw, fh) * 0.34;
  const y = (f) => top + (f - base + 0.5) * fh;
  // A barre: one finger across several strings at the same fret.
  for (let finger = 1; finger <= 4; finger++) {
    const held = frets.map((f, s) => ({ f, s })).filter((x) => x.f > 0 && fingers[x.s] === finger);
    if (held.length < 2 || held.some((x) => x.f !== held[0].f)) continue;
    g.fillRect(left + held[0].s * sw, y(held[0].f) - r * 0.6, (held[held.length - 1].s - held[0].s) * sw, r * 1.2);
  }
  frets.forEach((f, s) => {
    const x = left + s * sw;
    if (f === 0 && single) {
      // A single open-string note: the string itself is highlighted.
      g.fillRect(x - 1.5, top, 3, 5 * fh);
      g.beginPath();
      g.arc(x, top - 8, 5, 0, Math.PI * 2);
      g.fill();
    } else if (f === 0) {
      g.beginPath();
      g.arc(x, top - 7, 3.5, 0, Math.PI * 2);
      g.stroke();
    } else if (f < 0) g.fillText('×', x, top - 3);
    if (f <= 0) return;
    g.beginPath();
    g.arc(x, y(f), r, 0, Math.PI * 2);
    g.fill();
  });
  // The finger to use on each dot (1 index to 4 little).
  g.fillStyle = '#1b1600';
  g.font = `700 ${Math.round(r * 1.3)}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  frets.forEach((f, s) => {
    if (f > 0 && fingers[s]) g.fillText(String(fingers[s]), left + s * sw, y(f) + 0.5);
  });
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffcc4d';
}

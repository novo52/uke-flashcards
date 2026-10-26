// The calibration page: while calibrating, every single note plucked teaches the analyzer that pitch, and the drawn ukulele fills each position as its pitch is learned.
import { Microphone } from './mic.js';
import { setupAccount } from './sync/account.js';
import { calibrationDoc, templates, saveTemplates } from './sync/documents.js';
import { UkuleleView } from './ukulele.js';

const CAL_TARGET = 100; // calibration frames that count as a fully learned note

const $ = (id) => document.getElementById(id);
const view = new UkuleleView($('uke'));

calibrationDoc.canPull = () => !mic.calibrating;
calibrationDoc.onPull = () => showSaved();
const account = setupAccount({ setStatus: (text) => ($('status').textContent = text) });

const mic = new Microphone({
  onCalibration: (minMidi, counts) => view.show((midi) => (counts[midi - minMidi] ?? 0) / CAL_TARGET),
  onTemplates: (t) => {
    const n = Object.keys(t).length;
    saveTemplates(n ? t : null);
    account.scheduleSync();
    showSaved();
    $('status').textContent = n ? `Calibration saved: ${n} notes learned.` : 'No notes were learned; keeping the generic sound.';
  },
  onChange: () => {
    $('micState').textContent = mic.on ? `Microphone on · ${mic.label}` : 'Microphone off';
    $('micState').classList.toggle('on', mic.on);
    $('micStart').textContent = mic.on ? 'Stop microphone' : 'Start microphone';
    $('micStart').classList.toggle('primary', !mic.on);
    $('device').disabled = !mic.on;
    $('calibrate').disabled = !mic.on;
    if (!mic.on) {
      $('meterFill').style.width = '0';
      showCalibrating(false);
    }
  },
});

// Outside calibration the ukulele shows the notes the saved calibration holds.
function showSaved() {
  if (mic.calibrating) return;
  const learned = new Set(Object.keys(templates() ?? {}).map(Number));
  view.show((midi) => (learned.has(midi) ? 1 : 0));
  $('resetCal').disabled = !learned.size;
  $('status').textContent = learned.size ? `Calibrated: ${learned.size} notes learned.` : 'Not calibrated: using the generic sound.';
}

function showCalibrating(on) {
  $('calibrate').textContent = on ? 'Finish calibration' : 'Calibrate';
  $('calibrate').classList.toggle('primary', on);
  $('howTo').classList.toggle('active', on);
}

async function toggleMic() {
  if (mic.on) return mic.stop(); // stopping mid-calibration saves what was learned
  try {
    await mic.start(templates());
    const devices = await mic.devices();
    $('device').replaceChildren(...devices.map((d) => new Option(d.label, d.id, false, d.current)));
  } catch (err) {
    $('status').textContent = `Could not start the microphone: ${err.message}`;
  }
}

function toggleCalibration() {
  const on = !mic.calibrating;
  mic.calibrate(on);
  showCalibrating(on);
  if (on) {
    view.show(() => 0);
    $('status').textContent = 'Listening for single notes…';
  }
}

function renderMeter() {
  requestAnimationFrame(renderMeter);
  const f = mic.latest;
  if (!f) return;
  const pos = (db) => `${Math.max(0, Math.min(1, (db + 80) / 80)) * 100}%`;
  $('meterFill').style.width = pos(f.levelDb);
  // Notes need 10 dB above the room's noise floor (see dsp/analyzer.js).
  $('meterGate').style.left = pos(Math.max(mic.gateDb, f.noiseDb + 10));
}

$('micStart').addEventListener('click', toggleMic);
$('device').addEventListener('change', () => mic.setDevice($('device').value).catch((err) => ($('status').textContent = err.message)));
$('gate').value = String(mic.gateDb);
$('gateVal').textContent = `${mic.gateDb} dB`;
$('gate').addEventListener('input', () => {
  mic.setGate(Number($('gate').value));
  $('gateVal').textContent = `${$('gate').value} dB`;
});
$('calibrate').addEventListener('click', toggleCalibration);
$('resetCal').addEventListener('click', () => {
  if (!confirm('Discard the calibration and use the generic sound?')) return;
  saveTemplates(null);
  mic.resetTemplates();
  account.scheduleSync();
  showSaved();
  $('status').textContent = 'Calibration cleared; using the generic sound.';
});

showSaved();
account.start();
requestAnimationFrame(renderMeter);

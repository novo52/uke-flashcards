// The flashcard page (game/cards.js), with progress synced to the user's Google Drive.
import { CardMode } from './game/cards.js';
import { setFingerings } from './game/shapes.js';
import { Microphone } from './mic.js';
import { setupAccount } from './sync/account.js';
import { progressDoc, calibrationDoc, templates, replaceProgress } from './sync/documents.js';

const $ = (id) => document.getElementById(id);

let cards = null;
let cardsReady = false; // CardMode has shown the progress it loaded from this browser

progressDoc.canPull = () => cardsReady && !cards.run;
progressDoc.onPull = (data) => {
  cards.load(data);
  setStatus('Progress loaded from Google Drive.');
};
calibrationDoc.onPull = () => {
  showCalibrated();
  if (mic.on) setStatus('Calibration loaded; it applies when the microphone restarts.');
};

const account = setupAccount({ setStatus });

// CardMode's store: this browser first, Drive when signed in.
const progressStore = {
  async load() {
    return progressDoc.local;
  },
  async save(data, { replace = false } = {}) {
    if (replace) replaceProgress(data);
    else progressDoc.save(data);
    account.scheduleSync();
  },
};

const mic = new Microphone({
  onFrame: (f) => cards.onFrame(f),
  onChange: () => {
    if (!mic.on) cards.stop();
    $('micState').textContent = mic.on ? `Microphone on · ${mic.label}` : 'Microphone off';
    $('micState').classList.toggle('on', mic.on);
    $('micStop').hidden = !mic.on;
  },
});

async function ensureAudio() {
  try {
    return await mic.start(templates());
  } catch (err) {
    setStatus(`Could not start the microphone: ${err.message}`);
    return null;
  }
}

function setStatus(text) {
  $('cardsHint').textContent = text;
}

function showCalibrated() {
  const calibrated = !!templates();
  $('calLink').textContent = calibrated ? 'Calibrate' : 'Calibrate (recommended)';
  $('calLink').classList.toggle('suggest', !calibrated);
}

$('micStop').addEventListener('click', () => mic.stop());

cards = new CardMode({
  clock: () => mic.clock(),
  ensureAudio,
  setStatus,
  store: progressStore,
  els: {
    listen: $('cardsListen'), shapes: $('cardsShapes'), favourSlow: $('cardsFavourSlow'), target: $('cardsTarget'), startChords: $('cardsStartChords'), goalMinutes: $('cardsGoalMinutes'), reset: $('cardsReset'),
    metrics: $('cardsMetrics'), keys: $('cardsKeys'), current: $('cardsCurrent'), slow: $('cardsSlow'), streak: $('cardsStreak'), goal: $('cardsGoal'),
    board: $('cardsBoard'), text: $('cardsText'), overlay: $('cardsOverlay'), diagram: $('cardDiagram'), hint: $('cardsHint'),
  },
});

fetch('data/uke-fingerings.json')
  .then((res) => res.json())
  .then((data) => {
    setFingerings(data);
    cards.showShape();
  })
  .catch(() => {});

function render() {
  requestAnimationFrame(render);
  cards.render();
}

showCalibrated();
cards.ready.then(() => {
  cardsReady = true;
  account.start();
});
requestAnimationFrame(render);

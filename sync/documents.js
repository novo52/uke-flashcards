// Everything the site stores for a user, shared by every page: flashcard progress, its backup, and the calibration. Pages set `onPull` (and `canPull`) on the documents they show.
import { migrateV1 } from '../game/cards.js';
import { SyncedDoc } from './docs.js';

export const progressDoc = new SyncedDoc({
  key: 'uke.flashcards.v2',
  file: 'flashcards.json',
  newer: (a, b) => (a.revision ?? 0) > (b.revision ?? 0),
});

export const backupDoc = new SyncedDoc({
  key: 'uke.flashcards.backup',
  file: 'flashcards-backup.json',
  newer: (a, b) => a.backedUpAt > b.backedUpAt,
});

export const calibrationDoc = new SyncedDoc({
  key: 'uke.templates.v1',
  file: 'calibration.json',
  newer: (a, b) => (a.savedAt ?? '') > (b.savedAt ?? ''),
});

export const allDocs = [progressDoc, backupDoc, calibrationDoc];

// { [midi]: template sets } as the analyzer takes them, or null for the generic sound.
export function templates() {
  return calibrationDoc.local?.templates ?? null;
}

export function saveTemplates(t) {
  calibrationDoc.save({ savedAt: new Date().toISOString(), templates: t });
}

// Replaces the progress, keeping the previous copy as the backup.
export function replaceProgress(progress) {
  const current = progressDoc.local;
  if (current) backupDoc.save({ backedUpAt: new Date().toISOString(), progress: current });
  // A revision above both copies makes the new progress win the next sync.
  const data = { ...progress, revision: Math.max(progress.revision ?? 0, current?.revision ?? 0) + 1, savedAt: new Date().toISOString() };
  progressDoc.save(data);
  progressDoc.onPull(data);
}

export function exportData() {
  return { app: 'uke-flashcards', exportedAt: new Date().toISOString(), flashcards: progressDoc.local, calibration: calibrationDoc.local };
}

const isProgress = (p) => p && typeof p.chords === 'object' && Array.isArray(p.unlocked);

// Reads an export, or a bare flashcard progress file (the uke app's progress/flashcards.json, in either format). Returns { flashcards, calibration, summary } with null for what the file lacks, or null when it holds neither.
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const asProgress = (p) => (p?.version === 2 ? p : p?.introduced ? migrateV1(p) : null);
  const flashcards = asProgress(data?.app === 'uke-flashcards' ? data.flashcards : data);
  const calibration = data?.app === 'uke-flashcards' && data.calibration && 'templates' in data.calibration ? data.calibration : null;
  if (!isProgress(flashcards) && !calibration) return null;
  const parts = [];
  if (isProgress(flashcards)) parts.push(`flashcard progress (${flashcards.lessons?.length ?? 0} lessons, ${flashcards.unlocked.length} chords unlocked)`);
  if (calibration) parts.push(`calibration (${Object.keys(calibration.templates ?? {}).length} notes)`);
  return { flashcards: isProgress(flashcards) ? flashcards : null, calibration, summary: parts.join(' and ') };
}

export function applyImport({ flashcards, calibration }) {
  if (flashcards) replaceProgress(flashcards);
  if (calibration) {
    saveTemplates(calibration.templates ?? null);
    calibrationDoc.onPull(calibrationDoc.local);
  }
}

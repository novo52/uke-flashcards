// The top bar's data controls, built into each page's #account: a Sync button and a menu with the account, Drive options, and JSON export and import.
import { Drive, AuthError } from './drive.js';
import { allDocs, exportData, parseImport, applyImport } from './documents.js';

const CLIENT_ID = '159556833977-69oipcnih4ovl5ug8pl4vg100i2cnlg1.apps.googleusercontent.com';
const SYNC_DELAY_MS = 3000; // after a save, so a burst of saves makes one upload
const WAITING_RETRY_MS = 30_000;
const SIGNED_IN_LABELS = ['Sync', 'Syncing…', 'Saving…', 'Synced'];

const MARKUP = `
  <button id="syncButton" class="primary">Sync with Google</button>
  <details id="accountMenu">
    <summary title="Account and data">⋯</summary>
    <div>
      <p id="accountEmail"></p>
      <p id="accountText"></p>
      <button id="disconnect" title="This browser stops syncing and forgets the account; your files stay in Google Drive">Disconnect Google</button>
      <button id="deleteRemote" title="Removes this site's files from your Google Drive and disconnects">Delete my data from Google Drive</button>
      <hr>
      <button id="exportData" title="Download your flashcard progress and calibration">Export data (JSON)</button>
      <button id="importData" title="Replace your data with an exported file">Import data (JSON)</button>
      <input id="importFile" type="file" accept=".json,application/json" hidden>
    </div>
  </details>`;

// Call `start()` once the page can take documents from Drive. Returns { drive, syncAll, scheduleSync, start }.
export function setupAccount({ setStatus = () => {} } = {}) {
  const root = document.getElementById('account');
  root.innerHTML = MARKUP;
  const $ = (id) => document.getElementById(id);
  const ui = { sync: $('syncButton'), menu: $('accountMenu'), email: $('accountEmail'), text: $('accountText'), disconnect: $('disconnect'), deleteRemote: $('deleteRemote') };
  const drive = new Drive({ clientId: CLIENT_ID, onChange: () => render() });
  let syncing = null;
  let again = false;
  let error = null;
  let lastSync = null;
  let timer = null;

  function syncAll() {
    if (!drive.connected) {
      render();
      return Promise.resolve();
    }
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          again = false;
          for (const doc of allDocs) await doc.sync(drive);
        } while (again);
        lastSync = Date.now();
        error = null;
      } catch (err) {
        error = err instanceof AuthError ? null : err.message;
      } finally {
        syncing = null;
        render();
      }
    })();
    render();
    return syncing;
  }

  function scheduleSync() {
    clearTimeout(timer);
    if (drive.connected) timer = setTimeout(syncAll, SYNC_DELAY_MS);
    render();
  }

  // Must run straight from a click: see Drive.connect.
  function connectAndSync() {
    drive.connect()
      .then(syncAll)
      .catch((err) => {
        error = err.message;
        setStatus(err.message);
        render();
      });
  }

  function render() {
    const email = drive.email;
    const dirty = allDocs.some((d) => d.dirty);
    const waiting = allDocs.some((d) => d.waiting);
    let label;
    let text;
    if (error) [label, text] = [email ? 'Sync' : 'Sync with Google', error];
    else if (!email) [label, text] = ['Sync with Google', 'Your data is saved in this browser. Sync with Google to keep a copy in your Google Drive.'];
    else if (!drive.connected) [label, text] = ['Sync', dirty ? 'Changes not synced yet.' : 'Click Sync to reconnect.'];
    else if (syncing) [label, text] = ['Syncing…', 'Syncing with Google Drive…'];
    else if (waiting) [label, text] = ['Synced', 'Newer progress on Google Drive loads when you stop listening.'];
    else if (dirty) [label, text] = ['Saving…', 'Saving to Google Drive…'];
    else [label, text] = ['Synced', `Synced with Google Drive${lastSync ? ` at ${new Date(lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`];
    // Every signed-in label sits in the button, hidden but the shown one, so its width holds while the label changes.
    const labels = email ? SIGNED_IN_LABELS : [label];
    ui.sync.replaceChildren(...labels.map((l) => Object.assign(document.createElement('span'), { textContent: l, className: l === label ? '' : 'off' })));
    ui.sync.title = text;
    // Signed in and up to date: nothing to click.
    ui.sync.classList.toggle('primary', !drive.connected || !!error);
    ui.sync.classList.toggle('warn', !!error || (!!email && !drive.connected && dirty));
    ui.email.textContent = email ?? 'Not signed in';
    ui.text.textContent = text;
    ui.disconnect.hidden = !email;
    ui.deleteRemote.hidden = !email;
  }

  // A visitor who has not signed in contacts Google only on this click; if loading the script outlasts the click's popup allowance, the error asks for a second click.
  ui.sync.addEventListener('click', connectAndSync);
  ui.disconnect.addEventListener('click', async () => {
    ui.menu.open = false;
    await drive.disconnect();
    error = null;
    setStatus('Disconnected from Google. Your data stays in this browser; your files stay in Google Drive.');
  });
  ui.deleteRemote.addEventListener('click', () => {
    ui.menu.open = false;
    if (!confirm("Delete this site's files (flashcard progress and calibration) from your Google Drive? Your data in this browser is kept.")) return;
    drive.connect()
      .then(async () => {
        clearTimeout(timer);
        await syncing;
        await drive.deleteAll();
        await drive.disconnect();
        error = null;
        setStatus('Deleted from Google Drive and disconnected. Your data stays in this browser.');
      })
      .catch((err) => {
        error = err.message;
        setStatus(err.message);
        render();
      });
  });
  $('exportData').addEventListener('click', () => {
    ui.menu.open = false;
    const blob = new Blob([JSON.stringify(exportData())], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `uke-flashcards-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('importData').addEventListener('click', () => {
    ui.menu.open = false;
    $('importFile').click();
  });
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (!file) return;
    const parsed = parseImport(await file.text());
    if (!parsed) return setStatus(`${file.name} holds no flashcard progress or calibration.`);
    if (!confirm(`Import the ${parsed.summary} in ${file.name}? It replaces what this browser holds now.${parsed.flashcards ? ' The current progress is kept as a backup.' : ''}`)) return;
    applyImport(parsed);
    scheduleSync();
    setStatus(`Imported ${parsed.summary} from ${file.name}.`);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncAll();
  });
  setInterval(() => {
    if (allDocs.some((d) => d.waiting)) syncAll();
  }, WAITING_RETRY_MS);

  render();
  // A returning user has already chosen Google, so its script can load now.
  if (drive.email) drive.prepare().catch(() => {});

  // A token kept from earlier in this tab syncs at once.
  const start = () => syncAll();
  return { drive, syncAll, scheduleSync, start };
}

// Documents kept in browser storage first and copied to Drive as <file> when signed in. Each pair of copies is reconciled by `newer`: the copy that supersedes the other replaces it.

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// Which way a sync goes: 'pull' (Drive's copy replaces this device's), 'push', or null when neither supersedes the other.
export function direction(local, remote, newer) {
  if (remote && (!local || newer(remote, local))) return 'pull';
  if (local && (!remote || newer(local, remote))) return 'push';
  return null;
}

export class SyncedDoc {
  // `canPull()` false defers taking Drive's copy (as during a lesson); `onPull(data)` shows a copy that came from Drive.
  constructor({ key, file, newer, canPull = () => true, onPull = () => {} }) {
    Object.assign(this, { key, file, newer, canPull, onPull });
    this.dirtyKey = `${key}.dirty`;
    this.waiting = false; // Drive holds a newer copy that could not be taken yet
  }

  get local() {
    try { return JSON.parse(storage.get(this.key)); } catch { return null; }
  }

  get dirty() { return storage.get(this.dirtyKey) === '1'; }

  save(data) {
    storage.set(this.key, data == null ? null : JSON.stringify(data));
    storage.set(this.dirtyKey, '1');
  }

  async sync(drive) {
    const remote = await drive.readJson(this.file);
    let raw = storage.get(this.key);
    const local = this.local;
    this.waiting = false;
    switch (direction(local, remote, this.newer)) {
      case 'pull':
        if (!this.canPull()) {
          this.waiting = true;
          return;
        }
        raw = JSON.stringify(remote);
        storage.set(this.key, raw);
        this.onPull(remote);
        break;
      case 'push':
        await drive.writeJson(this.file, local);
        break;
    }
    // A save made while the requests were in flight is still unsynced.
    if (storage.get(this.key) === raw) storage.set(this.dirtyKey, null);
  }
}

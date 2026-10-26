// Google sign-in and JSON files in the user's Drive app-data folder, called straight from the browser with no server. Google's script is loaded only when sign-in is wanted, so a visitor who never signs in sends nothing to Google.

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = `${DRIVE_SCOPE} openid email`;
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const EMAIL_KEY = 'drive.email';
// The access token lasts an hour; keeping it for the tab's session spares a click on every reload.
const TOKEN_KEY = 'drive.token';
const EXPIRY_MARGIN_MS = 60_000;

const storage = (area) => ({
  get(k) { try { return area().getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) area().removeItem(k); else area().setItem(k, v); } catch { /* storage unavailable */ } },
});
const local = storage(() => localStorage);
const session = storage(() => sessionStorage);

export class AuthError extends Error {}

export class Drive {
  constructor({ clientId, onChange = () => {} }) {
    this.clientId = clientId;
    this.onChange = onChange;
    this.gis = null; // promise of google.accounts.oauth2
    this.tokenClient = null;
    this.pending = null;
    this.fileIds = new Map();
    try { this.token = JSON.parse(session.get(TOKEN_KEY)); } catch { this.token = null; }
  }

  get email() { return local.get(EMAIL_KEY); }
  get connected() { return !!this.token && Date.now() < this.token.expiresAt - EXPIRY_MARGIN_MS; }

  // Loads Google's script ahead of a click, so the click can open the popup at once.
  prepare() {
    this.gis ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = () => {
        const oauth2 = window.google.accounts.oauth2;
        this.tokenClient = oauth2.initTokenClient({
          client_id: this.clientId,
          scope: SCOPES,
          callback: (resp) => this.onToken(resp),
          error_callback: (err) => this.finish(new AuthError(err.type === 'popup_closed' ? 'Sign-in was closed.' : err.type === 'popup_failed_to_open' ? 'The sign-in popup was blocked. Click again.' : `Sign-in failed (${err.type}).`)),
        });
        resolve(oauth2);
      };
      s.onerror = () => {
        this.gis = null;
        reject(new AuthError('Could not load Google sign-in.'));
      };
      document.head.append(s);
    });
    return this.gis;
  }

  // Call straight from a click handler: browsers block the popup if the page waits on anything first. After the first consent, `prompt: ''` with the remembered account closes the popup by itself.
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.pending = { promise, resolve, reject };
    const request = () => {
      const email = this.email;
      this.tokenClient.requestAccessToken(email ? { prompt: '', login_hint: email } : { prompt: 'select_account' });
    };
    if (this.tokenClient) request();
    else this.prepare().then(request, (err) => this.finish(err));
    return promise;
  }

  async onToken(resp) {
    if (resp.error) return this.finish(new AuthError(`Sign-in failed: ${resp.error}`));
    // Google's consent screen lets the user untick individual permissions.
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      return this.finish(new AuthError('Google Drive access was not granted. Sign in again and tick the Drive permission to sync.'));
    }
    this.setToken({ access: resp.access_token, expiresAt: Date.now() + resp.expires_in * 1000 });
    try {
      if (!this.email) {
        const info = await this.api('https://openidconnect.googleapis.com/v1/userinfo');
        local.set(EMAIL_KEY, info.email);
      }
      this.finish(null);
    } catch (err) {
      this.finish(err);
    }
  }

  finish(err) {
    const p = this.pending;
    this.pending = null;
    if (err) p?.reject(err);
    else p?.resolve();
    this.onChange();
  }

  setToken(token) {
    this.token = token;
    session.set(TOKEN_KEY, token ? JSON.stringify(token) : null);
    this.onChange();
  }

  // Revokes this site's access and forgets the account on this device. Synced files stay in Drive.
  async disconnect() {
    if (this.connected) {
      const oauth2 = await this.prepare();
      await new Promise((resolve) => oauth2.revoke(this.token.access, resolve));
    }
    local.set(EMAIL_KEY, null);
    this.fileIds.clear();
    this.setToken(null);
  }

  async api(url, opts = {}) {
    if (!this.connected) throw new AuthError('Not signed in.');
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${this.token.access}`, ...opts.headers } });
    if (res.status === 401) {
      this.setToken(null);
      throw new AuthError('Google sign-in expired.');
    }
    if (!res.ok) throw Object.assign(new Error(`Google Drive: HTTP ${res.status}`), { status: res.status });
    return res.status === 204 ? null : res.json();
  }

  async list() {
    const { files } = await this.api(`${DRIVE}/files?spaces=appDataFolder&fields=files(id,name)&pageSize=100`);
    for (const f of files) this.fileIds.set(f.name, f.id);
    return files;
  }

  async fileId(name) {
    if (!this.fileIds.has(name)) {
      const q = encodeURIComponent(`name='${name}'`);
      const { files } = await this.api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
      this.fileIds.set(name, files[0]?.id ?? null);
    }
    return this.fileIds.get(name);
  }

  async readJson(name) {
    const id = await this.fileId(name);
    if (!id) return null;
    try {
      return await this.api(`${DRIVE}/files/${id}?alt=media`);
    } catch (err) {
      if (err.status !== 404) throw err;
      this.fileIds.set(name, null);
      return null;
    }
  }

  async writeJson(name, data) {
    const id = await this.fileId(name);
    if (id) {
      try {
        await this.api(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        return;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const boundary = `b${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name, parents: ['appDataFolder'] }),
      `--${boundary}`, 'Content-Type: application/json', '', JSON.stringify(data),
      `--${boundary}--`,
    ].join('\r\n');
    const created = await this.api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    this.fileIds.set(name, created.id);
  }

  // Deletes every file this site keeps in the user's Drive.
  async deleteAll() {
    for (const f of await this.list()) await this.api(`${DRIVE}/files/${f.id}`, { method: 'DELETE' });
    this.fileIds.clear();
  }
}

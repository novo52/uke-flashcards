# Uke Flashcards

Ukulele chord flashcards in the manner of [keybr.com](https://www.keybr.com): play chord progressions from memory while the page listens through the microphone. A static site with no server: progress and calibration live in the browser and, after signing in with Google, in the user's Google Drive app-data folder.

## Running

```sh
npm start   # http://localhost:8001 (the OAuth client's authorized origin)
npm test
```

Open it in a desktop browser on the machine with the microphone. Under WSL, use the Windows browser.

## Files

| Path | Contents |
|---|---|
| `index.html`, `app.js` | The flashcards |
| `calibrate.html`, `calibrate.js` | Calibration: while on, every single note plucked is learned, and each position on the drawn ukulele fills as its pitch is learned; *Finish calibration* (or stopping the microphone) saves it |
| `ukulele.js` | The drawn ukulele (SVG), strings in tablature order: A on top |
| `mic.js` | Microphone and analyzer worklet; the chosen microphone and gate are kept in `uke.audio.v1` |
| `style.css` | Styles shared by the pages |
| `sync/account.js` | The top bar's Sync button and ⋯ menu (account, Drive options, JSON export and import) and the sync loop |
| `sync/drive.js` | Google sign-in (Google Identity Services token client) and JSON files in the Drive app-data folder |
| `sync/docs.js` | Documents kept in `localStorage` and copied to Drive; the copy that supersedes the other replaces it |
| `sync/documents.js` | The synced documents, shared by both pages, and JSON export and import (an export, or the uke app's `progress/flashcards.json`) |
| `privacy.html` | Privacy policy (draft) |
| `fonts/` | Open Sans (OFL) and Ubuntu Mono (Ubuntu Font Licence), served from the site |
| `analyzer-worklet.js`, `dsp/`, `game/`, `data/` | Copied from the uke app by `npm run sync-from-uke`; edit them there |

## Sync

| Document | Browser key | Drive file | Newer copy |
|---|---|---|---|
| Flashcard progress | `uke.flashcards.v2` | `flashcards.json` | Higher `revision` |
| Backup made by *Reset* | `uke.flashcards.backup` | `flashcards-backup.json` | Later `backedUpAt` |
| Calibration | `uke.templates.v1` | `calibration.json` | Later `savedAt` |

Every save writes the browser copy at once and syncs 3 s later while a token is valid. Syncing also runs on load and when the tab becomes visible. Drive's progress replaces the browser's only while no lesson runs; a newer copy found during a lesson loads after listening stops. Calibration that arrives while the flashcards' microphone is on applies when it restarts; the calibration page takes it only while no calibration runs.

Progress from two devices does not merge: the copy with the higher revision replaces the other, so lessons played on a device that has not synced since the other's last lesson are lost.

Google's script loads only when the pointer reaches the sign-in button or, for a returning user, on load. The access token lasts an hour and is kept in `sessionStorage` until it expires; after that one click renews it (`prompt: ''` with the remembered account as `login_hint`).

## Google Cloud

The OAuth client (`CLIENT_ID` in `app.js`) is a Web application client in the dancey.net project, with authorized JavaScript origin `http://localhost:8001`. Publishing needs the site's origin added there, the consent screen moved from *Testing* to *In production*, and brand verification: dancey.net verified in Google Search Console, a homepage titled dancey.net, and this privacy policy.

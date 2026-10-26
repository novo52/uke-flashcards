# Uke Flashcards

Ukulele chord flashcards in the manner of [keybr.com](https://www.keybr.com): play chord progressions from memory while the page listens through the microphone. A static site with no server: progress and calibration live in the browser and, after signing in with Google, in the user's Google Drive app-data folder.

## Running

```sh
npm start   # http://localhost:8001 (the OAuth client's authorized origin)
npm test    # Node; synthesised ukulele audio, chord naming, flashcard rules, sync and import
npm run fetch-fingerings                          # rebuilds data/uke-fingerings.json
npm run build-chord-chain -- chordonomicon_v2.csv # rebuilds data/chord-chain.json
```

Open it in a desktop browser on the machine with the microphone. Under WSL, use the Windows browser so the microphone comes through Windows audio. No dependencies beyond Node (for tests and tools) and Python (for the dev server).

## Using it

- **Flashcards** (`index.html`): click the line or press Space to start listening, then play the underlined chord from memory. Esc stops; a lesson stopped part way is not counted.
- **Calibrate** (`calibrate.html`): start the microphone, press *Calibrate*, and pluck single notes two or three times each, letting them ring. Each position on the drawn ukulele fills as its pitch is learned (the same pitch on two strings fills both); notes skipped keep the generic sound. *Finish calibration*, or stopping the microphone, saves it.
- **Sync** and the **⋯** menu in the top bar: sign in with Google to keep a copy in Drive; the menu disconnects, deletes the Drive copy, and exports or imports all data as JSON.

## Flashcard rules

Rules are in `game/cards.js`:

| Rule | Source |
|---|---|
| A chord's time is its change time: from the previous right strum to its own. Its times are averaged per lesson and smoothed across lessons (exponential filter, alpha 0.1). Confidence is the target time over that time. | keybr (per-key time to type, the same filter) |
| Chords unlock in a fixed order (C, Am, F, G, G7, Dm, Em, A7, D, A, C7, E7, …), two at first, then the next one as soon as every unlocked chord has reached the target speed at its best. | keybr |
| The least confident unlocked chord below the target is focused (outlined in *All chords*), and every progression in a lesson contains it. A new chord is focused until played. | keybr (every generated word holds the focused key) |
| Lessons are phrases generated as keybr generates words: a walk over an order-4 chain counted from about 680,000 songs' chord progressions in Chordonomicon, keeping only unlocked chords; a context with no unlocked continuation backs off to fewer chords. A phrase is 3 to 8 chords. *Favour slow changes* makes changes slower than the target come up up to 3 times as often. | keybr (order-4 letter chain); [One Minute Changes](https://justinguitar.com/guitar-lessons/one-minute-changes-exercise-b1-110) |
| The shape stays hidden until Space, a wrong chord, or 6 s; the chord then counts as a miss and its time is left out. A strum heard as the chord just played, or within 0.25 s of it, is ignored. A chord never played before shows its shape. | Retrieval practice with corrective feedback (Roediger & Karpicke 2006) |
| A chord not played for a while is taken to have slowed: its time grows by up to half, about two-thirds of that after 14 days. The first lesson after a break moves the smoothed time further towards what is played. | Not in keybr |

*Metrics* shows the last lesson's speed in changes per minute (cpm), accuracy and score (speed × chords ÷ (misses + 1), as keybr's), each against the average of earlier lessons. *Target speed* sets the speed every chord must reach (30 cpm by default).

The chain is `data/chord-chain.json`, built by `npm run build-chord-chain` from the [Chordonomicon CSV](https://huggingface.co/datasets/ailsntua/Chordonomicon) (CC BY-NC 4.0: Kantarelis et al., arXiv:2410.22046). Its vocabulary is the flashcard `CURRICULUM`, so rebuild it after changing that list. Fingerings in diagrams come from [chords-db](https://github.com/tombatossals/chords-db) (MIT), stored in `data/uke-fingerings.json`; voicings it does not list get an estimated fingering.

## How detection works

All analysis runs in an AudioWorklet (`analyzer-worklet.js`) on the audio thread, timed on the AudioContext sample clock; only results leave it. The DSP in `dsp/` is plain JS and also runs under Node for the tests.

| Stage | Method | File |
|---|---|---|
| Attacks | SuperFlux onset detection, 21 ms window, 5.3 ms hop | `onset.js` |
| Notes | Non-negative decomposition (β = 0.5) of semitone-band spectra onto per-note templates | `decompose.js` |
| Windowing | After each attack, only audio since the attack is analysed (43–85 ms windows) | `analyzer.js` |
| Chords | Pitch-class template matching over 17 chord qualities with a simplicity prior; a note an octave and a fifth (or two octaves and a third) above a much stronger note counts as its partial | `chords.js`, `analyzer.js` |
| Calibration labels | Harmonic-summation multi-pitch estimation (template-free) | `pitch.js` |

A strum's chord is read 150 ms after the attack, since fingers that land after the pick leave open strings sounding for up to ~150 ms; if a different complete chord holds for 50 ms within 400 ms, a correction replaces it. Calibration learns from the first 0.4 s after each attack of a single clear note; a note needs 20 such frames to be installed, and 100 count as fully learned. Notes need 10 dB above the room's noise floor and the minimum level (*Too quiet or too noisy?* on the calibration page).

## Files

| Path | Contents |
|---|---|
| `index.html`, `app.js` | The flashcards |
| `calibrate.html`, `calibrate.js` | Calibration |
| `ukulele.js` | The drawn ukulele (SVG), strings in tablature order: A on top |
| `mic.js` | Microphone and analyzer worklet; the chosen microphone and minimum level are kept in `uke.audio.v1` |
| `analyzer-worklet.js`, `dsp/` | Detection |
| `game/cards.js` | Flashcard rules and the flashcard view |
| `game/shapes.js`, `game/diagram.js`, `game/score.js` | Chord shapes and fingerings, chord diagrams, chord comparison |
| `style.css` | Styles shared by the pages |
| `sync/account.js` | The top bar's Sync button and ⋯ menu, and the sync loop |
| `sync/drive.js` | Google sign-in (Google Identity Services token client) and JSON files in the Drive app-data folder |
| `sync/docs.js` | Documents kept in `localStorage` and copied to Drive; the copy that supersedes the other replaces it |
| `sync/documents.js` | The synced documents, shared by both pages, and JSON export and import |
| `privacy.html` | Privacy policy (draft) |
| `fonts/` | Open Sans (OFL) and Ubuntu Mono (Ubuntu Font Licence), served from the site |
| `data/` | Generated: chord chain and fingerings (see *Running*) |
| `tools/` | The generators for `data/` |
| `test/` | Node tests; `synth.js` synthesises ukulele audio |

## Sync

| Document | Browser key | Drive file | Newer copy |
|---|---|---|---|
| Flashcard progress | `uke.flashcards.v2` | `flashcards.json` | Higher `revision` |
| Backup made by *Reset* or an import | `uke.flashcards.backup` | `flashcards-backup.json` | Later `backedUpAt` |
| Calibration | `uke.templates.v1` | `calibration.json` | Later `savedAt` |

Every save writes the browser copy at once and syncs 3 s later while a token is valid. The first save on a page asks the browser for persistent storage (`navigator.storage.persist()`), so low disk space does not evict it; Firefox asks the user. Syncing also runs on load and when the tab becomes visible. Drive's progress replaces the browser's only while no lesson runs; a newer copy found during a lesson loads after listening stops. Calibration that arrives while the flashcards' microphone is on applies when it restarts; the calibration page takes it only while no calibration runs.

Progress from two devices does not merge: the copy with the higher revision replaces the other, so lessons played on a device that has not synced since the other's last lesson are lost.

Google's script loads only when the pointer reaches the Sync button or, for a returning user, on load. The access token lasts an hour and is kept in `sessionStorage` until it expires; after that one click renews it (`prompt: ''` with the remembered account as `login_hint`).

Export writes `{ app: 'uke-flashcards', exportedAt, flashcards, calibration }`. Import takes that, or a bare progress file (format version 1 or 2).

## Google Cloud

The OAuth client (`CLIENT_ID` in `sync/account.js`) is a Web application client in the dancey.net project, with authorized JavaScript origin `http://localhost:8001` and scopes `drive.appdata`, `openid` and `userinfo.email`. Publishing needs the site's origin added there, the consent screen moved from *Testing* to *In production*, and brand verification: dancey.net verified in Google Search Console, a homepage titled dancey.net, and this privacy policy.

## References

- A. Dessein, A. Cont, G. Lemaitre, "Real-time polyphonic music transcription with non-negative matrix factorization and beta-divergence", ISMIR 2010.
- S. Böck, G. Widmer, "Maximum filter vibrato suppression for onset detection" (SuperFlux), DAFx 2013.
- A. Klapuri, "Multiple fundamental frequency estimation by summing harmonic amplitudes", ISMIR 2006.
- H. L. Roediger, J. D. Karpicke, "Test-enhanced learning", Psychological Science 17, 2006.
- [keybr.com source](https://github.com/aradzie/keybr.com): `packages/keybr-lesson/lib/guided.ts` (unlocking and focus), `packages/keybr-phonetic-model` (word generation), `packages/keybr-result/lib/keystats.ts` (per-key filter).

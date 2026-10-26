// The microphone and the analyzer worklet (analyzer-worklet.js). Sound is analysed in the browser and never leaves it.

const PREFS_KEY = 'uke.audio.v1'; // { deviceId, gateDb } for this browser only
export const DEFAULT_GATE_DB = -55;

export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; }
}

export function savePrefs(changes) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...changes })); } catch { /* kept for this page only */ }
}

export class Microphone {
  // `onFrame(frame)`: each analysis frame. `onCalibration(minMidi, counts)`: frames gathered per note while calibrating. `onTemplates(templates)`: what calibration learned, when it stops. `onChange()`: started or stopped.
  constructor({ onFrame = () => {}, onCalibration = () => {}, onTemplates = () => {}, onChange = () => {} } = {}) {
    Object.assign(this, { onFrame, onCalibration, onTemplates, onChange });
    this.audio = null; // { ctx, node, stream, source }
    this.label = '';
    this.calibrating = false;
    this.latest = null; // newest analysis frame
    // Audio clock minus performance clock. Frames arrive slightly after their timestamp; the largest offset seen is the least-delayed estimate.
    this.clockOffset = -Infinity;
  }

  get on() { return !!this.audio; }
  get node() { return this.audio?.node ?? null; }
  get gateDb() { return loadPrefs().gateDb ?? DEFAULT_GATE_DB; }

  // The analyzer's audio clock now, estimated from the frames received.
  clock() {
    return Number.isFinite(this.clockOffset) ? performance.now() / 1000 + this.clockOffset : 0;
  }

  async start(templates) {
    if (this.audio) return this.audio;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule('analyzer-worklet.js');
      const node = new AudioWorkletNode(ctx, 'uke-analyzer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { gateDb: this.gateDb, templates, record: false },
      });
      node.port.onmessage = ({ data }) => this.onMessage(data);
      node.connect(ctx.destination); // keeps the node scheduled; it outputs silence
      this.audio = { ctx, node, stream: null, source: null };
      this.clockOffset = -Infinity;
      await this.openInput(loadPrefs().deviceId ?? '');
    } catch (err) {
      ctx.close();
      this.audio = null;
      throw err;
    }
    this.onChange();
    return this.audio;
  }

  async stop() {
    if (!this.audio) return;
    const { ctx, stream } = this.audio;
    const wasCalibrating = this.calibrating;
    if (wasCalibrating) this.calibrate(false);
    stream?.getTracks().forEach((t) => t.stop());
    setTimeout(() => ctx.close(), wasCalibrating ? 500 : 0); // let learned templates arrive
    this.audio = null;
    this.latest = null;
    this.onChange();
  }

  async openInput(deviceId) {
    const { ctx, node } = this.audio;
    this.audio.stream?.getTracks().forEach((t) => t.stop());
    this.audio.source?.disconnect();
    // Voice processing (echo cancellation, noise suppression, AGC) distorts music and adds latency.
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: deviceId ? { exact: deviceId } : undefined } });
    } catch (err) {
      // A remembered microphone that is unplugged falls back to the default.
      if (!deviceId || err.name !== 'OverconstrainedError') throw err;
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    }
    this.audio.stream = stream;
    this.audio.source = ctx.createMediaStreamSource(stream);
    this.audio.source.connect(node);
    this.label = stream.getAudioTracks()[0]?.label || 'Microphone';
  }

  async setDevice(deviceId) {
    savePrefs({ deviceId });
    if (this.audio) await this.openInput(deviceId);
  }

  // Audio inputs, with the one in use marked `current`. Labels are only available once the microphone has been allowed.
  async devices() {
    const current = this.audio?.stream?.getAudioTracks()[0]?.getSettings().deviceId;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    return inputs.map((d) => ({ id: d.deviceId, label: d.label || 'Microphone', current: d.deviceId === current }));
  }

  setGate(gateDb) {
    savePrefs({ gateDb });
    this.audio?.node.port.postMessage({ type: 'configure', gateDb });
  }

  calibrate(on) {
    this.calibrating = on;
    this.audio?.node.port.postMessage({ type: 'calibrate', on });
  }

  resetTemplates() {
    this.audio?.node.port.postMessage({ type: 'resetTemplates' });
  }

  onMessage(data) {
    if (data.type === 'frames') {
      for (const f of data.frames) {
        const sample = f.t - performance.now() / 1000;
        this.clockOffset = sample > this.clockOffset ? sample : this.clockOffset + (sample - this.clockOffset) * 0.002;
        this.latest = f;
        this.onFrame(f);
      }
    } else if (data.type === 'calibration') this.onCalibration(data.minMidi, data.counts);
    else if (data.type === 'templates') this.onTemplates(data.templates);
  }
}

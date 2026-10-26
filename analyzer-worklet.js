// Runs the analysis on the audio rendering thread, so results are timed on
// the AudioContext sample clock and never wait behind UI work.
import { Analyzer } from './dsp/analyzer.js';

const PROGRESS_EVERY = 40; // render quanta between calibration progress reports
const CAPTURE_CHUNK = 16384; // recorded samples per message (a multiple of the 128-sample quantum)

class UkeAnalyzerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions ?? {};
    this.analyzer = new Analyzer(sampleRate, opts);
    this.analyzer.decomposer.importTemplates(opts.templates);
    this.quanta = 0;
    this.setRecording(Boolean(opts.record));
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  onMessage(data) {
    const { analyzer } = this;
    switch (data.type) {
      case 'configure':
        analyzer.configure(data);
        break;
      case 'calibrate':
        if (data.on) analyzer.startCalibration();
        else this.port.postMessage({ type: 'templates', templates: analyzer.stopCalibration() });
        break;
      case 'resetTemplates':
        analyzer.decomposer.resetTemplates();
        break;
      case 'record':
        this.setRecording(data.on);
        break;
    }
  }

  // Recording sends the page exactly the samples the analyzer receives,
  // tagged with the sample-clock frame of the first one.
  setRecording(on) {
    if (!on && this.capture) {
      this.flushCapture();
      this.port.postMessage({ type: 'recordStopped' });
    }
    this.capture = on ? new Float32Array(CAPTURE_CHUNK) : null;
    this.captureLength = 0;
    this.captureFrame = 0;
  }

  record(channel) {
    if (this.captureLength && this.captureFrame + this.captureLength !== currentFrame) this.flushCapture();
    if (!this.captureLength) this.captureFrame = currentFrame;
    this.capture.set(channel, this.captureLength);
    this.captureLength += channel.length;
    if (this.captureLength + channel.length > CAPTURE_CHUNK) this.flushCapture();
  }

  flushCapture() {
    if (!this.capture || !this.captureLength) return;
    const samples = this.capture.subarray(0, this.captureLength);
    this.port.postMessage({ type: 'audio', frame: this.captureFrame, samples }, [this.capture.buffer]);
    this.capture = new Float32Array(CAPTURE_CHUNK);
    this.captureLength = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    if (this.capture) this.record(channel);
    const frames = this.analyzer.push(channel, currentFrame);
    if (frames.length) this.port.postMessage({ type: 'frames', frames });
    if (this.analyzer.calibrating && ++this.quanta % PROGRESS_EVERY === 0) {
      const { decomposer } = this.analyzer;
      this.port.postMessage({ type: 'calibration', minMidi: decomposer.minMidi, counts: decomposer.calibrationCounts() });
    }
    return true;
  }
}

registerProcessor('uke-analyzer', UkeAnalyzerProcessor);

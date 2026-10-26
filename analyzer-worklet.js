// Runs the analysis on the audio rendering thread, so results are timed on
// the AudioContext sample clock and never wait behind UI work. Only analysis
// results leave this thread; the samples themselves are never kept.
import { Analyzer } from './dsp/analyzer.js';

const PROGRESS_EVERY = 40; // render quanta between calibration progress reports

class UkeAnalyzerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions ?? {};
    this.analyzer = new Analyzer(sampleRate, opts);
    this.analyzer.decomposer.importTemplates(opts.templates);
    this.quanta = 0;
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
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
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

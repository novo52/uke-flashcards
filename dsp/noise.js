// Room noise level: the quietest frame level over the last few seconds of
// updates (minimum statistics over half-second blocks). The caller feeds only
// frames taken while the instrument is not being played, so a ringing chord
// never counts as noise and the estimate holds while playing continues.
// Digital silence (a muted input) is ignored.
export class NoiseFloor {
  constructor(framesPerSecond, { blockSec = 0.5, blocks = 16, initialDb = -60 } = {}) {
    this.blockFrames = Math.max(1, Math.round(blockSec * framesPerSecond));
    this.mins = new Float64Array(blocks).fill(Infinity);
    this.pos = 0;
    this.count = 0;
    this.current = Infinity;
    this.initialDb = initialDb;
  }

  update(levelDb) {
    if (levelDb > -150 && levelDb < this.current) this.current = levelDb;
    if (++this.count === this.blockFrames) {
      this.mins[this.pos] = this.current;
      this.pos = (this.pos + 1) % this.mins.length;
      this.current = Infinity;
      this.count = 0;
    }
  }

  get db() {
    let m = this.current;
    for (let i = 0; i < this.mins.length; i++) if (this.mins[i] < m) m = this.mins[i];
    return Number.isFinite(m) ? m : this.initialDb;
  }
}

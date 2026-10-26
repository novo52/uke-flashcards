// Radix-2 FFT with preallocated buffers, so the audio thread never allocates.
export class FFT {
  constructor(size) {
    if (size & (size - 1)) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / size);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / size);
    }
  }

  // Writes |X[k]| for k = 0..size/2 into `out` from real input `input`.
  magnitude(input, out) {
    const { size, re, im, rev, cos, sin } = this;
    for (let i = 0; i < size; i++) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step];
          const wi = sin[j * step];
          const a = start + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= size / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
}

export function hann(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

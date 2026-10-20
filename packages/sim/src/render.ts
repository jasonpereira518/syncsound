import { OfflineAudioContext } from 'node-web-audio-api';

/** Render one device's output: a buffer source started with source.start(when, offset) in an offline context. */
export async function renderDevice(p: {
  track: Float32Array;
  sampleRate: number;
  when: number;
  offset: number;
  lengthSec: number;
}): Promise<Float32Array> {
  const length = Math.ceil(p.lengthSec * p.sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: p.sampleRate });
  const buf = ctx.createBuffer(1, p.track.length, p.sampleRate);
  buf.copyToChannel(p.track as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(p.when, p.offset);
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice();
}

/**
 * Map a rendered buffer (indexed by the device's ctx time) onto the true room timeline:
 * y[j] = x(ctxOf(gridStartT + j/fs − latency) · fs), linear interpolation.
 */
export function toRoomTimeline(
  rendered: Float32Array,
  sampleRate: number,
  ctxOfTrueMs: (T: number) => number,
  latencyMs: number,
  gridStartT: number,
  n: number,
): Float64Array {
  const y = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const pos = ctxOfTrueMs(gridStartT + (j / sampleRate) * 1000 - latencyMs) * sampleRate;
    const i = Math.floor(pos);
    const f = pos - i;
    if (i >= 0 && i + 1 < rendered.length) y[j] = rendered[i]! * (1 - f) + rendered[i + 1]! * f;
  }
  return y;
}

/** in-place iterative radix-2 complex FFT (re/im length = power of 2); inverse if `inv` */
function fft(re: Float64Array, im: Float64Array, inv = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inv) {
    for (let i = 0; i < n; i++) {
      re[i]! /= n;
      im[i]! /= n;
    }
  }
}

/**
 * Lag L (samples, sub-sample via parabolic interpolation) maximising the cross-correlation, i.e. b[n] ≈ a[n − L]:
 * positive L means b is *later* than a. Searches |L| ≤ maxLag.
 */
export function xcorrLag(a: ArrayLike<number>, b: ArrayLike<number>, maxLag: number): number {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < a.length; i++) ar[i] = a[i]!;
  for (let i = 0; i < b.length; i++) br[i] = b[i]!;
  fft(ar, ai);
  fft(br, bi);
  // r[L] = Σ b[n]·a[n − L]  ⇔  B · conj(A)
  for (let k = 0; k < n; k++) {
    const r = br[k]! * ar[k]! + bi[k]! * ai[k]!;
    const i = bi[k]! * ar[k]! - br[k]! * ai[k]!;
    br[k] = r;
    bi[k] = i;
  }
  fft(br, bi, true);
  const at = (L: number) => br[(L + n) % n]!;
  let best = 0;
  for (let L = -maxLag; L <= maxLag; L++) if (at(L) > at(best)) best = L;
  const y0 = at(best - 1);
  const y1 = at(best);
  const y2 = at(best + 1);
  const den = y0 - 2 * y1 + y2;
  return best + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0);
}

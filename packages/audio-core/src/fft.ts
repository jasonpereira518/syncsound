import { todo } from './todo';

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 complex FFT. re/im length must be a power of two. inverse → scaled by 1/N. */
export function fft(_re: Float64Array, _im: Float64Array, _inverse = false): void {
  todo('fft');
}

/** Magnitude (linear) of the first N/2+1 bins of a real signal zero-padded to nfft. */
export function realMagnitude(_signal: Float32Array | Float64Array, _nfft: number): Float64Array {
  return todo('realMagnitude');
}

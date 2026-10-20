import { todo } from './todo';

/** 16-bit PCM WAV (WAVE_FORMAT_EXTENSIBLE with 5.1 mask when 6 channels). */
export function encodeWav(_channels: Float32Array[], _sampleRate: number): Uint8Array {
  return todo('encodeWav');
}

export function decodeWav(_bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  return todo('decodeWav');
}

import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from './wav';

const tone = (n: number, f: number) =>
  Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin((2 * Math.PI * f * i) / 48000));

describe('wav', () => {
  for (const nch of [1, 2, 6]) {
    it(`round-trips ${nch} channel(s) at 16-bit`, () => {
      const chans = Array.from({ length: nch }, (_, c) => tone(1000, 200 * (c + 1)));
      const bytes = encodeWav(chans, 48000);
      const out = decodeWav(bytes);
      expect(out.sampleRate).toBe(48000);
      expect(out.channels).toHaveLength(nch);
      out.channels.forEach((ch, c) =>
        ch.forEach((v, i) => expect(Math.abs(v - chans[c]![i]!)).toBeLessThan(1 / 16384)),
      );
      const v = new DataView(bytes.buffer);
      if (nch === 6) {
        expect(v.getUint16(20, true)).toBe(0xfffe);
        expect(v.getUint32(40, true)).toBe(0x3f);
      } else expect(v.getUint16(20, true)).toBe(1);
    });
  }

  it('clips out-of-range samples and decodes 24-bit and float32', () => {
    expect(decodeWav(encodeWav([new Float32Array([2, -2])], 8000)).channels[0]).toEqual(
      new Float32Array([32767 / 32768, -1]),
    );
    const mk = (format: number, bits: number, body: number[]) => {
      const data = new Uint8Array(body);
      const buf = new Uint8Array(44 + data.length);
      const v = new DataView(buf.buffer);
      buf.set(
        [...'RIFF'].map((c) => c.charCodeAt(0)),
        0,
      );
      v.setUint32(4, 36 + data.length, true);
      buf.set(
        [...'WAVEfmt '].map((c) => c.charCodeAt(0)),
        8,
      );
      v.setUint32(16, 16, true);
      v.setUint16(20, format, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, 44100, true);
      v.setUint32(28, 44100 * (bits / 8), true);
      v.setUint16(32, bits / 8, true);
      v.setUint16(34, bits, true);
      buf.set(
        [...'data'].map((c) => c.charCodeAt(0)),
        36,
      );
      v.setUint32(40, data.length, true);
      buf.set(data, 44);
      return buf;
    };
    // 24-bit: +0.5 (0x400000) and −0.5 (0xC00000)
    const d24 = decodeWav(mk(1, 24, [0, 0, 0x40, 0, 0, 0xc0]));
    expect(Array.from(d24.channels[0]!)).toEqual([0.5, -0.5]);
    const f = new Uint8Array(new Float32Array([0.25, -0.75]).buffer);
    expect(Array.from(decodeWav(mk(3, 32, [...f])).channels[0]!)).toEqual([0.25, -0.75]);
    expect(() => decodeWav(new Uint8Array(4))).toThrow();
  });
});

const KSDATAFORMAT_PCM_GUID_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/** 16-bit PCM WAV (WAVE_FORMAT_EXTENSIBLE with 5.1 mask when 6 channels; extensible, mask 0, for other >2). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nch = channels.length;
  if (!nch) throw new Error('encodeWav: no channels');
  const frames = channels[0]!.length;
  const extensible = nch > 2;
  const fmtLen = extensible ? 40 : 16;
  const dataLen = frames * nch * 2;
  const buf = new Uint8Array(12 + 8 + fmtLen + 8 + dataLen);
  const v = new DataView(buf.buffer);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, buf.length - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, fmtLen, true);
  v.setUint16(20, extensible ? 0xfffe : 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  if (extensible) {
    v.setUint16(36, 22, true); // cbSize
    v.setUint16(38, 16, true); // valid bits
    v.setUint32(40, nch === 6 ? 0x3f : 0, true); // FL FR FC LFE BL BR
    v.setUint16(44, 1, true); // subformat = PCM
    KSDATAFORMAT_PCM_GUID_TAIL.forEach((b, i) => v.setUint8(46 + i, b));
  }
  const d = 20 + fmtLen;
  str(d, 'data');
  v.setUint32(d + 4, dataLen, true);
  let o = d + 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c]![i] ?? 0));
      v.setInt16(o, Math.round(x < 0 ? x * 32768 : x * 32767), true);
      o += 2;
    }
  }
  return buf;
}

/** Decode PCM 16/24/32-bit int or 32-bit float WAV (plain or WAVE_FORMAT_EXTENSIBLE). */
export function decodeWav(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('decodeWav: not a RIFF/WAVE file');
  let fmt: { format: number; nch: number; sampleRate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe) format = v.getUint16(body + 24, true);
      fmt = {
        format,
        nch: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('decodeWav: data before fmt');
      const { format, nch, bits, sampleRate } = fmt;
      const bps = bits / 8;
      const size = Math.min(len, bytes.length - body);
      const frames = Math.floor(size / (bps * nch));
      const channels = Array.from({ length: nch }, () => new Float32Array(frames));
      const read =
        format === 3 && bits === 32
          ? (p: number) => v.getFloat32(p, true)
          : format === 1 && bits === 16
            ? (p: number) => v.getInt16(p, true) / 32768
            : format === 1 && bits === 24
              ? (p: number) => (v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608
              : format === 1 && bits === 32
                ? (p: number) => v.getInt32(p, true) / 2147483648
                : null;
      if (!read) throw new Error(`decodeWav: unsupported format ${format}/${bits}-bit`);
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < nch; c++) {
          channels[c]![i] = read(p);
          p += bps;
        }
      }
      return { channels, sampleRate };
    }
    o = body + len + (len & 1);
  }
  throw new Error('decodeWav: no data chunk');
}

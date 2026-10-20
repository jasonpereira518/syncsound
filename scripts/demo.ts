/**
 * Demo asset generator: `pnpm demo` writes 48 kHz 16-bit WAVs + manifest.json into apps/server/data/demo/.
 * Fully deterministic (seeded noise), idempotent (overwrites).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyFades, clickTrack, encodeWav, logSweep, mulberry32 } from '../packages/audio-core/src/index.ts';

const SR = 48000;
const OUT = fileURLToPath(new URL('../apps/server/data/demo/', import.meta.url));
const TAU = 2 * Math.PI;
const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const samples = (sec: number) => Math.round(sec * SR);

/** Add a sine burst with attack/exponential decay into `out` starting at `t0` seconds. */
function tone(out: Float32Array, t0: number, dur: number, freq: number, amp: number, decay = dur / 3) {
  const s0 = samples(t0);
  const n = samples(dur);
  const fade = samples(0.005);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const env = Math.min(1, i / fade, (n - i) / fade) * Math.exp(-i / SR / decay);
    out[s0 + i] = out[s0 + i]! + amp * env * Math.sin((TAU * freq * i) / SR);
  }
}

function clickAsset() {
  return [clickTrack(120, 60, SR)];
}

function toneSweepAsset() {
  const out = new Float32Array(samples(20));
  const sweep = logSweep({ f1: 30, f2: 16000, durationSec: 14, sampleRate: SR }).signal;
  sweep.forEach((v, i) => (out[i] = 0.4 * v));
  const t = out.subarray(samples(15), samples(20));
  for (let i = 0; i < t.length; i++) t[i] = 0.4 * Math.sin((TAU * 1000 * i) / SR);
  applyFades(t, samples(0.01));
  return [out];
}

function pingPongAsset() {
  const L = new Float32Array(samples(30));
  const R = new Float32Array(samples(30));
  for (let k = 0; k * 0.5 < 30; k++) tone(k % 2 ? R : L, k * 0.5, 0.35, k % 2 ? 880 : 660, 0.5, 0.15);
  return [L, R];
}

/** WAV order L R C LFE SL SR; played in turn L, C, R, SR, SL, LFE (1 s each), 4 rounds. */
function surroundAsset() {
  const dur = 24;
  const ch = Array.from({ length: 6 }, () => new Float32Array(samples(dur)));
  const seq: Array<[number, number]> = [
    [0, 440], // L
    [2, 523.25], // C
    [1, 659.25], // R
    [5, 783.99], // SR
    [4, 880], // SL
    [3, 50], // LFE
  ];
  for (let slot = 0; slot * 1 < dur; slot++) {
    const [c, f] = seq[slot % 6]!;
    tone(ch[c]!, slot, 0.7, f, f < 100 ? 0.7 : 0.5, f < 100 ? 0.5 : 0.3);
  }
  return ch;
}

/** ≈60 s loop at 120 BPM: C–G–Am–F pads, plucked bass, kick/snare/hats. */
function grooveAsset() {
  const bpm = 120;
  const beat = 60 / bpm;
  const bars = 30; // 60 s
  const n = samples(bars * 4 * beat);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = mulberry32(2024);
  const chords = [
    [60, 64, 67], // C
    [59, 62, 67], // G/B
    [57, 60, 64], // Am
    [57, 60, 65], // F/A
  ];
  const roots = [36, 43, 45, 41];
  const add = (buf: Float32Array, s: number, v: number) => {
    if (s >= 0 && s < n) buf[s] = buf[s]! + v;
  };

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat;
    const chord = chords[bar % 4]!;
    // pads: soft additive saws, detuned per side, slow attack, overlapping release
    const padLen = samples(4 * beat + 0.4);
    for (const m of chord) {
      for (const [buf, cents] of [
        [L, -7],
        [R, 7],
      ] as const) {
        const f = midi(m) * Math.pow(2, cents / 1200);
        const s0 = samples(t0);
        for (let i = 0; i < padLen; i++) {
          const t = i / SR;
          const env = Math.min(1, t / 0.35) * Math.min(1, (padLen - i) / samples(0.4));
          let v = 0;
          for (let h = 1; h <= 6; h++) v += Math.sin(TAU * f * h * t) / (h * h);
          add(buf, s0 + i, 0.045 * env * v);
        }
      }
    }
    if (bar < 2) continue; // two bars of pads as an intro
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * beat;
      // kick on 1 and 3
      if (b % 2 === 0) {
        const s0 = samples(tb);
        let ph = 0;
        for (let i = 0; i < samples(0.35); i++) {
          const t = i / SR;
          ph += (TAU * (45 + 105 * Math.exp(-t / 0.03))) / SR;
          const v = 0.55 * Math.exp(-t / 0.12) * Math.sin(ph);
          add(L, s0 + i, v);
          add(R, s0 + i, v);
        }
      }
      // snare on 2 and 4
      if (b % 2 === 1) {
        const s0 = samples(tb);
        let prev = 0;
        for (let i = 0; i < samples(0.2); i++) {
          const t = i / SR;
          const w = rnd() * 2 - 1;
          const v =
            0.22 * Math.exp(-t / 0.06) * (w - prev) + 0.15 * Math.exp(-t / 0.04) * Math.sin(TAU * 190 * t);
          prev = w;
          add(L, s0 + i, v);
          add(R, s0 + i, v);
        }
      }
      // hats on 8ths (open on the and of 4), slightly right
      for (let e = 0; e < 2; e++) {
        const open = b === 3 && e === 1;
        const s0 = samples(tb + (e * beat) / 2);
        let prev = 0;
        for (let i = 0; i < samples(open ? 0.25 : 0.06); i++) {
          const w = rnd() * 2 - 1;
          const v = (e ? 0.07 : 0.1) * Math.exp(-i / SR / (open ? 0.08 : 0.018)) * (w - prev);
          prev = w;
          add(L, s0 + i, 0.7 * v);
          add(R, s0 + i, v);
        }
      }
    }
    // bass: root on 1, 1&, 2&, 3, 4 (octave up on 4)
    const root = roots[bar % 4]!;
    for (const [pos, oct] of [
      [0, 0],
      [0.5, 0],
      [1.5, 0],
      [2, 0],
      [3, 12],
    ] as const) {
      const s0 = samples(t0 + pos * beat);
      const f = midi(root + oct);
      for (let i = 0; i < samples(0.45); i++) {
        const t = i / SR;
        const env = Math.min(1, i / samples(0.004)) * Math.exp(-t / 0.18);
        const v = 0.28 * env * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t));
        add(L, s0 + i, v);
        add(R, s0 + i, v);
      }
    }
  }
  // gentle soft clip + normalize to −1.4 dBFS
  let peak = 0;
  for (const buf of [L, R])
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs((buf[i] = Math.tanh(buf[i]!))));
  for (const buf of [L, R]) {
    for (let i = 0; i < n; i++) buf[i] = (buf[i]! * 0.85) / peak;
    applyFades(buf, samples(0.02));
  }
  return [L, R];
}

const assets: Array<{ id: string; title: string; make: () => Float32Array[] }> = [
  { id: 'click-120', title: 'Click track 120 BPM (sync test)', make: clickAsset },
  { id: 'tone-sweep', title: 'Log sweep + 1 kHz tone', make: toneSweepAsset },
  { id: 'stereo-pingpong', title: 'Stereo ping-pong (L/R test)', make: pingPongAsset },
  { id: 'surround-51-test', title: '5.1 channel test (L C R SR SL LFE)', make: surroundAsset },
  { id: 'synth-groove', title: 'Synth groove (demo loop)', make: grooveAsset },
];

mkdirSync(OUT, { recursive: true });
const manifest = assets.map(({ id, title, make }) => {
  const channels = make();
  const file = `${id}.wav`;
  const bytes = encodeWav(channels, SR);
  writeFileSync(OUT + file, bytes);
  const durationSec = channels[0]!.length / SR;
  console.log(
    `demo: ${file.padEnd(22)} ${channels.length}ch ${durationSec.toFixed(1).padStart(5)} s ${(bytes.length / 1e6).toFixed(1)} MB`,
  );
  return { id, title, file, channels: channels.length, durationSec, mime: 'audio/wav' };
});
writeFileSync(OUT + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`demo: wrote ${manifest.length} assets + manifest.json to ${OUT}`);

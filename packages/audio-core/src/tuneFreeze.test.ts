import { describe, expect, it } from 'vitest';
import { ClockMapping } from './clock';
import { frozenRoomMap } from './tuneFreeze';

describe('frozenRoomMap', () => {
  const drift = 50e-6;
  const t0 = 1_000_000;
  // the room clock mid-slew: 10 ms being caught up at 1 ms/s on top of the drift (what ClockSync applies), and the
  // same mapping de-slewed (what ClockSync.frozenAt returns; its own test covers that equivalence)
  const live = new ClockMapping({ t0, a0: 500, s1: drift + 1e-3, tEnd: t0 + 10_000, s2: drift });
  // the audio clock: ctx = (perf − perf0)·slope, slope = 1e-3·(1 + 80 ppm)
  const slope = 1e-3 * (1 + 80e-6);
  const perf0 = t0 - 2000;
  const ctxToPerf = (ctx: number) => perf0 + ctx / slope;
  const startCtx = 2.03;
  const freezeLocal = ctxToPerf(startCtx);
  // what ClockSync.frozenAt(freezeLocal) returns: anchored at the applied offset now, drift slope only
  const frozen = new ClockMapping({ t0: freezeLocal, a0: live.offsetAt(freezeLocal), s1: drift, tEnd: Infinity, s2: drift });
  const sr = 48_000;
  // room ms per nominal recording ms: (1 + drift) room per perf, over (1 + 80 ppm) samples per nominal
  const expected = (1 + drift) / (1 + 80e-6);

  it('takes the drift slope, not the slew: within 5 ppm, where a finite difference over the live clock is 1000 ppm off', () => {
    const map = frozenRoomMap({ startCtx, sampleRate: sr, audio: { perfAtStartCtx: ctxToPerf(startCtx), ctxPerPerfMs: slope }, clock: frozen });
    const rate = (map(8 * sr) - map(0)) / 8000;
    expect(Math.abs(rate - expected)).toBeLessThan(5e-6);
    expect(map(0)).toBeCloseTo(live.toRoomTime(ctxToPerf(startCtx)), 6); // anchored where the live clock is now
    const finiteDifference = (live.toRoomTime(ctxToPerf(startCtx + 1)) - live.toRoomTime(ctxToPerf(startCtx))) / 1000;
    expect(Math.abs(finiteDifference - expected)).toBeGreaterThan(900e-6);
  });

  it('follows a piecewise (held) mapping exactly', () => {
    const map = frozenRoomMap({ startCtx: 0, sampleRate: 1000, audio: { perfAtStartCtx: t0 - 100, ctxPerPerfMs: 1e-3 }, clock: live });
    for (const idx of [0, 50, 100, 600, 20_000]) expect(map(idx)).toBeCloseTo(live.toRoomTime(t0 - 100 + idx), 9);
  });
});

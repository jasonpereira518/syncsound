import type { TimeMap } from './clock';

export interface FrozenMapInput {
  /** AudioContext time of recording[0], s */
  startCtx: number;
  sampleRate: number;
  audio: {
    /** performance-clock ms at startCtx (the audio-clock map's anchor: its offset is common to everything this recorder hears) */
    perfAtStartCtx: number;
    /** AudioContext seconds per performance ms: the long-baseline rate (AudioClockMap.longRate / slope) */
    ctxPerPerfMs: number;
  };
  /** the room clock, already frozen (RoomClock.frozenAt): drift slope only, no pending slew */
  clock: TimeMap;
}

/**
 * The linear-in-rate map a recorder analyses its tune recording through: sample index → room ms. Built from the
 * audio clock's long-baseline rate and the room clock's drift slope, anchored at the recording's first sample —
 * never from a finite difference over the live clocks, whose pending 1 ms/s slew would leak up to ±1000 ppm into
 * the rate (0.3 ms per slot: more than the whole arrival budget). The room clock may be piecewise (a held
 * mapping): `analyzeRecording` only needs the map's values, not linearity.
 */
export function frozenRoomMap(i: FrozenMapInput): (idx: number) => number {
  const perfPerIdx = 1 / (i.sampleRate * i.audio.ctxPerPerfMs);
  return (idx) => i.clock.toRoomTime(i.audio.perfAtStartCtx + idx * perfPerIdx);
}

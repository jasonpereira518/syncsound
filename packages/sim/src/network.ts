/** Seeded randomness + network / device-clock models for the headless sync simulator. */

/** mulberry32: small, fast, deterministic PRNG in [0, 1) */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * next();
  const gauss = () => {
    const u = 1 - next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, uniform, gauss };
}
export type Rng = ReturnType<typeof makeRng>;

export interface NetParams {
  /** minimum round trip (propagation + serialisation), ms */
  baseRttMs: number;
  /** uplink − downlink base one-way delay, ms (NTP cannot observe this; it biases offset by asym/2) */
  asymmetryMs?: number;
  /** σ of the half-normal queueing delay added to each leg, ms */
  jitterMs?: number;
  /** per-leg probability of a heavy-tail spike */
  spikeProb?: number;
  /** spike size ~ U(0, spikeMaxMs) */
  spikeMaxMs?: number;
  /** per-leg packet loss probability */
  lossProb?: number;
  /** server processing time between recv and send stamps, ms */
  serverProcMs?: number;
}

/** One-way delay for one leg, or null if the packet is lost. */
export function legDelay(net: NetParams, up: boolean, rng: Rng): number | null {
  if (rng.next() < (net.lossProb ?? 0)) return null;
  const base = (net.baseRttMs + (up ? 1 : -1) * (net.asymmetryMs ?? 0)) / 2;
  const queue = Math.abs(rng.gauss()) * (net.jitterMs ?? 0);
  const spike = rng.next() < (net.spikeProb ?? 0) ? rng.uniform(0, net.spikeMaxMs ?? 0) : 0;
  return base + queue + spike;
}

/** room (server) clock epoch used by the sims: realistic epoch-ms magnitudes exercise float precision */
export const ROOM_T0 = 1_700_000_000_000;

export interface ClientClockParams {
  /** true server − client at ROOM_T0, ms */
  offsetMs: number;
  /** client clock drift, ppm (+ve: client runs slow vs server, so server − client grows) */
  driftPpm: number;
}

/** Client local (performance) clock as a function of true room time T, and its inverse. */
export class ClientClock {
  constructor(readonly p: ClientClockParams) {}
  local(T: number): number {
    return ROOM_T0 - this.p.offsetMs + (T - ROOM_T0) * (1 - this.p.driftPpm * 1e-6);
  }
  trueTime(local: number): number {
    return ROOM_T0 + (local - ROOM_T0 + this.p.offsetMs) / (1 - this.p.driftPpm * 1e-6);
  }
}

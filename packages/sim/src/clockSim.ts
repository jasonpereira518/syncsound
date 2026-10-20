import { mkdirSync, writeFileSync } from 'node:fs';
import { ClockSync, type ClockSample, type ClockSyncOptions } from '@syncsound/audio-core';
import { ClientClock, legDelay, makeRng, type ClientClockParams, type NetParams, type Rng } from './network';

export interface SimClientParams {
  clock: ClientClockParams;
  net: NetParams;
  seed: number;
  /** true room time of join (start of the ping burst), ms */
  joinT: number;
  syncOpts?: ClockSyncOptions;
  burstCount?: number;
  burstIntervalMs?: number;
  pingIntervalMs?: number;
}

/**
 * A simulated client running the real ClockSync against a simulated server over a simulated network.
 * Ping schedule: `burstCount` pings `burstIntervalMs` apart at join, then one per `pingIntervalMs`.
 * Call advanceTo(T) to deliver every PONG that has arrived by true room time T.
 */
export class SimClient {
  readonly sync: ClockSync;
  readonly clock: ClientClock;
  private readonly rng;
  private pending: { T3: number; s: ClockSample }[] = [];
  private nextSendT: number;
  private burstLeft: number;
  sent = 0;
  lost = 0;

  constructor(readonly p: SimClientParams) {
    this.sync = new ClockSync(p.syncOpts);
    this.clock = new ClientClock(p.clock);
    this.rng = makeRng(p.seed);
    this.nextSendT = p.joinT;
    this.burstLeft = p.burstCount ?? 25;
  }

  /** reconnect: forget the clock state and restart the burst at T */
  rejoin(T: number): void {
    this.sync.reset();
    this.pending = [];
    this.nextSendT = T;
    this.burstLeft = this.p.burstCount ?? 25;
  }

  advanceTo(T: number): void {
    while (this.nextSendT <= T) {
      this.send(this.nextSendT);
      this.burstLeft = Math.max(0, this.burstLeft - 1);
      this.nextSendT += this.burstLeft > 0 ? (this.p.burstIntervalMs ?? 50) : (this.p.pingIntervalMs ?? 1000);
    }
    this.pending.sort((a, b) => a.T3 - b.T3);
    while (this.pending.length && this.pending[0]!.T3 <= T) this.sync.addSample(this.pending.shift()!.s);
  }

  private send(Ts: number): void {
    this.sent++;
    const up = legDelay(this.p.net, true, this.rng);
    const down = legDelay(this.p.net, false, this.rng);
    if (up === null || down === null) {
      this.lost++;
      return;
    }
    const tsRecv = Ts + up;
    const tsSend = tsRecv + (this.p.net.serverProcMs ?? 0.5);
    const T3 = tsSend + down;
    this.pending.push({ T3, s: { t0: this.clock.local(Ts), tsRecv, tsSend, t3: this.clock.local(T3) } });
  }

  /** estimated room time − true room time at true time T, ms */
  roomError(T: number): number {
    return this.sync.toRoomTime(this.clock.local(T)) - T;
  }

  /** applied offset (server − client) at true time T, ms */
  appliedOffset(T: number): number {
    const l = this.clock.local(T);
    return this.sync.toRoomTime(l) - l;
  }
}

/** one Web Audio render quantum at 48 kHz, s */
export const QUANTUM_SEC = 128 / 48000;

/**
 * A device's AudioContext clock: ctx = 0 at true time `createdT`, then advances with the device's perf clock
 * scaled by (1 + ratePpm) (the audio crystal vs the perf clock). In these sims ctx time is "heard" time on the
 * reported timeline; extra (e.g. Bluetooth) output latency is modelled separately by the caller.
 */
export class AudioClockModel {
  private readonly l0: number;
  constructor(
    private readonly clock: ClientClock,
    readonly ratePpm: number,
    readonly createdT: number,
  ) {
    this.l0 = clock.local(createdT);
  }
  ctx(T: number): number {
    return ((this.clock.local(T) - this.l0) * (1 + this.ratePpm * 1e-6)) / 1000;
  }
  trueTime(ctxSec: number): number {
    return this.clock.trueTime(this.l0 + (ctxSec * 1000) / (1 + this.ratePpm * 1e-6));
  }
  /** AudioContext.currentTime: quantised to render quanta */
  currentTime(T: number): number {
    return Math.floor(this.ctx(T) / QUANTUM_SEC) * QUANTUM_SEC;
  }
  /**
   * A getOutputTimestamp()-style pair at true time T: contextTime jitters by ±½ render quantum (zero-mean
   * model) and with probability `hiccupProb` the perf stamp is taken 5–30 ms late (OS scheduling).
   */
  observe(T: number, rng: Rng, hiccupProb = 0.02): { perfMs: number; ctxSec: number } {
    const late = rng.next() < hiccupProb ? rng.uniform(5, 30) : 0;
    return { perfMs: this.clock.local(T) + late, ctxSec: this.ctx(T) + rng.uniform(-0.5, 0.5) * QUANTUM_SEC };
  }
}

export interface Stats {
  n: number;
  mean: number;
  rms: number;
  p50: number;
  p95: number;
  max: number;
}

/** stats of |values| (mean is signed) */
export function stats(values: number[]): Stats {
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  const n = abs.length;
  const q = (f: number) => (n ? abs[Math.min(n - 1, Math.floor(f * n))]! : NaN);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n,
    mean: r3(values.reduce((a, b) => a + b, 0) / n),
    rms: r3(Math.sqrt(values.reduce((a, b) => a + b * b, 0) / n)),
    p50: r3(q(0.5)),
    p95: r3(q(0.95)),
    max: r3(abs[n - 1] ?? NaN),
  };
}

/** write sim metrics to packages/sim/results/<name>.json */
export function writeResult(name: string, data: unknown): void {
  const dir = new URL('../results/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify({ name, ...(data as object) }, null, 2) + '\n');
}

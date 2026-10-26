import { mkdirSync, writeFileSync } from 'node:fs';
import { CLOCK_BURST_COUNT, CLOCK_BURST_GAP_MS, ClockSync, type ClockMappingData, type ClockSample, type ClockSyncOptions } from '@syncsound/audio-core';
import { ClientClock, legDelay, makeRng, wanderMs, wanderRate, type ClientClockParams, type NetParams, type Rng, type Wander } from './network';

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
  /**
   * Steady ping interval as a function of true time (hidden-tab throttling: 1000 → 60 000; a device asleep: null,
   * no pings at all). Default: `pingIntervalMs` everywhere.
   */
  pingIntervalAt?: (T: number) => number | null;
  /**
   * The clock that answers PINGs: true time → the room time it stamps. Default: the server (identity).
   * A LAN clock master passes its own room-time estimate (master.sync.toRoomTime(master.clock.local(T))).
   */
  reference?: (T: number) => number;
}

/** the app declares a burst finished this long after its last ping (fallback deadline) */
export const BURST_DONE_MS = 650;

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
  private burst: { base: ClockMappingData | null; doneT: number; reason: 'connect' | 'resync' } | null = null;
  /** true send times of every ping (to check a throttling model) */
  readonly pingLog: number[] = [];
  /** true time of the last PONG delivered to the estimator */
  lastPongT = -Infinity;
  sent = 0;
  lost = 0;

  constructor(readonly p: SimClientParams) {
    this.sync = new ClockSync(p.syncOpts);
    this.clock = new ClientClock(p.clock);
    this.rng = makeRng(p.seed);
    this.nextSendT = p.joinT;
    this.burstLeft = p.burstCount ?? CLOCK_BURST_COUNT;
    this.burst = { base: null, doneT: p.joinT + this.burstLeft * (p.burstIntervalMs ?? CLOCK_BURST_GAP_MS) + BURST_DONE_MS, reason: 'connect' };
  }

  /** reconnect: in-flight pongs are lost; re-acquire (rebase, never reset) with a fresh burst at T */
  rejoin(T: number): void {
    this.pending = [];
    this.startBurst(T, 'connect');
  }

  /** the tab became visible again: re-burst, keeping the mapping (the app's RoomClient.resync) */
  resync(T: number): void {
    this.startBurst(T, 'resync');
  }

  private startBurst(T: number, reason: 'connect' | 'resync') {
    this.burstLeft = this.p.burstCount ?? CLOCK_BURST_COUNT;
    this.nextSendT = T;
    this.burst = { base: this.sync.mapping(), doneT: T + this.burstLeft * (this.p.burstIntervalMs ?? CLOCK_BURST_GAP_MS) + BURST_DONE_MS, reason };
    this.sync.rebase();
  }

  /**
   * Once per burst, when it is done: how far the mapping moved during it (the app's onSynced shift), else null.
   * Call after advanceTo(T).
   */
  burstDone(T: number): { reason: 'connect' | 'resync'; shiftMs: number } | null {
    const b = this.burst;
    if (!b || T < b.doneT) return null;
    this.burst = null;
    const l = this.clock.local(T);
    return { reason: b.reason, shiftMs: b.base ? this.sync.shiftSince(b.base, l) : 0 };
  }

  advanceTo(T: number): void {
    while (this.nextSendT <= T) {
      if (this.burstLeft > 0) {
        this.send(this.nextSendT);
        this.burstLeft--;
        this.nextSendT += this.burstLeft > 0 ? (this.p.burstIntervalMs ?? CLOCK_BURST_GAP_MS) : (this.p.pingIntervalMs ?? 1000);
        continue;
      }
      const iv = this.p.pingIntervalAt ? this.p.pingIntervalAt(this.nextSendT) : (this.p.pingIntervalMs ?? 1000);
      if (iv === null) {
        this.nextSendT += 1000; // asleep: look again in a second
        continue;
      }
      this.send(this.nextSendT);
      this.nextSendT += iv;
    }
    this.pending.sort((a, b) => a.T3 - b.T3);
    while (this.pending.length && this.pending[0]!.T3 <= T) {
      const { T3, s } = this.pending.shift()!;
      this.sync.addSample(s);
      this.lastPongT = T3;
    }
  }

  private send(Ts: number): void {
    this.sent++;
    this.pingLog.push(Ts);
    const up = legDelay(this.p.net, true, this.rng);
    const down = legDelay(this.p.net, false, this.rng);
    if (up === null || down === null) {
      this.lost++;
      return;
    }
    const ref = this.p.reference ?? ((T: number) => T);
    const recvT = Ts + up;
    const sendT = recvT + (this.p.net.serverProcMs ?? 0.5);
    const T3 = sendT + down;
    this.pending.push({ T3, s: { t0: this.clock.local(Ts), tsRecv: ref(recvT), tsSend: ref(sendT), t3: this.clock.local(T3) } });
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
 * scaled by (1 + ratePpm) (the audio crystal vs the perf clock), optionally with a slow rate wander, and frozen
 * during a suspension (the context stops while the perf clock runs on). In these sims ctx time is "heard" time on
 * the reported timeline; extra (e.g. Bluetooth) output latency is modelled separately by the caller.
 */
export class AudioClockModel {
  private readonly l0: number;
  private gaps: Array<{ l0: number; l1: number }> = [];
  private sleeps: Array<{ T0: number; T1: number }> = [];
  constructor(
    private readonly clock: ClientClock,
    readonly ratePpm: number,
    readonly createdT: number,
    readonly wander?: Wander,
  ) {
    this.l0 = clock.local(createdT);
  }

  /** the context is suspended between true times T0 and T1 while the perf clock runs on (iOS background) */
  suspend(T0: number, T1: number): void {
    this.gaps.push({ l0: this.clock.local(T0), l1: this.clock.local(T1) });
  }

  /**
   * The whole device is asleep between true times T0 and T1: the perf clock stands still (ClientClock.sleep), so
   * ctx time stands still with it; nothing is observed meanwhile. Call ClientClock.sleep with the same times.
   */
  sleep(T0: number, T1: number): void {
    this.sleeps.push({ T0, T1 });
  }

  suspendedAt(T: number): boolean {
    if (this.sleeps.some((s) => T >= s.T0 && T < s.T1)) return true;
    const l = this.clock.local(T);
    return this.gaps.some((g) => l >= g.l0 && l < g.l1);
  }

  /** ctx seconds at local ms, ignoring suspensions (the wander is phased on local time: close enough to room time) */
  private base(l: number): number {
    return ((l - this.l0) * (1 + this.ratePpm * 1e-6) - wanderMs(this.wander, this.l0, l)) / 1000;
  }

  private ctxOfLocal(l: number): number {
    let c = this.base(l);
    for (const g of this.gaps) {
      if (l >= g.l1) c -= this.base(g.l1) - this.base(g.l0);
      else if (l >= g.l0) c -= this.base(l) - this.base(g.l0);
    }
    return c;
  }

  ctx(T: number): number {
    return this.ctxOfLocal(this.clock.local(T));
  }

  /** local ms at which the context reads ctxSec (a value inside a suspension maps to its end) */
  localOfCtx(ctxSec: number): number {
    let l = this.l0 + (ctxSec * 1000) / (1 + this.ratePpm * 1e-6);
    for (const g of this.gaps) if (this.ctxOfLocal(g.l1) <= ctxSec) l += g.l1 - g.l0;
    for (let i = 0; i < 4; i++) {
      const rate = (1 + this.ratePpm * 1e-6 - wanderRate(this.wander, l)) / 1000;
      l -= (this.ctxOfLocal(l) - ctxSec) / rate;
      for (const g of this.gaps) if (l > g.l0 && l < g.l1) l = g.l1;
    }
    return l;
  }

  trueTime(ctxSec: number): number {
    return this.clock.trueTime(this.localOfCtx(ctxSec));
  }

  /** AudioContext.currentTime: quantised to render quanta */
  currentTime(T: number): number {
    return Math.floor(this.ctx(T) / QUANTUM_SEC) * QUANTUM_SEC;
  }

  /**
   * A getOutputTimestamp()-style pair at true time T: contextTime jitters by ±½ render quantum (zero-mean
   * model) and with probability `hiccupProb` the perf stamp is taken 5–30 ms late (OS scheduling). Null while
   * the context is suspended (the engine does not observe a non-running context).
   */
  observe(T: number, rng: Rng, hiccupProb = 0.02): { perfMs: number; ctxSec: number } | null {
    if (this.suspendedAt(T)) return null;
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

/**
 * One simulated device playing a track the way the web engine does: the real ClockSync over a simulated network
 * (SimClient), the real AudioClockMap fed by getOutputTimestamp-style observations, computeStart, the PI drift
 * loop with a measured tick length, the learned rate carried into every new source, a forced rebuild remembered
 * while timing isn't ready (ReconcileGate), and the app's resync rule (reschedule only when the mapping moved).
 */
import {
  AudioClockMap,
  DriftController,
  PlaybackTracker,
  ReconcileGate,
  computeStart,
  positionAt,
  resyncNeedsReschedule,
  tickDt,
} from '@syncsound/audio-core';
import type { Playback } from '@syncsound/protocol';
import { AudioClockModel, SimClient, type SimClientParams } from './clockSim';
import { makeRng, type Wander } from './network';

export interface SimPlayerParams extends SimClientParams {
  /** audio crystal vs the perf clock, ppm */
  audioPpm: number;
  audioWander?: Wander;
  /** true time the AudioContext was created (default: joinT) */
  ctxCreatedT?: number;
  /** output latency the browser does not report (Bluetooth), ms */
  latencyMs?: number;
  /** what the tune measured for it, ms (default: exactly latencyMs) */
  calibratedMs?: number;
  /** getOutputTimestamp observation period, ms (the engine: 250) */
  obsEveryMs?: number;
  /** drift-loop tick, ms (the engine: 500) */
  tickEveryMs?: number;
}

export interface PlayerCounters {
  reschedules: number;
  rateNudges: number;
  lateStarts: number;
  /** sources rebuilt because a resync showed the mapping moved */
  forcedRebuilds: number;
  resyncShiftsMs: number[];
  /** true time the mapping became ready again after the last suspension (null = none) */
  readyAfterSuspendT: number | null;
}

export class SimPlayer {
  readonly client: SimClient;
  readonly audio: AudioClockModel;
  readonly acm = new AudioClockMap();
  readonly drift = new DriftController();
  readonly tracker = new PlaybackTracker();
  readonly gate = new ReconcileGate();
  readonly counters: PlayerCounters = { reschedules: 0, rateNudges: 0, lateStarts: 0, forcedRebuilds: 0, resyncShiftsMs: [], readyAfterSuspendT: null };
  playback: Playback | null = null;
  private synced = false;
  private wasReady = false;
  private voiceKey: string | null = null;
  private voiceWhen = 0;
  private lastTickCtx: number | null = null;
  private nextObsT: number;
  private nextTickT: number;
  private suspendEnd: number | null = null;
  private suspendStart: number | null = null;
  private suspended = false;
  private readonly rng;
  private readonly latencyMs: number;
  private readonly compSec: number;
  private readonly obsEvery: number;
  private readonly tickEvery: number;

  constructor(readonly p: SimPlayerParams) {
    this.client = new SimClient(p);
    const created = p.ctxCreatedT ?? p.joinT;
    this.audio = new AudioClockModel(this.client.clock, p.audioPpm, created, p.audioWander);
    this.rng = makeRng(p.seed * 7 + 3);
    this.latencyMs = p.latencyMs ?? 0;
    this.compSec = (p.calibratedMs ?? this.latencyMs) / 1000;
    this.obsEvery = p.obsEveryMs ?? 250;
    this.tickEvery = p.tickEveryMs ?? 500;
    this.nextObsT = created;
    this.nextTickT = created;
  }

  private roomToCtx = (r: number) => this.acm.perfToCtx(this.client.sync.toLocalTime(r));
  private ctxToRoom = (c: number) => this.client.sync.toRoomTime(this.acm.ctxToPerf(c));

  /** the engine's timingReady(): clock burst done since (re)connect, audio-clock map fitted */
  ready(): boolean {
    return this.synced && this.acm.ready();
  }

  get playing(): boolean {
    return this.voiceKey !== null;
  }

  /** a SCHEDULE arrived at true time T */
  setPlayback(pb: Playback, T: number): void {
    this.playback = pb;
    this.reconcile(T, false);
  }

  /** the tab became visible again at T: re-burst the clock (the mapping is kept) */
  resync(T: number): void {
    this.client.resync(T);
  }

  /** the AudioContext is suspended between T0 and T1 (the app fades a playing source out and rebuilds once the map is ready) */
  suspend(T0: number, T1: number): void {
    this.audio.suspend(T0, T1);
    this.suspendStart = T0;
    this.suspendEnd = T1;
    this.suspended = true;
  }

  /** the device sleeps between T0 and T1: its perf clock and AudioContext stand still, nothing runs meanwhile */
  sleep(T0: number, T1: number): void {
    this.client.clock.sleep(T0, T1);
    this.audio.sleep(T0, T1);
    this.suspendStart = T0;
    this.suspendEnd = T1;
    this.suspended = true;
  }

  /** run every clock sample, observation and drift tick up to true time T, in order */
  advanceTo(T: number): void {
    for (;;) {
      let next = Math.min(this.nextObsT, this.nextTickT);
      if (this.suspendStart !== null && this.suspendStart < next) next = this.suspendStart;
      if (this.suspendEnd !== null && this.suspendEnd < next) next = this.suspendEnd;
      if (next > T) {
        this.step(T);
        return;
      }
      this.step(next);
      if (this.suspendStart !== null && next >= this.suspendStart) {
        this.onSuspended();
        this.suspendStart = null;
      }
      if (this.suspendEnd !== null && next >= this.suspendEnd) {
        this.acm.reset();
        this.suspendEnd = null;
        this.counters.readyAfterSuspendT = null;
      }
      if (next >= this.nextObsT) {
        this.observe(next);
        this.nextObsT += this.obsEvery;
      }
      if (next >= this.nextTickT) {
        this.tick(next);
        this.nextTickT += this.tickEvery;
      }
    }
  }

  private step(T: number) {
    this.client.advanceTo(T);
    const b = this.client.burstDone(T);
    if (b) {
      if (b.reason === 'connect') this.synced = true;
      else this.counters.resyncShiftsMs.push(b.shiftMs);
      this.reconcile(T, b.reason === 'resync' && resyncNeedsReschedule(b.shiftMs, false));
    }
  }

  private onSuspended() {
    if (this.voiceKey !== null) {
      this.voiceKey = null;
      this.tracker.stop();
      this.gate.request(true);
    }
  }

  private observe(T: number) {
    const o = this.audio.observe(T, this.rng);
    if (!o) return;
    this.acm.addObservation(o.perfMs, o.ctxSec);
    const ready = this.ready();
    if (ready && !this.wasReady) {
      if (this.suspended && this.suspendEnd === null && this.counters.readyAfterSuspendT === null) this.counters.readyAfterSuspendT = T;
      this.reconcile(T, this.gate.pending);
    }
    this.wasReady = ready;
  }

  private tick(T: number) {
    if (this.voiceKey === null) return;
    const now = this.audio.currentTime(T);
    if (!this.ready()) {
      this.applyRate(now, this.drift.hold().rate, false);
      return;
    }
    const pb = this.playback;
    if (!pb || pb.status !== 'playing') return;
    if (now < this.voiceWhen + 0.2) return;
    const dt = tickDt(this.lastTickCtx, now, this.tickEvery / 1000);
    this.lastTickCtx = now;
    const expected = positionAt(pb, this.ctxToRoom(now) + this.compSec * 1000);
    const err = (this.tracker.positionAt(now) - expected) * 1000;
    const dec = this.drift.update(err, dt);
    if (dec.action === 'reschedule') {
      this.counters.reschedules++;
      this.reconcile(T, true);
      return;
    }
    this.applyRate(now, dec.rate, dec.action === 'rate');
  }

  private applyRate(now: number, rate: number, counted: boolean) {
    if (rate === this.tracker.rate) return;
    if (counted) this.counters.rateNudges++;
    this.tracker.setRate(now, rate);
  }

  private reconcile(T: number, force: boolean) {
    this.gate.request(force);
    const pb = this.playback;
    if (!pb || pb.status !== 'playing') {
      this.gate.take();
      if (this.voiceKey !== null) {
        this.voiceKey = null;
        this.tracker.stop();
      }
      return;
    }
    if (!this.ready()) return;
    const key = `${pb.startRoomTime}|${pb.trackOffset}`;
    const forced = this.gate.pending;
    if (!forced && this.voiceKey === key) return;
    const d = computeStart({ startRoomTime: pb.startRoomTime, trackOffset: pb.trackOffset, roomToCtx: this.roomToCtx, nowCtx: this.audio.currentTime(T), compensationSec: this.compSec });
    if (!d) {
      this.gate.take();
      return;
    }
    if (forced && this.voiceKey === key) this.counters.forcedRebuilds++;
    if (d.late) this.counters.lateStarts++;
    const rate = this.drift.hold().rate;
    this.tracker.start(d.when, d.offset, rate);
    this.voiceKey = key;
    this.voiceWhen = d.when;
    this.lastTickCtx = null;
    this.gate.take();
  }

  /**
   * What is coming out of the speaker at true time T versus where the room timeline is, ms (+ve = this device is
   * ahead); null before the source has started or while nothing plays.
   */
  trueErrorMs(T: number): number | null {
    const pb = this.playback;
    if (this.voiceKey === null || !pb || pb.status !== 'playing') return null;
    const c = this.audio.ctx(T - this.latencyMs);
    if (c < this.voiceWhen) return null;
    return (this.tracker.positionAt(c) - positionAt(pb, T)) * 1000;
  }
}

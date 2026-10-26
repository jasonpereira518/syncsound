/**
 * The per-device audio engine: AudioContext lifecycle, roomTime↔ctx mapping, scheduling with latency
 * compensation, drift correction, spatial mix + EQ graph, click test, identify beeps.
 * Browser-only: create it from client code after a user gesture (`unlock()`).
 */
import { setAudioSession } from '../audioSession';
import { batterySaver, dueNow } from '../power';
import { startTicker } from '../ticker';
import {
  AudioClockMap,
  DriftController,
  PlaybackTracker,
  ReconcileGate,
  clickTrack,
  tickDt,
  computeDeviceMix,
  computeStart,
  sceneAt,
  type RoomClock,
  type DeviceMix,
  type StartDecision,
  type TimeMap,
} from '@syncsound/audio-core';
import type { Playback, RoomState, Track } from '@syncsound/protocol';
import { errMsg, me, patch, setError, useRoomStore } from '../../store/state';
import { recordSchedule, type ScheduleRecord } from '../instrumentation';
import { AssetCache } from './assets';
import { OutputChain, Voice, XFADE_SEC } from './graph';
import {
  autoOnlyCompensationSec,
  compensationSec,
  driftErrorMs,
  equalPowerCurves,
  expectedHeardEpochMs,
  expectedPositionAtCtx,
  outputLatencyMs,
  type LatencyInput,
  snapToSampleGrid,
  transitionPlan,
} from './timing';

/** live-capture voice fade in/out, s */
const EXTERNAL_FADE_SEC = 0.02;

interface PlayingVoice {
  voice: Voice;
  src: AudioBufferSourceNode;
  key: string;
  trackId: string;
  when: number;
  tracker: PlaybackTracker;
  stopAt: number | null;
  /** ctx s until which this voice's own fade-in curve runs (automation inside a curve cannot be edited) */
  fadeUntil: number;
}

export interface EngineDeps {
  clock: () => RoomClock | null;
  /** clock burst done since the last (re)connect */
  clockReady: () => boolean;
  /** media devices changed outside a calibration run; default: prompt to recalibrate */
  onRouteChange?: () => void;
  /** the audio output's latency stepped outside a run: this device's tune timing may be off */
  onStale?: (kind: 'output') => void;
  /** a queued track was fetched and decoded on this device (lets the room learn durations it did not know) */
  onDecoded?: (trackId: string, info: { durationSec: number; channels: number }) => void;
}

const playbackKey = (pb: Playback) => `${pb.trackId}|${pb.startRoomTime}|${pb.trackOffset}`;

export class AudioEngine {
  ctx: AudioContext | null = null;
  readonly audioClock = new AudioClockMap();
  usingOutputTimestamp = false;
  autoLatencyMs: number | null = null;
  mix: DeviceMix | null = null;

  private chain: OutputChain | null = null;
  private voice: PlayingVoice | null = null;
  /** the previous track playing out under an auto-advance transition (gapless tail or crossfade) */
  private outgoing: PlayingVoice | null = null;
  private external: Voice | null = null;
  /** `?tap=1` e2e instrumentation: analysers on the output and the live source */
  private taps: ReturnType<OutputChain['enableTaps']> | null = null;
  private readonly assets: AssetCache;
  private readonly drift = new DriftController();
  private readonly gate = new ReconcileGate();
  private stops: Array<() => void> = [];
  private lastTickCtx: number | null = null;
  /** drift-tick gaps (ctx s, gap ms) over the last minute: the debug drawer's "tick gap" */
  private tickGaps: Array<[number, number]> = [];
  private orbitTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private click: { src: AudioBufferSourceNode; startedCtx: number } | null = null;
  private clickBuffer: AudioBuffer | null = null;
  private clickOn = false;
  private lastComp = 0;
  private corrections = { rate: 0, reschedule: 0 };
  private syncErrorMs = 0;
  private clockWasReady = false;
  private disposed = false;

  constructor(private readonly deps: EngineDeps) {
    this.assets = new AssetCache(
      (data) => this.decode(data),
      (id) => {
        const e = this.assets.get(id);
        if (e?.state === 'error' && id === this.currentTrack()?.id) setError(e.error);
        if (e?.state === 'ready' && e.buffer)
          this.deps.onDecoded?.(id, { durationSec: e.buffer.duration, channels: e.buffer.numberOfChannels });
        this.reconcile();
      },
    );
  }

  // ---------- lifecycle ----------

  /** MUST run synchronously inside a user gesture (creates/resumes the AudioContext). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume().catch(() => {});
      return;
    }
    const w = window as Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : w.webkitAudioContext;
    if (!Ctor) throw new Error('This browser does not support Web Audio.');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    void ctx.resume().catch(() => {});
    // iOS unlock: play one silent sample inside the gesture; ask Safari to ignore the ringer switch
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start(0);
    setAudioSession('playback');

    this.chain = new OutputChain(ctx);
    if (new URLSearchParams(location.search).has('tap')) this.taps = this.chain.enableTaps();
    ctx.onstatechange = () => this.onCtxStateChange();
    this.stops.push(startTicker(250, () => this.observeClock()), startTicker(500, () => this.tick()));
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
    void this.acquireWakeLock();
    this.onRoomChanged();
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.stops) stop();
    this.stops = [];
    this.stopOrbit();
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.stopClick();
    this.assets.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.loopbackNode = null;
    this.voice = null;
    this.outgoing = null;
    this.external = null;
    this.taps = null;
    this.chain?.dispose();
    this.chain = null;
    void ctx?.close().catch(() => {});
  }

  /** MUST run inside a user gesture: bring a suspended / interrupted context back (iOS needs the tap) */
  resume(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    setAudioSession('playback');
    // the rebuild waits in the gate until the audio clock has re-converged after the resume
    void ctx.resume().then(() => this.reconcile(true), () => {});
  }

  /** tab visible again: resume audio + wake lock; the caller re-bursts the clock, then reconciles (forced only if it moved) */
  onVisible(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
    void this.acquireWakeLock();
  }

  /**
   * The context was suspended/interrupted (iOS background, device sleep) or came back. A suspension freezes ctx
   * time while perf time runs on, so the audio-clock mapping is no longer linear: reset it. A source that was
   * playing would otherwise resume minutes-old audio on `running`: fade it out now and rebuild once the mapping
   * is ready again (the forced rebuild waits in the gate).
   */
  private onCtxStateChange(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') {
      const pv = this.voice;
      if (pv && pv.stopAt === null) {
        this.fadeOut(pv, ctx.currentTime);
        this.gate.request(true);
      }
    }
    // a suspension freezes ctx time while perf time runs on → the mapping is no longer linear
    this.audioClock.reset();
    // iOS 'interrupted' (a call, Siri, another app's audio): try to come back by ourselves once it ends; if the
    // browser wants a tap for that, the room shows a "turn the sound back on" button (resume())
    if (ctx.state !== 'running' && ctx.state !== 'closed' && document.visibilityState === 'visible') void ctx.resume().catch(() => {});
    this.publish();
  }

  private onDeviceChange = () => {
    // granting mic permission during calibration (here or as one of a tune's recorders) can fire devicechange
    // without a route change
    const cal = useRoomStore.getState().calibration;
    if (cal.running || cal.emitting || performance.now() < this.measuringUntil) return;
    this.drift.forget(); // a new output device may run on a different crystal
    if (this.deps.onRouteChange) this.deps.onRouteChange();
    else useRoomStore.setState({ routeChanged: true });
  };

  private async acquireWakeLock() {
    try {
      if (this.disposed || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      if (this.wakeLock && !this.wakeLock.released) return;
      const lock = await navigator.wakeLock.request('screen');
      this.wakeLock = lock;
      patch('engine', { wakeLock: true });
      lock.addEventListener('release', () => patch('engine', { wakeLock: false }));
    } catch {
      patch('engine', { wakeLock: false });
    }
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx) return Promise.reject(new Error('Audio is not unlocked yet.'));
    return this.ctx.decodeAudioData(data);
  }

  primeBuffer(trackId: string, buffer: AudioBuffer) {
    this.assets.prime(trackId, buffer);
  }

  // ---------- clocks ----------

  private measuringUntil = 0;
  /** instrumentation: lead the last schedule was acted on with, and the audio map's skew against now, ms */
  private lastLeadMs = 0;
  private lastSkewMs = 0;

  /** an output step or devicechange in the next `ms` is expected (a mic probe at join), not a route change */
  quietRouteStepsFor(ms: number): void {
    this.measuringUntil = Math.max(this.measuringUntil, performance.now() + ms);
  }

  private observeClock() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      const useTs = !!ts && (ts.performanceTime ?? 0) > 0 && typeof ts.contextTime === 'number';
      if (useTs !== this.usingOutputTimestamp) this.audioClock.reset();
      this.usingOutputTimestamp = useTs;
      const steps = this.audioClock.steps;
      if (useTs) {
        this.audioClock.addObservation(ts!.performanceTime!, ts!.contextTime!);
        // display only: render→heard latency derived from the output timestamp
        this.autoLatencyMs = ts!.performanceTime! - performance.now() + (ctx.currentTime - ts!.contextTime!) * 1000;
      } else {
        this.audioClock.addObservation(performance.now(), ctx.currentTime);
        this.autoLatencyMs = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
      }
      // the output delay jumped (Bluetooth profile switch, device re-open…): acoustic alignment is stale.
      // Opening/closing a measurement's recorder causes such a step too, so steps during one (+5 s) don't count.
      const st = useRoomStore.getState();
      if (st.calibration.running || st.calibration.emitting || st.syncMeasure.running) this.measuringUntil = performance.now() + 5000;
      else if (this.audioClock.steps > steps && performance.now() > this.measuringUntil) {
        useRoomStore.setState({ routeChanged: true });
        this.deps.onStale?.('output');
      }
      const ready = this.timingReady();
      if (ready && !this.clockWasReady) this.reconcile(this.gate.pending);
      this.clockWasReady = ready;
    } catch (e) {
      setError(`Audio clock error: ${errMsg(e)}`);
    }
  }

  timingReady(): boolean {
    try {
      return !!this.ctx && !!this.deps.clock() && this.deps.clockReady() && this.audioClock.ready();
    } catch {
      return false;
    }
  }

  roomToCtx = (roomMs: number) => this.audioClock.perfToCtx(this.deps.clock()!.toLocalTime(roomMs));
  ctxToRoom = (ctxSec: number) => this.deps.clock()!.toRoomTime(this.audioClock.ctxToPerf(ctxSec));

  latencyInput(): LatencyInput {
    const d = me();
    return {
      latencyMs: d?.latencyMs ?? 0,
      calibratedLatencyMs: d?.calibratedLatencyMs ?? null,
      autoLatencyMs: this.autoLatencyMs,
      usingOutputTimestamp: this.usingOutputTimestamp,
    };
  }

  compensationSec(): number {
    return compensationSec(this.latencyInput(), this.mix?.delaySec ?? 0);
  }

  autoCompensationSec(): number {
    return autoOnlyCompensationSec(this.autoLatencyMs, this.usingOutputTimestamp);
  }

  // ---------- room → graph ----------

  private currentTrack(room = useRoomStore.getState().room): Track | null {
    if (!room) return null;
    return room.queue.find((t) => t.id === room.playback.trackId) ?? null;
  }

  /** recompute mix + chain params + assets, then reconcile playback */
  onRoomChanged(): void {
    const room = useRoomStore.getState().room;
    if (!room || !this.ctx || !this.chain) return;
    const scene = this.heardScene(room);
    try {
      const myId = useRoomStore.getState().deviceId;
      this.mix = computeDeviceMix({ scene, devices: room.devices, masterVolume: room.volume }, myId);
    } catch (e) {
      setError(`Mix error: ${errMsg(e)}`);
      return;
    }
    const mix = this.mix;
    useRoomStore.setState({ mix });
    try {
      this.chain.setMix(mix);
      this.chain.setCrossover(room.scene.crossoverHz);
      this.chain.setHighpass(mix.highpassHz);
      this.chain.setEq(me()?.eq ?? null);
      this.voice?.voice.apply(scene, mix);
      this.external?.apply(scene, mix);
    } catch (e) {
      setError(`Audio graph error: ${errMsg(e)}`);
    }
    if (room.scene.motion) this.startOrbit();
    else this.stopOrbit();
    this.ensureAssets(room);
    const comp = this.compensationSec();
    if (Math.abs(comp - this.lastComp) > 0.0005 && this.clickOn) this.startClick();
    this.lastComp = comp;
    this.reconcile();
  }

  /**
   * The scene as heard right now: with 8D on, objects turned to where they are at the room time this device's output
   * reaches the air (now + its latency compensation), so every device pans the same sound to the same place.
   */
  private heardScene(room: RoomState) {
    if (!room.scene.motion || !this.ctx || !this.timingReady()) return room.scene;
    try {
      return sceneAt(room.scene, this.ctxToRoom(this.ctx.currentTime) + this.compensationSec() * 1000);
    } catch {
      return room.scene;
    }
  }

  /** 8D: re-pan ~30×/s (gains glide with SMOOTH_TAU, so the sweep is continuous); bus gains don't move */
  private startOrbit() {
    if (this.orbitTimer) return;
    this.orbitTimer = setInterval(() => {
      const room = useRoomStore.getState().room;
      if (!room?.scene.motion || !this.ctx) return this.stopOrbit();
      if (!this.voice && !this.external) return;
      try {
        const scene = this.heardScene(room);
        const mix = computeDeviceMix({ scene, devices: room.devices, masterVolume: room.volume }, useRoomStore.getState().deviceId);
        this.mix = mix;
        this.voice?.voice.apply(scene, mix);
        this.external?.apply(scene, mix);
      } catch {
        /* next tick */
      }
    }, 33);
  }

  private stopOrbit() {
    if (this.orbitTimer) clearInterval(this.orbitTimer);
    this.orbitTimer = null;
  }

  private ensureAssets(room: RoomState) {
    const rendered = room.queue.filter((t) => t.sourceClass === 'rendered' && t.url);
    const cur = this.currentTrack(room);
    const idx = cur ? room.queue.indexOf(cur) : -1;
    const wanted = [cur, ...room.queue.slice(idx + 1)].filter((t): t is Track => !!t && rendered.includes(t)).slice(0, 2);
    if (!cur && rendered[0]) wanted.splice(0, wanted.length, rendered[0]);
    this.assets.ensure(wanted);
  }

  // ---------- playback ----------

  /** Bring audio in line with room.playback. Idempotent; `force` rebuilds the source even if unchanged. */
  reconcile(force = false): void {
    this.gate.request(force);
    try {
      this.reconcileInner(this.gate.pending);
    } catch (e) {
      setError(`Playback error: ${errMsg(e)}`);
    }
    this.publish();
  }

  private reconcileInner(force: boolean) {
    const ctx = this.ctx;
    const room = useRoomStore.getState().room;
    if (!ctx || !room || !this.chain || !this.mix) return;
    const pb = room.playback;
    const track = this.currentTrack(room);
    if (pb.status !== 'playing' || !track || track.sourceClass !== 'rendered') {
      this.gate.take(); // nothing to rebuild
      this.stopForPlayback(pb);
      return;
    }
    if (!this.timingReady()) return; // resumes on clock sync / audio clock ready (a forced rebuild stays pending)
    const key = playbackKey(pb);
    if (!force && this.voice && this.voice.key === key && this.voice.stopAt === null) return;
    const buffer = this.assets.buffer(track.id);
    if (!buffer) return; // resumes when the asset is ready
    const comp = this.compensationSec();
    // one clock snapshot per decision: a LAN ↔ server path flip must not split one computation
    const clock = this.deps.clock()!;
    this.lastLeadMs = clock.toLocalTime(pb.startRoomTime) - performance.now();
    this.lastSkewMs = this.audioClock.ctxToPerf(ctx.currentTime) - performance.now();
    const d = computeStart({
      startRoomTime: pb.startRoomTime,
      trackOffset: pb.trackOffset,
      roomToCtx: (r) => this.audioClock.perfToCtx(clock.toLocalTime(r)),
      nowCtx: ctx.currentTime,
      compensationSec: comp,
      durationSec: buffer.duration,
    });
    if (!d) {
      this.gate.take();
      this.stopVoice(ctx.currentTime);
      return;
    }
    const old = this.voice;
    const action = force ? 'reschedule' : old && old.stopAt === null && old.trackId === track.id ? 'seek' : 'play';
    this.startVoice(track.id, key, buffer, d, comp, pb, action);
  }

  private startVoice(
    trackId: string,
    key: string,
    buffer: AudioBuffer,
    d: StartDecision,
    comp: number,
    pb: Playback,
    action: ScheduleRecord['action'],
  ) {
    const ctx = this.ctx!;
    const room = useRoomStore.getState().room!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const voice = new Voice(ctx, src, buffer.numberOfChannels, this.chain!);
    voice.apply(this.heardScene(room), this.mix!);
    const old = this.voice;
    let fadeUntil = 0;
    if (old && old.stopAt === null) {
      const plan = transitionPlan({
        crossfadeSec: pb.crossfadeSec,
        whenCtx: d.when,
        scheduledStartCtx: this.roomToCtx(pb.startRoomTime) - comp,
      });
      if (plan.kind === 'crossfade') {
        fadeUntil = plan.end;
        this.crossfade(old, voice, plan.start, plan.end);
      } else if (plan.kind === 'gapless') {
        // the old buffer ends right here on the room timeline; a decoder that padded it is cut over XFADE
        voice.fade.gain.value = 1;
        this.fadeOut(old, d.when);
        this.outgoing = old;
      } else {
        voice.fade.gain.setValueAtTime(0, d.when);
        voice.fade.gain.linearRampToValueAtTime(1, d.when + XFADE_SEC);
        this.fadeOut(old, d.when);
      }
    } else {
      voice.fade.gain.value = 1;
    }
    const g = snapToSampleGrid(d.when, d.offset, ctx.sampleRate);
    // start at the learned clock-rate correction, not at 1: the integral is this device's, not the track's
    const rate = this.drift.hold().rate;
    src.playbackRate.value = rate;
    src.start(g.when, g.offset);
    const tracker = new PlaybackTracker();
    tracker.start(g.when, g.offset, rate);
    this.lastTickCtx = null;
    this.gate.take();
    const pv: PlayingVoice = { voice, src, key, trackId, when: d.when, tracker, stopAt: null, fadeUntil };
    src.onended = () => {
      voice.dispose();
      if (this.voice === pv) this.voice = null;
      if (this.outgoing === pv) this.outgoing = null;
      this.publish();
    };
    this.voice = pv;
    const L = outputLatencyMs(this.latencyInput());
    recordSchedule({
      action: pb.crossfadeSec !== undefined && action === 'play' ? 'advance' : action,
      trackId,
      startRoomTime: pb.startRoomTime,
      trackOffset: pb.trackOffset,
      whenCtx: d.when,
      offset: d.offset,
      compensationSec: comp,
      late: d.late,
      arrivedLeadMs: Math.round(this.lastLeadMs),
      audioSteps: this.audioClock.steps,
      mapSkewMs: Math.round(this.lastSkewMs),
      pendingSteps: this.audioClock.pendingSteps(),
      expectedHeardEpochMs: expectedHeardEpochMs({
        timeOrigin: performance.timeOrigin,
        ctxToPerf: (c) => this.audioClock.ctxToPerf(c),
        whenCtx: d.when,
        offset: d.offset,
        trackOffset: pb.trackOffset,
        outputLatencyMs: L,
      }),
    });
  }

  /** ramp `pv` out over XFADE starting at `startAt` (ctx s) */
  private fadeOut(pv: PlayingVoice, startAt: number) {
    const ctx = this.ctx!;
    const t = Math.max(startAt, ctx.currentTime);
    const g = pv.voice.fade.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value || 1, t);
      g.linearRampToValueAtTime(0, t + XFADE_SEC);
    } catch {
      /* inside its own fade-in curve: the stop below ends it */
    }
    pv.stopAt = t + XFADE_SEC;
    try {
      pv.src.stop(t + XFADE_SEC + 0.005);
    } catch {
      /* not started */
    }
  }

  /** equal-power crossfade over [start, end] (ctx s): `pv` out, `voice` in; `pv` stops at the end */
  private crossfade(pv: PlayingVoice, voice: Voice, start: number, end: number) {
    const dur = end - start;
    const { fadeIn, fadeOut } = equalPowerCurves(Math.min(512, Math.max(16, dur * 100)));
    voice.fade.gain.value = 0;
    voice.fade.gain.setValueCurveAtTime(fadeIn, start, dur);
    // the outgoing voice may still be fading in (short track): its curve cannot be edited, so start after it
    const outStart = Math.max(start, pv.fadeUntil);
    const g = pv.voice.fade.gain;
    try {
      g.cancelScheduledValues(outStart);
      if (end - outStart > 0.005) g.setValueCurveAtTime(fadeOut, outStart, end - outStart);
      else g.setValueAtTime(0, end);
    } catch {
      /* automation conflict: the hard stop below still ends it on time */
    }
    pv.stopAt = end;
    try {
      pv.src.stop(end + 0.005);
    } catch {
      /* not started */
    }
    this.outgoing = pv;
  }

  private stopVoice(atCtx: number) {
    const pv = this.voice;
    if (!pv || pv.stopAt !== null) return;
    this.fadeOut(pv, atCtx - XFADE_SEC);
  }

  /** pause/stop: end at the scheduled room time (if it's in the future), else now */
  private stopForPlayback(pb: Playback) {
    const ctx = this.ctx!;
    if (!this.voice || this.voice.stopAt !== null) return;
    let at = ctx.currentTime;
    if (this.timingReady()) {
      const nowRoom = this.ctxToRoom(ctx.currentTime);
      if (pb.startRoomTime > nowRoom && pb.startRoomTime - nowRoom < 10_000) {
        at = Math.max(at, this.roomToCtx(pb.startRoomTime) - this.compensationSec());
      }
    }
    const trackId = this.voice.trackId;
    this.stopVoice(at);
    const out = this.outgoing;
    if (out && out.stopAt !== null && out.stopAt > at + XFADE_SEC) {
      // a pause mid-transition also ends the track that was fading out
      try {
        out.src.stop(Math.max(at, ctx.currentTime) + XFADE_SEC);
      } catch {
        /* not started */
      }
      out.stopAt = at + XFADE_SEC;
    }
    recordSchedule({
      action: pb.status === 'paused' ? 'pause' : 'stop',
      trackId,
      startRoomTime: pb.startRoomTime,
      trackOffset: pb.trackOffset,
      whenCtx: at,
      offset: pb.trackOffset,
      compensationSec: this.compensationSec(),
      late: false,
      arrivedLeadMs: 0,
      audioSteps: this.audioClock.steps,
      mapSkewMs: 0,
      pendingSteps: this.audioClock.pendingSteps(),
      expectedHeardEpochMs: expectedHeardEpochMs({
        timeOrigin: performance.timeOrigin,
        ctxToPerf: (c) => this.audioClock.ctxToPerf(c),
        whenCtx: at,
        offset: pb.trackOffset,
        trackOffset: pb.trackOffset,
        outputLatencyMs: outputLatencyMs(this.latencyInput()),
      }),
    });
  }

  // ---------- drift loop ----------

  private lastTick = { t: 0 };

  private tick() {
    if (!dueNow(this.lastTick, 1500)) return;
    const ctx = this.ctx;
    const room = useRoomStore.getState().room;
    const pv = this.voice;
    try {
      // (re)start the click once timing is ready, and re-align it to the room clock every 30 s
      if (this.clickOn && ctx && (!this.click || ctx.currentTime - this.click.startedCtx > 30)) this.startClick();
      if (!ctx || !room || !pv || pv.stopAt !== null) return;
      const now = ctx.currentTime;
      if (!this.timingReady()) {
        // no measurement right now (clock re-acquiring, audio clock reset): hold the learned rate rather than
        // freezing in whatever proportional nudge was applied last
        this.applyRate(pv, now, this.drift.hold().rate, false);
        return;
      }
      const pb = room.playback;
      if (pb.status !== 'playing' || playbackKey(pb) !== pv.key) return;
      if (now < pv.when + 0.2) return;
      const dt = tickDt(this.lastTickCtx, now, batterySaver() ? 1.5 : 0.5);
      this.lastTickCtx = now;
      this.noteTickGap(now, dt);
      const clock = this.deps.clock()!;
      const expected = expectedPositionAtCtx(pb, now, (c) => clock.toRoomTime(this.audioClock.ctxToPerf(c)), this.compensationSec());
      const err = driftErrorMs(pv.tracker.positionAt(now), expected);
      this.syncErrorMs = Math.abs(err);
      const dec = this.drift.update(err, dt);
      if (dec.action === 'reschedule') {
        this.corrections = { ...this.corrections, reschedule: this.corrections.reschedule + 1 };
        this.reconcile(true);
        return;
      }
      this.applyRate(pv, now, dec.rate, dec.action === 'rate');
    } catch (e) {
      setError(`Sync loop error: ${errMsg(e)}`);
    } finally {
      this.publish();
    }
  }

  private applyRate(pv: PlayingVoice, now: number, rate: number, counted: boolean) {
    if (rate === pv.tracker.rate) return;
    if (counted) this.corrections = { ...this.corrections, rate: this.corrections.rate + 1 };
    pv.src.playbackRate.setTargetAtTime(rate, now, 0.02);
    pv.tracker.setRate(now, rate);
  }

  private noteTickGap(nowCtx: number, dtSec: number) {
    this.tickGaps.push([nowCtx, dtSec * 1000]);
    while (this.tickGaps.length && this.tickGaps[0]![0] < nowCtx - 60) this.tickGaps.shift();
  }

  // ---------- extras ----------

  setEqBypass(bypass: boolean) {
    this.chain?.setBypass(bypass);
    patch('engine', { eqBypassed: bypass });
  }

  setClickTest(on: boolean) {
    this.clickOn = on;
    if (on) this.startClick();
    else this.stopClick();
    patch('engine', { clickTest: on });
  }

  /** click track whose beats land on multiples of 500 ms of room time (bars on 2000 ms), same compensation */
  private startClick() {
    const ctx = this.ctx;
    if (!ctx || !this.chain || !this.timingReady()) return;
    try {
      this.clickBuffer ??= this.toBuffer(clickTrack(120, 2, ctx.sampleRate));
      const comp = this.compensationSec();
      const nowRoom = this.ctxToRoom(ctx.currentTime + comp);
      const barRoom = Math.ceil((nowRoom + 300) / 2000) * 2000;
      const when = snapToSampleGrid(this.roomToCtx(barRoom) - comp, 0, ctx.sampleRate).when;
      const src = ctx.createBufferSource();
      src.buffer = this.clickBuffer;
      src.loop = true;
      src.loopEnd = this.clickBuffer.duration;
      src.connect(this.chain.fxIn);
      src.start(when);
      this.click?.src.stop(when);
      this.click = { src, startedCtx: when };
    } catch (e) {
      setError(`Click test error: ${errMsg(e)}`);
    }
  }

  private stopClick() {
    try {
      this.click?.src.stop();
    } catch {
      /* not started */
    }
    this.click = null;
  }

  toBuffer(samples: Float32Array): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, Math.max(1, samples.length), ctx.sampleRate);
    b.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return b;
  }

  /** room time → ctx start time for a one-shot that bypasses the mix (identify / calibration) */
  private oneShotWhen(roomMs: number, comp: number, clock?: TimeMap): number {
    const ctx = this.ctx!;
    // `clock` (a calibration run's clock: the LAN link, or the master's pinned mapping) overrides the live room clock
    const when = this.timingReady() ? (clock ? this.audioClock.perfToCtx(clock.toLocalTime(roomMs)) : this.roomToCtx(roomMs)) - comp : ctx.currentTime;
    return Math.max(when, ctx.currentTime + 0.005);
  }

  private loopbackNode: DelayNode | null = null;

  /**
   * Test mode `?loopbackMic=<delayMs>`: calibration/measurement emissions of THIS device are also routed (delayed)
   * straight into the calibration recorder inside the audio graph (sample-locked), instead of the microphone.
   * A stand-in "loopback mic" so the whole wizard can run headlessly; inactive unless the query param is present.
   */
  loopback(): DelayNode | null {
    const ctx = this.ctx;
    if (!ctx || typeof location === 'undefined') return null;
    const raw = new URLSearchParams(location.search).get('loopbackMic');
    if (raw === null) return null;
    if (!this.loopbackNode) {
      this.loopbackNode = ctx.createDelay(1.5);
      this.loopbackNode.delayTime.value = Math.min(Math.max(Number(raw) || 0, 0), 1000) / 1000;
    }
    return this.loopbackNode;
  }

  /**
   * Calibration emission: auto-only compensation, raw to the destination (no EQ/spatial). `viaChain` (sync check):
   * through the click-test input of the output chain (limiter, output delay and gain, like playback's tail; not EQ/crossover).
   */
  emitAt(samples: Float32Array, roomMs: number, comp: 'auto' | 'full' = 'auto', viaChain = false, clock?: TimeMap): { startCtx: number; endCtx: number } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.toBuffer(samples);
    src.connect(viaChain && this.chain ? this.chain.fxIn : ctx.destination);
    const lb = this.loopback();
    if (lb) src.connect(lb);
    const c = comp === 'full' ? this.compensationSec() : this.autoCompensationSec();
    const when = snapToSampleGrid(this.oneShotWhen(roomMs, c, clock), 0, ctx.sampleRate).when;
    src.start(when);
    return { startCtx: when, endCtx: when + src.buffer.duration };
  }

  identifyBeep(startRoomTime: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const when = this.oneShotWhen(startRoomTime, this.compensationSec());
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(ctx.destination);
      [0, 0.18, 0.36].forEach((dt, i) => {
        const o = ctx.createOscillator();
        o.frequency.value = [880, 1320, 1760][i]!;
        o.connect(g);
        o.start(when + dt);
        o.stop(when + dt + 0.12);
        g.gain.setValueAtTime(0, when + dt);
        g.gain.linearRampToValueAtTime(0.4, when + dt + 0.01);
        g.gain.setTargetAtTime(0, when + dt + 0.09, 0.01);
      });
      setTimeout(() => g.disconnect(), (when - ctx.currentTime + 1) * 1000);
    } catch (e) {
      setError(`Identify error: ${errMsg(e)}`);
    }
  }

  /**
   * capture mode: route a live stream (2 ch) through the same spatial graph. The voice starts silent; `fadeIn`
   * brings it up now, otherwise the caller does once the stream is aligned (fadeExternalIn).
   */
  attachExternal(node: AudioNode | null, opts: { fadeIn: boolean } = { fadeIn: true }) {
    this.detachExternal();
    if (!node || !this.ctx || !this.chain) return;
    const v = new Voice(this.ctx, node, 2, this.chain);
    const room = useRoomStore.getState().room;
    if (room && this.mix) v.apply(this.heardScene(room), this.mix);
    this.external = v;
    this.taps?.setExternal(node);
    if (opts.fadeIn) this.fadeExternalIn();
  }

  fadeExternalIn(sec = EXTERNAL_FADE_SEC) {
    const v = this.external;
    const ctx = this.ctx;
    if (!v || !ctx) return;
    const g = v.fade.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(1, ctx.currentTime + sec);
  }

  /** fade the live voice out and drop it once the fade is over (the caller keeps its stream alive that long) */
  detachExternal(sec = EXTERNAL_FADE_SEC) {
    const v = this.external;
    const ctx = this.ctx;
    this.external = null;
    this.taps?.setExternal(null);
    if (!v) return;
    if (!ctx || ctx.state === 'closed') {
      v.dispose();
      return;
    }
    const g = v.fade.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(0, ctx.currentTime + sec);
    setTimeout(() => v.dispose(), (sec + 0.02) * 1000);
  }

  /** live-capture alignment delay; true when the chain actually switched (see OutputChain.setDelayMs) */
  setOutputDelayMs(ms: number): boolean {
    return this.chain?.setDelayMs(ms) ?? false;
  }

  /** `?tap=1` instrumentation: what this device plays (per channel) and what the live source carries */
  readTaps() {
    return this.taps?.read() ?? null;
  }

  // ---------- store ----------

  private publish() {
    const ctx = this.ctx;
    const cur = this.currentTrack();
    const entry = cur ? this.assets.get(cur.id) : undefined;
    const pv = this.voice;
    const out = this.outgoing;
    const playing = !!ctx && !!pv && pv.stopAt === null && ctx.currentTime >= pv.when;
    // between an auto-advance SCHEDULE and the new track's start the previous track is still playing out
    const playingOut = !!ctx && !!out && out.stopAt !== null && ctx.currentTime < out.stopAt;
    let comp = 0;
    try {
      comp = this.compensationSec() * 1000;
    } catch {
      /* mix not ready */
    }
    patch('engine', {
      unlocked: !!ctx,
      ctxState: ctx ? (ctx.state as 'suspended' | 'running' | 'closed' | 'interrupted') : 'none',
      sampleRate: ctx?.sampleRate ?? null,
      autoLatencyMs: this.autoLatencyMs === null ? null : Math.round(this.autoLatencyMs * 10) / 10,
      usingOutputTimestamp: this.usingOutputTimestamp,
      bufferState: playing || playingOut ? 'playing' : (entry?.state ?? 'idle'),
      loadedTrackId: playing ? pv!.trackId : playingOut ? out!.trackId : entry?.state === 'ready' ? cur!.id : null,
      syncErrorMs: Math.round(this.syncErrorMs * 10) / 10,
      playbackRate: pv?.tracker.rate ?? 1,
      corrections: this.corrections,
      compensationMs: Math.round(comp * 10) / 10,
      tickGapMs: Math.round(Math.max(0, ...this.tickGaps.map((g) => g[1]))),
      audioSteps: this.audioClock.steps,
    });
  }
}

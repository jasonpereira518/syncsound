/**
 * The per-device audio engine: AudioContext lifecycle, roomTime↔ctx mapping, scheduling with latency
 * compensation, drift correction, spatial mix + EQ graph, click test, identify beeps.
 * Browser-only: create it from client code after a user gesture (`unlock()`).
 */
import { setAudioSession } from '../audioSession';
import { batterySaver, dueNow } from '../power';
import {
  AudioClockMap,
  DriftController,
  PlaybackTracker,
  clickTrack,
  computeDeviceMix,
  computeStart,
  sceneAt,
  type RoomClock,
  type DeviceMix,
  type StartDecision,
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
  expectedHeardEpochMs,
  expectedPositionAtCtx,
  outputLatencyMs,
  type LatencyInput,
  snapToSampleGrid,
} from './timing';

interface PlayingVoice {
  voice: Voice;
  src: AudioBufferSourceNode;
  key: string;
  trackId: string;
  when: number;
  tracker: PlaybackTracker;
  stopAt: number | null;
}

export interface EngineDeps {
  clock: () => RoomClock | null;
  /** clock burst done since the last (re)connect */
  clockReady: () => boolean;
  /** media devices changed outside a calibration run; default: prompt to recalibrate */
  onRouteChange?: () => void;
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
  private external: Voice | null = null;
  private readonly assets: AssetCache;
  private readonly drift = new DriftController();
  private intervals: Array<ReturnType<typeof setInterval>> = [];
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
    ctx.onstatechange = () => {
      // a suspension freezes ctx time while perf time runs on → the mapping is no longer linear
      this.audioClock.reset();
      // iOS 'interrupted' (a call, Siri, another app's audio): try to come back by ourselves once it ends; if the
      // browser wants a tap for that, the room shows a "turn the sound back on" button (resume()).
      if (ctx.state !== 'running' && ctx.state !== 'closed' && document.visibilityState === 'visible') void ctx.resume().catch(() => {});
      this.publish();
    };
    this.intervals.push(setInterval(() => this.observeClock(), 250));
    this.intervals.push(setInterval(() => this.tick(), 500));
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
    void this.acquireWakeLock();
    this.onRoomChanged();
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
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
    this.external = null;
    this.chain?.dispose();
    this.chain = null;
    void ctx?.close().catch(() => {});
  }

  /** MUST run inside a user gesture: bring a suspended / interrupted context back (iOS needs the tap) */
  resume(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    setAudioSession('playback');
    void ctx.resume().then(() => this.reconcile(true), () => {});
  }

  /** tab visible again: resume audio + wake lock; the caller re-bursts the clock then calls reconcile(true) */
  onVisible(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
    void this.acquireWakeLock();
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
      else if (this.audioClock.steps > steps && performance.now() > this.measuringUntil) useRoomStore.setState({ routeChanged: true });
      const ready = this.timingReady();
      if (ready && !this.clockWasReady) this.reconcile();
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
    try {
      this.reconcileInner(force);
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
      this.stopForPlayback(pb);
      return;
    }
    if (!this.timingReady()) return; // resumes on clock sync / audio clock ready
    const key = playbackKey(pb);
    if (!force && this.voice && this.voice.key === key && this.voice.stopAt === null) return;
    const buffer = this.assets.buffer(track.id);
    if (!buffer) return; // resumes when the asset is ready
    const comp = this.compensationSec();
    const d = computeStart({
      startRoomTime: pb.startRoomTime,
      trackOffset: pb.trackOffset,
      roomToCtx: this.roomToCtx,
      nowCtx: ctx.currentTime,
      compensationSec: comp,
      durationSec: buffer.duration,
    });
    if (!d) {
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
    if (old && old.stopAt === null) {
      voice.fade.gain.setValueAtTime(0, d.when);
      voice.fade.gain.linearRampToValueAtTime(1, d.when + XFADE_SEC);
      this.fadeOut(old, d.when);
    } else {
      voice.fade.gain.value = 1;
    }
    const g = snapToSampleGrid(d.when, d.offset, ctx.sampleRate);
    src.start(g.when, g.offset);
    const tracker = new PlaybackTracker();
    tracker.start(g.when, g.offset);
    const pv: PlayingVoice = { voice, src, key, trackId, when: d.when, tracker, stopAt: null };
    src.onended = () => {
      voice.dispose();
      if (this.voice === pv) this.voice = null;
      this.publish();
    };
    this.voice = pv;
    const L = outputLatencyMs(this.latencyInput());
    recordSchedule({
      action,
      trackId,
      startRoomTime: pb.startRoomTime,
      trackOffset: pb.trackOffset,
      whenCtx: d.when,
      offset: d.offset,
      compensationSec: comp,
      late: d.late,
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

  /** ramp `pv` out over XFADE ending at `endAt` (ctx s) */
  private fadeOut(pv: PlayingVoice, startAt: number) {
    const ctx = this.ctx!;
    const t = Math.max(startAt, ctx.currentTime);
    const g = pv.voice.fade.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value || 1, t);
    g.linearRampToValueAtTime(0, t + XFADE_SEC);
    pv.stopAt = t + XFADE_SEC;
    try {
      pv.src.stop(t + XFADE_SEC + 0.005);
    } catch {
      /* not started */
    }
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
    recordSchedule({
      action: pb.status === 'paused' ? 'pause' : 'stop',
      trackId,
      startRoomTime: pb.startRoomTime,
      trackOffset: pb.trackOffset,
      whenCtx: at,
      offset: pb.trackOffset,
      compensationSec: this.compensationSec(),
      late: false,
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
      if (!ctx || !room || !pv || pv.stopAt !== null || !this.timingReady()) return;
      const pb = room.playback;
      if (pb.status !== 'playing' || playbackKey(pb) !== pv.key) return;
      const now = ctx.currentTime;
      if (now < pv.when + 0.2) return;
      const expected = expectedPositionAtCtx(pb, now, this.ctxToRoom, this.compensationSec());
      const err = driftErrorMs(pv.tracker.positionAt(now), expected);
      this.syncErrorMs = Math.abs(err);
      const dec = this.drift.update(err, batterySaver() ? 1.5 : 0.5);
      if (dec.action === 'reschedule') {
        this.corrections = { ...this.corrections, reschedule: this.corrections.reschedule + 1 };
        this.reconcile(true);
        return;
      }
      const rate = dec.rate;
      if (rate !== pv.tracker.rate) {
        if (dec.action === 'rate') this.corrections = { ...this.corrections, rate: this.corrections.rate + 1 };
        pv.src.playbackRate.setTargetAtTime(rate, now, 0.02);
        pv.tracker.setRate(now, rate);
      }
    } catch (e) {
      setError(`Sync loop error: ${errMsg(e)}`);
    } finally {
      this.publish();
    }
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
  private oneShotWhen(roomMs: number, comp: number): number {
    const ctx = this.ctx!;
    const when = this.timingReady() ? this.roomToCtx(roomMs) - comp : ctx.currentTime;
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
  emitAt(samples: Float32Array, roomMs: number, comp: 'auto' | 'full' = 'auto', viaChain = false): { startCtx: number; endCtx: number } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.toBuffer(samples);
    src.connect(viaChain && this.chain ? this.chain.fxIn : ctx.destination);
    const lb = this.loopback();
    if (lb) src.connect(lb);
    const c = comp === 'full' ? this.compensationSec() : this.autoCompensationSec();
    const when = snapToSampleGrid(this.oneShotWhen(roomMs, c), 0, ctx.sampleRate).when;
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

  /** capture mode: route a live stream (2 ch) through the same spatial graph */
  attachExternal(node: AudioNode | null) {
    this.external?.dispose();
    this.external = null;
    if (!node || !this.ctx || !this.chain) return;
    const v = new Voice(this.ctx, node, 2, this.chain);
    const room = useRoomStore.getState().room;
    if (room && this.mix) v.apply(this.heardScene(room), this.mix);
    v.fade.gain.value = 1;
    this.external = v;
  }

  setOutputDelayMs(ms: number) {
    this.chain?.setDelayMs(ms);
  }

  // ---------- store ----------

  private publish() {
    const ctx = this.ctx;
    const cur = this.currentTrack();
    const entry = cur ? this.assets.get(cur.id) : undefined;
    const pv = this.voice;
    const playing = !!ctx && !!pv && pv.stopAt === null && ctx.currentTime >= pv.when;
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
      bufferState: playing ? 'playing' : (entry?.state ?? 'idle'),
      loadedTrackId: playing ? pv!.trackId : entry?.state === 'ready' ? cur!.id : null,
      syncErrorMs: Math.round(this.syncErrorMs * 10) / 10,
      playbackRate: pv?.tracker.rate ?? 1,
      corrections: this.corrections,
      compensationMs: Math.round(comp * 10) / 10,
    });
  }
}

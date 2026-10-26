/**
 * Video mode 1: capture tab/system audio on the host, stream it to every device over the WebRTC mesh, and
 * play it everywhere at ≈ captureTime + videoBufferMs. Browser-only.
 *
 * Alignment: each receiver measures its network + jitter-buffer delay (getStats), filters it (median) and sets the
 * output delay to buffer − pipeline − compensation in rare, sample-exact, click-free steps (liveDelay.ts →
 * OutputChain.setDelayMs). A receiver stays silent until its first estimate, so the first step is never heard.
 * The host plays the stream itself only when that can't feed back into the capture (capturePolicy.ts).
 */
import { defaultSettings, type ClientMessage, type RoomState, type RtcData } from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
import { RtcMesh } from '../rtc';
import type { AudioEngine } from './audioEngine';
import { captureOptions, hostPlayback, isOwnCapture, shouldMonitor, type DisplaySurface } from './capturePolicy';
import { LIVE_DELAY, PipelineFilter, bufferShortfallMs, jitterTargetMs, nextDelayMs } from './liveDelay';
import { captureDelayMs } from './timing';

const SILENCE_DBFS = -70;
const SILENCE_MS = 3000;
/** the live voice fades out over 20 ms: its stream and peers must outlive that, or the fade ends in a click */
const TEARDOWN_DELAY_MS = 40;

/**
 * Test mode `?fakeCapture=tone|silent`: stands in for getDisplayMedia so the WebRTC mesh and the DRM-silence
 * detection can be exercised headlessly (a 440/660 Hz stereo tone, or digital silence like a DRM tab).
 */
function fakeCaptureStream(ctx: AudioContext, silent: boolean): MediaStream {
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  if (!silent) {
    const merger = ctx.createChannelMerger(2);
    [440, 660].forEach((f, ch) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.value = 0.2;
      o.connect(g).connect(merger, 0, ch);
      o.start();
    });
    merger.connect(dest);
  }
  return dest.stream;
}

type CaptureHandle = { origin?: string; handle?: string } | null;

/** Capture Handle (Chrome/Edge): a tag other SyncSound tabs in this browser see when they capture this tab. */
function installCaptureHandle(): { origin: string; handle: string } | null {
  if (typeof navigator === 'undefined' || typeof location === 'undefined') return null;
  const md = navigator.mediaDevices as
    | (MediaDevices & {
        setCaptureHandleConfig?: (c: { exposeOrigin: boolean; handle: string; permittedOrigins: string[] }) => void;
      })
    | undefined;
  if (!md?.setCaptureHandleConfig) return null;
  try {
    const handle = Math.random().toString(36).slice(2, 18);
    md.setCaptureHandleConfig({ exposeOrigin: true, handle, permittedOrigins: [location.origin] });
    return { origin: location.origin, handle };
  } catch {
    return null;
  }
}

function captureHandleOf(track: MediaStreamTrack | undefined): CaptureHandle {
  try {
    return (track as (MediaStreamTrack & { getCaptureHandle?: () => CaptureHandle }) | undefined)?.getCaptureHandle?.() ?? null;
  } catch {
    return null;
  }
}

/** instrumentation (`window.__syncsound.liveDelay()`) */
export interface LiveDelayInfo {
  appliedMs: number | null;
  changes: number;
  estimateMs: number | null;
  monitoring: boolean;
  audible: boolean;
}

export class CaptureController {
  private mesh: RtcMesh | null = null;
  private role: 'host' | 'receiver' | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private receivingFrom: string | null = null;
  private sawHost = false;
  private readonly own = installCaptureHandle();
  // alignment governor
  private readonly filter = new PipelineFilter();
  private appliedMs: number | null = null;
  private delayChanges = 0;
  private settingsKey = '';
  /** the host plays the stream through its own chain */
  private monitoring = false;
  /** the live voice has been faded in (receivers wait for the first delay estimate) */
  private audible = false;

  constructor(
    private readonly engine: AudioEngine,
    private readonly send: (m: ClientMessage) => boolean,
  ) {}

  /** MUST be called from a user gesture (getDisplayMedia needs transient activation). */
  async start(): Promise<void> {
    if (this.role === 'host') return;
    patch('capture', { error: null, silent: false });
    try {
      if (!this.engine.ctx) throw new Error('Join the speaker array first.');
      const fake = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fakeCapture') : null;
      if (!fake && !navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser can't capture tab audio. Use desktop Chrome or Edge.");
      let stream: MediaStream;
      try {
        stream = fake ? fakeCaptureStream(this.engine.ctx, fake === 'silent') : await navigator.mediaDevices.getDisplayMedia(captureOptions());
      } catch (e) {
        throw new Error(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Capture was cancelled.' : `Couldn't start capture: ${errMsg(e)}`);
      }
      const audio = stream.getAudioTracks()[0];
      if (!audio) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("No audio was shared. Share a tab with 'Share tab audio' checked.");
      }
      this.teardownReceive();
      // what was shared lives on the video track; the share needs it, so keep it alive but don't encode it
      const video = stream.getVideoTracks()[0];
      const surface = fake ? 'browser' : (video?.getSettings().displaySurface as DisplaySurface);
      const capturedSelf = !fake && isOwnCapture(captureHandleOf(video), this.own);
      stream.getVideoTracks().forEach((t) => (t.enabled = false));
      try {
        audio.contentHint = 'music';
      } catch {
        /* read-only in some browsers */
      }
      audio.addEventListener('ended', () => this.stop());
      this.stream = stream;
      this.role = 'host';
      const ctx = this.engine.ctx;
      this.source = ctx.createMediaStreamSource(new MediaStream([audio]));
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.source.connect(this.analyser);
      // never play what could end up back inside the capture (the app tab is excluded from the picker; a window or
      // the whole screen is heard from the OS already)
      this.monitoring = shouldMonitor({ surface, capturedSelf });
      if (this.monitoring) {
        this.engine.attachExternal(this.source, { fadeIn: true });
        this.audible = true;
      }
      this.mesh = this.newMesh();
      this.mesh.setLocalTrack(audio, stream);
      this.send({ type: 'CAPTURE', active: true });
      this.syncHostPeers(useRoomStore.getState().room);
      this.watchSilence();
      this.updateDelay(true);
      patch('capture', {
        active: true,
        receiving: false,
        surface: surface ?? null,
        monitoring: this.monitoring,
        hostPlayback: hostPlayback({ surface, monitoring: this.monitoring }),
      });
    } catch (e) {
      patch('capture', { error: errMsg(e) });
    }
  }

  stop(): void {
    if (this.role !== 'host') return;
    this.send({ type: 'CAPTURE', active: false });
    this.release(true);
    patch('capture', { active: false, silent: false, peers: 0, surface: null, monitoring: false, hostPlayback: null });
  }

  onRoomChanged(room: RoomState | null): void {
    if (this.role === 'host') this.syncHostPeers(room);
    else if (this.role === 'receiver') {
      // the offer can race the STATE that names the capture host: only tear down on a real change
      const hostId = room?.captureHostId ?? null;
      const hostGone = !room?.devices.some((d) => d.id === this.receivingFrom && d.connected);
      if (hostId === this.receivingFrom) this.sawHost = true;
      if (hostGone || (hostId !== null && hostId !== this.receivingFrom) || (hostId === null && this.sawHost)) this.teardownReceive();
    }
    // the sliders moved: apply even a small change at once (a 5 ms nudge step is below the deadband)
    const key = room ? `${room.settings.videoBufferMs}|${room.settings.lipSyncNudgeMs}` : '';
    const settingsChanged = key !== this.settingsKey;
    this.settingsKey = key;
    if (settingsChanged && room && this.role === 'receiver') this.setJitterTarget(room.settings.videoBufferMs);
    this.updateDelay(settingsChanged);
  }

  onSignal(from: string, data: RtcData): void {
    if (this.role !== 'host' && data.kind === 'offer') {
      if (this.role !== 'receiver') {
        this.role = 'receiver';
        this.mesh = this.newMesh();
        this.setJitterTarget(useRoomStore.getState().room?.settings.videoBufferMs ?? defaultSettings().videoBufferMs);
        this.timers.push(setInterval(() => void this.pollStats(), LIVE_DELAY.pollMs));
      }
      this.receivingFrom = from;
    }
    void this.mesh?.handleSignal(from, data);
    if (data.kind === 'hangup' && this.role === 'receiver' && from === this.receivingFrom) this.teardownReceive();
  }

  dispose(): void {
    if (this.role === 'host') this.stop();
    else this.teardownReceive();
  }

  liveDelayInfo(): LiveDelayInfo {
    return {
      appliedMs: this.appliedMs,
      changes: this.delayChanges,
      estimateMs: this.filter.estimate(),
      monitoring: this.monitoring,
      audible: this.audible,
    };
  }

  private newMesh() {
    return new RtcMesh({
      send: (to, data) => this.send({ type: 'RTC_SIGNAL', to, data }),
      onRemoteStream: (_from, stream) => this.onRemoteStream(stream),
      onPeersChanged: (n) => patch('capture', { peers: n }),
      onError: (msg) => patch('capture', { error: msg }),
    });
  }

  private syncHostPeers(room: RoomState | null) {
    const myId = useRoomStore.getState().deviceId;
    this.mesh?.syncPeers(room ? room.devices.filter((d) => d.connected && d.id !== myId).map((d) => d.id) : []);
  }

  private setJitterTarget(videoBufferMs: number) {
    const jb = jitterTargetMs(videoBufferMs);
    this.mesh?.setJitterTargetMs(jb);
    patch('capture', { jitterTargetMs: jb });
  }

  private onRemoteStream(stream: MediaStream) {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    // Chrome only feeds WebRTC audio into Web Audio when the stream is also attached to a media element
    this.audioEl ??= new Audio();
    this.audioEl.muted = true;
    this.audioEl.srcObject = stream;
    void this.audioEl.play().catch(() => {});
    this.source?.disconnect();
    this.source = ctx.createMediaStreamSource(stream);
    // the first stream stays silent until the first delay estimate has aligned it; a renegotiated one fades in now
    this.audible = this.filter.estimate() !== null;
    this.engine.attachExternal(this.source, { fadeIn: this.audible });
    this.updateDelay();
    patch('capture', { receiving: true, error: null });
  }

  private async pollStats() {
    const mesh = this.mesh;
    const d = await mesh?.pipelineDelayMs();
    if (d === undefined || d === null || this.role !== 'receiver' || this.mesh !== mesh) return;
    this.filter.push(d);
    const estimate = this.filter.estimate();
    if (estimate === null) return;
    patch('capture', { pipelineDelayMs: Math.round(estimate) });
    this.updateDelay();
    if (!this.audible && this.appliedMs !== null) {
      this.audible = true;
      this.engine.fadeExternalIn();
    }
  }

  /** governor step: desired = buffer + nudge − pipeline − compensation; applied rarely, in whole samples */
  private updateDelay(force = false) {
    const room = useRoomStore.getState().room;
    const ctx = this.engine.ctx;
    if (!this.role || !room || !ctx) {
      this.engine.setOutputDelayMs(0);
      this.appliedMs = null;
      return;
    }
    const pipelineDelayMs = this.role === 'host' ? 0 : this.filter.estimate();
    if (pipelineDelayMs === null) return; // receiver before its first estimate: silent, nothing to align yet
    const input = {
      videoBufferMs: room.settings.videoBufferMs,
      lipSyncNudgeMs: room.settings.lipSyncNudgeMs,
      pipelineDelayMs,
      compensationMs: this.engine.compensationSec() * 1000,
    };
    const next = nextDelayMs({ desiredMs: captureDelayMs(input), appliedMs: this.appliedMs, sampleRate: ctx.sampleRate, force });
    if (next !== null) {
      if (this.engine.setOutputDelayMs(next)) this.delayChanges++;
      this.appliedMs = next;
    }
    const shortfall = bufferShortfallMs(input);
    patch('capture', {
      appliedDelayMs: this.appliedMs === null ? null : Math.round(this.appliedMs * 10) / 10,
      delayChanges: this.delayChanges,
      shortfallMs: shortfall > 0 ? Math.round(shortfall) : null,
    });
  }

  private watchSilence() {
    const buf = new Float32Array(2048);
    let quietSince: number | null = null;
    this.timers.push(
      setInterval(() => {
        const a = this.analyser;
        if (!a) return;
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const db = 10 * Math.log10(sum / buf.length + 1e-20);
        const now = performance.now();
        if (db >= SILENCE_DBFS) quietSince = null;
        else quietSince ??= now;
        patch('capture', { silent: quietSince !== null && now - quietSince > SILENCE_MS });
      }, 250),
    );
  }

  private teardownReceive() {
    if (this.role !== 'receiver') return;
    this.release(false);
    patch('capture', { receiving: false, peers: 0, pipelineDelayMs: null, jitterTargetMs: null, appliedDelayMs: null, shortfallMs: null });
  }

  /** Fade the live voice out now; drop the stream and peers once the fade is over (too early = a click). */
  private release(notifyPeers: boolean) {
    const { mesh, stream, source, analyser, audioEl } = this;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.engine.detachExternal();
    this.source = this.analyser = this.audioEl = this.mesh = this.stream = null;
    this.role = this.receivingFrom = null;
    this.sawHost = false;
    this.filter.reset();
    this.appliedMs = null;
    this.monitoring = this.audible = false;
    this.updateDelay();
    setTimeout(() => {
      mesh?.closeAll(notifyPeers);
      stream?.getTracks().forEach((t) => t.stop());
      if (audioEl) audioEl.srcObject = null;
      try {
        source?.disconnect();
        analyser?.disconnect();
      } catch {
        /* context closed */
      }
    }, TEARDOWN_DELAY_MS);
  }
}

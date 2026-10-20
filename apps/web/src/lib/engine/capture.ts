/**
 * Video mode 1: capture tab/system audio on the host, stream it to every device over the WebRTC mesh, and
 * play it everywhere (host monitor included) at ≈ captureTime + videoBufferMs. Browser-only.
 */
import type { ClientMessage, RoomState, RtcData } from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
import { RtcMesh } from '../rtc';
import type { AudioEngine } from './audioEngine';
import { captureDelayMs } from './timing';

const SILENCE_DBFS = -70;

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

/** not yet in lib.dom */
interface CaptureAudioConstraints extends MediaTrackConstraints {
  suppressLocalAudioPlayback?: boolean;
}
const CAPTURE_AUDIO: CaptureAudioConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  suppressLocalAudioPlayback: true,
};
interface CaptureOptions extends DisplayMediaStreamOptions {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
}
const CAPTURE_OPTIONS: CaptureOptions = {
  video: true,
  audio: CAPTURE_AUDIO,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  systemAudio: 'include',
};
const SILENCE_MS = 3000;

export class CaptureController {
  private mesh: RtcMesh | null = null;
  private role: 'host' | 'receiver' | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private pipelineDelayMs: number | null = null;
  private receivingFrom: string | null = null;
  private sawHost = false;

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
        stream = fake ? fakeCaptureStream(this.engine.ctx, fake === 'silent') : await navigator.mediaDevices.getDisplayMedia(CAPTURE_OPTIONS);
      } catch (e) {
        throw new Error(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Capture was cancelled.' : `Couldn't start capture: ${errMsg(e)}`);
      }
      const audio = stream.getAudioTracks()[0];
      if (!audio) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("No audio was shared. Share a tab with 'Share tab audio' checked.");
      }
      this.teardownReceive();
      stream.getVideoTracks().forEach((t) => (t.enabled = false)); // keep the share alive, skip encoding work
      audio.addEventListener('ended', () => this.stop());
      this.stream = stream;
      this.role = 'host';
      const ctx = this.engine.ctx;
      this.source = ctx.createMediaStreamSource(new MediaStream([audio]));
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.source.connect(this.analyser);
      this.engine.attachExternal(this.source);
      this.mesh = this.newMesh();
      this.mesh.setLocalTrack(audio, stream);
      this.send({ type: 'CAPTURE', active: true });
      this.syncHostPeers(useRoomStore.getState().room);
      this.watchSilence();
      this.updateDelay();
      patch('capture', { active: true, receiving: false });
    } catch (e) {
      patch('capture', { error: errMsg(e) });
    }
  }

  stop(): void {
    if (this.role !== 'host') return;
    this.send({ type: 'CAPTURE', active: false });
    this.mesh?.closeAll(true);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.reset();
    patch('capture', { active: false, silent: false, peers: 0 });
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
    this.updateDelay();
  }

  onSignal(from: string, data: RtcData): void {
    if (this.role !== 'host' && data.kind === 'offer') {
      if (this.role !== 'receiver') {
        this.role = 'receiver';
        this.mesh = this.newMesh();
        this.timers.push(setInterval(() => void this.pollStats(), 1000));
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
    this.engine.attachExternal(this.source);
    this.updateDelay();
    patch('capture', { receiving: true, error: null });
  }

  private async pollStats() {
    const d = await this.mesh?.pipelineDelayMs();
    if (d === undefined || d === null) return;
    this.pipelineDelayMs = d;
    patch('capture', { pipelineDelayMs: Math.round(d) });
    this.updateDelay();
  }

  private updateDelay() {
    const room = useRoomStore.getState().room;
    if (!this.role || !room) {
      this.engine.setOutputDelayMs(0);
      return;
    }
    this.engine.setOutputDelayMs(
      captureDelayMs({
        videoBufferMs: room.settings.videoBufferMs,
        lipSyncNudgeMs: room.settings.lipSyncNudgeMs,
        pipelineDelayMs: this.role === 'host' ? 0 : (this.pipelineDelayMs ?? 0),
        compensationMs: this.engine.compensationSec() * 1000,
      }),
    );
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
    this.mesh?.closeAll(false);
    this.reset();
    patch('capture', { receiving: false, peers: 0, pipelineDelayMs: null });
  }

  private reset() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.engine.attachExternal(null);
    this.source?.disconnect();
    this.analyser?.disconnect();
    if (this.audioEl) this.audioEl.srcObject = null;
    this.source = this.analyser = this.audioEl = this.mesh = this.stream = null;
    this.role = this.receivingFrom = null;
    this.sawHost = false;
    this.pipelineDelayMs = null;
    this.updateDelay();
  }
}

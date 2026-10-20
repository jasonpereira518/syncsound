/** Mode 2: a muted <video> driven by the room clock (its audio is the decoded track in the engine). */
import { useRoomStore } from '../../store/state';
import type { AudioEngine } from './audioEngine';
import { roomPosition, videoCorrection } from './timing';

export class VideoDriver {
  private el: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly nowRoom: () => number | null,
  ) {}

  attach(el: HTMLVideoElement | null) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.el && this.el !== el) this.el.playbackRate = 1;
    this.el = el;
    if (!el) return;
    el.muted = true;
    el.playsInline = true;
    this.timer = setInterval(() => this.tick(), 250);
  }

  private tick() {
    const el = this.el;
    const room = useRoomStore.getState().room;
    const now = this.nowRoom();
    if (!el || !room || now === null || el.readyState < 1) return;
    const pb = room.playback;
    // the frame on screen now should match the audio heard now (heard audio carries position at now − delay)
    let expected = roomPosition(pb, now - (this.engine.mix?.delaySec ?? 0) * 1000);
    if (Number.isFinite(el.duration)) expected = Math.min(expected, el.duration);
    if (pb.status !== 'playing' || expected < 0) {
      if (!el.paused) el.pause();
      el.playbackRate = 1;
      const target = Math.max(0, expected);
      if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
      return;
    }
    if (el.paused) {
      el.currentTime = expected;
      void el.play().catch(() => {});
      return;
    }
    const c = videoCorrection(el.currentTime - expected);
    if (c.seek) el.currentTime = expected;
    if (el.playbackRate !== c.rate) el.playbackRate = c.rate;
  }
}

/**
 * WebRTC mesh for capture mode: the capturing host offers one audio track to every peer; signaling over
 * RTC_SIGNAL. Browser-only.
 */
import type { RtcData } from '@syncsound/protocol';

const OPUS_PARAMS: Record<string, string> = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '256000', useinbandfec: '1' };
/** Opus packetization/encode delay not visible in getStats, ms */
const OPUS_FRAME_MS = 20;

/** Force stereo, 256 kb/s, in-band FEC on the Opus fmtp line. */
export function mungeOpusSdp(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  const params = new Map<string, string>();
  if (fmtpIdx >= 0) {
    for (const kv of lines[fmtpIdx]!.slice(`a=fmtp:${pt} `.length).split(';')) {
      const [k, v] = kv.split('=');
      if (k?.trim()) params.set(k.trim(), (v ?? '').trim());
    }
  }
  for (const [k, v] of Object.entries(OPUS_PARAMS)) params.set(k, v);
  const line = `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
  if (fmtpIdx >= 0) lines[fmtpIdx] = line;
  else lines.splice(lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `)) + 1, 0, line);
  return lines.join(eol);
}

interface Peer {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  jb: { delay: number; count: number } | null;
}

export interface MeshOptions {
  send: (to: string, data: RtcData) => void;
  onRemoteStream?: (from: string, stream: MediaStream) => void;
  onPeersChanged?: (n: number) => void;
  onError?: (msg: string) => void;
}

export class RtcMesh {
  private peers = new Map<string, Peer>();
  private local: { track: MediaStreamTrack; stream: MediaStream } | null = null;

  constructor(private readonly o: MeshOptions) {}

  get size() {
    return this.peers.size;
  }

  setLocalTrack(track: MediaStreamTrack, stream: MediaStream) {
    this.local = { track, stream };
  }

  /** host: offer to new peers, close peers that left */
  syncPeers(ids: string[]) {
    const want = new Set(ids);
    for (const id of this.peers.keys()) if (!want.has(id)) this.closePeer(id, true);
    for (const id of want) if (!this.peers.has(id)) void this.offer(id);
  }

  async handleSignal(from: string, data: RtcData): Promise<void> {
    try {
      if (data.kind === 'hangup') {
        this.closePeer(from, false);
        return;
      }
      if (data.kind === 'offer') {
        this.closePeer(from, false); // renegotiation = fresh peer (simple + robust)
        const peer = this.createPeer(from);
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await this.flushIce(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription({ type: 'answer', sdp: mungeOpusSdp(answer.sdp ?? '') });
        this.o.send(from, { kind: 'answer', sdp: peer.pc.localDescription?.sdp ?? '' });
        return;
      }
      const peer = this.peers.get(from);
      if (!peer) return;
      if (data.kind === 'answer') {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this.flushIce(peer);
      } else {
        const c: RTCIceCandidateInit = { candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex };
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(c);
        else peer.pendingIce.push(c);
      }
    } catch (e) {
      this.o.onError?.(`Connection setup with a device failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** receivers: estimated network + jitter-buffer delay, ms (max over peers) */
  async pipelineDelayMs(): Promise<number | null> {
    let best: number | null = null;
    for (const peer of this.peers.values()) {
      try {
        const stats = await peer.pc.getStats();
        let jbMs: number | null = null;
        let rttMs = 0;
        stats.forEach((r: { type: string; kind?: string; jitterBufferDelay?: number; jitterBufferEmittedCount?: number; state?: string; nominated?: boolean; currentRoundTripTime?: number }) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferEmittedCount) {
            const prev = peer.jb;
            const dDelay = r.jitterBufferDelay! - (prev?.delay ?? 0);
            const dCount = r.jitterBufferEmittedCount - (prev?.count ?? 0);
            peer.jb = { delay: r.jitterBufferDelay!, count: r.jitterBufferEmittedCount };
            // delta since the last poll tracks the current buffer; cumulative average as fallback
            jbMs = ((dCount > 0 ? dDelay / dCount : r.jitterBufferDelay! / r.jitterBufferEmittedCount) || 0) * 1000;
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime !== undefined) {
            rttMs = r.currentRoundTripTime * 1000;
          }
        });
        if (jbMs === null) continue;
        const total = jbMs + rttMs / 2 + OPUS_FRAME_MS;
        best = best === null ? total : Math.max(best, total);
      } catch {
        /* peer closing */
      }
    }
    return best;
  }

  closeAll(notify: boolean) {
    for (const id of [...this.peers.keys()]) this.closePeer(id, notify);
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const peer: Peer = { pc, pendingIce: [], jb: null };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate)
        this.o.send(id, { kind: 'ice', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
    };
    pc.ontrack = (e) => {
      const r = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
      try {
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = 40; // ms
        if ('playoutDelayHint' in r) r.playoutDelayHint = 0.04; // s (legacy Chrome)
      } catch {
        /* unsupported value */
      }
      this.o.onRemoteStream?.(id, e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePeer(id, false);
    };
    this.o.onPeersChanged?.(this.peers.size);
    return peer;
  }

  private async offer(id: string) {
    if (!this.local) return;
    const peer = this.createPeer(id);
    try {
      peer.pc.addTrack(this.local.track, this.local.stream);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ type: 'offer', sdp: mungeOpusSdp(offer.sdp ?? '') });
      this.o.send(id, { kind: 'offer', sdp: peer.pc.localDescription?.sdp ?? '' });
    } catch (e) {
      this.closePeer(id, false);
      this.o.onError?.(`Couldn't start streaming to a device: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async flushIce(peer: Peer) {
    const pending = peer.pendingIce.splice(0);
    for (const c of pending) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  private closePeer(id: string, notify: boolean) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (notify) this.o.send(id, { kind: 'hangup' });
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.o.onPeersChanged?.(this.peers.size);
  }
}

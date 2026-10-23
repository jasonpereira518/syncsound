/**
 * LAN clock master over a WebRTC DataChannel (unordered, no retransmits). One in-room device (pickClockMaster)
 * answers 10 Hz pings with its raw performance.now() and shares its server ClockSync mapping every 500 ms. Every
 * other device maps local → master-local (a tight LAN estimate) → room (the master's WAN estimate, identical for
 * everyone). A WAN error common to all devices doesn't separate them, so device-to-device spread is LAN error
 * only (packages/sim/test/lanMaster.test.ts). Callers fall back to the server clock whenever `ready` is false.
 */
import {
  ClockMapping,
  ClockSync,
  LAN_PING_MS,
  LAN_SYNC_OPTS,
  type ClockEstimate,
  type ClockMappingData,
  type RoomClock,
} from '@syncsound/audio-core';
import type { Device, RtcData } from '@syncsound/protocol';

export type LinkMsg = { t: 'ping'; t0: number } | { t: 'pong'; t0: number; r: number; s: number } | { t: 'map'; d: ClockMappingData };

/** no pong/mapping for this long → not ready (tab hidden, Wi-Fi hiccup, master gone) */
const STALE_MS = 3000;
const MAP_EVERY_TICKS = 5;

/** host if connected, else a connected desktop/laptop, else any connected device; ties by id (deterministic everywhere) */
export function pickClockMaster(devices: Device[], hostId: string | null): string | null {
  const live = devices.filter((d) => d.connected);
  const host = live.find((d) => d.id === hostId);
  if (host) return host.id;
  const rank = (d: Device) => (d.caps.deviceClass === 'desktop' || d.caps.deviceClass === 'laptop' ? 0 : 1);
  return [...live].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1))[0]?.id ?? null;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** parse a DataChannel message from another device (untrusted) */
export function parseLinkMsg(raw: unknown): LinkMsg | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (m.t === 'ping' && num(m.t0)) return { t: 'ping', t0: m.t0 };
  if (m.t === 'pong' && num(m.t0) && num(m.r) && num(m.s)) return { t: 'pong', t0: m.t0, r: m.r, s: m.s };
  const d = m.d as Record<string, unknown> | undefined;
  if (m.t === 'map' && d && num(d.t0) && num(d.a0) && num(d.s1) && num(d.s2) && (num(d.tEnd) || d.tEnd === null)) {
    // JSON has no Infinity: an open-ended slew segment travels as null
    return { t: 'map', d: { t0: d.t0, a0: d.a0, s1: d.s1, s2: d.s2, tEnd: d.tEnd ?? Infinity } };
  }
  return null;
}

interface Peer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
}

export interface ClockLinkOptions {
  selfId: string;
  /** RTC_SIGNAL with ch 'clock' */
  send: (to: string, data: RtcData) => void;
  /** this device's server ClockSync (the master shares its mapping) */
  serverClock: () => ClockSync;
  now?: () => number;
}

export class ClockLink implements RoomClock {
  private readonly lan = new ClockSync(LAN_SYNC_OPTS);
  private mapping: ClockMapping | null = null;
  private lastHeard = -Infinity;
  private master: string | null = null;
  private peers = new Map<string, Peer>();
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ClockLinkOptions) {
    this.now = o.now ?? (() => performance.now());
  }

  /** begin the 10 Hz ping / mapping loop (browser only) */
  start(): void {
    this.timer ??= setInterval(() => this.tick(), LAN_PING_MS);
  }

  get isMaster(): boolean {
    return this.master !== null && this.master === this.o.selfId;
  }

  /** peer with a fresh, converged LAN estimate and the master's mapping */
  get ready(): boolean {
    return (
      this.master !== null &&
      !this.isMaster &&
      this.mapping !== null &&
      this.lan.estimate().converged &&
      this.now() - this.lastHeard < STALE_MS
    );
  }

  /** call whenever the device list changes */
  setMaster(id: string | null): void {
    if (id === this.master) return;
    this.master = id;
    this.closeAll(true);
    this.lan.reset();
    this.mapping = null;
    if (id && id !== this.o.selfId) void this.connect(id);
  }

  toRoomTime(localMs: number): number {
    return this.mapping!.toRoomTime(this.lan.toRoomTime(localMs));
  }

  toLocalTime(roomMs: number): number {
    return this.lan.toLocalTime(this.mapping!.toLocalTime(roomMs));
  }

  estimate(): ClockEstimate {
    const e = this.lan.estimate();
    const t = this.now();
    return { ...e, offsetMs: this.toRoomTime(t) - t };
  }

  /** one tick: peers ping the master; the master pushes its mapping every MAP_EVERY_TICKS */
  tick(): void {
    this.ticks++;
    if (this.isMaster) {
      if (this.ticks % MAP_EVERY_TICKS) return;
      const map = this.mapMsg();
      if (map) for (const p of this.peers.values()) this.sendOn(p.dc, map);
    } else if (this.master) {
      this.sendOn(this.peers.get(this.master)?.dc ?? null, { t: 'ping', t0: this.now() });
    }
  }

  /** handle one message from `from`; returns a reply to send back, if any (transport-free for tests) */
  onMessage(from: string, msg: LinkMsg): LinkMsg | null {
    const t = this.now();
    if (msg.t === 'ping') return this.isMaster ? { t: 'pong', t0: msg.t0, r: t, s: this.now() } : null;
    if (from !== this.master) return null;
    if (msg.t === 'pong') this.lan.addSample({ t0: msg.t0, tsRecv: msg.r, tsSend: msg.s, t3: t });
    else this.mapping = new ClockMapping(msg.d);
    this.lastHeard = t;
    return null;
  }

  /** the master's current mapping, as a message (null until its server clock has converged) */
  mapMsg(): LinkMsg | null {
    const sc = this.o.serverClock();
    const d = sc.estimate().converged ? sc.mapping() : null;
    return d ? { t: 'map', d } : null;
  }

  async onSignal(from: string, data: RtcData): Promise<void> {
    try {
      if (data.kind === 'hangup') return this.closePeer(from, false);
      if (data.kind === 'offer') {
        this.closePeer(from, false);
        const peer = this.createPeer(from);
        peer.pc.ondatachannel = (e) => this.wire(from, peer, e.channel);
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await this.flushIce(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
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
    } catch {
      this.closePeer(from, false); // the server clock keeps working; the link is an optimisation
    }
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.closeAll(true);
  }

  private async connect(id: string) {
    const peer = this.createPeer(id);
    try {
      this.wire(id, peer, peer.pc.createDataChannel('clock', { ordered: false, maxRetransmits: 0 }));
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      this.o.send(id, { kind: 'offer', sdp: peer.pc.localDescription?.sdp ?? '' });
    } catch {
      this.closePeer(id, false);
    }
  }

  private wire(id: string, peer: Peer, dc: RTCDataChannel) {
    peer.dc = dc;
    dc.onmessage = (e) => {
      const msg = parseLinkMsg(e.data);
      const reply = msg && this.onMessage(id, msg);
      if (reply) this.sendOn(dc, reply);
    };
    dc.onopen = () => {
      const map = this.isMaster ? this.mapMsg() : null;
      if (map) this.sendOn(dc, map);
    };
  }

  private sendOn(dc: RTCDataChannel | null, msg: LinkMsg) {
    if (dc?.readyState !== 'open') return;
    try {
      dc.send(JSON.stringify(msg, (_k, v: unknown) => (v === Infinity ? null : v)));
    } catch {
      /* channel closing */
    }
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const peer: Peer = { pc, dc: null, pendingIce: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate)
        this.o.send(id, { kind: 'ice', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePeer(id, false);
    };
    return peer;
  }

  private async flushIce(peer: Peer) {
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  private closeAll(notify: boolean) {
    for (const id of [...this.peers.keys()]) this.closePeer(id, notify);
  }

  private closePeer(id: string, notify: boolean) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (notify) this.o.send(id, { kind: 'hangup' });
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  }
}

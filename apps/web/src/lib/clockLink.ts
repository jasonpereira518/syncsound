/**
 * LAN clock master over a WebRTC DataChannel (unordered, no retransmits). One in-room device (pickClockMaster)
 * answers 10 Hz pings with its raw performance.now() and shares its server ClockSync mapping: on a timer every
 * 500 ms and, event-driven, piggybacked on a pong whenever it changed (a master whose tab is hidden still answers
 * pings). Every other device maps local → master-local (a tight LAN estimate) → room (the master's WAN estimate,
 * identical for everyone). A WAN error common to all devices doesn't separate them, so device-to-device spread is
 * LAN error only (packages/sim/test/lanMaster.test.ts). Callers fall back to the server clock whenever `ready` is
 * false; `ready` needs the link healthy for READY_HOLD_MS first, so a flicker can't flip the path twice.
 */
import {
  ClockMapping,
  ClockSync,
  LAN_PING_MS,
  LAN_SYNC_OPTS,
  type ClockEstimate,
  type ClockMappingData,
  type RoomClock,
  type TimeMap,
} from '@syncsound/audio-core';
import type { Device, RtcData } from '@syncsound/protocol';
import { startTicker } from './ticker';

export type LinkMsg =
  | { t: 'ping'; t0: number }
  | { t: 'pong'; t0: number; r: number; s: number; d?: ClockMappingData }
  | { t: 'map'; d: ClockMappingData };

/** no pong/mapping for this long → not ready (tab hidden, Wi-Fi hiccup, master gone) */
export const STALE_MS = 3000;
/** the master's mapping must be younger than this to be used (its WAN estimate moves) */
export const MAP_STALE_MS = 15_000;
/** the link must be healthy this long before the clock path switches to it (no flip-flop on a flicker) */
export const READY_HOLD_MS = 2000;
/** an ICE `disconnected` that lasts this long counts as lost */
export const DISCONNECT_GRACE_MS = 5000;
/** reconnect attempts to the same master, ms apart */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
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

function parseMapping(d: unknown): ClockMappingData | null {
  const m = d as Record<string, unknown> | undefined;
  if (!m || !num(m.t0) || !num(m.a0) || !num(m.s1) || !num(m.s2) || !(num(m.tEnd) || m.tEnd === null)) return null;
  // JSON has no Infinity: an open-ended slew segment travels as null
  return { t0: m.t0, a0: m.a0, s1: m.s1, s2: m.s2, tEnd: (m.tEnd as number | null) ?? Infinity };
}

/** parse a DataChannel message from another device (untrusted) */
export function parseLinkMsg(raw: unknown): LinkMsg | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (m.t === 'ping' && num(m.t0)) return { t: 'ping', t0: m.t0 };
  if (m.t === 'pong' && num(m.t0) && num(m.r) && num(m.s)) {
    const d = m.d === undefined ? null : parseMapping(m.d);
    return d ? { t: 'pong', t0: m.t0, r: m.r, s: m.s, d } : { t: 'pong', t0: m.t0, r: m.r, s: m.s };
  }
  if (m.t === 'map') {
    const d = parseMapping(m.d);
    return d ? { t: 'map', d } : null;
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
  /** test hook: build peer connections (default: a real RTCPeerConnection with a public STUN server) */
  createPeerConnection?: () => RTCPeerConnection;
}

export class ClockLink implements RoomClock {
  private readonly lan = new ClockSync(LAN_SYNC_OPTS);
  private mapping: ClockMapping | null = null;
  private mappingAt = -Infinity;
  private lastHeard = -Infinity;
  private readySince: number | null = null;
  private master: string | null = null;
  private peers = new Map<string, Peer>();
  private ticks = 0;
  private stopTicker: (() => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimers = new Set<ReturnType<typeof setTimeout>>();
  /** per peer: t0 of the last mapping sent on a pong, so a changed mapping travels at once and an unchanged one doesn't */
  private sentMapT0 = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: ClockLinkOptions) {
    this.now = o.now ?? (() => performance.now());
  }

  /** begin the 10 Hz ping / mapping loop (browser only) */
  start(): void {
    this.stopTicker ??= startTicker(LAN_PING_MS, () => this.tick());
  }

  get isMaster(): boolean {
    return this.master !== null && this.master === this.o.selfId;
  }

  /** peer with a fresh, converged LAN estimate and a fresh mapping from the master, healthy for READY_HOLD_MS */
  get ready(): boolean {
    const now = this.now();
    const healthy =
      this.master !== null &&
      !this.isMaster &&
      this.mapping !== null &&
      this.lan.estimate().converged &&
      now - this.lastHeard < STALE_MS &&
      now - this.mappingAt < MAP_STALE_MS;
    if (!healthy) {
      this.readySince = null;
      return false;
    }
    this.readySince ??= now;
    return now - this.readySince >= READY_HOLD_MS;
  }

  /** call whenever the device list changes */
  setMaster(id: string | null): void {
    if (id === this.master) return;
    this.master = id;
    this.cancelReconnect();
    this.closeAll(true);
    this.lan.reset();
    this.mapping = null;
    this.mappingAt = -Infinity;
    this.readySince = null;
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

  /** the LAN estimate de-slewed and frozen at `localMs`, composed with the master's mapping as held right now */
  frozenAt(localMs: number): TimeMap {
    const lan = this.lan.frozenAt(localMs);
    const map = this.mapping!;
    return {
      toRoomTime: (l) => map.toRoomTime(lan.toRoomTime(l)),
      toLocalTime: (r) => lan.toLocalTime(map.toLocalTime(r)),
    };
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
    if (msg.t === 'ping') {
      if (!this.isMaster) return null;
      const pong: LinkMsg = { t: 'pong', t0: msg.t0, r: t, s: this.now() };
      const map = this.mapMsg();
      if (map && this.sentMapT0.get(from) !== map.d.t0) {
        this.sentMapT0.set(from, map.d.t0);
        pong.d = map.d;
      }
      return pong;
    }
    if (from !== this.master) return null;
    if (msg.t === 'pong') this.lan.addSample({ t0: msg.t0, tsRecv: msg.r, tsSend: msg.s, t3: t });
    const d = msg.t === 'map' ? msg.d : msg.d;
    if (d) {
      this.mapping = new ClockMapping(d);
      this.mappingAt = t;
    }
    this.lastHeard = t;
    return null;
  }

  /** the master's current mapping, as a message (null before its server clock has a mapping) */
  mapMsg(): { t: 'map'; d: ClockMappingData } | null {
    const d = this.o.serverClock().mapping();
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
      this.lost(from); // the server clock keeps working; the link is an optimisation
    }
  }

  dispose(): void {
    this.stopTicker?.();
    this.stopTicker = null;
    this.cancelReconnect();
    for (const t of this.graceTimers) clearTimeout(t);
    this.graceTimers.clear();
    this.closeAll(true);
  }

  private async connect(id: string) {
    const peer = this.createPeer(id);
    try {
      this.wire(id, peer, peer.pc.createDataChannel('clock', { ordered: false, maxRetransmits: 0 }));
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      this.o.send(id, { kind: 'offer', sdp: peer.pc.localDescription?.sdp ?? '' });
    } catch {
      this.lost(id);
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
      if (!this.isMaster) this.reconnectAttempt = 0;
      const map = this.isMaster ? this.mapMsg() : null;
      if (map) this.sendOn(dc, map);
    };
    dc.onclose = () => {
      if (this.peers.get(id)?.dc === dc) this.lost(id);
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
    const pc = this.o.createPeerConnection ? this.o.createPeerConnection() : new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const peer: Peer = { pc, dc: null, pendingIce: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate)
        this.o.send(id, { kind: 'ice', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') this.lost(id);
      else if (st === 'disconnected') {
        // a Wi-Fi hiccup usually recovers by itself; give it a grace period before rebuilding the link
        const t = setTimeout(() => {
          this.graceTimers.delete(t);
          if (this.peers.get(id)?.pc === pc && pc.connectionState === 'disconnected') this.lost(id);
        }, DISCONNECT_GRACE_MS);
        this.graceTimers.add(t);
      }
    };
    return peer;
  }

  /** the link to `id` is gone: drop it and, for the master, reconnect with backoff (the server clock covers meanwhile) */
  private lost(id: string) {
    this.closePeer(id, false);
    if (id === this.master && !this.isMaster) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const ms = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const m = this.master;
      if (m && !this.isMaster && !this.peers.has(m)) void this.connect(m);
    }, ms);
  }

  private cancelReconnect() {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
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
    this.sentMapT0.delete(id);
    if (notify) this.o.send(id, { kind: 'hangup' });
    peer.pc.onconnectionstatechange = null;
    if (peer.dc) peer.dc.onclose = null;
    peer.pc.close();
  }
}

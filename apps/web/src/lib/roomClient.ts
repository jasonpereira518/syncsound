/**
 * WebSocket room client: JOIN, NTP-style clock sync (ClockSync), reconnect with backoff, seq filtering.
 * Browser-only (uses WebSocket/performance/localStorage); construct it from client code only.
 */
import { dueNow } from './power';
import { startTicker } from './ticker';
import { CLOCK_BURST_COUNT, CLOCK_BURST_GAP_MS, ClockSync, type ClockMappingData } from '@syncsound/audio-core';
import {
  CreateRoomResponse,
  RoomInfoResponse,
  parseServerMessage,
  type ClientMessage,
  type DeviceCaps,
  type ServerMessage,
} from '@syncsound/protocol';
import type { ConnStatus } from '../store/types';
import { isServerMissing, NO_SERVER_MESSAGE, SERVER_WAKING_HINT, serverUrl, wsUrl } from './config';

export const hostKeyName = (code: string) => `syncsound:hostKey:${code}`;

export async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; msg?: string };
    return body.error ?? body.msg ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** POST /api/rooms; stores the host key so the next JOIN claims host. */
export async function createRoom(password?: string): Promise<CreateRoomResponse> {
  if (isServerMissing()) throw new Error(NO_SERVER_MESSAGE);
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    });
  } catch {
    throw new Error(`Can't reach the SyncSound server. Check that it is running and on the same network. ${SERVER_WAKING_HINT}`);
  }
  if (!res.ok) throw new Error(`Couldn't create a room: ${await readError(res)}`);
  const parsed = CreateRoomResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('The server sent an unexpected response.');
  try {
    localStorage.setItem(hostKeyName(parsed.data.code), parsed.data.hostKey);
  } catch {
    /* storage blocked: we just won't be host on rejoin */
  }
  return parsed.data;
}

export async function getRoomInfo(code: string): Promise<RoomInfoResponse> {
  if (isServerMissing()) throw new Error(NO_SERVER_MESSAGE);
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api/rooms/${encodeURIComponent(code)}`);
  } catch {
    throw new Error(`Can't reach the SyncSound server. ${SERVER_WAKING_HINT}`);
  }
  if (res.status === 404) return { exists: false, hasPassword: false };
  if (!res.ok) throw new Error(`Couldn't look up the room: ${await readError(res)}`);
  const parsed = RoomInfoResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('The server sent an unexpected response.');
  return parsed.data;
}

export interface RoomClientOptions {
  code: string;
  deviceId: string;
  name: string;
  password?: string;
  caps: () => DeviceCaps;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (s: ConnStatus) => void;
  /**
   * clock burst finished (after connect/reconnect or resync()) — safe to (re)schedule. `shiftMs`: how far the
   * mapping moved during the burst (0 when the clocks agreed with what we extrapolated).
   */
  onSynced: (reason: 'connect' | 'resync', shiftMs: number) => void;
  /** unrecoverable (join rejected) — no more reconnects */
  onFatal: (code: string, msg: string) => void;
}

export class RoomClient {
  readonly clock = new ClockSync();
  synced = false;
  private ws: WebSocket | null = null;
  private closed = false;
  private welcomed = false;
  private everWelcomed = false;
  private attempt = 0;
  private lastSeq = -1;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopPingTimer: (() => void) | null = null;
  private burstPongs = 0;
  private burstReason: 'connect' | 'resync' = 'connect';
  private burstBase: ClockMappingData | null = null;
  private bursting = false;
  private burstDeadline = 0;

  constructor(private readonly o: RoomClientOptions) {}

  connect(): void {
    if (this.closed) return;
    this.o.onStatus(this.attempt === 0 && !this.everWelcomed ? 'connecting' : 'reconnecting');
    this.welcomed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastSeq = -1;
    ws.onopen = () => {
      let hostKey: string | undefined;
      try {
        hostKey = localStorage.getItem(hostKeyName(this.o.code)) ?? undefined;
      } catch {
        hostKey = undefined;
      }
      this.send({
        type: 'JOIN',
        roomCode: this.o.code,
        deviceId: this.o.deviceId,
        name: this.o.name,
        caps: this.o.caps(),
        ...(this.o.password ? { password: this.o.password } : {}),
        ...(hostKey ? { hostKey } : {}),
      });
      this.startBurst('connect');
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPings();
      this.synced = false;
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** e.g. after the tab becomes visible again: re-burst (keeping the mapping), then onSynced('resync', shift) */
  resync(): void {
    if (this.open) this.startBurst('resync');
  }

  close(): void {
    this.closed = true;
    this.stopPings();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    this.o.onStatus('closed');
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private scheduleReconnect() {
    this.o.onStatus('reconnecting');
    const base = Math.min(10_000, 500 * 2 ** this.attempt++);
    this.later(() => this.connect(), base * (0.8 + Math.random() * 0.4));
  }

  private ping = () => this.send({ type: 'PING', t0: performance.now() });
  private lastTimerPing = { t: 0 };
  /** periodic (post-burst) ping; thinned to every 5 s in battery-friendly mode once synced */
  private timerPing = () => {
    if (!this.synced || dueNow(this.lastTimerPing, 5000)) this.ping();
  };

  /**
   * A 25-ping burst. The clock is never reset: `rebase()` lets the burst's samples decide whether the mapping
   * moved (a server restart, a device that slept) and keeps everything when it didn't. A resync keeps `synced`
   * true throughout — the mapping stays valid while it is re-checked — so a SCHEDULE arriving mid-burst is
   * scheduled on time instead of late.
   */
  private startBurst(reason: 'connect' | 'resync') {
    this.stopPings();
    if (reason === 'connect') this.synced = false;
    this.bursting = true;
    this.burstReason = reason;
    this.burstPongs = 0;
    this.burstDeadline = performance.now() + CLOCK_BURST_COUNT * CLOCK_BURST_GAP_MS + 600;
    this.burstBase = this.clock.mapping();
    this.clock.rebase();
    for (let i = 0; i < CLOCK_BURST_COUNT; i++) this.later(this.ping, i * CLOCK_BURST_GAP_MS);
    // fallback: declare synced shortly after the burst even if some pongs were lost
    this.later(() => this.finishBurst(), CLOCK_BURST_COUNT * CLOCK_BURST_GAP_MS + 650);
    this.later(() => {
      if (this.stopPingTimer === null && !this.closed) this.stopPingTimer = startTicker(1000, this.timerPing);
    }, CLOCK_BURST_COUNT * CLOCK_BURST_GAP_MS);
  }

  /** synced once welcomed and either the full burst answered or the deadline passed with ≥ 3 samples */
  private finishBurst() {
    if (!this.bursting || !this.welcomed) return;
    if (this.burstPongs < CLOCK_BURST_COUNT && (this.burstPongs < 3 || performance.now() < this.burstDeadline)) return;
    this.bursting = false;
    this.synced = true;
    const shift = this.burstBase ? this.clock.shiftSince(this.burstBase, performance.now()) : 0;
    this.burstBase = null;
    this.o.onSynced(this.burstReason, Number.isFinite(shift) ? shift : 0);
  }

  private stopPings() {
    this.stopPingTimer?.();
    this.stopPingTimer = null;
  }

  private handle(raw: unknown) {
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = parseServerMessage(data);
    if (!parsed.success) return;
    const msg = parsed.data as ServerMessage;
    if (msg.type === 'PONG') {
      try {
        this.clock.addSample({ t0: msg.t0, tsRecv: msg.ts_recv, tsSend: msg.ts_send, t3: performance.now() });
      } catch {
        return;
      }
      if (this.bursting) {
        this.burstPongs++;
        this.finishBurst();
      }
      return;
    }
    if (msg.seq <= this.lastSeq) return; // stale duplicate
    this.lastSeq = msg.seq;
    if (msg.type === 'WELCOME') {
      this.welcomed = this.everWelcomed = true;
      this.attempt = 0;
      this.o.onStatus('open');
      this.finishBurst();
    } else if (msg.type === 'ERROR' && !this.welcomed) {
      // join rejected (bad password, unknown room, full…) — don't hammer the server
      this.closed = true;
      this.o.onFatal(msg.code, msg.msg);
      this.close();
      this.o.onStatus('error');
      return;
    }
    this.o.onMessage(msg);
  }
}

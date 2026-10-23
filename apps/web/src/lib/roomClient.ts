/**
 * WebSocket room client: JOIN, NTP-style clock sync (ClockSync), reconnect with backoff, seq filtering.
 * Browser-only (uses WebSocket/performance/localStorage); construct it from client code only.
 */
import { dueNow } from './power';
import { ClockSync } from '@syncsound/audio-core';
import {
  CreateRoomResponse,
  RoomInfoResponse,
  parseServerMessage,
  type ClientMessage,
  type DeviceCaps,
  type ServerMessage,
} from '@syncsound/protocol';
import type { ConnStatus } from '../store/types';
import { serverUrl, wsUrl } from './config';

export const hostKeyName = (code: string) => `syncsound:hostKey:${code}`;
const BURST_COUNT = 25;
const BURST_GAP_MS = 40;

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
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    });
  } catch {
    throw new Error("Can't reach the SyncSound server. Check that it is running and on the same network.");
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
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api/rooms/${encodeURIComponent(code)}`);
  } catch {
    throw new Error("Can't reach the SyncSound server.");
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
  /** clock burst finished (after connect/reconnect or resync()) — safe to (re)schedule */
  onSynced: (reason: 'connect' | 'resync') => void;
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
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private burstPongs = 0;
  private burstReason: 'connect' | 'resync' = 'connect';
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

  /** e.g. after the tab becomes visible again: re-burst, then onSynced('resync') */
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

  private startBurst(reason: 'connect' | 'resync') {
    this.stopPings();
    this.synced = false;
    this.bursting = true;
    this.burstReason = reason;
    this.burstPongs = 0;
    this.burstDeadline = performance.now() + BURST_COUNT * BURST_GAP_MS + 600;
    this.clock.reset();
    for (let i = 0; i < BURST_COUNT; i++) this.later(this.ping, i * BURST_GAP_MS);
    // fallback: declare synced shortly after the burst even if some pongs were lost
    this.later(() => this.finishBurst(), BURST_COUNT * BURST_GAP_MS + 650);
    this.later(() => {
      if (this.pingTimer === null && !this.closed) this.pingTimer = setInterval(this.timerPing, 1000);
    }, BURST_COUNT * BURST_GAP_MS);
  }

  /** synced once welcomed and either the full burst answered or the deadline passed with ≥ 3 samples */
  private finishBurst() {
    if (!this.bursting || !this.welcomed) return;
    if (this.burstPongs < BURST_COUNT && (this.burstPongs < 3 || performance.now() < this.burstDeadline)) return;
    this.bursting = false;
    this.synced = true;
    this.o.onSynced(this.burstReason);
  }

  private stopPings() {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
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

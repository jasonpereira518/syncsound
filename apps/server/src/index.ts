/** Entry: Node http + ws adapter around the transport-free Room. Run with `tsx src/index.ts`. */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_UPLOAD_BYTES, SERVER_PORT_DEFAULT, parseClientMessage } from '@syncsound/protocol';
import { HomeStore } from './homes.ts';
import { createHttpHandler, originAllowed } from './http.ts';
import { ProfileStore } from './profiles.ts';
import { perfClock, type Outbound, type Room } from './room.ts';
import { RoomManager } from './roomManager.ts';
import { storageFromEnv, type Storage } from './storage.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const RATE_PER_SEC = 60;
export const RATE_BURST = 120;
export const MAX_DROPS = 500;
const HEARTBEAT_MS = 15_000;
const SWEEP_MS = 60_000;

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  allowedOrigins?: string[];
  publicUrl?: string;
  maxUploadBytes?: number;
  /** override env-selected asset storage (tests inject a fake bucket) */
  storage?: Storage;
  roomTtlMinutes?: number;
  /** how long a prepared tune waits for its recorders' microphones (tests shorten it) */
  prepareDeadlineMs?: number;
}
/** how often room deadlines are checked, ms */
const TICK_MS = 100;

interface Conn {
  id: string;
  ws: WebSocket;
  room: Room | null;
  tokens: number;
  lastRefill: number;
  drops: number;
  alive: boolean;
}

export async function startServer(
  opts: ServerOptions = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
  const allowedOrigins =
    opts.allowedOrigins ??
    (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const clock = perfClock;
  const profiles = new ProfileStore(join(dataDir, 'profiles.json'));
  const homes = new HomeStore(join(dataDir, 'homes.json'));
  const manager = new RoomManager({
    ttlMinutes: opts.roomTtlMinutes,
    profiles,
    clock,
    homes,
    ...(opts.prepareDeadlineMs !== undefined ? { prepareDeadlineMs: opts.prepareDeadlineMs } : {}),
  });
  const storage = opts.storage ?? storageFromEnv(join(dataDir, 'uploads'));
  const conns = new Map<string, Conn>();

  /** per room: the timer for its next end-of-track transition (auto-advance / stop at the end of the queue) */
  const advanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const deliver = (room: Room, senderId: string | undefined, outs: Outbound[]) => {
    for (const o of outs) {
      const data = JSON.stringify(o.msg);
      for (const id of room.resolve(o.to, senderId)) {
        const c = conns.get(id);
        if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
      }
    }
    armAdvance(room);
  };

  /** (re)arm the room's transition timer from its current playback; every delivery may have changed it */
  function armAdvance(room: Room) {
    const prev = advanceTimers.get(room.code);
    if (prev) clearTimeout(prev);
    advanceTimers.delete(room.code);
    const due = room.nextDueAt();
    if (due === null || manager.rooms.get(room.code) !== room) return;
    const t = setTimeout(
      () => {
        advanceTimers.delete(room.code);
        if (manager.rooms.get(room.code) !== room) return; // expired or removed meanwhile
        deliver(room, undefined, room.tick(clock()));
      },
      Math.min(2 ** 31 - 1, Math.max(0, due - clock())),
    );
    t.unref();
    advanceTimers.set(room.code, t);
  }

  const server = createServer(
    createHttpHandler({
      manager,
      storage,
      dataDir,
      allowedOrigins,
      // Render sets RENDER_EXTERNAL_URL (https://<service>.onrender.com), so uploads get the right public link there
      publicUrl: opts.publicUrl ?? process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL,
      maxUploadBytes: opts.maxUploadBytes ?? MAX_UPLOAD_BYTES,
      clock,
      homes,
      deliver: (room, out) => deliver(room, undefined, out),
      kick: (room) => {
        for (const c of conns.values())
          if (c.room === room) {
            c.room = null; // the room is gone; don't emit a leave on close
            c.ws.close(4001, 'room removed');
          }
      },
    }),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * MAX_MESSAGE_BYTES });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/ws' || !originAllowed(req.headers.origin, allowedOrigins)) {
      socket.end(
        `HTTP/1.1 ${path !== '/ws' ? '404 Not Found' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // joined connections get room-sequenced errors; pre-JOIN errors carry seq 0
  const sendError = (c: Conn, code: string, msg: string) =>
    c.room
      ? deliver(c.room, c.id, c.room.error(c.id, code, msg))
      : c.ws.send(JSON.stringify({ type: 'ERROR', code, msg, seq: 0 }));

  const allow = (c: Conn, now: number) => {
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.lastRefill) / 1000) * RATE_PER_SEC);
    c.lastRefill = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  };

  const onMessage = (c: Conn, data: RawData, isBinary: boolean) => {
    const recv = clock();
    if (!allow(c, recv)) {
      if (++c.drops >= MAX_DROPS) return c.ws.close(1008, 'rate limit');
      return sendError(c, 'rate_limited', 'too many messages');
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary || buf.length > MAX_MESSAGE_BYTES)
      return sendError(c, 'bad_message', 'text JSON ≤ 64 KB only');
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      return sendError(c, 'bad_message', 'invalid JSON');
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.success)
      return sendError(c, 'bad_message', parsed.error.issues[0]?.message ?? 'invalid message');
    const msg = parsed.data;

    if (msg.type === 'JOIN') {
      const room = manager.get(msg.roomCode);
      if (!room) return sendError(c, 'room_not_found', 'no such room');
      if (c.room && c.room !== room) return sendError(c, 'already_joined', 'connection is in another room');
      const r = room.join(c.id, msg, recv);
      if (r.ok) c.room = room;
      if (r.replacedConnId) {
        const old = conns.get(r.replacedConnId);
        if (old) {
          old.room = null; // the room already forgot it; don't emit a leave on close
          old.ws.close(4000, 'replaced by a newer connection');
        }
      }
      return deliver(room, c.id, r.out);
    }
    if (!c.room) return sendError(c, 'not_joined', 'first message must be JOIN');
    deliver(c.room, c.id, c.room.handle(c.id, msg, recv));
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    req.socket.setNoDelay(true);
    const c: Conn = {
      id: randomUUID(),
      ws,
      room: null,
      tokens: RATE_BURST,
      lastRefill: clock(),
      drops: 0,
      alive: true,
    };
    conns.set(c.id, c);
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(c, data, isBinary);
      } catch (e) {
        console.error('[ws]', e);
        sendError(c, 'internal', 'internal error');
      }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      conns.delete(c.id);
      if (c.room) deliver(c.room, c.id, c.room.leave(c.id, clock()));
    });
  });

  const heartbeat = setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(() => {
    for (const { room, out } of manager.sweep(clock()).updates) deliver(room, undefined, out);
  }, SWEEP_MS);
  const ticker = setInterval(() => {
    for (const { room, out } of manager.calibrationTick(clock()).updates) deliver(room, undefined, out);
  }, TICK_MS);
  heartbeat.unref();
  sweeper.unref();
  ticker.unref();

  await new Promise<void>((resolve) => server.listen(opts.port ?? SERVER_PORT_DEFAULT, opts.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);

  return {
    port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      clearInterval(ticker);
      for (const t of advanceTimers.values()) clearTimeout(t);
      advanceTimers.clear();
      for (const c of conns.values()) c.ws.close(1001, 'server shutting down');
      profiles.flush();
      homes.flush();
      await new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srv = await startServer({ port: Number(process.env.PORT ?? process.env.SERVER_PORT ?? SERVER_PORT_DEFAULT) });
  console.log(`[server] listening on :${srv.port}`);
  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`[server] ${sig}: shutting down`);
    srv.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

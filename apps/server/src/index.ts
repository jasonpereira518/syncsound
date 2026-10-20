/** Entry: Node http + ws adapter around the transport-free Room. Run with `tsx src/index.ts`. */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_UPLOAD_BYTES, SERVER_PORT_DEFAULT, parseClientMessage } from '@syncsound/protocol';
import { createHttpHandler, originAllowed } from './http.ts';
import { ProfileStore } from './profiles.ts';
import { perfClock, type Outbound, type Room } from './room.ts';
import { RoomManager } from './roomManager.ts';
import { storageFromEnv } from './storage.ts';

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
  roomTtlMinutes?: number;
}

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
  const manager = new RoomManager({ ttlMinutes: opts.roomTtlMinutes, profiles, clock });
  const storage = storageFromEnv(join(dataDir, 'uploads'));

  const server = createServer(
    createHttpHandler({
      manager,
      storage,
      dataDir,
      allowedOrigins,
      publicUrl: opts.publicUrl ?? process.env.PUBLIC_URL,
      maxUploadBytes: opts.maxUploadBytes ?? MAX_UPLOAD_BYTES,
      clock,
    }),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * MAX_MESSAGE_BYTES });
  const conns = new Map<string, Conn>();

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

  const deliver = (room: Room, senderId: string | undefined, outs: Outbound[]) => {
    for (const o of outs) {
      const data = JSON.stringify(o.msg);
      for (const id of room.resolve(o.to, senderId)) {
        const c = conns.get(id);
        if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
      }
    }
  };
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
  heartbeat.unref();
  sweeper.unref();

  await new Promise<void>((resolve) => server.listen(opts.port ?? SERVER_PORT_DEFAULT, opts.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);

  return {
    port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const c of conns.values()) c.ws.close(1001, 'server shutting down');
      profiles.flush();
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

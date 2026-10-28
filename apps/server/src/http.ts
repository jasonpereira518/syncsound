/** HTTP routes: health, room create/info, homes, asset upload + ranged serving, demo listing. */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CreateRoomRequest,
  DemoAsset,
  HomeGroupRequest,
  HomeRoomRequest,
  MAX_HOME_ROOMS,
  OWNER_KEY_HEADER,
  UploadInitRequest,
  isValidRoomCode,
  type HomeCreateResponse,
  type HomeView,
  type UploadInitResponse,
  type UploadResponse,
} from '@syncsound/protocol';
import type { HomeStore } from './homes.ts';
import type { Outbound, Room } from './room.ts';
import type { RoomManager } from './roomManager.ts';
import type { Media } from './media.ts';
import type { Storage } from './storage.ts';

export interface HttpDeps {
  manager: RoomManager;
  storage: Storage;
  media: Media;
  dataDir: string;
  allowedOrigins: string[];
  publicUrl?: string;
  maxUploadBytes: number;
  clock: () => number;
  homes: HomeStore;
  /** fan out room messages to its connections (group play) */
  deliver: (room: Room, out: Outbound[]) => void;
  /** disconnect every device of a removed room */
  kick: (room: Room) => void;
}

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEMO_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const MEDIA_MIME = /^(audio|video)\/[a-z0-9.+-]{1,60}$/;
const EXT_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};
const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).map(([e, m]) => [m, e]));

/** An allowed entry is an exact origin, or a pattern where `*` matches one DNS label fragment (`[a-z0-9-]+`, no dots). */
const wildcardMatch = (origin: string, pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i').test(origin);

export function originAllowed(origin: string | undefined, allowed: string[]) {
  return (
    allowed.length === 0 ||
    origin === undefined ||
    allowed.some((a) => (a.includes('*') ? wildcardMatch(origin, a) : a === origin))
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'body too large');
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function publicBase(req: IncomingMessage, d: HttpDeps) {
  if (d.publicUrl) return d.publicUrl.replace(/\/$/, '');
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

/** single byte range → [start, end] inclusive, null = no/ignored header, 'bad' = unsatisfiable */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return [start, end];
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  mime: string,
  cache: string,
) {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new HttpError(404, 'not found');
  }
  const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': cache };
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
    return void res.end();
  }
  const [start, end] = range ?? [0, size - 1];
  res.writeHead(range ? 206 : 200, {
    ...base,
    'content-length': size === 0 ? 0 : end - start + 1,
    ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }),
  });
  if (req.method === 'HEAD' || size === 0) return void res.end();
  await pipeline(createReadStream(path, { start, end }), res).catch(() => res.destroy());
}

/** upload filename → display title + a safe extension (falls back to the mime's) */
function nameParts(rawName: string, mime: string) {
  const filename = rawName.split(/[\\/]/).pop()!.trim() || 'upload';
  const rawExt = extname(filename).toLowerCase();
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : (MIME_EXT[mime] ?? '');
  const title = (filename.slice(0, filename.length - rawExt.length) || filename).slice(0, 200);
  return { ext, title };
}

function checkMedia(mime: string, size: number, d: HttpDeps) {
  if (!MEDIA_MIME.test(mime)) throw new HttpError(415, 'only audio/* and video/* uploads are allowed');
  if (size > d.maxUploadBytes) throw new HttpError(413, 'file too large');
}

const PRESIGN_TTL_SEC = 15 * 60;

/** step 1 of a direct-to-bucket upload: validate, then hand the browser a short-lived presigned PUT */
async function initUpload(req: IncomingMessage, res: ServerResponse, d: HttpDeps) {
  const direct = d.storage.direct;
  if (!direct) throw new HttpError(404, 'not found'); // no bucket: the client falls back to POST /api/assets
  const parsed = UploadInitRequest.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid request');
  const mime = parsed.data.mime.toLowerCase();
  checkMedia(mime, parsed.data.size, d);
  const id = randomBytes(12).toString('base64url');
  const body: UploadInitResponse = { id, uploadUrl: direct.presignPut(id, mime, PRESIGN_TTL_SEC), mime };
  json(res, 201, body);
}

/** step 3: confirm what actually landed in the bucket (the PUT bypassed our size check) */
async function completeUpload(req: IncomingMessage, res: ServerResponse, id: string, d: HttpDeps) {
  const direct = d.storage.direct;
  if (!direct) throw new HttpError(404, 'not found');
  const parsed = UploadInitRequest.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid request');
  const mime = parsed.data.mime.toLowerCase();
  const obj = await direct.head(id);
  if (!obj) throw new HttpError(404, 'upload not found');
  if (obj.size > d.maxUploadBytes || obj.size <= 0 || !MEDIA_MIME.test(obj.mime)) {
    await direct.remove(id);
    throw new HttpError(obj.size > d.maxUploadBytes ? 413 : 415, 'uploaded file rejected');
  }
  const { title } = nameParts(parsed.data.filename, mime);
  // the browser can't pre-decode big files, so the server tells the room how long this one is
  const probed = await d.media.probe(direct.publicUrl(id));
  const body: UploadResponse = {
    id,
    // straight from the bucket: a hop through /assets/:id would redirect cross-origin and trip CORS (`Origin: null`)
    url: direct.publicUrl(id),
    title,
    mime: obj.mime,
    size: obj.size,
    ...(probed && { durationSec: probed.durationSec, channels: probed.channels }),
  };
  json(res, 201, body);
}

async function upload(req: IncomingMessage, res: ServerResponse, d: HttpDeps) {
  const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  checkMedia(mime, Number(req.headers['content-length'] ?? 0), d);

  let rawName = 'upload';
  try {
    rawName = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload'));
  } catch {
    // keep default for malformed encodings
  }
  const { ext, title } = nameParts(rawName, mime);

  const id = randomBytes(12).toString('base64url');
  const uploadsDir = join(d.dataDir, 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  const tmp = join(uploadsDir, `${id}.part`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > d.maxUploadBytes) cb(new HttpError(413, 'file too large'));
      else cb(null, chunk);
    },
  });
  req.on('close', () => {
    if (!req.complete) limiter.destroy(new Error('client aborted upload'));
  });
  try {
    // req is piped (not pipelined) so a limit error leaves the socket alive to send the 413
    await pipeline(req.pipe(limiter), createWriteStream(tmp));
    await d.storage.save(id, tmp, { mime, title, size, ext });
  } catch (e) {
    await unlink(tmp).catch(() => {});
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, 'upload failed');
  }
  const loc = await d.storage.locate(id);
  const probed = loc?.kind === 'file' ? await d.media.probe(loc.path) : null;
  const body: UploadResponse = {
    id,
    url: `${publicBase(req, d)}/assets/${id}`,
    title,
    mime,
    size,
    ...(probed && { durationSec: probed.durationSec, channels: probed.channels }),
  };
  json(res, 201, body);
}

async function demoList(req: IncomingMessage, d: HttpDeps) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(d.dataDir, 'demo', 'manifest.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const base = publicBase(req, d);
  return raw.flatMap((a) => {
    const p = DemoAsset.safeParse(a);
    return p.success ? [{ ...p.data, url: `${base}/assets/demo/${encodeURIComponent(p.data.file)}` }] : [];
  });
}

async function homeRoute(req: IncomingMessage, res: ServerResponse, path: string[], d: HttpDeps) {
  const m = req.method ?? 'GET';
  if (m === 'POST' && path.length === 0) {
    if (overLimit(`homes:${req.socket.remoteAddress}`, 10, 60_000, Date.now()))
      throw new HttpError(429, 'too many homes created, slow down');
    const { home, ownerKey } = d.homes.create();
    return json(res, 201, { homeId: home.id, ownerKey } satisfies HomeCreateResponse);
  }
  const home = d.homes.get(path[0] ?? '');
  if (!home) throw new HttpError(404, 'no such home');
  const [, sub, roomId] = path;
  const owner = () => {
    const key = req.headers[OWNER_KEY_HEADER];
    if (!d.homes.isOwner(home, typeof key === 'string' ? key : undefined))
      throw new HttpError(403, 'owner key required');
  };
  const body = async <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }) => {
    const p = schema.safeParse(await readJson(req));
    if (!p.success) throw new HttpError(400, 'invalid request');
    return p.data;
  };

  if ((m === 'GET' || m === 'HEAD') && path.length === 1) {
    const view: HomeView = {
      id: home.id,
      rooms: home.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        connected: d.manager.rooms.get(r.id)?.connectedCount ?? 0,
      })),
    };
    return json(res, 200, view);
  }
  if (sub === 'rooms' && path.length === 2 && m === 'POST') {
    owner();
    if (home.rooms.length >= MAX_HOME_ROOMS) throw new HttpError(409, 'home is full');
    const { name } = await body(HomeRoomRequest);
    const r = d.manager.addHomeRoom(home, name);
    return json(res, 201, { id: r.id, name: r.name });
  }
  if (sub === 'rooms' && path.length === 3 && (m === 'PATCH' || m === 'DELETE')) {
    owner();
    const r = home.rooms.find((x) => x.id === roomId);
    if (!r) throw new HttpError(404, 'no such room');
    if (m === 'PATCH') {
      const { name } = await body(HomeRoomRequest);
      d.homes.updateRoom(r.id, { name });
      return json(res, 200, { id: r.id, name });
    }
    const { live } = d.manager.removeHomeRoom(home, r.id);
    if (live) d.kick(live);
    res.writeHead(204);
    return void res.end();
  }
  if (sub === 'group' && path.length === 2 && m === 'POST') {
    owner();
    const { roomIds, command } = await body(HomeGroupRequest);
    if (!roomIds.every((id) => home.rooms.some((r) => r.id === id)))
      throw new HttpError(400, 'room not in this home');
    const { updates, ...result } = d.manager.groupControl(roomIds, command, d.clock());
    for (const u of updates) d.deliver(u.room, u.out);
    return json(res, 200, result);
  }
  throw new HttpError(404, 'not found');
}

export function createHttpHandler(d: HttpDeps) {
  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const seg = (i: number) => {
      try {
        return decodeURIComponent(parts[i] ?? '');
      } catch {
        throw new HttpError(400, 'bad path');
      }
    };
    const m = req.method ?? 'GET';
    const get = m === 'GET' || m === 'HEAD';
    const p = url.pathname;

    if (get && p === '/health') return json(res, 200, { ok: true });
    if (m === 'POST' && p === '/api/rooms') {
      if (overLimit(`rooms:${req.socket.remoteAddress}`, 30, 60_000, Date.now())) throw new HttpError(429, 'too many rooms created, slow down');
      const parsed = CreateRoomRequest.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, 'invalid request');
      return json(res, 201, d.manager.create(parsed.data.password || undefined, d.clock()));
    }
    if (get && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
      const code = seg(2).toUpperCase();
      const room = isValidRoomCode(code) ? d.manager.get(code) : undefined;
      const name = room ? d.homes.findRoom(code)?.room.name : undefined;
      return json(res, 200, { exists: !!room, hasPassword: room?.state.settings.hasPassword ?? false, ...(name ? { name } : {}) });
    }
    if (parts[0] === 'api' && parts[1] === 'homes')
      return homeRoute(req, res, parts.slice(2).map((_, i) => seg(i + 2)), d);
    if (get && p === '/api/demo') return json(res, 200, await demoList(req, d));
    if (m === 'POST' && (p === '/api/assets' || p === '/api/assets/init' || (parts[0] === 'api' && parts[1] === 'assets' && parts[3] === 'complete' && parts.length === 4))) {
      if (overLimit(`assets:${req.socket.remoteAddress}`, 60, 60_000, Date.now())) throw new HttpError(429, 'too many uploads, slow down');
      if (p === '/api/assets/init') return initUpload(req, res, d);
      if (parts.length === 4) {
        const id = seg(2);
        if (!ASSET_ID.test(id)) throw new HttpError(400, 'bad asset id');
        return completeUpload(req, res, id, d);
      }
      return upload(req, res, d);
    }
    if (get && parts[0] === 'assets' && parts[1] === 'demo' && parts.length === 3) {
      const file = seg(2);
      if (!DEMO_FILE.test(file) || file.includes('..')) throw new HttpError(400, 'bad file name');
      const mime = EXT_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return sendFile(req, res, join(d.dataDir, 'demo', file), mime, 'public, max-age=3600');
    }
    if (get && parts[0] === 'assets' && parts.length === 2) {
      const id = seg(1);
      if (!ASSET_ID.test(id)) throw new HttpError(400, 'bad asset id');
      const loc = await d.storage.locate(id);
      if (!loc) throw new HttpError(404, 'not found');
      if (loc.kind === 'redirect') {
        res.writeHead(302, { location: loc.url });
        return void res.end();
      }
      return sendFile(req, res, loc.path, loc.meta.mime, 'public, max-age=31536000, immutable');
    }
    throw new HttpError(404, 'not found');
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin !== undefined && originAllowed(origin, d.allowedOrigins)) {
      res.setHeader('access-control-allow-origin', d.allowedOrigins.length ? origin : '*');
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': `content-type, x-filename, range, ${OWNER_KEY_HEADER}`,
        'access-control-max-age': '86400',
      });
      return void res.end();
    }
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[http]', e);
      if (res.headersSent) return void res.destroy();
      if (status === 413) res.setHeader('connection', 'close'); // don't drain an oversized body
      json(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
    });
  };
}

// ponytail: per-process fixed-window limiter keyed by remote address; behind a proxy, key on a trusted
// X-Forwarded-For instead, and move to a shared store if the server is ever scaled out.
const windows = new Map<string, { start: number; count: number }>();
export function overLimit(key: string, max: number, windowMs: number, now: number): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    windows.set(key, { start: now, count: 1 });
    return false;
  }
  return ++w.count > max;
}

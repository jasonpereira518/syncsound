/** HTTP routes: health, room create/info, asset upload + ranged serving, demo listing. */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CreateRoomRequest, DemoAsset, isValidRoomCode, type UploadResponse } from '@syncsound/protocol';
import type { RoomManager } from './roomManager.ts';
import type { Storage } from './storage.ts';

export interface HttpDeps {
  manager: RoomManager;
  storage: Storage;
  dataDir: string;
  allowedOrigins: string[];
  publicUrl?: string;
  maxUploadBytes: number;
  clock: () => number;
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

export function originAllowed(origin: string | undefined, allowed: string[]) {
  return allowed.length === 0 || origin === undefined || allowed.includes(origin);
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

async function upload(req: IncomingMessage, res: ServerResponse, d: HttpDeps) {
  const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!MEDIA_MIME.test(mime)) throw new HttpError(415, 'only audio/* and video/* uploads are allowed');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > d.maxUploadBytes) throw new HttpError(413, 'file too large');

  let filename = 'upload';
  try {
    filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload'));
  } catch {
    // keep default for malformed encodings
  }
  filename = filename.split(/[\\/]/).pop()!.trim() || 'upload';
  const rawExt = extname(filename).toLowerCase();
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : (MIME_EXT[mime] ?? '');
  const title = (filename.slice(0, filename.length - rawExt.length) || filename).slice(0, 200);

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
  const body: UploadResponse = { id, url: `${publicBase(req, d)}/assets/${id}`, title, mime, size };
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
      const parsed = CreateRoomRequest.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, 'invalid request');
      return json(res, 201, d.manager.create(parsed.data.password || undefined, d.clock()));
    }
    if (get && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
      const code = seg(2).toUpperCase();
      const room = isValidRoomCode(code) ? d.manager.get(code) : undefined;
      return json(res, 200, { exists: !!room, hasPassword: room?.state.settings.hasPassword ?? false });
    }
    if (get && p === '/api/demo') return json(res, 200, await demoList(req, d));
    if (m === 'POST' && p === '/api/assets') return upload(req, res, d);
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
        'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-filename, range',
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

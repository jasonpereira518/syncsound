import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  CreateRoomResponse,
  DemoAsset,
  HomeCreateResponse,
  HomeGroupResponse,
  HomeRoom,
  ServerMessage,
  UploadResponse,
} from '@syncsound/protocol';
import { originAllowed } from '../src/http.ts';
import { MAX_DROPS, RATE_BURST, startServer } from '../src/index.ts';
import { perfClock } from '../src/room.ts';

const caps = {
  userAgent: 't',
  platform: 't',
  deviceClass: 'laptop',
  sampleRate: 48000,
  baseLatencyMs: null,
  outputLatencyMs: null,
  hasOutputTimestamp: true,
  hasMic: true,
};

class Client {
  readonly msgs: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(String(d)) as ServerMessage);
      this.waiters.forEach((w) => w());
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.waiters.forEach((w) => w());
    });
  }
  static open(port: number, headers?: Record<string, string>) {
    return new Promise<Client>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      const c = new Client(ws);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  until<T>(check: () => T | undefined, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const tick = () => {
        const v = check();
        if (v === undefined) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== tick);
        resolve(v);
      };
      const timer = setTimeout(
        () => reject(new Error(`timeout; got ${this.msgs.map((m) => m.type).join(',')}`)),
        ms,
      );
      this.waiters.push(tick);
      tick();
    });
  }
  waitFor<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ) {
    return this.until(
      () =>
        this.msgs.find((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>)) as
          Extract<ServerMessage, { type: T }> | undefined,
    );
  }
}

function wav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 10000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(96000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const rawGet = (port: number, path: string) =>
  new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });

describe('server integration', () => {
  let dataDir: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'syncsound-'));
    mkdirSync(join(dataDir, 'demo'));
    writeFileSync(join(dataDir, 'demo', 'tone.wav'), wav(100));
    writeFileSync(
      join(dataDir, 'demo', 'manifest.json'),
      JSON.stringify([
        { id: 'tone', title: 'Tone', file: 'tone.wav', channels: 1, durationSec: 0.002, mime: 'audio/wav' },
      ]),
    );
    srv = await startServer({ port: 0, dataDir, maxUploadBytes: 64 * 1024, allowedOrigins: [] });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    clients.forEach((c) => c.ws.terminate());
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('health', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });

  it('home: owner-gated room CRUD, JOIN by room code, group play to two rooms at one time', async () => {
    const api = (path: string, init: RequestInit = {}, key?: string) =>
      fetch(`${base}/api/homes${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(key && { 'x-owner-key': key }) },
      });
    const { homeId, ownerKey } = (await (await api('', { method: 'POST' })).json()) as HomeCreateResponse;
    const add = (name: string, key?: string) => api(`/${homeId}/rooms`, { method: 'POST', body: JSON.stringify({ name }) }, key);
    expect((await add('Kitchen')).status).toBe(403);
    expect((await add('Kitchen', 'nope')).status).toBe(403);
    const kitchen = (await (await add('Kitchen', ownerKey)).json()) as HomeRoom;
    const lounge = (await (await add('Lounge', ownerKey)).json()) as HomeRoom;
    const renamed = await api(`/${homeId}/rooms/${lounge.id}`, { method: 'PATCH', body: '{"name":"Den"}' }, ownerKey);
    expect(renamed.status).toBe(200);
    expect(await (await api(`/${homeId}`)).json()).toEqual({
      id: homeId,
      rooms: [
        { id: kitchen.id, name: 'Kitchen', connected: 0 },
        { id: lounge.id, name: 'Den', connected: 0 },
      ],
    });
    expect((await api('/nosuchhome')).status).toBe(404);
    expect(await (await fetch(`${base}/api/rooms/${kitchen.id}`)).json()).toEqual({ exists: true, hasPassword: false, name: 'Kitchen' });

    const [a, b] = await Promise.all([Client.open(srv.port), Client.open(srv.port)]);
    clients.push(a!, b!);
    a!.send({ type: 'JOIN', roomCode: kitchen.id, deviceId: 'hk', name: 'K', caps, hostKey: ownerKey });
    b!.send({ type: 'JOIN', roomCode: lounge.id, deviceId: 'hl', name: 'L', caps });
    expect((await a!.waitFor('WELCOME')).isHost).toBe(true);
    expect((await b!.waitFor('WELCOME')).isHost).toBe(false);

    const group = (command: unknown) =>
      api(`/${homeId}/group`, { method: 'POST', body: JSON.stringify({ roomIds: [kitchen.id, lounge.id], command }) }, ownerKey);
    const track = { id: 'tone', title: 'Tone', kind: 'demo', sourceClass: 'rendered', url: `${base}/assets/demo/tone.wav` };
    expect((await group({ type: 'queue', track })).status).toBe(200);
    const res = (await (await group({ type: 'play', trackId: 'tone' })).json()) as HomeGroupResponse;
    expect(res.errors).toEqual({});
    const [sa, sb] = await Promise.all([a!.waitFor('SCHEDULE'), b!.waitFor('SCHEDULE')]);
    expect(sa.startRoomTime).toBe(res.startRoomTime);
    expect(sb.startRoomTime).toBe(res.startRoomTime);
    expect(res.startRoomTime).toBeGreaterThan(perfClock());

    expect((await api(`/${homeId}/rooms/${lounge.id}`, { method: 'DELETE' }, ownerKey)).status).toBe(204);
    await b!.until(() => b!.closeCode ?? undefined);
    expect(b!.closeCode).toBe(4001);
    expect(await (await fetch(`${base}/api/rooms/${lounge.id}`)).json()).toEqual({ exists: false, hasPassword: false });
  });

  it('3 clients: create room, join, ping/pong, identical future SCHEDULE on play', async () => {
    const created = (await (
      await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as CreateRoomResponse;
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await (await fetch(`${base}/api/rooms/${created.code}`)).json()).toEqual({
      exists: true,
      hasPassword: false,
    });
    expect(await (await fetch(`${base}/api/rooms/ZZZZZZ`)).json()).toEqual({
      exists: false,
      hasPassword: false,
    });

    const cs = await Promise.all([0, 1, 2].map(() => Client.open(srv.port)));
    clients.push(...cs);
    for (const [i, c] of cs.entries()) {
      c.send({
        type: 'JOIN',
        roomCode: created.code,
        deviceId: `dev${i}`,
        name: `Dev ${i}`,
        caps,
        ...(i === 0 && { hostKey: created.hostKey }),
      });
      const w = await c.waitFor('WELCOME');
      expect(w.isHost).toBe(i === 0);
    }
    await cs[0]!.waitFor('DEVICE_LIST', (m) => m.devices.length === 3);

    const t0 = perfClock();
    cs[1]!.send({ type: 'PING', t0 });
    const pong = await cs[1]!.waitFor('PONG');
    expect(pong.t0).toBe(t0);
    expect(pong.ts_send).toBeGreaterThanOrEqual(pong.ts_recv);
    expect(pong.ts_recv).toBeGreaterThanOrEqual(t0);

    cs[0]!.send({
      type: 'CONTROL',
      command: {
        type: 'queue',
        track: {
          id: 'tone',
          title: 'Tone',
          kind: 'demo',
          sourceClass: 'rendered',
          url: `${base}/assets/demo/tone.wav`,
        },
      },
    });
    await Promise.all(cs.map((c) => c.waitFor('STATE', (m) => m.roomState.queue.length === 1)));
    cs[0]!.send({ type: 'CONTROL', command: { type: 'play' } });
    const scheds = await Promise.all(cs.map((c) => c.waitFor('SCHEDULE')));
    const now = perfClock();
    for (const s of scheds) expect(s).toEqual(scheds[0]);
    expect(scheds[0]).toMatchObject({ action: 'play', trackId: 'tone', trackOffset: 0 });
    expect(scheds[0]!.startRoomTime).toBeGreaterThan(now);

    // seq strictly increases per client
    for (const c of cs) {
      const seqs = c.msgs.filter((m) => m.type !== 'PONG').map((m) => m.seq);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('first message must be JOIN; bad JSON is rejected', async () => {
    const c = await Client.open(srv.port);
    clients.push(c);
    c.send({ type: 'PING', t0: 1 });
    expect((await c.waitFor('ERROR')).code).toBe('not_joined');
    c.ws.send('{nope');
    expect((await c.waitFor('ERROR', (m) => m.code === 'bad_message')).code).toBe('bad_message');
    c.send({ type: 'JOIN', roomCode: 'ZZZZZZ', deviceId: 'x', name: 'x', caps });
    expect((await c.waitFor('ERROR', (m) => m.code === 'room_not_found')).code).toBe('room_not_found');
  });

  it('uploads a WAV and serves it with Range support', async () => {
    const body = wav(1000);
    const up = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'x-filename': encodeURIComponent('my tone.wav') },
      body,
    });
    expect(up.status).toBe(201);
    const info = (await up.json()) as UploadResponse;
    expect(info).toMatchObject({ title: 'my tone', mime: 'audio/wav', size: body.length });
    expect(info.url).toBe(`${base}/assets/${info.id}`);

    const part = await fetch(info.url, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${body.length}`);
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(body.subarray(10, 20));

    const full = await fetch(info.url, { headers: { origin: 'http://example.test' } });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/wav');
    expect(full.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(full.headers.get('access-control-allow-origin')).toBe('*');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(body);

    expect((await fetch(info.url, { headers: { range: `bytes=${body.length}-` } })).status).toBe(416);
  });

  it('rejects non-media and oversized uploads', async () => {
    const txt = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
    });
    expect(txt.status).toBe(415);
    const big = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.alloc(65 * 1024),
    });
    expect(big.status).toBe(413);
  });

  it('lists demo assets with absolute urls and serves them', async () => {
    const list = (await (await fetch(`${base}/api/demo`)).json()) as DemoAsset[];
    expect(list).toEqual([
      expect.objectContaining({ id: 'tone', file: 'tone.wav', url: `${base}/assets/demo/tone.wav` }),
    ]);
    const f = await fetch(list[0]!.url!, { headers: { range: 'bytes=0-3' } });
    expect(f.status).toBe(206);
    expect(Buffer.from(await f.arrayBuffer()).toString()).toBe('RIFF');
  });

  it('rejects path traversal', async () => {
    expect((await fetch(`${base}/assets/demo/..%2Fmanifest.json`)).status).toBe(400);
    expect((await fetch(`${base}/assets/demo/..%2F..%2Fprofiles.json`)).status).toBe(400);
    expect((await fetch(`${base}/assets/..%2Fdemo%2Fmanifest.json`)).status).toBe(400);
    writeFileSync(join(dataDir, 'secret.txt'), 'secret');
    expect(await rawGet(srv.port, '/assets/demo/../../secret.txt')).toBe(404);
    expect((await fetch(`${base}/assets/demo/..%2F..%2Fsecret.txt`)).status).toBe(400);
    expect(await rawGet(srv.port, '/assets/demo/%2e%2e/%2e%2e/etc/passwd')).not.toBe(200);
  });

  it('rate limits bursts and closes sustained abusers', async () => {
    const { code } = (await (
      await fetch(`${base}/api/rooms`, { method: 'POST' })
    ).json()) as CreateRoomResponse;
    const c = await Client.open(srv.port);
    clients.push(c);
    c.send({ type: 'JOIN', roomCode: code, deviceId: 'spam', name: 'spam', caps });
    await c.waitFor('WELCOME');

    for (let i = 0; i < RATE_BURST + 30; i++) c.send({ type: 'PING', t0: i });
    await c.waitFor('ERROR', (m) => m.code === 'rate_limited');
    expect(c.msgs.filter((m) => m.type === 'PONG').length).toBeLessThan(RATE_BURST + 30);

    for (let i = 0; i < MAX_DROPS + 50; i++) c.send({ type: 'PING', t0: i });
    expect(await c.until(() => c.closeCode ?? undefined)).toBe(1008);
  });
});

describe('originAllowed patterns', () => {
  const allowed = ['https://app.test', 'https://web-*-team.vercel.app'];
  it('matches exact origins and one-label wildcards only', () => {
    expect(originAllowed('https://app.test', allowed)).toBe(true);
    expect(originAllowed('https://web-abc123-team.vercel.app', allowed)).toBe(true);
    expect(originAllowed('https://web-git-my-branch-team.vercel.app', allowed)).toBe(true);
    expect(originAllowed('https://web-x.evil.com-team.vercel.app', allowed)).toBe(false);
    expect(originAllowed('https://web-abc-team.vercel.app.evil.com', allowed)).toBe(false);
    expect(originAllowed('https://evil.test', allowed)).toBe(false);
  });
});

describe('server origin check', () => {
  it('rejects WS upgrades from disallowed origins', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'syncsound-'));
    const srv = await startServer({ port: 0, dataDir, allowedOrigins: ['http://good.test'] });
    try {
      const ok = await Client.open(srv.port, { origin: 'http://good.test' });
      ok.ws.close();
      await expect(Client.open(srv.port, { origin: 'http://evil.test' })).rejects.toThrow(/403/);
      const res = await fetch(`http://127.0.0.1:${srv.port}/health`, {
        headers: { origin: 'http://evil.test' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('prepared tune: the adapter timer plans at the deadline', () => {
  it('a recorder that never answers READY is skipped when the (shortened) deadline passes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'syncsound-'));
    const srv = await startServer({ port: 0, dataDir, allowedOrigins: [], prepareDeadlineMs: 300 });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as CreateRoomResponse;
      const [h, g] = await Promise.all([Client.open(srv.port), Client.open(srv.port)]);
      h.send({ type: 'JOIN', roomCode: created.code, deviceId: 'h', name: 'H', caps: { ...caps, micPermission: 'granted' }, hostKey: created.hostKey });
      g.send({ type: 'JOIN', roomCode: created.code, deviceId: 'g', name: 'G', caps: { ...caps, micPermission: 'granted' } });
      await h.waitFor('WELCOME');
      await g.waitFor('WELCOME');
      const slots = [
        { deviceId: 'h', deviceIndex: 0, signal: 'tune', offsetMs: 500, durationMs: 1100 },
        { deviceId: 'g', deviceIndex: 1, signal: 'tune', offsetMs: 2050, durationMs: 1100 },
      ];
      const t0 = Date.now();
      h.send({ type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true });
      const prep = await g.waitFor('CALIBRATION_PREPARE');
      expect(prep.recorderIds).toEqual(['g']);
      // g never answers: the room's timer plans the run at the deadline, nobody had to send anything
      const plan = await h.waitFor('CALIBRATION_PLAN');
      const elapsed = Date.now() - t0;
      expect(plan.plan.id).toBe(prep.planId);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2500);
      h.ws.terminate();
      g.ws.terminate();
    } finally {
      await srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

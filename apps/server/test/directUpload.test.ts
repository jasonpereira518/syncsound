import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UploadInitResponse, UploadResponse } from '@syncsound/protocol';
import { startServer } from '../src/index.ts';
import { localStorage, presignV4, type Storage } from '../src/storage.ts';

describe('presignV4', () => {
  it('matches the AWS S3 presigned-URL example signature', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = new URL(
      presignV4({
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        region: 'us-east-1',
        service: 's3',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        amzDate: '20130524T000000Z',
        expiresSec: 86400,
      }),
    );
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('signs content-type for PUT so the browser must send the declared type', () => {
    const url = new URL(
      presignV4({
        method: 'PUT',
        url: new URL('https://storage.googleapis.com/b/uploads/abc'),
        headers: { 'content-type': 'audio/mpeg' },
        region: 'auto',
        service: 's3',
        accessKeyId: 'K',
        secretAccessKey: 'S',
        amzDate: '20260101T000000Z',
        expiresSec: 900,
      }),
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });
});

describe('direct-to-bucket upload routes', () => {
  const objects = new Map<string, { size: number; mime: string }>();
  const removed: string[] = [];
  const fakeBucket: Storage = {
    save: async () => {},
    locate: async (id) => ({ kind: 'redirect', url: `https://bucket.test/uploads/${id}` }),
    direct: {
      presignPut: (id, mime) => `https://bucket.test/uploads/${id}?sig=1&type=${encodeURIComponent(mime)}`,
      head: async (id) => objects.get(id) ?? null,
      remove: async (id) => void (objects.delete(id), removed.push(id)),
    },
  };
  let dataDir: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let local: Awaited<ReturnType<typeof startServer>>;
  const post = (port: number, path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const meta = { filename: 'my song.mp3', mime: 'audio/mpeg', size: 500 };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'syncsound-direct-'));
    srv = await startServer({ port: 0, dataDir, maxUploadBytes: 1000, allowedOrigins: [], storage: fakeBucket });
    local = await startServer({ port: 0, dataDir, maxUploadBytes: 1000, allowedOrigins: [], storage: localStorage(join(dataDir, 'u')) });
  });
  afterAll(async () => {
    await srv.close();
    await local.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('init → (browser PUT) → complete returns the usual UploadResponse', async () => {
    const init = await post(srv.port, '/api/assets/init', meta);
    expect(init.status).toBe(201);
    const slot = (await init.json()) as UploadInitResponse;
    expect(slot.mime).toBe('audio/mpeg');
    expect(slot.uploadUrl).toContain(`/uploads/${slot.id}?`);

    objects.set(slot.id, { size: 500, mime: 'audio/mpeg' }); // what the browser's PUT leaves in the bucket
    const done = await post(srv.port, `/api/assets/${slot.id}/complete`, meta);
    expect(done.status).toBe(201);
    expect((await done.json()) as UploadResponse).toEqual({
      id: slot.id,
      url: `http://127.0.0.1:${srv.port}/assets/${slot.id}`,
      title: 'my song',
      mime: 'audio/mpeg',
      size: 500,
    });
  });

  it('rejects oversized and non-media declarations before presigning', async () => {
    expect((await post(srv.port, '/api/assets/init', { ...meta, size: 1001 })).status).toBe(413);
    expect((await post(srv.port, '/api/assets/init', { ...meta, mime: 'text/plain' })).status).toBe(415);
    expect((await post(srv.port, '/api/assets/init', { filename: 'x' })).status).toBe(400);
  });

  it('complete: 404 when nothing was uploaded', async () => {
    expect((await post(srv.port, '/api/assets/never-put/complete', meta)).status).toBe(404);
  });

  it('complete: deletes an object that exceeds the cap (the PUT bypassed our size check)', async () => {
    objects.set('too-big', { size: 5000, mime: 'audio/mpeg' });
    expect((await post(srv.port, '/api/assets/too-big/complete', meta)).status).toBe(413);
    expect(removed).toContain('too-big');
    expect(objects.has('too-big')).toBe(false);
  });

  it('complete: deletes a non-media object', async () => {
    objects.set('not-media', { size: 10, mime: 'text/html' });
    expect((await post(srv.port, '/api/assets/not-media/complete', meta)).status).toBe(415);
    expect(removed).toContain('not-media');
  });

  it('init is 404 without bucket storage, so clients fall back to POST /api/assets', async () => {
    expect((await post(local.port, '/api/assets/init', meta)).status).toBe(404);
  });
});

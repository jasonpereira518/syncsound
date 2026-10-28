/** Asset storage: local disk by default, S3-compatible (hand-rolled SigV4) when S3_BUCKET is set. */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export interface AssetMeta {
  mime: string;
  title: string;
  size: number;
  ext: string;
}
export type Located = { kind: 'file'; path: string; meta: AssetMeta } | { kind: 'redirect'; url: string };

export interface Storage {
  /** move a fully-received temp file into storage under `id` */
  save(id: string, tmpFile: string, meta: AssetMeta): Promise<void>;
  /** caller must validate `id` first */
  locate(id: string): Promise<Located | null>;
  /** bucket-backed storage only: lets the browser PUT straight to the bucket, bypassing the server's request limits */
  direct?: {
    /** presigned PUT url; the browser must send exactly this content-type */
    presignPut(id: string, mime: string, expiresSec: number, now?: Date): string;
    /** size + content-type of the stored object, null if absent */
    head(id: string): Promise<{ size: number; mime: string } | null>;
    remove(id: string): Promise<void>;
  };
}

export function localStorage(uploadsDir: string): Storage {
  return {
    async save(id, tmpFile, meta) {
      await mkdir(uploadsDir, { recursive: true });
      await rename(tmpFile, join(uploadsDir, id + meta.ext));
      await writeFile(join(uploadsDir, `${id}.json`), JSON.stringify(meta));
    },
    async locate(id) {
      try {
        const meta = JSON.parse(await readFile(join(uploadsDir, `${id}.json`), 'utf8')) as AssetMeta;
        if (!/^(\.[A-Za-z0-9]{1,8})?$/.test(meta.ext)) return null;
        return { kind: 'file', path: join(uploadsDir, id + meta.ext), meta };
      } catch {
        return null;
      }
    },
  };
}

// ---------- AWS SigV4 ----------

const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: URL;
  /** headers to sign (host is added from url) */
  headers: Record<string, string>;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** YYYYMMDD'T'HHMMSS'Z' */
  amzDate: string;
  payloadHash: string;
}

/** returns the Authorization header value */
export function signV4(i: SignInput): string {
  const headers: Record<string, string> = { host: i.url.host };
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const query = [...i.url.searchParams]
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort()
    .join('&');
  const canonical = [
    i.method,
    i.url.pathname || '/',
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    i.payloadHash,
  ].join('\n');
  const date = i.amzDate.slice(0, 8);
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const amzNow = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** query-string (presigned URL) form of SigV4: the same canonical request, auth params in the query */
export function presignV4(i: Omit<SignInput, 'headers' | 'payloadHash'> & { headers?: Record<string, string>; expiresSec: number }): string {
  const url = new URL(i.url);
  const headers = i.headers ?? {};
  const signedHeaders = ['host', ...Object.keys(headers).map((h) => h.toLowerCase())].sort().join(';');
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${i.accessKeyId}/${i.amzDate.slice(0, 8)}/${i.region}/${i.service}/aws4_request`);
  url.searchParams.set('X-Amz-Date', i.amzDate);
  url.searchParams.set('X-Amz-Expires', String(i.expiresSec));
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);
  const auth = signV4({ ...i, url, headers, payloadHash: 'UNSIGNED-PAYLOAD' });
  url.searchParams.set('X-Amz-Signature', /Signature=([0-9a-f]+)$/.exec(auth)![1]!);
  return url.toString();
}

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

export function s3Storage(c: S3Config): Storage {
  // custom endpoint (R2/MinIO/...) → path-style; AWS → virtual-host style
  const objectUrl = (key: string) =>
    new URL(
      c.endpoint
        ? `${c.endpoint.replace(/\/$/, '')}/${c.bucket}/${key}`
        : `https://${c.bucket}.s3.${c.region}.amazonaws.com/${key}`,
    );
  const signedFetch = async (method: 'HEAD' | 'DELETE', id: string) => {
    const url = objectUrl(`uploads/${id}`);
    const amzDate = amzNow(new Date());
    const headers = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
    const authorization = signV4({
      method, url, headers, region: c.region, service: 's3', amzDate, payloadHash: 'UNSIGNED-PAYLOAD',
      accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey,
    });
    return fetch(url, { method, headers: { ...headers, authorization } });
  };
  return {
    direct: {
      presignPut: (id, mime, expiresSec, now = new Date()) =>
        presignV4({
          method: 'PUT',
          url: objectUrl(`uploads/${id}`),
          headers: { 'content-type': mime },
          region: c.region,
          service: 's3',
          amzDate: amzNow(now),
          expiresSec,
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
        }),
      async head(id) {
        const res = await signedFetch('HEAD', id);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`S3 HEAD ${res.status}`);
        return { size: Number(res.headers.get('content-length') ?? 0), mime: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() };
      },
      async remove(id) {
        await signedFetch('DELETE', id).catch(() => {});
      },
    },
    async save(id, tmpFile, meta) {
      const url = objectUrl(`uploads/${id}`);
      const amzDate = amzNow(new Date());
      const headers = {
        'content-type': meta.mime,
        'content-length': String((await stat(tmpFile)).size),
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'x-amz-date': amzDate,
      };
      const authorization = signV4({
        method: 'PUT',
        url,
        headers,
        region: c.region,
        service: 's3',
        amzDate,
        payloadHash: 'UNSIGNED-PAYLOAD',
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
      });
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { ...headers, authorization },
          body: Readable.toWeb(createReadStream(tmpFile)) as ReadableStream,
          duplex: 'half',
        } as RequestInit);
        if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } finally {
        await unlink(tmpFile).catch(() => {});
      }
    },
    async locate(id) {
      return { kind: 'redirect', url: `${c.publicBaseUrl.replace(/\/$/, '')}/uploads/${id}` };
    },
  };
}

export function storageFromEnv(uploadsDir: string, env = process.env): Storage {
  if (!env.S3_BUCKET) return localStorage(uploadsDir);
  if (!env.S3_PUBLIC_BASE_URL) throw new Error('S3_PUBLIC_BASE_URL is required when S3_BUCKET is set');
  return s3Storage({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION ?? 'auto',
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
  });
}

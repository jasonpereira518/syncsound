# Deploying SyncSound

SyncSound has two deployables:

| Piece | What | Where |
|-------|------|-------|
| `apps/server` | Node + `ws` room server (stateful, one process holds all rooms in memory) | Fly.io or Railway (any host with WebSockets + a persistent volume) |
| `apps/web` | Next.js frontend | Vercel (or the `web` Docker target) |

Both need **HTTPS** in production: microphone access (calibration), `getDisplayMedia` (tab capture) and Wake Lock all require a secure context. Phones on your LAN hitting `http://192.168.x.y:3000` will play audio but cannot calibrate or capture. Use HTTPS (`next dev --experimental-https`, a tunnel such as `cloudflared tunnel --url http://localhost:3000`, or a real deployment).

## Local (Docker)

```bash
docker compose up --build            # web :3000, server :8787
NEXT_PUBLIC_SERVER_URL=http://192.168.1.20:8787 docker compose up --build   # for phones on the LAN
docker compose --profile s3 up       # + MinIO for S3-compatible uploads
```

## Server on Fly.io

```bash
fly launch --no-deploy --name syncsound-server --dockerfile Dockerfile
# fly.toml: [build] target = "server"; [[services]] internal_port = 8787; add a [mounts] for /data
fly volumes create syncsound_data --size 1
fly secrets set ALLOWED_ORIGINS=https://your-web.vercel.app
fly deploy
```

Run exactly **one** machine (`fly scale count 1`): room state lives in memory. For horizontal scale, port `apps/server/src/room.ts` (transport-free) to a Cloudflare Durable Object, one object per room code.

## Server on Railway

New project → Deploy from repo → set *Dockerfile target* `server` (`RAILWAY_DOCKERFILE_TARGET=server`), add a volume at `/data`, set `PORT=8787`, `ALLOWED_ORIGINS`. Railway terminates TLS, so the WS URL is `wss://<app>.up.railway.app/ws`.

## Uploads on S3 / R2 / MinIO

Set `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` on the server. The bucket must allow public GET (or front it with a CDN) and CORS GET from the web origin, because every device fetches and decodes the full asset before the scheduled start.

## Frontend on Vercel

- Root directory: `apps/web`; framework Next.js; install command `pnpm install` (Vercel detects the pnpm workspace).
- Env: `NEXT_PUBLIC_SERVER_URL=https://syncsound-server.fly.dev`, plus optional Spotify/Apple variables (see `.env.example`).
- `vercel deploy --prod` (or Git integration).

## Spotify / Apple Music (optional)

- Spotify: create an app at developer.spotify.com, enable the **Web Playback SDK**, add the redirect URI `https://<web>/spotify-callback`, set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` and `NEXT_PUBLIC_SPOTIFY_REDIRECT_URI`. Each participating device signs in with its own **Premium** account. Development-mode apps only allow allow-listed users.
- Apple Music: generate a MusicKit developer token (JWT signed with your MusicKit private key; max 6 months) and set `NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN`. Each device needs its own Apple Music subscription.

Both are sync-only (no spatial/EQ) by design: their audio is DRM-protected and owned by the official SDK.

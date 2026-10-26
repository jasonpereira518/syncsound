# Deploying SyncSound

SyncSound has two deployables:

| Piece | What | Where |
|-------|------|-------|
| `apps/server` | Node + `ws` room server (stateful, one process holds all rooms in memory) | Google Cloud Run (`cloudbuild.yaml`, live), or Fly.io / Railway (any host with WebSockets; a persistent volume keeps homes) |
| `apps/web` | Next.js frontend | Vercel (or the `web` Docker target) |

Both need **HTTPS** in production: microphone access (calibration), `getDisplayMedia` (tab capture) and Wake Lock all require a secure context. Phones on your LAN hitting `http://192.168.x.y:3000` will play audio but cannot calibrate or capture. Use HTTPS (`next dev --experimental-https`, a tunnel such as `cloudflared tunnel --url http://localhost:3000`, or a real deployment).

## Quick start: Vercel (web) + Google Cloud Run (server)

The live setup: the site is on Vercel (`https://syncsound.jasonpereira.live`) and the room server on Cloud Run as
**syncsound-server** in `us-central1` (`https://syncsound-server-645599971176.us-central1.run.app`). Vercel can't run
the room server itself (it needs a long-lived WebSocket process); without a server address the site shows
*"This SyncSound site isn't connected to its room server yet"*.

**1. Build and deploy the server** (needs the [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in to the project)

```bash
# image for Cloud Run (amd64), built by Cloud Build from the Dockerfile's `server` target (cloudbuild.yaml)
gcloud builds submit --config cloudbuild.yaml   --substitutions=_IMAGE=us-central1-docker.pkg.dev/<PROJECT_ID>/syncsound/server:latest .

gcloud run deploy syncsound-server   --image us-central1-docker.pkg.dev/<PROJECT_ID>/syncsound/server:latest   --region us-central1 --port 8787 --allow-unauthenticated   --max-instances 1 --timeout 3600 --session-affinity   --set-env-vars "ALLOWED_ORIGINS=https://syncsound.jasonpereira.live,PUBLIC_URL=https://syncsound-server-645599971176.us-central1.run.app"
```

Why these flags:

- `--max-instances 1`: every room lives in this one process's memory. Two instances would split rooms between them
  (devices couldn't find each other's rooms).
- `--timeout 3600`: a WebSocket is one long request, and Cloud Run closes it at the timeout (default 5 min, max 60);
  the app reconnects and re-syncs by itself when that happens.
- `--session-affinity`: keeps a device on the same instance across reconnects.
- `ALLOWED_ORIGINS`: the site addresses allowed to connect, exactly as in the browser's address bar (`https://`, no
  path; a trailing slash is ignored). Several: use gcloud's alternate delimiter,
  `--set-env-vars "^@^ALLOWED_ORIGINS=https://a.example,https://b.example@PUBLIC_URL=https://…run.app"`.
- `PUBLIC_URL`: the service's own URL, used in links to demo tracks and uploads.

Check it: `https://syncsound-server-645599971176.us-central1.run.app/health` → `{"ok":true}`. The bare URL answers
`{"error":"not found"}`; that's normal, the server has no web page.

**2. Point the Vercel site at it**

1. Vercel → your project → **Settings → Environment Variables**.
2. `NEXT_PUBLIC_SERVER_URL` = `https://syncsound-server-645599971176.us-central1.run.app` (no trailing slash, no
   `/ws`), for *Production* (and *Preview* if you use previews; add those preview addresses to `ALLOWED_ORIGINS` too).
3. **Deployments → ⋯ on the latest → Redeploy.** Required: `NEXT_PUBLIC_*` values are built into the site, so
   changing the variable does nothing until the next build.
4. Open the site, create a room, join from your phone. The connection badge should read *Connected*.

**Good to know**

- With no minimum instances, an idle server scales to zero and the first visit waits a few seconds for it to start
  (the site says so). `--min-instances 1` keeps it warm, at a cost.
- The container's disk is in memory and starts empty on every new instance or deploy: saved homes, their layouts and
  tunings, and uploads are lost then (quick rooms are unaffected). To keep them, mount a Cloud Storage bucket as a
  volume at `/data` (`--add-volume name=data,type=cloud-storage,bucket=<bucket> --add-volume-mount volume=data,mount-path=/data`).

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
- Env: `NEXT_PUBLIC_SERVER_URL=https://syncsound-server-645599971176.us-central1.run.app` (the Cloud Run URL), plus optional
  Spotify/Apple variables (see `.env.example`). Without it, a public deployment shows "isn't connected to its room
  server yet" instead of trying to connect.
- `vercel deploy --prod` (or Git integration). Redeploy after changing any `NEXT_PUBLIC_*` variable.

## Spotify / Apple Music (optional)

- Spotify: create an app at developer.spotify.com, enable the **Web Playback SDK**, add the redirect URI `https://<web>/spotify-callback`, set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` and `NEXT_PUBLIC_SPOTIFY_REDIRECT_URI`. Each participating device signs in with its own **Premium** account. Development-mode apps only allow allow-listed users.
- Apple Music: generate a MusicKit developer token (JWT signed with your MusicKit private key; max 6 months) and set `NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN`. Each device needs its own Apple Music subscription.

Both are sync-only (no spatial/EQ) by design: their audio is DRM-protected and owned by the official SDK.

# Deploying SyncSound

SyncSound has two deployables:

| Piece | What | Where |
|-------|------|-------|
| `apps/server` | Node + `ws` room server (stateful, one process holds all rooms in memory) | Render (free, `render.yaml`), Fly.io or Railway (any host with WebSockets; a persistent volume keeps homes) |
| `apps/web` | Next.js frontend | Vercel (or the `web` Docker target) |

Both need **HTTPS** in production: microphone access (calibration), `getDisplayMedia` (tab capture) and Wake Lock all require a secure context. Phones on your LAN hitting `http://192.168.x.y:3000` will play audio but cannot calibrate or capture. Use HTTPS (`next dev --experimental-https`, a tunnel such as `cloudflared tunnel --url http://localhost:3000`, or a real deployment).

## Quick start: Vercel (web) + Render (server), both free

The Vercel site alone shows *"This SyncSound site isn't connected to its room server yet"*: Vercel can't run the
room server (it needs a long-lived WebSocket process). Put the server on Render and point the site at it.

**1. Deploy the server on Render** (≈ 5 minutes, free, no card)

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**, pick this repository, keep the branch you deploy from (e.g. `main`). Render reads
   [`render.yaml`](../render.yaml) and proposes one free web service, **syncsound-server**.
3. It asks for `ALLOWED_ORIGINS`: enter your Vercel site's address, e.g. `https://sync-sound.vercel.app`
   (no trailing slash; add more separated by commas, e.g. your custom domain). Leave it empty to allow any site.
4. **Apply**. The first build takes a few minutes. When it says *Live*, copy the service URL from the top of its page,
   e.g. `https://syncsound-server.onrender.com`.
5. Check it: open `https://<your-service>.onrender.com/health` in a browser → `{"ok":true}`.

**2. Point the Vercel site at it**

1. Vercel → your project → **Settings → Environment Variables**.
2. Add `NEXT_PUBLIC_SERVER_URL` = the Render URL from step 1.4 (`https://…onrender.com`, no trailing slash, no `/ws`),
   for *Production* (and *Preview* if you use previews).
3. **Deployments → ⋯ on the latest → Redeploy.** Required: `NEXT_PUBLIC_*` values are built into the site, so
   changing the variable does nothing until the next build.
4. Open the site, create a room, join from your phone. The connection badge should read *Connected*.

**Free-plan limits (Render)**

- The server **sleeps after ~15 minutes without visitors**. The first visit after that waits up to about a minute
  while it wakes (the site says so). For always-on, use Render's paid *Starter* instance.
- The free disk is **not kept** across restarts and redeploys: saved homes, their room layouts/tunings and uploaded
  files are lost then. Quick rooms are unaffected. To keep them, upgrade to *Starter*, add a disk mounted at
  `/var/data` and set `DATA_DIR=/var/data`.
- Run exactly one instance (the blueprint does): rooms live in the server's memory.

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
- Env: `NEXT_PUBLIC_SERVER_URL=https://syncsound-server.onrender.com` (or your Fly/Railway URL), plus optional
  Spotify/Apple variables (see `.env.example`). Without it, a public deployment shows "isn't connected to its room
  server yet" instead of trying to connect.
- `vercel deploy --prod` (or Git integration). Redeploy after changing any `NEXT_PUBLIC_*` variable.

## Spotify / Apple Music (optional)

- Spotify: create an app at developer.spotify.com, enable the **Web Playback SDK**, add the redirect URI `https://<web>/spotify-callback`, set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` and `NEXT_PUBLIC_SPOTIFY_REDIRECT_URI`. Each participating device signs in with its own **Premium** account. Development-mode apps only allow allow-listed users.
- Apple Music: generate a MusicKit developer token (JWT signed with your MusicKit private key; max 6 months) and set `NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN`. Each device needs its own Apple Music subscription.

Both are sync-only (no spatial/EQ) by design: their audio is DRM-protected and owned by the official SDK.

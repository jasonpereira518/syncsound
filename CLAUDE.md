# SyncSound

Multi-device synchronized + spatial audio in the browser. A host creates a room; phones/laptops/tablets join
by link/QR; every device plays the same audio at the same instant, each rendering its own spatial mix with
per-device latency compensation and EQ.

## Layout

```
apps/web/            Next.js App Router + Tailwind + Zustand (UI, Web Audio engine, WebRTC mesh)
apps/server/         Node + ws room server (authoritative room state, clock pongs, asset storage)
packages/protocol/   zod schemas + shared types for every WS message
packages/audio-core/ framework-agnostic math: clock sync, scheduler, drift control, spatial gains,
                     crossover/biquads, EQ fitting, DSP (FFT, sweeps, chirps, deconvolution), WAV I/O
packages/sim/        headless network/clock simulator + offline-render alignment + calibration sims
e2e/                 Playwright multi-context tests
docs/                PLAN, PROGRESS (resume point), DECISIONS, LIMITATIONS, HUMAN_TEST_CHECKLIST, SYNC_RESULTS
```

## Commands

```
pnpm install
pnpm demo        # generate demo WAVs into apps/server/data/demo
pnpm dev         # server :8787 + web :3000 (SERVER_PORT=… WEB_PORT=… to move them)
pnpm test        # vitest unit tests (all packages)
pnpm sim         # headless simulator suite (packages/sim)
pnpm e2e         # Playwright (builds web, starts server)
pnpm typecheck
pnpm lint
pnpm verify      # typecheck + lint + test + sim + e2e — the single green/red gate
```

Scope a command to one package: `pnpm --filter @syncsound/audio-core test`.

## Architecture rules

- Server owns one authoritative room state per room. Room logic (`apps/server/src/room.ts`) is transport-free
  so it can be ported to a Cloudflare Durable Object; `ws` is only an adapter.
- All play/pause/seek are `(startRoomTime, trackOffset)` pairs scheduled in the future
  (>= max device RTT + safety margin). Clients schedule against `AudioContext` time.
- Clients map `roomTime ↔ performance.now() ↔ AudioContext.currentTime`.
- Each client computes only its own mix from the shared scene (`computeDeviceMix` in audio-core).
- Audio assets are pre-fetched over HTTP and decoded before the scheduled start; never streamed on the WS.
- `audio-core` has no React/DOM dependency and is fully unit-tested in Node.
- Packages export TS source directly (no build step); Next uses `transpilePackages`, server runs on `tsx`.

## Hard constraints (never work around these)

- No DRM circumvention. Spotify/Apple Music audio cannot be captured, re-streamed or routed through Web Audio.
  They are Class B "sync-only" sources driven through their official SDKs; spatial/EQ are unavailable there
  and the UI says so ("Sync-only mode (no spatial/EQ)").
- Netflix/Disney+/DRM video tab capture yields silence: detect it and explain, don't fail quietly.
- Never download/extract YouTube streams. YouTube = YouTube's own tab (official player) + tab capture for audio.
- AudioContext needs a user gesture ("Join the speaker array" button). iOS suspends background audio.
  Bluetooth adds 100–300 ms unreported latency → acoustic calibration / manual slider.

## Working rules (autonomous run contract)

- No questions/approval gates. Ambiguity → pick the prompt's option, else the simplest robust one;
  record in `docs/DECISIONS.md`.
- After 8 genuine, different fix attempts, apply the best legitimate fallback and log it in `docs/LIMITATIONS.md`.
- Never fake results: no hardcoded passing numbers, no skipped/deleted failing tests, no weakened assertions.
  Anything needing real hardware goes to `docs/HUMAN_TEST_CHECKLIST.md`.
- `docs/PROGRESS.md` is the resume point: re-read it after compaction and continue at the first unchecked item.
- Per milestone: implement → tests → `pnpm typecheck && pnpm lint && pnpm test` → acceptance check →
  `git commit -m "M<n>: ..."` → tick PROGRESS.
- Keep tool output small (`| tail -n 40`).

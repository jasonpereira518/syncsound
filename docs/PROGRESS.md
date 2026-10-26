# Progress (resume point — continue at the first unchecked item)

- [x] M0 – Scaffold (monorepo, TS strict, ESLint, Prettier, Vitest, Playwright, CI, demo generator, git init)
- [x] Contracts (protocol zod schemas, audio-core API) + parallel workstreams integrated
- [x] M1 – Rooms + clock sync (create/join, QR, device list, NTP sync, debug panel; sim <10 ms w/ jitter)
- [x] M2 – Synchronized file playback (upload, pre-buffer, schedule, pause/seek, late join, drift correction)
- [x] M3 – Latency calibration (auto estimate, manual offset, chirp calibration, propagation alignment)
- [x] M4 – Spatial engine + stage UI (objects, DBAP, smooth drag, presets, bass management, undo/redo)
- [x] M5 – Device ID + auto-EQ (chirp-ID mapping, sweep, EQ fit, loudness, A/B)
- [x] M6 – Video mode (tab capture + WebRTC, local-file video, YouTube, DRM-silence detection)
- [x] M7 – Spotify / Apple Music sync-only (adapters, mock, seek sync w/ hysteresis, labeling)
- [x] M8 – Polish & deploy (PWA, a11y, error states, docs, Docker, CI, deploy guide)
- [x] Final: fresh-clone `pnpm verify`, self-review, SYNC_RESULTS, HUMAN_TEST_CHECKLIST

## Revamp (plan: home surround, <1 ms, simple UI + Advanced view)

- [x] R1 – Sub-ms sync: PI drift controller, LAN clock master over DataChannel (`ClockLink`), Bluetooth latency heuristic, <1 ms sync status
- [x] R2 – One speaker-layout model (LayoutId + slots, channel-routed mix, 7.1, `suggestLayout`, Stage layout buttons)
- [x] R3 – Calibration v2: auto-pause/resume, "turn this device up" hints (volumeUpDb), quick re-sync (chirps only), volume persisted
- [x] R4 – Persistent Home + rooms (server/protocol; built in its own session, merged)
- [x] R5 – Simple UI: landing → Home → room; one-tap join; 3-step setup wizard with room diagram; Now Playing; speaker screen
- [x] R6 – Advanced view (previous full shell behind "Advanced", debug only there)
- [ ] R7 – Native shells (later)
- [x] Calibration v3 – one-tap "Tune room": every laptop records, BeepBeep ranging → measured layout, listener-row timing aligned at the head, one wideband sweep per device, staggered wideband sync check (sim: head p95 0.53 ms)
- [ ] Calibration v3 on real hardware (HUMAN_TEST_CHECKLIST items 18–19)
- [x] Tune sound + leveling: one swoosh → chime per device (no auto click run), median loudness with ≤ +6 dB boost ahead of the limiter, K-weighted level, listener excluded from the median (DECISIONS 55–58)
- [x] Phase 2 – phones as the listener (held at the head), iOS audio-session/background constraints (code + tests)
- [ ] Phase 2 on real phones (HUMAN_TEST_CHECKLIST item 23)
- [x] Gap pass: group-play button, one-step YouTube, rejoin prompt, volume-to-max prompt, re-sync on clock steps, Bluetooth wobble during tuning, room name in title, balance / "Only I can control" renames, tests (home flow with tuning + volume, group play + rejoin, Bluetooth wobble sim)
- [x] Gapless auto-advance at track end + "Crossfade" room setting (server-timed SCHEDULEs, equal-power fades on the room timeline, durations learned from the first decode; DECISIONS 59–61, HUMAN_TEST_CHECKLIST 20)
- [x] Capture quality pass: alignment delay governed (median + 10 ms deadband, whole samples, dip → step → rise instead of a glide), jitter-buffer target = buffer/2, app tab excluded from the share picker (host monitors only a shared tab), in-app YouTube player replaced by "open in its own tab + share it", a share pauses the room and blocks play, e2e hears the received tone through `?tap=1` (DECISIONS 62–66, HUMAN_TEST_CHECKLIST 21)
- [x] Spatial pass: one sharp azimuth panner (`vbapGains`) for every layout, automatic upmix so C/surround slots always play, layout-aware role picker + auto-slotting of late joiners, 8D orbit (synced by room time), simpler Stage controls
- [ ] Spatial pass on real speakers (HUMAN_TEST_CHECKLIST item 22)

## Calibration + sync pass (plan: tighter, simpler, stays in tune)

- [x] S1 – Clocks that don't step: `rebase()` + gap/regime re-acquisition instead of `reset()`, age-bounded window, robust `fitLine`, long-baseline audio-clock rate, drift loop with measured dt / hold / learned-rate starts, `ReconcileGate` (suspend → fade + rebuild when ready), resync reschedules only if the mapping moved, `ClockLink` ready hold / mapping freshness / reconnect / mapping on pongs, Worker ticker; sims: pause/resume (5 & 30 min, sleep, suspend), 60-min wander, resync, LAN failover; e2e: resume spread, visibility (DECISIONS 76–85)
- [ ] S1 on real hardware (HUMAN_TEST_CHECKLIST 24–26)
- [x] S2 – Calibration accuracy hardening: analytic `frozenRoomMap`, the master's mapping pinned for a plan, `clockSettled` gate, `runValidity` + one retry + emitter faults, one tune at a time (`calibration_busy`, cancel), `tuneRoom.ts` + `tuneClock.test.ts` on real clocks (LAN head p95 3.27 → 0.74 ms) (DECISIONS 86–91)
- [ ] S2 on real hardware (HUMAN_TEST_CHECKLIST 27)
- [x] S3 – Calibration that stays valid: raw-arrival invariant + tune-time positions in `scene.tune`, server-derived `calibratedLatencyMs` / `syncState` on every edit, tune identity (unheard → untuned, `tuneStale` reported to the room), `placeForLayout` keeps ranged devices, late joiners take a free slot, per-output memory of `{ tuneId, tuneArrivalMs }`, shared `TuneStatus`; sim `tuneInvariant.test.ts` (drag/layout reset: 0.000 ms change vs 2.96 ms frozen); e2e quick tune from Now Playing (DECISIONS 92–96)
- [ ] S3 on real hardware (HUMAN_TEST_CHECKLIST 28)
- [x] S4 – Simplest setup experience: one-screen setup (layout suggested and applied by the tune, "Adjust layout" folded away, auto-advance), mic asked for at join (`probeMic`, `caps.micPermission`, `CAPS_UPDATE`), prepare/ready handshake (`CALIBRATION_PREPARE`/`READY`, 8 s deadline on a room timer, 1.5 s lead), one "Tune" verb (`roomActions.tune` + `tuneStatus`), Tune card in Now Playing, names in warnings, landing → room; e2e: host 3 taps to tuned / 5 to playing, guest 1; slow, unanswering and busy recorders; `AudioClockMap` lost-lock recovery, immediate busy on a participating device (DECISIONS 97–105)
- [ ] S4 on real hardware (HUMAN_TEST_CHECKLIST 16, 29)
- [x] S5 – Docs and results: SYNC_RESULTS §2c–2f, §4c, §4d, §6 setup checks; stale figures fixed (landing page, LIMITATIONS EQ); superseded decisions marked; `pnpm verify` green

## Spotify pass (plan: sign in, browse, play tracks/playlists synced on every device)

- [x] SP1 – Durable sign-in: `spotifyAuth.ts` (localStorage per device, PKCE refresh single-flight + Web Locks, rotated refresh token, invalid_grant → signed out, legacy migration), playback vs browse scopes, 403 classification (Premium / dev-mode allow-list), SDK prepared early + `activate()` inside the tap, auto-connect after join, `autoplay_failed` / lost-device flags, `SpotifyBanner` on every view (guests in host-only rooms can connect), disconnect
- [x] SP2 – Web API client (`spotifyApi.ts`: search ≤10/page, playlists, Liked Songs, albums, 429 gate, cache) + `MockSpotifyApi`; follows the Feb 2026 Web API rules (playlist songs only for own/collaborative playlists via `/items`, entry `item`|`track`, no batch lookups)
- [x] SP3 – Protocol `queueMany` (append/insert/replace + playIndex, ≤100, all or nothing) + Track `artist`/`album`/`artworkUrl` (Spotify CDN only), `QueueTrack` (Spotify needs id + duration; queue inputs only), server auto-advance for any track with a duration, no fade into or out of sync-only tracks, `queueRemote` looks the song up
- [ ] SP4 – Client sync: output compensation for remote tracks, persisted seek/start leads, track-boundary hand-over, end guard, pause when the room isn't playing
- [ ] SP5 – Spotify browse panel, cover art + metadata everywhere, readiness count, e2e `spotify-browse.spec.ts`
- [ ] SP6 – Docs (DEPLOY, LIMITATIONS, DECISIONS, HUMAN_TEST_CHECKLIST), `pnpm verify`
- [ ] Spotify pass on real accounts (HUMAN_TEST_CHECKLIST 10)

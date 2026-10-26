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
- [ ] Phase 2 – phones as the listener (held at the head), iOS audio-session/background constraints
- [x] Gap pass: group-play button, one-step YouTube, rejoin prompt, volume-to-max prompt, re-sync on clock steps, Bluetooth wobble during tuning, room name in title, balance / "Only I can control" renames, tests (home flow with tuning + volume, group play + rejoin, Bluetooth wobble sim)

## Calibration + sync pass (plan: tighter, simpler, stays in tune)

- [x] S1 – Clocks that don't step: `rebase()` + gap/regime re-acquisition instead of `reset()`, age-bounded window, robust `fitLine`, long-baseline audio-clock rate, drift loop with measured dt / hold / learned-rate starts, `ReconcileGate` (suspend → fade + rebuild when ready), resync reschedules only if the mapping moved, `ClockLink` ready hold / mapping freshness / reconnect / mapping on pongs, Worker ticker; sims: pause/resume (5 & 30 min, sleep, suspend), 60-min wander, resync, LAN failover; e2e: resume spread, visibility (DECISIONS 59–68)
- [ ] S1 on real hardware (HUMAN_TEST_CHECKLIST 20–22)
- [x] S2 – Calibration accuracy hardening: analytic `frozenRoomMap`, the master's mapping pinned for a plan, `clockSettled` gate, `runValidity` + one retry + emitter faults, one tune at a time (`calibration_busy`, cancel), `tuneRoom.ts` + `tuneClock.test.ts` on real clocks (LAN head p95 3.27 → 0.74 ms) (DECISIONS 69–74)
- [ ] S2 on real hardware (HUMAN_TEST_CHECKLIST 23)
- [ ] S3 – Calibration that stays valid (tune invariant + server derivation, tune identity / syncState, late joiner, TuneStatus)
- [ ] S4 – Simplest setup experience (one-screen setup, mic at join, prepare/ready, one "Tune" verb)
- [ ] S5 – Docs and results

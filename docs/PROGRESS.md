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
- [ ] R4 – Persistent Home + rooms (server/protocol)
- [ ] R5 – Simple UI (Home, Join/Speaker screen, setup wizard, Now Playing)
- [ ] R6 – Advanced view (relocate expert surfaces)
- [ ] R7 – Native shells (later)

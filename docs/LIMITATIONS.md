# Limitations

An honest list of what is not done, what can't be verified without hardware, and what the platform constrains.

## Platform constraints (by design, not bugs)

- **Spotify / Apple Music are DRM-protected.** They run sync-only (seek-based) through the official Web Playback
  SDK / MusicKit JS, with no spatial rendering, no EQ and no sample-accurate scheduling. Expect tens of ms to
  ~150 ms. Every device needs its own Premium / Apple Music subscription.
- **DRM video** (Netflix, Disney+, …) captures as silence. The app detects this after 3 s and explains it.
- **YouTube** streams are never downloaded. The host shows the official IFrame player, and audio reaches the
  other devices only through tab capture (Mode 1).
- **Secure context:** microphone (calibration), `getDisplayMedia` (capture) and Wake Lock need HTTPS. Phones on
  `http://<LAN-IP>` can play, but can't calibrate or capture. See DEPLOY.md.
- **iOS Safari** suspends audio in the background and some versions lack `outputLatency`. The app re-syncs and
  reschedules on `visibilitychange`, but background playback on iOS is not possible.
- **Bluetooth output latency** is not reported by browsers. It needs acoustic calibration or the manual slider.
- **Clock asymmetry:** NTP-style sync can't observe asymmetric network paths. The bias (asymmetry/2, e.g.
  15 ms for a 30 ms asymmetry) gets absorbed by acoustic calibration; without calibration it remains.

## Verified only in simulation or headlessly (needs real devices; see HUMAN_TEST_CHECKLIST.md)

- **Acoustic numbers:** all inter-device sync numbers come from simulation, offline rendering or same-machine
  headless browsers. None was measured with real phones, speakers and a microphone in a room.
- **Calibration** (chirp ID, sweep EQ, loudness) is verified with synthetic acoustics and a browser loopback
  "mic". Real microphones (AGC, non-flat response, room reflections) are untested. A phone mic's own response
  is common to every device, so relative matching still holds, but absolute EQ is shaped by it.
- **Lip-sync** (Mode 1 buffer, nudge slider) and "no clicks while dragging" (gain smoothing with
  `setTargetAtTime`) need ears.
- **The S3/R2/MinIO storage adapter** is only unit-tested at the signer level (AWS's published SigV4 vector).
  Uploads through a real bucket are untested.
- **Spotify and Apple adapters** are verified only through contract tests against the mock adapter. Real OAuth,
  Premium detection and MusicKit authorization are untested, since no credentials are available here.
- **Docker images** are built and smoke-tested locally (server health + demo assets, web 200). Fly.io/Railway/Vercel
  deploys are documented but not performed.

## Known gaps and simplifications

- **EQ convergence below 280 Hz:** the 200 Hz–8 kHz pairwise spread drops 38 % (spec target 40 %). Over
  280 Hz–8 kHz, where every device's EQ may act, it drops 78 %. Below 280 Hz the phone (300 Hz high-pass) may not
  be boosted by rule, so in the app that band goes through bass management to bass-capable devices instead.
- **Clock drift estimate under heavy jitter:** with σ ≥ 5 ms jitter and 1 Hz pings, drift is within ±5 ppm only
  after ~300 s (at 120 s: 5.0 ppm with σ 5 ms, up to 44.5 ppm with σ 30 ms). The offset error stays < 6 ms max
  regardless. Harsh-jitter alignment is 2.5 ms vs < 2 ms for normal Wi-Fi.
- **The drift controller deadband** leaves a steady ~1.5 ms bias (hysteresis between 1 and 2 ms). Feeding the
  measured rate forward would centre it; not done.
- **Clock-sync transport:** WebSocket only. The optional unreliable WebRTC DataChannel for lower-jitter pings was
  not implemented; the simulator shows WS-level jitter already stays within target.
- **Capture transport** is a WebRTC mesh: host uplink = N × ~256 kbps Opus. Fine for ~8 devices. LiveKit (an SFU)
  is recommended beyond that but not integrated. The capture pipeline-delay estimate uses `getStats`
  (jitterBufferDelay + RTT/2 + a fixed 20 ms Opus framing allowance), which is unverified on real networks.
- **Positions:** multilateration auto-layout from chirp time-of-flight (a stretch goal) is not implemented. Devices
  are placed manually or by preset, and "Identify" helps match icons to physical speakers. A height axis is not
  implemented.
- **Upmix** is a simple mid/side derivation (C = mid −3 dB, surrounds = filtered and delayed side), not a
  steering decoder.
- **Track end:** the client doesn't auto-advance; the host presses next. The server doesn't track durations to
  auto-advance.
- **Single server process:** room state lives in memory, so run one instance. `room.ts` is transport-free to make
  a Durable Object port straightforward, but the port isn't done.
- **Device id lives in localStorage:** two tabs of the same browser profile share it and replace each other in the
  room. Use separate browser profiles/devices.
- **Spotify tokens** aren't refreshed (they expire after 1 h; reconnect). Apple Music has no reliable
  missing-subscription check.
- **Profiles persist** (server `profiles.json`, keyed by the device id in localStorage): name, role, trim, latency,
  calibrated latency, EQ bands, rolloff, bass capability. The raw impulse response is not stored; re-measure to
  see curves again.
- **Calibration does not auto-pause music.** Users are told to pause first.
- **Room creation and uploads** are rate-limited per remote address in-process. Behind a proxy, use a trusted
  `X-Forwarded-For`.
- **This checkout's path contains `**`**, which breaks TypeScript's package-exports wildcard resolution (worked
  around with tsconfig `paths` for zustand) and makes Vite print a warning. Neither affects clones at normal paths.

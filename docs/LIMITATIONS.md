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
- **Bluetooth output latency** is not reported by browsers. It needs acoustic calibration or the manual slider
  (±1000 ms). The schedule lead grows with the largest device compensation, so a Bluetooth room has a slightly
  slower response to play/seek (e.g. ~550 ms instead of ~250 ms).
- **Bluetooth latency can change mid-session** (reconnect, codec renegotiation, speaker waking from sleep, RF
  interference). The browser can't see this; only re-running calibration or *Measure sync* catches it.
- **One phone drives one Bluetooth speaker.** A page has one audio output; OS "dual audio" features are outside
  the app's control and not compensated.
- **A Bluetooth listener can't measure its own speaker.** Opening the mic switches Bluetooth to its hands-free
  profile, so a device playing through Bluetooth is left out of a run it listens for (with a warning). Calibrate
  it from another device.
- **Per-output calibration memory** needs readable output labels: desktop Chromium/Firefox after mic permission
  was granted on that device. On iOS, and on Android where output devices aren't listed, a route change still
  only prompts to recalibrate. A device that never granted mic permission (calibrated from another listener)
  has no labels either. Calibrated latencies are relative to the fastest device *in that run*, so values from
  runs with different device sets are not strictly comparable.
- **The tune's search window is −0.4…+1.0 s around each slot** (every device plays the same sweep, so windows
  can't overlap the next slot). A speaker more than ~1 s late (AirPlay-class outputs, ~2 s) is not heard; use the
  manual slider for it.
- **The head is assumed 0.4 m behind the tuning laptop.** Timing is exact at that laptop's mic and aligned at the
  assumed head position; if you sit elsewhere, drag the listener on the stage (or tune from where you sit). Aligning
  at the mic instead would leave ~1.6 ms of error in the sim room (`tune.test.ts` control).
- **A laptop's two speakers are ~25 cm apart**, so its arrival differs by up to ±0.4 ms depending on direction, and
  measured distances are short by up to its half-width (≤ 15 cm in sim): the first arrival comes from the nearer
  speaker.
- **External speakers that aren't Bluetooth** (HDMI, USB, wired) far from their laptop are detected only by the
  direct-level co-location test, which can miss one a few metres away; if the layout looks wrong, drag it. Their
  timing at the listener is unaffected.
- **Headphones can't be tuned** (no mic hears them): they keep the browser-reported latency plus the manual slider.
- **Clock asymmetry:** NTP-style sync can't observe asymmetric network paths. The bias (asymmetry/2, e.g.
  15 ms for a 30 ms asymmetry) gets absorbed by acoustic calibration; without calibration it remains.

## Verified only in simulation or headlessly (needs real devices; see HUMAN_TEST_CHECKLIST.md)

- **Acoustic numbers:** all inter-device sync numbers come from simulation, offline rendering or same-machine
  headless browsers. None was measured with real phones, speakers and a microphone in a room.
- **Calibration** (ranging, timing, sweep EQ, loudness) is verified with synthetic acoustics (first-order wall and
  floor reflections, stereo laptops, recorder ppm, fresh clock errors at play time) and a browser loopback
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

- **EQ convergence below 280 Hz:** the 200 Hz–8 kHz pairwise spread drops 37 % (spec target 40 %). Over
  280 Hz–8 kHz, where every device's EQ may act, it drops 80 %. Below 280 Hz the phone (300 Hz high-pass) may not
  be boosted by rule, so in the app that band goes through bass management to bass-capable devices instead.
- **Clock drift estimate under heavy jitter:** with σ ≥ 5 ms jitter and 1 Hz pings, drift is within ±5 ppm only
  after ~300 s (at 120 s: 5.0 ppm with σ 5 ms, up to 44.5 ppm with σ 30 ms). The offset error stays < 6 ms max
  regardless. Harsh-jitter alignment is 2.5 ms vs < 2 ms for normal Wi-Fi.
- **LAN clock master (R1)** is verified in simulation (`lanMaster.test.ts`, `lanFailover.test.ts`) and by unit
  tests, not yet on real hardware. If WebRTC can't connect between two devices (e.g. client isolation on guest
  Wi-Fi), they fall back to the server clock, which keeps the old ~1–2 ms device-to-device spread over a WAN; a
  dropped link is retried with backoff (1…30 s).
- **Background-tab throttling** is countered by running the sync loops on a Worker (S1), whose exemption from
  Chrome's intensive throttling is documented policy but verifiable only on hardware (HUMAN_TEST_CHECKLIST 20). The
  loops are correct at any tick rate either way; without the Worker a paused room's clock just has fewer samples
  (and the debug drawer's "syncing" badge can show until the resume burst).
- **A suspended AudioContext (iOS background, device sleep)** leaves ≈ 0.75–1 s of silence on resume: the
  audio-clock map needs four fresh observations before the source is rebuilt. Before S1 the old source kept playing
  minutes-old audio for about as long.
- **Clock-rate wander** (crystal temperature) is followed, not averaged: the audio-clock slope lags a ±2 ppm /
  15 min wander by up to ≈ 2 ppm and the drift fit lags ±3 ppm / 20 min by up to ≈ 4 ppm (`longSession.test.ts`);
  position error stays p95 0.7 ms over an hour.
- **Capture transport** is a WebRTC mesh: host uplink = N × ~256 kbps Opus. Fine for ~8 devices. LiveKit (an SFU)
  is recommended beyond that but not integrated. The capture pipeline-delay estimate uses `getStats`
  (jitterBufferDelay + RTT/2 + a fixed 20 ms Opus framing allowance), which is unverified on real networks.
- **Positions:** a full tune measures laptop-to-laptop distances (two-way ranging) and lays the room out from them,
  fitted onto the user's rough layout. Devices that don't record (no mic or permission) or play through Bluetooth
  keep their hand placement (flagged in the result). Multilateration of those, and a height axis, are not
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
- **Calibration auto-pauses only when the calibrating device may control playback** (host, or open control). A
  guest under host-only control is still told to ask the host to pause.
- **Loudness matching boosts a soft speaker by at most +6 dB.** Everyone meets at the median; a boosted device's
  loud peaks are compressed by its output limiter (up to ~6 dB on a full-scale master) rather than clipped. A device
  more than 6 dB short is flagged (`volumeUpDb`) and asked to turn its own volume up before re-tuning; a browser
  can't do that itself, the native shells (R7) will.
- **The tuning laptop's own loudness is a prior.** Its speaker→mic path is assumed to be 0.1 m (`SELF_OFFSET_M`);
  a down-firing speaker with a bezel mic can read several dB off. Since #58 that only affects the tuning laptop's
  own trim (the others level to their own median). Estimating the path from pair levels was not adopted: a far mic
  hears a stereo laptop's two speakers separately (≈ ±3 dB bias), which would add error where the prior is right.
  Phase 2 (a phone held at the head as the listener) removes the near-field step.
- **Tabs on older code can't take part in a chime tune.** They reject the `'tune'` plan and are reported "not
  heard"; reload them.
- **Room creation and uploads** are rate-limited per remote address in-process. Behind a proxy, use a trusted
  `X-Forwarded-For`.
- **This checkout's path contains `**`**, which breaks TypeScript's package-exports wildcard resolution (worked
  around with tsconfig `paths` for zustand) and makes Vite print a warning. Neither affects clones at normal paths.
- **Group play** only shares tracks every device decodes itself (demo, music/video files, links). Tab capture,
  YouTube and Spotify/Apple stream from one room, so they can't be played in several rooms at once.
- **YouTube's one-step play** still depends on the person picking *this* tab with "share tab audio" on in the
  browser's share dialog; a wrong pick leaves the sound on this device only (the UI offers to share again).
- **Bluetooth wobble** is measured relative to the room's average, so with few speakers it reads somewhat lower than
  the true jitter (about 75 % of it with 4 speakers, per `syncMeasure.test.ts`).
- **Home links are capabilities:** anyone with a home link can see and join its rooms; only the browser that created
  the home (it holds the owner key) can change them. Losing that browser's storage loses ownership.

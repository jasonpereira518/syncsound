# Limitations

An honest list of what is not done, what can't be verified without hardware, and what the platform constrains.

## Platform constraints (by design, not bugs)

- **Spotify / Apple Music are DRM-protected.** They run sync-only (seek-based) through the official Web Playback
  SDK / MusicKit JS, with no spatial rendering, no EQ and no sample-accurate scheduling. Expect tens of ms to
  ~150 ms. Every device needs its own Premium / Apple Music subscription.
- **Spotify: one stream per account, 5 accounts per app.** Spotify plays one account on one device at a time and
  forbids relaying one stream to several listeners, so every speaker signs in with its own Premium account; a
  speaker without one stays silent for Spotify songs (the banner says so). A development-mode Spotify app allows
  5 allow-listed accounts in total (host included); extended quota is only for registered businesses.
- **Spotify catalog limits (Web API, Feb 2026):** search returns 10 results per page; the songs of a playlist can be
  listed only when the account owns or collaborates on it (followed and editorial playlists show their name only);
  `/me` no longer says whether an account has Premium, so that shows up when the player refuses to start.
- **Spotify queue window:** Play / Shuffle put at most 200 songs into the room queue (the queue's size); a longer
  playlist starts with its first 200 (Shuffle draws them from up to 1000).
- **DRM video** (Netflix, Disney+, …) captures as silence. The app detects this after 3 s and explains it.
- **YouTube** streams are never downloaded. The video plays in its own tab with YouTube's official player and its
  sound reaches every device through tab capture (Mode 1): two steps (open the tab, then share it), because the
  browser needs one user gesture per step. The app's own tab can't be shared (it would capture its own output).
- **Sharing a window or the whole screen** (system audio) keeps the original playing on the sharing device, which
  the browser can't mute; the other speakers follow it by the stream buffer. Share the tab itself for tight sync.
- **A device whose output latency exceeds the stream buffer** (Bluetooth: 100–300 ms unreported) plays a live
  stream late by the difference; it shows the shortfall and the buffer value that would fit.
- **Secure context:** microphone (calibration), `getDisplayMedia` (capture) and Wake Lock need HTTPS. Phones on
  `http://<LAN-IP>` can play, but can't calibrate or capture. See DEPLOY.md.
- **iOS Safari** suspends audio in the background and some versions lack `outputLatency`. The app re-syncs and
  reschedules on `visibilitychange`, but background playback on iOS is not possible. A call, Siri or another app
  can also interrupt the page's audio; it resumes by itself when allowed, otherwise the room shows "Turn the sound
  back on" (iOS needs a tap). A tune stops with an explanation if a listening or recording device's screen locks.
- **iOS audio session while tuning:** the mic needs Safari's `play-and-record` session, which can route sound to the
  earpiece or make it quieter. Every mic close sets the session back to `playback`; behaviour varies by iOS
  version and is only checked on hardware (HUMAN_TEST_CHECKLIST item 23).
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
  has no labels either. The memory keeps the output's timing (`tuneId` + arrival) only: a level trim or EQ
  measured through a Bluetooth speaker is cleared when the route changes and is not restored with it.
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
- **A tune waits for the clocks to settle** (S2): started within ~30 s of joining it shows "Letting the clocks
  settle…" for up to 20 s (the audio clock's long-baseline rate needs 30 s of observations); on a bad network the
  hard criteria can hold it up to 30 s and then refuse ("The room clock hasn't settled yet"). A device that joined
  a minute earlier waits ~3 s.
- **A room without a LAN clock master is clock-limited** (every device on the server clock, e.g. client isolation
  on guest Wi-Fi): each device's WAN estimate moves by about a millisecond per minute at σ 5 ms jitter, so a tune
  holds p95 ≈ 1.9 ms there (`tuneClock.test.ts`), not < 1 ms.
- **A USB or external microphone on its own clock** (not the device's audio context) adds its own rate error to
  the recorder map; the sims model the built-in path only.

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
- **Spotify and Apple adapters** are verified only through contract tests against the mock adapter and the fixture
  catalog (`?mockRemote=1`). Real OAuth, token refresh, the Web API responses, Premium detection, iOS's "tap to
  start" and MusicKit authorization are untested, since no credentials are available here. The Spotify output
  compensation leaves out the browser-reported Web Audio latency (`REMOTE_AUTO_LATENCY`), because the SDK plays
  through its own media element; whether it should be included needs a real Bluetooth speaker.
- **Docker images** are built and smoke-tested locally (server health + demo assets, web 200). Fly.io/Railway/Vercel
  deploys are documented but not performed.

## Known gaps and simplifications

- **EQ convergence below 280 Hz:** the 200 Hz–8 kHz pairwise spread drops 41 % (spec target 40 %). Over
  275 Hz–8 kHz, where every device's EQ may act, it drops 83 %. Below 280 Hz the phone (300 Hz high-pass) may not
  be boosted by rule, so in the app that band goes through bass management to bass-capable devices instead.
- **Clock drift estimate under heavy jitter:** with σ ≥ 5 ms jitter and 1 Hz pings, drift is within ±5 ppm only
  after ~300 s (at 120 s: 5.0 ppm with σ 5 ms, up to 44.5 ppm with σ 30 ms). The offset error stays < 6 ms max
  regardless. Harsh-jitter alignment is 2.5 ms vs < 2 ms for normal Wi-Fi.
- **LAN clock master (R1)** is verified in simulation (`lanMaster.test.ts`, `lanFailover.test.ts`) and by unit
  tests, not yet on real hardware. If WebRTC can't connect between two devices (e.g. client isolation on guest
  Wi-Fi), they fall back to the server clock, which keeps the old ~1–2 ms device-to-device spread over a WAN; a
  dropped link is retried with backoff (1…30 s).
- **Background-tab throttling** is countered by running the sync loops on a Worker (S1), whose exemption from
  Chrome's intensive throttling is documented policy but verifiable only on hardware (HUMAN_TEST_CHECKLIST 24). The
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
  (jitterBufferDelay + RTT/2 + a fixed 20 ms Opus framing allowance), median-filtered over 2.5 s and applied only
  in ≥ 10 ms steps; its absolute accuracy (host encode latency, the receiver's WebRTC → Web Audio bridge) is
  unverified on real networks, so host-vs-receiver alignment of a live stream needs ears (HUMAN_TEST item 21).
  Headless e2e hears a steady tone and a stable delay, but can't hear WebRTC's own concealment on a lossy Wi-Fi.
  A receiver whose browser reports no `jitterBufferDelay` stats stays silent until it does.
- **Positions:** a full tune measures laptop-to-laptop distances (two-way ranging) and lays the room out from them,
  fitted onto the user's rough layout. Devices that don't record (no mic or permission) or play through Bluetooth
  keep their hand placement (flagged in the result). Multilateration of those, and a height axis, are not
  implemented.
- **Upmix** is a simple mid/side derivation (C = mid −3 dB, surrounds = filtered and delayed side), not a
  steering decoder.
- **Track end:** rendered tracks with a known duration auto-advance (gapless, or the room's crossfade). The next
  track's title and seek bar switch over when its SCHEDULE arrives, i.e. up to the room's lead (~0.3 s, up to ~2 s
  with Bluetooth) before it is heard. Spotify songs carry their length from the catalog and auto-advance too, always without a
  crossfade (Spotify audio may not overlap anything); the hand-over costs one play request on each speaker, so
  expect a short gap (the learned start lead and the next song riding along in the request keep it small). Apple
  Music songs have no known length: the SDK plays on and the host presses next. A track whose length nobody has decoded yet (a web link, until the first device
  decodes it) doesn't advance. During a crossfade the outgoing track is no longer drift-corrected (its rate stays at
  the last nudge, ≤ 0.2 %). Decoders that pad a gapless album's tracks differently (MP3 in particular) leave a few
  ms of overlap or gap at a gapless join; an overlap is cut over 15 ms, a gap can't be filled.
- **Single server process:** room state lives in memory, so run one instance. `room.ts` is transport-free to make
  a Durable Object port straightforward, but the port isn't done.
- **Device id lives in localStorage:** two tabs of the same browser profile share it and replace each other in the
  room. Use separate browser profiles/devices.
- **Spotify sign-in** is kept per browser in localStorage and refreshed with its refresh token (PKCE, no secret), so a
  speaker connects once; "Disconnect Spotify" removes it. iOS Safari needs a tap before Spotify plays after the
  page loads ("Start Spotify here"), and stops when the screen locks. Apple Music has no reliable
  missing-subscription check.
- **Profiles persist** (server `profiles.json`, keyed by the device id in localStorage): name, role, trim, latency,
  tune arrival + tune id, EQ bands, rolloff, bass capability. The raw impulse response is not stored; re-measure to
  see curves again. A profile written before S3 (a bare `calibratedLatencyMs`) is ignored for timing: the device
  joins untuned and one tap fixes it.
- **A speaker that physically moved needs a new tune.** The tune stores each device's arrival where it was; a
  drag of the picture keeps the sound aligned (that is what it is for), so a laptop carried 1 m across the room
  and dragged to match plays 2.9 ms off until the next tune (`tuneInvariant.test.ts`; a quick tune is one tap).
  No silent fix exists: nothing can tell a moved speaker from a corrected picture.
- **Unheard devices drop out of the tune.** Every run is a new reference, so a device the run did not hear (a
  phone whose output was muted, a tab on older code) is untuned afterwards rather than kept on its old value;
  the host is told ("1 needs tuning") and the device plays without compensation until the next tune. Bluetooth
  outputs included: a stale hint would hide the untuned state.
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
  heard"; reload them. Tabs from before S4 (no `micPermission` in their caps) are not waited for in the prepare
  phase: they open their mic when the plan arrives, so a room with one keeps the old 3.5 s start lead.
- **The microphone is asked for at join** (one prompt, inside the join tap; `?noMicProbe` turns it off). On iOS
  Safari a `getUserMedia` grant lives with the page's audio session: the probe is stopped at once, and whether
  that leaves playback and the later tune untouched on every iOS version is a hardware item (checklist 29). A
  device that denies the mic still plays; it is just never asked to record and is placed by hand.
- **Distances fix the shape of the room, not its mirror image.** The tune fits the measured distances onto the
  host's rough picture, so left and right can come out swapped when the picture had them swapped; "Adjust layout"
  (tap the spots again) fixes it, and the timing is unaffected either way (it is aligned at the head, not by name).
- **A tune started from the setup screen moves on to Now Playing by itself** when it finishes; its result lingers
  there for 20 s. A tune that fails stays on the setup screen with the error and a retry.
- **Room creation and uploads** are rate-limited per remote address in-process. Behind a proxy, use a trusted
  `X-Forwarded-For`.
- **This checkout's path contains `**`**, which breaks TypeScript's package-exports wildcard resolution (worked
  around with tsconfig `paths` for zustand) and makes Vite print a warning. Neither affects clones at normal paths.
- **Group play** only shares tracks every device decodes itself (demo, music/video files, links). Tab capture,
  YouTube and Spotify/Apple stream from one room, so they can't be played in several rooms at once.
- **Sharing a tab** depends on the person picking the right tab with "share tab audio" on in the browser's share
  dialog; a share without audio is refused with an explanation, and a wrong tab simply streams that tab.
- **Bluetooth wobble** is measured relative to the room's average, so with few speakers it reads somewhat lower than
  the true jitter (about 75 % of it with 4 speakers, per `syncMeasure.test.ts`).
- **Home links are capabilities:** anyone with a home link can see and join its rooms; only the browser that created
  the home (it holds the owner key) can change them. Losing that browser's storage loses ownership.

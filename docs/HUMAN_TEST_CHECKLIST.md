# Human test checklist

These steps need real devices, ears, Bluetooth hardware or real streaming accounts. The automated suite covers
everything else. Run over **HTTPS**, or mic/capture won't work. Deploy, or use a tunnel such as
`cloudflared tunnel --url http://localhost:3000` plus `NEXT_PUBLIC_SERVER_URL` pointing at a tunnelled server.

Record results in the table at the bottom.

1. **Same-Wi-Fi sync, 3 devices.** Two phones and a laptop join one room. Play *Click track 120 BPM*. Expect one
   fused click, no flamming, and all three rows green in the device list. Then open the debug drawer on each
   device: offset jitter under 2 ms, sync error under 5 ms. Leave it running 10 min and confirm the corrections
   counter shows rate nudges, not repeated reschedules.
2. **Sync-measurement tool.** After step 1, put a fourth phone at the listening position and run
   *Calibrate → Measure sync → 60 s*. Record the p50/p95 inter-device error and the histogram.
   Target: p95 < 10 ms.
3. **Bluetooth speaker latency.** Pair a Bluetooth speaker to one laptop and join. Play the click track: the
   Bluetooth device should lag audibly (100–300 ms). Run *Calibrate* from a phone at the listening position. The
   Bluetooth device should get a large `calibrated` badge, the clicks should fuse again, and Measure sync should
   report < 10 ms for it.
4. **Manual fine-tune by ear.** Turn on the click test, nudge one device's manual latency ±20 ms and hear the
   flam; return it to 0 and hear the clicks fuse.
5. **Chirp-ID mapping.** During calibration each speaker chirps in turn. Use "Identify" on each row and confirm
   the right physical device beeps and its icon flashes. Mute one device and recalibrate: it must be reported as
   not heard, with the warning shown.
6. **EQ A/B listening test.** After calibration, play *Synth groove* and toggle *EQ A/B (bypass)*. With EQ, the
   phone and the laptop should sound closer in tone. With EQ there must be no distortion or clipping on the
   phone (limiter plus high-pass active).
7. **Spatial panning, no clicks.** Place devices with the *Stereo pair* preset and play *Stereo ping-pong*. Drag
   the L object across the room slowly and quickly. The sound should move between the physical devices with no
   zipper noise or clicks. Then try *5.1 ring* with *5.1 channel test*; each channel should come from the
   expected device, and LFE only from bass-capable devices.
8. **Tab-capture lip-sync with a YouTube video.** On the host laptop (Chrome), open YouTube in the app's YouTube
   tab and start Capture (share this tab with audio). Every device should play the audio. Use the lip-sync nudge
   to get perceived lip-sync within ±40 ms, and note the buffer value that gives dropout-free audio.
9. **DRM detection.** Capture a Netflix/Disney+ tab. The "This tab is silent / DRM" explanation should appear
   within ~3 s.
10. **Spotify sync-only, two Premium accounts.** Configure `NEXT_PUBLIC_SPOTIFY_CLIENT_ID`, connect Spotify on
    two devices, queue a track and play. Both should play in sync within the reported error (expect 20–150 ms).
    The "Sync-only mode (no spatial/EQ)" badge must show; seek and pause must follow. Also try a free account:
    it should show `needs-premium`.
11. **Apple Music.** Configure `NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN`, authorize on two devices with
    subscriptions, queue a song id and play. Check sync, pause and seek, and that the error appears in the UI.
12. **iOS Safari background behavior.** Join from an iPhone, play, then lock the screen or switch apps (audio
    stops; expected iOS behavior). Return to the tab: it must resume on the room timeline within a few seconds,
    in sync, without a manual reload. Check that Wake Lock keeps the screen on while foregrounded.
13. **Route change prompt.** Plug headphones or connect Bluetooth mid-session. The "recalibrate" banner should
    appear.
    - **Per-output memory (desktop Chrome, mic permission granted):** calibrate with a Bluetooth speaker
      connected, disconnect it (banner + calibrated offset cleared), reconnect it: the blue "using its saved
      calibration" banner should show the same offset and the clicks should fuse without recalibrating.
    - **Bluetooth listener:** start *Calibrate* on a device that plays through Bluetooth. It should record with
      the built-in mic (or refuse if only a Bluetooth mic exists), and the result should warn that its own
      speaker wasn't measured.
    - **Lead time:** with a calibrated Bluetooth device in the room, press play/seek repeatedly. The Bluetooth
      device must not skip the first ~100–300 ms of audio (devtools: `__syncsound.schedules` has no `late: true`).
    - **Stability:** leave a calibrated Bluetooth speaker playing 30 min (Android SBC/AAC/aptX, iPhone AAC,
      macOS, Windows), run *Measure sync* at 0 / 15 / 30 min and after pausing 5 min. Record how far it moves.
14. **Install as PWA** on Android Chrome and iOS Safari (Add to Home Screen). It should launch standalone and
    join a room.
15. **LAN clock master (R1).** Join 3+ devices on the same Wi-Fi with the host on a laptop. Open the debug
    drawer on a phone: the clock RTT should drop to a few ms (LAN) within ~2 s of joining. Run the 60 s sync
    measurement from the seat. Target: wired/built-in spread p95 < 1 ms. Then repeat on a guest network with
    client isolation, where it should fall back to the server clock without errors.
16. **Simple setup on real devices (R5).** On a phone, tap "Set up my home", open the Living room, and scan the QR
    with 3 other devices. In step 2 the suggested layout should match the speaker count. Tap a spot to move a speaker,
    and that device's screen should show its new spot name at once. Tune from the seat: every speaker should be listed
    as "in sync, level matched", or as needing its volume turned up. Close everything and reopen the home link: the
    room should open straight to Now Playing with the same layout.
17. **Gap pass (real devices).**
    - **YouTube:** paste a link and tap "Play on all speakers", pick this tab with tab audio on, and every speaker
      should play it.
    - **Bluetooth:** with a Bluetooth speaker in the room, finish tuning; it should show "Bluetooth timing varies by
      ±X ms".
    - **Re-sync banner:** switch a phone's output to Bluetooth mid-song; the "audio delay changed" banner should
      appear.
    - **Group play:** in a home with two rooms, "Play here and in 1 more" should start both rooms together. Listen in
      the doorway.

| # | Date | Devices / browsers | Result / numbers | Notes |
|---|------|--------------------|------------------|-------|
|   |      |                    |                  |       |

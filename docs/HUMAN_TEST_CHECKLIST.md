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
8. **Tab-capture lip-sync with a YouTube video.** On the host laptop (Chrome), open a YouTube video in its own tab,
   then in the app's YouTube panel start capture and pick that tab (share tab audio on). Every device, the laptop
   included, should play the audio. Use the lip-sync nudge to get perceived lip-sync within ±40 ms, and note the
   buffer value that gives dropout-free audio.
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
    - **YouTube:** paste a link, tap "Open on YouTube", start the video there, come back and tap "Start capture",
      pick the YouTube tab with tab audio on, and every speaker should play it.
    - **Bluetooth:** with a Bluetooth speaker in the room, finish tuning; it should show "Bluetooth timing varies by
      ±X ms".
    - **Re-sync banner:** switch a phone's output to Bluetooth mid-song; the "audio delay changed" banner should
      appear.
    - **Group play:** in a home with two rooms, "Play here and in 1 more" should start both rooms together. Listen in
      the doorway.

| # | Date | Devices / browsers | Result / numbers | Notes |
|---|------|--------------------|------------------|-------|
|   |      |                    |                  |       |

**Calibration on real hardware (laptop Chrome as listener + phone):** run *Calibrate*. If it fails, note the message
(it now says silent mic / too weak / noisy, with mic peak dBFS, best SNR and offset), click *Save microphone recording
(.wav)* and drop the file in `packages/sim` to replay through `analyzeCalibration`. Check the DevTools console for
`[calibration] preflight` (own-speaker self-test) and the per-device table.

18. **Calibration v3: one-tap tune (laptops).** Three or more laptops in one room on the same Wi-Fi, Chrome; one
    of them playing through a Bluetooth speaker.
    - On the laptop you'll sit at, press **Start tuning** (setup wizard; or Advanced → Calibrate → Start). Every laptop should ask once for its microphone and show
      "Tuning: <name> is playing" while each one chimes in turn (~1.5 s each). Each device makes **one** sound (a
      rising swoosh landing on a bell) and nothing plays after the last one (no click run, even with Bluetooth).
    - The result should list every laptop with a distance; tape-measure them: **within 10–15 cm**. The Bluetooth
      speaker should say "placed by hand"; drag it to where it really is.
    - Sit with your head ~40 cm behind the tuning laptop and run **Measure sync (60 s)**: **p95 < 1 ms**.
    - Run Measure sync once more from a *muted, non-speaker* phone or laptop at your seat: still p95 < 1 ms (proves
      that opening every laptop's mic during the tune didn't shift any output).
    - Move the listener elsewhere and repeat Measure sync: the per-device spread should stay small (the estimator's own
      bias doesn't cancel away from the tune spot).
    - Turn the Bluetooth speaker off and on: the "audio delay changed" banner should appear; **Re-sync speakers** (quick tune) should
      restore p95 < 1 ms without asking the other laptops for their microphones.
    - Close the LAN clock master's tab (the host) mid-song: the banner should appear on the others (clock path
      changed); a quick tune restores sync.

19. **Tune: does it sound good, and are levels even?** Same room as 18.
    - Ask 2–3 people whether the chime sounds pleasant at normal volume; listen for buzz or rattle on laptop
      speakers during the swoosh. Note any device that sounds harsh.
    - After the tune, solo each device in turn on the demo "Synth groove" loop and read a phone SPL app (C or Z
      weighting, slow) at the seat: **every device within ±2 dB**, the tuning laptop included (if it is off, note by how much: that is
      the near-field prior error, LIMITATIONS).
    - Play a loud track: the boosted devices (positive trim in Advanced → Calibrate) shouldn't audibly pump or
      distort.
    - The Bluetooth "timing varies by ±X ms" line should appear only after **Measure sync**, not after the tune.

20. **Auto-advance: gapless and crossfade.** Queue two demo tracks (better: upload two tracks of a gapless album) and
    play the first to its end. With *Crossfade* at *Gapless* (Library → below the queue, host only) the second should
    start on every device the instant the first ends: no gap, no double audio, no click; the title switches shortly
    before the sound does. Set *Crossfade* to 4 s and repeat: the tracks should overlap for ~4 s at an even loudness
    (no dip in the middle), starting at the same instant on every device. Paste a web link with no known length as
    the first track: it should still advance once a device has decoded it. Pause during a crossfade: both tracks must
    stop. Let the last track run out: the player should read *stopped*, not keep "playing" at the end.

21. **Live share quality (capture rework).** Laptop host (Chrome) + two phones on the same Wi-Fi.
    - **YouTube tab shared** to the phones: no echo or "wash", no periodic pitch wobble over 5 minutes, and the laptop
      plays in time with the phones. Debug drawer on a phone: "align delay" switches stay ≤ 2 after the first minute.
    - **Move the Stream buffer slider** while sharing: one brief dip on each device, no pitch bend, no click.
    - **Entire screen + system audio** (a desktop player): no echo loop on the phones; the laptop plays the original
      and the panel says so.
    - **Bluetooth phone** receiving at 150 ms: the "plays N ms late" warning appears; set the buffer to the suggested
      value and it disappears, and the phone falls into line with the others.

22. **Speaker spots + 8D.** 4–5 phones/laptops around one chair, any stereo music file.
    - Pick **5.1** on the Stage. Every speaker plays: the centre and both surrounds must not be silent.
    - Change a speaker's spot from the Devices list (e.g. Front left → Surround right): it moves on the map, and the
      speaker that held that spot takes the old one. Nothing goes quiet.
    - Join one more phone: within a second it gets a spot (shown in its own screen) and plays.
    - Drag the *Left* sound to a surround speaker on the map: it should now clearly come from that speaker alone.
    - Turn on **8D → Medium**: the music should audibly circle you about once every 8 s, speaker to speaker, with every
      device in step (no speaker lagging the sweep). Try Slow / Fast, then Off.
    - Pick **Everywhere**: every speaker plays the full mix; with 8D on, the mix circles the room through all of them.

23. **Phone as the listener + iOS audio (Phase 2).** An iPhone (Safari) and an Android phone, plus 2–3 other speakers.
    - Tune from the iPhone held at your head: the wizard says to hold it at ear height. The result should place the
      seat on the phone, and timing at your head should sound tight (Measure sync from the same spot: p95 < 1 ms).
    - Afterwards the iPhone is muted as a speaker with a note; unmuting it in Devices works.
    - After the tune, music on the iPhone must be at normal loudspeaker volume (not quiet, not on the earpiece).
    - Lock the iPhone mid-tune: the tune stops with "screen locked or you switched apps". Lock a *recording* phone
      mid-tune: the tune still finishes, without that phone's distances.
    - Play music, then take a call / trigger Siri on a speaker iPhone. When it ends, sound returns by itself or the
      "Turn the sound back on" banner appears and one tap brings it back in sync.

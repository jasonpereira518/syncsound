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
10. **Spotify, three Premium accounts (Spotify pass).** Set up the app per DEPLOY.md (all three accounts
    allow-listed). Host on a laptop, speakers on an Android phone and an iPhone.
    - Connect once on each device. Reload the page: it reconnects without the popup. Leave it over an hour: it
      keeps playing (token refresh).
    - Guest in a host-only room: the "This song plays from Spotify" banner's Connect works. On the iPhone, "Start
      Spotify here" appears and starts it.
    - Host: search, open one of your playlists, Liked Songs and an album; Play, Shuffle, Play next, Add. A followed
      playlist you don't own explains why its songs can't be listed.
    - Let a playlist run across 3 song boundaries with the room crossfade at 6 s: no overlap, a short gap at most,
      every speaker on the same song. Seek and pause follow. Run *Measure sync* during a song (expect 20–150 ms).
    - One speaker on a Bluetooth speaker after tuning: compare by ear with and without `REMOTE_AUTO_LATENCY`.
    - The same account on two devices: "This Spotify account is playing on another device", no tug of war.
    - An account not on the allow-list: the allow-list message. A free account: `needs-premium`.
    - The "Sync-only mode (no spatial/EQ)" badge and the cover art show on every device, phones included.
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
16. **Simple setup on real devices (R5, S4).** On a laptop, tap "Set up my home": it should land straight in the
    Living room's join page; tap "Open my room" (the mic prompt comes with it) and scan the QR with 3 other devices
    (one tap each; each asks for its mic once, right there). The setup screen should list every speaker with "Mic
    ready" and the suggested layout for the count. Tap **Tune the room** (the third tap): the layout is applied, every
    speaker gets a spot, and when the tune ends the screen moves on to Now Playing by itself with "Tuned · 4
    speakers" (or "3 of 4 speakers tuned" and who is missing). Open "Adjust layout", tap a spot to move a speaker,
    and that device's screen should show its new spot name at once. Close everything and tap "Open my home" on the
    landing page: it should open the room, straight to Now Playing with the same layout and tune state.
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

**Calibration on real hardware (laptop Chrome as listener + phone):** run *Tune*. If it fails, note the message
(it says silent mic / too weak / noisy, with mic peak dBFS, best SNR and offset), click *Save microphone recording
(.wav)* (Advanced → Calibrate) and drop the file in `packages/sim` to replay through `analyzeRecording`. Check the
DevTools console for the per-device row table (`console.table`).

18. **Calibration v3: one-tap tune (laptops).** Three or more laptops in one room on the same Wi-Fi, Chrome; one
    of them playing through a Bluetooth speaker.
    - On the laptop you'll sit at, press **Tune the room** (setup screen; or Now Playing → Tune; or Advanced →
      Calibrate → Tune). No laptop should ask for its microphone now (each did at join); the listener should read
      "Waiting for <name>'s microphone…" for a second or two at most, then every laptop shows "Tuning: <name> is
      playing" while each one chimes in turn (~1.5 s each). Each device makes **one** sound (a rising swoosh landing
      on a bell) and nothing plays after the last one (no click run, even with Bluetooth).
    - The result should list every laptop with a distance; tape-measure them: **within 10–15 cm**. The Bluetooth
      speaker should say "placed by hand"; drag it to where it really is.
    - Sit with your head ~40 cm behind the tuning laptop and run **Measure sync (60 s)**: **p95 < 1 ms**.
    - Run Measure sync once more from a *muted, non-speaker* phone or laptop at your seat: still p95 < 1 ms (proves
      that opening every laptop's mic during the tune didn't shift any output).
    - Move the listener elsewhere and repeat Measure sync: the per-device spread should stay small (the estimator's own
      bias doesn't cancel away from the tune spot).
    - Turn the Bluetooth speaker off and on: the "audio delay changed" banner should appear on that laptop and the
      host's Now Playing should read "<name> needs tuning again"; **Tune** there (a timing-only run) should restore
      p95 < 1 ms without the other laptops recording.
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
24. **Hidden tab while paused (S1).** Chrome desktop and Android Chrome: pause the room, switch the tab to the
    background (or another app) for 6+ minutes, come back and press play within a second. Nothing should skip, no
    device should start late (`__syncsound.schedules` has no `late: true`), and the debug drawer's **tick gap** should
    read ≤ 1.5 s (the Worker ticker kept the loops running). Repeat with `?noTicker` on the room URL (the
    `setInterval` fallback) and note the tick gap and how long the resume burst takes.
25. **iOS background while playing (S1).** Play, switch apps for 5 minutes, return to Safari. Expect ≤ 1.5 s of
    silence, then playback in sync with the others — never a stretch of stale (minutes-old) audio. The reschedule
    counter should rise by at most one.
26. **LAN clock master leaves mid-song (S1).** Close the master's tab (the host's). On the others expect at most a
    few ms of wobble within ~3 s and no reschedule counter increment; within ~25 s the debug drawer's clock RTT
    should drop back to LAN values (a new master).
27. **Tune right after joining (S2).** On real Wi-Fi, tap Tune within 10 s of opening the room: expect "Letting the
    clocks settle…" for up to ~20 s, then the run. Measure sync afterwards: p95 < 1 ms. Then, with two laptops, tap
    Tune on both at once: the second gets "Another device is tuning the room right now". Cancel a tune halfway: the
    other devices' chimes stop at once. Switch a phone's output to Bluetooth *during* a tune: it should be reported
    as not timed ("wasn't timed: the audio output changed during the run"), and the run should otherwise complete.
28. **The tune survives the picture, not a move (S3).** After a full tune with Measure sync p95 < 1 ms:
    - Drag a laptop 1 m on the stage *without moving it*, then change the layout (stereo → quad and back): Measure
      sync should stay < 1 ms p95 and the Advanced badge should keep reading "tuned X ms" (the value changes with the
      drag, the sync does not).
    - Carry that laptop 1 m and drag it to match: expect ~3 ms of error in Measure sync; a quick tune restores < 1 ms.
    - Let a phone join after the tune: the host's Now Playing reads "N speakers, 1 needs tuning", the phone's screen
      "Not tuned yet", and in a stereo/quad room the phone gets a free slot without anyone else moving on the stage.
    - Toggle a Bluetooth speaker off and on: the host sees "needs tuning again (output changed)" on that device
      within a few seconds; a quick tune from the guest's screen shows its progress and result on that screen.
    - Reload the host: the room still reads "Tuned" for the host laptop (profile + room tune reference).
29. **Mic at join (S4).** iOS Safari and Android Chrome, each as a guest: the mic prompt should come with the join
    tap, audio should still play afterwards (the probe is stopped at once), and no "audio delay changed" banner
    should appear in the first seconds. During a tune from the host, no second prompt. Lock one phone before the
    host taps Tune: the host should read "Waiting for <that phone>'s microphone…" for up to 8 s, then the run
    should go on without it and name it as skipped; the other devices' rows should be unaffected (Measure sync
    p95 < 1 ms among them). Deny the mic on one phone: its row should read "mic not allowed", it should still play,
    and the tune should not wait for it. Note the time from tapping Tune to the first chime (target ≤ 4 s with
    every mic granted).

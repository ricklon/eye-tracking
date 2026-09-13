# Eye Play kiosk prototype

Run from the project directory in a desktop session:

```bash
uv sync
uv run eye-tracking download-model
uv run eye-tracking kiosk
```

Use `--camera N` for another webcam, `--windowed` during development, and
`--max-seconds 10` for a bounded display check. `just kiosk` is a shortcut.
Press **R** to toggle live/echo, **F** to toggle fullscreen, **Tab** for staff diagnostics, or **Q/Esc**
to exit. Closing the window also exits. These are development controls, not an
OS-level public-access lock. Use `--diagnostics` to start with live per-eye gap, blink score, closure state,
and reopening-frame count visible. These values are live even when the eyes echo.
Kiosk mode records neither images nor measurements.
The existing `run --output PATH` command remains the raw measurement recorder.

## Visitor experience

- Idle eyes glance around and blink, inviting a visitor to step in front.
- A face near the center acquires attention, followed by a short greeting.
- After 1.6 seconds, sufficiently detailed eyes drive shared gaze and four
  separate illustrated lid positions. Prompts rotate through looking, winking,
  and blinking.
- Smaller/asymmetric eye images fall back to following face position with a
  positioning cue. Eye width must be at least 22 pixels in the actual capture;
  the smaller/larger eye-width ratio must exceed 0.65. These are prototype
  heuristics, not validated confidence or head-pose estimates.
- Brief face loss holds gaze and lid positions. After 1.5 seconds the kiosk
  says goodbye; after 3 seconds it returns to idle.
- Camera errors show a friendly break screen and retry after two seconds.
  Frames older than 0.75 seconds are rejected. Capture and inference run in a
  background thread so the display remains responsive.

## Live camera and image checks

A mirrored live camera inset shows the full camera view, with an outline around
the selected participant. It remains live while the illustrated eyes echo. The
inset preserves aspect ratio and is removed when the camera frame becomes stale;
no images are saved. Annotations and mirroring never modify inference input or
exported measurement coordinates.

The camera worker checks grayscale median brightness, 95th-minus-5th-percentile
contrast, and the fraction of nearly white pixels. It uses the selected face's
clipped landmark bounding box when available, otherwise the whole image. The
prototype cues flag median below 45/255, more than 20% of pixels at 250/255 or
above, or contrast below 18/255. Other cues request a centered face or a closer,
frontal view. These thresholds need exhibit testing across skin tones, cameras,
and lighting; they do not certify usable eye tracking, detect every reflection,
or measure blur. They are advisory and do not gate lid detection or recording.

## Eye echo and complete closure

Eye copying defaults to a visibly labeled 1.2-second echo so a visitor can look
away or blink, then look back and see that movement. Only animation poses are
buffered in memory, never images. Arrival, departure, and fault responses remain
live. Gaze-detail fallback and brief face loss preserve the echo buffer; departure,
a camera fault, or a participant change clears it. Eyelid detection continues
when gaze detail is insufficient, so a wink cannot bypass closure detection by
triggering the gaze-quality gate. Use
`--replay-delay 0` for live copying or `--replay-delay N` for 0..3 seconds.
**R** toggles between live and echo during a session.

An aperture at most 0.04 eye widths closes that illustrated eye completely.
A blink score of at least 0.55 also closes it if its own aperture is at most 0.10.
A clearly open aperture (at least 0.12) can provide reopening evidence regardless
of blink score; otherwise reopening evidence requires aperture at least 0.065
and score at most 0.35 (if available). Reopening requires at least three fresh
camera samples spanning 120 ms, or 250 ms when the blink score disagrees.
Ambiguous/closed samples or gaps over 200 ms reset that confirmation. Display
redraws of the same packet do not count. Missing eyes and brief tracking loss hold the current lids rather than reopening
them. Insufficient gaze detail does not disable per-eye lid processing. Departure
and camera-fault behavior still reset the display. High blink scores alone
cannot close a geometrically open eye. These differing thresholds avoid flickering near
closure. Closure bypasses smoothing; near-closed rendering draws only a lid seam,
with no iris pixels. Raw measurements and their gaze-validity rules are unchanged.
These are display heuristics and still need testing with different visitors.

## Architecture and conventions

`kiosk.py` contains the participant selector and pure animation controller.
`kiosk_app.py` owns the camera worker, OpenCV renderer, and desktop event loop.
No network or hardware actuation is implemented.

The tracker asks MediaPipe for up to three faces. Selection favors a central
face, then the nearest face to the previous position within a normalized-image
radius of 0.18. The lock expires after 1.5 seconds without a match. This is
spatial association, not identity tracking: crossings, nearby faces, and crowds
can still cause switches. Multi-face mode does not use MediaPipe's single-face
smoothing; the animation controller provides time-based smoothing and a gaze
speed limit of three normalized units per second.

Raw schema-v1 measurements are unchanged. `Pose` is an internal display contract:
shared gaze x/y in -1..1 (right/down) and four lid openings in 0..1. Anatomical
side labels remain intact. The illustration deliberately uses a mirror-like
layout, with anatomical left on screen left, and explicitly negates iris x.
A future robot adapter must choose its own side/axis mapping and calibration.

The display averages valid eye gaze, holding the last valid target when both
are invalid during closure. It maps signed lid offsets independently using a
provisional 0.12-eye-width open reference. Expression scores only assist closure
when corroborated by that eye's aperture; they do not cap the other lid openings. These defaults are not personal calibration or physical angles.
If detail is insufficient, the controller uses face position instead.

## Qualification before public deployment

Test live with children, adults, seated visitors, glasses, different eye shapes,
head turns, different lighting, entry/exit, two people crossing, and camera
unplug/replug. Measure end-to-end response time on the intended kiosk computer.
Tune distance, camera placement, thresholds, neutral gaze, and lid mapping using
those observations. Synthetic tests do not establish public tracking accuracy.

A driver that blocks forever inside camera capture can leave the worker stuck;
the display will report a break, but recovery then needs application restart.
A production deployment should use a supervised capture process and application
restart policy, desktop autostart, disabled screen blanking, restricted staff
controls, and installation-specific accessibility testing. These system changes
are not installed by this prototype.

For eyemech, add a normalized live-pose endpoint, bounded local interpolation,
latest-command replacement, command timeout, and animation ownership. Preserve
the release latch. Shared gaze and paired-lid animation are existing firmware
constraints; four independent lid targets need an interface extension and
physical travel/collision validation. See [eyemech.md](eyemech.md).

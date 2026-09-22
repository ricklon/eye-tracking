# Browser eye studio

Run `uv run eye-tracking web` (or `just web`) and open
<http://127.0.0.1:8080>. Press **Start camera** and allow browser camera access.
Use **Stop** before selecting a different camera. **Visitor view** hides the staff
panels; **Fullscreen** uses the browser fullscreen API. The idle eyes work before
camera access or model loading.

## Architecture

This first increment borrows smartcar4activities' dashboard organization and
separates control from measurement in preparation for hardware and MCP adapters.
MediaPipe runs on the device opening the page, rather than on the Python host.

```text
Browser camera → MediaPipe worker → raw measurement packet
                                      ├→ per-eye readings / JSONL download
                                      └→ display controller → canvas eyes
```

- `src/eye_tracking/web.py` serves only the packaged static asset directory using
  Python's development HTTP server. There is no application backend or hardware API.
- `static/tracker.worker.mjs` owns MediaPipe Tasks Face Landmarker in VIDEO mode,
  with one face, blendshapes, and the face transformation matrix. It uses a classic
  worker because the pinned runtime loads WASM glue through `importScripts`.
- `static/measurements.mjs` implements the existing Python schema v1 geometry.
  Cross-language tests check roll/scale, anatomical sides, closure, and matrix layout.
- `static/controller.mjs` owns gaze smoothing, blink latches, greeting, face loss,
  and bounded echo history. Like the Python kiosk, it falls back to following face
  position when eye spans are too small or asymmetric. These are display decisions,
  separate from raw data.
- Animated gaze adds head turn to eye movement. Iris offsets are measured inside the
  eye opening, so turning the head while watching the screen barely changes them.
  `headTurn()` takes the canonical face's forward axis from `face_transform`
  (column 2: x toward image right, y up) and adds `-sin(angle) × headGain` to the
  mirrored pose (**Head turn follow** slider, default 2, 0 disables). Head turn still
  steers while gaze is invalid, for example during a blink. The yaw sign was checked
  against MediaPipe output on an original and mirrored portrait; pitch follows the
  documented y-up camera space and has not been checked on a live face. The camera
  overlay shows the estimated turn.
- `static/app.mjs` owns browser capture, controls, canvas rendering, and recording.
  At most one camera frame is in flight. Slow inference drops opportunities to
  capture instead of building a queue; rendering continues independently.

No Node build or web framework is required to run the application. Node.js is
required for development tests. The HTML, CSS, and ES modules can also be deployed
as a static HTTPS site. Static assets are included in the Python package.

## Camera and runtime

The runtime is pinned to `@mediapipe/tasks-vision@1.0.1`, and the model uses Google's
`face_landmarker/float16/1` bundle. Runtime and WASM come from jsDelivr; the model
comes from Google Cloud Storage. These are downloads only; this application does
not upload frames or measurements. Offline startup is not guaranteed by browser
caching. Vendoring those assets is a future deployment step.

Camera access requires a secure context: localhost works for development; a phone
opening the host's LAN IP needs HTTPS. `--host 0.0.0.0` changes the bind address but
does not provide HTTPS. The bundled HTTP server is for local development, not public
hosting. A modern browser with workers, WebAssembly, OffscreenCanvas,
`createImageBitmap`, and camera access is needed. Chrome was exercised with a
synthetic camera; other browsers and physical cameras require qualification.

Stop releases camera tracks and terminates the worker. A hidden tab also stops
capture. Camera removal, worker failure, and model load failure show a retry message;
press Start to reconnect. Measurements become unavailable after 750 ms without a
fresh result. After five seconds without results, capture stops. No stale raw eye
values are presented as current measurements.

The browser currently tracks a single face. It does not implement the Python
kiosk's multi-face participant selector and does not recognize identity. Use one
participant at a time. Display lid/gaze gains remain heuristic rather than personal
calibration. The browser and Python display controllers are separate implementations;
the shared compatibility guarantee is the tested measurement contract.

### Frame rate

The camera is asked for 640×480 at 30 fps. Under the camera controls the dashboard
shows the delivered camera rate, the tracked rate, and the time tracking takes per
frame. Blinks last 100–300 ms, so below about 20 fps they land on one frame or none.
A camera steady at 7.5 or 15 fps is usually dimming for low light; front lighting
fixes it. If tracking time is high and the tracked rate trails the camera, the
computer is the limit. **Tracking on** selects the MediaPipe delegate: CPU (the
default) or GPU (WebGL2 in the worker, falling back to CPU if it cannot start).
Measured on an Intel UHD (Comet Lake) laptop over three runs, camera frames took
28-34 ms on the CPU and 34-45 ms on the GPU, and the GPU path also competes with the page's own drawing;
a machine with a separate graphics card may prefer GPU. The same tracker needs
about half that on a still photo, so camera frames are the expensive input. The worker
hands MediaPipe the camera's `VideoFrame` directly, saving a copy; over three runs
that measured the same as converting to an `ImageBitmap` first, within run-to-run
noise, and the conversion itself takes under a millisecond. A browser that refuses
a `VideoFrame` falls back to bitmaps, which are made anyway while the exploration
view needs the image. The rate line names the delegate in use and splits tracking time from all per-frame worker
work. In Chrome and Edge the worker reads the camera itself: the page hands it a
clone of the camera track through a `MediaStreamTrackProcessor`, so frames skip
the page's copy, the screen-refresh wait and a postMessage each, and a slow frame
drops stale ones instead of queueing them. The rate line says "direct feed". Other
browsers, or a feed that fails, fall back to "page copy": the page grabs frames
from the video element with up to two in flight, so the tracker starts the next
frame as soon as it finishes one, and the iris color estimate (a full-frame pixel readback)
runs about twice a second rather than every frame. The worker sends the full camera
frame to the page only while the exploration view is open, which is the only thing
that draws it, and the camera's landmark overlay redraws only when new landmarks
arrive rather than every animation frame.

## Blinks, winks and squints

`LidLatch` reads one eye, `LidPair` the two together (`controller.mjs`). Everything
is relative to that eye: its open aperture, seeded from the first frames and then
rising fast and forgotten over ~15 s, and its resting blink score. Fixed thresholds
cannot work — on the recording in `tests/data-eye-sequence.jsonl` both eyes held shut
read 0.26 of open on the left and 0.46 on the right, and a blink score can rest high
on a face that is wide awake. Closure is the larger of the gap and the blink-score
rise, except when the lids are plainly apart, where the gap wins so a high resting
score cannot hold an eye shut.

Level alone cannot separate a blink from a squint: in that recording the squint
reached the same depth. Speed can, so a fall of 0.2 of closure within 100 ms latches
the lid shut, as does a closure past 0.85 however slowly it arrives. A latch that is
still only partly shut 400 ms later — a blink's lifetime — is a squint: it reopens and
stays open until the eye opens properly. Blinks and winks fell 0.21..0.42 per 100 ms
there, a squint 0.18..0.22 and open eyes 0.04, so the bands touch and the 400 ms rule
settles the rest.

A wink is only visible by comparison, because MediaPipe leaks some of it into the
other eye. The two eyes also rarely fall at the same speed, so when one latches and
the other is already past 0.45 of closure the second is latched with it: a held-out
recording had a blink where both eyes reached 0.77 and 0.71, and without this the
marginally faster eye alone read as a wink. An eye that trails its partner by 0.1 of
closure while below 0.6 is held open — unless its own closure has been confirmed deep, since both eyes shut can still
measure far apart. Winks toward one side can be much weaker than the other, and this
face's blinks are not symmetric either: in the labelled recording the right winks left
the other eye untouched, and in a held-out one two soft blinks still read as left
winks, the left eye reaching 0.45 of closure against the right's 0.29.

**Glasses change what can be measured.** The same face and sequence recorded with and
without glasses: a blink reads 0.71 of the open gap through glasses and 0.19..0.35
without, and a wink 0.63 against 0.01. The frames sit over the lid landmarks and hold
them apart, so winks and blinks read as shallow, partial movements. That is why each
eye's SHUT end is learned from closures it has actually shown rather than assumed: a
fixed scale tuned for glasses makes a half-closed partner read as fully shut without
them, turning every wink into a blink.

`tests/lids.test.mjs` replays both recordings (open eyes, blinks, winks each
way, a held squint, a held closure) and is the check that these keep working. They hold
measurements only; no images were recorded. In the no-glasses take both eyes close
briefly at the start of a wink, so what marks the wink there is the eye that stays
shut, not the one that closes.

## Measurements and recording

### Explore tracking: the wink lab

Choose **Explore tracking** to see the path from a face landmark map to eye-corner,
iris, and separate upper/lower lid measurements. The face box tracks image position;
the line between the outer eye corners illustrates image tilt, not physical head
angles. Toggle face and eye guides independently. Both magnified eyes keep
anatomical labels and the same mirrored presentation as the full image.

The worker transfers the measured image and landmarks separately from the raw
schema-v1 packet. Inspection overlays and eye crops use that exact image rather
than the newer live camera preview. Only the latest inspection image is retained;
it is released on replacement or camera stop. The map, eye status, and challenges
are always live, independent of the playful animation's echo and smoothing.

Per-eye status uses the same closure/reopening latch as the animation, starting
immediately rather than waiting for its greeting. The latch (`LidLatch` in
`controller.mjs`) blends two signals into one smoothed 0..1 openness value: the lid
gap, scaled by a learned per-eye open gap, and the blink score. A lid gap below 15%
of the open gap counts as closed regardless of blink score, and a wide gap can reopen
an eye whose blink score stays high. Closing is immediate; reopening needs three
samples over 120 ms at openness 0.6 or more, so single noisy frames cannot flick a
held wink open. The animated lids ease toward `openness ** gain` (the **Lid
exaggeration** slider, default 1.6) and close faster than they open. **Show face
tracking on camera** overlays landmarks, lid lines, and per-eye openness on the
camera preview; they come from the latest measured frame and can trail the video.
A high blink score with a clearly open gap is shown as **Uncertain**. Missing eyes and stale frames are **Unavailable**,
not open. Gaze validity and sufficient eye detail are reported separately. Open/closed
states are heuristic interpretations, not verified physical measurements.

Five challenges cover a slow blink, left/right winks, and looking left/right.
Each begins with at least four distinct open-eye samples spanning 400 ms. Blink and
wink challenges require closure followed by reopening; a wink also requires the
other eye to remain open. Gaze challenges compare each eye's horizontal iris offset
with its starting value, require a shift of more than 0.04 eye widths for at least
three samples over 200 ms, and reject insufficient detail or a face-center shift
of 0.06 image units or more. These thresholds are provisional. The center check does
not compensate for head rotation or prove that only the eyes moved.

Gaps over 200 ms, unavailable eyes, and stale results reset unfinished movement
evidence. Repeated display frames cannot advance a challenge. **Pattern spotted**
is only a system observation: **Yes, that matched** records visitor confirmation;
**It missed / got it wrong** can record a false positive or a miss even when no
pattern was detected. **Skip / finish attempt** is available for any challenge.
Camera stop, restarting a challenge, or leaving exploration ends the active attempt
as skipped. Completed observations are not automatically counted as accurate.

**Download findings** exports a separate JSON report (`report_schema_version: 1`),
with challenge ID, system observation, visitor feedback, optional setup notes,
baseline/completion evidence, and up to 240 recent raw samples per attempt. It
retains the latest 30 reviewed attempts in tab memory. Evidence samples include
the unchanged measurement schema v1, not images or face landmarks. Timestamps are
relative to the individual camera session; separate attempts can come from different
sessions. Finish or review an attempt before downloading to include it. **Clear**
discards these findings and setup notes. Reloading/closing the page also loses them.
Reports are self-reported validation notes, not an accuracy score or calibration.

### Visible iris color

The exploration panels also estimate **visible iris color** independently per eye.
MediaPipe supplies iris landmarks; `static/iris-color.mjs` supplies a provisional
pixel-color heuristic, not a model-provided eye-color classification. A swatch and
broad color-family label describe the current camera image. These are transient UI
values and are not added to raw JSONL packets or validation reports.

The sampler uses the 60–85% radius band of the landmark-estimated iris ellipse,
clipped to the visible lid gap. It aims to exclude the pupil and outer iris border,
and rejects very dark or bright pixels. It requires at least a six-pixel radius
on both axes and 16 usable samples; tiny/oblique irises, closure, too few samples,
and large color variation produce an unavailable state with a positioning or
lighting cue. Uncertain eye status and stale frames also suppress the swatch.
Color does not affect gaze, lid detection, or the illustrated eyes.

The pupil boundary is not segmented, so a dilated pupil can contaminate the sample.
Reflections, skin/lid contamination, contact lenses, white balance, and illumination
can shift the result. Brown/amber, green/hazel, blue/gray, and gray labels are broad
appearance hints, not validated natural eye-color measurements. Unit checks use
synthetic colors and exclusions; browser checks use a portrait fixture. Real-eye
accuracy across colors, cameras, and lighting still needs visitor validation.

### Raw JSONL recording

Raw JSONL uses schema version 1, with anatomical `left` and `right` labels and the
original image orientation. Each timestamp is monotonic milliseconds since this
camera session started. Recording starts partway through that timeline; it does not
reset time. Iris/lid geometry is measured in eye-width units with pixel aspect ratio
and roll compensation, as documented in the root README. The JavaScript packed
column-major face matrix is converted to the nested rows exported by Python.

The mirrored camera preview and mirrored software pose do not change raw packets.
Echo delays only software poses; readings and recordings always use live raw packets.
Face loss produces `face_present: false` and null eye/face fields. An invalid gaze
retains its raw iris position with `gaze_valid: false`; the display holds its last
valid gaze through a blink. One null eye does not discard the other eye.

**Record measurements** buffers JSONL in browser memory. **Stop & download** exports
it. Camera stop also appends a face-loss packet and exports an active recording.
The 10,000-sample limit automatically finishes and downloads a recording. No images
are retained in recordings. Browser downloads may need permission; navigating away
or closing the browser can lose an unfinished recording.

## Next adapters

A future shared session/control service should arbitrate browser, agent, and tracking
commands before hardware actuation. MCP can expose discrete operations such as
status, mode selection, animation, and release, while a separate bounded pose stream
handles continuous eye motion. A browser-local camera session cannot be controlled
by a remote MCP client until this bridge exists.

The normalized display pose is not a servo contract. `static/eyemech.mjs` maps it to
the firmware's follow pose and streams it to the board directly, or through the
local bridge that `just web --eyemech HOST` starts. See [eyemech.md](eyemech.md#follow-mode-firmware-2026-09-17) for the mapping,
side mirroring and firmware behavior.

References:
- [Google's Web Face Landmarker guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [MediaPipe matrix conversion source](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/framework/formats/matrix.cc)

## Verification

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
node --test tests/web.test.mjs tests/eyemech.test.mjs
```

Pytest includes the Node behavior tests and Python/browser measurement parity.
Manual browser checks: start/stop/restart camera, change camera while stopped, test
left and right winks, lose/reacquire a face, switch live/echo, enter/exit visitor and
fullscreen views, export JSONL, deny camera permission, and interrupt model loading.

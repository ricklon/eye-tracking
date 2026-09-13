# Eye tracking

Python/uv starter for local webcam face, iris, and eyelid tracking with MediaPipe.
The first development target is measuring eye motion; the later target is animating
the sibling `../eyemech-esp32-xiao` mechanism.

**Live preview:** <https://ricklon.github.io/eye-tracking/>. The browser dashboard is
published from `main` by `.github/workflows/pages.yml` after the tests pass. Camera
and tracking run in your browser; nothing is uploaded.

## Start (web interface)

The browser dashboard is the primary way to run this project. It works the same on
Windows, macOS, and Linux.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/):
   - Windows (PowerShell): `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Install [just](https://github.com/casey/just) with uv (any OS), then open a new terminal:
   `uv tool install rust-just`
   (`winget install Casey.Just`, `brew install just`, or your Linux package manager also work.)
3. From the repository root:

```bash
just setup
just web
```

Open <http://127.0.0.1:8080> in Chrome or Edge, press **Start camera**, and allow
camera access. Stop the server with **Ctrl-C**. Plain `just` also starts the dashboard;
`just --list` shows all recipes. Pass options through, e.g. `just web --port 8081`
if 8080 is taken. Without just, run `uv sync` then `uv run eye-tracking web`.

No model download is needed for the web interface: the browser fetches the MediaPipe
runtime and model itself, so the first start needs internet access. Python 3.12 is
selected in `.python-version`; `uv sync` installs it if necessary.

### Browser dashboard

The browser dashboard runs MediaPipe Tasks Face Landmarker on the browser's own
camera, with inference in a worker. It includes software eyes, live/echo mode,
separate per-eye iris/lid readings, JSONL recording, and a fullscreen visitor view.
The Python command serves static assets; it does not capture or receive video.
The existing Python webcam and kiosk commands remain available.

**Explore tracking** turns validation into an interactive activity: a live face map,
magnified eyes with iris/lid markers, open/closed/uncertain status, and guided blink,
wink, and gaze challenges. Each eye also shows a provisional iris-color swatch when
there is enough clear image detail. Visitors can confirm or dispute what was detected and
download their findings with a short measurement trace. No images are exported.

The browser downloads pinned MediaPipe 0.10.32 runtime/WASM and the version 1 model
from jsDelivr and Google on startup (subject to browser caching). Camera access
requires localhost or HTTPS; plain HTTP on a LAN IP will not enable a phone's camera.
See [docs/web.md](docs/web.md) for architecture, recording conventions, and limits.
Development checks require Node.js as well as uv to compare browser
measurements with Python.

## Secondary: Python desktop tools

These run MediaPipe in Python with OpenCV windows and need a local model download
plus a desktop session. Use them for development and comparison with the web interface.

### Python webcam tracker

```bash
uv run eye-tracking download-model
uv run eye-tracking run
```

Press **Q** or **Esc** to exit, or **Ctrl-C** in the terminal.

```bash
# Select a different camera and record measurements (no video is saved).
uv run eye-tracking run --camera 1 --output outputs/session-001.jsonl

# Bounded run without a preview window.
uv run eye-tracking run --camera 0 --no-preview --max-frames 100 --output outputs/check.jsonl
```

Camera 0 is the default; indices depend on the connected devices. On Linux,
`v4l2-ctl --list-devices` helps identify them. Output paths must be new so earlier
recordings are not overwritten. Model paths default to `models/face_landmarker.task`
relative to the working directory; both commands accept `--model PATH`.

### Desktop kiosk

```bash
uv run eye-tracking download-model
uv run eye-tracking kiosk
# Development window instead of fullscreen:
uv run eye-tracking kiosk --windowed
```

The software eyes greet a visitor, follow their face, then copy eye movements,
blinks, and winks when eye detail is sufficient. They return to idle after the
visitor leaves. Camera errors trigger a recovery screen and reconnect attempts.
A live mirrored camera inset shows the visitor and outlines the selected face.
Basic lighting and positioning cues help diagnose the setup; they are not an
accuracy guarantee. No recording or hardware connection is enabled in kiosk mode.

Eye copying includes a labeled 1.2-second echo so you can look away or blink,
then watch your movement. Use `--replay-delay 0` for live copying.
**R** toggles live/echo, **F** toggles fullscreen, **Tab** shows staff diagnostics,
and **Q/Esc** exits.
See [docs/kiosk.md](docs/kiosk.md) for behavior, conventions, and deployment limits.

### Checks

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

`just setup`, `just web`, `just download-model`, `just run`, `just test`, and
`just lint` wrap the common commands.

## Included

- Single-face tracking with face position and the MediaPipe face transformation matrix.
- Anatomical left/right iris centers and separate upper/lower eyelid positions.
- Per-eye aperture, blink score, and approximate openness.
- Mirrored webcam preview with face landmarks and highlighted iris/lid points.
- Versioned JSONL measurements, including explicit face-loss packets.
- Geometry tests that run without a webcam or downloaded model.

Uses the [MediaPipe Face Landmarker Tasks API](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/python)
in VIDEO mode with monotonic timestamps and one face. Google documents tracking and
single-face smoothing for this configuration. The model bundle is linked from
the [official model page](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker#models).

## Measurement contract (schema version 1)

Each JSONL line has `timestamp_ms` (monotonic milliseconds since this run started),
`image_size`, `face_present`, `face_center`, `face_transform`, and `eyes`.
On face loss, center, transform, and eyes are `null`; no previous measurement is reused.
Face center is the normalized landmark bounding-box center. Face transform is the
unaltered MediaPipe 4×4 matrix, not Euler angles or a gaze direction.

`eyes.left` and `eyes.right` refer to the **person's anatomical sides**. Detection
always uses the original camera image. Mirroring affects only the preview; use
`--no-mirror` to show its original orientation.

| Per-eye field | Meaning |
| --- | --- |
| `iris_image` | Normalized original-image x/y; x right, y down; may leave 0..1 at image edges |
| `iris_local` | x/y relative to eye-corner midpoint, in eye-width units; x toward image right, y down on a frontal face |
| `upper_lid`, `lower_lid` | Separate signed y offsets from the same midpoint, in eye-width units |
| `aperture` | Nonnegative lower-minus-upper offset |
| `blink_score` | MediaPipe eyeBlinkLeft/Right score, 0..1, or null if absent |
| `openness` | 1 minus blink score; an expression proxy, not calibrated mechanical opening |
| `gaze_valid` | Heuristic: aperture > 0.03 and blink score < 0.5 if available |

Eye geometry uses pixel aspect ratio and an eye-corner axis to compensate for head
roll and scale. It does not compensate for head yaw/pitch. A degenerate eye width
produces a null eye. Iris estimates during closure remain available for inspection
but `gaze_valid` becomes false. This flag is not a model confidence score and does
not reliably detect every occlusion. Eye position is an iris-location proxy, not
calibrated screen gaze or physical gaze angles. The upper/lower samples are single
lid landmarks, not fitted curves.

## Continue development

- `src/eye_tracking/cli.py`: camera, model, preview, and recording.
- `src/eye_tracking/measurements.py`: pure measurement extraction and schema.
- `tests/test_measurements.py`: geometry, side assignment, and missing-data behavior.
- [docs/eyemech.md](docs/eyemech.md): existing mechanism interface and integration plan.

Next: validate against live eyes, add neutral/open/closed calibration per person,
refine the kiosk animation preview and add recording playback. Introduce a
separate calibrated adapter for eyemech after the measurement behavior is settled.
No hardware connection or servo output is implemented in this starter.

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
- `static/app.mjs` owns browser capture, controls, canvas rendering, and recording.
  At most one camera frame is in flight. Slow inference drops opportunities to
  capture instead of building a queue; rendering continues independently.

No Node build or web framework is required to run the application. Node.js is
required for development tests. The HTML, CSS, and ES modules can also be deployed
as a static HTTPS site. Static assets are included in the Python package.

## Camera and runtime

The runtime is pinned to `@mediapipe/tasks-vision@0.10.32`, and the model uses Google's
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

## Measurements and recording

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

The current normalized display pose is not a servo contract. Follow
[eyemech.md](eyemech.md) for physical side mapping, person and servo calibration,
independent lid support, engage/release behavior, and the firmware pose interface.

References:
- [Google's Web Face Landmarker guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [MediaPipe matrix conversion source](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/framework/formats/matrix.cc)

## Verification

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
node --test tests/web.test.mjs
```

Pytest includes the Node behavior tests and Python/browser measurement parity.
Manual browser checks: start/stop/restart camera, change camera while stopped, test
left and right winks, lose/reacquire a face, switch live/echo, enter/exit visitor and
fullscreen views, export JSONL, deny camera permission, and interrupt model loading.

"""Webcam entry point and explicit model setup."""

import argparse
import json
import math
import os
import shutil
import sys
import time
import urllib.request
from contextlib import ExitStack
from pathlib import Path

from eye_tracking.measurements import EYES, make_packet

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
DEFAULT_MODEL = Path("models/face_landmarker.task")


def download_model(path):
    if path.is_file():
        print(f"Model already exists: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".download")
    try:
        with (
            urllib.request.urlopen(MODEL_URL, timeout=60) as source,
            temporary.open("wb") as target,
        ):
            shutil.copyfileobj(source, target)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Model downloaded: {path}")


def draw_preview(cv2, frame, result, packet, mirror):
    height, width = frame.shape[:2]
    if result.face_landmarks:
        landmarks = result.face_landmarks[0]
        for p in landmarks:
            cv2.circle(frame, (int(p.x * width), int(p.y * height)), 1, (100, 100, 100), -1)
        for indices in EYES.values():
            for name in ("upper", "lower", "iris"):
                p = landmarks[indices[name]]
                color = (0, 255, 255) if name == "iris" else (0, 255, 0)
                cv2.circle(frame, (int(p.x * width), int(p.y * height)), 3, color, -1)
    if mirror:
        frame = cv2.flip(frame, 1)
    lines = ["Q / Esc: quit | anatomical L/R | preview mirror: " + str(mirror)]
    if packet["eyes"]:
        for side, eye in packet["eyes"].items():
            if eye is not None:
                x, y = eye["iris_local"]
                blink = eye["blink_score"]
                blink_text = "n/a" if blink is None else f"{blink:.2f}"
                lines.append(
                    f"{side}: iris {x:+.2f},{y:+.2f} gap {eye['aperture']:.2f} "
                    f"blink {blink_text} gaze valid {eye['gaze_valid']}"
                )
    else:
        lines.append("No face detected")
    for index, line in enumerate(lines):
        cv2.putText(
            frame,
            line,
            (12, 24 + index * 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    cv2.imshow("Eye tracking", frame)


def run(args):
    if not args.model.is_file():
        raise RuntimeError("Model missing. Run: uv run eye-tracking download-model")
    if not args.no_preview and sys.platform.startswith("linux"):
        if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            raise RuntimeError(
                "No desktop display. Use --no-preview --output outputs/session.jsonl"
            )
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model)),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
    )
    with ExitStack() as stack:
        tracker = stack.enter_context(vision.FaceLandmarker.create_from_options(options))
        camera = cv2.VideoCapture(args.camera)
        stack.callback(camera.release)
        if not camera.isOpened():
            raise RuntimeError(f"Cannot open camera {args.camera}; try --camera with another index")
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        output = None
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            # Refuse to silently overwrite an earlier recording.
            output = stack.enter_context(args.output.open("x"))
        if not args.no_preview:
            stack.callback(cv2.destroyAllWindows)
        start = time.monotonic_ns()
        previous_ms = -1
        count = 0
        while not args.max_frames or count < args.max_frames:
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Camera stopped returning frames")
            timestamp = max(previous_ms + 1, (time.monotonic_ns() - start) // 1_000_000)
            previous_ms = timestamp
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = tracker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp
            )
            height, width = frame.shape[:2]
            packet = make_packet(result, timestamp, width, height)
            if output:
                output.write(json.dumps(packet, allow_nan=False) + "\n")
                output.flush()
            count += 1
            if not args.no_preview:
                draw_preview(cv2, frame, result, packet, not args.no_mirror)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
        print(f"Processed {count} frames.")


def nonnegative(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return number


def replay_delay(value):
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 3:
        raise argparse.ArgumentTypeError("must be between 0 and 3 seconds")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download-model", help="Download the version 1 Google model")
    download.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    webcam = commands.add_parser("run", help="Track one face using a local webcam")
    webcam.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    webcam.add_argument("--camera", type=nonnegative, default=0)
    webcam.add_argument("--no-preview", action="store_true")
    webcam.add_argument("--no-mirror", action="store_true", help="Show original camera orientation")
    webcam.add_argument("--output", type=Path, help="New JSONL recording path")
    webcam.add_argument(
        "--max-frames", type=nonnegative, default=0, help="0 runs until interrupted"
    )
    kiosk = commands.add_parser("kiosk", help="Fullscreen interactive software eyes")
    kiosk.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    kiosk.add_argument("--camera", type=nonnegative, default=0)
    kiosk.add_argument("--windowed", action="store_true")
    kiosk.add_argument("--diagnostics", action="store_true", help="Show live per-eye measurements")
    kiosk.add_argument(
        "--replay-delay",
        type=replay_delay,
        default=1.2,
        help="Eye echo delay in seconds (0..3); 0 shows live movement",
    )
    kiosk.add_argument("--max-seconds", type=nonnegative, default=0)
    web = commands.add_parser("web", help="Browser dashboard and software-eye kiosk")
    web.add_argument("--host", default="127.0.0.1", help="Bind address; default is local only")
    web.add_argument("--port", type=int, default=8080)
    web.add_argument(
        "--eyemech",
        metavar="HOST[:PORT]",
        help="Relay dashboard poses to an eyemech board's follow mode, e.g. eyemech.local",
    )
    web.add_argument("--bridge-port", type=int, default=8766, help="Local WebSocket bridge port")
    args = parser.parse_args()
    try:
        if args.command == "download-model":
            download_model(args.model)
        elif args.command == "web":
            from eye_tracking.web import run_web

            run_web(args)
        elif args.command == "kiosk":
            if sys.platform.startswith("linux") and not (
                os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
            ):
                raise RuntimeError("Kiosk mode needs a desktop display")
            from eye_tracking.kiosk_app import run_kiosk

            run_kiosk(args)
        else:
            run(args)
    except KeyboardInterrupt:
        pass
    except (OSError, RuntimeError, ValueError) as exc:
        parser.exit(1, f"eye-tracking: {exc}\n")

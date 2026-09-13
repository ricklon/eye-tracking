"""OpenCV kiosk display with camera/inference isolated from the animation loop."""

import logging
import threading
import time
from dataclasses import dataclass

import numpy as np

from eye_tracking.camera_quality import CameraQuality, assess_camera
from eye_tracking.kiosk import KioskController, MirrorReplay, Observation, ParticipantSelector

LOG = logging.getLogger(__name__)
WINDOW = "Eye play"


@dataclass(frozen=True)
class Sample:
    observation: Observation | None
    captured_at: float
    camera_ok: bool
    message: str = ""
    frame: np.ndarray | None = None
    quality: CameraQuality | None = None


class CameraWorker:
    def __init__(self, camera_index, model):
        self.camera_index = camera_index
        self.model = model
        self.stop = threading.Event()
        self.sample = Sample(None, 0.0, False, "Starting camera")
        self.thread = threading.Thread(target=self._run, name="kiosk-camera", daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)

    def _run(self):
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(self.model)),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=3,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        while not self.stop.is_set():
            camera = None
            try:
                with vision.FaceLandmarker.create_from_options(options) as tracker:
                    selector = ParticipantSelector()
                    camera = cv2.VideoCapture(self.camera_index)
                    if not camera.isOpened():
                        raise RuntimeError("Camera unavailable")
                    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                    camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    previous_ms = -1
                    while not self.stop.is_set():
                        ok, frame = camera.read()
                        captured_at = time.monotonic()
                        if not ok:
                            raise RuntimeError("Camera stopped returning frames")
                        timestamp = max(previous_ms + 1, int(captured_at * 1000))
                        previous_ms = timestamp
                        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        result = tracker.detect_for_video(
                            mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp
                        )
                        height, width = frame.shape[:2]
                        observation = selector.select(result, captured_at, width, height)
                        self.sample = Sample(
                            observation,
                            captured_at,
                            True,
                            frame=frame,
                            quality=assess_camera(frame, observation),
                        )
            except (OSError, RuntimeError, ValueError, cv2.error) as exc:
                LOG.warning("Camera/tracker will retry: %s", exc)
                self.sample = Sample(None, time.monotonic(), False, str(exc))
            finally:
                if camera is not None:
                    camera.release()
            self.stop.wait(2.0)


def camera_preview(sample):
    """Letterboxed mirrored view; annotations never modify the source frame."""
    import cv2

    tile = np.zeros((132, 236, 3), dtype=np.uint8)
    if sample is None or sample.frame is None:
        cv2.putText(
            tile,
            "Camera unavailable",
            (20, 70),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (210, 210, 210),
            1,
            cv2.LINE_AA,
        )
        return tile
    frame = sample.frame
    height, width = frame.shape[:2]
    scale = min(236 / width, 132 / height)
    w, h = max(1, round(width * scale)), max(1, round(height * scale))
    view = cv2.resize(cv2.flip(frame, 1), (w, h), interpolation=cv2.INTER_AREA)
    observation = sample.observation
    if observation and observation.face_bounds:
        x0, y0, x1, y1 = observation.face_bounds
        cv2.rectangle(
            view,
            (int((1 - x1) * w), int(y0 * h)),
            (int((1 - x0) * w), int(y1 * h)),
            (191, 225, 84),
            1,
            cv2.LINE_AA,
        )
    x, y = (236 - w) // 2, (132 - h) // 2
    tile[y : y + h, x : x + w] = view
    return tile


def render(scene, staff_text=None, eye_status=None, sample=None):
    import cv2
    import numpy as np

    canvas = np.zeros((720, 1280, 3), dtype=np.uint8)
    canvas[:] = (30, 20, 12)
    accent = (191, 225, 84)
    white = (245, 244, 231)

    def centered(text, y, scale, color=white):
        thickness = 1 if scale < 0.7 else 2
        size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)[0]
        cv2.putText(
            canvas,
            text,
            ((1280 - size[0]) // 2, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            scale,
            color,
            thickness,
            cv2.LINE_AA,
        )

    centered("E Y E   P L A Y", 65, 0.65, accent)
    centered(scene.title, 137, 1.25)
    pose = scene.pose
    for cx, side in ((390, "left"), (890, "right")):
        cy, rx, ry = 345, 190, 125
        upper = getattr(pose, f"upper_{side}")
        lower = getattr(pose, f"lower_{side}")
        cv2.ellipse(canvas, (cx, cy), (rx + 12, ry + 12), 0, 0, 360, (65, 55, 40), -1, cv2.LINE_AA)
        if upper + lower <= 0.12:
            # Do not composite any eyeball pixels, including the center scanline.
            cv2.ellipse(canvas, (cx, cy - 8), (145, 18), 0, 0, 180, accent, 5, cv2.LINE_AA)
            continue
        mask = np.zeros(canvas.shape[:2], dtype=np.uint8)
        cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, 255, -1, cv2.LINE_AA)
        top, bottom = int(cy - ry * upper), int(cy + ry * lower)
        mask[:top] = 0
        mask[bottom + 1 :] = 0
        eye = np.full_like(canvas, white)
        iris = (int(cx + pose.x * 85), int(cy + pose.y * 48))
        cv2.circle(eye, iris, 75, (125, 155, 25), -1, cv2.LINE_AA)
        cv2.circle(eye, iris, 61, accent, -1, cv2.LINE_AA)
        cv2.circle(eye, iris, 33, (28, 23, 16), -1, cv2.LINE_AA)
        cv2.circle(eye, (iris[0] - 19, iris[1] - 23), 13, (255, 255, 255), -1, cv2.LINE_AA)
        canvas[mask > 0] = eye[mask > 0]
    centered(scene.prompt, 516, 0.75)
    if scene.state == "acquiring":
        cv2.line(canvas, (490, 174), (790, 174), (65, 55, 40), 6)
        cv2.line(canvas, (490, 174), (490 + int(300 * scene.progress), 174), accent, 6)
    # Camera inset is always live; only the illustrated pose is delayed.
    cv2.putText(
        canvas,
        "LIVE CAMERA / MIRRORED",
        (48, 542),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.4,
        accent,
        1,
        cv2.LINE_AA,
    )
    preview = camera_preview(sample)
    canvas[550:682, 48:284] = preview
    cue = sample.quality.cue if sample is not None and sample.quality else "Waiting for the camera"
    cv2.putText(canvas, cue, (320, 576), cv2.FONT_HERSHEY_SIMPLEX, 0.65, white, 1, cv2.LINE_AA)
    cv2.putText(
        canvas,
        "Outline = the person I'm following",
        (320, 608),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        accent,
        1,
        cv2.LINE_AA,
    )
    cv2.putText(
        canvas,
        "Live on this computer. No images recorded.",
        (320, 675),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (177, 168, 150),
        1,
        cv2.LINE_AA,
    )
    centered(
        "A camera finds your eye movements. Code brings these eyes to life.",
        708,
        0.42,
        (177, 168, 150),
    )
    if staff_text:
        cv2.rectangle(canvas, (0, 0), (1280, 28), (0, 0, 0), -1)
        cv2.putText(
            canvas,
            staff_text[:145],
            (12, 20),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    if eye_status:
        for index, line in enumerate(eye_status):
            y = 633 + index * 19
            cv2.rectangle(canvas, (310, y - 16), (1280, y + 3), (0, 0, 0), -1)
            cv2.putText(
                canvas,
                line,
                (320, y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.4,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )
    return canvas


def run_kiosk(args):
    import cv2

    if not args.model.is_file():
        raise RuntimeError("Model missing. Run: uv run eye-tracking download-model")
    controller = KioskController()
    replay = MirrorReplay(args.replay_delay)
    worker = CameraWorker(args.camera, args.model)
    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, 1280, 720)
    fullscreen = not args.windowed
    cv2.setWindowProperty(
        WINDOW, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL
    )
    staff = args.diagnostics
    worker.start()
    start = time.monotonic()
    try:
        while not args.max_seconds or time.monotonic() - start < args.max_seconds:
            now = time.monotonic()
            sample = worker.sample
            fresh = sample.camera_ok and now - sample.captured_at < 0.75
            scene = controller.update(sample.observation if fresh else None, now, fresh)
            participant = controller.participant

            scene = replay.present(scene, now, participant)
            detail = (
                (
                    f"{scene.state} | camera {args.camera} | frame age {now - sample.captured_at:.2f}s"
                    f" | {sample.message} | R live/echo | F fullscreen | Tab staff | Q/Esc exit"
                )
                if staff
                else None
            )
            eye_status = []
            if staff and fresh and sample.observation:
                for side, eye in (sample.observation.packet["eyes"] or {}).items():
                    if eye is not None:
                        latch = controller.closed[side]
                        blink = eye["blink_score"]
                        blink_text = "n/a" if blink is None else f"{blink:.2f}"
                        eye_status.append(
                            f"LIVE {side}: gap {eye['aperture']:.3f} blink {blink_text} "
                            f"closed {latch.closed} reopen frames {latch.open_samples} "
                            f"gaze detail {sample.observation.eye_detail}"
                        )
            cv2.imshow(WINDOW, render(scene, detail, eye_status, sample if fresh else None))
            key = cv2.waitKey(16) & 0xFF
            if key in (ord("q"), 27) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if key == ord("r"):
                replay = MirrorReplay(0.0 if replay.delay else args.replay_delay or 1.2)
            if key == 9:
                staff = not staff
            if key == ord("f"):
                fullscreen = not fullscreen
                cv2.setWindowProperty(
                    WINDOW,
                    cv2.WND_PROP_FULLSCREEN,
                    cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL,
                )
    finally:
        worker.close()
        cv2.destroyAllWindows()

"""Visitor selection and software animation; no camera, transport, or servo units."""

from collections import deque
from dataclasses import dataclass, replace
from math import exp, hypot, sin
from types import SimpleNamespace

from eye_tracking.measurements import EYES, make_packet


def clamp(value, low=-1.0, high=1.0):
    return max(low, min(high, value))


@dataclass(frozen=True)
class Observation:
    packet: dict
    eye_detail: bool
    participant: int
    face_bounds: tuple[float, float, float, float] | None = None


class ParticipantSelector:
    """Spatial continuity only, not identity recognition. Missing locks expire."""

    def __init__(self):
        self.center = None
        self.last_seen = -100.0
        self.participant = 0

    def select(self, result, now, width, height):
        candidates = []
        for index, points in enumerate(result.face_landmarks):
            if len(points) < 478:
                continue
            xs, ys = [p.x for p in points], [p.y for p in points]
            center = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
            span = max(xs) - min(xs)
            if not (0.12 <= center[0] <= 0.88 and 0.08 <= center[1] <= 0.92):
                continue
            if span < 0.12:
                continue
            candidates.append((index, center, span))
        locked = self.center is not None and now - self.last_seen < 1.5
        if locked:
            candidates = [c for c in candidates if hypot(*self._delta(c[1])) < 0.18]
            chosen = min(candidates, key=lambda c: hypot(*self._delta(c[1])), default=None)
        else:
            chosen = min(
                candidates,
                key=lambda c: hypot(c[1][0] - 0.5, c[1][1] - 0.5) - c[2] * 0.2,
                default=None,
            )
        if chosen is None:
            return None
        if not locked:
            self.participant += 1
        index, self.center, _ = chosen
        self.last_seen = now
        selected = SimpleNamespace(
            face_landmarks=[result.face_landmarks[index]],
            face_blendshapes=result.face_blendshapes[index : index + 1],
            facial_transformation_matrixes=result.facial_transformation_matrixes[index : index + 1],
        )
        packet = make_packet(selected, int(now * 1000), width, height)
        points = selected.face_landmarks[0]
        spans = []
        for indices in EYES.values():
            a, b = (points[i] for i in indices["corners"])
            spans.append(hypot((b.x - a.x) * width, (b.y - a.y) * height))
        # Conservative detail/asymmetry gate, not a calibrated head-pose estimate.
        detail = min(spans) >= 22 and min(spans) / max(spans) > 0.65
        bounds = (
            min(p.x for p in points),
            min(p.y for p in points),
            max(p.x for p in points),
            max(p.y for p in points),
        )
        return Observation(packet, detail, self.participant, bounds)

    def _delta(self, center):
        return center[0] - self.center[0], center[1] - self.center[1]


@dataclass(frozen=True)
class Pose:
    """Display pose v1. Gaze -1..1 right/down; each lid 0 closed..1 open.

    Side names stay anatomical. The renderer uses a mirror-like layout: the
    participant's left eye appears on screen left. This is not a servo contract.
    """

    x: float = 0.0
    y: float = 0.0
    upper_left: float = 1.0
    lower_left: float = 1.0
    upper_right: float = 1.0
    lower_right: float = 1.0


@dataclass(frozen=True)
class Scene:
    pose: Pose
    state: str
    title: str
    prompt: str
    progress: float = 0.0


@dataclass
class LidLatch:
    closed: bool = False
    reopening_since: float | None = None
    last_sample: float | None = None
    open_samples: int = 0

    def interrupt(self):
        self.reopening_since = None
        self.open_samples = 0

    def update(self, aperture, blink, timestamp):
        # UI redraws of one camera packet are not independent evidence.
        if self.last_sample is not None:
            if timestamp <= self.last_sample:
                return self.closed
            if timestamp - self.last_sample > 0.2:
                self.interrupt()
        self.last_sample = timestamp
        closing = aperture <= 0.04 or (aperture <= 0.10 and blink is not None and blink >= 0.55)
        opening = aperture >= 0.12 or (aperture >= 0.065 and (blink is None or blink <= 0.35))
        if closing:
            self.closed = True
            self.interrupt()
        elif self.closed and opening:
            if self.reopening_since is None:
                self.reopening_since = timestamp
            self.open_samples += 1
            # Conflicting blink/geometry evidence needs a longer confirmation.
            duration = 0.25 if blink is not None and blink > 0.35 else 0.12
            if self.open_samples >= 3 and timestamp - self.reopening_since >= duration:
                self.closed = False
                self.interrupt()
        else:
            self.interrupt()
        return self.closed


class KioskController:
    def __init__(self):
        self.pose = Pose()
        self.previous_time = None
        self.participant = None
        self.entered = None
        self.last_seen = None
        self.last_gaze = (0.0, 0.0)
        self.closed = {"left": LidLatch(), "right": LidLatch()}

    def update(self, observation, now, camera_ok=True):
        dt = 1 / 30 if self.previous_time is None else max(0.0, now - self.previous_time)
        self.previous_time = now
        if not camera_ok:
            self.participant = self.entered = self.last_seen = None
            self.closed = {"left": LidLatch(), "right": LidLatch()}
            return self._scene(
                Pose(), dt, "offline", "Taking a little break", "I'll be back in a moment"
            )
        if observation is not None:
            if observation.participant != self.participant:
                self.participant = observation.participant
                self.entered = now
                self.last_gaze = (0.0, 0.0)
                self.closed = {"left": LidLatch(), "right": LidLatch()}
            self.last_seen = now
            elapsed = now - self.entered
            center = observation.packet["face_center"]
            face_gaze = (clamp((0.5 - center[0]) * 2.5), clamp((center[1] - 0.5) * 2.5))
            if elapsed < 0.6:
                return self._scene(
                    Pose(*face_gaze),
                    dt,
                    "acquiring",
                    "Oh, hello!",
                    "Stay here a moment",
                    elapsed / 0.6,
                )
            if elapsed < 1.6:
                return self._scene(
                    Pose(*face_gaze), dt, "greeting", "You caught my eye!", "Let's play together"
                )
            eyes = observation.packet["eyes"] or {}
            valid = [eye for eye in eyes.values() if eye and eye["gaze_valid"]]
            if not observation.eye_detail:
                self.last_gaze = face_gaze
            elif valid:
                # Explicit display mirroring; raw iris coordinates are never changed.
                x = -sum(eye["iris_local"][0] for eye in valid) / len(valid) * 5
                y = sum(eye["iris_local"][1] for eye in valid) / len(valid) * 5
                self.last_gaze = (clamp(x), clamp(y))
            lids = []
            for side in ("left", "right"):
                eye = eyes.get(side)
                if eye is None:
                    self.closed[side].interrupt()
                    lids.extend(
                        (getattr(self.pose, f"upper_{side}"), getattr(self.pose, f"lower_{side}"))
                    )
                    continue
                blink = eye.get("blink_score")
                if blink is None and eye["openness"] is not None:
                    blink = 1.0 - eye["openness"]
                aperture = eye.get("aperture", max(0.0, eye["lower_lid"] - eye["upper_lid"]))
                timestamp = observation.packet.get("timestamp_ms", now * 1000) / 1000
                if self.closed[side].update(aperture, blink, timestamp):
                    lids.extend((0.0, 0.0))
                    continue
                lids.extend(
                    (
                        clamp(-eye["upper_lid"] / 0.12, 0, 1),
                        clamp(eye["lower_lid"] / 0.12, 0, 1),
                    )
                )
            if not observation.eye_detail:
                return self._scene(
                    Pose(*self.last_gaze, *lids),
                    dt,
                    "following",
                    "I see you!",
                    "I can copy blinks. Come closer to try eye movements too",
                )
            prompts = (
                "Look left. Look right. I'm copying your eyes!",
                "Can you make just one eye wink?",
                "Try a slow blink. Watch my eyelids!",
            )
            return self._scene(
                Pose(*self.last_gaze, *lids),
                dt,
                "copying",
                "Your eyes are in charge!",
                prompts[int((elapsed - 1.6) / 7) % len(prompts)],
            )
        for latch in self.closed.values():
            latch.interrupt()
        missing = float("inf") if self.last_seen is None else now - self.last_seen
        if missing < 1.5:
            # Brief missing data is not evidence of reopening. Departure resets the pose.
            return self._scene(self.pose, dt, "waiting", "Peekaboo!", "I'm still here")
        self.participant = self.entered = None
        if missing < 3.0:
            return self._scene(Pose(), dt, "goodbye", "See you next time!", "Who's next?")
        phase = now % 4.5
        opening = 0.0 if phase < 0.13 else 1.0
        return self._scene(
            Pose(0.35 * sin(now * 0.55), 0.12 * sin(now * 0.8), *([opening] * 4)),
            dt,
            "idle",
            "Can you make me wink?",
            "Step in front of me to play",
        )

    def _scene(self, target, dt, state, title, prompt, progress=0.0):
        values = []
        for name in Pose.__dataclass_fields__:
            current, desired = getattr(self.pose, name), getattr(target, name)
            if name not in ("x", "y") and desired == 0.0:
                # A closure is categorical: smoothing must not leave an iris slit.
                values.append(0.0)
                continue
            tau = 0.10 if name in ("x", "y") else 0.035
            change = (desired - current) * (1 - exp(-dt / tau))
            if name in ("x", "y"):
                change = 0.0 if abs(desired - current) < 0.015 else clamp(change, -3 * dt, 3 * dt)
            values.append(current + change)
        self.pose = Pose(*values)
        return Scene(self.pose, state, title, prompt, progress)


class MirrorReplay:
    """Bounded in-memory animation history; never retains camera images."""

    def __init__(self, delay=1.2):
        self.delay = delay
        self.history = deque(maxlen=600)
        self.participant = None

    def present(self, scene, now, participant):
        interactive = scene.state in ("copying", "following", "waiting")
        if not interactive or participant != self.participant or self.delay <= 0:
            self.history.clear()
        self.participant = participant
        if not interactive or self.delay <= 0:
            return scene
        self.history.append((now, scene.pose))
        cutoff = now - self.delay
        while len(self.history) > 1 and self.history[1][0] <= cutoff:
            self.history.popleft()
        if self.history[0][0] > cutoff:
            return replace(
                scene,
                title="Let's try an eye echo!",
                prompt="Look aside or blink, then look back here",
            )
        return replace(
            scene,
            pose=self.history[0][1],
            title=f"Your eyes, {self.delay:g} seconds later",
            prompt=(
                scene.prompt
                if scene.state == "following"
                else "Look aside or blink, then watch what you did!"
            ),
        )

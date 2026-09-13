"""Pure geometry in a roll-aligned eye frame; no camera or MediaPipe dependency."""

from dataclasses import asdict, dataclass
from math import hypot

# Anatomical sides of the person, using unmirrored MediaPipe input.
# corners are ordered toward increasing image x on a frontal face.
EYES = {
    "left": {"corners": (362, 263), "upper": 386, "lower": 374, "iris": 473},
    "right": {"corners": (33, 133), "upper": 159, "lower": 145, "iris": 468},
}


@dataclass(frozen=True)
class EyeState:
    iris_image: tuple[float, float]
    iris_local: tuple[float, float]
    upper_lid: float
    lower_lid: float
    aperture: float
    blink_score: float | None
    openness: float | None
    gaze_valid: bool


def measure_eye(landmarks, indices, width, height, blink_score=None):
    """Local x/y and lid offsets are in eye-width units from the corner midpoint."""

    def pixel(index):
        point = landmarks[index]
        return point.x * width, point.y * height

    a, b = (pixel(i) for i in indices["corners"])
    dx, dy = b[0] - a[0], b[1] - a[1]
    span = hypot(dx, dy)
    if span < 1e-6:
        return None
    ux, uy = dx / span, dy / span
    midpoint = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)

    def local(index):
        px, py = pixel(index)
        x, y = px - midpoint[0], py - midpoint[1]
        return ((x * ux + y * uy) / span, (-x * uy + y * ux) / span)

    upper = local(indices["upper"])[1]
    lower = local(indices["lower"])[1]
    aperture = max(0.0, lower - upper)
    iris = landmarks[indices["iris"]]
    blink = None if blink_score is None else max(0.0, min(1.0, blink_score))
    return EyeState(
        iris_image=(iris.x, iris.y),
        iris_local=local(indices["iris"]),
        upper_lid=upper,
        lower_lid=lower,
        aperture=aperture,
        blink_score=blink,
        openness=None if blink is None else 1.0 - blink,
        gaze_valid=aperture > 0.03 and (blink is None or blink < 0.5),
    )


def make_packet(result, timestamp_ms, width, height):
    packet = {
        "schema_version": 1,
        "timestamp_ms": timestamp_ms,
        "image_size": [width, height],
        "face_present": False,
        "face_center": None,
        "face_transform": None,
        "eyes": None,
    }
    if not result.face_landmarks or len(result.face_landmarks[0]) < 478:
        return packet
    landmarks = result.face_landmarks[0]
    scores = {
        item.category_name: item.score
        for item in (result.face_blendshapes[0] if result.face_blendshapes else [])
    }
    eyes = {}
    for side, indices in EYES.items():
        state = measure_eye(
            landmarks, indices, width, height, scores.get(f"eyeBlink{side.title()}")
        )
        eyes[side] = asdict(state) if state else None
    packet.update(
        face_present=True,
        face_center=[
            (min(p.x for p in landmarks) + max(p.x for p in landmarks)) / 2,
            (min(p.y for p in landmarks) + max(p.y for p in landmarks)) / 2,
        ],
        eyes=eyes,
    )
    if len(result.facial_transformation_matrixes):
        packet["face_transform"] = result.facial_transformation_matrixes[0].tolist()
    return packet

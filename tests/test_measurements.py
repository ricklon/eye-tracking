from math import cos, sin
from types import SimpleNamespace as NS

import pytest

from eye_tracking.measurements import EYES, make_packet, measure_eye


def landmarks(angle=0.0, scale=1.0, closed=False):
    points = [NS(x=0.5, y=0.5) for _ in range(478)]
    for indices in EYES.values():
        positions = {
            indices["corners"][0]: (-50, 0),
            indices["corners"][1]: (50, 0),
            indices["iris"]: (10, 5),
            indices["upper"]: (0, 0 if closed else -10),
            indices["lower"]: (0, 0 if closed else 10),
        }
        for index, (x, y) in positions.items():
            points[index] = NS(
                x=(320 + scale * (x * cos(angle) - y * sin(angle))) / 640,
                y=(240 + scale * (x * sin(angle) + y * cos(angle))) / 480,
            )
    return points


@pytest.mark.parametrize("angle,scale", [(0, 1), (0.6, 1), (-0.3, 2)])
def test_eye_geometry_is_scale_and_roll_invariant(angle, scale):
    eye = measure_eye(landmarks(angle, scale), EYES["left"], 640, 480, 0.1)
    assert eye.iris_local == pytest.approx((0.1, 0.05))
    assert eye.upper_lid == pytest.approx(-0.1)
    assert eye.lower_lid == pytest.approx(0.1)
    assert eye.aperture == pytest.approx(0.2)
    assert eye.openness == pytest.approx(0.9)
    assert eye.gaze_valid


def test_closed_eye_does_not_divide_by_lid_gap():
    eye = measure_eye(landmarks(closed=True), EYES["left"], 640, 480, 0.95)
    assert eye.aperture == 0
    assert not eye.gaze_valid
    assert eye.iris_local == pytest.approx((0.1, 0.05))


def test_degenerate_eye_is_unavailable():
    points = landmarks()
    a, b = EYES["left"]["corners"]
    points[b] = points[a]
    assert measure_eye(points, EYES["left"], 640, 480) is None


def test_missing_blendshape_is_not_invented():
    eye = measure_eye(landmarks(), EYES["right"], 640, 480)
    assert eye.blink_score is None
    assert eye.openness is None


def test_anatomical_sides_keep_independent_blinks():
    result = NS(
        face_landmarks=[landmarks()],
        face_blendshapes=[
            [
                NS(category_name="eyeBlinkLeft", score=0.95),
                NS(category_name="eyeBlinkRight", score=0.05),
            ]
        ],
        facial_transformation_matrixes=[],
    )
    packet = make_packet(result, 42, 640, 480)
    assert packet["face_present"]
    assert not packet["eyes"]["left"]["gaze_valid"]
    assert packet["eyes"]["right"]["gaze_valid"]
    assert packet["eyes"]["left"]["openness"] == pytest.approx(0.05)


def test_face_loss_emits_no_stale_measurements():
    packet = make_packet(NS(face_landmarks=[]), 43, 640, 480)
    assert packet["timestamp_ms"] == 43
    assert not packet["face_present"]
    assert packet["eyes"] is None
    assert packet["face_center"] is None
    assert packet["face_transform"] is None

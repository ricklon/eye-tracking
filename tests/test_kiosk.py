from copy import deepcopy
from types import SimpleNamespace as NS

import pytest

from eye_tracking.kiosk import KioskController, Observation, ParticipantSelector, Pose, Scene
from eye_tracking.kiosk_app import render
from eye_tracking.measurements import EYES


def observation(participant=1, detail=True, blink=0.0, valid=True):
    eye = {
        "iris_local": (0.12, -0.04),
        "upper_lid": -0.12 * (1 - blink),
        "lower_lid": 0.06 * (1 - blink),
        "openness": 1 - blink,
        "gaze_valid": valid,
    }
    return Observation(
        {"face_center": (0.6, 0.4), "eyes": {"left": eye, "right": dict(eye)}},
        detail,
        participant,
    )


def copying():
    controller = KioskController()
    controller.update(observation(), 0)
    controller.update(observation(), 2)
    return controller


def test_arrival_loss_and_departure():
    controller = KioskController()
    assert controller.update(None, 0).state == "idle"
    assert controller.update(observation(), 1).state == "acquiring"
    assert controller.update(observation(), 1.7).state == "greeting"
    assert controller.update(observation(), 2.7).state == "copying"
    assert controller.update(None, 3).state == "waiting"
    assert controller.update(None, 4.3).state == "goodbye"
    assert controller.update(None, 5.8).state == "idle"
    assert controller.update(observation(participant=2), 6).state == "acquiring"


def test_blink_holds_gaze_but_closes_lids():
    controller = copying()
    before = controller.last_gaze
    closed = observation(blink=1, valid=False)
    scene = controller.update(closed, 2.2)
    assert controller.last_gaze == before
    assert scene.pose.upper_left < 0.01
    assert scene.pose.lower_left < 0.01


def test_wink_and_separate_lid_positions():
    controller = copying()
    sample = observation()
    sample.packet["eyes"]["left"].update(openness=0, upper_lid=0, lower_lid=0)
    sample.packet["eyes"]["left"]["gaze_valid"] = False
    scene = controller.update(sample, 3)
    assert scene.pose.upper_left == pytest.approx(0, abs=0.001)
    assert scene.pose.upper_right == pytest.approx(1)
    assert scene.pose.lower_right == pytest.approx(0.5)


def test_display_mapping_does_not_modify_measurements():
    controller = copying()
    sample = observation()
    original = deepcopy(sample.packet)
    scene = controller.update(sample, 3)
    assert scene.pose.x == pytest.approx(-0.6, abs=0.01)
    assert scene.pose.y == pytest.approx(-0.2, abs=0.01)
    assert sample.packet == original


def test_low_detail_follows_face_and_camera_failure_resets_session():
    controller = copying()
    scene = controller.update(observation(detail=False), 3)
    assert scene.state == "following"
    assert scene.pose.x < 0
    assert controller.update(None, 4, camera_ok=False).state == "offline"
    assert controller.update(observation(), 5).state == "acquiring"


def test_new_participant_cannot_inherit_old_gaze():
    controller = copying()
    controller.update(observation(participant=2), 3)
    assert controller.last_gaze == (0, 0)
    assert controller.entered == 3


def test_gaze_speed_is_bounded():
    controller = copying()
    before = controller.pose.x
    sample = observation()
    for eye in sample.packet["eyes"].values():
        eye["iris_local"] = (-1, 0)
    scene = controller.update(sample, 2.01)
    assert abs(scene.pose.x - before) <= 0.030001


def face(center):
    points = [NS(x=center, y=0.5) for _ in range(478)]
    points[0], points[1] = NS(x=center - 0.15, y=0.3), NS(x=center + 0.15, y=0.7)
    for side, indices in EYES.items():
        cx = center + (0.07 if side == "left" else -0.07)
        for index, dx, dy in (
            (indices["corners"][0], -0.03, 0),
            (indices["corners"][1], 0.03, 0),
            (indices["upper"], 0, -0.01),
            (indices["lower"], 0, 0.01),
            (indices["iris"], 0, 0),
        ):
            points[index] = NS(x=cx + dx, y=0.5 + dy)
    return points


def result(*centers):
    return NS(
        face_landmarks=[face(c) for c in centers],
        face_blendshapes=[],
        facial_transformation_matrixes=[],
    )


def test_selection_survives_model_order_changes_and_waits_before_handoff():
    selector = ParticipantSelector()
    first = selector.select(result(0.5, 0.8), 0, 640, 480)
    next_frame = selector.select(result(0.8, 0.51), 0.1, 640, 480)
    assert first.participant == next_frame.participant
    assert next_frame.packet["face_center"][0] == pytest.approx(0.51)
    assert selector.select(result(0.8), 0.2, 640, 480) is None
    replacement = selector.select(result(0.8), 1.7, 640, 480)
    assert replacement.participant != first.participant


def test_small_eyes_fall_back_to_face_following():
    selector = ParticipantSelector()
    assert selector.select(result(0.5), 0, 640, 480).eye_detail
    assert not selector.select(result(0.5), 0.1, 320, 240).eye_detail


def test_missing_and_outside_faces_do_not_acquire():
    selector = ParticipantSelector()
    assert selector.select(result(), 0, 640, 480) is None
    assert selector.select(result(0.95), 1, 640, 480) is None


def test_renderer_handles_closed_and_open_eyes():
    open_image = render(Scene(Pose(), "idle", "Hello", "Step closer"))
    closed_image = render(Scene(Pose(upper_left=0, lower_left=0), "copying", "Hello", "Wink"))
    assert open_image.shape == (720, 1280, 3)
    assert open_image[300, 390].tolist() != closed_image[300, 390].tolist()


def test_imperfect_blink_score_closes_completely_without_waiting_for_smoothing():
    controller = copying()
    scene = controller.update(observation(blink=0.7, valid=False), 2.016)
    assert scene.pose.upper_left == scene.pose.lower_left == 0


def test_small_aperture_closes_even_without_blink_score():
    controller = copying()
    sample = observation()
    for eye in sample.packet["eyes"].values():
        eye.update(openness=None, upper_lid=-0.015, lower_lid=0.015, gaze_valid=False)
    scene = controller.update(sample, 2.016)
    assert scene.pose.upper_left == scene.pose.lower_left == 0


def test_closure_hysteresis_and_reopening():
    controller = copying()
    controller.update(observation(blink=0.7, valid=False), 2.016)
    scene = controller.update(observation(blink=0.45), 2.032)
    assert scene.pose.upper_left == 0
    controller.update(observation(blink=0.2), 2.1)
    controller.update(observation(blink=0.2), 2.17)
    scene = controller.update(observation(blink=0.2), 2.24)
    assert scene.pose.upper_left > 0


@pytest.mark.parametrize("opening", [0.0, 0.04])
def test_closed_eye_pixels_do_not_depend_on_hidden_iris_position(opening):
    import numpy as np

    first = render(Scene(Pose(x=-1, upper_left=opening, lower_left=opening), "copying", "", ""))
    second = render(Scene(Pose(x=1, upper_left=opening, lower_left=opening), "copying", "", ""))
    assert np.array_equal(first[200:490, 180:610], second[200:490, 180:610])


def test_echo_shows_past_pose_and_clears_on_participant_change():
    from eye_tracking.kiosk import MirrorReplay

    replay = MirrorReplay(1)
    closed = Scene(Pose(x=-0.8, upper_left=0, lower_left=0), "copying", "", "")
    opened = Scene(Pose(x=0.5), "copying", "", "")
    replay.present(closed, 0, 1)
    replay.present(opened, 0.5, 1)
    echoed = replay.present(opened, 1, 1)
    assert echoed.pose == closed.pose
    assert "1 seconds later" in echoed.title
    assert replay.present(opened, 1.1, 2).pose == opened.pose
    assert len(replay.history) == 1


def test_echo_clears_on_loss_and_live_mode_has_no_history():
    from eye_tracking.kiosk import MirrorReplay

    replay = MirrorReplay(1)
    scene = Scene(Pose(x=1), "copying", "", "")
    replay.present(scene, 0, 1)
    idle = Scene(Pose(), "idle", "", "")
    assert replay.present(idle, 1, None) == idle
    assert not replay.history
    replay.delay = 0
    assert replay.present(scene, 2, 1) == scene
    assert not replay.history


@pytest.mark.parametrize("closed_side,open_side", [("left", "right"), ("right", "left")])
def test_wink_does_not_close_other_eye_with_high_blink_score(closed_side, open_side):
    controller = copying()
    sample = observation()
    sample.packet["eyes"][closed_side].update(
        blink_score=0.9, openness=0.1, upper_lid=-0.02, lower_lid=0.01, gaze_valid=False
    )
    sample.packet["eyes"][open_side].update(blink_score=0.9, openness=0.1)
    scene = controller.update(sample, 2.016)
    assert getattr(scene.pose, f"upper_{closed_side}") == 0
    assert getattr(scene.pose, f"lower_{closed_side}") == 0
    assert getattr(scene.pose, f"upper_{open_side}") > 0.9
    assert getattr(scene.pose, f"lower_{open_side}") > 0.4


def test_open_geometry_releases_latch_even_if_blink_score_stays_high():
    controller = copying()
    controller.update(observation(blink=0.9, valid=False), 2.016)
    sample = observation()
    for eye in sample.packet["eyes"].values():
        eye.update(blink_score=0.8, openness=0.2)
    controller.update(sample, 2.1)
    controller.update(sample, 2.2)
    controller.update(sample, 2.3)
    scene = controller.update(sample, 2.4)
    assert scene.pose.upper_left > 0.8
    assert scene.pose.upper_right > 0.8


def test_single_false_open_frame_does_not_release_closed_eye():
    controller = copying()
    controller.update(observation(blink=0.9), 2.016)
    scene = controller.update(observation(), 2.05)
    assert scene.pose.upper_left == 0
    scene = controller.update(observation(blink=0.9), 2.08)
    assert scene.pose.upper_left == 0


def test_repeated_render_of_same_packet_cannot_confirm_reopening():
    controller = copying()
    controller.update(observation(blink=0.9), 2.016)
    sample = observation()
    sample.packet["timestamp_ms"] = 2050
    for now in (2.05, 2.1, 2.2, 2.3, 2.4):
        scene = controller.update(sample, now)
        assert scene.pose.upper_left == 0


def test_lost_detail_and_missing_eye_do_not_open_closed_eye():
    controller = copying()
    controller.update(observation(blink=0.9), 2.016)
    assert controller.update(observation(detail=False), 2.05).pose.upper_left == 0
    sample = observation()
    sample.packet["eyes"]["left"] = None
    assert controller.update(sample, 2.08).pose.upper_left == 0
    assert controller.update(None, 2.1).pose.upper_left == 0
    assert controller.update(None, 4).state == "goodbye"


def test_ambiguous_sample_resets_reopening_confirmation():
    from eye_tracking.kiosk import LidLatch

    latch = LidLatch(closed=True)
    assert latch.update(0.18, 0.1, 0)
    assert latch.update(0.18, 0.1, 0.08)
    assert latch.update(0.05, 0.45, 0.1)
    assert latch.update(0.18, 0.1, 0.15)
    assert latch.update(0.18, 0.1, 0.22)
    assert not latch.update(0.18, 0.1, 0.29)


def test_blink_detection_runs_even_when_gaze_detail_fails():
    controller = copying()
    sample = observation(detail=False, blink=0.9, valid=False)
    sample.packet["eyes"]["right"] = observation().packet["eyes"]["right"]
    scene = controller.update(sample, 2.016)
    assert scene.state == "following"
    assert scene.pose.upper_left == scene.pose.lower_left == 0
    assert scene.pose.upper_right > 0.9


def test_echo_does_not_discard_wink_when_gaze_detail_drops():
    from eye_tracking.kiosk import MirrorReplay

    replay = MirrorReplay(1)
    wink = Scene(Pose(upper_left=0, lower_left=0), "copying", "", "")
    fallback = Scene(Pose(), "following", "", "Come closer")
    replay.present(wink, 0, 1)
    replay.present(fallback, 0.2, 1)
    echoed = replay.present(fallback, 1, 1)
    assert echoed.pose.upper_left == 0
    assert echoed.prompt == "Come closer"

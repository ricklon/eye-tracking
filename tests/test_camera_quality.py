import numpy as np

from eye_tracking.camera_quality import assess_camera
from eye_tracking.kiosk import Observation
from eye_tracking.kiosk_app import Sample, camera_preview


def test_dark_and_overexposed_frames_offer_lighting_cues():
    dark = np.full((100, 100, 3), 20, dtype=np.uint8)
    bright = np.full_like(dark, 255)
    assert "more light" in assess_camera(dark, None).cue
    assert "harsh light" in assess_camera(bright, None).cue


def test_quality_measures_selected_face_instead_of_bright_background():
    frame = np.full((100, 100, 3), 255, dtype=np.uint8)
    frame[20:81, 20:81] = 20
    observation = Observation({}, True, 1, (0.2, 0.2, 0.8, 0.8))
    quality = assess_camera(frame, observation)
    assert quality.region == "face"
    assert quality.brightness == 20
    assert "more light" in quality.cue


def test_positioning_cue_and_found_face_are_not_accuracy_claims():
    frame = np.tile(np.arange(40, 220, dtype=np.uint8)[None, :, None], (100, 1, 3))
    assert "middle" in assess_camera(frame, None).cue
    assert "closer" in assess_camera(frame, Observation({}, False, 1)).cue
    assert "Face found" in assess_camera(frame, Observation({}, True, 1)).cue


def test_preview_mirrors_without_mutating_camera_frame():
    frame = np.zeros((132, 236, 3), dtype=np.uint8)
    frame[:, :118] = (20, 50, 200)
    original = frame.copy()
    preview = camera_preview(Sample(None, 0, True, frame=frame))
    assert np.array_equal(frame, original)
    assert preview[50, 200].tolist() == [20, 50, 200]
    assert preview[50, 20].tolist() == [0, 0, 0]


def test_preview_letterboxes_and_handles_missing_camera():
    frame = np.full((100, 100, 3), 80, dtype=np.uint8)
    preview = camera_preview(Sample(None, 0, True, frame=frame))
    assert preview.shape == (132, 236, 3)
    assert np.all(preview[:, :52] == 0)
    assert preview[60, 118].tolist() == [80, 80, 80]
    assert camera_preview(None).shape == preview.shape

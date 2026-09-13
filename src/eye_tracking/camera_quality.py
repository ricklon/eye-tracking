"""Image-based positioning cues, not eye-tracking confidence estimates."""

from dataclasses import dataclass

import cv2
import numpy as np

from eye_tracking.kiosk import Observation


@dataclass(frozen=True)
class CameraQuality:
    cue: str
    brightness: float
    contrast: float
    clipped_fraction: float
    region: str


def assess_camera(frame: np.ndarray, observation: Observation | None) -> CameraQuality:
    height, width = frame.shape[:2]
    region = frame
    region_name = "image"
    if observation and observation.face_bounds:
        x0, y0, x1, y1 = observation.face_bounds
        left, right = max(0, int(x0 * width)), min(width, int(x1 * width) + 1)
        top, bottom = max(0, int(y0 * height)), min(height, int(y1 * height) + 1)
        if right > left and bottom > top:
            region = frame[top:bottom, left:right]
            region_name = "face"
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    brightness = float(np.median(gray))
    contrast = float(np.percentile(gray, 95) - np.percentile(gray, 5))
    clipped = float(np.mean(gray >= 250))
    if brightness < 45:
        cue = "Try more light in front of your face"
    elif clipped > 0.20:
        cue = "Try moving away from harsh light"
    elif contrast < 18:
        cue = "Image looks flat - check light and camera"
    elif observation is None:
        cue = "Step into the middle so I can find your face"
    elif not observation.eye_detail:
        cue = "Come closer and face the camera"
    else:
        cue = "Face found - try a slow wink"
    return CameraQuality(cue, brightness, contrast, clipped, region_name)

"""Cross-language contract checks; Node is required for the browser implementation."""

import json
import shutil
import subprocess
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace as NS
from urllib.error import HTTPError
from urllib.request import urlopen

import numpy as np
import pytest
from test_measurements import landmarks

from eye_tracking.measurements import make_packet
from eye_tracking.web import ASSETS, DashboardHandler


@pytest.mark.parametrize("angle,scale,closed", [(0, 1, False), (0.6, 1, False), (-0.3, 2, True)])
def test_browser_packet_matches_python(angle, scale, closed):
    assert shutil.which("node"), "Install Node.js to verify the browser measurement contract"
    points = landmarks(angle, scale, closed)
    # Different anatomical blink scores detect accidental side swaps.
    scores = [
        NS(category_name="eyeBlinkLeft", score=0.9),
        NS(category_name="eyeBlinkRight", score=0.1),
    ]
    matrix = np.arange(16, dtype=float).reshape(4, 4)
    result = NS(
        face_landmarks=[points], face_blendshapes=[scores], facial_transformation_matrixes=[matrix]
    )
    browser_result = {
        "faceLandmarks": [[vars(p) for p in points]],
        "faceBlendshapes": [
            {"categories": [{"categoryName": s.category_name, "score": s.score} for s in scores]}
        ],
        "facialTransformationMatrixes": [
            {"rows": 4, "columns": 4, "data": matrix.flatten(order="F").tolist()}
        ],
    }
    script = f"""
        import {{makePacket}} from {json.dumps((ASSETS / "measurements.mjs").as_uri())};
        let input = ''; for await (const part of process.stdin) input += part;
        console.log(JSON.stringify(makePacket(JSON.parse(input), 123, 640, 480)));
    """
    output = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(browser_result),
        text=True,
        capture_output=True,
        check=True,
    )
    actual = json.loads(output.stdout)
    expected = json.loads(json.dumps(make_packet(result, 123, 640, 480)))
    for side in ("left", "right"):
        for key, value in expected["eyes"][side].items():
            assert actual["eyes"][side][key] == pytest.approx(value)
    actual.pop("eyes")
    expected.pop("eyes")
    assert actual == expected


def test_browser_controller_contracts():
    assert shutil.which("node"), "Install Node.js to verify browser behavior"
    tests = sorted(str(path) for path in Path(__file__).parent.glob("*.test.mjs"))
    assert tests, "no browser tests found"
    subprocess.run(["node", "--test", *tests], check=True)


def test_server_serves_only_app_assets():
    handler = partial(DashboardHandler, directory=str(ASSETS))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urlopen(base) as response:
                assert b"Eye studio" in response.read()
            with urlopen(base + "/app.mjs") as response:
                assert response.headers.get_content_type() == "text/javascript"
            with pytest.raises(HTTPError) as error:
                urlopen(base + "/../pyproject.toml")
            assert error.value.code == 404
        finally:
            server.shutdown()
            thread.join()

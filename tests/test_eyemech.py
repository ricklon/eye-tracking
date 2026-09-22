import json
import queue
import socket
from functools import partial
from http.server import ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace as NS
from urllib.request import urlopen

import pytest
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect
from websockets.sync.server import serve

from eye_tracking.eyemech import Board, board_uri, dashboard_origins, parse_message, serve_bridge
from eye_tracking.web import ASSETS, DashboardHandler

POSE = {"lr": 0.5, "ud": 0.25, "lid_tl": 1, "lid_bl": 1, "lid_tr": 0, "lid_br": 0.5}
ORIGIN = "http://127.0.0.1:8080"


def test_parse_message_accepts_only_the_follow_schema():
    assert parse_message(json.dumps(POSE))["lid_tl"] == 1.0
    assert parse_message('{"stop": true}') == {"stop": True}
    for bad in (
        "not json",
        "[]",
        json.dumps({**POSE, "extra": 1}),
        json.dumps({k: v for k, v in POSE.items() if k != "ud"}),
        json.dumps({**POSE, "lr": 1.5}),
        json.dumps({**POSE, "lr": True}),
        json.dumps({**POSE, "lr": "0.5"}),
        '{"stop": false}',
    ):
        with pytest.raises(ValueError):
            parse_message(bad)


def test_board_uri_and_origins():
    assert board_uri("eyemech.local") == "ws://eyemech.local/ws/pose"
    assert board_uri("10.0.0.5:8080") == "ws://10.0.0.5:8080/ws/pose"
    assert board_uri("ws://b/ws/pose") == "ws://b/ws/pose"
    assert dashboard_origins("0.0.0.0", 8080) == [
        "http://127.0.0.1:8080",
        "http://localhost:8080",
    ]


def start(server):
    Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def board():
    """A fake board: records messages and refuses a pose with lr == 0.123."""
    received = queue.Queue()

    def handler(ws):
        for text in ws:
            message = json.loads(text)
            received.put(message)
            if message.get("lr") == 0.123:
                ws.send(json.dumps({"error": "not accepting poses"}))

    server = start(serve(handler, "127.0.0.1", 0))
    yield NS(received=received, host=f"127.0.0.1:{server.socket.getsockname()[1]}")
    server.shutdown()


@pytest.fixture
def bridge(board):
    server = start(serve_bridge(board.host, "127.0.0.1", 0, [ORIGIN]))
    yield f"ws://127.0.0.1:{server.socket.getsockname()[1]}"
    server.shutdown()


def test_bridge_relays_poses_errors_and_stops_on_disconnect(board, bridge):
    with connect(bridge, origin=ORIGIN) as ws:
        assert "bridge ready" in json.loads(ws.recv(timeout=2))["status"]
        ws.send(json.dumps(POSE))
        assert board.received.get(timeout=2) == {k: float(v) for k, v in POSE.items()}
        ws.send(json.dumps({**POSE, "lr": 1.5}))
        assert "0..1" in json.loads(ws.recv(timeout=2))["error"]
        ws.send(json.dumps({**POSE, "lr": 0.123}))
        board.received.get(timeout=2)
        # The board's refusal arrives after the send; the next pose carries it back.
        reply = None
        for _ in range(20):
            ws.send(json.dumps(POSE))
            board.received.get(timeout=2)
            try:
                reply = json.loads(ws.recv(timeout=0.05))
                break
            except TimeoutError:
                pass
        assert reply == {"error": "not accepting poses"}
    assert board.received.get(timeout=2) == {"stop": True}


def test_board_connection_disables_nagle(board):
    upstream = Board(board_uri(board.host))
    try:
        upstream.send({"stop": True})
        sock = upstream.connection.socket
        assert sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY)
    finally:
        upstream.close()


def test_bridge_refuses_other_origins_and_a_second_driver(bridge):
    with pytest.raises(InvalidStatus):
        connect(bridge, origin="https://example.com")
    with connect(bridge, origin=ORIGIN) as first:
        first.recv(timeout=2)
        with connect(bridge, origin=ORIGIN) as second:
            assert "already driving" in json.loads(second.recv(timeout=2))["error"]


def test_bridge_reports_an_unreachable_board():
    server = start(serve_bridge("127.0.0.1:9", "127.0.0.1", 0, [ORIGIN]))
    try:
        with connect(f"ws://127.0.0.1:{server.socket.getsockname()[1]}", origin=ORIGIN) as ws:
            ws.recv(timeout=2)
            ws.send(json.dumps(POSE))
            assert "unreachable" in json.loads(ws.recv(timeout=5))["error"]
    finally:
        server.shutdown()


def test_dashboard_advertises_bridge_only_when_running():
    for bridge in (None, {"port": 8766, "board": "ws://eyemech.local/ws/pose"}):
        handler = partial(DashboardHandler, directory=str(ASSETS), bridge=bridge)
        with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
            Thread(target=server.serve_forever, daemon=True).start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/bridge.json"
                if bridge is None:
                    with pytest.raises(OSError):
                        urlopen(url)
                else:
                    with urlopen(url) as response:
                        assert json.load(response) == bridge
            finally:
                server.shutdown()

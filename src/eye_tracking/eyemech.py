"""Local bridge from the browser dashboard to eyemech follow mode (``/ws/pose``).

The board refuses cross-origin browser WebSockets, and a native sender must disable
Nagle's algorithm or poses arrive in bursts. This relays validated poses unchanged: the
browser already sends mechanism units, so no mapping or calibration happens here.

Pose messages use the firmware's schema: ``lr``, ``ud``, ``lid_tl``, ``lid_bl``,
``lid_tr``, ``lid_br``, each 0..1, or ``{"stop": true}``. The bridge replies with
``{"status": ...}`` or ``{"error": ...}`` text frames; accepted poses get no reply.
"""

import json
import math
import socket
import threading
import time

from websockets.exceptions import ConnectionClosed, WebSocketException
from websockets.sync.client import connect
from websockets.sync.server import serve

POSE_KEYS = frozenset({"lr", "ud", "lid_tl", "lid_bl", "lid_tr", "lid_br"})
RECONNECT_S = 1.0


def parse_message(text):
    """Return a pose dict or ``{"stop": True}``; raise ValueError for anything else."""
    try:
        message = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise ValueError("bad json") from exc
    if message == {"stop": True}:
        return message
    if not isinstance(message, dict) or set(message) != POSE_KEYS:
        raise ValueError(f"need exactly {', '.join(sorted(POSE_KEYS))}")
    for key, value in message.items():
        number = isinstance(value, int | float) and not isinstance(value, bool)
        if not (number and math.isfinite(value) and 0 <= value <= 1):
            raise ValueError(f"{key} must be a number 0..1")
    return {key: float(value) for key, value in message.items()}


def board_uri(board):
    """Accept ``host``, ``host:port`` or a full ``ws://`` URI."""
    if "://" in board:
        return board
    return f"ws://{board}/ws/pose"


def dashboard_origins(host, port):
    hosts = {host, "127.0.0.1", "localhost"} - {"", "0.0.0.0", "::"}
    return sorted(f"http://{h}:{port}" for h in hosts)


class Board:
    """One upstream connection to the mechanism, reopened lazily after failures."""

    def __init__(self, uri):
        self.uri = uri
        self.connection = None
        self.failed_at = -math.inf

    def _open(self):
        if self.connection is not None:
            return self.connection
        if time.monotonic() - self.failed_at < RECONNECT_S:
            raise ConnectionError(f"board unreachable at {self.uri}")
        try:
            # The board's httpd does not need pings; a missed pong would drop the stream.
            connection = connect(
                self.uri, compression=None, proxy=None, open_timeout=3, ping_interval=None
            )
        except (OSError, WebSocketException) as exc:
            self.failed_at = time.monotonic()
            raise ConnectionError(f"board unreachable at {self.uri}: {exc}") from exc
        connection.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.connection = connection
        return connection

    def send(self, message):
        """Forward one message; return board error texts received since the last send."""
        connection = self._open()
        try:
            connection.send(json.dumps(message))
            replies = []
            while True:
                try:
                    replies.append(connection.recv(timeout=0))
                except TimeoutError:
                    return replies
        except (OSError, WebSocketException) as exc:
            self.close()
            self.failed_at = time.monotonic()
            raise ConnectionError(f"lost the board: {exc}") from exc

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None


class Bridge:
    """Accepts one dashboard at a time, so two tabs cannot interleave poses."""

    def __init__(self, board):
        self.board = Board(board_uri(board))
        self.driver = threading.Lock()

    def handle(self, client):
        if not self.driver.acquire(blocking=False):
            client.send(json.dumps({"error": "another dashboard is already driving"}))
            return
        try:
            client.send(json.dumps({"status": f"bridge ready for {self.board.uri}"}))
            for text in client:
                try:
                    message = parse_message(text)
                    replies = self.board.send(message)
                except (ValueError, ConnectionError) as exc:
                    client.send(json.dumps({"error": str(exc)}))
                    continue
                for reply in replies:
                    client.send(reply)
        except ConnectionClosed:
            pass
        finally:
            # Ease to neutral now rather than after the board's one-second timeout.
            try:
                self.board.send({"stop": True})
            except ConnectionError:
                pass
            self.board.close()
            self.driver.release()


def serve_bridge(board, host, port, origins):
    """Return a websockets server; call ``serve_forever()`` and ``shutdown()`` on it."""
    bridge = Bridge(board)
    return serve(bridge.handle, host, port, origins=origins, compression=None)

"""Serve the browser application; camera capture and inference stay in the browser."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

ASSETS = Path(__file__).with_name("static")


class DashboardHandler(SimpleHTTPRequestHandler):
    extensions_map: ClassVar = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
    }

    def list_directory(self, path):
        self.send_error(404)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def run_web(args):
    if not 1 <= args.port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    handler = partial(DashboardHandler, directory=str(ASSETS))
    with ThreadingHTTPServer((args.host, args.port), handler) as server:
        print(f"Eye studio: http://{args.host}:{args.port}", flush=True)
        print("Camera runs in your browser. Other devices need an HTTPS origin.", flush=True)
        server.serve_forever()

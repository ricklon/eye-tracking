"""Serve the browser application; camera capture and inference stay in the browser."""

import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import ClassVar

ASSETS = Path(__file__).with_name("static")


class DashboardHandler(SimpleHTTPRequestHandler):
    extensions_map: ClassVar = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
    }

    def __init__(self, *args, bridge=None, **kwargs):
        self.bridge = bridge
        super().__init__(*args, **kwargs)

    def do_GET(self):
        # Tells the page whether a mechanism bridge is running; 404 means software only.
        if self.path.split("?")[0] == "/bridge.json" and self.bridge:
            body = json.dumps(self.bridge).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def run_web(args):
    for port in (args.port, args.bridge_port):
        if not 1 <= port <= 65535:
            raise ValueError("port must be between 1 and 65535")
    bridge = None
    if args.eyemech:
        from eye_tracking.eyemech import board_uri, dashboard_origins, serve_bridge

        bridge_server = serve_bridge(
            args.eyemech, args.host, args.bridge_port, dashboard_origins(args.host, args.port)
        )
        Thread(target=bridge_server.serve_forever, daemon=True).start()
        bridge = {"port": args.bridge_port, "board": board_uri(args.eyemech)}
    handler = partial(DashboardHandler, directory=str(ASSETS), bridge=bridge)
    with ThreadingHTTPServer((args.host, args.port), handler) as server:
        print(f"Eye studio: http://{args.host}:{args.port}", flush=True)
        print("Camera runs in your browser. Other devices need an HTTPS origin.", flush=True)
        if bridge:
            print(
                f"Mechanism bridge: ws://{args.host}:{args.bridge_port} → {bridge['board']}",
                flush=True,
            )
        server.serve_forever()

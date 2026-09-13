# Works on Windows, macOS, and Linux. Recipes only call uv, so the shell just
# needs to launch it: sh on macOS/Linux, Windows PowerShell on Windows.
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Start the browser dashboard (primary interface)
default: web

# Install Python and dependencies
setup:
    uv sync

# Serve the browser dashboard at http://127.0.0.1:8080
web *args:
    uv run eye-tracking web {{args}}

# Only needed for the Python desktop tools (run, kiosk)
download-model:
    uv run eye-tracking download-model

# Python webcam tracker with OpenCV preview
run *args:
    uv run eye-tracking run {{args}}

# Python desktop kiosk
kiosk *args:
    uv run eye-tracking kiosk {{args}}

test:
    uv run pytest

lint:
    uv run ruff check .
    uv run ruff format --check .

format:
    uv run ruff format .

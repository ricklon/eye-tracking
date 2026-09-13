default:
    @just --list

setup:
    uv sync
    uv run eye-tracking download-model

run *args:
    uv run eye-tracking run {{args}}

test:
    uv run pytest

lint:
    uv run ruff check .
    uv run ruff format --check .

format:
    uv run ruff format .

kiosk *args:
    uv run eye-tracking kiosk {{args}}

web *args:
    uv run eye-tracking web {{args}}

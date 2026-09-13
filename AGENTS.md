# Project scope

This is a standalone Python/uv MediaPipe eye-tracking project. Primary requirements
are per-eye iris position and separate upper/lower lid measurements. Future work
will animate the sibling eyemech-esp32-xiao project.

- Keep measurements independent of hardware transport and servo calibration.
- Use MediaPipe Tasks Face Landmarker; preserve anatomical left/right labels.
- Mirror only the display, never silently change exported coordinate conventions.
- Preserve explicit face-loss and invalid-gaze semantics. Version schema changes.
- Keep raw measurements available when introducing calibration or smoothing.
- See docs/eyemech.md before integrating hardware; source there is ahead of its README.
- Use uv; keep uv.lock current. Verify relevant changes with pytest and ruff.

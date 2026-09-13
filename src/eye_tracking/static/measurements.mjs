// Schema v1, matching measurements.py. Input is always the original camera image.
export const EYES = {
  left: { corners: [362, 263], upper: 386, lower: 374, iris: 473 },
  right: { corners: [33, 133], upper: 159, lower: 145, iris: 468 },
};
export const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
export function hasEyeDetail(points, width, height) {
  if (!points || points.length < 478) return false;
  const spans = Object.values(EYES).map(({ corners: [a, b] }) =>
    Math.hypot(
      (points[b].x - points[a].x) * width,
      (points[b].y - points[a].y) * height,
    ),
  );
  return (
    Math.min(...spans) >= 22 && Math.min(...spans) / Math.max(...spans) > 0.65
  );
}
export function measureEye(points, indices, width, height, score = null) {
  const pixel = (i) => [points[i].x * width, points[i].y * height];
  const [a, b] = indices.corners.map(pixel);
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    span = Math.hypot(dx, dy);
  if (span < 1e-6) return null;
  const ux = dx / span,
    uy = dy / span;
  const local = (i) => {
    const p = pixel(i),
      x = p[0] - (a[0] + b[0]) / 2,
      y = p[1] - (a[1] + b[1]) / 2;
    return [(x * ux + y * uy) / span, (-x * uy + y * ux) / span];
  };
  const upper = local(indices.upper)[1],
    lower = local(indices.lower)[1];
  const aperture = Math.max(0, lower - upper),
    blink = score === null ? null : clamp(score);
  return {
    iris_image: [points[indices.iris].x, points[indices.iris].y],
    iris_local: local(indices.iris),
    upper_lid: upper,
    lower_lid: lower,
    aperture,
    blink_score: blink,
    openness: blink === null ? null : 1 - blink,
    gaze_valid: aperture > 0.03 && (blink === null || blink < 0.5),
  };
}
export function makePacket(result, timestamp, width, height) {
  const packet = {
    schema_version: 1,
    timestamp_ms: Math.floor(timestamp),
    image_size: [width, height],
    face_present: false,
    face_center: null,
    face_transform: null,
    eyes: null,
  };
  const points = result.faceLandmarks?.[0];
  if (!points || points.length < 478) return packet;
  const scores = Object.fromEntries(
    (result.faceBlendshapes?.[0]?.categories ?? []).map((x) => [
      x.categoryName,
      x.score,
    ]),
  );
  packet.face_present = true;
  packet.eyes = Object.fromEntries(
    Object.entries(EYES).map(([side, indices]) => [
      side,
      measureEye(
        points,
        indices,
        width,
        height,
        scores[`eyeBlink${side[0].toUpperCase()}${side.slice(1)}`] ?? null,
      ),
    ]),
  );
  packet.face_center = ["x", "y"].map((axis) => {
    const values = points.map((p) => p[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  });
  const matrix = result.facialTransformationMatrixes?.[0];
  if (matrix) {
    // MediaPipe JS exposes packed column-major data; Python exposes nested rows.
    packet.face_transform = Array.from({ length: matrix.rows }, (_, row) =>
      Array.from(
        { length: matrix.columns },
        (_, column) => matrix.data[column * matrix.rows + row],
      ),
    );
  }
  return packet;
}

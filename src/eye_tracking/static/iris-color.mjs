// A camera-color heuristic, not pigment measurement or a MediaPipe classification.
// Uses the four iris rim points following each iris center in the 478-point model.
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
export function colorFamily([r, g, b]) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  if (delta < 12 || delta / max < 0.14) return "Gray-like";
  let hue =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 65 || hue > 345)
    return max < 150 ? "Brown-like" : "Amber / light brown-like";
  if (hue < 165) return "Green / hazel-like";
  if (hue < 270) return "Blue / gray-like";
  return "Mixed / unclear";
}
export function estimateIrisColor(image, points, indices, eye) {
  const unavailable = (reason) => ({
    status: "unavailable",
    reason,
    hex: null,
    label: null,
  });
  if (
    !eye ||
    !eye.gaze_valid ||
    eye.aperture < 0.1 ||
    (eye.blink_score !== null && eye.blink_score > 0.35)
  )
    return unavailable("Open this eye and look toward the camera.");
  if (!points || points.length < 478)
    return unavailable("Iris landmarks unavailable.");
  const { width, height, data } = image;
  const pixel = (i) => [points[i].x * width, points[i].y * height];
  const [a, b] = indices.corners.map(pixel),
    center = pixel(indices.iris);
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    span = Math.hypot(dx, dy);
  if (span < 1) return unavailable("Eye detail is too small.");
  const ux = dx / span,
    uy = dy / span;
  const local = (x, y) => [
    (x - center[0]) * ux + (y - center[1]) * uy,
    -(x - center[0]) * uy + (y - center[1]) * ux,
  ];
  const rim = [1, 2, 3, 4].map((i) => local(...pixel(indices.iris + i)));
  const rx = Math.max(...rim.map((p) => Math.abs(p[0]))),
    ry = Math.max(...rim.map((p) => Math.abs(p[1])));
  if (!Number.isFinite(rx + ry) || Math.min(rx, ry) < 6)
    return unavailable("Come closer: the iris needs more pixels.");
  if (Math.min(rx, ry) / Math.max(rx, ry) < 0.6)
    return unavailable("Face the camera more directly.");
  const radius = Math.max(rx, ry);
  if (
    center[0] - radius < 0 ||
    center[1] - radius < 0 ||
    center[0] + radius >= width ||
    center[1] + radius >= height
  )
    return unavailable("Keep the whole eye inside the image.");
  const upper = pixel(indices.upper),
    lower = pixel(indices.lower);
  const upperY = local(...upper)[1] + 1,
    lowerY = local(...lower)[1] - 1;
  const channels = [[], [], []];
  let candidates = 0;
  for (
    let y = Math.floor(center[1] - radius);
    y <= Math.ceil(center[1] + radius);
    y++
  ) {
    for (
      let x = Math.floor(center[0] - radius);
      x <= Math.ceil(center[0] + radius);
      x++
    ) {
      const [ex, ey] = local(x + 0.5, y + 0.5),
        r = Math.hypot(ex / rx, ey / ry);
      // Middle/outer iris ring, inside the visible lid gap. Avoid the pupil and rim.
      if (r < 0.6 || r > 0.85 || ey < upperY || ey > lowerY) continue;
      candidates++;
      const offset = (y * width + x) * 4,
        rgb = [data[offset], data[offset + 1], data[offset + 2]];
      if (
        Math.max(...rgb) < 45 ||
        Math.max(...rgb) > 245 ||
        Math.min(...rgb) > 210
      )
        continue;
      rgb.forEach((v, i) => channels[i].push(v));
    }
  }
  const count = channels[0].length;
  if (count < 16 || count < 0.3 * candidates)
    return unavailable(
      "Too little clear iris color: try softer front lighting.",
    );
  const rgb = channels.map(median);
  const spread = channels.map((values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(count * 0.75)] - sorted[Math.floor(count * 0.25)];
  });
  if (Math.max(...spread) > 70)
    return unavailable(
      "Color varies too much: check glare, focus, and lighting.",
    );
  return {
    status: "estimated",
    hex: "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""),
    label: colorFamily(rgb),
    samples: count,
    reason:
      "Visible color estimate; lighting and camera processing can change it.",
  };
}

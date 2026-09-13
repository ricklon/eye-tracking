import test from "node:test";
import assert from "node:assert/strict";
import {
  EyeController,
  LidLatch,
} from "../src/eye_tracking/static/controller.mjs";
import {
  makePacket,
  measureEye,
  EYES,
} from "../src/eye_tracking/static/measurements.mjs";
const eye = {
  iris_local: [0.1, 0.05],
  upper_lid: -0.1,
  lower_lid: 0.1,
  aperture: 0.2,
  blink_score: 0.1,
  gaze_valid: true,
};
const packet = (t) => ({
  timestamp_ms: t,
  face_present: true,
  face_center: [0.5, 0.5],
  eyes: { left: { ...eye }, right: { ...eye } },
});
test("face loss clears measurements and degenerate eye stays null", () => {
  const p = makePacket({}, 10, 640, 480);
  assert.equal(p.face_present, false);
  assert.equal(p.eyes, null);
  assert.equal(p.face_transform, null);
  assert.equal(
    measureEye(
      Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 })),
      EYES.left,
      640,
      480,
    ),
    null,
  );
});
test("repeated redraws cannot reopen a closed lid", () => {
  const latch = new LidLatch();
  assert.equal(latch.update({ ...eye, aperture: 0 }, 0), true);
  for (let i = 0; i < 10; i++) assert.equal(latch.update(eye, 20), true);
  let t = 20;
  while (latch.update(eye, (t += 33)) && t < 1000);
  assert.ok(t >= 150 && t <= 300, `reopened after ${t} ms`);
});
test("held closed eye ignores brief noisy open-looking frames", () => {
  const latch = new LidLatch();
  const closed = { ...eye, aperture: 0.07, blink_score: 0.7 };
  const noisy = [
    { ...eye, aperture: 0.13, blink_score: 0.6 },
    { ...eye, aperture: 0.09, blink_score: 0.3 },
    { ...eye, aperture: 0.2, blink_score: 0.25 },
  ];
  let t = 0;
  for (let i = 0; i < 30; i++) latch.update(eye, (t += 33));
  for (let i = 0; i < 5; i++) latch.update(closed, (t += 33));
  assert.equal(latch.closed, true);
  for (let i = 0; i < 300; i++) {
    const sample = i % 7 === 3 ? noisy[i % 3] : closed;
    assert.equal(latch.update(sample, (t += 33)), true, `frame ${i}`);
    assert.equal(latch.display(), 0);
  }
});
test("partial closure is shown, open gap reopens despite high blink score", () => {
  const latch = new LidLatch();
  let t = 0;
  for (let i = 0; i < 30; i++) latch.update(eye, (t += 33));
  assert.ok(latch.display() > 0.95);
  for (let i = 0; i < 10; i++)
    latch.update({ ...eye, aperture: 0.12, blink_score: 0.45 }, (t += 33));
  assert.equal(latch.closed, false);
  assert.ok(latch.display(1.6) < latch.display(1) && latch.display(1) < 0.9);
  for (let i = 0; i < 10; i++)
    latch.update({ ...eye, aperture: 0, blink_score: 1 }, (t += 33));
  assert.equal(latch.closed, true);
  for (let i = 0; i < 15; i++)
    latch.update({ ...eye, aperture: 0.22, blink_score: 0.9 }, (t += 33));
  assert.equal(latch.closed, false);
});
test("closure affects one anatomical side and invalid gaze holds", () => {
  const c = new EyeController();
  c.setDelay(0);
  c.update(packet(0), 0, true);
  c.update(packet(1700), 1700, true);
  const p = packet(1750);
  p.eyes.left = { ...eye, aperture: 0, blink_score: 1, gaze_valid: false };
  p.eyes.right = { ...eye, gaze_valid: false };
  c.update(p, 1750, true);
  p.timestamp_ms = 1850;
  const scene = c.update(p, 1850, true);
  assert.ok(c.lids.left.closed && !c.lids.right.closed);
  assert.ok(scene.pose.upper_left < 0.05);
  assert.ok(scene.pose.lower_left < 0.05);
  assert.ok(scene.pose.upper_right > 0.9);
  assert.deepEqual(c.gaze, [-0.5, 0.25]);
  assert.deepEqual(p.eyes.left.iris_local, [0.1, 0.05]);
});
// Rotation about camera y: positive turns the face's forward axis toward image right.
const yawed = (t, degrees, pitchDegrees = 0) => {
  const a = (degrees * Math.PI) / 180,
    b = (pitchDegrees * Math.PI) / 180;
  const p = packet(t);
  for (const s of ["left", "right"]) p.eyes[s].iris_local = [0, 0.05];
  p.face_transform = [
    [Math.cos(a), 0, Math.sin(a) * Math.cos(b), 0],
    [0, 1, Math.sin(b), 0],
    [-Math.sin(a), 0, Math.cos(a) * Math.cos(b), -40],
    [0, 0, 0, 1],
  ];
  return p;
};
test("head turn moves the mirrored eyes the same way, even with eyes still", () => {
  for (const [degrees, sign] of [
    [25, -1],
    [-25, 1],
  ]) {
    const c = new EyeController();
    c.setDelay(0);
    c.update(yawed(0, 0), 0, true);
    let pose;
    for (let t = 1700; t < 2700; t += 33)
      pose = c.update(yawed(t, degrees), t, true).pose;
    const still = new EyeController();
    still.setDelay(0);
    still.update(yawed(0, 0), 0, true);
    let base;
    for (let t = 1700; t < 2700; t += 33)
      base = still.update(yawed(t, 0), t, true).pose;
    assert.ok(sign * (pose.x - base.x) > 0.6, `x ${pose.x} vs ${base.x}`);
  }
  const c = new EyeController();
  c.setDelay(0);
  c.update(yawed(0, 0), 0, true);
  let pose;
  for (let t = 1700; t < 2700; t += 33)
    pose = c.update(yawed(t, 0, 20), t, true).pose;
  assert.ok(pose.y < -0.1, "looking up moves eyes up");
  c.headGain = 0;
  for (let t = 2700; t < 3700; t += 33)
    pose = c.update(yawed(t, 0, 20), t, true).pose;
  assert.ok(Math.abs(pose.y - 0.25) < 0.01, "gain 0 ignores the head");
});
test("head turn still steers while gaze is invalid", () => {
  const c = new EyeController();
  c.setDelay(0);
  c.update(yawed(0, 0), 0, true);
  for (let t = 1700; t < 2000; t += 33) c.update(yawed(t, 0), t, true);
  const before = c.gaze[0];
  let t = 2000;
  for (; t < 3000; t += 33) {
    const p = yawed(t, 25);
    for (const s of ["left", "right"]) p.eyes[s].gaze_valid = false;
    c.update(p, t, true);
  }
  assert.ok(c.gaze[0] < before - 0.6);
});
test("stale camera clears replay; departure resets and reacquires", () => {
  const c = new EyeController();
  c.update(packet(0), 0, true);
  c.update(packet(1700), 1700, true);
  assert.ok(c.history.length);
  assert.equal(c.update(packet(1700), 3000, true).state, "offline");
  assert.equal(c.history.length, 0);
  assert.equal(c.update(packet(3100), 3100, true).state, "greeting");
  assert.equal(
    c.update(makePacket({}, 5000, 640, 480), 5000, true).state,
    "idle",
  );
});
test("changing delay resets bounded echo history", () => {
  const c = new EyeController();
  c.update(packet(0), 0, true);
  for (let t = 1600; t < 10000; t += 16) c.update(packet(t), t, true);
  assert.ok(c.history.length < 200);
  c.setDelay(0);
  assert.equal(c.history.length, 0);
  assert.throws(() => c.setDelay(NaN));
  assert.throws(() => c.setDelay(3100));
});
test("insufficient eye detail follows face position instead of iris noise", () => {
  const c = new EyeController();
  c.setDelay(0);
  c.update(packet(0), 0, true, false);
  const p = packet(1700);
  p.face_center = [0.6, 0.4];
  const scene = c.update(p, 1700, true, false);
  assert.equal(scene.state, "following");
  assert.ok(Math.abs(c.gaze[0] + 0.25) < 1e-10);
  assert.ok(Math.abs(c.gaze[1] + 0.25) < 1e-10);
  assert.deepEqual(p.eyes.left.iris_local, [0.1, 0.05]);
});

// Exploration reports observations and visitor feedback separately.
import {
  EyeInspector,
  ChallengeSession,
} from "../src/eye_tracking/static/explore.mjs";
const inspectStatus = (left = "Open", right = "Open") => ({
  fresh: true,
  face: true,
  left,
  right,
});
function armed(id = "blink") {
  const c = new ChallengeSession();
  c.start(id);
  for (let t = 0; t <= 400; t += 100)
    c.update(packet(t), inspectStatus(), true);
  assert.equal(c.current.phase, "action");
  return c;
}
test("inspection handles disagreement, null eyes and stale frames explicitly", () => {
  const i = new EyeInspector();
  const p = packet(0);
  p.eyes.left = { ...eye, blink_score: 0.9 };
  p.eyes.right = null;
  assert.equal(i.update(p, 0, true).left, "Uncertain");
  assert.equal(i.update(p, 0, true).right, "Unavailable");
  assert.equal(i.update(p, 751, true).left, "Unavailable");
  assert.equal(i.update(p, 751, true).face, false);
});
test("challenge requires fresh distinct open samples before closure", () => {
  const c = new ChallengeSession();
  c.start("blink");
  for (let t = 0; t <= 1000; t += 100)
    c.update(packet(t), inspectStatus("Closed", "Closed"), true);
  assert.equal(c.current.phase, "prepare");
  assert.equal(c.current.observed, false);
  for (let n = 0; n < 20; n++) c.update(packet(1100), inspectStatus(), true);
  assert.equal(c.current.phase, "prepare");
});
test("blink evidence survives for review and never auto-confirms visitor feedback", () => {
  const c = armed();
  c.update(packet(500), inspectStatus("Closed", "Closed"), true);
  assert.equal(c.current.phase, "reopen");
  assert.equal(c.current.observed, false);
  c.update(packet(600), inspectStatus(), true);
  assert.equal(c.current.observed, true);
  assert.equal(c.attempts.length, 0);
  c.review("mismatch");
  const a = c.report().attempts[0];
  assert.equal(a.system_observed, true);
  assert.equal(a.visitor_feedback, "mismatch");
  assert.equal(a.evidence.closure.timestamp_ms, 500);
  assert.equal(a.evidence.completion.timestamp_ms, 600);
  assert.equal(c.report().report_schema_version, 1);
});
test("wink requires the correct anatomical side and other eye to remain open", () => {
  const c = armed("left");
  c.update(packet(500), inspectStatus("Open", "Closed"), true);
  assert.equal(c.current.phase, "action");
  c.update(packet(600), inspectStatus("Closed", "Open"), true);
  assert.equal(c.current.phase, "reopen");
  c.update(packet(700), inspectStatus("Closed", "Closed"), true);
  assert.equal(c.current.phase, "prepare");
  assert.equal(c.current.observed, false);
});
test("loss and sample gaps cannot bridge a challenge movement", () => {
  const c = armed();
  c.update(packet(500), inspectStatus("Closed", "Closed"), true);
  c.update(
    null,
    { fresh: false, face: false, left: "Unavailable", right: "Unavailable" },
    false,
  );
  c.update(packet(600), inspectStatus(), true);
  assert.equal(c.current.observed, false);
  assert.equal(c.current.phase, "prepare");
  const other = armed();
  other.update(packet(500), inspectStatus("Closed", "Closed"), true);
  other.update(packet(1000), inspectStatus(), true);
  assert.equal(other.current.observed, false);
});
test("gaze challenge uses relative anatomical direction and rejects poor detail", () => {
  const c = armed("gaze-left");
  for (let t = 500; t <= 800; t += 100) {
    const p = packet(t);
    for (const e of Object.values(p.eyes)) e.iris_local = [0.18, 0.05];
    c.update(p, inspectStatus(), true);
  }
  assert.equal(c.current.observed, true);
  const d = armed("gaze-left");
  const p = packet(500);
  for (const e of Object.values(p.eyes)) e.iris_local = [0.18, 0.05];
  d.update(p, inspectStatus(), false);
  assert.equal(d.current.phase, "prepare");
  assert.equal(d.current.observed, false);
  const h = armed("gaze-right");
  for (let t = 500; t <= 800; t += 100) {
    const p = packet(t);
    p.face_center = [0.7, 0.5];
    for (const e of Object.values(p.eyes)) e.iris_local = [0, 0.05];
    h.update(p, inspectStatus(), true);
  }
  assert.equal(h.current.observed, false);
});
test("misses are reportable; findings and traces are bounded and contain no imagery", () => {
  const c = armed();
  for (let t = 500; t < 35000; t += 100)
    c.update(packet(t), inspectStatus(), true);
  assert.equal(c.current.samples.length, 240);
  c.review("mismatch");
  assert.equal(c.attempts[0].system_observed, false);
  for (let n = 0; n < 35; n++) {
    c.start("left");
    c.review("skipped");
  }
  assert.equal(c.attempts.length, 30);
  const report = c.report("x".repeat(600));
  assert.equal(report.notes.length, 500);
  assert.ok(!JSON.stringify(report).includes("landmarks"));
  assert.throws(() => c.start("unknown"));
  assert.throws(() => c.review("passed"));
});

import { estimateIrisColor } from "../src/eye_tracking/static/iris-color.mjs";
function colorFixture(rgb = [110, 75, 45]) {
  const width = 100,
    height = 80,
    data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 })),
    e = EYES.left;
  points[e.corners[0]] = { x: 0.15, y: 0.5 };
  points[e.corners[1]] = { x: 0.85, y: 0.5 };
  points[e.upper] = { x: 0.5, y: 0.25 };
  points[e.lower] = { x: 0.5, y: 0.75 };
  points[e.iris + 1] = { x: 0.7, y: 0.5 };
  points[e.iris + 2] = { x: 0.5, y: 0.25 };
  points[e.iris + 3] = { x: 0.3, y: 0.5 };
  points[e.iris + 4] = { x: 0.5, y: 0.75 };
  return { image: { width, height, data }, points, e };
}
test("iris sampling excludes the central pupil and rejects bright reflections", () => {
  const f = colorFixture();
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 100; x++) {
      if (Math.hypot(x - 50, y - 40) < 11)
        f.image.data.set([0, 0, 0, 255], (y * 100 + x) * 4);
      if (x > 55 && y < 40)
        f.image.data.set([255, 255, 255, 255], (y * 100 + x) * 4);
    }
  const c = estimateIrisColor(f.image, f.points, f.e, eye);
  assert.equal(c.status, "estimated");
  assert.equal(c.hex, "#6e4b2d");
  assert.equal(c.label, "Brown-like");
  assert.ok(c.samples >= 16);
});
test("iris color does not guess for closure, tiny irises, darkness or glare", () => {
  const f = colorFixture();
  assert.equal(
    estimateIrisColor(f.image, f.points, f.e, { ...eye, gaze_valid: false })
      .status,
    "unavailable",
  );
  for (let i = 1; i <= 4; i++) f.points[f.e.iris + i] = { x: 0.51, y: 0.51 };
  assert.equal(
    estimateIrisColor(f.image, f.points, f.e, eye).status,
    "unavailable",
  );
  for (const rgb of [
    [0, 0, 0],
    [255, 255, 255],
  ]) {
    const f = colorFixture(rgb);
    assert.equal(
      estimateIrisColor(f.image, f.points, f.e, eye).status,
      "unavailable",
    );
  }
});
test("iris swatches preserve separate colors and leave measurements untouched", () => {
  const brown = colorFixture([100, 65, 35]),
    blue = colorFixture([80, 110, 150]);
  const before = JSON.stringify(eye);
  assert.equal(
    estimateIrisColor(brown.image, brown.points, brown.e, eye).label,
    "Brown-like",
  );
  assert.equal(
    estimateIrisColor(blue.image, blue.points, blue.e, eye).label,
    "Blue / gray-like",
  );
  assert.equal(JSON.stringify(eye), before);
});

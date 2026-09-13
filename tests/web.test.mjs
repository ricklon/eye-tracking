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
  assert.equal(latch.update(eye, 80), true);
  assert.equal(latch.update(eye, 160), false);
});
test("closure affects one anatomical side and invalid gaze holds", () => {
  const c = new EyeController();
  c.setDelay(0);
  c.update(packet(0), 0, true);
  c.update(packet(1700), 1700, true);
  const p = packet(1750);
  p.eyes.left = { ...eye, aperture: 0, blink_score: 1, gaze_valid: false };
  p.eyes.right = { ...eye, gaze_valid: false };
  const scene = c.update(p, 1750, true);
  assert.equal(scene.pose.upper_left, 0);
  assert.equal(scene.pose.lower_left, 0);
  assert.ok(scene.pose.upper_right > 0);
  assert.deepEqual(c.gaze, [-0.5, 0.25]);
  assert.deepEqual(p.eyes.left.iris_local, [0.1, 0.05]);
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

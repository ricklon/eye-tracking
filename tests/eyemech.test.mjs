import test from "node:test";
import assert from "node:assert/strict";
import {
  boardUrl,
  LidGate,
  mechPose,
  PoseSender,
} from "../src/eye_tracking/static/eyemech.mjs";
const pose = {
  x: 0.4,
  y: -0.2,
  upper_left: 0.1,
  lower_left: 0.3,
  upper_right: 0.9,
  lower_right: 1,
};
test("mechanism pose maps axes and mirrors sides by default", () => {
  const p = mechPose(pose);
  assert.ok(Math.abs(p.lr - 0.7) < 1e-9);
  assert.ok(Math.abs(p.ud - 0.4) < 1e-9);
  // Your left eye drives the mechanism's right eye (TR/BR).
  assert.deepEqual(
    [p.lid_tl, p.lid_bl, p.lid_tr, p.lid_br],
    [0.9, 1, 0.1, 0.3],
  );
  const q = mechPose(pose, { mirrorSides: false, reverseLr: true, reverseUd: true });
  assert.deepEqual([q.lid_tl, q.lid_tr], [0.1, 0.9]);
  assert.ok(Math.abs(q.lr - 0.3) < 1e-9 && Math.abs(q.ud - 0.6) < 1e-9);
});
test("mechanism pose stays within 0..1 at high gain", () => {
  const p = mechPose({ ...pose, x: 1, y: -1, upper_left: 1.2 }, { gazeGain: 1.5 });
  assert.deepEqual([p.lr, p.ud, p.lid_tr], [1, 0, 1]);
  const keys = Object.keys(p).sort();
  assert.deepEqual(keys, ["lid_bl", "lid_br", "lid_tl", "lid_tr", "lr", "ud"]);
});
class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
  }
}
test("sender throttles, drops when backed up, and stops once when idle", () => {
  const statuses = [];
  const sender = new PoseSender("ws://x", (t, bad) => statuses.push([t, bad]), FakeSocket);
  const socket = sender.socket;
  const copying = { state: "copying", pose };
  assert.equal(sender.update(copying, 0), true);
  assert.equal(sender.update(copying, 10), false);
  socket.bufferedAmount = 5;
  assert.equal(sender.update(copying, 25), false);
  socket.bufferedAmount = 0;
  assert.equal(sender.update(copying, 30), true);
  sender.update({ state: "idle", pose }, 60);
  sender.update({ state: "offline", pose }, 90);
  assert.equal(socket.sent.length, 3);
  assert.deepEqual(socket.sent[2], { stop: true });
  socket.onmessage({ data: JSON.stringify({ error: "not accepting poses" }) });
  assert.deepEqual(statuses.at(-1), ["not accepting poses", true]);
  socket.readyState = 0;
  assert.equal(sender.update(copying, 200), false);
  socket.readyState = 1;
  sender.close();
  assert.equal(socket.onclose, null);
  assert.equal(socket.readyState, 3);
});
test("board address becomes the follow-mode socket", () => {
  assert.equal(boardUrl(" eyemech.local "), "ws://eyemech.local/ws/pose");
  assert.equal(boardUrl("10.0.0.5:8080"), "ws://10.0.0.5:8080/ws/pose");
  assert.equal(boardUrl("ws://10.0.0.5/ws/pose"), "ws://10.0.0.5/ws/pose");
  for (const bad of ["", "eye mech", "http://eyemech.local", "eyemech.local/ws"])
    assert.equal(boardUrl(bad), null);
});
const lids = (l, r) => ({ ...pose, upper_left: l, lower_left: Math.sqrt(l), upper_right: r, lower_right: Math.sqrt(r) });
test("lid gate sends open or closed with hysteresis per eye", () => {
  const gate = new LidGate();
  const shut = (p) => [p.upper_left, p.lower_left, p.upper_right, p.lower_right];
  // Squint and jitter between the thresholds stay open.
  for (const [t, v] of [[0, 0.9], [16, 0.45], [32, 0.35], [48, 0.55]])
    assert.deepEqual(shut(gate.apply(lids(v, 1), t)), [1, 1, 1, 1]);
  // A wink closes only that eye, upper and lower together.
  assert.deepEqual(shut(gate.apply(lids(0.2, 0.9), 64)), [0, 0, 1, 1]);
  // Values between the thresholds hold closed; reopening needs > 0.6.
  assert.deepEqual(shut(gate.apply(lids(0.5, 0.9), 300)), [0, 0, 1, 1]);
  assert.deepEqual(shut(gate.apply(lids(0.8, 0.9), 316)), [1, 1, 1, 1]);
});
test("lid gate holds a brief closure long enough to finish the stroke", () => {
  const gate = new LidGate();
  gate.apply(lids(0.1, 0.1), 0);
  assert.equal(gate.apply(lids(1, 1), 100).upper_left, 0);
  assert.equal(gate.apply(lids(1, 1), 150).upper_left, 1);
});
test("sender gates lids by default and can pass them through", () => {
  const sender = new PoseSender("ws://x", () => {}, FakeSocket);
  const scene = { state: "copying", pose: lids(0.45, 0.2) };
  sender.update(scene, 0);
  const gated = sender.socket.sent.at(-1);
  // Mirrored: anatomical right drives the mechanism's left lids.
  assert.deepEqual([gated.lid_tl, gated.lid_bl, gated.lid_tr, gated.lid_br], [0, 0, 1, 1]);
  sender.settings = { ...sender.settings, decisiveLids: false };
  sender.update(scene, 100);
  assert.equal(sender.socket.sent.at(-1).lid_tr, 0.45);
  // Leaving the copying states resets the gate.
  sender.update({ state: "idle", pose: scene.pose }, 200);
  assert.equal(sender.lids.eyes.right.closed, false);
});

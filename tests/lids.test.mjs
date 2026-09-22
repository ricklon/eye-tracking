// Replays a labelled 30 fps recording of one face: eyes open, three blinks, three
// left winks, three right winks, a held squint, then both eyes held shut. The labels
// are what the person reported doing and what the dashboard showed at the time.
// Raw measurements only; no images were recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LidPair, LidLatch } from "../src/eye_tracking/static/controller.mjs";

const rows = readFileSync(new URL("./data-eye-sequence.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

function replay() {
  const lids = new LidPair(),
    frames = [];
  for (const packet of rows) {
    lids.update(packet, packet.timestamp_ms);
    frames.push({
      t: packet.timestamp_ms / 1000,
      left: lids.left.closed,
      right: lids.right.closed,
      leftSquint: lids.left.squint,
      rightSquint: lids.right.squint,
    });
  }
  return frames;
}
const frames = replay();
const between = (lo, hi) => frames.filter((f) => f.t >= lo && f.t <= hi);
const shut = (lo, hi, side) => between(lo, hi).filter((f) => f[side]).length;

test("open eyes never read as closed", () => {
  for (const [lo, hi] of [
    [0, 2.5],
    [4.6, 6.4],
    [11, 12.5],
  ]) {
    assert.equal(shut(lo, hi, "left"), 0, `left ${lo}-${hi}s`);
    assert.equal(shut(lo, hi, "right"), 0, `right ${lo}-${hi}s`);
  }
});

test("blinks close both eyes", () => {
  for (const [lo, hi] of [
    [3.3, 3.8],
    [3.9, 4.4],
  ]) {
    assert.ok(shut(lo, hi, "left") >= 2, `left blink ${lo}s`);
    assert.ok(shut(lo, hi, "right") >= 2, `right blink ${lo}s`);
  }
});

test("a wink closes one eye and leaves the other open", () => {
  // The other eye's landmarks and blend shape score move too, so the pair is judged
  // together; alone, each of these would drag both lids shut. This face's left winks
  // are the weaker ones -- the left eye leads the right by 0.07..0.09 of closure,
  // against 0.36..0.41 the other way -- so they are only required to lead, while a
  // right wink must leave the left eye alone entirely.
  for (const [lo, hi] of [
    [6.5, 7.1],
    [7.2, 7.7],
    [7.85, 8.4],
  ]) {
    assert.ok(shut(lo, hi, "left") >= 3, `left wink ${lo}s closes left`);
    assert.ok(
      shut(lo, hi, "right") < shut(lo, hi, "left"),
      `left wink ${lo}s closes the left eye more`,
    );
  }
  for (const [lo, hi] of [
    [9.2, 9.6],
    [9.7, 10.2],
    [10.3, 10.8],
  ]) {
    assert.ok(shut(lo, hi, "right") >= 3, `right wink ${lo}s closes right`);
    assert.equal(shut(lo, hi, "left"), 0, `right wink ${lo}s keeps left open`);
  }
});

test("a held squint is not a blink", () => {
  // It reaches a blink's depth, so only its slow onset and its length tell them
  // apart. It may latch briefly at the start, then must let go and stay open.
  const squint = between(12.8, 16.3);
  assert.ok(
    squint.some((f) => f.leftSquint || f.rightSquint),
    "recognised as a squint rather than a blink",
  );
  for (const side of ["left", "right"]) {
    assert.ok(
      squint.filter((f) => f[side]).length <= squint.length * 0.2,
      `${side} eye holds open through the squint`,
    );
    assert.equal(
      squint.slice(-30).filter((f) => f[side]).length,
      0,
      `${side} eye is open by the end of the squint`,
    );
  }
});

test("a deliberate closure stays shut", () => {
  // The left eye shuts first and holds; the right only closes fully after 18.2 s,
  // measuring 0.46 of its open gap against the left's 0.26 even when both are shut.
  const hold = between(16.9, 19.5);
  assert.ok(shut(16.9, 19.5, "left") >= hold.length * 0.95, "left stays shut");
  assert.ok(shut(18.4, 19.4, "right") >= between(18.4, 19.4).length * 0.9, "right stays shut");
  // Nothing reopens between: the closure is one latch, not a stutter.
  const runs = hold.filter((f, i) => i > 0 && f.left !== hold[i - 1].left).length;
  assert.ok(runs <= 1, `left lid latches once, saw ${runs} changes`);
});

test("each eye is measured against its own open gap and blink score", () => {
  const latch = new LidLatch();
  // A narrow-eyed face whose blink score rests high still reads as open.
  for (let t = 0; t < 4000; t += 33)
    latch.update({ aperture: 0.14, blink_score: 0.45, gaze_valid: true }, t);
  assert.equal(latch.closed, false);
  assert.ok(latch.closure < 0.3, `closure ${latch.closure}`);
  // Halving that gap in one frame is a blink, whatever the absolute numbers.
  latch.update({ aperture: 0.06, blink_score: 0.75, gaze_valid: true }, 4033);
  assert.equal(latch.closed, true);
});

test("a stalled or rewound clock does not fabricate a blink", () => {
  const lids = new LidPair();
  const eye = (aperture) => ({ aperture, blink_score: 0.2, gaze_valid: true });
  for (let t = 0; t < 3000; t += 33)
    lids.update({ eyes: { left: eye(0.3), right: eye(0.3) } }, t);
  assert.equal(lids.left.closed, false);
  lids.update({ eyes: { left: eye(0.3), right: eye(0.3) } }, 2000);
  assert.equal(lids.left.closed, false);
  // A partly narrower eye on the frame after a long gap is not a blink; a deep
  // closure still is, because the eye plainly is shut.
  lids.update({ eyes: { left: eye(0.2), right: eye(0.3) } }, 9000);
  assert.equal(lids.left.closed, false, "no blink invented across a frame gap");
  lids.update({ eyes: { left: eye(0.02), right: eye(0.3) } }, 9033);
  assert.equal(lids.left.closed, true, "a shut eye still reads as shut");
});

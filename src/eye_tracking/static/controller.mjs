import { clamp } from "./measurements.mjs";
const neutral = () => ({
  x: 0,
  y: 0,
  upper_left: 1,
  lower_left: 1,
  upper_right: 1,
  lower_right: 1,
});
const smoothstep = (lo, hi, x) => {
  const t = clamp((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
// Reads one eye's lids. Everything is measured against what THIS eye does: its own
// open gap and its own open-eye blink score, because the two eyes differ on the same
// face (measured on a 30 fps recording: both eyes held shut read 0.26 of open on the
// left and 0.46 on the right) and the blink score has a per-eye resting level.
//
// Closure level alone cannot tell a blink from a squint: a squint reached the same
// depth as a blink in that recording. Speed can. A blink loses a quarter of the gap
// within 100 ms; the squint took about 400 ms to settle and then held for seconds.
// So a fast fall latches the lid shut, a slow one is treated as a squint and never
// latches, and a deep gap latches whatever its speed.
export class LidLatch {
  // Measured over a labelled 30 fps recording: blinks and winks gain 0.21..0.42 of
  // closure within 100 ms, a squint only 0.18..0.22, and open eyes 0.04. The bands
  // touch, so speed alone cannot decide; HOLD_MS below settles the rest.
  static CLOSE_RATE = 0.2;
  static ONSET_MS = 100;
  static DEEP = 0.85; // closure that is shut however slowly it arrived
  static OPEN = 0.3; // closure below which a latched eye reopens
  // A latched eye that sits partly shut this long without deepening was a squint or
  // a smile: it reopens and stays open until the eye opens properly again. A blink
  // is long gone by then, and a real closure is deeper than HELD.
  static HOLD_MS = 400;
  static HELD = 0.7;
  // Both references track THIS eye rather than a tuned constant: resting aperture and
  // resting blink score vary by face, camera and distance, and fixed numbers would
  // read a narrow-eyed face, or one whose blink score rests high, as permanently shut.
  static SEED_FRAMES = 10;
  // Where a shut eye lands, as a fraction of its open gap, until this eye shows its
  // own: 0.45 with glasses on, whose frames hold the lid landmarks apart, against
  // 0.05 without them on the same face.
  static SHUT = 0.45;
  // How far the blink score rises above this eye's resting level when it is shut.
  static SCORE_SPAN = 0.5;
  closed = false;
  squint = false;
  latchedAt = null;
  deepest = 0; // closure reached since latching, which decides squint or closure
  confirmed = false;
  closure = 0; // 0 open .. 1 shut
  openGap = 0.25;
  shutGap = null; // aperture this eye reaches when it is really shut
  baseline = 0.15; // this eye's blink score while open
  seen = 0;
  openness = 1;
  last = null;
  held = null; // when the current partial closure began
  recent = []; // [timestamp, closure] within ONSET_MS, for the fall speed
  interrupt() {
    this.recent = [];
    this.held = null;
  }
  // The eye's own open state: the aperture it reaches when open, and the blink score
  // it rests at. The first frames seed it, so a face that is narrower than the
  // starting guess is not read as shut; after that it rises fast and forgets slowly.
  reference(dt, eye) {
    if (eye.aperture <= 0.01) return;
    if (this.seen < LidLatch.SEED_FRAMES) {
      this.seen++;
      this.openGap = clamp(Math.max(eye.aperture, this.seen > 1 ? this.openGap : 0), 0.05, 0.6);
    } else if (!this.closed && eye.aperture >= 0.4 * this.openGap) {
      const rate = eye.aperture > this.openGap ? 0.2 : 1 - Math.exp(-dt / 15000);
      this.openGap = clamp(this.openGap + (eye.aperture - this.openGap) * rate, 0.05, 0.6);
    }
    // Only while this eye looks open by its own gap, so a closure cannot raise it.
    if (eye.blink_score !== null && eye.aperture >= 0.9 * this.openGap)
      this.baseline += (eye.blink_score - this.baseline) * 0.05;
    // The shut end comes from closures this eye has actually shown, and forgets
    // upward over ~60 s so one odd frame does not define it.
    if (this.closed && this.confirmed)
      this.shutGap = Math.min(this.shutGap ?? eye.aperture, eye.aperture);
    else if (this.shutGap !== null)
      this.shutGap += (this.openGap * LidLatch.SHUT - this.shutGap) * (1 - Math.exp(-dt / 60000));
  }
  // 0 when the eye is open, 1 when it is as shut as this eye gets -- measured against
  // both of this eye's own ends, because how far the lids appear to meet depends on
  // the face and on whether glasses sit over them.
  evidence(eye) {
    const open = eye.aperture / this.openGap,
      shut = clamp(this.shutGap === null ? LidLatch.SHUT : this.shutGap / this.openGap, 0.02, 0.6),
      gap = clamp((0.95 - open) / (0.95 - shut)),
      score =
        eye.blink_score === null
          ? 0
          : clamp((eye.blink_score - this.baseline) / LidLatch.SCORE_SPAN);
    // Either signal alone is enough, because a wink can show in the blend shape score
    // before the lid landmarks move much. Except when the lids are plainly apart: a
    // blink score that rests high must not hold an open eye shut.
    return open >= 0.85 ? Math.min(gap, score) : Math.max(gap, score);
  }
  update(eye, timestamp) {
    if (this.last !== null && timestamp <= this.last) return this.closed;
    const dt = this.last === null ? 33 : timestamp - this.last;
    if (dt > 200) this.interrupt();
    this.last = timestamp;
    this.reference(dt, eye);
    // Light smoothing only: heavier would blunt the fall that identifies a blink.
    this.closure +=
      (this.evidence(eye) - this.closure) * (1 - Math.exp(-Math.min(dt, 200) / 40));
    this.recent.push([timestamp, this.closure]);
    while (this.recent.length > 1 && this.recent[0][0] < timestamp - LidLatch.ONSET_MS)
      this.recent.shift();
    const fell = this.closure - Math.min(...this.recent.map(([, c]) => c));
    if (this.closure < LidLatch.OPEN) {
      this.closed = false;
      this.squint = false;
      this.latchedAt = null;
      this.confirmed = false;
    } else if (
      // A deep closure latches even after a squint: the eye really did shut.
      this.closure >= LidLatch.DEEP ||
      (!this.squint && fell >= LidLatch.CLOSE_RATE)
    ) {
      if (!this.closed) {
        this.latchedAt = timestamp;
        this.deepest = 0;
        this.confirmed = false;
      }
      this.closed = true;
      this.squint = false;
    }
    this.deepest = Math.max(this.deepest, this.closure);
    // Judged once per closure, a blink's lifetime after it latched: an eye that never
    // got past HELD was a squint or a smile, so it opens and stays open until the eye
    // opens properly again. Anything deeper is a real closure and is left alone.
    if (this.closed && !this.confirmed && timestamp - this.latchedAt >= LidLatch.HOLD_MS) {
      if (this.deepest < LidLatch.HELD) {
        this.closed = false;
        this.squint = true;
        this.latchedAt = null;
      } else this.confirmed = true;
    }
    this.openness = this.closed ? 0 : 1 - this.closure;
    return this.closed;
  }
  // Shut on a partner's evidence rather than this eye's own fall; the squint check
  // still applies, so a held half-closure opens again.
  latch(timestamp) {
    if (this.closed) return;
    this.closed = true;
    this.squint = false;
    this.latchedAt = timestamp;
    this.deepest = this.closure;
    this.confirmed = false;
  }
  // Display openness: 0 while latched shut, otherwise exaggerated partial closure.
  display(gain = 1.6) {
    if (this.closed) return 0;
    return clamp(1 - this.closure) ** gain;
  }
}
// Both eyes together, because a wink is only visible by comparison: MediaPipe leaks
// some of a wink into the other eye, so an eye that is much less closed than its
// partner is held open rather than dragged shut with it.
export class LidPair {
  // Blinks in the labelled recording differed between the eyes by at most 0.05,
  // winks by 0.11 to 0.41.
  static WINK_GAP = 0.1;
  // A second eye already this far into a closure when the first one latches is
  // blinking with it: the two eyes rarely fall at exactly the same speed, and without
  // this the faster one alone reads as a wink.
  static TOGETHER = 0.45;
  // An eye this far shut is not the quiet half of a wink, whatever its partner does:
  // two eyes held shut still measure a little apart.
  static WINK_OPEN = 0.8;
  left = new LidLatch();
  right = new LidLatch();
  interrupt() {
    this.left.interrupt();
    this.right.interrupt();
  }
  reset(side) {
    this[side] = new LidLatch();
  }
  update(packet, timestamp) {
    for (const side of ["left", "right"]) {
      const eye = packet.eyes?.[side];
      if (eye) this[side].update(eye, timestamp);
      else this[side].interrupt();
    }
    const sides = [
      ["left", "right"],
      ["right", "left"],
    ];
    for (const [side, other] of sides) {
      const lead = this[side].closure - this[other].closure;
      // Both eyes equally far into a closure: a blink, even when only the faster eye
      // passed its own fall test. Never an eye already judged to be squinting.
      if (
        this[side].closed &&
        !this[other].closed &&
        !this[other].squint &&
        lead < LidPair.WINK_GAP &&
        this[other].closure >= LidPair.TOGETHER
      )
        this[other].latch(timestamp);
      // One eye clearly ahead of the other: a wink, so the trailing eye is held open.
      // MediaPipe leaks part of a wink into the other eye, and the leak grows with the
      // wink, so the test is how far apart they are rather than a level. An eye whose
      // own closure was confirmed deep keeps it: both eyes shut can measure far apart.
      if (
        this[side].closed &&
        this[other].closed &&
        !this[other].confirmed &&
        this[other].closure < LidPair.WINK_OPEN &&
        lead >= LidPair.WINK_GAP
      ) {
        this[other].closed = false;
        this[other].openness = 1 - this[other].closure;
      }
    }
    return this;
  }
}
// Head turn from the face transform: the canonical face's forward (+z) axis in camera
// space. Returns [x toward image right, y up], each sin(angle), or null. Display-only.
export function headTurn(packet) {
  const m = packet?.face_transform;
  if (!m || m.length < 3 || m[0].length < 3) return null;
  const [x, y, z] = [m[0][2], m[1][2], m[2][2]];
  const n = Math.hypot(x, y, z);
  return n > 1e-6 ? [x / n, y / n] : null;
}
// Browser display controller. Pose is mirrored for visitors, never a servo contract.
export class EyeController {
  pose = neutral();
  delay = 1200;
  lidGain = 1.6;
  // sin(30°) head turn × 2 reaches the edge of the eye.
  headGain = 2;
  headPart = [0, 0];
  history = [];
  lastSeen = -Infinity;
  entered = null;
  previous = null;
  gaze = [0, 0];
  lids = new LidPair();
  setDelay(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 3000)
      throw new Error("Delay must be 0–3000 ms");
    this.delay = ms;
    this.history = [];
  }
  update(packet, now, active, eyeDetail = true) {
    const dt = this.previous === null ? 16 : Math.max(0, now - this.previous);
    this.previous = now;
    const fresh = active && packet && now - packet.timestamp_ms < 750;
    let target = neutral(),
      state = "idle",
      title = "Can you make me wink?",
      prompt = "Start the camera to play";
    if (fresh && packet.face_present) {
      if (this.entered === null) {
        this.entered = now;
        this.gaze = [0, 0];
        this.headPart = [0, 0];
        this.lids = new LidPair();
      }
      this.lastSeen = now;
      const age = now - this.entered;
      const eyes = Object.values(packet.eyes).filter(Boolean);
      const valid = eyes.filter((e) => e.gaze_valid);
      // Mirrored display: pose x is screen right (image left), pose y is down.
      const head = headTurn(packet);
      const [hx, hy] = head
        ? [-head[0] * this.headGain, -head[1] * this.headGain]
        : [0, 0];
      if (age < 1600 || !eyeDetail) {
        this.gaze = [
          clamp((0.5 - packet.face_center[0]) * 2.5 + hx, -1, 1),
          clamp((packet.face_center[1] - 0.5) * 2.5 + hy, -1, 1),
        ];
      } else if (valid.length) {
        const mean = (i) =>
          valid.reduce((s, e) => s + e.iris_local[i], 0) / valid.length;
        this.gaze = [
          clamp(-mean(0) * 5 + hx, -1, 1),
          clamp(mean(1) * 5 + hy, -1, 1),
        ];
      } else if (head) {
        // Eyes closed or gaze invalid: keep eye-in-socket part, still follow the head.
        this.gaze = [clamp(this.gaze[0] - this.headPart[0] + hx, -1, 1), clamp(this.gaze[1] - this.headPart[1] + hy, -1, 1)];
      }
      this.headPart = [hx, hy];
      [target.x, target.y] = this.gaze;
      if (age >= 1600) {
        // Both eyes at once: a wink is only recognisable by comparing them.
        this.lids.update(packet, packet.timestamp_ms);
        for (const side of ["left", "right"]) {
          if (!packet.eyes[side]) {
            target[`upper_${side}`] = this.pose[`upper_${side}`];
            target[`lower_${side}`] = this.pose[`lower_${side}`];
            continue;
          }
          const open = this.lids[side].display(this.lidGain);
          // The lower lid travels less than the upper until nearly closed.
          target[`upper_${side}`] = open;
          target[`lower_${side}`] = Math.sqrt(open);
        }
      }
      state = age < 1600 ? "greeting" : "copying";
      title = age < 1600 ? "Oh, hello!" : "Your eyes are in charge";
      prompt =
        age < 1600
          ? "Face the camera and stay a moment"
          : "Try looking left, looking right, or a slow wink";
      if (age >= 1600 && !eyeDetail) {
        state = "following";
        title = "I see you!";
        prompt = "Come closer and face the camera to try eye movements";
      }
    } else {
      this.lids.interrupt();
      const missing = now - this.lastSeen;
      if (fresh && missing < 1500) {
        target = { ...this.pose };
        state = "waiting";
        title = "Peekaboo!";
        prompt = "I’m still here";
      } else {
        this.entered = null;
        this.history = [];
        target.x = 0.35 * Math.sin(now * 0.00055);
        target.y = 0.12 * Math.sin(now * 0.0008);
        if (now % 4500 < 130)
          for (const k of Object.keys(target))
            if (k.includes("_")) target[k] = 0;
        if (active && !fresh) {
          state = "offline";
          title = "Waiting for the camera";
          prompt = "Check the camera status in the dashboard";
        } else if (active) prompt = "Step in front of the camera to play";
      }
    }
    for (const key of Object.keys(target)) {
      const gaze = key === "x" || key === "y";
      // Lids close fast and open a little slower, like a real blink.
      const tau = gaze ? 100 : target[key] < this.pose[key] ? 25 : 60;
      const change = (target[key] - this.pose[key]) * (1 - Math.exp(-dt / tau));
      this.pose[key] += gaze ? clamp(change, -dt * 0.003, dt * 0.003) : change;
    }
    let pose = { ...this.pose };
    if ((state === "copying" || state === "following") && this.delay > 0) {
      this.history.push({ time: now, pose });
      while (
        this.history.length > 1 &&
        this.history[1].time <= now - this.delay
      )
        this.history.shift();
      // Bounded even if the rendering clock behaves unexpectedly.
      if (this.history.length > 600) this.history.shift();
      if (this.history[0].time <= now - this.delay) {
        pose = this.history[0].pose;
        title = `Your eyes, ${this.delay / 1000} seconds later`;
        if (eyeDetail) prompt = "Look aside or blink, then watch what you did";
      } else {
        title = "Let’s try an eye echo";
        prompt = "Look aside or blink, then look back here";
      }
    } else this.history = [];
    return { pose, state, title, prompt };
  }
}

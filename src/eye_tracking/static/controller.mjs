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
// Fuses lid gap and blink score into one smoothed 0 (closed)..1 (open) value.
// The gap is scaled by this person's learned open-eye gap. Closing is immediate;
// reopening needs sustained open evidence so landmark jitter cannot flick a held
// closed eye open.
export class LidLatch {
  closed = false;
  openness = 1;
  openGap = 0.25;
  last = null;
  since = null;
  count = 0;
  interrupt() {
    this.since = null;
    this.count = 0;
  }
  evidence(eye) {
    const a = eye.aperture,
      b = eye.blink_score,
      gap = clamp(a / this.openGap, 0, 1.5),
      gapOpen = smoothstep(0.3, 0.8, gap);
    // Touching lid landmarks are closed whatever the blink score says.
    if (b === null || gap < 0.15) return gapOpen;
    // A clearly wide gap still counts when the blink score stays high while open.
    return Math.max(
      (gapOpen + 1 - smoothstep(0.35, 0.7, b)) / 2,
      0.8 * smoothstep(0.65, 0.9, gap),
    );
  }
  update(eye, timestamp) {
    if (this.last !== null && timestamp <= this.last) return this.closed;
    const dt = this.last === null ? 33 : timestamp - this.last;
    if (dt > 200) this.interrupt();
    this.last = timestamp;
    const b = eye.blink_score;
    if (!this.closed && (b === null || b <= 0.3) && eye.aperture > 0.03) {
      // Rise quickly to a wider open gap, forget slowly (~15 s).
      const rate = eye.aperture > this.openGap ? 0.2 : 1 - Math.exp(-dt / 15000);
      this.openGap = clamp(
        this.openGap + (eye.aperture - this.openGap) * rate,
        0.12,
        0.45,
      );
    }
    const raw = this.evidence(eye);
    this.openness += (raw - this.openness) * (1 - Math.exp(-Math.min(dt, 200) / 60));
    if (raw < 0.2 || this.openness < 0.3) {
      this.closed = true;
      this.openness = Math.min(this.openness, raw);
      this.interrupt();
    } else if (this.closed && this.openness >= 0.6) {
      this.since ??= timestamp;
      this.count++;
      if (this.count >= 3 && timestamp - this.since >= 120) {
        this.closed = false;
        this.interrupt();
      }
    } else this.interrupt();
    return this.closed;
  }
  // Display openness: 0 while latched closed, otherwise exaggerated partial closure.
  display(gain = 1.6) {
    if (this.closed) return 0;
    return clamp((this.openness - 0.3) / 0.6) ** gain;
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
  lids = { left: new LidLatch(), right: new LidLatch() };
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
        this.lids = { left: new LidLatch(), right: new LidLatch() };
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
      if (age >= 1600)
        for (const side of ["left", "right"]) {
          const eye = packet.eyes[side];
          if (!eye) {
            this.lids[side].interrupt();
            target[`upper_${side}`] = this.pose[`upper_${side}`];
            target[`lower_${side}`] = this.pose[`lower_${side}`];
            continue;
          }
          const latch = this.lids[side];
          latch.update(eye, packet.timestamp_ms);
          const open = latch.display(this.lidGain);
          // The lower lid travels less than the upper until nearly closed.
          target[`upper_${side}`] = open;
          target[`lower_${side}`] = Math.sqrt(open);
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
      for (const latch of Object.values(this.lids)) latch.interrupt();
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

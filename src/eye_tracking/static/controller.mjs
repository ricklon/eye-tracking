import { clamp } from "./measurements.mjs";
const neutral = () => ({
  x: 0,
  y: 0,
  upper_left: 1,
  lower_left: 1,
  upper_right: 1,
  lower_right: 1,
});
export class LidLatch {
  closed = false;
  last = null;
  since = null;
  count = 0;
  interrupt() {
    this.since = null;
    this.count = 0;
  }
  update(eye, timestamp) {
    if (this.last !== null && timestamp <= this.last) return this.closed;
    if (this.last !== null && timestamp - this.last > 200) this.interrupt();
    this.last = timestamp;
    const a = eye.aperture,
      b = eye.blink_score;
    if (a <= 0.04 || (a <= 0.1 && b !== null && b >= 0.55)) {
      this.closed = true;
      this.interrupt();
    } else if (
      this.closed &&
      (a >= 0.12 || (a >= 0.065 && (b === null || b <= 0.35)))
    ) {
      this.since ??= timestamp;
      this.count++;
      if (
        this.count >= 3 &&
        timestamp - this.since >= (b !== null && b > 0.35 ? 250 : 120)
      ) {
        this.closed = false;
        this.interrupt();
      }
    } else this.interrupt();
    return this.closed;
  }
}
// Browser display controller. Pose is mirrored for visitors, never a servo contract.
export class EyeController {
  pose = neutral();
  delay = 1200;
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
        this.lids = { left: new LidLatch(), right: new LidLatch() };
      }
      this.lastSeen = now;
      const age = now - this.entered;
      const eyes = Object.values(packet.eyes).filter(Boolean);
      const valid = eyes.filter((e) => e.gaze_valid);
      if (age < 1600 || !eyeDetail) {
        this.gaze = [
          clamp((0.5 - packet.face_center[0]) * 2.5, -1, 1),
          clamp((packet.face_center[1] - 0.5) * 2.5, -1, 1),
        ];
      } else if (valid.length) {
        this.gaze = [
          clamp(
            (-valid.reduce((s, e) => s + e.iris_local[0], 0) / valid.length) *
              5,
            -1,
            1,
          ),
          clamp(
            (valid.reduce((s, e) => s + e.iris_local[1], 0) / valid.length) * 5,
            -1,
            1,
          ),
        ];
      }
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
          const closed = this.lids[side].update(eye, packet.timestamp_ms);
          target[`upper_${side}`] = closed ? 0 : clamp(-eye.upper_lid / 0.12);
          target[`lower_${side}`] = closed ? 0 : clamp(eye.lower_lid / 0.12);
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
      const change =
        (target[key] - this.pose[key]) *
        (1 - Math.exp(-dt / (gaze ? 100 : 35)));
      this.pose[key] =
        !gaze && target[key] === 0
          ? 0
          : this.pose[key] +
            (gaze ? clamp(change, -dt * 0.003, dt * 0.003) : change);
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

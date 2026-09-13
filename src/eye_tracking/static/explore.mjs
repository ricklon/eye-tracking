import { LidLatch } from "./controller.mjs";

export const CHALLENGES = [
  {
    id: "blink",
    title: "The slow blink",
    instruction:
      "Look straight ahead with both eyes open. Slowly close both eyes, then open them again.",
  },
  {
    id: "left",
    title: "Left-eye secret signal",
    instruction:
      "Look straight ahead with both eyes open. Wink your LEFT eye while keeping your right eye open, then reopen it.",
  },
  {
    id: "right",
    title: "Right-eye secret signal",
    instruction:
      "Look straight ahead with both eyes open. Wink your RIGHT eye while keeping your left eye open, then reopen it.",
  },
  {
    id: "gaze-left",
    title: "Look to your left",
    instruction:
      "First look straight ahead. Once ready, look toward your left hand using only your eyes. Keep your head still.",
  },
  {
    id: "gaze-right",
    title: "Look to your right",
    instruction:
      "First look straight ahead. Once ready, look toward your right hand using only your eyes. Keep your head still.",
  },
];

// Live evidence is independent of the delayed animation. Missing data is never "open".
export class EyeInspector {
  latches = { left: new LidLatch(), right: new LidLatch() };
  last = null;
  reset() {
    this.latches = { left: new LidLatch(), right: new LidLatch() };
    this.last = null;
  }
  update(packet, now, active) {
    const fresh = Boolean(
      active &&
      packet &&
      now - packet.timestamp_ms >= 0 &&
      now - packet.timestamp_ms < 750,
    );
    if (!fresh || !packet.face_present) {
      this.reset();
      return { fresh, face: false, left: "Unavailable", right: "Unavailable" };
    }
    if (this.last !== null && packet.timestamp_ms - this.last > 200)
      this.reset();
    this.last = packet.timestamp_ms;
    const result = { fresh: true, face: true };
    for (const side of ["left", "right"]) {
      const eye = packet.eyes?.[side];
      if (!eye) {
        this.latches[side] = new LidLatch();
        result[side] = "Unavailable";
        continue;
      }
      const closed = this.latches[side].update(eye, packet.timestamp_ms);
      const conflict =
        eye.blink_score !== null &&
        eye.blink_score >= 0.55 &&
        eye.aperture > 0.1;
      const open =
        eye.aperture >= 0.12 ||
        (eye.aperture >= 0.065 &&
          (eye.blink_score === null || eye.blink_score <= 0.35));
      result[side] = conflict
        ? "Uncertain"
        : closed
          ? "Closed"
          : open
            ? "Open"
            : "Uncertain";
    }
    return result;
  }
}

// Only distinct fresh samples progress a challenge. Visitor feedback is separate evidence.
export class ChallengeSession {
  current = null;
  attempts = [];
  sequence = 0;
  start(id) {
    if (!CHALLENGES.some((c) => c.id === id))
      throw new Error("Unknown challenge");
    if (this.current) this.review("skipped");
    this.current = {
      id,
      phase: "prepare",
      observed: false,
      hint: "Hold both eyes open and look straight ahead for a moment.",
      last: null,
      since: null,
      count: 0,
      baseline: null,
      samples: [],
      evidence: null,
    };
  }
  interrupt(hint = "Tracking interrupted. Start again with both eyes open.") {
    const c = this.current;
    if (!c || c.observed) return;
    c.phase = "prepare";
    c.since = null;
    c.count = 0;
    c.baseline = null;
    c.evidence = null;
    c.hint = hint;
  }
  update(packet, status, detail) {
    const c = this.current;
    if (!c || c.observed) return;
    if (
      !status.fresh ||
      !status.face ||
      ["left", "right"].some((s) => status[s] === "Unavailable")
    ) {
      this.interrupt("Find your face and both eyes in the camera to begin.");
      return;
    }
    const time = packet.timestamp_ms;
    if (c.last !== null && time <= c.last) return;
    if (c.last !== null && time - c.last > 200) this.interrupt();
    c.last = time;
    c.samples.push({
      packet,
      status: { left: status.left, right: status.right },
      eye_detail: detail,
    });
    if (c.samples.length > 240) c.samples.shift();
    const bothOpen = status.left === "Open" && status.right === "Open";
    const gazeChallenge = c.id.startsWith("gaze-");
    const usableGaze =
      detail && ["left", "right"].every((s) => packet.eyes[s].gaze_valid);
    if (gazeChallenge && !usableGaze) {
      this.interrupt(
        "Come closer, face the camera, and keep both eyes open for this gaze check.",
      );
      return;
    }
    if (c.phase === "prepare") {
      if (!bothOpen) {
        c.since = null;
        c.count = 0;
        return;
      }
      c.since ??= time;
      c.count++;
      if (time - c.since >= 400 && c.count >= 4) {
        c.baseline = {
          center: [...packet.face_center],
          iris: Object.fromEntries(
            ["left", "right"].map((s) => [s, [...packet.eyes[s].iris_local]]),
          ),
        };
        c.phase = "action";
        c.since = null;
        c.count = 0;
        c.hint = gazeChallenge
          ? "Ready! Move only your eyes toward your " +
            (c.id === "gaze-left" ? "left" : "right") +
            " hand."
          : "Ready! Try the blink or wink now.";
      }
      return;
    }
    let matched = false;
    if (gazeChallenge) {
      const headShift = Math.hypot(
        ...packet.face_center.map((x, i) => x - c.baseline.center[i]),
      );
      const direction = c.id === "gaze-left" ? 1 : -1; // Anatomical left is original-image right.
      matched =
        bothOpen &&
        headShift < 0.06 &&
        ["left", "right"].every(
          (s) =>
            direction * (packet.eyes[s].iris_local[0] - c.baseline.iris[s][0]) >
            0.04,
        );
      if (headShift >= 0.06)
        c.hint =
          "Your face moved too. Return to your starting position and move only your eyes.";
      if (!matched) {
        c.since = null;
        c.count = 0;
      } else {
        c.since ??= time;
        c.count++;
        matched = time - c.since >= 200 && c.count >= 3;
      }
    } else {
      const closed =
        c.id === "blink"
          ? status.left === "Closed" && status.right === "Closed"
          : status[c.id] === "Closed" &&
            status[c.id === "left" ? "right" : "left"] === "Open";
      if (c.phase === "action" && closed) {
        c.phase = "reopen";
        c.hint = "Closure spotted! Open both eyes again.";
        c.evidence = { closure: packet };
      } else if (c.phase === "reopen") {
        const other = c.id === "left" ? "right" : "left";
        if (c.id !== "blink" && status[other] !== "Open") {
          this.interrupt(
            "The other eye changed too. Open both eyes and try one eye at a time.",
          );
          return;
        }
        matched = bothOpen;
      }
    }
    if (matched) {
      c.observed = true;
      c.phase = "review";
      c.evidence = { ...c.evidence, completion: packet };
      c.hint =
        "The system spotted the pattern. Did that match what you actually did?";
    }
  }
  review(verdict) {
    if (!["matched", "mismatch", "skipped"].includes(verdict))
      throw new Error("Unknown verdict");
    const c = this.current;
    if (!c) return;
    this.attempts.push({
      attempt: ++this.sequence,
      challenge: c.id,
      system_observed: c.observed,
      visitor_feedback: verdict,
      baseline: c.baseline,
      evidence: c.evidence,
      samples: c.samples,
    });
    if (this.attempts.length > 30) this.attempts.shift();
    this.current = null;
  }
  report(notes = "") {
    return {
      report_schema_version: 1,
      measurement_schema_version: 1,
      runtime: "MediaPipe Tasks Vision 0.10.32",
      model: "face_landmarker/float16/1",
      notes: notes.slice(0, 500),
      interpretation:
        "System observations are heuristics; visitor feedback is self-reported, not an accuracy score.",
      attempts: this.attempts,
    };
  }
}

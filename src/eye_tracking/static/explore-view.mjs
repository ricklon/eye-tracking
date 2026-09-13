import { EYES } from "./measurements.mjs";
import { CHALLENGES, EyeInspector, ChallengeSession } from "./explore.mjs";
const $ = (id) => document.getElementById(id);
const COLORS = {
  iris: "#ffdb78",
  upper: "#bdacff",
  lower: "#69e5e0",
  corners: "#ffffff",
};
const fmt = (value) => (value == null ? "—" : value.toFixed(3));

// Image and overlays come from the same inference frame, never a newer video frame.
export class ExploreView {
  inspector = new EyeInspector();
  challenges = new ChallengeSession();
  packet = null;
  frame = null;
  landmarks = null;
  detail = false;
  irisColors = null;
  currentStatus = null;
  constructor() {
    CHALLENGES.forEach((c) =>
      $("challenge-select").add(new Option(c.title, c.id)),
    );
    $("challenge-start").onclick = () => {
      this.challenges.start($("challenge-select").value);
      this.refreshChallenge();
    };
    for (const verdict of ["matched", "mismatch", "skipped"])
      $("challenge-" + verdict).onclick = () => {
        this.challenges.review(verdict);
        this.refreshChallenge();
      };
    $("report-download").onclick = () => {
      const report = this.challenges.report($("validation-notes").value);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `eye-exploration-${new Date().toISOString().replaceAll(":", "-")}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $("report-reset").onclick = () => {
      this.challenges = new ChallengeSession();
      $("validation-notes").value = "";
      this.refreshChallenge();
    };
    this.refreshChallenge();
  }
  ingest(data, now) {
    this.frame?.close();
    this.frame = data.frame;
    this.packet = data.packet;
    this.landmarks = data.landmarks;
    this.detail = data.eyeDetail;
    this.irisColors = data.irisColors;
    this.update(now, true);
  }
  clear() {
    this.frame?.close();
    this.frame = null;
    this.packet = null;
    this.landmarks = null;
    this.irisColors = null;
    this.inspector.reset();
    this.endAttempt();
  }
  endAttempt() {
    this.challenges.review("skipped");
    this.refreshChallenge();
  }
  update(now, active) {
    this.currentStatus = this.inspector.update(this.packet, now, active);
    this.challenges.update(this.packet, this.currentStatus, this.detail);
  }
  refreshChallenge() {
    const c = this.challenges.current;
    $("challenge-instruction").textContent = CHALLENGES.find(
      (x) => x.id === (c?.id ?? $("challenge-select").value),
    ).instruction;
    $("challenge-progress").textContent =
      c?.hint ??
      "Choose a challenge. You can report a miss even if nothing is detected.";
    $("challenge-detected").textContent = c?.observed
      ? "Pattern spotted"
      : c
        ? "Listening to your eyes…"
        : "Your turn";
    $("challenge-start").textContent = c
      ? "Restart challenge"
      : "Try this challenge";
    for (const verdict of ["matched", "mismatch", "skipped"])
      $("challenge-" + verdict).disabled = !c;
    $("challenge-matched").disabled = !c?.observed;
    $("challenge-select").disabled = Boolean(c);
    $("report-download").disabled = this.challenges.attempts.length === 0;
    $("report-reset").disabled = !c && this.challenges.attempts.length === 0;
    $("attempts").replaceChildren(
      ...this.challenges.attempts.slice(-5).map((a) => {
        const li = document.createElement("li");
        li.textContent = `${CHALLENGES.find((c) => c.id === a.challenge).title} · ${a.system_observed ? "pattern spotted" : "not spotted"} · ${a.visitor_feedback === "matched" ? "you confirmed" : a.visitor_feedback === "mismatch" ? "you reported a mismatch" : "skipped"}`;
        return li;
      }),
    );
    $("report-count").textContent =
      `${this.challenges.attempts.length} saved attempts · up to 30 kept in this tab`;
  }
  render(now, active) {
    this.update(now, active);
    const status = this.currentStatus;
    $("explore-camera").textContent = $("stop").disabled
      ? "Start camera"
      : "Stop camera";
    $("challenge-start").disabled = !status.face;
    this.refreshChallenge();
    if (!document.body.classList.contains("exploring")) return;
    const fresh = status.fresh;
    $("face-step").textContent = !fresh
      ? "Waiting for camera"
      : status.face
        ? "Face landmarks found"
        : "Looking for a face";
    $("eye-step").textContent = !status.face
      ? "Eyes unavailable"
      : this.detail
        ? "Eye detail available"
        : "Come closer / face forward";
    $("signal-step").textContent = !status.face
      ? "No current eye signals"
      : `${status.left} left · ${status.right} right`;
    $("explore-age").textContent = fresh
      ? `${Math.max(0, Math.round(now - this.packet.timestamp_ms))} ms since this frame`
      : "No fresh frame";
    this.draw($("tracking-map"), null, fresh);
    for (const side of ["left", "right"]) {
      this.draw($(`${side}-zoom`), side, fresh && status.face);
      $(`${side}-status`).textContent = status[side];
      $(`${side}-status`).dataset.state = status[side];
      const color =
        fresh && status[side] === "Open" ? this.irisColors?.[side] : null;
      $(`${side}-color-swatch`).style.backgroundColor =
        color?.hex ?? "transparent";
      $(`${side}-color-label`).textContent =
        color?.label ?? "Color unavailable";
      $(`${side}-color-reason`).textContent =
        color?.reason ?? "Wait for a clear, open eye in the camera.";
      const eye = fresh ? this.packet?.eyes?.[side] : null;
      $(`${side}-explanation`).textContent = !eye
        ? "Find this eye in the camera."
        : status[side] === "Uncertain"
          ? "The lid gap and blink evidence are ambiguous or disagree."
          : status[side] === "Closed"
            ? "Closure detected. Fresh open samples are needed before reopening."
            : "The lid gap indicates an open eye.";
      $(`${side}-signals`).textContent =
        `Upper ${fmt(eye?.upper_lid)} · lower ${fmt(eye?.lower_lid)} · gap ${fmt(eye?.aperture)} · blink ${fmt(eye?.blink_score)}`;
      $(`${side}-gaze`).textContent = !eye
        ? "Iris position unavailable"
        : !eye.gaze_valid
          ? "Iris estimate retained; gaze invalid"
          : !this.detail
            ? "Raw iris available; animation follows face position"
            : "Iris position usable for the animation";
    }
  }
  draw(canvas, side, fresh) {
    const ctx = canvas.getContext("2d"),
      W = canvas.width,
      H = canvas.height;
    ctx.fillStyle = "#101720";
    ctx.fillRect(0, 0, W, H);
    if (!fresh || !this.frame) {
      ctx.fillStyle = "#a8bbcb";
      ctx.font = "18px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(
        side ? "Eye detail appears here" : "Start the camera to see what I see",
        W / 2,
        H / 2,
      );
      return;
    }
    const fw = this.frame.width,
      fh = this.frame.height,
      points = this.landmarks;
    let crop = { x: 0, y: 0, w: fw, h: fh };
    if (side) {
      if (!points?.length || !this.packet.eyes?.[side]) return;
      const [a, b] = EYES[side].corners.map((i) => points[i]);
      const span = Math.hypot((a.x - b.x) * fw, (a.y - b.y) * fh);
      const w = Math.min(fw, Math.max(40, span * 2)),
        h = Math.min(fh, (w * H) / W);
      crop = {
        x: Math.max(0, Math.min(fw - w, ((a.x + b.x) * fw) / 2 - w / 2)),
        y: Math.max(0, Math.min(fh - h, ((a.y + b.y) * fh) / 2 - h / 2)),
        w,
        h,
      };
    }
    const scale = Math.min(W / crop.w, H / crop.h),
      ox = (W - crop.w * scale) / 2,
      oy = (H - crop.h * scale) / 2;
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(
      this.frame,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      ox,
      oy,
      crop.w * scale,
      crop.h * scale,
    );
    ctx.restore();
    if (!points?.length) return;
    const xy = (i) => [
      W - (ox + (points[i].x * fw - crop.x) * scale),
      oy + (points[i].y * fh - crop.y) * scale,
    ];
    const line = (indices, color, width = 2) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      indices.forEach((i, n) =>
        n ? ctx.lineTo(...xy(i)) : ctx.moveTo(...xy(i)),
      );
      ctx.stroke();
    };
    if (!side && $("overlay-face").checked) {
      ctx.fillStyle = "#a2f4d099";
      for (let i = 0; i < 468; i++) {
        ctx.beginPath();
        ctx.arc(...xy(i), 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Face position box and eye line show image position/tilt, not physical head angles.
      const xs = points.map((p) => W - (ox + (p.x * fw - crop.x) * scale)),
        ys = points.map((p) => oy + (p.y * fh - crop.y) * scale);
      ctx.strokeStyle = "#a2f4d0";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      );
      line([33, 263], "#ffffff88");
    }
    if (side || $("overlay-eyes").checked)
      for (const s of side ? [side] : ["left", "right"]) {
        const e = EYES[s];
        line(e.corners, "#ffffffaa", 1);
        line([e.upper, e.lower], COLORS.lower, 2);
        for (const [name, indices] of Object.entries({
          corners: e.corners,
          upper: [e.upper],
          lower: [e.lower],
          iris: [e.iris],
        })) {
          ctx.fillStyle = COLORS[name];
          for (const i of indices) {
            ctx.beginPath();
            ctx.arc(...xy(i), side ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (!side) {
          ctx.fillStyle = "#fff";
          ctx.font = "14px system-ui";
          ctx.textAlign = "center";
          const [x, y] = xy(e.upper);
          ctx.fillText(s === "left" ? "Your left" : "Your right", x, y - 15);
        }
      }
  }
}

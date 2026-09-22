import { clamp } from "./measurements.mjs";
// Display pose → eyemech follow pose. The display pose is x toward screen right and
// y down (-1..1) with anatomical lid names; the follow pose is 0..1 across the board's
// calibrated gaze limits and one 0 closed..1 open value per lid servo, named by the
// MECHANISM's sides. Which end of each axis is which depends on the build, so both
// directions are settings, not assumptions.
export const MECH_DEFAULTS = {
  gazeGain: 1,
  reverseLr: false,
  reverseUd: false,
  // The mechanism faces you like the screen: your left eye drives its right eye.
  mirrorSides: true,
  // Servos follow every wobble in a half-open lid; send only open or closed.
  decisiveLids: true,
};
export function mechPose(pose, settings = MECH_DEFAULTS) {
  const s = { ...MECH_DEFAULTS, ...settings },
    axis = (v, reverse) => clamp(0.5 + ((reverse ? -1 : 1) * v * s.gazeGain) / 2),
    [mechLeft, mechRight] = s.mirrorSides ? ["right", "left"] : ["left", "right"];
  return {
    lr: axis(pose.x, s.reverseLr),
    ud: axis(pose.y, s.reverseUd),
    lid_tl: clamp(pose[`upper_${mechLeft}`]),
    lid_bl: clamp(pose[`lower_${mechLeft}`]),
    lid_tr: clamp(pose[`upper_${mechRight}`]),
    lid_br: clamp(pose[`lower_${mechRight}`]),
  };
}
// The board's follow-mode socket for "eyemech.local", "10.0.0.5:8080" or a full
// ws:// URL; null for anything else. Direct mode needs firmware that allows this
// page's origin (CONFIG_EYE_WEB_EXTRA_ORIGINS).
export function boardUrl(address) {
  const a = String(address).trim();
  if (/^wss?:\/\/\S+$/.test(a)) return a;
  return /^[\w.-]+(:\d{1,5})?$/.test(a) ? `ws://${a}/ws/pose` : null;
}
// Turns the display's continuous lids into open/closed decisions for the servos,
// per anatomical eye. Hysteresis keeps squints and landmark jitter between the
// thresholds from reaching the mechanism, and a minimum hold lets a one-frame blink
// finish its travel instead of reversing mid-stroke.
export class LidGate {
  closeBelow = 0.3;
  openAbove = 0.6;
  minClosedMs = 150;
  constructor() {
    this.reset();
  }
  reset() {
    this.eyes = {
      left: { closed: false, since: 0 },
      right: { closed: false, since: 0 },
    };
  }
  apply(pose, now) {
    const out = { ...pose };
    for (const side of ["left", "right"]) {
      const eye = this.eyes[side],
        upper = pose[`upper_${side}`];
      if (!eye.closed && upper < this.closeBelow) {
        eye.closed = true;
        eye.since = now;
      } else if (
        eye.closed &&
        upper > this.openAbove &&
        now - eye.since >= this.minClosedMs
      )
        eye.closed = false;
      out[`upper_${side}`] = out[`lower_${side}`] = eye.closed ? 0 : 1;
    }
    return out;
  }
}
// States where the eyes copy a person. Otherwise the board is released to its own
// mode: one stop, then silence, and it eases to neutral.
const DRIVING = new Set(["greeting", "copying", "following", "waiting"]);
// Streams poses to the board, or the local bridge, at a steady rate. The board slews each servo
// toward the latest pose, so a steady, already-smoothed stream is what makes motion
// smooth; a backed-up socket drops frames rather than delivering them late.
export class PoseSender {
  interval = 20;
  settings = { ...MECH_DEFAULTS };
  lastSent = -Infinity;
  driving = false;
  lids = new LidGate();
  constructor(url, onStatus = () => {}, Socket = globalThis.WebSocket) {
    this.onStatus = onStatus;
    this.socket = new Socket(url);
    this.socket.onopen = () => onStatus(`Connected to ${url}`, false);
    // A refused origin looks the same to a page as an unreachable board.
    this.socket.onclose = () =>
      onStatus(
        `Not connected to ${url}. Check the address, that the board is on, and that its firmware allows this page's origin.`,
        true,
      );
    this.socket.onmessage = (event) => {
      let reply;
      try {
        reply = JSON.parse(event.data);
      } catch {
        return;
      }
      if (reply.error) onStatus(reply.error, true);
      else if (reply.status) onStatus(reply.status, false);
    };
  }
  get open() {
    return this.socket.readyState === 1;
  }
  update(scene, now) {
    if (!this.open) return false;
    if (!DRIVING.has(scene.state)) {
      if (this.driving) this.stop();
      this.lids.reset();
      return false;
    }
    // Gate every frame, sent or not, so a brief closure is never skipped.
    const pose = this.lids.apply(scene.pose, now);
    if (now - this.lastSent < this.interval || this.socket.bufferedAmount > 0)
      return false;
    this.lastSent = now;
    this.driving = true;
    const lids = this.settings.decisiveLids ?? MECH_DEFAULTS.decisiveLids;
    this.socket.send(JSON.stringify(mechPose(lids ? pose : scene.pose, this.settings)));
    return true;
  }
  stop() {
    this.driving = false;
    if (this.open) this.socket.send(JSON.stringify({ stop: true }));
  }
  close() {
    this.stop();
    // A deliberate close is not a connection problem worth reporting.
    this.socket.onclose = this.socket.onmessage = null;
    this.socket.close();
  }
}

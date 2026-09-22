import { EyeController, headTurn } from "./controller.mjs";
import { EYES, clamp, makePacket } from "./measurements.mjs";
import { ExploreView } from "./explore-view.mjs";
import { PoseSender, boardUrl } from "./eyemech.mjs";
import { canDriveMechanism, startingView } from "./views.mjs";
const $ = (id) => document.getElementById(id);
const video = $("camera"),
  canvas = $("eyes"),
  ctx = canvas.getContext("2d");
let controller = new EyeController(),
  worker = null,
  stream = null,
  packet = null;
// Frames handed to the worker and not yet answered. Two keeps the tracker busy
// while the next frame is grabbed, instead of idling a whole cycle between frames.
const MAX_IN_FLIGHT = 2;
let inFlight = 0,
  ready = false,
  starting = false,
  session = 0,
  startedAt = 0,
  lastVideoTime = -1;
let recording = null,
  lastPacketAt = 0,
  initializationTimer;
let eyeDetail = false,
  landmarks = null;
let bridge = null,
  mech = null;
const MAX_SAMPLES = 10000;
// Events per second over the last second, for the camera and tracking readout.
class RateMeter {
  times = [];
  tick(now) {
    this.times.push(now);
    while (this.times[0] <= now - 1000) this.times.shift();
  }
  rate(now) {
    while (this.times.length && this.times[0] <= now - 1000) this.times.shift();
    return this.times.length;
  }
}
const cameraRate = new RateMeter(),
  trackRate = new RateMeter();
let trackMs = null,
  workMs = null,
  // A cloned camera track read by the worker itself, when the browser supports it.
  feed = null,
  delegate = null;
function countCameraFrames(token) {
  if (!video.requestVideoFrameCallback) return;
  video.requestVideoFrameCallback((now) => {
    if (token !== session) return;
    cameraRate.tick(now);
    countCameraFrames(token);
  });
}
function showRates(now) {
  if (!ready) {
    $("rate").textContent = "";
    return;
  }
  const settings = stream?.getVideoTracks()[0]?.getSettings() ?? {},
    camera = video.requestVideoFrameCallback
      ? cameraRate.rate(now)
      : Math.round(settings.frameRate ?? 0),
    tracked = trackRate.rate(now);
  let advice = "";
  if (camera && camera < 20)
    advice = " Camera is slow: add light in front of you, or try another camera.";
  else if (trackMs > 45 && tracked < camera - 4)
    advice =
      delegate === "GPU"
        ? " Tracking is the bottleneck on this computer."
        : " Tracking is the bottleneck: try Tracking on GPU.";
  $("rate").textContent =
    `Camera ${camera} fps · tracked ${tracked} fps` +
    (trackMs === null
      ? ""
      : ` · ${Math.round(trackMs)} ms tracking on ${delegate}, ${Math.round(workMs ?? trackMs)} ms per frame in all`) +
    (feed ? " · direct feed" : " · page copy") +
    ` · ${settings.width ?? "?"}×${settings.height ?? "?"}.${advice}`;
  $("rate").classList.toggle("warning", Boolean(advice));
}
const exploration = new ExploreView();
function message(text) {
  $("message").textContent = text;
  // The play page hides the camera panel, so anything worth saying goes on the stage.
  $("play-note").textContent = text;
}
function downloadRecording() {
  if (recording === null) return;
  const lines = recording;
  recording = null;
  $("record").textContent = "Record measurements";
  $("record-status").textContent =
    `${lines.length} samples exported. No video saved.`;
  if (!lines.length) return;
  const url = URL.createObjectURL(
    new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `eye-measurements-${new Date().toISOString().replaceAll(":", "-")}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function acceptPacket(value) {
  packet = value;
  if (recording !== null) {
    recording.push(JSON.stringify(value));
    $("record-status").textContent =
      `Recording · ${recording.length} / ${MAX_SAMPLES} samples`;
    if (recording.length >= MAX_SAMPLES) downloadRecording();
  }
}
function stopCamera(reason = "Camera stopped. Press Start to reconnect.") {
  session++;
  clearTimeout(initializationTimer);
  worker?.terminate();
  worker = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  inFlight = 0;
  ready = starting = false;
  feed?.stop();
  feed = null;
  if (packet)
    acceptPacket(
      makePacket(
        {},
        Math.max(packet.timestamp_ms + 1, performance.now() - startedAt),
        ...packet.image_size,
      ),
    );
  downloadRecording();
  packet = null;
  landmarks = null;
  exploration.clear();
  controller = new EyeController();
  setDelay();
  setGains();
  $("start").disabled = false;
  $("stop").disabled = true;
  showPlay();
  $("camera-select").disabled = false;
  $("tracker-delegate").disabled = false;
  $("record").disabled = true;
  $("camera-empty").style.display = "";
  $("status").textContent = "Camera off";
  message(reason);
}
async function cameras() {
  const previous = $("camera-select").value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "videoinput",
  );
  $("camera-select").replaceChildren(new Option("Default camera", ""));
  devices.forEach((d, i) =>
    $("camera-select").add(
      new Option(d.label || `Camera ${i + 1}`, d.deviceId),
    ),
  );
  $("camera-select").value = previous;
}
async function startCamera() {
  if (starting || stream) return;
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message(
      "Camera access needs localhost or HTTPS. Open this page locally or through an HTTPS host.",
    );
    return;
  }
  const token = ++session;
  starting = true;
  $("start").disabled = true;
  $("stop").disabled = false;
  showPlay();
  $("camera-select").disabled = true;
  $("tracker-delegate").disabled = true;
  $("status").textContent = "Starting";
  message("Allow camera access. Loading the eye model…");
  try {
    const deviceId = $("camera-select").value;
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        // Blinks last 100–300 ms; below ~20 fps they land on one frame or none.
        frameRate: { ideal: 30 },
        ...(deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: "user" }),
      },
    });
    if (token !== session) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = acquired;
    video.srcObject = stream;
    stream.getVideoTracks()[0].onended = () =>
      stopCamera("Camera disconnected. Press Start to reconnect.");
    await video.play();
    if (token !== session) return;
    countCameraFrames(token);
    $("camera-empty").style.display = "none";
    await cameras();
    if (token !== session) return;
    startedAt = performance.now();
    lastPacketAt = performance.now();
    lastVideoTime = -1;
    // Classic worker: MediaPipe loads its non-module WASM glue using importScripts.
    worker = new Worker(new URL("./tracker.worker.mjs", import.meta.url));
    worker.onerror = (event) => {
      if (token === session)
        stopCamera(`Tracking worker failed: ${event.message}`);
    };
    worker.onmessage = ({ data }) => {
      if (token !== session) {
        data.frame?.close();
        return;
      }
      if (data.type === "ready") {
        clearTimeout(initializationTimer);
        delegate = data.delegate ?? "CPU";
        feedWorker(stream.getVideoTracks()[0]);
        worker.postMessage({
          type: "frames",
          on: document.body.classList.contains("exploring"),
        });
        ready = true;
        starting = false;
        $("record").disabled = false;
        $("status").textContent = "Camera on";
        lastPacketAt = performance.now();
        message("Tracking locally. Face the camera; try a slow blink or wink.");
      } else if (data.type === "packet") {
        inFlight = Math.max(0, inFlight - 1);
        lastPacketAt = performance.now();
        trackRate.tick(lastPacketAt);
        trackMs = data.trackMs ?? null;
        workMs = data.workMs ?? null;
        eyeDetail = data.eyeDetail;
        landmarks = data.landmarks;
        acceptPacket(data.packet);
        exploration.ingest(data, performance.now() - startedAt);
      } else if (data.type === "feed-failed") {
        // Keep tracking by copying frames from the video element instead.
        feed?.stop();
        feed = null;
        inFlight = 0;
      } else if (data.type === "error")
        stopCamera(
          `Could not start tracking: ${data.message}. Check your connection and retry.`,
        );
    };
    initializationTimer = setTimeout(() => {
      if (token === session)
        stopCamera("Model loading timed out. Check your connection and retry.");
    }, 90000);
    worker.postMessage({ type: "init", delegate: $("tracker-delegate").value });
  } catch (error) {
    if (token === session) stopCamera(`Camera unavailable: ${error.message}`);
  }
}
// Hands the worker its own copy of the camera track, so frames skip the page's
// copy, the screen-refresh wait and one postMessage each. Chrome and Edge support
// this; elsewhere capture() keeps copying frames from the video element.
function feedWorker(track) {
  if (typeof MediaStreamTrackProcessor !== "function") return;
  let clone = null;
  try {
    clone = track.clone();
    const { readable } = new MediaStreamTrackProcessor({
        track: clone,
        maxBufferSize: 1,
      });
    worker.postMessage(
      {
        type: "stream",
        readable,
        startedAtEpoch: performance.timeOrigin + startedAt,
      },
      [readable],
    );
    feed = clone;
  } catch {
    clone?.stop();
    feed = null;
  }
}
async function capture() {
  if (
    feed ||
    !ready ||
    inFlight >= MAX_IN_FLIGHT ||
    video.readyState < 2 ||
    video.currentTime === lastVideoTime
  )
    return;
  const token = session;
  inFlight++;
  lastVideoTime = video.currentTime;
  const timestamp = performance.now() - startedAt;
  try {
    const bitmap = await createImageBitmap(video);
    if (token !== session) {
      bitmap.close();
      return;
    }
    worker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
  } catch (error) {
    if (token === session)
      stopCamera(`Could not read camera: ${error.message}`);
  }
}
function setDelay() {
  const echo = $("mode").value === "echo",
    seconds = Number($("delay").value);
  controller.setDelay(echo ? seconds * 1000 : 0);
  $("delay").disabled = !echo;
  $("delay-value").textContent = `${seconds.toFixed(1)} seconds`;
  $("mode-badge").textContent = echo
    ? `${seconds.toFixed(1)}s echo`
    : "Live mirror";
}
function drawEye(x, y, upper, lower, pose) {
  const w = 360,
    h = 190;
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = "#9cfbd026";
  ctx.shadowBlur = 40;
  ctx.fillStyle = "#dfebe7";
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.save();
  ctx.clip();
  const ix = pose.x * 75,
    iy = pose.y * 35;
  const iris = ctx.createRadialGradient(ix, iy, 17, ix, iy, 69);
  iris.addColorStop(0, "#14363c");
  iris.addColorStop(0.6, "#47ab9f");
  iris.addColorStop(1, "#1b5357");
  ctx.fillStyle = iris;
  ctx.beginPath();
  ctx.arc(ix, iy, 68, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#091820";
  ctx.beginPath();
  ctx.arc(ix, iy, 31, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffffdb";
  ctx.beginPath();
  ctx.ellipse(ix - 20, iy - 25, 11, 8, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff75";
  ctx.beginPath();
  ctx.arc(ix + 17, iy + 19, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1b2b36";
  ctx.fillRect(-w / 2 - 1, -h / 2 - 1, w + 2, (h / 2) * (1 - upper) + 1);
  ctx.fillRect(-w / 2 - 1, (h / 2) * lower, w + 2, h / 2 + 1);
  ctx.restore();
  ctx.strokeStyle = "#506a70";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
// Landmarks come from the latest measured frame, so they can trail the live video slightly.
let overlayDrawnAt = null;
function drawCameraOverlay(fresh) {
  const overlay = $("camera-overlay"),
    octx = overlay.getContext("2d"),
    W = Math.round(overlay.clientWidth * devicePixelRatio),
    H = Math.round(overlay.clientHeight * devicePixelRatio);
  if (overlay.width !== W || overlay.height !== H)
    [overlay.width, overlay.height] = [W, H];
  const drawn = `${packet?.timestamp_ms}:${fresh}:${W}x${H}:${$("camera-tracking").checked}`;
  if (drawn === overlayDrawnAt) return;
  overlayDrawnAt = drawn;
  octx.clearRect(0, 0, W, H);
  const vw = video.videoWidth,
    vh = video.videoHeight;
  if (!$("camera-tracking").checked || !fresh || !vw || !vh) return;
  const scale = Math.min(W / vw, H / vh),
    ox = (W - vw * scale) / 2,
    oy = (H - vh * scale) / 2,
    s = devicePixelRatio;
  const xy = (p) => [W - ox - p.x * vw * scale, oy + p.y * vh * scale];
  octx.font = `${11 * s}px system-ui`;
  if (!packet.face_present || !landmarks?.length) {
    octx.fillStyle = "#ffdb78";
    octx.fillText("Looking for a face…", 10 * s, 20 * s);
    return;
  }
  octx.fillStyle = "#a2f4d080";
  for (let i = 0; i < Math.min(468, landmarks.length); i++) {
    const [x, y] = xy(landmarks[i]);
    octx.fillRect(x - s, y - s, 2 * s, 2 * s);
  }
  for (const side of ["left", "right"]) {
    const e = EYES[side],
      latch = controller.lids[side];
    const color = latch.closed ? "#ff8a8a" : "#69e5e0";
    octx.strokeStyle = color;
    octx.lineWidth = 1.5 * s;
    octx.beginPath();
    octx.moveTo(...xy(landmarks[e.upper]));
    octx.lineTo(...xy(landmarks[e.lower]));
    octx.stroke();
    octx.fillStyle = "#ffdb78";
    const [ix, iy] = xy(landmarks[e.iris]);
    octx.beginPath();
    octx.arc(ix, iy, 2.5 * s, 0, Math.PI * 2);
    octx.fill();
    const [ux, uy] = xy(landmarks[e.upper]);
    octx.fillStyle = color;
    octx.textAlign = "center";
    octx.fillText(
      packet.eyes?.[side]
        ? latch.closed
          ? "closed"
          : `${Math.round(latch.display(controller.lidGain) * 100)}%`
        : "—",
      ux,
      uy - 12 * s,
    );
  }
  octx.textAlign = "left";
  octx.fillStyle = "#e6f1f6";
  octx.fillText(eyeDetail ? "Tracking eyes" : "Come closer for eye detail", 10 * s, 20 * s);
  const head = headTurn(packet);
  if (head) {
    // Mirrored preview: image-right turn shows as a turn to the viewer's left.
    const yaw = Math.round((Math.asin(clamp(head[0], -1, 1)) * 180) / Math.PI);
    const pitch = Math.round((Math.asin(clamp(head[1], -1, 1)) * 180) / Math.PI);
    octx.fillText(
      `Head ${yaw > 0 ? "←" : yaw < 0 ? "→" : ""}${Math.abs(yaw)}° ${pitch > 0 ? "↑" : pitch < 0 ? "↓" : ""}${Math.abs(pitch)}°`,
      10 * s,
      36 * s,
    );
  }
}
const fields = [
  ["Iris x / y", "iris_local"],
  ["Upper lid", "upper_lid"],
  ["Lower lid", "lower_lid"],
  ["Aperture", "aperture"],
  ["Blink score", "blink_score"],
  ["Gaze valid", "gaze_valid"],
];
for (const side of ["left", "right"])
  for (const [label, key] of fields) {
    const term = document.createElement("dt"),
      value = document.createElement("dd");
    term.textContent = label;
    value.id = `${side}-${key}`;
    value.textContent = "—";
    $(`${side}-readings`).append(term, value);
  }
let lastReadings = 0;
function animate(now) {
  const clock = now - startedAt;
  if (ready && now - lastPacketAt > 5000)
    stopCamera("Camera frames stopped arriving. Press Start to reconnect.");
  const scene = controller.update(packet, clock, ready, eyeDetail);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const p = scene.pose;
  drawEye(320, 280, p.upper_left, p.lower_left, p);
  drawEye(780, 280, p.upper_right, p.lower_right, p);
  drawCameraOverlay(ready && packet && clock - packet.timestamp_ms < 750);
  $("title").textContent = scene.title;
  $("prompt").textContent = scene.prompt;
  $("scene-state").textContent = scene.state;
  mech?.update(scene, now);
  if (now - lastReadings > 100) {
    lastReadings = now;
    exploration.render(clock, ready);
    showRates(now);
    const fresh = ready && packet && clock - packet.timestamp_ms < 750;
    for (const side of ["left", "right"])
      for (const [, key] of fields) {
        const value = fresh ? packet?.eyes?.[side]?.[key] : null;
        $(`${side}-${key}`).textContent =
          value == null
            ? "—"
            : Array.isArray(value)
              ? value.map((v) => v.toFixed(3)).join(" / ")
              : typeof value === "boolean"
                ? value
                  ? "Yes"
                  : "No"
                : value.toFixed(3);
      }
  }
  capture();
  requestAnimationFrame(animate);
}
$("start").onclick = startCamera;
$("explore-camera").onclick = () =>
  stream || starting ? stopCamera() : startCamera();
$("stop").onclick = () => stopCamera();
$("mode").onchange = setDelay;
$("delay").oninput = setDelay;
function setGains() {
  controller.lidGain = Number($("lid-gain").value);
  controller.headGain = Number($("head-gain").value);
  $("lid-gain-value").textContent = `${controller.lidGain.toFixed(1)}×`;
  $("head-gain-value").textContent = `${controller.headGain.toFixed(1)}×`;
}
$("lid-gain").oninput = setGains;
$("head-gain").oninput = setGains;
$("record").onclick = () => {
  if (recording !== null) {
    downloadRecording();
    return;
  }
  recording = [];
  $("record").textContent = "Stop & download";
  $("record-status").textContent = "Recording raw measurements…";
};
const playing = startingView(location) === "play";
document.body.classList.toggle("visitor", playing);
$("view-switch").textContent = playing ? "Diagnostics" : "Back to play";
$("view-switch").onclick = () => {
  // Its own address, so the page someone wants is the page they can link to.
  location.search = playing ? "?diagnostics=1" : "?play=1";
};
function showPlay() {
  $("play").textContent = stream || starting ? "Stop the camera" : "Start the camera";
}
$("play").onclick = () => {
  if (stream || starting) stopCamera();
  else startCamera();
  showPlay();
};
$("explore-toggle").onclick = () => {
  // The wink lab is for visitors too, so it opens inside whichever view is showing.
  const exploring = document.body.classList.toggle("exploring");
  if (!exploring) exploration.endAttempt();
  worker?.postMessage({ type: "frames", on: exploring });
  $("explore-toggle").textContent = exploring
    ? "Back to playful eyes"
    : "Explore tracking";
  $("explore-toggle").setAttribute("aria-pressed", String(exploring));
};
$("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    message(
      "Fullscreen is unavailable in this browser.",
    );
  }
};
document.addEventListener("fullscreenchange", () => {
  $("fullscreen").textContent = document.fullscreenElement
    ? "Exit fullscreen"
    : "Fullscreen ↗";
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (stream || starting))
    stopCamera(
      "Camera stopped while this tab was hidden. Press Start to resume.",
    );
});
window.addEventListener("pagehide", () => {
  stopCamera();
  mech?.close();
});
window.addEventListener("beforeunload", (event) => {
  if (recording?.length) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function mechStatus(text, problem = false) {
  $("mech-status").textContent = text;
  $("mech-status").classList.toggle("warning", problem);
}
function setMechSettings() {
  const gain = Number($("mech-gain").value);
  $("mech-gain-value").textContent = `${gain.toFixed(2)}×`;
  if (!mech) return;
  mech.settings = {
    gazeGain: gain,
    reverseLr: $("mech-reverse-lr").checked,
    reverseUd: $("mech-reverse-ud").checked,
    mirrorSides: $("mech-mirror").checked,
    decisiveLids: $("mech-decisive").checked,
  };
}
for (const id of ["mech-gain", "mech-reverse-lr", "mech-reverse-ud", "mech-mirror", "mech-decisive"])
  $(id).oninput = setMechSettings;
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
// Direct opens the board's own /ws/pose; the bridge (just web --eyemech) relays.
function connectMech() {
  mech?.close();
  mech = null;
  const direct = $("mech-link").value === "direct",
    url = direct
      ? boardUrl($("mech-host").value)
      : `ws://${location.hostname}:${bridge.port}`;
  $("mech-host").disabled = !direct;
  if (!$("mech-enable").checked) {
    mechStatus(direct ? "Not sending." : `Not sending. The bridge relays to ${bridge.board}.`);
  } else if (!url) {
    mechStatus("Enter a board address such as eyemech.local.", true);
  } else if (direct && location.protocol === "https:") {
    // A secure page cannot open ws:// to the board; serve it locally instead.
    mechStatus("Direct needs this page served over http://localhost (just web).", true);
  } else {
    mech = new PoseSender(url, mechStatus);
    setMechSettings();
    mechStatus(`Connecting to ${url}…`);
  }
  $("hardware-note").textContent = mech
    ? `Sending poses to ${direct ? url : bridge.board}`
    : "Software only · hardware is not connected";
}
$("mech-link").value = recall("mech-link") === "bridge" ? "bridge" : "direct";
$("mech-host").value = recall("mech-host") || "eyemech.local";
$("mech-enable").onchange = connectMech;
$("mech-link").onchange = () => {
  remember("mech-link", $("mech-link").value);
  connectMech();
};
$("mech-host").onchange = () => {
  remember("mech-host", $("mech-host").value.trim());
  connectMech();
};
// The local server answers bridge.json only when started with --eyemech.
fetch("bridge.json")
  .then((response) => (response.ok ? response.json() : null))
  .then((value) => {
    if (!value) return;
    bridge = value;
    $("mech-link").querySelector('[value="bridge"]').disabled = false;
  })
  .catch(() => {})
  .finally(() => {
    if ($("mech-link").value === "bridge" && !bridge) $("mech-link").value = "direct";
    // A published page cannot reach the board, so it does not pretend otherwise.
    const drivable = canDriveMechanism(location, bridge);
    document.querySelector(".mechanism").hidden = !drivable;
    if (drivable) connectMech();
  });
setDelay();
setGains();
setMechSettings();
requestAnimationFrame(animate);

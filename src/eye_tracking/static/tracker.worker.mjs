const VERSION = "1.0.1";
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
let tracker, makePacket, hasEyeDetail, EYES, estimateIrisColor;
let colorCanvas, colorContext;
// Iris color changes slowly; a full-frame pixel readback every frame is not worth it.
const COLOR_EVERY_MS = 500;
let lastColorAt = -Infinity;
// The full camera frame is only wanted by the exploration view. Transferring one per
// frame costs the page a copy and a close it otherwise never looks at.
let sendFrames = false;
// Measured on an Intel UHD laptop: handing MediaPipe the camera's VideoFrame beats
// converting it to an ImageBitmap first (28 ms vs 35 ms), even though the conversion
// itself takes under a millisecond. Not every browser accepts a VideoFrame, so the
// first refusal switches back to bitmaps for good.
let videoFrameInput = true;
// Direct path: camera frames arrive here from a MediaStreamTrackProcessor, with no
// main-thread copy, screen-refresh wait or postMessage per frame. The processor
// keeps at most one frame buffered, so a slow frame drops stale ones rather than
// queueing them.
async function pump(readable, startedAtEpoch) {
  const reader = readable.getReader();
  let last = -Infinity;
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) return;
    const started = performance.now();
    // Same clock as the page: milliseconds since it started the camera.
    const timestamp = Math.max(
      last + 1,
      Math.floor(performance.timeOrigin + started - startedAtEpoch),
    );
    last = timestamp;
    try {
      // The exploration view needs a real image; tracking alone does not.
      if (videoFrameInput && !sendFrames) {
        try {
          track(frame, timestamp, started, false);
          continue;
        } catch (error) {
          if (!/VideoFrame|image|source|type/i.test(error.message)) throw error;
          videoFrameInput = false;
        }
      }
      track(await createImageBitmap(frame), timestamp, started, true);
    } finally {
      frame.close();
    }
  }
}
// `image` is the camera's VideoFrame, or an ImageBitmap when the page wants the frame.
function track(image, timestamp, started, closeImage = true) {
  const width = image.width ?? image.displayWidth,
    height = image.height ?? image.displayHeight;
  try {
    const trackStart = performance.now();
    const result = tracker.detectForVideo(image, timestamp);
    const trackMs = performance.now() - trackStart;
    const packet = makePacket(result, timestamp, width, height);
    let irisColors = null;
    if (packet.face_present && started - lastColorAt >= COLOR_EVERY_MS) {
      lastColorAt = started;
      colorCanvas ??= new OffscreenCanvas(width, height);
      colorContext ??= colorCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (
        colorCanvas.width !== width ||
        colorCanvas.height !== height
      ) {
        colorCanvas.width = width;
        colorCanvas.height = height;
      }
      colorContext.drawImage(image, 0, 0);
      const pixels = colorContext.getImageData(
        0,
        0,
        colorCanvas.width,
        colorCanvas.height,
      );
      irisColors = Object.fromEntries(
        Object.entries(EYES).map(([side, indices]) => [
          side,
          estimateIrisColor(
            pixels,
            result.faceLandmarks[0],
            indices,
            packet.eyes[side],
          ),
        ]),
      );
    }
    self.postMessage(
      {
        type: "packet",
        // Transient inspection data is outside the versioned measurement packet.
        frame: sendFrames && closeImage ? image : null,
        landmarks: result.faceLandmarks?.[0] ?? null,
        irisColors,
        trackMs,
        workMs: performance.now() - started,
        eyeDetail: hasEyeDetail(
          result.faceLandmarks?.[0],
          width,
          height,
        ),
        packet,
      },
      sendFrames && closeImage ? [image] : [],
    );
  } finally {
    if (closeImage) image.close();
  }
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      ({ makePacket, hasEyeDetail, EYES } = await import("./measurements.mjs"));
      ({ estimateIrisColor } = await import("./iris-color.mjs"));
      const { FaceLandmarker, FilesetResolver } = await import(
        `${BASE}/vision_bundle.mjs`
      );
      const vision = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      const create = (delegate) =>
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      // The GPU (WebGL2 on this worker's OffscreenCanvas) is typically several
      // times faster; the CPU is the fallback where WebGL2 is unavailable.
      let delegate = data.delegate === "CPU" ? "CPU" : "GPU";
      try {
        tracker = await create(delegate);
      } catch (error) {
        if (delegate === "CPU") throw error;
        delegate = "CPU";
        tracker = await create(delegate);
      }
      self.postMessage({ type: "ready", delegate });
    } else if (data.type === "frame") {
      // Fallback path: the page grabbed this frame and posted it.
      track(data.bitmap, data.timestamp, performance.now());
    } else if (data.type === "frames") {
      sendFrames = Boolean(data.on);
    } else if (data.type === "stream") {
      try {
        await pump(data.readable, data.startedAtEpoch);
      } catch (error) {
        self.postMessage({ type: "feed-failed", message: error.message });
      }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};

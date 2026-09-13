const VERSION = "0.10.32";
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
let tracker, makePacket, hasEyeDetail, EYES, estimateIrisColor;
let colorCanvas, colorContext;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      ({ makePacket, hasEyeDetail, EYES } = await import("./measurements.mjs"));
      ({ estimateIrisColor } = await import("./iris-color.mjs"));
      const { FaceLandmarker, FilesetResolver } = await import(
        `${BASE}/vision_bundle.mjs`
      );
      const vision = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      tracker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      self.postMessage({ type: "ready" });
    } else if (data.type === "frame") {
      try {
        const result = tracker.detectForVideo(data.bitmap, data.timestamp);
        const packet = makePacket(
          result,
          data.timestamp,
          data.bitmap.width,
          data.bitmap.height,
        );
        let irisColors = null;
        if (packet.face_present) {
          colorCanvas ??= new OffscreenCanvas(
            data.bitmap.width,
            data.bitmap.height,
          );
          colorContext ??= colorCanvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (
            colorCanvas.width !== data.bitmap.width ||
            colorCanvas.height !== data.bitmap.height
          ) {
            colorCanvas.width = data.bitmap.width;
            colorCanvas.height = data.bitmap.height;
          }
          colorContext.drawImage(data.bitmap, 0, 0);
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
            frame: data.bitmap,
            landmarks: result.faceLandmarks?.[0] ?? null,
            irisColors,
            eyeDetail: hasEyeDetail(
              result.faceLandmarks?.[0],
              data.bitmap.width,
              data.bitmap.height,
            ),
            packet,
          },
          [data.bitmap],
        );
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};

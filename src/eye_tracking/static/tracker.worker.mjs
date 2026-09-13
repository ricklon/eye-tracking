const VERSION = "0.10.32";
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
let tracker, makePacket, hasEyeDetail;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      ({ makePacket, hasEyeDetail } = await import("./measurements.mjs"));
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
        self.postMessage({
          type: "packet",
          eyeDetail: hasEyeDetail(
            result.faceLandmarks?.[0],
            data.bitmap.width,
            data.bitmap.height,
          ),
          packet: makePacket(
            result,
            data.timestamp,
            data.bitmap.width,
            data.bitmap.height,
          ),
        });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};

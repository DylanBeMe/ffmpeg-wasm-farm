import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { ParallelFFmpeg } from "ffmpeg-wasm-farm";

const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const fileInput = document.querySelector<HTMLInputElement>("#file");
const output = document.querySelector<HTMLVideoElement>("#output");

if (!fileInput || !output) {
  throw new Error("The example requires #file and #output elements.");
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  const loadConfig = {
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  };

  const farm = new ParallelFFmpeg(() => new FFmpeg());
  const result = await farm.transcode(file, {
    inputName: file.name,
    outputName: "output.mp4",
    segmentSeconds: 12,
    workerCount: ParallelFFmpeg.recommendedWorkerCount(),
    audioStrategy: "single-pass",
    audioArgs: ["-c:a", "aac", "-b:a", "128k"],
    encodingArgs: [
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
    ],
    muxArgs: ["-movflags", "+faststart"],
    loadConfig,
    onProgress: ({ stage, ratio, completedSegments, totalSegments }) => {
      console.log(stage, `${Math.round(ratio * 100)}%`, `${completedSegments}/${totalSegments}`);
    },
  });

  const url = URL.createObjectURL(
    new Blob([result.data.slice().buffer], { type: "video/mp4" }),
  );
  output.src = url;
  output.addEventListener("emptied", () => URL.revokeObjectURL(url), { once: true });
});

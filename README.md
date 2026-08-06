# ffmpeg-wasm-farm

A multicore browser transcoder built on the single-thread `@ffmpeg/core`. It gets parallelism by transcoding independent, keyframe-aligned segments in separate FFmpeg Web Workers, then concatenating them in source order.

This is intentionally different from `@ffmpeg/core-mt`: it does **not** use `SharedArrayBuffer`, Emscripten pthreads, COOP, or COEP.

## What is included

- A strict TypeScript library with cancellation, progress, structured logs, argument validation, and collision-safe virtual filenames.
- A responsive browser demo in `demo/` with drag and drop, presets, progress, cancellation, result preview, diagnostics, and matching light/dark themes.
- Unit, integration, cancellation, concurrency, command-topology, and native FFmpeg smoke tests.

## Install

```bash
npm install ffmpeg-wasm-farm @ffmpeg/ffmpeg @ffmpeg/core @ffmpeg/util
```

## Library usage

```ts
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { ParallelFFmpeg } from "ffmpeg-wasm-farm";

const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const loadConfig = {
  coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
  wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
};

const farm = new ParallelFFmpeg(() => new FFmpeg());
const controller = new AbortController();

const result = await farm.transcode(file, {
  inputName: file.name,
  outputName: "output.mp4",
  workerCount: ParallelFFmpeg.recommendedWorkerCount(),
  segmentSeconds: 12,

  // Encode audio once to avoid codec priming delay at every segment boundary.
  audioStrategy: "single-pass",
  audioArgs: ["-c:a", "aac", "-b:a", "128k"],

  // Applied independently to each video segment.
  encodingArgs: [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
  ],
  muxArgs: ["-movflags", "+faststart"],
  loadConfig,
  signal: controller.signal,
  onProgress: ({ stage, ratio, completedSegments, totalSegments }) => {
    console.log(stage, Math.round(ratio * 100), `${completedSegments}/${totalSegments}`);
  },
  onLog: ({ scope, worker, message }) => {
    console.debug(scope, worker, message);
  },
});

const outputURL = URL.createObjectURL(
  new Blob([result.data.slice().buffer], { type: "video/mp4" }),
);
```

Calling `controller.abort()` rejects the operation with an `AbortError` and terminates active FFmpeg workers.

## Run the demo app

```bash
npm install
npm run demo
```

Production build:

```bash
npm run demo:build
```

The demo uses a single token-based theme for every tab, card, dialog state, log view, and responsive layout. It remembers the selected light/dark theme locally.

## Choosing concurrency

Start with two to four workers. Each active worker owns a full FFmpeg WebAssembly heap, so matching a high-end desktop's full logical CPU count can exhaust browser memory. Automatic concurrency is capped at four and leaves one logical core for the browser.

Useful segment sizes are usually 8–20 seconds. Tiny segments increase startup and mux overhead; very large segments reduce load balancing.

User-provided `workerCount` values are limited to 16 as a final guard against accidental memory exhaustion.

## Audio strategies

- `single-pass`: probe and encode audio once, transcode video segments in parallel, then mux them together. Best default for MP4 and WebM. The final mux preserves the full video duration; add `"-shortest"` to `muxArgs` only when deliberate truncation to the shorter stream is wanted.
- `per-segment`: keep audio in each segment. Audio is stream-copied by default unless the encoding arguments explicitly request audio processing.
- `drop`: produce video without audio.

## Safety and correctness guards

- Anonymous byte inputs are sniffed for common container signatures. Unknown inputs must provide `inputName`.
- Filenames are sanitized and leading dashes are neutralized so FFmpeg cannot interpret them as options.
- Every run uses a unique internal prefix, preventing collisions with source and output filenames.
- Managed FFmpeg options such as extra inputs, stream maps, output formats, and final codecs are rejected in the wrong argument group.
- Runtime callers receive clear errors for malformed argument arrays, invalid audio strategies, unsafe worker counts, and contradictory single-pass audio flags.
- Caller-owned option arrays are snapshotted before asynchronous work, so mid-run mutations cannot make segments use different codecs or filters.
- Overall progress is monotonic even when individual worker progress events reset.
- Recent FFmpeg output is attached to nonzero-exit errors.
- Observer callback failures are reported without discarding an otherwise successful export.

## What parallelizes well

Independent video transcodes, resizing, pixel-format conversion, overlays that do not depend on global timeline state, and per-segment filters.

## What does not

Two-pass encoding, exact whole-file bitrate allocation, filters whose state must flow across segment boundaries, commands with multiple external inputs, and lossless preservation of inter-segment codec state.

## Browser and bundler notes

Use the single-thread `@ffmpeg/core` asset, not `@ffmpeg/core-mt`. Host core files on your own origin in production when possible. The `FFmpeg` class already runs each core in a dedicated worker; creating several instances creates the process-level worker pool.

The FFmpeg progress event is best-effort. Segment counts and stage transitions remain useful even when codec progress is not exact.

## Development

```bash
npm run check
bash tests/real-ffmpeg-smoke.sh
```

GitHub Actions configuration is included for Node.js 20/22/24 CI, native FFmpeg smoke testing, npm package artifacts, Dependabot updates, and tag-driven npm/GitHub releases. See [`RELEASING.md`](./RELEASING.md) for the one-time setup and release procedure.

The package has no runtime dependency on a concrete FFmpeg class. Its FFmpeg peer packages are optional, and it accepts a structural factory so applications control the exact build, asset URLs, and bundling strategy.

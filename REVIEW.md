# Code and UX review

## 0.2.1 follow-up

- Removed the implicit `-shortest` flag from single-pass audio assembly so a shorter audio stream no longer truncates valid trailing video. Callers can still opt in through `muxArgs`.
- Added native FFmpeg regression coverage using a 9-second video with 3-second audio and asserted that the output remains 9 seconds.
- Snapshotted caller-owned argument arrays and load configuration before asynchronous work, preventing mid-run mutation from producing incompatible segment commands.
- Added runtime validation for malformed argument arrays, invalid audio strategies, empty explicit filenames, contradictory single-pass `-an`, and invalid pool item counts.
- Required distinct active worker instances and made listener removal and worker termination best-effort so cleanup cannot mask a successful result or a more useful original error.
- Marked FFmpeg peer packages optional and declared the ESM package side-effect-free for bundlers.

## Scope

The 0.2.0 review covered the TypeScript library, FFmpeg command construction, cancellation and lifecycle behavior, memory-sensitive data movement, automated tests, package metadata, examples, and the complete browser demo.

## Correctness fixes

- Made internal virtual filenames unique per run so user filenames cannot overwrite planner, segment, manifest, audio, or output files.
- Sanitized paths and neutralized leading dashes before passing names to FFmpeg.
- Forwarded `AbortSignal` to load, execution, probe, read, write, and directory operations, then terminated affected engines after cancellation.
- Made overall progress monotonic across worker resets and separated overall progress from stage-local progress.
- Stopped the indexed worker pool from claiming new jobs after the first failure.
- Added explicit `ffprobe` capability validation for single-pass audio.
- Added audio-stream detection so silent video can complete without a failed audio extraction.
- Added strict validation for managed FFmpeg arguments, worker limits, segment duration, timeouts, and required file extensions.
- Attached recent FFmpeg log output to command failures and protected successful runs from observer callback exceptions.

## Performance and regression fixes

- Transfer-safe input handling now copies only when preservation is requested or a `SharedArrayBuffer` cannot be transferred.
- Consumed source and encoded arrays are released as soon as ownership moves to an FFmpeg worker.
- Worker concurrency is automatically capped at four and explicitly capped at sixteen to reduce accidental memory exhaustion.
- Per-segment audio is stream-copied unless the caller requests audio processing.
- The demo caches same-origin blob URLs for the FFmpeg core after the first load.
- Activity logs are capped at 250 rendered rows to prevent unbounded DOM growth.
- Package consumers are no longer constrained by the Node version needed only by the demo's Vite development toolchain.

## UX and visual consistency

- Added one responsive token-based theme across Transcode, Activity, and Guide panels.
- Added persistent light and dark modes, consistent surfaces, typography, spacing, focus states, and reduced-motion behavior.
- Added drag and drop, file summary, presets, hardware-aware worker controls, progress, cancellation, diagnostics, preview, and download states.
- Added accessible tab semantics with arrow, Home, and End navigation plus correct focus and hidden-panel behavior.
- Removed audio-only selection from a video-only workflow, reject empty/audio files clearly, and normalize the output extension to the chosen preset.
- Added large-file memory guidance and worker-count warnings before execution.

## Remaining architectural limits

- Every active worker owns a full FFmpeg WebAssembly heap. Peak memory can still be high because source segments, encoded segments, and the final assembler coexist during parts of a run.
- Encoded segments are retained until final assembly; a future streaming or persistent-assembler design could lower JavaScript heap pressure at the cost of another live FFmpeg instance or more scheduling complexity.
- Segment-level parallelism is unsuitable for two-pass encoding, exact whole-file rate allocation, stateful temporal filters, and commands with multiple external inputs.
- FFmpeg's progress signal is best-effort; stage transitions and completed segment counts are more reliable than codec-local percentages.

## Validation performed

- Strict TypeScript library build.
- Demo TypeScript typecheck.
- Unit and mock integration tests for binary handling, argument construction, scheduling, cancellation, concurrency, output ordering, progress monotonicity, log scope, capability errors, and UI structure/theme consistency.
- Native FFmpeg smoke test of the split, parallel-transcode command topology, concat, and single-pass audio mux.
- Static accessibility and responsive-theme audit of the demo markup, CSS, and interactions.

A full browser screenshot run could not be completed in this sandbox because local-page navigation was blocked by the browser policy. The UI source was still statically audited and typechecked; final visual verification should be repeated in the target browsers after installing the demo dependencies.

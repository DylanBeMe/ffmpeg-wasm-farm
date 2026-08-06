# Design

## Why a worker farm instead of pthreads?

A pthread-enabled Emscripten build shares one WebAssembly memory across workers. That is useful for fine-grained codec threading, but browser deployment requires cross-origin isolation and every thread contends for one allocator and heap.

This project uses coarse-grained temporal parallelism:

1. A planner FFmpeg instance remuxes the source into keyframe-aligned Matroska segments.
2. The planner transfers the segment buffers to JavaScript and terminates.
3. Several independent single-thread FFmpeg instances transcode different segments concurrently.
4. All but one worker terminate. The remaining worker receives the encoded segments, concatenates them, and performs the final mux.

Every engine owns separate WebAssembly memory. A failed segment worker cannot corrupt another worker's heap, and the page does not need `SharedArrayBuffer` or COOP/COEP headers.

## Memory model

`@ffmpeg/ffmpeg` transfers `Uint8Array` buffers through `postMessage`. The implementation immediately replaces consumed array entries, so detached buffers do not remain accidentally reachable.

There is still an unavoidable memory cost:

- one FFmpeg heap per active worker;
- unprocessed source segments in JavaScript;
- completed encoded segments waiting for assembly;
- the final assembler heap.

The default recommendation is capped at four workers and user-supplied concurrency is capped at 16. Applications should lower concurrency for large files and memory-constrained devices.

## Internal filesystem isolation

A fresh, run-specific prefix is applied to every planner segment, audio track, probe file, worker input, worker output, encoded segment, and concat manifest. This prevents a source named `source_000000.mkv` or an output named `concat.txt` from overwriting managed files.

User filenames are reduced to a basename, unsupported characters are replaced, and a leading dash is prefixed with an underscore so FFmpeg cannot interpret a virtual path as another command-line option.

## Cancellation

The active `AbortSignal` is forwarded to FFmpeg load, exec, and filesystem calls. `@ffmpeg/ffmpeg` rejects the pending API call; the farm then terminates every affected worker to stop the underlying WebAssembly execution and free its heap. Log and progress listeners are detached during disposal when the engine supports `off()`.

Cancellation is destructive for the current worker set. A later export creates fresh engines.

## Progress

Pipeline stages occupy fixed overall ranges. Worker progress contributes fractional segment completion while completed segments contribute whole units. The emitted overall ratio is clamped to be monotonic, preventing progress bars from moving backward when a worker starts its next segment.

FFmpeg progress itself is best-effort, so stage transitions and completed segment counts are the authoritative UI signals.

## Audio handling

`audioStrategy="single-pass"` uses ffprobe when available to detect an audio stream, encodes it once, and muxes it with the concatenated video. This avoids codec priming delay at every segment boundary. The mux does not add `-shortest` implicitly, because valid sources can contain audio that ends before the video; callers can opt into that truncation through `muxArgs`.

`per-segment` maps audio into every segment and stream-copies it unless the caller explicitly supplies audio-processing options. This avoids an accidental default audio encode and reduces work.

## Correctness boundaries

Cuts are requested every `segmentSeconds`, but the segment muxer cuts on suitable keyframes. Segments therefore vary in duration.

Temporal filters, filters with long state, two-pass encodes, exact whole-file rate control, commands with multiple external inputs, and sources whose stream parameters change between segments are not automatically parallelizable by this design.

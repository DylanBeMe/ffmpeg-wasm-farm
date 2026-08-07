import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssembleArgs,
  buildAudioProbeArgs,
  buildAudioArgs,
  buildConcatManifest,
  parseMediaTimingProbe,
  buildSegmentTranscodeArgs,
  buildSplitArgs,
  segmentName,
  validateOptions,
} from "../dist/internal/commands.js";

function validOptions(overrides = {}) {
  return {
    inputName: "input.mp4",
    outputName: "output.mp4",
    encodingArgs: ["-c:v", "libx264"],
    segmentSeconds: 10,
    workerCount: 2,
    audioStrategy: "per-segment",
    audioArgs: [],
    muxArgs: [],
    intermediateStorage: "auto",
    ...overrides,
  };
}

test("split command maps both streams for per-segment audio", () => {
  const args = buildSplitArgs({
    inputName: "input.mp4",
    segmentPattern: "source_%06d.mkv",
    segmentSeconds: 10,
    audioStrategy: "per-segment",
  });
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-c")), ["-map", "0:v:0?", "-map", "0:a:0?"]);
  assert.equal(args.at(-1), "source_%06d.mkv");
});

test("single-pass segment transcode drops audio", () => {
  const args = buildSegmentTranscodeArgs({
    inputName: "in.mkv",
    outputName: "out.mkv",
    encodingArgs: ["-c:v", "libx264", "-crf", "23"],
    audioStrategy: "single-pass",
  });
  assert.ok(args.includes("-an"));
  assert.equal(args.at(-1), "out.mkv");
});

test("per-segment audio is copied unless audio processing was requested", () => {
  const copied = buildSegmentTranscodeArgs({
    inputName: "in.mkv",
    outputName: "out.mkv",
    encodingArgs: ["-c:v", "libx264"],
    audioStrategy: "per-segment",
  });
  assert.deepEqual(copied.slice(copied.indexOf("-c:a"), copied.indexOf("-c:a") + 2), ["-c:a", "copy"]);

  const encoded = buildSegmentTranscodeArgs({
    inputName: "in.mkv",
    outputName: "out.mkv",
    encodingArgs: ["-c:v", "libx264", "-c:a", "aac"],
    audioStrategy: "per-segment",
  });
  assert.equal(encoded.filter((token) => token === "-c:a").length, 1);
});

test("assembler preserves the full video duration by default", () => {
  const args = buildAssembleArgs({
    manifestName: "concat.txt",
    outputName: "output.mp4",
    audioName: "audio.mka",
    muxArgs: ["-movflags", "+faststart"],
  });
  assert.deepEqual(args.slice(-3), ["-movflags", "+faststart", "output.mp4"]);
  assert.equal(args.includes("-shortest"), false);
  assert.equal(args.includes("-copyts"), true);

  const shortest = buildAssembleArgs({
    manifestName: "concat.txt",
    outputName: "output.mp4",
    audioName: "audio.mka",
    muxArgs: ["-shortest"],
  });
  assert.equal(shortest.filter((token) => token === "-shortest").length, 1);
});

test("audio probe requests A/V start timestamps", () => {
  const args = buildAudioProbeArgs({ inputName: "input.mp4", outputName: "probe.txt" });
  assert.deepEqual(
    args.slice(args.indexOf("-show_entries"), args.indexOf("input.mp4")),
    ["-show_entries", "format=start_time:stream=codec_type,start_time", "-of", "json"],
  );
  assert.deepEqual(args.slice(-2), ["-o", "probe.txt"]);
});

test("timing probe preserves relative A/V starts independent of absolute container time", () => {
  assert.deepEqual(parseMediaTimingProbe(JSON.stringify({
    streams: [
      { codec_type: "video", start_time: "5.000000" },
      { codec_type: "audio", start_time: "5.500000" },
    ],
  })), { hasAudio: true, timelineBaselineSeconds: 5, videoOffsetSeconds: 0 });
  assert.deepEqual(parseMediaTimingProbe(JSON.stringify({
    streams: [
      { codec_type: "video", start_time: "5.500000" },
      { codec_type: "audio", start_time: "5.000000" },
    ],
  })), { hasAudio: true, timelineBaselineSeconds: 5, videoOffsetSeconds: 0.5 });
});

test("audio extraction rebases timestamps to the selected A/V timeline", () => {
  const args = buildAudioArgs({
    inputName: "input.mkv",
    outputName: "audio.mka",
    audioArgs: ["-c:a", "copy"],
    timelineBaselineSeconds: 5,
  });
  assert.deepEqual(args.slice(args.indexOf("-copyts"), args.indexOf("-i")), ["-copyts", "-itsoffset", "-5"]);
});

test("manifest is ordered and newline terminated", () => {
  assert.equal(
    buildConcatManifest(["encoded_000000.mkv", "encoded_000001.mkv"]),
    "file 'encoded_000000.mkv'\nfile 'encoded_000001.mkv'\n",
  );
});

test("segment names sort lexicographically", () => {
  assert.equal(segmentName(12), "segment_000012.mkv");
});

test("managed ffmpeg arguments are rejected in every argument group", () => {
  assert.throws(() => validateOptions(validOptions({ encodingArgs: ["-i=other.mp4"] })), /encodingArgs/);
  assert.throws(() => validateOptions(validOptions({ audioArgs: ["-map", "0:a"] })), /audioArgs/);
  assert.throws(() => validateOptions(validOptions({ muxArgs: ["-c:v", "copy"] })), /muxArgs/);
});

test("unsafe concurrency, timeout, and storage values are rejected", () => {
  assert.throws(() => validateOptions(validOptions({ workerCount: 17 })), /workerCount/);
  assert.throws(() => validateOptions(validOptions({ execTimeoutMs: 0 })), /execTimeoutMs/);
  assert.throws(() => validateOptions(validOptions({ intermediateStorage: "disk" })), /intermediateStorage/);
});

test("runtime option shapes and strategy values are validated", () => {
  assert.throws(() => validateOptions(validOptions({ audioStrategy: "surround" })), /audioStrategy/);
  assert.throws(() => validateOptions(validOptions({ encodingArgs: null })), /encodingArgs/);
  assert.throws(() => validateOptions(validOptions({ muxArgs: ["-movflags", 42] })), /muxArgs\[1\]/);
  assert.throws(() => validateOptions(validOptions({
    audioStrategy: "single-pass",
    audioArgs: ["-an"],
  })), /audioArgs/);
});

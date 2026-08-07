import type { AudioStrategy, IntermediateStorage } from "../types.js";

const MAX_WORKER_COUNT = 16;
const AUDIO_STRATEGIES: ReadonlySet<string> = new Set(["per-segment", "single-pass", "drop"]);
const INTERMEDIATE_STORAGE_MODES: ReadonlySet<string> = new Set(["auto", "memory", "opfs"]);
const MANAGED_ENCODING_OPTIONS = new Set([
  "-f",
  "-filter_complex",
  "-filter_complex_script",
  "-i",
  "-map",
  "-map_chapters",
  "-map_metadata",
]);
const MANAGED_AUDIO_OPTIONS = new Set([
  "-f",
  "-filter_complex",
  "-filter_complex_script",
  "-i",
  "-map",
  "-vn",
  "-an",
]);
const MANAGED_MUX_OPTIONS = new Set([
  "-c",
  "-codec",
  "-f",
  "-filter_complex",
  "-filter_complex_script",
  "-i",
  "-map",
]);

export function validateOptions(args: {
  inputName: string;
  outputName: string;
  encodingArgs: string[];
  segmentSeconds: number;
  workerCount: number;
  audioStrategy: AudioStrategy;
  audioArgs: string[];
  muxArgs: string[];
  intermediateStorage: IntermediateStorage;
  execTimeoutMs?: number;
}): void {
  if (typeof args.inputName !== "string") {
    throw new TypeError("inputName must be a string.");
  }
  if (typeof args.outputName !== "string") {
    throw new TypeError("outputName must be a string.");
  }
  if (!hasExtension(args.inputName)) {
    throw new Error("inputName must include a file extension so FFmpeg can infer the demuxer.");
  }
  if (!hasExtension(args.outputName)) {
    throw new Error("outputName must include a file extension so FFmpeg can infer the muxer.");
  }
  if (!Number.isFinite(args.segmentSeconds) || args.segmentSeconds < 1) {
    throw new Error("segmentSeconds must be a finite number >= 1.");
  }
  if (!Number.isInteger(args.workerCount) || args.workerCount < 1) {
    throw new Error("workerCount must be an integer >= 1.");
  }
  if (args.workerCount > MAX_WORKER_COUNT) {
    throw new Error(`workerCount must be <= ${MAX_WORKER_COUNT} to avoid excessive browser memory use.`);
  }
  if (
    args.execTimeoutMs !== undefined
    && (!Number.isFinite(args.execTimeoutMs) || args.execTimeoutMs <= 0)
  ) {
    throw new Error("execTimeoutMs must be a finite number > 0 when provided.");
  }
  if (!AUDIO_STRATEGIES.has(args.audioStrategy)) {
    throw new Error('audioStrategy must be "per-segment", "single-pass", or "drop".');
  }
  if (!INTERMEDIATE_STORAGE_MODES.has(args.intermediateStorage)) {
    throw new Error('intermediateStorage must be "auto", "memory", or "opfs".');
  }

  validateArgumentList("encodingArgs", args.encodingArgs);
  validateArgumentList("audioArgs", args.audioArgs);
  validateArgumentList("muxArgs", args.muxArgs);
  validateManagedOptions("encodingArgs", args.encodingArgs, MANAGED_ENCODING_OPTIONS);
  validateManagedOptions("audioArgs", args.audioArgs, MANAGED_AUDIO_OPTIONS);
  validateManagedOptions("muxArgs", args.muxArgs, MANAGED_MUX_OPTIONS);

  if (args.audioStrategy === "single-pass" && args.audioArgs.length === 0) {
    throw new Error("audioArgs is required when audioStrategy is single-pass.");
  }
}

export function buildSplitArgs(args: {
  inputName: string;
  segmentPattern: string;
  segmentSeconds: number;
  audioStrategy: AudioStrategy;
}): string[] {
  const mapArgs = args.audioStrategy === "per-segment"
    ? ["-map", "0:v:0?", "-map", "0:a:0?"]
    : ["-map", "0:v:0?", "-an"];

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    args.inputName,
    ...mapArgs,
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-f",
    "segment",
    "-segment_format",
    "matroska",
    "-segment_time",
    String(args.segmentSeconds),
    "-segment_time_delta",
    "0.05",
    "-reset_timestamps",
    "1",
    args.segmentPattern,
  ];
}

export function buildAudioProbeArgs(args: {
  inputName: string;
  outputName: string;
}): string[] {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=start_time:stream=codec_type,start_time",
    "-of",
    "json",
    args.inputName,
    "-o",
    args.outputName,
  ];
}

export function parseMediaTimingProbe(value: string): {
  hasAudio: boolean;
  timelineBaselineSeconds: number;
  videoOffsetSeconds: number;
} {
  let document: {
    streams?: Array<{ codec_type?: string; start_time?: string }>;
  };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Probe document must be an object.");
    }
    document = parsed as typeof document;
  } catch (error) {
    throw new Error("Audio stream probe returned invalid JSON.", { cause: error });
  }

  const streams = Array.isArray(document.streams) ? document.streams : [];
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  if (!audio) return { hasAudio: false, timelineBaselineSeconds: 0, videoOffsetSeconds: 0 };

  const video = streams.find((stream) => stream?.codec_type === "video");
  const audioStart = finiteTimestamp(audio.start_time) ?? 0;
  const videoStart = finiteTimestamp(video?.start_time) ?? audioStart;
  const baseline = Math.min(videoStart, audioStart);

  return {
    hasAudio: true,
    timelineBaselineSeconds: baseline,
    videoOffsetSeconds: Math.max(0, videoStart - baseline),
  };
}

export function buildAudioArgs(args: {
  inputName: string;
  outputName: string;
  audioArgs: string[];
  timelineBaselineSeconds?: number;
}): string[] {
  const timelineBaselineSeconds = args.timelineBaselineSeconds ?? 0;
  if (!Number.isFinite(timelineBaselineSeconds)) {
    throw new Error("timelineBaselineSeconds must be finite.");
  }
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-copyts",
    ...(timelineBaselineSeconds === 0
      ? []
      : ["-itsoffset", String(-timelineBaselineSeconds)]),
    "-i",
    args.inputName,
    "-map",
    "0:a:0?",
    "-vn",
    ...args.audioArgs,
    args.outputName,
  ];
}

export function buildSegmentTranscodeArgs(args: {
  inputName: string;
  outputName: string;
  encodingArgs: string[];
  audioStrategy: AudioStrategy;
}): string[] {
  const mapArgs = args.audioStrategy === "per-segment"
    ? ["-map", "0:v:0?", "-map", "0:a:0?"]
    : ["-map", "0:v:0?", "-an"];
  const defaultAudioArgs = args.audioStrategy === "per-segment" && !hasAudioProcessingOption(args.encodingArgs)
    ? ["-c:a", "copy"]
    : [];

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    args.inputName,
    ...mapArgs,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    ...defaultAudioArgs,
    ...args.encodingArgs,
    args.outputName,
  ];
}

export function buildConcatManifest(segmentNames: string[]): string {
  return segmentNames.map((name) => `file '${escapeConcatPath(name)}'`).join("\n") + "\n";
}

export function buildAssembleArgs(args: {
  manifestName: string;
  outputName: string;
  audioName?: string;
  videoOffsetSeconds?: number;
  muxArgs: string[];
}): string[] {
  const videoOffsetSeconds = args.videoOffsetSeconds ?? 0;
  if (!Number.isFinite(videoOffsetSeconds) || videoOffsetSeconds < 0) {
    throw new Error("videoOffsetSeconds must be a finite number >= 0.");
  }
  const base = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...(args.audioName && videoOffsetSeconds > 0
      ? ["-itsoffset", String(videoOffsetSeconds)]
      : []),
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    args.manifestName,
  ];

  if (args.audioName) {
    return [
      ...base,
      "-i",
      args.audioName,
      // Each input normally gets rebased independently. Preserve the relative
      // timestamps established during extraction/segment assembly instead.
      "-copyts",
      "-map",
      "0:v:0?",
      "-map",
      "1:a:0?",
      "-c",
      "copy",
      ...args.muxArgs,
      args.outputName,
    ];
  }

  return [
    ...base,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    ...args.muxArgs,
    args.outputName,
  ];
}

function finiteTimestamp(value: string | undefined): number | undefined {
  if (value === undefined || value === "N/A") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function segmentName(index: number, prefix = "segment"): string {
  return `${prefix}_${String(index).padStart(6, "0")}.mkv`;
}

function validateArgumentList(label: string, tokens: unknown): asserts tokens is string[] {
  if (!Array.isArray(tokens)) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string") {
      throw new TypeError(`${label}[${index}] must be a string.`);
    }
    if (token.includes("\0")) {
      throw new Error(`${label}[${index}] must not contain a null byte.`);
    }
  }
}

function validateManagedOptions(
  label: string,
  tokens: readonly string[],
  forbidden: ReadonlySet<string>,
): void {
  for (const token of tokens) {
    if (!token.startsWith("-")) continue;
    const option = token.split("=", 1)[0]?.toLowerCase() ?? token.toLowerCase();
    if (forbidden.has(option) || isManagedStreamCodec(option, forbidden)) {
      throw new Error(`${label} must not contain ${token}; that part of the command is managed by the farm.`);
    }
  }
}

function isManagedStreamCodec(option: string, forbidden: ReadonlySet<string>): boolean {
  if (!forbidden.has("-c") && !forbidden.has("-codec")) return false;
  return option === "-c:v"
    || option === "-c:a"
    || option === "-codec:v"
    || option === "-codec:a"
    || option === "-vcodec"
    || option === "-acodec";
}

function hasAudioProcessingOption(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const option = token.split("=", 1)[0]?.toLowerCase() ?? token.toLowerCase();
    return option === "-c:a"
      || option === "-codec:a"
      || option === "-acodec"
      || option === "-af"
      || option === "-filter:a"
      || option === "-filter_audio"
      || option === "-an"
      || option.startsWith("-b:a")
      || option.startsWith("-q:a");
  });
}

function escapeConcatPath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

function hasExtension(path: string): boolean {
  const lastPart = path.split("/").at(-1) ?? path;
  return /^.+\.[A-Za-z0-9]{1,12}$/.test(lastPart);
}

const MAX_WORKER_COUNT = 16;
const AUDIO_STRATEGIES = new Set(["per-segment", "single-pass", "drop"]);
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
export function validateOptions(args) {
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
    if (args.execTimeoutMs !== undefined
        && (!Number.isFinite(args.execTimeoutMs) || args.execTimeoutMs <= 0)) {
        throw new Error("execTimeoutMs must be a finite number > 0 when provided.");
    }
    if (!AUDIO_STRATEGIES.has(args.audioStrategy)) {
        throw new Error('audioStrategy must be "per-segment", "single-pass", or "drop".');
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
export function buildSplitArgs(args) {
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
export function buildAudioProbeArgs(args) {
    return [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        args.inputName,
        "-o",
        args.outputName,
    ];
}
export function buildAudioArgs(args) {
    return [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        args.inputName,
        "-map",
        "0:a:0?",
        "-vn",
        ...args.audioArgs,
        args.outputName,
    ];
}
export function buildSegmentTranscodeArgs(args) {
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
export function buildConcatManifest(segmentNames) {
    return segmentNames.map((name) => `file '${escapeConcatPath(name)}'`).join("\n") + "\n";
}
export function buildAssembleArgs(args) {
    const base = [
        "-hide_banner",
        "-loglevel",
        "warning",
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
export function segmentName(index, prefix = "segment") {
    return `${prefix}_${String(index).padStart(6, "0")}.mkv`;
}
function validateArgumentList(label, tokens) {
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
function validateManagedOptions(label, tokens, forbidden) {
    for (const token of tokens) {
        if (!token.startsWith("-"))
            continue;
        const option = token.split("=", 1)[0]?.toLowerCase() ?? token.toLowerCase();
        if (forbidden.has(option) || isManagedStreamCodec(option, forbidden)) {
            throw new Error(`${label} must not contain ${token}; that part of the command is managed by the farm.`);
        }
    }
}
function isManagedStreamCodec(option, forbidden) {
    if (!forbidden.has("-c") && !forbidden.has("-codec"))
        return false;
    return option === "-c:v"
        || option === "-c:a"
        || option === "-codec:v"
        || option === "-codec:a"
        || option === "-vcodec"
        || option === "-acodec";
}
function hasAudioProcessingOption(tokens) {
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
function escapeConcatPath(path) {
    return path.replaceAll("'", "'\\''");
}
function hasExtension(path) {
    const lastPart = path.split("/").at(-1) ?? path;
    return /^.+\.[A-Za-z0-9]{1,12}$/.test(lastPart);
}
//# sourceMappingURL=commands.js.map
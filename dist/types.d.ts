export type BinaryInput = Uint8Array | ArrayBuffer | Blob;
export interface FFmpegLoadConfig {
    coreURL?: string;
    wasmURL?: string;
    workerURL?: string;
    classWorkerURL?: string;
}
export interface FFmpegMessageOptions {
    signal?: AbortSignal;
}
export interface FFmpegFsNode {
    name: string;
    isDir: boolean;
}
export interface FFmpegLogEvent {
    type: string;
    message: string;
}
export interface FFmpegProgressEvent {
    progress: number;
    time: number;
}
/** Minimal structural interface implemented by @ffmpeg/ffmpeg's FFmpeg class. */
export interface FFmpegEngine {
    readonly loaded: boolean;
    load(config?: FFmpegLoadConfig, options?: FFmpegMessageOptions): Promise<boolean>;
    exec(args: string[], timeout?: number, options?: FFmpegMessageOptions): Promise<number>;
    ffprobe?(args: string[], timeout?: number, options?: FFmpegMessageOptions): Promise<number>;
    writeFile(path: string, data: Uint8Array | string, options?: FFmpegMessageOptions): Promise<boolean>;
    readFile(path: string, encoding?: "binary" | "utf8", options?: FFmpegMessageOptions): Promise<Uint8Array | string>;
    deleteFile(path: string, options?: FFmpegMessageOptions): Promise<boolean>;
    listDir(path: string, options?: FFmpegMessageOptions): Promise<FFmpegFsNode[]>;
    terminate(): void;
    on(event: "log", callback: (event: FFmpegLogEvent) => void): void;
    on(event: "progress", callback: (event: FFmpegProgressEvent) => void): void;
    off?(event: "log", callback: (event: FFmpegLogEvent) => void): void;
    off?(event: "progress", callback: (event: FFmpegProgressEvent) => void): void;
}
export type FFmpegFactory = () => FFmpegEngine;
export type AudioStrategy = "per-segment" | "single-pass" | "drop";
export type IntermediateStorage = "auto" | "memory" | "opfs";
export type PipelineStage = "loading-planner" | "extracting-audio" | "splitting" | "loading-workers" | "transcoding" | "assembling" | "done";
export interface FarmProgress {
    stage: PipelineStage;
    /** Overall progress in [0, 1]. This value is monotonic. */
    ratio: number;
    /** Progress within the current stage in [0, 1]. */
    stageRatio: number;
    completedSegments: number;
    totalSegments: number;
    activeSegment?: number;
}
export interface FarmLog {
    scope: "planner" | "worker" | "assembler";
    worker?: number;
    message: string;
}
export interface ParallelTranscodeOptions {
    /** Input filename including an extension. File.name is used automatically. */
    inputName?: string;
    /** Output filename including the desired container extension. */
    outputName?: string;
    /** Encoding/filter arguments inserted after input mapping and before output. */
    encodingArgs: string[];
    /** Approximate source segment duration. Actual cuts occur on keyframes. */
    segmentSeconds?: number;
    /** Maximum number of concurrent single-thread FFmpeg instances. */
    workerCount?: number;
    /** How audio is handled at segment boundaries. */
    audioStrategy?: AudioStrategy;
    /** Audio encoding arguments used only by audioStrategy="single-pass". */
    audioArgs?: string[];
    /**
     * Additional options applied only during the final mux. Pass "-shortest"
     * explicitly when truncating to the shortest mapped stream is desired.
     */
    muxArgs?: string[];
    /** FFmpeg.load() configuration. Use the single-thread @ffmpeg/core build. */
    loadConfig?: FFmpegLoadConfig;
    /**
     * Preserve the caller's Uint8Array/ArrayBuffer by copying before it is
     * transferred to the FFmpeg worker. Set false only when detaching it is safe.
     */
    preserveInput?: boolean;
    /** Optional hard byte limit checked before FFmpeg is loaded or the input is copied. */
    maxInputBytes?: number;
    /**
     * Where source/encoded segment buffers wait between FFmpeg stages. "auto"
     * uses Origin Private File System storage when available and falls back to
     * the legacy in-memory behavior.
     */
    intermediateStorage?: IntermediateStorage;
    /** Stop the active pipeline. Running FFmpeg workers are terminated on abort. */
    signal?: AbortSignal;
    /** Per-FFmpeg-command timeout in milliseconds. Omit for no timeout. */
    execTimeoutMs?: number;
    onProgress?: (event: FarmProgress) => void;
    onLog?: (event: FarmLog) => void;
}
export interface ParallelTranscodeResult {
    data: Uint8Array;
    outputName: string;
    segmentCount: number;
    workerCount: number;
    elapsedMs: number;
}
//# sourceMappingURL=types.d.ts.map
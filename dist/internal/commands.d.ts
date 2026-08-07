import type { AudioStrategy, IntermediateStorage } from "../types.js";
export declare function validateOptions(args: {
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
}): void;
export declare function buildSplitArgs(args: {
    inputName: string;
    segmentPattern: string;
    segmentSeconds: number;
    audioStrategy: AudioStrategy;
}): string[];
export declare function buildAudioProbeArgs(args: {
    inputName: string;
    outputName: string;
}): string[];
export declare function parseMediaTimingProbe(value: string): {
    hasAudio: boolean;
    timelineBaselineSeconds: number;
    videoOffsetSeconds: number;
};
export declare function buildAudioArgs(args: {
    inputName: string;
    outputName: string;
    audioArgs: string[];
    timelineBaselineSeconds?: number;
}): string[];
export declare function buildSegmentTranscodeArgs(args: {
    inputName: string;
    outputName: string;
    encodingArgs: string[];
    audioStrategy: AudioStrategy;
}): string[];
export declare function buildConcatManifest(segmentNames: string[]): string;
export declare function buildAssembleArgs(args: {
    manifestName: string;
    outputName: string;
    audioName?: string;
    videoOffsetSeconds?: number;
    muxArgs: string[];
}): string[];
export declare function segmentName(index: number, prefix?: string): string;
//# sourceMappingURL=commands.d.ts.map
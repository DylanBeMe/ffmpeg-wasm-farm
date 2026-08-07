import type { BinaryInput, FFmpegFactory, ParallelTranscodeOptions, ParallelTranscodeResult } from "./types.js";
export declare class ParallelFFmpeg {
    #private;
    constructor(createEngine: FFmpegFactory);
    static recommendedWorkerCount(inputBytes?: number): number;
    transcode(input: BinaryInput, options: ParallelTranscodeOptions): Promise<ParallelTranscodeResult>;
}
//# sourceMappingURL=parallel-ffmpeg.d.ts.map
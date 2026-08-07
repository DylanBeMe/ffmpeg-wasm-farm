export interface WorkerRecommendationSignals {
    logicalCores: number;
    inputBytes: number;
    deviceMemoryGiB?: number;
}
export declare function recommendWorkerCount(signals: WorkerRecommendationSignals): number;
export declare function validateMaxInputBytes(inputBytes: number, maxInputBytes?: number): void;
//# sourceMappingURL=memory.d.ts.map
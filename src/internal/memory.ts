const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_AUTOMATIC_WORKERS = 4;

export interface WorkerRecommendationSignals {
  logicalCores: number;
  inputBytes: number;
  deviceMemoryGiB?: number;
}

export function recommendWorkerCount(signals: WorkerRecommendationSignals): number {
  const logicalCores = Number.isFinite(signals.logicalCores)
    ? Math.max(1, Math.floor(signals.logicalCores))
    : 2;
  const inputBytes = Number.isFinite(signals.inputBytes)
    ? Math.max(0, signals.inputBytes)
    : 0;

  let workers = Math.max(1, Math.min(MAX_AUTOMATIC_WORKERS, logicalCores - 1 || 1));

  // Each active FFmpeg instance owns a full WASM/MEMFS heap. Large inputs
  // therefore trade throughput for a much higher OOM risk. These caps only
  // affect automatic selection; an explicit workerCount remains authoritative.
  if (inputBytes >= GIB) workers = Math.min(workers, 1);
  else if (inputBytes >= 512 * MIB) workers = Math.min(workers, 2);
  else if (inputBytes >= 256 * MIB) workers = Math.min(workers, 3);

  const deviceMemoryGiB = signals.deviceMemoryGiB;
  if (deviceMemoryGiB !== undefined && Number.isFinite(deviceMemoryGiB)) {
    if (deviceMemoryGiB <= 2) workers = Math.min(workers, 1);
    else if (deviceMemoryGiB <= 4) workers = Math.min(workers, 2);
    else if (deviceMemoryGiB <= 8) workers = Math.min(workers, 3);
  }

  return Math.max(1, workers);
}

export function validateMaxInputBytes(inputBytes: number, maxInputBytes?: number): void {
  if (maxInputBytes === undefined) return;
  if (!Number.isFinite(maxInputBytes) || maxInputBytes <= 0) {
    throw new Error("maxInputBytes must be a finite number > 0 when provided.");
  }
  if (inputBytes > maxInputBytes) {
    throw new RangeError(`Input is ${inputBytes} bytes, exceeding maxInputBytes (${maxInputBytes}).`);
  }
}

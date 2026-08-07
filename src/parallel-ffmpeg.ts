import type {
  BinaryInput,
  FarmLog,
  FarmProgress,
  FFmpegEngine,
  FFmpegFactory,
  FFmpegLoadConfig,
  FFmpegLogEvent,
  FFmpegMessageOptions,
  FFmpegProgressEvent,
  ParallelTranscodeOptions,
  ParallelTranscodeResult,
  PipelineStage,
} from "./types.js";
import { binaryByteLength, inferInputName, requireBinary, sanitizeFilename, toUint8Array } from "./internal/binary.js";
import {
  buildAssembleArgs,
  buildAudioArgs,
  buildAudioProbeArgs,
  buildConcatManifest,
  parseMediaTimingProbe,
  buildSegmentTranscodeArgs,
  buildSplitArgs,
  segmentName,
  validateOptions,
} from "./internal/commands.js";
import { runIndexedPool } from "./internal/pool.js";
import { createIntermediateStore } from "./internal/intermediate-store.js";
import { recommendWorkerCount, validateMaxInputBytes } from "./internal/memory.js";

const DEFAULT_SEGMENT_SECONDS = 12;
const DEFAULT_OUTPUT_NAME = "output.mp4";
const MAX_RECENT_LOGS = 8;
const STAGE_RANGES: Record<PipelineStage, readonly [number, number]> = {
  "loading-planner": [0, 0.02],
  "extracting-audio": [0.02, 0.10],
  splitting: [0.10, 0.16],
  "loading-workers": [0.16, 0.20],
  transcoding: [0.20, 0.94],
  assembling: [0.94, 0.995],
  done: [1, 1],
};

interface EngineContext {
  scope: FarmLog["scope"];
  worker?: number;
  recentLogs: string[];
}

type FFmpegLogHandler = (event: FFmpegLogEvent) => void;
type FFmpegProgressHandler = (event: FFmpegProgressEvent) => void;

let runSequence = 0;

export class ParallelFFmpeg {
  readonly #createEngine: FFmpegFactory;

  public constructor(createEngine: FFmpegFactory) {
    if (typeof createEngine !== "function") {
      throw new TypeError("createEngine must be a function.");
    }
    this.#createEngine = createEngine;
  }

  public static recommendedWorkerCount(inputBytes = 0): number {
    const logicalCores = typeof navigator === "undefined"
      ? 2
      : Math.max(1, navigator.hardwareConcurrency || 2);
    const deviceMemoryGiB = typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { readonly deviceMemory?: number }).deviceMemory;
    return recommendWorkerCount({
      logicalCores,
      inputBytes,
      ...(deviceMemoryGiB === undefined ? {} : { deviceMemoryGiB }),
    });
  }

  public async transcode(
    input: BinaryInput,
    options: ParallelTranscodeOptions,
  ): Promise<ParallelTranscodeResult> {
    if (!options || typeof options !== "object") {
      throw new TypeError("options must be an object.");
    }

    const startedAt = now();
    const inputBytes = binaryByteLength(input);
    validateMaxInputBytes(inputBytes, options.maxInputBytes);
    const inputName = inferInputName(input, options.inputName);
    const outputName = sanitizeFilename(options.outputName ?? DEFAULT_OUTPUT_NAME);
    const segmentSeconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
    const requestedWorkers = options.workerCount ?? ParallelFFmpeg.recommendedWorkerCount(inputBytes);
    const audioStrategy = options.audioStrategy ?? "per-segment";
    const intermediateStorage = options.intermediateStorage ?? "auto";
    const rawAudioArgs = options.audioArgs ?? [];
    const rawMuxArgs = options.muxArgs ?? [];
    const rawLoadConfig = options.loadConfig ?? {};
    const internalPrefix = createInternalPrefix(inputName, outputName);
    const audioName = `${internalPrefix}audio.mka`;
    const probeName = `${internalPrefix}audio-probe.txt`;
    const sourceStem = `${internalPrefix}source`;
    const sourcePattern = `${sourceStem}_%06d.mkv`;
    const sourceRegex = new RegExp(`^${escapeRegExp(sourceStem)}_\\d{6}\\.mkv$`);

    validateOptions({
      inputName,
      outputName,
      encodingArgs: options.encodingArgs,
      segmentSeconds,
      workerCount: requestedWorkers,
      audioStrategy,
      audioArgs: rawAudioArgs,
      muxArgs: rawMuxArgs,
      intermediateStorage,
      ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
    });

    // Snapshot mutable caller-owned arrays and config before the first await so
    // every segment in this run uses one consistent command configuration.
    const encodingArgs = [...options.encodingArgs];
    const audioArgs = [...rawAudioArgs];
    const muxArgs = [...rawMuxArgs];
    const loadConfig = { ...rawLoadConfig };
    options = {
      ...options,
      inputName,
      outputName,
      encodingArgs,
      audioArgs,
      muxArgs,
      loadConfig,
      intermediateStorage,
    };
    this.#throwIfAborted(options.signal);
    const intermediateStore = await createIntermediateStore(intermediateStorage, internalPrefix);

    try {
      this.#throwIfAborted(options.signal);
      let lastOverallRatio = 0;
      const emitProgress = (
        stage: PipelineStage,
        rawStageRatio: number,
        completedSegments: number,
        totalSegments: number,
        activeSegment?: number,
      ): void => {
        const stageRatio = clamp(rawStageRatio, 0, 1);
        const [start, end] = STAGE_RANGES[stage];
        const calculated = stage === "done" ? 1 : start + (end - start) * stageRatio;
        const ratio = Math.max(lastOverallRatio, clamp(calculated, 0, 1));
        lastOverallRatio = ratio;
        const event: FarmProgress = {
          stage,
          ratio,
          stageRatio,
          completedSegments,
          totalSegments,
        };
        if (activeSegment !== undefined) event.activeSegment = activeSegment;
        safeNotify(options.onProgress, event, "onProgress");
      };

      const planner = this.#newEngine("planner");
      const plannerContext: EngineContext = { scope: "planner", recentLogs: [] };
      let plannerLogHandler: FFmpegLogHandler | undefined;
      let segmentCount = 0;
      let hasAudio = false;
      let videoOffsetSeconds = 0;
      let plannerProgressStage: "extracting-audio" | "splitting" | undefined;
      const plannerProgressHandler = ({ progress }: FFmpegProgressEvent) => {
        if (plannerProgressStage === "extracting-audio") {
          emitProgress("extracting-audio", progress, 0, 0);
        } else if (plannerProgressStage === "splitting") {
          // Reserve the final quarter for moving segment files out of the planner.
          emitProgress("splitting", 0.75 * clamp(progress, 0, 1), 0, 0);
        }
      };

      try {
        emitProgress("loading-planner", 0, 0, 0);
        plannerLogHandler = await this.#loadEngine(planner, loadConfig, options, plannerContext);
        planner.on("progress", plannerProgressHandler);
        emitProgress("loading-planner", 1, 0, 0);

        const source = await toUint8Array(input, options.preserveInput ?? true);
        await planner.writeFile(inputName, source, messageOptions(options.signal));
        this.#throwIfAborted(options.signal);

        if (audioStrategy === "single-pass") {
          emitProgress("extracting-audio", 0, 0, 0);
          plannerProgressStage = "extracting-audio";
          const extractedAudio = await this.#extractAudio(
            planner,
            inputName,
            audioName,
            probeName,
            audioArgs,
            options,
            plannerContext,
          );
          if (extractedAudio) {
            await intermediateStore.put("audio", extractedAudio.data);
            hasAudio = true;
            videoOffsetSeconds = extractedAudio.videoOffsetSeconds;
          }
          plannerProgressStage = undefined;
          emitProgress("extracting-audio", 1, 0, 0);
        }

        emitProgress("splitting", 0, 0, 0);
        plannerProgressStage = "splitting";
        const splitCode = await this.#exec(planner, buildSplitArgs({
          inputName,
          segmentPattern: sourcePattern,
          segmentSeconds,
          audioStrategy,
        }), options);
        plannerProgressStage = undefined;
        this.#assertExitCode(splitCode, "Source segmentation", plannerContext);
        await safeDelete(planner, inputName);

        const nodes = await planner.listDir("/", messageOptions(options.signal));
        const names = nodes
          .filter((node) => !node.isDir && sourceRegex.test(node.name))
          .map((node) => node.name)
          .sort();
        if (names.length === 0) {
          throw new Error("FFmpeg produced no segments. The input may not contain a supported video stream.");
        }

        segmentCount = names.length;
        for (let index = 0; index < names.length; index += 1) {
          this.#throwIfAborted(options.signal);
          const name = names[index];
          if (!name) throw new Error("Internal segment indexing error.");
          const bytes = requireBinary(
            await planner.readFile(name, "binary", messageOptions(options.signal)),
            `Reading ${name}`,
          );
          await intermediateStore.put(intermediateSegmentKey("source", index), bytes);
          await safeDelete(planner, name);
          emitProgress("splitting", 0.75 + 0.25 * ((index + 1) / names.length), 0, names.length);
        }
      } finally {
        plannerProgressStage = undefined;
        safeRemoveProgressListener(planner, plannerProgressHandler);
        disposeEngine(planner, plannerLogHandler);
      }

      const workerCount = Math.min(requestedWorkers, segmentCount);
      const workers: FFmpegEngine[] = [];
      try {
        for (let index = 0; index < workerCount; index += 1) {
          const worker = this.#newEngine(`worker ${index}`);
          if (workers.includes(worker)) {
            throw new Error("createEngine must return a distinct FFmpeg instance for every active worker.");
          }
          workers.push(worker);
        }
      } catch (error) {
        workers.forEach((worker) => safeTerminate(worker));
        throw error;
      }
      const workerContexts: EngineContext[] = workers.map((_, worker) => ({
        scope: "worker",
        worker,
        recentLogs: [],
      }));
      const workerLogHandlers = new Array<FFmpegLogHandler | undefined>(workerCount).fill(undefined);
      const workerProgress = new Array<number>(workerCount).fill(0);
      const workerActive = new Array<boolean>(workerCount).fill(false);
      const workerSegments = new Array<number | undefined>(workerCount).fill(undefined);
      let completed = 0;

      const emitTranscodeProgress = (workerIndex?: number): void => {
        const activeProgress = workerProgress.reduce(
          (sum, value, index) => sum + (workerActive[index] ? value : 0),
          0,
        );
        const ratio = (completed + activeProgress) / segmentCount;
        emitProgress(
          "transcoding",
          ratio,
          completed,
          segmentCount,
          workerIndex === undefined ? undefined : workerSegments[workerIndex],
        );
      };

      this.#throwIfAborted(options.signal);
      emitProgress("loading-workers", 0, 0, segmentCount);
      let loadedWorkers = 0;
      try {
        await Promise.all(workers.map(async (worker, workerIndex) => {
          const context = workerContexts[workerIndex];
          if (!context) throw new Error(`Missing log context for worker ${workerIndex}.`);
          workerLogHandlers[workerIndex] = await this.#loadEngine(worker, loadConfig, options, context);
          loadedWorkers += 1;
          emitProgress("loading-workers", loadedWorkers / workerCount, 0, segmentCount);
        }));
      } catch (error) {
        workers.forEach((worker, index) => disposeEngine(worker, workerLogHandlers[index]));
        throw error;
      }
      emitProgress("loading-workers", 1, 0, segmentCount);

      const progressHandlers = workers.map((worker, workerIndex) => {
        const handler = ({ progress }: FFmpegProgressEvent) => {
          if (!workerActive[workerIndex]) return;
          workerProgress[workerIndex] = clamp(progress, 0, 1);
          emitTranscodeProgress(workerIndex);
        };
        worker.on("progress", handler);
        return handler;
      });

      try {
        await runIndexedPool(workers, segmentCount, async (worker, workerIndex, segmentIndex) => {
          this.#throwIfAborted(options.signal);
          const sourceName = segmentName(segmentIndex, `${internalPrefix}job_input`);
          const encodedName = segmentName(segmentIndex, `${internalPrefix}job_output`);
          const bytes = await intermediateStore.take(intermediateSegmentKey("source", segmentIndex));
          const context = workerContexts[workerIndex];
          if (!context) throw new Error(`Missing log context for worker ${workerIndex}.`);

          await worker.writeFile(sourceName, bytes, messageOptions(options.signal));
          workerProgress[workerIndex] = 0;
          workerActive[workerIndex] = true;
          workerSegments[workerIndex] = segmentIndex;
          emitTranscodeProgress(workerIndex);

          try {
            const code = await this.#exec(worker, buildSegmentTranscodeArgs({
              inputName: sourceName,
              outputName: encodedName,
              encodingArgs,
              audioStrategy,
            }), options);
            this.#assertExitCode(code, `Segment ${segmentIndex} transcode`, context);
            const output = requireBinary(
              await worker.readFile(encodedName, "binary", messageOptions(options.signal)),
              `Reading encoded segment ${segmentIndex}`,
            );
            await intermediateStore.put(intermediateSegmentKey("encoded", segmentIndex), output);
            workerActive[workerIndex] = false;
            workerProgress[workerIndex] = 0;
            workerSegments[workerIndex] = undefined;
            completed += 1;
            emitTranscodeProgress();
          } finally {
            workerActive[workerIndex] = false;
            workerProgress[workerIndex] = 0;
            workerSegments[workerIndex] = undefined;
            await safeDelete(worker, sourceName);
            await safeDelete(worker, encodedName);
          }
        });
      } catch (error) {
        workers.forEach((worker, index) => disposeEngine(worker, workerLogHandlers[index]));
        throw error;
      } finally {
        workers.forEach((worker, index) => {
          const handler = progressHandlers[index];
          if (handler) safeRemoveProgressListener(worker, handler);
        });
      }

      const assembler = workers[0];
      const assemblerContext = workerContexts[0];
      if (!assembler || !assemblerContext) throw new Error("No assembler worker is available.");
      assemblerContext.scope = "assembler";
      delete assemblerContext.worker;
      for (let index = 1; index < workers.length; index += 1) {
        const worker = workers[index];
        if (worker) disposeEngine(worker, workerLogHandlers[index]);
      }

      try {
        emitProgress("assembling", 0, completed, segmentCount);
        const outputSegmentNames: string[] = [];
        for (let index = 0; index < segmentCount; index += 1) {
          this.#throwIfAborted(options.signal);
          const name = segmentName(index, `${internalPrefix}encoded`);
          const bytes = await intermediateStore.take(intermediateSegmentKey("encoded", index));
          await assembler.writeFile(name, bytes, messageOptions(options.signal));
          outputSegmentNames.push(name);
          emitProgress("assembling", 0.35 * ((index + 1) / segmentCount), completed, segmentCount);
        }

        const manifestName = `${internalPrefix}concat.txt`;
        await assembler.writeFile(
          manifestName,
          buildConcatManifest(outputSegmentNames),
          messageOptions(options.signal),
        );
        if (hasAudio) {
          const audio = await intermediateStore.take("audio");
          await assembler.writeFile(audioName, audio, messageOptions(options.signal));
        }

        const assembleOptions = hasAudio
          ? { manifestName, outputName, audioName, videoOffsetSeconds, muxArgs }
          : { manifestName, outputName, muxArgs };
        const assembleCode = await this.#exec(assembler, buildAssembleArgs(assembleOptions), options);
        this.#assertExitCode(assembleCode, "Final assembly", assemblerContext);
        emitProgress("assembling", 0.95, completed, segmentCount);

        const data = requireBinary(
          await assembler.readFile(outputName, "binary", messageOptions(options.signal)),
          "Reading final output",
        );
        emitProgress("done", 1, completed, segmentCount);
        return {
          data,
          outputName,
          segmentCount,
          workerCount,
          elapsedMs: now() - startedAt,
        };
      } finally {
        disposeEngine(assembler, workerLogHandlers[0]);
      }
    } finally {
      await intermediateStore.dispose();
    }
  }

  #newEngine(label: string): FFmpegEngine {
    const engine = this.#createEngine();
    if (!engine || typeof engine !== "object") {
      throw new TypeError(`createEngine returned an invalid ${label} instance.`);
    }
    return engine;
  }

  async #extractAudio(
    engine: FFmpegEngine,
    inputName: string,
    audioName: string,
    probeName: string,
    audioArgs: string[],
    options: ParallelTranscodeOptions,
    context: EngineContext,
  ): Promise<{ data: Uint8Array; videoOffsetSeconds: number } | undefined> {
    if (!engine.ffprobe) {
      throw new Error(
        'audioStrategy="single-pass" requires an FFmpeg engine with ffprobe support.',
      );
    }

    {
      const probeCode = await engine.ffprobe(
        buildAudioProbeArgs({ inputName, outputName: probeName }),
        options.execTimeoutMs ?? -1,
        messageOptions(options.signal),
      );
      this.#assertExitCode(probeCode, "Audio stream probe", context);
      const probe = await engine.readFile(probeName, "utf8", messageOptions(options.signal));
      await safeDelete(engine, probeName);
      if (typeof probe !== "string" || probe.trim() === "") {
        throw new Error("Audio stream probe returned no data.");
      }
      const timing = parseMediaTimingProbe(probe);
      if (!timing.hasAudio) {
        this.#emitLog(options, context, "No audio stream found; continuing with video only.");
        return undefined;
      }

      const code = await this.#exec(
        engine,
        buildAudioArgs({
          inputName,
          outputName: audioName,
          audioArgs,
          timelineBaselineSeconds: timing.timelineBaselineSeconds,
        }),
        options,
      );
      this.#assertExitCode(code, "Single-pass audio extraction", context);
      try {
        const audio = requireBinary(
          await engine.readFile(audioName, "binary", messageOptions(options.signal)),
          "Reading single-pass audio",
        );
        await safeDelete(engine, audioName);
        return { data: audio, videoOffsetSeconds: timing.videoOffsetSeconds };
      } catch (error) {
        await safeDelete(engine, audioName);
        throw error;
      }
    }
  }

  async #loadEngine(
    engine: FFmpegEngine,
    config: FFmpegLoadConfig,
    options: ParallelTranscodeOptions,
    context: EngineContext,
  ): Promise<FFmpegLogHandler> {
    const logHandler: FFmpegLogHandler = ({ message }) => {
      context.recentLogs.push(message);
      if (context.recentLogs.length > MAX_RECENT_LOGS) context.recentLogs.shift();
      this.#emitLog(options, context, message);
    };
    engine.on("log", logHandler);
    try {
      await engine.load(config, messageOptions(options.signal));
      return logHandler;
    } catch (error) {
      safeRemoveLogListener(engine, logHandler);
      throw error;
    }
  }

  async #exec(
    engine: FFmpegEngine,
    args: string[],
    options: ParallelTranscodeOptions,
  ): Promise<number> {
    return engine.exec(
      args,
      options.execTimeoutMs ?? -1,
      messageOptions(options.signal),
    );
  }

  #assertExitCode(code: number, operation: string, context: EngineContext): void {
    if (code === 0) return;
    const recent = context.recentLogs
      .filter((line) => line.trim() !== "")
      .slice(-4)
      .join("\n");
    const detail = recent ? `\nRecent FFmpeg output:\n${recent}` : "";
    throw new Error(`${operation} failed with FFmpeg exit code ${code}.${detail}`);
  }

  #emitLog(options: ParallelTranscodeOptions, context: EngineContext, message: string): void {
    const event: FarmLog = context.worker === undefined
      ? { scope: context.scope, message }
      : { scope: context.scope, worker: context.worker, message };
    safeNotify(options.onLog, event, "onLog");
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const message = signal.reason === undefined ? "The operation was aborted." : String(signal.reason);
    throw new DOMException(message, "AbortError");
  }
}

function disposeEngine(engine: FFmpegEngine, logHandler?: FFmpegLogHandler): void {
  if (logHandler) safeRemoveLogListener(engine, logHandler);
  safeTerminate(engine);
}

function safeRemoveLogListener(engine: FFmpegEngine, handler: FFmpegLogHandler): void {
  try {
    engine.off?.("log", handler);
  } catch {
    // Listener cleanup must not mask the pipeline result or original failure.
  }
}

function safeRemoveProgressListener(engine: FFmpegEngine, handler: FFmpegProgressHandler): void {
  try {
    engine.off?.("progress", handler);
  } catch {
    // Listener cleanup must not mask the pipeline result or original failure.
  }
}

function safeTerminate(engine: FFmpegEngine): void {
  try {
    engine.terminate();
  } catch {
    // Termination is cleanup and must not replace a more useful error/result.
  }
}

async function safeDelete(engine: FFmpegEngine, path: string): Promise<void> {
  try {
    await engine.deleteFile(path);
  } catch {
    // Cleanup is best-effort; the worker is terminated after the pipeline.
  }
}

function messageOptions(signal?: AbortSignal): FFmpegMessageOptions | undefined {
  return signal ? { signal } : undefined;
}

function intermediateSegmentKey(kind: "source" | "encoded", index: number): string {
  return `${kind}_${String(index).padStart(6, "0")}`;
}

function createInternalPrefix(inputName: string, outputName: string): string {
  let prefix: string;
  do {
    runSequence += 1;
    prefix = `__ffmpeg_farm_${runSequence.toString(36)}_`;
  } while (inputName.startsWith(prefix) || outputName.startsWith(prefix));
  return prefix;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeNotify<T>(
  callback: ((event: T) => void) | undefined,
  event: T,
  label: string,
): void {
  if (!callback) return;
  try {
    callback(event);
  } catch (error) {
    // Observer failures should not discard an expensive transcode result.
    console.error(`ffmpeg-wasm-farm ${label} callback failed:`, error);
  }
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

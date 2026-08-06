import test from "node:test";
import assert from "node:assert/strict";
import { ParallelFFmpeg } from "../dist/index.js";

class FakeEngine {
  static nextId = 0;
  static activeTranscodes = 0;
  static maxConcurrentTranscodes = 0;
  static terminatedIds = [];
  static instances = [];
  static segmentCommands = [];

  id = FakeEngine.nextId++;
  loaded = false;
  files = new Map();
  logHandlers = [];
  progressHandlers = [];

  constructor() {
    FakeEngine.instances.push(this);
  }

  async load(_config, options) {
    throwIfAborted(options?.signal);
    this.loaded = true;
    return true;
  }

  async exec(args, _timeout, options) {
    throwIfAborted(options?.signal);
    const outputName = args.at(-1);
    if (!outputName) return 1;

    if (args.includes("segment")) {
      const pattern = outputName;
      for (let index = 0; index < 5; index += 1) {
        const name = pattern.replace("%06d", String(index).padStart(6, "0"));
        this.files.set(name, new Uint8Array([index]));
      }
      return 0;
    }

    if (outputName.includes("job_output_")) {
      FakeEngine.segmentCommands.push([...args]);
      const inputIndex = args.indexOf("-i") + 1;
      const inputName = args[inputIndex];
      const source = this.files.get(inputName);
      if (!(source instanceof Uint8Array)) return 2;

      FakeEngine.activeTranscodes += 1;
      FakeEngine.maxConcurrentTranscodes = Math.max(
        FakeEngine.maxConcurrentTranscodes,
        FakeEngine.activeTranscodes,
      );
      this.logHandlers.forEach((handler) => handler({ type: "stderr", message: `encoding ${outputName}` }));
      this.progressHandlers.forEach((handler) => handler({ progress: 0.5, time: 1 }));
      try {
        await abortableDelay(8, options?.signal);
      } finally {
        FakeEngine.activeTranscodes -= 1;
      }
      this.files.set(outputName, new Uint8Array([source[0] + 10]));
      this.progressHandlers.forEach((handler) => handler({ progress: 1, time: 2 }));
      return 0;
    }

    if (args.includes("concat")) {
      const firstInput = args.indexOf("-i") + 1;
      const manifestName = args[firstInput];
      const manifest = this.files.get(manifestName);
      if (typeof manifest !== "string") return 3;
      const orderedNames = [...manifest.matchAll(/file '([^']+)'/g)].map((match) => match[1]);
      const values = orderedNames.map((name) => this.files.get(name)?.[0]);
      this.logHandlers.forEach((handler) => handler({ type: "stderr", message: "assembling output" }));
      this.files.set(outputName, new Uint8Array(values));
      return 0;
    }

    return 0;
  }

  async writeFile(path, data, options) {
    throwIfAborted(options?.signal);
    this.files.set(path, typeof data === "string" ? data : data.slice());
    return true;
  }

  async readFile(path, encoding = "binary", options) {
    throwIfAborted(options?.signal);
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`Missing fake file: ${path}`);
    if (encoding === "utf8") return typeof data === "string" ? data : new TextDecoder().decode(data);
    return typeof data === "string" ? data : data.slice();
  }

  async deleteFile(path) {
    this.files.delete(path);
    return true;
  }

  async listDir(_path, options) {
    throwIfAborted(options?.signal);
    return [
      { name: ".", isDir: true },
      { name: "..", isDir: true },
      ...[...this.files.keys()].map((name) => ({ name, isDir: false })),
    ];
  }

  terminate() {
    this.loaded = false;
    FakeEngine.terminatedIds.push(this.id);
  }

  on(event, callback) {
    if (event === "log") this.logHandlers.push(callback);
    else this.progressHandlers.push(callback);
  }

  off(event, callback) {
    const handlers = event === "log" ? this.logHandlers : this.progressHandlers;
    const index = handlers.indexOf(callback);
    if (index >= 0) handlers.splice(index, 1);
  }
}

function resetFakeEngine() {
  FakeEngine.nextId = 0;
  FakeEngine.activeTranscodes = 0;
  FakeEngine.maxConcurrentTranscodes = 0;
  FakeEngine.terminatedIds = [];
  FakeEngine.instances = [];
  FakeEngine.segmentCommands = [];
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

test("parallel pipeline transcodes concurrently and reassembles in source order", async () => {
  resetFakeEngine();

  const progress = [];
  const logs = [];
  const farm = new ParallelFFmpeg(() => new FakeEngine());
  const result = await farm.transcode(new Uint8Array([99]), {
    inputName: "source_000000.mkv",
    outputName: "concat.txt",
    workerCount: 3,
    segmentSeconds: 10,
    audioStrategy: "drop",
    encodingArgs: ["-c:v", "libx264"],
    onProgress: (event) => progress.push(event),
    onLog: (event) => logs.push(event),
  });

  assert.deepEqual([...result.data], [10, 11, 12, 13, 14]);
  assert.equal(result.segmentCount, 5);
  assert.equal(result.workerCount, 3);
  assert.ok(FakeEngine.maxConcurrentTranscodes >= 2);
  assert.equal(progress.at(-1)?.stage, "done");
  assert.equal(progress.at(-1)?.ratio, 1);
  assert.ok(progress.every((event, index) => index === 0 || event.ratio >= progress[index - 1].ratio));
  assert.ok(logs.some((event) => event.scope === "assembler" && event.message.includes("assembling")));
  assert.deepEqual(FakeEngine.terminatedIds.sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.ok(FakeEngine.instances.every((engine) => engine.logHandlers.length === 0));
  assert.ok(FakeEngine.instances.every((engine) => engine.progressHandlers.length === 0));
});

test("abort stops active workers and rejects with AbortError", async () => {
  resetFakeEngine();
  const controller = new AbortController();
  const farm = new ParallelFFmpeg(() => new FakeEngine());

  const pending = farm.transcode(new Uint8Array([99]), {
    inputName: "input.mp4",
    outputName: "output.mp4",
    workerCount: 3,
    segmentSeconds: 10,
    audioStrategy: "drop",
    encodingArgs: ["-c:v", "libx264"],
    signal: controller.signal,
    onProgress: (event) => {
      if (event.stage === "transcoding" && event.stageRatio > 0) controller.abort();
    },
  });

  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.ok(FakeEngine.terminatedIds.length >= 4);
});

test("single-pass audio fails clearly when the engine lacks ffprobe", async () => {
  resetFakeEngine();
  const farm = new ParallelFFmpeg(() => new FakeEngine());

  await assert.rejects(
    farm.transcode(new Uint8Array([99]), {
      inputName: "input.mp4",
      outputName: "output.mp4",
      workerCount: 1,
      segmentSeconds: 10,
      audioStrategy: "single-pass",
      audioArgs: ["-c:a", "aac"],
      encodingArgs: ["-c:v", "libx264"],
    }),
    /requires an FFmpeg engine with ffprobe support/,
  );
});


test("caller-owned argument arrays are snapshotted before asynchronous work", async () => {
  resetFakeEngine();
  const farm = new ParallelFFmpeg(() => new FakeEngine());
  const options = {
    inputName: "input.mp4",
    outputName: "output.mp4",
    workerCount: 2,
    segmentSeconds: 10,
    audioStrategy: "drop",
    encodingArgs: ["-c:v", "libx264", "-crf", "23"],
  };

  const pending = farm.transcode(new Uint8Array([99]), options);
  options.encodingArgs.splice(0, options.encodingArgs.length, "-c:v", "mutated-codec");
  await pending;

  assert.ok(FakeEngine.segmentCommands.length > 0);
  assert.ok(FakeEngine.segmentCommands.every((args) => args.includes("libx264")));
  assert.ok(FakeEngine.segmentCommands.every((args) => !args.includes("mutated-codec")));
});

test("active workers must be distinct engine instances", async () => {
  resetFakeEngine();
  const shared = new FakeEngine();
  const farm = new ParallelFFmpeg(() => shared);

  await assert.rejects(farm.transcode(new Uint8Array([99]), {
    inputName: "input.mp4",
    outputName: "output.mp4",
    workerCount: 2,
    segmentSeconds: 10,
    audioStrategy: "drop",
    encodingArgs: ["-c:v", "libx264"],
  }), /distinct FFmpeg instance/);
});

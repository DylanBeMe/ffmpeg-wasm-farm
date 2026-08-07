import test from "node:test";
import assert from "node:assert/strict";
import { recommendWorkerCount, validateMaxInputBytes } from "../dist/internal/memory.js";
import { createIntermediateStore } from "../dist/internal/intermediate-store.js";

const MIB = 1024 * 1024;

test("automatic worker recommendations become more conservative for large inputs", () => {
  assert.equal(recommendWorkerCount({ logicalCores: 16, inputBytes: 128 * MIB, deviceMemoryGiB: 16 }), 4);
  assert.equal(recommendWorkerCount({ logicalCores: 16, inputBytes: 300 * MIB, deviceMemoryGiB: 16 }), 3);
  assert.equal(recommendWorkerCount({ logicalCores: 16, inputBytes: 600 * MIB, deviceMemoryGiB: 16 }), 2);
  assert.equal(recommendWorkerCount({ logicalCores: 16, inputBytes: 1100 * MIB, deviceMemoryGiB: 16 }), 1);
});

test("reported device memory can further reduce automatic concurrency", () => {
  assert.equal(recommendWorkerCount({ logicalCores: 16, inputBytes: 1 * MIB, deviceMemoryGiB: 2 }), 1);
  assert.equal(recommendWorkerCount({ logicalCores: 16, inputBytes: 1 * MIB, deviceMemoryGiB: 4 }), 2);
});

test("maxInputBytes rejects oversized inputs before FFmpeg work starts", () => {
  assert.doesNotThrow(() => validateMaxInputBytes(10, 10));
  assert.throws(() => validateMaxInputBytes(11, 10), /maxInputBytes/);
  assert.throws(() => validateMaxInputBytes(10, 0), /maxInputBytes/);
});

test("memory intermediate store releases entries when ownership is taken", async () => {
  const store = await createIntermediateStore("memory", "test_");
  await store.put("source_000000", new Uint8Array([1, 2, 3]));
  assert.deepEqual([...await store.take("source_000000")], [1, 2, 3]);
  await assert.rejects(store.take("source_000000"), /Missing intermediate data/);
  await store.dispose();
});

test("auto storage falls back to memory when OPFS is unavailable", async () => {
  const store = await createIntermediateStore("auto", "test_");
  await store.put("encoded_000000", new Uint8Array([9]));
  assert.deepEqual([...await store.take("encoded_000000")], [9]);
  await store.dispose();
});


test("OPFS writes normalize SharedArrayBuffer-backed views", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let written;
  const files = new Map();

  const directory = {
    async getFileHandle(name) {
      return {
        async createWritable() {
          return {
            async write(data) {
              written = data;
              files.set(name, new Uint8Array(data));
            },
            async close() {},
          };
        },
        async getFile() {
          return new Blob([files.get(name)]);
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };

  const root = {
    async getDirectoryHandle() {
      return directory;
    },
    async removeEntry() {},
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        async getDirectory() {
          return root;
        },
      },
    },
  });

  try {
    const sourceBuffer = new SharedArrayBuffer(3);
    const source = new Uint8Array(sourceBuffer);
    source.set([4, 5, 6]);

    const store = await createIntermediateStore("opfs", "test_");
    await store.put("encoded_000000", source);

    assert.ok(written instanceof Uint8Array);
    assert.ok(written.buffer instanceof ArrayBuffer);
    assert.deepEqual([...await store.take("encoded_000000")], [4, 5, 6]);
    await store.dispose();
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
});

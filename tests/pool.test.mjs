import test from "node:test";
import assert from "node:assert/strict";
import { runIndexedPool } from "../dist/internal/pool.js";

test("indexed pool preserves result order", async () => {
  const workers = ["a", "b", "c"];
  const results = await runIndexedPool(workers, 8, async (worker, workerIndex, itemIndex) => {
    await new Promise((resolve) => setTimeout(resolve, (7 - itemIndex) % 3));
    return `${itemIndex}:${worker}:${workerIndex}`;
  });
  assert.equal(results.length, 8);
  results.forEach((value, index) => assert.match(value, new RegExp(`^${index}:`)));
});


test("indexed pool rejects invalid item counts clearly", async () => {
  await assert.rejects(runIndexedPool(["worker"], -1, async () => 1), /itemCount/);
  await assert.rejects(runIndexedPool(["worker"], 1.5, async () => 1), /itemCount/);
});

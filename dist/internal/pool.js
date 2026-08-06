export async function runIndexedPool(workers, itemCount, task) {
    if (!Number.isInteger(itemCount) || itemCount < 0) {
        throw new Error("itemCount must be a non-negative integer.");
    }
    if (itemCount === 0)
        return [];
    if (workers.length === 0)
        throw new Error("At least one worker is required.");
    const results = new Array(itemCount);
    let cursor = 0;
    let stopped = false;
    await Promise.all(workers.map(async (worker, workerIndex) => {
        while (!stopped) {
            const itemIndex = cursor;
            cursor += 1;
            if (itemIndex >= itemCount)
                return;
            try {
                results[itemIndex] = await task(worker, workerIndex, itemIndex);
            }
            catch (error) {
                stopped = true;
                throw error;
            }
        }
    }));
    return results;
}
//# sourceMappingURL=pool.js.map
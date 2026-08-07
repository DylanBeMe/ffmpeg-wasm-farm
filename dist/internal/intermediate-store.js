export async function createIntermediateStore(mode, runPrefix) {
    if (mode === "memory")
        return new HybridIntermediateStore(false);
    const getDirectory = getOpfsDirectoryFactory();
    if (!getDirectory) {
        if (mode === "opfs") {
            throw new Error('intermediateStorage="opfs" is not supported in this environment.');
        }
        return new HybridIntermediateStore(false);
    }
    try {
        const root = await getDirectory();
        const directoryName = `${runPrefix}spill_${uniqueSuffix()}`;
        const directory = await root.getDirectoryHandle(directoryName, { create: true });
        return new HybridIntermediateStore(mode === "opfs", root, directory, directoryName);
    }
    catch (error) {
        if (mode === "opfs") {
            throw new Error("Unable to create OPFS intermediate storage.", { cause: error });
        }
        return new HybridIntermediateStore(false);
    }
}
class HybridIntermediateStore {
    #strictOpfs;
    #memory = new Map();
    #diskKeys = new Set();
    #root;
    #directory;
    #directoryName;
    #writeToDisk;
    constructor(strictOpfs, root, directory, directoryName) {
        this.#strictOpfs = strictOpfs;
        this.#root = root;
        this.#directory = directory;
        this.#directoryName = directoryName;
        this.#writeToDisk = directory !== undefined;
    }
    async put(key, data) {
        const fileName = storageFileName(key);
        if (this.#directory && this.#writeToDisk) {
            try {
                const handle = await this.#directory.getFileHandle(fileName, { create: true });
                const writable = await handle.createWritable();
                try {
                    await writable.write(toOpfsWriteChunk(data));
                    await writable.close();
                }
                catch (error) {
                    try {
                        await writable.close();
                    }
                    catch {
                        // Some OPFS implementations close a failed stream themselves.
                    }
                    throw error;
                }
                this.#diskKeys.add(key);
                return;
            }
            catch (error) {
                try {
                    await this.#directory.removeEntry(fileName);
                }
                catch {
                    // Best-effort removal of a partially-written file.
                }
                if (this.#strictOpfs) {
                    throw new Error(`Unable to spill intermediate ${key} to OPFS.`, { cause: error });
                }
                // Quota/private-mode failures must not make the default mode less
                // compatible than the previous in-memory implementation. Existing
                // disk entries remain readable; subsequent writes use memory.
                this.#writeToDisk = false;
            }
        }
        this.#memory.set(key, data);
    }
    async take(key) {
        const memory = this.#memory.get(key);
        if (memory) {
            this.#memory.delete(key);
            return memory;
        }
        if (this.#directory && this.#diskKeys.has(key)) {
            const fileName = storageFileName(key);
            const handle = await this.#directory.getFileHandle(fileName);
            const file = await handle.getFile();
            const data = new Uint8Array(await file.arrayBuffer());
            this.#diskKeys.delete(key);
            try {
                await this.#directory.removeEntry(fileName);
            }
            catch {
                // dispose() removes the run directory as the final fallback.
            }
            return data;
        }
        throw new Error(`Missing intermediate data: ${key}.`);
    }
    async dispose() {
        this.#memory.clear();
        this.#diskKeys.clear();
        if (!this.#root || !this.#directoryName)
            return;
        try {
            await this.#root.removeEntry(this.#directoryName, { recursive: true });
        }
        catch {
            // Cleanup must not mask a successful result or a more useful failure.
        }
    }
}
function getOpfsDirectoryFactory() {
    if (typeof navigator === "undefined" || !navigator.storage)
        return undefined;
    const storage = navigator.storage;
    if (typeof storage.getDirectory !== "function")
        return undefined;
    return () => storage.getDirectory();
}
function storageFileName(key) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
        throw new Error(`Invalid intermediate storage key: ${key}.`);
    }
    return `${key}.bin`;
}
function uniqueSuffix() {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
    }
    catch {
        // Fall through to a non-cryptographic collision-avoidance suffix.
    }
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
function toOpfsWriteChunk(data) {
    if (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return copy;
    }
    return data;
}
//# sourceMappingURL=intermediate-store.js.map
import type { IntermediateStorage } from "../types.js";
export interface IntermediateStore {
    put(key: string, data: Uint8Array): Promise<void>;
    take(key: string): Promise<Uint8Array>;
    dispose(): Promise<void>;
}
export declare function createIntermediateStore(mode: IntermediateStorage, runPrefix: string): Promise<IntermediateStore>;
//# sourceMappingURL=intermediate-store.d.ts.map
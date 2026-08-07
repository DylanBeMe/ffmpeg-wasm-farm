import type { BinaryInput } from "../types.js";
export declare function binaryByteLength(input: BinaryInput): number;
export declare function toUint8Array(input: BinaryInput, preserve: boolean): Promise<Uint8Array>;
export declare function inferInputName(input: BinaryInput, explicit?: string): string;
export declare function requireBinary(data: Uint8Array | string, context: string): Uint8Array;
export declare function sanitizeFilename(name: string): string;
//# sourceMappingURL=binary.d.ts.map
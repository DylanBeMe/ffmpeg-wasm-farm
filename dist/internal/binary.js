const MIME_EXTENSIONS = {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "video/avi": "avi",
    "video/mp4": "mp4",
    "video/mpeg": "mpeg",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "video/x-msvideo": "avi",
};
export function binaryByteLength(input) {
    if (input instanceof Uint8Array || input instanceof ArrayBuffer)
        return input.byteLength;
    return input.size;
}
export async function toUint8Array(input, preserve) {
    if (input instanceof Uint8Array) {
        // SharedArrayBuffer cannot be transferred by @ffmpeg/ffmpeg. Copy it even
        // when preserve=false so writeFile does not fail with DataCloneError.
        if (isSharedArrayBuffer(input.buffer))
            return input.slice();
        return preserve ? input.slice() : input;
    }
    if (input instanceof ArrayBuffer) {
        return new Uint8Array(preserve ? input.slice(0) : input);
    }
    return new Uint8Array(await input.arrayBuffer());
}
export function inferInputName(input, explicit) {
    if (explicit !== undefined)
        return sanitizeFilename(explicit);
    if (typeof File !== "undefined" && input instanceof File && input.name) {
        return sanitizeFilename(input.name);
    }
    if (typeof Blob !== "undefined" && input instanceof Blob) {
        const mimeType = input.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const extension = MIME_EXTENSIONS[mimeType];
        if (extension)
            return `input.${extension}`;
    }
    const bytes = input instanceof Uint8Array
        ? input
        : input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : undefined;
    const extension = bytes ? sniffExtension(bytes) : undefined;
    if (extension)
        return `input.${extension}`;
    throw new Error("inputName is required when the input is not a named File and its format cannot be inferred.");
}
export function requireBinary(data, context) {
    if (!(data instanceof Uint8Array)) {
        throw new Error(`${context} unexpectedly returned text instead of binary data.`);
    }
    return data;
}
export function sanitizeFilename(name) {
    if (typeof name !== "string")
        throw new TypeError("Filename must be a string.");
    const base = name.split(/[\\/]/).at(-1) ?? name;
    let cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!cleaned || cleaned === "." || cleaned === "..") {
        throw new Error("Filename is empty after sanitization.");
    }
    // FFmpeg treats a leading dash as another option even when it is intended
    // to be a virtual filesystem path.
    if (cleaned.startsWith("-"))
        cleaned = `_${cleaned}`;
    return cleaned;
}
function sniffExtension(bytes) {
    if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]))
        return "mkv";
    if (ascii(bytes, 0, 4) === "OggS")
        return "ogg";
    if (ascii(bytes, 0, 4) === "fLaC")
        return "flac";
    if (ascii(bytes, 0, 3) === "ID3" || isMp3Frame(bytes))
        return "mp3";
    const riff = ascii(bytes, 0, 4) === "RIFF";
    if (riff && ascii(bytes, 8, 4) === "WAVE")
        return "wav";
    if (riff && ascii(bytes, 8, 4) === "AVI ")
        return "avi";
    if (ascii(bytes, 4, 4) === "ftyp")
        return "mp4";
    if (matches(bytes, 0, [0x00, 0x00, 0x01, 0xba]))
        return "mpeg";
    if (isTransportStream(bytes))
        return "ts";
    return undefined;
}
function ascii(bytes, offset, length) {
    if (bytes.length < offset + length)
        return "";
    let value = "";
    for (let index = offset; index < offset + length; index += 1) {
        value += String.fromCharCode(bytes[index] ?? 0);
    }
    return value;
}
function matches(bytes, offset, expected) {
    if (bytes.length < offset + expected.length)
        return false;
    return expected.every((value, index) => bytes[offset + index] === value);
}
function isMp3Frame(bytes) {
    return bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
}
function isTransportStream(bytes) {
    if (bytes.length < 377)
        return false;
    return bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
}
function isSharedArrayBuffer(buffer) {
    return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}
//# sourceMappingURL=binary.js.map
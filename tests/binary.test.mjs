import test from "node:test";
import assert from "node:assert/strict";
import { inferInputName, sanitizeFilename } from "../dist/internal/binary.js";

test("leading dashes and paths are made safe for FFmpeg", () => {
  assert.equal(sanitizeFilename("../../-dangerous name.mp4"), "_-dangerous_name.mp4");
});

test("common container signatures are inferred for byte inputs", () => {
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  assert.equal(inferInputName(mp4), "input.mp4");

  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal(inferInputName(webm), "input.mkv");
});

test("blob MIME types are used when a filename is unavailable", () => {
  assert.equal(inferInputName(new Blob(["x"], { type: "video/webm" })), "input.webm");
});

test("unknown anonymous input requires an explicit filename", () => {
  assert.throws(() => inferInputName(new Uint8Array([1, 2, 3])), /inputName is required/);
});


test("an explicitly empty filename is rejected instead of silently ignored", () => {
  assert.throws(() => inferInputName(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), ""), /Filename is empty/);
});

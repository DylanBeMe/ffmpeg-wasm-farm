import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../demo/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../demo/src/styles.css", import.meta.url), "utf8");
const script = await readFile(new URL("../demo/src/main.ts", import.meta.url), "utf8");

function attributes(name) {
  return [...html.matchAll(new RegExp(`\\b${name}="([^"]+)"`, "g"))].map((match) => match[1]);
}

test("demo has unique IDs and valid labelled/control references", () => {
  const ids = attributes("id");
  assert.equal(new Set(ids).size, ids.length, "duplicate HTML id found");
  const idSet = new Set(ids);
  for (const target of [...attributes("for"), ...attributes("aria-controls"), ...attributes("aria-labelledby")]) {
    for (const id of target.split(/\s+/)) assert.ok(idSet.has(id), `missing referenced id: ${id}`);
  }
});

test("tabs are keyboard- and accessibility-coherent", () => {
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 3);
  assert.match(script, /"Home", "End"/);
  assert.match(script, /panel\.hidden = !active/);
  assert.match(script, /tab\.tabIndex = active \? 0 : -1/);
});

test("all panels use the shared tokenized light and dark theme", () => {
  for (const token of ["--bg", "--surface", "--text", "--text-muted", "--border", "--accent", "--log-bg"]) {
    assert.ok(css.includes(token), `missing shared theme token ${token}`);
  }
  assert.match(css, /:root\s*\{/);
  assert.match(css, /html\[data-theme="dark"\]\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
});

test("demo prevents misleading audio-only selection and output-container mismatches", () => {
  assert.doesNotMatch(html, /accept="[^"]*audio\/\*/);
  assert.match(script, /file\.type\.startsWith\("audio\/"\)/);
  assert.match(script, /aac\|flac\|m4a\|mp3\|opus\|wav/);
  assert.match(script, /normalizeOutputName\(outputNameInput\.value, preset\.extension\)/);
});

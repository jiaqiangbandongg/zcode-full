import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeInfo } from "../src/core/environment.js";
import { color, formatJson, supportsColor } from "../src/core/output.js";

test("formats JSON with a trailing newline", () => {
  assert.equal(formatJson({ ok: true }), '{\n  "ok": true\n}\n');
});

test("applies ANSI colors only when enabled", () => {
  assert.equal(color.green("ready", false), "ready");
  assert.equal(color.green("ready", true), "\x1b[32mready\x1b[39m");
  assert.equal(color.bold("title", true), "\x1b[1mtitle\x1b[22m");
});

test("detects color support from stream and no-color option", () => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  const nonTtyStream = { isTTY: false } as NodeJS.WriteStream;

  assert.equal(supportsColor(stream, false), true);
  assert.equal(supportsColor(nonTtyStream, false), false);
  assert.equal(supportsColor(stream, true), false);
});

test("reports runtime details", () => {
  const runtime = getRuntimeInfo();

  assert.equal(runtime.arch, process.arch);
  assert.equal(runtime.cwd, process.cwd());
  assert.equal(runtime.execPath, process.execPath);
  assert.equal(runtime.node, process.version);
  assert.equal(runtime.platform, process.platform);
  assert.equal(runtime.versions, process.versions);
  assert.equal(typeof runtime.sea, "boolean");
});

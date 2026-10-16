import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { test } from "node:test";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { extractDisallowedToolsArgs } from "../src/arguments.js";
import { installStderrConsoleBoundary } from "../src/protocol-console.js";
import { interceptKnownRuntimeWarnings } from "../src/runtime-warnings.js";
import { interceptTuiStderr, isTuiInvocation } from "../src/tui-stderr.js";

function output() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream;
  return { stream, read: () => text };
}

test("TUI console captures real AI SDK warnings while preserving model output and explicit errors", async () => {
  const stdout = output();
  const stderr = output();
  const previousConsole = globalThis.console;
  const previousWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  globalThis.console = new Console({ stdout: stdout.stream, stderr: stderr.stream });
  const restoreConsole = installStderrConsoleBoundary(stderr.stream);
  const warnings = interceptKnownRuntimeWarnings(stderr.stream);
  const tui = interceptTuiStderr(stderr.stream);
  globalThis.AI_SDK_LOG_WARNINGS = undefined;
  try {
    const result = await generateText({
      prompt: "test",
      model: new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "model response" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [{ type: "other", message: "sdk-warning-regression" }],
        },
      }),
    });
    console.info("dependency info");
    console.debug("dependency debug");
    console.log("dependency log");
    console.error("dependency error");
    assert.equal(result.text, "model response");
    assert.equal(stdout.read(), "");
    assert.equal(stderr.read(), "");
    assert.match(tui.bufferedOutput, /AI SDK Warning System/);
    assert.match(tui.bufferedOutput, /sdk-warning-regression/);
    assert.match(tui.bufferedOutput, /dependency info/);
    assert.match(tui.bufferedOutput, /dependency debug/);
    assert.match(tui.bufferedOutput, /dependency log/);
    assert.match(tui.bufferedOutput, /dependency error/);
    tui.passthrough.write("Error: actionable CLI failure\n");
    assert.equal(stderr.read(), "Error: actionable CLI failure\n");
    tui.restore({ flush: true });
    assert.match(stderr.read(), /sdk-warning-regression/);
    assert.doesNotMatch(stderr.read(), /AI SDK Warning System/);
  } finally {
    tui.restore();
    warnings.restore();
    restoreConsole();
    globalThis.console = previousConsole;
    globalThis.AI_SDK_LOG_WARNINGS = previousWarningLogger;
  }
});

test("TUI output protection recognizes the same supported flags as command routing", () => {
  for (const args of [
    [],
    ["tui"],
    ["--locale", "zh-CN", "--mode", "yolo"],
    ["--cwd", "app-server", "--locale=en-US", "tui"],
    ["--browser-use=headless", "--browser-executable", "/test/browser"],
    ["--force-mcs", "--continue"],
    ["tui", "--disallowedTools", "Bash", "web_search", "--locale", "en-US"],
    ["--disallowed-tools=Bash(rm:*)", "tui"],
  ]) {
    assert.equal(isTuiInvocation(args), true, JSON.stringify(args));
  }
});

test("console isolation never captures ordinary CLI output or mistakes flag values for TUI", () => {
  for (const args of [
    ["--help"],
    ["--version"],
    ["--prompt", "tui"],
    ["-p", "tui"],
    ["--target", "tui"],
    ["--cwd", "tui", "login"],
    ["login", "bigmodel", "--no-browser"],
    ["app-server", "--stdio"],
    ["agent-server", "--stdio"],
    ["tui", "--invalid-option"],
  ]) {
    assert.equal(isTuiInvocation(args), false, JSON.stringify(args));
  }
});

test("shared tool-argument extraction preserves normalization and rejects missing values", () => {
  assert.deepEqual(
    extractDisallowedToolsArgs([
      "tui",
      "--disallowedTools",
      "Bash(rm:*,cp:*)",
      "web_search",
      "web_search",
      "--locale",
      "en-US",
      "--disallowed-tools=Edit,Read",
    ]),
    {
      args: ["tui", "--locale", "en-US"],
      toolDisallowlist: ["Bash(rm:*,cp:*)", "WebSearch", "Edit", "Read"],
    },
  );
  assert.throws(() => extractDisallowedToolsArgs(["--disallowedTools", "--locale", "en-US"]));
});

test("console boundary restores the original console once and keeps diagnostics off protocol stdout", () => {
  const previousConsole = globalThis.console;
  const stderr = output();
  const restore = installStderrConsoleBoundary(stderr.stream);
  try {
    console.info("protocol-safe info");
    assert.equal(stderr.read(), "protocol-safe info\n");
    restore();
    assert.equal(globalThis.console, previousConsole);
    restore();
    assert.equal(globalThis.console, previousConsole);
  } finally {
    restore();
  }
});

test("long-running TUI diagnostics are bounded and write callbacks still complete", async () => {
  const stderr = output();
  const tui = interceptTuiStderr(stderr.stream);
  try {
    await new Promise<void>((resolve, reject) => {
      stderr.stream.write(`${"x".repeat(100_000)}latest diagnostic`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    assert.equal(stderr.read(), "");
    assert.ok(tui.bufferedOutput.length <= 64 * 1024);
    assert.ok(tui.bufferedOutput.endsWith("latest diagnostic"));
  } finally {
    tui.restore();
  }
});

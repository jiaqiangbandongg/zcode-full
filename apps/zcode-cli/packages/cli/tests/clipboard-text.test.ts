import assert from "node:assert/strict";
import test from "node:test";
import { createNodeClipboardTextWriter } from "../src/clipboard-text.js";

type CapturedWriteStream = {
  output: () => string;
  write: (chunk: string) => boolean;
};

const createWriteStream = (): CapturedWriteStream => {
  let output = "";

  return {
    output: () => output,
    write: (chunk: string): boolean => {
      output += chunk;
      return true;
    },
  };
};

test("text clipboard writer emits OSC 52 and falls back to native commands", async () => {
  const stdout = createWriteStream();
  const attemptedCommands: string[] = [];
  const writer = createNodeClipboardTextWriter({
    platform: "linux",
    runCommand: async (file, _args, options) => {
      attemptedCommands.push(`${file}:${options.input}`);
      return { exitCode: -1 };
    },
    stdout,
  });

  await writer("hello");

  assert.equal(stdout.output(), "\x1b]52;c;aGVsbG8=\x07");
  assert.deepEqual(attemptedCommands, ["wl-copy:hello", "xclip:hello", "xsel:hello"]);
});

test("text clipboard writer can use native clipboard without stdout", async () => {
  let copiedInput = "";
  const writer = createNodeClipboardTextWriter({
    platform: "darwin",
    runCommand: async (file, args, options) => {
      assert.equal(file, "pbcopy");
      assert.deepEqual(args, []);
      copiedInput = options.input;
      return { exitCode: 0 };
    },
  });

  await writer("from native");

  assert.equal(copiedInput, "from native");
});

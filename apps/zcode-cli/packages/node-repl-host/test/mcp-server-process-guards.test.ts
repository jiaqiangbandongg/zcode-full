import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "../src/server.js";

function createFakeProcess() {
  const emitter = new EventEmitter();
  return {
    emitter,
    on: emitter.on.bind(emitter) as NodeJS.Process["on"],
    once: emitter.once.bind(emitter) as NodeJS.Process["once"],
  };
}

describe("node_repl MCP server process guards", () => {
  it("logs unhandled rejections to stderr instead of letting the process die", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit("unhandledRejection", new Error("boom from stale cell promise"));

    expect(stderrLines.join("")).toContain("unhandledRejection");
    expect(stderrLines.join("")).toContain("boom from stale cell promise");
  });

  it("logs uncaught exceptions to stderr instead of letting the process die", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit("uncaughtException", new Error("boom from async timer"));

    expect(stderrLines.join("")).toContain("uncaughtException");
    expect(stderrLines.join("")).toContain("boom from async timer");
  });

  it("keeps handler installation idempotent so repeated main() bootstraps do not stack listeners", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    const options = {
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text: string) => stderrLines.push(text),
    };
    installNodeReplProcessGuards(options);
    installNodeReplProcessGuards(options);

    fake.emitter.emit("unhandledRejection", new Error("once"));

    expect(stderrLines).toHaveLength(1);
  });

  it("stringifies non-Error rejection reasons", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit("unhandledRejection", "plain string reason");

    expect(stderrLines.join("")).toContain("plain string reason");
  });

  it.each(["EPIPE", "EIO", "ENXIO", "EBADF", "ERR_STREAM_DESTROYED"])(
    "treats %s as a terminal output closure without writing to the broken stderr again",
    (code) => {
      const fake = createFakeProcess();
      const stderrLines: string[] = [];
      const onOutputClosed = vi.fn();
      installNodeReplProcessGuards({
        onOutputClosed,
        process: fake,
        writeStderr: (text) => stderrLines.push(text),
      });
      const error = Object.assign(new Error(`write ${code}`), { code });

      fake.emitter.emit("uncaughtException", error);
      fake.emitter.emit("uncaughtException", error);

      expect(onOutputClosed).toHaveBeenCalledOnce();
      expect(onOutputClosed).toHaveBeenCalledWith(error);
      expect(stderrLines).toEqual([]);
    },
  );

  it("stops reporting queued errors after the output has closed", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit(
      "uncaughtException",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );
    fake.emitter.emit("unhandledRejection", new Error("already queued"));

    expect(stderrLines).toEqual([]);
  });

  it("treats a synchronous EPIPE from the diagnostic write as output closure", () => {
    const fake = createFakeProcess();
    const onOutputClosed = vi.fn();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    installNodeReplProcessGuards({
      onOutputClosed,
      process: fake,
      writeStderr: () => {
        throw error;
      },
    });

    fake.emitter.emit("uncaughtException", new Error("original async failure"));

    expect(onOutputClosed).toHaveBeenCalledOnce();
    expect(onOutputClosed).toHaveBeenCalledWith(error);
  });
});

describe("node_repl MCP server shutdown triggers", () => {
  it.each(["end", "close"] as const)("shuts down when stdin emits %s", (event) => {
    const fakeProcess = createFakeProcess();
    const stdin = new EventEmitter();
    const shutdown = vi.fn();
    installNodeReplShutdownTriggers({
      process: fakeProcess,
      shutdown,
      stdin: {
        once: stdin.once.bind(stdin) as NodeJS.ReadStream["once"],
      },
    });

    stdin.emit(event);

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("coalesces stdin closure and process signals into one shutdown", () => {
    const fakeProcess = createFakeProcess();
    const stdin = new EventEmitter();
    const shutdown = vi.fn();
    installNodeReplShutdownTriggers({
      process: fakeProcess,
      shutdown,
      stdin: {
        once: stdin.once.bind(stdin) as NodeJS.ReadStream["once"],
      },
    });

    stdin.emit("end");
    stdin.emit("close");
    fakeProcess.emitter.emit("SIGTERM");
    fakeProcess.emitter.emit("SIGINT");

    expect(shutdown).toHaveBeenCalledOnce();
  });
});

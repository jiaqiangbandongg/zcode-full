import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";
import type { RunDependencies } from "../src/run.js";

type CapturedWriteStream = NodeJS.WriteStream & {
  output: () => string;
};

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    output: () => output,
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const writeCallback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      writeCallback?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (
  argv: string[],
): RunContext & { stderr: CapturedWriteStream; stdout: CapturedWriteStream } => ({
  argv,
  stderr: createWriteStream(),
  stdin: { isTTY: false } as NodeJS.ReadStream,
  stdout: createWriteStream(),
});

const fakeProjection = {
  contextUsed: 12,
  contextWindow: 1000,
  status: "idle",
  totalTokenCount: 12,
  turnCount: 1,
};

/** Two events, one carrying a newline, so NDJSON framing is actually exercised. */
const fakeEvents = [
  { id: "evt-1", type: "model.streaming", text: "first" },
  { id: "evt-2", type: "turn.completed", text: "second\nwith a newline" },
];

const createDeps = (): RunDependencies => ({
  createZCodeApp: () =>
    ({
      getModel: () => "openai/gpt-test",
      getThoughtLevel: () => "medium",
      sessionId: "session-test",
      traceId: "trace-test",
      runtime: {} as never,
      submitPrompt: async (
        _prompt: unknown,
        options?: { onEvent?: (event: unknown) => void | Promise<void> },
      ) => {
        for (const event of fakeEvents) options?.onEvent?.(event);
        return {
          events: fakeEvents,
          projection: fakeProjection as never,
          response: "the answer",
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        };
      },
    }) as never,
  loadDotenv: () => ({ keys: [], loaded: false }),
  startProcessProviderRegistryRuntime: async () =>
    ({
      dispose: () => {},
      runtime: { registryService: {} },
    }) as never,
  // Stand-in for the bootstrap mapper: the bootstrap module is not loaded when
  // createZCodeApp is injected, so streaming needs this to be injectable too.
  mapSessionEvent: ((event: { id: string; type: string }) => ({
    eventId: event.id,
    type: event.type,
  })) as never,
});

test("stream-json writes one line per event, then a tagged result line", async () => {
  const ctx = createContext(["--output-format", "stream-json", "--prompt", "hi"]);
  const code = await run(ctx, createDeps());
  assert.equal(code, 0);

  const lines = ctx.stdout.output().trim().split("\n");
  // Two events plus the summary. If anything pretty-printed its JSON this count
  // would balloon — which is the bug this test exists to catch.
  assert.equal(lines.length, 3);

  const first = JSON.parse(lines[0] ?? "") as { eventId: string; type: string };
  assert.equal(first.eventId, "evt-1");
  assert.equal(first.type, "model.streaming");

  const summary = JSON.parse(lines[2] ?? "") as {
    type: string;
    response: string;
    sessionId: string;
    eventCount: number;
  };
  assert.equal(summary.type, "result");
  assert.equal(summary.response, "the answer");
  assert.equal(summary.sessionId, "session-test");
  assert.equal(summary.eventCount, 2);
});

test("every stream-json line parses on its own", async () => {
  const ctx = createContext(["--output-format", "stream-json", "--prompt", "hi"]);
  await run(ctx, createDeps());
  for (const line of ctx.stdout.output().trim().split("\n")) {
    assert.doesNotThrow(() => JSON.parse(line), `not valid JSON on its own: ${line}`);
  }
});

test("--output-format json prints the summary, not plain text", async () => {
  // Regression: an earlier cut of this change only looked at `options.json`, so
  // --output-format json parsed fine and then silently printed plain text.
  const ctx = createContext(["--output-format", "json", "--prompt", "hi"]);
  assert.equal(await run(ctx, createDeps()), 0);
  const out = ctx.stdout.output();
  const parsed = JSON.parse(out) as { response: string; sessionId: string };
  assert.equal(parsed.response, "the answer");
  assert.equal(parsed.sessionId, "session-test");
});

test("--output-format text prints the answer only, overriding --json", async () => {
  const ctx = createContext(["--output-format", "text", "--json", "--prompt", "hi"]);
  assert.equal(await run(ctx, createDeps()), 0);
  assert.equal(ctx.stdout.output(), "the answer\n");
});

test("plain --json keeps working unchanged", async () => {
  const ctx = createContext(["--json", "--prompt", "hi"]);
  assert.equal(await run(ctx, createDeps()), 0);
  const parsed = JSON.parse(ctx.stdout.output()) as { response: string };
  assert.equal(parsed.response, "the answer");
});

test("no output-format streams nothing: a default run is unchanged", async () => {
  const ctx = createContext(["--prompt", "hi"]);
  assert.equal(await run(ctx, createDeps()), 0);
  assert.equal(ctx.stdout.output(), "the answer\n");
});

test("an unknown --output-format is rejected instead of falling back to text", async () => {
  const ctx = createContext(["--output-format", "ndjson", "--prompt", "hi"]);
  const code = await run(ctx, createDeps());
  assert.notEqual(code, 0);
  assert.match(ctx.stderr.output(), /--output-format must be one of/);
  assert.equal(ctx.stdout.output(), "");
});

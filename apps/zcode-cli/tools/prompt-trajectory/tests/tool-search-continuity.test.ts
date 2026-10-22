import { deepStrictEqual, equal, match } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deriveTrajectoriesFromEntries } from "../src/derive.js";
import { deriveTrajectoriesFromModelIoEntries, type ModelIoJsonlEntry } from "../src/model-io.js";
import type { OpenAiMessage, TrajectoryJsonlEntry } from "../src/types.js";

const options = { ignoreToolSearchChanges: true };
const text = (value: string) => ({ type: "text", text: value });
const user = (content: unknown[]): OpenAiMessage => ({ role: "user", content });
const assistant = (content: unknown[]): OpenAiMessage => ({ role: "assistant", content });
const reference = { type: "tool_reference", tool_name: "WebFetch" };
const removed = text("[Tool references removed - tools no longer available]");
const disabled = text("[Tool references removed - tool search not enabled]");
const call = { type: "tool_use", id: "search_1", name: "ToolSearch", input: { query: "web" } };
const announcement = text(
  '<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nWebFetch\n</system-reminder>',
);
const result = (content: unknown[], id = "search_1") => ({
  type: "tool_result",
  tool_use_id: id,
  content,
});
const history = (content: unknown[] = [reference]): OpenAiMessage[] => [
  user([announcement, text("find a tool")]),
  assistant([call]),
  user([result(content)]),
];
const record = (
  messages: OpenAiMessage[],
  response?: ModelIoJsonlEntry["response"],
): ModelIoJsonlEntry => ({
  querySource: "main_turn",
  request: { body: { model: "test", messages } },
  response,
});

describe("ToolSearch trajectory synthesis", () => {
  it("requires opt-in and retains the last real request through removal and restoration", () => {
    const first = history();
    const second = [...history([removed]), assistant([text("ready")]), user([text("removed")])];
    const third = [...second, assistant([text("removed")]), user([text("restored")])];
    third[2] = user([result([reference])]);
    const records = [
      record(first, { text: "ready" }),
      record(second, { text: "removed" }),
      record(third),
    ];
    const original = structuredClone(records);
    const strict = deriveTrajectoriesFromModelIoEntries(records);
    equal(strict.trajectories.length, 3);
    equal(strict.manifest.ignoreToolSearchChanges, undefined);
    const merged = deriveTrajectoriesFromModelIoEntries(records, options);
    equal(merged.trajectories.length, 1);
    equal(merged.trajectories[0]?.requestCount, 3);
    deepStrictEqual(merged.trajectories[0]?.requestBody.messages, third);
    equal(merged.manifest.ignoreToolSearchChanges, true);
    deepStrictEqual(records, original);
  });

  for (const content of [
    [removed],
    [disabled],
    [reference, { ...reference, tool_name: "TodoWrite" }],
  ]) {
    it(`ignores reference projections: ${JSON.stringify(content)}`, () => {
      const last = [...history(content), user([text("next")])];
      const merged = deriveTrajectoriesFromModelIoEntries(
        [record(history()), record(last)],
        options,
      );
      equal(merged.trajectories.length, 1);
      deepStrictEqual(merged.trajectories[0]?.requestBody.messages, last);
    });
  }

  it("ignores references within mixed results while preserving ordinary text and its order", () => {
    const before = history([text("before"), reference, text("after")]);
    const after = history([text("before"), text("after")]);
    equal(
      deriveTrajectoriesFromModelIoEntries([record(before), record(after)], options).trajectories
        .length,
      1,
    );
    const edited = history([text("after"), text("before")]);
    equal(
      deriveTrajectoriesFromModelIoEntries([record(before), record(edited)], options).trajectories
        .length,
      2,
    );
  });

  for (const notice of [
    announcement,
    text(
      "<system-reminder>\nThe following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:\nWebFetch\n</system-reminder>",
    ),
    text(
      "<system-reminder>\n31 deferred tools are no longer available (MCP server disconnected): mcp__demo__* (31). Do not search for them — ToolSearch will return no match.\n</system-reminder>",
    ),
    text(
      "<system-reminder>\n1 deferred tool is available again (MCP server reconnected — names announced earlier in this conversation): WebFetch. Load via ToolSearch as before.\n</system-reminder>",
    ),
  ]) {
    it(`ignores only a catalog reminder block: ${notice.text.slice(18, 80)}`, () => {
      const before = [user([notice]), ...history()];
      const after = history();
      after[0] = user([text("find a tool")]);
      after.push(user([notice, text("next")]));
      const merged = deriveTrajectoriesFromModelIoEntries([record(before), record(after)], options);
      equal(merged.trajectories.length, 1);
      deepStrictEqual(merged.trajectories[0]?.requestBody.messages, after);
    });
  }

  it("completes real reasoning after an announcement disappears and references are filtered", () => {
    const before = [user([announcement]), ...history()];
    const readCall = { type: "tool_use", id: "read_1", name: "Read", input: { path: "a" } };
    const reply = assistant([
      { type: "thinking", thinking: "thought", signature: "sig" },
      readCall,
    ]);
    const after = [...history([removed]), reply, user([result([text("file")], "read_1")])];
    const records = [
      record(before, { toolCalls: [{ id: "read_1", name: "Read", input: { path: "a" } }] }),
      record(after),
    ];
    const merged = deriveTrajectoriesFromModelIoEntries(records, options);
    equal(merged.trajectories.length, 1);
    deepStrictEqual(merged.trajectories[0]?.requestBody.messages, after);
  });

  it("expands deltas and filters sidecars before relaxing ToolSearch comparison", () => {
    const first = history();
    const after = history([disabled]);
    const delta = record(after.slice(2));
    delta.request!.bodyMessagesKind = "delta";
    delta.request!.bodyMessageOffset = 2;
    const sidecar = { ...record(first), querySource: "session_title" };
    const merged = deriveTrajectoriesFromModelIoEntries([record(first), sidecar, delta], options);
    equal(merged.trajectories.length, 1);
    equal(merged.trajectories[0]?.requestCount, 2);
    deepStrictEqual(merged.trajectories[0]?.requestBody.messages, after);
  });

  for (const [label, change] of [
    [
      "input",
      (h) => {
        h[1] = assistant([{ ...call, input: { query: "changed" } }]);
      },
    ],
    [
      "call ID",
      (h) => {
        h[1] = assistant([{ ...call, id: "changed" }]);
      },
    ],
    [
      "result ID",
      (h) => {
        h[2] = user([result([reference], "changed")]);
      },
    ],
    [
      "error status",
      (h) => {
        h[2] = user([{ ...result([reference]), is_error: true }]);
      },
    ],
    [
      "result text",
      (h) => {
        h[2] = user([result([text("No matching tools found")])]);
      },
    ],
    [
      "user text",
      (h) => {
        h[0] = user([announcement, text("changed")]);
      },
    ],
    [
      "other reminder",
      (h) => {
        h[0] = user([
          announcement,
          text("find a tool"),
          text("<system-reminder>TodoWrite reminder</system-reminder>"),
        ]);
      },
    ],
    [
      "thinking",
      (h) => {
        h[1] = assistant([{ type: "thinking", thinking: "changed", signature: "sig" }, call]);
      },
    ],
  ] satisfies Array<[string, (h: OpenAiMessage[]) => void]>) {
    it(`still splits on ${label}`, () => {
      const after = history();
      change(after);
      equal(
        deriveTrajectoriesFromModelIoEntries([record(history()), record(after)], options)
          .trajectories.length,
        2,
      );
    });
  }

  it("does not mask references or placeholder text in another tool's result", () => {
    const before = history();
    before[1] = assistant([{ ...call, name: "Read" }]);
    const after = structuredClone(before);
    after[2] = user([result([removed])]);
    equal(
      deriveTrajectoriesFromModelIoEntries([record(before), record(after)], options).trajectories
        .length,
      2,
    );
  });

  it("preserves compact and Continue history boundaries", () => {
    const before = [
      ...history(),
      assistant([text("partial")]),
      user([text("Output token limit hit. Resume directly")]),
    ];
    equal(
      deriveTrajectoriesFromModelIoEntries([record(before), record(history())], options)
        .trajectories.length,
      2,
    );
    const compacted = [
      user([
        text("This session is being continued from a previous conversation that was compacted"),
      ]),
    ];
    const merged = deriveTrajectoriesFromModelIoEntries(
      [record(before), record(compacted)],
      options,
    );
    equal(merged.trajectories[1]?.reason, "post-compaction");
  });

  it("also applies to recorded ledgers, keeping final tool definitions unchanged", () => {
    const latestTools = [{ name: "Read", input_schema: { type: "object" } }];
    const entries: TrajectoryJsonlEntry[] = [history(), history([disabled])].flatMap(
      (messages, i) => [
        {
          kind: "request",
          requestIndex: i + 1,
          bodyWithoutMessages: { model: "test", tools: i ? latestTools : [] },
        },
        ...messages.map((message, messageIndex) => ({
          kind: "message" as const,
          requestIndex: i + 1,
          messageIndex,
          message,
        })),
      ],
    );
    const merged = deriveTrajectoriesFromEntries(entries, options);
    equal(merged.trajectories.length, 1);
    deepStrictEqual(merged.trajectories[0]?.requestBody.tools, latestTools);
  });

  for (const command of ["model-io", "derive"]) {
    it(`exposes the opt-in via the ${command} CLI and marks the output manifest`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "toolsearch-trajectory-"));
      try {
        const input = join(dir, "input.jsonl");
        const messages = [history(), history([disabled])];
        const rows =
          command === "model-io"
            ? messages.map((h) => record(h))
            : messages.flatMap((h, i) => [
                { kind: "request", requestIndex: i + 1, bodyWithoutMessages: { model: "test" } },
                ...h.map((message, messageIndex) => ({
                  kind: "message",
                  requestIndex: i + 1,
                  messageIndex,
                  message,
                })),
              ]);
        await writeFile(input, rows.map((r) => JSON.stringify(r)).join("\n"));
        const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
        await promisify(execFile)(process.execPath, [
          "--import",
          import.meta.resolve("tsx"),
          cli,
          command,
          "--input",
          input,
          "--out",
          dir,
          "--ignore-tool-search-changes",
        ]);
        const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
        equal(manifest.ignoreToolSearchChanges, true);
        equal(manifest.trajectories.length, 1);
        const output = await readFile(
          join(dir, "trajectories", "0001.anthropic_request_body.json"),
          "utf8",
        );
        match(output, /Tool references removed - tool search not enabled/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

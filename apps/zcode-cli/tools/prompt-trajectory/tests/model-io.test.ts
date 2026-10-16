import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveTrajectoriesFromModelIoEntries,
  writeModelIoAnthropicTrajectory,
  type ModelIoJsonlEntry,
} from "../src/model-io.js";

describe("deriveTrajectoriesFromModelIoEntries", () => {
  it("expands model-io body message deltas before deriving the main trajectory", () => {
    const entries: ModelIoJsonlEntry[] = [
      {
        querySource: "main_turn",
        request: {
          body: {
            messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
            model: "glm-test",
          },
          bodyMessageCount: 1,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: {
          finishReason: "stop",
          text: "first answer",
          toolCalls: [],
        },
        type: "model_io",
      },
      {
        querySource: "main_turn",
        request: {
          body: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "first answer" }],
              },
              { role: "user", content: [{ type: "text", text: "second" }] },
            ],
            model: "glm-test",
          },
          bodyMessageCount: 3,
          bodyMessageOffset: 1,
          bodyMessagesKind: "delta",
        },
        response: {
          finishReason: "stop",
          text: "second answer",
          toolCalls: [],
        },
        type: "model_io",
      },
    ];

    const result = deriveTrajectoriesFromModelIoEntries(entries);

    equal(result.trajectories.length, 1);
    equal(result.trajectories[0]?.requestCount, 2);
    deepStrictEqual(result.trajectories[0]?.requestBody.messages, [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ]);
  });

  it("keeps append-only main turns together when a session_title sidecar is present", () => {
    const entries: ModelIoJsonlEntry[] = [
      {
        querySource: "main_turn",
        request: {
          body: {
            messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
            model: "glm-test",
          },
          bodyMessageCount: 1,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: {
          finishReason: "tool-calls",
          text: "reading",
          toolCalls: [{ id: "call_1", input: { file_path: "/tmp/a.md" }, name: "Read" }],
        },
        type: "model_io",
      },
      {
        querySource: "session_title",
        request: {
          body: {
            messages: [{ role: "user", content: "Generate a title" }],
            model: "glm-test",
          },
          bodyMessageCount: 1,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: { finishReason: "stop", text: "{\"title\":\"demo\"}", toolCalls: [] },
        type: "model_io",
      },
      {
        querySource: "main_turn",
        request: {
          body: {
            messages: [
              { role: "user", content: [{ type: "text", text: "first" }] },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "reading" },
                  {
                    type: "tool_use",
                    id: "call_1",
                    input: { file_path: "/tmp/a.md" },
                    name: "Read",
                  },
                ],
              },
              {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "call_1", content: "# A" },
                  { type: "text", text: "summarize" },
                ],
              },
            ],
            model: "glm-test",
          },
          bodyMessageCount: 3,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: { finishReason: "stop", text: "summary", toolCalls: [] },
        type: "model_io",
      },
    ];

    const result = deriveTrajectoriesFromModelIoEntries(entries);

    equal(result.trajectories.length, 1);
    equal(result.trajectories[0]?.requestCount, 2);
    equal(result.manifest.trajectories[0]?.reason, "initial");
  });
});

describe("writeModelIoAnthropicTrajectory", () => {
  it("writes a single Anthropic trajectory JSON for main_turn records by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-model-io-trajectory-"));
    const inputPath = join(root, "model-io.jsonl");
    const entries: ModelIoJsonlEntry[] = [
      {
        querySource: "session_title",
        request: {
          body: {
            messages: [{ role: "user", content: "Generate a title" }],
            model: "glm-test",
          },
          bodyMessageCount: 1,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: { finishReason: "stop", text: "{\"title\":\"demo\"}", toolCalls: [] },
        type: "model_io",
      },
      {
        querySource: "main_turn",
        request: {
          body: {
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            model: "glm-test",
            system: [{ type: "text", text: "stable system" }],
          },
          bodyMessageCount: 1,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: { finishReason: "stop", text: "hi", toolCalls: [] },
        type: "model_io",
      },
    ];
    await writeFile(
      inputPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    await writeModelIoAnthropicTrajectory({ inputPath, outDir: root });

    const anthropic = JSON.parse(await readFile(join(root, "anthropic_trajectory.json"), "utf8"));
    deepStrictEqual(anthropic, {
      model: "glm-test",
      system: [{ type: "text", text: "stable system" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
    });
  });

  it("projects recorded mid-conversation system blocks to the final wire string", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-model-io-mcs-"));
    const inputPath = join(root, "model-io.jsonl");
    const entries: ModelIoJsonlEntry[] = [
      {
        querySource: "main_turn",
        request: {
          body: {
            messages: [
              { role: "user", content: [{ type: "text", text: "hello" }] },
              { role: "system", content: [{ type: "text", text: "runtime reminder" }] },
              { role: "assistant", content: [{ type: "text", text: "hi" }] },
              { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
            model: "glm-test",
            system: [{ type: "text", text: "stable system" }],
          },
          bodyMessageCount: 4,
          bodyMessageOffset: 0,
          bodyMessagesKind: "full",
        },
        response: { finishReason: "stop", text: "done", toolCalls: [] },
        type: "model_io",
      },
    ];
    await writeFile(
      inputPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    await writeModelIoAnthropicTrajectory({ inputPath, outDir: root });

    const openAi = JSON.parse(
      await readFile(join(root, "trajectories", "0001.openai_request_body.json"), "utf8"),
    );
    const anthropic = JSON.parse(await readFile(join(root, "anthropic_trajectory.json"), "utf8"));
    deepStrictEqual(openAi.messages, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: [{ type: "text", text: "runtime reminder" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    deepStrictEqual(anthropic.system, [{ type: "text", text: "stable system" }]);
    deepStrictEqual(anthropic.messages, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: "runtime reminder" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });
});

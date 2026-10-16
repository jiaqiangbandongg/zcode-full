import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveTrajectoriesFromEntries,
  writeDerivedTrajectories,
  type TrajectoryJsonlEntry,
} from "../src/derive.js";

describe("deriveTrajectoriesFromEntries", () => {
  it("keeps append-only requests in one trajectory and appends the final assistant response", () => {
    const entries: TrajectoryJsonlEntry[] = [
      {
        kind: "request",
        requestIndex: 1,
        bodyWithoutMessages: {
          model: "glm-test",
          temperature: 0.2,
        },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 0,
        message: { role: "user", content: "hello" },
      },
      {
        kind: "message",
        requestIndex: 1,
        message: { role: "assistant", content: "hi" },
      },
      {
        kind: "request",
        requestIndex: 2,
        bodyWithoutMessages: {
          model: "glm-test",
          temperature: 0.2,
        },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 0,
        message: { role: "user", content: "hello" },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 1,
        message: { role: "assistant", content: "hi" },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 2,
        message: { role: "user", content: "continue" },
      },
      {
        kind: "message",
        requestIndex: 2,
        message: { role: "assistant", content: "done" },
      },
    ];

    const result = deriveTrajectoriesFromEntries(entries);

    equal(result.trajectories.length, 1);
    equal(result.trajectories[0]?.id, "0001");
    deepStrictEqual(result.trajectories[0]?.requestBody, {
      model: "glm-test",
      temperature: 0.2,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "continue" },
        { role: "assistant", content: "done" },
      ],
    });
  });

  it("does not split a trajectory when Anthropic cache_control moves between user turns", () => {
    const entries: TrajectoryJsonlEntry[] = [
      {
        kind: "request",
        requestIndex: 1,
        bodyWithoutMessages: { model: "glm-test" },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 0,
        message: {
          role: "user",
          content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
        },
      },
      {
        kind: "message",
        requestIndex: 1,
        message: { role: "assistant", content: "first answer" },
      },
      {
        kind: "request",
        requestIndex: 2,
        bodyWithoutMessages: { model: "glm-test" },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 0,
        message: {
          role: "user",
          content: [{ type: "text", text: "first" }],
        },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 1,
        message: { role: "assistant", content: "first answer" },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 2,
        message: {
          role: "user",
          content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }],
        },
      },
      {
        kind: "message",
        requestIndex: 2,
        message: { role: "assistant", content: "second answer" },
      },
    ];

    const result = deriveTrajectoriesFromEntries(entries);

    equal(result.trajectories.length, 1);
    deepStrictEqual(result.trajectories[0]?.requestBody.messages, [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: "first answer" },
      {
        role: "user",
        content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: "second answer" },
    ]);
  });

  it("starts a post-compaction trajectory when request messages are not append-only", () => {
    const compactContinuation =
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\nsummary";
    const entries: TrajectoryJsonlEntry[] = [
      {
        kind: "request",
        requestIndex: 1,
        bodyWithoutMessages: { model: "glm-test" },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 0,
        message: { role: "user", content: "long history" },
      },
      {
        kind: "message",
        requestIndex: 1,
        message: { role: "assistant", content: "large answer" },
      },
      {
        kind: "request",
        requestIndex: 2,
        bodyWithoutMessages: { model: "glm-test" },
      },
      {
        kind: "message",
        requestIndex: 2,
        messageIndex: 0,
        message: {
          role: "user",
          content: compactContinuation,
        },
      },
      {
        kind: "message",
        requestIndex: 2,
        message: { role: "assistant", content: "after compact" },
      },
    ];

    const result = deriveTrajectoriesFromEntries(entries);

    equal(result.trajectories.length, 2);
    equal(result.trajectories[0]?.id, "0001-pre-compaction");
    equal(result.trajectories[1]?.id, "0002-post-compaction");
    equal(result.trajectories[1]?.reason, "post-compaction");
    deepStrictEqual(result.trajectories[1]?.requestBody.messages, [
      {
        role: "user",
        content: compactContinuation,
      },
      { role: "assistant", content: "after compact" },
    ]);
  });

  it("omits tool_choice and orders request body fields for comparison", () => {
    const entries: TrajectoryJsonlEntry[] = [
      {
        kind: "request",
        requestIndex: 1,
        bodyWithoutMessages: {
          temperature: 0.2,
          tools: [{ type: "function", function: { name: "read_file" } }],
          tool_choice: "auto",
          model: "glm-test",
          stream: true,
        },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 0,
        message: { role: "user", content: "hello" },
      },
    ];

    const result = deriveTrajectoriesFromEntries(entries);
    const requestBody = result.trajectories[0]?.requestBody;

    deepStrictEqual(Object.keys(requestBody ?? {}), [
      "model",
      "messages",
      "tools",
      "temperature",
      "stream",
    ]);
    equal(requestBody?.tool_choice, undefined);
  });

  it("writes Anthropic request-body snapshots alongside OpenAI-compatible snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-derive-"));
    const inputPath = join(root, "trajectory.jsonl");
    const entries: TrajectoryJsonlEntry[] = [
      {
        kind: "request",
        requestIndex: 1,
        bodyWithoutMessages: {
          model: "glm-test",
          tools: [{ type: "function", function: { name: "Read" } }],
        },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 0,
        message: { role: "system", content: "stable system" },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 1,
        message: { role: "user", content: "prefix context" },
      },
      {
        kind: "message",
        requestIndex: 1,
        messageIndex: 2,
        message: { role: "user", content: "real prompt" },
      },
    ];
    await writeFile(
      inputPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    await writeDerivedTrajectories({ inputPath, outDir: root });

    const openAiBody = JSON.parse(
      await readFile(join(root, "trajectories", "0001.openai_request_body.json"), "utf8"),
    );
    const anthropicBody = JSON.parse(
      await readFile(join(root, "trajectories", "0001.anthropic_request_body.json"), "utf8"),
    );

    deepStrictEqual(openAiBody.messages, [
      { role: "system", content: "stable system" },
      { role: "user", content: "prefix context" },
      { role: "user", content: "real prompt" },
    ]);
    deepStrictEqual(anthropicBody.system, [{ type: "text", text: "stable system" }]);
    deepStrictEqual(anthropicBody.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "prefix context" },
          { type: "text", text: "real prompt" },
        ],
      },
    ]);
  });
});

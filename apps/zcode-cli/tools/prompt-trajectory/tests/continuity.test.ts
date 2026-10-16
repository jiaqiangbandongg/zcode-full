import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTrajectoriesFromEntries } from "../src/derive.js";
import type { OpenAiMessage, TrajectoryJsonlEntry } from "../src/types.js";

function derive(previous: OpenAiMessage[], next: OpenAiMessage[]) {
  const entries: TrajectoryJsonlEntry[] = [previous, next].flatMap((messages, index) => [
    { kind: "request", requestIndex: index + 1, bodyWithoutMessages: { model: "test" } },
    ...messages.map(
      (message, messageIndex): TrajectoryJsonlEntry => ({
        kind: "message",
        requestIndex: index + 1,
        messageIndex,
        message,
      }),
    ),
  ]);
  return deriveTrajectoriesFromEntries(entries);
}

const toolResult = { type: "tool_result", tool_use_id: "call_1", content: "original result" };
const prompt = { type: "text", text: "also check gold" };
const user = { role: "user", content: [toolResult] };

describe("trajectory message continuity", () => {
  it("accepts appended blocks on the final user and preserves the latest cache controls", () => {
    const old = [
      { role: "user", content: [{ ...toolResult, cache_control: { type: "ephemeral" } }] },
    ];
    const next = [
      { role: "user", content: [toolResult, { ...prompt, cache_control: { type: "ephemeral" } }] },
    ];
    const output = derive(old, next);
    equal(output.trajectories.length, 1);
    deepStrictEqual(output.trajectories[0]?.requestBody.messages, next);
  });

  const cases: Array<{ name: string; previous: OpenAiMessage[]; next: OpenAiMessage[] }> = [
    {
      name: "changed result",
      previous: [user],
      next: [{ role: "user", content: [{ ...toolResult, content: "changed" }, prompt] }],
    },
    {
      name: "reordered blocks",
      previous: [user],
      next: [{ role: "user", content: [prompt, toolResult] }],
    },
    {
      name: "removed block",
      previous: [{ role: "user", content: [toolResult, prompt] }],
      next: [user],
    },
    {
      name: "changed role",
      previous: [user],
      next: [{ role: "system", content: [toolResult, prompt] }],
    },
    {
      name: "changed message metadata",
      previous: [{ ...user, name: "original" }],
      next: [{ role: "user", name: "changed", content: [toolResult, prompt] }],
    },
    {
      name: "extended non-final user",
      previous: [user, { role: "assistant", content: "done" }],
      next: [
        { role: "user", content: [toolResult, prompt] },
        { role: "assistant", content: "done" },
      ],
    },
    {
      name: "extended assistant",
      previous: [{ role: "assistant", content: [prompt] }],
      next: [{ role: "assistant", content: [prompt, prompt] }],
    },
    {
      name: "removed message",
      previous: [user, { role: "assistant", content: "done" }],
      next: [user],
    },
  ];
  for (const { name, previous, next } of cases) {
    it(`retains non-incremental-change for ${name}`, () => {
      const output = derive(previous, next);
      equal(output.trajectories.length, 2);
      equal(output.trajectories[1]?.reason, "non-incremental-change");
    });
  }
});

import { describe, expect, it } from "vitest";
import { createModelId, createModelProviderId, type ModelInputMessage } from "@zcode/contracts";
import { normalizeReasoningHistory } from "../src/model/reasoning-history-normalization.js";

const MODEL_ID = createModelId("GLM-5.3");
const PROVIDER_GROUPS = [
  ["builtin:zai-coding-plan", "account:zai-individual-coding-plan", "account:zai-team-coding-plan"],
  [
    "builtin:bigmodel-coding-plan",
    "account:bigmodel-individual-coding-plan",
    "account:bigmodel-team-coding-plan",
  ],
];
const compatiblePairs = PROVIDER_GROUPS.flatMap((group) =>
  group.flatMap((source) => group.map((target) => [source, target] as const)),
);

describe("reasoning replay provider identity", () => {
  it.each(compatiblePairs)("preserves history and cache metadata: %s -> %s", (source, target) => {
    const messages = history(source);
    const before = structuredClone(messages);
    expect(normalizeReasoningHistory(messages, identity(target))).toBe(messages);
    expect(messages).toEqual(before);
  });

  it.each([
    ["builtin:zai-coding-plan", "account:bigmodel-individual-coding-plan"],
    ["builtin:bigmodel-coding-plan", "account:zai-team-coding-plan"],
    ["account:zai-team-coding-plan", "account:bigmodel-team-coding-plan"],
    ["custom-a", "custom-b"],
    ["custom-zai-coding-plan", "account:zai-individual-coding-plan"],
    ["account:zai-team-coding-plan-extra", "account:zai-team-coding-plan"],
    ["builtin:zai-unknown-plan", "account:zai-team-coding-plan"],
    ["account:zai-start-plan", "account:zai-team-coding-plan"],
    ["account:zai-off-peak", "account:zai-team-coding-plan"],
    ["zai-api", "account:zai-team-coding-plan"],
  ])("keeps distinct providers isolated: %s -> %s", (source, target) => {
    expectStripped(history(source), identity(target));
    expectStripped(history(target), identity(source));
  });

  it.each(compatiblePairs)("still strips across model IDs: %s -> %s", (source, target) => {
    expectStripped(history(source), { ...identity(target), modelId: createModelId("GLM-5.2") });
  });

  it("keeps identical custom provider identities compatible", () => {
    const messages = history("custom-a");
    expect(normalizeReasoningHistory(messages, identity("custom-a"))).toBe(messages);
  });
});

function identity(providerId: string) {
  return { providerId: createModelProviderId(providerId), modelId: MODEL_ID };
}

function history(providerId: string): ModelInputMessage[] {
  return [
    { role: "user", content: "Read the file" },
    {
      role: "assistant",
      ...identity(providerId),
      cacheControl: { type: "ephemeral" },
      content: [
        {
          type: "reasoning",
          text: "signed",
          providerOptions: { anthropic: { signature: " sig\n" } },
        },
        { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "opaque" } } },
        { type: "reasoning", text: "unsigned" },
        { type: "text", text: "Reading" },
      ],
      toolCalls: [{ id: "read", name: "Read", input: { file_path: "file.txt" } }],
    },
    { role: "tool", toolCallId: "read", toolName: "Read", content: "File contents" },
    { role: "user", content: "Continue" },
  ];
}

function expectStripped(messages: ModelInputMessage[], target: ReturnType<typeof identity>) {
  const before = structuredClone(messages);
  const projected = normalizeReasoningHistory(messages, target);
  expect(projected).toEqual([
    messages[0],
    {
      ...messages[1],
      content: [
        { type: "reasoning", text: "unsigned" },
        { type: "text", text: "Reading" },
      ],
    },
    ...messages.slice(2),
  ]);
  expect(messages).toEqual(before);
}

import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import {
  isThinkingSignatureRejection,
  normalizeReasoningHistory,
  removeRejectedReasoning,
} from "../src/model/reasoning-history-normalization.js";

describe("reasoning history normalization", () => {
  it("preserves signed and redacted reasoning for the same model identity", () => {
    const messages: ModelInputMessage[] = [
      assistantWithReasoning(
        [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("redacted", { redactedData: "redacted_1" }),
          { type: "text", text: "answer" },
        ],
        modelIdentity("provider-a/model-a"),
      ),
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-a/model-a"))).toBe(messages);
  });

  it("removes signed and redacted reasoning across model identities but preserves unsigned blocks", () => {
    const messages: ModelInputMessage[] = [
      assistantWithReasoning(
        [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          reasoning("empty signature", { signature: "" }),
          reasoning("redacted", { redactedData: "redacted_1" }),
          { type: "text", text: "answer" },
        ],
        modelIdentity("provider-a/shared-model"),
      ),
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/shared-model"))).toEqual([
      {
        role: "assistant",
        ...modelIdentity("provider-a/shared-model"),
        content: [
          reasoning("unsigned"),
          reasoning("empty signature", { signature: "" }),
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("preserves a non-final assistant envelope when cross-model stripping makes it empty", () => {
    const messages: ModelInputMessage[] = [
      assistantWithReasoning(
        [reasoning("signed", { signature: "sig_1" })],
        modelIdentity("provider-a/model-a"),
      ),
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/model-b"))).toEqual([
      {
        role: "assistant",
        ...modelIdentity("provider-a/model-a"),
        content: [{ type: "text", text: "(no content)" }],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("removes a whitespace-only assistant exposed by stripping and merges adjacent users", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "first" },
      assistantWithReasoning(
        [reasoning("signed", { signature: "sig_1" }), { type: "text", text: "  \n" }],
        modelIdentity("provider-a/model-a"),
      ),
      { role: "user", content: "second" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/model-b"))).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first\n" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("does not merge a tool-result user carrier after removing a whitespace assistant", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: "tool result",
        toolCallId: "call_1",
        toolName: "Read",
      },
      { role: "assistant", content: [{ type: "text", text: " " }] },
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      {
        role: "user",
        content: "tool result",
        toolCallId: "call_1",
        toolName: "Read",
      },
      { role: "user", content: "next" },
    ]);
  });

  it("does not merge into a later tool-result user carrier", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: " " }] },
      {
        role: "user",
        content: "tool result",
        toolCallId: "call_1",
        toolName: "Read",
      },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      { role: "user", content: "first" },
      {
        role: "user",
        content: "tool result",
        toolCallId: "call_1",
        toolName: "Read",
      },
    ]);
  });

  it.each([
    {
      expected: { type: "ephemeral" as const },
      first: { type: "ephemeral" as const, ttl: "1h" as const },
      name: "prefers the later user cache control",
      second: { type: "ephemeral" as const },
    },
    {
      expected: { type: "ephemeral" as const, ttl: "1h" as const },
      first: { type: "ephemeral" as const, ttl: "1h" as const },
      name: "falls back to the earlier user cache control",
      second: undefined,
    },
  ])("$name when whitespace cleanup merges users", ({ expected, first, second }) => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "first", cacheControl: first },
      { role: "assistant", content: [{ type: "text", text: " " }] },
      {
        role: "user",
        content: "second",
        ...(second ? { cacheControl: second } : {}),
      },
    ];

    const normalized = normalizeReasoningHistory(messages);

    expect(normalized).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first\n" },
          { type: "text", text: "second" },
        ],
        cacheControl: expected,
      },
    ]);
    expect(normalized[0]?.cacheControl).not.toBe(first);
    if (second) expect(normalized[0]?.cacheControl).not.toBe(second);
  });

  it("preserves mixed string and block user content without inventing a text separator", () => {
    const image = {
      type: "image" as const,
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      mediaType: "image/png",
    };
    const messages: ModelInputMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: " " }] },
      { role: "user", content: [image] },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "first" }, image],
      },
    ]);
  });

  it("does not infer a model mismatch when assistant provenance is missing", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [reasoning("signed", { signature: "sig_1" }), { type: "text", text: "answer" }],
      },
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/model-b"))).toBe(messages);
  });

  it("removes orphan reasoning-only assistant messages", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [reasoning("orphan")] },
      { role: "user", content: "second" },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
  });

  it("removes a final reasoning-only assistant before trailing cleanup", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: [reasoning("orphan")] },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([{ role: "user", content: "question" }]);
  });

  it("removes only the final assistant's consecutive trailing reasoning", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          reasoning("kept"),
          { type: "text", text: "answer" },
          reasoning("trailing one"),
          reasoning("trailing two"),
        ],
      },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [reasoning("kept"), { type: "text", text: "answer" }],
      },
    ]);
  });

  it("keeps tool calls when trailing reasoning leaves assistant content empty", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [reasoning("trailing")],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
    ]);
  });

  it("does not mutate canonical history and preserves the original reference when unchanged", () => {
    const messages: ModelInputMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ];
    const snapshot = structuredClone(messages);

    expect(normalizeReasoningHistory(messages)).toBe(messages);
    expect(messages).toEqual(snapshot);
  });

  it("removes only signed and redacted reasoning after a signature rejection", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          reasoning("redacted", { redactedData: "redacted_1" }),
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
    ];
    const snapshot = structuredClone(messages);

    expect(removeRejectedReasoning(messages)).toEqual([
      {
        role: "assistant",
        content: [reasoning("unsigned"), { type: "text", text: "answer" }],
      },
      { role: "user", content: "next" },
    ]);
    expect(messages).toEqual(snapshot);
    expect(
      removeRejectedReasoning([
        { role: "assistant", content: [reasoning("unsigned"), { type: "text", text: "answer" }] },
        { role: "user", content: "next" },
      ]),
    ).toEqual([
      { role: "assistant", content: [reasoning("unsigned"), { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ]);
  });

  it("adds the [Thinking removed] placeholder when only unsigned reasoning remains", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          { type: "text", text: "  " },
        ],
      },
      { role: "user", content: "next" },
    ];

    expect(removeRejectedReasoning(messages)).toEqual([
      {
        role: "assistant",
        content: [reasoning("unsigned"), { type: "text", text: "[Thinking removed]" }],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("does not add a rejection placeholder when a tool call remains", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [reasoning("signed", { signature: "sig_1" }), { type: "text", text: " " }],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
      { role: "user", content: "next" },
    ];

    expect(removeRejectedReasoning(messages)).toEqual([
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
      { role: "user", content: "next" },
    ]);
  });
});

describe("thinking signature rejection", () => {
  it.each([
    "signature in thinking block is invalid",
    "thinking block cannot be modified",
    "`thinking` has an invalid signature",
    "redacted_thinking cannot be modified",
  ])("accepts the supported HTTP 400 message: %s", (message) => {
    expect(isThinkingSignatureRejection(apiError(message, 400))).toBe(true);
  });

  it.each([
    apiError("signature in thinking block is invalid", 500),
    apiError("unrelated invalid request", 400),
    apiError("thinking budget is invalid", 400),
  ])("rejects unrelated errors", (error) => {
    expect(isThinkingSignatureRejection(error)).toBe(false);
  });
});

function assistantWithReasoning(
  content: Extract<ModelInputMessage["content"], unknown[]>,
  model: Pick<ModelInputMessage, "providerId" | "modelId">,
): ModelInputMessage {
  return { role: "assistant", content, ...model };
}

function modelIdentity(input: string): Pick<ModelInputMessage, "providerId" | "modelId"> {
  const separator = input.indexOf("/");
  return {
    providerId: input.slice(0, separator) as never,
    modelId: input.slice(separator + 1) as never,
  };
}

function reasoning(
  text: string,
  anthropic?: Record<string, unknown>,
): Extract<ModelInputMessage["content"], unknown[]>[number] {
  return {
    type: "reasoning",
    text,
    ...(anthropic ? { providerOptions: { anthropic } } : {}),
  };
}

function apiError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

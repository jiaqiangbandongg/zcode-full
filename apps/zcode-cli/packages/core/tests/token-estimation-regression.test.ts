import { describe, expect, it } from "vitest";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import { estimateMessageTokens, shouldAutoCompact } from "../src/compact/index.js";
import { estimateTokens } from "../src/context/utils.js";
import { buildPostCompactReadStateReminderEntries } from "../src/runtime/helpers/compact-post-reminders.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

describe("token estimation regression", () => {
  it("uses the shared three-character divisor for text and model messages", () => {
    const text = "x".repeat(10);

    expect(ESTIMATED_TOKEN_CHAR_DIVISOR).toBe(3);
    expect(estimateTokens(text)).toBe(4);
    expect(estimateMessageTokens([{ role: "user", content: text }])).toBe(4);
  });

  it("counts each tool call name and serialized input without counting its id", () => {
    const content = "assistant text";
    const toolCalls = [
      {
        id: "tool-id-must-not-be-counted-" + "x".repeat(120),
        name: "Read",
        input: {
          file_path: "/tmp/" + "nested/".repeat(12) + "large-input.txt",
          limit: 2_000,
        },
      },
      {
        id: "undefined-input",
        name: "Bash",
        input: undefined,
      },
    ];
    const estimatedCharacters =
      content.length +
      toolCalls.reduce(
        (total, toolCall) =>
          total + (toolCall.name + JSON.stringify(toolCall.input ?? {})).length,
        0,
      );

    expect(
      estimateMessageTokens([
        {
          role: "assistant",
          content,
          toolCalls,
        },
      ]),
    ).toBe(Math.ceil(estimatedCharacters / ESTIMATED_TOKEN_CHAR_DIVISOR));
  });

  it("falls back to an empty object for non-JSON-safe tool call inputs", () => {
    const circularInput: Record<string, unknown> = {};
    circularInput.self = circularInput;
    const toolCalls = [
      { id: "bigint-input", name: "BigIntTool", input: 1n },
      { id: "circular-input", name: "CircularTool", input: circularInput },
    ];
    const estimatedCharacters = toolCalls.reduce(
      (total, toolCall) => total + `${toolCall.name}{}`.length,
      0,
    );

    expect(
      estimateMessageTokens([
        {
          role: "assistant",
          content: "",
          toolCalls,
        },
      ]),
    ).toBe(Math.ceil(estimatedCharacters / ESTIMATED_TOKEN_CHAR_DIVISOR));
  });

  it("uses tool call inputs in local auto-compact decisions", () => {
    const toolCall = {
      name: "Bash",
      input: { command: "x".repeat(300) },
    };
    const messages = [
      { role: "user", content: "old context" },
      { role: "assistant", content: "", toolCalls: [toolCall] },
    ];
    const estimatedTokenCount =
      Math.ceil(messages[0]!.content.length / ESTIMATED_TOKEN_CHAR_DIVISOR) +
      Math.ceil(
        (toolCall.name + JSON.stringify(toolCall.input)).length /
          ESTIMATED_TOKEN_CHAR_DIVISOR,
      );

    expect(
      shouldAutoCompact({
        config: {
          bufferTokens: 100,
          contextWindow: 200,
          maxOutputTokens: 1,
        },
        messages,
      }),
    ).toMatchObject({
      estimatedTokenCount,
      reason: "above_threshold",
      shouldCompact: true,
      tokenCount: estimatedTokenCount,
      tokenSource: "estimate",
    });
  });

  it("uses the shared divisor when deciding whether to inline post-compact read content", () => {
    const filePath = "/tmp/zcode-compact-three-char-divisor.txt";
    const content = "x".repeat(31);
    const readFileState: ReadFileStateMap = new Map();
    readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
      content,
      isPartialView: false,
      path: filePath,
      readAt: new Date(5_000),
    });

    const reminderText = JSON.stringify(
      buildPostCompactReadStateReminderEntries({
        maxFileApproxTokens: 10,
        readFileState,
      }),
    );

    expect(reminderText).toContain(`Note: ${filePath} was read before`);
    expect(reminderText).not.toContain(content);
  });
});

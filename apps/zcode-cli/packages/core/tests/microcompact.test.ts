import { describe, expect, it } from "vitest";
import { MicrocompactTrigger } from "@zcode/contracts";
import { maybeLocalMicrocompactMessages } from "../src/compact/index.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  estimateRuntimeEntryTokens,
  getTrailingRuntimeUserEntries,
  maybeLocalMicrocompactRuntimeEntries,
} from "../src/runtime/helpers/compact.js";

describe("local microcompact", () => {
  it("counts reasoning consistently in runtime-entry estimates", () => {
    expect(
      estimateRuntimeEntryTokens([
        {
          message: {
            role: "assistant",
            content: [{ type: "reasoning", text: "r".repeat(40) }],
          },
        },
      ]),
    ).toBe(14);
  });

  it("uses reasoning pressure when deciding whether to clear old tool results", () => {
    const result = maybeLocalMicrocompactMessages({
      config: {
        enabled: true,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 500,
      },
      messages: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "r".repeat(2_000) }],
          toolCalls: [{ id: "read-old", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "old result ".repeat(10),
          toolCallId: "read-old",
          toolName: "Read",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-latest", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "latest result ".repeat(10),
          toolCallId: "read-latest",
          toolName: "Read",
        },
      ],
    });

    expect(result.payload).toMatchObject({
      clearedToolCallIds: ["read-old"],
      keptToolCallIds: ["read-latest"],
      trigger: MicrocompactTrigger.TokenPressure,
    });
  });

  it("clears old tool results by token pressure by default", () => {
    const result = maybeLocalMicrocompactMessages({
      config: {
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-old", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "old-read-token ".repeat(120),
          toolCallId: "read-old",
          toolName: "Read",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-latest", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "latest-read-token ".repeat(40),
          toolCallId: "read-latest",
          toolName: "Read",
        },
      ],
    });

    expect(result.payload).toMatchObject({
      clearedToolCallIds: ["read-old"],
      keptToolCallIds: ["read-latest"],
      trigger: MicrocompactTrigger.TokenPressure,
    });
    expect(String(result.messages[1]?.content)).toBe("[Old tool result content cleared]");
    expect(String(result.messages[3]?.content)).toContain("latest-read-token");
  });

  it("clears old tool results after the idle threshold by default", () => {
    const result = maybeLocalMicrocompactMessages({
      config: {
        idleThresholdMinutes: 60,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 999_999,
      },
      lastAssistantCompletedAtMs: 0,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-old", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "old-read-token ".repeat(120),
          toolCallId: "read-old",
          toolName: "Read",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-latest", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "latest-read-token ".repeat(40),
          toolCallId: "read-latest",
          toolName: "Read",
        },
      ],
      nowMs: 61 * 60_000,
    });

    expect(result.payload).toMatchObject({
      clearedToolCallIds: ["read-old"],
      keptToolCallIds: ["read-latest"],
      trigger: MicrocompactTrigger.TimeBased,
    });
    expect(String(result.messages[1]?.content)).toBe("[Old tool result content cleared]");
    expect(String(result.messages[3]?.content)).toContain("latest-read-token");
  });

  it("does not clear tool results below the token-pressure threshold", () => {
    const result = maybeLocalMicrocompactMessages({
      config: {
        enabled: true,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 999_999,
      },
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-old", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "old-read-token ".repeat(120),
          toolCallId: "read-old",
          toolName: "Read",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-latest", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "latest-read-token ".repeat(40),
          toolCallId: "read-latest",
          toolName: "Read",
        },
      ],
    });

    expect(result.payload).toBeUndefined();
    expect(result.decision.reason).toBe("not_triggered");
    expect(String(result.messages[1]?.content)).toContain("old-read-token");
    expect(String(result.messages[3]?.content)).toContain("latest-read-token");
  });

  it("uses the provider-visible cleared marker and keeps the latest tool-result group", () => {
    const result = maybeLocalMicrocompactMessages({
      config: {
        enabled: true,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-old", name: "Read", input: {} }],
        },
        {
          role: "tool",
          content: "old-read-token ".repeat(120),
          toolCallId: "read-old",
          toolName: "Read",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "read-latest-a", name: "Read", input: {} },
            { id: "read-latest-b", name: "Read", input: {} },
          ],
        },
        {
          role: "tool",
          content: "latest-a-token ".repeat(40),
          toolCallId: "read-latest-a",
          toolName: "Read",
        },
        {
          role: "tool",
          content: "latest-b-token ".repeat(40),
          toolCallId: "read-latest-b",
          toolName: "Read",
        },
      ],
    });

    expect(result.payload).toMatchObject({
      clearedToolCallIds: ["read-old"],
      keptToolCallIds: ["read-latest-a", "read-latest-b"],
      trigger: MicrocompactTrigger.TokenPressure,
    });
    expect(String(result.messages[1]?.content)).toBe("[Old tool result content cleared]");
    expect(String(result.messages[1]?.content)).not.toContain("by microcompact");
    expect(String(result.messages[1]?.content)).not.toContain("tool=");
    expect(String(result.messages[1]?.content)).not.toContain("call=");
    expect(String(result.messages[3]?.content)).toContain("latest-a-token");
    expect(String(result.messages[4]?.content)).toContain("latest-b-token");
  });

  it("does not clear image, video, or file tool result content", () => {
    const mediaContent = [
      { type: "text" as const, text: "old media result" },
      {
        type: "image" as const,
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
      {
        type: "video" as const,
        mediaType: "video/mp4",
        dataUrl: "data:video/mp4;base64,dmlkZW8=",
      },
      {
        type: "file" as const,
        mediaType: "application/pdf",
        dataUrl: "data:application/pdf;base64,cGRm",
      },
    ];
    const result = maybeLocalMicrocompactMessages({
      config: {
        enabled: true,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      messages: [
        {
          role: "tool",
          content: mediaContent,
          toolCallId: "media-old",
          toolName: "Read",
        },
        {
          role: "tool",
          content: "latest-output ".repeat(120),
          toolCallId: "latest",
          toolName: "Read",
        },
      ],
    });

    expect(result.payload).toBeUndefined();
    expect(result.decision.reason).toBe("nothing_to_clear");
    expect(result.messages[0]?.content).toEqual(mediaContent);
  });

  it("keeps error results by default", () => {
    const result = maybeLocalMicrocompactMessages({
      config: {
        enabled: true,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      messages: [
        {
          role: "tool",
          content: "error-output ".repeat(120),
          isError: true,
          toolCallId: "bash-error",
          toolName: "Bash",
        },
        {
          role: "tool",
          content: "success-output ".repeat(120),
          toolCallId: "bash-success",
          toolName: "Bash",
        },
      ],
    });

    expect(result.payload).toBeUndefined();
    expect(result.decision.reason).toBe("nothing_to_clear");
    expect(String(result.messages[0]?.content)).toContain("error-output");
  });

  it("reuses readonly runtime entries when microcompact does not apply", () => {
    const entries = [
      {
        message: {
          role: "user",
          content: "prompt below the microcompact threshold",
        },
      },
    ] satisfies RuntimeMessageEntry[];

    const result = maybeLocalMicrocompactRuntimeEntries({
      config: {
        enabled: true,
        minTokenSavings: 1,
        thresholdTokens: 999_999,
      },
      entries,
    });

    expect(result.payload).toBeUndefined();
    expect(result.entries).toBe(entries);
  });

  it("keeps runtime attachment metadata while clearing old tool results", () => {
    const latestTokens = {
      input: 100,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 120,
    };
    const entries = [
      {
        kind: "attachment",
        content: "style body",
        metadata: { source: "output_style" },
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-old", name: "Read", input: {} }],
        },
      },
      {
        message: {
          role: "tool",
          content: "old-read-token ".repeat(120),
          toolCallId: "read-old",
          toolName: "Read",
        },
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-latest", name: "Read", input: {} }],
        },
        tokens: latestTokens,
      },
      {
        message: {
          role: "tool",
          content: "latest-read-token ".repeat(40),
          toolCallId: "read-latest",
          toolName: "Read",
        },
      },
    ] satisfies RuntimeMessageEntry[];
    const originalEntries = structuredClone(entries);
    const result = maybeLocalMicrocompactRuntimeEntries({
      config: {
        enabled: true,
        keepRecentToolResults: 1,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      entries,
    });

    expect(result.payload).toMatchObject({
      clearedToolCallIds: ["read-old"],
      keptToolCallIds: ["read-latest"],
      trigger: MicrocompactTrigger.TokenPressure,
    });
    expect(result.entries[0]).toEqual({
      kind: "attachment",
      content: "style body",
      metadata: { source: "output_style" },
    });
    expect(result.entries[2]).toMatchObject({
      message: {
        role: "tool",
        toolCallId: "read-old",
        toolName: "Read",
      },
    });
    expect(String(result.entries[2]?.message.content)).toBe("[Old tool result content cleared]");
    expect(String(result.entries[2]?.message.content)).not.toContain("old-read-token");
    expect(entries).toEqual(originalEntries);
    expect(result.entries[0]).toBe(entries[0]);
    expect(result.entries[1]).toBe(entries[1]);
    expect(result.entries[2]).not.toBe(entries[2]);
    expect(result.entries[3]).toBe(entries[3]);
    expect(result.entries[4]).toBe(entries[4]);
    expect(result.entries[3]?.tokens).toEqual(latestTokens);
  });

  it("handles trailing runtime attachments as user-like entries", () => {
    const result = getTrailingRuntimeUserEntries([
      {
        message: {
          role: "assistant",
          content: "previous answer",
        },
      },
      {
        kind: "attachment",
        content: "<task-notification />",
        metadata: { source: "task_status" },
      },
    ]);

    expect(result).toEqual([
      {
        kind: "attachment",
        content: "<task-notification />",
        metadata: { source: "task_status" },
      },
    ]);
  });
});

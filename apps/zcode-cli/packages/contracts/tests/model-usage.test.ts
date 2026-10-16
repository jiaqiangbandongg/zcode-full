import { describe, expect, it } from "vitest";

import {
  SessionEventType,
  createModelUsageSummary,
  createModelUsageSummaryFromEvents,
  createSessionEvent,
  getModelUsageContextTokens,
  getModelUsageInputWindowTokens,
  getModelUsageTotalTokens,
  modelMessageContentToText,
} from "../src/index.js";
import type { SessionId, TraceId } from "../src/index.js";

describe("model usage contracts", () => {
  it("summarizes provider usage without double-counting cache breakdowns", () => {
    const summary = createModelUsageSummary([
      {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        reasoningTokens: 5,
      },
      {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    ]);

    expect(summary).toEqual({
      source: "provider",
      modelRequestCount: 2,
      inputTokens: 130,
      outputTokens: 34,
      totalTokens: 164,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      reasoningTokens: 5,
      webFetchRequests: 0,
      webSearchRequests: 0,
    });
  });

  it("summarizes provider-native server tool usage", () => {
    const summary = createModelUsageSummary([
      {
        inputTokens: 12,
        outputTokens: 8,
        serverToolUse: { webSearchRequests: 2 },
      },
      {
        serverToolUse: { webFetchRequests: 1 },
      },
    ]);

    expect(summary).toEqual({
      source: "provider",
      modelRequestCount: 2,
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webFetchRequests: 1,
      webSearchRequests: 2,
    });
  });

  it("falls back to cache fields only when input tokens are absent", () => {
    expect(
      getModelUsageTotalTokens({
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      }),
    ).toBe(15);
  });

  it("computes context usage without double-counting cache breakdowns", () => {
    expect(
      getModelUsageContextTokens({
        inputTokens: 137_154,
        outputTokens: 56,
        totalTokens: 137_210,
        cacheReadTokens: 136_896,
      }),
    ).toBe(137_210);
    expect(getModelUsageContextTokens({ inputTokens: 10, outputTokens: 4 })).toBe(14);
    expect(getModelUsageContextTokens({ totalTokens: 10, cacheReadTokens: 4 })).toBe(10);
  });

  it("uses normalized total input as input window tokens", () => {
    expect(
      getModelUsageInputWindowTokens({
        inputTokens: 137_154,
        outputTokens: 56,
        totalTokens: 137_210,
        cacheReadTokens: 136_896,
      }),
    ).toBe(137_154);
    expect(getModelUsageInputWindowTokens({ outputTokens: 3, cacheReadTokens: 5 })).toBe(5);
  });

  it("collects model usage from model_complete events", () => {
    const sessionId = "session-usage" as SessionId;
    const traceId = "trace-usage" as TraceId;
    const summary = createModelUsageSummaryFromEvents([
      createSessionEvent(
        SessionEventType.ModelComplete,
        sessionId,
        {
          content: "first",
          stopReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
        { traceId },
      ),
      createSessionEvent(
        SessionEventType.ModelComplete,
        sessionId,
        {
          content: "second",
          stopReason: "stop",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        },
        { traceId },
      ),
    ]);

    expect(summary?.modelRequestCount).toBe(2);
    expect(summary?.totalTokens).toBe(37);
  });

  it("converts structured model message content to stable text placeholders", () => {
    expect(
      modelMessageContentToText([
        { type: "text", text: "hello" },
        {
          type: "image",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
          source: { id: "image-1", kind: "inline", placeholder: "[Image 1]" },
        },
        { type: "resource_link", uri: "file://README.md", title: "README" },
      ]),
    ).toBe("hello\n\n[Attached image/png: [Image 1]]\n\n[Resource: README]");
  });
});

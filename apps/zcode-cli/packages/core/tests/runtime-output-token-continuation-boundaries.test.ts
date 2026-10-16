import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  countContinuePrompts,
  createRuntime,
  outputLimitResult,
  registerReadOnlyTool,
  requestText,
  stopResult,
} from "./runtime-output-token-continuation-test-helpers.js";

describe("AgentRuntime output-token continuation boundaries", () => {
  it("lets a complete non-streaming tool call take precedence over length", async () => {
    const registry = createToolRegistry();
    const requests: any[] = [];
    registerReadOnlyTool(registry, "ReadOnly", "tool result");
    const runtime = createRuntime({
      id: "output-token-tool-precedence",
      config: { mode: "yolo" },
      deps: { toolRegistry: registry },
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          if (requests.length === 1) {
            return {
              ...outputLimitResult({ text: "partial" }),
              toolCalls: [{ id: "read-1", name: "ReadOnly", input: {} }],
            };
          }
          return stopResult("done", 2);
        },
      } as never,
    });

    const result = await runtime.executeTurn("use tool");

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => countContinuePrompts(request.messages) === 0)).toBe(true);
  });

  it("lets a complete streaming tool call take precedence over length", async () => {
    const registry = createToolRegistry();
    let callCount = 0;
    const requests: any[] = [];
    registerReadOnlyTool(registry, "StreamRead", "stream tool result");
    const runtime = createRuntime({
      id: "output-token-stream-tool-precedence",
      config: { mode: "yolo", modelStreaming: "on" },
      deps: { toolRegistry: registry },
      modelAdapter: {
        async generateText() {
          throw new Error("streaming path expected");
        },
        async *streamText(request: any) {
          requests.push(request);
          callCount += 1;
          if (callCount === 1) {
            yield {
              type: "tool_call",
              toolCall: { id: "stream-read-1", name: "StreamRead", input: {} },
            };
            yield { type: "finish", finishReason: "length", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          };
        },
      } as never,
    });

    const result = await runtime.executeTurn("use streaming tool");

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => countContinuePrompts(request.messages) === 0)).toBe(true);
  });

  // 行为回归（非 Bug）：成功的超窗 stop reason 即使内容全空也续写三次。
  // 原实现 6e7ef0d617 已覆盖此分支；同时保留 other/length，防止归一化方式改变恢复语义。
  it.each([
    { finishReason: "other", rawFinishReason: "max_output_tokens" },
    { finishReason: "other", rawFinishReason: "model_context_window_exceeded" },
    { finishReason: "length", rawFinishReason: "model_context_window_exceeded" },
  ])(
    "continues three empty $finishReason / $rawFinishReason responses",
    async ({ finishReason, rawFinishReason }) => {
      const requests: any[] = [];
      const runtime = createRuntime({
        id: "output-token-context-finish",
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            if (requests.length <= 3) {
              return {
                finishReason,
                providerMetadata: { rawFinishReason },
                text: "",
                usage: {},
              };
            }
            return stopResult("done", 2);
          },
        } as never,
      });

      const result = await runtime.executeTurn("start");

      expect(result.response).toBe("done");
      expect(requests).toHaveLength(4);
      expect(requests.map((request) => countContinuePrompts(request.messages))).toEqual([
        0, 1, 2, 3,
      ]);
    },
  );

  // 与原实现的耗尽边界一致：不发送第五个请求，不把成功 stop reason 改判为 Reactive Compact。
  it.each(["other", "length"])(
    "exhausts empty context-window finish responses normalized as %s",
    async (finishReason) => {
      const requests: any[] = [];
      const runtime = createRuntime({
        id: "output-token-context-finish-exhausted",
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason,
              providerMetadata: { rawFinishReason: "model_context_window_exceeded" },
              text: "",
              usage: {},
            };
          },
        } as never,
      });

      await expect(runtime.executeTurn("start")).rejects.toMatchObject({
        message: "The model's response exceeded the output token maximum.",
        type: "model_error",
      });
      expect(requests).toHaveLength(4);
      expect(requests.map((request) => countContinuePrompts(request.messages))).toEqual([
        0, 1, 2, 3,
      ]);
    },
  );

  it.each(["max_output_tokens", "model_context_window_exceeded"])(
    "lets a provider-executed tool call take precedence over %s",
    async (rawFinishReason) => {
      const requests: any[] = [];
      const runtime = createRuntime({
        id: "output-token-provider-tool",
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "other",
              providerMetadata: { rawFinishReason },
              text: "provider tool completed",
              toolCalls: [
                {
                  id: "provider-tool-1",
                  input: {},
                  name: "web_search",
                  providerExecuted: true,
                },
              ],
              usage: {},
            };
          },
        } as never,
      });

      const result = await runtime.executeTurn("search");

      expect(result.response).toBe("provider tool completed");
      expect(requests).toHaveLength(1);
      expect(requestText(requests[0]!.messages)).not.toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    },
  );

  it("defers an inline guide until recovery completes", async () => {
    const requests: string[] = [];
    let runtime!: AgentRuntime;
    runtime = createRuntime({
      id: "output-token-atomic-recovery",
      modelAdapter: {
        async generateText(request: any) {
          requests.push(requestText(request.messages));
          if (requests.length === 1) {
            await runtime.steerTurn({ delivery: "guide", input: "guide after recovery" });
            return { finishReason: "length", text: "A", usage: {} };
          }
          if (requests.length === 2) {
            return stopResult("B", 5);
          }
          return stopResult("done", 7);
        },
      } as never,
    });

    const result = await runtime.executeTurn("start");

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(requests[1]).not.toContain("guide after recovery");
    expect(requests[2]).toContain("guide after recovery");
  });

  it("defers memory updates and runtime notices until a normal tool boundary", async () => {
    const registry = createToolRegistry();
    registerReadOnlyTool(registry, "RecoveryBoundary", "tool done");
    const requests: string[] = [];
    let runtime!: AgentRuntime;
    runtime = createRuntime({
      id: "output-token-deferred-notices",
      config: { mode: "yolo" },
      deps: { toolRegistry: registry },
      modelAdapter: {
        async generateText(request: any) {
          requests.push(requestText(request.messages));
          if (requests.length === 1) {
            (runtime as any).pendingMemoryUpdate = {
              inContextPaths: [],
              paths: ["/memory/fact.md"],
              source: "dream",
              summary: "memory after recovery",
            };
            (runtime as any).enqueueSubagentMessage({
              agentId: "agent-output-recovery",
              agentType: "general-purpose",
              childSessionId: createSessionId("child-output-recovery"),
              childToolCallId: "child-call-output-recovery",
              message: "notice after recovery",
              responseId: "response-output-recovery",
              summary: "notice summary",
              traceContext: (runtime as any).rootTraceContext,
            });
            return { finishReason: "length", text: "A", usage: {} };
          }
          if (requests.length === 2) {
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [{ id: "recovery-boundary", input: {}, name: "RecoveryBoundary" }],
              usage: {},
            };
          }
          return stopResult("done", 7);
        },
      } as never,
    });

    const result = await runtime.executeTurn("start");

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(requests[1]).not.toContain("memory after recovery");
    expect(requests[1]).not.toContain("notice after recovery");
    expect(requests[2]).toContain("memory after recovery");
    expect(requests[2]).toContain("notice after recovery");
  });
});

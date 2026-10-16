import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputInputJsonSchema,
  TaskOutputResultJsonSchema,
  type ModelToolContract,
} from "@zcode/contracts";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

const taskOutputContent = [
  "<retrieval_status>success</retrieval_status>",
  "<task_id>agent_1</task_id>",
  "<task_type>local_agent</task_type>",
  "<status>completed</status>",
  "<output>\nanswer <raw>&\n</output>",
].join("\n\n");
const unknownTaskContent = "<tool_use_error>No task found with ID: missing</tool_use_error>";

describe("TaskOutput provider wire projection", () => {
  it("sends the exact Anthropic tool definition and tool_result text", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = createAnthropic({
      apiKey: "fake-ak",
      baseURL: "https://api.example.test",
      fetch: async (_input, init) => {
        capturedBody = parseRequestBody(init);
        return new Response(
          JSON.stringify({
            content: [{ text: "ok", type: "text" }],
            id: "msg_task_output",
            model: "test-model",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    await generateText(
      createGenerateTextOptions({
        includeModelIO: false,
        request: taskOutputRequest(),
        resolved: {
          properties: createTestModelProperties(),
          baseURL: "https://api.example.test",
          model: provider("test-model"),
          providerKind: "anthropic",
          providerId: "test-anthropic",
          modelId: "test-model",
        } as ResolvedAiSdkModel,
        statusContext: {
          providerId: "test-anthropic",
          modelId: "test-model",
          providerKind: "anthropic",
          requestId: "req_task_output_anthropic",
          sessionId: "sess_task_output_anthropic",
          traceId: "trace_task_output_anthropic",
        } as never,
      }),
    );

    expect(capturedBody?.tools).toEqual([
      {
        name: TASK_OUTPUT_TOOL_NAME,
        description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
        input_schema: TaskOutputInputJsonSchema,
      },
    ]);
    expect(capturedBody?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "start the task" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_task_output",
            name: TASK_OUTPUT_TOOL_NAME,
            input: { task_id: "agent_1", block: false },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_task_output",
            content: taskOutputContent,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_task_output_missing",
            name: TASK_OUTPUT_TOOL_NAME,
            input: { task_id: "missing", block: false },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_task_output_missing",
            content: unknownTaskContent,
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("sends the exact OpenAI-compatible tool definition and tool result text", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      apiKey: "fake-ak",
      baseURL: "https://api.example.test/v1",
      name: "TaskOutput Compatible",
      fetch: async (_input, init) => {
        capturedBody = parseRequestBody(init);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "ok", role: "assistant" },
              },
            ],
            id: "chatcmpl-task-output",
            model: "test-model",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    await generateText(
      createGenerateTextOptions({
        includeModelIO: false,
        request: taskOutputRequest(),
        resolved: {
          properties: createTestModelProperties(),
          baseURL: "https://api.example.test/v1",
          model: provider("test-model"),
          providerKind: "openai-compatible",
          providerId: "test-compatible",
          modelId: "test-model",
        } as ResolvedAiSdkModel,
        statusContext: {
          providerId: "test-compatible",
          modelId: "test-model",
          providerKind: "openai-compatible",
          requestId: "req_task_output_compatible",
          sessionId: "sess_task_output_compatible",
          traceId: "trace_task_output_compatible",
        } as never,
      }),
    );

    expect(capturedBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: TASK_OUTPUT_TOOL_NAME,
          description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
          parameters: TaskOutputInputJsonSchema,
        },
      },
    ]);
    expect(capturedBody?.messages).toEqual([
      { role: "user", content: "start the task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tool_task_output",
            type: "function",
            function: {
              name: TASK_OUTPUT_TOOL_NAME,
              arguments: JSON.stringify({ task_id: "agent_1", block: false }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool_task_output",
        content: taskOutputContent,
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tool_task_output_missing",
            type: "function",
            function: {
              name: TASK_OUTPUT_TOOL_NAME,
              arguments: JSON.stringify({ task_id: "missing", block: false }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool_task_output_missing",
        content: unknownTaskContent,
      },
    ]);
  });
});

function taskOutputRequest() {
  return {
    messages: [
      { role: "user" as const, content: "start the task" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "tool_task_output",
            name: TASK_OUTPUT_TOOL_NAME,
            input: { task_id: "agent_1", block: false },
          },
        ],
      },
      {
        role: "tool" as const,
        content: taskOutputContent,
        toolCallId: "tool_task_output",
        toolName: TASK_OUTPUT_TOOL_NAME,
      },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "tool_task_output_missing",
            name: TASK_OUTPUT_TOOL_NAME,
            input: { task_id: "missing", block: false },
          },
        ],
      },
      {
        role: "tool" as const,
        content: unknownTaskContent,
        isError: true,
        toolCallId: "tool_task_output_missing",
        toolName: TASK_OUTPUT_TOOL_NAME,
      },
    ],
    tools: [taskOutputContract()],
  };
}

function taskOutputContract(): ModelToolContract {
  return {
    name: TASK_OUTPUT_TOOL_NAME,
    capability: "read output/logs from a background task",
    description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
    inputSchema: TaskOutputInputJsonSchema,
    outputSchema: TaskOutputResultJsonSchema,
    readOnly: true,
    concurrentSafe: true,
    needsApproval: false,
  };
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

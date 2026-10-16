import { readFile } from "node:fs/promises";
import { generateText } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createRegistryProviderConfig,
  createRegistryModelConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
  type ModelConfigRules,
} from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import { createStatusContext } from "../src/model/runner-status.js";
import type { AiSdkModelTextRequest } from "../src/model/runner-runtime.js";

let rules: ModelConfigRules;
beforeAll(async () => {
  const release = JSON.parse(
    await readFile(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
      "utf8",
    ),
  );
  rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
});
const baseUrl = "https://opencode.ai/zen/go/v1";
// 每种 Go 映射走正式 SDK / transport；只截获假 Key 请求，不消耗用户额度。
describe("Todo149 OpenCode Go 正式 SDK 请求", () => {
  it.each([
    ["glm-5.3", "openai-chat-completions", ["low", "high", "max"], "effort"],
    ["glm-5.3-flash", "openai-chat-completions", ["low", "high", "max"], "effort"],
    ["deepseek-v4-pro", "openai-chat-completions", ["high", "max"], "effort"],
    ["hy3", "openai-chat-completions", ["none", "low", "high"], "effort"],
    ["kimi-k2.7-code", "openai-chat-completions", ["enabled"], "fixed"],
    ["mimo-v2.5", "openai-chat-completions", ["enabled"], "fixed"],
    ["minimax-m3", "anthropic-messages", ["disabled", "enabled"], "adaptive"],
    ["minimax-m2.7", "anthropic-messages", ["enabled"], "fixed"],
    ["qwen3.7-max", "anthropic-messages", ["disabled", "enabled"], "toggle"],
    ["qwen3.8-max", "anthropic-messages", ["low", "medium", "xhigh"], "qwen-effort"],
    [
      "gpt-5.6-luna",
      "openai-responses",
      ["none", "low", "medium", "high", "xhigh", "max"],
      "responses",
    ],
    ["grok-4.6", "openai-responses", ["low", "medium", "high", "xhigh"], "responses"],
  ] as const)("%s/%s 不混发其他协议字段", async (modelId, apiType, levels, mode) => {
    const config = rules.resolve({ providerId: "go", modelId, apiType, baseUrl });
    const modelConfig = createRegistryModelConfig(config);
    const provider = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "E2E_GO_FAKE_KEY" },
        api: { type: apiType, baseUrl },
      }),
    );
    if (!provider.ok || !modelConfig.ok) throw new Error("Invalid Go fixture");
    const requests: Request[] = [];
    const execution = new AiSdkModelExecution(
      {
        env: {},
        defaultHeaders: { "User-Agent": "ZCode/3.12.1", "X-ZCode-App-Version": "3.12.1" },
      },
      {
        transport: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(
            { type: "error", error: { message: "E2E_GO_CAPTURED", type: "invalid_request_error" } },
            { status: 400 },
          );
        },
      },
    );
    const bound = execution.bindModel({
      providerId: "go",
      modelId,
      providerConfig: provider.config,
      supportsJsonSchemaOutput: false,
      optionSpecs: {
        reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
        maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
      },
    });
    for (const { reasoningLevel, maxOutputTokens } of levels.flatMap((reasoningLevel) =>
      [1, 4096].map((maxOutputTokens) => ({ reasoningLevel, maxOutputTokens })),
    )) {
      const resolved = bound.resolveRequest({ options: { reasoningLevel, maxOutputTokens } });
      const ready = { ...resolved, properties: modelConfig.config.properties };
      const requestInput: AiSdkModelTextRequest = {
        messages: [{ role: "user", content: "E2E_GO_CAPTURE" }],
        metadata: { sessionId: "go-wire-session", requestId: "go-wire-request" },
      };
      await expect(
        generateText(
          createGenerateTextOptions({
            includeModelIO: false,
            resolved: ready,
            request: requestInput,
            statusContext: createStatusContext({
              maxAttempts: 1,
              request: requestInput,
              resolved: ready,
              transport: "http",
            }),
          }),
        ),
      ).rejects.toThrow("E2E_GO_CAPTURED");
      const request = requests.at(-1)!;
      const body = await request.json();
      expect(request.url).toBe(
        `${baseUrl}/${apiType === "anthropic-messages" ? "messages" : apiType === "openai-responses" ? "responses" : "chat/completions"}`,
      );
      expect(request.headers.get("authorization")).toBe("Bearer E2E_GO_FAKE_KEY");
      expect(request.headers.get("user-agent")).toContain("ZCode/3.12.1");
      expect(request.headers.get("x-zcode-app-version")).toBe("3.12.1");
      expect(request.headers.get("x-session-id")).toBe("go-wire-session");
      expect(request.headers.get("x-opencode-session")).toBe("go-wire-session");
      expect(body.model).toBe(modelId);
      expect(body.enable_thinking).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body[mode === "responses" ? "max_output_tokens" : "max_tokens"]).toBe(maxOutputTokens);
      const reasoning = Object.fromEntries(
        ["reasoning_effort", "reasoning", "thinking", "output_config"]
          .filter((k) => k in body)
          .map((k) => [k, body[k]]),
      );
      expect(reasoning).toEqual(
        mode === "effort"
          ? { reasoning_effort: reasoningLevel }
          : mode === "responses"
            ? { reasoning: { effort: reasoningLevel } }
            : mode === "fixed"
              ? {}
              : mode === "qwen-effort"
                ? { thinking: { type: "enabled" }, output_config: { effort: reasoningLevel } }
                : {
                    thinking: {
                      type:
                        reasoningLevel === "disabled"
                          ? "disabled"
                          : mode === "adaptive"
                            ? "adaptive"
                            : "enabled",
                    },
                  },
      );
    }
    expect(requests).toHaveLength(levels.length * 2);
  });
  it.each([
    ["glm-5.3-flash", "openai-chat-completions", "low"],
    ["minimax-m3", "anthropic-messages", "enabled"],
    ["gpt-5.6-luna", "openai-responses", "low"],
  ] as const)(
    "%s 正式 SDK 可解析正文、工具调用与用量",
    async (modelId, apiType, reasoningLevel) => {
      const modelConfig = createRegistryModelConfig(
        rules.resolve({ providerId: "go", modelId, apiType, baseUrl }),
      );
      const provider = createRegistryProviderConfig(
        parseProviderConfig({
          group: "standard-personal",
          access: { type: "api-key", apiKey: "E2E_GO_FAKE_KEY" },
          api: { type: apiType, baseUrl },
        }),
      );
      if (!modelConfig.ok || !provider.ok) throw new Error("Invalid Go fixture");
      let body: Record<string, unknown> = {};
      const execution = new AiSdkModelExecution(
        { env: {} },
        {
          transport: async (input, init) => {
            body = await new Request(input, init).json();
            // synthetic：各协议按官方结构返回相同的正文、工具意图与非零用量，不调用真实工具。
            if (apiType === "anthropic-messages")
              return Response.json({
                id: "msg_go",
                type: "message",
                role: "assistant",
                model: modelId,
                content: [
                  { type: "text", text: "ok" },
                  { type: "tool_use", id: "call_go", name: "Read", input: { path: "README.md" } },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: { input_tokens: 7, output_tokens: 3 },
              });
            if (apiType === "openai-chat-completions")
              return Response.json({
                id: "chat_go",
                object: "chat.completion",
                created: 1,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "ok",
                      tool_calls: [
                        {
                          id: "call_go",
                          type: "function",
                          function: { name: "Read", arguments: '{"path":"README.md"}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
              });
            return Response.json({
              id: "resp_go",
              object: "response",
              created_at: 1,
              status: "completed",
              model: modelId,
              output: [
                {
                  id: "msg_go",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "ok", annotations: [] }],
                },
                {
                  id: "fc_go",
                  type: "function_call",
                  call_id: "call_go",
                  name: "Read",
                  arguments: '{"path":"README.md"}',
                  status: "completed",
                },
              ],
              usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
            });
          },
        },
      );
      const model = execution.bindModel({
        providerId: "go",
        modelId,
        providerConfig: provider.config,
        supportsJsonSchemaOutput: false,
        optionSpecs: modelConfig.config.optionSpecs,
      });
      const resolved = {
        ...model.resolveRequest({ options: { reasoningLevel, maxOutputTokens: 4096 } }),
        properties: modelConfig.config.properties,
      };
      const request: AiSdkModelTextRequest = {
        messages: [{ role: "user", content: "E2E_GO_TOOL" }],
        tools: [
          {
            name: "Read",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
      };
      const result = await generateText(
        createGenerateTextOptions({
          includeModelIO: false,
          request,
          resolved,
          statusContext: createStatusContext({
            maxAttempts: 1,
            request,
            resolved,
            transport: "http",
          }),
        }),
      );
      expect(body.model).toBe(modelId);
      expect(body.tools).toHaveLength(1);
      expect(result.text).toBe("ok");
      expect(result.toolCalls).toMatchObject([
        { toolCallId: "call_go", toolName: "Read", input: { path: "README.md" } },
      ]);
      expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    },
  );
});

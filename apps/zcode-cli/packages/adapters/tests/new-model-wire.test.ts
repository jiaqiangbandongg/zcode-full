import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";

describe("新目录通过真实 SDK 发出的请求", () => {
  for (const [modelId, apiType, baseUrl, levels] of [
    ["gpt-6-astra", "openai-responses", "https://api.openai.com/v1", ["low", "max"]],
    ["claude-fable-5-1", "anthropic-messages", "https://api.anthropic.com/v1", ["low", "max"]],
    // 厂商的无预算 enabled 不能穿透到 OpenRouter；验证最终 SDK wire 而非只编译 Map。
    ["z-ai/glm-5.3", "anthropic-messages", "https://openrouter.ai/api", ["low", "max"]],
    ["z-ai/glm-5.3-flash", "anthropic-messages", "https://openrouter.ai/api", ["high"]],
    [
      "deepseek/deepseek-v4.1-flash",
      "anthropic-messages",
      "https://openrouter.ai/api",
      ["disabled", "max"],
    ],
    ["moonshotai/kimi-k2.5", "anthropic-messages", "https://openrouter.ai/api", ["enabled"]],
    ["qwen/qwen3.8-max-0902", "anthropic-messages", "https://openrouter.ai/api", ["minimal"]],
    ["xiaomi/mimo-v2.5", "anthropic-messages", "https://openrouter.ai/api", ["enabled"]],
    [
      "deepseek-flash",
      "anthropic-messages",
      "https://api.deepseek.com/anthropic",
      ["disabled", "low", "high", "max"],
    ],
    [
      "deepseek-flash",
      "openai-chat-completions",
      "https://api.deepseek.com/v1",
      ["disabled", "low", "high", "max"],
    ],
    [
      "deepseek-flash",
      "openai-responses",
      "https://api.deepseek.com/v1",
      ["disabled", "low", "high", "max"],
    ],
  ] as const)
    for (const level of levels)
      it(`${modelId} / ${apiType} / ${level}`, async () => {
        const release = JSON.parse(
          await readFile(
            new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
            "utf8",
          ),
        );
        const config = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules).resolve({
          providerId: "fixture",
          modelId,
          apiType,
          baseUrl,
        });
        const modelConfig = createRegistryModelConfig(config);
        const providerConfig = createRegistryProviderConfig(
          parseProviderConfig({
            group: "standard-personal",
            access: { type: "api-key", apiKey: "fixture" },
            api: { type: apiType, baseUrl },
          }),
        );
        if (!modelConfig.ok || !providerConfig.ok) throw new Error("incomplete fixture");
        let body: Record<string, unknown> | undefined;
        vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(url, init);
          body = await request.json();
          if (apiType === "anthropic-messages")
            return Response.json({
              id: "fixture",
              type: "message",
              role: "assistant",
              model: modelId,
              content: [
                { type: "text", text: modelId.startsWith("claude") ? '{"ok":true}' : "ok" },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          if (apiType === "openai-chat-completions")
            return Response.json({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: modelId,
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          return Response.json({
            id: "resp_fixture",
            object: "response",
            created_at: 1,
            status: "completed",
            model: modelId,
            output: [
              {
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        });
        try {
          const model = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }).createModel({
            providerId: createModelProviderId("fixture"),
            modelId: createModelId(modelId),
            providerConfig: providerConfig.config,
            modelConfig: modelConfig.config,
            options: { maxOutputTokens: 4000, reasoningLevel: level },
          });
          await model.generateText({
            messages: [{ role: "user", content: "hi" }],
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
            ...(modelId.startsWith("claude")
              ? {
                  responseJsonSchema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                    additionalProperties: false,
                  },
                }
              : {}),
          });
          expect(body?.model).toBe(modelId);
          if (apiType === "openai-responses") {
            expect(body).toMatchObject({
              reasoning: { effort: level === "disabled" ? "none" : level },
            });
            expect(body?.max_output_tokens).toBe(4000);
          } else {
            expect(body).toMatchObject({
              thinking: {
                type:
                  level === "disabled"
                    ? "disabled"
                    : modelId.startsWith("claude") || baseUrl === "https://openrouter.ai/api"
                      ? "adaptive"
                      : "enabled",
              },
            });
            if (level !== "disabled")
              expect(body).toMatchObject(
                apiType === "anthropic-messages"
                  ? { output_config: { effort: level === "enabled" ? "high" : level } }
                  : { reasoning_effort: level },
              );
            if (modelId.startsWith("claude")) {
              expect(body).toMatchObject({
                tool_choice: { type: "auto" },
                output_config: { format: { type: "json_schema" } },
              });
            }
            if (baseUrl === "https://openrouter.ai/api") {
              expect(body?.thinking).not.toHaveProperty("budget_tokens");
              expect(body?.max_tokens).toBe(4000);
            }
          }
        } finally {
          vi.unstubAllGlobals();
        }
      });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  WEBSEARCH_PROVIDER_NATIVE_SPEC,
  WEBSEARCH_TOOL_CONTRACT,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { buildProviderRequestMessages } from "../../core/src/runtime/helpers/provider-request-messages.js";
import { AiSdkModelAdapter } from "../src/model/runner.js";

describe("Published MCS and search final Anthropic wire", () => {
  it.each([
    [
      "account:zai-start-plan",
      "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      "GLM-5.3-Flash",
      true,
      true,
    ],
    [
      "account:bigmodel-start-plan",
      "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      "GLM-5.3-Flash",
      true,
      true,
    ],
    [
      "account:zai-offpeak-idle-plan",
      "https://zcode.z.ai/api/v1/off-peak/anthropic",
      "GLM-5.3-Flash",
      true,
      true,
    ],
    [
      "account:bigmodel-offpeak-idle-plan",
      "https://zcode.z.ai/api/v1/off-peak/anthropic",
      "GLM-5.3-Flash",
      true,
      true,
    ],
    ["fixture", "https://api.anthropic.com/v1", "claude-sonnet-5", false, true],
    ["fixture", "https://proxy.invalid/v1", "vendor/claude-opus-4-8", true, false],
    ["personal-off", "https://proxy.invalid/v1", "vendor/claude-opus-4-8", false, false],
  ] as const)("%s / %s / %s", async (providerId, baseUrl, modelId, mcs, search) => {
    const release = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
    let config = rules.resolve({ providerId, baseUrl, modelId, apiType: "anthropic-messages" });
    if (providerId === "personal-off")
      config = config.overlay(
        parseModelConfig({ properties: { supportsMidConversationSystem: false } }),
      );
    const modelConfig = createRegistryModelConfig(config);
    const providerConfig = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "fixture-not-a-real-key" },
        api: { type: "anthropic-messages", baseUrl },
      }),
    );
    if (!modelConfig.ok || !providerConfig.ok) throw new Error("Incomplete fixture");
    const bodies: Array<{
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
    }> = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.url).toBe(`${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/messages`);
      bodies.push(await request.json());
      return Response.json({
        id: "fixture",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    try {
      const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } });
      const model = adapter.createModel({
        providerId: createModelProviderId(providerId),
        modelId: createModelId(modelId),
        providerConfig: providerConfig.config,
        modelConfig: modelConfig.config,
        options: {
          maxOutputTokens: 4_000,
          reasoningLevel: config.optionSpecs!.reasoningLevel!.values!.at(-1)!,
        },
      });
      await model.generateText({
        messages: buildProviderRequestMessages({
          useMidConversationSystem: model.properties.supportsMidConversationSystem,
          entries: [
            { message: { role: "system", content: "stable prefix" } },
            { message: { role: "user", content: "hello" }, metadata: { source: "real_user" } },
            {
              kind: "attachment",
              content: "CAPABILITY_REMINDER",
              metadata: { source: "output_style" },
            },
          ],
        }).messages,
        tools: search
          ? [
              {
                name: "web_search",
                capability: "web_search",
                description: "fixture search",
                executionMode: "providerNative",
                inputSchema: WEBSEARCH_TOOL_CONTRACT.inputSchema,
                outputSchema: WEBSEARCH_TOOL_CONTRACT.outputSchema,
                providerNative: WEBSEARCH_PROVIDER_NATIVE_SPEC,
              },
            ]
          : [],
      });
      expect(bodies).toHaveLength(1);
      const body = bodies[0]!;
      const reminder = body.messages.find((message) =>
        JSON.stringify(message.content).includes("CAPABILITY_REMINDER"),
      );
      expect(reminder?.role).toBe(mcs ? "system" : "user");
      if (!mcs) expect(JSON.stringify(reminder?.content)).toContain("<system-reminder>");
      if (search)
        expect(body.tools).toContainEqual(
          expect.objectContaining({ name: "web_search", type: "web_search_20260209" }),
        );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { collectAgentListingAttachment } from "../../core/src/subagent/listing.js";
import { buildProviderRequestMessages } from "../../core/src/runtime/helpers/provider-request-messages.js";
import type { RuntimeMessageEntry } from "../../core/src/agent/message-history.js";
import { AiSdkModelAdapter } from "../src/model/runner.js";

// 首次与完整工具批次后的 listing 在 MCS 分支都为 system string，
// 不能只验证 formatter 的 meta user 中间态。
const EXPECTED_LISTING = [
  "Available agent types for the Agent tool:",
  "- A: Description A (Tools: Read)",
  "",
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
].join("\n");
const MODEL_ID = "claude-fable-5-1";
const BASE_URL = "https://api.anthropic.com/v1";

describe("agent listing final Anthropic wire", () => {
  it.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])("MCS=%s after complete tool batch=%s", async (mcs, afterTools) => {
    const release = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    let config = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules).resolve({
      providerId: "fixture",
      baseUrl: BASE_URL,
      modelId: MODEL_ID,
      apiType: "anthropic-messages",
    });
    if (!mcs)
      config = config.overlay(
        parseModelConfig({ properties: { supportsMidConversationSystem: false } }),
      );
    const modelConfig = createRegistryModelConfig(config);
    const providerConfig = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "fixture" },
        api: { type: "anthropic-messages", baseUrl: BASE_URL },
      }),
    );
    if (!modelConfig.ok || !providerConfig.ok) throw new Error("Incomplete fixture");
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }>; system?: unknown }> =
      [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.url).toBe(`${BASE_URL}/messages`);
      bodies.push(await request.json());
      return Response.json({
        id: "fixture",
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    try {
      const model = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }).createModel({
        providerId: createModelProviderId("fixture"),
        modelId: createModelId(MODEL_ID),
        providerConfig: providerConfig.config,
        modelConfig: modelConfig.config,
        options: { maxOutputTokens: 4000, reasoningLevel: "low" },
      });
      expect(model.properties.supportsMidConversationSystem).toBe(mcs);
      const listing = collectAgentListingAttachment({
        definitions: {
          activeAgents: [
            {
              name: "A",
              description: "Description A",
              source: "user",
              tools: ["Read"],
              systemPrompt: "private",
            },
          ],
        },
        entries: [],
        tools: [{ name: "Agent" }],
      })!;
      const entries: RuntimeMessageEntry[] = [
        { message: { role: "system", content: "prefix" } },
        { message: { role: "user", content: "question" }, metadata: { source: "real_user" } },
        ...(afterTools
          ? [
              {
                message: {
                  role: "assistant" as const,
                  content: "",
                  toolCalls: [
                    { id: "r1", name: "Read", input: { file_path: "/one" } },
                    { id: "r2", name: "Read", input: { file_path: "/two" } },
                  ],
                },
              },
              ...["r1", "r2"].map((toolCallId) => ({
                message: {
                  role: "tool" as const,
                  toolCallId,
                  toolName: "Read",
                  content: toolCallId,
                },
              })),
            ]
          : []),
        listing,
      ];
      await model.generateText({
        messages: buildProviderRequestMessages({
          entries,
          useMidConversationSystem: model.properties.supportsMidConversationSystem,
        }).messages,
      });
      expect(bodies).toHaveLength(1);
      const { messages, system } = bodies[0]!;
      const notices = messages.filter((message) =>
        JSON.stringify(message.content).includes("Available agent types for the Agent tool:"),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.role).toBe(mcs ? "system" : "user");
      expect(JSON.stringify(system)).not.toContain("Available agent types");
      expect(JSON.stringify(messages)).not.toContain("agentListingDelta");
      if (mcs) {
        expect(messages.at(-1)).toEqual({ role: "system", content: EXPECTED_LISTING });
        expect(messages.map((message) => message.role)).toEqual(
          afterTools ? ["user", "assistant", "user", "system"] : ["user", "system"],
        );
      } else expect(JSON.stringify(notices[0]!.content)).toContain("<system-reminder>");
      if (afterTools) {
        const toolResults = messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((block) => block.type === "tool_result");
        expect(toolResults.map((block) => block.tool_use_id)).toEqual(["r1", "r2"]);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

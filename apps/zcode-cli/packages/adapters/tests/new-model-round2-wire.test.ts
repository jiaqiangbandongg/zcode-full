import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelMessageContentBlock } from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

type Api = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
let rules: ReturnType<typeof parseZCodeBuiltinModelConfigRules>;
beforeAll(async () => {
  const release = JSON.parse(
    await readFile(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
      "utf8",
    ),
  );
  rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
});
afterEach(() => vi.unstubAllGlobals());
const image: ModelMessageContentBlock = {
  type: "image",
  mediaType: "image/png",
  dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
};
const video: ModelMessageContentBlock = {
  type: "video",
  mediaType: "video/mp4",
  dataUrl: "data:video/mp4;base64,ZmFrZQ==",
};

async function capture(
  modelId: string,
  apiType: Api,
  baseUrl: string,
  reasoningLevel: string,
  media: ModelMessageContentBlock[] = [],
  schema = false,
) {
  const config = createRegistryModelConfig(
    rules.resolve({ providerId: "fixture", modelId, apiType, baseUrl }),
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture" },
      api: { type: apiType, baseUrl },
    }),
  );
  if (!config.ok || !provider.ok) throw new Error("incomplete fixture");
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    body = await new Request(url, init).json();
    const text = schema ? '{"ok":true}' : "ok";
    if (apiType === "anthropic-messages")
      return Response.json({
        id: "fixture",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [{ type: "text", text }],
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
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
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
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });
  const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } });
  const model = adapter.createModel({
    providerId: "fixture",
    modelId,
    modelConfig: config.config,
    providerConfig: provider.config,
    options: { reasoningLevel, maxOutputTokens: 4096 },
  });
  await model.generateText({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }, ...media] }],
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
    ...(schema
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
  expect(body?.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining(
        apiType === "openai-chat-completions" ? { type: "function" } : { name: "Read" },
      ),
    ]),
  );
  expect(
    body?.[
      apiType === "openai-responses"
        ? "max_output_tokens"
        : apiType === "anthropic-messages"
          ? "max_tokens"
          : "max_completion_tokens"
    ],
  ).toBe(4096);
  if (media.some((m) => m.type === "image")) expect(JSON.stringify(body)).toContain("iVBORw0KGgo");
  if (media.some((m) => m.type === "video")) expect(JSON.stringify(body)).toContain("ZmFrZQ==");
  return body!;
}

describe("Todo113 第二轮真实 SDK 序列化，不请求付费模型", () => {
  it("Schema 能力在 binding 时冻结，后续配置不能改变已创建 Model", () => {
    const p = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "fixture" },
        api: { type: "openai-chat-completions", baseUrl: "https://fixture.invalid/v1" },
      }),
    );
    if (!p.ok) throw new Error("invalid fixture");
    const execution = new AiSdkModelExecution({});
    const input = {
      providerId: "fixture",
      modelId: "gpt-5.4",
      providerConfig: p.config,
      supportsJsonSchemaOutput: true,
      optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
    };
    const old = execution.bindModel(input);
    input.supportsJsonSchemaOutput = false;
    const fresh = execution.bindModel(input);
    expect(old.resolved.model).toHaveProperty("supportsStructuredOutputs", true);
    expect(
      old.resolveRequest({ options: { reasoningLevel: "none", maxOutputTokens: 100 } }).model,
    ).toHaveProperty("supportsStructuredOutputs", true);
    expect(fresh.resolved.model).toHaveProperty("supportsStructuredOutputs", false);
  });
  for (const id of ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"]) {
    for (const level of id.endsWith("-pro") ? ["medium", "xhigh"] : ["none", "xhigh"]) {
      it(`${id}/${level} 原厂 Responses 图片/Schema/工具`, async () => {
        expect(
          await capture(id, "openai-responses", "https://api.openai.com/v1", level, [image], true),
        ).toMatchObject({
          reasoning: { effort: level },
          text: { format: { type: "json_schema" } },
        });
      });
      it(`${id}/${level} OpenRouter Messages`, async () => {
        const body = await capture(
          `openai/${id}`,
          "anthropic-messages",
          "https://openrouter.ai/api",
          level,
          [image],
        );
        expect(body).toMatchObject(
          level === "none"
            ? { thinking: { type: "disabled" } }
            : { output_config: { effort: level } },
        );
        if (level !== "none") expect(body).not.toHaveProperty("thinking");
      });
    }
  }
  for (const id of [
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.7-flash",
    "qwen3.6-plus",
    "qwen3.6-flash",
  ]) {
    for (const api of [
      "anthropic-messages",
      "openai-chat-completions",
      "openai-responses",
    ] as const) {
      for (const level of ["disabled", "enabled"])
        it(`${id}/${api}/${level}`, async () => {
          const url =
            api === "anthropic-messages"
              ? "https://dashscope.aliyuncs.com/apps/anthropic"
              : "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
          const body = await capture(id, api, url, level, id.endsWith("-max") ? [] : [image]);
          expect(body).toMatchObject(
            api === "anthropic-messages"
              ? { thinking: { type: level } }
              : api === "openai-responses"
                ? { reasoning: { effort: level === "disabled" ? "none" : "high" } }
                : { enable_thinking: level === "enabled" },
          );
          if (api === "openai-chat-completions") expect(body).not.toHaveProperty("thinking");
        });
    }
  }
  it.each(["none", "max"])("Omni Chat %s / 图片 / 视频", async (level) => {
    expect(
      await capture(
        "qwen3.8-omni-flash",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        level,
        [image, video],
      ),
    ).toMatchObject({ reasoning_effort: level });
  });
  it("Omni Chat 音频输入保留为音频而不是文本占位", async () => {
    const body = await capture(
      "qwen3.8-omni-flash",
      "openai-chat-completions",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "low",
      [
        {
          type: "file",
          mediaType: "audio/wav",
          dataUrl: "data:audio/wav;base64,UklGRg==",
          name: "fixture.wav",
        },
      ],
    );
    expect(JSON.stringify(body)).toContain('"input_audio"');
    expect(JSON.stringify(body)).toContain("UklGRg==");
  });
  it.each(["anthropic-messages", "openai-chat-completions"] as const)(
    "Kimi 高速版 %s 共用 Code 请求",
    async (api) => {
      expect(
        await capture(
          "kimi-k2.7-code-highspeed",
          api,
          api === "anthropic-messages"
            ? "https://api.moonshot.cn/anthropic"
            : "https://api.moonshot.cn/v1",
          "enabled",
          [image, video],
        ),
      ).toMatchObject({ thinking: { type: "enabled" } });
    },
  );
  it.each(["disabled", "max"])(
    "OpenRouter V4.1 Flash Chat %s，统一 reasoning 与 Schema",
    async (level) => {
      expect(
        await capture(
          "deepseek/deepseek-v4.1-flash",
          "openai-chat-completions",
          "https://openrouter.ai/api/v1",
          level,
          [image],
          true,
        ),
      ).toMatchObject({
        reasoning: level === "disabled" ? { enabled: false } : { effort: "max" },
        response_format: { type: "json_schema" },
      });
    },
  );
  it.each(["qwen3.6-plus", "qwen3.6-flash"])("OpenRouter %s 的 Schema 是网关能力", async (id) => {
    const body = await capture(
      `qwen/${id}`,
      "openai-chat-completions",
      "https://openrouter.ai/api/v1",
      "enabled",
      [image],
      true,
    );
    expect(body).toMatchObject({
      reasoning: { enabled: true },
      response_format: { type: "json_schema" },
    });
    expect(body).not.toHaveProperty("enable_thinking");
  });
  it.each(["minimal", "xhigh"])("OpenRouter Qwen3.8 快照 %s 映射", async (level) => {
    const body = await capture(
      "qwen/qwen3.8-max-0902",
      "anthropic-messages",
      "https://openrouter.ai/api",
      level,
      [image],
    );
    expect(body).toMatchObject({ output_config: { effort: level } });
  });
});

describe("Todo138 通用两档的真实 SDK 请求体", () => {
  for (const api of [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
  ] as const) {
    for (const level of ["disabled", "enabled"]) {
      it(`${api}/${level} 不把 enabled 直接传成 effort`, async () => {
        const body = await capture(
          "future-unknown-model",
          api,
          "https://fixture.invalid/v1",
          level,
        );
        const effort = level === "disabled" ? "none" : "high";
        if (api === "anthropic-messages") {
          expect(body.thinking).toEqual({ type: level === "disabled" ? "disabled" : "adaptive" });
          if (level === "disabled") expect(body).not.toHaveProperty("output_config");
          else expect(body.output_config).toEqual({ effort: "high" });
        } else {
          expect(body.reasoning).toEqual({ effort });
          if (api === "openai-chat-completions") {
            expect(body.reasoning_effort).toBe(effort);
            expect(body.thinking).toEqual({ type: level === "disabled" ? "disabled" : "enabled" });
            expect(body.enable_thinking).toBe(level !== "disabled");
          }
        }
      });
    }
  }
});

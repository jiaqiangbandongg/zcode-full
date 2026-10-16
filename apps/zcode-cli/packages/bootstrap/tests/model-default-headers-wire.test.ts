import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  InMemorySessionEventStore,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  parseProviderConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { createRuntimeAiSdkModelExecutionConfig } from "../src/model-config.js";
import { createModelAdapter } from "../src/model-factory.js";

type ApiType = RegistryProviderConfig["api"]["type"];
const CLIENT_VERSION = "3.12.0";
const MODEL_ID = "header-test-model";
const API_TYPES: ApiType[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

afterEach(() => vi.unstubAllGlobals());

function createFixture(
  options: {
    apiType?: ApiType;
    baseUrl?: string;
    headers?: Record<string, string>;
    access?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    sourceTitle?: "cli" | "electron";
    appVersion?: string;
  } = {},
) {
  const apiType = options.apiType ?? "anthropic-messages";
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const body = (await request.json()) as { stream?: boolean };
    return body.stream ? streamResponseFor(apiType) : responseFor(apiType);
  });
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: options.access ?? { type: "api-key", apiKey: "fixture-key" },
      api: {
        type: apiType,
        baseUrl: options.baseUrl ?? "https://provider.example.test/v1",
        ...(options.headers ? { headers: options.headers } : {}),
      },
    }),
  );
  const model = createRegistryModelConfig(
    new ModelConfig({
      enabled: true,
      properties: new ModelPropertiesConfig({
        contextWindow: 200_000,
        requiresMfjsToolSchema: false,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: 2048, map: "{}" },
      }),
    }),
  );
  if (!provider.ok || !model.ok) throw new Error("invalid header fixture");
  const executionConfig = createRuntimeAiSdkModelExecutionConfig(
    options.env ?? { ZCODE_APP_VERSION: CLIENT_VERSION, ZCODE_ENV: "production" },
    { sourceTitle: options.sourceTitle ?? "electron", appVersion: options.appVersion },
  );
  const adapter = createModelAdapter({ executionConfig, env: {} });
  const bound = adapter.createModel({
    providerId: "header-provider",
    modelId: MODEL_ID,
    providerConfig: provider.config,
    modelConfig: model.config,
    options: { reasoningLevel: "disabled", maxOutputTokens: 2048 },
  });
  return { requests, model: bound };
}

function responseFor(apiType: ApiType) {
  if (apiType === "anthropic-messages")
    return Response.json({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [{ type: "text", text: '{"title":"Header regression"}' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  if (apiType === "openai-chat-completions")
    return Response.json({
      id: "chat_fixture",
      object: "chat.completion",
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  return Response.json({
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: MODEL_ID,
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
}

const requestInput = { messages: [{ role: "user" as const, content: "hello" }] };

async function streamResponseFor(apiType: ApiType) {
  const response = await responseFor(apiType).json();
  const events =
    apiType === "anthropic-messages"
      ? [
          { type: "message_start", message: { ...response, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]
      : apiType === "openai-chat-completions"
        ? [
            {
              id: "chat_fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: MODEL_ID,
              choices: [
                { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: response.usage,
            },
          ]
        : [{ type: "response.completed", response }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("模型请求默认 Header：Bootstrap → Adapter → 真实 SDK", () => {
  for (const apiType of API_TYPES) {
    for (const stream of [false, true]) {
      it(`${apiType} / ${stream ? "streamText" : "generateText"} 带来源、版本且不新增设备身份`, async () => {
        const { model, requests } = createFixture({ apiType });
        if (stream) {
          const events = [];
          for await (const event of model.streamText(requestInput)) events.push(event);
          expect(events.length).toBeGreaterThan(0);
          expect(events.some((event) => event.type === "error")).toBe(false);
        } else await model.generateText(requestInput);
        expect(requests).toHaveLength(1);
        const headers = requests[0]!.headers;
        expect(headers.get("user-agent")).toContain(`ZCode/${CLIENT_VERSION}`);
        expect(headers.get("x-zcode-app-version")).toBe(CLIENT_VERSION);
        expect(headers.get("x-title")).toBe("Z Code@electron");
        expect(headers.get("http-referer")).toBe("https://zcode.z.ai");
        expect(headers.get("x-zcode-agent")).toBe("glm");
        expect(headers.get("x-release-channel")).toBe("production");
        for (const key of [
          "x-client-language",
          "x-client-timezone",
          "x-platform",
          "x-os-category",
          "x-os-version",
        ])
          expect(headers.get(key)).toBeTruthy();
        expect(headers.get("authorization")).toBe("Bearer fixture-key");
        expect(headers.has("x-device-mid")).toBe(false);
        expect(headers.has("x-openrouter-title")).toBe(false);
        expect((await requests[0]!.json()).model).toBe(MODEL_ID);
      });
    }
  }

  it.each([
    ["https://openrouter.ai/api/v1", true],
    ["https://API.OPENROUTER.AI/api/v1", true],
    ["https://openrouter.ai.example.test/v1", false],
    ["http://openrouter.ai/api/v1", false],
  ])("按真实 URL 匹配 OpenRouter，不按 Provider 名称：%s", async (baseUrl, matches) => {
    const { model, requests } = createFixture({ baseUrl, apiType: "openai-chat-completions" });
    await model.generateText(requestInput);
    expect(requests[0]!.headers.get("x-openrouter-title")).toBe(matches ? "ZCode" : null);
    expect(requests[0]!.headers.get("x-openrouter-categories")).toBe(
      matches ? "programming-app" : null,
    );
  });

  it("用户 Header 大小写不敏感地覆盖默认值，不拼接重复值", async () => {
    const headers = {
      "x-title": "User Title",
      "USER-AGENT": "Custom/1",
      "x-openrouter-title": "User Router",
      "http-referer": "https://user.example.test",
    };
    const { model, requests } = createFixture({ baseUrl: "https://openrouter.ai/api/v1", headers });
    await model.generateText(requestInput);
    expect(requests[0]!.headers.get("x-title")).toBe("User Title");
    expect(requests[0]!.headers.get("user-agent")).toMatch(/^Custom\/1(?: |$)/);
    expect(requests[0]!.headers.get("user-agent")).not.toContain("ZCode/");
    expect(requests[0]!.headers.get("x-openrouter-title")).toBe("User Router");
    expect(requests[0]!.headers.get("http-referer")).toBe("https://user.example.test");
    expect(headers["x-title"]).toBe("User Title");
  });

  it.each([
    { env: {}, sourceTitle: "cli" as const, appVersion: "1.2.3", expected: "1.2.3" },
    {
      env: { ZCODE_APP_VERSION: "3.12.0" },
      sourceTitle: "electron" as const,
      appVersion: "0.13.3",
      expected: "3.12.0",
    },
    {
      env: { ZCODE_APP_VERSION: "bad\r\nheader" },
      sourceTitle: "cli" as const,
      appVersion: "1.2.3",
      expected: undefined,
    },
    { env: {}, sourceTitle: "cli" as const, expected: undefined },
  ])("保留版本来源及非法/缺失语义：$sourceTitle / $expected", async (options) => {
    const { model, requests } = createFixture(options);
    await model.generateText(requestInput);
    expect(requests[0]!.headers.get("user-agent")).toContain(
      `ZCode/${options.expected ?? "unknown"}`,
    );
    expect(requests[0]!.headers.get("x-zcode-app-version")).toBe(options.expected ?? null);
    expect(requests[0]!.headers.get("x-title")).toBe(`Z Code@${options.sourceTitle}`);
  });

  it("真实 Runtime 标题 sidecar 沿公共工厂携带版本、other 类型和会话追踪", async () => {
    const { model, requests } = createFixture();
    const sessionId = createSessionId("header-title-session");
    const updateSession = vi.fn(async (input) => input);
    const store = {
      getSession: async () => ({
        id: sessionId,
        title: "New session",
        titleSource: "default",
        taskType: "interactive",
      }),
      updateSession,
    } as unknown as SessionStorePort;
    const runtime = new AgentRuntime(
      sessionId,
      {
        modelSelection: {
          providerId: "header-provider",
          modelId: MODEL_ID,
          options: { reasoningLevel: "disabled" },
        },
        titleGeneration: { enabled: true },
      },
      {
        modelFactory: () => model,
        eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
        sessionStore: store,
      },
    );
    runtime.maybeStartSessionTitleGenerationFromExternalInput(
      "Please investigate missing client headers",
    );
    await vi.waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Header regression", titleSource: "generated" }),
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("x-zcode-app-version")).toBe(CLIENT_VERSION);
    expect(requests[0]!.headers.get("x-zcode-session-type")).toBe("other");
    // 既有请求归因会去掉内部 sess_ 前缀；本次不改变服务端看到的会话身份格式。
    expect(requests[0]!.headers.get("x-session-id")).toBe("header-title-session");
    expect(requests[0]!.headers.get("x-zcode-trace-id")).toBeTruthy();
    expect(JSON.stringify(await requests[0]!.json())).toContain(
      "This is a title-generation task, not a conversation.",
    );
  });
});

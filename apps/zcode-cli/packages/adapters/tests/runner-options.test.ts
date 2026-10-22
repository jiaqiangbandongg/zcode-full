import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
  shouldIncludeStreamResponseBody,
} from "../src/model/runner-options.js";
import { isOpenCodeGoBaseUrl } from "../src/model/opencode-session.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

function resolved(partial: Partial<ResolvedAiSdkModel>): ResolvedAiSdkModel {
  return { properties: {}, ...partial } as ResolvedAiSdkModel;
}

describe("shouldIncludeStreamResponseBody", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enables responseBody capture for zcode-plan openai-compatible providers", () => {
    expect(
      shouldIncludeStreamResponseBody(
        resolved({
          providerKind: "openai-compatible",
          baseURL: "https://zcode.z.ai/api/v1/zcode-plan",
          accountAccess: { mode: "start-plan" } as ResolvedAiSdkModel["accountAccess"],
        }),
      ),
    ).toBe(true);
  });

  it("skips responseBody capture for unrelated providers", () => {
    expect(
      shouldIncludeStreamResponseBody(
        resolved({
          providerKind: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
        }),
      ),
    ).toBe(false);
  });
});

describe("isOpenCodeGoBaseUrl", () => {
  it.each(["https://opencode.ai/zen/go/v1", "https://api.opencode.ai/zen/go/v1/"])(
    "matches OpenCode Go host and path boundaries: %s",
    (baseURL) => {
      expect(isOpenCodeGoBaseUrl(baseURL)).toBe(true);
    },
  );

  it.each([
    "https://opencode.ai/zen/v1",
    "https://opencode.ai/zen/go/v2",
    "https://opencode.ai.example/zen/go/v1",
    "not a url",
    undefined,
  ])("rejects unrelated OpenCode endpoints: %s", (baseURL) => {
    expect(isOpenCodeGoBaseUrl(baseURL)).toBe(false);
  });
});

describe("createStreamTextOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a JSON response schema only into generateText structured output", async () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: {
          items: { type: "string" },
          type: "array",
        },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      includeModelIO: false,
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test-provider",
        modelId: "test-model",
        providerKind: "custom",
      }),
      statusContext: {
        model: { providerId: "test-provider", modelId: "test-model" },
        providerKind: "custom",
        requestId: "req_structured_output",
        sessionId: "sess_structured_output",
        traceId: "trace_structured_output",
      } as never,
    };

    const generateOptions = createGenerateTextOptions(input);
    const streamOptions = createStreamTextOptions(input);

    expect(generateOptions.output).toBeDefined();
    await expect(generateOptions.output?.responseFormat).resolves.toEqual({
      schema: responseJsonSchema,
      type: "json",
    });
    expect(streamOptions).not.toHaveProperty("output");
  });

  it("keeps explicit generateText schemas on the native Anthropic output format", () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: { items: { type: "string" }, type: "array" },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      includeModelIO: false,
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test-provider",
        modelId: "lite-model",
        providerKind: "anthropic",
      }),
      statusContext: {
        model: { providerId: "test-provider", modelId: "lite-model" },
        providerKind: "anthropic",
        requestId: "req_native_structured_output",
        sessionId: "sess_native_structured_output",
        traceId: "trace_native_structured_output",
      } as never,
    };
    const generateInput = {
      ...input,
      request: {
        ...input.request,
        options: { maxOutputTokens: 256 },
        providerOptions: { anthropic: {} },
      },
      resolved: {
        ...input.resolved,
        providerOptions: {
          anthropic: {
            effort: "medium",
            thinking: { budgetTokens: 8_000, type: "enabled" },
          },
        },
      },
    };

    const generateOptions = createGenerateTextOptions(generateInput);
    expect(generateOptions).not.toHaveProperty("maxOutputTokens");
    expect(generateOptions.providerOptions).toEqual({
      anthropic: { structuredOutputMode: "outputFormat" },
    });
    expect(createStreamTextOptions(input).providerOptions).toBeUndefined();
  });

  it("applies the same empty-user wire fallback to generate and stream requests", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "custom-compatible",
          modelId: "empty-user-model",
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
        }),
        statusContext: {
          model: { providerId: "custom-compatible", modelId: "empty-user-model" },
          providerKind: "openai-compatible",
          requestId: "req_empty_user",
          sessionId: "sess_empty_user",
          traceId: "trace_empty_user",
        } as never,
      });

      expect(options.messages).toEqual([{ role: "user", content: "(no content)" }]);
    }
  });

  it("passes resolved image support into generateText message transforms", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/png",
                dataUrl: "data:image/png;base64,aW1hZ2U=",
              },
            ],
          },
        ],
      },
      resolved: resolved({
        properties: {
          inputFormat: { text: true, image: false, audio: false, video: false, pdf: false },
        },
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "zai",
        modelId: "glm-text",
        providerKind: "openai-compatible",
      }),
      statusContext: {
        model: { providerId: "zai", modelId: "glm-text" },
        providerKind: "openai-compatible",
        requestId: "req_text_only",
        sessionId: "sess_text_only",
        traceId: "trace_text_only",
      } as never,
    });

    expect((options.messages[0] as any).content).toEqual([
      {
        type: "text",
        text: "[Attached image/png]\n[Media omitted from provider request because the selected model does not support image input.]",
      },
    ]);
  });

  it("strips video before the OpenAI Responses adapter sees an unsupported file part", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "video",
                  mediaType: "video/mp4",
                  dataUrl: "data:video/mp4;base64,dmlkZW8=",
                },
              ],
            },
          ],
        },
        resolved: resolved({
          properties: {
            inputFormat: { text: true, image: false, audio: false, video: true, pdf: false },
          },
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "openai",
          modelId: "gpt-test",
          providerKind: "openai",
        }),
        statusContext: {
          model: { providerId: "openai", modelId: "gpt-test" },
          providerKind: "openai",
          requestId: "req_openai_video",
          sessionId: "sess_openai_video",
          traceId: "trace_openai_video",
        } as never,
      });

      expect((options.messages[0] as any).content).toEqual([
        {
          type: "text",
          text: "[Attached video/mp4]\n[Media omitted from provider request because the selected model does not support video input.]",
        },
      ]);
    }
  });

  // 最终输出预算由 Model Option Map 写入原始请求体；runner 不再二次推导、扣减或投影旧字段。
  it.each([createGenerateTextOptions, createStreamTextOptions])(
    "keeps canonical model options out of SDK-specific legacy projection",
    (createOptions) => {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "hello" }],
          options: { maxOutputTokens: 20_000, reasoningLevel: "high" },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "example",
          modelId: "example-model",
          providerKind: "anthropic",
        }),
        statusContext: { model: { providerId: "example", modelId: "example-model" } } as never,
      });
      expect(options).not.toHaveProperty("maxOutputTokens");
      expect(options.providerOptions).toBeUndefined();
    },
  );

  it("passes experimental_include.responseBody for zcode-plan streams", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "builtin:zai-coding-plan",
        modelId: "glm-5.1",
        providerKind: "openai-compatible",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan",
        accountAccess: { mode: "start-plan" } as ResolvedAiSdkModel["accountAccess"],
      }),
      statusContext: {
        model: { providerId: "builtin:zai-coding-plan", modelId: "glm-5.1" },
        providerKind: "openai-compatible",
        requestId: "req_test",
        sessionId: "sess_test",
        traceId: "trace_test",
      } as never,
    });

    expect(options.experimental_include).toEqual({ responseBody: true });
  });

  it("uses merged Responses provider options while transforming history", () => {
    const toolCallId = "call_read";
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "stored reasoning",
                providerOptions: { openai: { itemId: "rs_1" } },
              },
              { type: "text", text: "checking" },
            ],
            toolCalls: [{ id: toolCallId, name: "Read", input: { file_path: "README.md" } }],
          },
        ],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "openai",
        modelId: "gpt-5",
        providerKind: "openai",
        providerOptions: { apiFormat: "openai-responses" },
      }),
      statusContext: {
        model: { providerId: "openai", modelId: "gpt-5" },
        providerKind: "openai",
        requestId: "req_responses",
        sessionId: "sess_responses",
        traceId: "trace_responses",
      } as never,
    });

    const [message] = options.messages ?? [];
    expect((message as any).content).toEqual([
      { type: "text", text: "checking" },
      {
        type: "tool-call",
        toolCallId,
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
    expect(options.providerOptions).toEqual({ apiFormat: "openai-responses" });
  });

  it("preserves explicit provider option namespaces without inferring model options", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "Generate a title" }],
          providerOptions: { reasoningEffort: "none" },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerKind: "openai",
          providerOptions: { openai: { reasoningEffort: "high", store: false } },
          providerId: "openai",
          modelId: "gpt-5.2",
        }),
        statusContext: {
          model: { providerId: "openai", modelId: "gpt-5.2" },
          providerKind: "openai",
          requestId: "req_openai_reasoning",
          sessionId: "sess_openai_reasoning",
          traceId: "trace_openai_reasoning",
        } as never,
      });

      expect(options.providerOptions).toEqual({
        openai: { reasoningEffort: "high", store: false },
        reasoningEffort: "none",
      });
    }
  });

  it("adds request attribution headers for generateText requests", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "main",
        providerKind: "openai-compatible",
        requestId: "req_generate",
        queryId: "query_generate",
        sessionId: "sess_generate",
        traceId: "trace_generate",
      } as never,
    });

    expect(options.headers).toEqual({
      "x-query-id": "generate",
      "x-request-id": "req_generate",
      "x-session-id": "generate",
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": "trace_generate",
    });
  });

  it("keeps provider runtime platform headers with request attribution headers", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        headers: {
          "X-Os-Category": "macos",
          "X-Os-Version": "25.0.0",
          "X-Platform": "darwin-arm64",
          "x-zcode-session-type": "spoofed",
        },
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "subagent",
        providerKind: "openai-compatible",
        requestId: "req_platform",
        sessionId: "sess_platform",
        traceId: "trace_platform",
      } as never,
    });

    expect(options.headers).toEqual({
      "X-Os-Category": "macos",
      "X-Os-Version": "25.0.0",
      "X-Platform": "darwin-arm64",
      "x-request-id": "req_platform",
      "x-session-id": "platform",
      "x-zcode-session-type": "subagent",
      "x-zcode-trace-id": "trace_platform",
    });
  });

  it("strips internal subagent and query prefixes from request attribution headers", () => {
    const queryId = "query_ad8740cd-f843-4235-ba0d-395063e56fda";
    const sessionId = "sess_subagent_agent_b3d813c3-c568-42e9-8f67-eeb814bc8ef2";
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "subagent",
        providerKind: "openai-compatible",
        requestId: "req_subagent",
        queryId,
        sessionId,
        traceId: "trace_subagent",
      } as never,
    });

    expect(options.headers).toMatchObject({
      "x-query-id": "ad8740cd-f843-4235-ba0d-395063e56fda",
      "x-session-id": "b3d813c3-c568-42e9-8f67-eeb814bc8ef2",
    });
  });

  it("adds request attribution headers for streamText requests", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "other",
        providerKind: "openai-compatible",
        requestId: "req_stream",
        queryId: "query_stream",
        sessionId: "sess_stream",
        traceId: "trace_stream",
      } as never,
    });

    expect(options.headers).toEqual({
      "x-query-id": "stream",
      "x-request-id": "req_stream",
      "x-session-id": "stream",
      "x-zcode-session-type": "other",
      "x-zcode-trace-id": "trace_stream",
    });
  });

  it.each([createGenerateTextOptions, createStreamTextOptions])(
    "adds a stable OpenCode Go session header to %s requests",
    (createOptions) => {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "hi" }],
        },
        resolved: resolved({
          baseURL: "https://opencode.ai/zen/go/v1",
          headers: { "x-opencode-session": "spoofed" },
          model: {} as ResolvedAiSdkModel["model"],
          providerKind: "openai-compatible",
          providerId: "custom-provider",
          modelId: "kimi-k2.5",
        }),
        statusContext: {
          model: { providerId: "custom-provider", modelId: "kimi-k2.5" },
          modelRequestSessionType: "main",
          providerKind: "openai-compatible",
          requestId: "req_opencode_go",
          sessionId: "sess_conversation_stable",
          traceId: "trace_opencode_go",
          baseURL: "https://opencode.ai/zen/go/v1",
        } as never,
      });

      expect(options.headers).toMatchObject({
        "x-opencode-session": "conversation_stable",
      });
    },
  );
});

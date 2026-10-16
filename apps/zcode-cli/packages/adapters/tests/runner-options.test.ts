import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
  shouldIncludeStreamResponseBody,
} from "../src/model/runner-options.js";
import { isOpenCodeGoBaseUrl } from "../src/model/opencode-session.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

function resolved(partial: Partial<ResolvedAiSdkModel>): ResolvedAiSdkModel {
  return partial as ResolvedAiSdkModel;
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
        ref: { providerId: "test-provider", modelId: "test-model" },
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
        ref: { providerId: "test-provider", modelId: "lite-model" },
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
        maxOutputTokens: 256,
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
    expect(generateOptions.maxOutputTokens).toBe(256);
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
          ref: { providerId: "custom-compatible", modelId: "empty-user-model" },
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
        inputMediaCapabilities: { supportsImages: false },
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "zai", modelId: "glm-text" },
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
          inputMediaCapabilities: { supportsVideo: true },
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "openai", modelId: "gpt-test" },
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

  it("subtracts fixed Anthropic thinking from the explicit model-level generateText budget", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        maxOutputTokens: 131_072,
        maxOutputTokensSource: "model-capability",
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          anthropic: {
            thinking: {
              budgetTokens: 1_024,
              type: "enabled",
            },
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "default-mimo", modelId: "mimo-v2.5-pro" },
        providerKind: "anthropic",
        baseURL: "https://api.xiaomimimo.com/anthropic",
      }),
      statusContext: {
        model: { providerId: "default-mimo", modelId: "mimo-v2.5-pro" },
        providerKind: "anthropic",
        requestId: "req_mimo_generate",
        sessionId: "sess_mimo_generate",
        traceId: "trace_mimo_generate",
      } as never,
    });

    expect(options.maxOutputTokens).toBe(130_048);
  });

  it("subtracts fixed Anthropic thinking from the explicit model-level streamText budget", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        maxOutputTokens: 131_072,
        maxOutputTokensSource: "model-capability",
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          anthropic: {
            thinking: {
              budgetTokens: 1_024,
              type: "enabled",
            },
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "default-mimo", modelId: "mimo-v2.5-pro" },
        providerKind: "anthropic",
        baseURL: "https://api.xiaomimimo.com/anthropic",
      }),
      statusContext: {
        model: { providerId: "default-mimo", modelId: "mimo-v2.5-pro" },
        providerKind: "anthropic",
        requestId: "req_mimo_stream",
        sessionId: "sess_mimo_stream",
        traceId: "trace_mimo_stream",
      } as never,
    });

    expect(options.maxOutputTokens).toBe(130_048);
  });

  it("fits oversized fixed Anthropic thinking into one immutable request budget", () => {
    const providerOptions = {
      anthropic: {
        effort: "high",
        vendorFlag: "kept",
        thinking: { budgetTokens: 32_000, type: "enabled" },
      },
    };
    const input = {
      includeModelIO: false,
      request: {
        maxOutputTokens: 20_000,
        maxOutputTokensSource: "runtime-default" as const,
        messages: [{ role: "user" as const, content: "compact" }],
        providerOptions,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "anthropic-compatible", modelId: "fixed-thinking-model" },
        providerKind: "anthropic",
        baseURL: "https://api.example.test/anthropic",
      }),
      statusContext: {
        model: { providerId: "anthropic-compatible", modelId: "fixed-thinking-model" },
        providerKind: "anthropic",
        requestId: "req_compact_fixed_thinking",
        sessionId: "sess_compact_fixed_thinking",
        traceId: "trace_compact_fixed_thinking",
      } as never,
    };

    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions(input);

      expect(options.maxOutputTokens).toBe(1);
      expect(options.providerOptions).toMatchObject({
        anthropic: {
          effort: "high",
          vendorFlag: "kept",
          thinking: { budgetTokens: 19_999, type: "enabled" },
        },
      });
    }
    expect(providerOptions.anthropic.thinking.budgetTokens).toBe(32_000);
  });

  it.each([0.5, 1])(
    "rejects Anthropic fixed thinking when the total request budget is %s",
    (maxOutputTokens) => {
      const input = {
        includeModelIO: false,
        request: {
          maxOutputTokens,
          messages: [{ role: "user" as const, content: "small budget" }],
          providerOptions: {
            anthropic: {
              thinking: { budgetTokens: 32_000, type: "enabled" },
            },
          },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "anthropic-compatible", modelId: "fixed-thinking-model" },
          providerKind: "anthropic",
          baseURL: "https://api.example.test/anthropic",
        }),
        statusContext: {
          model: { providerId: "anthropic-compatible", modelId: "fixed-thinking-model" },
          providerKind: "anthropic",
          requestId: "req_small_fixed_thinking",
          sessionId: "sess_small_fixed_thinking",
          traceId: "trace_small_fixed_thinking",
        } as never,
      };

      for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
        let error: unknown;
        try {
          createOptions(input);
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(AiSdkModelAdapterError);
        expect(error).toMatchObject({
          code: ModelErrorCode.InvalidModelRequest,
          message: "Anthropic-compatible fixed thinking requires maxOutputTokens to be at least 2",
        } satisfies Partial<AiSdkModelAdapterError>);
      }
    },
  );

  it("keeps explicit model-level output tokens on non-Anthropic transport", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        maxOutputTokens: 131_072,
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          anthropic: {
            thinking: {
              budgetTokens: 1_024,
              type: "enabled",
            },
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "default-mimo", modelId: "mimo-v2.5-pro" },
        providerKind: "openai-compatible",
        baseURL: "https://api.xiaomimimo.com/v1",
      }),
      statusContext: {
        model: { providerId: "default-mimo", modelId: "mimo-v2.5-pro" },
        providerKind: "openai-compatible",
        requestId: "req_mimo_openai",
        sessionId: "sess_mimo_openai",
        traceId: "trace_mimo_openai",
      } as never,
    });

    expect(options.maxOutputTokens).toBe(131_072);
  });

  it.each([
    { caseId: "OTB01", modelLimit: undefined, expected: 32_000 },
    { caseId: "OTB02", modelLimit: 16_000, expected: 16_000 },
    { caseId: "OTB03", modelLimit: 64_000, expected: 64_000 },
    { caseId: "fractional normalization", modelLimit: 16_000.9, expected: 16_000 },
    { caseId: "invalid zero", modelLimit: 0, expected: 32_000 },
    { caseId: "invalid negative", modelLimit: -1, expected: 32_000 },
    { caseId: "invalid non-finite", modelLimit: Number.NaN, expected: 32_000 },
  ])("$caseId resolves model capability $modelLimit to $expected", ({ modelLimit, expected }) => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          maxOutputTokens: modelLimit,
          maxOutputTokensSource: "model-capability",
          messages: [{ role: "user", content: "hi" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "custom-compatible", modelId: "reasoning-model" },
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
        }),
        statusContext: {
          model: { providerId: "custom-compatible", modelId: "reasoning-model" },
          providerKind: "openai-compatible",
          requestId: "req_model_capability",
          sessionId: "sess_model_capability",
          traceId: "trace_model_capability",
        } as never,
      });

      expect(options.maxOutputTokens).toBe(expected);
    }
  });

  it.each([
    {
      expected: 32_000,
      name: "model-capability source",
      providerKind: "openai-compatible" as const,
      source: "model-capability" as const,
    },
    {
      expected: 32_000,
      name: "runtime-default source",
      providerKind: "openai-compatible" as const,
      source: "runtime-default" as const,
    },
    {
      expected: 32_000,
      name: "legacy Anthropic request",
      providerKind: "anthropic" as const,
      source: undefined,
    },
    {
      expected: undefined,
      name: "legacy non-Anthropic request",
      providerKind: "openai-compatible" as const,
      source: undefined,
    },
  ])(
    "keeps the missing-budget compatibility behavior for $name",
    ({ expected, providerKind, source }) => {
      for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
        const options = createOptions({
          includeModelIO: false,
          request: {
            maxOutputTokensSource: source,
            messages: [{ role: "user", content: "hi" }],
          },
          resolved: resolved({
            model: {} as ResolvedAiSdkModel["model"],
            ref: { providerId: "provider", modelId: "model" },
            providerKind,
          }),
          statusContext: {
            model: { providerId: "provider", modelId: "model" },
            providerKind,
            requestId: "req_missing_output_budget",
            sessionId: "sess_missing_output_budget",
            traceId: "trace_missing_output_budget",
          } as never,
        });

        expect(options.maxOutputTokens).toBe(expected);
      }
    },
  );

  it.each(["openai", "openai-compatible", "gateway", "custom"] as const)(
    "keeps normal model capability budget for %s providers",
    (providerKind) => {
      const options = createGenerateTextOptions({
        includeModelIO: false,
        request: {
          maxOutputTokens: 131_072,
          maxOutputTokensSource: "model-capability",
          messages: [{ role: "user", content: "hi" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "provider", modelId: "model" },
          providerKind,
        }),
        statusContext: {
          model: { providerId: "provider", modelId: "model" },
          providerKind,
          requestId: `req_${providerKind}`,
          sessionId: `sess_${providerKind}`,
          traceId: `trace_${providerKind}`,
        } as never,
      });

      expect(options.maxOutputTokens).toBe(131_072);
    },
  );

  it("keeps the Compact summary budget for OpenAI-compatible runtime-default requests", () => {
    const generateOptions = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        maxOutputTokens: 20_000,
        maxOutputTokensSource: "runtime-default",
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "custom-openai-compatible", modelId: "generic-reasoning-model" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "custom-openai-compatible", modelId: "generic-reasoning-model" },
        providerKind: "openai-compatible",
        requestId: "req_openai_compatible_default_generate",
        sessionId: "sess_openai_compatible_default_generate",
        traceId: "trace_openai_compatible_default_generate",
      } as never,
    });
    const streamOptions = createStreamTextOptions({
      includeModelIO: false,
      request: {
        maxOutputTokens: 20_000,
        maxOutputTokensSource: "runtime-default",
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "custom-openai-compatible", modelId: "generic-reasoning-model" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "custom-openai-compatible", modelId: "generic-reasoning-model" },
        providerKind: "openai-compatible",
        requestId: "req_openai_compatible_default_stream",
        sessionId: "sess_openai_compatible_default_stream",
        traceId: "trace_openai_compatible_default_stream",
      } as never,
    });

    expect(generateOptions.maxOutputTokens).toBe(20_000);
    expect(streamOptions.maxOutputTokens).toBe(20_000);
  });

  it("lets the canonical budget override native OpenAI-compatible output params", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          maxOutputTokens: 64_000,
          maxOutputTokensSource: "runtime-default",
          messages: [{ role: "user", content: "hi" }],
          providerOptions: {
            openaiCompatible: {
              extra_body: {
                max_tokens: 32_768,
                vendor_flag: true,
              },
            },
          },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "custom-openai-compatible", modelId: "large-output-model" },
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
          providerOptionsName: "Custom Compatible",
        } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
        statusContext: {
          model: { providerId: "custom-openai-compatible", modelId: "large-output-model" },
          providerKind: "openai-compatible",
          requestId: "req_openai_compatible_native_max_tokens",
          sessionId: "sess_openai_compatible_native_max_tokens",
          traceId: "trace_openai_compatible_native_max_tokens",
        } as never,
      });

      expect(options.maxOutputTokens).toBe(64_000);
      expect(options.providerOptions).toEqual({
        openaiCompatible: {
          extra_body: { vendor_flag: true },
        },
        "Custom Compatible": { vendor_flag: true },
      });
    }
  });

  it("keeps native output params for legacy requests without a canonical budget", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          openaiCompatible: { extra_body: { max_tokens: 32_768 } },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "custom-openai-compatible", modelId: "legacy-model" },
        providerKind: "openai-compatible",
        providerOptionsName: "Custom Compatible",
      } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
      statusContext: {
        model: { providerId: "custom-openai-compatible", modelId: "legacy-model" },
        providerKind: "openai-compatible",
        requestId: "req_legacy_native_max_tokens",
        sessionId: "sess_legacy_native_max_tokens",
        traceId: "trace_legacy_native_max_tokens",
      } as never,
    });

    expect(options.maxOutputTokens).toBeUndefined();
    expect(options.providerOptions).toMatchObject({
      "Custom Compatible": { max_tokens: 32_768 },
    });
  });

  it("keeps explicit Anthropic runtime-default output tokens", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        maxOutputTokens: 131_072,
        maxOutputTokensSource: "runtime-default",
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "custom-anthropic-compatible", modelId: "generic-reasoning-model" },
        providerKind: "anthropic",
        baseURL: "https://api.example.test/anthropic",
      }),
      statusContext: {
        model: { providerId: "custom-anthropic-compatible", modelId: "generic-reasoning-model" },
        providerKind: "anthropic",
        requestId: "req_anthropic_runtime_default",
        sessionId: "sess_anthropic_runtime_default",
        traceId: "trace_anthropic_runtime_default",
      } as never,
    });

    expect(options.maxOutputTokens).toBe(131_072);
  });

  it("keeps the Compact summary budget on Anthropic requests", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          maxOutputTokens: 20_000,
          maxOutputTokensSource: "runtime-default",
          messages: [{ role: "user", content: "hi" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "custom-anthropic-compatible", modelId: "generic-reasoning-model" },
          providerKind: "anthropic",
          baseURL: "https://api.example.test/anthropic",
        }),
        statusContext: {
          model: { providerId: "custom-anthropic-compatible", modelId: "generic-reasoning-model" },
          providerKind: "anthropic",
          requestId: "req_anthropic_compact_independent_cap",
          sessionId: "sess_anthropic_compact_independent_cap",
          traceId: "trace_anthropic_compact_independent_cap",
        } as never,
      });

      expect(options.maxOutputTokens).toBe(20_000);
    }
  });

  it("unwraps OpenAI-compatible extra_body into the SDK provider namespace", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          openaiCompatible: {
            extra_body: {
              chat_template_kwargs: {
                reasoning_effort: "max",
              },
            },
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "custom-glm", modelId: "GLM-5.2" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
        providerOptionsName: "GLM52 E2E",
      } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
      statusContext: {
        model: { providerId: "custom-glm", modelId: "GLM-5.2" },
        providerKind: "openai-compatible",
        requestId: "req_glm52",
        sessionId: "sess_glm52",
        traceId: "trace_glm52",
      } as never,
    });

    expect(options.providerOptions).toEqual({
      openaiCompatible: {
        extra_body: {
          chat_template_kwargs: {
            reasoning_effort: "max",
          },
        },
      },
      "GLM52 E2E": {
        chat_template_kwargs: {
          reasoning_effort: "max",
        },
      },
    });
  });

  it("preserves raw and sibling namespaces while projecting canonical options", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          openaiCompatible: {
            extra_body: {
              mode: "legacy",
              thinking: { type: "enabled" },
            },
            mode: "direct",
            reasoningEffort: "max",
          },
          "foo-bar": {
            rawOnly: true,
          },
          fooBar: {
            camelOnly: true,
          },
          "openai-compatible": {
            legacyOnly: true,
          },
          anthropic: {
            siblingOnly: true,
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "foo-bar", modelId: "reasoning-model" },
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
        providerOptionsName: "foo-bar",
      } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
      statusContext: {
        model: { providerId: "foo-bar", modelId: "reasoning-model" },
        providerKind: "openai-compatible",
        requestId: "req_namespace_pass_through",
        sessionId: "sess_namespace_pass_through",
        traceId: "trace_namespace_pass_through",
      } as never,
    });

    expect(options.providerOptions).toEqual({
      openaiCompatible: {
        extra_body: {
          mode: "legacy",
          thinking: { type: "enabled" },
        },
        mode: "direct",
        reasoningEffort: "max",
      },
      "foo-bar": {
        mode: "direct",
        rawOnly: true,
        reasoningEffort: "max",
        thinking: { type: "enabled" },
      },
      fooBar: {
        camelOnly: true,
      },
      "openai-compatible": {
        legacyOnly: true,
      },
      anthropic: {
        siblingOnly: true,
      },
    });
  });

  it("rejects a non-object canonical extra_body", () => {
    let error: unknown;

    try {
      createGenerateTextOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "hi" }],
          providerOptions: {
            openaiCompatible: {
              extra_body: [],
            },
          },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          ref: { providerId: "custom-compatible", modelId: "reasoning-model" },
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
          providerOptionsName: "Custom Compatible",
        } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
        statusContext: {
          model: { providerId: "custom-compatible", modelId: "reasoning-model" },
          providerKind: "openai-compatible",
          requestId: "req_invalid_extra_body",
          sessionId: "sess_invalid_extra_body",
          traceId: "trace_invalid_extra_body",
        } as never,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AiSdkModelAdapterError);
    expect(error).toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
      message: "openaiCompatible.extra_body 必须是对象",
    } satisfies Partial<AiSdkModelAdapterError>);
  });

  it("passes experimental_include.responseBody for zcode-plan streams", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        ref: { providerId: "builtin:zai-coding-plan", modelId: "glm-5.1" },
        providerKind: "openai-compatible",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan",
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
        ref: { providerId: "openai", modelId: "gpt-5" },
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

  it("packages native OpenAI reasoning effort without dropping static OpenAI options", () => {
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
          ref: { providerId: "openai", modelId: "gpt-5.2" },
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
        openai: {
          reasoningEffort: "none",
          store: false,
        },
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
        ref: { providerId: "test", modelId: "model-a" },
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
        ref: { providerId: "test", modelId: "model-a" },
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
        ref: { providerId: "test", modelId: "model-a" },
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
        ref: { providerId: "test", modelId: "model-a" },
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
          ref: { providerId: "custom-provider", modelId: "kimi-k2.5" },
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

  it("does not add OpenCode Go session header for other providers on the same host", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: { messages: [{ role: "user", content: "hi" }] },
      resolved: resolved({
        baseURL: "https://opencode.ai/zen/v1",
        model: {} as ResolvedAiSdkModel["model"],
        providerKind: "openai-compatible",
        ref: { providerId: "custom-provider", modelId: "kimi-k2.5" },
      }),
      statusContext: {
        model: { providerId: "custom-provider", modelId: "kimi-k2.5" },
        modelRequestSessionType: "main",
        providerKind: "openai-compatible",
        requestId: "req_opencode_zen",
        sessionId: "sess_conversation_stable",
        traceId: "trace_opencode_zen",
      } as never,
    });

    expect(options.headers).not.toHaveProperty("x-opencode-session");
  });
});

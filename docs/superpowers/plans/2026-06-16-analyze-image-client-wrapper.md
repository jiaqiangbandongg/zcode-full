# AnalyzeImage Client Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 ZCode client-side `AnalyzeImage` 工具，内部通过单独模型请求只带 provider-native `analyze_image` 工具，避免 provider 自发输出的 `analyze_image` transcript 被误当作普通 ZCode 工具执行。

**Architecture:** 公开工具面只暴露 `AnalyzeImage`，不把 provider-native `analyze_image` 暴露到主 turn。`AnalyzeImage` handler 复用现有图片读取/压缩能力，把本地图片和用户问题发到 `querySource: "analyze_image_tool"` 的内部流式模型请求；adapter 只在这个内部请求的工具名为 `analyze_image` 时把函数工具投影成 provider-native `analyze_image`。主 turn 中未经请求的 `server_tool_use analyze_image` 仍按 provider anomaly 隔离，不进入 Bash 或任意本地工具调度。

**Tech Stack:** TypeScript、Zod、Vercel AI SDK v6、`@zcode/contracts`、`@zcode/core` tool runtime、Vitest、现有 model-io/fake-fetch 验证链路。

---

## 设计边界

- `AnalyzeImage` 是 ZCode client-side built-in tool，模型可见名称使用 PascalCase：`AnalyzeImage`。
- `analyze_image` 是 provider-native server tool 名称，只允许出现在 `AnalyzeImage` 内部 side request。
- v1 输入显式使用本地图片路径：`image_path` 和可选 `prompt`。不在 v1 中实现“从整个历史里自动猜当前图片”的隐式图片选择，避免把 prompt attachment、Read image result、MCP image artifact 三类来源混在一起。
- 图片读取复用 `apps/zcode-cli/packages/core/src/tool/handlers/read-image.ts` 的 `inferImageMimeFromPath()` 与 `readImageFile()`，继承当前跨平台文件读取、尺寸限制、压缩和错误语义。
- enable 逻辑对齐 `WebSearch`：只有 provider connection 满足 `providerKind === "anthropic"` 且 baseURL 命中 allowlist 时，主工具池才暴露 `AnalyzeImage`。
- provider-visible 验收面是最终 HTTP request body，不是中间 `ModelToolContract`：
  - 主 turn `request.body.tools` 包含 `AnalyzeImage` function tool，不包含 provider-native `analyze_image`。
  - `querySource: "analyze_image_tool"` 的内部请求 `request.body.tools` 只包含 `{"type":"analyze_image","name":"analyze_image"}`。
  - provider 未授权输出的主 turn `server_tool_use analyze_image` 不产生可执行 ZCode tool call。

## 文件结构

- Create: `apps/zcode-cli/packages/contracts/src/tools/analyze-image.ts`
  - 定义 `AnalyzeImageInputSchema`、`AnalyzeImageOutputSchema`、provider-native spec、baseURL allowlist 和参数转换。
- Modify: `apps/zcode-cli/packages/contracts/src/tools/index.ts`
  - 导出 `analyze-image.ts`。
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image.ts`
  - 实现 client-side tool handler、内部 side request、结果格式化。
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image-support.ts`
  - 实现 provider enable 检查、statusSink、trace helper，结构对齐 `websearch-support.ts`。
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
  - 注册 `analyzeImageToolEntry`。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
  - 用 `supportsProviderNativeAnalyzeImage()` 过滤工具暴露。
- Modify: `apps/zcode-cli/packages/adapters/src/model/tool-transform.ts`
  - 为内部 provider-native `AnalyzeImage` 合同生成 `analyze_image` sentinel function tool。
- Modify: `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts`
  - 在发给 Anthropic-compatible provider 前，把 sentinel function tool 改写为 provider-native `analyze_image`。
  - 在主 turn 中隔离未授权 `server_tool_use analyze_image` 流式块。
- Create: `apps/zcode-cli/packages/contracts/tests/analyze-image.test.ts`
- Create: `apps/zcode-cli/packages/core/tests/analyze-image.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/websearch.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/registry.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/runner.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`

---

### Task 1: 新增 AnalyzeImage contracts

**Files:**
- Create: `apps/zcode-cli/packages/contracts/src/tools/analyze-image.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/tools/index.ts`
- Test: `apps/zcode-cli/packages/contracts/tests/analyze-image.test.ts`

- [ ] **Step 1: 写 contracts 失败测试**

```ts
import {
  AnalyzeImageInputSchema,
  isAnalyzeImageCapableBaseURL,
  toAnalyzeImageProviderNativeArgs,
} from "../src/index.js";

describe("analyze-image contracts", () => {
  it("accepts explicit local image path input", () => {
    expect(
      AnalyzeImageInputSchema.safeParse({
        image_path: "/tmp/screen.png",
        prompt: "读出图片中的错误信息",
      }).success,
    ).toBe(true);
  });

  it("rejects missing image_path", () => {
    expect(AnalyzeImageInputSchema.safeParse({ prompt: "看图" }).success).toBe(false);
  });

  it.each([
    "https://open.bigmodel.cn/api/anthropic/v1",
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    "https://api.z.ai/anthropic",
  ])("allows AnalyzeImage-capable host %s", (baseURL) => {
    expect(isAnalyzeImageCapableBaseURL(baseURL)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "https://api.openai.com/v1",
    "https://example.test/anthropic",
  ])("denies AnalyzeImage-incapable host %s", (baseURL) => {
    expect(isAnalyzeImageCapableBaseURL(baseURL)).toBe(false);
  });

  it("maps prompt to provider-native args", () => {
    expect(
      toAnalyzeImageProviderNativeArgs({
        image_path: "/tmp/screen.png",
        prompt: "提取文字",
      }),
    ).toEqual({ prompt: "提取文字" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @zcode/contracts test -- analyze-image.test.ts
```

Expected: fail，错误包含 `Cannot find module` 或 `AnalyzeImageInputSchema` 未导出。

- [ ] **Step 3: 新增 contract 文件**

Create `apps/zcode-cli/packages/contracts/src/tools/analyze-image.ts`:

```ts
import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ProviderNativeToolSpec, ToolContractDeclaration } from "./contract.js";

const ANALYZE_IMAGE_CAPABLE_BASE_HOSTS = ["bigmodel.cn", "z.ai", "z.ai"];

export const AnalyzeImageInputSchema = z
  .object({
    image_path: z
      .string()
      .trim()
      .min(1)
      .describe("Local image file path to analyze"),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe("Question or instruction for analyzing the image"),
  })
  .strict();

export type AnalyzeImageInput = z.infer<typeof AnalyzeImageInputSchema>;

export const AnalyzeImageInputJsonSchema = toToolJsonSchema(AnalyzeImageInputSchema);

const AnalyzeImageModelUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  })
  .strict();

export const AnalyzeImageOutputSchema = z
  .object({
    imagePath: z.string(),
    prompt: z.string().optional(),
    analysis: z.string(),
    durationMs: z.number().nonnegative(),
    modelUsage: AnalyzeImageModelUsageSchema.optional(),
  })
  .strict();

export type AnalyzeImageOutput = z.infer<typeof AnalyzeImageOutputSchema>;

export const AnalyzeImageOutputJsonSchema = toToolJsonSchema(AnalyzeImageOutputSchema);

export interface AnalyzeImageProviderNativeArgs extends Record<string, unknown> {
  prompt?: string;
}

export function toAnalyzeImageProviderNativeArgs(
  input: AnalyzeImageInput,
): AnalyzeImageProviderNativeArgs {
  return input.prompt ? { prompt: input.prompt } : {};
}

export function isAnalyzeImageCapableBaseURL(baseURL: string | undefined): boolean {
  const host = hostnameFromBaseURL(baseURL);
  if (!host) return false;
  return ANALYZE_IMAGE_CAPABLE_BASE_HOSTS.some(
    (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`),
  );
}

function hostnameFromBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
}

export const ANALYZE_IMAGE_PROVIDER_NATIVE_SPEC: ProviderNativeToolSpec = {
  kind: "provider_native",
  logicalName: "AnalyzeImage",
  providerToolName: "analyze_image",
  fallback: "disabled",
};

export const ANALYZE_IMAGE_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "analyze_image",
  executionMode: "client",
  inputSchema: AnalyzeImageInputJsonSchema,
  outputSchema: AnalyzeImageOutputJsonSchema,
  permission: {
    permission: "read",
    reason: "AnalyzeImage reads a local image file and sends it to an internal provider-native image analysis request",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 10_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: {
      maxLines: 30,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 60_000,
    maxMs: 120_000,
    allowCallOverride: true,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "AnalyzeImage was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "full",
    recordOutput: "summary",
  },
};
```

- [ ] **Step 4: 导出 contract**

Modify `apps/zcode-cli/packages/contracts/src/tools/index.ts`:

```ts
export * from "./analyze-image.js";
```

- [ ] **Step 5: 运行 contracts 测试确认通过**

Run:

```bash
pnpm --filter @zcode/contracts test -- analyze-image.test.ts
```

Expected: pass。

- [ ] **Step 6: Commit**

```bash
git add apps/zcode-cli/packages/contracts/src/tools/analyze-image.ts apps/zcode-cli/packages/contracts/src/tools/index.ts apps/zcode-cli/packages/contracts/tests/analyze-image.test.ts
git commit -m "feat(zcode-cli): add analyze image tool contract"
```

### Task 2: 新增 core AnalyzeImage tool handler

**Files:**
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image-support.ts`
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Test: `apps/zcode-cli/packages/core/tests/analyze-image.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`

- [ ] **Step 1: 写 handler 失败测试**

Add to `apps/zcode-cli/packages/core/tests/analyze-image.test.ts`:

```ts
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createSessionId } from "@zcode/contracts";
import { SessionEventType, ModelRole, type ModelRef } from "@zcode/contracts";
import { createTestSessionEventStore } from "./helpers/session-event-store.js";

const modelRef: ModelRef = {
  providerId: "builtin:bigmodel" as never,
  modelId: "glm-5.1" as never,
  role: ModelRole.Main,
};

describe("AnalyzeImage client wrapper", () => {
  it("runs an internal streaming provider-native analyze_image request", async () => {
    const sessionId = createSessionId("runtime-analyze-image-handler-side-request");
    const eventStore = createTestSessionEventStore();
    const requests: any[] = [];
    let mainRequestCount = 0;

    const runtime = new AgentRuntime(
      sessionId,
      { modelRef },
      {
        eventStore,
        fileSystem: {
          async readBinaryFile() {
            return { content: Buffer.from("png-data"), sizeBytes: 8 };
          },
        } as never,
        imageProcessorPort: {
          async prepareForModel() {
            return {
              data: Buffer.from("prepared-png"),
              mediaType: "image/png",
              originalWidth: 1,
              originalHeight: 1,
              width: 1,
              height: 1,
              resized: false,
              compressed: false,
              transformedSizeBytes: 12,
              strategy: "preserve-format",
            };
          },
        } as never,
        modelAdapter: {
          async generateText(request: any) {
            if (request.metadata?.querySource === "analyze_image_tool") {
              throw new Error("AnalyzeImage side request must use streamText");
            }
            mainRequestCount++;
            if (mainRequestCount === 1) {
              return {
                finishReason: "tool-calls",
                model: request.model,
                text: "",
                toolCalls: [
                  {
                    id: "call_analyze_image",
                    input: {
                      image_path: "screen.png",
                      prompt: "图片里写了什么",
                    },
                    name: "AnalyzeImage",
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              model: request.model,
              text: "最终答案",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
          async *streamText(request: any) {
            requests.push(request);
            if (request.metadata?.querySource !== "analyze_image_tool") {
              throw new Error("Unexpected streaming request");
            }
            yield { type: "start" };
            yield { id: "text_1", type: "text_start" };
            yield {
              id: "text_1",
              text: "图片中显示：您尚未登录",
              type: "text_delta",
            };
            yield { id: "text_1", type: "text_end" };
            yield {
              finishReason: "stop",
              providerMetadata: { rawFinishReason: "end_turn" },
              type: "finish",
              usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
            };
          },
          resolveConnection() {
            return {
              baseURL: "https://open.bigmodel.cn/api/anthropic/v1",
              model: modelRef,
              providerId: "builtin:bigmodel",
              providerKind: "anthropic",
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("分析 screen.png");

    const innerRequest = requests.find(
      (request) => request.metadata?.querySource === "analyze_image_tool",
    );
    expect(innerRequest).toBeDefined();
    expect(innerRequest.tools.map((tool: any) => tool.name)).toEqual(["analyze_image"]);
    expect(innerRequest.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image", mediaType: "image/png" }),
      ]),
    );
    expect(innerRequest.tools[0]).toMatchObject({
      executionMode: "providerNative",
      providerNative: expect.objectContaining({
        logicalName: "AnalyzeImage",
        providerToolName: "analyze_image",
      }),
    });

    const storedEvents = await eventStore.getEvents(sessionId);
    expect(
      storedEvents.some(
        (event: any) =>
          event.type === SessionEventType.ToolCallStarted &&
          event.payload?.toolName === "AnalyzeImage",
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 写工具暴露测试**

Add to `apps/zcode-cli/packages/core/tests/analyze-image.test.ts`:

```ts
it("exposes AnalyzeImage only for supported Anthropic-compatible hosts", () => {
  const supported = createRuntime("analyze-image-supported", {
    baseURL: "https://open.bigmodel.cn/api/anthropic/v1",
    providerKind: "anthropic",
  });
  expect(supported.getTools().some((tool) => tool.name === "AnalyzeImage")).toBe(true);

  const unsupported = createRuntime("analyze-image-unsupported", {
    baseURL: "https://example.test/v1",
    providerKind: "anthropic",
  });
  expect(unsupported.getTools().some((tool) => tool.name === "AnalyzeImage")).toBe(false);
});
```

Use the same local `createRuntime(...)` helper shape as the WebSearch tests in `apps/zcode-cli/packages/core/tests/websearch.test.ts`; keep `modelConnectionPort.resolveConnection()` returning the provided `baseURL` and `providerKind`.

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
pnpm --filter @zcode/core test -- analyze-image.test.ts
```

Expected: fail，错误包含 `AnalyzeImage` 未注册或 handler 文件不存在。

- [ ] **Step 4: 新增 support helper**

Create `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image-support.ts`:

```ts
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  isAnalyzeImageCapableBaseURL,
  type ModelConnectionInfo,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";

const ANALYZE_IMAGE_TOOL_NAME = "AnalyzeImage";

export function resolveAnalyzeImageModelConnection(
  context: ToolExecutionContext,
): ModelConnectionInfo {
  if (!context.modelConnectionPort || !context.modelRef) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ModelConnectionPort is required to check AnalyzeImage provider support",
      {
        context: { toolCallId: context.toolCallId, toolName: ANALYZE_IMAGE_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  try {
    return context.modelConnectionPort.resolveConnection(context.modelRef);
  } catch (error) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Failed to resolve AnalyzeImage model",
      {
        cause: error instanceof Error ? error : undefined,
        context: { toolCallId: context.toolCallId, toolName: ANALYZE_IMAGE_TOOL_NAME },
        recoverable: false,
      },
    );
  }
}

export function assertProviderSupportsAnalyzeImage(
  connection: ModelConnectionInfo,
  toolCallId: string,
): void {
  if (!supportsProviderNativeAnalyzeImage(connection)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Current provider/model does not support native AnalyzeImage",
      {
        context: {
          baseURL: connection.baseURL,
          providerKind: connection.providerKind,
          toolCallId,
          toolName: ANALYZE_IMAGE_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }
}

export function supportsProviderNativeAnalyzeImage(
  connection: Pick<ModelConnectionInfo, "baseURL" | "providerKind">,
): boolean {
  return (
    connection.providerKind === "anthropic" &&
    isAnalyzeImageCapableBaseURL(connection.baseURL)
  );
}

export function createAnalyzeImageModelStatusSink(
  context: ToolExecutionContext,
): ModelStatusSink | undefined {
  if (!context.emitEvent) return undefined;

  return {
    publish: async (statusEvent: ModelNetworkStatusEvent) => {
      await context.emitEvent?.({
        id: crypto.randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: statusEvent,
      });
    },
  };
}

export function analyzeImageTraceFromContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      toolCallId: context.toolCallId,
      toolName: ANALYZE_IMAGE_TOOL_NAME,
    },
  };
}
```

- [ ] **Step 5: 新增 handler**

Create `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image.ts`:

```ts
import path from "node:path";
import {
  ANALYZE_IMAGE_PROVIDER_NATIVE_SPEC,
  ANALYZE_IMAGE_TOOL_CONTRACT,
  AnalyzeImageInputJsonSchema,
  AnalyzeImageInputSchema,
  AnalyzeImageOutputJsonSchema,
  AnalyzeImageOutputSchema,
  CoreErrorType,
  ModelRole,
  createCoreError,
  hasModelUsage,
  toAnalyzeImageProviderNativeArgs,
  type AnalyzeImageInput,
  type AnalyzeImageOutput,
  type ModelStreamEvent,
  type ModelTextRequest,
  type ModelTextResult,
  type ModelUsage,
  type ModelToolCall,
  type ModelToolContract,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { inferImageMimeFromPath, readImageFile } from "./read-image.js";
import {
  analyzeImageTraceFromContext,
  assertProviderSupportsAnalyzeImage,
  createAnalyzeImageModelStatusSink,
  resolveAnalyzeImageModelConnection,
} from "./analyze-image-support.js";

const ANALYZE_IMAGE_TOOL_NAME = "AnalyzeImage";
const PROVIDER_ANALYZE_IMAGE_TOOL_NAME = "analyze_image";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT = "Analyze the attached image and return the relevant visual details.";

const analyzeImageHandler: ToolHandler<AnalyzeImageInput, AnalyzeImageOutput> = async (
  input,
  context,
) => {
  const startedAt = Date.now();
  if (!context.modelPort || !context.modelRef) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ModelPort and modelRef are required for AnalyzeImage",
      {
        context: { toolCallId: context.toolCallId, toolName: ANALYZE_IMAGE_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const connection = resolveAnalyzeImageModelConnection(context);
  assertProviderSupportsAnalyzeImage(connection, context.toolCallId);

  const absolutePath = path.isAbsolute(input.image_path)
    ? input.image_path
    : path.resolve(context.workingDirectory, input.image_path);
  const mimeType = inferImageMimeFromPath(absolutePath);
  if (!mimeType) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Unsupported image file type", {
      context: {
        imagePath: input.image_path,
        toolCallId: context.toolCallId,
        toolName: ANALYZE_IMAGE_TOOL_NAME,
      },
      recoverable: true,
    });
  }

  const image = await readImageFile(absolutePath, mimeType, context);
  const prompt = input.prompt?.trim() || DEFAULT_PROMPT;
  const request: ModelTextRequest = {
    model: {
      ...context.modelRef,
      role: context.modelRef.role ?? ModelRole.Main,
    },
    messages: [
      {
        role: "system",
        content: "You are an assistant for performing an image analysis tool use.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image",
            mediaType: image.mimeType,
            dataUrl: `data:${image.mimeType};base64,${image.base64}`,
            source: {
              id: `analyze-image:${context.toolCallId}`,
              kind: "local_file",
              path: absolutePath,
              mimeType: image.mimeType,
              sizeBytes: image.transformedSize ?? image.originalSize,
              placeholder: input.image_path,
            },
          },
        ],
      },
    ],
    tools: [createProviderNativeAnalyzeImageContract(input)],
    maxOutputTokens: 4096,
    abortSignal: context.abortSignal,
    metadata: {
      traceId: context.traceId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      toolName: ANALYZE_IMAGE_TOOL_NAME,
      querySource: "analyze_image_tool",
    },
    statusSink: createAnalyzeImageModelStatusSink(context),
    traceContext: analyzeImageTraceFromContext(context),
  };

  const result = await collectAnalyzeImageStreamResult({
    events: context.modelPort.streamText(request),
    model: request.model,
  });
  const analysis = result.text.trim();
  if (!analysis) {
    throw createCoreError(CoreErrorType.ModelError, "AnalyzeImage returned no analysis text", {
      context: { toolCallId: context.toolCallId, toolName: ANALYZE_IMAGE_TOOL_NAME },
      recoverable: true,
    });
  }

  return {
    imagePath: input.image_path,
    prompt: input.prompt,
    analysis,
    durationMs: Date.now() - startedAt,
    modelUsage: hasModelUsage(result.usage) ? result.usage : undefined,
  };
};
```

Add the helper functions in the same file:

```ts
export const analyzeImageToolEntry: ToolEntry = {
  ...ANALYZE_IMAGE_TOOL_CONTRACT,
  providerNative: undefined,
  metadata: {
    name: ANALYZE_IMAGE_TOOL_NAME,
    description:
      "Analyze a local image file using the provider's native image analysis capability.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: 20_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: analyzeImageHandler as ToolHandler,
  formatModelContent: formatAnalyzeImageModelContent,
  inputSchema: AnalyzeImageInputJsonSchema,
  outputSchema: AnalyzeImageOutputJsonSchema,
  runtimeInputSchema: AnalyzeImageInputSchema,
  runtimeOutputSchema: AnalyzeImageOutputSchema,
};

function createProviderNativeAnalyzeImageContract(input: AnalyzeImageInput): ModelToolContract {
  return {
    name: PROVIDER_ANALYZE_IMAGE_TOOL_NAME,
    capability: "analyze_image",
    description: "Provider-native image analysis used internally by the AnalyzeImage tool",
    executionMode: "providerNative",
    providerNative: {
      ...ANALYZE_IMAGE_PROVIDER_NATIVE_SPEC,
      args: toAnalyzeImageProviderNativeArgs(input),
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    outputSchema: { type: "object" },
  };
}

function formatAnalyzeImageModelContent(output: unknown): string {
  const parsed = AnalyzeImageOutputSchema.safeParse(output);
  if (!parsed.success) return JSON.stringify(output) ?? "";
  const data = parsed.data;
  return [
    `Image analysis for: ${data.imagePath}`,
    data.prompt ? `Prompt: ${data.prompt}` : undefined,
    "",
    data.analysis,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trim();
}

async function collectAnalyzeImageStreamResult(input: {
  events: AsyncIterable<ModelStreamEvent>;
  model: ModelTextRequest["model"];
}): Promise<ModelTextResult> {
  let text = "";
  let finishReason = "unknown";
  let providerMetadata: Record<string, unknown> | undefined;
  let usage: ModelUsage = {};
  const toolCalls: ModelToolCall[] = [];

  for await (const event of input.events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "tool_call":
        toolCalls.push(event.toolCall);
        break;
      case "finish":
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;
      case "error":
        throw normalizeStreamError(event.error);
    }
  }

  return {
    finishReason,
    model: input.model,
    providerMetadata,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) return error;
  return createCoreError(CoreErrorType.ModelError, "AnalyzeImage stream failed", {
    context: { error },
    recoverable: true,
  });
}
```

- [ ] **Step 6: 注册内建工具**

Modify `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`:

```ts
import { analyzeImageToolEntry } from "./analyze-image.js";
```

Add it near `webSearchToolEntry`:

```ts
  webFetchToolEntry,
  webSearchToolEntry,
  analyzeImageToolEntry,
```

- [ ] **Step 7: 添加 runtime visible filter**

Modify `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`:

```ts
import { supportsProviderNativeAnalyzeImage } from "../../tool/handlers/analyze-image-support.js";
```

Replace the filter body with:

```ts
  return tools.filter((tool) => {
    if (tool.name === "WebSearch") return shouldExposeWebSearch.call(this);
    if (tool.name === "AnalyzeImage") return shouldExposeAnalyzeImage.call(this);
    return true;
  });
```

Add:

```ts
function shouldExposeAnalyzeImage(this: AgentRuntimeInternal): boolean {
  if (!this.modelConnectionPort) return false;

  try {
    const connection = this.modelConnectionPort.resolveConnection(this.defaultModelRef);
    return supportsProviderNativeAnalyzeImage(connection);
  } catch {
    return false;
  }
}
```

- [ ] **Step 8: 更新 main tool pool 断言**

Modify `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts` in the supported provider case:

```ts
expect(toolNames).toContain("AnalyzeImage");
```

Add an unsupported provider assertion:

```ts
expect(
  createRuntime("runtime-analyze-image-provider-deny", {
    modelConnectionPort: {
      resolveConnection: () => ({
        baseURL: "https://example.test/v1",
        model: modelRef,
        providerId: "test",
        providerKind: "anthropic",
      }),
    },
  }).getTools().some((tool) => tool.name === "AnalyzeImage"),
).toBe(false);
```

- [ ] **Step 9: 运行 core 测试确认通过**

Run:

```bash
pnpm --filter @zcode/core test -- analyze-image.test.ts main-tool-pool.test.ts
```

Expected: pass。

- [ ] **Step 10: Commit**

```bash
git add apps/zcode-cli/packages/core/src/tool/handlers/analyze-image.ts apps/zcode-cli/packages/core/src/tool/handlers/analyze-image-support.ts apps/zcode-cli/packages/core/src/tool/handlers/index.ts apps/zcode-cli/packages/core/src/runtime/methods/config.ts apps/zcode-cli/packages/core/tests/analyze-image.test.ts apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts
git commit -m "feat(zcode-cli): add AnalyzeImage client wrapper"
```

### Task 3: Adapter 投影 provider-native analyze_image

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/model/tool-transform.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/websearch.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/registry.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/runner.test.ts`

- [ ] **Step 1: 写 tool-transform 失败测试**

Add to `apps/zcode-cli/packages/adapters/tests/websearch.test.ts` or split a new `analyze-image.test.ts` in the same package:

```ts
function createInternalProviderNativeAnalyzeImageContract(): ModelToolContract {
  return {
    name: "analyze_image",
    capability: "analyze_image",
    description: "Provider-native image analysis used internally by AnalyzeImage",
    executionMode: "providerNative",
    providerNative: {
      kind: "provider_native",
      logicalName: "AnalyzeImage",
      providerToolName: "analyze_image",
      fallback: "disabled",
      args: { prompt: "读图" },
    },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
  };
}

it("keeps the public AnalyzeImage model-facing tool as AnalyzeImage", () => {
  const tools = toAiSdkTools([
    {
      name: "AnalyzeImage",
      description: "Analyze a local image file",
      inputSchema: { type: "object", properties: {} },
    } as ModelToolContract,
  ]);

  expect(Object.keys(tools ?? {})).toEqual(["AnalyzeImage"]);
});

it("maps internal AnalyzeImage to an analyze_image sentinel function tool", () => {
  const tools = toAiSdkTools([createInternalProviderNativeAnalyzeImageContract()], {
    baseURL: "https://open.bigmodel.cn/api/anthropic/v1",
    providerKind: "anthropic",
  });

  expect(Object.keys(tools ?? {})).toEqual(["analyze_image"]);
  expect(tools?.analyze_image).toMatchObject({
    description: "Provider-native image analysis used internally by AnalyzeImage",
  });
});

it("omits internal AnalyzeImage for unsupported provider hosts", () => {
  expect(
    toAiSdkTools([createInternalProviderNativeAnalyzeImageContract()], {
      baseURL: "https://example.test/v1",
      providerKind: "anthropic",
    }),
  ).toBeUndefined();
});
```

- [ ] **Step 2: 写 request body rewrite 失败测试**

Add to `apps/zcode-cli/packages/adapters/tests/registry.test.ts`:

```ts
it("rewrites internal analyze_image function tools to Anthropic provider-native tools", async () => {
  const fetch = createAnthropicCompatFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ body }), {
      headers: { "content-type": "application/json" },
    });
  });

  const response = await fetch("https://example.test/v1/messages", {
    headers: { "content-type": "application/json" },
    method: "POST",
    body: JSON.stringify({
      model: "glm-5.1",
      messages: [],
      tools: [
        {
          name: "analyze_image",
          description: "Provider-native image analysis used internally by AnalyzeImage",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
  });

  const data = await response.json();
  expect(data.body.tools).toEqual([{ type: "analyze_image", name: "analyze_image" }]);
});

it("does not rewrite public AnalyzeImage function tools", async () => {
  const fetch = createAnthropicCompatFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ body }), {
      headers: { "content-type": "application/json" },
    });
  });

  const response = await fetch("https://example.test/v1/messages", {
    headers: { "content-type": "application/json" },
    method: "POST",
    body: JSON.stringify({
      model: "glm-5.1",
      messages: [],
      tools: [
        {
          name: "AnalyzeImage",
          description: "Public client-side tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
  });

  const data = await response.json();
  expect(data.body.tools[0]).toMatchObject({ name: "AnalyzeImage" });
  expect(data.body.tools[0]).not.toHaveProperty("type", "analyze_image");
});
```

- [ ] **Step 3: 运行 adapter 测试确认失败**

Run:

```bash
pnpm --filter @zcode/adapters test -- websearch.test.ts registry.test.ts
```

Expected: fail，原因是 `AnalyzeImage` provider-native 分支不存在，request body rewrite 不存在。

- [ ] **Step 4: 修改 tool transform**

Modify `apps/zcode-cli/packages/adapters/src/model/tool-transform.ts` imports:

```ts
import {
  isAnalyzeImageCapableBaseURL,
  isWebSearchCapableBaseURL,
  type JsonSchema,
  type ModelToolContract,
} from "@zcode/contracts";
```

Replace provider-native dispatch:

```ts
function toAiSdkProviderNativeTool(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
): ToolSet[string] | undefined {
  switch (contract.providerNative?.logicalName) {
    case "WebSearch":
      return toAiSdkProviderNativeWebSearchTool(contract, options);
    case "AnalyzeImage":
      return toAiSdkProviderNativeAnalyzeImageTool(contract, options);
    default:
      return undefined;
  }
}
```

Keep existing WebSearch logic in `toAiSdkProviderNativeWebSearchTool(...)` and add:

```ts
function toAiSdkProviderNativeAnalyzeImageTool(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
): ToolSet[string] | undefined {
  if (options.providerKind !== "anthropic") {
    return undefined;
  }
  if (!isAnalyzeImageCapableBaseURL(options.baseURL)) {
    return undefined;
  }

  // AI SDK Anthropic provider only allowlists known provider-defined tool ids.
  // ZCode sends a normal function-shaped sentinel here and rewrites it to
  // provider-native analyze_image at the Anthropic-compatible fetch boundary.
  return tool<unknown, never>({
    description: contract.description,
    inputSchema: jsonSchema<unknown>(contract.inputSchema as JsonSchema),
    needsApproval: contract.needsApproval,
    providerOptions: {
      anthropic: {
        eagerInputStreaming: false,
      },
    },
  }) as ToolSet[string];
}
```

- [ ] **Step 5: 修改 Anthropic compat fetch 的 request rewrite**

Modify `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts`:

```ts
const PROVIDER_NATIVE_ANALYZE_IMAGE_TOOL_NAME = "analyze_image";
```

Change `createAnthropicCompatFetch`:

```ts
export function createAnthropicCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const rewrittenInit = rewriteAnthropicAnalyzeImageRequest(init);
    const response = await baseFetch(input, rewrittenInit);
    return rewriteAnthropicJsonThinkingResponse(filterAnthropicStream(response));
  };
}
```

Add request rewrite helpers:

```ts
function rewriteAnthropicAnalyzeImageRequest(init: RequestInit | undefined): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  const parsed = safeParseRecord(init.body);
  if (!parsed || !Array.isArray(parsed.tools)) return init;

  let changed = false;
  const tools = parsed.tools.map((toolValue) => {
    const toolRecord = safeRecord(toolValue);
    if (!toolRecord || toolRecord.name !== PROVIDER_NATIVE_ANALYZE_IMAGE_TOOL_NAME) {
      return toolValue;
    }
    if (!("input_schema" in toolRecord)) {
      return toolValue;
    }
    changed = true;
    return {
      type: PROVIDER_NATIVE_ANALYZE_IMAGE_TOOL_NAME,
      name: PROVIDER_NATIVE_ANALYZE_IMAGE_TOOL_NAME,
    };
  });

  if (!changed) return init;
  return {
    ...init,
    body: JSON.stringify({
      ...parsed,
      tools,
    }),
  };
}
```

- [ ] **Step 6: 隔离主 turn 未授权 analyze_image server_tool_use**

Modify `shouldEmitFrame(...)` in `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts`.

Add `suppressedProviderToolUseIds` state to the transform and suppress `server_tool_use analyze_image` plus matching bare `tool_result` when it appears in provider output without being part of the side request. The initial implementation can key off the stream content only:

```ts
const suppressedProviderToolUseIds = new Set<string>();
```

In `content_block_start` handling:

```ts
const contentBlock = safeRecord(parsed.content_block);
if (
  type === "content_block_start" &&
  contentBlock?.type === "server_tool_use" &&
  contentBlock.name === PROVIDER_NATIVE_ANALYZE_IMAGE_TOOL_NAME
) {
  const toolUseId = typeof contentBlock.id === "string" ? contentBlock.id : undefined;
  if (toolUseId) suppressedProviderToolUseIds.add(toolUseId);
  suppressedIndexes.add(index);
  return false;
}

if (
  type === "content_block_start" &&
  contentBlock?.type === "tool_result" &&
  typeof contentBlock.tool_use_id === "string" &&
  suppressedProviderToolUseIds.has(contentBlock.tool_use_id)
) {
  suppressedIndexes.add(index);
  suppressedProviderToolUseIds.delete(contentBlock.tool_use_id);
  return false;
}
```

Keep the existing generic bare `tool_result` suppression after this specific branch. This preserves typed `web_search_tool_result` behavior.

- [ ] **Step 7: 增加 final request body 验证**

Add to `apps/zcode-cli/packages/adapters/tests/runner.test.ts` a fake-fetch test that executes `streamText` with a side request containing only internal provider-native `AnalyzeImage` and asserts the captured JSON body:

```ts
expect(capturedBody.tools).toEqual([{ type: "analyze_image", name: "analyze_image" }]);
expect(capturedBody.tools).not.toContainEqual(expect.objectContaining({ name: "AnalyzeImage" }));
```

Add a second main-turn request body assertion:

```ts
expect(JSON.stringify(capturedMainBody.tools)).toContain("AnalyzeImage");
expect(JSON.stringify(capturedMainBody.tools)).not.toContain('"type":"analyze_image"');
```

- [ ] **Step 8: 运行 adapter 测试确认通过**

Run:

```bash
pnpm --filter @zcode/adapters test -- websearch.test.ts registry.test.ts runner.test.ts
```

Expected: pass。

- [ ] **Step 9: Commit**

```bash
git add apps/zcode-cli/packages/adapters/src/model/tool-transform.ts apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts apps/zcode-cli/packages/adapters/tests/websearch.test.ts apps/zcode-cli/packages/adapters/tests/registry.test.ts apps/zcode-cli/packages/adapters/tests/runner.test.ts
git commit -m "feat(zcode-cli): route analyze image through provider-native side request"
```

### Task 4: Provider anomaly 与损坏 tool input 回归

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/tests/registry.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/streaming-tool-call-assembler.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/registry.test.ts`

- [ ] **Step 1: 写未授权 transcript 隔离测试**

Replace the current assertion in `filters assistant-side bare tool_result content blocks from Anthropic SSE` so it no longer expects `server_tool_use` to remain visible:

```ts
expect(text).toContain("Output already summarized");
expect(text).toContain("The image says");
expect(text).not.toContain('"type":"server_tool_use"');
expect(text).not.toContain('"name":"analyze_image"');
expect(text).not.toContain('"type":"tool_result"');
expect(text).not.toContain('"index":2');
expect(text).not.toContain('"index":4');
```

Add a malformed-input regression:

```ts
it("drops malformed provider-injected analyze_image input before tool input normalization", async () => {
  const fetch = createAnthropicCompatFetch(async () =>
    sseResponse([
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "call_image",
          name: "analyze_image",
          input: {},
        },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"" },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]),
  );

  const response = await fetch("https://example.test/v1/messages");
  const text = await response.text();
  expect(text).not.toContain("analyze_image");
  expect(text).not.toContain("partial_json");
});
```

- [ ] **Step 2: 运行测试确认失败或确认现有测试需要更新**

Run:

```bash
pnpm --filter @zcode/adapters test -- registry.test.ts
```

Expected before implementation: fail，当前实现仍保留 `server_tool_use analyze_image`。

- [ ] **Step 3: 完成 stream suppression**

If Task 3 Step 6 did not already finish the suppression, finish it here. The final behavior must suppress all frames for the `server_tool_use analyze_image` block and matching `tool_result` block. Add a Chinese comment at the suppression point:

```ts
// 修复原因：部分 Anthropic-compatible provider 会在未请求 analyze_image 时返回
// server_tool_use transcript；这不是 ZCode 注册的工具调用，必须在进入 AI SDK
// tool input normalization 前隔离，避免损坏参数继续流向 Bash 或普通工具调度。
```

- [ ] **Step 4: 增加 assembler 防线**

Add an adapter-level guard in `streaming-tool-call-assembler.ts` so provider-executed `analyze_image` cannot become a ZCode-executable tool call even if a future provider response shape bypasses fetch-level frame suppression:

```ts
const UNAUTHORIZED_PROVIDER_TOOL_NAMES = new Set(["analyze_image"]);

private handleToolInputStart(
  event: Extract<ModelStreamEvent, { type: "tool_input_start" }>,
): ModelStreamEvent[] {
  if (
    event.providerExecuted === true &&
    UNAUTHORIZED_PROVIDER_TOOL_NAMES.has(event.toolName)
  ) {
    this.logger?.warn("Unauthorized provider-executed tool input suppressed", {
      event: "model.provider_tool.unauthorized_suppressed",
      module: "adapters.model.streaming-tool-call-assembler",
      toolCallId: event.id,
      toolName: event.toolName,
    });
    this.emittedToolCallIds.add(event.id);
    return [];
  }
  ...
}
```

The side request does not rely on `tool_call` events from provider-native `analyze_image`; it consumes final text. Suppressing this provider-executed tool input in the assembler is therefore safe for both main turn anomaly output and the internal `AnalyzeImage` request.

- [ ] **Step 5: 运行 anomaly 测试确认通过**

Run:

```bash
pnpm --filter @zcode/adapters test -- registry.test.ts
```

Expected: pass，且 test output 不包含 `model.tool_input.normalize_failed`。

- [ ] **Step 6: Commit**

```bash
git add apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts apps/zcode-cli/packages/adapters/src/model/streaming-tool-call-assembler.ts apps/zcode-cli/packages/adapters/tests/registry.test.ts
git commit -m "fix(zcode-cli): isolate unauthorized analyze_image provider tool output"
```

### Task 5: 端到端 provider-visible 验收

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/analyze-image.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/runner.test.ts`
- Optional generated evidence: local model-io debug JSONL, not committed

- [ ] **Step 1: 验证主 turn tool surface**

Run:

```bash
pnpm --filter @zcode/core test -- analyze-image.test.ts main-tool-pool.test.ts
```

Expected:

```text
PASS apps/zcode-cli/packages/core/tests/analyze-image.test.ts
PASS apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts
```

- [ ] **Step 2: 验证 adapter final request body**

Run:

```bash
pnpm --filter @zcode/adapters test -- runner.test.ts registry.test.ts websearch.test.ts
```

Expected:

```text
PASS apps/zcode-cli/packages/adapters/tests/runner.test.ts
PASS apps/zcode-cli/packages/adapters/tests/registry.test.ts
PASS apps/zcode-cli/packages/adapters/tests/websearch.test.ts
```

The `runner.test.ts` assertions must prove:

```ts
expect(capturedAnalyzeImageSideRequest.tools).toEqual([
  { type: "analyze_image", name: "analyze_image" },
]);
expect(JSON.stringify(capturedMainTurn.tools)).toContain("AnalyzeImage");
expect(JSON.stringify(capturedMainTurn.tools)).not.toContain('"type":"analyze_image"');
```

- [ ] **Step 3: 运行 focused packages**

Run:

```bash
pnpm --filter @zcode/contracts test -- analyze-image.test.ts
pnpm --filter @zcode/core test -- analyze-image.test.ts main-tool-pool.test.ts
pnpm --filter @zcode/adapters test -- runner.test.ts registry.test.ts websearch.test.ts
```

Expected: all pass。

- [ ] **Step 4: 运行强制机械验证**

Run from repository root:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0。If either command fails because of pre-existing unrelated files, capture the failing file list and run the narrower package-level command that covers the changed files before reporting the residual root-level failure.

- [ ] **Step 5: 用真实或 fake model-io 检查 request.body.tools**

Run a local fake-fetch or model-io capture around a prompt that calls:

```text
请用 AnalyzeImage 分析 ./screen.png 中的文字
```

Acceptance:

```json
{
  "main_turn": {
    "tools_contains": ["AnalyzeImage"],
    "tools_not_contains": ["\"type\":\"analyze_image\""]
  },
  "analyze_image_tool": {
    "tools": [{ "type": "analyze_image", "name": "analyze_image" }]
  }
}
```

Do not treat a green object-level `ModelToolContract` test as sufficient without this final request-body check.

- [ ] **Step 6: Commit**

```bash
git add apps/zcode-cli/packages/contracts apps/zcode-cli/packages/core apps/zcode-cli/packages/adapters
git commit -m "test(zcode-cli): verify AnalyzeImage provider-visible request bodies"
```

## 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| AI SDK 不支持任意 Anthropic provider-defined tool | `tool({ type: "provider", id: "anthropic.analyze_image" })` 会被 prepare-tools 丢弃 | 使用 `analyze_image` sentinel function tool，并在 `createAnthropicCompatFetch` 出站 body rewrite 为 provider-native tool |
| provider 在主 turn 未授权注入 `server_tool_use analyze_image` | 产生损坏 tool input，可能继续污染 Bash 或普通工具调度 | 在 Anthropic SSE compat 层按 provider anomaly suppress 未授权 `analyze_image` block 和匹配 `tool_result` |
| handler 隐式选择历史图片 | 容易选错 prompt attachment / Read result / MCP artifact | v1 只支持显式 `image_path`，后续若要支持 attachment id，先新增独立 spec |
| 非支持 provider 暴露 AnalyzeImage | 主模型会调用不可执行工具 | enable 逻辑对齐 WebSearch：`providerKind === "anthropic"` 且 baseURL allowlist |
| Windows 路径与工作目录 | 相对路径解析错误 | 使用 `path.isAbsolute` + `path.resolve(context.workingDirectory, input.image_path)`；文件读取仍经 `FileSystemPort` |
| 生产日志刷爆 | 高频 streaming delta 写入 info | 所有逐 chunk 诊断只用 adapter/core 现有 debug 日志；provider anomaly 只在 suppress 起点打一条 warn |

## Self-Review

- Spec coverage: client-side `AnalyzeImage`、内部单工具 side request、enable gating、request-body 投影、provider anomaly 隔离、图片读取复用、测试与强制验证均有任务覆盖。
- Placeholder scan: 本计划没有 `TBD`、`TODO`、空泛“补测试”步骤；每个代码变更任务都给出目标文件、关键代码和命令。
- Type consistency: public tool 名称统一为 `AnalyzeImage`；provider-native 名称统一为 `analyze_image`；内部 querySource 统一为 `analyze_image_tool`。
- Scope check: v1 不实现历史图片自动选择，不改变 `Read` 图片输出格式，不改变 `WebSearch` 既有 request 结构。

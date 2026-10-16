# Model Media Capability Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对于明确不支持图片或媒体输入的模型，在最终 provider-visible request 构造前把媒体内容替换成稳定的文字占位，避免后续请求因历史图片或 tool 图片反复 400。

**Architecture:** 不在发送图片、拖拽图片、Read/Bash/MCP tool 输出等入口分支做限制；真实 session history 保留原始媒体，provider-visible messages 在 core runtime 最后一跳投影成文字。adapter 侧继续保留第二道兜底，确保绕过 core 的调用也不会把明确 unsupported media 发给 AI SDK provider。

**Tech Stack:** TypeScript, `@zcode/core` runtime, `@zcode/adapters` AI SDK adapter, `@zcode/contracts` model catalog/protocol schemas, Vitest, pnpm.

## Global Constraints

- 执行时不得自动提交 commit，除非用户明确要求。
- 修复 bug 时需要留下中文注释，说明问题原因和为什么这么修。
- 不修改 UI 入口行为，不禁止用户发送、拖拽或通过 tool 产生媒体。
- 不把真实 session history 永久文本化；只影响 provider-visible request、model-io 和轨迹里的请求体。
- 能力判断必须使用三态语义：`true` 表示明确支持，`false` 表示明确不支持，`undefined` 表示未知且不剥离，避免误伤自定义 vision provider。
- 日志走 `debug`，不得记录 data URL 或媒体 payload。
- 修改完成后必须执行 `pnpm typecheck` 和 `pnpm lint`；若耗时或环境阻塞，最终说明未验证项。

---

## Current Root Cause

当前实现有两段能力，但没有接成闭环：

- `apps/zcode-cli/packages/core/src/runtime/helpers/media-budget.ts` 只按请求体字节预算剥离历史媒体，默认保护最新 user media，不知道当前模型是否支持图片。
- `apps/zcode-cli/packages/adapters/src/model/transform.ts` 已经支持 `supportsImages` / `supportsPdf` / `stripMedia`，但 `apps/zcode-cli/packages/adapters/src/model/runner-options.ts` 调 `toAiSdkMessages` 时没有把 resolved model capability 传入。
- `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` 动态切模型只刷新 `contextWindow`、`maxOutputTokens` 和 `modelProviderOptions`，没有刷新媒体输入能力。
- `ModelCapability.supportsImages` 是 boolean；直接读合并后的 capability 会把部分“未声明能力”的自定义模型误判为 false。

---

## File Structure

- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/media-capability.ts`
  - 负责 provider request 的媒体能力投影、占位文本生成、debug 日志上下文。
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`
  - 导出 media capability helper。
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
  - 在 `AgentRuntimeConfig` 增加当前模型输入媒体能力。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
  - `updateConfig` 支持动态刷新媒体能力。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`
  - 在 `projectMessagesForMediaBudget` 之前应用 capability projection。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
  - compact request 保持 text-only；可复用 capability projection 但最终仍由 `maxMediaBytes: 0` 保证无媒体。
- Modify: `apps/zcode-cli/packages/contracts/src/model/catalog.ts`
  - 扩展 catalog override/capability 的 PDF 输入能力字段。
- Modify: `packages/shared/src/zcode-protocol/index.ts`
  - 如 UI 或远程协议需要展示/传递 PDF 能力，补充 optional schema 字段。
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/model-selection.ts`
  - 增加 `resolveRuntimeModelInputCapabilities`，用三态解析当前模型媒体能力。
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
  - 初始化 runtime 时注入当前主模型媒体能力。
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`
  - `setModel` 时同步刷新 runtime 媒体能力。
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
  - provider catalog 热更新影响当前模型时，同步刷新媒体能力。
- Modify: `apps/zcode-cli/packages/bootstrap/src/model-config.ts`
  - 创建 AI SDK registry config 时携带模型媒体能力索引。
- Modify: `apps/zcode-cli/packages/adapters/src/model/registry.ts`
  - `AiSdkResolvedModel` 增加 `inputMediaCapabilities`。
- Modify: `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`
  - 把 resolved media capability 传给 `toAiSdkMessages`。
- Modify: `apps/zcode-cli/packages/adapters/src/model/transform.ts`
  - 把 unsupported media 的兜底文本改为中性占位，不诱导模型每轮道歉。
- Test: `apps/zcode-cli/packages/core/tests/media-capability.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/media-budget.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/model-transform.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/model-transform-tool-media.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/model-config.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`

---

### Task 1: Add Core Media Capability Projection

**Files:**
- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/media-capability.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`
- Test: `apps/zcode-cli/packages/core/tests/media-capability.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ModelInputMediaCapabilities {
    supportsImages?: boolean;
    supportsPdf?: boolean;
  }

  export interface MediaCapabilityProjection {
    messages: ModelInputMessage[];
    omittedMediaCount: number;
    omittedImageCount: number;
    omittedPdfCount: number;
    retainedMediaCount: number;
  }

  export function projectMessagesForMediaCapabilities(
    messages: ModelInputMessage[],
    capabilities: ModelInputMediaCapabilities | undefined,
  ): MediaCapabilityProjection;

  export function logMediaCapabilityProjection(
    logger: Logger | undefined,
    traceContext: TraceContext,
    projection: MediaCapabilityProjection,
    options: { event: string; message: string; model: string },
  ): void;
  ```
- Consumes: `modelMessageContentToText`, `traceContextToLogContext`, `ModelInputMessage`, `ModelMessageContentBlock`.

- [ ] **Step 1: Write failing tests**

  Add `apps/zcode-cli/packages/core/tests/media-capability.test.ts` with cases:

  ```ts
  import { describe, expect, it } from "vitest";
  import type { ModelInputMessage } from "@zcode/contracts";
  import { projectMessagesForMediaCapabilities } from "../src/runtime/helpers/media-capability.js";

  describe("model request media capability projection", () => {
    it("replaces user image blocks when the model explicitly does not support images", () => {
      const messages: ModelInputMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
              source: { id: "image-1", kind: "inline", placeholder: "[image #1]" },
            },
          ],
        },
      ];

      const result = projectMessagesForMediaCapabilities(messages, { supportsImages: false });

      expect(result.omittedMediaCount).toBe(1);
      expect(result.omittedImageCount).toBe(1);
      expect(result.retainedMediaCount).toBe(0);
      expect(result.messages).not.toBe(messages);
      expect(result.messages[0]?.content).toEqual([
        { type: "text", text: "describe this" },
        {
          type: "text",
          text: "[Attached image/png: [image #1]]\n[Media omitted from provider request because the selected model does not support image input.]",
        },
      ]);
    });

    it("keeps image blocks when support is true or unknown", () => {
      const image = {
        type: "image" as const,
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      };
      const messages: ModelInputMessage[] = [{ role: "user", content: [image] }];

      expect(projectMessagesForMediaCapabilities(messages, { supportsImages: true }).messages).toBe(
        messages,
      );
      expect(projectMessagesForMediaCapabilities(messages, {}).messages).toBe(messages);
      expect(projectMessagesForMediaCapabilities(messages, undefined).messages).toBe(messages);
    });

    it("replaces PDF file data when PDF support is explicitly false", () => {
      const messages: ModelInputMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "application/pdf",
              name: "report.pdf",
              dataUrl: "data:application/pdf;base64,cGRm",
            },
          ],
        },
      ];

      const result = projectMessagesForMediaCapabilities(messages, { supportsPdf: false });

      expect(result.omittedPdfCount).toBe(1);
      expect(result.messages[0]?.content).toEqual([
        {
          type: "text",
          text: "[Attached application/pdf: report.pdf]\n[Media omitted from provider request because the selected model does not support PDF input.]",
        },
      ]);
    });
  });
  ```

- [ ] **Step 2: Run tests and verify they fail**

  Run:

  ```bash
  pnpm --filter @zcode/core exec vitest run tests/media-capability.test.ts
  ```

  Expected: fail because `media-capability.ts` does not exist.

- [ ] **Step 3: Implement helper**

  Implement the exported interfaces and functions in `media-capability.ts`.

  Required behavior:
  - If `capabilities?.supportsImages === false`, replace every `image` block with a text block.
  - If `capabilities?.supportsPdf === false`, replace `file` blocks whose `mediaType` is `application/pdf` and whose provider-visible payload is `dataUrl` without extracted `text`.
  - If capability is `true` or `undefined`, keep media unchanged.
  - Clone only when a block changes; return original `messages` array when no media is omitted.
  - Preserve `toolCalls` and `cacheControl` by shallow clone only when message content changes.
  - Use Chinese code comments only for non-obvious bugfix rationale.

- [ ] **Step 4: Export helper**

  Add this line to `apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`:

  ```ts
  export * from "./media-capability.js";
  ```

- [ ] **Step 5: Run focused tests**

  Run:

  ```bash
  pnpm --filter @zcode/core exec vitest run tests/media-capability.test.ts
  ```

  Expected: all tests pass.

---

### Task 2: Apply Projection in Runtime Provider Requests

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/media-budget.test.ts`

**Interfaces:**
- Consumes: `ModelInputMediaCapabilities`, `projectMessagesForMediaCapabilities`, `logMediaCapabilityProjection`.
- Produces: `AgentRuntimeConfig.modelInputMediaCapabilities?: ModelInputMediaCapabilities`.

- [ ] **Step 1: Write failing runtime tests**

  Extend `apps/zcode-cli/packages/core/tests/media-budget.test.ts` with:

  ```ts
  it("textifies current user media for text-only models before applying media budget", async () => {
    const requests: ModelInputMessage[][] = [];
    const runtime = new AgentRuntime(
      createSessionId("runtime-media-capability-text-only"),
      {
        mode: "plan",
        modelInputMediaCapabilities: { supportsImages: false },
        workingDirectory: "/tmp/zcode-runtime-media-capability-text-only",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {
          async generateText(request: { messages: ModelInputMessage[] }) {
            requests.push(request.messages);
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("describe [image #1]", [
      { type: "image", path: "[image #1]", content: imageDataUrl(5 * 1024 * 1024) },
    ]);

    expect(requestImageBlocks(requests[0] ?? [])).toHaveLength(0);
    expect(requestTextBlocks(requests[0] ?? []).join("\n")).toContain(
      "does not support image input",
    );
  });

  it("keeps current user media for models with unknown image support", async () => {
    const requests: ModelInputMessage[][] = [];
    const runtime = new AgentRuntime(
      createSessionId("runtime-media-capability-unknown"),
      {
        mode: "plan",
        modelInputMediaCapabilities: {},
        workingDirectory: "/tmp/zcode-runtime-media-capability-unknown",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {
          async generateText(request: { messages: ModelInputMessage[] }) {
            requests.push(request.messages);
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("describe [image #1]", [
      { type: "image", path: "[image #1]", content: imageDataUrl(128) },
    ]);

    expect(requestImageBlocks(requests[0] ?? [])).toHaveLength(1);
  });
  ```

- [ ] **Step 2: Run tests and verify they fail**

  Run:

  ```bash
  pnpm --filter @zcode/core exec vitest run tests/media-budget.test.ts
  ```

  Expected: TypeScript or runtime failure because `modelInputMediaCapabilities` is not defined and projection is not applied.

- [ ] **Step 3: Add runtime config field**

  In `apps/zcode-cli/packages/core/src/runtime/types.ts`, import or re-export the capability type and add:

  ```ts
  modelInputMediaCapabilities?: ModelInputMediaCapabilities;
  ```

  to `AgentRuntimeConfig`.

- [ ] **Step 4: Allow dynamic config refresh**

  In `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`, include `"modelInputMediaCapabilities"` in the `Pick<AgentRuntimeConfig, ...>` union and apply:

  ```ts
  if ("modelInputMediaCapabilities" in patch) {
    this.config.modelInputMediaCapabilities = patch.modelInputMediaCapabilities;
  }
  ```

- [ ] **Step 5: Apply projection before budget in `runModelTextRequest`**

  In `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`, change the request projection order to:

  ```ts
  const capabilityProjection = projectMessagesForMediaCapabilities(
    options.messages,
    this.config.modelInputMediaCapabilities,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: formatModelRef(this.defaultModelRef),
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  ```

  Then derive `projectedOptions` from `mediaProjection.messages`, not from raw `options.messages`.

- [ ] **Step 6: Keep compact request text-only**

  In `compact-active.ts`, leave the existing `projectMessagesForMediaBudget(..., { maxMediaBytes: 0, preserveLatestUserMedia: false })` behavior. Optionally apply capability projection before it for consistent logs; do not weaken the compact all-media stripping behavior.

- [ ] **Step 7: Run focused core tests**

  Run:

  ```bash
  pnpm --filter @zcode/core exec vitest run tests/media-capability.test.ts tests/media-budget.test.ts
  ```

  Expected: all tests pass.

---

### Task 3: Resolve Runtime Capabilities from Model Catalog

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/model/catalog.ts`
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/model-selection.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolveRuntimeModelInputCapabilities(
    modelRef: { modelId: string; providerId: string } | undefined,
    modelCatalog: ModelCatalogConfig,
  ): ModelInputMediaCapabilities | undefined;
  ```
- Consumes: `modelCatalog.overrides`, deterministic default policy for known model families, protocol model metadata.

- [ ] **Step 1: Write failing model-selection tests**

  Add cases to `apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts`:

  ```ts
  it("resolves explicit text-only image capability as false", () => {
    expect(
      resolveRuntimeModelInputCapabilities(
        { providerId: "zai", modelId: "glm-text" },
        { overrides: { "zai/glm-text": { supportsImages: false } } },
      ),
    ).toEqual({ supportsImages: false });
  });

  it("does not treat missing image capability as unsupported", () => {
    expect(
      resolveRuntimeModelInputCapabilities(
        { providerId: "custom", modelId: "vision-maybe" },
        { overrides: { "custom/vision-maybe": { contextWindow: 128000 } } },
      ),
    ).toEqual({});
  });

  it("uses deterministic defaults for known text-only models", () => {
    expect(
      resolveRuntimeModelInputCapabilities(
        { providerId: "deepseek", modelId: "deepseek-v4-flash" },
        { overrides: {} },
      )?.supportsImages,
    ).toBe(false);
  });
  ```

- [ ] **Step 2: Run tests and verify they fail**

  Run:

  ```bash
  pnpm --filter @zcode/bootstrap exec vitest run tests/model-selection.test.ts
  ```

  Expected: fail because `resolveRuntimeModelInputCapabilities` does not exist.

- [ ] **Step 3: Extend contracts for PDF capability**

  In `apps/zcode-cli/packages/contracts/src/model/catalog.ts`, add optional PDF support fields:

  ```ts
  supportsPdf?: boolean;
  ```

  to `ModelCapabilityOverride` and `ModelCapability`. Keep it optional to avoid changing existing catalog records.

- [ ] **Step 4: Extend protocol schema only as optional metadata**

  In `packages/shared/src/zcode-protocol/index.ts`, add optional `supportsPdf: z.boolean().optional()` next to existing `supportsImages` fields if model list consumers need to surface it. This must stay optional for backward compatibility.

- [ ] **Step 5: Implement tri-state resolver**

  In `model-selection.ts`, implement `resolveRuntimeModelInputCapabilities` so it:
  - returns `undefined` when `modelRef` is undefined;
  - reads `modelCatalog.overrides["provider/model"].supportsImages` and `.supportsPdf` first;
  - falls back only to deterministic defaults for known models;
  - never converts absent custom capability into `false`.

- [ ] **Step 6: Inject capability during runtime bootstrap**

  In `runtime-config.ts`, set:

  ```ts
  modelInputMediaCapabilities: options.runtimeConfig?.modelInputMediaCapabilities ??
    resolveRuntimeModelInputCapabilities(initialModelRef, configResult.config.modelCatalog),
  ```

- [ ] **Step 7: Refresh capability when session model changes**

  In `session-facade.ts` `setModel`, include:

  ```ts
  modelInputMediaCapabilities: resolveRuntimeModelInputCapabilities(
    modelRef,
    effectiveModelCatalog,
  ),
  ```

  in the `deps.runtime.updateConfig(...)` patch.

- [ ] **Step 8: Refresh capability when workspace catalog metadata changes**

  In `workspace-model-catalog.ts`, update the helper currently returning `contextWindow` and `maxOutputTokens` to also return `modelInputMediaCapabilities`. The existing `record.app.runtime.updateConfig(modelLimits)` call should then refresh all three fields together.

- [ ] **Step 9: Run bootstrap tests**

  Run:

  ```bash
  pnpm --filter @zcode/bootstrap exec vitest run tests/model-selection.test.ts tests/runtime-config.test.ts
  ```

  Expected: all tests pass.

---

### Task 4: Wire Adapter-Side Capability Guard

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/model-config.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/registry.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/transform.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/tool-result-media-projection.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/model-config.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/model-transform.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/model-transform-tool-media.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AiSdkModelInputMediaCapabilities {
    supportsImages?: boolean;
    supportsPdf?: boolean;
  }

  export interface AiSdkModelRegistryConfig {
    inputMediaCapabilities?: Record<string, AiSdkModelInputMediaCapabilities>;
  }

  export interface AiSdkResolvedModel {
    inputMediaCapabilities?: AiSdkModelInputMediaCapabilities;
  }
  ```
- Consumes: capability resolver from bootstrap/model-selection or equivalent local registry config input.

- [ ] **Step 1: Write failing adapter tests**

  In `model-transform.test.ts`, change the unsupported image expectation to neutral text:

  ```ts
  expect((messages[0] as any).content).toEqual([
    {
      type: "text",
      text: "[Attached image/png]\n[Media omitted from provider request because the selected model does not support image input.]",
    },
  ]);
  ```

  In `model-transform-tool-media.test.ts`, add:

  ```ts
  it("does not project OpenAI-compatible tool images when images are explicitly unsupported", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
            },
          ],
          toolCallId: "call_image",
          toolName: "Read",
        },
      ],
      { providerKind: "openai-compatible", supportsImages: false },
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content[0].output).toEqual({
      type: "text",
      value: "[Attached image/png]",
    });
  });
  ```

- [ ] **Step 2: Run tests and verify expected failures**

  Run:

  ```bash
  pnpm --filter @zcode/adapters exec vitest run tests/model-transform.test.ts tests/model-transform-tool-media.test.ts
  ```

  Expected: unsupported image test fails due current `ERROR: Cannot read...` text.

- [ ] **Step 3: Add registry capability field**

  In `registry.ts`, extend registry config and resolved model with `inputMediaCapabilities`. Store the record in `AiSdkModelRegistry` and include the resolved value based on `formatModelRef(ref)` or `"provider/model"` key.

- [ ] **Step 4: Pass capability into AI SDK message transform**

  In `runner-options.ts`, pass:

  ```ts
  supportsImages: input.resolved.inputMediaCapabilities?.supportsImages,
  supportsPdf: input.resolved.inputMediaCapabilities?.supportsPdf,
  ```

  to `toAiSdkMessages` in both `createGenerateTextOptions` and `createStreamTextOptions`.

- [ ] **Step 5: Neutralize adapter fallback wording**

  In `transform.ts`, replace unsupported image/PDF `ERROR` strings with the same neutral omission text as core. This keeps adapter behavior aligned if core is bypassed.

- [ ] **Step 6: Keep tool media projection bounded**

  In `tool-result-media-projection.ts`, preserve current behavior where `supportsImages === false` does not add follow-up image parts. Ensure the textual tool result remains available via `modelMessageContentToText`.

- [ ] **Step 7: Wire registry config from bootstrap**

  In `model-config.ts`, add a `modelCatalog?: ModelCatalogConfig` option to `CreateAiSdkModelRegistryConfigOptions`. Build `inputMediaCapabilities` for `main`, `lite`, and `available` targets using the same tri-state resolver. Do not put this data into providerOptions.

- [ ] **Step 8: Run adapter/bootstrap focused tests**

  Run:

  ```bash
  pnpm --filter @zcode/adapters exec vitest run tests/model-transform.test.ts tests/model-transform-tool-media.test.ts
  pnpm --filter @zcode/bootstrap exec vitest run tests/model-config.test.ts
  ```

  Expected: all tests pass.

---

### Task 5: End-to-End Request Shape Verification

**Files:**
- Modify if needed: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Modify if needed: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

**Interfaces:**
- Consumes: runtime projection from Task 2 and catalog capability from Task 3.
- Produces: test evidence that user attachment media and tool-result media both disappear from text-only provider requests.

- [ ] **Step 1: Add a tool-loop regression**

  Extend `runtime-tool-loop.test.ts` or add a focused test that:
  - creates runtime with `modelInputMediaCapabilities: { supportsImages: false }`;
  - makes a tool return an image block;
  - lets the next model request happen;
  - asserts the next model request has no `image` content block and contains the neutral omission text.

- [ ] **Step 2: Add trace/log regression if existing trace helper makes it cheap**

  Extend `runtime-trace.test.ts` to assert the debug event contains counts such as `omittedImageCount: 1` and does not contain the data URL.

- [ ] **Step 3: Run core regressions**

  Run:

  ```bash
  pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts tests/runtime-trace.test.ts
  ```

  Expected: all tests pass.

---

### Task 6: Full Validation

**Files:**
- No source files expected unless previous tasks expose integration failures.

- [ ] **Step 1: Run package-focused tests**

  Run:

  ```bash
  pnpm --filter @zcode/core exec vitest run tests/media-capability.test.ts tests/media-budget.test.ts tests/runtime-tool-loop.test.ts tests/runtime-trace.test.ts
  pnpm --filter @zcode/adapters exec vitest run tests/model-transform.test.ts tests/model-transform-tool-media.test.ts
  pnpm --filter @zcode/bootstrap exec vitest run tests/model-selection.test.ts tests/model-config.test.ts tests/runtime-config.test.ts
  ```

  Expected: all listed tests pass.

- [ ] **Step 2: Run mandatory repository checks**

  Run:

  ```bash
  pnpm typecheck
  pnpm lint
  ```

  Expected: both commands exit 0.

- [ ] **Step 3: Manual request-shape smoke test**

  Use a model config entry with explicit `supportsImages: false`, send a user image, then inspect model-io/debug trajectory. Expected provider-visible request contains the neutral text omission and no image/file media payload.

- [ ] **Step 4: Summarize residual risk**

  Final implementation summary must state:
  - media entry points remain unchanged;
  - raw session history remains unchanged;
  - provider-visible requests are sanitized only when capability is explicitly false;
  - unknown custom models keep prior behavior;
  - whether `pnpm typecheck` and `pnpm lint` passed.

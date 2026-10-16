# 动态 Mid-conversation System Projection 实现计划

> **执行约束：** 实现本计划时按 Phase 推进。每个 Phase 完成后必须先跑单测、做 code review、产出 prompt-trajectory/provider-visible 证据，再等用户确认后进入下一 Phase。除非用户明确要求，不要自动提交 commit。

**目标：** 根据当前模型/provider 能力，动态决定 runtime system-reminder attachment 最终投影为 mid-conversation `role: "system"`，还是 legacy `role: "user"` + `<system-reminder>` wrapper。

**核心架构：** 所有 reminder producer 继续产出 source-aware runtime attachment entry，不在 producer 处分叉。新增一个通用 capability resolver，从当前 `ModelRef` 和 resolved `ModelConnectionInfo` 构造完整决策上下文，再返回 `useMidConversationSystem` boolean。最终 provider request builder 只消费这个 boolean；如果 MCS 关闭，则恢复 legacy user system-reminder shape，并恢复 legacy attachment-like reminder bubble-up 排序。

**技术栈：** TypeScript、Vitest、`@zcode/contracts`、`@zcode/core`、prompt-trajectory、model-io trajectory converter。

## 全局约束

- 默认不新增静态/用户配置开关；未显式传 CLI override 时，是否启用 MCS 必须由 runtime provider/model 环境动态计算。
- CLI 可在 `--prompt`、`--target` 或 `tui` runtime 路径中通过单次运行参数 `--force-mcs` 设置 runtime override；其他命令必须报错，避免用户误以为 `app-server` / `doctor` / `plugins` 等非 runtime prompt 命令会继承该开关。该 override 只跳过 fast-supported model / baseURL host gate，不跳过 `providerKind === "anthropic"`、connection resolve、source/position projection 约束；非 Anthropic provider 仍必须关闭 MCS，避免把不兼容 provider 请求投影成 mid-history `role: "system"`。
- capability 判断函数必须接收完整上下文，而不是只接收 `baseURL` 和 `providerKind`。后续需要能在同一个函数内读取当前模型名、provider id、provider 类型、provider URL、role、source、variant、request source 等信息。
- 启用条件：resolved connection 的 `providerKind` 必须先是 `anthropic`；在此前提下，如果当前模型名命中 fast-supported model lookup（当前只覆盖 Opus 4.8 的 `claude-opus-4-8` 边界完整片段），则直接启用 MCS；其他 Anthropic 模型，包括 `glm-5.2` / `GLM-5.2` 等大小写变体，仍要求 `baseURL` 命中 MCS allowlist。这里不依赖 baseURL 来判断 fast-supported model，只基于模型名字符串。
- 不在本计划中新增或修改任何 provider header / Anthropic beta header。
- producer 不分叉：`skills_listing`、`todo_reminder`、`output_style`、`prompt_attachment` 等仍然只产出 source-aware attachment entry。
- capability helper 可以接收完整 `ModelConnectionInfo`，但其中可能包含 `apiKey`、`headers` 等敏感字段；禁止 log、snapshot、persist 这些敏感字段，且返回给调用方的 decision context 必须移除 `apiKey` / `headers`。
- MCS 关闭时，MCS-capable attachments 必须渲染为 legacy `role: "user"` + `<system-reminder>`，并参与 legacy attachment-like bubble-up 排序。
- request-level `context_prefix`、真实用户输入、tool-result warning、goal verification auxiliary prompt 不进入 MCS。
- 验收面只看最终发送给 model provider 的 provider-visible request body。

## 当前代码事实

- provider-visible 投影边界在 `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts` 的 `buildProviderRequestMessages(...)`。
- 当前实现默认调用 `projectMidConversationSystemEntries(...)`，没有 provider capability 输入。
- source 静态分类在 `apps/zcode-cli/packages/core/src/system-reminder/source.ts`，入口是 `isMidConversationSystemSource(...)`。
- legacy render 逻辑已经存在：未被 MCS projector 消费的 runtime attachment entry 会通过 `renderProjectedEntryToModelMessage(...)` 变成 `role: "user"` + `wrapSystemReminderForSource(...)`。
- 当前 attachment reorder 会排除 MCS-capable source，原因是 `isAttachmentLikeUserEntry(...)` 对 `isMidConversationSystemSource(source)` 返回 false。
- WebSearch 已经有可参考的 provider/baseURL 动态 capability 模式：
  - `apps/zcode-cli/packages/core/src/tool/handlers/websearch-support.ts`
  - `apps/zcode-cli/packages/contracts/src/tools/websearch.ts`
  - runtime 侧通过 `modelConnectionPort.resolveConnection(this.defaultModelRef)` 获取 resolved connection。

## 目标行为

### MCS 开启

给定 runtime entries：

```text
user "Summarize this"
attachment prompt_attachment "Called the Read tool..."
assistant ...
attachment todo_reminder "The TodoWrite tool hasn't..."
```

最终 provider-visible messages 应保持 MCS shape：

```json
[
  { "role": "user", "content": "Summarize this" },
  { "role": "system", "content": "Called the Read tool..." },
  { "role": "assistant", "content": "..." },
  { "role": "system", "content": "The TodoWrite tool hasn't..." }
]
```

### MCS 关闭

同一组 runtime entries 应降级为 legacy user system-reminder messages；如果 attachment-like reminder 原本在真实 user query 后面，则需要 bubble 到真实 user query 前面：

```json
[
  {
    "role": "user",
    "content": "<system-reminder>\nCalled the Read tool...\n</system-reminder>"
  },
  { "role": "user", "content": "Summarize this" },
  { "role": "assistant", "content": "..." },
  {
    "role": "user",
    "content": "<system-reminder>\nThe TodoWrite tool hasn't...\n</system-reminder>"
  }
]
```

assistant/tool-result 边界后的具体位置继续遵循现有 `reorderAttachmentLikeEntries(...)` 的 bubble-stop 规则。

## 文件职责

| 文件                                                                                    | 职责                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/contracts/src/model/mid-conversation-system.ts`                | MCS baseURL allowlist 与 fast-supported model lookup 纯函数。                   |
| `apps/zcode-cli/packages/contracts/src/model/index.ts`                                  | 导出 MCS baseURL / fast-supported model helper。                               |
| `apps/zcode-cli/packages/contracts/tests/mid-conversation-system.test.ts`               | 覆盖 allowlisted / denied baseURL 解析和 fast-supported model 判断。            |
| `apps/zcode-cli/packages/core/src/runtime/helpers/mid-conversation-system.ts`           | 构造完整 MCS capability context，并返回 capability decision。                   |
| `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`         | 消费 `useMidConversationSystem`，切换 MCS projection 和 legacy reorder。        |
| `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts` | runtime 包装层：解析 capability，再调用 provider request builder。              |
| `apps/zcode-cli/packages/cli/src/run.ts`                                               | 解析并校验 `--force-mcs`，仅允许 `--prompt` / `--target` / `tui` runtime 路径。 |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts`                                    | headless prompt runtimeConfig 写入 MCS force override。                        |
| `apps/zcode-cli/packages/cli/src/tui-command.ts` / `tui-prompt-handler.ts`             | TUI runtimeConfig 写入 MCS force override。                                    |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`                         | main turn 请求使用 runtime wrapper。                                            |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`                           | compact sizing 使用 runtime wrapper。                                           |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`                    | compact summary/token accounting 使用同一个 capability decision。               |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts`            | compact summary request builder 接收 `useMidConversationSystem`。               |
| `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`                           | runtime-entry token estimation / microcompact 接收 `useMidConversationSystem`。 |
| `apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`    | target verification 请求使用 runtime wrapper。                                  |
| `apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts`                  | 覆盖 MCS 开启/关闭投影 shape。                                                  |
| `apps/zcode-cli/packages/core/tests/runtime-mcs-capability.test.ts`                     | 覆盖完整 model/provider context 的 capability 判断。                            |
| `apps/zcode-cli/tools/prompt-trajectory/testcases/`                                     | E2E fixture，用于验证 provider-visible shape。                                  |

## Phase 0：基线确认

**目标：** 在实现前确认当前代码路径和测试基线。

**用户确认点：** 完成后暂停，等用户确认再进入 Phase 1。

### Checklist

- [ ] 确认当前分支和 worktree 状态。
- [ ] 确认 `provider-request-messages.ts` 当前是无条件启用 MCS。
- [ ] 确认当前没有 first-class disabled MCS path。
- [ ] 跑 focused baseline tests。

### 步骤

1. 检查 git 状态：

```bash
git status --short --branch
```

预期：在目标 MCS 工作分支上，没有无关 dirty files。

2. 跑基线测试：

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts
```

预期：实现前全部通过。若失败，先排查，不进入实现。

## Phase 1：新增通用 MCS Capability Utility

**目标：** 新增动态 capability 判断。它参考 WebSearch 的 provider/baseURL 模式，但设计上接收完整 model/provider context，避免后续新增 model-specific gate 时再次改 projection 层。

**用户确认点：** 单测和 review 完成后暂停。

### Task 1.1：contracts 层 baseURL / fast-supported model lookup helper

**文件：**

- 新增：`apps/zcode-cli/packages/contracts/src/model/mid-conversation-system.ts`
- 修改：`apps/zcode-cli/packages/contracts/src/model/index.ts`
- 测试：`apps/zcode-cli/packages/contracts/tests/mid-conversation-system.test.ts`

**产出接口：**

```ts
export function isMidConversationSystemCapableBaseURL(
  baseURL: string | undefined,
): boolean;

export function isFastSupportedModel(modelId: string | undefined): boolean;
```

**测试：**

```ts
import { describe, expect, it } from "vitest";
import {
  isFastSupportedModel,
  isMidConversationSystemCapableBaseURL,
} from "../src/model/mid-conversation-system.js";

describe("isMidConversationSystemCapableBaseURL", () => {
  it.each([
    "https://bigmodel.cn/api/anthropic",
    "https://open.bigmodel.cn/api/anthropic",
    "https://open.bigmodel.cn/api/anthropic",
    "https://z.ai/api/anthropic",
    "https://api.z.ai/api/anthropic",
    "https://deepseek.com/anthropic",
    "https://api.deepseek.com/anthropic",
    "https://z.ai/api/anthropic",
    "https://zcode.z.ai/api/anthropic",
    "api.z.ai/api/anthropic",
  ])("allows %s", (baseURL) => {
    expect(isMidConversationSystemCapableBaseURL(baseURL)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "https://provider.example/anthropic",
    "https://bigmodel.cn.example/anthropic",
    "https://z.ai.example/anthropic",
    "https://deepseek.com.example/anthropic",
    "https://z.ai.example/anthropic",
    "https://example.com/anthropic?redirect=https://api.z.ai",
  ])("rejects %s", (baseURL) => {
    expect(isMidConversationSystemCapableBaseURL(baseURL)).toBe(false);
  });
});

describe("isFastSupportedModel", () => {
  it.each([
    "claude-opus-4-8",
    " claude-opus-4-8 ",
    "CLAUDE-OPUS-4-8",
    "anthropic.claude-opus-4-8",
    "us.anthropic.claude-opus-4-8",
    "bedrock/us.anthropic.claude-opus-4-8",
    "claude-opus-4-8-cc[1m]",
    " claude-opus-4-8-cc[1m] ",
    "claude-opus-4-8-cc",
    "claude-opus-4-8[1m]",
    "claude-opus-4-8-preview",
    "claude-opus-4-8-latest",
  ])("matches %s", (modelId) => {
    expect(isFastSupportedModel(modelId)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "claude-opus-4-7",
    "claude-opus-4-80",
    "claude-sonnet-4-8",
    "not-claude-opus-4-8",
    "my_claude-opus-4-8",
    "glm-5.2",
    " GLM-5.2 ",
    "zai/glm-5.2",
    "z.ai/glm-5.2",
    "bigmodel/glm-5.2-latest",
    "glm-5.1",
    "glm-5.20",
    "not-glm-5.2",
    "my_glm-5.2",
  ])("rejects %s", (modelId) => {
    expect(isFastSupportedModel(modelId)).toBe(false);
  });
});
```

先运行并确认失败：

```bash
pnpm --filter @zcode/contracts exec vitest run tests/mid-conversation-system.test.ts
```

实现：

```ts
const MID_CONVERSATION_SYSTEM_CAPABLE_BASE_HOSTS = [
  "bigmodel.cn",
  "z.ai",
  "deepseek.com",
  "z.ai",
] as const;

const FAST_SUPPORTED_MODEL_MARKERS = ["claude-opus-4-8"] as const;
const FAST_SUPPORTED_MODEL_PREFIX_BOUNDARIES = new Set([".", "/", ":"]);
const FAST_SUPPORTED_MODEL_SUFFIX_BOUNDARIES = new Set(["-", "[", ".", "/", ":", "@", "_"]);

export function isFastSupportedModel(modelId: string | undefined): boolean {
  const name = modelId?.trim().toLowerCase();
  if (!name) return false;

  return FAST_SUPPORTED_MODEL_MARKERS.some((marker) =>
    modelNameContainsFastSupportedMarker(name, marker),
  );
}

function modelNameContainsFastSupportedMarker(name: string, marker: string): boolean {
  let index = name.indexOf(marker);
  while (index !== -1) {
    const before = index === 0 ? undefined : name[index - 1];
    const afterIndex = index + marker.length;
    const after = afterIndex >= name.length ? undefined : name[afterIndex];

    if (
      (!before || FAST_SUPPORTED_MODEL_PREFIX_BOUNDARIES.has(before)) &&
      (!after || FAST_SUPPORTED_MODEL_SUFFIX_BOUNDARIES.has(after))
    ) {
      return true;
    }

    index = name.indexOf(marker, index + 1);
  }

  return false;
}

export function isMidConversationSystemCapableBaseURL(
  baseURL: string | undefined,
): boolean {
  const host = hostnameFromBaseURL(baseURL);
  if (!host) return false;
  return MID_CONVERSATION_SYSTEM_CAPABLE_BASE_HOSTS.some(
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
```

在 `apps/zcode-cli/packages/contracts/src/model/index.ts` 增加导出：

```ts
export * from "./mid-conversation-system.js";
```

验证：

```bash
pnpm --filter @zcode/contracts exec vitest run tests/mid-conversation-system.test.ts
```

### Task 1.2：core 层完整 capability context

**文件：**

- 新增：`apps/zcode-cli/packages/core/src/runtime/helpers/mid-conversation-system.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`
- 测试：`apps/zcode-cli/packages/core/tests/runtime-mcs-capability.test.ts`

**产出接口：**

```ts
export interface MidConversationSystemCapabilityContext {
  modelRef: ModelRef;
  connection: ModelConnectionInfo;
}

type SanitizedModelConnectionInfo = Omit<ModelConnectionInfo, "apiKey" | "headers">;

export interface ResolvedMidConversationSystemCapabilityContext {
  baseURL?: string;
  connection: SanitizedModelConnectionInfo;
  modelId: string;
  modelRef: ModelRef;
  providerId: string;
  providerKind: ModelConnectionInfo["providerKind"];
}

export type MidConversationSystemCapabilityReason =
  | "supported"
  | "missing_model_connection_port"
  | "resolve_connection_failed"
  | "unsupported_provider_kind"
  | "unsupported_base_url";

export interface MidConversationSystemCapabilityDecision {
  useMidConversationSystem: boolean;
  reason: MidConversationSystemCapabilityReason;
  context?: ResolvedMidConversationSystemCapabilityContext;
}

export function evaluateMidConversationSystemCapability(
  context: MidConversationSystemCapabilityContext,
): MidConversationSystemCapabilityDecision;

export function resolveMidConversationSystemCapability(input: {
  modelConnectionPort?: ModelConnectionPort;
  modelRef: ModelRef;
}): MidConversationSystemCapabilityDecision;
```

**关键设计：**

- `evaluateMidConversationSystemCapability(...)` 接收完整 `ModelConnectionInfo`，因此能看到：
  - `connection.model.modelId`
  - `connection.providerId`
  - `connection.providerKind`
  - `connection.baseURL`
  - `connection.providerOptions`
  - `modelRef.role`
  - `modelRef.source`
  - `modelRef.variant`
- 初始版本只用 `providerKind` + `baseURL` 判断。
- `apiKey` / `headers` 可以存在于输入 `connection`，但不允许输出到日志或轨迹；返回的 decision context 只包含去敏后的 connection。

**测试重点：**

- allowlisted anthropic provider 返回 supported。
- 非 anthropic provider 返回 unsupported。
- unknown baseURL 返回 unsupported。
- missing `modelConnectionPort` 返回 disabled decision。
- resolve connection 抛错返回 disabled decision。
- decision context 中可以读取完整当前模型/provider 信息。

测试片段：

```ts
import { describe, expect, it } from "vitest";
import {
  ModelRefSource,
  ModelRole,
  createModelId,
  createModelProviderId,
  type ModelConnectionInfo,
  type ModelConnectionPort,
  type ModelRef,
} from "@zcode/contracts";
import {
  evaluateMidConversationSystemCapability,
  resolveMidConversationSystemCapability,
} from "../src/runtime/helpers/mid-conversation-system.js";

const modelRef: ModelRef = {
  providerId: createModelProviderId("test"),
  modelId: createModelId("claude-opus-4-20250514"),
  role: ModelRole.Main,
  source: ModelRefSource.Config,
  variant: "first-party",
};

function connection(
  input: Partial<ModelConnectionInfo> = {},
): ModelConnectionInfo {
  return {
    apiKey: "secret-api-key",
    baseURL: "https://api.z.ai/api/anthropic",
    headers: { Authorization: "Bearer secret-token" },
    model: modelRef,
    providerId: "test",
    providerKind: "anthropic",
    ...input,
  } as ModelConnectionInfo;
}

describe("evaluateMidConversationSystemCapability", () => {
  it("enables MCS for anthropic providers on allowlisted baseURL", () => {
    expect(
      evaluateMidConversationSystemCapability({
        modelRef,
        connection: connection(),
      }),
    ).toMatchObject({
      reason: "supported",
      useMidConversationSystem: true,
    });
  });

  it("keeps safe current model/provider context available to the decision function", () => {
    const currentModelRef: ModelRef = {
      providerId: createModelProviderId("anthropic-provider"),
      modelId: createModelId("claude-opus-4-1-20260101"),
      role: ModelRole.Subagent,
      source: ModelRefSource.Session,
      variant: "first-party",
    };
    const currentConnection = connection({
      model: currentModelRef,
      providerId: "anthropic-provider",
      providerOptions: { routing: "first-party" },
    });

    const decision = evaluateMidConversationSystemCapability({
      modelRef: currentModelRef,
      connection: currentConnection,
    });

    expect(decision.useMidConversationSystem).toBe(true);
    if (!decision.context) throw new Error("expected capability context");
    expect(decision.context.modelRef).toBe(currentModelRef);
    expect(decision.context.connection).toEqual({
      baseURL: "https://api.z.ai/api/anthropic",
      model: currentModelRef,
      providerId: "anthropic-provider",
      providerKind: "anthropic",
      providerOptions: { routing: "first-party" },
    });
    expect("apiKey" in decision.context.connection).toBe(false);
    expect("headers" in decision.context.connection).toBe(false);
    expect(decision.context.modelId).toBe("claude-opus-4-1-20260101");
    expect(decision.context.providerId).toBe("anthropic-provider");
    expect(decision.context.providerKind).toBe("anthropic");
    expect(decision.context.baseURL).toBe("https://api.z.ai/api/anthropic");
  });
});
```

验证：

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-mcs-capability.test.ts
```

## Phase 2：让 Provider Projection 感知 Capability

**目标：** `buildProviderRequestMessages(...)` 增加 `useMidConversationSystem` 参数。MCS 开启时保持当前 role system projection；MCS 关闭时走 legacy user system-reminder，并恢复 legacy bubble-up 排序。

**用户确认点：** 单测和 review 完成后暂停。

### Task 2.1：builder 参数与 legacy reorder

**文件：**

- 修改：`apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`
- 测试：`apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts`

**接口变更：**

```ts
export function buildProviderRequestMessages(input: {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  useMidConversationSystem?: boolean;
}): ProviderRequestMessageProjectionResult;
```

**测试：**

```ts
it("projects MCS-capable attachments as system messages when MCS is enabled", () => {
  const entries = [
    entry(user("Summarize notes."), "real_user"),
    attachment(
      "prompt_attachment",
      "Called the Read tool with the following input: {}",
    ),
    attachment("output_style", "Terse output style is active."),
  ] satisfies RuntimeMessageEntry[];

  expect(
    buildProviderRequestMessages({
      entries,
      useMidConversationSystem: true,
    }).messages,
  ).toEqual([
    { role: "user", content: "Summarize notes." },
    {
      role: "system",
      content:
        "Called the Read tool with the following input: {}\n\nTerse output style is active.",
    },
  ]);
});

it("renders MCS-capable attachments as legacy user system reminders when MCS is disabled", () => {
  const entries = [
    entry(user("Summarize notes."), "real_user"),
    attachment(
      "prompt_attachment",
      "Called the Read tool with the following input: {}",
    ),
  ] satisfies RuntimeMessageEntry[];

  expect(
    buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    }).messages,
  ).toEqual([
    {
      role: "user",
      content:
        "<system-reminder>\nCalled the Read tool with the following input: {}\n</system-reminder>",
    },
    { role: "user", content: "Summarize notes." },
  ]);
});
```

**实现要点：**

- `useMidConversationSystem === true` 才调用 `projectMidConversationSystemEntries(...)`。
- `useMidConversationSystem !== true` 时不调用 MCS projector。
- `reorderAttachmentLikeEntries(...)` 新增参数：

```ts
interface AttachmentReorderOptions {
  includeMidConversationSystemAttachments: boolean;
}
```

- MCS 开启：`includeMidConversationSystemAttachments: false`。
- MCS 关闭：`includeMidConversationSystemAttachments: true`，让原本 MCS-capable 的 attachment 回到 legacy bubble-up 排序。

验证：

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/message-history.test.ts
```

## Phase 3：Runtime 所有请求路径接入动态 Capability

**目标：** main turn、compact、microcompact、token estimation、target verification 全部使用同一个 capability decision，避免不同请求路径出现 provider-visible shape 分裂。

**用户确认点：** focused tests 和 code review 完成后暂停。

### Task 3.1：新增 runtime wrapper

**文件：**

- 新增：`apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`
- 测试：`apps/zcode-cli/packages/core/tests/runtime-mcs-capability.test.ts`

**产出接口：**

```ts
export function resolveRuntimeMidConversationSystemCapability(
  runtime: Pick<
    AgentRuntimeInternal,
    "defaultModelRef" | "modelConnectionPort"
  >,
): MidConversationSystemCapabilityDecision;

export function buildRuntimeProviderRequestMessages(
  runtime: Pick<
    AgentRuntimeInternal,
    "defaultModelRef" | "modelConnectionPort"
  >,
  input: {
    entries: readonly RuntimeMessageEntry[];
    applyCacheControl?: boolean;
  },
): ProviderRequestMessageProjectionResult;
```

**实现：**

```ts
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  resolveMidConversationSystemCapability,
  type MidConversationSystemCapabilityDecision,
} from "./mid-conversation-system.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

export function resolveRuntimeMidConversationSystemCapability(
  runtime: Pick<
    AgentRuntimeInternal,
    "defaultModelRef" | "modelConnectionPort"
  >,
): MidConversationSystemCapabilityDecision {
  return resolveMidConversationSystemCapability({
    modelConnectionPort: runtime.modelConnectionPort,
    modelRef: runtime.defaultModelRef,
  });
}

export function buildRuntimeProviderRequestMessages(
  runtime: Pick<
    AgentRuntimeInternal,
    "defaultModelRef" | "modelConnectionPort"
  >,
  input: {
    entries: readonly RuntimeMessageEntry[];
    applyCacheControl?: boolean;
  },
): ProviderRequestMessageProjectionResult {
  const decision = resolveRuntimeMidConversationSystemCapability(runtime);
  return buildProviderRequestMessages({
    ...input,
    useMidConversationSystem: decision.useMidConversationSystem,
  });
}
```

**测试重点：**

- allowlisted anthropic connection 下，`output_style` attachment 投影为 `role: "system"`。
- non-anthropic connection 下，`output_style` attachment 投影为 legacy user `<system-reminder>`，并 bubble 到真实 user 前面。

验证：

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-mcs-capability.test.ts tests/provider-request-messages.test.ts
```

### Task 3.2：替换 runtime call sites

**文件：**

- 修改：`apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`
- 如当前代码存在独立 microcompact runtime method，同步修改对应文件。

**main turn：**

```ts
const providerProjection = buildRuntimeProviderRequestMessages(this, {
  entries: this.messageHistory.toRuntimeEntries(),
  applyCacheControl: true,
});
```

**compact sizing：**

```ts
const activeMessages = buildRuntimeProviderRequestMessages(this, {
  entries: this.messageHistory.toRuntimeEntries(),
  applyCacheControl: false,
}).messages;
```

**compact summary：**

```ts
const useMidConversationSystem =
  resolveRuntimeMidConversationSystemCapability(this).useMidConversationSystem;
```

然后把 `useMidConversationSystem` 传入：

```ts
estimateRuntimeEntryTokens(activeEntries, { useMidConversationSystem });
buildCompactSummaryRequestMessages(entriesForSummary, compactPrompt, {
  useMidConversationSystem,
});
estimateRuntimeEntryTokens(postCompactEntries, { useMidConversationSystem });
```

**microcompact：**

```ts
const useMidConversationSystem =
  resolveRuntimeMidConversationSystemCapability(this).useMidConversationSystem;
```

然后传入 `maybeLocalMicrocompactRuntimeEntries(...)`。

**target verification：**

```ts
const projection = buildRuntimeProviderRequestMessages(this, {
  entries,
  applyCacheControl: false,
});
```

验证：

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts tests/runtime-compact.test.ts tests/microcompact.test.ts tests/provider-request-messages.test.ts tests/runtime-mcs-capability.test.ts
```

## Phase 4：Prompt-trajectory E2E 验证

**目标：** 用真实 provider-visible trajectory 证明同一个 session/request 在不同 provider capability 下会得到正确 shape。

**用户确认点：** 生成 E2E 产物后暂停给用户 review。

### Checklist

- [ ] 准备一个 fixture，包含真实 user prompt。
- [ ] fixture 至少触发一个 text file prompt attachment。
- [ ] fixture 至少触发一个 runtime reminder，例如 `output_style` 或 `todo_reminder`。
- [ ] allowlisted anthropic provider 下，验证 reminder 为 `role: "system"`。
- [ ] unsupported provider 下，验证 reminder 为 user `<system-reminder>`，且 attachment-like reminder bubble 到真实 user 前面。
- [ ] 产物输出到 `apps/zcode-cli/out/` 方便 review。

### 命令

先构建：

```bash
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/core build
```

MCS-capable provider 预期片段：

```json
[
  { "role": "user", "content": "..." },
  { "role": "system", "content": "Called the Read tool..." }
]
```

unsupported provider 预期片段：

```json
[
  {
    "role": "user",
    "content": "<system-reminder>\nCalled the Read tool..."
  },
  { "role": "user", "content": "..." }
]
```

## Phase 5：文档、Worklog、最终验证

**目标：** 更新 MCS 计划状态与 worklog，并完成最终工程验证。

### Checklist

- [x] 更新相关 MCS plan 状态，说明当前是 dynamic capability gate。
- [x] 更新 `apps/zcode-cli/worklogs/trajectory-align-log.md`，按天聚合记录 brief、核心改动思路、生效范围。
- [x] 确认没有输出敏感 connection fields。
- [x] 确认没有 producer 层分叉。
- [x] 确认 disabled path 已恢复 legacy bubble-up 排序。
- [x] 确认 enabled path 保持当前 MCS projection。

### Phase 5 执行记录（2026-06-24）

- MCS 计划文档已更新为 dynamic capability gate 口径：MCS enabled path 保持 `role: "system"`；MCS disabled path 回退到 legacy user `<system-reminder>`，并恢复 attachment-like bubble-up。
- capability 判断只在 runtime wrapper / helper 中读取 `ModelRef` 与 resolved `ModelConnectionInfo`；provider request builder 不读取 provider/model 信息，只消费 `useMidConversationSystem` boolean。
- 2026-07-09 follow-up：新增 CLI-only `--force-mcs` runtime override，用于强制 Anthropic provider 绕过 model/baseURL allowlist。该开关只允许 `--prompt` / `--target` / `tui` runtime 路径，不落持久配置，不影响默认自动判断；非 Anthropic provider 仍关闭 MCS。
- producer 层继续只产出 source-aware runtime attachment entry，没有按 provider 分叉。
- 敏感 connection 字段检查：新增 helper 不记录、不 persist、不输出 `apiKey` / `headers`，并且 `decision.context.connection` 会在返回前移除这两个字段。
- Prompt-trajectory evidence：`apps/zcode-cli/out/mcs-dynamic-capability/enabled` 与 `apps/zcode-cli/out/mcs-dynamic-capability/disabled`。enabled case 的 reminder 为 mid-history `role: "system"`；disabled case 的 reminder 为 legacy user `<system-reminder>` 且位于真实 user prompt 前。
- Verification：focused Vitest 与 `pnpm typecheck` 通过；`pnpm lint` 已执行，但被仓库既有 max-lines / unused lint 项阻塞，未发现本次新增 MCS helper 文件的 lint 报错。

### 最终验证命令

```bash
pnpm --filter @zcode/contracts exec vitest run tests/mid-conversation-system.test.ts
pnpm --filter @zcode/core exec vitest run tests/runtime-mcs-capability.test.ts tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts
pnpm typecheck
pnpm lint
```

如 `pnpm typecheck` 或 `pnpm lint` 因仓库既有问题失败，需要在交付说明里明确区分：本次改动引入的问题 vs 既有问题。

## 风险与防护

| 风险                                                    | 防护                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| provider capability 判断散落在多个 call site            | 只允许 runtime wrapper 调用 capability resolver，provider builder 只接收 boolean。 |
| 后续 model-specific gate 需要重构                       | capability resolver 接收完整 context，包括 `ModelRef` 和 `ModelConnectionInfo`。   |
| MCS disabled 时 provider-visible shape 和 legacy 不一致 | `includeMidConversationSystemAttachments: true` 恢复 legacy bubble-up。            |
| `apiKey` / `headers` 泄露到日志或轨迹                   | decision 可以持有 context，但任何 logging/snapshot 都不得输出完整 connection。     |
| compact/microcompact 和 main turn shape 分裂            | 所有 request path 共享 `resolveRuntimeMidConversationSystemCapability(...)`。      |

## 自检清单

- [x] MCS 开启条件只在 capability resolver 中定义。
- [x] `buildProviderRequestMessages(...)` 没有读取 provider/model 信息。
- [x] producer 没有根据 provider 改变 entry 生成方式。
- [x] enabled path provider-visible 输出 role system。
- [x] disabled path provider-visible 输出 user `<system-reminder>`。
- [x] disabled path 恢复 attachment bubble-up。
- [x] prompt-trajectory 能看到两种 provider capability 下的 shape 差异。
- [x] 没有自动 commit。

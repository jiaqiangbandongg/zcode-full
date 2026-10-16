# WebSearch Client Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking; completed items are marked `- [x]`.

> **Status 2026-06-08:** Implemented. Final focused tests, CLI typecheck, explicit build,
> and prompt-trajectory e2e passed. Final trajectory evidence 是本地 `tools/prompt-trajectory/out/`
> 下的两组记录（未入库）：P-12 outer request `test20260608-213225` 与 internal request `final3`。
> Full CLI lint/test still have unrelated pre-existing failures documented in the final
> implementation report.

**Goal:** 把 ZCode WebSearch 从主请求 direct provider-native `web_search` 切换为 client tool + internal side request 形态：外层暴露普通 `WebSearch` client tool，handler 内部发起只包含 provider-native `web_search` 的 model request，并把结果作为普通 tool result 回灌给主模型。

**Architecture:** 主模型请求只看到 `WebSearch` function tool；`web_search` 只在 `WebSearch` handler 的内部 side request 中出现。Runtime registry、permission、scheduler、hooks、tool parts、history 和 nested usage 都按普通 client-side tool 路径处理 WebSearch；adapter 的 provider-native helper 映射继续保留，但只服务内部 request。

**Tech Stack:** TypeScript, Zod, Vercel AI SDK tool helpers, Vitest, prompt-trajectory, ZCode core runtime/tool registry/adapter contracts.

---

## Commit Policy

用户已明确要求“不要帮我自动提交，除非我主动要求了”。执行本 plan 时：

- 每个 phase 结束可以给出建议 commit message。
- 不执行 `git commit`，除非用户在当轮明确要求提交。
- 可以执行 `git add` 之前先征询用户；默认只保留 working tree diff。

## Source References

- Current spec to rewrite: `apps/zcode-cli/docs/design/v2/tool/13-websearch.md`
- Tool change chain: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`
- Current handler: `apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts`
- Current result formatter: `apps/zcode-cli/packages/core/src/tool/handlers/websearch-results.ts`
- Current provider support helper: `apps/zcode-cli/packages/core/src/tool/handlers/websearch-support.ts`
- Current runtime direct append: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Current public/native schema: `apps/zcode-cli/packages/contracts/src/tools/websearch.ts`
- Current adapter mapping: `apps/zcode-cli/packages/adapters/src/model/tool-transform.ts`

## Frozen Decisions

| ID | Decision |
| --- | --- |
| WS-D1 | 外层 provider-visible tool name 是 `WebSearch`，不是 `web_search`。 |
| WS-D2 | 外层 `WebSearch` 是 client-side tool，必须进入 ToolExecutor、permission、scheduler、hooks、tool part persistence 和 tool result history。 |
| WS-D3 | 内部 side request 的唯一 tool 是 provider-native `web_search`，由 adapter 映射到 Anthropic provider 的 native web search helper。 |
| WS-D4 | 外层 public schema 使用 snake_case domain 字段：`query`、`allowed_domains`、`blocked_domains`。 |
| WS-D5 | 只保留当前 Anthropic provider-native `web_search` 实际消费的 `maxUses` public 可选调参字段，并透传到内部 provider-native args；`searchContextSize` 不再暴露，避免形成 no-op contract。 |
| WS-D6 | `web_search` 可以作为 legacy allowlist alias 映射到 `WebSearch`，但不得出现在外层 provider-visible `tools[].name`。 |
| WS-D7 | Provider capability gate 优先在 runtime tool projection 做；handler assertion 继续作为第二道 fail-closed 防线。 |
| WS-D8 | runtime 只有在能解析 model connection，且 `providerKind === "anthropic"`、baseURL host 为 `bigmodel.cn` / `z.ai` / `deepseek.com` 或其子域时才暴露 `WebSearch`；无法解析时 fail-closed。 |
| WS-D9 | 先不实现内部 request 的 streaming progress；内部 request 保持 `generateText`，只保证 request shape 与 tool result 格式。 |
| WS-D10 | 不恢复 BigModel Web Search REST API、DuckDuckGo HTML fallback、`numResults`、`safeSearch`。 |

## File Map

| File | Responsibility in this change |
| --- | --- |
| `apps/zcode-cli/docs/design/v2/tool/13-websearch.md` | 正式 spec，从 direct provider-native 改为 public wrapper + internal native side request。 |
| `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` | 更新 provider-native/server-side checklist，说明 WebSearch 采用 side request 形态。 |
| `apps/zcode-cli/docs/design/v2/tool/README.md` | Tool matrix 改为 `WebSearch` client-side wrapper。 |
| `apps/zcode-cli/docs/design/v2/model/http-proxy.md` | 说明 WebSearch 内部 model request 跟随 provider transport/proxy。 |
| `apps/zcode-cli/docs/design/v2/compact/plan.md` | WebSearch 有本地 tool result budget。 |
| `apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md` | WebSearch 不再是主请求 provider-native tool。 |
| `apps/zcode-cli/docs/design/v2/loop/architecture.md` | read-only/concurrent tool 调度说明加入 WebSearch。 |
| `apps/zcode-cli/docs/design/v2/tui-network-status-panel.md` | WebSearch handler 内部 model request 的 network status 说明。 |
| `apps/zcode-cli/packages/contracts/src/tools/websearch.ts` | 拆 public schema、内部 provider-native args、client contract。 |
| `apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts` | normalize public snake_case input；内部发起 provider-native `web_search` request。 |
| `apps/zcode-cli/packages/core/src/tool/handlers/websearch-results.ts` | tool result text、sources reminder、typed result extraction。 |
| `apps/zcode-cli/packages/core/src/tool/handlers/websearch-support.ts` | 导出 provider support predicate，供 runtime projection 和 handler 共用。 |
| `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` | 注册 `webSearchToolEntry`。 |
| `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` | 保存 `modelConnectionPort`；allowlist alias normalize；注册/过滤 WebSearch。 |
| `apps/zcode-cli/packages/core/src/runtime/internal.ts` | `AgentRuntimeInternal` 增加 `modelConnectionPort?: ModelConnectionPort`。 |
| `apps/zcode-cli/packages/core/src/runtime/methods/config.ts` | 删除 direct append `web_search`，`getTools()` 返回过滤后的 registry contracts。 |
| `apps/zcode-cli/packages/core/src/tool/scheduler.ts` | `READ_ONLY_TOOLS` 加回 `WebSearch`。 |
| `apps/zcode-cli/packages/core/src/permission/service.ts` | `isReadOnlyTool()` 加回 `WebSearch`。 |
| `apps/zcode-cli/packages/adapters/src/model/tool-transform.ts` | 保持 provider-native helper 映射；确认 public `WebSearch` 不进 provider-native branch。 |
| `apps/zcode-cli/packages/core/tests/websearch.test.ts` | 主红绿测试：schema、registry、runtime projection、handler side request。 |
| `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts` | 主请求 tool list 从 `web_search` 改为 `WebSearch`。 |
| `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts` | Explore child tool list 从 `web_search` 改为 `WebSearch`。 |
| `apps/zcode-cli/packages/core/tests/scheduler.test.ts` | WebSearch read-only/concurrent scheduling coverage。 |
| `apps/zcode-cli/packages/adapters/tests/websearch.test.ts` | provider-native mapping 改为内部 `web_search` contract 语义。 |
| `apps/zcode-cli/packages/adapters/tests/runner.test.ts` | 保持内部 native request body / providerExecuted normalization coverage。 |
| `apps/zcode-cli/tools/prompt-trajectory/testcases/*` | 增加或更新 WebSearch request-body fixtures。 |

## Phase Gate

每个 phase 完成后停止给用户 review：

1. 本 phase diff 摘要。
2. Focused test 命令和结果。
3. 影响面：provider-visible request、runtime lifecycle、UI/remote、docs。
4. Residual risk。
5. 不自动 commit。

## Phase 0: Spec and Red Tests

**Files:**
- Modify: `apps/zcode-cli/docs/design/v2/tool/13-websearch.md`
- Modify: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`
- Modify: `apps/zcode-cli/packages/core/tests/websearch.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/websearch.test.ts`

- [x] **Step 0.1: Rewrite the WebSearch spec**

Replace `13-websearch.md` with a spec whose top-level conclusion states:

```markdown
# WebSearch Wrapper Tool

## 结论

`WebSearch` 是主模型可见的普通 client-side tool。模型调用 `WebSearch`
后，ZCode 在 tool handler 内部发起一个只包含 provider-native `web_search`
的 model request。内部 request 返回后，ZCode 把 links/sources 格式化为
普通 tool result，回灌给主模型继续生成最终答案。

主模型请求不得直接暴露 provider-native `web_search`。
```

- [x] **Step 0.2: Update provider-native checklist wording**

In `00-tool-change-chain.md`, replace the WebSearch direct exposure paragraph with:

```markdown
WebSearch 当前目标采用 side request 形态：主 loop 注册普通 `WebSearch`
client-side tool；`web_search` provider-native contract 只在 `WebSearch`
handler 内部 request 中出现。外层 `WebSearch` 必须完整经过 ToolExecutor、
permission、hook、scheduler、事件、resultBudget 和 tool result history。
```

- [x] **Step 0.3: Write failing public schema tests**

In `apps/zcode-cli/packages/core/tests/websearch.test.ts`, change the schema test to:

```ts
it("exposes WebSearch schema without unsupported provider-native no-op options", () => {
  const properties = WebSearchInputJsonSchema.properties as Record<string, unknown>;

  expect(properties.query).toBeDefined();
  expect(properties.allowed_domains).toBeDefined();
  expect(properties.blocked_domains).toBeDefined();
  expect(properties.allowedDomains).toBeUndefined();
  expect(properties.blockedDomains).toBeUndefined();
  expect(properties.maxUses).toBeDefined();
  expect(properties.searchContextSize).toBeUndefined();
  expect(properties.numResults).toBeUndefined();
  expect(properties.safeSearch).toBeUndefined();
});
```

- [x] **Step 0.4: Write failing registry/runtime projection tests**

In `apps/zcode-cli/packages/core/tests/websearch.test.ts`, replace the unregistered/direct-native assertions with:

```ts
it("registers WebSearch as a client-side built-in tool", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, { includeAgent: true });

  expect(registry.has("WebSearch")).toBe(true);
  expect(registry.has("web_search")).toBe(false);
  expect(registry.toContracts()).toContainEqual(
    expect.objectContaining({
      executionMode: "client",
      name: "WebSearch",
      providerNative: undefined,
    }),
  );
});

it("does not add direct provider-native web_search to main model contracts", () => {
  const runtime = createRuntime("runtime-websearch-client-wrapper");
  const tools = runtime.getTools();

  expect(runtime.getToolRegistry().has("WebSearch")).toBe(true);
  expect(tools).toContainEqual(
    expect.objectContaining({
      executionMode: "client",
      name: "WebSearch",
      providerNative: undefined,
    }),
  );
  expect(tools.some((tool) => tool.name === "web_search")).toBe(false);
});
```

- [x] **Step 0.5: Write failing handler side request test**

Add this focused test to `websearch.test.ts`:

```ts
it("runs an internal provider-native web_search request from the WebSearch handler", async () => {
  const sessionId = createSessionId("runtime-websearch-handler-side-request");
  const eventStore = createTestSessionEventStore();
  const requests: any[] = [];
  const runtime = new AgentRuntime(sessionId, { modelRef }, {
    eventStore,
    modelAdapter: {
      async generateText(request: any) {
        requests.push(request);
        if (request.metadata?.querySource === "web_search_tool") {
          return {
            finishReason: "stop",
            model: request.model,
            providerMetadata: undefined,
            text: "Search summary",
            toolResults: [
              {
                id: "server_search_1",
                name: "web_search",
                output: [{ type: "web_search_result", title: "Example", url: "https://example.com" }],
                providerExecuted: true,
              },
            ],
            sources: [{ sourceType: "url", title: "Example", url: "https://example.com" }],
            usage: {
              inputTokens: 5,
              outputTokens: 7,
              totalTokens: 12,
              serverToolUse: { webSearchRequests: 1 },
            },
          };
        }
        return {
          finishReason: "tool-calls",
          model: request.model,
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: "call_websearch",
              name: "WebSearch",
              input: { query: "latest zcode", allowed_domains: ["example.com"] },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      resolveConnection() {
        return {
          providerId: "deepseek",
          providerKind: "anthropic",
          baseURL: "https://api.deepseek.com/anthropic",
        };
      },
    } as never,
  });

  await runtime.executeTurn("Search current ZCode info");

  const innerRequest = requests.find((request) => request.metadata?.querySource === "web_search_tool");
  expect(innerRequest).toBeDefined();
  expect(innerRequest.messages).toEqual([
    { role: "system", content: "You are an assistant for performing a web search tool use." },
    { role: "user", content: "Perform a web search for the query: latest zcode" },
  ]);
  expect(innerRequest.tools.map((tool: any) => tool.name)).toEqual(["web_search"]);
  expect(innerRequest.tools[0]).toMatchObject({
    executionMode: "providerNative",
    providerNative: expect.objectContaining({
      logicalName: "WebSearch",
      providerToolName: "web_search",
      args: expect.objectContaining({
        allowedDomains: ["example.com"],
        maxUses: 8,
      }),
    }),
  });
  expect(innerRequest.tools[0].providerNative.args).not.toHaveProperty("searchContextSize");
  expect(innerRequest.toolChoice).toBeUndefined();
});
```

Add the overload used above:

```ts
function createRuntime(
  sessionId: string,
  config: ConstructorParameters<typeof AgentRuntime>[1] = {},
  deps: Partial<ConstructorParameters<typeof AgentRuntime>[2]> = {},
): AgentRuntime {
  return new AgentRuntime(
    createSessionId(sessionId),
    {
      modelRef,
      ...config,
    },
    {
      eventStore: createTestSessionEventStore(),
      ...deps,
    },
  );
}
```

- [x] **Step 0.6: Run red tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/websearch.test.ts tests/main-tool-pool.test.ts tests/subagent-explore.test.ts
pnpm --filter @zcode/adapters exec vitest run tests/websearch.test.ts
```

Expected: FAIL with old direct provider-native behavior:

- public schema still has `allowedDomains`.
- registry does not have `WebSearch`.
- runtime tools still include `web_search`.
- handler side request test cannot execute because `WebSearch` is not registered.

## Phase 1: Contract Split

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/tools/websearch.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/websearch-results.ts`
- Modify: `apps/zcode-cli/packages/core/tests/websearch.test.ts`

- [x] **Step 1.1: Replace public input schema with snake_case**

In `websearch.ts` contracts, use this shape:

```ts
export const WebSearchInputSchema = z
  .object({
    query: z.string().min(2).describe("The search query to use"),
    allowed_domains: z
      .array(DomainSchema)
      .max(20)
      .optional()
      .describe("Only include search results from these domains"),
    blocked_domains: z
      .array(DomainSchema)
      .max(20)
      .optional()
      .describe("Never include search results from these domains"),
  })
  .strict()
  .refine((input) => !(input.allowed_domains?.length && input.blocked_domains?.length), {
    message: "allowed_domains and blocked_domains cannot both be specified",
    path: ["blocked_domains"],
  });
```

- [x] **Step 1.2: Add internal provider args type and normalizer**

In the same file, add:

```ts
export interface WebSearchProviderNativeArgs {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

export function toWebSearchProviderNativeArgs(
  input: WebSearchInput,
  defaults: { maxUses: number },
): WebSearchProviderNativeArgs {
  return {
    allowedDomains: input.allowed_domains,
    blockedDomains: input.blocked_domains,
    maxUses: input.maxUses ?? defaults.maxUses,
  };
}
```

- [x] **Step 1.3: Make the public contract client-side**

Change `WEBSEARCH_TOOL_CONTRACT` to:

```ts
export const WEBSEARCH_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "web_search",
  executionMode: "client",
  inputSchema: WebSearchInputJsonSchema,
  outputSchema: WebSearchOutputJsonSchema,
  permission: {
    permission: "websearch",
    reason: "WebSearch performs read-only provider-native web searches through an internal model request",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "network"],
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
    userVisibleMessage: "WebSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "full",
    recordOutput: "summary",
  },
};
```

Do not include `providerNative` on `WEBSEARCH_TOOL_CONTRACT`.

- [x] **Step 1.4: Update handler args mapping**

In `apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts`, import `toWebSearchProviderNativeArgs` and change the provider-native contract args:

```ts
providerNative: {
  ...WEBSEARCH_PROVIDER_NATIVE_SPEC,
  args: toWebSearchProviderNativeArgs(input, {
    maxUses: DEFAULT_MAX_USES,
  }),
},
```

- [x] **Step 1.5: Update input references**

Replace handler reads:

```ts
input.allowedDomains
input.blockedDomains
```

with:

```ts
input.allowed_domains
input.blocked_domains
```

The handler should still pass provider-native camelCase args to the adapter through `toWebSearchProviderNativeArgs(...)`.

- [x] **Step 1.6: Run contract tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/websearch.test.ts
```

Expected: schema tests pass; registry/projection tests still fail until Phase 2.

## Phase 2: Registry and Runtime Projection Cutover

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/websearch-support.ts`
- Modify: `apps/zcode-cli/packages/core/tests/websearch.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

- [x] **Step 2.1: Register the client tool**

In `handlers/index.ts` add:

```ts
import { webSearchToolEntry } from "./websearch.js";
```

and include it in `builtInTools` after `webFetchToolEntry`:

```ts
webFetchToolEntry,
webSearchToolEntry,
todoReadToolEntry,
```

- [x] **Step 2.2: Normalize legacy allowlist alias**

In `agent-runtime.ts`, add:

```ts
function normalizeBuiltInToolAllowlist(
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  return allowlist?.map((toolName) => (toolName === "web_search" ? "WebSearch" : toolName));
}
```

Then call it in `resolveBuiltInToolAllowlist(...)`:

```ts
const normalizedAllowlist = normalizeBuiltInToolAllowlist(config.toolAllowlist);

if (config.toolset !== "explore") {
  return normalizedAllowlist;
}

if (!normalizedAllowlist) {
  return EXPLORE_AGENT_ALLOWED_TOOLS;
}

return normalizedAllowlist.filter((toolName) => EXPLORE_AGENT_ALLOWED_TOOL_SET.has(toolName));
```

- [x] **Step 2.3: Store modelConnectionPort on runtime**

In `agent-runtime.ts`, add a private field:

```ts
private modelConnectionPort?: ModelConnectionPort;
```

Set it in the constructor before creating the executor:

```ts
this.modelConnectionPort =
  deps.modelConnectionPort ?? (deps.modelAdapter as ModelConnectionPort | undefined);
```

Pass `this.modelConnectionPort` into `createToolExecutor(...)`:

```ts
modelConnectionPort: this.modelConnectionPort,
```

In `runtime/internal.ts`, import `ModelConnectionPort` and add:

```ts
modelConnectionPort?: ModelConnectionPort;
```

- [x] **Step 2.4: Export a provider support predicate**

In `websearch-support.ts`, export:

```ts
export function supportsProviderNativeWebSearch(
  connection: Pick<ModelConnectionInfo, "baseURL" | "providerKind">,
): boolean {
  return (
    connection.providerKind === "anthropic" &&
    isWebSearchCapableBaseURL(connection.baseURL)
  );
}
```

Then simplify `assertProviderSupportsWebSearch(...)`:

```ts
if (!supportsProviderNativeWebSearch(connection)) {
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    "Current provider/model does not support native WebSearch",
    { context: { toolCallId, toolName: WEBSEARCH_TOOL_NAME }, recoverable: true },
  );
}
```

- [x] **Step 2.5: Remove direct provider-native append**

In `runtime/methods/config.ts`, remove:

```ts
WEBSEARCH_PROVIDER_NATIVE_SPEC
WEBSEARCH_TOOL_CONTRACT
WEBSEARCH_PUBLIC_TOOL_NAME
WEBSEARCH_PROVIDER_TOOL_NAME
withRuntimeProviderNativeTools(...)
shouldExposeProviderNativeWebSearch(...)
createProviderNativeWebSearchContract(...)
```

Replace `getTools()` with registry contracts plus capability filter:

```ts
export function getTools(this: AgentRuntimeInternal): ModelToolContract[] {
  if (this.cachedTools === null) {
    this.cachedTools = filterRuntimeVisibleTools.call(this, this.registry.toContracts());
  }
  return this.cachedTools;
}
```

Add:

```ts
function filterRuntimeVisibleTools(
  this: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  return tools.filter((tool) => {
    if (tool.name !== "WebSearch") return true;
    return shouldExposeWebSearch.call(this);
  });
}

function shouldExposeWebSearch(this: AgentRuntimeInternal): boolean {
  if (!this.modelConnectionPort) return true;
  try {
    const connection = this.modelConnectionPort.resolveConnection(this.defaultModelRef);
    return supportsProviderNativeWebSearch(connection);
  } catch {
    return true;
  }
}
```

Import `supportsProviderNativeWebSearch` from `../../tool/handlers/websearch-support.js`.

- [x] **Step 2.6: Update main/explore expectations**

In `main-tool-pool.test.ts`, change:

```ts
expect(toolNames).toContain("web_search");
expect(toolNames).not.toContain("WebSearch");
```

to:

```ts
expect(toolNames).toContain("WebSearch");
expect(toolNames).not.toContain("web_search");
```

In `subagent-explore.test.ts`, change expected child tools from:

```ts
"web_search",
```

to:

```ts
"WebSearch",
```

- [x] **Step 2.7: Run runtime projection tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/websearch.test.ts tests/main-tool-pool.test.ts tests/subagent-explore.test.ts
```

Expected: registry/projection tests pass; handler result formatting tests may still fail until Phase 3.

## Phase 3: Handler Result Formatting and Nested Usage

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/websearch-results.ts`
- Modify: `apps/zcode-cli/packages/core/tests/websearch.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/runner.test.ts`

- [x] **Step 3.1: Ensure inner request is side-request only**

Confirm `websearch.ts` handler request keeps this exact shape:

```ts
const result = await modelPort.generateText({
  model: {
    ...modelRef,
    role: modelRef.role ?? ModelRole.Main,
  },
  messages: [
    {
      role: "system",
      content: "You are an assistant for performing a web search tool use.",
    },
    {
      role: "user",
      content: `Perform a web search for the query: ${input.query}`,
    },
  ],
  tools: [createProviderNativeWebSearchContract(input)],
  // BigModel 的 Anthropic 兼容端点会拒绝 named forced web_search tool_choice（1210）。
  // 这里保持自动选择，依靠单工具请求和 prompt 触发 provider-native 搜索。
  maxOutputTokens: 4096,
  abortSignal: context.abortSignal,
  metadata: {
    traceId: context.traceId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
    toolName: WEBSEARCH_TOOL_NAME,
    querySource: "web_search_tool",
  },
  statusSink: createToolModelStatusSink(context),
  traceContext: webSearchTraceFromContext(context),
});
```

- [x] **Step 3.2: Tighten model-visible result reminder**

In `websearch-results.ts`, change the final reminder to:

```ts
lines.push(
  "",
  "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
);
```

- [x] **Step 3.3: Preserve typed web_search_tool_result hits**

Extend `collectResults(...)` so it handles typed wrapper objects:

```ts
if (Array.isArray(value.content)) {
  return value.content.flatMap((item) => collectResults(item));
}
```

Keep existing direct `url` extraction so both Anthropic provider typed results and OpenAI provider source-like results work.

- [x] **Step 3.4: Add formatter test**

In `websearch.test.ts`, add:

```ts
it("formats WebSearch tool results with markdown sources reminder", () => {
  const text = webSearchToolEntry.formatModelContent?.({
    query: "latest zcode",
    results: [{ title: "Example", url: "https://example.com" }],
    sources: [],
    durationMs: 10,
    webSearchRequests: 1,
    modelUsage: {
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      serverToolUse: { webSearchRequests: 1 },
    },
  });

  expect(String(text)).toContain('Web search results for query: "latest zcode"');
  expect(String(text)).toContain("- [Example](https://example.com)");
  expect(String(text)).toContain("markdown hyperlinks");
});
```

- [x] **Step 3.5: Run handler tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/websearch.test.ts
pnpm --filter @zcode/adapters exec vitest run tests/runner.test.ts
```

Expected: WebSearch handler side request, formatter, providerExecuted normalization, and nested usage extraction pass.

## Phase 4: Permission, Scheduler, Hooks, and Lifecycle

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/scheduler.ts`
- Modify: `apps/zcode-cli/packages/core/src/permission/service.ts`
- Modify: `apps/zcode-cli/packages/core/tests/scheduler.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/websearch.test.ts`

- [x] **Step 4.1: Add WebSearch to read-only scheduler set**

In `scheduler.ts`, change:

```ts
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "Agent",
  "Skill",
]);
```

- [x] **Step 4.2: Add WebSearch to permission read-only set**

In `permission/service.ts`, change `isReadOnlyTool(...)` to include:

```ts
"WebSearch",
```

Remove the old Chinese temporary-debug comments that said WebSearch does not enter local scheduling.

- [x] **Step 4.3: Add lifecycle assertions**

In `websearch.test.ts`, extend the handler side request test after `executeTurn(...)`:

```ts
const storedEvents = await eventStore.getEvents(sessionId);
expect(
  storedEvents.some(
    (event: any) =>
      event.type === SessionEventType.ToolCallResult &&
      event.payload?.toolName === "WebSearch",
  ),
).toBe(true);
```

- [x] **Step 4.4: Run lifecycle tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/websearch.test.ts tests/scheduler.test.ts
```

Expected: `WebSearch` is treated as read-only/concurrent safe and produces ordinary tool lifecycle events.

## Phase 5: Adapter Semantics and Prompt Trajectory

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/tests/websearch.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/runner.test.ts`
- Modify: `apps/zcode-cli/tools/prompt-trajectory/testcases/p12-tool-surface/main-and-explore/expect.json`
- Create: `apps/zcode-cli/tools/prompt-trajectory/testcases/websearch-client-tool/fixture.json`
- Create: `apps/zcode-cli/tools/prompt-trajectory/testcases/websearch-client-tool/expect.json`

- [x] **Step 5.1: Rename adapter test helper to internal native contract**

In `adapters/tests/websearch.test.ts`, change helper contract name to `web_search`:

```ts
function createInternalWebSearchContract(args?: Record<string, unknown>): ModelToolContract {
  return {
    name: "web_search",
    capability: "web_search",
    description: "Provider-native web search used internally by WebSearch",
    executionMode: "providerNative",
    inputSchema: WEBSEARCH_TOOL_CONTRACT.inputSchema,
    outputSchema: WEBSEARCH_TOOL_CONTRACT.outputSchema,
    providerNative: {
      ...WEBSEARCH_PROVIDER_NATIVE_SPEC,
      args,
    },
  };
}
```

Then update provider-native expectations from `tools?.WebSearch` to:

```ts
expect(tools?.web_search).toMatchObject({
  id: "anthropic.web_search_20260209",
  type: "provider",
});
```

Keep the existing public client tool test:

```ts
expect(tools?.WebSearch).not.toMatchObject({
  id: "anthropic.web_search_20260209",
  type: "provider",
});
```

- [x] **Step 5.2: Update runner native request tests**

In `runner.test.ts`, keep tests that verify provider request bodies can contain private `web_search`, but rename descriptions to say internal native request:

```ts
it("keeps internal web_search for allowlisted Anthropic-compatible side requests", async () => {
  ...
});
```

- [x] **Step 5.3: Update P-12 expect file**

In `p12-tool-surface/main-and-explore/expect.json`, change parent/explore expectations to no longer exclude `WebSearch` as out of scope. Expected final shape:

```json
{
  "expected": {
    "parentTools": {
      "contains": ["Agent", "WebSearch"],
      "doesNotContain": ["Glob", "Grep", "GoalRead", "web_search"]
    },
    "exploreChildTools": {
      "contains": ["Read", "Bash", "Glob", "Grep", "WebSearch"],
      "doesNotContain": ["Agent", "Skill", "Write", "Edit", "ApplyPatch", "GoalRead", "web_search"]
    }
  }
}
```

- [x] **Step 5.4: Add WebSearch client tool trajectory fixture**

Create `apps/zcode-cli/tools/prompt-trajectory/testcases/websearch-client-tool/fixture.json`:

```json
{
  "name": "websearch-client-tool",
  "description": "WebSearch should be exposed as a public function tool in outer requests; provider-native web_search should only appear in the internal web_search_tool request.",
  "turns": [
    {
      "user": "Search the web for current ZCode WebSearch behavior and cite sources."
    }
  ],
  "runtime": {
    "mode": "build",
    "workingDirectory": "/tmp/zcode-websearch-client-tool"
  }
}
```

Create `expect.json`:

```json
{
  "description": "Inspect derived request bodies. The main turn exposes WebSearch and not web_search. The internal web_search_tool request exposes only web_search.",
  "expected": {
    "mainTurnTools": {
      "contains": ["WebSearch"],
      "doesNotContain": ["web_search"]
    },
    "internalWebSearchTools": {
      "containsOnly": ["web_search"]
    }
  }
}
```

If prompt-trajectory cannot force a WebSearch tool call without live provider behavior, keep this testcase as a manual inspection fixture and rely on focused handler tests for the internal request.

- [x] **Step 5.5: Run adapter and trajectory checks**

Run:

```bash
pnpm --filter @zcode/adapters exec vitest run tests/websearch.test.ts tests/runner.test.ts
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases/p12-tool-surface --out-root out/websearch-client-tool-p12
```

Expected:

- Adapter maps only provider-native internal `web_search` contracts to native helpers.
- Public `WebSearch` stays a regular function tool.
- P-12 trajectory parent/explore request bodies contain `WebSearch`, not `web_search`.

## Phase 6: Docs Sweep and Full Validation

**Files:**
- Modify: `apps/zcode-cli/docs/design/v2/tool/README.md`
- Modify: `apps/zcode-cli/docs/design/v2/model/http-proxy.md`
- Modify: `apps/zcode-cli/docs/design/v2/compact/plan.md`
- Modify: `apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md`
- Modify: `apps/zcode-cli/docs/design/v2/loop/architecture.md`
- Modify: `apps/zcode-cli/docs/design/v2/tui-network-status-panel.md`

- [x] **Step 6.1: Replace stale direct-provider-native wording**

Run:

```bash
rg -n "direct provider-native|主请求.*provider-native|provider-native `web_search`|不注册本地 handler|不进入本地调度|ToolExecutor 不执行搜索" apps/zcode-cli/docs -g '*.md'
```

For every WebSearch hit, update wording to:

```markdown
WebSearch is a public client-side wrapper tool. Its handler sends an internal model request whose only provider-native tool is `web_search`.
```

Keep docs that describe generic provider-native behavior or adapter internals if they are not claiming main-turn direct exposure.

- [x] **Step 6.2: Run focused WebSearch suite**

Run:

```bash
pnpm --filter @zcode/core exec vitest run \
  tests/websearch.test.ts \
  tests/main-tool-pool.test.ts \
  tests/subagent-explore.test.ts \
  tests/scheduler.test.ts

pnpm --filter @zcode/adapters exec vitest run \
  tests/websearch.test.ts \
  tests/runner.test.ts
```

Expected: PASS.

- [x] **Step 6.3: Run repo-required gates**

Run:

```bash
CI=true pnpm typecheck
CI=true pnpm lint
```

Expected:

- `pnpm lint` should exit 0. Existing warnings may remain if oxlint reports warnings without nonzero exit.
- `pnpm typecheck` may fail on the current baseline `@zcode/shared` export/type errors unrelated to WebSearch. If it fails, capture the first 20 error lines and confirm none reference files touched by this WebSearch implementation.

- [x] **Step 6.4: Manual runtime check**

Status: current environment did not run a live external-provider smoke test because no
throwaway native-search provider credentials were configured for this review pass. The
runtime-equivalent check was completed with focused runtime tests plus prompt-trajectory
recordings:

- `packages/core/tests/websearch.test.ts` covers `ToolCallStarted` /
  `ToolCallResult`, `querySource: "web_search_tool"`, automatic internal
  tool choice, provider-native args, and nested `serverToolUse.webSearchRequests`.
- 本地 P-12 outer request 记录 `test20260608-213225`（未入库）
  confirms outer main/Explore request bodies expose `WebSearch` and not
  `web_search`.
- 本地 internal request 记录 `final3`（未入库）confirms the
  internal `web_search_tool` request exposes only `web_search` and the final
  outer request receives a formatted `WebSearch` tool result.

If a disposable real provider key is available, rerun this as a final smoke check with
a provider that supports native web search and confirm:

1. Main model request `tools[]` includes `WebSearch`.
2. Main model request `tools[]` does not include `web_search`.
3. Tool lifecycle shows `WebSearch` pending/running/completed.
4. Internal request metadata has `querySource: "web_search_tool"`.
5. Internal request `tools[]` contains only `web_search`.
6. Final answer cites links from WebSearch tool result.
7. Nested usage records `serverToolUse.webSearchRequests`.

## Final Acceptance Criteria

- Public provider-visible main/explore tool name is `WebSearch`.
- Private provider-native `web_search` never appears in outer main/explore `tools[]`.
- Handler internal request uses only provider-native `web_search` and does not set `toolChoice`.
- Public schema is `query`, `allowed_domains`, `blocked_domains`, `maxUses`.
- `allowedDomains`, `blockedDomains`, `searchContextSize`, `numResults`, `safeSearch` are not public provider-visible fields.
- Adapter provider-native mapping still works for internal requests.
- `WebSearch` is read-only, concurrent safe, low-risk, no approval by default.
- `WebSearch` triggers normal ToolExecutor lifecycle and tool result replay.
- Result text includes sources and markdown hyperlink reminder.
- No code path restores BigModel REST search or HTML fallback.
- Docs no longer describe WebSearch as direct main-turn provider-native exposure.
- No automatic commit has been made.

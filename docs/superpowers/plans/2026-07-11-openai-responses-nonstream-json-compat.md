# OpenAI Responses Non-stream JSON Compatibility Implementation Plan

> 2026-07-15 superseded note：本文记录当时的已完成实现过程；其中“compact 固定 non-stream”是
> 历史基线，不再是当前 transport 合同。JSON compatibility 实现继续保留，并由
> `2026-07-15-compact-stream-first-nonstream-fallback.md` 作为 HTTP fallback leg 复用。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让第三方 OpenAI Responses provider 省略 message `id` 与 output_text `annotations` 的非流式 JSON 仍能完成 compact，同时保持主会话 SSE、compact 非流式和其他协议不变。

**Architecture:** 在 adapter 中新增独立的 Responses JSON fetch 兼容器，并只组合到 `providerKind === "openai"` 的显式 `provider.responses` factory。兼容器只补两个已证实缺失字段；共享 business-error fetch、Chat Completions、Anthropic、Gateway 和 retry 生命周期保持不变。

**Tech Stack:** TypeScript、Vitest、AI SDK `@ai-sdk/openai`、Node HTTP fake server、ZCode compact E2E harness。

## Global Constraints

- 协议判据只使用 ZCode `providerKind === "openai"` 与 AI SDK `provider.responses` factory，不检查 URL、method、模型名、provider 名或 baseURL。
- 只补 `message.id === undefined` 和 `output_text.annotations === undefined`；其他 schema 问题不在本次范围内。
- 缺失 message ID 使用 Node `node:crypto.randomUUID()` 生成为 `msg_<UUIDv4>`；不新增 UUID 依赖或 collision resolver。
- 不修改 compact 的非流式调用，不做 stream fallback，不增加请求、重试、model-io、遥测或协议事件。
- `createProviderBusinessErrorFetch()` 继续只负责共享网络代理和业务错误识别。
- 使用 fake API key 与本地 fake server；不调用真实 provider。
- 生产代码严格遵循 RED → GREEN；先证明当前 AI SDK 在真实 adapter 链路失败。

---

### Task 1: Adapter Responses 兼容层 TDD

**Files:**

- Create: `apps/zcode-cli/packages/adapters/tests/openai-responses-json-compat.test.ts`
- Create: `apps/zcode-cli/packages/adapters/src/model/openai-responses-json-compat.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/registry.ts`

**Interfaces:**

- Consumes: `ProviderFetch = typeof globalThis.fetch`、`AiSdkModelRegistry`、`AiSdkModelAdapter.generateText()`。
- Produces: `createOpenAIResponsesJsonCompatFetch(baseFetch: ProviderFetch): ProviderFetch`。
- Produces: `normalizeOpenAIResponsesJson(value: unknown): Record<string, unknown> | undefined`；`undefined` 表示 body 不变。

- [x] **Step 1: 写真实 adapter 链路失败测试**

先只新增集成测试，不引用尚未存在的兼容模块。本地 HTTP server 对 `/responses` 返回：

```ts
{
  id: "resp_compact",
  model: "gpt-5.5-e2e",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "RESPONSES_COMPACT_SUMMARY_MARKER",
        },
      ],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
}
```

测试通过下面的真实路径发起请求：

```ts
const registry = new AiSdkModelRegistry({
  env: {},
  providers: {
    responses: {
      kind: "openai",
      apiKey: "sk-e2e-fake",
      baseURL,
    },
  },
});
const adapter = new AiSdkModelAdapter({
  registry,
  retry: { maxAttempts: 1 },
});

const result = await adapter.generateText({
  model: "responses/gpt-5.5-e2e",
  messages: [{ role: "user", content: "compact" }],
});

expect(result.text).toBe("RESPONSES_COMPACT_SUMMARY_MARKER");
expect(requests).toHaveLength(1);
expect(requests[0]?.url).toBe("/responses");
```

- [x] **Step 2: 运行 RED**

Run:

```bash
pnpm --dir apps/zcode-cli exec vitest run packages/adapters/tests/openai-responses-json-compat.test.ts
```

Expected: FAIL with adapter `Model request failed.`；cause 为 `AI_APICallError: Invalid JSON response`，validation issues 指向 `output[0].id` 与 `output[0].content[0].annotations`。不得是 server、路径或 API key 错误。

- [x] **Step 3: 在同一测试文件补兼容器边界测试**

在 RED 已确认后，为目标接口增加以下断言：

```ts
expect(
  normalizeOpenAIResponsesJson(missingFieldsBody),
).toMatchObject({
  output: [
    {
      id: expect.stringMatching(
        /^msg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      content: [{ annotations: [] }],
    },
  ],
});

expect(normalizeOpenAIResponsesJson(validBody)).toBeUndefined();
```

fetch 包装器还必须证明：合法 JSON、SSE、非 2xx、无效 JSON 返回原始 `Response` 实例；发生改写时保留 status、statusText 与普通 headers，并删除 `content-length`、`content-encoding`。

- [x] **Step 4: 实现最小兼容器**

```ts
type ProviderFetch = typeof globalThis.fetch;

export function createOpenAIResponsesJsonCompatFetch(
  baseFetch: ProviderFetch,
): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.ok || isEventStream(response)) return response;

    const body = await parseResponseJsonObject(response);
    if (!body) return response;
    const normalized = normalizeOpenAIResponsesJson(body);
    if (!normalized) return response;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(normalized), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}
```

归一化只遍历 `output` 中的 message item：顶层 `response.id` 是非空字符串时，使用 Node `node:crypto.randomUUID()` 为缺失的 message ID 补 `msg_<UUIDv4>`；output_text 缺失 annotations 时补 `[]`。使用浅复制，只为已确认的两个缺失字段建立兼容合同；其他 schema 问题不在本次范围内。

- [x] **Step 5: 只在显式 Responses factory 组合**

```ts
case "openai": {
  const provider = createOpenAI({
    apiKey,
    baseURL: providerConfig.baseURL,
    fetch: createOpenAIResponsesJsonCompatFetch(fetch),
    headers,
  });
  return provider.responses as LanguageModelFactory;
}
```

其他 factory 分支不修改。测试补一个 OpenAI-compatible fake server 对照，断言仍请求 `/chat/completions` 并成功。

- [x] **Step 6: 运行 GREEN 与 adapter 邻接回归**

Run:

```bash
pnpm --dir apps/zcode-cli exec vitest run \
  packages/adapters/tests/openai-responses-json-compat.test.ts \
  packages/adapters/tests/registry.test.ts
pnpm --dir apps/zcode-cli --filter @zcode/adapters typecheck
pnpm --dir apps/zcode-cli --filter @zcode/adapters lint
```

Expected: 两个测试文件、adapter typecheck 和变更文件定向 lint 通过；包级 lint 若命中未改文件的既有基线，留到 Task 3 如实记录。

### Task 2: 记录 F08 补充证据并增加 fake Responses compact E2E

**Files:**

- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: `apps/zcode-cli/e2e/compact-microcompact/constants.mjs`
- Modify: `apps/zcode-cli/e2e/compact-microcompact/suite-cases.mjs`
- Modify: `apps/zcode-cli/e2e/compact-microcompact/case-utils.mjs`
- Modify: `apps/zcode-cli/e2e/compact-microcompact/run.mjs`
- Modify: `apps/zcode-cli/e2e/compact-microcompact/scripted-provider.mjs`
- Modify: `apps/zcode-cli/e2e/compact-microcompact/README.md`
- Create: `apps/zcode-cli/e2e/compact-microcompact/case-openai-responses-compact.mjs`

**Interfaces:**

- Consumes: `startScriptedProvider()`、`writeProviderConfig()`、`createApp()`、`compactBoundaries()`。
- Produces: fake case `openai-responses-compact`，作为现有 F08 的 provider 兼容补充证据。
- Extends: scripted handler 可选返回 `{ bodyText: string, headers: Record<string, string>, status?: number }`；既有 `{ body, status? }` 保持兼容。
- Produces: dry-run 保留既有顶层 `model/baseURL`，suite 结果保留既有顶层 `model`；单 case
  可用 case-local model 覆盖顶层值，混合 suite 通过具体 case 的可选 `model` 表达例外。

- [x] **Step 1: 更新已确认的 NL→E2E 边界**

Responses 缺字段是 F08 手动 compact success 的 provider 输入变体，不新增会话产品状态。catalog
在 F08 分组下记录兼容边界，coverage matrix 的 F08 备注直接引用
`apps/zcode-cli/e2e/compact-microcompact/case-openai-responses-compact.mjs` 作为补充证据。
不得新增 F10、自动化缩写、产品统计或通用 coverage audit 规则；也不扩展 malformed JSON、
manual/auto、remote 或 provider 名排列。

- [x] **Step 2: 让现有 fake server 支持原始 SSE**

`scripted-provider.mjs` 按 handler 输出选择 body 与 headers：

```js
const responseBody = scripted.bodyText ?? JSON.stringify(scripted.body);
const responseHeaders = scripted.headers ?? { "content-type": "application/json" };

response.writeHead(scripted.status ?? 200, responseHeaders);
response.end(responseBody);
```

capture 同样保存实际 responseBody/responseHeaders。既有 JSON handler 行为不得改变。

- [x] **Step 3: 允许 case-local Responses provider 配置**

`writeProviderConfig()` 使用：

```js
kind: input.kind ?? "openai-compatible",
options: {
  ...(input.apiKey ? { apiKey: input.apiKey } : {}),
  apiKeyRequired: input.apiKeyRequired ?? true,
  baseURL: input.baseURL,
},
```

既有 fake case 继续走默认 `openai-compatible`；新 case 显式传 `kind: "openai"` 与 `apiKey: "sk-e2e-fake"`。

- [x] **Step 4: 新增 main SSE + compact JSON 场景**

main turn 返回以下最小 Responses SSE，每个 frame 使用空行分隔：

```text
data: {"type":"response.created","response":{"id":"resp-main-1","created_at":1,"model":"gpt-5.5-e2e","service_tier":null}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-main-1","phase":"final_answer"}}

data: {"type":"response.output_text.delta","item_id":"msg-main-1","delta":"RESPONSES_COMPACT_SETUP_ACK"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg-main-1","phase":"final_answer"}}

data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0}},"service_tier":null}}

data: [DONE]
```

compact 非流式响应的 output text 固定为：

```text
<analysis>compat e2e</analysis><summary>RESPONSES_COMPACT_SUMMARY_MARKER: compact succeeded.</summary>
```

该响应只省略已确认的两个字段。case 断言：

- 所有模型请求 pathname 都是 `/responses`，不存在 `/chat/completions`；
- main request `stream === true` 且成功返回 setup marker；
- compact request `stream !== true`，原始 capture response 确实缺两个字段；
- 只有一个 compact provider 请求；
- `CompactBoundary` 为 manual/standalone/user-requested；
- compact `ModelComplete` content 含 summary marker，最终响应是 `Compacted`。

- [x] **Step 5: 注册 fake case 并更新运行说明**

把 `openai-responses-compact` 加入 `CASE_NAMES`、`FAKE_CASE_NAMES` 和 `suite-cases.mjs`；README 增加：

```bash
pnpm --filter zcode-cli exec tsx ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs \
  --case=openai-responses-compact
```

- [x] **Step 6: 构建并运行定向 E2E**

Run:

```bash
pnpm --dir apps/zcode-cli build
pnpm --filter zcode-cli exec tsx \
  ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs \
  --case=openai-responses-compact
pnpm audit:conversation-session-coverage
```

Expected: case status `passed`，captured provider requests 同时证明 main SSE 与 compact non-stream；coverage audit 通过。
coverage audit 必须保持原有 product/covered 统计，且生成文档保持 `0 stale, 0 missing`。

### Task 3: 全量验证与文档一致性

**Files:**

- Modify: `docs/superpowers/specs/2026-07-11-openai-responses-nonstream-json-compat-design.md`
- Create: `docs/superpowers/plans/2026-07-11-openai-responses-nonstream-json-compat.md`
- Verify only: Task 1、Task 2 的生产代码与测试文件。

**Interfaces:**

- Consumes: 已通过的 adapter tests 和 `openai-responses-compact` fake E2E。
- Produces: 与 typed factory 判据一致的 spec/plan 和静态门禁结果。

- [x] **Step 1: 自查 spec/plan 不再使用 URL 判据**

Run（只检查生产实现；E2E 对实际 wire pathname 的断言不是协议判据）：

```bash
if rg -n 'pathname|endsWith\(.*/responses|request\.method' \
  apps/zcode-cli/packages/adapters/src/model/openai-responses-json-compat.ts; then
  exit 1
fi
```

Expected: 无输出且退出码为 0，生产兼容器没有 URL/method guard。

- [x] **Step 2: 运行仓库要求的静态门禁**

Run:

```bash
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm typecheck
pnpm lint
git diff --check
```

Expected: 所有命令退出码为 0；若存在与本改动无关的基线失败，保留完整输出并明确区分，不得宣称通过。

执行结果：两套 typecheck、根仓库 lint、CLI build、变更文件定向 lint/语法/格式和
`git diff --check` 通过；CLI 全量 lint 仍被未改文件的既有 `max-lines` 等规则失败阻塞，
未在本任务中顺手清理。

- [x] **Step 3: 审查最终 diff**

确认：

- shared `createProviderBusinessErrorFetch()` 没有 Responses 归一化代码；
- `openai` 显式返回 `provider.responses`，其他 factory 未改；
- 没有 URL/provider/model allowlist、stream fallback、额外 retry 或 model-io；
- E2E 只作为 F08 的 provider 补充证据，不新增产品 case 或扩大 remote/auto/malformed JSON 覆盖声明；
- 工作区没有无关改动。

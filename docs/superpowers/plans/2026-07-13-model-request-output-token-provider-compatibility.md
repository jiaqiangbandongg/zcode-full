# 模型请求输出预算与 provider 兼容实施计划

> 状态：产品边界已确认，可按本文执行。本文只处理模型输出预算与标准请求字段，不改变模型返回结果的完成态、错误态或重试语义。

**Goal:** 统一模型输出预算计算与已验证的 provider 兼容逻辑，同时保持 ZCode 当前默认请求上限为 64,000：用户 provider config 中的 `limit.output` 表示模型能力上限并优先于 catalog；正常模型请求按独立的全局请求上限裁剪，并通过 AI SDK 向 OpenAI Compatible、OpenAI Responses 和 Anthropic 发送各自的标准字段；对已验证组合省略请求上限，并在 Snowflake Cortex 最终请求边界改写字段名。

**Architecture:** App 侧 `modelProviderService` 负责保证用户配置优先、catalog 只补缺失；core 用内部 `maxOutputTokensSource` 区分正常模型能力预算与 Compact 的内部派生预算；adapter 集中计算正常请求的有效输出预算，并在 AI SDK 序列化前应用小范围 provider 兼容规则；AI SDK 负责把保留下来的通用 `maxOutputTokens` 映射为不同协议的最终字段。

**Tech Stack:** TypeScript、Vitest、Vercel AI SDK、pnpm、turbo。

## 背景与当前问题

当前实现同时存在两个问题：

1. core 和 adapter 都会把模型输出能力预先截断到 64,000；OpenAI Compatible 的 `runtime-default` 又会在 adapter 中被省略，因此自定义网关可能回退到供应商的小默认值。
2. App 读取 `~/.zcode/v2/config.json` 时，catalog 的 `maxOutputTokens` 可以覆盖用户已经配置的 `model.limit.output`，与已确认的配置优先级相反。

请求预算逻辑是：

```ts
effectiveMaxOutputTokens = Math.min(
  model.limit.output ?? globalOutputTokenMax,
  globalOutputTokenMax,
);
```

ZCode 为减少行为变化，继续使用现有 64K 作为默认值，并提供独立环境变量覆盖。

## 已确认边界

### 纳入本次修复

- 用户 provider config 的 `model.limit.output` 优先；catalog/models.dev 只补缺失能力事实。
- 新增独立全局请求上限 `ZCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`，仅接受正整数，未配置或非法时默认 64,000。
- 正常请求的有效预算为 `min(modelLimit ?? globalCap, globalCap)`。
- 主轮次和 Target Completion Verification 都属于正常模型请求，使用相同预算策略。
- OpenAI Compatible、OpenAI Responses、Anthropic 都通过通用 `maxOutputTokens` 进入 AI SDK，并验证最终请求体字段。
- OpenAI Compatible 默认发送 `max_tokens`；仅对 provider id 包含 `github-copilot` 的 GPT 模型，在 adapter 请求参数边界省略。
- provider id 精确为 `openai` 时，在 AI SDK 序列化前省略 `maxOutputTokens`；其他使用 Responses 协议的自定义 provider 保持发送标准 `max_output_tokens`。
- `snowflake-cortex` 在最终 JSON request body 边界把 `max_tokens` 改名为 `max_completion_tokens`；字段不存在时不重写 body。
- Anthropic fixed thinking 继续沿用现有“先从可见输出预算扣除 thinking budget，再由 SDK 形成协议请求”的换算，这是 ZCode 保留的协议适配差异。

### 不纳入本次修复

- 不改变空文本、`finishReason=length`、完成态、错误态、队列或自动重试行为。
- 不修改 Compact 的窗口、20K summary budget、thinking 配置或当前发送策略；`runtime-default` 继续使用独立固定 64K 保护，不受通用 global cap 影响。
- 不修改 `extra_body` 的合并、展开或覆盖规则。
- 不新增或替换 GLM、DeepSeek 等具体模型的硬编码能力事实。
- 不对未知 provider 做运行时探测、失败重试或自动学习兼容规则。
- 不增加设置页或其他 UI 配置入口。
- 不修改桌面 continuous、手机 replayable、远程 workspace 或 app-agent 外部协议。

## 行为契约

### 配置优先级

```text
用户 provider config 的 model.limit.output
  > catalog / models.dev 中已有能力值
  > 未知模型
```

catalog 只填充缺失值，不覆盖用户已经显式配置的值；缺失 metadata 的既有补齐与持久化流程保持不变。

### 请求预算

```ts
const globalCap = positiveInteger(adapterEnv.ZCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX) ?? 64_000;
const modelLimit = positiveInteger(model.maxOutputTokens);
const effectiveMaxOutputTokens = Math.min(modelLimit ?? globalCap, globalCap);
```

| 模型 `limit.output` | 全局上限 | 正常请求预算 |
| ------------------: | -------: | -----------: |
|              32,768 |   64,000 |       32,768 |
|             131,072 |   64,000 |       64,000 |
|             131,072 |  131,072 |      131,072 |
|              未配置 |   64,000 |       64,000 |

### 最终协议字段

| Provider kind         | 最终请求字段            | 正常请求默认行为                   |
| --------------------- | ----------------------- | ---------------------------------- |
| `openai-compatible`   | `max_tokens`            | 默认发送；一个已验证组合省略       |
| `openai`（Responses） | `max_output_tokens`     | provider id 为 `openai` 时省略     |
| `anthropic`           | `max_tokens`            | 显式发送；保留 fixed thinking 换算 |
| `snowflake-cortex`    | `max_completion_tokens` | 从最终 `max_tokens` 精确改名       |

`gateway` / `custom` 不再因 provider kind 被统一省略；它们接收 AI SDK 的通用 `maxOutputTokens`，具体协议投影仍由各自 provider 实现负责。

兼容规则只使用 provider id 与 model id 的已验证组合，不改变其他 provider 的默认发送行为。
字段省略在 AI SDK 序列化前完成；Snowflake Cortex 字段改名在最终 JSON request body 边界完成。

---

### Task 1：先更新输出预算与 provider config spec

**Files:**

- Modify: `docs/model-request-output-tokens.md`
- Modify: `docs/model-provider-config-overrides.md`
- Modify: `docs/model-provider-json-schema.md`

- [x] 在 `model-request-output-tokens.md` 写明默认 64K、环境变量覆盖、`min(modelLimit ?? globalCap, globalCap)` 公式、三种标准协议字段和 Anthropic thinking 差异。
- [x] 在 `model-provider-config-overrides.md` 删除 catalog 覆盖用户 `maxOutputTokens` 的旧规则，改为 catalog 仅补缺失。
- [x] 在 `model-provider-json-schema.md` 修正“`maxOutputTokens` 不会自动进入 OpenAI Compatible 请求”的旧描述；不调整其他 provider options 设计。
- [x] 检查三份文档之间不存在“已知模型直传且不受全局 cap”“Responses 继续省略”或“catalog 覆盖用户值”等冲突表述。

### Task 2：修复 App provider config 的优先级

**Files:**

- Modify: `packages/services/src/model-provider/modelProviderServiceStorage.ts`
- Test: `packages/services/test/modelProviderService.test.ts`

- [x] 先修改现有 config 读取测试：用户已经配置的 `limit.output` 必须在 service 返回值和持久化文件中保持不变。
- [x] 新增缺失值用例：用户模型未配置 `limit.output` 时，catalog 仍可补充 `maxOutputTokens`。
- [x] 运行目标测试并确认修改前失败：

```bash
pnpm exec vitest run packages/services/test/modelProviderService.test.ts
```

- [x] 从 `readZCodeConfigProviders` 移除 `maxOutputTokens` catalog override 白名单；删除仅服务于该覆盖行为的类型、常量和条件分支，使 `applyCatalogModelMetadata` 对该字段恢复 fill-only。
- [x] 保持旧 `model-providers.json` 迁移路径和其他 metadata 补缺逻辑不变。
- [x] 重跑目标 service 测试并确认通过。

### Task 3：实现预算公式和请求来源边界

**Files:**

- Modify: `apps/zcode-cli/packages/contracts/src/model/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`
- Delete: `apps/zcode-cli/packages/core/src/runtime/methods/model-output-tokens.ts`
- Add: `apps/zcode-cli/packages/core/src/runtime/methods/compact-output-tokens.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/model-request-output-tokens.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/runner-options.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-model-anomaly.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

- [x] 先为 adapter 增加预算真值表测试，generate/stream 共用同一组期望：
  - 模型 32,768 + 默认全局 64,000 → 32,768；
  - 模型 131,072 + 默认全局 64,000 → 64,000；
  - 模型 131,072 + 环境变量 131,072 → 131,072；
  - 模型未配置 + 默认全局 64,000 → 64,000；
  - 环境变量为 `0`、负数、非数字或非整数时 → 回退 64,000。
- [x] 扩展内部来源类型为 `"runtime-default" | "model-capability"`，同步 TypeScript 类型和 JSON schema；该字段仍只属于 core→adapter 内部模型请求，不修改外部 ZCode Protocol。
- [x] 主轮次设置 `maxOutputTokensSource: "model-capability"`。
- [x] Target Completion Verification 改为传递原始模型能力值并设置 `maxOutputTokensSource: "model-capability"`，不再在 core 预先截断到 64K。
- [x] `model.ts` 对 `model-capability` 不再调用 core 的固定 64K precap，让 adapter 统一计算；其他未标记调用保持现状。
- [x] 将原有固定 cap 收窄为 `compact-output-tokens.ts` 中的 Compact 专用 64K 保护；普通请求不再复用该常量。
- [x] 在 adapter 中集中解析 `ZCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`，按行为契约计算正常请求预算；不要根据 `providerKind` 省略 `openai`、`openai-compatible`、`gateway` 或 `custom` 的正常预算。
- [x] Anthropic 在有效预算计算完成后继续执行现有 fixed thinking budget 扣减；默认环境下现有 64K 行为不变。
- [x] `compact-active.ts` 仅改为调用 Compact 专用裁剪函数，并用 compact 测试确认 summary budget 仍为 20,000、来源仍为 `runtime-default`。
- [x] 用 core 测试确认主轮次和 Target Completion Verification 的来源均为 `model-capability`，并确认现有模型异常处理断言没有变化。

目标测试：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- runner-options
pnpm --dir apps/zcode-cli --filter @zcode/core test -- runtime-model-anomaly runtime-tool-loop runtime-compact
```

### Task 4：验证三种协议的最终请求体

**Files:**

- Add: `apps/zcode-cli/packages/adapters/tests/model-output-tokens-wire.test.ts`
- Modify only if reusable setup is needed: existing adapter test helpers

- [x] 使用本地 fake fetch 捕获 AI SDK 最终 JSON request body，不只断言 `runner-options` 中间对象。
- [x] OpenAI Compatible：有效预算 64,000 最终为 `max_tokens: 64000`。
- [x] OpenAI Responses：有效预算 64,000 最终为 `max_output_tokens: 64000`。
- [x] Anthropic：默认预算最终为 `max_tokens: 64000`；再增加 fixed thinking 用例，验证现有 thinking 换算不会把最终总预算推过全局 cap。
- [x] 增加一个环境变量提高到 131,072 的 wire 用例，证明全局 cap 可以显式提高，而不是永久硬截断 64K。
- [x] 不在本测试中增加模型空回复、重试、UI 或 Compact 行为断言。

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- model-output-tokens-wire
```

### Task 4.1：加入已验证的 provider 例外

**Files:**

- Add: `apps/zcode-cli/packages/adapters/src/model/model-request-output-token-compat.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`
- Add: `apps/zcode-cli/packages/adapters/tests/model-output-token-provider-compat.test.ts`

- [x] 增加 provider/model family 的精确行为用例。
- [x] generate/stream 在同一 adapter 兼容函数中应用规则：
  - provider id 包含 `github-copilot` + model id 包含 `gpt` → 省略；
  - 其他 OpenAI Compatible → 保留。
- [x] 重跑移植测试、adapter 全量测试与 CLI typecheck。

### Task 4.2：补齐 OpenAI 与 Snowflake Cortex 请求兼容

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/model/model-request-output-token-compat.ts`
- Add: `apps/zcode-cli/packages/adapters/src/model/model-request-body-compat.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/registry.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/model-output-token-provider-compat.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/model-output-tokens-wire.test.ts`

- [x] provider id 精确为 `openai` 时省略 `maxOutputTokens`；相似但不相等的 provider id 保持发送。
- [x] `snowflake-cortex` 只在最终 JSON body 存在 `max_tokens` 时改名为 `max_completion_tokens`。
- [x] body 不是 JSON 字符串或不存在 `max_tokens` 时保持原请求不变。
- [x] 补充 Chat Compatible、Responses、Anthropic、Snowflake Cortex 的最终请求体断言。
- [x] Gemini、Bedrock 和 native runtime 当前没有对应 adapter/provider 实现，不为测试引入未使用的 SDK；登记为独立 provider 接入 action。

目标测试：

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- model-output-token-provider-compat
pnpm --dir apps/zcode-cli --filter @zcode/adapters test
pnpm --dir apps/zcode-cli typecheck
```

### Task 5：全量验证与提交

- [x] 运行受影响测试：

```bash
pnpm exec vitest run packages/services/test/modelProviderService.test.ts
pnpm --dir apps/zcode-cli --filter @zcode/adapters test
pnpm --dir apps/zcode-cli --filter @zcode/core test
pnpm --dir apps/zcode-cli --filter @zcode/contracts test
```

- [x] 执行两个 workspace 的机械检查：

```bash
pnpm typecheck
pnpm lint
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
```

- [x] 最终 diff 检查必须满足：
  - 没有 `finishReason=length` 或空回复状态改动；
  - 没有 `extra_body` 实现改动；
  - 没有 GLM/DeepSeek 模型能力硬编码；
  - `compact-active.ts` 只切换到 Compact 专用 64K 裁剪，不修改窗口、summary budget、thinking 或发送策略；
  - provider config 优先级、预算真值表和三协议 wire tests 均已覆盖。
- [ ] 用户明确要求提交时，只提交本计划范围内的文件并使用 Conventional Commit；不包含工作区内其他既有改动。

执行结果：根 workspace typecheck 与 lint、CLI workspace 的 20 个 typecheck task 已通过；根 lint 为 75 warnings / 0 errors。CLI 全量 lint 仍被执行前已存在的 max-lines 等基线错误阻断，本次 adapter 请求代码定向 lint 为 0 warning / 0 error。Adapter 独立全量为 47 files passed、657 tests passed、2 skipped；bootstrap `model-config` 为 16 tests passed；provider service 为 105 tests passed；contracts 全量为 147 tests passed；受影响的 186 条 core 测试全部通过。CLI 全量测试已用 continue 模式执行，仍有本范围外的 core 边界守卫、bootstrap session、CLI SEA 资源和并发超时等基线失败。

## 验收标准

- 用户配置 `limit.output = 131072` 时，App 不再把它改写成 catalog 的 64000。
- 默认全局上限下，模型能力 131072 的正常请求发送 64000；设置 `ZCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=131072` 后发送 131072。
- 未提供模型能力时，正常请求发送默认 64000。
- OpenAI Compatible、OpenAI Responses、Anthropic 的最终请求体分别出现正确标准字段。
- 已验证的 OpenAI Compatible provider/model 组合以及 provider id 为 `openai` 的请求省略输出上限；通用 OpenAI Compatible 和自定义 Responses provider 保持发送。
- Snowflake Cortex 最终发送 `max_completion_tokens`，不同时保留 `max_tokens`。
- Anthropic fixed thinking 行为保持兼容。
- Compact 的预算、窗口与 thinking 行为无变化。
- 空回复状态、`extra_body`、模型事实和 UI 均无行为变化。

# Agent Auto Compact Output Reserve Design

## 背景

Agent runtime 在发送模型请求前会用 `contextWindow - outputReserve` 作为输入侧自动压缩预算。`maxOutputTokens` 显式配置时，自动压缩策略使用该配置；未配置时，旧逻辑回退到 `32_000`。

Anthropic adapter 在未收到 `maxOutputTokens` 时，会为主模型请求补默认 `64_000` output tokens。开启 thinking 时，最终 Anthropic 请求体还可能在 `max_tokens` 上叠加 thinking budget，例如 `64_000 + 1_024`。

因此未配置模型 `limit.output` 时，自动压缩预算和真实模型请求预算存在默认值不一致：compact 侧按 `32_000` 预留输出，请求侧按 `64_000` 发出请求，导致输入侧阈值偏松。

模型目录中也存在大量 `limit.output > 64_000` 的模型，部分甚至等于或超过 `limit.context`。如果 auto compact 阈值直接使用这些超大 output 上限，`effectiveContextWindow` 会被扣到极小甚至 0，导致会话在有足够消息时过早压缩或反复压缩。阈值计算需要使用策略性 output reserve，而不是把 provider 宣称的最大输出上限完整当作每轮常态预留。

## 目标

- 未配置 `maxOutputTokens` 时，agent auto compact 默认 output reserve 使用 `64_000`。
- 显式配置的 `maxOutputTokens` 继续优先于默认值，但 auto compact 阈值和真实模型请求中的 output 上限都最大按 `64_000` 计算。
- `summaryReserveTokens` 仍可作为测试或策略覆盖项，但默认值和上限跟随 `64_000`。
- compact 日志中的 `effectiveContextWindow`、`inputBudgetTokens`、`outputReserveTokens` 反映压缩阈值使用的 capped reserve；`maxOutputTokens` 继续记录模型真实配置。

## 非目标

- 不修改用户配置文件格式。
- 不强制为所有自定义模型写入 `limit.output`。
- 不改变 adapter 已有的 Anthropic 默认 `64_000` 行为。
- 不在本次变更中实现 provider usage + 增量输入估算。

## 行为

当 runtime config 中 `maxOutputTokens` 缺失时：

```text
outputReserveTokens = 64_000
effectiveContextWindow = contextWindow - min(64_000, contextWindow)
autoCompactThreshold = floor(effectiveContextWindow * 90%)
```

当 runtime config 中 `maxOutputTokens` 存在时：

```text
rawOutputReserveTokens = maxOutputTokens
outputReserveTokens = min(rawOutputReserveTokens, 64_000)
effectiveContextWindow = contextWindow - min(outputReserveTokens, contextWindow)
```

示例：`contextWindow = 200_000` 且没有 `limit.output`：

- 旧逻辑：`effectiveContextWindow = 168_000`，阈值 `151_200`
- 新逻辑：`effectiveContextWindow = 136_000`，阈值 `122_400`

这会让 auto compact 在 Anthropic 默认 output 预算下更早触发，避免输入侧预算比真实请求更宽松。

示例：`contextWindow = 200_000` 且 `limit.output = 131_072`：

- 旧逻辑：`effectiveContextWindow = 68_928`，阈值 `62_035`
- 新逻辑：`effectiveContextWindow = 136_000`，阈值 `122_400`

这避免超大 output 上限把输入侧预算扣穿；模型目录仍可保留 `maxOutputTokens = 131_072` 作为原始能力信息，但运行时请求会按下面规则封顶。

同一模型请求发送给 provider 时也执行相同封顶：

```text
requestMaxOutputTokens = min(configuredMaxOutputTokens, 64_000)
provider max_tokens <= 64_000
```

Anthropic thinking 请求需要保留现有 thinking budget 扣减：先把 configured max output 封顶到 `64_000`，再扣掉 fixed thinking budget，避免 AI SDK 最终组装出的 `max_tokens` 超过 `64_000`。

## 验证

- `apps/zcode-cli/packages/core/tests/compact-policy.test.ts` 覆盖未配置 `maxOutputTokens` 时默认 reserve 为 `64_000`。
- `apps/zcode-cli/packages/core/tests/compact-policy.test.ts` 覆盖 `maxOutputTokens > 64_000` 时 auto compact reserve 封顶为 `64_000`。
- `apps/zcode-cli/packages/core/tests/runtime-model-anomaly.test.ts` 覆盖 runtime 传给 model adapter 的 `maxOutputTokens` 封顶。
- `apps/zcode-cli/packages/adapters/tests/runner-options.test.ts` 覆盖 AI SDK 请求 options 的 `maxOutputTokens` 封顶，以及 Anthropic thinking 扣减后的最终请求不超过 `64_000`。
- 回归执行：
  - `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/runner-options.test.ts tests/runner.test.ts`
  - `pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/runtime-model-anomaly.test.ts tests/compact-policy.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`

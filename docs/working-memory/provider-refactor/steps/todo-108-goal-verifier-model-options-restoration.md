# Todo 108：恢复 Goal Verifier 的思考等级与输出上限

> 状态：实现、Verifier 实际请求测试及逐项复审完成。2026-09-10。实施/测试证据、逐条边界复审及真实环境限制见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。

## 目标与裁决

Goal Verifier 沿用验证开始时 Session 的模型与思考配置，使用该模型按当前配置体系解析出的输出上限；不得因为属于内部调用就强制降低思考等级或另设 5,000 Token 封顶。

恢复原有产品语义，保留当前 Provider / ModelSelection / ModelFactory 抽象，不恢复旧接口或旧配置来源。

## 已确认事实与根因

- 已核对远端 `main` 为 `e7921fb5d484d9c9d22d2e638064163fd13143a6`。其 Verifier 读取验证开始时的 `defaultModelRef` 和 `modelProviderOptions`，没有独立覆盖思考等级。
- main 的 `resolveNormalRequestMaxOutputTokens` 使用 Model 已解析的 `maxOutputTokens`；有效值原样取整使用，缺失或无效才兜底 32,000。32,000 不是封顶，Verifier 没有专用 5,000 限制。
- 当前 Verifier 仍先读取 Session ModelSelection 并创建 Model，但提交 `5aaddd0bdf` 将请求参数改为 `auxiliaryModelOptions(model)`：强制 `reasoningLevel.values[0]`，并设置 `min(5000, maxOutputTokens.max)`。
- 根因是把 Goal Verifier 归入了低成本辅助调用策略；统一调用实现时同时改变了业务行为，不是单纯接口迁接。
- 相关代码：`apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`、`apps/zcode-cli/packages/core/src/model/auxiliary-model-options.ts`。

## 实施要求

1. 移除 Verifier 对上述降档、5,000 封顶策略的使用。请求继承创建所得 Model 的思考配置，不另行改选最低档、最高档或关闭档。
2. 输出上限遵循当前统一模型配置与请求规则，不在 Verifier 新增预算、兜底或封顶。main 的 32,000 仅作为历史行为说明；当前配置完整性已有统一保证，不为恢复行为重新引入旧 Runtime fallback。
3. 模型在验证开始时确定；本次请求、重试和用量归因使用同一执行 Model。验证中途修改 Session 选择，不得修改已经开始的验证，也不得把 Verifier 参数回写到 Session。

   ```text
   验证开始
     -> 读取 Session ModelSelection
     -> 按现有统一入口创建执行 Model
     -> 请求 / 重试 / 用量归因共用该 Model

   期间 Session 改选 -> 只影响之后新创建的执行
   ```

4. 不全局修改或删除 `auxiliaryModelOptions`；标题生成等其他调用的既有策略不在本轮恢复范围内。
5. 不改变 Verifier Prompt、结果解析、失败处理、取消语义、Start Plan 重试、消息投影或 Provider 鉴权机制；不借机实施新的账号架构。

## 具体实现方案（2026-09-10 补充裁决）

以局部删除错误策略为主，不新增 Verifier 专用配置层、参数解析器或辅助函数：

1. 保留 `getSessionModelSelection()` 与 `createRuntimeModel(...)` 的现有执行绑定入口。
2. 删除 Verifier 对 `auxiliaryModelOptions` 的导入及调用，直接在 `generateText` 请求中提供：

   ```ts
   options: {
     maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max,
   },
   ```

3. 不传 `reasoningLevel` 覆盖值，由现有 Model 请求准备逻辑合并已绑定参数并统一校验。不在 Verifier 重新判断档位名称或选择默认档。
4. 不能直接删除整个 `options`：当前普通 Turn 在 `turn-model-step.ts` 显式使用模型声明的输出上限，ModelFactory 不负责填充请求输出预算；Verifier 遵循同一边界。
5. 不因本次修复全局修改 `auxiliaryModelOptions`，不恢复旧 `defaultModelRef` / `modelProviderOptions` 读取路径，不添加 32,000 兜底或新的预算常量。
6. 在修改处留简短中文注释，说明 Verifier 不能套用低成本辅助调用的降档／封顶策略。无需为这一处直接取值再抽象一层。

## 测试与验收

- [x] 先补有区分力的回归测试，再修改代码；断言进入 Model 请求合并后实际使用的参数，不仅断言创建时的 Selection。
- [x] Session 选择非最低档（如 high / max），验证实际请求沿用该档位；关闭档同样保留，不强制开启。
- [x] 未显式指定思考档位时，遵循当前统一 Model 的解析语义，Verifier 不增加一套默认策略。
- [x] 输出上限大于 5,000、低于 5,000 均遵循模型配置；覆盖 64,000，防止误恢复成统一 32,000 封顶。
- [x] 验证中改选 Session、重试及用量记录仍使用开始时的执行 Model；Session 不被辅助参数污染。
- [x] 复核其他辅助调用参数不变，Verifier 的消息投影、取消及既有重试路径无回退。
- [x] 按整批执行相关定向测试、类型检查和 lint；复审业务恢复与当前抽象是否同时满足，不为小改逐项重复做全量回归或 Pro 验证。
- [x] 更新实施与验证记录，提交代码；未测部分明确说明，不把本地参数捕获写成真实供应商验证通过。

## 完成标准

Verifier 不再强制降档、不再额外封顶 5,000；保持统一 Model 创建与已绑定执行边界，相关回归通过并完成复审。该文档落盘不等于修复完成。

## 实施与复审记录

- 删除 Verifier 的辅助调用策略；只显式传当前 Model 的输出上限，不增加辅助层或预算 fallback。
- 新增 `adapters/tests/goal-verifier-model-options.test.ts`：真实 Runtime + SQLite + ExecutableModel 请求准备，捕获合并后参数。修复前 high/max/无显式档位三例失败，修复后 5/5 通过，包括 4,000、64,000、128,000 及 Start busy 重试期间 Session 改选。
- Core 既有 Verifier/verification 定向 22 条通过：用量绑定、取消、重试、媒体投影、目标循环和队列边界保持。更正两处旧 5,000 策略断言。
- 逐条复审：Factory/Selection 入口不变；每次验证只绑定一次 Model；请求、重试、usage 共享它；无 Session 回写；其他 auxiliary 调用和 helper 未改；Prompt、解析和失败策略未改。
- 根目录 `pnpm typecheck`、`pnpm lint` 通过（41 个既有 warning，0 error）；Adapters 类型检查通过。最终批次回归另行收口；以上为不联网的本地执行证据，不是供应商在线验证。

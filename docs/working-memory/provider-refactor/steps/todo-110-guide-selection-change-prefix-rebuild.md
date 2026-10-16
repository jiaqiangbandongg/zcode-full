# Todo 110：Guide 同选择重新解析，但不触发切模 System 重建

> 状态：实现、真实 Runtime 请求验证与逐项复审完成；新增桌面 GS/P06 未实跑。2026-09-10。实施/测试证据、逐条边界复审及真实环境限制见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。

## 目标与最高优先级裁决

区分两个事实：**执行 Model 重新解析**与**ModelSelection 发生变化**。

- Guide 携带 ModelSelection 时，即使选择没有变化，也必须通过当前统一入口重新解析配置、校验并创建执行 Model；相同 Provider、模型和档位不代表配置没有更新。
- 新解析出的 Model 用于后续请求；不能因为 Selection 相同就复用旧 Model、跳过配置解析，或继续使用旧的执行参数。
- 只有 Selection 本身发生变化，才触发 Guide 的切模 System 前缀重建。不得把“返回了 Model”“新 Model 对象与旧对象不同”当成切换的判断条件。
- 本轮只修上述触发条件，不修输出风格冻结问题，不重构 Provider、Selection、账号同步或 Guide 调度架构。

本文明确取代讨论中“相同选择复用旧 Model，不调用模型工厂”的初稿；不得按该初稿实施。

## 当前问题与相关入口

- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts` 的 `applySubmissionExecutionState()` 收到 Selection 后会创建并返回 Model。已有选择比较只控制 Session 模型选择事件，不阻止返回 Model。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-guide-drain.ts` 当前只判断 `if (guideModel)`，随即替换执行 Model 并调用 `rebuildContextPrefix()`；错误在于把获得 Model 与发生切换混为一谈。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` 的新 Turn / compact 路径也使用上述公共函数，不能为 Guide 修改公共行为而破坏这些调用。
- Session 保存的选择与当前 Loop 已绑定的执行模型可能不同：Bot 等入口可以更新 Session。因此，Guide 是否改变本次执行选择，应对比当前 Loop 的实际 Model，而非仅对比可变 Session 值。

## 预期链路

```text
Guide 在既定的下一次 model-step 边界被消费
  -> 正常追加 Guide 正文
  -> 记录切换前的执行选择（来自当前 Loop Model）
  -> 通过原有统一入口重新解析 / 校验 / 创建 Model
  -> 更新后续请求使用的执行 Model
  -> 比较 Guide 选择与切换前的执行选择
       相同 -> 不触发切模 System 前缀重建
       不同 -> 沿用现有切模 System 前缀重建
  -> 正常完成输入归属、模式等其他 Guide 处理

已经发出的模型请求 -> 继续使用原绑定，不被中途改写
```

## 实施要求

1. 选择比较涵盖 `providerId`、`modelId`、`options.reasoningLevel`，遵循现有完整 Selection 契约；换 Provider、换模型、只换推理档位均算变化。不按显示名称、对象引用或整份模型配置比较。
2. 在合适的现有边界分别表达解析所得 `model` 与 `selectionChanged`。可以通过小型返回结果或 Guide 局部计算实现；不要求为了一个布尔事实增加状态服务、缓存或重复持久化字段。
3. `selectionChanged` 只控制本次切模专属前缀重建，不控制是否重新解析 Model。选择相同但配置更新时，后续实际请求必须使用新 Model 的配置。
4. 不在公共应用函数开头用“选择相同”提前返回；不以旧 Model 作为 `preparedModel` 绕过本次解析。正常新 Turn 的模型创建及已有 prepared-model 用途不变。
5. 保留 Session 选择提交、持久化及事件的既有语义；Session 变化事件与当前执行是否需要重建前缀不是同一判断，不能简单用同一个布尔值替换两者。常规 Session / 执行 / Guide 三者选择一致时，不产生虚假模型切换事件。
6. Guide 的正文、模式更新、query / message 归属、工具限制合并、重复工具检测重置仍正常处理，不能因无需重建前缀而跳过。没有 Selection 的 Guide 沿用原行为。
7. 真实换模型时继续使用现有工厂校验和切换边界，不偷偷替换为其他模型，不吞掉解析失败。执行级临时绑定、Off-Peak 和既有继承保护不变。
8. 在修复处留中文注释，解释“配置重新解析不等于选择变化”。沿用统一 Model 下游消费机制，不新增第二套请求参数来源。
9. 更新现有相关 spec / 功能图中“Guide 总是创建并重建模型上下文”的笼统表述，明确重新解析与前缀重建的不同条件；不修改整个上下文冻结契约。

## 明确不做

- 不修真正切模时，前缀构造器读取最新 output style、而 reminder 仍使用本轮冻结样式的第二个问题。此问题独立保留，不以本 Todo 完成宣称已解决。
- 不通过删除 reminder、提前更新 reminder 或刷新全部冻结配置来掩盖上述第二个问题。
- 不改变 Guide admission、FIFO、提交 / 保存时机、桌面 continuous 与手机 replayable 链路，不新增发送前同步屏障。
- 不顺带修改数据库迁移、Bot 命令、Provider 配置规则或其他辅助调用策略。

## 测试与验收

先补测试，再实现；按整批组织定向回归和复审，不为每个小项重复全量回归或 Pro 验证。

- [x] 相同完整 Selection、配置不变：模型工厂仍调用，后续使用重新解析所得 Model；不重建 System，Guide 正文正常进入请求。
- [x] 相同完整 Selection、配置已改变：使用可观察的配置变化（如合法输出上限变化），断言后续实际请求采用新配置，同时 System 前缀不因切模逻辑改变。不能只断言工厂调用或只比较 Model 对象。
- [x] 相同 Selection 加运行模式变化：模式正常应用，前缀不因切模逻辑重建；输入归属及 Guide 其他状态处理不丢。
- [x] Provider、模型、推理档位分别变化：保持原有真实切换行为，后续请求使用新 Model，并按现有规则重建前缀。
- [x] 连续 Guide A→B、B→B：两次均正常解析，只有第一次触发切模前缀重建。
- [x] Session 保存选择与 Loop 执行选择不同：重建条件依据 Loop，Session 保存 / 事件仍遵循原提交语义，不混用两个变化判断。
- [x] 没有 Selection、解析失败、执行级临时绑定，以及下一轮继续选相同模型的路径无回退。
- [x] 用真实 Runtime 与不联网测试模型捕获前后请求：运行中改 output style 后提交相同选择的 Guide，正文出现，System 前缀不因此变化；不据此声称真实切模时的样式冻结问题也已修复。
- [x] 核对现有 Guide 交互 E2E，补充或更新最小有区分力的用例；保留桌面 / 手机共享 CLI 消费边界，不将单端通过写成全端实机通过。
- [x] 整批执行相关定向测试、`pnpm typecheck`、`pnpm lint`，复审公共调用、新 Model 下游使用、持久化与不在范围内的冻结语义。
- [x] 更新实施、验证及剩余限制记录并提交；待测与已通过分开陈述。

## 完成标准

同选择的 Guide 能获取更新后的模型配置，后续请求正确使用新 Model，但不误触发切模 System 重建；真实选择变化仍正常切换。相关测试和复审完成，未把输出风格冻结问题混入本次修复或完成声明。

## 实施与复审记录

- 复用 `turn-model` 的完整选择比较，仅在 Guide 中控制重建；比较旧 Loop Model 与新 Model，而非可变 Session 或对象引用。Factory 和 Session 提交逻辑不变，没有提前返回或 prepared-model 旁路。
- `guide-model-refresh.test.ts` 用真实 Runtime 捕获请求，旧实现 5 个同选择/连续 Guide 场景失败；修复后连同真实 Provider/模型/档位变化、双向 Session/Loop 差异共 9 场景通过。输出上限由 8,000 更新至 16,000，后续请求用新值而 System 保持旧值，Guide 文本/模式/归属正常。
- 5 文件 186 条定向回归通过（上述测试、旧 Guide 测试、Runtime model lifecycle/selection、完整 tool loop），Core 类型检查通过。
- 逐条复审：execution scope 分支不变；无选择、解析失败、新 Turn 与 prepared-model 仍走原路径；当前请求不受影响；工具限制、重复工具检测、message/query 更新仍在重建判断之外。没有增加同步/持久化/投影状态，也未触碰第二个输出风格冻结问题。
- GS/P06 加实际首轮/连续 Guide 请求前缀断言，catalog/matrix 同步。该新增 E2E 断言尚待整批桌面验证，不能沿用旧 formal 标记冒充本次已通过。

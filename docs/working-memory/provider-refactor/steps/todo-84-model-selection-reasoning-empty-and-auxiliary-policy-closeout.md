# Todo 84：Model Selection 缺失 Reasoning 与辅助请求策略收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已由 Todo 88 R11 完成修正与阶段验收；2026-09-08 同步状态。主动选模型取最高档已实现，不再作为待开发项；全端全量未运行项仍按 Todo 88 记录，不冒称全部通过。
>
> 日期：2026-09-05
>
> 关系：收口 Todo 58、Todo 60、Todo 63、Todo 70、Todo 81 中关于 Reasoning 缺失、失效和辅助调用的分散约定。

## 背景

2026-09-07 用户明确修正：用户主动选择新模型时，使用该模型当前有序档位的最高档 `values.at(-1)`。历史恢复、持久化选择缺失或档位失效，仍保留模型身份并清空档位。

两者属于不同的产品动作，不能为了统一实现而合并语义。主动选模入口显式构造完整 Selection，不等于在 Option Spec 新增 default，也不允许 ModelFactory 或请求层偷偷补值。辅助请求仍在自身调用点使用最低档位。

## 最终规则

### 1. 区分主动选模与已有选择恢复

```text
用户主动选择新模型
    -> 使用目标模型的最高 Reasoning 档位
    -> 形成包含该档位的新 Selection

恢复或重新校验已有 Selection
    -> 按下图保留有效值、清空失效部分
```

```text
Model Selection
      |
      v
当前 Registry 校验
      |
  +---+----------------------+
  |                          |
Provider/Model 无效       Provider/Model 有效
  |                          |
整份 Selection 置空       校验 reasoning
                             |
                    +--------+--------+
                    |                 |
                 有效              缺失/失效
                    |                 |
                 保留             保留 Provider/Model
                                 reasoning 置空
```

- 用户主动切换模型时取目标模型 `values.at(-1)`，不携带源模型档位；没有合法候选档位时不得伪造档位。
- 读取持久化 Selection、读取历史 Selection、配置刷新后重新校验已有选择时，遵循上述留空规则，不补最高档。
- 本次裁决不单独改变全新 Composer 的初始模型、Recent 或 Configured Default 优先级，也不改变账号切换的同模型/同档位衔接规则。
- Reasoning 为空的 Selection 不得进入普通模型执行；Composer 等待用户重新选择档位。
- Provider 或 Model 不存在时，不能猜测身份，整份 Selection 置空。
- 普通 Composer 对失效 Reasoning 只显示为空，不弹泛化的迁移失败通知；可执行任务（如 Automation、仍可能运行的 Off-Peak）在其原有错误位置提示无法继续运行，沿用 Todo 81 的场景化提示范围。

### 2. 辅助请求独立、显式选择档位

辅助请求不是在修复或补全 Model Selection，而是在一次调用中显式构造临时请求参数：

```text
辅助调用
  |
  +-- Title
  +-- Memory / Recall
  +-- Connectivity Test
  +-- Goal Completion Verification
  +-- 其他已明确标记为 sidecar 的请求
  |
  `--> reasoning = optionSpecs.reasoningLevel.values[0]
      maxOutputTokens = 调用方明确限制的预算
```

- 辅助调用不得回写 Composer、Session 或持久化 Selection。
- 最低档位策略只在辅助调用构造参数时出现，不能下沉成 Model Selection 的默认值。
- 普通 Goal 主执行和 Goal continuation 不属于低成本辅助请求，继续使用当前完整 Model Selection；只有 Goal Completion Verification 使用辅助策略。
- 连接测试继续显式使用最低档位，不依赖当前 Composer 的 reasoning 状态。

## 实施范围（已由 Todo 88 收口，保留验收要求）

1. 恢复用户主动选模时取最高 Reasoning 的公共构造入口及调用，补充与历史恢复留空的区别测试；不将补值下沉至执行层。
2. 保证所有普通 Selection 进入执行前都要求有效 Reasoning；禁止 ModelFactory 或其他下层静默补档位。
3. 保留并统一“Provider/Model 无效整份置空、Reasoning 无效只清空 Reasoning”的恢复语义。
4. 检查 Composer、Session 恢复、Model Selection View、Automation、Off-Peak、Subagent、Bot、Repo Wiki 等消费方，避免各自重新猜测或补齐 Reasoning。
5. 明确辅助请求的调用点和测试边界，尤其确认 Goal 主执行不会误走 `auxiliaryModelOptions`，Goal Completion Verification 才使用最低档位。
6. 清理与旧“最高档默认补齐”规则相关的命名、注释、文档和测试，避免保留桥接逻辑。

## 验收标准

- 用户主动选择新模型后，默认档位为该模型当前最高档；持久化/历史恢复及已有选择校验发现缺失或失效 Reasoning 时仍留空，不自动降档或升档。
- Provider/Model 失效时整份 Selection 为空；Reasoning 单独失效时模型身份仍保留。
- Composer 可以识别空 Reasoning 并要求用户重新选择，但不显示无法修复的泛化迁移通知。
- Automation、可继续执行的 Off-Peak 等任务在空 Selection 时不会运行，并在原任务位置给出可理解的错误提示。
- 普通 Goal 设置、Goal continuation 使用当前完整 Selection；Goal Completion Verification 使用最低 Reasoning 和自己的输出预算。
- Title、Memory、Connectivity 等辅助请求仍显式传入最低档位，且不修改任何持久化 Selection。
- 覆盖新建、持久化恢复、Registry 变更、Composer、Goal、Automation、连接测试的定向测试通过，并通过全量 typecheck、lint 和既有 E2E 回归。

## 实施记录（2026-09-05）

以下为原实现的历史记录，不代表当前行为。`a43049c265d` 曾取消主动选模补最高档；此行为已由 Todo 88 R11 按 2026-09-07 新裁决修正，关闭依据是后续验收，而非下述旧测试结果。

- 普通 Selection 规范化改为 `normalizeModelSelection`：Provider/Model 身份保留，Reasoning 缺失或失效时清空；删除 Registry 顺序 fallback 和自动取最高档。
- Composer、Repo Wiki、Session Facade 和 Registry 选择入口不再自动物化最高 Reasoning；模型切换可以先保存模型身份，必须随后显式选择 Reasoning 才能执行。
- `resolveRegistryThoughtLevel` 不再把缺失或非法值回退到最高档；`setModel` 仅允许在 UI 选择边界暂存缺失 Reasoning，不放宽正式 Runtime/ModelFactory 的执行校验。
- 保留 `auxiliaryModelOptions` 的最低档策略；Goal 主执行与 continuation 不变，Goal Completion Verification 继续使用辅助策略。
- 定向测试通过：Provider 7 tests、Bootstrap 35 tests、UI 36 tests、Core 84 tests；`pnpm typecheck` 和 `pnpm lint` 通过（lint 保留工作区原有 warnings，无 errors）。

## 后续修正与收口（2026-09-08 状态同步）

- [Todo 88 的 R11](todo-88-provider-audit-regression-repair.md) 已将 Composer、定时任务、闲时任务、Subagent、Wiki 的主动选模接入公共最高档构造，并补齐 Bot `/model` 两个入口。历史恢复缺档位仍留空，不在 ModelFactory 补值。
- 既有证据：选择配置/Facade/Composer 33 条通过；Bot 服务 93/93；Pro `desktop-e2e-20260907-163541-147` 3/3，另有 I20 实际子请求验证。这里只同步已记录的结果，本次没有重跑测试。
- 完整桌面/手机全量未运行等限制沿用 Todo 88。后续迁移去环境依赖、原意图保护和旧字段专项审计由 Todo 96/97 承接，不重新把最高档功能列为未实现。

## 非目标

- 不重新设计 Provider Config 分层或 Personal Provider Instance 结构；相关内容由 Todo 76 负责。
- 不修改 Goal 的产品语义、队列语义或完成验证流程，只收口其模型档位归属。
- 不把辅助调用的最低档位写入 Model Config 的 `default` 字段。

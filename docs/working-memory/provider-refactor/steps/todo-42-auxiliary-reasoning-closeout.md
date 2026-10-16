# Todo 42：辅助模型 Reasoning 与输出预算语义收尾

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：Bugfix 08 完成后 Review
>
> 前置：[`Bugfix 08：辅助模型调用统一使用最低 Reasoning 档位`](./bugfix-08-auxiliary-model-lowest-reasoning.md)

## 1. 背景

Bugfix 08 已将 Session Title、Goal Title、Git Commit Message 和 Memory Recall 从“猜测关闭 Reasoning”改为
使用当前 Model 公开 Reasoning 档位的首项。该方向已经确认，但完成后 Review 仍发现三类残留：

1. Git Commit Message 上游仍声明 `maxOutputTokens: 256`，下游却因最低 Reasoning 可能需要生成预算而主动忽略；
2. Adapter 的 Telemetry 仍扫描 `disabled`、`off`、`nothink`、`none` 等字符串，猜测档位是否代表关闭；
3. 缺少模型完全没有 Reasoning Option Spec 时的直接行为证明。

这些残留不会改变已经确认的“最低公开档位”主链，但会留下无效参数、隐式名称语义和测试缝隙，需要单独收口。

## 2. 已裁决语义

### 2.1 辅助调用 Reasoning

```text
Model.optionSpecs.reasoningLevel
        |
        +-- 存在 --> 使用 values[0]
        |
        `-- 不存在 -> 不合成、不发送 reasoningLevel
```

- `values` 按语义强度从低到高排列；
- 首项可能是 `off`、`nothink`、`low` 或其他公开档位；
- Runtime 与 Adapter 不根据档位名称推断“启用”或“关闭”；
- 普通请求继续使用用户显式选择或 Model Config 的 `default`。

### 2.2 辅助调用输出预算

```text
辅助调用
├─ Reasoning：最低公开档位
└─ Max Output：继承当前 Model 的有效预算
```

不再承诺 Recall 或 Git Commit Message 的总生成预算不超过 256。部分模型的最低公开档位仍要求 Reasoning，固定 256
可能不足以构成合法请求，因此本轮接受辅助调用继承当前 Model 的有效输出预算。

上游不得继续声明一个下游必然忽略的 256 Token 限制；接口、常量、测试和文档必须表达同一真实语义。

### 2.3 Telemetry

Telemetry 只记录请求实际选择的公开 `reasoningLevel`。不扫描档位名称，不额外推断统一的 enabled/disabled 状态。
如未来确实需要跨 Provider 的开关语义，必须由显式 Config 事实表达，不能恢复字符串猜测。

## 3. 目标

1. 删除 Git Commit Message 链路中已经失效的 256 Token 参数、常量、特殊忽略逻辑和对应旧断言；
2. 让通用 Workspace Generate Text 继续按其正式契约处理调用方真正提供的预算，不为 Git Commit Message 保留假参数；
3. 删除 `resolveReasoningDisabledMappingKey` 及其全部导出、引用和测试；
4. 删除 Adapter Telemetry 对 `disabled`、`off`、`nothink`、`none` 的名称推断，只记录准确的请求档位；
5. 清理“隐藏关闭 Mapping 会被辅助调用消费”的设计表述；Reasoning Mapping 只按实际选择的公开档位精确读取；
6. 证明没有 Reasoning Option Spec 时，Title、Git Commit Message 和 Recall 均不合成档位、不改变 Active Model；
7. 保持 Model Selection、Active Model 冻结、Account/Personal Overlay、队列与持久化语义不变。

## 4. 明确不做

- 不恢复辅助调用固定 256 Token 的限制；
- 不新增 Reasoning Policy、Resolver、DTO、Factory Input 或请求专用 Option；
- 不按 Provider、Model ID、API Type 或模型名推断 Reasoning；
- 不改变普通对话、Compact、Subagent、Repo Wiki 或 Dream 的模型参数；
- 不开启 Semantic Recall，也不改变 Off-Peak 跳过 Extraction 的现有裁决。

## 5. 测试目标

- Git Commit Message 不再发送已经失效的 256 Token 假约束，并继承 Model 有效预算；
- 通用 Workspace Generate Text 在调用方真实提供 `maxOutputTokens` 时仍按正式契约处理；
- 有 Reasoning Spec 时，四类辅助调用继续使用 `values[0]`；
- 无 Reasoning Spec 时，Title、Git Commit Message 和 Recall 不产生 `reasoningLevel`；
- Active Model 与 Session Selection 在所有辅助调用后保持不变；
- Adapter Provider Options 只由精确的 `reasoningMapping[reasoningLevel]` 产生；
- Telemetry 不再通过字符串别名判断 enabled/disabled；
- Built-in Reasoning values 顺序完整性测试继续通过；
- 相关 Contracts、Adapters、Core、Services、Provider 测试和 typecheck、根 lint 通过。

## 6. 完成标准

- 生产代码与当前 Design 中不存在 `resolveReasoningDisabledMappingKey`；
- Git Commit Message 链路不存在“上游传 256、下游忽略”的虚假契约；
- 三类无 Reasoning Spec 辅助调用都有直接回归证据；
- 辅助调用只表达两个真实事实：最低公开 Reasoning 档位，以及继承当前 Model 的输出预算；
- Bugfix 08 的实施记录与最终代码一致，不再把残留或行为漂移标记为已完成。

## 7. 实施记录

- Git Commit Message Services 不再声明固定 `maxOutputTokens: 256`；通用 Workspace Generate Text 删除
  querySource 特判，调用方明确提供预算时照常执行，未提供时由当前 Model 的有效 Options 承担预算事实；
- 删除 `resolveReasoningDisabledMappingKey`，Adapter Provider Options 只读取
  `reasoningMapping[reasoningLevel]`；Telemetry 只记录实际请求档位，不再合成 enabled/disabled；
- Test Model Factory 增加“无 Reasoning Spec”测试能力，Session/Goal Title 共用链路、Git Commit Message
  与 Memory Recall 均证明不合成 Reasoning，且 Active Model/Selection 不被修改；
- Services、Core、Adapters 定向测试共 93 条通过；Provider 全量 151 条通过；根 typecheck 与 CLI
  Contracts/Adapters/Core typecheck 通过；根 lint 为 0 error（保留 33 条与本次无关的既有 warning）；
- Core 全量有 2109 条通过，剩余失败来自既有绝对路径 conformance fixture、CUA、I/O/模块边界和
  stream-recovery 基线；Adapters 全量有 1370 条通过，唯一失败为与本次无关且单独复现的进程组清理测试。

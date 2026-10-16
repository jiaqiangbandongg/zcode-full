# Bugfix 08：辅助模型调用统一使用最低 Reasoning 档位

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：GLM-5.3 Flash 生成标题时没有携带公开 Reasoning 档位

## 1. 问题

Session 标题、Goal 标题、Git Commit Message、Memory Recall Selector 和 Provider 连接测试都属于短小、
低成本的辅助模型调用。
这些入口当前没有共享“低成本 Reasoning”语义，而是分别通过 `reasoningMode: "disabled"` 寻找
`disabled`、`off`、`nothink` 或 `none` Mapping。

这会产生两个问题：

- 不允许关闭 Reasoning、但公开 `low / high / max` 的模型（例如 GLM-5.3）最终不携带任何 Reasoning
  Mapping，标题请求与模型公开能力不一致；
- 业务代码表达的是“最低成本”，实现却表达成“强制关闭”，并依赖 Provider-specific 档位名称猜测。

## 2. 正确语义

Reasoning Enum 的 `values` 是有序列表，按推理强度从低到高排列：

```text
reasoningLevel.values[0]             最低公开档位
reasoningLevel.values[1..n]          逐步提高
reasoningLevel.default               普通请求的默认档位（可以不是最低档）
```

“最低档位”不等于“关闭”：

- 模型公开 `off / low / high` 时，最低档位是 `off`；
- 模型只公开 `low / high / max` 时，最低档位是 `low`；
- 模型没有 Reasoning Option Spec 时，不合成、不猜测任何档位。

普通对话、Compact、Subagent、Repo Wiki 等仍使用用户显式选择或 `default`。本 Bugfix 只改变明确声明为辅助低成本请求的入口。

## 3. 统一执行链

```text
辅助调用读取 Model.optionSpecs
                    |
                    v
          reasoningLevel.values[0]
                    |
                    v
      Model.bind / ModelRequest.reasoningLevel
                    |
                    v
          正常 reasoningMapping / Adapter
```

- 标题与 Git Commit Message 对创建好的 Model 直接 bind `values[0]`；
- Memory Recall 在单次 Request 中直接传入 `reasoningLevel: values[0]`；
- Provider 连接测试对正式 Model 直接 bind `values[0]`，继续通过同一 Registry、ModelFactory、
  runtime headers 与 Adapter 链路发起请求；
- 删除 `reasoningMode: "disabled"` 及其用于选择辅助档位的隐藏关闭 Mapping 扫描；
- 不增加 Policy、Resolver、Factory Input 或 Request Option；Adapter 只消费正常 `reasoningLevel`；
- Active Model 仍不可变，单次 Memory Recall 请求不能修改它的 `options`。

## 4. 影响范围

| 入口                   | 新行为                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Session Title          | 创建使用最低公开 Reasoning 档位的辅助 Model                                           |
| Goal Title             | 与 Session Title 共用同一实现                                                         |
| Git Commit Message     | 无论会话当前档位如何，辅助 Model 使用最低公开档位                                     |
| Memory Recall Selector | 单次请求使用当前 Model 的最低公开档位，Active Model 不变；总输出预算继承 Active Model |
| Provider 连接测试      | 测试当前 Registry 中的正式 Model，并使用最低公开档位；无 Spec 时不合成档位            |

不改变模型选择、Session 持久化、Provider Registry、Account/Personal Overlay、普通请求默认值或桌面/手机恢复语义。

## 5. Schema 与配置作者约束

- Provider Model Config Schema 对 `reasoningLevel.values` 标注“按推理强度从低到高”；
- TypeScript Contract、Provider Config Design、Model Contract 和 Built-in 作者规范同步说明顺序语义；
- Built-in Config 中现有 Reasoning values 按最低到最高排列，`default` 保持原值，因此普通请求行为不变；
- Schema 只校验非空以及 `default` 属于 `values`。顺序正确性和避免重复值属于配置发布者责任，不在客户端重复建立繁杂校验。

## 6. 测试

先写失败测试，再实现：

- 有 Reasoning Spec 时直接取 `values[0]`，无 Spec 时不合成档位；
- Session/Goal Title 与 Git Commit Message 都在已创建 Model 上 bind `values[0]`，不改变 Selection；
- Memory Recall 单次请求使用最低档位，Active Model options 保持不变；
- Provider 连接测试有 Reasoning Spec 时 bind `values[0]`，无 Spec 时不 bind；
- Provider 连接测试继续使用 Provider-neutral 的用户消息，不恢复 Start Plan 专用请求体、Provider ID
  分支或测试专用鉴权；
- Memory Recall 继承 Active Model 的总输出预算，不保留“关闭 reasoning 后固定 256”的旧假设；
- Adapter 通过普通 reasoning Mapping 发送最低档位，不再扫描隐藏关闭别名；
- Built-in 配置评审确认 Reasoning values 按低到高排列；客户端不维护另一套已知档位或顺序校验；
- Core、Bootstrap、Adapters、Provider 定向测试以及根 `typecheck`、`lint` 通过。

## 7. 完成标准

- 所有已知辅助模型入口只有一种最低档位实现；
- 不新增 Reasoning Policy、Resolver、Factory Input 或 Request Option；
- 生产代码不存在 `reasoningMode`；辅助档位选择不调用 `resolveReasoningDisabledMappingKey`；
- GLM-5.3/Flash 的辅助请求使用 `low`，而不是无 Reasoning 参数；
- 普通请求继续使用显式选择或 `reasoningLevel.default`；
- 文档、Schema、Built-in 顺序和测试对“Reasoning values 有序”给出一致说明。

## 8. 实施与验证记录

- 实现只在 Session/Goal Title 共用链路、Git Commit Message 和 Memory Recall 三处直接读取
  `optionSpecs.reasoningLevel.values[0]`；
- 删除 `reasoningMode`、专用 Model Request Options、Factory Input 和内部 Mapping 选择入口，未新增替代抽象；
- GLM-5.3/Flash 完整性测试确认公开顺序为 `low / high / max`、普通默认仍为 `max`，最低档映射为 `low`；
- Contracts、Adapters、Bootstrap、Core、Provider Node 定向测试通过；
- 根 `typecheck`、CLI 受影响包 typecheck、`lint` 通过；
- 全量单测通过：1491 个测试文件通过、1 个跳过；12720 个测试通过、25 个跳过。
- 本次 26 个修改文件的格式检查与 `git diff --check` 通过；全仓 `fmt:check` 仍被既有 Electron
  示例 HTML 语法和 `apps/zcode-cli/tests/gb2312.js` 读取问题阻断，本次未扩大范围修复。
- Todo 42 已进一步删除 Git Commit Message 的失效 256 Token 假参数、Core 的对应特殊忽略分支，以及
  Adapter Telemetry 的关闭档位名称扫描；无 Reasoning Spec 的 Title、Git Commit 与 Recall 均有直接测试。
- 2026-08-30 复核发现 Provider 连接测试仍遗漏最低档位绑定；本 Bugfix 将它纳入同一直接
  `values[0]` 规则。Experience Plan 活动结束后无法复现的 3012 风控拒绝不据猜测改成 Provider 特例。

# Todo 63：Model Selection 失效与请求预算收口

> 状态：已完成
>
> 日期：2026-09-02
>
> 前置：Todo 58 已删除 Model Option Spec 的 `default`；Todo 60 已要求每个 Effective Model 都具有完整、有序的 Reasoning Spec。本 Todo 统一处理 Selection 失效、旧闲时任务恢复，并让 `maxOutputTokens` 退出 Selection。

## 1. 目标

把模型静态事实、用户选择与单次请求参数严格分开：

```text
Model Config / Option Specs
├─ reasoningLevel.values：合法档位，按低到高排序
└─ maxOutputTokens.max：模型允许的硬上限

ModelSelection
├─ providerId
├─ modelId
└─ reasoningLevel

Model Request
└─ maxOutputTokens：Agent 框架为本次调用显式决定
```

`spec.max` 是合法且常见的请求预算。问题不在于使用最大值，而在于调用方没有作出决定时由 ModelFactory 或 Adapter 静默补值。

## 2. ModelSelection 契约

目标结构：

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options: {
    reasoningLevel: string;
  };
}
```

- 删除 `ModelSelection.options.maxOutputTokens`，并清理协议、持久化、Recent、Session、Subagent、Automation、Off-Peak、时间线比较与 Hydration 中的对应残余。
- 新写入的 Selection 必须携带具体 `reasoningLevel`。
- 旧 Selection 缺少 reasoning 时，只允许在“创建全新默认选择”的既有 Host 初始化边界补 `values.at(-1)`；业务层、Renderer、ModelFactory 和 Adapter 不再各自补值。
- 显式但已失效的 reasoning 不得自动替换。

## 3. 单次请求预算

`maxOutputTokens` 继续是 Model Request Option，且进入 Executor 前必须完整合法：

```text
具体执行链
    |
    | 显式决定本次 maxOutputTokens
    v
Active Model / Adapter
    |
    | 只校验 0 < value <= spec.max
    v
模型 API
```

- 普通 Turn、Off-Peak 和普通 Subagent 可以由 Agent 框架显式选择 `spec.max`。
- Title、Goal、Memory、Git Commit、Connectivity、WebSearch/WebFetch 等辅助链继续使用其明确预算。
- Compact 和 Repo Wiki 保留自身任务语义，但必须由调用方显式传值。
- 删除 ModelFactory 的 `selection value ?? spec.max`；Active Model 不再把 Selection 中的输出预算当作长期绑定状态。
- Adapter 保持严格缺参报错，不 clamp、不补值。

## 4. 统一 Selection 失效定义

下面情况统一视为 `ModelSelection` 失效：

```text
ModelSelection invalid
├─ 结构无法解析
├─ Provider 不存在或不在当前 Selection View
├─ Model 不存在或不在当前 Selection View
└─ reasoningLevel 不属于当前模型的 values
```

Reasoning 失效只是统一 Selection 失效的一种原因，不建立第二套修复流程。校验结果必须保留结构化原因，供 UI 给出准确提示；不能只返回 `false` 后静默回退。

## 5. 未提交草稿

未提交草稿没有产生自动执行副作用，失效时复用现有默认选择优先级：

```text
当前/Recent Selection
        |
        +-- 有效 --> 保留
        |
        `-- 失效 --> 丢弃整个 Selection
                     使用 Host preferredSelection
                     显示一次通知
```

- 没有任何历史选择的新草稿正常使用现有默认优先级，不通知。
- 曾有选择但因 Registry revision 变化而失效时，显示现有 Toast/通知样式：
  - 有 fallback：`原来的模型选择已失效，已切换到当前默认模型，请确认后继续。`
  - 无 fallback：`原来的模型选择已失效，请重新选择模型。`
- 同一次失效只通知一次；不使用阻塞 Modal，不使用 timeout 解决状态问题。

## 6. 已创建任务与历史数据

已创建且可能自动执行的任务不能静默换模型：

```text
Persisted Task Selection
        |
        +-- 当前有效 --------> 正常执行
        |
        +-- 可可靠迁移 ------> 写回完整 Selection 后执行
        |
        `-- 无法可靠恢复 ----> 保留任务
                               标记模型选择需要修复
                               禁止调度/执行
                               等待用户编辑
```

### 6.1 旧闲时任务

旧记录只有 `model` / `thought_level`，没有 Provider 身份。旧实现本来就在执行时根据当前账号连接选择 Z.ai 或 BigModel，因此可靠迁移应在当前 Off-Peak Selection View 就绪后完成，而不是在 SQLite Row Mapper 中猜 Provider：

```text
legacy model / thought_level
          +
current Off-Peak Selection View
          |
          v
解析唯一、当前有效的完整 Selection
          |
          +-- 成功 --> 原子写回 model_selection
          `-- 失败 --> 保留为 repair-required
```

- Repository 必须逐条容忍缺失或非法 `model_selection`，一条旧记录不能让 `list()`、同步或其他任务调度整体失败。
- 待修复任务仍出现在列表中；终态历史记录可以正常查看。
- 未修复的非终态任务不能被 claim、continue 或 dispatch。
- 不删除旧记录，不凭模型名猜账号 Provider，不把当前默认模型静默写入已创建任务。

## 7. Registry 更新与 Active Model

```text
Registry revision 更新
├─ 新草稿：校验并按第 5 节处理
├─ 已创建任务：校验并按第 6 节处理
├─ 后续新请求：从新 Registry 创建 Model
└─ 已开始执行的 Active Model：保持冻结
```

Desktop continuous 与 Mobile replayable 只共享 Selection 校验结果；本 Todo 不改变消息流、队列、owner/lease 或恢复协议。

## 8. 测试先行

1. Shared/Protocol：Selection 不接受 `maxOutputTokens`；结构化 reasoning 仍可 round-trip。
2. Provider：校验返回 provider/model/reasoning 的结构化失效原因；默认初始化缺 reasoning 时取最高档，显式非法值不补。
3. Agent Runtime：ModelFactory 不绑定输出预算；普通 Turn 显式传 `spec.max`；所有其他执行链在 Executor 前都有明确预算。
4. UI unit：Recent/当前草稿失效后回到 Host preferred，并暴露“发生过失效”的结果；新草稿正常缺省不误报。
5. UI E2E：Registry revision 使当前草稿选择失效后，工具条切换到有效默认值并显示一次通知；无可用模型时要求重选。
6. Off-Peak Repo/Service：旧行不拖垮列表；可唯一恢复时写回；不可恢复时可见但不可调度；其他任务继续同步与 claim。
7. 回归：Session、Subagent、Automation、Repo Wiki、Title、Goal、Memory、Compact、Connectivity 的 Selection 和 Request Options 不混用。

## 9. 完成门禁

- `ModelSelection` 的 Schema、协议和持久化中不存在 `maxOutputTokens`。
- ModelFactory 不再从 Selection 或 Spec 推导请求输出预算。
- 每条模型请求在 Agent 框架的真实调用方显式决定 `maxOutputTokens`。
- Provider/Model/Reasoning 失效进入同一个结构化 Selection 校验流程。
- 普通草稿失效后回到现有默认优先级并通知；已创建任务失效后不会静默换模型执行。
- 旧闲时记录不会隐藏整个列表或阻塞其他任务。
- 定向测试、`pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、相关 Desktop E2E 与 `git diff --check` 通过；无法运行的图形 E2E 必须明确记录。

## 10. 实施结果

- `ModelSelection` 已收口为 Provider、Model 与 Reasoning；协议、Session、Timeline、Recent、Automation、Subagent、Off-Peak 和 Repo Wiki 不再保存 `maxOutputTokens`。
- ModelFactory 不再绑定或缺省输出预算；普通 Turn/Off-Peak/Subagent 显式选择模型 `spec.max`，Compact、Title、Goal、Memory、Git Commit、Connectivity、WebSearch/WebFetch 与 Repo Wiki 保留各自的显式预算。
- Provider Registry 对缺失 Reasoning 和非法 Reasoning 返回结构化失效原因；新选择统一通过 `completeNewModelSelection()` 取有序档位最后一项，显式非法值不修补。
- 草稿在 Registry revision 变化后会原子清除失效 Selection，回到 Host preferred，并按 workspace/revision 去重显示一次通知；已经开始执行的 Active Model 不变。
- 闲时任务 Repository 可逐条读取缺失、旧 Schema 或损坏的 `model_selection`；Service 只在当前 Account Family 的 Off-Peak Resolver 能保留原 model/reason 时写回。无法恢复的任务保留在列表、标记待修复并撤销调度资格，编辑时必须重新选择完整模型与 Reasoning。
- 延迟迁移和失效写回均在 SQLite 写锁内重读，避免覆盖另一进程刚完成的用户修复。

### 10.1 验证记录

- Provider/Services/UI 定向测试：5 个文件、50 条通过。
- CLI Bootstrap/Contracts/Core 定向测试：9 个文件、109 条通过。
- CLI Core 全量：2,201 条通过。
- 根 `pnpm typecheck` 与 CLI 全工作区 typecheck 通过。
- `pnpm lint` 通过（35 条均为本轮之外的既有 warning）。
- `pnpm test:unit`：13,087 条通过、25 条跳过；仍有 2 条与本轮无关的既有基线失败：Desktop E2E Provider seed 数量旧断言，以及 pre-push mise 旧断言。
- 本轮全部修改文件 `oxfmt --check` 与 `git diff --check` 通过。
- 图形 Desktop E2E 未在当前无显示环境中实跑；核心交互由 React Hook/状态单测覆盖，仍需在可用的 macOS WDIO 环境补跑。

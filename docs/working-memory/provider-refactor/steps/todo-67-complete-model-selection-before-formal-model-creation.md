# Todo 67：正式 Model 创建前的 Selection 完整性收口

> 状态：Completed
>
> 来源：Account Provider 连接测试实机回归与完整执行入口 Review

## 1. 背景与根因

Provider Registry 已经把 `reasoningLevel` 定义为执行 Selection 的必需事实。ModelFactory
只校验和装配完整 Selection，不再替调用方猜测缺省值。

连接测试虽然已经决定使用模型 Reasoning Spec 的最低公开档位 `values[0]`，但当前实现的
执行顺序错误：

```text
设置页只提交 providerId/modelId
            |
            v
ModelFactory 先校验 Selection
            |
            X reasoningLevel 缺失

原计划中的 values[0] 绑定发生在 Model 创建之后，因此永远到不了。
```

这是确定的本地失败，不是 Account 套餐、请求 Header、凭据或服务端网络问题。

本轮 Review 同时发现同类不完整 Selection 还存在于 Git 提交信息生成、Subagent 显式模型
保存，以及 Session 创建的分裂 `model`/`thoughtLevel` 输入。显式 Title Generation Model
Override 也存在同样的潜在契约缺口。

## 2. 统一原则

### 2.1 身份 Selection 与执行 Selection

`ModelSelection` 仍可作为跨进程、历史存储和 UI 选择中的模型身份，因此不能把共享 Schema
全局改成 Reasoning 必填。

但凡进入正式 ModelFactory 的执行 Selection，必须已经包含该模型支持的合法
`reasoningLevel`：

```text
身份 Selection
      |
      v
拥有 Registry 的选择/创建边界
      |
      v
完整执行 Selection
      |
      v
ModelFactory
```

不得放宽 ModelFactory，不得恢复 Runtime fallback，不得根据 Provider ID、modelId 或
`off`/`nothink` 等字符串猜测档位。

### 2.2 正常选择与辅助请求

- 用户正常选择模型时，缺省档位继续取有序 `values` 的最后一项；
- 连接测试、Git 提交信息和标题生成等辅助请求使用最低公开档位 `values[0]`；
- `values[0]` 不等价于字符串 `disabled`；
- 不新增 `reasoningLevelPolicy` 或另一套默认值抽象；
- 输出预算继续由各辅助请求已有规则显式绑定。

## 3. 实施范围

### 3.1 Provider 连接测试

连接测试继续只从设置页提交 Provider/Model 身份。拥有正式 Registry 的 App/Bootstrap 边界
读取目标 Model 的 `optionSpecs.reasoningLevel.values[0]`，先形成完整执行 Selection，再调用
ModelFactory。

Core 保留已有的辅助请求绑定：

- `reasoningLevel = values[0]`；
- `maxOutputTokens = min(5000, optionSpecs.maxOutputTokens.max)`。

不得增加 Account、Start、Individual、Team 或具体模型分支。

### 3.2 Git 提交信息生成

当前模型提供方已经返回完整 Host Selection。Git 生成器不得再主动删除 `options`；完整
Selection 必须原样进入正式 Model 创建边界。Core 仍在实际 Git 辅助请求上绑定最低档位，
因此这不会让 Git 请求沿用交互会话的高档 Reasoning。

删除把“丢弃交互 Reasoning”误写成“丢弃完整 Selection”的旧测试断言。

### 3.3 Subagent 显式模型

模型选择控件已经根据 Registry 显示正常缺省 Reasoning。保存显式 Subagent 模型时，必须将
该已解析档位与 Provider/Model 一起持久化，不能显示有值却保存 `undefined`。

历史缺失值只允许在明确的读取/迁移边界完成一次性补全；ModelFactory 不兜底。

### 3.4 Session 创建

协议暂时保留兼容字段 `model` 与 `thoughtLevel`。在构造 App/Runtime Config 前先原子合并：

- `model.options.reasoningLevel` 已存在时使用它；
- 否则使用独立 `thoughtLevel`；
- 两者都不存在时，由正式 Registry 选择边界完成正常新选择，不允许把不完整 Selection 先送进
  ModelFactory。

后续 `setModel`/`setThoughtLevel` 只负责会话状态事件，不再承担首次 Model 能否创建的前置条件。

### 3.5 Title Generation 显式 Override

普通标题生成使用当前完整 Session Selection，不改行为。若保留显式
`titleGeneration.modelSelection`，其生产/加载边界必须保证完整，不能依赖创建 Model 后再绑定
最低档位。没有生产调用方的旧入口应优先删除，而不是新增兼容分支。

## 4. 测试先行

先写失败测试，再改生产代码：

1. 使用正式 Provider Registry 与 ModelFactory，向连接测试输入仅含 Provider/Model 身份，证明
   Adapter 最终收到 `values[0]` 和受限输出预算；
2. 参数化覆盖 API Key、Start Plan、Team Plan，证明没有 Provider 特化；
3. Git 生成器保留完整输入 Selection，同时正式请求最终使用 `values[0]`；
4. Subagent 切换模型后不操作 Reasoning 控件也会保存界面显示的合法档位；
5. Session Create 在 App 构造前合并分裂的 Model/Thought；
6. 显式 Title Override 若保留，使用正式 Registry-backed 测试验证；
7. Desktop Provider Settings E2E 必须真正点击连接测试按钮，不能只检查 Account 页面和模型列表。

Core 的假 ModelFactory 单测可以保留用于验证 bind 行为，但不能再被视为 Registry 纵向证明。

## 5. 完成标准

- Account Provider、API Key Provider 的连接测试不再报 Reasoning 缺失；
- 连接测试实际使用 `values[0]`，且不识别任何具体 Provider/模型；
- Git、Subagent、Session Create 不再把不完整执行 Selection 送入 ModelFactory；
- 普通聊天、Compact、Memory、Repo Wiki、Automation、Bot 和 Off-Peak 行为不变；
- 没有放宽 Registry/ModelFactory，也没有建立第二套 Reasoning 默认事实；
- 定向单测、Desktop E2E 类型检查、根 `pnpm typecheck` 与 `pnpm lint` 通过；
- 完成后重新审计所有正式 ModelFactory 调用点，并记录尚未验证的真实 E2E 环境限制。

## 6. 实施记录

首轮修复已完成两个确定会把不完整 Selection 送入正式 ModelFactory 的入口：

- Provider 连接测试在 Bootstrap/App 的 Registry 边界补入目标模型的 `values[0]`，再创建
  Model；Core 的统一辅助请求预算保持不变；
- Git 提交信息生成不再剥离 Host 当前 Selection 的 `options`。Bootstrap 先验证完整
  Selection，Core 再统一把实际辅助请求降至 `values[0]`。

纵向回归测试使用真实 `ProviderRegistry -> ApiProviderModelRuntime -> Core` 链路，证明身份
Selection 不会再在 Factory 处因缺少 Reasoning 失败。

Subagent 设置页也已修正：切换显式模型时，把控件根据 Registry 展示的正常缺省档位一并写入
Model Selection，不再展示 `high` 却持久化 `undefined`。

复查结果：Session Create 的正常 Host 调用已经在创建前合并 `model` 与 `thoughtLevel`；共享协议
继续允许读取历史身份 Selection，不能为本 Bug 把 `ModelSelection` 全局改成必填。Title 的显式
Model Override 当前没有生产配置写入方，因此未增加无消费者的兼容分支。ModelFactory 的严格
完整性校验保持不变。

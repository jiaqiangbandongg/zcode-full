# M1 实施记录

> 状态：完成阶段审计与缺口修复
>
> 开始日期：2026-08-11
>
> 实施目标：[`01-model-and-request.md`](./01-model-and-request.md)
>
> 目标设计：[`../design/model/model.md`](../design/model/model.md)
>
> 后续裁决：Guide/“立即”已经确定为在当前 Loop 内生效，见 [`../design/interaction/interaction.md`](../design/interaction/interaction.md)。正文保留实施当时的未决状态。

本文主要记录实现过程中超出原计划、但为了继续推进而自主作出的决策。开始基线、验证结果和进度清单作为 M1 当时的实施证据保留；后续阶段的 implementation log 不再逐项记录正常提交和常规命令输出。

Implementation log 不修改已有设计；发现冲突时，以阶段设计为准，并把冲突交给阶段复核或后续 Design 讨论。

## 完成审计后的继续实施

2026-08-12 按阶段完成条件重新审计后，确认模型调用入口已经收敛，但下面几条语义尚未闭环：

- Microcompact 和 Reactive Compact 没有完整继承当前 Agent Loop 持有的 Model。
- 未显式选择模型的 Child Agent 仍可能从可变 Session 默认值重新选模。
- Context Usage、Compact 持久化和部分 Sidecar Usage 仍可能记录请求前的 ModelRef，而非实际 Model。
- `workspace/generateText` 创建目标 Model 时仍混入当前 Runtime 的模型属性。
- Repo Wiki 迁移后需要重新确认错误边界：既要保留可公开的错误分类，又不能把 Provider 回显的源码写入日志或持久化任务。

这些问题都由 `01-model-and-request.md` 已有实施约束直接裁决，本轮继续实现，不新增阶段设计。

Guide/“立即”是否在当前 Loop 内替换 Model 仍是阶段文档明确保留的待裁决项。当前实现固定 Loop Model，已经与旧的逐 Step 读取行为不同；本轮不会借修复其他生命周期问题擅自选择 Guide 语义，只保留现状并将差异继续记录在这里。

请求前 Property 校验已经按阶段设计实施。校验失败时采用错误、降级还是仅记录可观测事件仍未统一裁决；本轮只补充继承与归因，不扩展这一策略。

## 开始基线

实施前已将 `origin/staging` 的 `38d37ca50a` 合并到 `provider-refactor`，合并提交为 `07e4ba350f`。合并没有产生冲突。

实施完成审计时，`origin/staging` 已继续前进到 `d8cf5a49a7`。当前分支再次完成合并，工作区改动通过 Git autostash 原样恢复；新增的 Core token estimate 修复与 M1 的 Model 调用边界没有设计冲突。

最新 staging 删除了部分请求形状与工具准入辅助逻辑，并简化了若干模型调用测试。主链仍然保留以下事实：

```text
业务调用方
    -> ModelTextRequest（携带 model / providerOptions / 传输控制）
    -> AiSdkModelAdapter
    -> 每次请求从可变 Registry resolve ModelRef
    -> Provider SDK
```

因此 M1 的目标不需要调整。实现需要避免把刚删除的旧辅助抽象重新引入，并直接以最终 `Model` / `ModelRequest` 契约建立新边界。

## 实施中的自主决策

### 1. 现有 Adapter 作为第一版 Model 的执行内核

M1 不重写 Provider SDK、流恢复、Header 刷新和错误归一。第一版 Model 在 Adapter 包内封装现有 `AiSdkModelAdapter`，业务调用方只接触新的 Model 接口。旧 `ModelTextRequest` 暂时成为 Adapter 内部兼容输入，并随 M1 调用方迁移逐步退出业务边界。

### 2. Model 创建时固定普通 Registry 解析结果

普通 Model 在创建时解析一次 Provider、model、capability 和连接信息。Agent Loop 持有该 Model 后，后续 Step 不再从可变 Registry 重新决定模型身份或普通 API Key。配置变化只影响以后创建的 Model。

Start Plan 等现有动态 Header 链路仍允许 Adapter 在明确执行 Header 刷新后更新请求级认证材料。该例外不得改变 Model 的 `providerId`、`modelId`、Properties 和 Options。

### 3. 传输控制留在 Model 实现内部

`statusSink`、Trace、流恢复、idle timeout、Provider stream boundary 和运行时 Header 刷新不进入公开 `ModelRequest`。第一版实现通过创建 Model 时注入的内部执行上下文承接这些能力。业务调用方不能逐请求自由拼装传输参数。

### 4. ModelResult 与 ModelEvent 先收敛语义，再清理旧名字

M1.1 以当前已经归一化的 `ModelTextResult` 和 `ModelStreamEvent` 字段为迁移基础，定义最终公开名字并移除业务侧不应控制的输入。Provider SDK 原始类型仍由 Adapter 隔离。完成调用方迁移后，再删除只为旧 `ModelPort` 服务的别名和请求类型。

### 5. Properties 从现有能力与连接判断形成

`contextWindow`、图片、PDF、Tool Call 和 Structured Output 先复用现有 `ModelCapability` 事实；Native Web Search 与 Mid-conversation System 在 Model 创建时复用当前判断逻辑计算。Core 后续只读取 Model Properties，不再读取 Provider kind、URL 或 model name 推断能力。

### 6. Repo Wiki 走统一 Model，不保留独立 Provider 客户端

Repo Wiki 的接入方式要根据当前 Services 与 Core 的实际依赖方向选择。无论最终通过现有 workspace 协议取得 Model 能力，还是复用更低层的 Model 实现，它在 M1 结束时都必须使用同一 `ModelRequest` 语义，不再自行解析 API Key、Endpoint 和协议请求。

实际实现沿用了已有进程边界：Services 通过 `workspace/generateText` 请求 CLI，CLI 内部创建 Model 并执行。Repo Wiki 原先自行处理 API Key、Endpoint、OpenAI/Anthropic 请求、Tool loop 和 Usage 的客户端已经删除。为保持取消语义，workspace 请求增加 operation id；Host 的 AbortSignal 会同时结束本地等待并通知 CLI 中止对应模型任务。

### 7. 内部调用上下文使用 AsyncLocalStorage

Trace、status sink、stream recovery、Header 刷新等传输控制没有进入公开 `ModelRequest`。Core 在模型调用边界写入 invocation context，Adapter 在同一异步链读取。流式调用额外包裹 AsyncIterator 的 `next`、`return` 和 `throw`，避免只在创建 iterator 时建立上下文、实际消费时丢失。

### 8. 辅助任务的“关闭推理”先作为 Model 构造意图

Title、Git Commit Message 和 Memory Selector 过去在业务代码中直接改写 Anthropic、OpenAI 和 OpenAI-compatible 参数。M1 将调用方收敛为 `reasoningMode: "disabled"` 的兼容工厂输入。正式 Bootstrap 工厂把该意图交给 Adapter 转换；旧的 Provider 方言逻辑只在唯一兼容 Model Factory 中保留，供直接构造 Core 的旧测试和迁移调用使用。

这没有新增公开 Reasoning level，也没有改变现有用户可选档位。完整 Reasoning 配置模型仍按既有专项调研留给后续 Provider/Registry 阶段。

### 9. Properties 在 Model 创建时形成

Native Web Search 与 Mid-conversation System 的旧 Provider kind、URL 和 model name 判断已移到 Model 创建路径。主 Agent、Compact、Project Memory 和模型型工具读取 Model Properties。工具目录的非执行预览仍可在没有 Model 时使用旧连接判断；该路径不发起模型请求，等 M2 的 Registry/Descriptor 成为正式查看来源后再删除。

### 10. 旧 ModelPort 只剩唯一兼容入口

生产调用方均使用 `Model.generateText()` 或 `Model.streamText()`。Core 中对旧 `modelAdapter.generateText/streamText` 的直接调用只存在于 `runtime-model.ts` 的兼容工厂，用于尚未通过 Bootstrap 装配、直接构造 `AgentRuntime` 的测试和旧嵌入调用。第二阶段替换 Model 来源时，可以整体删除这一个入口。

### 11. Agent Loop、Compact 与 Child Agent 共用不可变 Model

普通 Agent Loop 在开始时创建 Model，后续 Step、自动 Compact、Microcompact、Reactive Compact 和未显式选模的 Child Agent 都沿用该对象。Child Agent 显式选择模型时创建自己的 Model。Session 默认模型、Config 或 Registry 在 Loop 运行期间变化，不会改写已经被引用的普通 Model；Start Plan 等动态 Header Provider 仍按既有请求前刷新链路更新认证材料，但不得更换 Model 身份。

### 12. 运行历史与 Usage 以实际 Model 归因

Assistant 消息、Compact 记录、Tool 持久化诊断、Context Usage、Usage Fact 和 Trace 不再在请求完成后读取可变 `defaultModelRef`。这些路径都接收实际发起请求的 Model 或由它形成的 ModelRef。Title 等关闭推理的独立任务会形成 `reasoningLevel: "disabled"` 的 Model，Usage 因而记录真实执行选项，而不是 Session 的旧推理档位。

### 13. 输出预算由调用方选择、Model 严格校验

复核发现，最初实现把 Provider fixed thinking 的最小预算投影为 `maxOutputTokens.min`，并提供公共 clamp 帮助调用方静默调整请求。这让 Provider 方言泄漏进了通用 Model 契约，也让 `workspace/generateText` 等通用入口改变调用方输入。

纠正后的公共 Option 只声明默认值和最大值。`maxOutputTokens` 表示 reasoning 与最终回答共享的总生成硬上限；Model 只接受不超过上限的正整数。Compact、Memory、WebFetch、WebSearch 和 ReadSessionContext 的固定预算属于各自任务策略，由调用方显式选择任务预算与模型上限中的较小值。`workspace/generateText` 不再静默调整输入，越界时由 Model 返回错误。

现有 Adapter reasoning 映射和 wire request 保持不变。fixed thinking 继续在 Adapter 内把档位预算限制到 `maxOutputTokens - 1`，不会把关联约束暴露为公共 Option Spec。原生 effort/adaptive 迁移和 fixed-budget 的 `3/4` 分配策略留给后续 Adapter 专题。

### 14. Repo Wiki 保留安全错误边界

Repo Wiki 已通过 `workspace/generateText` 使用 CLI 内的 Model。Provider 返回的原始异常可能含有请求正文，Repo Wiki 又会把失败原因持久化到 task，因此 Services 边界只保留可安全公开的 HTTP 状态，其余错误正文归一化为通用失败信息。Abort 与 Repo Wiki 自身的 Deadline 错误继续保留原有控制语义。

### 15. 兼容旧的最小 Model Adapter 注入

正式生产 Adapter 提供 `createModel()` 与 `resolveConnection()`，Bootstrap 使用正式 Model Factory。部分单元测试和旧嵌入调用只注入最小 `generateText/streamText` Adapter；Bootstrap 对这类对象不安装正式工厂，让它们统一落到 Core 的唯一兼容工厂。该分支不新增第二套生产调用链。

### 16. Repo Wiki 的截断恢复属于业务策略

Repo Wiki 迁入 `workspace/generateText` 后，统一 Model 已经能够产生结构化的 `finishReason` 和 Usage，但第一版 workspace 协议只返回文本与模型身份。旧 Wiki 客户端删除时，依赖 `finish_reason=max_tokens` 的截断升级重试也随之丢失：目录可能因半截 JSON 失败，页面则可能把半截 Markdown 当作成功结果保存。

修复后的 workspace 结果透传 `finishReason` 与 Usage。Repo Wiki 在自己的调用边界把 `length`、`max_tokens` 和 `max_output_tokens` 归一为截断错误，并由现有 Catalog/Page 重试策略提高一次请求预算：Catalog 从 16384 提高到 32768，Page 从 8192 提高到 16384。升级最多发生一次，不计入用户配置的普通重试次数，最终请求仍由 Model 按模型的 `maxOutputTokens` 上限校验。

这项策略继续属于 Repo Wiki。Model 只返回真实调用结果并校验请求，不感知 Wiki 的预算升级，也不恢复 Wiki 旧有的 Provider、Endpoint 或协议客户端。

`finishReason` 在 workspace wire schema 中保持可选，使其他不依赖结束原因的调用仍能读取旧 app-server 响应。Repo Wiki 无法安全兼容缺少该字段的结果：半截 Markdown 在结构上仍然合法，Services 无法从正文恢复完整性事实。因此 Wiki 遇到旧响应时明确失败并提示更新或重启 ZCode，不进行工具降级或普通重试，也不保存本次 Catalog/Page。

## 实施后复核结论

- Property 冲突第一版返回 `InvalidModelRequest`，暂未增加 OTEL invariant；产品降级策略仍待后续按 Property 分别决定。
- 调用上下文采用 AsyncLocalStorage，并覆盖 Promise 与 AsyncIterable 的消费边界。
- 动态 Header Provider 可以在 Adapter retry 前刷新认证材料；刷新后的模型身份必须与当前 Model 一致。
- Repo Wiki 通过既有 Host -> CLI workspace 协议接入，分层问题没有扩散到公开 Model 接口。
- 旧 `ModelPort` 与 `ModelTextRequest` 仍是 Adapter/兼容工厂内部迁移对象；业务调用方已不再构造它们。
- 全仓生产调用扫描没有发现遗留的 Repo Wiki/OpenAI/Anthropic 直连模型客户端；脚本、测试工具与历史文档不计入生产调用方。
- Embedded Search 仍通过旧 Connection 信息判断分支，但它本身不发起模型请求，已经记录为后续 Provider/Capability 清理项，不阻塞 M1。
- Guide/“立即”统一为 Loop 内生效：成功进入当前 Loop 时，同时切换该 Loop 后续 Step 使用的 Model Selection 与 Model。普通 Submission 仍在新 Loop 开始时固定自己的 Model。

### 17. 视频输入进入统一 Model Property

设计文档已经把 `supportsVideo` 定义为 Model Property，但 M1 的可执行契约最初只实现了图片与 PDF。M2 准备接入 Registry Model Factory 时发现并补齐该缺口：

- `ModelProperties` 明确携带 `supportsVideo`；
- Model 在 Provider 调用前校验视频文件输入；
- Core 的媒体投影在模型明确不支持视频时移除原始视频数据，并保留可追踪的文本占位；
- 旧 Factory 尚未提供该字段时保守按 `false` 处理，新 Registry 创建的 Model 必须从完整 Model Config 显式提供。

这项改动补全既有 Model 契约，不改变 Provider Config、Registry 或 Adapter 的分层。

## 验证记录

已通过：

- 根工作区 `pnpm typecheck`。
- ZCode CLI 的 Contracts、Adapters、Core、Bootstrap、CLI 等 23 个包 typecheck。
- 根工作区 `pnpm lint`（0 error；现有 warning 保持不变）。
- 合并最终 staging 前的根工作区全量单元测试：1148 个文件、9831 项通过，8 项跳过。
- Adapter 全量测试：75 个文件、1159 个通过、3 个跳过。
- M1 Core 重点测试：Model 生命周期、Compact、Memory、WebFetch、WebSearch、ReadSessionContext 等。
- Services 重点测试：Git Commit Message、Repo Wiki、ZCode Protocol Client。
- Bootstrap workspace model generation 与取消协议测试。
- 本轮缺口修复后的 Contracts 全量测试及新增流式调用上下文回归：28 个文件、202 项通过。
- 本轮缺口修复后的 Adapter 全量测试：77 个文件、1191 项通过、3 项跳过。
- 本轮缺口修复后的 Services 重点测试：5 个文件、82 项通过。
- 本轮缺口修复后的根工作区 `pnpm typecheck` 与 `pnpm lint`；lint 为 0 error，35 个既有 warning。

最终合并 `d8cf5a49a7` 后再次运行根工作区全量单元测试：1171 个文件、9989 项通过，4 项失败，8 项跳过。失败全部来自本轮 staging 新合入的 Settings 源码文本断言；当前分支与 `origin/staging` 在相关实现和测试文件上没有差异。Provider/Core 相关的 155 项合并后回归测试全部通过。

完成审计后的最终根工作区全量单元测试为 1170 个文件通过、4 个文件失败、1 个文件跳过；9989 项通过、5 项失败、8 项跳过。四项 Settings 源码文本断言和一项 Web Remote 重连时序测试均位于未修改文件，其中 Settings 失败可在 staging 代码上直接确认，Web Remote 为本次全量运行中的独立时序失败。Bootstrap 全量测试的 steering、resume title、marketplace、v4 boundary 与 telemetry mock 失败也已在 staging 或未修改文件上复核，不属于 Provider 迁移回归。

ZCode CLI 的 Core 全量测试中的若干既有失败已在未修改的 staging 工作区复现，包括旧 steering 测试与本地 cc-run 路径依赖；这些失败不由本次迁移引入。CLI 全量 lint 仍会命中仓库已有的 max-lines 基线，改动文件单独 lint 为 0 error。

## 进度

- [x] 合并最新 staging 并检查模型调用相关变化。
- [x] M1.1：公共类型、兼容 Model Wrapper、单元测试。
- [x] M1.2：主 Agent Loop、Automatic Compact、Usage、Trace。
- [x] M1.3：Child Agent、Title、Goal verifier、Project Memory。
- [x] M1.4：Git、workspace generateText、WebFetch、WebSearch。
- [x] M1.5：Repo Wiki。
- [x] M1.6：删除业务侧旧读取，完成可执行门禁；仓库既有基线失败单独记录。

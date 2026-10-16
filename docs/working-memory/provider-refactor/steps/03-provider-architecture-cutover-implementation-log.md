# M3 实施记录

> 状态：当前基线实现完成，待集成裁决与上线门禁
>
> 最近更新：2026-08-21
>
> 阶段目标：[`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md)

本文记录 M3 实施过程中超出既定计划、但可以依据现有设计原则自主完成的工程决策。正常代码修改和命令输出不逐项罗列；会改变产品语义、公共抽象或阶段边界的问题仍需进入 Human in the Loop。

## 1. 当前工作树作为实施基线

M3 从本工作树的 `7f413be9de` 开始实施。该提交是 M2 在较新 staging 上的本地重建结果；当前本地 `origin/staging` 已再次发生历史重建并与本工作树双向分叉。用户已明确要求暂不处理远端分支，因此本轮不 merge、rebase 或恢复旧 staging 实现，也不把 M3.0 误记为完成。

M3 先在当前 M2 基线上按 Design 推进原子 Submission、Selection、Session Model、旧状态退役和 Settings 收敛。最终上线验收仍保留 staging 拓扑裁决与集成门禁；裁决前的实现提交保持职责单一，便于后续审计式重放。

## 2. Spec 与测试先行

原子 Submission 的正式行为先写入 Conversation Protocol Declaration 与 Conversation Product State Space。对应的 Shared、Core、Bootstrap 和 UI 测试在生产实现前迁移，用于锁定以下不变量：

- prompt、attachments、mode 与 ModelSelection 原子接收；
- Queue 固定入队时的 Selection；
- Guide 在 Model Step 边界切换；
- Edit、Retry 与 Goal 保留或继承明确的 Submission 意图；
- Composer Selection 不再预写当前 Runtime 模型。

## 3. Wire 与领域类型分层

Shared V4 定义可序列化 Submission wire schema，字段语义与 Provider `ModelSelection` 对齐；CLI admission 在边界转换为 Contracts/Core 使用的领域值。Shared 不反向依赖 Provider Registry 或 Model 行为，避免把 Provider 领域依赖压入所有协议消费者。

## 4. Guide 在 Core Step 边界切换

Queue 与 Guide 保存完整 Submission intent。Guide 真正 drain 时由 Core 使用 ModelFactory 创建新 Model，并同时更新当前 Loop 与 Session Selection；Bootstrap 不新增 Core 到 Bootstrap 的长期模型切换回调。已经发出的 Request 继续使用旧 Model，下一 Model Step 才使用新 Model。

## 5. Goal、Edit 与 Retry 的 Selection

Goal 首轮使用用户 Submission 中冻结的 Selection；自动续轮不保存另一份 continuation model，而在启动时读取届时的 Session Selection。Edit 和 Retry 从 canonical source input 继承原 Submission 的 Selection 与 mode，不读取当前 Composer 或后来变化的 Session 状态。

## 6. Renderer 只维护下一次提交意图

Composer 的模型、reasoning 和 mode 选择不再提前发送 `switchModelConfig` 或 `switchCollaborationMode`。Renderer 在发送时通过 `resolveComposerSubmissionConfig()` 形成完整 Submission；App Recent 仍在 Submission 被接受后更新。这样选择控件不会再充当 Active Model 或 Session Selection 的可变投影。

## 7. 当前切片验证边界

根 workspace TypeScript build 通过；Shared/UI 原子 Submission 专项测试 64 项通过；Core Model 生命周期与 Guide 专项测试 7 项通过。Bootstrap 五个相关文件的 138 项断言全部通过，但既有 fake-timer 超时用例产生三个未处理 rejection，使 Vitest 进程退出 1；这类错误不作为本切片的绿色证明，后续全量验收继续保留该基线风险。CLI 依赖构建到 Bootstrap 时只剩 legacy personal provider importer 的两项既有类型错误。

## 8. Session Selection 使用结构化持久格式

Contracts 提供协议无关的 `ModelSelection` 解析与从实际 Model 投影 Selection 的函数。Session entry 直接保存 `providerId`、`modelId` 与通用 options，使 reasoning level 和 max output tokens 随 Session 恢复。旧 entry 的顶层 `thoughtLevel` 只在冷读取边界单向兼容；新写入不再产生该字段。

## 9. ModelFactory 直接接收 Selection

`RuntimeModelFactoryInput` 改为直接接收结构化 `ModelSelection`。Provider、Model、reasoning level 与 max output tokens 由同一输入进入 Registry ModelFactory，不再由 Factory 从 `ModelRef.variant` 和独立 max-output 字段重新拼装。尚未迁移的 Adapter 只在最终装配边界取得临时 ModelRef 投影；调用用途继续由 operation 与 execution context 表达。

## 10. Session Selection 成为运行时模型事实

Agent Runtime 只持有 `sessionModelSelection`，并通过 `getSessionModelSelection()` / `setSessionModelSelection()` 读写当前 Session 选择；构造阶段仅将尚未迁移的旧配置 `modelRef` 单向转换一次，不再保存 `defaultModelRef` 或另一份可变模型状态。持久化、fork、compact、title、subagent、hook 与 turn loop 都读取同一 Selection。仍要求 `ModelRef` 的旧 Adapter 暂时通过 `getModelRef()` 即时投影，后续 M3.5 将连同旧配置写入口一起删除。

这一切片以九个 Core 测试文件锁定 Session Selection、Guide step 切换、持久化与派生流程，迁移前 17 项失败，实现后 190 项全部通过。

## 11. Bootstrap 切换与恢复写入 Selection

Bootstrap 的 Registry `setModel`、reasoning level 修改和冷恢复统一调用 `setSessionModelSelection()`，不再通过 `updateConfig({ modelRef })` 改写 Session 模型事实。Session entry 从 Runtime 读取并保存完整 Selection，因此 reasoning level 与默认或显式 max output tokens 一起恢复。Turn Overlay 返回的执行期兼容配置暂留，归入后续 M3.5 Adapter 清理。

测试夹具先迁离旧 `updateConfig({ modelRef })` API；由于这些夹具直接调用 Core，新旧实现下均保持绿色，4 个文件 240 项通过。Bootstrap 的模型配置、冷恢复与 off-peak overlay 3 个文件 67 项通过。Provider Registry App Runtime 的 8 项测试中 1 项通过、7 项在进入断言前被当前工作树缺失的 Browser Use seed 构建产物阻断；Bootstrap 构建继续只报 legacy personal provider importer 的两项既有类型错误。

## 12. 删除 Runtime Config 的 ModelRef 写入口

全局引用审计确认生产调用方已经离开 `updateConfig({ modelRef })` 后，Core 从 `updateConfig` 的公开类型和实现中删除该字段。运行参数更新与 Session Selection 写入由此形成机械边界：context window、max output tokens 等运行参数更新不能隐式改写 Selection，模型意图只能经 `setSessionModelSelection()` 或 Submission admission 进入。

新增的边界测试与模型生命周期测试共 16 项通过，Core TypeScript build 通过。`dep:refs` 当前无法把嵌套的 `apps/zcode-cli` package 加载进根 project；删除审计因此同时使用全量 knip 与无 scope 的文本调用图，不能把该工具失败误记为零引用证明。

## 13. 新建 Runtime 直接接收 ModelSelection

`AgentRuntimeConfig` 新增结构化 `modelSelection`，Bootstrap Registry 初始化、Workflow child、Script Workflow child 与 Subagent child 都直接传递 Selection；Registry 解析结果同时携带归一化 Selection，不再要求 App 先构造 Session `ModelRef`。Core 构造器暂时保留旧 `modelRef` 的单向读取，只服务尚未迁移的测试、协议 Entry 与兼容配置，生产 child runtime 已离开该字段。

两项先行测试在旧实现下按预期失败，实现后 Core 与 Bootstrap 共 37 项通过。Core 及依赖 build 通过；Bootstrap 仍只报 legacy personal provider importer 的两项既有错误。

## 14. Protocol Session Entry 解析为 Selection

ZCode Protocol 的 `session/create` 仍接受 wire 层结构化 model DTO，但进入 App Runtime 前直接转换为 `ModelSelection`，reasoning variant 写入 `options.reasoningLevel`，不再构造初始 `ModelRef`。Workspace generate text 仍是独立模型任务，暂时保留自己的旧输入，后续按独立任务迁移切片处理。

新增协议入口测试确认 Runtime 收到完整 Selection 且配置中不存在 `modelRef`；目标测试 1 项通过。

## 15. 执行用途不再编码为 ModelRole

Title、Subagent、Registry Main 与 Turn Overlay 不再向模型身份写入 `ModelRole`。Title 由 `modelCall.operation=session_title_generation` 识别，Subagent 由 child runtime/task context 识别；模型身份只保留 Provider、Model 与尚待迁移的 reasoning variant。生产 Core、Bootstrap、Adapter 与 Contracts 源码中已没有 `ModelRole.*` 构造。

Subagent 初始模型事件测试先在旧实现下失败，删除 role 后与 Title operation 测试共 2 项通过；Core、Adapter 及其依赖 build 通过，Bootstrap 仍停在同两项 legacy importer 基线错误。

## 16. 模型调试与创建不再传播旧来源元数据

Adapter Registry、Core 默认占位选择和 Model IO debug 不再构造或输出 `ModelRefSource`；Core 内部依赖 barrel 同时停止重导出 `ModelRole` / `ModelRefSource`。来源语义保留在 Submission、query source、trace context 和 task context，不再伪装成模型身份字段。

Model IO debug 测试先确认旧记录仍含 role/source 而失败，清理后 2 项通过，Adapter TypeScript build 通过。Contracts 中的旧类型与 parse/schema 仍暂留给未迁移测试和协议，下一切片继续删除。

## 17. Contracts 删除 ModelRole 与 ModelRefSource

Contracts 已删除 `ModelRole`、`ModelRefSource`、对应 `ModelRef` 字段、parse options 与 JSON Schema properties；全仓 TypeScript 源码和测试均无这两个符号。旧用途不再能通过公共类型或 schema 重新进入系统，Lite role 也随之正式退役。

Contract 测试先在旧 parser 仍输出 undefined metadata key 时失败，删除后 4 项通过；迁移的 8 个 Core 测试文件 175 项通过，Adapter debug 2 项通过，根 workspace typecheck 通过。Bootstrap session persistence 仍被缺失 Browser Use seed 产物阻断，与本切片无断言关联。

## 18. 删除 Lite Runtime 配置

`AgentRuntimeConfig`、Bootstrap 配置装配、Project Memory selector 与 Subagent child 已删除 `liteModelRef` / `liteModelProviderOptions`。独立任务缺省继承当前 Session Selection，再通过 `modelCall.operation` 和 reasoning policy 表达任务策略；Subagent profile 的旧 `lite` 特判也已删除，不再把一个用途别名转换成第二份共享模型状态。

先行测试确认旧 Bootstrap 仍生成两个 undefined Lite key 而失败；清理后 Runtime Config、Subagent、Memory 与 Profile 共 103 项通过，Core 及依赖 build 通过。测试 Registry helper 同步改为采集结构化 `modelSelection`。

## 19. 删除 AgentRuntimeConfig.modelRef

Core Runtime 构造配置与 Bootstrap Registry 初始化已删除旧 `modelRef` 输入和兼容读取；Runtime 只能由 `modelSelection` 初始化。未提供 Selection 的低层测试/占位 Runtime 使用明确的 `zcode-unconfigured/missing-model` 结构化占位值，不再通过内部字符串 parser 生成。Protocol、Workflow 与 Subagent 生产入口此前已完成 Selection 迁移。

12 个 Core 测试文件的 61 个构造夹具和 3 个 Bootstrap 测试/基座先迁移，Core 393 项及连同 Runtime Config 的 420 项通过。Telemetry 同时删除从 ModelRef 投影 `modelRole` 的路径；先行红测转绿，5 项通过。Core、Adapter、Telemetry 及其依赖 build 通过，Bootstrap 回到两项 legacy importer 基线错误。

## 20. 持久化与展示直接读取 Session Selection

Session fork、message/timeline persistence、Context/Hook prompt metadata 与 Workflow 展示不再调用 `getModelRef()`。旧持久化 DTO 仍要求 branded provider/model 字段时，只在写入边界校验并投影 Selection；reasoning 从 `options.reasoningLevel` 读取。生产 `getModelRef()` 调用从 62 处降至 40 处，剩余调用集中在尚未迁移的独立模型任务、旧事件和 Adapter 输入。

相关 fake runtime 先迁为 `getSessionModelSelection()`；Session Fork 25 项、Hook admission 19 项、Runtime persistence 61 项通过，Core 及依赖 build 通过。Bootstrap 工作流测试仍受缺失 Browser Use seed 产物阻断。

## 21. Session Facade 退出 Runtime ModelRef 读取

Session Facade 的模型展示、Registry 归属判定、reasoning 读取/切换和模型切换前态统一读取 `getSessionModelSelection()`；`ModelRef` 只在尚未迁移的模型变更事件写入边界临时投影，不再从 Runtime 取得第二份模型事实。Overlay 与 Registry 同名时仍按 execution-scoped Overlay 优先，当前 reasoning 直接来自 Selection options。

新增回归测试将 `getModelRef()` 设为调用即抛错，覆盖模型展示、默认/当前 reasoning、档位列表和 reasoning 切换；旧实现按预期失败，迁移后 3 项通过。Provider Registry App 测试仍有 7 项在进入断言前被缺失 Browser Use seed 产物阻断，另 1 项通过；Bootstrap 构建继续只报 legacy personal provider importer 的两项既有类型错误。

## 22. Bootstrap 协议投影退出 Runtime ModelRef 读取

V4 模型命令、create-session config admission、Registry fallback、V4 config seed 与旧发送端 Submission admission 全部直接读取 Runtime `ModelSelection`。尚未迁移的 `ModelSelected` 事件只在发布边界把 Selection 临时投影为旧事件 DTO；跨进程 config seed 与 canonical Submission 均保持结构化 provider/model/options，不再读取 Runtime ModelRef。Bootstrap 生产源码已无 `getModelRef` 引用。

先行测试把模型命令、Registry fallback 和 V4 config seed 的旧 getter 替换为 Selection getter，旧实现分别产生 18 项、1 项和 2 项失败；迁移后模型命令与 fallback 共 35 项、完整冷恢复 32 项通过。

## 23. 持久化缺省模型读取 Selection

Assistant message 与 Compact summary/reminder 在调用方未传显式 execution model 时，从 Session Selection 投影旧持久化 DTO；模型请求路径显式传入的请求快照仍保持优先，避免 Guide 切换影响在飞请求归因。默认持久化不再读取 Runtime `getModelRef()`。

两项先行测试均通过“旧 getter 调用即抛错”锁定边界，旧实现各失败 1 项；迁移后持久化专项 5 项、Runtime persistence 61 项、Runtime compact 68 项通过，Core 及依赖 build 通过。

## 24. 删除 AgentRuntime.getModelRef

`AgentRuntime` 的公开接口、内部接口和 prototype 已删除 `getModelRef()`。普通执行、title、goal verifier、compact、project memory、MCS、embedded search、subagent 和工具装配统一从 Session Selection 读取；仍需要旧 Adapter/执行事件 DTO 的位置在消费边界临时投影，不再暴露第二个共享 Runtime getter。Core 中剩余同名 getter 只属于 Tool Executor 自己的 execution-scoped request context，后续随 ModelRef 类型退役继续迁移。

两项模型生命周期测试先断言 Runtime 不再公开旧 getter，旧实现按预期失败；迁移后相关 8 个测试文件 289 项通过，Core 及依赖 build 通过。Bootstrap 构建仍仅有 legacy personal provider importer 的两项既有类型错误。

## 25. Settings Service 增加原子身份重命名

Provider Config Service、Settings Facade 与跨进程 Service 契约新增 `renamePersonalProvider` 和 `renamePersonalModel`。Provider rename 在同一次 Personal Repository update 中保持有序位置并迁移全部精确 Model Config；Model rename 同时替换 Provider 的模型列表项和精确规则。两者都拒绝覆盖 Official 或已有 Personal 身份，Official Provider/Model 不能通过 Personal 设置重命名。

三项先行测试在旧实现下因方法缺失失败；实现后 Provider 全量 115 项、Provider build 与根 workspace typecheck 通过。UI 尚未接入这两个操作，下一切片继续移除 label/删除重建式身份编辑。

## 26. 添加 Provider 改为原子创建

“添加供应商”不再进入 Renderer 持有 UUID、名称、端点、密钥和模型的二次保存表单。Provider Config Service 在一次 Personal Repository 原子更新中同时检查 Official 与 Personal 身份，依次分配 `new-provider`、`new-provider-2`、`new-provider-3`，写入默认启用但尚不完整的 Personal Provider；Settings Facade 等待 Registry 刷新后返回 `{ providerId, view }`。Renderer 点击左侧添加项后直接调用该 Service，并立即选中新身份进入既有详情编辑。

旧 `AddProviderCard`、UUID 草稿生成器及其整套创建表单测试已经删除，避免保留第二条“先在 UI 组装完整 Provider、再保存”的前朝路径。先行测试在旧实现下分别因 Config Service、Facade 和导航动作缺少原子创建能力失败；实现后 Provider 116 项、Settings Runtime 8 项、Settings UI 199 项与根 workspace typecheck 全部通过。

## 27. Settings UI 接入原子身份重命名

Personal-only Provider 的设置页名称现在直接读取 `providerId`，名称提交调用 `renamePersonalProvider(oldId, newId)`，成功后把当前导航选择前向迁移到新身份；不再通过 `config.label` 制造第二个名称事实。Config Service 在 Personal-only Effective 保存和原子 rename 时主动清除历史 `label`，因此旧配置会在下一次编辑或改名时自然收敛。Official Provider 仍保留 Official Config 的只读 label。

模型编辑对 Model ID 的修改先调用 `renamePersonalModel(providerId, oldId, newId)`，等待有序模型列表与精确 Model Config 原子迁移完成后，才保存同一编辑动作中的 Properties / Option Specs。先行测试锁定 rename-before-save 顺序以及 Personal label 清理；实现后 Provider 117 项、Settings/UI/Runtime 相关 233 项、根 workspace typecheck 通过。保存反馈的 revision 状态仍待下一切片接入。

## 28. 连通性测试改走目标 Environment 的正式 Model

设置页“测试模型”不再在 Host 中根据草稿手拼 Anthropic/OpenAI HTTP URL、鉴权头、reasoning body 和一次性请求。UI 先以完整 Effective Draft 调用 `saveEffectiveProvider`，只在返回的 Settings View 中确认 Provider 已 selectable 且 Model 已存在；随后跨 Service/Agent 协议只传目标 workspace 与 `ModelSelection`。CLI 从该 Environment 的 Registry 创建正式 `Model`，发送最小请求并完整消费 `streamText` 到 finish。API Client、Account Config、动态 Runtime Headers、Start Plan 官方版本安全校验、Provider Adapter 与错误语义因此和普通执行共用同一条链路。

远程设置页现在通过 `workspacePath + workspaceIdentity + remoteSessionId/remoteTarget` 解析目标 Service Collection；`useModelProviders` 改读当前 `ServiceProvider`，并订阅该 Environment 的 Settings View，避免远端草稿误保存到本地 Host。Host 仍只负责账号 Overlay 同步与协议转发，不持有另一份 Provider 执行配置。

旧 `modelProviderConnectivityProbe`、HTTP helpers、request body builder、logging wrapper 及两套直连探测测试已经删除，共净删除约 1,200 行前朝实现。先行测试覆盖正式 Model stream 消费、协议 active/temporary app、Agent workspace identity 路由、保存后再测试顺序与错误归一化；Core 8 项、Bootstrap 2 项、Services/UI 33 项通过，根 workspace typecheck 通过。Lint 为 0 error、38 个与本切片无关的既有 warning；Bootstrap build 仍只报 legacy personal provider importer 的两项既有类型错误。

## 29. Settings UI 以 Draft revision 展示自动保存反馈

Provider 详情现在为本地 Draft 维护单调递增 revision，并展示 `dirty -> saving -> success/failure` 状态。保存完成只有在响应对应当前 revision 时才生效；在飞请求之后又发生编辑时，旧响应不能覆盖新的 dirty 状态或错误地显示成功。成功勾在短暂保留后淡出；失败保留图标、可访问错误文本与重试入口。父层保存不再吞掉异常，因此字段附近能得到真实失败结果。

Base URL、API Key 和 Provider 名称继续在失焦时提交，并补齐 Enter 提交；API Format、Enabled、模型变更和拖动仍在操作完成后立即保存，模型拖动失败继续恢复原顺序。测试覆盖 revision 门控、dirty/saving/success、失败重试和 Enter 提交；相关 UI 221 项通过，根 workspace typecheck 通过。

## 30. workspace 独立生成链退出 ModelRef 协议

`workspace/generateText` 的跨进程参数、结果、Bootstrap App、Core Runtime 和 Services 消费方统一改为结构化 `ModelSelection`。Git 提交消息与 Repo Wiki 直接传递 `options.reasoningLevel`；Core 使用 Selection 创建正式 `Model`，结果再从实际 Model 投影 Selection。旧 `modelRef.variant` 只在尚未迁移的 Adapter、鉴权、事件边界局部投影，不再作为这条协议和独立任务的输入事实。

同步迁移 Git、Repo Wiki、协议与 Runtime 测试，并增加协议到 App 的断言，确认输入保留 `selection` 且不再下发 `modelRef`。Core 相关 15 项、Bootstrap 协议/连通性 6 项、Services 73 项及根 workspace typecheck 通过。

## 31. 标题生成配置退出 ModelRef

`AgentRuntimeConfig.titleGeneration` 的模型覆盖改为 `modelSelection`；空覆盖继续在真正执行时读取当前 Session Selection，显式覆盖则完整保留 reasoning options。标题 sidecar 直接用 Selection 创建正式 `Model`，并返回实际 Model 投影出的 Selection。旧标题事件和动态 Runtime Headers Port 仍要求旧 DTO 时，仅在对应写入/调用边界临时投影，不再把 `ModelRef` 暴露回标题配置或 sidecar 结果。

无独立语义的 `titleGenerationModelRef` 和单调用方 `session-title-runtime-headers.ts` 已删除，测试夹具也不再构造嵌套 `modelRef`。先行测试用不同于 Session 的标题 Selection 锁定覆盖行为；Core 标题/持久化相关 88 项、Bootstrap 标题/协议相关 12 项与根 workspace typecheck 通过。Bootstrap build 除 legacy personal provider importer 的两项既有错误外无新增错误。

## 32. Goal 完成验证直接消费 Session Selection

Goal completion verifier 不再把 Session Selection 投影为 `ModelRef`、追加输出预算后再反向转换为 Selection。验证开始时直接冻结一份 Selection，并在该副本的 `options.maxOutputTokens` 上合并请求预算后创建正式 `Model`；请求、重试和 usage 仍共用这次冻结快照。旧 ModelRequest 事件与动态 Header Port 所需身份只在执行边界从实际模型局部投影。

Goal completion / post-turn verification 相关 4 项与 Core build 通过。

## 33. Project Memory sidecar 直接冻结 Selection

Project Memory extraction、dream 与 recall 不再从 Session Selection 投影 `ModelRef` 后又反向构造 Selection。调度时冻结结构化 Selection，并在副本上合并输出预算后创建正式 `Model`；跨异步边界的 Agent Context 同时保存该 Selection，Provider 消息构建直接读取它。旧 Tool Executor getter 和动态 Header Port 仍只在其兼容边界使用局部 ModelRef 投影。

Memory agent / extraction / dream / permission 94 项、Memory recall 13 项与 Core build 通过。

## 34. Selection 输出预算合并收敛到纯函数

Core 新增 `withModelSelectionMaxOutputTokens`，以不修改源对象的方式覆盖 Selection 输出预算；Goal verifier、Project Memory 与 Compact 普通 Session 分支统一使用它。Compact 已持有正式 `Model` 时直接从实际 Model 取得 Selection；只有显式 `turnExecutionModel` 继续通过 `runtimeModelSelectionFromRef` 进入 M4 execution-scoped overlay。该旧反向转换 helper 因此不再被任何普通 Session 或 sidecar 路径调用。

先行单测覆盖 options 合并与无 override 克隆；Selection 12 项、Compact 72 项、Memory 107 项和 Core build 通过。

## 35. 删除无效的草稿模型切换保护窗与死导出

UI 中两套基于 TTL Map 的旧保护窗已经删除：`draftModelConfigSwitchGuard` 的两个 mark 入口在生产代码中均为零调用，唯一剩余的 preserve 调用因此永远面对空 Map，只会原样返回；`thoughtLevelConfigUpdateGuard` 则只被自身测试引用。继续保留这些状态机会让读者误以为 Renderer 仍在维护一份已提交模型状态，并掩盖 Submission 已原子携带 Selection 的事实。删除后 `setConfigOptions` 只执行规范化与等价去重，不再打印逐次生产级配置日志。

同一轮引用审计还收窄了 Provider 保存和 Composer 模型展示 helper 的公开面，删除三个零引用导出，并修正冷恢复中仍称 `defaultModelRef` 的过期注释。`dep:refs` 用于核对根 workspace UI 导出引用；其对别名 import 存在漏报，因此删除候选同时用全仓文本调用图逐项复核，未把工具漏报当作零引用证明。

删除后草稿配置、Session Store、Composer 恢复、全局模型种子、模型偏好确认与 Provider 设置 6 个文件共 98 项通过；根 workspace typecheck 通过，lint 为 0 error、仅保留与本切片无关的既有 warning。

## 36. 全量验收反向迁移遗漏测试夹具

`test:unit:affected` 因相对远端基准包含已删除文件而自动降级为全仓单测。该运行抓到两类与 M3 直接相关的旧夹具：SessionPane continuity snapshot 没有完整 provider/model/mode，导致原子 Submission 正确拒绝；SettingsPage 的 workspace service mock 未实现新增的目标 Environment 解析结果。两者均按正式契约补齐，不放宽生产校验。

Bootstrap 专项继续发现冷恢复断言和两个 fake app 仍从 `runtimeConfig.modelRef` 初始化。测试基座已经改为读取 `runtimeConfig.modelSelection`（包含 reasoning option），冷恢复同时断言旧字段不存在；Guide fake runtime 也不再构造已删除的共享 `modelRef` 配置。迁移后 UI 两个文件 11 项、Bootstrap 冷恢复与协议行为 33+1 项、Core Guide 1 项通过。

## 37. 修复旧 CLI 导入边界的类型真源

Desktop E2E 构建暴露 Bootstrap 一直被掩盖的两项类型错误：普通 `ZCodeConfigFileSchema` 有意把旧 `provider` 留作 passthrough unknown，但一次性导入器先用它解析、再假定该 unknown 已是旧 Provider 类型。专用 `parseLegacyCliModelConfig` 本来已经执行完整旧格式校验，现在直接把已校验的 `provider` 投影返回，导入器只消费这一个真源；普通 Runtime Config 仍不拥有 Provider 字段。

Adapter 先行测试确认专用投影包含完整 Provider/Model 定义；实现后该测试、Bootstrap 导入器 9 项以及 Adapter/Bootstrap build 全部通过，原来阻断 Desktop E2E 的两项基线错误归零。

## 38. E2E 设置驱动迁移到原子 Provider 生命周期

正式首发用例、设置 UI 用例、两个共享 Provider helper 与四个待评审 reasoning 用例仍在操作已经删除的 `AddProviderCard`：先填写 Renderer 草稿，再点击第二个“添加供应商”按钮。该路径与 M3.6 的原子创建和逐字段自动保存合同冲突，也会让未来恢复 pending case 时得到伪失败。

E2E 现在共用一条原子设置 helper：点击 `custom:add` 后等待已落盘的普通详情卡，调用身份重命名，再通过 Base URL、API Key 的 blur 和 API Format select 分别自动保存，模型 metadata 弹窗保存后即完成配置，不再寻找第二个提交按钮。名称、Base URL 与 API Format 补充统一 test id，并以 UI 单测先红后绿锁定；过期的复制版 DOM setter/select/save helper 一并删除，净删除约一千行测试代码。设置 UI 的 MP-UI-01 也改为断言原子创建后立即出现普通详情字段且旧 footer 不存在。

相关 UI 单测 23 项与 Desktop E2E TypeScript 全量检查通过，全仓已无 `model-provider-add-custom-*` 或 `clickAddProviderAction` 引用。本机正式回放先完成 Desktop、CLI、Adapter 与 Bootstrap 构建；宿主最初缺少 `xvfb-run`，随后用临时解包的 Xvfb 与 Electron 动态库启动真实 X Server，Chrome WebDriver session 仍在业务页面装载前退出。按 replay-isolated 规范尝试 Docker 单 spec 验证时，环境又没有 `docker` 命令。两条路径均未进入业务断言，因此不能记录为用例失败或绿色 admission；M3 最终验收保留该项环境待补验证。

## 39. Memory E2E 夹具退出 Lite ModelRef

最终旧符号审计发现 Memory runtime E2E 仍用 `modelRef + liteModelRef` 构造 App，并向已经只接受 Registry Config 的 Adapter 传递旧 `modelConfig`。迁移前完整命令在场景启动处以 `createModelAdapter requires registryConfig` 失败；夹具改为通过正式 `createAiSdkModelRegistryConfig` 装配 Adapter，并只向 Runtime 传递结构化 `modelSelection`。

首次迁移后运行又暴露既有 trajectory 断言的并发假设：首个 no-op Extraction 如果已经启动，完整轨迹为 6 次；如果下一次用户提交先到达，Scheduler 按既定 `latest pending` 语义合并旧快照，轨迹为 5 次。证据校验现在只接受这两种合法结果，显式 Extraction 的三步工具轨迹、next-session no-op、关闭取消以及文件结果仍各自独立断言。对应证据单测 4 项与 `pnpm --dir apps/zcode-cli test:e2e:memory` 完整构建、运行、产物校验均通过。

## 40. 当前基线最终验收状态

M3.1 至 M3.9 的当前基线实现已经收口。生产源码旧符号审计确认 `defaultModelRef`、`liteModelRef`、`liteModelProviderOptions`、`ModelRole`、`ModelRefSource` 与独立 Connectivity Probe 均已退出；`runtimeModelSelectionFromRef` 只剩 M4 明确保留的 `turnExecutionModel` execution-scoped overlay。根 `pnpm typecheck` 通过，`pnpm lint` 为 0 error、38 个与本阶段无关的既有 warning，改动文件定向格式检查通过。

全量 affected 单测曾降级为全仓运行，M3 直接相关的旧夹具失败已全部修复；剩余失败集中在 CUA/平台依赖、缺失 Browser Use seed、打包公证和既有 fake-timer rejection。全仓 `fmt:check` 仍被仓库内 Electron 文档的既有非法 HTML 与 GB2312 fixture 阻断。正式 Desktop 原子设置首发 E2E 因当前环境缺少 Docker、宿主 WebDriver session 又在页面加载前退出而未获得 admission。远端 staging 拓扑继续按用户要求留待裁决。因此这里记录“当前基线实现完成”，不把整个 M3 阶段或上线门禁误记为完成。

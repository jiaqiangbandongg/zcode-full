# M3：Provider 架构切换

> 状态：当前基线实现完成，待集成裁决与上线门禁
>
> 最近更新：2026-08-21
>
> 实施载体：当前 Draft Merge Request；源分支暂时保留历史 M2 命名，阶段与评审语义以 M3 为准，不另开并行分支

M3 是一次完整架构切换。当前 Merge Request 中已经完成的 Provider Config、Registry、ModelFactory 与生产接入构成它的基础；本阶段继续完成原子 Submission、模型选择状态、Provider 设置页，并删除被新链路取代的旧协议和旧运行状态。整个变更作为一个大 Merge Request 接受评审和上线验证，这是本次迁移的明确实验，不再把已完成的 M2 基础单独发布后另开 M3。

目标设计分别位于：

- [`../design/registry/registry.md`](../design/registry/registry.md)：Config、Registry 与 Model 创建；
- [`../design/interaction/interaction.md`](../design/interaction/interaction.md)：Draft、Selection、Submission、Queue 与 Guide；
- [`../design/registry/settings.md`](../design/registry/settings.md)：设置页保存、调序与连通性测试；
- [`../design/execution/execution.md`](../design/execution/execution.md)：当前阶段与 execution-scoped Provider 的边界。

本文负责把这些已确定的设计组织成一个可执行、可评审、可验收的迁移计划。

## 完成后的主链

M3 完成后，Provider 静态事实、用户提交意图和模型执行分别经过唯一入口：

```text
Official Config ─┐
Personal Config ─┼─> Process Registry
Account Config ──┘        ├─ Settings View
                           ├─ Selection View
                           └─ createModel(ModelSelection)

Composer Draft / CLI Input
├─ prompt
├─ attachments
├─ mode
└─ ModelSelection
          |
          v
     CoreSubmission
          |
          v
CLI Admission
├─ start-now
├─ queue
└─ guide
          |
          v
Session Selection + Active Model
          |
          v
      ModelRequest
```

这条链路形成三个清晰边界：

1. Config 与 Account Source 决定当前 Environment 中有哪些 Provider 和模型。
2. Submission 固定一次用户输入及其模型意图，投递过程中不再读取 Composer 的后来状态。
3. Registry 根据 Selection 创建 Model；Model 与请求结果是 Usage、Trace 和错误归因的执行事实。

## 当前基础与阶段关系

原 M2 已经完成 M3 的 Provider 基础设施：

- Official、Personal、Account 三层 Provider Config；
- 进程级 Registry、Settings/Selection Facade 与 ModelFactory；
- Host、Worker、Prompt CLI、TUI 的主要生产装配；
- Account Provider 的静态配置与请求期鉴权边界；
- 旧 Catalog、Preset、Workspace Snapshot 和 Runtime Provider 静态事实的退役。

这些改动尚未独立合入，因此 Roadmap 中的 M2 视为 M3 的已完成基础切片。M3 不重新实现它们，而是在同一分支上完成交互和设置链路，随后以一份自洽的系统进入上线验证。

## 实施范围

### M3.0：固定基线与评审结构（远端拓扑待裁决）

具体方案见 [`03-staging-integration.md`](./03-staging-integration.md)。当前本地 staging 已发生历史重建，用户裁决前不 merge 或 rebase 远端分支；M3 先以当前 M2 工作树为权威推进可审计切片。最终上线前仍需完成拓扑裁决，确认只保留有效 Provider 改动，并完整验证 Video Input、模型输入类型和 ox-alpha reasoning 等产品语义；任何集成都不能恢复 staging 已删除的旧实现。

大 Merge Request 保留多个职责清晰的提交，并按以下评审区域组织 Changes：

```text
A  Config / Registry 基础
B  Submission / Selection 协议
C  CLI Admission / Queue / Guide / Session
D  ModelRef 与旧运行状态退役
E  Provider Settings Service
F  Provider Settings UI
G  连通性测试 / Model / Adapter
H  迁移清理、测试与文档
```

区域用于降低评审成本，不形成可长期共存的双轨实现。

### M3.1：更新正式行为 Spec 与测试地图

实现前先把原子 Submission 写入长期 Spec，并消除现有文档中“Queue 消费时读取最新 Session 模型”的旧表述。需要同步检查：

- Conversation Protocol Declaration；
- Conversation Product State Space；
- Conversation Case Catalog 与 Coverage Matrix；
- Feature Graph 中 Composer、Queue、Guide、Edit、Retry 和模型切换的边；
- Desktop continuous 与 Mobile replayable 对同一 Submission 的投递边界。

Working Memory 决定迁移目标，正式 Spec 决定上线后的产品行为。测试用例从 Spec 中提取，不从当前实现反推。

### M3.2：建立原子 CoreSubmission 协议

Shared Protocol、Renderer、Services 与 CLI 使用同一个 Submission 结构：

```ts
interface CoreSubmission {
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: readonly SubmissionAttachment[];
  mode?: AgentMode;
}
```

协议接收 prompt、attachments、mode 和 ModelSelection 的单次原子提交。普通发送不再依靠 `switchModelConfig` 与 `sendText` 的调用顺序，也不通过可变 Runtime 传递“下一条消息的模型”。

Desktop continuous 和 Mobile replayable 可以采用不同的传输恢复机制，但两端携带同一个完整 Submission。远程 Workspace 继续传递 `workspaceIdentity` 与 `remoteSessionId`，Provider 重构不改变远控的 owner、lease 或 replayable 恢复职责。

### M3.3：让 CLI Admission 成为执行权威

CLI 在接收 Submission 时明确选择一种 admission 结果：

```text
Core idle
└─ start-now
   ├─ Registry 创建 Model
   ├─ Session Selection = Submission Selection
   └─ 启动 Agent Loop

Core busy
└─ queue
   └─ Queue item 保存完整 Submission

Guide accepted
├─ 当前已发出的 Request 继续使用旧 Model
├─ Step 边界创建并切换新 Model
├─ Session Selection = Guide Selection
└─ 后续 Step 使用新 Model
```

Queue 出队时使用入队对象中的 Selection。Composer 后续切换、Session 期间发生的其他输入和 Config 更新，都不能改写已经接受的 Queue item。

Guide 与“立即”使用同一语义。创建 Model、注入 Context 或更新 Session 状态无法整体完成时，完整 Submission 转入 Queue，不留下只切换模型或只插入文本的中间状态。

Edit 与 Retry 从源 Submission 派生，缺省继承源 Selection；如将来提供“使用当前模型重试”，必须形成携带新 Selection 的显式 Submission。

### M3.4：收敛 Renderer 的选择状态

Composer 中的选择只表达下一次 Submission。Renderer 负责 Draft 与 App Recent，不再预先修改 CLI Runtime：

```text
Composer 编辑 ModelSelection B
├─ 更新 Draft
└─ 不影响 Active Model A

用户提交
├─ 形成 Submission B
├─ App 接受后更新 App Recent
└─ CLI 开始执行后更新 Session Selection
```

App Recent、Configured Default、Draft、Session Selection 和 Active Model 的初始化及写入时机继续以 [`../design/interaction/selection-state.md`](../design/interaction/selection-state.md) 为准。Prompt CLI 与 TUI 不读写 App Recent。

### M3.5：退役 ModelRef 与共享可变模型状态

M3 删除普通执行链上的 `ModelRef`、`defaultModelRef` 和基于字符串 `providerId/modelId` 的内部协议。现有字段按真实语义迁移：

```text
ModelRef.providerId / modelId -> ModelSelection
ModelRef.variant              -> ModelSelection.options.reasoningLevel
ModelRef.role / Lite          -> 删除
ModelRef.source               -> Submission 或 Trace metadata
```

结构化 `ModelSelection` 是进程内状态和跨进程协议的模型意图。CLI 人类输入可以继续提供 `provider/model` 简写，但解析只发生在 Entry 边界；内部不保存、拼接或重新解析该字符串。

删除前使用引用审计确认所有生产消费者已经迁移。`turnRuntimeModel` 属于 execution-scoped Provider 的 M4 边界，本阶段既不扩大它的用途，也不以删除它作为 M3 完成条件。

### M3.6：完成 Provider Settings Service

Renderer 通过目标 Environment 的 Provider Settings Service 读取和修改 Provider。Service 负责：

- 返回适合设置页的 Settings View；
- 保存完整 Provider Draft，并计算稀疏 Personal Overlay；
- Provider/Model 新增、重命名、删除与调序；
- 等待 Config 持久化和相应 Registry revision 生效；
- 使用 Registry 创建 Model 并执行连通性测试；
- 将领域错误投影为稳定的设置页错误结构。

Renderer 不读取物理配置、不执行 Overlay、不判断 Registry 准入，也不拼装 Provider 请求。

保存的时序需要形成一个明确完成点：

```text
Renderer submit Draft revision N
        |
        v
Settings Service 保存 Personal Config
        |
        v
Registry 观察到 Config revision N
        |
        v
Service 返回 Settings View revision N
        |
        v
Renderer 才显示“已保存”
```

### M3.7：完成设置页交互

设置页采用已经确定的自动保存语义：文本在失焦、Enter 或切换 Provider 时提交；选择、开关和拖动在操作完成后立即提交。页面显示 dirty、saving、success 和 failure 状态，只有 Host 确认相应 revision 后才显示成功勾。

本切片同时完成：

- 添加 Provider 后立即创建 `new-provider[-N]`，不保留二次“保存”按钮；
- Provider ID 与用户名称统一，重命名通过原子 Service 操作完成；
- 模型 ID 在独立模型编辑页修改，列表不提供内联名称编辑；
- Personal-only Provider 和允许调序的 Personal 模型支持拖动；
- 调序后按 Effective 顺序重排 Personal Overlay，Official 覆盖项保持 Official 顺序；
- Desktop 与 Mobile Web 使用相同 Service 契约，布局和反馈遵循项目 UI 规范与国际化要求。

### M3.8：使用正式 Model 进行连通性测试

设置页点击测试时，先提交尚未保存的 Draft，等待 Config 与 Registry 更新完成，再由 Registry 创建正式 Model：

```text
flush Draft
    -> wait Registry revision
    -> createModel(ModelSelection)
    -> Model.streamText(minimal request)
    -> consume stream
    -> normalized result
```

这条链路复用正式 Adapter、Request Auth、Reasoning Mapping 和错误边界。M3 删除独立 Connectivity Probe，以及 Renderer/Host 手工拼 Endpoint、Header 或请求体的旁路。

### M3.9：删除旧链路并完成全量审计

最后一个切片根据引用和运行时验证删除被替代的代码。删除门禁是行为条件，不是按文件名猜测：

- 普通发送不存在 `switchModelConfig -> sendText` 时序；
- Queue 不在消费时读取当前 Composer 或最新 Session 模型；
- 普通执行链不再读取 `ModelRef`、`defaultModelRef` 或 Lite role；
- Renderer 不再解析 Provider Config、Account 状态或 Registry 准入；
- 连通性测试不存在独立 Probe；
- Provider 静态事实不再从 Catalog、Preset、Workspace Snapshot 或旧 CLI Config 回流；
- Usage 与 Trace 从实际 Model 取得模型身份；
- 旧兼容代码只保留已在 Design 中明确划定的 M4、M6、M7 边界。

无法证明仍有生产消费者的旧代码直接删除，不建立新的 fallback。

## 验收矩阵

M3 的最低行为矩阵如下。每一项都需要单元或集成测试；跨进程、恢复和 UI 时序使用相应 E2E 覆盖。

| 场景                                | 必须保持的结果                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Loop 正在使用 A，Composer 切换 B    | 当前 Request 和后续 Step 继续 A，直到新的 Submission 或 Guide 被接收             |
| 空闲时提交 B                        | Submission、Session Selection、Active Model 与 Usage 使用 B                      |
| 忙碌时 B 入队，随后 Composer 切换 C | B 出队时仍使用 B                                                                 |
| Guide 使用 B                        | 当前已发 Request 使用 A，后续 Step 使用 B，Session Selection 更新为 B            |
| Edit / Retry                        | 缺省继承源 Submission 的 Selection                                               |
| App 重启或恢复                      | Draft、App Recent、Session Selection 按各自作用域恢复；CLI/TUI 不消费 App Recent |
| API Key 或 Config 更新              | 已有 Active Model 不变；下一次创建 Model 使用最新 Registry                       |
| 设置页测试                          | 先保存并等待 Registry，再通过正式 Model 调用                                     |
| Provider / Model 拖动               | Effective 顺序和 Personal Overlay 顺序符合设置设计，失败时回滚 UI                |
| Provider / Model 重命名             | 当前选择前向迁移；已完成历史保留旧身份                                           |
| Desktop / Mobile 提交               | 两端传输同一完整 Submission，continuous/replayable 边界不变                      |
| Remote Workspace                    | 使用远端 Environment Registry，不传递本机 Provider 配置或鉴权                    |

## 明确留到后续阶段的内容

M3 不借机扩展以下问题：

- execution-scoped Provider、闲时任务和 Subagent 强制模型策略，继续由 M4 处理；
- Provider Config 的远端管理发布、跨 Environment 同步与独立登录，继续由 M5/M7 处理；
- Account Provider 的身份、权益和动态凭据内部模型，继续由 M6 深化；
- Adapter 的 Reasoning 方言重构不与原子 Submission 混合，现有行为保持兼容；
- `turnRuntimeModel` 仅保留在已经划定的特殊执行边界。

这些边界允许当前大 Merge Request 完整切换普通产品链路，同时避免再次把闲时任务、Plan 和远端账号重构卷入本阶段。

## 完成定义

M3 只有在下列条件同时满足时完成：

1. 三层 Config 和进程级 Registry 是普通 Provider 的唯一事实来源。
2. 所有用户输入以完整 Submission 进入 Core，Queue 与 Guide 使用同一结构。
3. Composer、App Recent、Session Selection 和 Active Model 的状态与时机符合 Design。
4. ModelRef 和共享可变 Runtime 模型状态退出普通执行链。
5. 设置页通过正式 Service 完成自动保存、编辑、调序和连通性测试。
6. 旧 Provider、模型切换和 Connectivity Probe 链路已经删除。
7. 类型检查、Lint、受影响单测、Provider/Conversation 专项测试及必要 E2E 通过。
8. Merge Request 的提交和 Changes 能按评审区域追溯，Working Memory 与正式 Spec 已同步实际结果。

实现过程中若出现设计未覆盖的问题，记录在 M3 implementation log，并按已确定原则作出推荐决策继续推进；会改变目标语义、公共协议或阶段边界的问题进入 Human in the Loop 后再修改 Design。

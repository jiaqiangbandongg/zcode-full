# Todo 71：Composer Draft 持久化与 Submission 状态收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已完成实现与阶段验收（2026-09-04）。
>
> 来源：已有 Session 中切换 mode 后，Composer 被 Agent Session Snapshot 旧值覆盖，表现为菜单无法切换
>
> 依赖：Todo 68 的 Active Model 执行事实收口；Todo 70 的历史 Session Selection 迁移边界
>
> 最新裁决：已有选择缺失/失效时留空，不自动切默认模型，不弹失效提示。与 Todo 70 使用同一规则。

## 1. 问题

Composer 表达的是“下一次提交准备发送什么”。当前实现却把这份状态拆散在多个位置：

- 文本和 Lexical 状态进入 `V4ComposerDraft`；
- `mode` 和 `modelSelection` 只留在 React `draftConfig`；
- Workspace Store 还保存 `draftPreferredModel`、`draftPreferredMode`、`draftPreferredThoughtLevel`；
- mode 另有一份全局 localStorage 偏好；
- 已有 Session 的 Toolbar 又持续读取 Agent Session Snapshot；
- 提交时再临时合并 Snapshot、Draft 和各类 Preferred 状态。

因此 Renderer 没有一个完整、稳定的 Composer 事实源。典型错误时序如下：

```text
已有 Session Snapshot.mode = yolo
            |
            v
Composer 显示 yolo
            |
用户选择 build
            |
            v
React draftConfig.mode = build
            |
            v
组件重新渲染
            |
            `-- 又从 Snapshot.mode 读取 yolo
                    |
                    v
              菜单看起来切换失败
```

这不是下拉菜单组件本身的问题，而是 Composer 状态所有权错误：发送前状态被已经运行过的 Agent Session
状态持续反向驱动。

## 2. 目标状态

现有 Composer Draft 扩展为 Composer 的唯一持久化载体。Renderer 内存态负责即时交互，持久 Draft 负责重启、
切页和 Session 恢复；Agent Session Snapshot 不再作为 Composer 存活期间的实时输入。

```text
                    打开 / 恢复 Composer
                            |
                            v
              Persisted Composer Draft
                ├─ text / editor state
                ├─ mode
                └─ modelSelection
                            |
                            v
                 Composer In-memory State
                 （发送前唯一 UI 事实）
                    |               |
             用户修改               | submit
                    |               v
                    |        immutable Submission
                    |          ├─ prompt / attachments
                    |          ├─ mode
                    |          └─ modelSelection
                    |               |
                    `---- persist  v
                              Agent admission
                                   |
                                   v
                         Session execution state
                                   |
                                   v
                          immutable Active Model
```

核心原则：

1. Composer 只维护“下一次提交”的完整状态；
2. Submission 被创建后冻结自己的状态，不回读 Composer 或 Session；
3. Agent Session 状态可以记录已接纳 Submission 的执行事实，但不再持续反投影到 Renderer Composer；
4. Active Model 继续由 Todo 68 管理，不进入 Composer 持久化；
5. 不增加 `LastSubmittedState`、`SessionComposerState`、Context Model Snapshot 或新的 Provider/Model DTO。

### 2.1 与模型缓存的关系

持久 Composer Draft 不直接决定服务端 Prompt Cache 是否命中；缓存仍取决于真实请求的
Provider、Model、Options 和 Prefix。它的作用是保存用户正在持续使用的 mode/ModelSelection，
避免切页、重启或 Snapshot 重渲染时意外跳到另一个模型或模式，从而无意中改变后续请求前缀并
破坏缓存连续性。因此它是缓存稳定性的产品状态前提，但不是新的缓存配置层。

## 3. Composer Draft 契约

复用现有 `V4ComposerDraft`，把当前散落的执行选择并入同一个记录：

```ts
interface V4ComposerDraft {
  text: string;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  mode?: CollaborationMode;
  modelSelection?: ModelSelection;
  updatedAt: number;
}
```

这里的可选字段只服务持久化兼容和初始化过程。Composer 完成初始化后，内存态应持有可提交的完整 `mode`；
`modelSelection` 是否为空由当前 `ModelSelectionView` 和初始化/失效规则决定；已有选择失效后不得 fallback。

当前 `V4ComposerDraft` 的 localStorage key 和文件头都是 `v1`。本轮增加的 `mode/modelSelection` 是可选的
向后兼容叶子，继续使用 v1，不额外制造一次 key 搬迁；但 Reader 必须逐项校验 Draft 和新增叶子，不能继续
把 `JSON.parse()` 结果中的 `scopes` 直接断言成当前类型。旧 Draft 只有 text/editor 时正常读取，并按第 4 节
只执行一次缺失字段初始化。

### 3.1 不写入 Draft 的内容

- `maxOutputTokens` 不属于 ModelSelection，也不属于 Composer Draft。Agent 框架必须在每次模型请求时根据任务需要
  显式传入；选择 `optionSpecs.maxOutputTokens.max` 本身可以是合法的显式决策。
- Endpoint、API Schema、凭据、Properties 和 Option Specs 不进入 Draft；执行时由目标 Host Registry 解析。
- Active Model 不持久化。
- 不再持久化 `provider/model/thoughtLevel` 等 ModelSelection 的平铺别名。

### 3.2 附件边界

逻辑上的 Composer 状态仍包含附件，Submission 必须冻结本次附件；但当前附件包含不可安全跨重启恢复的
`File`、`objectUrl` 和本地路径所有权。本 Todo 不借机发明附件序列化协议：

- Composer 存活期间继续由当前内存附件状态持有；
- 提交时与 prompt、mode、ModelSelection 一起进入 Submission；
- 本轮持久化扩展只覆盖现有安全可序列化字段和 `mode/modelSelection`；
- 跨重启附件恢复留给独立设计，不得把失效 object URL 或未校验本地路径直接写入持久 Draft。

## 4. 初始化规则

初始化只在 Composer 创建、Workspace/Session scope 切换或恢复时执行一次。完成后，普通 React render 不再重新
合并 Session Snapshot 与各类默认值。

### 4.1 已有 Session

```text
当前 Session scope 的持久 Composer Draft
        |
        +-- 已有 Draft --> 恢复；失效选择按第 7 节留空
        |
        `-- 不存在 ------> 从 Session Selection + Session mode 初始化一次
                              |
                              v
                         立即写入 Draft
```

Session Selection 和 mode 在这里只是旧 Session 第一次建立 Composer Draft 的 seed。初始化完成后，即使 Agent
Snapshot 更新，也不能覆盖用户正在编辑的 Composer。

Todo 70 返回未绑定选择时，Draft 同样保留空模型或空 Reasoning，不再走默认模型初始化，也不弹提示。
旧 Draft 只有 text/editor 时，可以执行一次缺失字段初始化；但已经初始化、因失效而留空的 Draft 不属于旧 Draft，
不能在 remount、切页或重启后重新用 Session/Recent/preferred 填满。使用 Draft 中合法的 `mode` 区分是否已
完成初始化：初始化始终保存 mode，包括明确空模型的状态；旧文本草稿没有 mode。不要仅凭
`modelSelection === undefined` 判断是否需要初始化，不新增独立业务状态库或另一个初始化标志。

### 4.2 新 Session / 空白任务

```text
Root Draft（scope = __draft__）
        |
        +-- 已有 Draft --> 恢复；失效选择按第 7 节留空
        |
        `-- 不存在
              |
              +--> 当前 View 中仍合法的 workspace App Recent
              |
              `--> Host preferredSelection

mode：已有 Root Draft 优先；全新 Root Draft 读取当前 workspace 的 Composer Recent.mode，缺失或非法才使用 build
```

Host `preferredSelection` 已经包含 Configured Default 与 Registry fallback 的统一结果；Renderer 不复制这套
算法，也不根据 Provider、模型名称或 Account 类型自行推断。

上述 Recent/preferred 只用于真正首次创建且没有持久 Draft 的新任务，不能用于修复已有 Draft 的空选择。
用户主动选择新模型时仍按正常选模规则初始化档位；这不等于给失效的已保存 Reasoning 自动补值。

### 4.2.1 ZCT-2098314627607224320：新任务继承最近提交权限

修复原因：将 Root Draft 迁移到 Session 后删除来源是正确的任务隔离，但新 Root 固定 build 丢失了下一任务权限继承。
扩展现有 App Recent 为 Composer Recent，模型与模式并列保存；不修改共享 ModelSelection 类型、不恢复第二套全局 mode preference。
Recent 继续按 `workspaceIdentity?.trim() || workspacePath` 隔离，同路径不同远端不能串值。Desktop 与手机各自持有 Renderer Recent。

```text
用户选择 -> 当前 scope Draft（即时持久化）
用户提交 -> 冻结 modelSelection + mode -> CLI accepted -> 一次写入 Composer Recent
新任务 -> 已有 Root Draft 优先；没有时用 Recent 初始化一次 -> 当前 scope Draft
Snapshot / Recent 后续更新 -X-> 已初始化的 Draft
```

- 接纳含排队，不等待执行完成；执行后来失败也不撤销已接纳的选择。
- 未发送、rejected/failed、空会话预热、历史恢复、重复 ACK 不刷新 Recent。
- 同一 Renderer/workspace 按实际命令发起顺序记录候选；只有较新的已接纳命令能覆盖 Recent。迟到 ACK 不读取当前菜单、不覆盖用户的新草稿。
- 沿用现有 Recent key，读取兼容旧纯 ModelSelection 记录；modelSelection 与 mode 独立校验，坏模型不丢合法模式，坏模式不丢合法模型。
- Recent 写入失败只记录 UI logger 警告，不把已接纳发送报告成失败。现有草稿与历史 Session 不批量重写。
- 只改 App Composer 初始化与接纳后偏好保存。Desktop continuous 和手机 replayable 的既有可信 attachment、shared-host、owner、CommandInbox 与恢复协议不变。
- 回归必须真实点击 New Task；证明 toolbar、持久 Draft、后续工具执行权限一致，并保留 Session/Root 未发送意图隔离。

### 4.3 初始化后的约束

- 初始化结果立即进入同一个 Composer 内存态并持久化，不保留“只有 UI 显示、尚未进入 Draft”的半状态；
- mode 和 modelSelection 使用同一套状态读取原则；
- 不在每次 render、Snapshot 事件或提交时重新计算优先级；
- Prompt CLI、TUI、Automation、Repo Wiki、Subagent 和 Off-Peak 继续使用各自的 Draft/Config/Record，不复用
  App Composer Draft。

## 5. 用户修改与持久化

用户修改 mode 或 ModelSelection 时：

```text
点击菜单项
    |
    +--> 立即更新 Composer 内存态
    +--> 关闭下拉菜单
    `--> 持久化当前 scope 的完整 Draft
```

- UI 不等待 Host/Agent ack 才显示新值；
- mode 和 ModelSelection 是低频离散操作，修改后可立即持久化；文本仍可沿用现有防抖写入；
- 空文本不等于空 Composer。只要该 scope 已初始化并持有 mode 或 ModelSelection，普通持久化就必须保留记录；
  删除整个 scope 只能走显式清理接口，不能继续使用“text 和 editorStateJson 为空”作为删除条件；
- 持久化失败只记录一次可诊断日志，不把 UI 回滚成 Agent Snapshot；
- 同一 scope 内连续修改遵守 latest intent wins，旧异步结果不能覆盖新内存态；
- key 继续使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`，scope 使用 Session ID 或
  `__draft__`。

本 Todo 不引入跨窗口分布式锁或新的 Host Repository。当前 localStorage 载体可以继续使用；若后续需要同一
Session 多窗口协同编辑，应作为独立同步设计处理。

### 5.1 草稿容量

Composer Draft 不再按 scope 数量裁剪。模型选择属于长期用户状态，不能沿用临时文本草稿的固定上限而被静默删除；仅在用户显式清理 scope 或存储本身拒绝写入时移除。

## 6. 提交时序

### 6.1 创建 Submission

Submission 必须从同一时刻的 Composer 内存态一次性复制：

```text
Composer State
├─ prompt
├─ attachments
├─ mode
└─ modelSelection
        |
        v
一个不可变 Submission
```

禁止提交函数再从以下位置补字段：

- Agent Session Snapshot；
- Workspace `draftPreferred*`；
- 全局 mode localStorage；
- 提交前临时查询到的另一份模型状态。

### 6.2 Submission 被接纳

接纳成功后，只清除已经发送的内容，保留执行选择：

```text
提交前 Draft
├─ text = "请修复问题"
├─ attachments = [...]
├─ mode = build
└─ modelSelection = DeepSeek/high
        |
        v
Submission accepted
        |
        v
提交后 Draft
├─ text = ""
├─ attachments = []（仅内存）
├─ mode = build
└─ modelSelection = DeepSeek/high
```

- 已有 Session：在原 Session scope 保存清空内容后的 Draft；
- 新任务从 `__draft__` 建立真实 Session 时：把保留的 mode/ModelSelection 转移到新 Session scope，再删除旧
  Root scope；
- Composer Recent 在 App 接纳用户 Submission 后一次保存本次冻结的 modelSelection 与 mode，不由菜单点击、空 Session 预热或历史恢复更新；
- Agent Session execution state 在接纳/启动边界更新，不能提前于 Submission 成功。

接纳成功后的清理必须带本次提交的局部 revision/token，防止迟到结果清除用户在等待期间产生的新输入：

```text
Submission A 从 Composer revision R 创建
        |
        +--> 等待 Agent admission
        |
用户继续输入或切模，Composer 已推进到 R+1
        |
Submission A 接纳成功
        |
        `--> 只能清理仍属于 R 的已提交内容
             不得清理 R+1 的文本、附件、mode 或 ModelSelection
```

这只是单次提交操作的局部比较与清理条件，不建立 `LastSubmittedState`。无论是否发生并发修改，提交成功后
Composer 中保留的 mode/ModelSelection 都以当前最新内存态为准。

### 6.3 提交失败

- Submission 未被接纳时，恢复或保留提交前的文本、附件、mode 和 ModelSelection；
- 不允许只恢复 prompt 却丢失选择；
- 失败恢复不能被迟到的清理操作再次覆盖；
- 不创建 `LastSubmittedState`，提交前快照只作为这次异步操作的局部回滚材料。

Root scope 转移同样遵守 latest intent wins：先写入目标 Session scope，成功后才删除对应 Root scope；如果
接纳期间 Root Composer 已经产生更新，只移动本次已接纳内容对应的状态，不能用旧快照覆盖更新后的 Composer。

## 7. Registry 更新与选择失效

Registry revision 变化时，当前 Composer Draft 的 ModelSelection 必须使用新的 `ModelSelectionView` 校验。
校验只发生在 View 真正 Ready 且 revision 已推进时，不把 loading/error/unavailable 当作选择失效。

```text
Persisted / In-memory ModelSelection
                +
Ready ModelSelectionView(revision N)
                |
                v
          按层级校验 Selection
          |
          +-- 全部有效
          |      `--> 原样保留
          |
          +-- Provider 或 Model 失效
          |      +--> 整份 Selection 置空
          |      +--> 不使用 Host preferredSelection，不弹提示
          |      `--> 用户完成选择前禁止提交
          |
          `-- Provider / Model 有效，Reasoning 缺失或失效
                 +--> 保留 providerId/modelId
                 +--> 只清空 reasoningLevel
                 +--> 不自动补档位，不弹提示
                 `--> 用户完成选择前禁止提交
```

以下情况复用同一个 validator，但必须区分失效层级：

- Provider 不存在或不可选择、Model 不存在或不可选择：模型身份已经失效，整份 Selection 作废；
- 已保存 reasoning 不再属于当前模型的有序 `values`，或缺少提交契约要求的 reasoning：模型身份仍然有效，
  只清空 `reasoningLevel`。

处理要求：

- Provider/Model 失效后保持空选择，不使用 Recent、Configured Default 或 Host preferred 自动替换；
- Reasoning 失效时不得自动补成最高、最低或 Configured Default，也不得改动仍然有效的 Provider/Model；
- 空模型或空 Reasoning 仅由控件空态和不可提交状态表达，不弹 Toast、弹窗或额外失效横幅；删除对应通知及去重逻辑；
- 清空后的状态立即更新内存态并持久化，后续 render、revision、切页和重启不能自动填满；
- 全新草稿从未有过选择且没有持久 Draft 时走正常初始化。

现有 `ModelSelection` 持久结构允许 `reasoningLevel` 暂时缺失，因此这里不新增
`PartialModelSelection`、`ComposerModelChoice` 或其他中间 DTO。这个未完成状态只能存在于 Composer Draft
和历史恢复边界；创建 Submission 时必须先通过完整性校验，ModelFactory 仍只接收完整、可执行的 Selection。

Todo 70 处理的是恢复历史 Session 时旧 Selection 的迁移/未绑定状态；本节处理的是已经正常打开的 Composer
在 Registry 更新后的选择。两者统一为留空、不自动替换、不弹提示，不再保留按场景区分的失效 fallback。
取消的是选择留空的通知，不是实际请求失败、提交失败或持久化故障的正常错误反馈。

## 8. Queue、Guide 与执行边界

本 Todo 不修改 Queue 与 Guide 的产品语义，只固定它们共同依赖的 Submission 边界：

- Queue item 保存入队时完整 Submission；出队时不回读 Composer 或最新 Session Selection；
- 点击“立即”仍使用该 Queue item 自己的 Submission；
- Guide 被当前 Loop 接纳后，按既有原子边界更新 Session execution state，并从合法 model-step 使用新 Active
  Model；
- Registry 在排队后变化、导致 Queue item 的 Selection 无法执行时，明确失败并保留输入，不静默路由到另一个
  Provider/Model/Reasoning；
- Desktop `continuous` 与 Mobile `replayable` 只传递同一份已提交 Submission，不各自推导默认值，也不在
  Renderer 建立第二份 accepted-input queue。

排队与“立即引导”的更大产品语义此前已决定暂缓，本 Todo 不借状态收口修改 `sendQueuedNow` 或默认立即行为。

## 9. 现有实现清理

### 9.1 合并 Composer 状态

- 扩展 `composerDraftStore.ts`，让读取、保存、清理和 scope 转移保留 mode/ModelSelection；
- `ConversationComposer`、`SessionPane`、Toolbar 和 mode/model 控件统一读取 Composer 内存态；
- 提交成功从“删除整个 Draft”改为“清除已提交内容、保留 mode/ModelSelection”；
- Root Draft 建立 Session 时增加明确的 scope 转移测试。

### 9.2 删除第二事实源

在证明无其他产品消费者后删除或收窄：

- `draftPreferredModel`；
- `draftPreferredMode`；
- `draftPreferredThoughtLevel`；
- Renderer 全局 `draftModePreference` 对当前 Composer 的持续 fallback；
- `resolveCurrentComposerSubmission()` 中 Snapshot + Draft + Initial Config 的动态拼接；
- Toolbar 从 `snapshot.config` 读取当前 mode/model 的逻辑；
- 以 Agent config CAS 作为 mode/model 菜单点击确认的路径。

删除前需用引用审计逐个确认。若 `draftPreferred*` 仍服务非 Composer 产品，先拆清消费者，不得机械删掉共享状态。

### 9.3 保留但重新定界

- Session Selection：保留，表示 Agent 后续执行的持久模型意图；不直接渲染 Composer；
- Session mode/runtime config：保留，服务权限、工具行为、恢复和协议执行；只在 Composer 首次缺少 Draft 时提供
  一次初始化 seed；
- Prewarm：可以继续接收当前完整 Composer 配置用于启动性能和 readiness，但它不是 UI 事实源，第一次正式
  Submission 仍必须原子携带 mode/ModelSelection；
- `followupMode` 等不属于本次 Composer model/mode 收口的设置不机械删除。

## 10. 命名收口

命名必须体现状态所有权：

- `draftConfig` 改为 `composerState` 或 `composerDraftState`；
- `resolveCurrentComposerSubmission` 改为表达“从 Composer 快照构造 Submission”的名称，例如
  `createSubmissionFromComposer`；
- Agent 侧 `getModelSelection()` 若实际读取 Session 后续选择，按 Todo 68 改为
  `getSessionModelSelection()`；
- 禁止继续使用 `currentModel`、`currentMode` 指代既可能是 Composer 又可能是 Agent Runtime 的含混值。

具体命名以实现时真实职责为准，不为改名新增包装层或兼容 alias。

## 11. 跨层影响面

| 层级 | 本 Todo 的改动 | 不允许发生的事 |
| --- | --- | --- |
| UI / Composer | 完整内存态、菜单交互、选择空态 | 每次 render 回读 Session Snapshot |
| Draft persistence | 持久化 text/editor/mode/ModelSelection | 持久化 Active Model、凭据或 Option Specs |
| Submission | 一次复制完整 Composer 状态 | 提交后再从 Session 补 mode/model |
| App Recent | 接纳后保存最近 Submission 的 Selection + mode | 菜单点击即更新 Recent |
| Agent Session | 接纳后记录执行状态 | 作为 Renderer Composer 的实时 store |
| Registry | 提供 Ready View、preferred 和 Selection 校验 | Renderer 复制 fallback 算法 |
| Queue / Guide | 保留冻结的 Submission | 执行时回读 Composer |
| Remote | 透传相同 Submission 与 workspace identity | Relay/Main 持有 Composer 业务状态 |

Automation、Repo Wiki、Subagent、Off-Peak、Bot、Prompt CLI 和 TUI 不迁入 App Composer Draft。本轮只验证它们
没有被共享 helper 的清理误伤。

## 12. 测试先行计划

### 12.1 Draft Store 单测

- mode 和完整 ModelSelection JSON round-trip；
- `workspaceIdentity` 优先于 `workspacePath` 隔离；
- Session scope 与 `__draft__` 不串数据；
- 只有 mode/ModelSelection、文本为空时仍保留 Draft；
- 清除已提交内容不会清除 mode/ModelSelection；
- Root scope 向新 Session scope 转移后不残留两份；
- 旧版本只有 text/editor 的 Draft 可以读取并完成一次初始化；
- 保存 51 个 scope 不淘汰；500 个正常保留；第 501 个按更新时间淘汰最旧 scope，保留新写入项；
- 仅有 mode/modelSelection 或留空选择的记录，在容量以内正常 round-trip，不因空文本被删除。

### 12.2 Composer 组件测试

- 已有 Session 点击 mode 后立即显示新值并关闭菜单；Snapshot 重渲染不能覆盖；
- 切换 Model/Reasoning 后 UI、Draft 和最终 Submission 三者一致；
- App 重启/组件 remount 后恢复同一 mode/ModelSelection；
- Submission 成功清空文本但保留 mode/ModelSelection；
- Submission 失败恢复完整提交前状态；
- 中文输入、附件和既有发送交互不回归。

### 12.3 Registry 失效测试

- Provider 或 Model 失效时整份 Selection 留空；即使 View 有 `preferredSelection` 也不自动替换；
- 旧会话未绑定、已有 Draft 失效、重启恢复空 Draft 均保持留空；真正首次新任务初始化仍可使用 preferred；
- Reasoning 缺失或失效时保留 Provider/Model，只清空 Reasoning，Renderer 不自动选择最高或最低档位；
- Reasoning 未重新选择前禁止提交，选择完成后构造完整 Submission；
- 空模型或所需 Reasoning 未选时禁止提交；
- 清空模型/Reasoning 不弹失效提示，重复 revision/remount 也不弹；
- loading/error/LKG 切换不误报失效；
- 留空状态被持久化，重启后既不恢复旧失效值，也不自动补默认值。

### 12.4 Submission / Queue / Agent 集成测试

- Submission 原子携带 prompt、attachments、mode、ModelSelection；
- 提交后修改 Composer 不改变已经入队的 Submission；
- Queue 出队和点击“立即”不回读 Composer/Session 当前值；
- Agent admission 后 Session 状态与 Submission 一致；
- Todo 68 的 Active Model 由该 Submission Selection 创建，Context/Tools/Request 不滞后一拍；
- 排队 Selection 后续失效时明确失败并保留输入。

### 12.5 App E2E / MacBook Pro 实机

至少验证：

1. 已有对话从“完全访问”切到“自动编辑”，菜单立即关闭且显示正确；
2. 不发送消息，切换任务再回来，选择仍保留；
3. 重启 App 后选择仍保留；
4. 发送成功后文本清空，但 mode、Provider/Model 和 reasoning 不跳回旧值；
5. 连续切换同 modelId 的不同 Provider，第一条请求使用当前 Composer Selection；
6. Registry 更新使 Provider/Model 失效时模型留空；Reasoning 单独失效时保留 Provider/Model、只清空档位；
   两者均不弹提示，重启后继续留空，用户重新选择后可发送；
7. Desktop continuous 与 Mobile remote replayable 均收到相同 Submission 配置。

涉及 UI 交互，必须新增或更新 Desktop E2E case；按用户最新要求在 MacBook Pro 验证。新增用例先按流程进入
pending，不能因为自动化通过就声称已人工转正。

## 13. 文档同步

实现时同步修订：

- `design/interaction/selection-state.md`：提交成功只清除内容，保留 Composer 执行选择；澄清附件持久化边界；
- `design/interaction/interaction.md`：Session 状态只在 Draft 缺失时参与一次初始化；
- `design/interaction/submission-delivery.md`：Submission 从完整 Composer 快照创建；
- Conversation Protocol / Product State Space / Case Catalog：更新 Composer state owner、成功清理和 Queue 冻结案例；
- Feature Graph：删除 Renderer 从 Session Snapshot 持续投影 mode/model 的旧边；
- Todo 68：只保留 Agent 内 Active Model/Context 事实，不承担 Composer 持久化；
- Todo 70：复用同一个 Selection validator，统一留空、不自动替换、不弹提示，删除历史恢复/活跃 Draft 的策略分叉。

当前 Case Catalog 中 I50/I51/I52 若仍把 model/mode 菜单操作描述为 Agent config CAS，需要按新状态所有权重新审查：
保留“即时 UI 意图、latest intent wins、首次 Submission readiness barrier”等产品事实，删除“Agent Snapshot 是 Composer
确认源”的旧实现假设。

## 14. 不属于本 Todo

- 不修改 Queue 与 Guide/立即的产品语义；
- 不处理 `outputStyle` 在同一 Turn 内的历史一致性问题；
- 不设计附件跨重启序列化；
- 不改变 Provider Config、Account Overlay、Registry 或 ModelFactory 的领域结构；
- 不改变 Automation、Repo Wiki、Subagent、Off-Peak 的选择继承规则；
- 不增加新的超时、轮询或 Session/Renderer 双向同步协议；
- 不把 Composer 状态下沉到 Desktop Main、Relay 或 Remote Host。

## 15. 完成标准

- Composer 的 text/editor/mode/ModelSelection 由一份内存态和一份对应持久 Draft 表达；
- 已有 Session 的 Agent Snapshot 只能初始化一次，不能覆盖存活 Composer；
- mode/model 菜单点击立即生效、关闭菜单，并能在切页和重启后恢复；
- Submission 原子冻结 Composer 状态，成功后只清除已发送内容，失败时完整恢复；
- Registry 失效走统一 validator；Provider/Model 失效留空，Reasoning 失效只清空档位并保留模型身份；
  不自动替换、不弹提示，留空状态在重启后保持；
- Queue、Guide、Desktop continuous、Mobile replayable 不回读 Composer 或创建第二份选择事实；
- `draftPreferred*`、动态 Snapshot merge 和旧 mode preference 等冗余路径完成引用审计并尽量删除；
- Todo 68/70 与设计文档同步，不留下互相矛盾的状态所有权描述；
- 相关单测、Bootstrap 集成测试、Desktop E2E、`pnpm typecheck`、`pnpm lint`、格式检查和
  `git diff --check` 全部通过；
- 在 MacBook Pro 复现原问题并取得修复后的运行时证据。

## 16. 实施记录

待执行后补充。

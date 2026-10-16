# Registry 运行边界

Provider Registry 在一个进程中维护所属 Environment 的 Provider View。调用方可以随时读取一致的当前
视图；ZCode Built-in、Account Built-in 或 Personal Provider Config 变化后，Registry 发布新视图，已经创建的
Model 保持不变。

```text
Config / Account Sources
          |
          | change
          v
       Registry
       ├─ rebuild View
       ├─ replace indexes
       └─ notify consumers
          |
          v
新的查询与 Model 创建使用新 View
旧 Model 继续使用创建时的配置
```

## Registry View

Registry View 是有序 Provider 集合：

```ts
interface Provider {
  config: RegistryProviderConfig;
  models: readonly {
    modelId: ModelId;
    config: RegistryModelConfig;
  }[];
}
```

这是可执行 Registry View，只包含完整且 enabled 的模型，包括 hidden Provider 下的模型和与 Personal 重名时继续
生效的 Built-in Model。disabled 和 incomplete 成员留在 Settings Resolution；重复成员在 Inventory 阶段按
“保留第一次、Built-in-wins”确定化，不把 optional Config 或 `status` 混入 Registry。完整类型的序列化返回值也必须
保持完整，不能把稀疏基类的 optional 字段重新暴露给协议消费者。

设置和模型选择按数组顺序展示。Registry 同时建立轻量查询索引：

```text
Provider[]
├─ 对外有序 View
└─ providerById
   └─ modelById
      ├─ lookup
      └─ validate selection
```

索引引用 View 中的 `RegistryProviderConfig` 和 `RegistryModelConfig`，不复制一套新的配置事实。Registry
不把 HTTP Client、连接池、动态凭据或 Provider SDK 运行状态放进 View。

ModelFactory 创建 Active Model 时，将 Effective Model Config 的完整 `properties` 原样冻结到
`Model.properties`。Core、Compact、Memory、Child Agent 与 Adapter 直接读取其中的
`input_format` / `output_format`；Runtime Config、Turn 和 Adapter Registry 不维护并行 capability map。
异步边界无法传递 Active Model 时，只能传递同结构的不可变 Properties 快照。详见
[`../model/input-output-format.md`](../model/input-output-format.md)。

Registry 不创建 Model。ModelFactory 先用 Registry 完成 lookup/validate，再把完整 Provider/Model Config
作为私有输入交给 Adapter 创建 Active Model；公共 Model 不暴露这两份 Registry Config。

## 执行步骤中的 Active Model

`ModelSelection` 只表达 Session 或 Submission 对“下一次创建哪个 Model”的选择意图。它可以持久化，
但不能用来反推一个已经开始执行的模型步骤。每个模型步骤由 ModelFactory 创建一个不可变 Active Model，
并把同一个 Model 传给该步骤的所有执行消费者：

```text
Session / Submission ModelSelection
                 |
                 v
             ModelFactory
                 |
                 v
        immutable Active Model
          |        |        |
          v        v        v
       Context    Tools    Adapter request
```

Context Source 只保存工作目录、平台、Shell、Git、Instructions 等环境事实，不保存执行模型快照。
Context 中的模型说明、模型相关工具投影和请求 Options 必须在模型步骤开始时从该 Active Model 生成；
Builder 直接接收该 Model，不再经过 `envInfo.currentModel` 字段；
Core 不维护把 Session Selection 复制到 Context 再反复刷新的同步机制。

- 普通 Submission 在 admission 时先创建 Active Model，再用它初始化 Context、运行 SessionStart Hook 和发起请求；
- execution-scoped Off-Peak 使用自己的 Active Model，但不改写 Session Selection；
- Guide 在合法的下一个 model-step 边界创建新 Model，并用它同时替换请求 Context 与后续请求；
- Subagent 继承父模型时，child Selection、Context 和 ModelFactory 都从实际传入的父 Active Model 派生；
- 活动步骤中发生的 Session Selection 或 Registry 变化只影响后来创建的 Model，不能污染当前步骤。

详见 [`../../steps/todo-68-active-model-context-single-source.md`](../../steps/todo-68-active-model-context-single-source.md)。

## 发布新 View

ZCode Built-in、Account 或 Personal ProviderConfigMap 变化后，Registry 重新执行 Provider 与 Model
两轮解析：

```text
旧 View v1
      |
Source change
      |
      v
构造并校验 View v2
      |
      v
一次性替换 View 与索引
      |
      v
onDidChange(revision)
```

消费者在任意时刻只观察到一份完整 View。构建中的中间状态不对外发布。已有 Model 引用创建时的 ProviderConfig、ModelConfig 和 Options，因此 View 替换不会静默改变活动 Agent Loop。

单个 Source 读取、解析或刷新失败时，Registry 保留上一份成功的完整 View，并报告具体 Source 与错误；它不会发布缺少该 Source 的部分 View。Source 成功返回删除、禁用、空 Config Map 或账号失效时，这些属于确定的新事实，仍应正常构建并发布。

首次启动采用分层恢复，而不是把所有输入都当成同等的 ready barrier：

```text
Bundled 无效 ------------------------------> 启动失败
Active/LKG 无效或不可写 --------------------> 丢弃/绕过，使用 Bundled
Personal 无效 ------------------------------> 保留恢复备份，使用空 Personal Overlay
Account 首次解析失败 ------------------------> 账号 Provider access.entitled=false
Configured Default 无效 --------------------> 丢弃偏好，使用 Registry fallback
Resolver/Registry 内部完整性不变量被破坏 ----> 启动失败
```

因此，只有无法建立可信 Built-in 基线或代码内部完整性证明失败时，Provider Runtime 才能阻断启动。可丢弃缓存、
用户偏好、Personal Overlay 或动态 Account 事实的局部失败必须降级并报告，不能放大为整个应用或 Agent 不可用。

## 查询与变化通知

长期存活的消费者采用“读取、订阅失效、重新读取”：

```text
消费者启动
    |
    +--> registry.list...() 读取 View v1
    |
    `--> registry.onDidChange
                    |
                    v
              重新读取 View v2
```

变化通知说明旧 View 已失效。完整数据仍由查询接口提供，避免事件 payload 和查询结果形成两份权威来源。事件可以包含 revision、原因或受影响范围；最终粒度在实现阶段根据设置页和模型选择器的刷新需求确定。

## 每个进程拥有自己的实例

同一个 Environment 中，需要 Provider 能力的进程各自持有 Registry 实例：

```text
同一 Environment 的 Provider Facts
               |
       +-------+--------+
       |                |
       v                v
 Host Registry     Worker Registry
       |                |
       v                v
 设置、模型选择       创建 Model、执行

Prompt CLI / TUI
└─ 在自己的进程内使用同一 Registry 实现
```

Registry 对象和内存 View 不跨进程共享；Config、Account 和 Registry 领域实现共享。Host 选择模型时读取自己的 Registry，Submission 只携带 ModelSelection；Core Worker 使用自己所属 Environment 的 Registry 创建执行 Model。

每个进程的装配对象称为 `ProviderRuntime`。它不增加新的事实或状态模型，只把本进程所需的组件连接起来：

```text
ProviderRuntime
├─ ProviderConfigRuntime
│  ├─ ZCode Built-in Config Source
│  └─ Personal Config Repository
├─ injected Account Built-in Config Source
├─ ProviderRegistryService
├─ ProviderSettingsFacade
└─ ModelSelectionFacade
```

Account Built-in Config Source 由 Entry 注入。尚不提供 Account Provider 的 Entry 可以使用空 Source，普通 API
Provider 仍能完整运行；需要 Account 进一步约束的 Built-in Provider 由初始 fail-closed Overlay 设为
`access.entitled=false`。这个缺省只表达当前 Entry 没有账号权益，不回退到旧 Snapshot。

文件读取、原子写入、文件锁、Built-in watcher 与 Personal revision polling 属于 Node.js 运行环境，不进入纯领域包。
它们集中在 `@zcode/provider-node`：

```text
@zcode/provider
└─ Config / Resolver / Registry / Facade

@zcode/provider-node
├─ ZCode Built-in file source
├─ Personal file repository
├─ Config runtime
└─ process registry runtime
```

Entry 负责定位物理文件并显式注入路径；`@zcode/provider-node` 不假设 Desktop、Worker、CLI 或 TUI 的安装目录。Host 与 Worker 各自读取同一 Environment 的文件，Registry 对象和 View 不跨进程传输。

ZCode Built-in 的远端同步由 Environment 组合根拥有。Local Host、Remote Host、Standalone Server 和没有
Host 的 Prompt CLI/TUI 各自为所属 Environment 建立一个同步 owner；普通 Core Worker 只读、监听 Host
注入的同一个 `active.json`，不独立请求 `/client/configs`：

```text
Bundled Release ──┐
Active/LKG ───────┼─> 选择 max revision ─> active.json ─> Host Registry
Remote Release ───┘                              └──────> Worker Registry
```

本地有效候选先完成 ready，远端刷新随后在后台执行。多个进程通过 Active 旁的
`refresh-control.json`、文件锁和短期 lease 合并请求；Active 与刷新控制按规范化 ZCode 控制面 Endpoint
物理隔离，成功使用一小时量级 TTL，失败递增退避，Endpoint
变化不继承旧 TTL。显式刷新可以越过 TTL，但不能越过仍有效的 lease。远端仅接受
`/api/v1/client/configs.data.configs.zcodeBuiltin`，解析成功且 revision 更高时先原子替换 Active，再由现有
Source change 链触发 Account 与 Registry 刷新。请求期间 Endpoint 已变化的旧响应，以及 dispose 后到达的
响应，都不能写盘或发布。

Registry 更新仍只影响后来创建的 Model；已经创建的 Active Model 保持创建时冻结事实。其他 Client Config
消费者、Session、队列、Continuous/Replayable 和远程 Provisioning 不属于这条同步链。

Prompt CLI 的一次执行只有一个 App，因此 Registry 与该 Entry 同生共死。TUI 可以在 `/new`、resume 和 fork 时替换 App；这些 App 都借用同一份进程 Registry，避免每次切换 Session 都重新创建文件观察循环。关闭某个 App 不释放 Registry，TUI Entry 终止时才统一释放。

Host 通过两个独立频道暴露 Facade：`provider-settings` 负责 Personal Config 的查看与修改，`model-selection` 负责候选模型 View 与 Selection 校验。频道只传普通可序列化对象；Config Class、Source 和 Registry 实例留在 Host 进程。

Selection 校验覆盖完整的通用选择语义：Provider 与 Model 必须存在；显式
`reasoningLevel` 必须属于模型的 Option Spec；显式 `maxOutputTokens` 必须是正整数且不超过
模型声明的上限。校验只报告错误，不修改或截断调用方提交的值。Configured Default 与 Facade
调用复用同一套 Option 校验，避免初始化、设置页和执行入口产生不同结论。

`ProviderRuntime` 的启动是两个 Facade 的共享 ready barrier。Host 可以先注册 RPC 频道再异步启动 Runtime，但 `getView`、预览、写入和 Selection 校验都必须等待首次 Config / Account Source 解析完成。多个并发调用共用同一条 Registry 启动链路，不由 Renderer 重试“尚未 start”这种内部初始化状态。

Host 的组合根先创建 Config Runtime，再用它的 Config Service 创建 Account Provider Service，最后把 Config
Service 与 Account Source 一起装配进 Registry。`ProviderRuntime` 接受已经创建的 Config Runtime，不在
内部隐藏第二次构造。Account Source 只以 ZCode Built-in Provider Config 为账号 Provider 的静态边界，再
根据账号事实形成约束；它不读取或吸收 Personal Provider Config，Personal 始终在 Account 之后覆盖。

```text
ProviderConfigRuntime
└─ ProviderConfigService ─────┬──────────────> ProviderRegistry
                              │                         ^
                              v                         │
                 AccountProviderService                │
                 └─ Account Built-in ProviderConfigMap ─┘
```

Client 为这两个频道建立独立代理，共享 `IServiceAccessor` 将二者声明为必备能力。Local Host、Remote
Workspace Service Collection 与 Web home-only 组合根都必须提供明确实现；Web home-only 使用空 View
服务表达“当前没有 attached Environment”，不使用 `undefined` 充当能力协商。跨版本远端若需要能力
判断，应使用显式协议能力。

历史实现曾由 Host 向 Worker 推送完整 Registry Snapshot，再由 Worker 维护 Workspace Catalog。
M2 已经让正式 Entry 与内部 Harness 退出这条事实链路，并强制装配 Process Registry。旧实现的订阅与
跨进程刷新事实保存在
[`../../research/m2-registry-aggregation-and-refresh.md`](../../research/m2-registry-aggregation-and-refresh.md)。

Account Built-in Provider Config 使用独立的进程级同步边界。Host 和 Worker 各自持有 Registry；Host
只把账号状态形成的 Account Built-in Config Source 传给 Worker，不传整份 Registry View：

```text
Host Account Built-in Provider Source
        |
        | revision + ProviderConfigMap JSON
        v
provider/updateAccountConfig
        |
        v
Worker Account Built-in Provider Source
        |
        v
Worker Registry
```

这条协议只连接同一个 Environment 内的 Host 与 Worker。Desktop Local Host 和
desktop-attached Remote Host 属于两个 Environment，不能通过该协议共享 Account Built-in Config。
Remote Host 必须从自己的 Config、Credential 与 Account Source 产生 Account Built-in Provider Config，再同步给
它管理的 Remote Worker。

```text
Desktop Environment                  Remote Environment
Local Host -> Local Worker           Remote Host -> Remote Worker
     account config                       account config

两个 Environment 之间的 Provisioning Sync
└─ 只写 Remote Config / Credential Store
   不直接调用 provider/updateAccountConfig
```

上图只定义 Environment 所有权边界。远程 Provisioning、远程设置操作、登录和配置同步是独立产品能力，
不属于 Provider Refactor 或 M4 的实施范围。

消息中的 Provider Config 是普通可序列化对象，到达 Worker 后由 `@zcode/provider` 的同一
Schema 校验解析。Account Source 只接受 `builtinModelIds`，并只允许对固定 `zhipu-account` Access 覆盖
`entitled`；Provider 顶层 `enabled`、Access 身份、API Key、Secret 和请求期鉴权材料不能通过该入口进入
Registry。相同 revision 不重复发布，新进程在开始
模型执行前必须先取得当前 Account Built-in Config。

Off-Peak Provider 的动态凭据只在 Model request attempt 上注入，不属于 Account Built-in Config 同步。缺少
Request Auth 时，Model 在发出网络请求前返回明确的缺凭据错误；Registry 不为它保存临时 Secret。

Host 内的 `AccountProviderService` 同时是 Registry 的 Account Source。它读取 Config Service 当前的
ZCode Built-in Provider Config，把账号、套餐和团队连接解析为 Account Built-in Provider Config。Account 的职责是
对 Built-in 中与账号相关的 Provider 做进一步约束，不参与 Personal Overlay。远端请求通过注入的 Account
Resolver 完成，`@zcode/provider` 中的 Service 本身不依赖网络、文件系统或 OAuth 实现。

Account Source 每次发布都记录 `basedOnZCodeBuiltinRevision`。Registry 收到 Built-in change 时，在对应
Account 刷新完成前继续保留上一份完整 Registry，不能发布新 Built-in 与旧 Account 的组合；即使 Overlay
内容未变，来源 revision 变化也必须形成新 Account Snapshot。Personal change 不触发这道等待。

```text
ZCode Built-in Provider Config
          |
          | Account Resolver 施加账号约束
          v
Account Built-in ProviderConfigMap
```

首次 `read()` 是账号事实的首次解析尝试；后续 Config 变化或账号事件调用 `refresh()`。刷新成功后原子替换
Account Snapshot 并通知 Registry。刷新失败时保留上一份成功 Snapshot，并通过错误事件报告；首次刷新尚无
成功 Snapshot 时，基于同一份 ZCode Built-in revision 发布显式 `access.entitled=false` 的 fail-closed Account Overlay，
让普通 API Provider 与 Personal Provider 继续启动。该降级不伪造账号可用性、模型成员或 Access，后续刷新成功
后再原子替换。

## Source 刷新边界

Registry 只接收 Source 已变化的统一信号：

```text
设置保存 ───────────────┐
外部配置变化 ────────────┤
ZCode Built-in Config 更新 ┼─> Source invalidate ─> Registry rebuild
Account Built-in Config 更新 ─┘
```

Services 侧的 Account Connection Resolver 负责把现有产品状态翻译成领域层的
Connection Result。它读取当前账号域、每个 Provider Family 的连接模式、已选择的
Individual/Team 连接、当前账号身份以及权益查询结果；成功时输出完整的 Provider 结果集合，其中可用
Provider 携带可用状态和可选模型集合。
原始 Settings 选择状态不进入 Provider Config；非当前账号域时，账号 Provider 的 `entitled` 仍由账号产品事实独立解析；网络或远端服务失败时整轮解析失败，由
Account Provider Service 保留整份上一版成功 Snapshot，不发布部分结果。

```text
Account Settings + Credential Port + Plan API
                    |
                    v
      Account Connection Resolver
                    |
                    | status + models?
                    v
        AccountProviderService
                    |
                    v
        Account Built-in ProviderConfigMap
```

Individual、Team、Start 分别对应固定类型的独立 Built-in Provider，并由 Built-in Access 的 `mode` 与
`family` 明确表达。Resolver 只投影 `access.entitled` 和 Start 账号模型成员；账号身份、Team scope、Token、Runtime
Key 与 Header 留在 Account Connection/Request Auth。模型成员没有专属远端结果时由领域解析器沿用当前 Built-in Config 的顺序；能够从
权益接口取得权威模型集合时，应随 Connection Result 一起提供。

本地 Host 的生产组合根直接创建 `AccountProviderService`。Config 变化由 Service 自己
订阅；账号连接设置与账号事实分别通过窄事件触发同一条 `refresh()` 链路：

```text
ObservableSettingService.onDidUpdate
└─ providerFamilyDomain / providerFamilyConnectionSelections / endpoint origin
                                                        │
ModelProviderServiceRuntime.onDidInvalidateAccountFacts │
└─ 登录预置、套餐入口、Coding Plan Key 与可用性变化 ─────┤
                                                        v
                                      AccountProviderService.refresh()
```

普通 Provider 保存、删除与 runtime header 更新不会触发账号刷新。旧
`onDidChangeProviderRegistry` 不再承担本地 Account invalidation；刷新内容始终由
Connection Resolver 根据 Config、账号设置、凭据端口和权益接口重新计算。

`desktop-attached-remote` 的历史 Snapshot 兼容链路已经退出生产路径。生产 Entry 必须装配
Process Registry；缺失 Registry 是组合根错误，不再通过旧协议类型或运行时 fallback 恢复。
Remote Environment 的 Provider 数据所有权始终位于远端自身。

文件 watcher、Personal revision polling、mtime、远端 Plan 接口、缓存和并发去重属于各 Source 或配置 Service 的实现。Registry 调用方不感知这些机制。

当前实现已经采用主动通知、Source 文件观察与 revision 去重：设置写入等待 Repository 完成，再以 Registry `refresh()`
作为提交屏障；Personal Repository 的其他进程变化由低频异步 revision polling 自愈，同一 revision 不重复发布 View。
连接测试在查找 Provider/Model 前显式刷新当前 Worker Registry，因此不等待下一轮轮询，也不从 Host Snapshot 旁路创建
Model。普通查询调用方不负责手工检查 mtime。

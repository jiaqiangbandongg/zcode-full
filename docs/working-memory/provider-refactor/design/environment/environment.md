# Provider 所处的 Environment 蓝图

> 本篇是理解 Provider 所有权、部署方式和长期边界的心智模型，不是当前实现说明，也不是本轮 Provider 重构需要一次完成的施工范围。

Provider 设计需要同时适用于本机、SSH 和未来 Cloud Environment。这里用逻辑角色描述各部分职责；角色可以进程内运行，也可以由 Host、Worker 或远端服务承载。

## 逻辑角色

```text
Entry
├─ Desktop App
├─ Prompt CLI
├─ TUI
└─ Web / Remote Client
        |
        v
Environment
├─ Provider Config 与账号事实
├─ Provider Registry
├─ Session 与 Agent 执行
├─ Workspace 文件、命令和 Git 能力
└─ Environment 持久数据
        |
        v
Model Provider
```

Entry 表达用户操作。Environment 拥有实际配置和执行事实。跨进程或跨网络时，Environment API 负责传输一部分对外能力；Environment 内部的 Agent、Registry 与文件等 Service 通过进程内接口或依赖注入协作。

Environment API 是部署边界，不要求所有 Service 变成独立 Server。

## Provider 所有权

执行 Agent 的 Environment 拥有 Provider Config、账号事实和 Registry：

```text
Local Environment
└─ Local Provider facts / Registry

SSH Environment
└─ Remote Provider facts / Registry

Cloud Environment
└─ Cloud Provider facts / Registry
```

Desktop、Prompt CLI、TUI 或 Web 只是不同 Entry。它们通过目标 Environment 查看、选择和执行模型。SSH Environment 最终使用远端自己的 Provider facts；本地 App 不应成为远端 Provider 配置的永久事实来源。

## Provider 领域边界

Provider 领域接收以下输入：

```text
ZCode Built-in Provider Config
Account Built-in Provider Config
Personal Provider Config
ZCode Built-in Model Config Rules
Personal Model Config Rules
ModelSelection
请求时鉴权 Service
Provider Adapter dependencies
```

它对外提供：

```text
Provider Registry View
Model selection / settings facades
Model creation
Model request execution
Usage / Trace identity
```

Provider 领域不感知配置来自 JSON、数据库、Host 内存、RPC 还是远端管理服务。Renderer、React、Electron、Session Runtime 和具体持久化实现也不成为 Provider 核心模块的依赖。

## 进程内复用

`zcode-cli` 是物理包和可执行文件，包含三种 Entry/运行角色以及共同的 Core：

```text
zcode-cli package / executable
│
├─ Shared Core
│  └─ Agent、Submission、Registry、Model、Adapter
│
├─ Core Worker
│  └─ 将 Shared Core 包装成 stdio 协议进程
│
├─ Prompt CLI
│  └─ 在当前进程调用 Shared Core
│
└─ TUI
   └─ 在当前进程调用 Shared Core
```

Prompt CLI、TUI 和 Core Worker 复用同一 Provider 领域实现。Prompt CLI 与 TUI 可以在当前进程装配本地文件、命令、网络和 Session Store；它们无需为了调用 Core 再启动 Server。

窗口管理、远程 Workspace、运营同步和原生平台集成由 Host 或专门的 Environment 服务承担，不需要在 CLI/TUI 内复制。

## Desktop 的当前映射

下面只说明当前 Desktop 进程如何承载上述逻辑角色：

```text
Renderer
    |
    | MessagePort / Service RPC
    v
Local Host
├─ Provider 设置与账号外围能力
├─ Workspace / Worker 生命周期
├─ 闲时任务调度
└─ Remote connection
    |
    | stdio Agent Protocol
    v
Core Worker
├─ Shared Core
├─ Agent Loop
├─ Model / Adapter
└─ Session execution
```

当前 App 为 Workspace 管理 Core Worker，以隔离 Worker 崩溃对其他 Workspace 和 Host 的影响。这是部署与
稳定性策略，不定义 Provider 领域必须按 Workspace 复制实现。

Host 和 Worker 使用同一 Provider 领域实现，根据所属 Environment 的 facts 各自构造 Registry。完整 Registry
Snapshot 已退出正式事实链；M4 也已删除闲时任务曾使用的 `turnRuntimeModel` / Runtime Overlay。Host 只随
单次派发提供标准 Selection 和动态 Request Auth，不再下发 Provider/Model 静态快照。

## SSH 与 Cloud 部署

```text
Desktop / Web Entry
        |
        | SSH / HTTP
        v
Remote Host Server
        |
        | local protocol / stdio / in-process
        v
Remote Core Worker
        |
        v
Shared Core
```

Remote Host Server 暴露跨网络能力，负责连接、鉴权和 Worker 生命周期。Remote Core Worker 仍然使用与本机相同的 Registry、ModelFactory、Model 和 Adapter 接口。

文件和命令等高频能力可以与 Agent 部署在同一机房的不同服务集群；是否跨进程由部署决定。Core 依赖能力接口，不把 RPC 形状写入 Agent 执行逻辑。

## ZCode Built-in 配置发布与 Environment 同步

服务端通过既有 `/api/v1/client/configs.data.configs.zcodeBuiltin` 原子发布 ZCode Built-in Provider Config
与 ZCode Built-in Model Config Rules：

```text
Bundled / Remote ZCode Built-in Release
├─ Provider Config
└─ Model Config Rules
        |
        | Environment owner fetch / cache
        v
Environment `<platform>/<appVersion>/<endpointKey>/active.json`（同时承担该 Endpoint 的 LKG）
├─ Host Registry
└─ Core Worker Registry
```

每个 Environment 只缓存自己的 Active；Desktop 不向 Remote Environment 推送本地 Built-in。Host 负责
远端刷新，Worker 只消费活动文件。Prompt CLI/TUI 没有 Host 时由自己的 Entry 承担同一职责。服务暂时
不可用时继续使用 Bundled 或 LKG；版本由 Release revision 排序，客户端不按文件时间猜测新旧。

这里的 Endpoint 是 Environment 当前配置的 ZCode 控制面 Origin，不是模型 API Endpoint。不同 Endpoint
使用不同 Active/LKG 与刷新控制目录，不做跨 Endpoint revision 比较或回退。

这条实现不统一其他 Client Config 请求，也不改变 Personal/Account Overlay、凭据或最终服务端授权。
Built-in 发布业务完整性门禁、灰度和审计仍是发布流程的后续工作。

## Remote Environment 的 Provider 权威

Desktop 连接远端 Workspace 时，Remote Environment 仍然拥有自己的 Provider Config、Credential Store、Registry 和 ModelFactory。`desktop-attached` 只表达 Desktop 可以远程操作该 Environment，不表示 Desktop Environment 的 Provider Runtime 延伸到远端：

```text
Desktop Entry
├─ 展示 Remote Settings / Selection View
├─ 提交 ModelSelection
└─ 控制 Remote Session
        |
        v
Remote Environment
├─ Remote Provider Config
├─ Remote Credential Store
├─ Remote Provider Registry
└─ Remote ModelFactory
```

Desktop 不向 Remote Worker 注入完整 Registry Snapshot、Runtime Model、Account Built-in Config 或请求凭据。Remote Worker 始终从所属 Remote Environment 的 Registry 创建 Model。

配置与凭据如何到达远端是独立的 Provisioning 产品能力，不改变运行时权威，也不属于本次 Provider
Refactor 或 M4 的实施范围。以下只记录必须保持的所有权边界：

```text
第一步：远端成为唯一执行事实源
└─ 删除 Desktop -> Remote 的 Provider Runtime 注入

第二步：独立同步功能持续写入远端 Store
Local Config / Credential
        |
        | Remote Environment 级自动 provisioning sync
        v
Remote Config / Credential Store
        |
        v
Remote Registry 自己重建

第三步：App 远程操作远端设置与登录
└─ 调用 Remote Settings / OAuth Service
```

第二步以 Remote Environment 为唯一同步单位：多个 Workspace/窗口共享 Desktop Main 的一条
single-flight lane，Main 只协调身份、代际和在线 Host；被选中的 Window Host 现读 Local Source
并调用 Remote Target。同步产物必须先落入 Remote Environment 自己的配置与凭据边界，再由
Remote Source 发布变化。同步链路不直接构造 Registry、Model 或请求 Header，也不成为每次模型
请求的在线依赖。即使同步暂时停止，远端仍使用最后一次成功写入的本地事实继续运行。

后续直接在 App 中编辑远端配置或发起远端登录，同样只是对 Remote Environment Service 的远程操作。凭据交换与持久化发生在 Remote Environment；Desktop 不把自己的 Credential Store 当作远端请求鉴权源。

## Environment 配置同步

Environment 之间可以显式同步配置。目标 Environment 将同步结果写入自己的配置边界，并使用自己的
ZCode Built-in Config 和 Account Built-in Provider Config 重新形成 Effective Provider：

```text
Environment A Personal Config
          |
          | explicit sync
          v
Environment B Provider Config Service
├─ Environment B ZCode Built-in Config
├─ Environment B Account Built-in Provider Config
└─ synced Personal Config
          |
          v
Environment B Registry
```

同步协议还需要定义目标 Environment、冲突、credential 和受管理字段策略。同步可以持续运行，但只负责更新目标 Environment 的 Store；Registry 刷新和模型执行仍完全发生在目标 Environment 内部。

## Account Built-in Provider 的两类状态

```text
静态选择事实
├─ ZCode Built-in Provider Config
├─ ZCode Built-in Model Config Rules
└─ Account Built-in Provider Config
   └─ enabled + Start 账号模型成员

动态请求状态
├─ 登录 Token
├─ 一次性安全校验 / 动态 Header
├─ 缓存与刷新
└─ 鉴权失败后的强制更新
```

Registry 使用静态选择事实，决定当前有哪些 Provider 和 Model。动态请求状态由专门 Service 管理，在 Model/Adapter 真正发起请求时提供。详细边界见 [`../registry/model-creation.md`](../registry/model-creation.md)。

Start Plan、Individual Coding Plan 和 Team Plan 各自具有稳定 providerId，并共享 Account Provider 类型和
执行基础设施；Provider Family 只用于产品分组，不替代 providerId。正常结构化连接选择只启用其中一个
匹配 Provider，因此 Model Selection 只展示当前连接；Settings 可以同时展示这些固定 Provider 及其启停
状态，不让同一个 Provider 在 Individual 与 Team 之间运行时变形。

# Server Remote Workspace Connection

## 背景

当前 Desktop App 已支持通过 SSH / WSL / Docker / Server 创建 remote workspace。每个 BrowserWindow 有一个独立
Window Host，同一窗口内的本地与远端 workspace tab 共用该进程；SSH、WSL 在 Host 内池化连接，Docker/Server
使用 logical session 对应的 dedicated connection。Host 把对应 workspaceKey 的 service/CLI scope 暴露给
renderer，registry 不跨 BrowserWindow 共享。

Web 模式下的远端 server 已经暴露 `/ws`，通过 `ChannelServer` 把 `ServiceCollection` 交给 Web UI 使用。这个能力可以复用到 Desktop App，但它不是 SSH remote 的同一条链路：Desktop 不应该再部署或启动一个远端 runtime，而应该连接一个已经运行的 ZCode server，并用 App 的界面管理该 server 里的 workspace、task、文件、git 和 terminal。

## 目标

- 新增一种 remote target：`server`，表示连接已运行的 ZCode Web/HTTP server。
- Desktop App 可以像打开 SSH remote workspace 一样打开 server remote workspace。
- 远端 server 继续持有 workspace runtime、ZCode session/task、agent runtime、文件系统、git、terminal 和 workspace 级能力状态。
- Desktop 本地只持有窗口、UI shell、server 凭据、连接生命周期和 workspace tab/session 绑定。
- 不改变现有 SSH / WSL / Docker remote workspace 行为。
- 不把 mobile `/remote` 的 replayable 恢复语义扩散到 Desktop App 的 continuous 主链路。

## 非目标

- 不在 Desktop 本机为 server remote 启动新的 ZCode Agent runtime。
- 不让 Desktop main 解析或保存 ZCode task/session/stream 业务状态。
- 不把当前裸 `/ws` 作为可公网长期暴露的生产接口。
- 第一版不承诺断线期间本地排队消息不丢；断线时禁用发送，重连后用远端 snapshot 对齐。
- 第一版不支持 Desktop App 创建新的 SSH / WSL / Docker session 再嵌套到远端 server；server remote 只连接已有 server。

## 进程模型

R1 后 Server connector 运行在窗口唯一 Host 内，不创建额外 connector Host process。远端 server wire contract 保持不变。

```text
Desktop renderer
  -> RemoteWorkspaceSessionStore
  -> MessagePort
  -> Window Host / remote-scoped attachment
      -> RemoteConnectionRegistry / dedicated server connection
      -> Node WebSocket wss://<server>/ws
      -> SocketProtocol
      -> ChannelClient
      -> RemoteServiceAccess
  -> remote ZCode server
      -> ChannelServer
      -> ServiceCollection
      -> ZCode task/session/agent runtime
      -> remote filesystem / git / terminal
```

connector 保持在 Node Host 而不是 renderer 直连，原因是：

- WebSocket 鉴权 header、系统代理、TLS/证书和网络诊断更适合放在 Node side。
- renderer 继续只消费 `IServiceAccessor`，和已有 remote workspace UI 结构一致。
- main 只薄转发连接控制请求和 MessagePort，不承担 RPC frame 细节和重连状态机。

## 连接时序

```text
User selects "Connect server"
  -> renderer validates form
  -> main forwards ConnectRemoteWorkspace to Window Host
  -> Window Host allocates remoteSessionId and creates dedicated connection
  -> connector calls GET /api/server-info
  -> connector opens wss://server/ws with auth
  -> connector creates RemoteServiceAccess
  -> Window Host exposes scoped MessagePort; main transfers it to renderer
  -> renderer registers remote session
  -> UI loads workspace state from remote services
```

断线重连：

```text
WebSocket close
  -> connector reports disconnected
  -> renderer marks remote workspace disconnected
  -> UI disables send / terminal write
  -> connector reconnects or user clicks reconnect
  -> new ChannelClient is created
  -> renderer re-registers services
  -> UI calls list/read snapshot APIs to converge
```

## RemoteTarget 与 Workspace Identity

新增 target 类型：

```ts
type ServerRemoteTarget = {
  kind: "server";
  url: string;
  name?: string;
  tokenRef?: string;
  workspacePath?: string;
  serverId?: string;
};
```

身份隔离继续遵守现有规则：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

server remote 的 `workspaceIdentity` 必须通过统一的 `buildRemoteWorkspaceIdentity()` 构造，格式为：

```text
remote:server:<serverId>:<workspacePath>
```

`workspacePath` 继续只表达远端 server 上的实际执行路径；tab 去重、session 绑定、缓存 key、队列 key 和持久化 key 使用 `workspaceIdentity` fallback 规则。

## Server 接口

现有 `/ws` 可以继续作为 RPC 入口，但需要补生产级 bootstrap 与鉴权：

```text
GET /api/server-info
  -> serverId
  -> version
  -> protocolVersion
  -> authRequired
  -> workspaces[]

GET /api/health
  -> ok

GET /ws
  Authorization: Bearer <token>
```

当前部署验证用的裸 `/ws` 只适合受控内网或临时调试。生产入口必须启用 token 或等价鉴权，且日志不能记录原始 token。

## 服务归属

server remote 不能完全复用 SSH remote 的 service merge 策略。SSH remote 仍有很多 app-global state 由 Desktop 本地权威管理；server remote 更像连接一个完整运行的远端 ZCode 实例，workspace/runtime 相关状态应以 server 为准。

推荐第一版归属：

```text
Local Desktop authority:
  - theme / locale / window state
  - server target list
  - server token credential
  - desktop-only platform actions

Remote server authority:
  - file / git / terminal / file watcher
  - zcodeTask / zcodeSession / zcodeAgent
  - skills / plugins / MCP / commands for remote workspace
  - model provider registry used by the remote runtime
  - workspace-level settings and task/session persistence
```

这需要新增 `buildServerRemoteWorkspaceSessionServices()`，不要直接套用 SSH 的 `buildRemoteWorkspaceSessionServices()`。

## Realtime 与队列边界

Desktop App 连接 server remote 时仍属于 Desktop continuous 客户端：

```text
Desktop server remote:
  clientMode = desktop-continuous
  deliveryKind = continuous
  reconnect recovery = read snapshot / list tasks

Mobile /remote:
  clientMode = web-remote-replayable
  deliveryKind = replayable
  reconnect recovery = mirror gap + snapshot watermark + pendingCommands
```

第一版发送策略：

- connected 且 task ready：直接走远端 `zcodeTaskService` / `zcodeAgentService` 现有发送路径。
- disconnected：禁用发送，不在本地 renderer queue 积压。
- running task 的流由远端 server 持有；Desktop 断线不会杀远端 runtime。
- 重连后用远端 session/task snapshot 对齐 UI。

如果后续产品要求“Desktop 断线期间提交的 prompt 也不丢”，再单独把 server remote 桌面发送切到 host-accepted command queue，并明确不会影响本地 Desktop continuous 主链路。

## UI 入口

在现有 Remote Connection dialog 中增加 `Server` 类型，但当前仅对本地开发运行形态开放：

```text
Remote Connection
  - SSH
  - WSL
  - Docker
  - Server
```

展示边界：

- 本地 Vite 开发启动，或 Desktop platform 明确标记 `isLocalDevelopmentRuntime = true`：展示 `Server` 类型卡片。
- production-mode 打包的 Desktop（包括正式包和预览包）：不展示 `Server` 类型卡片，即使产品环境配置为 `test` 也不放开。
- 门禁只使用本地开发运行形态，不使用 `ZCODE_ENV` 或内网探测结果；SSH / WSL / Docker 的展示规则不受影响。

Server 表单字段：

- Server URL
- Display name
- Token / credential
- Workspace selector（来自 `/api/server-info`；如果没有 workspace list，则允许手输 path）

连接成功后，侧边栏展示为 remote workspace。断线状态、重连按钮、错误日志复用现有 remote workspace UI 模式，但文案区分 “Server connection” 和 “SSH connection”。

## 验证计划

- Unit：`ServerRemoteTarget` schema、workspace identity 构造、URL normalizer、token redaction。
- Unit：connector host reconnect 状态机。
- Unit：server remote service merge 不误用 SSH merge 策略。
- Integration：mock `/api/server-info` + `/ws` ChannelServer，验证 renderer 能注册 remote session 并读取 workspace state。
- Integration：WebSocket close 后 UI 标记 disconnected，重连后重新读取 snapshot。
- E2E：Desktop 连接本地测试 server，发送 prompt，任务流正常展示。
- Regression：SSH / WSL / Docker remote connection 不受影响。
- Regression：mobile `/remote` 仍 attach existing host，不新增 independent runtime。

## 当前实现状态

- `RemoteTarget` / settings snapshot 已新增 `kind: "server"`，server token 通过 credential key 持久化。
- Server HTTP 入口新增 `GET /api/server-info`，返回 `serverId`、版本、协议版本、workspace 列表和桌面 continuous 能力标记。
- Desktop host 通过 Node WebSocket 连接已有 server 的 `/ws`，使用 `RemoteServiceAccess` 转接 RPC，不进入 SSH/WSL/Docker backend 部署链路。
- Desktop server remote 不启用 `relay_bridge`，保持 desktop continuous 语义；mobile `/remote` 的 replayable 恢复边界未扩散到 server remote。
- Renderer 对 server remote 使用 server-authoritative service merge；SSH/WSL/Docker 继续使用原有本地全局服务 + 远端 workspace 服务策略。
- Server remote 的 runtime Provider Registry 保持 server-authoritative；Desktop 模型配置页只编辑
  Local Environment，首次连接的 `onlyIfMissing` Provisioning 是唯一自动复制入口，不提供运行中的
  Local → Server 手动同步动作。
- UI 远程连接向导已在本地开发运行形态新增 Server 类型和 URL / 名称 / token / 默认目录字段；production-mode 打包不展示该类型。

## 开放问题

- Server remote 是否只允许 HTTPS/WSS，还是开发态允许 HTTP/WS。
- 一个 server 是否可以暴露多个 workspace；如果可以，workspace list 的权限和刷新策略需要在 `/api/server-info` 或独立 `/api/workspaces` 中定义。
- 多个 Desktop App 同时连接同一个 server 时，task owner、permission 和 elicitation 的 UX 是否要显示当前 owner/client 信息。

# Federated ZCode Node / Hub 状态与迁移规划

## 状态

- 文档状态：架构草案，等待产品裁决。
- 范围：同一 Desktop 或 Browser Web 同时管理本机与多个 ZCode Lite / Server Node。
- 本文规划统一进程模型、通信栈、状态权威、任务聚合、扩展能力和旧数据迁移；不修改现有产品代码。
- 已确认的上层架构边界：
  - Desktop UI 和 Browser Web 都是统一 UI。
  - TUI 是 Node 本地能力，不作为跨远端 UI。
  - SSH / WSL / Docker 负责 bootstrap、发现和 transport；业务协议最终连接同一个 Node Runtime。
  - 手机 `/remote` 是现有 Hub 的远程 UI attachment，不独立创建 Node runtime。
  - Desktop `desktop-continuous` 与 Browser / 手机 replayable 继续保持不同 delivery 语义；
    目标态再把 Browser 与手机拆成不同的可信连接角色。

## Feature Impact Brief

### 变更层

| 层            | 本规划的变化                                                                       |
| ------------- | ---------------------------------------------------------------------------------- |
| option-source | 模型目录改为账户级期望配置；Skill / Plugin / Subagent 候选改为目标 Node 实际能力。 |
| draft-default | 新任务模型默认值来自账户级模型 Profile；已有 Session 继续使用自己的运行时配置。    |
| validation    | 创建和发送前校验目标 Node 的模型与凭据 readiness；扩展操作校验目标 Node 能力。     |
| commit-effect | Task / Session 命令只路由到任务来源 Node；Hub 不执行业务命令。                     |
| persistence   | 引入稳定 Node / Workspace 身份、跨节点视图配置、Hub 目录缓存和迁移 ledger。        |
| recovery      | 多 Node 游标、节点离线、拓扑变化、双数据库迁移和旧 identity alias 都需要恢复协议。 |

### 当前事实

1. Task 列表持久行来自各 endpoint 的 `tasks-index.sqlite`，Session runtime 和正文仍由 CLI
   Session Store 权威持有。当前 UI 会把每个 endpoint 的 active / pinned / archived 全量拉回，
   再在 renderer 合并、排序和裁剪。
2. `ZCodeTaskListQuery` 只有 `limit`，没有 cursor；当前“显示更多”仍会重新读取完整前缀。
3. 自定义分组当前存于单个 `tasks-index.sqlite` 的
   `task_groups / task_group_members / task_group_view_node_orders`，排序是用户显式顺序，
   不是时间排序；当前 Grouped 视图明确不聚合 remote endpoint。
4. App 模型配置权威文件为 `~/.zcode/v2/config.json`。当前 Provider metadata、Base URL 和
   自定义 API Key 仍混在同一配置 / registry snapshot 中。
5. SSH / WSL 当前是混合权威：
   - 文件、Git、Terminal、Agent、Task、Skills、Plugins 在远端；
   - Settings、Credential、Model Provider 在 Desktop；
   - Subagent 设置服务仍在 Desktop，但远端 CLI runtime 实际读取远端定义和状态，存在事实源分裂。
6. 旧 SSH Task 数据实际同时落在目标机的两套数据库：
   - `~/.zcode/v2/tasks-index.sqlite`
   - `~/.zcode/cli/db/db.sqlite`
7. 旧 SSH workspace key 的格式为：

```text
remote:ssh:<host>:<port>:<username>:<workspacePath>
```

同一目标机经不同 hostname、端口、用户名或 SSH alias 连接，会形成不同 key。

8. 当前 SSH / WSL / Docker 虽已复用
   `IRemoteBackend -> deployServer -> connectRemote -> zcode-server`，进程复用和回收仍不一致：
   - SSH：同窗口、同 SSH 身份共享 Host，通常留到窗口关闭；
   - WSL：同窗口、同 distro / user 共享 Host，使用 workspace generation 和 60 秒 idle TTL；
   - Docker：每个 remote session 独立 Host，session 关闭即回收整套 runtime。
9. 当前 SSH / WSL / Docker 启动的是前台 stdio `zcode-server`。它由 Desktop Host 持有生命周期，
   不监听长期端口；连接 EOF 或 Host 退出会触发 Server 和 Agent 清理。
10. 当前 ZCode Lite 使用 `entry-http.js` 创建另一种长期 HTTP / WebSocket Server；它与 stdio Server
    都调用 `createLocalServices()`，但入口、认证、连接复用和生命周期仍是两套。
11. 当前手机 `/remote` 经 relay 附着 Desktop 窗口已有 Local / Remote Host；relay 和 Desktop main
    只透传 `rpc-frame` 与 attachment 控制，不拥有 task / session / stream / queue / snapshot。

### 必须保留的不变量

1. Task / Session / Stream / Queue / Snapshot 的业务真相只在任务来源 Node。
2. Hub、relay 和 Desktop main 不持有 conversation 业务状态。
3. 全局 Task 身份不能再只用 `taskId`，至少使用：

```text
GlobalTaskRef = { nodeId, workspaceId, taskId }
```

4. `workspacePath` 只用于目标 Node 上的 IO 和展示，不能继续承担跨机器永久身份。
5. 已有 Session 的 provider / model / thought 仍由该 Session runtime 权威持有；账户模型配置只提供
   目录、默认值和新 Session 种子，不能批量改写历史 Session。
6. Node 本地 Skill / Plugin / Subagent 不得被多个节点的候选并集伪装成“当前任务可用”。
7. 手机 `/remote` 只看到已配对 Hub 已连接或已缓存的 Node；不能绕过 Hub attachment 直接创建
   Node runtime。
8. UI 不得自行声明可信 `clientMode`；Desktop continuous、Browser / Mobile replayable 都必须由
   Hub / Node attachment 依据已认证的连接角色注入。
9. SSH / WSL / Docker bootstrap 只负责“到达 Node”，不得拥有 workspace、Agent 或 conversation
   生命周期。

## 目标架构

```text
                         Account Control Plane
                  ┌────────────────────────────────┐
                  │ Model Profile                  │
                  │ Credential policy / bindings   │
                  │ Federated Task View Profile    │
                  └───────────────┬────────────────┘
                                  │ revision sync
                  ┌───────────────┴────────────────┐
                  │                                │
          Browser Web on A                  Desktop UI on C
                  │                                │
             Federated Hub A                  Federated Hub C
             ┌────┴────┐                    ┌──────┼──────┐
             │         │                    │      │      │
          Node A     Node B               Node A Node B Node C
             ▲
             │ local/in-process
          TUI on A

Mobile /remote
  -> relay
  -> Hub C attachment
  -> 已连接的 Node A / B / C
```

约束：

- Hub 只连接 Node plane，不递归连接另一个 Hub，避免环路、重复聚合和身份歧义。
- Browser Web 的 Hub 位于它所连接的 Lite / Server 进程；Desktop 的 Hub 是由 Electron Main 监督、
  供多个窗口共享的 app-wide 独立进程，不属于任一 per-window Host。
- Node 是本机 workspace、task、session、file、git、terminal、resource 和 extension inventory 的权威。
- Account Control Plane 是一个逻辑接口，可以由 ZCode 账户服务、自托管同步服务或离线本地 Profile
  实现；不把云实现细节写死到 Node RPC。

## 统一进程与通信模型

### 一句话模型

```text
Desktop / Browser / Mobile UI 只连接 Hub
TUI 只连接本机 Node
Hub 只连接 Node
Node 持有本机业务服务和 workspace runtime
Node 按 workspaceKey 懒启动 ZCode Agent
SSH / WSL / Docker 只是 bootstrap + tunnel adapter
```

目标不是把所有东西塞进一个进程，而是让不同部署形态复用同一组逻辑角色和协议合同。

### 逻辑角色

| 角色                       | 数量与位置                                           | 职责                                                                                                  | 明确不负责                                                          |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| UI Client                  | Desktop Renderer、Browser Web、Mobile Web            | 展示统一 Node / Workspace / Task 视图，提交用户意图                                                   | 不持有业务权威，不直接 SSH，不直接启动 Agent                        |
| ZCode Hub                  | 每个 Desktop 实例一个；每个 Lite Web origin 一个     | Node registry、连接管理、Task Summary 聚合、离线目录缓存、账户 Profile 同步、UI attachment            | 不执行文件命令，不拼 conversation，不拥有 queue / stream / snapshot |
| ZCode Node                 | 每台目标机器、WSL distro 或容器一个稳定实例          | Workspace Registry、file/git/terminal、Task Index、Resource Store、Agent manager、extension inventory | 不聚合其他 Node，不递归充当远端 Hub                                 |
| ZCode Agent                | 每个活跃 workspaceKey 最多一个主聊天 runtime         | Session、V4 CommandInbox、projection、stream、permission、tool、model runtime                         | 不管理跨 Node 连接或 UI 布局                                        |
| Bootstrap / Tunnel Adapter | 每条 SSH / WSL / Docker 连接一个短生命周期 connector | 安装、升级、发现 Node，建立到 Node endpoint 的字节隧道                                                | 不创建第二套 ServiceCollection，不保存业务状态                      |
| Relay                      | 外部可选基础设施                                     | 手机与 Hub 的鉴权、配对、心跳、opaque frame 透传                                                      | 不解析 Node / task / session，不做 replayable snapshot              |
| Account Control Plane      | 账户服务、自托管服务或离线实现                       | Model Profile、Credential policy、Federated View revision                                             | 不承载实时 conversation                                             |

### Desktop 进程模型

```text
Desktop machine C
┌─────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                       │
│ - 窗口、native API、进程监督、MessagePort 分发                      │
│ - 不拥有 Node registry / task / session                             │
│                                                                     │
│ ├─ Renderer Window 1 ─┐                                             │
│ ├─ Renderer Window 2 ─┼─ MessagePort ──> App-wide ZCode Hub Process │
│ └─ Mobile relay ──────┘                         │                    │
│                                                ├─ local connector   │
│                                                ├─ direct WSS        │
│                                                ├─ SSH tunnel        │
│                                                ├─ WSL tunnel        │
│                                                └─ Docker tunnel     │
└────────────────────────────────────────────────┼────────────────────┘
                                                 │
                         ┌───────────────────────┼──────────────────────┐
                         ▼                       ▼                      ▼
                      Node A                  Node B                 Node C
```

目标态不再按窗口为每个 SSH / Docker workspace 创建一套业务 Remote Host。Desktop main 只监督一个
app-wide Hub；多个窗口和手机 attachment 都复用 Hub 的 Node connection pool。每个 UI attachment
仍有独立 connection / subscription scope，不能因物理连接复用而共享 delivery buffer。

Desktop 本机能力也通过同一个 Node 合同访问：

```text
Desktop Hub
  -> 发现已有 local Node daemon
  -> 若不存在，则由 Main 监督启动 embedded Node Process
  -> MessagePort / named pipe / loopback socket
  -> Local Node Core
```

Node 数据目录必须有 single-owner lock。若用户已经通过 ZCode Lite 启动同一数据目录的 Node，
Desktop 必须复用它，不能再启动第二个 SQLite / Agent owner。

### ZCode Lite / Browser Web 进程模型

```text
zcode-lite serve
┌──────────────────────────────────────────────────────────────┐
│ Lite Supervisor                                              │
│ ├─ Node Core / Node Process                                  │
│ │   ├─ Workspace Registry / Task Index / Resource Store      │
│ │   └─ Agent A / Agent B ...                                 │
│ ├─ Hub Core / Hub Gateway                                    │
│ │   ├─ local Node A connection                               │
│ │   └─ remote Node B / C connections                         │
│ └─ HTTP Gateway                                              │
│     ├─ /                 Web 静态资源                         │
│     ├─ UI <-> Hub endpoint                                   │
│     └─ authenticated Hub <-> Node endpoint                   │
└──────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ same-origin WSS                  │ HTTPS/WSS
   Browser Web on A                   Desktop Hub C
```

Lite 对外可以只暴露一个端口，但端口内必须按角色分开：

```text
Browser UI role  -> Hub endpoint
Remote Hub role  -> Node endpoint
Admin/bootstrap  -> 有限的 Node discovery / pairing endpoint
```

同一个 HTTP listener 不等于同一个权限。Browser session cookie 不能自动获得 Hub-to-Node 的可信权限；
Desktop Hub 需要独立 token、mTLS 或一次性 capability。

MVP 可以让 Node Core、Hub Core 和 HTTP Gateway 同处一个 Node.js 进程以降低安装复杂度，但必须使用
独立 service collection、身份和生命周期接口。长期可以拆进程而不改变协议。

### 当前入口到目标入口的映射

| 当前实现                                  | 当前语义                                        | 目标迁移                                                  |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `entry-http.ts -> createLocalServices()`  | Lite HTTP 进程直接持有 Node services            | 抽出 Node Core；同 listener 增加独立 Hub Gateway          |
| `/ws`                                     | Browser 直接连接 Node services，固定 replayable | Browser 改连 Hub endpoint；Hub 再路由 local / remote Node |
| `/ws/host`                                | Desktop Node Host 以一次性 capability 直连 Node | 保留为 Hub-to-Node trusted endpoint，并扩展稳定身份与重连 |
| `entry-stdio.ts -> createLocalServices()` | SSH / WSL / Docker 每次连接启动一套业务 Server  | 迁为 bootstrap / tunnel shim；业务只在稳定 Node daemon    |
| per-window Remote Host                    | 窗口级 SSH / WSL pool，Docker dedicated         | app-wide Hub connector pool                               |
| Desktop Main mobile bridge                | relay frame 接到某个窗口已有 Host               | relay device transport 接到 Hub logical attachment        |

当前 Browser Web 只读取一个 `ZCODE_SERVER_WORKSPACE`，不能管理动态 workspace catalog；普通 Web
也不能完整处理长文本临时附件。目标 Hub / Workspace Registry 和 Resource Store 必须先补齐这些合同，
再开放跨 Node Web 管理，不能只把 UI 入口显示出来。

### TUI

TUI 是 Lite / Node 安装包的本机客户端，不参与跨 Node 聚合：

```text
TUI on A
  -> local socket / in-process adapter
  -> Node A
  -> workspace Agent
```

它可以复用 Node API 和 V4 conversation protocol，但不提供 SSH 管理入口，也不作为其他机器的 Hub。

### 一个二进制，多种角色

建议最终发布同一套 runtime，以子命令区分角色：

```text
zcode node serve       # 长期 Node daemon
zcode node connect     # 只做 stdio <-> local Node socket 字节桥
zcode hub serve        # 可独立运行的 Hub Gateway
zcode lite serve       # 监督 local Node + Hub + Web 静态入口
zcode tui              # 本机 UI，直接连接 local Node
```

`zcode node connect` 不调用 `createLocalServices()`，也不启动 Agent；它只是 SSH / WSL / Docker
无法直接转发本地 socket 时的 transport shim。

### Authority 与 Transport 正交

`ssh`、`direct URL` 或 `local socket` 只说明如何到达 Node，不能继续隐式决定模型、凭据和设置的权威。

```text
Transport:
  local | direct-wss | ssh-tunnel | wsl-tunnel | docker-tunnel

Authority profile:
  account-managed
  hub-attached-compat
  node-standalone
```

- `account-managed`：账户 Model Profile 是期望配置，Node 使用自己的 credential binding / lease。
- `hub-attached-compat`：仅表示已经退出的历史 Desktop Registry 下发方案，不是当前兼容模式。
- `node-standalone`：离线或自托管 Node 使用本机 Profile / vault。

同一个 Node 从 SSH tunnel 改为 direct WSS 后，不得因此换一套 task、workspace、model 或 extension 身份。

## 通信栈

### 协议层与载体层分离

```text
业务层
├─ Hub Protocol
│  ├─ Node registry / connection status
│  ├─ federated Task Summary query
│  ├─ account profile / view profile
│  └─ route(GlobalWorkspaceRef / GlobalTaskRef)
├─ Node Service Protocol
│  ├─ workspace / file / git / terminal / task index
│  ├─ extension inventory / readiness
│  └─ resource begin / chunk / commit
├─ ZCode Protocol V4
│  ├─ command ACK / query
│  ├─ conversation / sessions-index / workspace-config topic
│  └─ snapshot / delta / gap recovery
└─ Bootstrap Protocol
   ├─ install / upgrade / discover
   └─ NodeId / version / capability / endpoint

统一 RPC / frame 层
└─ @zcode/rpc IMessagePassingProtocol + typed runtime schema

Transport adapter
├─ MessagePort
├─ local socket / named pipe
├─ HTTPS + WSS
├─ SSH direct-tcpip / stdio tunnel
├─ WSL stdio tunnel
├─ Docker exec stdio tunnel
└─ mobile relay acknowledged rpc-frame
```

“SSH 发送的内容和 WS 差不多”应落实为：两者承载完全相同的 Node RPC / V4 frame，
而不是在 SSH 代码里维护另一套 service 方法。WebSocket 是一种 carrier；SSH / Docker 的 stdio
也只是 carrier。业务 schema、connection scope、命令幂等、资源协议和恢复语义必须相同。

### 各链路推荐 Transport

| 链路                              | 物理 Transport                                       | 逻辑协议                  | 默认 delivery              |
| --------------------------------- | ---------------------------------------------------- | ------------------------- | -------------------------- |
| Desktop Renderer -> Desktop Hub   | Electron MessagePort                                 | Hub RPC                   | `desktop-continuous`       |
| Browser Web -> Lite Hub           | same-origin WSS                                      | Hub RPC                   | `browser-replayable`       |
| Mobile -> Hub                     | WSS relay + acknowledged opaque `rpc-frame`          | Hub RPC                   | `mobile-remote-replayable` |
| Desktop / Lite Hub -> direct Node | authenticated WSS                                    | Node RPC + multiplexed V4 | 由 logical attachment 决定 |
| Hub -> local embedded Node        | MessagePort / named pipe / local socket              | Node RPC + multiplexed V4 | 由 logical attachment 决定 |
| Hub -> SSH Node                   | SSH tunnel 中的 socket frames                        | 与 direct Node 完全相同   | 由 logical attachment 决定 |
| Hub -> WSL Node                   | stdio connector -> distro local socket               | 与 direct Node 完全相同   | 由 logical attachment 决定 |
| Hub -> Docker Node                | `docker exec -i` connector -> container local socket | 与 direct Node 完全相同   | 由 logical attachment 决定 |
| Node -> Agent                     | child-process stdio NDJSON                           | ZCode Protocol V4         | Node 内部连接              |

`browser-replayable` 和 `mobile-remote-replayable` 可以复用同一种 replayable 算法，但必须保留不同
client role，避免把手机 pairing、Hub attachment 和 Browser same-origin 权限混成一个模式。
迁移期可以映射到现有 `web-remote-replayable`。

### 一个物理 Node link，多个逻辑 attachment

Hub 与同一 Node 只需维护少量物理连接，但物理复用不能吞掉现有 connection 隔离：

```text
Hub C == one authenticated physical link ==> Node A
          │
          ├─ attachment d1
          │   role=desktop
          │   profile=continuous
          │   connectionId=node-assigned-1
          │
          ├─ attachment b1
          │   role=browser
          │   profile=replayable
          │   connectionId=node-assigned-2
          │
          └─ attachment m1
              role=mobile-remote
              profile=replayable
              connectionId=node-assigned-3
```

每个 logical attachment 必须独立拥有：

- `connectionId`
- subscription registry
- buffer / saturation state
- fragment assembly
- resync flight
- permission / elicitation visibility

Node 只接受已认证 Hub 打开的 attachment role；UI payload 不能直接指定 `clientMode`。MVP 可先为每个
attachment 打开独立 WebSocket，等合同稳定后再做物理 multiplex。

Hub 只路由 frame 和管理 connection；conversation 的 seq、snapshot、queue 和 command lookup
仍由来源 Node / Agent 权威持有。

## SSH / WSL / Docker bootstrap 与 tunnel

### 统一时序

```text
Hub Connector        Bootstrap Adapter          Target Node
     |                       |                       |
     |-- detect/install ---->|                       |
     |                       |-- install/upgrade --->|
     |                       |-- ensure daemon ----->|
     |                       |<-- bootstrap result --|
     |<-- NodeId/endpoint ---|                       |
     |                                               |
     |==== authenticated Node Protocol over tunnel ==|
     |-- hello(nodeId, protocol range, role) -------->|
     |<-- capability / bootId / workspace registry --|
     |-- open logical attachment -------------------->|
     |<== Node RPC / V4 / resource frames ===========>|
```

Bootstrap 返回至少包含：

```ts
interface NodeBootstrapResult {
  nodeId: string;
  bootId: string;
  nodeVersion: string;
  protocolRange: { min: number; max: number };
  capabilities: string[];
  endpoint: {
    kind: "loopback-tcp" | "unix-socket" | "named-pipe" | "direct-url";
    address: string;
  };
  connectionChallenge: string;
}
```

`connectionChallenge` 只能兑换短期 Hub-to-Node capability，不能成为长期明文凭据。

### SSH

```text
ssh2
  1. 上传/升级统一 Node runtime
  2. 启动或发现 zcode node serve
  3. Node 仅监听远端 loopback
  4. ssh2.forwardOut 建 direct-tcpip tunnel
  5. tunnel 上运行与 direct WSS 相同的 Node frame
```

若目标环境无法使用 direct-tcpip，则执行 `zcode node connect`，把 SSH stdio 纯转发到 Node local
socket。旧 `entry-stdio.ts -> createLocalServices()` 只保留一个迁移周期，不作为长期架构。

### WSL

```text
wsl.exe ... zcode node connect
  -> distro 内 Unix socket
  -> persistent Node daemon
```

这样 Windows localhost forwarding 差异只影响 adapter，不影响 Node RPC。WSL distro 不因 Desktop
窗口关闭而被 terminate。

### Docker

```text
docker exec -i <container> zcode node connect
  -> container 内 Unix socket
  -> persistent Node daemon
```

如果容器已显式暴露并保护 Node HTTPS / WSS 端口，Hub 可以 direct URL 连接；否则默认使用 exec
tunnel，不要求用户重建容器增加 `-p`。Node 生命周期跟随容器，workspace / Agent 生命周期由统一
`WorkspaceLeaseManager` 决定，不再每个 UI session 重启整套 Server。

### 手动安装的 Lite / Headless Node

用户通过 `zcode lite serve` 或 `zcode node serve` 启动后：

- Browser Web 连接本机 Hub endpoint；
- Desktop 使用 direct URL 连接同端口的 Node endpoint；
- 本机 TUI 走 local socket；
- SSH / Docker bootstrap 发现相同 NodeId 时直接复用，不启动第二个 runtime。

连接 URL、SSH alias、Docker container name 和 WSL distro 只进入 `ConnectionProfile`，不进入 Node /
Workspace / Task 永久身份。

## 文件与外部资源传输

长文本自动转文件、拖入图片和任意外部资源必须走同一个目标 Node Resource Store：

```text
Desktop / Browser / Mobile bytes
            |
            v
Hub route(GlobalWorkspaceRef)
            |
            v
Node resource/begin
  -> resource/chunk*
  -> resource/commit
            |
            v
ResourceRef { nodeId, workspaceId, resourceId, sha256, mediaType, size }
            |
            v
Prompt 只携带 ResourceRef
            |
            v
目标 Node materialize / stream 给 workspace Agent
```

规则：

1. UI 本地路径永远不能直接发给远端 Agent。
2. Hub 不把资源落成业务权威文件；它只流式路由并维护传输进度。
3. Node 在 `commit` 前校验长度、hash、配额和目标 workspace lease。
4. ResourceRef 必须包含 `nodeId + workspaceId`，禁止在 Node 之间误复用。
5. 连接中断后按 upload id / committed chunks 恢复；禁止在 conversation RPC 中 base64 整个大文件。
6. 长文本临时文件、截图、拖拽图片、浏览器 `File` 对象共享同一 API。
7. Node 负责生成 Agent 可读的本地路径或 byte stream；CLI 不感知原文件来自 Desktop、Web 还是手机。

因此 Browser A 管理 Node B 时，资源链路是
`Browser A -> Hub A -> Node B Resource Store`，不是把 Node A 的临时路径写进 prompt。

## 手机 Remote Controller

### 架构位置

手机是 Hub 的远程 UI attachment：

```text
Mobile Browser
  -> external relay
  -> selected Hub device transport
  -> Hub node registry / router
  -> existing Node logical attachment
  -> source workspace Agent
```

目标态把 relay device transport 和 shared attachment manager 收敛到 Hub Gateway。Desktop main
只保留二维码、窗口和进程调度；Lite Hub 也可以在用户显式开启后注册 relay device role。

### 能力边界

- 手机可以浏览 Hub 已知的 Node A / B / C 和聚合 Task Summary。
- 手机打开 Task 时，Hub 向来源 Node 创建 `mobile-remote-replayable` logical attachment。
- 手机断线、刷新或 relay 重连只重建 attachment，不停止 Hub、Node 或 Agent。
- relay 继续只看 opaque `rpc-frame`；replay / gap / snapshot 在 Node / Agent 与手机 UI 两端。
- 第一阶段手机不能安装 Node、输入 SSH 凭据或启动新的 SSH / WSL / Docker bootstrap。
- Hub 已有连接离线时，手机只能看到 stale summary；是否允许 Hub 按预授权 profile 自动重连是独立产品策略。
- 手机命令与 Desktop / Browser 命令进入同一个来源 Agent `CommandInbox`；不新增 mobile queue。

### 与 Browser Web 的区别

```text
Browser Web:
  same-origin WSS -> Lite Hub -> one or more Nodes

Mobile Remote:
  relay WSS -> 已配对 Hub -> one or more Nodes
```

两者可以渲染同一套 UI 组件，也都使用 replayable delivery，但认证、入口和连接 owner 不同。

## 生命周期与故障边界

```text
UI attachment lifetime       = 页面 / 窗口 / 手机 bridge
Hub lifetime                 = Desktop App 或 Lite Hub service
Tunnel lifetime              = Hub 到 Node 的一次物理连接
Node daemon lifetime         = 节点级，独立于 UI 和 tunnel
Workspace lease lifetime     = attachment + running task + policy / idle TTL
Agent lifetime               = workspaceKey 级，由 Node WorkspaceLeaseManager 管理
Conversation lifetime        = Agent session store，不等于任何进程连接
```

必须满足：

1. 关闭一个 UI tab 只释放自己的 logical attachment。
2. Browser refresh / Mobile reconnect 不重启 Node 或 Agent。
3. Hub 崩溃重启后，从 Node registry、Task Summary、V4 snapshot 恢复；不重放私有业务日志。
4. SSH tunnel 断开不立即杀死 Node daemon；Agent 是否继续由 running task / lease policy决定。
5. 容器 stop、WSL shutdown 或机器关机导致 Node `bootId` 变化；Hub 必须使旧 attachment /
   subscription / cursor 失效并重新握手。
6. Node shutdown 先停止新命令、关闭 attachment、等待 Agent process tree 和数据库 checkpoint，
   再退出。
7. Account Control Plane、relay 或 Hub 暂时不可用不能破坏 Node 本地 Task / Session 数据。

### 安全边界

- Node 默认只监听 loopback / Unix socket / named pipe；公开地址必须显式开启 TLS 和 token / mTLS。
- UI token、Hub-to-Node capability、bootstrap credential、账户 credential 使用不同 audience。
- Node 分配 `connectionId`，并根据已认证 role 注入 delivery profile。
- Hub 只保存 Connection Profile 和可撤销 credential 引用，不把 SSH 密码、API Key 写入 task catalog。
- direct URL、SSH tunnel 和 relay 都必须进行协议版本与 capability negotiation。
- 资源上传、terminal、file write、bootstrap 和账户 Secret 下发分别授权，不能只靠“已连上 Node”。

## 状态作用域

| Scope      | 权威数据                                                                              | 同步语义                                                            |
| ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| account    | Provider / Model metadata、展示顺序、默认模型、全局最近显式模型元组、可选跨端分组视图 | revision 化，同一账户各 Hub / Node 收敛                             |
| credential | API Key、OAuth token、Coding Plan key、runtime header                                 | 与 metadata 分离；按策略使用 E2E 同步、Node 本地 vault 或短期 lease |
| hub/device | Node connection profile、连接状态、UI 布局、持久化离线目录缓存                        | 设备本地；不能成为 Task / Session 权威                              |
| node       | Plugin 实际安装、user Skill / Subagent、工具链、Node capability、runtime cache        | 每台机器独立，可显式复制，不自动求并或覆盖                          |
| workspace  | Repo 内 `.zcode/*` / `.agents/*`、workspace extension、项目设置                       | 位于目标 Node 的 workspace；由 Git / 文件系统自然传播               |
| session    | 当前 provider / model / thought / mode、消息、queue、owner、stream、permission        | 只在执行该 Session 的 Node runtime                                  |

## 模型配置

### 目标拆分

历史 `ZCodeProviderRegistrySnapshot` 曾同时包含 metadata 和 raw secret；该快照链已经删除。多 Node
目标设计仍需把期望配置、Credential Binding 和执行时 Lease 保持为三条独立链：

```text
Account Model Profile
  ProviderCatalogSnapshot
  - provider / model / capability / baseURL / order / defaults
  - metadataRevision
                  │
             ▼
Node Runtime Binding
  - providerId / modelId / metadataRevision
  - credentialBindingId
                  │
                  ▼
Credential Plane
  - encrypted Node secret 或短期 credential lease
  - audience = nodeId + workspaceId + sessionId
  - credentialRevision / expiry / revocation
```

建议类型：

```ts
interface ModelProfile {
  profileId: string;
  revision: string;
  providers: ProviderMetadata[];
  defaultModelRef?: string;
  lastExplicitSelection?: {
    modelRef: string;
    thoughtLevel?: string;
  };
}

interface NodeModelReadiness {
  nodeId: string;
  profileRevision: string;
  providers: Array<{
    providerId: string;
    status: "ready" | "missing-credential" | "unsupported" | "stale";
    reason?: string;
  }>;
}
```

规则：

1. 所有端展示同一 `ModelProfile`。
2. Node 单独上报 readiness；“配置相同”与“目标 Node 已能执行”不混成一个字段。
3. 新建 Session 前，Node 必须先应用目标 Profile revision，再解析默认模型。
4. 已有 Session 保留自己的 provider / model / thought；打开历史 Session 不反写全局偏好。
5. 目标 Node 缺凭据时，默认阻止创建 / 发送并给出明确修复入口，不静默切换成另一台机器可用的模型。
6. 当前 Desktop-attached SSH 的“把完整 registry 和 raw secret 一起下发”只作为迁移期兼容路径；
   新协议只下发 catalog revision 和 credential binding / lease。

### 待裁决

- 自定义 API Key 是否必须做到跨端 E2E 加密同步：
  - 推荐：Provider metadata 强同步；Secret 支持账户 E2E 同步，并允许 Provider 级设置为 Node-local。
  - 简化方案：Secret 全部 Node-local；此时各端模型目录相同，但 readiness 可能不同。

## Skill / Plugin / Subagent

### 产品语义

1. Extension inventory 按 `nodeId + workspaceId` 查询，不能使用所有 Node 的并集作为当前任务候选。
2. 当前任务来自 Node B 时：
   - Composer / Slash command / Agent picker 使用 B 的能力；
   - Settings 中的 Skill / Plugin / Subagent 编辑也提交给 B；
   - Node A / C 的安装状态不能影响 B 的 runtime。
3. 全局设置页需要 Node 选择器；可提供“所有节点”矩阵，但矩阵只用于比较，不可作为执行目录。
4. 用户级 Skill / Plugin / Subagent 是 Node-local。
5. Repo 内 workspace Skill / Subagent 随目标 Node 上的 checkout 发现。
6. “复制到其他节点”是显式动作，需要 preview、目标选择和冲突处理；不做后台自动同步。
7. Subagent profile 里引用的是账户 Model Profile 的 model ref，但 profile 文件和 enabled / override
   状态仍属于 Node 或 Workspace。

### 当前实现差距

- SSH / WSL 的 Skills / Plugins 已走远端服务。
- SSH / WSL 的 Subagents 设置服务仍指向 Desktop 本地，而 runtime 读取远端文件；统一架构前必须先消除
  这条 UI / runtime 分裂。
- Plugin 的 `workspace` 字段当前还没有形成完整的 workspace 隔离语义，不能直接当作目标设计已完成。

## Session / Task 聚合

### 不拉取所有 Session 正文

Hub 只聚合 Task Summary；用户打开任务后才从来源 Node 读取 snapshot / conversation page。

```text
Node A sorted TaskSummary page ─┐
Node B sorted TaskSummary page ─┼─ Hub k-way merge ── unified task list
Node C sorted TaskSummary page ─┘

select {nodeId, workspaceId, taskId}
  -> route to origin Node
  -> subscribe continuous / replayable
  -> on-demand session snapshot and rows
```

### 新查询协议

```ts
interface FederatedTaskQuery {
  kind: "timeline" | "workspace" | "pinned" | "archived";
  sortBy: "created" | "updated";
  search?: string;
  workspaceIds?: string[];
  pageSize: number;
  cursor?: string;
}

interface NodeTaskSummaryPage {
  nodeId: string;
  taskIndexRevision: string;
  sessionIndexRevision: {
    logEpoch: string;
    seq: number;
  };
  items: TaskSummary[];
  nextCursor?: string;
}
```

协议要求每个 Node 使用完全相同的 total order。全局 tie-break 必须包含
`nodeId + workspaceId + taskId`，不能继续假设 `taskId` 跨 endpoint 不冲突。

### Running 与历史分页分离

推荐把易变的 running task 从历史 cursor 中拆出：

```text
有界、实时、全量的 running overlay
                 +
稳定 keyset 分页的 terminal / history rows
```

当前排序语义保持：

- running 整体置顶；
- running 内按 `createdAt DESC`，再按全局 Task ref；
- 非 running：
  - created：`createdAt DESC, updatedAt DESC, GlobalTaskRef`
  - updated：`updatedAt DESC, createdAt DESC, GlobalTaskRef`

历史页 cursor 至少绑定：

```text
queryHash
topologyEpoch
nodeId -> taskIndexRevision / sessionIndexRevision / shardCursor
after -> primaryTime / secondaryTime / GlobalTaskRef
```

节点集合或 revision 变化时返回 `cursor-stale` 并刷新，不静默跳项。

### 跨机器时间

MVP 可以沿用 `createdAt / updatedAt`，并以全局 Task ref 做稳定 tie-break；这只能保证确定性，
不能消除机器时钟漂移。

长期建议增加：

```text
ActivityStamp = { physicalMs, logical, nodeId }
```

旧数据迁移为 `{ updatedAt, 0, nodeId }`。Node 握手时交换时钟诊断，严重漂移时在 UI 标记，
不能用 Hub 收到消息的时间篡改历史创建时间。

### 离线

当前 renderer cache 不持久化。Federated Hub 需要一个只读 materialized catalog：

- key：`GlobalTaskRef`
- 内容：Task Summary、membership、tombstone、来源 revision、lastSeenAt
- Node 离线时显示 stale / offline
- 离线目录只允许浏览摘要；打开正文、发送、stop、permission 等命令必须等待来源 Node 在线
- Node 回来后按 revision / tombstone 增量收敛

## “分组”视图

### 两种分组不能混用

1. Workspace 分组：由 `GlobalWorkspaceRef` 派生，任务仍按时间分页。
2. 用户自定义“分组”：是 UI 组织数据，排序来自显式 `sortOrder`，不是 Task 时间。

### 推荐权威

跨 Node 的自定义分组不能把每个 Node 的 `task_groups` 直接求并。推荐由账户级
`FederatedTaskViewProfile` 单一持有：

```ts
interface FederatedTaskViewProfile {
  revision: string;
  groups: Array<{
    groupId: string;
    title: string;
    color: string;
    sortOrder: number;
  }>;
  members: Array<{
    groupId: string;
    task: GlobalTaskRef;
    sortOrder: number;
  }>;
  topLevel: Array<
    | { type: "group"; groupId: string; sortOrder: number }
    | { type: "task"; task: GlobalTaskRef; sortOrder: number }
  >;
}
```

所有成员和顶层节点必须持久化显式顺序；新架构不能再依赖客户端扫描全量后用
`max + 1000` 补序。

因此：

- Timeline 不需要拉全量，走 Node 分页 + Hub k-way merge。
- 自定义 Group 先读取轻量 View Profile，再按可见 `GlobalTaskRef` 向对应 Node 批量取 Summary。
- Group 分页 cursor 使用 `viewRevision + groupId + sortOrder + GlobalTaskRef`。
- Node 离线时成员仍保留，显示离线摘要，不从 Group 自动删除。

### 待裁决

- A Web 与 C Desktop 是否必须共享完全相同的自定义 Group / 手工顺序：
  - 推荐：账户级同步，所有 UI 相同。
  - 可选：Hub-device-local，各 UI 可有不同布局，但不再满足严格的“大一统分组”。

## 身份模型

### 目标

```text
NodeId       = Node 数据目录中一次生成并持久化的 UUID
WorkspaceId  = Node Workspace Registry 中的稳定 UUID

GlobalWorkspaceRef = { nodeId, workspaceId }
GlobalTaskRef      = { nodeId, workspaceId, taskId }
```

- Node URL、hostname、SSH alias、端口、用户名是 connection route，不是 NodeId。
- `workspacePath` 是 Workspace Registry 的可变属性，不是 WorkspaceId。
- `remoteSessionId` 仍是某个 Hub attachment 的短期句柄，不进入全局身份。
- SSH / WSL / Docker / direct URL adapter 在 Node ingress 把旧 `workspaceIdentity` 翻译成
  Node-local WorkspaceId；Node 数据库不应因为访问方式不同产生多套 Task。

渐进式 MVP 可以先用 Node 内规范化路径作为 canonical workspace key，但 RPC 必须先引入
`WorkspaceRef`，给稳定 WorkspaceId 留出升级位置。

### Stable NodeId 前置

当前 HTTP serverId 可能回退 hostname，SSH stdio hello 也没有 serverId。迁移前必须：

1. 在 Node 数据目录生成并持久化 UUID。
2. HTTP、SSH stdio、WSL、Docker bootstrap handshake 返回同一个 NodeId。
3. Hub 检测重复 NodeId；VM 克隆后不得静默把两台机器当成同一 Node。
4. 重装时提供“认领旧 Node”流程，不用 hostname 自动合并。

## 旧数据迁移

### 迁移面

```text
目标 Node
├─ ~/.zcode/v2/tasks-index.sqlite
│  ├─ tasks
│  ├─ task_group_members
│  ├─ task_group_view_node_orders
│  ├─ task_group_workspace_bootstraps
│  ├─ automations
│  └─ automation_runs
├─ ~/.zcode/cli/db/db.sqlite
│  └─ session.workspace_id
├─ ~/.zcode/v2/sessions/<legacyWorkspaceHash>/
├─ workspace config / provider isolation hash directories
└─ Hub / Desktop lastWorkspaceSession 与 connection credentials
```

`messages / parts / todos / targets` 等通过 `session_id` 关联，无需改 workspace key。

### Alias 与 ledger

先上兼容层，再搬数据：

```text
workspace_registry(
  workspace_id,
  canonical_path,
  ...
)

workspace_alias(
  alias_key,
  workspace_id,
  source_kind,
  verified_node_id,
  created_at
)

migration_run(
  migration_id,
  source_alias,
  workspace_id,
  phase,
  error,
  updated_at
)
```

旧客户端继续传 `remote:ssh:*` 时，ingress alias 必须先把它解析到 canonical workspace；
否则迁移后旧客户端会再次写出旧 key。

### 幂等 saga

两个 SQLite 不能跨库事务，迁移必须可恢复：

```text
prepared
   -> task_index_done
   -> session_store_done
   -> files_and_settings_done
   -> verified
```

1. `prepared`
   - handshake 获取稳定 NodeId；
   - 只接受能够证明属于当前 Node 的精确 legacy alias；
   - 校验 identity path 与行内 workspace path；
   - 对两个 WAL 数据库分别做一致性备份；
   - 写 alias 和 migration ledger。
2. `task_index_done`
   - 合并 `tasks`，同步改标量列与 `meta_json`；
   - 更新 group member；
   - 解析并重写 top-level `node_key` 的新旧格式；
   - 更新 bootstrap workspace key，但保留既有 `group_id`、标题、颜色和顺序；
   - 更新 automation / automation run；
   - 不删除旧 alias。
3. `session_store_done`
   - 只更新迁移清单中的精确 `session.id`；
   - 同时验证 `directory == canonicalPath` 和 `old workspace_id == source alias`；
   - 禁止按目录全表更新。
4. `files_and_settings_done`
   - legacy hash 目录先 copy / alias 并校验，不移动或删除原目录；
   - `lastWorkspaceSession` 改为 GlobalWorkspaceRef；
   - SSH 地址和认证信息迁到 Connection Profile，不再混入 workspace identity；
   - 不因为 Task identity 迁移而复制、删除或记录明文 secret。
5. `verified`
   - Task 列表行都能打开对应 Session；
   - Group、pin、archive、deleted、unread、automation 均可对账；
   - 冷启动、本机 Web、TUI、Desktop 远程使用同一 WorkspaceRef；
   - 至少保留一个版本周期的 legacy alias 和备份。

### 冲突

同一 canonical workspace 下出现相同 `taskId` 时：

1. Session 内容摘要相同：视为同一 Task，合并 shell metadata。
2. Session 内容不同：不得覆盖；写入 migration conflict，保留两份并要求人工选择或给其中一份生成
   新 Task identity。
3. 自动字段：
   - `createdAt` 取最早；
   - `updatedAt / unreadAt` 取最新；
   - title 优先用户手工覆盖版本；
   - terminal / model / searchable text 取最新合法 Session 投影。
4. 产品字段不能直接 OR：
   - pinned / archived / deleted 冲突必须按明确的 membership 规则裁决；
   - Group 与顺序冲突必须按 View Profile revision 裁决；
   - 在规则确认前记录 conflict，不自动复活 deleted Task。

### 旧 Group 导入

各 Hub / Node 可能已经有不同的本地 Group 布局。推荐：

- 每个旧布局以独立 `legacyViewOrigin` 导入；
- 不按同名 Group 自动合并；
- 只有一个来源时可直接采用；
- 多来源默认保留为“来自 <设备>”的独立分组，用户确认后再合并；
- Task ref 先经过 workspace alias 映射，再进入账户 View Profile。

## 分阶段落地

### Phase 0：合同、身份和观察能力

- 稳定 NodeId handshake。
- Workspace Registry / WorkspaceRef / alias schema。
- 所有 Task key、日志和诊断改为 GlobalTaskRef。
- 定义 Hub Protocol、Node Protocol、Bootstrap Protocol 和 Resource Transfer Protocol。
- 在协议层引入可信 connection role 与 logical attachment，先不改变现有 transport。
- 先做只读 inventory 和 migration dry-run。

### Phase 1：Node Core 与 Hub Core

- 从 `entry-http` / `entry-stdio` 抽出唯一 Node Core 组合根。
- 实现 local Node single-owner lock、daemon discovery 和 embedded fallback。
- Desktop 改为 app-wide Hub Process，多窗口通过独立 MessagePort attachment 复用。
- Lite 增加逻辑独立的 Hub Core；Browser UI 只连 Hub endpoint。
- 保留现有 per-window Host 作为兼容路径，先做双栈观测，不立即删除。

### Phase 2：统一 bootstrap、tunnel 与资源传输

- SSH / WSL / Docker 只负责安装、启动、升级、发现和连接 Node daemon。
- Direct URL、Browser Web、Desktop 和 TUI 使用同一 Node API。
- SSH 使用 direct-tcpip，WSL / Docker 使用 `zcode node connect` 到 local socket。
- 引入统一 `WorkspaceLeaseManager`，消除三种不同 Host / Agent 回收语义。
- 长文本、图片和外部文件统一进入 Node Resource Store。
- 旧 stdio business server 保留一个兼容周期；compat shim 只做 transport。

### Phase 3：Node API 与聚合目录

- Node Task Summary keyset API。
- Running overlay 与历史分页拆分。
- Hub k-way merge、拓扑 epoch、持久离线 catalog。
- 打开 Task 时按来源 Node 路由；conversation delivery 语义不变。

### Phase 4：模型与 Extension 作用域

- 拆 ProviderCatalog 与 Credential Binding。
- Account Model Profile revision 同步。
- Node readiness。
- 修正 SSH / WSL Subagent UI / runtime 分裂。
- Extension Settings 增加 Node selector。

### Phase 5：Federated Group

- Account View Profile。
- 旧 Group dry-run / import / conflict UI。
- 所有 sortOrder 权威持久化。
- 分组成员按 GlobalTaskRef 查询。

### Phase 6：旧数据迁移和旧链路退出

- 两库 migration saga。
- 文件 hash alias。
- Desktop history / credential route 拆分。
- 灰度读双写单、校验、回滚和版本期后清理。
- 删除 `entry-stdio -> createLocalServices()` 远端主路径。
- 删除 per-window SSH / Docker business Host；保留 bootstrap / tunnel adapter。

## Case Planning

### 主要维度

| 维度       | 代表值                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| UI         | Browser Web / Desktop / Mobile remote                                            |
| Node       | local / direct server / SSH bootstrap / offline                                  |
| delivery   | desktop-continuous / browser-replayable / mobile-remote-replayable               |
| transport  | MessagePort / direct WSS / SSH tunnel / WSL connector / Docker connector / relay |
| config     | Profile current / Node stale / missing credential                                |
| task state | running / terminal / archived / deleted                                          |
| list       | timeline / workspace / pinned / grouped                                          |
| resource   | long-paste file / image / browser File / mobile attachment                       |
| migration  | clean / duplicate alias / same task same content / same task divergent           |

### 首批候选 cases

| ID     | Setup                                                | Action                         | Assertion                                                                         | 状态             |
| ------ | ---------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- | ---------------- |
| FED-01 | A Web 连接 Node A/B，C Desktop 连接 A/B/C            | 各 Node 创建 Task              | 两个 UI 都以 GlobalTaskRef 展示，不因 taskId / path 相同去重错误                  | accepted         |
| FED-02 | 三个 Node 各有多页 terminal Task 和 running Task     | 滚动 timeline                  | running overlay 置顶；历史 k-way merge 不重不漏；不拉正文                         | proposed         |
| FED-03 | Node B 离线，Hub 有旧目录缓存                        | 打开统一列表                   | B 的 Task 显示 stale/offline；命令被阻止；A/C 可正常操作                          | proposed         |
| FED-04 | Account Profile revision N，Node B 仍是 N-1          | 在 B 新建 Task                 | 先同步到 N；缺 credential 时明确阻止，不静默换模型                                | proposed         |
| FED-05 | A/B 的 Skill / Plugin / Subagent 不同                | 在 B 的 Task 打开候选菜单      | 只展示 B workspace + B node inventory；全局矩阵不参与执行                         | accepted         |
| FED-06 | Account Group 跨 A/B Task                            | A Web 拖拽排序，C Desktop 刷新 | 两端按同一 View Profile revision 收敛                                             | pending-decision |
| FED-07 | 旧 SSH alias 与新 Node WorkspaceRef 指向同一数据     | 运行迁移并冷启动               | Task、Session、Group、automation 可对账；旧 alias 不再产生新行                    | proposed         |
| FED-08 | 两个旧 alias 有同 taskId、不同 Session 内容          | 运行迁移                       | 不覆盖；生成 conflict，原数据和备份均保留                                         | proposed         |
| FED-09 | 手机附着 C Desktop Hub                               | 切换查看 A/B/C Task            | 只使用已有 attachment；不新建 Node runtime；replayable 恢复边界不变               | accepted         |
| FED-10 | Node B 已由 Lite 启动，Desktop 又通过 SSH 发现 B     | Desktop 连接同一 workspace     | 复用同一 NodeId / WorkspaceId；不创建第二个 Server、Task Index 或 Agent owner     | proposed         |
| FED-11 | Desktop 与 Browser 同时操作 Node A 的同一 Task       | 两端订阅并发送                 | logical connection 隔离；continuous / replayable 各自恢复；命令进入同一 CLI inbox | proposed         |
| FED-12 | Node B running task，SSH tunnel 断开                 | Hub 重连 tunnel                | Node / Agent 不因 tunnel 断开退出；按新 bootId / logEpoch 恢复或明确失败          | proposed         |
| FED-13 | Docker 未暴露端口                                    | Desktop 连接容器               | `docker exec` connector 只转发 local socket；业务 RPC 与 direct WSS 同 schema     | proposed         |
| FED-14 | Desktop 长文本转文件、Browser 拖图片到 Node B        | 发送 prompt                    | 资源先 commit 到 B Resource Store；prompt 只含 B 的 ResourceRef；Agent 可读       | proposed         |
| FED-15 | 手机连接 Hub C，Node B 离线                          | 打开 B 历史 Task               | 只展示 stale summary；不由手机触发 SSH / Docker bootstrap                         | accepted         |
| FED-16 | Lite Node 与 Desktop embedded Node 竞争同一 data dir | 两端并发启动                   | single-owner lock 保证一个 Node owner，另一端发现并连接或明确失败                 | proposed         |
| FED-17 | 普通 Browser 伪造 desktop clientMode                 | 建立 Node 连接                 | Node 忽略客户端自报值，按认证 role 注入 replayable profile                        | accepted         |

### 剪枝

- 不做 UI × Node × delivery × 所有 Task state 的全排列；Task Summary 终态由 Node API 合同证明，
  Desktop / Web 只各取一个聚合代表。
- Skill、Plugin、Subagent 各取一个候选隔离代表；共同不变量是 Node capability authority。
- SSH / WSL / Docker 不分别复制业务聚合 case；只在 bootstrap / identity migration 层取代表。
- Conversation queue / fork / compact 不与列表分页叉乘；它们仍由来源 Node 的现有协议覆盖。
- 手机不测试创建独立 Hub / Node，因为产品合同明确禁止。

## 影响面

### must-inspect

- `packages/shared/src/remote-workspace-identity.ts`
- `packages/shared/src/remoteTarget.ts`
- `packages/shared/src/zcode-protocol/index.ts`
- `packages/services/src/session/taskIndexRepo.ts`
- `packages/services/src/session/automationRepo.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/`
- `packages/ui/src/hooks/useWorkspaceTaskLists.ts`
- `packages/ui/src/hooks/useGlobalTaskList.ts`
- `packages/ui/src/hooks/useGroupedTaskView.ts`
- `packages/ui/src/lib/buildGroupedTaskViewFromSessions.ts`
- `packages/ui/src/lib/taskListMembershipSets.ts`
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`
- `packages/desktop/src/main/desktopRemoteSessions.ts`
- `packages/desktop/src/main/desktopHostProcess.ts`
- `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts`
- `packages/desktop/src/host/serverRemoteConnection.ts`
- `packages/server/src/entry-http.ts`
- `packages/server/src/entry-stdio.ts`
- `packages/server/src/http.ts`
- `packages/server/src/remote/connect.ts`
- `packages/server/src/remote/create-backend.ts`
- `packages/server/src/remote/ssh-backend.ts`
- `packages/server/src/remote/wsl-backend.ts`
- `packages/server/src/remote/docker-backend.ts`
- `packages/services/src/node.ts`
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- `scripts/build-zcode-lite.mjs`

### should-inspect

- Model Provider storage / registry / remote sync
- Skill / Plugin / Subagent discovery and sync
- `lastWorkspaceSession` 与 Connection Profile persistence
- Web remote workspace list snapshot
- Hub persistent cache、search、pin / archive membership
- Node daemon supervisor、single-owner lock 与 bootId
- Hub / Node connection capability、logical attachment multiplex
- Resource Store 的配额、断点续传、janitor 和跨 Node 防误用

### invariant-only

- V4 Session runtime / conversation projection
- owner / lease / queued command
- Desktop continuous 与 Mobile replayable
- relay / desktop main 的纯透传边界
- V4 CommandInbox、command ACK/query、owner/lease 和 connection-scoped subscription

## Proposed Feature Graph Delta

在产品语义确认后再更新 feature graph，建议新增：

- `capability.federated-node-hub`
- `capability.unified-node-runtime`
- `state.account-model-profile`
- `state.node-capability-manifest`
- `state.federated-task-view-profile`
- `service.hub-core`
- `service.node-core`
- `service.node-bootstrap`
- `service.node-resource-store`
- `service.logical-attachment-multiplexer`
- `service.node-workspace-registry`
- `service.federated-task-query`
- `persistence.workspace-alias-ledger`
- `persistence.hub-task-summary-catalog`
- `boundary.browser-replayable`
- `boundary.mobile-remote-replayable`
- `invariant.global-task-ref`

## 待用户裁决

1. 自定义 API Key 是否跨端 E2E 同步，还是只同步模型 metadata、Secret 保持 Node-local？
2. A Web 与 C Desktop 的自定义 Group / 手工顺序是否必须完全一致？
3. Node 离线时，是否要在重启 UI 后继续显示上次 Task 摘要，还是只显示“Node 离线”？
4. 同一旧 Task 的 pin / archive / deleted 冲突，是否采用 `deleted > archived > pinned > normal`
   的保守优先级？
5. Node 数据目录被克隆导致 NodeId 重复时，是否默认把新发现机器视为克隆并强制生成新 NodeId？
6. Node daemon 是否默认独立于 UI 长期运行：
   - 推荐：Lite / 手动安装 Node 长期运行；Desktop embedded fallback 随 App 生命周期；
   - 另一方案：所有 bootstrap Node 都在无 task / lease 后按 idle policy 退出。
7. Lite Hub 是否允许像 Desktop Hub 一样注册手机 relay device role：
   - 推荐：允许，但必须用户显式开启；手机仍不能直接 bootstrap 新 Node。
8. Browser Web 是否固定使用 replayable delivery：
   - 推荐：是；Browser tab 会刷新、休眠和断网，不应伪装成 Desktop continuous。
9. Hub 是否允许依据预授权 Connection Profile 自动恢复离线 Node：
   - 推荐：Desktop / Lite Hub 可以按设备策略恢复；手机 attachment 本身无权创建或修改该策略。

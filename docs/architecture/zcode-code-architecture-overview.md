# Z Code 代码架构总览（当前事实）

> 本文是进程与分层架构的当前入口。历史方案和迁移计划不能覆盖本文口径。

## 一句话模型

Z Code 可以运行多个 workspace window；每个窗口有且只有一个 Window Host，每个 workspaceKey 最多一个聊天 CLI。Renderer 只通过 service/protocol 边界访问能力；CLI 持有 conversation 的权威状态。远程 workspace 的连接和 scoped services 也由该窗口的同一个 Host 管理。

```text
Electron App
├─ Main Process（调度/原生能力/attachment 中转）
└─ Workspace Window（每个窗口独立一组）
   ├─ Renderer
   └─ Window Host（唯一 PID）
      ├─ LocalSource
      │  ├─ workspaceKey A ── stdio ── zcode-cli A
      │  └─ workspaceKey B ── stdio ── zcode-cli B
      ├─ RemoteConnectionRegistry
      │  ├─ SSH / WSL pooled connection
      │  ├─ Docker / Server dedicated connection
      │  └─ remoteSessionId -> workspaceKey scoped services
      ├─ ControllerProjection（workspace/task 列表事实）
      └─ AttachmentRegistry
         ├─ desktop-continuous
         └─ web-remote-replayable
```

窗口、Host、connection 和 workspace 不是同一层级：窗口 Host 按 workspaceKey 隔离本地 CLI，并在进程内维护远端 connection 与 logical session。SSH 在同一窗口、同一标准化 target 下共享一条连接和一个远端 `zcode-server`；WSL 按 normalized distro/user 共享连接并保留既有 60 秒 idle TTL/running-task protection；Docker、Server 保持 dedicated connection。所有 transport 仍保留独立 `remoteSessionId`、attachment 和 workspaceKey，连接复用不等于 workspace 身份合并。

## 进程职责

### Main Process

只做平台调度：窗口生命周期、native dialog、external URL、OAuth callback、唯一窗口 Host Process 的监督、远端连接控制请求与 MessagePort/broadcast/远控 attachment 薄转发、日志接收。Main 不拥有连接池、logical session lifecycle、task projection、row、stream、queue、snapshot、goal 或 interaction 状态；`remoteSessionId` 由 Window Host 分配。

### Renderer

负责 React UI、路由、布局以及草稿/滚动/焦点等本地状态；通过 hooks/service proxy 和 V4 transport 发意图；订阅 snapshot/delta 渲染 projection。Renderer 不直接调用 Repo/Node/CLI，也不维护第二份权威 conversation。

### Host Process

由 `createLocalServices({ parentPort })` 初始化窗口本地服务，并在同一进程中维护 `RemoteConnectionRegistry`、`ControllerProjection` 与 `AttachmentRegistry`。Host 按 workspaceKey 选择或启动本地 CLI，或把 scoped facade 路由到远端权威 service；列表 membership、在线/运行/等待事实与列表写路由由 Controller 持有，但 Host 不替 CLI reducer 拼 conversation rows、stream、permission 或 runtime snapshot。

一个窗口只注册一个 realtime `hostId`。每个 attachment 独立持有可信 `clientMode`、订阅、seq、背压和 dispose；关闭一个 attachment 不销毁仍有其他 owner 的 connection。远端断连保留最后可信 task 投影并标记 offline，所有 IO/mutation fail-closed，禁止回落本地；重连后由新 source snapshot 原子替换。

真实窗口关闭、app quit 和 update install 只等待该窗口唯一 Host；Host 内部对 attachment、远端 registry 和本地 services 做有界释放。手机 attachment 断开只释放 attachment，不进入 Host shutdown 屏障。

### zcode-cli

每个 workspaceKey 最多一个聊天 CLI 进程。CLI 承载 session/core runtime、V4 command inbox、幂等/CAS 裁决、ProductProjection reducer、conversation topic、queue、goal、interaction、tool 与模型运行态。

## Workspace Identity

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

- 身份/隔离使用 workspaceKey：CLI 映射、session 绑定、缓存、队列、持久化与跨进程关联。
- 文件执行使用 workspacePath：cwd、文件读写、Git 和路径展示。
- SSH/WSL/Docker 必须传递 `workspaceIdentity`；远控同时贯穿 `remoteSessionId`。

不得用相同远端路径推导相同 workspace 身份，也不得在业务代码手写 remote identity 格式。

## Monorepo 分层

| 模块                | 职责                                                     |
| ------------------- | -------------------------------------------------------- |
| `packages/shared`   | 跨进程类型、V4 schema、workspace identity 与平台契约     |
| `packages/rpc`      | Channel RPC、MessagePort/WebSocket transport、日志中间件 |
| `packages/services` | Host 业务服务接口和 Node 实现                            |
| `packages/client`   | service proxy 与客户端 transport 装配                    |
| `packages/ui`       | 平台无关 React UI、hooks、V4 projection store            |
| `packages/desktop`  | Electron main/preload/renderer/host 壳                   |
| `apps/zcode-cli`    | Agent core、command、projection 与 app-server            |

```text
UI -> hooks/types -> service/protocol contracts
Host services -> adapters/interfaces -> runtime implementations
Desktop/Web shells -> dependency injection -> shared UI
```

禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入非 Types 模块或形成循环依赖。

## Conversation 数据流

```text
UI command
  -> Host transport
  -> workspace CLI command inbox
  -> core events
  -> ProductProjection
  -> snapshot/delta
  -> SessionDataLayer
  -> ConversationProjectionStore
  -> UI rows/status/composer
```

desktop 和 mobile 共享这条事实链。差别只在 delivery profile：桌面是 continuous；手机是 replayable，并在 gap 时 snapshot 恢复。relay/Main 不能下沉业务状态。

## 平台抽象与 UI 规则

- UI 通过 `IPlatformService` 访问目录选择、外链等平台能力。
- 组件通过 `useServices()`、`usePlatform()` 等 hooks 获取依赖，不直接使用 `window.zcode` 或 service 单例。
- Desktop/Web/Mobile 差异通过装配和依赖注入处理，不在共享组件里硬编码平台分支。

## 当前事实入口

- [通信协议分层](./communication-protocol-layers.md)
- [ZCode Protocol](../zcode-protocol.md)
- [Message Flow](./message-flow.md)
- [Web Remote Control Architecture](../web-remote-control/web-remote-control-architecture.md)
- [Task Realtime Sync](../web-remote-control/task-realtime-sync.md)
- [Chat Message Queue](../ui/chat-message-queue.md)

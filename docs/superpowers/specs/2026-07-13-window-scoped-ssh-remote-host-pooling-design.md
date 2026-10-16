# 窗口级 SSH Remote Host 共享设计

## Feature Summary

| Field | Value |
| --- | --- |
| Change | 将 Desktop SSH remote workspace 从“一 workspace 一 Remote Host”调整为“同一 Electron 窗口内，同一 SSH 连接配置共享一个 Remote Host”。 |
| User-visible surfaces | SSH 连接、远程目录选择、远程 workspace tab、断线与重连、Renderer reload、手机 `/remote` 进入 SSH workspace。 |
| Existing docs | `docs/architecture/zcode-code-architecture-overview.md`、`docs/architecture/message-flow.md`、`docs/remote-workspace-session-unified-settings.md`、`docs/ssh-remote-app-global-state-authority.md`、`docs/web-remote-control/web-remote-control-architecture.md`、`docs/web-remote-control/task-realtime-sync.md`、`docs/web-remote-control-task-command-queue.md`、`docs/remote/desktop-remote-session-renderer-reattach.md`。 |
| Existing code owners | `packages/desktop/src/main/desktopRemoteSessions.ts`、`packages/desktop/src/main/desktopHostProcess.ts`、`packages/desktop/src/host/index.ts`、`packages/desktop/src/renderer/src/main.tsx`、`packages/ui/src/store/remoteWorkspaceSessionStore.ts`、`packages/ui/src/root/useRemoteWorkspaceHistory.ts`、`packages/ui/src/root/useRemoteWorkspaceTabLifecycle.ts`。 |
| Out of scope | WSL/Docker Host 共享、跨 Electron 窗口共享、SSH Profile 数据模型、Host 级断开 UI、远端常驻 Daemon、App 冷启动自动重连。 |

## 背景与当前问题

当前 Desktop 本地窗口只创建一个 Local Host。一个 Local Host 内的 `ZCodeAgentService` 按
`workspaceKey` 管理多个 Agent 进程，因此同一窗口内的多个本地 workspace 共享 Host 进程。

SSH remote workspace 当前不同：`createRemoteWorkspaceSession()` 每次都会生成新的
`remoteSessionId`，fork 一个新的 Remote Workspace Host，建立一条新的 SSH 连接，并在远端启动一个新的
`zcode-server`。即使两个 workspace 使用完全相同的 SSH 登录配置，也会重复执行 SSH 握手、远端环境探测、
资源部署检查和 server 启动。

当前实现把三种身份耦合在一起：

```text
remoteSessionId
  = workspace 的 Renderer RPC 路由身份
  = Main 侧 Remote Host 进程身份
  = Web Remote Control shared-host attachment 的查找身份
```

远端 `zcode-server` 本身并没有“一进程只能服务一个 workspace”的限制。它通过
`createLocalServices()` 创建的 `ZCodeAgentService`、`ZCodeSessionService`、task index 和 provider registry
状态都已经按 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 隔离。真正需要调整的是 Desktop
Main 的 Host/session 生命周期和 MessagePort 路由，而不是重写远端 Agent 协议。

## 目标

- 同一 Electron 窗口内，使用同一标准化 SSH 连接配置的多个 remote workspace 只创建一个 Remote Host。
- 一个共享 Remote Host 只持有一条 SSH 连接并只启动一个远端 `zcode-server`。
- 每个 workspace 继续拥有独立 `remoteSessionId`、MessagePort、`workspaceIdentity` 和 `workspaceKey`。
- 关闭或移除 workspace 时只解除 workspace session 和 RPC attachment；即使绑定数归零，ready Host 仍缓存到窗口关闭。
- Host 意外断开时，所有关联 workspace 一起进入断开状态。
- 用户对任一关联 workspace 发起重连时，恢复同窗口内使用同一 SSH 配置且仍打开的全部 workspace。
- Host 级连接失败整体失败；Host ready 后的路径、Provider Registry 和 Agent 初始化按 workspace 独立成功或失败。
- 保持 Desktop `desktop-continuous` 与手机 `web-remote-replayable` 的现有边界。
- 保持远程 workspace 的 `workspaceIdentity` 隔离规则和实际 `workspacePath` 执行语义。

## 非目标

- 不跨 Electron 窗口共享 Remote Host。
- 不修改 WSL、Docker 的“一 workspace 一 Host”模型。
- 不新增 SSH Profile ID，不迁移现有 remote workspace 历史或凭据存储结构。
- 不新增用户可见的 Host 级“断开 SSH 配置”入口。
- 不把远端 `zcode-server` 改造成监听端口或 Unix socket 的常驻 Daemon。
- 不持久化 Host pool、Host readiness、attachment 或 `remoteSessionId`。
- 不在 App 冷启动时自动连接 SSH。
- 不修改 App 与 Agent 之间的 `@zcode/protocol`。
- 不改变 task、stream、queue、snapshot、permission、elicitation 或 owner/lease 的产品语义。
- 不把 task/session/realtime 业务状态下沉到 Desktop Main 或 Relay。

## Clarification Log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | Host 共享范围是窗口内还是 App 全局？ | 同一 Electron 窗口内。 | 不跨窗口共享。 | no |
| 2 | 最后一个 workspace 关闭后是否销毁 Host？ | 缓存到窗口关闭。 | ready Host 允许零 workspace 绑定。 | no |
| 3 | 显式断开共享 SSH 配置是否影响全部 workspace？ | 接受全部断开。 | Host 级 dispose 会关闭全部关联 session。 | no |
| 4 | 是否引入独立 SSH Profile ID？ | 不引入，使用标准化连接字段。 | 本期不修改配置和凭据数据模型。 | no |
| 5 | `remoteSessionId` 是 Host 级还是 workspace 级？ | 每个 workspace 保持独立 `remoteSessionId`。 | 新增内部 Host 共享维度，不重定义现有 session 语义。 | no |
| 6 | Host 断线后重连一个 workspace 是否恢复同组其他 workspace？ | 自动恢复同窗口内同配置、仍打开的全部 workspace。 | 重连按 Host 组编排。 | no |
| 7 | Host ready 后某个 workspace 初始化失败是否回滚全部？ | 不回滚，按 workspace 独立成功或失败。 | Transport failure 与 workspace initialization failure 分层处理。 | no |
| 8 | 是否同时共享 WSL/Docker Host？ | 仅 SSH。 | WSL/Docker 保持现状。 | no |
| 9 | 本期是否新增 Host 级断开 UI？ | 不新增。 | 仅窗口关闭、内部 dispose 或异常断线销毁 Host。 | no |
| 10 | 精简后的 Host pool/pending connect/attached session 三事实源模型是否接受？ | 接受。 | 删除可派生的反向索引和重复 key。 | no |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 共享范围 | `(windowWebContentsId, remoteHostKey)` 唯一确定一个 SSH Host。 | 同窗口同配置 workspace。 | 跨窗口 Host。 | user |
| Host 生命周期 | ready Host 缓存到窗口关闭。 | 零 workspace 的 idle Host。 | last-session-close dispose。 | user |
| Session 身份 | `remoteSessionId` 继续按 workspace 独立。 | 独立 RPC port、缓存和 mobile route。 | Host 级共享 session ID。 | user |
| Workspace 隔离 | `workspaceKey = workspaceIdentity?.trim() || workspacePath`。 | Agent/provider/task/cache 隔离。 | 仅按 `workspacePath` 匹配。 | project invariant |
| 重连 | 一个 workspace 发起后恢复同组仍打开 workspace。 | 一次 Host 建连，多 workspace attachment。 | 逐个手工重连。 | user |
| 部分失败 | Host ready 后按 workspace 独立。 | Provider/path/Agent 初始化错误。 | 任一失败整体回滚 Host。 | user |
| Remote kind | 仅 SSH 进入 Host pool。 | SSH password/private-key/agent auth。 | WSL/Docker。 | user |
| UI | 不新增 Host 级断开入口。 | 现有 workspace/tab 行为。 | 新 UI 和样式。 | user |
| 持久化 | Host pool 纯内存。 | 现有 remote workspace history。 | Host/Profile schema migration。 | design |
| 协议 | 只调整 Desktop 内部 channel/platform 消息。 | Main ↔ Host、Renderer ↔ Main。 | `@zcode/protocol`。 | architecture |

## Domain Scope

| Domain | Include? | Why it can change behavior | Primary sources |
| --- | --- | --- | --- |
| Architecture/process boundary | yes | Main、Remote Host、Renderer MessagePort 与远端 server 的进程所有权发生变化。 | `docs/architecture/zcode-code-architecture-overview.md`、`docs/architecture/message-flow.md` |
| Workspace identity/remote runtime | yes | Host 共享不能削弱 `workspaceIdentity/workspaceKey` 隔离。 | `docs/remote-workspace-session-unified-settings.md`、`docs/ssh-remote-app-global-state-authority.md` |
| Mobile remote/replayable realtime | yes | 多个逻辑 session 将 attach 到同一进程，必须保留 mobile replayable 边界。 | `docs/web-remote-control/web-remote-control-architecture.md`、`docs/web-remote-control/task-realtime-sync.md` |
| Model/provider/runtime config | yes | Registry 内容同源，但远端 applied revision 仍按 workspaceKey。 | `docs/ssh-remote-app-global-state-authority.md` |
| Queue/task command | limited | 不改变 queue 语义，只验证 owner/lease 和 command 路由不跨 workspace。 | `docs/web-remote-control-task-command-queue.md` |
| Persistence/index/snapshot | limited | Host pool 不持久化，现有 workspace history 保持兼容。 | `docs/remote-workspace-session-unified-settings.md` |
| Conversation/session behavior | no | 不修改 session 消息、compact、fork、goal、queue 或 snapshot 内容。 | existing protocol docs |
| UI shell/theme/locale | no | 不新增 UI。 | user decision |

## High-Risk Cross-Products

| Cross-product | Candidate risk | Handling |
| --- | --- | --- |
| Host pool × workspace identity | 同一路径不同 SSH 主机串用 services。 | `remoteHostKey` 只决定进程复用；每次调用继续携带 workspaceIdentity。 |
| Host pool × Renderer reload | 一个 Host 重挂多个 session 时覆盖 renderer store。 | 每个 session 独立 MessagePort 和 remoteSessionId。 |
| Host pool × mobile replayable | 手机通过 session A 访问 workspace B。 | attach 同时校验 remoteSessionId、window owner 和 workspaceIdentity/workspaceKey。 |
| Host pool × realtime scope | Host 收到不属于已绑定 workspace 的事件。 | scope 从 attached session context 实时派生并更新 TaskRealtimeBus。 |
| Host pool × provider registry | 一个 workspace 的 applied revision 被另一个 workspace 复用。 | 远端 registry 和 revision 继续按 workspaceKey 存储。 |
| Host pool × cancel | 一个连接尝试取消误杀其他并发等待者。 | pending connect 独立；只有全部等待者取消且 Host 仍 connecting 时才销毁。 |
| Host pool × stale exit | 旧 Host exit 回调误删新 Host。 | 删除前比较当前 pool entry/process 对象身份。 |
| Host pool × window lifecycle | 一个窗口关闭误杀另一窗口同 key Host。 | pool key 强制包含 windowWebContentsId。 |
| Host pool × credentials | 同 key workspace 保存不同密码。 | 已连接 Host 继续复用；重新建连使用发起者本次提供的有效凭据。 |

## Concept Map

| Concept | Why it matters | Source |
| --- | --- | --- |
| `createRemoteWorkspaceSession()` | 当前每次调用都 fork 一个 Host，是本次重构入口。 | `packages/desktop/src/main/desktopRemoteSessions.ts` |
| `AttachServicePort` | 已支持把新 RPC port 暴露到现有 `activeServices`，是共享 Host 的基础。 | `packages/desktop/src/host/index.ts` |
| `activeServices` | 一个 Host 内的共享混合 ServiceCollection。 | `packages/desktop/src/host/index.ts` |
| `createRemoteWorkspaceServiceCollection()` | 组合本地 app-global service、远端 service 和 wrapper。 | `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` |
| `connectRemote()` | 一次 SSH backend、远端 server stdio 与 RPC client 的完整连接。 | `packages/server/src/remote/connect.ts` |
| `createLocalServices()` | 远端 server 的多 workspace service owner。 | `packages/services/src/node.ts` |
| `ZCodeAgentProcessManager` | 已按 workspaceKey 复用/隔离 Agent 进程。 | `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` |
| `remoteWorkspaceSessionStore` | Renderer 按 remoteSessionId 注册 services，再按 identity/path 绑定 workspace。 | `packages/ui/src/store/remoteWorkspaceSessionStore.ts` |
| `webRemoteControlSharedHostAttachments` | 手机 attachment 需要从逻辑 session 找到共享进程。 | `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts` |
| `TaskRealtimeBus` | Host delivery scope、owner/lease 与 session route 的 Main 侧路由器。 | `packages/desktop/src/main/taskRealtimeBus.ts` |
| `buildRemoteWorkspaceIdentity()` | authority + canonical path 的 workspace 身份。 | `packages/ui/src/lib/remoteWorkspaceHistory.ts` |

## State Owners

| State / fact | Authority | Mirrors / caches | Evidence |
| --- | --- | --- | --- |
| 窗口内 SSH Host 是否存在 | Desktop Main Host pool | none | pool entry + child process |
| Host readiness | Host pool entry `readiness` | pending connect waiters | `Connected`/`Error`/exit |
| pending connect | Desktop Main pending connect map | UI loading state | requestId cancel/result |
| logical remote session | Desktop Main attached session map | Renderer `sessionsById`、tab remoteSessionId | RemoteServicePort payload |
| RPC attachment | Remote Host attachment map | Main session `attachmentId` | Attach/DetachServicePort |
| workspace context | Renderer tab/history, bound into Main session | Host realtime scope | workspacePath + workspaceIdentity |
| workspace isolation key | `resolveWorkspaceKey(context)` | Agent/task/provider maps | workspaceKey |
| remote Agent process | 远端 `ZCodeAgentProcessManager` | process lifecycle reports | process by workspaceKey |
| Provider registry applied revision | 远端 workspace runtime | UI sync coordinator | appliedProviderRevision by workspaceKey |
| task/session/stream state | 远端 Agent/session services | desktop projection/mobile replay mirror | protocol events/snapshots |

## Identity Model

### `remoteHostKey`

新增共享纯函数：

```ts
buildSshRemoteHostKey(target: SSHConnectOptions | SSHRemoteTargetSnapshot): string
```

推荐编码语义：

```text
ssh:v1:
  normalizedHost
  + effectivePort
  + trimmedUsername
  + authKind(password | private-key | agent)
  + normalizedPrivateKeyPath
```

规则：

- host trim 后按 ASCII lowercase；端口缺省为 `22`。
- username trim 后保留大小写。
- private key path 使用浏览器安全且根感知的词法规范化：trim、统一分隔符、清理尾部分隔符，并规范 Windows drive letter 大小写。Windows drive root（`C:/`）、UNC share root（`//server/share/`）和 POSIX root（`/`）必须作为不可被 `..` 弹出的根处理；相对路径保留无法消解的前导 `..`，`~` 不视为可被 `..` 消解的普通目录。
- shared key builder 不展开 `~`、不调用 realpath，也不解析软链；Main 和 Renderer 必须对同一份持久化文本得到相同 key。等价路径文本不同只会产生保守的“不复用”，不能产生错误复用。
- password 与 private key passphrase 的内容禁止进入 key、日志或持久化 Host 索引。
- `workspacePath`、`workspaceIdentity`、`remoteSessionId` 不进入 key。
- `assetInstallMode` 只影响首次部署策略，不进入连接身份。
- `resourcePackages` 是历史输入，当前部署忽略，不进入 key。
- `sshConfigAlias` 名称不作为身份；当前 backend 使用 alias 展开后的有效连接字段。两个 alias 的有效字段一致时复用同一 Host。

### `remoteSessionId`

`remoteSessionId` 继续表示一个 workspace 的 Renderer/Main 逻辑路由句柄：

```text
workspace A -> remoteSessionId A --┐
                                   ├-> shared Remote Host
workspace B -> remoteSessionId B --┘
```

它不再等价于 Host 进程 ID，但外部语义保持不变。

### `workspaceKey`

所有身份/隔离语义继续统一使用：

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

实际文件、Git、terminal 和 command cwd 继续使用 `workspacePath`。

## 精简状态模型

Host pool 不维护可派生的 `sessionIds` 或 `workspaceKeys` 反向集合，避免多事实源同步。

```ts
type RemoteSshHostReadiness =
  | {
      kind: "connecting";
      promise: Promise<void>;
    }
  | {
      kind: "ready";
    };

interface RemoteSshHostEntry {
  process: ElectronUtilityProcess;
  target: SanitizedSshTarget;
  readiness: RemoteSshHostReadiness;
  taskRealtimeHostId?: string;
}

interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface PendingRemoteConnect {
  host: RemoteSshHostEntry;
  context?: RemoteWorkspaceContext;
}

interface AttachedRemoteWorkspaceSession {
  host: RemoteSshHostEntry;
  attachmentId: string;
  context?: RemoteWorkspaceContext;
}
```

权威索引：

```ts
sshHostsByPoolKey: Map<
  `${windowWebContentsId}\0${remoteHostKey}`,
  RemoteSshHostEntry
>;

pendingConnectsByRequestId: Map<string, PendingRemoteConnect>;

attachedSessionsById: Map<
  string, // remoteSessionId
  AttachedRemoteWorkspaceSession
>;
```

字段约束：

- pool key 已包含 window 和 remoteHostKey，value 不重复保存。
- attached session 直接引用 Host entry，不新增第二套 `remoteHostId` 映射。
- TaskRealtimeBus 需要进程 ID 时复用 `spawnHostProcess()` 已生成的 `hostId`。
- `workspaceKey` 永远从 context 派生，不保存副本。
- pending 与 attached 分库存放，集合本身表达状态，不再保存 session `state`。
- `target` 只保存不含 password/privateKeyPassphrase 的描述；完整 secret 只用于启动 Host。
- Host 失败、scope 更新等低频操作通过扫描 `attachedSessionsById` 派生关联 session/workspace 集合。
- `connectRemote()` 缺少外部 requestId 时由 Main 生成内部 connectAttemptId；精确取消使用外部 requestId，旧调用的窗口级取消通过扫描该窗口 pending attempts 保持兼容。

## 方案比较

### 方案 A：Main 维护窗口级 SSH Host pool（采用）

保留现有 Remote Host 和远端 stdio server，在 Main 中拆开 Host 与 logical session。

优点：

- 直接复用现有 `AttachServicePort` 和远端多 workspace 能力。
- 不引入远端监听端口或 Daemon。
- `remoteSessionId`、Renderer store 和 mobile route 语义基本不变。
- 共享范围、窗口生命周期和故障域清晰。

代价：

- Main 需要管理 Host pool、pending connect 和 session attachment。
- Host 内部需要显式 Detach RPC port。
- UI 重连协调器需要按 remoteHostKey 批量恢复。

### 方案 B：一个窗口一个 Remote Broker Host（不采用）

让一个本地 Host 进程管理多个 SSH target 和多套 ServiceCollection。

不采用原因：Host 内需要新增连接路由、故障隔离和多 service graph，显著扩大进程职责和回归面。

### 方案 C：远端常驻 `zcode-server` Daemon（不采用）

多个本地 Host 通过远端 socket/port 连接同一个 server。

不采用原因：需要远端鉴权、监听地址、版本升级、孤儿进程回收和安全设计，超出当前目标。

## 组件职责

### Shared：SSH Host key

提供 `buildSshRemoteHostKey()` 及其规范化 helper。Desktop Main 与 UI 重连分组必须复用同一实现，禁止各自拼接。

### Desktop Main：Host pool 与 logical session

建议从 `desktopRemoteSessions.ts` 抽出聚焦的 `remoteSshHostPool` 组件，负责：

- `getOrCreateHost()`
- `reservePendingConnect()`
- `attachSession()`
- `detachSession()`
- `bindSessionContext()`
- `disposeHost()`
- `disposeWindow()`

`desktopRemoteSessions.ts` 继续负责 BrowserWindow/IPC 适配、session-closed 通知、WSL/Docker 旧路径以及 Bot/Web Remote Control 桥接。

### Remote Host：共享 ServiceCollection 与 attachment registry

SSH 共享路径新增内部消息：

```ts
InitRemoteSshHost
AttachServicePort { attachmentId }
DetachServicePort { attachmentId }
```

`InitRemoteSshHost` 只建立 SSH、执行部署检查、启动远端 `zcode-server` 并创建一次共享 ServiceCollection。它不绑定 workspace，也不把初始化端口作为第一个 workspace 的特殊通道。

Host ready 后，所有 logical session 一律走 `AttachServicePort`。Host 内维护：

```ts
attachedServicePorts: Map<string, ExposedServicePortHandle>;
```

`DetachServicePort` 精确释放对应 ChannelServer、protocol 和订阅；重复 detach 幂等。

### Renderer/UI：workspace binding 与批量重连

Renderer 继续按 remoteSessionId 注册独立 remote services。建议新增明确的平台操作：

```ts
bindRemoteWorkspaceSessionContext({
  remoteSessionId,
  workspacePath,
  workspaceIdentity,
}): void;
```

调用发生在 canonical path 和 workspaceIdentity 确定后、Provider Registry 同步和 connected 状态提交前。

当前 session context 绑定间接复用 `syncWebRemoteControlWorkspaces`。该调用在本次重构后应只负责手机可见 workspace 同步，不再兼任 Main session binding。

SSH 连接 UI 必须在本次连接流程内保留用户输入的完整 target，直到现有 credential/history mutation 完成。Main 发回的 `RemoteServicePort` payload 和 Renderer session store 只接收 sanitized target；不能再依赖 Main 把 password/privateKeyPassphrase 原样回显给 Renderer 来完成凭据持久化。

## 生命周期

### 首次连接

1. Main 计算 `(windowWebContentsId, remoteHostKey)`。
2. pool miss，创建 connecting Host entry 并 fork `InitRemoteSshHost`。
3. pending connect 按 `connectAttemptId = requestId?.trim() || randomUUID()` 登记。
4. Host 建立 SSH、部署 server、创建 ServiceCollection 并回报 `Connected`。
5. Host entry readiness 切换为 ready。
6. Main 创建新的 remoteSessionId 和 attachmentId。
7. Main 给 Host 发送 `AttachServicePort`，给 Renderer 投递独立 `RemoteServicePort`。
8. connect IPC 返回 remoteSessionId；Renderer 等待 session store 注册完成。

### 同配置后续连接

- connecting Host：复用同一个 readiness promise，不重复 fork。
- ready Host：直接创建新的 logical session 和 attachment。
- 同一 remoteHostKey、不同 Electron 窗口：pool key 不同，各自 fork Host。

### workspace context 绑定

1. 初始 session 可没有 context，用于远程目录浏览。
2. Renderer 在远端调用 realpath 得到 canonical workspacePath。
3. 使用统一工具构造 workspaceIdentity。
4. 通过专用平台操作把 context 绑定到 remoteSessionId。
5. Main 从当前 attached sessions 派生 Host workspaceKey 并集，更新 TaskRealtimeBus scope。
6. UI 再执行 Provider Registry 同步、历史提交和 tab connected 更新。

### Renderer workspace RPC readiness

Renderer 必须把 workspace 服务解析结果显式区分为 `local-ready`、`remote-waiting` 和
`remote-ready`。本地 workspace 始终保持 `local-ready`；远端 workspace 只有在对应
`remoteSessionId` 已经存在于 Renderer session store、能够解析到真实 remote services 后才进入
`remote-ready`。仅有 remote tab 元数据或正在重连状态都仍属于 `remote-waiting`。

`remote-waiting` 期间允许继续渲染 App 壳、侧栏和连接进度，但 workspace model 初始化、conversation /
sessions-index 订阅、任务终态通知的 sessions-index 监听、MCP workspace 目录配置水合、draft config 水合和
draft session prewarm 等 workspace RPC 副作用不得启动。
断连代理继续作为最终越界保护，禁止回退到本地 base services，也禁止缓存请求后跨 transport 重放。
usage entitlement 等 app-global 能力必须使用 base host service，不跟随 remote workspace readiness。

该 readiness 只控制 Renderer 发起 workspace RPC 的时机，不改变 Desktop
`desktop-continuous`、手机 `web-remote-replayable`、owner/lease 或 workspace identity 语义。

### 关闭 workspace

1. Renderer 删除 tab 并解除 identity/path 到 session 的映射。
2. Main 删除 logical session。
3. Main 释放该 session 的 desktop RPC attachment 和 mobile shared-host attachments。
4. Main 重新派生 realtime workspace scope。
5. ready Host 即使没有 session 也继续留在 pool。

### Renderer reload

Main 遍历仍然 attached 的 logical sessions，为每个 session 从同一个 Host 创建新的 attachment。remoteSessionId 和 workspace context 不变，旧 attachment 被显式释放。

该流程只恢复 Desktop direct RPC，不使用 mobile replayable snapshot/gap 语义。

### 窗口关闭

Main 删除该窗口所有 pool entry，释放所有 session/attachment，向每个 Host 发送 dispose，并等待现有强杀兜底完成。

### 远端 stdio server 退出

SSH transport 关闭会让远端 `zcode-server` 的 stdin 收到 `end` / `error`，或者让进程收到
`SIGHUP` / `SIGTERM` / `SIGINT`。远端 server 是其内部 `ZCodeAgentProcessManager` 的进程所有者，
因此不能在该事件里直接 `process.exit()`；必须先停止 RPC，再等待所有 workspace Agent 的
graceful + force cleanup 完成，最后退出 server：

```text
stdin end/error or termination signal
  -> ChannelServer / connection scope 停止接收 RPC
  -> disposeServiceResourcesAndWait()
       -> 每个 workspace 的 Agent disposeAndWait()
       -> graceful stdin EOF
       -> 超时后进程树强杀兜底
  -> cleanup 完成、失败或整体 deadline 超时被记录
  -> process.exit(normal=0, transport/cleanup error=1)
```

退出收口必须幂等：`end`、`error`、termination signal 或重复事件只能启动一次 cleanup、只能调用一次
exit；cleanup 期间如果又收到 stdin error 或 termination signal，最终退出码升级为 `1`。cleanup 自身失败
也必须记录并以 `1` 退出，不能因为 rejected Promise 跳过 exit 或产生 unhandled rejection。
整个 `stopRpc + disposeServiceResourcesAndWait` 共享一个默认 5 秒的硬 deadline；deadline
必须可注入以便测试。任一阶段永久 pending 时，server 记录当前未完成阶段和 deadline，不再等待
cleanup Promise，直接以 `1` 退出。deadline timer 必须保持 ref，确保它能独立驱动最终收口。

该契约只属于远端 server 进程退出，不改变本地 Desktop Host 的既有
`disposeServiceResourcesAndWait()` 路径，也不改变 workspaceKey、Desktop continuous 或手机 replayable
语义。

## 取消语义

- connecting Host 的一个等待者取消：只删除该 pending connect。
- connecting Host 的全部等待者取消且没有 attached session：销毁 Host，停止正在进行的上传/部署。
- ready Host 上取消远程目录选择：删除临时 logical session，Host 保持缓存。
- ready Host 上关闭最后一个 workspace：Host 保持缓存。
- requestId/connectAttemptId 只属于 pending connect，不进入 attached session 长期状态。

## 断线与重连

### Host 意外退出

1. Main 使用 Host entry/process 对象身份确认退出回调仍属于当前 pool entry。
2. 找出 `attachedSessionsById` 中引用该 Host 的全部 session。
3. 分别发送现有 remote-session-closed 通知。
4. 释放所有 desktop/mobile attachment。
5. Renderer 清除各 tab remoteSessionId，保留 remote target、workspace history 和 workspaceIdentity。
6. 删除 Host pool entry。

旧 Host 的延迟 exit/error 回调不得删除同 key 的新 Host。

### 用户发起重连

1. UI 使用 `buildSshRemoteHostKey()` 找到同一窗口内、同 key、仍打开的全部 remote workspace tab，并把用户发起重连的 workspace 固定为组内 initiator。
2. 只加载 initiator 的有效凭据并先完成它的 logical connect；该 connect 返回时 Main 中的共享 Host 必须已经 ready。
3. initiator 建连失败时立即停止整组恢复，禁止其他 workspace 使用各自历史凭据抢建同 key Host。
4. initiator 成功后，再并行恢复其余 workspace；Main pool 只为它们创建独立 attachment，不重复 SSH 认证。
5. 每个 workspace 获得新的独立 remoteSessionId。
6. 每个 workspace 分别 canonicalize path、绑定 context、同步 Provider Registry 并初始化 Agent。
7. initiator 成功后，其他 workspace 的初始化保持独立失败语义；单 workspace 失败不回滚 ready Host 或已恢复 workspace。

如果 SSH/RPC transport 在恢复期间断开，则属于 Host 级失败，全部关联 workspace 一起失败。

## Service 与 Provider 边界

共享 Remote Host 中只创建一次本地混合 ServiceCollection：

- 本地权威：setting、credential、OAuth、model provider、usage stats、coding plan、broadcast 等。
- 本地 wrapper：ZCode Task、ZCode Session、Repo Wiki 等。
- 远端实现：file、git、terminal、file watcher、Agent、skills、MCP/plugin sync 等。

远端 `zcode-server` 内继续按 workspaceKey 管理：

```text
zcode-server
├── workspaceKey A
│   ├── Agent A
│   └── appliedProviderRevision A
└── workspaceKey B
    ├── Agent B
    └── appliedProviderRevision B
```

Provider Registry 的来源是 Desktop app-global 配置，但应用和 revision 状态仍按 workspaceKey 独立。A 的同步失败不表示 SSH Host 损坏，也不得清理 B 的成功状态。

## Realtime 与 Web Remote Control

### Desktop continuous

- 每个 remoteSessionId 使用独立 MessagePort。
- 多个 MessagePort 指向同一个 Host `activeServices`。
- UI 直接订阅远端 continuous stream，不拼接 mobile replayable 恢复消息。

### Mobile replayable

手机仍通过 Relay/Main attach 已存在的 logical remote session：

```text
remoteSessionId
  -> attached session
  -> shared Host
  + workspaceIdentity/workspaceKey validation
  -> remote services
```

`attachRemoteWorkspaceSessionHost()` 必须同时验证：

- remoteSessionId 存在。
- session 属于请求窗口。
- workspaceIdentity 非空。
- `workspaceKey === resolveWorkspaceKey({ workspacePath, workspaceIdentity })`。
- session 已绑定的 workspaceKey 与请求一致。

Host 共享不能让 mobile session A 访问 workspace B。Relay 和 Main 继续只做鉴权、配对、心跳、rpc-frame/app payload 透传与 attachment 调度，不持有 task/session/stream/queue/snapshot 业务状态。

### TaskRealtimeBus

SSH Host 的 realtime delivery kind 保持现有 `relay_bridge`。workspace scope 从该 Host 当前 attached session context 的 workspaceKey 并集派生，并使用现有 `updateHostWorkspaceKeys()` 更新。

owner/lease、owner command、pending permission/elicitation/command 和 stale run 防护继续按 workspaceKey/task/run 工作，不因共享 Host 删除。

## 持久化与凭据

- Host pool、readiness、pending connect、attachment 和 remoteSessionId 都不持久化。
- App 冷启动继续恢复 disconnected remote workspace tab，不自动连接。
- 现有 `RemoteWorkspaceSessionEntry` schema 不变，不做数据迁移。
- 现有密码/私钥口令 credential key 仍按 workspace history 保存；本期允许同配置 workspace 存在重复 credential。
- 批量重连使用发起者本次加载成功的 credential 建立一次 Host，其他 workspace 不重复 SSH 认证。
- 已经 ready 的 Host 不因 password/privateKeyPassphrase 内容变化被替换；下一次真正建连时使用发起者当前 credential。

## 日志与安全

- 完整 password、privateKeyPassphrase、Authorization/token 和完整 provider registry 禁止进入日志。
- Main 长期 Host entry 不保存 password 或 privateKeyPassphrase；Renderer 只在当前连接流程完成 credential/history mutation 前临时持有用户输入。
- 允许记录：Host key 的不可逆摘要、existing hostId、remoteSessionId、workspaceKey、状态转换、PID、错误码和耗时。
- Host 创建/ready/exit、窗口 dispose 使用 `info`。
- 可恢复的 attachment/context/单 workspace 初始化失败使用 `warn`。
- Host 建连、握手、远端 server 启动等不可恢复失败使用 `error`。
- 与 stream/event 数量同级的 trace 必须使用 service `debug`，生产环境不落盘。
- SFTP session/write 失败且 exec pipe 可以接管时只记录一次 `warn`，不能先记录 `error` 再记录
  fallback `warn`；本地文件读取失败或 exec pipe 失败仍属于 `error`。
- 新 remote session、registry revision 变化、强制刷新或 pending 重试已经明确要求下发 Provider
  Registry 时，禁止在下发前调用 `getWorkspaceRuntimeIdentity`。Registry 应用成功后再读取 runtime
  identity；只有同 session、同 revision 的 unchanged 判定才允许先探测 identity 以发现 Agent 重建。
- Registry 应用后的 identity 探针仍返回 `ZCODE_AGENT_PROVIDER_NOT_READY` 时，保留一次有界重放保护；
  该错误表示应用回包后 runtime 被替换，不再属于正常冷启动路径。
- Node `ExperimentalWarning` / `DeprecationWarning` / `Warning` 由 host 结构化为一条 `warn`；默认
  stderr/console 路径不得再额外上报一条 `error`。

## SSH 上传能力降级

- SSH backend 初始优先使用 SFTP，以保留正常服务器上的上传性能和进度行为。
- 第一次 `sftp-session` 或 `sftp-write` 失败后，当前 backend 标记为 `exec-upload-only`，当前文件
  立即通过 exec pipe 重试，后续文件直接通过 exec pipe 上传。
- `local-read` 失败不表示远端 SFTP 能力不可用，不得触发 `exec-upload-only`。
- 降级状态只存在于当前 backend 生命周期；新建 backend 会重新探测 SFTP。
- 首次降级必须留下包含失败种类和错误码的 `warn`，后续 exec-only 上传只保留正常的开始、进度、
  完成日志。

## Dimensions

| Dimension | Values / equivalence classes | Include? | Reason |
| --- | --- | --- | --- |
| window | same / different | yes | 共享边界。 |
| remote kind | SSH / WSL / Docker | yes | 仅 SSH 改变。 |
| SSH key | same / different | yes | Host pool 主键。 |
| Host readiness | absent / connecting / ready / exited | yes | 并发、取消和错误语义。 |
| logical session | pending / attached / removed | yes | attachment 生命周期。 |
| workspace context | unbound / bound | yes | 目录浏览与 identity 校验。 |
| attached count | 0 / 1 / many | yes | idle cache 和共享行为。 |
| renderer lifecycle | initial / reload / close | yes | port 重挂与回收。 |
| client mode | desktop-continuous / web-remote-replayable | yes | delivery 边界不可混用。 |
| failure layer | Host transport / attachment / workspace initialization | yes | 整体失败与部分失败边界。 |
| auth | password / private key / agent | yes | remoteHostKey 等价类。 |
| credential content | same / changed | representative | secret 不进 key，但影响重新建连。 |
| provider revision | same / independently failed | yes | applied state 按 workspace。 |

## Candidate Combinations

| Candidate ID | State | Event | Target/surface | Expected guard/effect | Status |
| --- | --- | --- | --- | --- | --- |
| SSH-HOST-POOL-01 | no Host | connect A then B, same window/key | Desktop | one Host, two logical sessions/ports | accepted |
| SSH-HOST-POOL-02 | no Host | same key in different windows | Desktop | one Host per window | accepted |
| SSH-HOST-POOL-03 | no Host | two different keys in same window | Desktop | two Hosts | accepted |
| SSH-HOST-POOL-04 | connecting | concurrent same-key connects | Main | share readiness promise and one spawn | accepted |
| SSH-HOST-POOL-05 | connecting with two waiters | cancel one | Main/UI | one waiter removed, Host continues | accepted |
| SSH-HOST-POOL-06 | connecting with last waiter | cancel | Main/UI | Host disposed and deployment stops | accepted |
| SSH-HOST-POOL-07 | ready, temp session | cancel directory selection | Desktop | session detached, Host cached | accepted |
| SSH-HOST-POOL-08 | ready, two workspaces | close A | Desktop/mobile | detach A only; B remains usable | accepted |
| SSH-HOST-POOL-09 | ready, one workspace | close last workspace then reopen same key | Desktop | Host stays idle and is reused | accepted |
| SSH-HOST-POOL-10 | ready Hosts | close window | Main | dispose all Hosts in that window | accepted |
| SSH-HOST-POOL-11 | ready, two sessions | renderer reload | Desktop | reattach two independent ports to same Host | accepted |
| SSH-HOST-POOL-12 | ready, two sessions | Host/SSH exits | Desktop/mobile | both sessions close and tabs disconnect | accepted |
| SSH-HOST-POOL-13 | disconnected group | reconnect A | UI/Main | A and B restored through one new Host | accepted |
| SSH-HOST-POOL-14 | Host ready | B provider/path init fails | UI/service | A stays connected; B shows failure | accepted |
| SSH-HOST-POOL-15 | shared Host, A/B | phones attach A and B | mobile | same process, isolated sessions/identities | accepted |
| SSH-HOST-POOL-16 | session A bound to key A | attach with identity B | mobile | reject identity mismatch | accepted |
| SSH-HOST-POOL-17 | A/B registry sync | same registry revision | remote server | applied state independently keyed | accepted |
| SSH-HOST-POOL-18 | attached set changes | bind/unbind workspace | realtime | TaskRealtime scope equals derived union | accepted |
| SSH-HOST-POOL-19 | WSL/Docker | open multiple workspaces | Desktop | existing session-per-host behavior | accepted |
| SSH-HOST-POOL-20 | ready or reconnecting | credential content changes | SSH | ready Host reused; new Host uses current credential | accepted |
| SSH-HOST-POOL-21 | backend 首次 SFTP write/session 失败 | 连续上传多个资源 | SSH deploy | 首个资源 fallback；后续资源直接 exec pipe；只记录一次降级 warn | accepted |
| SSH-HOST-POOL-22 | 新 session 且 provider registry 尚未同步 | 同步 workspace app-global state | UI/Host RPC | 跳过无决策价值的 pre-probe；先应用 registry，再进行一次成功的 post-apply identity probe | accepted |
| SSH-HOST-POOL-23 | remote tab 已激活但 services 尚未注册 | Renderer workspace 副作用准备启动 | UI | 状态为 `remote-waiting`；conversation、任务通知 sessions-index 和 MCP 水合的 workspace RPC 调用数均为 0，services 注册后各只启动一次；本地 workspace 继续立即启动 | accepted |
| SSH-HOST-POOL-24 | 多个 remote tab 的 `workspacePath` 相同、`workspaceIdentity` 不同，只有其中一个 identity 已绑定 live session | Renderer 解析 workspace services | UI | 带 identity 的 tab 只能命中显式 `remoteSessionId` 或 identity 精确映射；精确映射缺失时保持 `remote-waiting`，禁止按 path 借用另一 endpoint | accepted |
| SSH-HOST-POOL-25 | local tab 与 remote tab 的 `workspacePath` 相同，remote path 索引已绑定 live session | Renderer 解析 local workspace services | UI | local tab 不具备 remote 元数据时必须使用 base services，禁止仅凭 path 借用 remote endpoint | accepted |
| SSH-HOST-POOL-26 | Web 远控入口携带 remote `workspaceIdentity`，tab 的 `remoteSessionId` 尚未回填或已经失效 | Renderer 解析远控目标 session | UI/mobile | identity 必须参与精确解析；弹层只接收已注册的解析结果，禁止透传未校验 session 或按 path 借用另一 endpoint | accepted |

## Pruning Decisions

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| --- | --- | --- | --- | --- |
| SSH-POOL-PD-01 | same key across windows shares Host | pool key includes window id | 窗口级故障与生命周期隔离 | SSH-HOST-POOL-02 |
| SSH-POOL-PD-02 | WSL/Docker use Host pool | remote kind must be SSH | 本期控制回归面 | SSH-HOST-POOL-19 |
| SSH-POOL-PD-03 | all workspaces share one remoteSessionId | session remains workspace-scoped | 保留现有路由/缓存/mobile 语义 | SSH-HOST-POOL-01 |
| SSH-POOL-PD-04 | last session closes Host | ready Host survives zero binding | 提升再次打开 workspace 的体验 | SSH-HOST-POOL-09 |
| SSH-POOL-PD-05 | any workspace init failure rolls back Host | Host ready separates transport from workspace init | 避免失败扩散 | SSH-HOST-POOL-14 |
| SSH-POOL-PD-06 | persist Host/Profile identity | Host pool is runtime-only | 不扩大到配置迁移 | cold-start compatibility tests |
| SSH-POOL-PD-07 | app cold start auto-connect | restored tabs remain disconnected | 不在后台偷偷建立 SSH | existing persistence tests |
| SSH-POOL-PD-08 | new disconnect UI | no UI in scope | 聚焦进程模型 | no UI diff |
| SSH-POOL-PD-09 | mobile creates independent remote runtime | shared-host attachment invariant | Relay/Main 不拥有业务 runtime | SSH-HOST-POOL-15/16 |

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers | Status |
| --- | --- | --- | --- | --- | --- |
| SSH-HOST-POOL-01 | 同窗口，无 Host | 依次连接同 key 的 workspace A/B | 只 fork 一次；A/B sessionId 与 attachmentId 不同；远端一个 server | unit + process/log | planned |
| SSH-HOST-POOL-04 | Host connecting | 两个 connect 并发进入 | connect/deploy/handshake 只执行一次 | unit | planned |
| SSH-HOST-POOL-05 | 两个 pending waiter | 取消其中一个 requestId | 另一个继续成功；Host 未 dispose | unit | planned |
| SSH-HOST-POOL-06 | 仅一个 pending waiter | 取消 requestId | connecting Host 被 dispose；上传/部署停止 | unit + runtime log | planned |
| SSH-HOST-POOL-08 | A/B attached | 关闭 A tab | Host 仅 detach A；B file/task RPC 成功 | unit + integration | planned |
| SSH-HOST-POOL-09 | 最后一个 workspace attached | 关闭后再次打开同 key workspace | Host PID 不变；无新 SSH handshake | unit + manual SSH | planned |
| SSH-HOST-POOL-11 | A/B attached | renderer reload | A/B 原 remoteSessionId 分别重挂到同一 Host process | unit + renderer harness | planned |
| SSH-HOST-POOL-12 | A/B running | 模拟 SSH/backend close | 两个 session-closed；两个 tab 清 remoteSessionId；pool entry 删除 | unit + fault harness | planned |
| SSH-HOST-POOL-13 | A/B disconnected、仍打开 | 对 A 点击重连 | 一次 Host 创建；A/B 各获新 session；各自绑定 identity | UI/Main integration | planned |
| SSH-HOST-POOL-14 | Host 已恢复 | 注入 B provider/path init failure | A connected；B failed；Host 保留 | UI/service integration | planned |
| SSH-HOST-POOL-15 | A/B attached，同一 Host | mobile 分别打开 A/B | 两个 shared-host attachments 指向同一 process；workspaceKey 不串 | unit + web remote harness | planned |
| SSH-HOST-POOL-16 | session A 绑定 identity A | mobile 用 identity B attach A | 返回 identity mismatch，不创建 port | unit | planned |
| SSH-HOST-POOL-17 | A/B 使用同 provider snapshot | 分别 update registry | 远端两个 workspaceKey 都记录 applied revision；失败独立 | service integration | planned |
| SSH-HOST-POOL-22 | 新 remote session，无 applied revision | 同步 provider registry | 首次操作为 update；之后只做一次成功 identity probe | UI unit | covered |
| SSH-HOST-POOL-23 | remote tab 有 identity、无已注册 services | 挂载单 pane/跨 workspace pane | waiting 期间数据层不挂载；注册并绑定 session 后只挂载一次；本地立即挂载 | UI hook/component | covered |
| SSH-HOST-POOL-24 | 115、localhost、jumpserver 三个 remote tab 的路径都为 `/root`，仅 115 identity 已绑定 live session | 分别解析三个 tab 的 workspace services | 115 命中自己的 session；另外两个返回 remote-waiting，不向 115 Host 发起 sessions-index/provider/task RPC；无 identity 的旧 remote tab 仍允许 path fallback | UI resolver unit | covered |
| SSH-HOST-POOL-25 | local `/root` 与 remote `/root` 同时存在，path 索引指向 remote session | 解析 active local tab 的 workspace services | 返回 local/base 路由，不命中 remote session | UI hook unit | covered |
| SSH-HOST-POOL-26 | Web 远控入口传入 localhost identity 与失效/缺失的 session，115 path 索引仍存活 | 打开远控弹层 | resolver 收到 localhost identity；弹层只收到 resolver 验证后的 session，不收到失效 session 或 115 session | UI component unit | covered |
| SSH-HOST-POOL-18 | A attached，然后 B attach，再 A detach | 更新 context | realtime scope 依次为 `{A}`、`{A,B}`、`{B}` | unit | planned |

## Matrix Backfill

| File | Change |
| --- | --- |
| `docs/architecture/zcode-code-architecture-overview.md` | 更新 SSH Remote Host 为窗口内按 remoteHostKey 共享。 |
| `docs/architecture/message-flow.md` | 更新多 workspace 到共享 Host/server 的 MessagePort 和 stdio 流。 |
| `docs/remote-workspace-session-unified-settings.md` | 说明 persisted workspace history 与 runtime Host pool 分离。 |
| `docs/ssh-remote-app-global-state-authority.md` | 说明一个 Host 多 workspace 时 registry 内容同源、应用状态仍按 workspaceKey。 |
| `docs/web-remote-control/web-remote-control-architecture.md` | 更新多个 logical session attach 同一 SSH Host 的约束。 |
| `docs/web-remote-control/task-realtime-sync.md` | 记录共享 Host workspace scope 为 attached session 的派生并集。 |
| `docs/remote/desktop-remote-session-renderer-reattach.md` | 将“session host”重挂更新为“logical session attachment”重挂。 |

## 测试设计

### Shared 单元测试

- host 大小写、空白和默认端口规范化。
- username 保留大小写，首尾空白移除。
- password/privateKeyPassphrase 内容变化不进入 key。
- password/private-key/agent authKind 不同产生不同 key。
- privateKeyPath 不同产生不同 key。
- alias 名称不同但有效字段一致产生同 key。

### Desktop Main 单元测试

- SSH-HOST-POOL-01 至 13、18、19、20。
- stale Host exit 不删除新 entry。
- attachment 失败只回收对应 session。
- 同 key 跨窗口严格隔离。
- 非 SSH 继续调用旧 create/dispose 路径。

### Remote Host 单元测试

- `InitRemoteSshHost` 不要求 workspace context 或 Renderer service port。
- ServiceCollection 只创建一次。
- 多个 attachment 暴露同一 ServiceCollection。
- Detach 精确释放目标 handle；未知/重复 ID 幂等。
- Host dispose 释放全部 attachment、services、realtime bridge 和 SSH connection。
- 首次 SFTP session/write 失败后，同 backend 的后续上传不再调用 SFTP，并且只产生一次降级 warn。
- provider-not-ready RPC 与 Node warning 使用预期日志级别，不产生重复 error。

### Renderer/UI 单元测试

- 关闭 remote tab 调用 detach session，不销毁 Host。
- 同 remoteHostKey 的 open disconnected tabs 被分为一个恢复组。
- 不同 key、不同窗口或已关闭 workspace 不进入恢复组。
- 批量恢复部分失败时保留成功 tab。
- Provider Registry 对每个 workspace session 分别同步。
- 同路径不同 endpoint 的 tab 在 identity 精确映射缺失时保持 `remote-waiting`，不得按 path 借用已连接 endpoint；仅无 identity 的旧数据允许 path fallback。

### Web Remote Control 单元测试

- SSH-HOST-POOL-15/16。
- detach session 只释放该 session 的 mobile attachments。
- Host failure 释放该 Host 下全部 mobile attachments。
- desktop continuous 与 mobile replayable deliveryKind 不互相替代。

### Service 集成测试

- 同一个 remote ServiceCollection 对两个 workspaceKey 初始化独立 Agent。
- Provider registry applied revision 按 workspaceKey 隔离。
- task/session/file/terminal 请求始终使用调用参数中的 workspacePath/workspaceIdentity。

### 真实运行时验证

使用真实 SSH macOS/Linux 主机：

1. 在同一窗口通过同一配置打开两个远端目录。
2. 进程监控确认本地只有一个 SSH Remote Host PID。
3. 远端确认只有一个对应 `zcode-server`，并可按两个 workspaceKey 启动独立 Agent。
4. 两个 workspace 分别执行 file、Git、terminal、task 和 Provider 操作。
5. 关闭一个 workspace，确认另一个正常且 Host PID 不变。
6. 关闭最后一个 workspace再打开同配置目录，确认没有新 SSH 握手/server PID。
7. 终止 SSH/server，确认两个 workspace 一起断开。
8. 对一个 workspace 点击重连，确认两个仍打开 workspace 通过一个新 Host 恢复。
9. 手机分别进入两个 workspace，确认 task/stream/permission 路由不串。

仓库机械验证：

```sh
pnpm typecheck
pnpm lint
```

## 风险与缓解

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 一个 Host 故障影响更多 workspace | 同配置 workspace 同时断开 | 明确 Host 级故障域；批量重连恢复；不跨窗口共享。 |
| attachment 未释放 | idle Host 长生命周期内订阅/内存泄漏 | attachmentId + DetachServicePort + dispose-all 测试。 |
| session/context/Host 多份索引漂移 | identity 串用、scope 错误 | 三事实源模型；workspaceKey/sessionIds/workspaceKeys 按需派生。 |
| stale process callback | 新 Host 被误清理 | 删除前比较 pool entry/process 对象身份。 |
| Provider 状态错误共享 | workspace 使用错误模型配置 | applied revision 与 registry cache 继续按 workspaceKey。 |
| mobile attachment 越界 | 跨 workspace task/data 暴露 | remoteSessionId + window + workspaceIdentity/workspaceKey 四重校验。 |
| idle SSH 占用资源 | 窗口存活期间保持连接 | 这是已确认的 UX 选择；窗口关闭统一回收；本期不加 idle timeout。 |
| workspace-scoped credential 重复 | 同配置保存多份密码 | 本期接受，避免引入 Profile/migration；后续可独立设计 SSH Profile。 |

## 实施顺序约束

1. 先实现并测试 shared `remoteHostKey` 纯函数。
2. 再实现 Main Host pool 与精简状态模型，不先改 UI 行为。
3. 将 SSH Host init 与 logical session attachment 解耦，并补 detach。
4. 接入 session context 专用绑定与 realtime scope 派生。
5. 调整 tab close、renderer reload 和 Host failure 生命周期。
6. 实现同 Host group 的 UI 批量重连与部分失败。
7. 回归 mobile shared-host attachment、owner/lease 和 provider sync。
8. 更新架构事实文档并执行完整验证。

每一阶段都必须保持 WSL/Docker 旧路径可运行，且不得在中间状态把手机 `/remote` 切换为独立 runtime。

## Implementation Notes

- `buildSshRemoteHostKey()` 同时接受运行时 SSH target 和持久化 SSH snapshot；password snapshot 通过
  `passwordCredentialKey` 推导 auth kind，secret 内容不进入 key。
- Renderer 只在首次连接的待选目录 Map 或 reconnect 调用栈内保留完整 target；main 的
  `RemoteServicePort`、remote session store 和 workspace tab 都只保存脱敏 target，credential/history
  mutation 完成后立即删除临时引用。
- canonical path 与 identity 通过独立 `BindRemoteWorkspaceSessionContext` IPC 绑定，并校验 session 属于
  发起 IPC 的 webContents；`syncWebRemoteControlWorkspaces` 不再兼任绑定入口。
- Host attachment 使用显式 `attachmentId`；desktop logical session 关闭/reload 发送
  `DetachServicePort`，mobile 短 attachment 仍可通过 MessagePort close 触发同一 registry 回收。
- 本实现未改变 task stream、snapshot、queue、permission、owner/lease 或 deliveryKind 协议。
- 同 Host 批量重连先串行恢复 initiator，确认共享 Host ready 后再并行恢复其余 workspace；只有用户点击的
  workspace 会被激活，后台恢复的同组 workspace 不争抢 active tab。

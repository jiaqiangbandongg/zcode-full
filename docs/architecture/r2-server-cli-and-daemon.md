# R2 独立 Server CLI 与 daemon 规格

## 1. 状态与范围

- 状态：P0/P1 已实现；本次 hardening 已补齐 Core 父进程断连、更新指针清理和稳定 Server identity；Linux x64 已完成 SSH 实机验证
- 阶段：统一多端远程架构 R2 / D4
- 本阶段目标：交付可独立安装、可后台运行、与 UI 生命周期解耦的 ZCode Server CLI
- 本文定位：R2 的实现规格和边界；可执行测试补充见 [R2 lifecycle test plan](./r2-server-cli-and-daemon-test-plan.md)
- R2 不切换 Desktop 的生产远程连接主链

本文基于：

- [ZCode 统一多端远程连接架构与产品方案（评审稿）](https://internal-docs.example.invalid/redacted)
- [R1 窗口级单 Host 进程重构规格](./r1-single-window-host-refactor.md)
- [Agent Electron/Node runtime 事实](../runtime-tools/agent-electron-node-runtime.md)
- [ZCode Lite / Server 统一多端架构实施计划](./unified-zcode-lite-server-multi-server-plan.md)

R2 交付：

- 独立安装的 `zcode` Server CLI；
- `serve`、`serve --daemon`、`status`、`stop`、`restart`、`update`、`uninstall`；
- Supervisor、Server Core、Agent 的进程边界；
- macOS、Linux、Windows 的用户级自启动服务；
- 单实例、崩溃退避和任务中断语义；
- HTTP/WebSocket ingress 边界及 R1 Host RPC 兼容性验证；
- 与现有远端资产流程一致的独立 Node runtime。

R2 不交付：

- SSH、WSL、Docker、Direct URL、WS/WSS 的 Transport Adapter；
- Desktop Host 到 Server daemon 的连接发现、安装和连接管理；
- Web 多 Server Controller；
- 手机独立创建 Server、Host 或 Agent runtime；
- `sourceServerId`、Connection Profile、Resource Store 和完整 compatibility manifest；
- Desktop 新远程生产链切换。

## 2. 核心决策

| 决策项 | R2 结论 |
| --- | --- |
| 新代码目录 | 新建 `packages/zcode-server-cli`；R2 不在 `packages/server` 中增加代码 |
| 旧 `packages/server` | 仅作为现有 HTTP/WS、stdio、远程部署和协议行为参考；保持其当前入口兼容 |
| 用户入口 | 独立发行包提供 `zcode`；无参数继续进入既有 TUI |
| Server Core | 新目录内实现新的 Core 入口和生命周期合同，不继承旧 `entry-http` / `entry-stdio` 的进程语义 |
| 业务服务 | 经过审查后复用 `@zcode/services`、`@zcode/shared`、`@zcode/rpc` 等底层能力 |
| Supervisor | 只拥有生命周期状态，不拥有 task/session/stream/queue/snapshot 业务状态 |
| 监听地址 | 默认回环地址和动态端口；非回环监听必须启用鉴权 |
| Web / WS | R2 实现并验证 Core 的 HTTP/WS ingress；具体远程 Transport 留给后续阶段 |
| 数据目录 | 复用 `getZCodeDataRootDir()` 和 `ZCODE_DATA_BASE_DIR`；标准目录为 `<dataRoot>/server`。OS service 必须携带内部参数 `--server-root <absolute-path>`，不得依赖注册时 shell 的环境 |
| Node runtime | 沿用现有远端资产流程的 Node `v22.16.0`；Server CLI 不依赖系统 Node 或 Electron Node |
| 崩溃策略 | 5 次/5 分钟预算，退避 1、2、4、8、16 秒；超出后进入 `crash-loop-stopped` |
| Task 恢复 | Core 崩溃或更新后，运行中的 Task 中断，不自动恢复或重放输入 |
| stop | 停止当前实例，但保留自启动注册 |
| uninstall | 停止实例、移除服务注册、删除 ZCode 自有数据；Workspace/Repo/用户文件不删除 |
| update | 默认从配置的 release catalog 在线下载并校验；无网络时可应用本地 pending；使用原子切换和失败回滚 |
| 组件更新 | 以 Node、server、agent、official-plugins、native-search-tools 五个粗粒度组件做内容寻址缓存；完整 release 仍是原子运行单元 |
| 平台服务注册 | 生成 descriptor 后调用当前用户的 launchctl / systemctl --user / schtasks；命令不可用时保留 descriptor 并返回可诊断错误；OS service 是 daemon 的唯一启动 owner，Supervisor 不重复注册服务 |

## 3. 进程与职责模型

```text
安装后的 zcode
└── bin/zcode
    ├── serve
    │   └── Supervisor
    │       └── Server Core
    │           └── Agent CLI
    ├── serve --daemon
    │   └── OS Service Manager
    │       └── Supervisor
    │           └── Server Core
    │               └── Agent CLI
    ├── status / stop / restart / update / uninstall
    │   └── 本地 Unix Socket / Windows Named Pipe
    │       └── Supervisor
    └── 无参数及其他既有 CLI 命令
        └── 发行包内既有 CLI/TUI bundle
```

### 3.1 Server CLI

Server CLI 负责：

- 解析 Server 生命周期命令；
- 对 Supervisor 发起本地控制请求；
- 输出人类可读或 `--json` 状态；
- 执行 update/uninstall 的交互确认；
- 在不加载 Server Core 的情况下保持 TUI 启动路径；
- 将无参数和非 Server 生命周期命令转发给发行包内已有 CLI/TUI bundle。

CLI 不直接持有 Server 业务状态，也不直接杀 Core 或 Agent 的裸 PID。

### 3.2 Supervisor

Supervisor 负责：

- 获取和维护 data-root 级单实例锁；
- 启动、停止、重启 Server Core；
- 通过私有 child IPC 接收 Core ready、heartbeat、运行任务数量和退出原因；
- 执行崩溃退避和 crash-loop 熔断；
- 处理 update/uninstall 前的运行任务保护；
- 管理平台服务注册、启动、停止和移除。

Supervisor 不持有：

- Session 正文；
- Task conversation 或 stream；
- CommandInbox、queued prompt 或 permission payload；
- Workspace、Repo 或用户文件内容。

### 3.3 Server Core

Server Core 是无界面的业务服务进程，负责：

- 以 `standalone-server` authority 组装服务；
- 管理多个 Workspace 和 Workspace Agent；
- 提供 HTTP API 和 WebSocket API；
- 维护 task/session/runtime 的权威状态；
- 把运行任务数量以只读生命周期快照提供给 Supervisor；
- 响应 SIGINT、SIGTERM 并有界释放服务资源。

Core 崩溃后由 Supervisor 启动新的 Core。旧 Core 中运行中的任务不自动续跑，遵循现有 CLI/runtime 的冷恢复语义。

### 3.4 Agent CLI

Agent CLI 继续作为每个 Workspace 的独立子进程运行：

- Agent 负责命令队列、Session、模型调用和工具执行；
- Server Core 负责 Workspace 到 Agent 的生命周期和路由；
- Supervisor 不直接管理 Agent 的业务状态；
- Agent 重启、Core 重启和 Desktop attachment 断开不得自动重放已接受的输入。

## 4. 进程间通信

```text
CLI 控制请求 ── Unix Socket / Windows Named Pipe ──> Supervisor
Supervisor ── 私有 child IPC ──> Server Core
Server Core ── stdio/RPC ──> Agent CLI
Server Core ── HTTP/WS ──> Desktop Host / Browser / future Transport
```

### 4.1 CLI ↔ Supervisor

本地控制协议由 `packages/zcode-server-cli` 自己拥有，使用严格运行时 schema 和 JSONL framing，至少包括：

- `status`；
- `stop`；
- `restart`；
- `prepare-update` / `apply-update`；
- `prepare-uninstall` / `confirm-uninstall`；
- `ping`。

控制 socket/pipe 必须位于当前 data root 下，并使用权限收紧的运行时路径。响应不得泄露 token、凭据或完整用户路径之外的敏感内容。

### 4.2 Supervisor ↔ Core

Core 通过私有 child IPC 发送：

- `ready`：监听地址、端口、Core 版本和实例 generation；
- `heartbeat`：单调递增时间戳和运行任务数量；
- `task-activity`：运行任务数量发生变化时的只读更新；
- `shutdown-ack`：资源释放完成；
- `fatal`：不可恢复错误摘要；
- `exit`：Core 主动或异常退出原因。

运行任务数量必须来自 Core 内部 Agent runtime 发布的权威 turn lifecycle fact，不能由 Supervisor
维护第二份 task registry。Core-local `TaskActivityTracker` 订阅所有已连接 workspace 的
`turn.started` / `turn.terminal`，只保留按 `workspaceKey + sessionId` 去重的活动 key，并把数量作为
生命周期快照发给 Supervisor。它不是公开 RPC 接口，也不持有正文、stream、queue 或 snapshot。
Task facade 与直接调用 `IZCodeAgentService` v4 的 `desktop-continuous` 路径必须汇入同一 tracker；
`web-remote-replayable` 仍只按自己的 gap/snapshot 边界向客户端恢复，活动计数不得改变两种 delivery
语义。

```text
desktop-continuous ── sendConversationCommandV4 ─┐
                                                 ├─> Agent runtime turn facts
web-remote-replayable ─ Task/Agent command ──────┘             │
                                                               ▼
                                         Core-local TaskActivityTracker
                                         key = workspaceKey + sessionId
                                                               │ count only
                                                               ▼
                                                         Supervisor guard
```

## 5. HTTP / WebSocket ingress

R2 不把 Server Core 设计成 SSH 专用服务。Web、WS、WSS、SSH、WSL、Docker 后续都应只是到达同一个 Core 的不同 Transport。

```text
Desktop Host / Browser Web / Mobile Controller
                  │
                  ▼
       SSH / WSL / Docker / WS / WSS
                  │
                  ▼
              Server Core
```

R2 Core 实现和验证：

- HTTP server-info 能力；
- Web replayable WebSocket 合同；
- capability-gated desktop continuous WebSocket 合同；
- `desktop-continuous` 和 `web-remote-replayable` 的 delivery 边界；
- `workspaceIdentity`、`workspacePath` 的传递和隔离；`remoteSessionId` 不属于 R2 Core ingress 合同，仍由 R3 Transport/Host 连接层负责透传。

R2 的 Core 是 Supervisor 的 child process。除显式 `shutdown` 外，Core 还必须监听 IPC
`disconnect`：Supervisor 被强杀、崩溃或 IPC 通道断开时，Core 要自行关闭 HTTP/WebSocket、释放
Agent/SQLite 等资源并退出，不能成为绕过 data-root lock 的孤儿进程。Supervisor 只依据自己的
lock ownership 判断实例存活，不能把 Core 的孤儿状态当作可安全复用。

```text
Supervisor ── SIGKILL/crash ──X IPC ──disconnect──> Core
                                                    │
                                                    ├─ close HTTP/WebSocket
                                                    ├─ dispose Agent/SQLite
                                                    └─ exit；端口不再可用
```

在线 catalog 已确认当前 release 与磁盘上的 `current.json` 一致时，`prepareOnlineUpdate` 会删除
不可能高于当前版本的遗留 `pending.json`。这样离线更新不会在一次“已是最新”的在线检查之后
意外降级到旧 release；如果 pending 明确指向更高的未来版本，则保留它作为显式的离线候选。

`/api/server-info.serverId` 使用 `install.json.installationId` 作为安装级稳定身份。只有直接调用
Core HTTP 工厂且未提供 server root 的测试/嵌入场景才回退到 hostname；真实 Supervisor 启动的
Core 必须通过 `ZCODE_SERVER_ROOT` 校验 ownership marker 后注入 installationId。

现有 `packages/server` 中的 `/api/server-info`、`/api/rpc-host-capability`、`/ws`、`/ws/host` 等行为作为兼容性参考；新 Core 不直接导入旧入口，而是通过合同测试决定需要保留的边界。

R2 默认只监听回环地址和动态端口，并把实际端口写入 `status.json`。非回环监听必须显式配置鉴权。R2 不实现公网暴露、Relay、配对、Direct URL 发现和 Transport Adapter。

当前 loopback-only ingress 的安全边界是网络位置边界，不是进程身份边界：同一台机器上能够发现该动态端口的其他进程，理论上可以访问普通 `/ws` replayable RPC 和申请 host capability。R2 的 `authRequired: false` 因此只表示“未启用调用方认证”，不应被解释为跨用户或公网安全保证。该阶段暂接受受控本机/SSH 隧道的威胁模型；在启用 Direct URL、WSS、Relay 或其他非回环 Transport 前，必须补充 token、Unix socket peer credential 或 Windows named-pipe ACL 等调用方认证，并更新对应连接合同。

手机 `/remote` 仍只能 attachment 到已经存在的 Desktop Host；R2 daemon 不得成为手机独立 Agent 的创建入口。

## 6. 新代码目录与依赖边界

```text
packages/zcode-server-cli/
├── src/
│   ├── main.ts
│   ├── supervisor/
│   ├── server-core/
│   ├── ipc/
│   ├── platform/
│   ├── runtime/
│   └── packaging/
└── package.json
```

依赖规则：

- 新 Core 不依赖 `@zcode/server` 的入口实现；
- 不修改 `packages/server` 的 `entry-http`、`entry-stdio` 和 `build:remote`；
- 只复用经过审查的 `@zcode/services`、`@zcode/shared`、`@zcode/rpc` 和服务类型；
- 不把 Electron、Renderer、Desktop Main 或 Window Host 打入 Server CLI 包；
- 不新增 App ↔ Agent 协议；若未来必须修改该协议，另行修改 `packages/shared/src/zcode-protocol` 并增加 schema 验证；
- 新增 IO 使用异步 API；锁、状态和 release 切换必须可恢复、可审计。

## 7. 安装包与 Node runtime

R2 Server CLI 不使用 Electron 内置 Node，也不要求目标服务器预装 Node。

当前事实：

- Desktop Host/Agent 使用 Electron 41 内置 Node 24.x；
- SSH/WSL/Docker 远端资产使用独立 Node `v22.16.0`；
- CLI bundle 当前以 `node22` 为最低运行目标。

R2 沿用第二条远端资产链路，并把它扩展为独立 Server CLI 的发行 runtime：

- Node 版本固定为 `v22.16.0`；
- CLI、Supervisor、Server Core、Agent 共用同一 Node；
- 每个 OS/架构随包提供对应 Node；
- 运行时不联网下载 Node；
- `node-pty` 等原生依赖按 OS/架构随包准备；
- 根目录构建仍可使用 Node 24+，但不代表发行 runtime 使用 Node 24。

发行包结构：

```text
zcode-server-<os>-<arch>/
├── bin/
│   ├── zcode
│   └── zcode.cmd
├── runtime/
│   ├── node                 # Windows 为 node.exe
│   ├── package.json         # {"type":"module"}，让 .js 入口按 ESM 解析
│   ├── server-cli.js        # ESM bundle（tsup 产物，含 __dirname banner）
│   ├── server-core.js       # ESM bundle，server-cli 以同目录相对路径 fork
│   ├── zcode.cjs            # 既有 CLI/Agent bundle（自包含 CJS）
│   ├── node_modules/        # bundle 外置依赖闭包（含 node-pty 平台 prebuilds）
│   ├── tools/               # bfs/rg/ugrep（Windows 为 rg/ugrep）
│   └── packages/            # Agent 实际启用的官方插件
└── manifest.json
```

入口用 ESM `.js` 而不是最初设想的 `.cjs`：`@zcode/services` 依赖链已按 ESM 组织，
CJS 化 bundle 风险更高；`server-cli.js` 通过 `new URL("./server-core.js", import.meta.url)`
fork Core，通过同目录 `zcode.cjs` 委派既有 CLI，因此三个入口必须位于同一 `runtime/` 目录。

### 7.1 发行包 staging

staging 由 `packages/zcode-server-cli/src/packaging/stage.ts` 实现，
`pnpm --filter @zcode/server-cli stage --target <os>-<arch>` 触发，只做本地组装，不上传、不发布：

- 入口 bundle 来自本包 `tsup` 产物；`zcode.cjs` 来自 `apps/zcode-cli/packages/cli/dist/zcode.cjs`
  （由 `scripts/build-desktop-agent-cli.mjs` 构建，与远端资产链同源）；
- `runtime/node_modules` 内容以**产物扫描**为事实源：扫描 bundle 顶层裸模块引用，
  与 workspace `node_modules` 求交集后递归收集生产依赖闭包，从 workspace 复制为扁平布局；
  不使用 `tsup` external 声明列表作为事实源，避免声明与实际引用漂移；
- `node-pty` 复制时剔除 `build/`（本机编译产物，交叉打包时会被 loadNativeModule 优先加载导致
  错误架构崩溃），只保留目标平台 `prebuilds/<os>-<arch>/`；linux 平台官方包无 prebuild，
  从 workspace `@lydell/node-pty-linux-<arch>` 补 `pty.node`；darwin 保留官方 `pty.node` 与
  `spawn-helper`；
- Node 二进制固定 `v22.16.0`：优先复用 `packages/desktop/mock-cdn/releases/<version>/node/<platform>/`
  已下载的缓存，缺失时从 nodejs.org 下载目标格式（POSIX 为 `tar.xz`，Windows 为 `zip`）并缓存；
- 同时产出目录形态和 `zcode-server-<os>-<arch>.tar.gz`（供 scp 到远端解压验证）；
- staging 实现六个目标：`darwin-x64/arm64`、`linux-x64/arm64`、`win32-x64/arm64`；POSIX
  产出 `tar.gz`，Windows 产出 `zip` 和 `zcode.cmd`。Windows 不打包 `bfs`，使用 `rg.exe`、
  `ugrep.exe`，并保留系统/Git Bash fallback。
- Agent bundle 的外置依赖以运行时入口扫描和官方插件定义为事实源；不再只扫描 Server CLI/Core，
  因而 `@zcode/tui`、`playwright-core` 等 bundle 运行时依赖不会被遗漏。
- `runtime/tools` 由 `scripts/prepare-native-search-tools.mjs` 按目标 release plan 准备到
  `node_modules/.cache/zcode-server-cli/tools/<target>`（内网依赖源已配置时下载，未配置时解包仓库归档），
  不复用 mock-cdn 或 bundled-tools 目录（远端 macOS 固定为 rg13）；每个工具目录同时携带
  `THIRD-PARTY-NOTICES.txt` 与 `SOURCES.json`。运行时通过
  `ZCODE_SERVER_RUNTIME_ROOT` 解析；`runtime/packages` 包含当前官方插件定义中需要 seed 的七个
  plugin（browser-use、document-skills、skill-creator、zcode-guide、android-emulator、
  ios-simulator、restore-legacy-sessions）。

Agent 接线约定：发行包内 Core 不在 monorepo、也没有 Electron runtime。Supervisor 每次启动 Core
时必须根据该 Core 所属 release 的 `runtime/` 重新计算接线（`runtime/node zcode.cjs app-server
--stdio`），不得由旧 `server-cli.js` 把自动推导结果永久写入全局 `process.env`。显式配置的
`ZCODE_AGENT_SERVER_COMMAND` 仍永远优先；开发态没有 release runtime 时不注入。

安装后的程序和数据分离：

```text
~/.zcode/server/
├── releases/<version>-<target>-<sha12>/
│   ├── runtime/
│   ├── bin/
│   └── manifest.json
├── current.json
├── pending.json
├── bin/zcode                       # Windows 为 zcode.cmd；OS service 稳定入口
├── service/<root-hash>.<platform>  # 运行时按 canonical root 生成，显式携带 --server-root
├── cache/components/<target>/<component>/<sha256>/
└── run/
    ├── server.lock
    ├── status.json
    └── control.sock / named pipe
```

descriptor 不随 release archive 打包，而是在 `serve --daemon` 注册时由
`platform/serviceManager.ts` 动态写入 `service/`。显式传入非标准 `--server-root` 时，Server CLI
将该目录同时作为 `dataBaseDir`，因此 Agent/SQLite 等本地状态位于该 root 的 `.zcode/` 隔离目录；
卸载仍只删除 ZCode allowlist，未知文件会保留并列入 `uninstalled.json.preservedPaths`。

`current.json` 和 `pending.json` 只通过临时文件加 rename 更新。release 目录按 archive SHA 内容寻址
且不可变：安装器只能把完整临时目录原子 promote 到尚不存在的 `releases/<releaseId>`；目标已存在
时校验 archive identity 与 runtime manifest 后复用，内容不一致必须失败，禁止删除、覆盖或 rename
走一个可能正被 Core 使用的 release 目录。组件缓存命中时只下载变化组件并组装新的 release，最后
仍只切换一次 `current.json`。任何启动失败都恢复旧 pointer，临时目录和半成品缓存会被清理。

完整 archive 安装与组件增量组装必须复用同一个 immutable promote 语义：`incoming` 只能 rename 到
不存在的目标；目标已存在时只允许校验完整 release identity 与内容 hash 后复用。无论复用还是失败，
未 promote 的 `incoming` 都必须清理。禁止为了发布新内容把既有目标移动到 backup；该目标可能已在
另一个并发 update 完成后成为活动 release。

更新回滚必须先收口未就绪的新 Core，再恢复旧 pointer 并启动旧 release；超时但仍存活的 Core
不得与回滚后的旧 Core 并存：

```text
apply pending
    │
    ▼
new Core ── ready ───────────────────────────────> commit
    │
    ├─ spawn error + close（无 exit）─┐
    └─ timeout / fatal / exit ────────┴─> stop if alive ─> restore current ─> old Core ready
```

`fork()` 的 `error`、`exit` 与 `close` 必须收敛到同一个、最多执行一次的 Core 终态入口。spawn error
也是可回滚的启动失败，必须被 Supervisor 消费并进入 crash budget，不能成为未处理事件让 Supervisor
崩溃；运行中 ChildProcess 的 `error` 本身不等价于进程已经退出。停止流程只有观察到 `exit`/`close`
才能释放 data-root lock；SIGKILL 后仍未收口则进入 `stop-failed`，保留 Core 引用和锁，禁止启动替代 Core。

Supervisor 的 `stop`、`restart`、`apply-update`、`confirm-uninstall` 共用一个生命周期 operation gate。
同类幂等 stop 可复用当前 Promise；其他并发写操作立即返回 retryable `operation-in-progress`，不排队。
Core IPC listener 必须绑定具体 child 与 generation，非当前 child 的消息全部丢弃；Core 终止或换代时
清空 host、port、startedAt 与 runningTaskCount，不能让已中断任务继续污染下一代 guard。

`serve --daemon` 的启动 owner 只有 OS service。descriptor 的命令必须指向 data root 下的稳定入口
`<serverRoot>/bin/zcode`（Windows 为 `zcode.cmd`），参数固定包含 `serve --supervisor --service-entry
--server-root <absolute-path>`；不得记录注册时 release 的 `server-cli.js` 绝对路径。CLI 注册并启动
service 后等待现有 Supervisor 报告 ready；service entry 不能再次注册自身或 fork 第二个 Supervisor。
只有 OS service entry 才报告 `serviceRegistered=true`；显式跳过 service registration 的 detached
fallback 必须报告 false。服务管理器注册失败时保留 descriptor 并返回可诊断错误，不能把 fallback
伪装成注册成功。update 立即切换 Core；Supervisor 自身的新 release 代码在下一次 daemon process
lifecycle（OS service 重新拉起）生效，R2 不在 apply-update 响应中做进程内自举 handoff。`stop` 请求
导致的正常退出不得被 launchd 自动重启，但异常退出仍由服务管理器保留的 restart 语义处理。

OS service identity 必须按 canonical server root 隔离，使用稳定 root hash 派生 launchd Label、systemd
unit name、Windows task name 和 descriptor 文件名。兼容清理旧固定 service id 时，只有旧 descriptor
中的 canonical `--server-root` 与当前 root 相同才允许卸载，禁止误删另一个 root 的服务。

`--server-root` 是 service/fallback daemon 使用的内部全局参数，值必须是绝对路径。CLI 的 control
endpoint、status、release、service descriptor 和 uninstall 均从该参数解析同一个 layout；Core/Agent
同时获得对应的 `ZCODE_DATA_BASE_DIR`。因此自定义 data root 的 daemon 不得在默认 root 创建第二份
status、lock、Core 或 SQLite。

组件增量组装先从旧 release 复制，再删除所有已变化或已移除组件声明的旧路径，之后解压新组件并
校验新 manifest；这样新 manifest 移除插件/工具等组件时不会把旧文件带入新 release。

R2 至少准备以下平台资产：

- `darwin-x64`、`darwin-arm64`；
- `linux-x64`、`linux-arm64`；
- `win32-x64`、`win32-arm64`。

## 8. CLI 命令语义

```bash
zcode                  # 无参数仍进入 TUI
zcode serve            # 前台 Server Core
zcode serve --daemon   # 注册并启动 daemon
zcode status
zcode stop
zcode restart
zcode update
zcode update --force
zcode uninstall
```

| 命令 | 行为 |
| --- | --- |
| `serve` | 由当前 CLI 进程运行 Supervisor/Core；不注册 OS 自启动；终止信号后有界退出 |
| `serve --daemon` | 安装/复用当前用户的服务注册，并启动或复用 Supervisor/Core |
| `status` | 返回注册状态、Core 状态、PID、端口、版本、最近退出原因和 crash budget |
| `stop` | 请求 Supervisor 停止 Core；保留自启动注册 |
| `restart` | 有界停止并重新启动；不自动恢复中断 Task |
| `update` | 获取 catalog 中当前 target 的新 release（或使用已有 pending），校验并安装后应用；catalog 与 current archive 相同返回成功的 `up-to-date`，不得继续请求 apply；未配置 catalog 且没有 pending 时返回明确的 release source 错误；有运行 Task 时默认返回可操作的 guard 错误，不中断任务 |
| `update --force` | 明确允许中断运行 Task 后应用 release |
| `uninstall` | 检查运行 Task（有运行 Task 时拒绝并保持原状态），要求两次输入 `DELETE`，停止并移除服务，删除允许列表内的 ZCode 数据 |

`uninstall` 允许删除：

- R2 程序 release；
- Supervisor/Core 运行记录；
- ZCode 配置、缓存、runtime 记录；
- ZCode 自有状态数据库和日志。

`uninstall` 禁止删除：

- Workspace 文件；
- Git 仓库和工作树；
- 用户 home 下的其他文件；
- 用户显式指定的外部目录；
- 任何无法通过 canonical path 和 allowlist 校验的路径。

初始化 server root 时必须写入严格 schema 的 `install.json` 所有权标记，包含 product、schema version、
canonical server root 和 installation id。`uninstall` 只有在 `realpath` 后的 root 与该标记一致时才允许
自动清理；无标记或标记不匹配时拒绝并提示手工处理。卸载只删除 `releases/`、`run/`、`cache/`、
`bin/`、`service/`、`current.json`、`pending.json` 和所有权标记等 allowlist 项，server root 内未知文件
必须保留并在结果的 `preservedPaths` 中列出。完成后在保留的 root 下写 `uninstalled.json`，含卸载时间
与版本；R2 不实现 Controller UI。

## 9. 数据、状态与不变量

```text
OS Service Manager
└── Supervisor lifecycle state
    ├── release / PID / port / registration
    ├── crash budget / backoff
    └── update / uninstall operation

Server Core
└── authoritative business state
    ├── workspace / task / session
    ├── command queue / stream
    └── Agent runtime lifecycle

Workspace / Repo / User files
└── user-owned state，R2 不负责删除
```

必须保持：

- 单实例 key = 当前 OS 用户 + data root；
- stale lock 回收必须先按 ownership token 原子 claim 到隔离路径；release 只能删除仍属于自己的 token，禁止按一次陈旧的 PID 判断直接删除当前路径；
- Workspace 隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；
- 路径执行继续使用 `workspacePath`；
- 远程 identity 不得只使用 `workspacePath`；
- Supervisor 不创建第二份 CommandInbox 或 Task queue；
- Desktop `continuous` 不拼接 Web `replayable` 恢复消息；
- Mobile `replayable` 不绕过 gap/snapshot 恢复；
- Core 崩溃、更新和卸载都不自动恢复已中断输入；
- Main、relay 和未来 Transport 不下沉业务状态；
- 生产日志使用 `createServiceLogger`，高频 heartbeat/RPC 明细使用 debug，不记录 secret。

## 10. 实施顺序

1. 保留本文作为 R2 spec，并补充 [R2 lifecycle test plan](./r2-server-cli-and-daemon-test-plan.md)；涉及 conversation/session 的用例先更新 case catalog 和 coverage matrix。
2. 在 `packages/zcode-server-cli` 建立 CLI、IPC、runtime layout 和 contract schema，先写测试。
3. 实现单实例锁、状态文件、canonical path 和 allowlist 校验。
4. 实现 Server Core 新入口，接入 `standalone-server` 服务并提供 HTTP/WS ingress。
5. 实现 Supervisor、Core 私有 child IPC、崩溃预算和 running-task guard。
6. 实现 macOS launchd、Linux systemd --user、Windows Task Scheduler adapter。
7. 实现 Server CLI 命令路由、TUI/既有 CLI lazy delegation、`--json` 和确认流程。
8. 实现六平台 Node runtime、node-pty、native search tools 和官方 plugins 的 staging；不改 `packages/server` 的构建入口。
9. 实现 ReleaseCatalog/Downloader/Installer、组件内容寻址缓存、原子 current/pending 切换和失败回滚。
10. 完成真实 OS service manager adapter、在线下载合同测试、Windows 合同测试和 R1 Host RPC compatibility。
11. 执行 `pnpm typecheck`、`pnpm lint`、新包测试及 conversation coverage audit。

## 11. 验收用例

| Case | 验收目标 |
| --- | --- |
| R2-CLI-01 | 无参数不加载 Server Core，仍进入 TUI |
| R2-CLI-02 | 前台 `serve` 启动 Core、监听回环动态端口并完成 ready |
| R2-CLI-03 | `serve --daemon` 注册平台服务并启动 Supervisor |
| R2-CLI-04 | 重复启动复用当前实例，不产生第二个 Core |
| R2-CLI-05 | `status`、`stop`、`restart` 状态收敛且幂等 |
| R2-CLI-06 | Core 崩溃按 1/2/4/8/16 秒退避，超过预算进入熔断 |
| R2-CLI-07 | Core 崩溃后运行 Task 中断，不自动恢复 |
| R2-CLI-08 | 无运行 Task 时 update 原子切换 release 并完成 ready |
| R2-CLI-09 | 有运行 Task 时 update 默认返回 guard 错误且不中断任务，`--force` 才允许中断 |
| R2-CLI-10 | uninstall 双重 `DELETE` 确认并移除服务注册 |
| R2-CLI-11 | uninstall 保留 Workspace、Repo 和用户文件 |
| R2-CLI-12 | HTTP/WS ingress 通过 server-info、Web replayable 和 Host continuous 合同测试 |
| R2-CLI-13 | 不同 data root 互相隔离，单实例锁不误伤其他 root |
| R2-CLI-14 | macOS/Linux/Windows service descriptor 和 Node runtime 可启动 |

## 12. 发布与回滚

R2 只在内部环境验证，不改变 Desktop 当前生产远程连接。发布前必须同时具备：

- 安装、启动、停止、重启、卸载成功；
- 单实例和 crash-loop 行为稳定；
- Node runtime 和 native dependency 在三平台矩阵通过；
- R1 Host RPC 边界通过合同测试；
- 无 Workspace/Repo/用户文件误删；
- 日志不泄露 secret；
- `pnpm typecheck` 和 `pnpm lint` 通过。

失败时只回滚当前 Server CLI release 或 Desktop 版本，不做数据库破坏性迁移，不切换或修复现有 `packages/server` 远程链路。

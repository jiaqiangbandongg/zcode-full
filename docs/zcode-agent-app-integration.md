# ZCode Agent 与 App 当前集成

更新日期：2026-09-04

ZCode App 只启动 ZCode Agent（`apps/zcode-cli` 的 `zcode app-server --stdio`）。退役的多 Agent
process manager、第三方 runtime installer、proxy traffic 和 UI agent switch 不属于当前产品路径。

## 进程与服务边界

```text
Renderer / Web UI
  -> hooks / IServiceAccessor
  -> IZCodeAgentService（V4 command/topic）
     IZCodeSessionService（仍存的 lifecycle/workspace config facade）
     IZCodeTaskService（列表组织态、兼容查询和 remote wrapper）
  -> window-scoped Local Host Process
  -> ZCodeAgentProcessManager
  -> workspaceKey-scoped zcode app-server --stdio
```

- UI 不管理子进程、不解析 stdio 帧，也不直接调用 service concrete implementation。
- 每个 BrowserWindow 有一个 Local Host；同一窗口的多个本地 workspace 通过 workspaceKey service scope
  共用该进程，不为每个 workspace 另起 Local Host。
- 远程 workspace 另外创建或复用窗口/目标作用域的 Remote Host。Remote Host 与窗口 Local Host 是不同进程，
  负责连接对应 SSH/WSL/Docker/Server 环境；broadcast 仍由桌面本地服务提供。
- Agent process 按 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 隔离并对并发启动单飞。
- 手机 `/remote` attach 桌面窗口已有的 local/remote host 和 CLI，不创建手机侧 Agent runtime。
- main/relay 只负责窗口、配对、鉴权、心跳和 frame/app payload 转发，不保存 conversation 状态。

## 状态所有权

| 状态                                                                                            | 权威                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| transcript、turn/row、phase、actions、queue、interaction、goal、background work、session config | CLI V4 projection/runtime                                                                                       |
| Provider Config、Registry 与凭据                                                                | 当前 Environment；Host/Worker 从该 Environment 的 Config/Credential Source 构建，不跨 Environment 下发 Registry |
| pin/archive/group/unread、列表搜索兼容 metadata                                                 | host tasks-index                                                                                                |
| draft、scroll、focus、panel、optimistic pending overlay                                         | renderer/web 本地                                                                                               |

`zcodeSessionStore` 仍承载 workspace shell、任务列表缓存、未读/乐观组织态和部分兼容 service 投影，但不再
拥有 V4 conversation transcript 或已绑定 session config。UI conversation 读路径是
`ConversationProjectionStore` / `SessionDataLayer`，列表活性读路径是 sessions-index。

## 协议

stdio 使用 LF 分隔的 NDJSON，schema 位于 `packages/shared/src/zcode-protocol-v4/`。Host 的
`zcodeProtocolClient` 和 `zcodeStdioTransport` 负责请求、通知和运行时代际；高频原始 frame/chunk 日志必须
用 service logger 的 `debug`。

主路径：

- 读：`conversation/<sessionId>`、`sessions-index/<workspaceId>`、
  `workspace-config/<workspaceId>` topic；
- 写：V4 command envelope + command ACK/query；
- 恢复：desktop continuous 与 mobile replayable 使用独立 subscription ownership 和 delivery kind，
  最终收敛到同一 snapshot；
- 旧 `session/*` schema 只允许维护剩余兼容 facade，不能承接新 conversation 功能。

详见 [ZCode Protocol](./zcode-protocol.md)。

## Provider 就绪与启动

Provider readiness 只门禁会改变 session/workspace 或执行模型的写路径。Service 检查当前 Environment
Registry 至少存在一个可运行 Provider/Model 和所需访问材料；检查只验证本 Environment 的结构，不做网络探测。未满足时写路径返回稳定的
`provider_not_ready`，不创建 draft session，草稿 UI 显示已有的模型配置缺失入口。

只读控制面不依赖模型：`sessions-index`、已有 `conversation/<sessionId>` 与其 resync/unsubscribe 可以按需启动并
复用 workspace CLI，使无模型或凭据迁移失败时仍能展示任务列表和读取历史。只读启动后，后续
`createSession` / command 仍必须重新经过 readiness 门禁；active client 不能成为绕过条件。该修复不新增协议字段，
也不改变 desktop continuous、mobile replayable、connection ownership 或 workspace identity 边界。

`provider_not_ready` 是新用户尚未完成配置的正常等待态，不是 sessions-index 订阅故障。Registry 变为 ready 时，
Agent Service 复用已由只读订阅启动的 Worker，或在尚未启动时按 workspaceKey 单次启动；Worker 从当前
Environment 的 Config Source 重建 Registry；topic
订阅不需要等待模型配置，也不能要求用户重启 App。

所有 topic 重试原因必须使用有界枚举，禁止把上一轮日志 reason 再拼入下一轮。非 readiness 的持续故障允许保留
自动恢复，但相同错误的 production `warn` 至多每分钟一次；成功建立订阅后清空该 topic 的退避和限频状态，使后续
新故障仍能立即留下首条诊断日志。

Registry 后续变为 ready 时，Service 按 workspaceKey 单次启用已登记 workspace 的模型执行能力。
配置随后失效时更新当前 Environment Registry，但不主动杀死已经运行的进程。远程 workspace 的只读订阅仍沿既有 desktop
shared-host attachment 启动目标 CLI；手机 `/remote` 不得因此另起 Agent/runtime。

草稿模型不是“全部由 Agent 默认决定”：V4 draft 会读取 workspace catalog 和该 workspace 下的全局上次选择，
并通过预热 `createSession.config` / CAS 建立 CLI session 初值。已有 session 一律以 snapshot config 为准。

## 启动 workspace 不可用

桌面启动只用上次 active 的本地 workspace 决定 UI 是否进入只读恢复。路径缺失、不是目录或不可访问时：

- 仍恢复原 workspace tab、tasks-index 和历史 session；
- renderer 生命周期内标记为 `unavailable-local-directory`，不写回 setting，也不运行中轮询；
- 允许只读浏览、搜索、复制、切换/关闭 workspace 和设置；
- 禁止会修改 session/workspace 的发送、重试、fork、compact、列表 mutation、附件、文件树、Git、终端等入口；
- 本地桌面恢复链路始终确保 app-managed conversation backing workspace 存在，并把它作为 local Host
  的 Agent spawn fallback；任意已恢复的本地 workspace（包括非 active 的历史 workspace）只在自身 cwd
  不可用时降级到该目录，协议 workspacePath/identity 仍保留原值。

远程 workspace 和非 active 本地 workspace 不参与启动 UI 可用性判定。非 active 历史 workspace 在
tasks-index 建立后台订阅时由 Agent spawn preflight 动态检查真实 cwd；缺失目录不得导致 Helper `ENOENT`
或持续重启。active 路径在运行中恢复后仍保持只读，下一次启动重新判定。

## 远程资源与打包

当前默认远端部署/桌面打包只保留 ZCode Agent 及必要工具/runtime（例如 Node、node-pty、ripgrep 和各平台
search runtime）。历史 `resourcePackages.selectedPackageIds` 只兼容读取，不能裁剪当前必需资源。构建脚本、
签名和 Windows 资源锁检查都不得把本机残留的退役第三方 runtime 重新带入产物。

- `@zcode/desktop` 的 `prepare:glm` 仅保留为手动下载旧原生 Agent 的兼容兜底；默认本机打包通过
  `prepare:agent-bundle` 准备 `zcode.cjs`。`prepare:native-search` 按目标平台下载 `bfs`、`ugrep`、`ripgrep`
  预编译归档，旧 `prepare:rg` 不再作为独立维护入口暴露。
- `pnpm dev:desktop` 的本地 runtime 自检只补齐当前平台的 native-search 工具集和必需平台 helper：
  macOS/Linux 的工具集为 `bfs`、`ugrep`、`ripgrep`，Windows x64/arm64 为 `ugrep`、`ripgrep`；自检不再
  检查或下载 `glm/zcode-agent`。开发态 Agent 由 `dev-desktop-env.mjs` 在 `pre-dev` 后调用
  `build-desktop-agent-cli.mjs` 构建，运行时优先使用 workspace 内的 `dist/zcode.cjs`。
- 桌面安装包携带 `resources/glm/zcode.cjs`、`resources/tools/ugrep` 与 `resources/tools/ripgrep`；
  macOS/Linux 另携带 `resources/tools/bfs`。

Agent runtime 版本事实源是 `packages/shared/src/zcode-agent-runtime.ts`。本地开发、desktop build、remote
manifest 和下载逻辑应共同读取它，不再从旧 provider runtime 清单推断。

## 当前入口

- `packages/services/src/zcode-agent/zcodeAgentService.ts`
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- `packages/services/src/zcode-agent/zcodeProtocolClient.ts`
- `packages/services/src/zcode-agent/zcodeStdioTransport.ts`
- `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`
- `packages/ui/src/v4/V4ConversationContext.tsx`
- `packages/ui/src/v4/SessionPane.tsx`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`

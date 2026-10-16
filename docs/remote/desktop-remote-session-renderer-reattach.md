# 桌面端远程 Workspace Renderer 重挂设计

> **当前状态**：renderer 重挂继续作用于同一 BrowserWindow 内仍存活的 logical remote session。
> SSH session 可能共享 `sshHostsByPoolKey` 对应的 Remote Host；WSL session 按
> `window + normalized(distro,user)` 共享池化 Host；Docker/Server 使用 dedicated Host。
> 重挂只替换该 logical session 的 attachment/renderer port，不能销毁共享 Host 或改变 replayable 边界。

## Feature Summary

| Field                 | Value                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | 桌面端 renderer reload / React ErrorBoundary 刷新后，main 需要把仍然存活、承载该 workspace scope 的 Remote Host 重新挂到新的 renderer service store。                                                               |
| User-visible surfaces | 已打开的 SSH / WSL / Docker remote workspace tab、远程任务列表、首次发送和文件树等 workspace RPC。                                                                                                                  |
| Existing docs         | `docs/remote-workspace-session-unified-settings.md`、`docs/architecture/zcode-code-architecture-overview.md`、`docs/architecture/message-flow.md`、`docs/web-remote-control/web-remote-control-architecture.md`。   |
| Existing code owners  | `packages/desktop/src/main/desktopRemoteSessions.ts`、`packages/desktop/src/main/desktopWindowLifecycle.ts`、`packages/desktop/src/renderer/src/main.tsx`、`packages/ui/src/store/remoteWorkspaceSessionStore.ts`。 |
| Out of scope          | 不做 SSH 自动重连；不改变手机 `/remote` 的 `web-remote-replayable` 恢复语义；不把 disconnected history tab 启动时自动连回远端。                                                                                     |

## Clarification Log

| Round | Question                                                                            | User answer  | Boundary fixed                                                         | Follow-up needed |
| ----- | ----------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- | ---------------- |
| 1     | renderer reload / 崩溃 / ErrorBoundary 刷新导致 remote session 绑定丢失是否值得修？ | 值得，继续。 | 优先修复桌面端 renderer 状态丢失但 main remote host 仍存活的失绑问题。 | no               |

## Boundary Decisions

| Boundary   | Decision                                                                          | Includes                                                                           | Excludes / prunes                                        | Source    |
| ---------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- | --------- |
| 重挂对象   | 只重挂 main 侧仍 tracked 且 `connected=true` 的 remote workspace session。        | renderer reload、ErrorBoundary `window.location.reload()` 后的同一 BrowserWindow。 | pending 连接、已 dispose session、host 已 exit session。 | code      |
| 主路径语义 | 保持 desktop `desktop-continuous` 主链路。                                        | 重新投递 `RemoteServicePort`，让 renderer 重新注册 remote services。               | 不使用 mobile replayable snapshot/gap 恢复。             | docs      |
| 启动恢复   | 仍只恢复 disconnected remote tab，不后台连接。                                    | settings 里的 remote history 保持手动重连。                                        | 不把 app 冷启动当成 live session 恢复。                  | docs      |
| 远控桥接   | 复用现有 `AttachServicePort` 模式，但不改变手机 shared-host attachment 生命周期。 | main 给桌面 renderer 新端口。                                                      | relay/main 不拥有 task/session state。                   | docs/code |
| 投递时序   | renderer 允许 remote service port 早于 base ServicePort 到达。                    | 早到的 remote port 先暂存，base services 注册后再 flush。                          | 不因为 base services 暂未 ready 而丢弃 remote port。     | code      |

## Domain Scope

| Domain                            | Include? | Why it can change behavior                                                         | Primary sources                                              |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Architecture/process boundary     | yes      | renderer、desktop main、remote host 三层重新建立 RPC transport。                   | `docs/architecture/zcode-code-architecture-overview.md`      |
| Workspace identity/remote runtime | yes      | 重挂必须保留 `remoteSessionId`、`target`、`workspaceIdentity/workspacePath` 隔离。 | `docs/remote-workspace-session-unified-settings.md`          |
| Mobile remote/replayable realtime | limited  | 需要确认不影响手机 replayable 远控 attachment。                                    | `docs/web-remote-control/web-remote-control-architecture.md` |
| Conversation/session behavior     | no       | 不修改 session 内容、queue、snapshot 或 replay 规则。                              | `docs/testing/conversation-session-e2e-coverage-matrix.md`   |

## Concept Map

| Concept                            | Why it matters                                                                 | Source                                               |
| ---------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `RemoteServicePort`                | renderer 注册 remote services 的唯一运行态入口。                               | `packages/desktop/src/renderer/src/main.tsx`         |
| `remoteWorkspaceSessionsById` | main 侧 logical session、Host 引用和 attachment 的权威索引。                   | `packages/desktop/src/main/desktopRemoteSessions.ts` |
| `sshHostsByPoolKey`                 | 同窗口 SSH Host 存活和 readiness 的权威索引。                                  | `packages/desktop/src/main/desktopRemoteSessions.ts` |
| `AttachServicePort`                | remote host 已有 `activeServices` 时可补挂新的 RPC port。                      | `packages/desktop/src/host/index.ts`                 |
| disconnected remote tab            | settings 恢复的 remote tab 不含 live `remoteSessionId`，必须等待用户手动重连。 | `docs/remote-workspace-session-unified-settings.md`  |

## State Owners

| State / fact                       | Authority                     | Mirrors / caches      | Evidence                                       |
| ---------------------------------- | ----------------------------- | --------------------- | ---------------------------------------------- |
| SSH remote host process 是否存活   | desktop main                  | none                  | `sshHostsByPoolKey`                            |
| renderer remote services 是否可用  | renderer Zustand store        | tab `remoteSessionId` | `registerRemoteWorkspaceSession`               |
| remote workspace 身份              | tab/settings remote entry     | main session context  | `workspaceIdentity?.trim() \|\| workspacePath` |
| remote host RPC service collection | host process `activeServices` | attached ports        | `AttachServicePort` log                        |

## Dimensions

| Dimension      | Values / equivalence classes               | Source        | Include? | Reason                                        |
| -------------- | ------------------------------------------ | ------------- | -------- | --------------------------------------------- |
| session state  | pending / connected / disposed-exited      | code          | yes      | 只有 connected 应重挂。                       |
| renderer event | initial create / same-window reload        | code          | yes      | 两者都走 `dom-ready` 后端口投递。             |
| remote kind    | SSH / WSL / Docker                         | shared target | no       | 重挂只依赖 session host，不依赖具体 backend。 |
| client mode    | desktop-continuous / web-remote-replayable | docs          | yes      | 本修复只作用 desktop renderer。               |

## Candidate Combinations

| Candidate ID | State                    | Event                      | Target/surface   | Expected guard/effect                                                        | Initial status | Notes                |
| ------------ | ------------------------ | -------------------------- | ---------------- | ---------------------------------------------------------------------------- | -------------- | -------------------- |
| DRS-RR-01    | connected remote session | renderer reload/dom-ready  | desktop renderer | main 重新发送 `RemoteServicePort`，renderer 可重新注册同一 `sessionId`。     | accepted       | 本次实现。           |
| DRS-RR-02    | pending remote session   | renderer reload/dom-ready  | desktop renderer | 不重挂，避免把未初始化 host 暴露给 renderer。                                | accepted       | 单测覆盖。           |
| DRS-RR-05    | connected remote session | remote port 早于 base port | desktop renderer | renderer 暂存 remote port，base ServicePort ready 后再注册 remote services。 | accepted       | 本次实现。           |
| DRS-RR-03    | disconnected history tab | app 冷启动恢复             | UI tab           | 仍保持断连占位，不自动创建 SSH runtime。                                     | pruned         | 由现有恢复设计覆盖。 |
| DRS-RR-04    | mobile bridge attachment | mobile reconnect           | web remote       | 保持 shared-host attachment 现有逻辑，不新增 replayable 恢复。               | pruned         | 不在本次改动范围。   |

## Accepted Cases

| Case ID   | Setup                                                                | Action                                                            | Assertions                                                                                                              | Evidence layers                 | E2E status |
| --------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------- |
| DRS-RR-01 | 已 connected 的 remote workspace session 属于 `webContents.id=99`。  | 同一窗口 renderer 重新 ready，main 调用 remote session reattach。 | 旧 attachment 被精确 detach，child 收到带新 `attachmentId` 的 `AttachServicePort`；renderer 收到同一 `sessionId` 的 `RemoteServicePort`。 | unit: main manager message/port | covered    |
| DRS-RR-02 | pending remote workspace session 尚未收到 `Connected`。              | renderer 重新 ready。                                             | 不投递端口。                                                                                                            | unit: main manager no-op        | planned    |
| DRS-RR-05 | renderer 收到 remote `RemoteServicePort` 时 base services 尚未注册。 | 随后收到本地 `ServicePort`。                                      | remote port 不丢弃；base services ready 后 flush pending remote ports。                                                 | unit: renderer source guard     | planned    |

## Pruning Decisions

| Decision ID | Pruned combinations                | Guard/invariant                             | Product reason                                          | Representative coverage    |
| ----------- | ---------------------------------- | ------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| PD-01       | app 冷启动 remote history 自动重连 | settings 恢复只生成 disconnected tab        | 用户关闭远端后不能被后台偷偷拉回。                      | existing persistence tests |
| PD-02       | mobile replayable snapshot 恢复    | relay/main 不拥有 task/session/stream state | 手机远控只能 attach existing host，不创建独立 runtime。 | existing web remote tests  |

## E2E Handoff Notes

- Provider fixture: 不需要。
- File-system fixture: 不需要。
- Timing strategy: unit test 直接模拟 `Connected` 和 renderer ready。
- Docker preset: 不需要。
- Review risks: 需要确认 same-window reload 不重复注册 pending session；connected session 重挂不改变 remote host 生命周期。

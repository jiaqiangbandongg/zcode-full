# Workspace / App 入口草稿态

## Feature Summary

| Field                 | Value                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Change                | app 冷启动和 workspace 级打开入口不再自动选择上次 session，只进入空草稿                                                    |
| User-visible surfaces | Desktop 启动恢复、打开本地/远程 workspace、侧栏 workspace 行、系统 workspace focus                                         |
| Existing docs         | `docs/conversation-session-case-catalog.md` TSL、`docs/v4-refactor/06-ui.md`                                               |
| State owners          | tab/workspace 激活由 tab store 持有；草稿/`activeTaskId` 由 workspace Zustand 桶持有；pane/group 是 renderer-local UI 状态 |
| Out of scope          | 显式点击历史 session、通知/task deep link、session 内容恢复、CLI projection、手机 replayable gap/snapshot                  |

## Clarification Log

| Round | Question                                             | User answer          | Boundary fixed                                   | Follow-up needed |
| ----- | ---------------------------------------------------- | -------------------- | ------------------------------------------------ | ---------------- |
| 1     | 打开 workspace 或启动 app 是否需要默认打开 session？ | 不需要，只需要草稿态 | workspace/app 级入口必须保持 `activeTaskId=null` | no               |
| 2     | 远程连接成功后的 workspace 切换期间，右侧是否允许先空白再显示草稿？ | 不允许；仍需激活远程 workspace，但右侧应直接进入新建对话 | 远程 tab 激活与目标 workspace 的 `startDraft` 必须属于同一提交阶段，列表刷新不得夹在两者之间 | no |
| 3     | 从侧栏激活断连 remote workspace 时，连接期间右侧显示什么？ | 连接期间保留当前右侧内容；连接 ready 后再切换为远程新建对话 | 不得先激活缺少 `remoteSessionId` 的断连 tab；连接、identity 和 services ready 后再原子提交 tab + draft | no |
| 4     | 从远程历史入口打开断连 workspace 时，成功后是否只更新 tab？ | 不可以；与侧栏重连一致，ready 后必须进入目标 workspace 的新建对话 | 历史入口必须传递统一的 workspace 激活回调；顺序固定为补齐 tab → 激活精确 identity → `startDraft` → pinned/timeline 刷新 | no |

## Boundary Decisions

| Boundary         | Decision                                             | Includes                                  | Excludes / prunes               | Source                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------- | ------------------------------- | --------------------- |
| app 冷启动       | 恢复 workspace tab，但不恢复可见 session owner       | 本地、SSH/WSL/Docker tab                  | 不删除历史 session              | user                  |
| workspace 级入口 | 每次显式打开/激活 workspace 都进入草稿               | 文件夹选择、workspace 行、系统 focus      | 显式 session/task 导航          | user                  |
| renderer reload  | 保留当前 session 的 pane 恢复                        | 同一 renderer 刷新、输出中续流            | app 进程冷启动                  | existing M3 contract  |
| 首次执行         | 首次发送或必须依附 session 的命令才创建/绑定 session | draft promotion                           | 启动/打开时隐藏创建正式 session | conversation protocol |
| 多端             | workspace 入口语义一致；delivery profile 不变        | desktop continuous、web remote replayable | relay/main 持有 session 状态    | architecture          |
| 远程连接完成     | ready 前保留当前右侧；ready 后激活远程 tab 并立即切换该 workspace 的草稿归属 | SSH/WSL/Docker/Server 首次连接与断连 tab 复用 | 提前激活 `remote-waiting` tab；等 pinned/timeline 刷新后才 `startDraft` | user |

## Domain Scope And State Owners

| Domain                        | Include?       | Authority / evidence                                                         |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------- |
| Conversation/session behavior | yes            | `activeTaskId`、draft DOM、首次 `createSession` command                      |
| UI shell / persistence        | yes            | tab activation、pane layout、workbench group、last-session renderer storage  |
| Workspace identity            | yes            | `workspaceKey = workspaceIdentity?.trim() \|\| workspacePath`               |
| Mobile replayable             | representative | 只证明入口不选 session；不改变 snapshot/gap/owner/lease                      |
| Provider/runtime/queue        | pruned         | 不改变首次发送后的既有行为                                                   |

```text
app cold launch / open workspace
  -> activate exact workspaceKey
  -> deactivate visible workbench group + reset primary pane (desktop only)
  -> activeTaskId = null
  -> render draft

explicit session/task navigation
  -> activate exact workspaceKey
  -> activeTaskId = target sessionId
  -> optionally restore that session's workbench

draft first send
  -> createSession
  -> bind returned sessionId
  -> subscribe continuous | replayable according to trusted attachment

remote workspace selection / disconnected workspace reconnect
  -> keep current active workspace and conversation while connecting
  -> remote services + workspace identity ready
  -> activate/upsert exact remote workspace tab
  -> startDraft for the same workspaceKey in the same interaction stage
  -> render remote draft without an empty intermediate pane
  -> refresh pinned/timeline task lists as async follow-up
```

## Candidate Combinations And Pruning

| Candidate ID | State                                    | Event                                 | Expected effect                                          | Status   | Notes                                        |
| ------------ | ---------------------------------------- | ------------------------------------- | -------------------------------------------------------- | -------- | -------------------------------------------- |
| WED-01       | persisted workspace + last session       | app cold launch                       | workspace visible, primary draft, no session selected    | accepted | stale pane/group owner cannot override draft |
| WED-02       | workspace has historical sessions        | workspace-level open/activate         | target workspace draft                                   | accepted | exact identity bucket only                   |
| WED-03       | historical session exists                | explicit session click/task deep link | open target session                                      | accepted | not a workspace-only entry                   |
| WED-04       | session is running in current renderer   | renderer reload                       | restore the selected session and continue projection     | accepted | preserves M3 refresh continuity              |
| WED-05       | mobile remote attachment                 | workspace-only switch                 | draft without changing replayable recovery               | accepted | shared-host boundary unchanged               |
| WED-06       | 当前右侧正在显示本地或其它 workspace；目标远程 workspace 尚未连接 | 选择远程目录、点击侧栏断连 workspace，或从远程历史入口打开断连 workspace | 连接期间保留当前右侧；services ready 后先补齐 tab，再激活精确远程 workspace，并在任务列表刷新完成前同步进入该 workspace 草稿 | accepted | 禁止暴露 `remote-waiting` active tab；三条入口必须复用同一 tab activation 与 draft owner 提交语义 |
| WED-P01      | provider/model/theme/locale combinations | any WED entry                         | same navigation result                                   | pruned   | these dimensions do not own selection        |
| WED-P02      | queue/goal/compact/fork/tool state       | app/workspace entry                   | historical session remains in history, not auto-selected | pruned   | no command is sent to that session           |

## Accepted Cases And Matrix Backfill

| Case ID | Setup                                    | Action                             | Assertions                                                               | Evidence                            | E2E status |
| ------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------- | ---------- |
| TSL08   | persisted last-session/group/pane exists | cold launch or workspace-only open | `activeTaskId=null`; one primary draft; no restored session subscription | UI + renderer store + command trace | planned    |
| TSL09   | current renderer shows a running session | reload renderer                    | same session is rebound; projection continues                            | UI + subscription/session id        | planned    |
| TSL10   | draft or another workspace is visible    | click a historical session         | target session opens; exact workspace identity selected                  | UI + renderer store                 | planned    |
| TSL35   | local/other workspace conversation is visible; target remote workspace is disconnected | select a remote directory or click the disconnected workspace | current conversation remains mounted while connecting; after services become ready, exact remote tab and its primary draft become visible before pinned/timeline refresh settles | UI + tab/Zustand ordering + deferred connect/refresh | covered-unit |

E2E 使用无 provider 请求的启动/导航 fixture；TSL08 在首次发送前必须断言没有 `createSession` conversation command。TSL09 继续使用 controlled stream 证明 reload 续流，不把 app 冷启动与 renderer reload 混成同一等价类。

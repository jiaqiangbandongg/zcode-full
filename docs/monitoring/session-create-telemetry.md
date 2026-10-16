# Session 创建业务埋点

## 口径

`session_create` 通过 `/api/v1/event/report` 统计用户草稿或自动化实际新建且首发接纳的正式会话。
Group / Project 点击只确定来源；默认空态直接输入的来源为 `session`。
预热 `createSession`、重复点新建、未发送草稿、打开历史、后续轮次、fork、subagent、
自动化复用已有会话均不计入。首条普通输入或有效 Goal 命令被接受后报告；失败不报告。
自动化只有实际新建 Session 且首条 sendPrompt accepted 才计入，不等待 message_completion。

```text
Group / Project / 默认 Session 空态
    -> 草稿来源（首发前冻结）
    -> 预热 session 或 fallback createSession
    -> 首条输入 accepted
    -> session_create（按 workspace identity + session 去重）

Desktop IPlatformService -> IPC -> TelemetryCore -> /event/report
Mobile  IPlatformService -> 已配对 relay app payload -> Desktop Main -> TelemetryCore
Automation Host 新建 + 首发 accepted -> 严格 telemetry 消息 -> Desktop Main -> TelemetryCore
```

事件固定 `element_name=session_create`、`event_region=app`、`event_type=result`，
顶层 `talk_id` 为创建的 session ID，`message_id` 必填，为首次 accepted 输入的 command ID，
与该轮 message_completion.message_id 一致。公共 user/device/version/marketing 字段沿用 TelemetryCore。

| event_extra_detail 字段 | 值 |
| --- | --- |
| create_source | `group` / `project` / `session` / `automation_idle` / `automation_scheduled` |
| client_kind | `desktop` / `mobile` / `web`；mobile 表示 Web 远控入口，不按 UA 猜设备 |
| workspace_kind | `local` / `remote` |
| remote_kind | `ssh` / `wsl` / `docker` / `server` / 空字符串 |

workspace 类型复用 conversation telemetry：identity 或 remoteSessionId 任一非空就是
remote；remote_kind 由 `parseRemoteWorkspaceIdentity` 提取，未知 identity 保留 remote。
身份隔离用 `workspaceIdentity?.trim() || workspacePath`，不上报路径、identity 原文或远端地址。

侧栏 Project 当前是 workspace 分组，没有独立持久化项目 ID。CLI session 表的
`project_id` 确实存在，但 `projectIdFromDirectory` 仅将目录小写化、替换符号、截取
80 字符；不是 opaque ID，也不区分同路径远端主机，且可能碰撞。V4 创建 ACK 未暴露它。
Tab ID 是 UI 身份，Coding Plan 的 projectId 是计费项目，两者也不作为该字段。
本次不新增/伪造 project_id；项目级统计需要先定义跨端、远端隔离的稳定身份合同。

## 自动化与幂等合同（2026-09-15 补充）

- create_source 扩展 `automation_idle` / `automation_scheduled`。闲时只有 `init`
  计入，`bound-first-run` / `resume` 不计入；定时只有未传 `targetTaskId`、实际调用
  createTask 的分支计入。prompt 创建并绑定原会话的定时任务追加消息不计入。
- 自动化触发归属由当前 Host 派发函数判断；sendPrompt accepted 后通过严格的
  Host → Main 事件转发。Main 只校验/转发，不维护 Session 状态；UI 不从订阅补报。
- 自动化 client_kind 为 desktop（执行宿主），不反推最初在哪个设备创建任务配置。
  Host context 使用运行环境 timezone/locale，screenResolution 留空，不伪造屏幕尺寸。
- TelemetryCore 为 session_create 按 `[版本命名空间, user_id, talk_id]` 的 SHA-256
  前 128 位生成 UUIDv8 格式 event_id。Session ID 本身为全局 UUID；来源/设备不参与键，
  同一用户和 Session 跨报告、重试和 Core 重建保持同一 ID。其他事件仍使用随机 UUID。
- event_id 供服务端幂等消费；本仓库不包含生产接收端去重实现，不宣称端到端 exactly-once。
  网络失败延用现有有界重试，不引入持久发送队列。accepted 后即报告，不依赖完成事件；
  message_id 使用首发输入命令身份，accepted 时已可取得，不是 Assistant row ID。
- 不改调度、owner/lease、CLI admission 或桌面 continuous / 手机 replayable 恢复边界。
- 测试：真实派发函数覆盖闲时 init/绑定/续跑、cron 新建/绑定原会话、首发拒绝/挂起；
  Host schema/消息转发、event_id 重试与多实例稳定性；桌面 E2E 验证最终 event_id。

## 边界

message_id 的唯一事实源为输入命令：UI 普通/预热/Goal 首发使用 accepted ACK.commandId，
createSession(firstInput) 使用该创建命令 ACK.commandId；空 createSession 后另行首发时
使用 sendText/Goal 的 commandId，不能误用空创建命令。用户确认恢复重发使用新 ACK 的
commandId。自动化使用实际 sendPrompt 的 traceId（cron 为 runId，闲时 init 为 task.traceId）。
手机与 Host 的严格转发 schema 均要求非空 messageId；不新增另一套 ID、不从完成消息反查。
event_id 仍只按用户与 Session 幂等，不将 message_id 加入创建事件的幂等键。

```text
首发命令 ID -> accepted ACK -> session_create.message_id
          \-> 后续完成事实 -> message_completion.message_id（同一值）
```

用户草稿由发起 UI 报告，自动化新建由派发 Host 报告；Desktop 不从手机/桌面订阅流补报。
手机只透传本事件的严格 schema，不启用其他原有 desktop-only conversation 事件。
Main 不保存 session、queue、owner 或去重业务状态；使用已有配对连接与 TelemetryCore。
Desktop continuous 和 Mobile replayable 的 command、snapshot、恢复行为不变，
workspaceIdentity/remoteSessionId 继续沿原 attachment 传递。

去重保留当前 Renderer 最近 4096 个 workspace/session 组合，覆盖重复创建回调/多 pane；
不宣称跨崩溃或断线丢 ACK 场景 exactly-once。
埋点为旁路，不阻塞导航、发送，不把上报失败转为创建失败。

## 验证

- 单测：三种来源；local/SSH/WSL/Docker/server/未知 identity；mobile+SSH；
  同 session 重复回调只一次，同路径不同远端 identity 隔离；无 project_id/路径泄露。
- 单测：草稿来源的设置/重定位；手机 schema 拒绝其他事件/多余字段；宿主转发。
- Pending E2E：预热零事件、首发一条带 talk_id、续发和历史重开不增加事件；
  Group/Project 来源由真实 UI 创建入口验证。
- `pnpm typecheck`、`pnpm lint`、`pnpm --filter @zcode/desktop typecheck:e2e`。

### 2026-09-15 验证记录

- macOS Electron + case-local 模型回放通过：Project / Group / 刷新后直接首发三种
  入口最终 `/event/report` 请求体、预热零报告、续发与历史重开不重复。
  Run：`desktop-e2e-20260915062832206-p33122-e75382b73612e1b7`。
- 全仓类型检查、E2E 类型检查、lint（0 errors）、架构检查通过。
- 8 个相关单测文件共 173 条通过，含 Goal accepted/rejected 和上报失败隔离。
- 手机 strict schema 和 Desktop Main 转发由单测覆盖；手机实机、SSH/WSL/Docker
  实机与 Windows/Linux UI 尚未验收，不计为跨平台 E2E 已通过。
- 全仓 conversation coverage audit 未通过：基线已有 D19/I74/I75 引用错误、统计数
  与三个生成文档过期；本次 pending fixture metadata 为 0 rejected。
- E2E 保持 pending，未人工 review / promotion。

### 自动化与 event_id 补充验证

- 11 个相关单测文件共 137 条通过；全仓 typecheck、E2E typecheck、lint
  （43 条既有 warning、0 error）、architecture:check（0 violation）通过。
- 三入口创建及最终 UUIDv8 event_id E2E 通过：
  `desktop-e2e-20260915070847887-p40115-4254803e37acd6f0` 的创建事件用例。
- 定时任务 UI 新建后立即运行、Host → Main → `/event/report` 完整链路 E2E 通过：
  `desktop-e2e-20260915071458180-p44110-b9e884f38651cbd9`，来源 automation_scheduled、
  talk_id 和稳定 event_id 均有断言；两条用例的 fixture check 通过。
- 闲时 init/绑定/续跑、cron targetTaskId 追加、首发失败/等待由生产派发函数的隔离
  测试验证；没有将其计为闲时/远端/手机实机 E2E。生产接收端的 event_id 去重未验证。
- 全仓 typecheck 会输出 Host 编译产物，不能和 Electron 打包/运行并行；本次最终自动化
  E2E 在 typecheck 完成后重新构建运行。账号 mock 显式隔离，表单显式选择 case 回放模型。

### message_id 补充验证

- 8 个相关单测文件共 110 条通过，含普通/预热/Goal、空创建后发送、确认恢复重发、
  闲时/定时首发 ID、手机/Host 必填 schema 与转发；event_id 不随 message_id 改变。
- 三入口 E2E 通过：`desktop-e2e-20260915072807214-p50394-fa16c0175fef4bc5`。
  逐轮确认创建和完成事件的 message_id 相等；Group 关联断言在刷新前完成，
  避免把刷新时未完成的异步上报误判为 ID 不一致。
- 定时任务 E2E 通过：`desktop-e2e-20260915072551534-p48619-f5fdee3f954ae066` 的
  automation-run-title-stable 用例，最终 HTTP 两事件的 message_id 与 runId 一致。
- 全仓 typecheck、E2E typecheck、lint（43 warnings、0 errors）、架构检查通过。
  两条 fixture check 通过。手机和远端实机验证状态沿用上节，不宣称新增实机覆盖。

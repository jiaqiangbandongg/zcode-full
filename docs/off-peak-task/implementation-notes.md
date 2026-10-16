# 闲时任务（Off-Peak Task）实现说明

> 面向维护者的实现地图。产品口径与决策见 `spec.md` / `decisions.md` / `tech-design.md`（真源），
> 本文只记录"代码落在哪、怎么串起来"。范式：Automations 体系下的一次性后台任务（D28）。

## 一图看全链路

```
创建表单(OffPeakEditView) ──RPC──▶ IOffPeakTaskService.createTask
                                      │ 取号 POST /ticket（成功才落库）
                                      ▼
                            off_peak_tasks(sqlite, OffPeakTaskRepo)
                                      │ history_deleted_at 仅控制 History 可见性
                                      ▲                    │
        offPeakTaskSync 轮询 /ticket/status 写回 schedulable/位次   │ scheduler tick 认领 schedulable=1
                                      │                    ▼
                                      │        offpeak-dispatch-request ──▶ main ──▶ host OffPeakRun
                                      │                                              │ createTask/resume + sendPrompt
                                      │                                              │  (idle Selection + modelExecution, D33/M4)
                                      │                                              ▼
                                      │                              agent loop ──▶ idle plan provider
                                      │                                              │  POST /off-peak/anthropic/v1/messages
                                      │                                              ▼
                                      │                                   网关(真实/进程内 mock)
                                      │   400/3102 票过期 ◀──────────────────────────┘
                                      │        │ host 识别标记 → handleTicketExpiredDuringRun
                                      └────────┘   同 task_id 重取号 → resume 同 session 续跑
                              终态 → markTerminal → settle 核销 outbox → 系统通知
```

## 关键文件

| 层        | 文件                                                                                                  | 职责                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 类型/协议 | `packages/shared/src/off-peak-types.ts`                                                               | 七态领域类型、错误标记常量、`OFF_PEAK_PROVIDER_ID`                                                                                       |
|           | `packages/shared/src/channels.ts` + `validation.ts`                                                   | `OffPeakRun`/`OffPeakRunResult`/`OffPeakSchedulerWakeRequest` 消息对；V4 `sendText.modelExecution`（D33/M4）                             |
| 存储      | `packages/services/src/session/offPeakTaskRepo.ts`                                                    | `off_peak_tasks` DDL + 状态机守卫；`history_deleted_at` 兼容迁移与本地 History 隐藏                                                      |
| 服务      | `offPeakServerClient.ts`                                                                              | availability/取号/批量状态/结算四接口；每个请求只解析一次 selected credential snapshot，并成对注入 Team org/project（messages 不走这里） |
|           | `offPeakMockGateway.ts`                                                                               | 进程内 mock 网关（`ZCODE_OFFPEAK_MOCK=1`）；`resolveUpstream` 返 null 回固定响应                                                         |
|           | `offPeakTaskService.ts`                                                                               | 编排：创建取号/取消/Pause-Continue/删除/编辑/Delete history + offPeakTaskSync 轮询晋级 + 核销 + 3102 续跑                                |
|           | `offPeakRuntimeModel.ts`                                                                              | selected Coding Plan 分类与 credential snapshot + 单次 Request Auth 构造 + origin/mock 上游解析                                          |
|           | `offPeakTask.ts`                                                                                      | `IOffPeakTaskService` 描述符（renderer RPC 面，向 UI 只暴露脱敏 Coding Plan support）                                                    |
| 调度      | `packages/desktop/src/scheduler/index.ts`                                                             | offPeak tick：认领 schedulable 派发、启动 recoverInterrupted、active 计数上报                                                            |
|           | `packages/desktop/src/main/desktopCronScheduler.ts` + `index.ts`                                      | 派发路由、结果转发、keep-awake powerSaveBlocker                                                                                          |
| host      | `packages/desktop/src/host/index.ts`                                                                  | OffPeakRun 处理：createTask/resume + idle Selection/`modelExecution` 注入 + 终态回写 + 3102 续跑                                         |
| 适配层    | `apps/zcode-cli/packages/adapters/src/model/offpeak-retry.ts`                                         | 429/3105 排队豁免预算无限探测 + 400/3102 续跑标记（仅 idle plan provider）                                                               |
|           | `apps/zcode-cli/.../commands/handlers/session-flow.ts` + `prompt-turn.ts`                             | execution-scoped Selection/Request Auth 进入 Core；不修改 Session Selection、不进入普通 Queue（D33/M4）                                  |
| UI        | `packages/ui/src/settings/{AutomationsSection,OffPeakEditView,OffPeakTaskList,OffPeakHistoryTab}.tsx` | 三 Tab/本地项目创建/列表卡片/History/灰度与订阅门控                                                                                      |
|           | `packages/ui/src/store/offPeakTaskStore.ts`                                                           | zustand store（列表/灰度/CRUD/10s 轮询；selected-connection support；availability 快照控制额度置灰与到点重查）                           |
|           | `packages/ui/src/hooks/useOffPeakTaskNotifications.ts`                                                | 完成/失败系统通知；permission/elicitation 由普通 session 通知链路负责                                                                    |

## 会话内创建（D49，v2）

```
用户会话 turn ──模型 tool_use OffPeakCreate/OffPeakList──▶ core/tool/handlers/off-peak.ts
      │  （offPeakTurn 拒 Create；automationTurn 放行=组合玩法 D49-3）
      ▼
bootstrap/zcode-protocol/offpeak-port.ts（activeOffPeakTaskId 递归拒；无标题冻结/无绑定检查）
      │ requestClient offPeak/create|list
      ▼
services zcodeAgentService offPeak/* handler（缺省解析：yolo / allowed_models 末位 / 最高档；
      │  model 白名单预校；workspace 闭包注入）──▶ OffPeakTaskService.createTask（同表单链路）
      ▼
成功输出 → ConversationTurnGroup 轮尾静态卡（月亮+标题+位次快照+「去到闲时任务」）
      → onOpenAutomationsMain(offPeakTaskId,"idle") → AutomationsSection offpeak- 前缀分流
      → offpeak-edit 视图（queued/paused 可编辑，running/终态 readOnly）
```

| 层 | 文件 | 职责 |
| --- | --- | --- |
| contracts | `apps/zcode-cli/packages/contracts/src/tools/off-peak.ts` + `interfaces/off-peak.port.ts` | 工具 schema（title/prompt 必填，permissionMode/model/thoughtLevel 可选）与 OffPeakPort 判别联合 |
| core | `core/src/tool/handlers/off-peak.ts`、`runtime/methods/turn-loop-state.ts`（isOffPeakCreateRestrictedTurn + OFF_PEAK_MUTATION_TOOL_NAMES） | handler 最终拒绝边界 + turn 三信号；注册门 `includeOffPeak = Boolean(deps.offPeakPort)` |
| bootstrap | `zcode-protocol/offpeak-port.ts`、`server-operations.ts`（offPeakToolEnabled 才注入端口）、`zcode-protocol-v4/commands/prompt-turn.ts`（activeOffPeakTaskId + denylist） | 协议桥与 turn 身份维护；flag 缺省不注入 = fail-closed |
| services | `zcodeAgentService.ts`（offPeak/create|list handler、offPeakToolEnabled 下发+compat、缺省解析）、`automationToolPolicy.ts`（OFF_PEAK_MUTATION_TOOL_NAMES 独立常量）、`node.ts`（前向引用 holder 注入） | host 侧编排；**OffPeakCreate 绝不混入 AUTOMATION_MUTATION_TOOL_NAMES 的任何副本** |
| host | `packages/desktop/src/host/index.ts` 派发 `toolDenylist: ["CronCreate","OffPeakCreate"]` | D45+D49-2 对称主落点 |
| UI | `ui/src/ToolCallBlocks/renderers/offpeak-create.tsx`、`v4/ConversationTurnGroup.tsx`（resolveOffPeakTurnCards）、`settings/AutomationsSection.tsx`（resolveOffPeakDetailNavigation） | 静态轮尾卡与 idle tab 编辑跳转 |

## 计费边界（D33，最容易踩坑）

idle plan 使用隐藏 Built-in Provider 与标准 Model 执行链，Session Selection 始终是用户自己的：

- 首次派发创建 session 前以 `workspace/readState(preferWorkspaceDefaults=true)` 读取 workspace 默认视图，按 `defaultModel` → `lastUsed` → `settings.model.current` 快照完整 `providerId/modelId` 并显式传给 `createTask`；禁止读取 active session 的运行态模型，也禁止在 OffPeak 层退回 `available[0]` 或 provider registry 的字典序首项。旧 catalog 的 current 由普通 `session/create` 同源 bootstrap 产生。OffPeak 表单模型仍只用于 idle plan turn。
- 派发的 `sendPrompt` 带精确 idle Model Selection 与最小 `modelExecution`；Registry/ModelFactory 创建当前 Loop 的 Active Model，Request Auth 只绑定这次执行。
- 零持久化：不写 Session Selection、Config、Registry View、CLI record、workspace catalog 或普通 Queue，也不产出 modelChange 通知。
- 结果：run session 终态后聊天、busy 插话在当前 turn terminal 后按自己的普通 Submission 与 Session Selection 创建用户模型，不存在回切时序。
- Permission 边界（D44）：确认只走普通 session，Off-Peak task 保持 `running`；批准/拒绝若发生
  在当前自动 turn，仍使用同一个 idle Active Model。不存在 Off-Peak 专用 Review 状态、重复通知
  或“继续将使用你自己的套餐配额”提示。旧库的预留 `awaiting_approval` 值初始化时迁移为 running。

派发错误按可恢复性分流：缺用户模型、缺 idle plan 模型、缺 JWT/Coding Plan Key 为
`permanent`，scheduler 直接把任务置为 `failed` 并停止退避；网络、Agent 生命周期等未知错误
保持 `transient`。修复原因：确定性配置错误重试不会自愈，旧逻辑却一直消耗 ready ticket 并让
UI 永久显示“Waiting for idle compute”。

## Coding Plan 导航、support 与 credential 边界（D40/D41）

```text
settings selected family/mode/key
              |
              v
exact connection classifier ──> registry/Team runtime-key helper
              |
              v
OffPeakCredentialSnapshot { metadata, jwt, codingPlanApiKey }
       |                 |                         |
       v                 v                         v
UI 脱敏 support    ticket 四接口请求头       modelExecution.requestAuth
```

- 支持：ZAI 个人 Coding Plan、BigModel 个人 Coding Plan、BigModel Team 项目连接。
- 拒绝：Start Plan、API Key mode、未选择、active OAuth provider 与所选 family 不一致、
  disabled/stale connection、缺 JWT 或解析中 selection/登录身份改变。
- ticket client 的单个请求只解析一次 snapshot；availability/take/status/settle 与 host 自动 turn 使用同一
  resolver。Team 连接通过 provider registry 的既有 Team runtime-key projection 取 `${apiKey}.${secretKey}`，
  禁止自行拼 secret 或失败后回退个人 key。
- UI 不读取秘密。New Task 主页模板只从已有 provider 快照读取 id/enabled/systemDisabledReason，判断是否
  持有任一 Coding Plan；有套餐但未选 provider 时允许携带草稿进入表单。Automations 创建入口与表单提交
  仍保存并校验脱敏 support metadata，确认当前 family/mode/selected key 与 metadata 一致；它们不会因为
  主页导航放宽而扫描或自动选择其他凭证。

## 本地演示 / 联调

```bash
ZCODE_OFFPEAK_MOCK=1 mise run dev:desktop           # 进程内 mock 网关点亮全流程
# 可调时序（演示 3h 续跑用小值）：
ZCODE_OFFPEAK_MOCK_READY_DELAY_MS=3000 ZCODE_OFFPEAK_MOCK_ACTIVE_MS=30000 \
ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT=2 ...
```

mock 模式灰度强制开启（`resolveOffPeakClientConfig`），`resolveUpstream` 只代理当前 selected Coding Plan；
该 connection 不可用时回固定响应，不会扫描其他缓存 provider。联调切真实服务端：删掉
`ZCODE_OFFPEAK_MOCK` 即走 zcode API origin。

UI 验收使用当前窗口已打开的本地 workspace 作为 Project 候选。手机 `/remote` 不暴露
Automations；桌面远程 workspace 不暴露 Idle-time。不要为了选择远程项目向任务协议补
`remoteSessionId`，本次新建能力明确仅限本地。

## 服务端待对齐（tech-design §7.8）

429/3105 补 Retry-After 文档、take 额度实际值、排队 429 勿带 `x-should-retry:false`、灰度按账号命中则 client/configs 需带 Authorization、`next_poll_after` 单位（客户端按秒实现）。

## 测试

- 单测：`packages/services/test/offPeak*.test.ts`（repo/service/client+gateway/gray config）、`apps/zcode-cli/packages/adapters/tests/offpeak-retry.test.ts`、`apps/zcode-cli/packages/bootstrap/tests/offpeak-turn-model-overlay.test.ts`
- 端到端集成：`packages/services/test/offPeakE2eIntegration.test.ts`（全链路真跑，覆盖 OP02/04/07 服务层机制）
- WDIO GUI E2E（OP01-06）：coverage matrix 已登记为 planned，依赖桌面构建

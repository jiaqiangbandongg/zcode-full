# 定时任务 / 闲时任务消息埋点

> 状态：定时任务消息来源归因 MVP 已接入；闲时任务 V1 使用同一消息事件链路，契约见
> `docs/monitoring/off-peak-task-telemetry-v1.md`。本文中的“未来闲时任务”和 telemetry outbox
> 内容是历史演进方案；与 V1 冲突时以该契约为准，V1 不实现 outbox/retry/restart replay。

## 目标

1. 定时任务和未来的闲时任务都是真实的 Agent 输入轮次，应复用普通对话的
   `message_completion` 与 `agent_step`，以便统一比较时延、工具使用、token 和成功率。

​ 只新增最小的来源维度，不上传 prompt 正文、文件路径或工具输入/输出。定时任务创建轮与后续运行使用

2. 定时任务tool创建时，用已有 `automationId` 使得agent_step.tool_name=croncreate与message_completion 关联；若上报链路不允许传原始 UUID，则传其稳定 hash，但不新增另一套领域 ID。

```text
普通 chat
UI commandId/inputId
        |
        +-- SessionPane ACK -> UI telemetry seed
        |
        +-- message_completion / agent_step -> /event/report

定时任务（已实现）
automation_runs.runId -> Host traceId -> inputId/sourceCommandId
        |                         |
        +-- trigger: schedule/manual
        +-- automationId（规则级稳定关联键；本轮执行上下文）
                                  |
                                  +-- CLI TurnStarted 建立可信 telemetry seed

闲时任务（未实现）
Spec: offPeakTaskId -> 未来 Host sendPrompt -> inputId/sourceCommandId
```

## 1. 普通消息事件口径

公共关联字段：

| 字段                            | 含义                                                                                           |
| --- | --- |
| `talk_id`                       | task / session ID。                                                                            |
| `message_id`                    | 当前输入轮次 ID；V4 对应 `sourceCommandId` / `inputId`。同一轮的 completion 和 step 必须相同。 |
| `model_name` / `model_provider` | 本轮实际模型与 provider。                                                                      |

### `message_completion`

一轮 Agent 输入的最终汇总；每个 `talk_id + message_id` 至多一条。

| 字段组                           | 字段                                                                                                                   | 含义                                                                                                                                                                             |
| --- | --- | --- |
| 时延                             | `request_time`、`duration_ms`、`time_to_first_token`、`waiting_ms`                                                     | 发送时刻、端到端时长、首 token 时长、权限等等待累计。                                                                                                                            |
| 用量                             | `input_tokens`、`output_tokens`、`reasoning_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`total_tokens` | 本轮主 Agent 用量。                                                                                                                                                              |
| 步骤与工具                       | `agent_step_cnt`、`tool_call_total`、`tool_call_failed`                                                                | 当前轮已收口的 step 数和工具调用统计。                                                                                                                                           |
| 结果                             | `status`、`error_type`、`error_msg`                                                                                    | `success` / `fail` / `user_interrupt` ；失败归因使用 `error_type`，`error_msg` 非空原文统一为 `[redacted]`，空串保持空。                                                                                                                               |
| 套餐身份字段                     | `plan_status`、`plan_product_id`                                                                                       | 发送时冻结的用户套餐身份：`coding_plan` / `start_plan` / `no_plan` / `unknown` ； 当前套餐的后端稳定商品 ID.                                                                     |
| 来源与关联（新增）               | `message_source`、`task_trigger`、`automation_id` / `off_peak_task_id`                                                 | 写入 `event_extra_detail`；明确来源、定时/立即运行方式，并把定时任务创建轮和后续运行关联起来。                                                                                   |
| 定时运行时序（新增，仅定时任务） | `scheduled_at`、`schedule_lag_ms`                                                                                      | 写入 `event_extra_detail`；分别是本次计划触发的 Unix 毫秒时间戳，以及 Host 接纳该执行时刻减去 `scheduled_at`。仅 `task_trigger=schedule` 有值；手动运行为空，不复制到每条 step。 |
| 兼容指标                         | `file_change_cnt`、`generated_code_lines`、`ask_mode`、`retry_cnt`                                                     | 现有报表兼容字段；部分沿用历史固定口径。                                                                                                                                         |

### `agent_step`

一轮内的已收口执行步骤；`message_completion.agent_step_cnt` 必须等于该轮实际成功上报的条数。

| 字段组             | 字段                                                                        | 含义                                                                                                                                   |
| --- | --- | --- |
| 顺序与类型         | `step_id`、`loop_index`、`step_type`、`is_tool_call`                        | `step_id` 是同一 `message_id` 内已收口 step 的稳定唯一标识，`loop_index` 是轮内序号；类型为 `reasoning` / `generation` / `tool_call`。 |
| 工具               | `tool_name`、`tool_call_id`                                                 | 工具 step 的名称与调用 ID；非工具为空。                                                                                                |
| 时延与结果         | `duration_ms`、`waiting_ms`、`generation_tail_finalize_ms`、`status`        | step 时长、权限等待、正文末帧收口时延和成功/失败/超时。                                                                                |
| 用量与错误         | `input_tokens`、`output_tokens`、`cached_tokens`、`error_type`、`error_msg` | 当前兼容口径的 step 用量；失败归因使用 `error_type`，`error_msg` 非空原文统一为 `[redacted]`，空串保持空。                                                                                                   |
| 来源与关联（新增） | `message_source`、`task_trigger`、`automation_id` / `off_peak_task_id`      | 普通输入与同一 `message_completion` 一致；独立 background subagent 唤起的 completion 细分来源。                                  |

`send_btn` 是用户点击/提交事件，不应由后台自动任务伪造；自动任务只复用 completion 和 step。

`step_id` 不只是报表字段：同一输入轮可合法产生多个 `agent_step`，重试或 Host 重启后同一个已收口
step 必须保留相同 `step_id`。因此可靠投递时，step 的 事件实例身份/Outbox 的逻辑幂等键/唯一约束 是
`message_id + agent_step + step_id`；不能只使用 `message_id + event_type`。

## 2. 最小来源区分

两个事件均保留来源字段：

```ts
message_source: "chat" | "background_subagent" | "background_task" | "scheduled_task" | "off_peak_task";
task_trigger: "schedule" | "manual" | "";
automation_id?: string; // 定时任务：直接使用既有 automationId
off_peak_task_id?: string; // 闲时任务：未来直接使用既有 offPeakTaskId
```

仅 `message_completion` 在 `message_source=scheduled_task` 时额外增加：

```ts
scheduled_at?: number; // automation_runs.scheduledAt，Unix 毫秒；manual 时为空
schedule_lag_ms?: number; // Host 接纳该输入的时间 - scheduled_at；manual 时为空
```

这两个字段描述的是一次运行而不是某一个 Agent step，故不写入 `agent_step`；同一次运行的所有 step
可通过既有 `message_id=runId` 关联回该条 completion。

- 普通输入：`chat` + 空 `task_trigger`。
- scheduler 到点运行：`scheduled_task` + `schedule`。
- 定时任务「立即运行」：`scheduled_task` + `manual`。
- 未来闲时任务：`off_peak_task` + 空 `task_trigger`；如未来有“立即执行”语义，再单独扩展触发枚举。

`message_source` 是数仓筛选字段；`task_trigger` 只补充定时任务的启动方式。普通输入、定时任务和
闲时任务的来源在 prompt admission 时确定并冻结到该 `inputId`。独立 background notification 的
main `agent_step` 保持现有 `background_task` admission 来源；只有明确消费到 background subagent
结果且 admission 来源明确为 subagent 时，最终 `message_completion` 才细分为
`background_subagent`，无法识别具体来源时保留
`background_task`。

独立 background notification 唤起的 main 轮次继续沿用同一个 `message_source` 字段细分：
`background_subagent` 表示由 admission 元数据明确标识为 subagent 的 completion 唤起；无法识别具体
background 来源时保留 `background_task`。用户 query 期间 active-loop 合流消费 background 结果时，
当前轮次仍保持 `message_source=chat`，不按被消费的结果改写来源。
当多个 background notification 合并成一轮时，展示用 `originMeta` 仍可保留代表任务；因果来源只在整批
成员同源时冻结，mixed 或缺失来源统一保留 `background_task`，不受通知到达顺序影响。

> **不能只靠 ID 判断来源。** `talk_id` 和 `message_id` 只回答“这是谁的一轮执行”；来源判断读取
> `event_extra_detail.message_source`，定时任务的触发方式读取
> `event_extra_detail.task_trigger`。

```text
可信 Host 计算来源（而非按 session 反推）
    |
    +-- UI 普通输入              -> chat
    +-- automation_runs.runId    -> scheduled_task + schedule/manual
    +-- future offPeakTaskId     -> off_peak_task
    |
    v
同一 inputId 的 agent_step + message_completion 复用同一来源
```

### 定时任务 ID、创建轮与运行轮

定时任务和未来闲时任务都应产生标准 `talk_id` 与 `message_id`。当前定时任务已通过 CLI
`TurnStarted` 产生可信的 `prompt.accepted` telemetry fact，为运行轮建立 seed 并发出标准 completion /
step 事件。创建一条规则与后续某次运行是不同输入轮，不能共用 `message_id`；它们通过已有
`automationId` 关联。

定时任务领域最核心的 ID 只有两个：

```text
automationId = 一条已落盘的定时规则
       |
       +-- runId #1 = 一次到点执行
       +-- runId #2 = 下一次到点执行
       +-- runId #3 = 用户点击“立即运行”

关系：automationId 1 : N runId
```

对同一次定时执行，`runId` 会被原样复用到 Host、Agent 和 telemetry 的输入标识；它们不是不同 ID：

```text
automation_runs.runId
  = Host sendPrompt.traceId
  = V4 commandId
  = Agent inputId
  = telemetry sourceCommandId
  = /event/report message_id
```

这个等式对“复用已绑定会话”和“为 UI 手动创建的未绑定任务新建会话”两条派发路径同样成立。
`createTask` 自己生成的 session trace 只描述建会话操作，不能继续作为首条 automation prompt 的
`traceId/inputId`；否则 CLI 无法从输入 ID 识别 `manual` / `schedule`，renderer 也就不会为该执行轮建立
telemetry seed，最终整轮缺少 `agent_step` 与 `message_completion`。新建会话后发送 prompt 时必须显式
覆盖为本次 `runId`。

`talk_id` 是另一条轴：它表示“这次运行在哪个 session/task 中执行”。绑定会话的规则复用其
`targetTaskId`；未绑定规则则新建 task。因此一条完整埋点可读作：

```text
talk_id    = 哪个会话执行
message_id = 该会话里的哪一次定时运行（runId）
```

| 字段               | 范围与生成方式                                                                  | 用途                                                                                                                                        |
| --- | --- | --- |
| `automationId`     | 一条定时规则一个，跨每次 schedule / manual run 保持不变。                       | 创建轮和所有执行轮的 `event_extra_detail.automation_id`；**不是** `message_id`。                                                            |
| `runId`            | 一次定时运行一个：`automationId:scheduledAt` 或 `automationId:manual:uuid`。    | Host `traceId`，再映射为执行轮 `inputId/sourceCommandId/message_id`；是本轮埋点幂等命名空间。completion 以它区分，step 还必须加 `step_id`。 |
| `scheduledAt`      | `automation_runs` 的本次理论触发时间（Unix 毫秒）；manual run 为空。            | 写入本次 `message_completion.event_extra_detail.scheduled_at`，并计算调度延迟；**不是**规则的 cron 表达式。                                 |
| `talk_id`          | 本次执行所在的 session/task ID；绑定规则复用 target task，未绑定规则新建 task。 | 把当前轮 completion 与 step 归入执行会话；**不是**定时规则 ID。                                                                             |
| `cronAutomationId` | task meta 中的会话归属标记。                                                    | 仅 UI 分组/工具隔离；不能做消息来源或创建-运行关联。                                                                                        |

```text
创建轮：普通 chat
talk_id = T0
message_id = M0
agent_step { tool_name=CronCreate, status=success, automation_id=A }
                                      |
                                      | automation_runs 之后多次引用 A
                                      v
第 N 次执行轮：定时任务
talk_id = T0（绑定会话）或新 task
message_id = runId=R1
message_completion / agent_step {
  message_source=scheduled_task,
  task_trigger=schedule|manual,
  automation_id=A
}
```

数仓通过 `automation_id=A` 把创建 `CronCreate` step 与后续多次运行 join；创建轮的 `M0` 与执行轮的
`R1` 保持不同，避免一条规则的多次运行被错误合并为同一 message。

未来闲时任务直接复用 `offPeakTaskId`：执行 `message_id` 使用其单次执行 ID（实现时若另有 run ID 则用
run ID），跨轮关联写 `off_peak_task_id=offPeakTaskId`。当前闲时任务未实现，不能把 `CronCreate` 指标
误称为“闲时任务配置用户数”。

### 对话创建定时任务的用户数（MVP）

不新增 `task_configuration_created` 事件。以已有 Agent tool step 作为创建成功事实：

```text
element_name = agent_step
event_extra_detail.tool_name = CronCreate
event_extra_detail.status = success
event_extra_detail.automation_id = A（非空）
```

数仓按该条件过滤后 `count(distinct user_id)`，得到的是**“通过对话成功配置过定时任务的用户数”**。
`automation_id` 用于把该创建 step 与后续执行数据 join，不用于用户去重。

当前这项 MVP 不包含手动创建的定时任务，也不包含闲时任务：闲时任务尚未实现，且当前 Spec 是 composer
直连服务创建，不会天然产生 `CronCreate` agent step。未来若闲时任务仍保持该入口，就不能伪造
`agent_step`；需要另行定义其创建成功的业务埋点。若产品改为由 Agent 工具创建，则应使用独立
`tool_name=OffPeakCreate` 与 `off_peak_task_id`，不能复用 `CronCreate`。

当前事件口径没有独立的 `agent_id` 作为消息关联键。`talk_id + message_id` 已足以关联一次执行；若要
关联 Agent/provider，沿用 `agent`、`model_provider`、`model_name`，不要把 `automationId` 或 `runId`
伪装为 `agent_id`。

### 现有字段的可用性

| 现有字段                        | 结论                               | 原因                                                                                                                                            |
| --- | --- | --- |
| 定时任务 `runId`                | 执行轮的 message ID 与幂等命名空间 | 当前 `runId -> Host traceId -> inputId/sourceCommandId`；每次运行唯一。`message_completion` 用它去重，多个 `agent_step` 还要以 `step_id` 区分。 |
| 定时任务 `trigger`              | 可作 `task_trigger` 来源           | 已持久化为 `schedule` / `manual`。                                                                                                              |
| 定时任务 `automationId`         | 创建轮与运行轮的关联键             | 写入 `event_extra_detail.automation_id`；当前也用于本轮工具隔离。                                                                               |
| `cronAutomationId`（task meta） | 不可用于消息分类                   | 这是 task 级归属；该会话里的后续普通用户消息也可能带它。                                                                                        |
| `inputId` / `sourceCommandId`   | 只可关联，不能分类                 | 所有输入都有该 ID。                                                                                                                             |
| `clientMode=desktop-continuous` | 不能分类                           | 普通桌面 chat 和定时任务相同。                                                                                                                  |
| `querySource`                   | 不复用                             | 它是模型请求内部来源，不是产品级消息来源。                                                                                                      |
| `offPeakTaskId`                 | 未来可作内部关联键                 | 闲时任务目前仅有 Spec，尚无 runtime、repo、scheduler 或 UI 实现。                                                                               |

## 3. 当前 MVP 运行链路与边界

普通 V4 输入在 renderer 的 `SessionPane` 收到 accepted ACK 后，建立 telemetry seed；随后 live facts
收口为 `agent_step` 和 `message_completion`。

定时任务由 scheduler 调用 Host 的 `dispatchCronRun -> sendPrompt`，把 `runId` 传成
`traceId/inputId`。CLI 在可信 admission 时发布不含正文的 `prompt.accepted` fact，桌面 continuous
workspace supervisor 据此建立 lifecycle，再复用现有 UI `/event/report` 聚合与上报。

```text
scheduler / Run now
  -> Host sendPrompt(runId, automationId)
  -> CLI TurnStarted（可信 admission 事实）
  -> prompt.accepted telemetry fact（无正文）
  -> desktop-continuous workspace supervisor
  -> agent_step* + message_completion
```

该 MVP 只复用桌面 `desktop-continuous` 的 live telemetry attachment，不进入手机 Web 的
`web-remote-replayable` snapshot/gap 恢复链路。renderer 不存在或 attachment 未就绪时仍可能漏报；如需
无人值守可靠投递，应实现 Host telemetry outbox，且不能把业务状态下沉到 main 或 relay。

## 4. 已实现方案与后续演进

### 实施任务拆分

产品目标可以概括为两件事：让定时/闲时任务执行复用普通消息埋点；让现有 `CronCreate` 创建 step
能够与后续定时运行关联。工程实现建议拆成三项，边界更清楚：

```text
任务 1：执行来源与 ID 透传
  scheduled: runId -> traceId/inputId/sourceCommandId/message_id
  off-peak: future offPeakTaskId（或其 runId）-> 同一输入链路
  附带 message_source、task_trigger、automation_id/off_peak_task_id
  schedule run 的 completion 另附 scheduled_at、schedule_lag_ms
  runId 是事件幂等命名空间：completion 使用 runId，step 使用 runId + step_id

任务 2：执行消息埋点接线
  scheduler / future off-peak Host dispatch
    -> 建立 telemetry seed 或 Host reporter
    -> 标准 message_completion + agent_step

任务 3：已有 CronCreate 创建 step 补关联字段
  CronCreate repo commit success
    -> agent_step { tool_name=CronCreate, status=success, automation_id }
    -> 可与任务 2 的后续运行按 automation_id join
```

任务 1 解决“这轮执行从哪来、ID 如何一致”；任务 2 解决“后台不经过 UI 仍能上报”；任务 3 解决
“创建动作如何和后续运行关联、如何统计对话创建定时任务的用户”。

三种方案都需要先补同一条创建关联链路：`CronCreate` 的工具终态只有在 automation repo 成功写入后，才向
V4 `tool.lifecycle` telemetry fact 附加 `automationId`（只带 ID，不带 prompt 或工具 output）；supervisor
把它映射为该条 `agent_step.event_extra_detail.automation_id`。随后 Host 派发运行时，把同一个
`automationId` 冻结到该运行的 completion 与每个 step。现有 fact schema 是 strict 的，这个字段需要在
shared telemetry 协议中显式声明，不能由 UI 临时猜测或从 task meta 反推。

```text
CronCreate repo commit
  -> terminal tool.lifecycle { toolName=CronCreate, automationId=A }
  -> agent_step { tool_name=CronCreate, status=success, automation_id=A }

dispatchCronRun { runId=R, automationId=A }
  -> message_completion / agent_step { message_id=R, automation_id=A }
```

### 方案 A：Host 向现有 renderer supervisor 补可信 seed（MVP 已实现）

Host 在 `sendPrompt` accepted 后发布一个不含正文的 `automation prompt accepted` 事实，包含
`sessionId`、`inputId/runId`、`message_source`、`task_trigger` 和 `automation_id`；schedule run 还包含
`scheduled_at`、`schedule_lag_ms`。renderer supervisor
用它建立与 UI 相同的 lifecycle，再消费现有 live facts。

- 优点：改动最少，直接复用当前 `messageTelemetry` 聚合与 `/event/report` 上报。
- 限制：renderer reload、窗口不存在或 attachment 未就绪时仍可能漏报。
- 适用：先验证定时任务量级和字段口径的 MVP。

### 方案 B：Host 直接复用 `/event/report` 的消息生命周期

把当前 UI 的 source-neutral 聚合逻辑抽成可被 Host 调用的模块。Host 对 automation / off-peak 输入在
accepted、step 收口、terminal 三个时机上报标准 `agent_step` / `message_completion`，并冻结来源与
`automation_id` / `off_peak_task_id`；schedule run 的 completion 冻结 `scheduled_at`、
`schedule_lag_ms`；UI 仅保留普通 chat 的 reporter。

- 优点：不依赖 renderer，定时任务和未来闲时任务都可接入。
- 限制：需要明确 reporter owner，避免 UI 与 Host 对同一 `inputId` 双报。
- 最小规则：`chat` 由 UI 上报；`scheduled_task` / `off_peak_task` 只由 Host 上报。

### 方案 C：方案 B + Host telemetry outbox（推荐正式上线）

在 automation run 台账同库增加轻量 outbox：accepted、每个已收口 step，以及 terminal 对应的
`message_completion` 各写一条待发记录。记录携带 `runId`、`automationId` 和事件实例级的
`outbox_event_id`；后台批量发送成功后标记完成。

`automationId` 仅用于跨轮关联，不能作为单条 outbox 记录的区分条件。`runId` 等于本轮 `inputId`，
但同一运行内可以有多个 `agent_step`，因此幂等键必须包含事件实例身份：

```text
accepted seed:       runId + ":accepted"
agent_step:          runId + ":agent_step:" + step_id
message_completion:  runId + ":message_completion"
```

其中 terminal 不再额外生成第二条 `/event/report` 终态事件；它收口为唯一的
`message_completion`。如果实现层需要持久化原始 terminal fact，也必须为它使用独立的 fact ID，
不能与 `agent_step` 共用 `event_type` 级幂等键。

```text
accepted / finalized step / terminal
        -> SQLite telemetry outbox（事件实例级 outbox_event_id）
        |      |- runId:accepted
        |      |- runId:agent_step:step_id # 每个已收口 step 一条
        |      `- runId:message_completion
        -> 批量 /event/report
        -> 成功后标记 delivered；失败异步重试
```

- 优点：不阻塞 scheduler 或模型流；Host 重启、网络失败后仍可重试；可覆盖无人值守执行。
- 成本：新增持久化和投递清理逻辑。
- 边界：不按流式 chunk 写库；只记录 accepted、每个最终 step、一次 completion，日志高频细节使用
  `debug`。重试或 Host 重启时，相同 `outbox_event_id` 不重复投递；不同 `step_id` 必须分别投递。

## 5. 建议落地顺序与验收

1. 已在 shared prompt context / live fact 契约中增加 `message_source`、`task_trigger` 与
   `automation_id` / `off_peak_task_id`；schedule run 的 completion 另增加 `scheduled_at`、
   `schedule_lag_ms`。普通 chat 默认 `chat`，并保持旧调用兼容。
2. 定时任务运行已以 `runId` 作为执行 message ID，以 `automationId` 跨轮关联；未来闲时任务以
   `offPeakTaskId` 走同一接口。
3. 当前采用方案 A 验证字段与 event payload；若要求无人值守可靠统计，采用方案 C。
4. 补齐以下断言：
   - `CronCreate` 只有在 automation repo 写入成功后才收口为 `agent_step(tool_name=CronCreate,
status=success)`，并携带非空 `automation_id`；失败、取消或重复回放不得计为成功创建；
   - schedule run：同一 `inputId` 的 completion 和所有 step 均为 `scheduled_task/schedule`，并携带
     对应 `automation_id`；completion 的 `scheduled_at` 等于该 `automation_runs` 记录，且
     `schedule_lag_ms >= 0`；
   - Run Now：为 `scheduled_task/manual`，仍使用同一 `automation_id`、不同 `message_id=runId`；
     `scheduled_at` 与 `schedule_lag_ms` 均为空；
   - 创建轮的 `CronCreate` step 与后续每次运行可按同一 `automation_id` join；不得把创建轮 inputId
     重用于运行轮；
   - 同一 cron 会话中的后续手动消息：仍为 `chat`，且不携带本次 automation 执行的 `automation_id`；
   - 一次包含 reasoning、两个工具调用和 generation 的运行，会持久化四条不同
     `runId:agent_step:step_id` 的 step 记录；发送失败、Host 重启或重复 terminal 后，四条 step
     均恰好上报一次，且 completion 的 `agent_step_cnt=4`；
   - Host/renderer 重连或重复 terminal：同一事件实例的 `outbox_event_id` 不重复上报；不得只按
     `inputId + event type` 去重；
   - 闲时任务实现后：为 `off_peak_task`，且不依赖 provider、session ID 或 workspace path 推断来源。

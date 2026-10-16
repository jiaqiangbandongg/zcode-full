# 端侧 UI 性能 ARMS 上报设计

> 状态（2026-07-15）：已实施，本文保留为历史设计记录。当前事件目录与字段口径以
> `docs/monitoring/performance-telemetry-catalog.md` 为准；下文旧 stream hook 接入点不再代表 V4 主链路。

> 日期：2026-06-16　负责人：数据与可观测性负责人
> 范围：为 Electron renderer(UI)侧补四个性能埋点，经 ARMS `sendCustom` 上报。

## 背景

现有 ARMS 性能上报体系（见 `docs/monitoring/performance-monitoring.md`）已覆盖三大类系统级指标，全部在 **main 进程**采集：

- `group=stability`：启动、crash、ANR、freeze、退出码（`desktopStabilityTelemetry.ts`）
- `group=resource`：CPU、内存、GPU、磁盘、句柄、线程（`desktopResourceTelemetry.ts`）
- `group=network`：HTTP/RPC/WebSocket 质量（`desktopNetworkTelemetry.ts`）

**空白区**：renderer 侧的业务级 UI 性能。目前 renderer 只有 ARMS Browser SDK 自动采集的 webvitals/longTask，以及一个既有的模块级业务埋点 helper。用户可感知的 UI 性能（首屏、首 token、消息耗时、流式停顿）没有专门上报。

本设计补齐这块，全部进入 ARMS `group=ui_perf`，事件名前缀 `perf_ui_`。

## 目标与非目标

**目标**

- 新增四个 UI 性能事件，复用现有 `reportArmsCustomEvent` → IPC → `armsRum.sendCustom` 链路。
- 首 token / 消息耗时复用 `messageTelemetry.ts` 已算好的值，镜像双发到 ARMS，不动现有 `/report` 链路。
- 全采（100%），无采样开关。

**非目标**

- 不改动现有 `message_completion`（`/report`）上报，不影响现有看板。
- 不手动埋渲染卡顿（主线程 longTask 由 ARMS Browser SDK 自动采集，已在 `appARMSBootstrap.ts` 开启 `browserCollectors.longTask`）。
- 不碰 main / preload / IPC 通道定义——现有 `PlatformChannels.ReportArmsCustomEvent` 链路已满足需求。

## 上报链路（已存在，复用）

```
UI 调用 reportXxx(...)
  → uiPerfArmsTelemetry 单例 reporter.reportArmsCustomEvent({name, group, value, properties})
  → window.zcode.reportArmsCustomEvent (packages/desktop/src/renderer/src/main.tsx:147)
  → IPC PlatformChannels.ReportArmsCustomEvent
  → packages/desktop/src/main/desktopMainIpcRemote.ts:119 handler
     自动补公共维度：event_name / app_version / arms_env / device_mid / platform / renderer_id / metric_value
  → armsRum.sendCustom({ name, type: "custom", group, value, properties })
```

公共维度由 main handler 统一补齐，UI 侧不重复填。

## 架构：单点封装 + 多点调用

新建 `packages/ui/src/lib/uiPerfArmsTelemetry.ts`，完全仿照该既有业务埋点 helper 的范式：

- **单例 reporter**：模块级 `let armsReporter: ArmsReporter | null`，`ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">`。
- `setUiPerfArmsReporter(reporter | null)`：在 `Root.tsx` 注入/清理（挨着现有 reporter 注入处）。
- `clearUiPerfArmsReporterForTest()`：测试用。
- 每个事件导出一个 `reportXxx(...)` 函数，内部 `buildPayload` + `reportArmsCustomEvent`。
- **全程 try/catch 吞错**：埋点失败只 `logger.warn`，绝不阻塞主流程（既有埋点 helper 已有此约定）。
- 常量集中定义：`UI_PERF_ARMS_GROUP = "ui_perf"`、事件名常量、`STREAM_STALL_REPORT_THRESHOLD_MS = 3000`。

**为何用模块级单例而非 `usePlatform` hook**：四个埋点的触发点大多不在 React 组件上下文内——首屏在 `main.tsx` 模块层、首 token / 耗时在 `messageTelemetry.ts` 模块层、停顿在 stream handler 层。`usePlatform()` 只能在组件/hook 内调用，无法统一覆盖。模块级单例（reporter 在 Root 注入一次，各处直接 import 调用）是唯一一致可行的方式，且与既有业务埋点 helper 完全同构。

## 四个事件

所有事件 `group = "ui_perf"`，`value` 为主指标（耗时 ms），细分进 `properties`。

| name                       | value                    | 触发 / 数据来源                                                           | properties                                                     |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `perf_ui_first_screen`     | 首屏耗时 ms              | `main.tsx` 模块加载记起点 → 现有 `"zcode-react-startup-ready"` 事件为终点 | `phase`（可选）                                                |
| `perf_ui_first_token`      | `time_to_first_token` ms | 复用 `finalizePromptTelemetry()` 已算好的值，镜像双发                     | `model`, `talk_id`, `message_id`                               |
| `perf_ui_message_complete` | `duration_ms` ms         | 复用现有 `message_completion` 计算结果，镜像双发                          | `result`(success/fail/user_interrupt), `talk_id`, `message_id` |
| `perf_ui_stream_stall`     | 真实停顿时长 ms          | 流式期间相邻 chunk 间隔 > `STREAM_STALL_REPORT_THRESHOLD_MS`(3000)        | `stall_ms`, `waiting_tool`, `talk_id`                          |

### 1. perf_ui_first_screen（首屏可交互耗时）

- **起点**：`packages/desktop/src/renderer/src/main.tsx` 模块加载早期记录时间戳（`performance.now()`，模块级变量）。
- **终点**：现有 `StartupReadyNotifier` 在 React commit 后派发的 `window` 事件 `"zcode-react-startup-ready"`（main.tsx:217-224）。在 `main.tsx` 内监听该事件，计算 `endNow - startNow` 并调用 `reportUiFirstScreen(elapsedMs)`。
- **注意（已修正的根因）**:`StartupReadyNotifier` 的 effect 按 React tree post-order **早于** `RootInner` 注入 reporter 的 effect 执行(前序兄弟子树先刷 effect),因此事件派发时 reporter 仍为 null——若直接静默丢弃则 `perf_ui_first_screen` **100% 不上报**。首屏每进程仅一次、丢失无法重来,故 `reportUiFirstScreen` 在 reporter 未注入时**暂存 payload**,`setUiPerfArmsReporter` 注入后**补发一次**(见 `uiPerfArmsTelemetry.ts` 的 `pendingFirstScreenPayload`)。
- `value` = 首屏耗时 ms。

### 2. perf_ui_first_token（首 token 延迟，镜像双发）

- **不新增计时**。`messageTelemetry.ts` 的 `finalizePromptTelemetry()` 已算出 `time_to_first_token`（`firstTokenAt - sendTime`）。
- 在 finalize 流程产出该值处，额外调用 `reportUiFirstToken({ ttftMs, model, talkId, messageId })`。
- `/report` 的 `message_completion` 不动。

### 3. perf_ui_message_complete（消息端到端耗时，镜像双发）

- 同样复用 `finalizePromptTelemetry()` 的 `duration_ms`（`finishedAt - sendTime`）。
- 在 finalize 处额外调用 `reportUiMessageComplete({ durationMs, result, talkId, messageId })`。
- `result` 取现有完成状态：success / fail / user_interrupt（来自 `reportPromptCompletionTelemetry` 的状态参数）。

### 4. perf_ui_stream_stall（流式停顿）

- **判定**：流式接收正文 chunk 期间，记录 `lastChunkAt`。下一个 chunk 到达时若 `now - lastChunkAt > STREAM_STALL_REPORT_THRESHOLD_MS`(3000)，上报一次。
- **value = 真实停顿时长 ms**（`now - lastChunkAt`），非阈值。阈值仅作上报闸门，挡住正常抖动。
- **状态位置**：在 `taskStreamEventHandlers.ts` 收 chunk 的逻辑里维护 per-task 的 `lastChunkAt`；消息结束（terminal handler）清理该状态。
- **工具调用期间不计入**:`tool_call` / `tool_call_update` 到达时调用 `clearStreamStallTracking(taskId)`,工具执行后第一个正文 chunk 视为首个,不与工具前的 chunk 比较——避免把工具正常执行的耗时误判为停顿。
- `properties.waiting_tool`：本期固定 `false`(纯 chunk 间隔)。工具感知归因留待后续。
- **语义边界**（写入监控文档）：chunk 间隔 >3s 的根因通常在上游（模型推理 / 网络），不一定是客户端渲染卡顿；但从用户视角"界面长时间不动"是可感知的停顿，故上报有价值。`waiting_tool` 帮助区分。

## 改动文件清单

| 文件                                                       | 改动                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/lib/uiPerfArmsTelemetry.ts`               | **新建**：单例 reporter + `setUiPerfArmsReporter` + 4 个 report 函数 + 常量                                                                  |
| `packages/ui/src/Root.tsx`                                 | 注入 / 清理 reporter（挨着 L150 既有 reporter 注入）                                                                                         |
| `packages/desktop/src/renderer/src/main.tsx`               | 模块层记首屏起点；监听 `zcode-react-startup-ready` 算首屏并上报                                                                              |
| `packages/ui/src/hooks/useZCodeChat.ts`                    | `reportPromptCompletionTelemetry` 内镜像首 token / 完成到 ARMS(复用 `completionTelemetry.eventExtraDetail`,保持 messageTelemetry 为纯计算器) |
| `packages/ui/src/hooks/taskStreamEventHandlers.ts`         | 维护 `lastChunkAt`，超阈值上报停顿                                                                                                           |
| `packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | 消息结束清理 `lastChunkAt` 状态                                                                                                              |
| `docs/monitoring/performance-monitoring.md`                | 新增 "P0 端侧 UI 性能 / group=ui_perf" 一节                                                                                                  |
| `packages/ui/src/lib/uiPerfArmsTelemetry.test.ts`          | **新建**：单测（仿既有埋点 helper 测试），覆盖 reporter 注入、吞错、payload 构造                                                             |

## 错误处理

- 所有 `reportXxx` 内部 try/catch，失败仅 `logger.warn`，不抛出、不阻塞主流程。
- reporter 未注入（null）时直接静默返回。
- 与既有业务埋点一致：ARMS 属观测链路，主流程（发送、渲染、启动）不得因埋点失败而中断。

## 测试

- **单测**（`uiPerfArmsTelemetry.test.ts`）：
  - reporter 未注入时调用 reportXxx 不抛错、不调用。
  - 注入后 payload 字段正确（name / group / value / properties）。
  - reporter 抛错时被吞掉、不向上传播。
- **本地验证**（开发构建 `arms_env=local`）：
  - 启动 → main 日志 `beforeReport` 出现 `custom:perf_ui_first_screen`。
  - 发一条消息 → 出现 `custom:perf_ui_first_token`、`custom:perf_ui_message_complete`。
  - 构造 >3s chunk 间隔（慢模型或断点）→ 出现 `custom:perf_ui_stream_stall`，value 为真实间隔。
  - 回归：`/report` 的 `message_completion` 仍独立上报，条数不变。

## 常量

| 常量                               | 值          | 位置                           |
| ---------------------------------- | ----------- | ------------------------------ |
| `UI_PERF_ARMS_GROUP`               | `"ui_perf"` | uiPerfArmsTelemetry.ts         |
| `STREAM_STALL_REPORT_THRESHOLD_MS` | `3000`      | uiPerfArmsTelemetry.ts（可调） |

## 2026-06-25 归因增强补充设计

### 背景

3.1.5 全量 RUM 显示 Agent/UI 链路 Top 慢点集中在 Bash、reasoning、generation、Write、Edit。现有 `perf_ui_first_token`、`perf_ui_message_complete`、`perf_ui_stream_stall` 可定位首 token、端到端和停顿，但还不能稳定回答“慢在队列、模型请求、重试、工具权限等待、工具执行、流式停顿还是端到端完成”。逐 step 明细保留在 `/report` 的 `agent_step` 链路，不再逐条镜像 ARMS，避免长消息放大事件量。

### 性能约束

本次增强必须遵守以下约束，避免观测链路反向拖慢 app：

- 不按 token 上报，不为每个普通 chunk 上报事件；`perf_ui_stream_stall` 仍只在 gap 超过阈值时上报。
- 端到端 breakdown 只在每轮完成时上报一次，复用 `finalizePromptTelemetry()` 已经计算好的字段。
- 不逐条镜像 `agent_step` 到 ARMS；`/report` 保留逐步骤明细，ARMS 只保留每轮 breakdown、工具终态和停顿事件。
- 模型网络状态只镜像 runtime 已经产生的低频状态事件：started / completed / failed / retry_scheduled / stream_stalled。
- 高基数字段只上报稳定关联键或脱敏/归一化值；不直接上报原始命令、文件路径、请求 header、response body。
- 所有上报继续异步 fire-and-forget，失败仅记录 warn，不阻塞发送、渲染、stream 处理。

### 本期新增/增强事件

| name                     | value                | 触发                                           | 关键 properties                                                                                                                                                                                                                   |
| ------------------------ | -------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_turn_breakdown` | `duration_ms`        | 每轮 prompt completion 结束时一次              | `talk_id`, `message_id`, `model`, `result`, `ttft_ms`, `waiting_ms`, `tool_call_total`, `tool_call_failed`, `agent_step_cnt`, `retry_cnt`, `file_change_cnt`, `generated_code_lines`                                              |
| `plan_request`           | `1` 或 `duration_ms` | `task_network_debug_status` 的所有模型网络状态 | `request_status`, `request_id`, `task_id`, `input_id`, `query_id`, `event_key`, `attempt`, `max_attempts`, `status_code`, `duration_ms`, `delay_ms`, `idle_ms`, `timeout_ms`, `retryable`, `reason`, `transport`, `provider_kind` |
| `perf_ui_stream_stall`   | gap ms               | 相邻正文/思考 chunk gap 超阈值                 | 增加 `chunk_type`，区分 `message` / `thought`；仍不记录普通 chunk                                                                                                                                                                 |

### 非本期但需要 runtime 支持的字段

以下字段是进一步定位 Bash / Write / Edit 的关键，必须由 agent/tool runtime 产生，UI 只负责透传/镜像，避免把 UI 观察到的总耗时误判为工具内部阶段耗时。

- Bash：`permission_wait_ms`, `command_run_ms`, `first_output_ms`, `no_output_ms`, `exit_code`, `timeout`, `output_bytes`, `command_category`, `command_name`, `command_count`, `command_status`。
- Write/Edit：`permission_wait_ms`, `fs_read_ms`, `fs_write_ms`, `patch_match_ms`, `file_count`, `total_bytes`, `max_file_bytes`, `hunk_count`, `match_attempts`, `workspace_kind`。

### 2026-06-25 runtime 工具阶段补充

第二阶段把上述字段收敛到工具结果结构化 `perf` 字段，并通过已有 `tool_call_result` / `tool_call_update.raw.result.perf` 链路到 UI。模型可见文本不包含这些字段；它们只用于 UI、debug、RUM 和 session 结构化投影。

新增 ARMS 事件：

| name                       | value                                      | 触发                                                            | 关键 properties                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_tool_call_detail` | `total_ms` 或 `command_run_ms/fs_write_ms` | 工具调用终态 `completed/failed/denied` 且存在 `raw.result.perf` | `tool_name`, `status`, `talk_id`, `message_id`, `tool_call_id`, `permission_wait_ms`, `command_run_ms`, `first_output_ms`, `no_output_ms`, `exit_code`, `timeout`, `output_bytes`, `command_name`, `command_category`, `command_count`, `command_status`, `fs_read_ms`, `fs_write_ms`, `patch_match_ms`, `file_count`, `total_bytes`, `max_file_bytes`, `hunk_count`, `match_attempts`, `workspace_kind` |

事件量约束：

- 每个工具调用最多在终态上报一次。
- 不上报原始命令、原始路径、文件内容、diff 内容或 header。
- 2026-07-27 隐私复审后停止向 RUM/ARMS 上报 `command_hash`。常见命令可被字典反查，
  且该字段会制造高基数；远端只保留公开 Registry 白名单化的 `command_name`、低基数
  `command_category`、`command_count` 和 `command_status`。
- `workspace_kind` 只使用 `local` / `remote` / `unknown` 低基数值。

### 归因口径

- `perf_ui_message_complete` 保留为体验总指标。
- `perf_ui_turn_breakdown` 用于把同一轮里的 TTFT、权限等待、工具总数、失败工具数、retry 等现有字段拉平到 ARMS，帮助从总耗时进一步归因。
- `plan_request` 从仅 started 扩展为网络状态全量低频镜像，用于回答“慢是否来自重试、失败、provider 尾部延迟或 stream stall”。
- `perf_ui_stream_stall` 继续代表 UI 观察到的上游流式间隔，不代表 React 渲染卡顿；React/longTask 仍依赖 ARMS Browser SDK 自动指标。

## 2026-07-01 longTask 低基数归因摘要

### 背景

ARMS Browser SDK 的 `longTask` 事件会把 LoAF / rAF attribution 写入 `snapshots`，其中 LoAF 来源包含 top 脚本片段的 `duration` 与 `invokerType`。`snapshots` 是 SDK 元数据字段，默认不稳定落入 SLS 可查询维度；直接上报原始脚本名、URL 或路径又会带来高基数与路径泄露风险。因此主进程 `beforeReport` 在不新增事件的前提下，把已采集的 top-5 attribution 提炼为低基数字段，合并进同一条 `longTask` 的 `properties`。

### 字段口径

| properties 字段         | 类型   | 口径                                                                                                                                                         |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loaf_script_count`     | number | SDK `snapshots` 内 attribution 条数，最多 5。                                                                                                                |
| `loaf_top_duration_ms`  | number | attribution 中最大 `duration`，四舍五入为 ms，负值钳为 0。                                                                                                   |
| `loaf_top_invoker_type` | string | top attribution 的来源类型：`user-callback` / `event-listener` / `script` / `unknown`。缺少 `invokerType` 的 rAF 来源归为 `script`，非法枚举归为 `unknown`。 |
| `loaf_top_share_pct`    | number | `loaf_top_duration_ms / longTask.duration` 的百分比整数；总时长缺失、非数字或不大于 0 时记 0。                                                               |

### 边界

- 只增强 `event_type="longTask"` 的 SDK 自动事件，不通过 `sendCustom` 新增 ARMS 自定义事件，也不改变 `group=ui_perf` 事件量。
- 解析失败、`snapshots` 缺失或无有效 attribution 时静默跳过，不影响原始 longTask 上报。
- 不写入原始脚本名、脚本 URL、文件路径、堆栈、selector 或源码片段；SLS 查询只使用上述低基数字段。
- 该归因只描述一次 longTask 内耗时最大的已采样 attribution，不能等同于完整 React 渲染根因；需要结合 `duration`、`fps`、`source` 和 `perf_ui_*` 事件判断用户体验影响。

## 未来可调整项（非本期）

- 停顿闸门 3000ms 上线后据真实分布（p50/p90/p99）收紧。
- 高频事件若量过大，再加客户端采样开关。
- 首屏可细分阶段（main ready / window 创建 / React commit），通过 `phase` 维度扩展。

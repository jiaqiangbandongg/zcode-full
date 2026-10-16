# 性能监控

> 本文维护稳定性、网络与 UI 性能；进程资源契约见 [全进程 CPU / 内存监控埋点](./process-resource-telemetry.md)。业务质量见 [business-monitoring.md](./business-monitoring.md)。
>
> 全部性能埋点（含消息链路 `/report` agent_trace）的事件名 / value / 字段速查见 [performance-telemetry-catalog.md](./performance-telemetry-catalog.md)。
>
> **V4 接线提示**：main/renderer 的 ARMS 稳定性、资源和网络指标保持不变；conversation
> 指标通过 [conversation-telemetry-v4.md](./conversation-telemetry-v4.md) 定义的 live-only
> workspace supervisor 接线，不进入 snapshot/recovery。

## 范围

- **P0（当前）**：Electron 桌面端**稳定性**、**资源占用**与**网络与通信**指标，数据进入 **ARMS `@arms/rum-electron`**（`sendCustom`，`group` 为 `stability` / `resource` / `network`）。
- **不做**：Web/手机远控 RUM、Host/Agent 进程 ANR、`/report` 业务埋点（`app_launch` 不作崩溃率分母）。Agent 非预期退出由 desktop main 主动补 `perf_agent_crash`，手机远控复用 shared host，不重复上报。

## 与业务监控的边界

| 归属本文件                            | 归属 [business-monitoring.md](./business-monitoring.md) |
| ------------------------------------- | ------------------------------------------------------- |
| 崩溃率、ANR、Crash-Free、挂死、退出码 | 产品埋点、Agent 可观测库、App Usage 可靠性面板          |

## P0 稳定性指标

### 公共维度

所有 P0 自定义事件（`sendCustom`）携带：

| 字段                       | 说明                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `platform`                 | `macos` / `windows` / `linux`                                                       |
| `app_version`              | `ZCODE_VERSION`                                                                     |
| `arms_env`                 | `prod` / `local`（`mapZCodeEnvToArmsRumEnv(runtimeEnv)`；本地开发态固定为 `local`） |
| `device_mid`               | 桌面端设备标识（`userData` 路径哈希）                                               |
| `telemetry_schema_version` | 稳定性事件口径版本；本次修复后的事件固定为 `2`                                      |
| `scene_lifecycle`          | 见下表                                                                              |
| `scene_window`             | 见下表                                                                              |

**场景 — lifecycle**

| 值               | 含义                          |
| ---------------- | ----------------------------- |
| `cold_start`     | 进程冷启动，`perf_app_start`  |
| `runtime`        | 常规运行（默认）              |
| `app_quit`       | 用户/系统退出                 |
| `update_install` | `quitAndInstall` 更新安装退出 |

**场景 — window（首版）**

| 值                | 含义                                 |
| ----------------- | ------------------------------------ |
| `main`            | 主业务窗口                           |
| `process_monitor` | Resource Manager（资源管理器）单例窗 |
| `other`           | 其它 `BrowserWindow`                 |

### 1. Crash 率

- **Renderer Crash 率**：
  `count(perf_crash where crash_scope=main_window_renderer) / app_start_count`。
- **Native Crash 率**：
  `count(crashReporter where crash_scope=app_native_process and native_dump_process_role=main) /
app_start_count`。
- **分母**：`perf_app_start`，每进程 1 次（`await armsInitPromise` 之后、主窗口首屏 `did-finish-load` 再延迟约 3.2s）。
- **禁止相加**：Renderer Crash 与 Native Crash 必须分源统计。Windows renderer dump
  也可能包含产品 exe，同一次事故会同时产生 Electron callback 与 crashReporter dump；
  两者没有共享的稳定事故 ID，直接相加会重复计数。
- **不纳入 Renderer Crash**：`auxiliary_window_renderer`、`embedded_webview`
  （Page Crash）、`host`、Agent Crash、GPU/Utility 可恢复退出。
- **计数**：每个 Electron `render-process-gone` / `child-process-gone` 回调上报一次，
  不再按 `crash_kind` 做五分钟客户端去重。ARMS 网络重试由服务端事件标识处理，不能用
  进程内粗粒度时间窗吞掉另一个真实 crash。

```text
同一次 Windows renderer crash
        │
        ├─ render-process-gone ── perf_crash / electron_callback
        │                              └─ Renderer Crash 率
        │
        └─ Crashpad dump ─────── crashReporter / crash_reporter_dump
                                   │
                                   ├─ role=main ── app_native_process ── Native Crash 率
                                   └─ unknown/helper ── native_dump_unattributed
                                                        └─ 仅诊断，不进入 Crash-Free

两个分源事件 ── 按 device_mid 取并集 ── Crash-Free
             └─ 禁止按事件数直接相加
```

**Crash 分类**

`crash_scope` 表示“哪个产品进程/页面崩溃”，`crash_cause` 表示“为什么崩溃”。
两者禁止再用 `js` / `native` 混合表达。

| 来源                                         | `crash_scope`               | `crash_cause`                                   | `crash_source`        |
| -------------------------------------------- | --------------------------- | ----------------------------------------------- | --------------------- |
| 主业务窗口 `render-process-gone`             | `main_window_renderer`      | `oom` / `process_crashed` / `abnormal_exit` / … | `electron_callback`   |
| Resource Manager / 更新 / About 等辅助窗口   | `auxiliary_window_renderer` | 同上                                            | `electron_callback`   |
| 内置浏览器 `<webview>` `render-process-gone` | `embedded_webview`          | 同上                                            | `electron_callback`   |
| ZCode Host `child-process-gone`              | `host`                      | `process_crashed` / `abnormal_exit` / …         | `electron_callback`   |
| ARMS crash dump，且明确标记为主进程          | `app_native_process`        | `native_crash`                                  | `crash_reporter_dump` |
| ARMS crash dump，仅能确认来自产品二进制      | `native_dump_unattributed`  | `native_crash`                                  | `crash_reporter_dump` |
| `reason=killed` / `clean-exit`               | —                           | 不计 crash，走 `perf_process_exit`              | —                     |

Electron 的 `reason=memory-eviction` 与 `reason=oom` 统一归类为
`crash_kind=oom`、`crash_cause=oom`；前者表示 Chromium 在内存压力下驱逐进程。

`crash_kind` 仅为兼容历史查询保留：schema v2 中 `oom` 仍为 `oom`，其余进程崩溃统一为
`native`；历史值 `js` 不再新增。Page Crash 直接查询
`perf_crash AND crash_scope=embedded_webview`，不新增第二条 `perf_page_crash`，避免同一
事故重复上报。

ARMS `crashReporter` 会扫描共享 crash dump 目录。上报前先校验
`binary_images` 中存在当前 ZCode 产品可执行文件；`hdc`、`plugin-container`、
`chrome-headless-shell` 等外部程序 dump 直接丢弃。该过滤只遍历 crash 批次的已有
元数据，不增加采样、文件或子进程开销。可信名称集合必须包含产品应用名和
`basename(process.execPath)`，覆盖开发态 `Electron` 与 Linux Preview
`zcode-preview`。

仅命中产品二进制不能证明 dump 来自主进程：Linux/Windows 的 Electron 子进程可能共用
同一 executable。事件必须通过 `native_dump_process_role`（或兼容的 process-role 元数据）
明确标记为 `main`，才使用 `crash_scope=app_native_process`；角色未知或属于子进程时保留
原始事件，但使用 `crash_scope=native_dump_unattributed`，不进入 App Crash / Crash-Free。

角色元数据链路固定为 Crashpad 结构化 `process_type` / `ptype` → `@arms/rum-electron`
crash collector 从 minidump Crashpad info 及 annotation RVA 提取到 `meta.process_type` →
`readNativeDumpProcessRole()`；其中 `browser` 归一化为 `main`。collector 不得扫描整个 dump
匹配相邻 key/value 字节，未被 annotation 结构引用的同名字节不能参与角色判定。
不得使用 `meta.process`（该字段是应用名）猜测角色。依赖升级或 SDK patch 必须保持这条
透传契约，否则所有未带角色的 dump 只能继续归入 `native_dump_unattributed`。

Windows 和 Linux 下 Electron 主进程和部分子进程可能共用同一个产品可执行文件名，
仅凭 `binary_images` 不能可靠细分进程角色。未经主进程标记的 dump 不得直接用于
Crash-Free；Native Crash 与 Renderer Crash 必须使用各自的分源比率，不能合成
`app_crash_count`。

### 1.1 Agent 进程崩溃

- **启动事件**：成功收到 Node `spawn` 后上报 `perf_agent_start(value=1)`，每个 runtime
  一次；spawn 失败不产生启动事件。
- **就绪事件**：同一 runtime 首次通过 provider/model 门禁后上报
  `perf_agent_ready(value=1)`，并携带 `startup_duration_ms`；只读 runtime 不提前计 ready。
- **事件**：`perf_agent_crash`，`value=1`，按事件数或 `sum(value)` 统计。
- **判定**：Agent 是长期运行进程；没有 Host 主动退出意图却发生 exit 时，即使
  `exit_code=0` 也属于非预期退出。
- **排除**：workspace/app 主动回收不报；request timeout 回收记为
  `watchdog_recycle`，不混入 crash；`protocol-close` 是崩溃结果，不能作为排除条件。
- **应用退出保护**：desktop main 发出 `perf_app_exit` 后持续保持
  `app_quit` / `update_install`；随后异步到达的 Agent exit 不进入 crash。
- **受控终止兼容分类**：本地 desktop RUM 仅在缺少结构化退出根因时排除 Windows
  `exit_code=0x40010004` 和 POSIX `signal=SIGTERM`。`protocol-close` 不建立主动退出
  意图，但 Host 会把首次 cleanup 原因作为 `termination_reason` 传递；即使后续进程树
  回收产生受控系统退出特征，也仍按协议故障上报 crash。
- **诊断**：上报脱敏、最多 4000 字符的 stderr 尾部，并附
  `error_name/error_code/error_fingerprint`、`crash_phase`、`termination_class`、
  `termination_reason`、
  `diagnostic_class`。摘要优先识别 OOM、SQLite、errno，并排除 `[Object]`、GC 标题、
  native stack 地址等结构噪音。禁止上传 workspace 路径、命令参数、
  credential 和 session 内容；裸 `sk-...` API key 必须在 services 和 desktop main
  两层脱敏。
- **实例关联**：`perf_agent_start` / `perf_agent_ready` / `perf_agent_crash` /
  `perf_agent_spawn_error`
  使用同一个随机 `runtime_instance_id`；该 ID 不包含 workspace、PID 或设备信息。
- **启动失败**：单独走 `perf_agent_spawn_error(value=1)`。
- **详细契约**：[Agent 进程崩溃 ARMS 上报](./agent-process-crash-arms.md)。

### 2. ANR / 无响应率

- **公式**：`anr_count / app_start_count`（平台 × 版本）。
- **判定**：`webContents` `unresponsive` 起计时，`responsive` 或销毁结束；持续 ≥ **`STABILITY_ANR_THRESHOLD_MS`（5000）** 上报 `perf_anr`。
- **Windows**：依赖 Electron/Chromium `unresponsive`，与系统「程序未响应」一致，不另接 Win32 API。

### 3. Crash-Free 率

- **公式**：`1 - (affected_users / active_users)`，行业基线 **≥ 99.5%**。
- **用户键**：`device_mid`（ARMS `properties` + `perf_app_start` 绑定）。
- **受影响设备**：时间窗内出现 `main_window_renderer` 或经过产品二进制校验的
  且 `native_dump_process_role=main` 的 `app_native_process` 的去重 `device_mid` 并集。
  `native_dump_unattributed`、辅助窗口/Page/Host/Agent Crash 不进入该集合。
- **周期**：日/周看板在 ARMS 侧配置；客户端保证事件带 `device_mid`。

### 4. 挂死 / 冻结率

- **公式**：`freeze_count / app_start_count`（平台 × 版本）。
- **判定**：`unresponsive` 持续 ≥ **`STABILITY_FREEZE_THRESHOLD_MS`（30000）** 且该次未发生 crash → `perf_freeze`。
- 若随后 crash，只计 crash，不计 freeze。

### 5. 退出码分布

| 事件                | 说明                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `perf_app_exit`     | 应用退出（`before-quit`，`exit_kind=normal`，`exit_code=0`）          |
| `perf_process_exit` | 子进程/渲染进程异常退出（`exit_code`、`exit_reason`、`process_role`） |

看板：按 `exit_code` × `process_role` 直方图；`exit_kind=normal` 单独桶。

## P0 资源占用指标

全进程 CPU / 内存采样、三个资源事件、性能红线与 PRT-023 / PRT-024 验收统一见
[全进程 CPU / 内存监控埋点](./process-resource-telemetry.md)。独立的数据目录体积事件仍见
[ZCode 数据目录占用 ARMS 上报](./zcode-data-size-arms-telemetry.md)。

---

## P0 网络与通信指标

主进程 **5min 聚合上报**（开发 1min）。每个 `transport + interface` 窗口只发送一条
`group=network/name=perf_network_window`；成功率、错误率和重试率由 counts 查询派生，
不再拆事件或发送全局错误率镜像。每条事件合并全局 properties 后不得超过 20 个属性。

### 数据源

| 传输层    | 采集点                                                                                                                                    | 接口维度                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| HTTP      | ARMS `beforeReport` 解析 `api` 事件（`dns_duration` / `connect_duration` / `ssl_duration` / `first_byte_duration` / `download_duration`） | `host+path`                |
| RPC       | Host `NetworkTelemetryChannelServer` 包装 `ChannelServer`，批次经 `HostResponseTypes.NetworkTelemetryBatch` 回传 main                     | `channel.command`          |
| WebSocket | `WebRemoteControlDeviceTransport` 远控 relay 建连/断连/重连                                                                               | `web_remote_control.relay` |

### 事件一览

| 事件                  | 指标                                                                                                                        | 看板维度                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `perf_network_window` | `value`=duration mean；success/fail/retry counts、duration peak/p95；HTTP 阶段只保留 mean；错误只保留窗口主错误类型及其计数 | 平台×`transport`×`interface` |

`primary_error_kind` 固定为：`timeout`、`dns_failure`、`connection_reset`、`proxy_error`、
`tls_error`、`server_error`、`client_error`、`other`，并携带 `primary_error_count`。窗口存在多种
错误时取计数最高者，同数按固定枚举顺序决定；任意外来值归入 `other`。

HTTP path 只允许保留代码内显式登记的低基数静态路由段；数字、UUID、邮箱、用户 slug、
长 token 以及未登记段统一模板化为 `:id`。file URL、Windows 盘符路径和任意 `/` 开头的
POSIX 本地绝对路径统一归为 `local_file`，禁止通过枚举常见根目录来猜测本地路径范围。
每种 transport 的内存 bucket 有硬上限，超出部分进入 `other`；flush 仍只保留请求量最高的
40 个接口。

常量：`NETWORK_REPORT_INTERVAL_MS` 生产 300000 / 开发 60000；Host 批次 flush 30s / 最多 200 条。

## P0 端侧 UI 性能指标

renderer(UI)侧埋点,经 `reportArmsCustomEvent` → IPC → `armsRum.sendCustom` 上报。事件 `group=ui_perf`,名称前缀 `perf_ui_`。全采(100%)。公共维度由 main IPC handler 自动补齐(`app_version` / `arms_env` / `device_mid` / `platform` / `renderer_id`)。

### 事件一览

| 事件                              | `value`               | 来源                                                    | 关键 properties                                                                                                                                                                       |
| --------------------------------- | --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_launch_to_input`         | 启动到能输入总耗时 ms | 进程创建(`getCreationTime`)→ 启动门禁清除、输入框可用   | `session_id`                                                                                                                                                                          |
| `perf_ui_launch_electron_init_ms` | Electron 启动 ms      | 进程创建 → main JS                                      | `session_id`                                                                                                                                                                          |
| `perf_ui_launch_app_ready_ms`     | main 初始化 ms        | main JS → `app.whenReady`                               | `session_id`                                                                                                                                                                          |
| `perf_ui_launch_window_ms`        | 窗口编排 ms           | `whenReady` → `loadURL`                                 | `session_id`                                                                                                                                                                          |
| `perf_ui_launch_renderer_load_ms` | renderer 加载 ms      | `loadURL` → bundle 执行                                 | `session_id`                                                                                                                                                                          |
| `perf_ui_launch_react_commit_ms`  | React 渲染 ms         | bundle → React 首次 commit                              | `session_id`                                                                                                                                                                          |
| `perf_ui_launch_startup_gate_ms`  | 启动门禁 ms           | React commit → 输入框可用(鉴权/provider/workspace 恢复) | `session_id`                                                                                                                                                                          |
| `perf_ui_session_open_start`      | session 打开开始计数  | Renderer pane acquire 后的逻辑打开起点                  | `session_open_id` / `session_id` / `open_kind` / `open_trigger` / `client_mode`                                                                                                       |
| `perf_ui_session_open_result`     | 首屏到可交互总耗时 ms | 首个 snapshot paint 且 Composer 可交互；失败/超时也上报 | `status` / `session_open_id` / `session_id` / Host/CLI/Renderer 阶段耗时                                                                                                              |
| `perf_ui_first_token`             | 首 token 延迟 ms      | 镜像 `message_completion` 的 `time_to_first_token`      | `model` / `talk_id` / `message_id`                                                                                                                                                    |
| `perf_ui_message_complete`        | 消息端到端耗时 ms     | 镜像 `message_completion` 的 `duration_ms`              | `result` / `talk_id` / `message_id`                                                                                                                                                   |
| `perf_ui_stream_stall`            | 真实停顿时长 ms       | 流式相邻正文 chunk 间隔 > 3000ms                        | `stall_ms` / `waiting_tool` / `talk_id` / `message_id`                                                                                                                                |
| `perf_ui_tool_call_detail`        | 工具终态耗时 ms       | `tool_call_update` 终态的 `raw.result.perf`             | `tool_name` / `status` / `talk_id` / `message_id` / `tool_call_id` / `parent_tool_call_id` / `child_tool_call_id` / `child_session_id` / `agent_id` / `agent_type` / 工具内部阶段字段 |

### 说明与边界

- **启动分阶段**:7 段每进程冷启动各上报一次,`value` 为各段 ms(`Math.max(0,...)` 钳非负)。锚点 `process.getCreationTime()`,main 的 T0-T3 经主窗口 loadURL query(`zcodeLaunchMarks`)注入 renderer,在启动门禁清除(`isStartupRenderBlocked` 翻 false)时统一计算上报。未登录(WelcomeScreen)不上报;总时长 >300000ms 哨兵丢弃。`session_id` 关联同次启动各段。旧 `perf_ui_first_screen` 已废弃,语义并入 `perf_ui_launch_react_commit_ms`。
- **session 首次打开**:`perf_ui_session_open_start` / `perf_ui_session_open_result` 每个逻辑打开最多两条，阶段 timing 通过 `v4/conversation/subscribe` ACK 携带，不按阶段拆分 ARMS 事件；Web/mobile reporter 为空。完整字段与边界见 [Session 首次打开 ARMS 埋点](./session-open-telemetry.md)。
- **首 token / 消息耗时**：V4 supervisor 复用 `messageTelemetry` builder，时间锚点仍是 renderer receipt clock；initial/recovery 不补报。
- **工具终态细分**:`perf_ui_tool_call_detail` 只在工具完成/失败/拒绝且 `raw.result.perf` 存在时上报。Bash 带 `command_run_ms` / `first_output_ms` / `no_output_ms` / `timed_out` / `command_category` 等；Edit/Write 带 `fs_read_ms` / `fs_write_ms` / `patch_match_ms` / 文件大小等。subagent mirror 子工具额外带 `parent_tool_call_id` / `child_tool_call_id` / `child_session_id` / `agent_id` / `agent_type`,用于从父 `Agent` step 下钻到子工具耗时。
- **逐步骤耗时**：`agent_step` 保持 `/report` 旧口径；ARMS **RUM Custom Event**
  仍只做每轮和工具终态低频归因，禁止把 `/report agent_step` 逐条镜像成 RUM 事件。
  CLI Agent Loop 的 `zcode.agent.step` OTel Span 是另一套强类型执行 Trace，目标结构见
  [CLI Agent Telemetry 开发指南](../trace/cli-agent-telemetry.md)，不经过 Renderer IPC，
  也不复用旧 `agent_step` Schema。
- **流式停顿**:`value` 为真实 chunk 间隔(非阈值),阈值 `STREAM_STALL_REPORT_THRESHOLD_MS=3000` 仅作上报闸门。**工具调用期间不计入**:`tool_call`/`tool_call_update` 到达时 `clearStreamStallTracking`,工具后第一个正文 chunk 视为首个,不与工具前的 chunk 比较,避免把工具正常执行误判为停顿。chunk 间隔 >3s 的根因可能在上游(模型推理/网络),不一定是客户端渲染卡顿;但用户视角"界面长时间不动"可感知,故上报。后续据线上分布收紧阈值。`waiting_tool` 本期固定 `false`。
- **渲染卡顿(longTask)**:由 ARMS Browser SDK 自动采集(`browserCollectors.longTask`),不在此手动埋点。主进程 `beforeReport` 会把 SDK `snapshots` 中的 top-5 LoAF/rAF attribution 提炼为低基数字段并合入同一条 longTask 的 `properties`: `loaf_script_count`、`loaf_top_duration_ms`、`loaf_top_invoker_type`、`loaf_top_share_pct`。不上报原始脚本名、URL、路径或源码片段;`snapshots` 缺失/解析失败时跳过,不影响原始 longTask 上报。

常量(代码):`STREAM_STALL_REPORT_THRESHOLD_MS=3000`(`packages/ui/src/lib/uiPerfArmsTelemetry.ts`)。

## ARMS 看板建议

- 稳定性等历史事件可筛选 `properties.event_name`；资源事件与网络
  `perf_network_*` 为节省属性预算，必须直接筛选 custom `name`。
- Crash 率：schema v2 的 App Crash 分子按 `crash_scope` 过滤，再按
  `crash_cause` 分组；分母为 `perf_app_start`。
- Native Crash 看板还必须过滤
  `json_extract_scalar(properties, '$.native_dump_process_role')='main'`；否则历史上
  仅命中产品二进制但无法确认进程角色的 dump 仍会污染 Native Crash / Crash-Free。
- 维度：`platform`、`app_version`、`scene_lifecycle`、`scene_window`、
  `crash_scope`、`crash_cause`、`telemetry_schema_version`。
- 环境：开发构建 `arms_env=local`，生产 `prod`。

## 实现索引

| 模块                   | 路径                                                      |
| ---------------------- | --------------------------------------------------------- |
| P0 稳定性上报          | `packages/desktop/src/main/desktopStabilityTelemetry.ts`  |
| P0 资源上报            | `packages/desktop/src/main/desktopResourceTelemetry.ts`   |
| P0 网络上报            | `packages/desktop/src/main/desktopNetworkTelemetry.ts`    |
| P0 端侧 UI 性能上报    | `packages/ui/src/lib/uiPerfArmsTelemetry.ts`              |
| 网络聚合               | `packages/desktop/src/main/networkTelemetryAggregator.ts` |
| RPC 网络中间件         | `packages/rpc/src/network-telemetry-middleware.ts`        |
| Host 网络批次          | `packages/desktop/src/host/hostNetworkTelemetry.ts`       |
| 聚合工具               | `packages/desktop/src/main/resourceMetricsStats.ts`       |
| ARMS 初始化            | `packages/desktop/src/main/appARMSBootstrap.ts`           |
| 崩溃归档               | `packages/desktop/src/main/desktopCrashCapture.ts`        |
| 主进程接线             | `packages/desktop/src/main/index.ts`                      |
| Resource Manager 窗 ID | `packages/desktop/src/main/resourceManagerWindow.ts`      |

## 本地验证 checklist

1. 开发包启动：主进程日志 `[stability] perf_app_start reported`（或 ARMS `beforeReport` 含 custom 事件）。
2. DevTools 触发普通 JS exception：只应看到 exception，不应伪装成进程 Crash；模拟
   `render-process-gone` 时应看到 `perf_crash`，并带正确的 `crash_scope` /
   `crash_cause`。
3. 模拟卡死：主线程同步长循环 ≥5s → `perf_anr`；≥30s 且无 crash → `perf_freeze`。
4. ARMS 控制台：环境选 `local`，按 `app_version` × `platform` 分组核对分子分母。
5. 回归：`/report` 的 `app_launch` 仍独立上报，条数不必等于 `perf_app_start`。
6. 资源：日志 `[resource] sampling started`；约 1min（dev / E2E）后出现 `[resource] perf_process_window + perf_system_window flushed`；`beforeReport` 含每角色一条 `custom:perf_process_window` 与一条 `custom:perf_system_window`。
7. 网络：日志 `[network] reporting started`；触发 RPC 或 HTTP 后约 1min 出现 `[network] perf_network flushed` 与 `custom:perf_network_window`。
8. ARMS 入库可能有分钟级延迟，以 `beforeReport` 时间锚点查询。

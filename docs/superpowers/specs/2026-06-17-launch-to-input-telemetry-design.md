# 桌面端「应用启动 → 能输入」分阶段耗时埋点设计

> 日期：2026-06-17　负责人：数据与可观测性负责人
> 范围：把启动链路「进程创建 → 用户能输入」拆成 7 段，各段独立经 ARMS `sendCustom` 上报，用于后续性能优化定位。替换现有只测 renderer 内部渲染的 `perf_ui_first_screen`。

## 背景与问题

现有 `perf_ui_first_screen`（见 `docs/monitoring/performance-monitoring.md`）的计时区间是：

- 起点：renderer 的 JS bundle 开始执行（`main.tsx` 模块层 `performance.now()`）
- 终点：React 首次 commit（`zcode-react-startup-ready` 事件）

线上均值 ≈ 75ms。它**只覆盖了 renderer 内部渲染那一小段**，把用户主观感受的大头全漏掉了：

- Electron 运行时自身冷启动（进程创建 → main JS）
- main 进程初始化、窗口创建编排（main JS → loadURL）
- renderer 进程启动、HTML 壳、bundle 下载/解析
- **React commit 之后的启动门禁**（鉴权解析 / provider 启动 / workspace 恢复）——这期间显示 `RootStartupLoading`，输入框尚未可用

**目标**：上报「进程创建 → 输入框真正可用」的总时长，并拆成可归因的阶段，定位优化点。

## 目标与非目标

**目标**
- 新增「启动到能输入」总耗时 + 6 个细分阶段耗时，全部进 ARMS `group=ui_perf`。
- 复刻现有 `perf_network_*_dns_ms` 的「每阶段一个事件名 + 各自 value」范式，使每段都能稳定出 mean/p50/p90/p99。
- 全采（100%），每个 renderer 进程冷启动仅一次。

**非目标**
- 不改 main / preload / IPC 通道定义——复用现有 `PlatformChannels.ReportArmsCustomEvent` 链路与 `additionalArguments` 注入机制。
- 不动 `perf_ui_first_token` / `perf_ui_message_complete` / `perf_ui_stream_stall` 三个事件。
- 不覆盖二次窗口 / 运行时 reload（仅冷启动主窗口首次链路）。

## 为什么用「每阶段独立事件」而非「单事件多字段」

ARMS 上报链路（`desktopMainIpcRemote.ts:126-148`）里，只有 `value` 被映射成标准数值指标 `metric_value`，能稳定做 mean/分位聚合；`properties` 是当维度/计数用的。现有网络埋点（`performance-monitoring.md:155-156`）正是用 **`perf_network_*_duration_ms`（总）+ `perf_network_*_dns_ms`（分阶段）** 各自独立事件来出分阶段分位的，不赌 properties 数字能聚合。本设计沿用该已验证范式。

## 计时锚点与跨进程时钟

起点在 **main 进程**、终点在 **renderer 进程**，两进程的 `performance.now()` 原点不同**不可相减**。统一用 **epoch 毫秒**：

- 锚点 `T0 = process.getCreationTime()`（主进程创建的 epoch ms，main / renderer 均可取）
- 其余边界统一 `Date.now()`

所有阶段在 renderer 一处相减、一次性发 7 条，避免分散计算。

### 七个时刻

| 标记 | 采集位置 | 进程 | 含义 |
|------|----------|------|------|
| `T0` | `process.getCreationTime()` | main | 进程创建（锚点） |
| `T1` | `main/index.ts` 模块顶部第一行 `Date.now()` | main | main JS 起点 |
| `T2` | `app.whenReady().then` 回调入口（index.ts:981）`Date.now()` | main | 框架就绪 |
| `T3` | 主窗口 `loadURL` 调用前 `Date.now()` | main | 开始加载 renderer |
| `T4` | `renderer/src/main.tsx` 模块顶部 `Date.now()` | renderer | bundle 开始执行 |
| `T5` | `zcode-react-startup-ready` 触发时 `Date.now()` | renderer | React 首次 commit |
| `T6` | 启动门禁 `isStartupRenderBlocked` 由 `true→false` 时 `Date.now()` | renderer | 输入框可用 |

### 七个阶段（相邻差）

| 事件名（`group=ui_perf`） | `value` | 区间 | 优化指向 |
|---------------------------|---------|------|----------|
| `perf_ui_launch_to_input` | **总时长** | `T6 - T0` | 用户主观「启动到可用」主指标 |
| `perf_ui_launch_electron_init_ms` | `T1 - T0` | 进程创建 → main JS | Electron 二进制 + V8 启动（基本不可控，看基线） |
| `perf_ui_launch_app_ready_ms` | `T2 - T1` | main JS → whenReady | main 同步初始化 |
| `perf_ui_launch_window_ms` | `T3 - T2` | whenReady → loadURL | 窗口/数据目录/网络策略等启动编排 |
| `perf_ui_launch_renderer_load_ms` | `T4 - T3` | loadURL → bundle 执行 | HTML 壳、bundle 下载/解析 |
| `perf_ui_launch_react_commit_ms` | `T5 - T4` | bundle → React commit | renderer 内部渲染（= 旧 `perf_ui_first_screen` 语义） |
| `perf_ui_launch_startup_gate_ms` | `T6 - T5` | React commit → 输入框可用 | 鉴权 / provider / workspace 恢复 |

每条 `properties` 带 `session_id`（同一次启动关联键，用 `T0` 派生或 renderer_id）以便把 7 段拼回一次启动。

## 数据流

```
main 进程
  T0 = process.getCreationTime()        // 锚点
  T1 = Date.now()  (index.ts 模块顶部)
  T2 = Date.now()  (app.whenReady 回调入口)
  T3 = Date.now()  (主窗口 loadURL 前)
    └─ 序列化 {T0,T1,T2,T3} 注入 webPreferences.additionalArguments
       形如 --zcode-launch-marks=<json>（先例：desktopWindowChrome.ts:283 的 --device-id=）
         │
renderer 进程
  从 process.argv 解析出 {T0,T1,T2,T3}（先例：preload/index.ts:14 已读 argv）
  T4 = Date.now()  (renderer/src/main.tsx 模块顶部)
  T5 = Date.now()  (zcode-react-startup-ready, 一次性)
  T6 = Date.now()  (Root: isStartupRenderBlocked true→false)
    └─ 在 T6 处统一算 7 段 → reportUiLaunchStages(...)
       → uiPerfArmsTelemetry 单例 reporter.reportArmsCustomEvent × 7
       → window.zcode.reportArmsCustomEvent → IPC → armsRum.sendCustom
```

公共维度（app_version / arms_env / device_mid / platform / renderer_id）由 main handler 统一补齐，UI 侧不重复填。

## 终点 T6 的判定与边界

- **T6 定义**：`Root.tsx` 的 `isStartupRenderBlocked`（L547，由 `shouldShowRootStartupLoading` 计算）由 `true→false` 翻转的那一刻——此时 `RootStartupLoading` 退场、`LexicalChatInput` 挂载并可编辑。在 Root 加一个 `useEffect` 监听该布尔翻转，翻到 `false` 时记 `T6` 并触发上报（用 ref 保证每进程仅触发一次）。
- **未登录 / WelcomeScreen 边界**：`shouldShowRootStartupLoading` 在 `welcomeScreenOpen` 时返回 `false`（`rootStartupGate.ts:47`），即门禁「清除」但显示的是登录页、**没有输入框**。该启动**不上报** `perf_ui_launch_to_input` 总链路（前提「能输入」不成立），避免污染分布。判定方式：T6 触发时若处于 WelcomeScreen 状态则整批跳过。已登录正常进入工作区的启动才上报。
- **reporter 注入时序**：与旧 `perf_ui_first_screen` 不同，T6 发生在 Root mount 之后、门禁清除时，reporter 早已由 `setUiPerfArmsReporter` 注入，**无需** `pendingFirstScreenPayload` 暂存补发逻辑（该逻辑随旧事件一并删除）。

## 时钟健壮性

- `Date.now()` 是墙钟，启动中途系统校时理论上可能产生负值/跳变。每段 `value` 经 `Math.max(0, Math.round(...))`（沿用现有约定）。
- 哨兵：总时长 `T6 - T0` 若 > `LAUNCH_TO_INPUT_SANITY_MAX_MS`（如 300000ms / 5min）视为异常，整批丢弃并 `logger.warn`，不上报。
- `process.getCreationTime()` 在极少数平台可能返回 `null`/`-1`；此时整批跳过（无法对齐锚点），`logger.warn`。

## 现有 `perf_ui_first_screen` 处理：废弃，完全替换

其语义被 `perf_ui_launch_react_commit_ms`（`T5 - T4`）完全覆盖。一并清理：

- `uiPerfArmsTelemetry.ts`：删除 `UI_PERF_EVENT_FIRST_SCREEN`、`reportUiFirstScreen`、`pendingFirstScreenPayload` 及 `setUiPerfArmsReporter` 内的补发分支。
- `renderer/src/main.tsx`：删除 `uiFirstScreenStartedAt` 与 `zcode-react-startup-ready` 监听里调用 `reportUiFirstScreen` 的部分（该事件监听本身保留——T5 仍需它）。
- 测试 / 文档中 `perf_ui_first_screen` 的条目替换为新事件。

> 注：旧事件历史看板会断更。已与需求方确认接受（目标是更完整的启动链路，旧的 75ms 段并入新链路）。

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/desktop/src/main/index.ts` | 模块顶部记 `T1`；`whenReady` 回调入口记 `T2`；取 `T0=process.getCreationTime()` |
| `packages/desktop/src/main/desktopWindowLifecycle.ts` | `loadURL` 前记 `T3`；把 `{T0,T1,T2,T3}` 注入主窗口 `additionalArguments` |
| `packages/desktop/src/preload/index.ts` 或 renderer 入口 | 从 `process.argv` 解析 launch marks，暴露给 renderer |
| `packages/desktop/src/renderer/src/main.tsx` | 记 `T4`；`zcode-react-startup-ready` 里记 `T5`（移除旧 `reportUiFirstScreen` 调用） |
| `packages/ui/src/Root.tsx` | `useEffect` 监听 `isStartupRenderBlocked` 翻转记 `T6`，组装 marks 调 `reportUiLaunchStages`（含 WelcomeScreen 跳过判定） |
| `packages/ui/src/lib/uiPerfArmsTelemetry.ts` | 新增 `reportUiLaunchStages(marks)` 发 7 条；删除 `reportUiFirstScreen` 及暂存逻辑；新增常量 |
| `packages/ui/src/lib/uiPerfArmsTelemetry.test.ts` | 删旧 first_screen 用例；新增：7 段 payload 正确、负值钳为 0、哨兵丢弃、WelcomeScreen 跳过、reporter 未注入吞错 |
| `docs/monitoring/performance-monitoring.md` | 事件一览替换 `perf_ui_first_screen` 为 7 个 `perf_ui_launch_*` |

## 常量

| 常量 | 值 | 位置 |
|------|-----|------|
| `UI_PERF_ARMS_GROUP` | `"ui_perf"`（复用） | uiPerfArmsTelemetry.ts |
| `UI_PERF_EVENT_LAUNCH_TO_INPUT` 等 7 个事件名 | 见上表 | uiPerfArmsTelemetry.ts |
| `LAUNCH_TO_INPUT_SANITY_MAX_MS` | `300000` | uiPerfArmsTelemetry.ts |
| `LAUNCH_MARKS_ARGV_PREFIX` | `"--zcode-launch-marks="` | 共享常量 |

## 错误处理

- 所有上报内部 try/catch，失败仅 `logger.warn`，绝不阻塞启动主流程（沿用现有约定）。
- reporter 未注入时静默返回（T6 时已注入，正常不触发）。
- 任一锚点缺失（T0 无效 / argv 未解析出 marks）→ 整批跳过，不发部分数据。

## 测试

- **单测**（`uiPerfArmsTelemetry.test.ts`）：
  - 给定 `{T0..T6}`，7 条 payload 的 name/group/value 正确，相邻差计算正确。
  - 某段为负（时钟回拨）→ 该段 value 钳为 0，其余正常。
  - 总时长 > 哨兵阈值 → 整批不发。
  - WelcomeScreen 标志为真 → 整批不发。
  - reporter 未注入 / reporter 抛错 → 不抛、不阻塞。
- **本地验证**（`arms_env=local`）：
  - 冷启动登录态 → main 日志 `beforeReport` 依次出现 7 条 `custom:perf_ui_launch_*`，total ≈ 各段之和。
  - 各段数量级 sanity：`react_commit` 应接近旧 first_screen 的 ~75ms。
  - 未登录冷启动 → 不出现 `perf_ui_launch_to_input`。
  - 回归：`perf_ui_first_token` / `perf_ui_message_complete` / `perf_ui_stream_stall` 不受影响。

## 未来可调整项（非本期）

- `react_commit` / `startup_gate` 段若发现是大头，可再细分（如 workspace 恢复 vs provider 启动）。
- 量级稳定后据 p50/p90/p99 设启动性能基线告警。
- 二次窗口 / reload 链路如需监控，另立事件，不混入冷启动分布。

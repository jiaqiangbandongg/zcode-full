# Desktop 启动关键路径优化

## 背景与基线

2026-08-05 对生产版冷启动日志和运行时 mark 的采样显示：

- Local Host 从 `initializing local services` 到 `local services ready` 的最近 12 次中位数为
  `2.081s`，最近一次为 `2.208s`。
- 同机单独执行两次现有 login shell 探测各约 `0.97s`：一次只读取 `PATH`，一次读取
  `env -0`。后者已经包含 `PATH`，两次串行探测属于重复工作。
- Local Host ready 后首秒产生约 `146` 次 RPC；恢复 13 个 workspace 时，task list 的
  list/archive/pin/delete 查询会随全部 tab 同时进入数据源。
- 最近一次生产冷启动估算输入可用约为 `5.3s`；内置 T0-T5 mark 中 React 首次 commit 仅
  `24ms`，主要等待发生在 Host 初始化和启动 gate 之后的 workspace 恢复。

本文定义两个 P0 改动，只缩短 Desktop 本地窗口的启动关键路径，不改变 task/session 的
权威状态、remote workspace 连接语义或手机远控恢复协议。

## P0-1：提前异步采集一次 login shell 环境

### 现状

```text
renderer dom-ready
  -> fork Local Host
     -> createLocalServices()
        -> zsh -ilc <capture PATH>   ~0.97s，阻塞 Host 事件循环
        -> zsh -ilc 'env -0'         ~0.97s，阻塞 Host 事件循环
        -> 构造 services
        -> 发布 RPC port
```

### 目标时序

```text
Desktop Main 模块初始化
  +-> async shell -ilc 'marked env -0'  --------+
  |                                              |
  +-> app.ready -> create window -> renderer DOM |
                                                 v
renderer dom-ready -> await 已预热 snapshot -> fork Local Host
                                               -> InitLocal(envPatch)
                                               -> createLocalServices(envPatch)
                                               -> 直接发布 RPC port
```

约束：

1. shell 只执行一次；同一份 null-separated snapshot 同时提供 `PATH` 和允许继承的环境字段。
2. Main 使用异步 `execFile`，采集与 Electron/app/window 初始化并行；不得在 Main 或 Local Host
   关键路径使用同步 shell IO。
3. Main 只负责采集和传递已过滤的 runtime patch，不把 shell 环境直接写入 Main 自身。
4. `InitLocal` 可以携带 `runtimeProcessEnvPatch`；Remote Host 不复用本机 patch，避免把本地
   `PATH`、`SSH_AUTH_SOCK` 或 workspace authority 带入 SSH/WSL/Docker。
5. Windows 当前不执行 POSIX shell 探测，继续使用原有 bootstrap/Node path 规则。macOS、Linux
   使用同一异步实现。
6. 非 Desktop Local Host 的旧同步创建入口暂时保留单次 snapshot fallback，保证 remote server
   和测试调用兼容；它不再执行重复的 PATH + env 两次探测。
7. snapshot 失败或超时 fail-open：使用当前进程环境、POSIX bootstrap path 和 bundled tools，
   不阻断窗口启动，也不记录环境值或密钥。

### 2026-08-09 生产反馈后的安全边界

性能优化继续保留，但环境预热只能是有界的启动加速项，不能成为 Local Host 的单点启动门禁。
生产日志已经确认两类独立故障：macOS 白屏样本只有 `dom-ready`，之后始终没有 Host fork；Windows
样本的 Host 可正常启动，但把大小写不敏感的 `Path` 展开为普通对象后，下游按 `PATH` 读取，最终只把
bundled tool 目录写入新 `PATH`，覆盖了用户原有命令目录。

正确时序必须满足：

```text
Main module import
  -> per-window async login-shell capture
       | success before deadline -> complete filtered patch
       | failure / hard deadline -> shell-free fallback patch
       v
renderer dom-ready
  -> bounded wait（不能无限等待 Promise）
  -> fork Local Host exactly once
  -> InitLocal 始终携带完整 patch
  -> Host 禁止因为 fallback 再同步执行 login shell
```

环境不变量：

1. Windows 的环境变量名按操作系统语义大小写不敏感。`process.env`、dotenv 与预热 patch 一旦复制到
   普通对象，必须先把所有 `Path` 大小写变体合并成唯一 `PATH`；真实进程环境优先于 dotenv。
2. fallback patch 必须由当前进程环境、平台 bootstrap path 与 bundled tools 直接计算，不得用
   `undefined` 触发 Host 内旧的同步 shell fallback。
3. login shell 采集自身必须有 hard deadline；POSIX 超时后要终止该采集的进程组并立即结算 Promise，
   避免 profile 启动的后代进程继承 stdio 后让 `execFile` 永远等不到 close。
4. Window 生命周期还要有独立 deadline。即使测试注入或未来 executor 永不 settle，Local Host 也必须
   使用 fallback 创建；迟到的预热结果不得再创建第二个 Host。
5. 首窗复用 Main import 时已经开始的预热；后续新窗口各自重新异步采集，避免一个进程生命周期内永久
   复用过期的 shell 环境。Renderer reload 若已有 Host，继续直接重挂端口，不重新等待或创建 Host。
6. 日志只记录耗时、成功/降级原因和生命周期，不记录 PATH 内容、环境值或密钥。

## P0-2：active workspace 先恢复，inactive 首帧后补齐

### 现状

```text
settings.get
  -> ensure conversation workspace
  -> restoreTabs([workspace 1 ... workspace N], activeIndex)
  -> 所有 tab 同时进入 task/sidebar/session hooks
  -> N 个 workspace 的 index subscription 与 membership RPC fan-out
  -> startup gate 清除
```

### 目标时序

```text
settings.get
  -> 解析完整且去重后的 persisted session
  -> restoreTabs([active workspace], 0)
  -> startup gate 清除 -> active 输入框可用 (T6)
  -> 首帧后的 browser idle callback
     -> completeTabRestore(full persisted session)
     -> 保留 active tab id / 当前焦点 / 用户新开的 tab
     -> inactive workspace 在后台进入 task list 数据源
     -> 允许后续 tab session 持久化
```

状态约束：

- 只在 Desktop 主窗口的本地 `desktop-continuous` 恢复链路启用 active-first。Web、手机
  `web-remote-replayable`、不恢复会话的次级窗口维持现状。
- active workspace 的选择继续复用 `resolveStartupLocalWorkspaceSessionIndex`：持久化 active 为
  断连 remote 时仍选择可用 local workspace；不改变远程自动重连禁用语义。
- inactive 补齐必须是 merge，不得重建已经恢复的 active tab，不得抢焦点，也不得覆盖补齐前
  用户新开的 settings/workspace tab。
- active-only 是瞬态投影，不是新的持久化事实。inactive 补齐完成或失败前，tab persistence
  不得把 active-only 状态写回 `lastWorkspaceSession`。
- `requestIdleCallback` 不可用时使用异步 timer fallback；两者都必须可取消，Root unmount 后不得
  修改旧窗口 store。
- 补齐失败记录 UI logger error 并释放 persistence gate；启动输入仍保持可用。

active-first 是 Renderer 内部的两阶段恢复状态，不是可以对外发布的 workspace 全量快照：

```text
pending
  -> active-ready
       | Renderer：允许 active workspace 首屏和输入
       | Main/TaskRealtimeBus：仍等待，不发布 workspaceKeys=[active]
       | Web remote：仍等待，不发布单 workspace 快照
       | persistence：仍关闭
  -> complete
       | 合并 inactive workspace
       | 发布完整 workspace scope
       | 打开 persistence gate
```

补充约束：

1. `syncWindowTabs`、`syncWebRemoteControlWorkspaces`、Web 远控 task 索引和依赖完整 workspace 集合的
   telemetry scope，只能在 `complete` 后消费 tabs。桌面仍是 `desktop-continuous`，手机仍是
   `web-remote-replayable`；这里不引入新的 replay/snapshot 状态。
2. 用户若在 `active-ready` 到 `complete` 之间关闭启动 active tab，补齐必须把该关闭视为本窗口用户意图，
   不得从旧的持久化快照把它重新加入。期间新开的 workspace/settings tab 与当前焦点仍需保留。
3. 完整恢复对身份判等继续使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；文件执行和
   展示继续使用 `workspacePath`。

## 验收与测试

自动化必须覆盖：

1. 一次异步 shell 调用同时生成 login `PATH` 和允许继承字段；失败时使用 fallback。
2. `InitLocal` 把预计算 patch 传到 Local Host，`createLocalServices` 使用注入值且不再触发 shell。
3. window 在 patch 尚未完成时不 spawn 新 Local Host；renderer reload 复用已有 Host 时不等待或重建。
4. active-first 首阶段只有一个 workspace，deferred 阶段补齐原顺序，并保留 active tab id/焦点。
5. deferred 完成前不持久化 active-only snapshot；调度可取消。
6. remote restore、Web/手机 replayable 和 workspace identity 行为保持现有测试通过。
7. Windows `Path` 输入生成唯一且保留用户目录的 `PATH`；Host 进程环境也不存在大小写重复键。
8. 永不 settle、reject 和迟到 resolve 的预热 Promise 都只能创建一个 Local Host，并在 deadline 后
   使用完整 fallback patch。
9. active-only 阶段不向 Main/手机远控发布单 workspace 快照；用户关闭 active tab 后补齐不复活它。

机械验证：`pnpm typecheck`、`pnpm lint`、相关 Vitest；性能验证使用同一份隔离后的 production
workspace/session 数据，至少各跑 3 次改前/改后冷启动，报告中位数及 Local Host ready、T6 两个
阶段的变化，不用单次最好值作为结论。

## 2026-08-05 实测结果

基线使用改动前同一提交的 detached worktree，改前/改后都构建 production bundle，并复制同一份
包含 15 个 persisted workspace 的隔离 storage fixture。每轮使用全新的 Electron 进程、user data
和数据库 clone，按 baseline/optimized 交替执行各 5 次；未清空操作系统文件缓存，因此这里的“冷启动”
指冷进程启动，不把不可控的整机冷缓存作为前提。

| 指标 | 改前中位数 | 改后中位数 | 变化 |
| --- | ---: | ---: | ---: |
| T0 到输入框可用（T6） | 5,441ms | 3,249ms | -2,193ms（快 40.3%） |
| Local Host 初始化 | 2,707ms | 17ms | -2,690ms（快 99.4%） |
| React commit 后 startup gate | 3,278ms | 579ms | -2,699ms（快 82.3%） |

新的单次异步 login shell snapshot 本身中位数仍约 `1,626ms`，但它在 Main 模块初始化时启动，和
Electron ready、窗口及 renderer 加载重叠；5 轮中都在 Local Host 创建前完成，所以不再进入 Host
关键路径。Host 阶段减少量不会一比一转化为 T6 减少量，因为 Agent/provider 就绪与 renderer 加载
原本存在部分并行；最终以 T6 的 `2,193ms` 中位数改善作为用户可感知结论。

## 后续极限路线：可恢复 App Shell，而不是 SSR

传统 SSR 不作为下一阶段方案。Desktop renderer 已经是本地静态资源，当前采样的 React 首次
commit 约 `24ms`；把 JSX 搬到 Main/Node 预渲染仍然需要 hydration，并不能消除 Host、鉴权、
provider 与 workspace RPC 等待，反而增加两套渲染环境和 stale UI 风险。

真正的下一阶段目标是把“可输入”和“数据已全部校验”拆开：

1. 持续原子写入一份版本化、最小化的 startup projection；不要只依赖正常退出回调，因为 crash、
   强制更新和系统关机都可能跳过退出收尾。
2. projection 只包含 active workspace identity/purpose、tab 顺序、有限条 task row 展示字段、未发送
   draft 和 UI 偏好；不保存 token、credential、完整对话、running 权威状态或远端连接能力。
3. Main 创建窗口时把 projection 随 bootstrap 一次性注入。Renderer 在任何 service RPC 前同步
   初始化 tab/sidebar/draft store，先挂载可编辑输入框；Send 在 Host ready 前进入本地 pending，
   ready 后再走原有权威命令链。
4. Host、settings 和 sessions/tasks index 后台并行恢复，用 schema version、storage profile、
   workspace identity 和更新时间校验 projection；不匹配时局部替换，不整页重置。
5. 长列表恢复继续分片并放入 `requestIdleCallback`；输入、workspace 切换和发送属于用户关键动作，
   不得放入 idle callback。
6. 可选保存窗口截图作为启动 cover，只改善“看到界面”的时间，不把它计为 T6，也不能遮住已经
   可编辑的真实 App Shell。

这条路线预期可以让“看到界面”和“开始打字”早于 Host ready；完整 task/session 权威投影仍按后台
恢复完成。具体预算要以 P0 改后基线重新定，不在设计阶段承诺固定毫秒数。

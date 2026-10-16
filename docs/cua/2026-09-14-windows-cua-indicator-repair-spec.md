# Windows CUA 操作指示器修复 Spec

## 状态

Accepted（2026-09-14）

## 目标

Windows 顶部提示条（`ZCode 正在操作电脑` / `ZCode is controlling your computer`）在模型使用
Computer Use 期间可见，并且**在任何情况下都能关闭**。

指示器保持在 desktop main 侧（`windowsCuaOperationIndicator.ts`，2026-08-04 的既有实现），
只修被 SDK 重构打断的那一段判定链路。

本 spec 不改变：模型可见工具面、SDK 形状、broker 协议、Helper 生命周期与进程模型、
macOS PiP 行为。zcode-cua producer **零改动**，因此不需要升 pin。

## 为什么当前失效

`bootstrap/src/zcode-protocol/computer-use-operation-event.ts` 用正则从
`mcp__node_repl__js` 的 `input.code` 里提取 SDK 调用名，再拿动作词表
（tracker 的 `CUA_SDK_ACTIONS`）比对。node_repl 重构后没有任何真实调用形态能命中：

| 模型实际写法（SKILL.md） | 正则结果 |
| --- | --- |
| `agent.computerUse.getApp("Notes")` | `getApp`（不在动作集，门面方法是 camelCase） |
| `app.click(42)` / `app.typeText(…)` / `app.pressKey(…)` | 不匹配（变量名是 `app`） |
| `agent.computerUse.computer.left_click({…})` | 不匹配（`computer` 后是 `.` 不是 `(`） |

唯一能命中的 `agent.computerUse.left_click(…)` 在 SDK 与文档中都不存在，只存在于
`bootstrap/tests/computer-use-operation-event.test.ts` 的夹具里——该测试长期为**假绿**。

叠加一个粒度缺陷：一个 cell 内含多个动作，但 agent 只可见一次 tool call，因此
`AUTO_HIDE_MS = 10_000` 在单个 cell 内得不到续期，cell 超过 10 秒时提示条会在电脑仍被
操作时熄灭。

## 设计：一个布尔事实

判定收敛成一句话——**这个 cell 是否在用 Computer Use**，不再关心它在做哪个动作。

```
bootstrap  mapComputerUseOperationEvent
  └─ tool-scheduled: code.includes("setupComputerUseRuntime") → { computerUse: true }
        │  sideband（既有通道，无新增 kind）
        ▼
services   cuaOperationTurnTracker
  └─ 排期时记下事实 → tool-started 兑现 → reporter
        │  既有 host→main 通道
        ▼
desktop    windowsCuaOperationIndicator（既有实现，只调兜底时限）
```

### 锚点为什么是 `setupComputerUseRuntime`

它是模型**必须原样照抄**的引导语句，而且这是架构强制而非文档软要求：node_repl 每个 cell
都是全新 Worker、SDK 绑定不跨 cell，所以模型面文档写明「The first executable statement of
every CUA cell must be this bootstrap, and the bootstrap and the actions must be in the
**same** cell」（`zcode-cua-plugin/docs/computer-use.md:25`、`skills/computer-use/SKILL.md`）。
凡用 CUA 的 cell 必然含这一句。

它还自带回归防护：`zcode-cua-plugin/tests/skill-sync.node-test.mjs` 钉住了 SKILL.md 里
`setupComputerUseRuntime({ globals: globalThis })` 这个模式，引导语句一旦改写那个测试会红。
旧正则最缺的正是这一层——它锚在会随 SDK 动作面演化的东西上，且无人钉住。

Browser Use（`agent.browsers.*`）不含该引导，不会命中。

### 为什么事实只挂在 `tool-scheduled` 上

`ToolCallStartedPayload` 没有 `input` 字段（`contracts/src/events/session.events.ts:633`），
start 时已拿不到模型源码，所以"是否 CUA"只能在排期时判定。

但浮层要等 `tool-started` 才亮：排期到开始执行之间可能卡在权限审批上，那时还没有人在操作
电脑。tracker 因此在排期时把事实存进 `computerUseScheduledCalls`（键为
`turnKey\0toolCallId`），由 `tool-started` 兑现并消费。

缺了排期事件时（例如该事件因缺 `turnId` 被丢弃）不激活——失败方向是**不亮**，不是乱亮。

## 关闭路径

显示只有一个入口，关闭有六条，任意一条成立即收场：

| 触发 | 位置 |
| --- | --- |
| `turn-completed` / `turn-failed` | tracker `clearTurn` → reporter `active:false` |
| `session-closed` | tracker `clearSession` |
| 新 turn 顶掉旧 turn | tracker `retireTurn` + `clearSession` |
| workspace 关闭 / runtime 不可用 | `clearWorkspaceKey` / `clearSource` |
| 应用退出 | `dispose()` 销毁窗口 |
| 以上全部失约 | `AUTO_HIDE_MS` 兜底计时器 |

兜底时限从 `10_000` 调到 `30_000`。理由：事实现在按 cell 上报，同一 turn 内后续 cell 会
刷新计时器，但单个 cell 本身可以跑很久，10 秒会让浮层在操作中途熄灭；30 秒同时保住了
"没有人来关也一定会关"这条底线。

Reporter 与边界回调的异常都被吞掉并只记 warn（`report` / `notifyBoundary`）：展示旁路绝不
能截断主 session event 链路。反过来，异常发生在**显示**路径时浮层不会亮，发生在**隐藏**
路径时兜底计时器仍会收场。

### 放弃的即时隐藏

旧实现认 `stop_computer_control` 动作名，模型主动停止控制时立刻隐藏。布尔事实下拿不到动作
名，这条快捷路径没了：模型停止控制后若继续工作，浮层会停留到 turn 终态或 30 秒兜底。这是
换取整条链路不再依赖动作词表的代价，且上界有限。

## 删除的死代码

- `nodeReplComputerUseAction` 正则及其三个虚构形态夹具
- tracker：`CUA_SDK_ACTIONS`、`NON_OPERATING_ACTIONS`、`OFFICIAL_CUA_TOOL_PREFIXES`、
  `STOP_ACTION`、`resolveOfficialCuaAction`、`scheduledToolNameByCall`、
  `scheduledOperationActionByCall`
- 协议：`tool-scheduled` / `tool-started` 的 `operationAction` 字段

`mcp__computer-use__*` 前缀分支同批删除：`zcode-cua-plugin` 不再注册任何 MCP server
（`package.json`：execution is provided by the shared node_repl host），旧配置在 bootstrap
即被丢弃且禁止重新注册（`2026-08-24-cua-node-repl-sdk-migration-spec.md`、
`cua-dev-mcp-runtime-assets.md`），且 tracker 只从 live sideband 喂入
（`zcodeAgentService.ts:1910`），历史 transcript 的只读解析到不了它。

**消费者已核实**（2026-09-14）：`ZCodeComputerUseOperationEvent` 与
`zcodeComputerUseOperationEventSchema` 的引用只出现在三处——`packages/shared`（定义与其
测试）、`packages/services/src/zcode-agent/{zcodeAgentService,cuaOperationTurnTracker}.ts`
及其测试、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts`。
UI、desktop main、web 与其他包均无引用，因此 `operationAction` 没有本链路之外的消费者。

`toolName` / `toolCallId` 保留：tracker 需要 `toolCallId` 做排期与开始的配对。

## 验收

1. bootstrap 单测：夹具改用 SKILL.md 里的**真实**引导语句；纯 Browser Use、无引导的普通
   cell、非 node_repl 工具携带同名文本三种情况均不命中；`tool-started` 永不携带该事实。
2. 协议单测：`computerUse` 只接受 `true`（`false` 与动作名被拒）；`tool-started` 携带
   `computerUse` 被 strict schema 拒绝。
3. tracker 单测：只排期不激活；无 `computerUse` 的 node_repl cell 不激活；缺排期事实的
   `tool-started` 不激活；同 turn 多 cell 逐次续期；turn 终态 / `session-closed` /
   新 turn 顶掉 / `clearWorkspaceKey` / `clearAll` 五条清除路径各自成立；reporter 抛错
   不影响事件处理。
4. 指示器单测：兜底时限为 30 秒且每次 active 都重新计时。
5. 全仓 `src` 下 `operationAction`、`CUA_SDK_ACTIONS`、`resolveOfficialCuaAction` 零命中；
   没有任何测试再断言从模型源码推断动作名。
6. Windows 真机：含多个动作、总时长超过 10 秒的 CUA cell 全程提示条不熄灭；Browser Use
   与普通 node_repl cell 不显示；turn 结束后隐藏；切换应用语言后文案跟随。

## 被否决的替代方案：Helper 自持窗口

2026-09-14 曾按 macOS PiP 的结构实现"面板与触发事实同处 Helper 进程"：触发点取
`dispatchRequest`（Helper 内每个 broker 方法的唯一咽喉点），turn 范围复用
`pip_session_event`，窗口用 Electron `BrowserWindow`。

该方案的事实来源确实比正则可靠——它就在注入点本身。放弃的原因是成本与本次目标不成比例：

- Windows Helper 以 `ELECTRON_RUN_AS_NODE=1` 启动，该模式下没有窗口 API。要去掉它，
  代价是每个 Helper 多 3 个 Chromium 子进程。
- 需要新增 `indicator_set_presentation`（文案只能由 host 传入，Helper 侧无 i18n），
  协议面从 43 变 44，按约定必须把 `CUA_BROKER_IPC_VERSION` 从 2 bump 到 3。
- 需要在 Helper 内新写状态机与窗口，且跨两个仓库交付、要升 producer pin。
- 两侧实现不得共存，desktop main 侧的既有指示器必须在真机验收后删除。

而 zcode 侧修一处判定即可，producer 零改动。方案期间踩到并已修掉的真实缺陷单独留存：
`windowsCuaDevHelperHost.ts` 把 `ELECTRON_RUN_AS_NODE: "1"` 硬编码在 `...commandEnv`
**之后**，导致 `commandEnv` 永远无法覆盖它——这是当时真机测试指示器始终不出现的根因。

实测数据留档（Windows 11 / Electron 41.0.3），若将来重启该方案可直接复用：

| 验证项 | 结果 |
| --- | --- |
| 完整 Electron 模式下 Helper ready / broker RPC / `stop()` 退出 | 集成测试 2 passed，exit 0 |
| `BrowserWindow` + `setAlwaysOnTop(_, "screen-saver")` + `screen` API | 均可用 |
| `helperReaper` 的 `--socket <值>` 匹配 | 命令行含该值的进程恰好 1 个，精确认领不受影响 |
| 硬杀 Helper 后 Chromium 子进程（gpu/utility/renderer） | 3 个全部随父退出，零孤儿 |

另需注意：不能用 `isReadOnlyBrokerMethod` 取反当触发判据。该集合服务于**软超时**判定
（凡有副作用都算动作），非只读一侧混着 lease 仲裁、焦点防抢与 `pip_session_event`——后者
每个 `turn-started` 都会发一次，取反会让提示条恒亮。

## 迁移与历史

- 2026-08-04 `2026-08-04-windows-cua-operation-indicator-design.md` 确立指示器与文案，
  实现落在 desktop main。
- 2026-08-24 迁至 node_repl + SDK，约定 sideband 携带从 SDK 调用名解析出的
  `operationAction`，当时以扁平 `computerUse.<action>()` 形态实现。
- 2026-09-13 `e2d7a9f2e9` 重塑 SDK 为 `getApp()` + 绑定对象 + `computer.*` 逃逸口，
  动作名转 camelCase 门面。正则与 `CUA_SDK_ACTIONS` 未同步，指示器自此失效；因该路径无
  typecheck 覆盖（测试目录不在 `packages/services/tsconfig.json` 的 `include` 内）且夹具
  虚构了调用形态，CI 全程为绿。
- 2026-09-14 曾尝试"producer 发布动作级事实 + MCP 通知送回 agent"（zcode-cua
  `4439fc8a`，已由 `c0ad9f81` 回滚）。该方案要新建跨进程通道、新协议 kind 与信任边界；
  复核 PiP 结构后确认面板可与事实同处 Helper，那条回程路整体不需要。
- 2026-09-14 Helper 自持窗口方案（见上）实现后否决，zcode-cua 侧改动整体 reset。

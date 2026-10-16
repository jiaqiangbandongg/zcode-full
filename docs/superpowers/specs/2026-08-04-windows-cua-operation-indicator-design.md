# Windows CUA 顶部操作提示设计

> **部分被取代（2026-09-14）**：本文的**触发判定**与**10 秒安全计时器**两处已经改变。
> 触发不再是"每次官方 CUA 工具的 `tool-started`"——node_repl + SDK 重构后动作级 tool call
> 已不存在，现在按 cell 判定（sideband 布尔事实 `computerUse`，锚点是引导语句
> `setupComputerUseRuntime`）；安全计时器随之从 10 秒放宽到 30 秒，并明确退为兜底，
> 主导隐藏的是 turn 终态等显式清除路径。窗口形态、文案、位置、点击穿透、
> `host source + cuaTurnKey` 聚合与多窗口语义均不变。
> 见 `docs/cua/2026-09-14-windows-cua-indicator-repair-spec.md`。

## 背景与目标

Windows 用户在 ZCode 通过 Computer Use 观察或操作桌面时，当前只能从会话工具卡和操作结果判断是否仍在执行。ZCode 窗口被其他应用遮挡后，这些信息不可见，用户无法持续确认当前机器是否仍由 Agent 操作。

本功能在 Windows 桌面顶部显示一个不抢焦点、可点击穿透的轻量提示：

> ZCode 正在操作电脑

提示从一个 turn 首次真正开始执行官方 Computer Use 工具时出现，在该 turn 结束或控制链路异常终止时消失。它不提供暂停、停止或接管按钮；这些控制能力不在本次范围内。

## 设计取舍

- 活跃状态按 `session_id + turn_id` 维护：新 turn 的第一条 Computer Use 工具调用触发提示；新 turn 替换旧 turn 时先结束旧 turn；`end_turn`、pipe/socket 关闭、dispose 都会结束活跃 turn。
- 提示由独立的桌面浮层窗口承载，不依赖主窗口的 React 树。
- Picture-in-Picture 仅限 macOS，不作为 Windows 实现基础；可见性收口到 CUA 工具触发级别。

## 范围

### 包含

- Windows desktop-local Computer Use。
- 由桌面窗口直接发起，或由手机 `/remote` 复用同一个 desktop-local Host 发起的本机 Computer Use。
- 当前显示器顶部的非交互式操作提示。
- 中英文文案、亮暗主题、DPI、多显示器和 reduced-motion。
- turn 成功、失败、停止、session 关闭、runtime 重启、Host 退出和应用退出的终态收口。

### 不包含

- macOS PiP 或后台模式。
- Linux 顶部提示。
- Web/手机端自行渲染提示。
- 暂停、停止、人工接管等交互按钮。
- 实时画面、步骤列表、目标窗口标题或 per-action 文案。
- 修改 `zcode-cua` broker/native wire protocol。

## 设计原则

1. **CLI 提供权威生命周期，Host 拥有桌面投影状态。** CLI 从 runtime 原始事件发送精简的临时旁路通知；Host 维护活跃 turn，Main 只消费 Host 上报的投影状态并管理原生窗口，不从工具卡或 Renderer DOM 猜测。
2. **tool 级触发 + 有界显示。** 每次真实 CUA 工具 `tool-started` 都重新触发提示并把可见截止时间延长 10 秒；同一工具调用期间不重复创建原生窗口。没有后续 CUA 工具时，提示最多在最近一次工具触发后保持 10 秒。
3. **真实 CUA 工具触发。** 普通 Agent turn 和普通 MCP 工具不会显示提示。
4. **fail closed to hidden。** Host/runtime 生命周期中断时必须移除对应活跃记录，不能留下永久浮层。
5. **不进入截图。** 浮层必须启用 Windows capture exclusion，避免被 CUA 截图再次喂给模型。
6. **全流程使用中划线。** 新代码只生成和判断官方 `computer-use` canonical identity，不新增 `computer_use` 命名链路。
7. **不依赖对话投影订阅。** CUA 生命周期通知不得受旧 `session/event` 的 `deliveryKind` 或 v4 conversation subscription 是否存在影响，也不得进入 snapshot、replay、conversation frame 或持久化事件流。

## 状态与时序

### 权威键

Host 内使用以下键隔离一次活跃 CUA turn：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
cuaTurnKey   = workspaceKey + NUL + sessionId + NUL + turnId
```

除 `session-closed` 外，生命周期通知都携带 runtime 原始 `turnId`；其中 `tool-started` 允许兼容缺少 `turnId` 的 runtime 事件。此时 tracker 使用该 session 最近收到的 `turn-started` turnId；两者都缺失时不激活提示，避免把不明来源状态扩散到其他 session。

Tracker 同时维护 session 的单调 `sequenceNumber` watermark、已处理 `eventId` 和有界 retired turn 集合。低于已处理 watermark 的迟到事件、重复事件、已经被新 turn 替换或已经 terminal 的 turn 后续事件全部忽略，避免旧 turn 回退或在终态之后重新激活提示。runtime/workspace 清理时同时清除这些临时索引。旁路通知是 tracker 的唯一协议事件源，不与旧 `session/event` 的独立序号域混用。

### 事件流

```text
CLI runtime              CLI protocol sideband       Host tracker           Desktop Main       Overlay
    | turn_started              |                         |                       |                 |
    |-------------------------->| computer-use/           |                       |                 |
    |                           | operation-event         |                       |                 |
    |                           |------------------------>| remember turn         |                 |
    |                           |                         |                       |                 |
    | tool_call_scheduled       |                         |                       |                 |
    |-------------------------->|------------------------>| remember id/name      |                 |
    | tool_call_started         |                         |                       |                 |
    |-------------------------->|------------------------>| each CUA tool        |                 |
    |                           |                         |-- active(turnKey) --->| add key         |
    |                           |                         |                       |-- show -------->|
    | ... more CUA tools ...    |------------------------>| refresh deadline      | extend 10s      |
    | turn_complete/error       |                         |                       |                 |
    |-------------------------->|------------------------>|-- inactive(turnKey) ->| remove key      |
    |                           |                         |                       |-- hide -------->|

v4 conversation frame -----------------------------------------------> Renderer（既有链路，不参与提示状态）
旧 session/event（无 deliveryKind 时不存在）--------------------------X Host tracker
```

### 触发规则

`tool-scheduled` 用于建立 `toolCallId -> toolName` 映射；`tool-started` 才能激活或刷新提示。因为 runtime started payload 中的 `toolName` 是可选字段，tracker 先读 started 自带名称，再回退 scheduled 映射。CLI 只发送工具名和调用标识，不发送 tool input、tool result、模型文本或截图内容。

识别范围：

- 接受官方 canonical `mcp__computer-use__*` 及带 official plugin namespace 的 `computer-use` 工具名；
- 截图、读取应用状态、点击、滚动、拖拽、键盘、输入、打开应用等都激活；
- `wait` 和 `request_access` 不激活，因为它们不代表正在观察或操作桌面；
- `stop_computer_control` 不激活，并在其 `tool-started` 到达时立即清理该 session 当前活跃的 CUA turn。

### 结束规则

以下事件移除对应活跃键：

- `turn-completed`
- `turn-failed`
- `session-closed`
- `stop_computer_control` started
- 最近一次 CUA `tool-started` 后 10 秒无新的 CUA 工具触发
- workspace runtime restart/dispose
- Host process exit
- ZCode app quit

CLI 不为单个 `tool_call_result|tool_call_error` 发送旁路通知。工具结果不会主动隐藏提示；提示由最近一次 CUA `tool-started` 后的 10 秒安全计时器收口，后续 CUA 工具会重新计时。这样既不会在连续工具之间闪烁，也不会因工具失败或终态通知丢失而永久残留。

Main 按 `host source + cuaTurnKey` 维护集合，并为每个活跃键维护最近一次 CUA 工具触发的 10 秒截止时间。只要集合非空就显示；终态或计时器清理最后一个键后才隐藏，从而覆盖多窗口和并行 session。

CLI 旁路通知和 Reporter 都是 best-effort 桌面投影旁路。通知构造、Host MessagePort 关闭竞态或上报异常只能记录 `warn`，不得截断 v4 conversation frame、普通协议通知或 CUA 工具执行。

## 组件边界

### App ↔ Agent：`computer-use/operation-event`

在 `packages/shared/src/zcode-protocol/index.ts` 新增严格校验的单向通知，method 固定为 `computer-use/operation-event`。`computer-use` 与 `operation-event` 全部使用中划线。Payload 是以下判别联合：

```ts
type ZCodeComputerUseOperationEvent =
  | {
      kind: "turn-started" | "turn-completed" | "turn-failed";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId: string;
      timestamp: number;
    }
  | {
      kind: "tool-scheduled";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId: string;
      timestamp: number;
      toolCallId: string;
      toolName: string;
    }
  | {
      kind: "tool-started";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId?: string;
      timestamp: number;
      toolCallId: string;
      toolName?: string;
    }
  | {
      kind: "session-closed";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      timestamp: number;
    };
```

CLI 在 runtime `onSessionEvent` 入口、任何 `record.deliveryKind` 判断之前，把 `TurnStarted`、`ToolCallScheduled`、`ToolCallStarted`、`TurnComplete`、`TurnError` 和 `SessionEnded` 映射为上述通知。通知保留 runtime 原始 `eventId` 与 `sequenceNumber`，允许序号有间隙但必须单调；不为普通 streaming、tool progress/result 或模型内容发通知。

该通知只沿已经存在的 App ↔ Agent stdio 连接发送。它不创建新的 Agent runtime，不写 event store，不进入 v4 topic、snapshot、replayable 恢复或远程 relay 业务状态。旧 Agent 不支持该通知时 Windows 提示保持隐藏，不能回退到 Renderer/DOM 猜测。

### Services：`CuaOperationTurnTracker`

职责：

- 消费已经通过 `zcodeComputerUseOperationEventSchema` 校验的临时生命周期通知；
- 维护 current turn、tool name 和 active CUA turn；
- 只在 inactive → active 或 active → inactive 时调用 reporter；
- workspace/runtime dispose 时清理全部相关状态；
- 生命周期通知只走 `debug` 日志，状态跃迁可走 `info`。

它不依赖 UI、Electron 或具体 Helper 实现。

`ZCodeAgentService.wireClient` 校验 `computer-use/operation-event` 后直接交给 tracker。现有 `session/event` 仍服务旧协议消费者，但不再作为 CUA tracker 输入，避免 raw `sequenceNumber` 与协议投影 `seq` 两个序号域互相覆盖。

### Host → Main 消息

新增严格 schema 的单向消息：

```ts
type HostCuaOperationStateResponse = {
  type: "cua-operation-state";
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
};
```

仅 `serviceAuthorityMode="desktop-local"` 的 Host 装配 reporter。远程 workspace Host、server 和普通 Web 不发送该消息。手机 `/remote` 复用 desktop-local Host 时仍会触发物理 Windows 屏幕上的提示，但手机 Renderer 不创建另一份提示。

### Desktop Main：`WindowsCuaOperationIndicator`

职责：

- 聚合不同 Host/window 的活跃键；
- 懒创建一个轻量 `BrowserWindow`；
- 按当前 app locale/theme 更新文案和配色；
- 在新一轮从空集合变为非空时，定位到当前鼠标所在 display 的 work area 顶部居中；
- app quit 时销毁窗口。

Main 不解析 `tool.updated`，不维护 session 业务状态，也不向 Host/Agent 回写。

## Windows 浮层视觉与窗口属性

默认视觉：

- 文案：中文 `ZCode 正在操作电脑`；英文 `ZCode is controlling your computer`；
- 顶部间距：可见卡片顶边位于 work area 顶边下方 `12px`；
- 可见卡片高度保持 `38px`；中文/英文宽度分别保持 `234px`/`308px`；
- 透明窗口在卡片外预留左/右 `8px`、上 `6px`、下 `12px` 的阴影安全区，因此中文/英文窗口分别为 `250px × 56px`/`324px × 56px`；窗口自身向上偏移 `6px`，保证扩大画布后可见卡片的位置不变；
- 容器：紧凑圆角、popover 语义背景与边框；只使用 CSS 绘制的克制双层阴影，不使用 Windows 原生窗口阴影；
- 左侧使用低对比度的三点呼吸动效，不增加品牌插画；
- 进入：`opacity 0 -> 1`、`translateY(-6px) -> 0`，`140ms`；
- 退出：反向动画，`120ms`；
- `prefers-reduced-motion: reduce` 时取消位移与循环动画，仅保留直接显隐。

窗口约束：

```ts
{
  alwaysOnTop: true,
  focusable: false,
  frame: false,
  resizable: false,
  show: false,
  skipTaskbar: true,
  transparent: true,
  hasShadow: false,
}
```

### 置顶层级与隐藏后复用

`BrowserWindow` 构造参数中的 `alwaysOnTop: true` 只保证首次创建时申请置顶。Windows 在透明窗口执行 `hide()` 后可能清除原生 `WS_EX_TOPMOST`；后续仅调用 `showInactive()` 只恢复可见性，不保证恢复 Z-order，因此前台普通窗口可能遮住提示条。

每次窗口显示都必须执行同一条无焦点置顶链路，包括首次 `loadURL` 完成后的显示和后续 turn 复用隐藏窗口时：

```text
showInactive()
      |
      v
setAlwaysOnTop(true, "screen-saver")
      |
      v
moveTop()
```

- `showInactive()` 保持目标应用的键盘焦点；
- `screen-saver` 层级让提示条保持在普通窗口、系统任务栏和常见全屏窗口之上；
- `moveTop()` 在不激活窗口的前提下把它移动到当前层级最前方；
- 以上调用不改变鼠标穿透、任务栏隐藏和 capture exclusion；
- Windows 安全桌面（例如 UAC）、锁屏以及部分独占全屏程序不属于应用窗口可覆盖范围，提示条不承诺显示在这些系统表面之上。

### 阴影所有权与裁剪边界

旧实现把 `234px × 38px` 卡片放在 `236px × 40px` 的透明窗口里，四周只有 `1px` 余量，但 CSS 阴影为 `0 4px 12px rgba(..., 0.20)`。CSS 阴影因此被窗口边界裁掉；同时 `BrowserWindow.hasShadow` 默认开启，DWM 又按矩形窗口外框绘制第二层原生阴影。最终视觉表现为卡片底部的硬边与宽矩形灰带叠加，而不是沿圆角自然扩散。

修复后的阴影 owner 只能有一个：

- `BrowserWindow` 显式设置 `hasShadow: false`，禁止 DWM 绘制矩形阴影；
- `body` 使用 `padding: 6px 8px 12px` 提供透明安全区，`.indicator` 占满 content box；
- 亮色阴影使用 `0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18)`；
- 暗色阴影使用 `0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28)`；
- 阴影、边框和透明安全区都在 capture-excluded BrowserWindow 内，不改变鼠标穿透、焦点或截图排除语义。

创建后必须调用：

```ts
window.setIgnoreMouseEvents(true);
window.setContentProtection(true);
```

浮层不可成为 key/focused window，不阻挡鼠标，不出现在 Alt+Tab 或任务栏，也不出现在 Windows 10 2004+ 的系统截图和 WGC capture 中。

## 异常处理与不变量

- Host 发送重复 active/inactive 时必须幂等。
- 未知 inactive key 直接忽略。
- 一个 Host 退出时，Main 清理该 Host 的全部 key；不能依赖 Host 在退出前成功发送 inactive。
- BrowserWindow 创建、安全属性配置或 loadURL 失败只记录 warn，不得影响 CUA 工具执行；同步创建/配置失败 fail-hidden，并在当前 active epoch 内最多自动重试一次，禁止形成重试死循环。
- 浮层窗口被系统意外关闭后，活跃集合仍保留；Main 在窗口 `closed` 回调中立即调度一次 reconcile，集合非空时重新创建，避免必须等待下一条 Host 状态。
- 每个 CUA 工具触发都设置 10 秒安全截止时间；后续工具触发会延长该键的截止时间。合法长 turn 仍可继续运行，但没有新的 CUA 工具触发时提示最多显示 10 秒。
- desktop `continuous` 和手机 `replayable` 状态不进入该 UI 状态机；它只消费本机 Host 收到的临时生命周期通知，不持久化、不进入 snapshot、不广播给 Web。手机 `/remote` 通过 shared-host attachment 复用本机 Host 时可触发同一物理 Windows 提示，但 relay 与手机端不拥有这份状态。
- `workspaceIdentity` 只用于身份隔离，`workspacePath` 仍用于路径语义，禁止混用。

## 测试策略

### Shared/CLI 协议测试

- schema 接受六种合法生命周期 payload，拒绝空 id、负序号、缺少必填 turn/tool 字段和未知 kind。
- CLI 在 `record.deliveryKind` 未设置、仅存在 v4 subscription 时仍发送旁路通知。
- 只投影 turn start/terminal、tool scheduled/started；不泄露 input、result、模型文本或截图。
- sideband notify 抛错只记录告警，不阻断既有 v4 frame 和工具执行。

### Services 单元测试

- 普通 turn 和普通 MCP 工具不激活。
- `tool-scheduled` 记录名称，`tool-started` 激活 canonical `computer-use`。
- 每个 canonical CUA `tool-started` 都向 Main 发送一次 active 刷新，供浮层重置 10 秒计时器；重复 `eventId` 仍必须去重。
- started 自带 toolName 时不依赖 scheduled。
- 同 turn 多个 CUA 工具分别上报 active 刷新，但不重复创建原生窗口。
- tool result/error 不隐藏。
- turn completed/failed 各上报一次 inactive。
- session close、stop tool、runtime/workspace clear 都清理。
- 缺少可确定 turnId 时不激活。
- 多 session、多 workspace、`workspaceIdentity` fallback 相互隔离。
- 低 `sequenceNumber` 的迟到 `turn-started` 不得替换当前 turn，terminal/retired turn 的迟到工具事件不得复活提示。
- 重复 `eventId` 不得产生重复跃迁。
- Reporter 抛错不得影响状态机或主 v4/协议事件投递。
- runtime `unavailable`（协议关闭、进程崩溃、请求超时）必须清理对应 workspace 的 tracker 活跃状态，即使没有后续 runtime restart。

### Shared/Host 单元测试

- `computer-use/operation-event` 和 `cua-operation-state` schema 接受完整合法 payload。
- 缺 sessionId/turnId、非法 active 或空 workspacePath 时拒绝。
- 只有 local Host 注入 reporter；remote workspace 不上报。

### Desktop Main 单元测试

- 第一个 active 创建并显示窗口。
- 重复 active 幂等。
- 多 Host/turn 聚合，最后一个 inactive 才隐藏。
- Host exit 清理其全部活跃键。
- 窗口具备 always-on-top、不可聚焦、任务栏隐藏、鼠标穿透和 content protection。
- 首次显示和隐藏后复用都按 `showInactive -> setAlwaysOnTop(true, "screen-saver") -> moveTop` 顺序恢复系统级置顶，且不激活窗口。
- 窗口显式关闭原生 `hasShadow`，透明画布具备 `6px 8px 12px` 安全区，CSS 阴影不再被稳定态窗口边界裁剪。
- 以鼠标所在 display 的 work area 顶部居中定位，并遵守 DPI 坐标。
- 扩大透明画布后，可见卡片仍保持原尺寸，且卡片顶边仍为 work area `+12px`。
- 每次 aggregate 从空变为非空时重新按当前鼠标 display 定位；并行 source 加入时不跳屏。
- 每次 active 刷新都把对应键的安全计时器延长至 10 秒；计时器到期后即使没有 inactive 也必须隐藏该键，后续 CUA 工具可重新显示。
- 窗口创建或安全属性配置异常 fail-hidden，仅做一次有界重试。
- locale/theme 更新刷新内容，不重新抢焦点。

### Windows 运行时验证

1. 启动开发版 ZCode，前台打开记事本。
2. 发起包含截图、点击和输入的 CUA turn。
3. 观察提示在首个 CUA 工具开始后出现，连续操作期间不闪烁。
4. 验证目标应用始终保持焦点，提示不可点击。
5. 验证 CUA screenshot 中不包含提示。
6. 分别验证成功、工具失败、Stop、关闭 task、重启 Host 和退出应用后的隐藏行为。
7. 在双显示器上从两个显示器分别开始新 turn，验证定位到当时鼠标所在显示器。
8. 在浅色和深色背景上观察圆角四周阴影，确认没有矩形 DWM 灰带、硬裁剪边或双重阴影。
9. 验证单次 CUA 工具触发后 10 秒自动隐藏，以及 10 秒内后续工具触发会从新的时间点重新计时。
10. 验证 Agent 进程崩溃、协议关闭、请求超时且没有 runtime restart 时，提示最多 10 秒后隐藏且 tracker 不残留。

## 文档与能力图更新

实现时同步更新：

- `docs/product-capability-map-office-computer-use.md`：移除 Windows CUA 仍未解析的旧描述；
- capability graph 中 `surface.computer-use-task-experience`：增加 Windows desktop operation indicator producer/consumer；
- 能力图中的状态链更新为 `CLI runtime lifecycle -> computer-use/operation-event -> desktop-local Host tracker -> cua-operation-state -> Desktop Main overlay`；
- dedicated live control/takeover 仍保持 planned，本次只增加只读状态提示，不宣称已经支持接管。

## 验收标准

- Windows CUA turn 首个真实 Computer Use 工具 started 后，顶部提示可见。
- 每次真实 CUA 工具触发都显示或刷新提示；连续工具不闪烁，最近一次触发 10 秒后自动消失，turn 终态可提前收口。
- 仅使用 v4 conversation、没有旧 `session/event` 订阅时行为一致。
- 普通 Agent/MCP turn 永不显示。
- 提示不抢焦点、不阻挡输入、不进入 CUA 截图。
- 顶部卡片尺寸和位置不变，阴影只由 CSS 绘制且不出现矩形系统阴影或稳定态裁剪。
- 多窗口、多 session 不会提前隐藏或永久残留。
- macOS、Linux、Web、手机 replayable 语义和现有 Helper/PiP 行为不变。
- 定向测试、`pnpm typecheck` 与 `pnpm lint` 全部通过。

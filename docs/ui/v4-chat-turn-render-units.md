# V4 Chat Turn Render Units

## 目标

v4 conversation protocol 仍保持 `ConversationRow[]` 的 flat fact model；UI 不直接把每条 row 当成一条可见消息，而是先派生视觉 turn render unit，再渲染聊天界面。

核心目标是复刻旧 ChatView 的阅读语义：

- user query 在上方，assistant work 在该 user query 下方。
- `turnHeader` 是协议边界和诊断事实，不直接显示为用户可见行。
- assistant 的 reasoning、tool、explore、subagent、compact timeline 和正文都属于同一轮 assistant work。
- 每个初始输入或已成功注入的 guided input 都开启独立 visual work segment；正常完成的 segment 默认折叠为“已工作 N 秒”，当前运行或以 interrupted / failed / error 异常收口的 segment 强制展开。
- 手动 `/compact` 是维护命令，不显示 `/compact` user bubble；只显示 compact timeline / assistant work activity。

## 结构

```text
ConversationSnapshot.rows.window
  |
  | buildConversationTurnRenderUnits(rows)
  v
ConversationTurnRenderUnit[]
  |
  +-- product turn identity / final action target
  +-- workSegments[]
      +-- trigger user input（首段为原始输入，后续为 guided input）
      +-- history status + rows（每段独立折叠）
      +-- assistant text / following rows
  +-- tail boundary rows
```

`ConversationTurnRenderUnit` 是 UI view model，不改变 v4 协议事实，也不参与 command target、snapshot recovery 或 replayable gap 判断。

## `/compact` 可见性

手动 `/compact` 通过 v4 `compact` command 触发。它不属于真实用户 query：

```text
composer "/compact"
  -> command compact
  -> runtime compact turn
  -> compact timeline marker
  -> no visible user bubble
```

runtime / projection 必须提供 `inputVisibility="model-only"` 或等价维护语义，使 projection
不生成 visible `userInput` row。UI view model 禁止嗅探 `userInput.text === "/compact"`；旧历史
缺字段时由 CLI transcript hydration 归一化为 canonical visibility/origin/marker 后再下发。

turn actions 逐行消费 `row.actions`。任何带 action 的 assistant row 都必须渲染 action 入口；
不得用 `lastFlowRow`、turn 内数组位置或“最后一条 assistant”规则再次隐藏 CLI 已授权动作。

## Assistant Work History

每个 product turn 先按 guided `userInput` 拆成 visual work segment，再在各 segment 内按以下规则拆分。该拆分只影响 UI 工作区，不创建新 `turnId` / `productTurnId`：

- `latestAssistantTextRow`：该 turn 最后一条 `assistantText` row，作为最新正文展示。
- `historyRows`：该 turn 中 latest assistant text 之前的 reasoning、toolCall、subagent、compact marker 和较早 assistantText row。
- `tailRows`：该 turn 中 latest assistant text 之后的 boundary rows，例如 fork notice / goal verification。它们属于本轮结尾，但不是 assistant work history，不能被“已工作 N 秒”折叠到正文上方。
- 如果没有 latest assistant text，则所有 assistant rows 都是 history rows，必须展开，避免出现只有“已工作”但没有内容的空 assistant。
- 当前 running segment 必须展开 history；新的 guide 到达后，前一 segment 收口并可独立折叠，新 segment 使用自己的展开状态。
- `completedInterrupted`、`failed`、`error` 异常终态必须强制展开 history，即使已经存在 interrupted / failed assistant partial；异常上下文不能隐藏在“已工作”折叠内。`completedSuccess` 继续遵循正常完成的默认折叠规则。
- 冷恢复发现 transcript assistant message 缺少完成时间时，表示应用或 Agent 在 turn 收口前退出；hydration 必须将该 orphan turn 归一化为 `completedInterrupted`，禁止伪造 `completedSuccess` 后触发正常折叠。
- assistant work history 的状态标签必须区分运行中、正常完成和中断：运行中显示“工作中 N 秒”，正常结束显示“已工作 N 秒”，`completedInterrupted` 的末段只显示“已停止”/`Stopped`，不得附带耗时。guide turn 优先消费 `turnHeader.workSegments` 的权威分段时间；无分段事实的普通/旧 snapshot 才回退到 turn 级 `activeMs`、`endedAt - startedAt` 或运行时 UI 时钟。
- `turnHeader.executionKind` 是是否存在 Agent 工作生命周期的权威事实。`controlOnly` 轮只承载可见控制输入，不产生 work status；字段缺失的旧 snapshot 只在有真实 work row、running 或正工时时兼容派生。
- `lightBoundary`（例如 model change）先从 assistant work rows 分离，再计算 work status；边界行本身不能把 control-only query 推成“工作中/已工作”。

```text
turn
  workSegment(initial)
    userInput(real user)
    historyStatus(running ? "工作中 11 秒" : "已工作 11 秒")
    historyRows(collapsed by default)
    assistantText
  workSegment(guide-1)
    userInput(guided)
    historyStatus(independent)
    assistantText
  tailRows(always after product-turn final assistant text)
```

运行中标签的状态链路：

```text
ConversationSnapshot.rows
  -> buildConversationTurnRenderUnits(rows, nowMs)
  -> split leadingBoundaryRows / assistantWorkRows
  -> unit.workSegments[].workStatus { state, durationMs } | undefined
  -> each segment AssistantHistoryStatus
       state=running   => "工作中 N 秒"
       state=completed => "已工作 N 秒"
       state=interrupted => "已停止"
       undefined       => 不渲染工作状态
```

`/goal` 的可见 query 与真实 continuation 是两个产品 turn，但只有后者执行 Agent：

```text
model A completed
  -> select model B
  -> /goal controlOnly turn
       leadingBoundary(modelChange) + userInput
       no session running / activeWorks / workStatus
  -> goalContinuation agent turn
       session running + one work segment status
```

## 虚拟滚动边界

虚拟滚动单位是 turn render unit，而不是 raw row。原因：

- user query 和它的 assistant work 不能被 `turnHeader` 或工具行拆散。
- explore / agent / subagent 工具内部已经有自己的折叠和聚合语义，虚拟滚动不能进入这些聚合内部。
- history collapsed 状态需要按 turn / assistant work key 记忆，不能按 transient row index 记忆。

## Explore 聚合与 reasoning 可见性

Explore 是 assistant work 的 UI 聚合视图，不改变 `ConversationRow[]` 的原始顺序。聚合边界必须与当前消息流的 reasoning 可见性一致：

- 开启“显示思考过程”时，每条 reasoning 都可见，也是 Explore 的硬边界；reasoning 两侧的只读工具分别聚合。
- 关闭“显示思考过程”时，每轮第一条 reasoning 仍按既有规则显示并保留边界；其余被隐藏的 reasoning 对 Explore 聚合透明，前后连续的只读工具合并为同一个 Explore。
- 透明规则只适用于被 reasoning 开关隐藏的 reasoning row。可见 assistant text、可见 reasoning、非探索工具、subagent、timeline marker 等仍然结束当前 Explore，不能为了扩大聚合而重排原始行序。
- 这是共享 UI view-model 语义，Desktop、Web 与手机远控使用同一结果；不得修改 conversation snapshot、`desktop-continuous` 或 `web-remote-replayable` 的消息边界。

```text
raw rows:       Explore(A) -> reasoning(2) -> Explore(B)
                                  |
showReasoning: on                visible
render items:   Explore(A) -> reasoning(2) -> Explore(B)

showReasoning: off               hidden / transparent
render items:   Explore(A + B)
```

## Reasoning 展开状态

消息流中的 reasoning row 是否显示，由“显示思考过程”设置和每轮首条 reasoning 规则决定；显示出来以后，其内容展开状态遵循统一的低干扰语义：

- streaming 与 complete reasoning 初次出现时都默认收起，只展示“正在思考”或“思考”触发器。
- 用户点击触发器后才展开内容；后续 streaming chunk 和 `streaming -> complete/interrupted` 状态迁移不能覆盖用户的手动展开/收起选择。
- `isStreaming` 仍负责运行态文案和耗时统计，不再隐式等价于 `open=true`。
- 展开状态属于共享 UI 本地交互，不写入 conversation snapshot，也不改变 Desktop continuous 或 Web remote replayable 行序。

```text
reasoning row visible
  -> default closed
  -> user toggles open/closed
  -> streaming state updates preserve the user's choice
```

## 状态面板

v4 聊天右上角恢复旧 ChatView status panel 语义，不使用摘要 pills：

- Git 工具：worktree change summary、branch、commit/push/create branch actions。
- Goal：当前目标状态。
- Todo / Plan：优先使用 v4 `plan.items`；后续如果 v4 snapshot 补 `todoGroups`，再恢复 goal iteration todo。
- Running：`backgroundWorks` 中 running 的 bash/subagent。

状态面板是 UI 派生层，不修改 conversation stream、queue、owner command、desktop continuous 或 mobile replayable 语义。

状态面板形态复用旧 ChatView 的 summary panel 交互，而不是一次性固定展开：

- 面板只有 `panel` / `mini` 两个可渲染形态；`auto` 是用户 override 为空时的解析策略，不是第三种 DOM。
- 不再由 JavaScript 测量聊天容器宽度或自动切换 `panel` / `mini`；无用户 override 时默认解析为 `panel`，宽窄布局后续统一由 CSS 负责。
- 展开态右上角菜单只显示“自动”，用于把 override 置回 `null`；手动 `panel` / `mini` 仍由面板的收起/展开按钮写入，不再显示“始终展开 / 始终收起”菜单选项。
- `mini` 是同一个浮层 shell 的收起态，展示当前最重要的一行摘要：进行中的 todo / goal、running、Git diff、已完成 goal 或 todo progress。只要 goal section 有内容，`active`、`notSatisfied`、`paused`、`verifying` 与 `verified` 都必须保留可点击的 goal 摘要行，不能留下空 shell；标题与展开态共用 `summaryTitle.trim() || objective.trim()`，不能在收起态退化成长 objective 或空文本。
- 展开态顶部保留标题、更多菜单、收起按钮；内部按 Git / Goal / Todo / Running 分区，每个分区可独立折叠。
- 这个 override 属于 workspace shell UI 偏好，沿 `WorkspaceShellLayout -> V4WorkspaceChatArea -> WorkbenchPane -> SessionPane` 传递，不能落进 v4 conversation snapshot。

主聊天区走 `WorkspaceShellLayout -> V4WorkspaceChatArea -> WorkbenchPane -> SessionPane`。`V4WorkspaceChatArea` 必须把 shell 已经持有的 workspace Git summary、dirty file count、worktree change summary、active task change summary、summary panel variant 和 refresh handler 放进 primary pane 的 shell binding；`WorkbenchPane` 再只对 shell workspace pane 透传 workspace 级 Git/status props 给 `SessionPane`，其中 active task change summary 只透传给 primary pane。跨 workspace 的非 primary pane 不能复用当前 shell workspace 的 Git summary，避免分屏里展示错误仓库状态。

Git Tools 只在 worktree `added + removed > 0` 时展示；clean repository 不能仅因为是 Git repository 而挂载 status panel。

## 多端边界

- Desktop `desktop-continuous` 仍使用 direct continuous 主链路。
- Mobile `web-remote-replayable` 仍由 replayable snapshot / gap 恢复，不因为 UI 虚拟滚动拉取全量历史。
- `workspaceIdentity?.trim() || workspacePath` 只用于 workspace 身份隔离；文件展示和命令 cwd 仍使用 `workspacePath`。

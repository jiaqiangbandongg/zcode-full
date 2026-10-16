# 对话轮次 Hook 摘要

> 状态：2026-08-19 产品语义已确认，作为对话底部 Hook 图标、详情浮层与多端投影的事实规格。

## 目标

当某个 product turn 实际执行过用户、工作区或插件 Hook 时，在该轮最下方的 assistant action bar
增加一个 `Anchor` 图标：

- 悬浮或键盘聚焦只显示本地化短提示“钩子” / “Hooks”。
- 点击或键盘激活后打开锚定图标的详情 Popover；手机 Web 通过点击打开。
- 详情只回答“本轮按顺序实际运行了哪些 Hook、各自来自哪里、是否出现异常”。
- 没有实际执行 Hook 时不显示图标，也不留下空 assistant work 容器或空虚拟行。

本功能不改变 Hook 配置、Trust、matcher、执行顺序、输出消费或 task 成败语义。

## 产品边界

### 统计范围

- 图标与详情按权威 `turnId` 聚合，不统计整个 session。
- `UserPromptSubmit`、tool Hook、`Stop` 等均归入触发它们的真实 product turn。
- `SessionStart` 在正常首发时沿 runtime 已携带的 `turnId` 归入首轮。
- 「真实 user-intent turn」指 `user-visible` 的 TurnStarted。维护 turn（manual `/compact` 这类
  controlOnly 命令轮）没有资格承载 SessionStart 摘要：pending 归位与 cold merge 归属都不得
  把它当作收口目标。
- model-only ≠ 维护 turn（2026-08-28 review 修订）：background_task 通知轮、subagent_message
  轮、goal continuation 轮同样是 `inputVisibility="model-only"`，但它们是会真实跑工具的 agent
  轮；其 PreToolUse/PostToolUse/Stop 必须按 `event.turnId` 直挂原轮，live 与 cold merge 归属
  保持一致。维护 turn 排除只作用于 SessionStart 的 pending 归位，不得无差别拦截所有 Hook。
- session 只被打开但没有后续真实 turn 时，不为 resume Hook 单独制造可见时间线内容。

Bug 背景（2026-08-28，HK17）：Runtime 里 `runSessionStartHooks` 先于 `/compact` 输入解析执行，
首条输入即 `/compact` 时 SessionStart Hook 真实执行且事件携带 compact 的 runtime turnId；
投影层 flush 与 cold merge 归属只看「下一条 TurnStarted」，没有排除 model-only 维护 turn，
Hook 摘要被错误挂到 compact marker 轮：

```text
用户首条输入 "/compact"
  Runtime turn()
    ├─ runSessionStartHooks("startup")     ← Hook 真实执行（didExecute=true）
    ├─ parseCompactCommand(input) → compact
    └─ executeManualCompact()
         └─ TurnStarted{ inputVisibility="model-only" }   ← 维护 turn
            ├─ compact lifecycle marker
            └─ TurnComplete

Projection 归位（live / cold 同源约束）
  SessionStart lifecycle → pending
  TurnStarted(compact, model-only)  ─X→ 不得 flush/归属（修复点）
  TurnStarted(next real, visible)   ─→  flush 到该真实 turn
  只有 /compact 且无后续输入        ─→  摘要保持 pending，不制造可见时间线内容
```

- cold recovery 必须先用持久 message 的 `anchor.turnId` 建立 runtime turn → hydration turn 映射，
  再归类 Hook lifecycle；不得把 completed turn 的 Hook 留在 runtime turn orphan 或 pending 集合中。
- 同一 runtime turn 经 queue drain 拆成多个 product turn 时，cold merge 必须按
  `TurnSteerDrained/SessionInputPromoted.messageId` 推进当前 hydration turn，并在首次 Hook lifecycle
  到达时冻结该 invocation 的归属；不得因多个 durable message 共用 runtime anchor 而丢弃映射。

### “实际执行”的定义

- 收到 `HookRunStarted` 的 execution 才属于详情中的“实际执行”。成功、失败、超时、取消和
  Hook 自身执行后主动 block 都保留。
- admission 在进程执行前直接产生的 `HookRunBlocked` 不展示为“运行过”；现有 Workspace Hook
  pending/review UI 继续负责解释未信任或策略阻止。
- internal Hook 缺省 `clientVisible=false`，不进入用户可见摘要。
- 图标只在至少存在一条实际执行的 client-visible execution 时显示。

### 来源

来源保持三类真实语义，不把插件伪装成 User 或 Workspace：

| `sourceKind` | 中文展示 | 英文展示  |
| ------------ | -------- | --------- |
| `user`       | 用户     | User      |
| `project`    | 工作区   | Workspace |
| `plugin`     | 插件     | Plugin    |

`internal` 不展示。

### 可见状态

| Runtime 结果     | UI 状态 |
| ---------------- | ------- |
| started 且未终态 | 运行中  |
| success          | 已完成  |
| executed block   | 已阻止  |
| failed           | 失败    |
| timed_out        | 已超时  |
| cancelled        | 已取消  |

Hook 失败不自动展开 Popover、不弹全局 Toast，也不直接把 task 标成失败。
- 已实际执行的 `UserPromptSubmit` Hook 若阻断当前输入，则将脱敏后的阻断原因同步到
  `snapshot.control.lastError`，由聊天区的 `ChatErrorBanner` 展示；这只是当前输入的错误提示，
  不把成功完成的 turn 改成 `phase=error`，下一次 `TurnStarted` 会清除该提示。准入阶段尚未执行的
  Hook 阻断，以及 `PreToolUse`/`PermissionRequest` 等工具边界阻断，仍只在 Hook 详情中展示，避免
  将工具级权限裁决误报成聊天输入错误。

### UserPromptSubmit 阻断的 Chat Error

```text
HookRunner
  -> HookRunStarted
  -> HookRunBlocked(blockReason, stderrPreview/errorMessage)
  -> ProductProjection
       ├─ HookInvocationRow.executions[].blockReason
       └─ control.lastError(fault.runtime.hookBlocked)
  -> ChatErrorBanner（composer 上方）
```

- 只有同一 `hookRunId` 已收到 `HookRunStarted` 且事件为 `UserPromptSubmit` 时，才写入
  `control.lastError`；admission-only blocked 不满足“实际执行”条件。
- `lastError.message` 以稳定的错误类型 `hooks_prompt_block` 开头；存在已经脱敏的
  `stderrPreview` / `errorMessage` / `stdoutPreview` 时，摘要格式为
  `hooks_prompt_block: <diagnostic>`，没有诊断时则只显示错误类型。`recoverable=false`，不显示重试入口。
  `lastError.detail` 始终保留通用 `blockReason`，并在有诊断时追加完整 Hook 错误；Chat Error 的
  “查看详情”按钮打开该内容，横幅左侧使用 Hooks 图标。`traceId` 保留用于复制错误和反馈。
- `TurnComplete(resultType="success")` 仍是 Hook 阻断后的 turn 终态，`phase` 和任务成功语义不变；
  `TurnStarted` 清除旧 `lastError`，避免旧轮原因覆盖下一轮输入。

## UI 规格

### Action bar

```text
[复制] [赞] [踩] [Fork] [Anchor]
                           │ hover/focus -> Tooltip“钩子”
                           └ click/Enter/Space -> details Popover
```

- 图标复用 Hooks 设置入口的 `Anchor`，大小跟随既有 message action icon（`size-3.5`）。
- Desktop action bar 延续既有整轮 hover/focus 显示；手机远控 action bar 常显。
- “不常驻”指数据门禁而不是新增隐藏状态：只有本轮至少一条 client-visible execution
  满足 `didExecute=true` 时才渲染 Hook 图标；本轮没有实际运行 Hook 时 DOM 中完全没有该入口。
- Hook action 属于 turn-local artifact，位于正文、预览、定时任务卡片、文件 summary 和浏览器轮尾图之后，
  但位于连续 `turnTailBoundary` 之前。
- assistant 正文存在时继续显示 copy/feedback/fork/time；没有正文、被中断或 error 的终态轮次，只要
  实际执行过 Hook，也允许单独显示 Hook action。
- 同一轮最多渲染一个 Hook 入口：普通 assistant action bar 与独立 Hook action bar 必须互斥。
  Highspeed 来源页脚独立渲染，既不得让有正文的轮次重复显示 Hook，也不得遮掉无正文终态轮的 Hook 入口。
- Hook action 与 copy/feedback/fork/retry 共用同一 turn eligibility：`timelineOnly` 维护 turn
  （纯 compact/modelChange marker 轮）即使带有历史遗留的 `didExecute=true` Hook row，也不得
  渲染 Hook action 或空操作栏；无正文终态轮（HK11）的豁免只覆盖真实 product turn。
- Tooltip 与 Popover 不能同时可见；Popover 打开时关闭 Tooltip。

### 详情 Popover

```text
┌─ 钩子 ──────────────────────────┐
│ SessionStart           用户   12ms │
│ SessionStart           用户   18ms │
│ UserPromptSubmit       用户    7ms │
│ PreToolUse           工作区   24ms │
│ PreToolUse           工作区  1.25s │
│ PostToolUseFailure 工作区 8ms 失败│
└─────────────────────────────────┘
```

- 使用 `bg-popover + border-popover-border + rounded-xl + shadow-md`。
- Desktop 使用紧凑固定宽度；手机宽度不超过 `calc(100vw - 2rem)`。
- 标题区使用 8px 垂直 padding，列表外层只保留 2px 上下留白，每条 Hook 使用 6px 垂直 padding；
  event 与来源之间保持 8px 间距，在不缩小字号的前提下提高长列表可扫描密度。
- Popover 外壳最大高度同时受 `20rem` 与 Radix
  `--radix-popover-content-available-height` 约束；超出后只允许内部列表滚动，外壳的
  `top/right/bottom/left` 均不得越过 viewport collision padding。
- invocation 按 CLI row 顺序进入 Renderer 派生；同一 invocation 内按 `hookIndex` 顺序逐条列出
  `didExecute=true` 的 execution。相同 Hook 不聚合、不去重，重复出现是权威执行顺序的直接表达。
- 每行只显示 Hook event 与来源；`project` 的产品文案统一为“工作区” / “Workspace”。
- 不显示 `displayName`、runtime executable、脚本文件名、tool 名或执行次数。即使没有显式 Hook 名称，
  也不得从命令或文件名推导一条用户可见名称。
- 终态 execution 在来源之后显示弱化耗时；小于 1 秒显示整数 `Nms`，1 秒及以上显示秒数，
  10 秒内保留两位小数、其余保留一位。运行中不显示未完成耗时。
- 成功终态不显示重复的绿色图标或“已完成”；只有运行中、失败、超时、取消和 executed block
  显示状态文本/语义图标，不能只依赖颜色表达异常。异常状态位于耗时之后。
- executed block 在状态图标右侧直接显示经过脱敏的阻断原因；原因缺失时显示通用的
  `Hook blocked execution`；Action bar 里的 Hooks 图标右侧同步显示首个阻断原因，不能要求用户
  悬浮或打开 tooltip 才能判断为何被阻断。
- 标题只显示“钩子” / “Hooks”，不再显示“共 N 个钩子执行”副标题。
- 第一版不展示 runtime、脚本文件名、tool 名、次数、完整命令、绝对路径、stdin、tool input、环境变量、
  stdout/stderr 或 stack；线上的 client-safe row 仍不得传输完整命令及其它敏感原始字段。

Popover 是只读详情，不提供重跑、Trust、编辑配置或跳转设置入口。

## 状态与同步链路

```text
HookRunner
  -> HookRunStarted / HookRunCompleted / HookRunFailed / HookRunBlocked
  -> CLI session event log（唯一持久事实源）
  -> ProductProjection
       - hookInvocationId 聚合 invocation
       - hookRunId 聚合 execution
       - 权威 turnId / pending resume SessionStart 归位
       - 生成 client-safe HookInvocationRow
       - UserPromptSubmit executed block 同步生成 transient control.lastError
  -> connection-owned delivery
       desktop-continuous     -> direct continuous delta/snapshot
       web-remote-replayable  -> replayable delta/gap/snapshot
  -> Renderer ConversationProjectionStore（无 Hook 专用 store）
  -> ConversationTurnRenderUnit.hookInvocations
  -> terminal turn action + details Popover
```

冷恢复的身份转换固定为：

```text
durable message anchor.turnId (runtime)
              │ transcript message identity
              ▼
       hydrate-turn-* event turn
              │ ProductProjection TurnStarted mapping
              ▼
       stable product turn (messageId)
              ▲
              │ Hook lifecycle 在 cold merge 中先改写到 hydrate turn
runtime Hook turnId
```

这条转换只作用于 cold/replayable 物化；desktop continuous 继续使用原 live 事件顺序和 runtime → product
映射，不拼接 cold 事件。

共享安全摘要只包含展示身份、来源、event/tool、状态、脱敏后的阻断原因和权威耗时。desktop 与 mobile 的业务事实相同；
两端只在 continuous/replayable 的交付与恢复方式上不同。relay、desktop main、Host owner/lease 不新增
Hook session 状态，也不建立第二份缓存或队列。

## 协议投影

`HookInvocationRow` 是 turn-local 的只读 product row。execution 至少包含：

```ts
interface HookExecutionProjection {
  hookRunId: string;
  hookIndex: number;
  didExecute: boolean;
  state: "running" | "completed" | "failed";
  outcome?: "success" | "blocked" | "failed" | "cancelled" | "timed_out";
  blockReason?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  displayName: string;
  sourceKind: "user" | "plugin" | "project";
  pluginName?: string;
  toolName?: string;
}
```

约束：

- `didExecute=true` 只能由同一 `hookRunId` 已观察到 `HookRunStarted` 得出。
- terminal-only `HookRunCompleted/HookRunFailed` 仍可用于安全收口 row，但不得反推
  `didExecute=true`，也不得让该 execution 触发 Anchor 或进入详情。
- admission-only blocked execution 可以用于 invocation 完整收口，但 Renderer 不计入详情和图标数量。
- row 不携带 `HookExecutionDescriptor.commandDisplay/sourcePath` 或原始 error/output 字段。
- async terminal upsert 可以在 turn 完成后到达，但不得把已终态 turn 重新推成 running。
- CLI restart 后 started-only execution 收口为 `failed/cancelled`；普通 task 切换不得误判取消。
- edit/retry/rewind 删除分支时，同 turn 的 Hook row 随权威 `row.removed` 一起删除。

## 多端边界

```text
one CLI projection
      ├─ connection A / desktop-continuous
      └─ connection B / web-remote-replayable

B gap/resync/snapshot  -X->  A continuous cursor
A direct live stream   -X->  B 绕过 replayable recovery
```

- 手机继续 attach 到桌面窗口已有 shared Host/runtime，不另起 Agent、Host 或远程 session。
- Hook summary 不携带 workspace 路径，因此不新增 `workspaceIdentity` key；订阅和 task/session 隔离继续
  复用现有 attachment 的 `workspaceIdentity?.trim() || workspacePath` 与 `remoteSessionId`。
- replayable snapshot 与 rows/range 必须恢复相同 Hook summary；不能只支持 live delta。

## 用例与剪枝

| Case | Setup                                                                                                                                 | Action                                                            | Assertion                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HK08 | completed turn 实际执行 user/project/plugin Hook                                                                                      | hover，再点击 Anchor                                              | hover 只有“钩子”；点击按权威顺序逐条显示 event、来源与终态耗时，重复 Hook 不合并；不显示 runtime、脚本文件名、tool 名或次数；位置在 turn boundary 前         |
| HK09 | 同一 invocation 同时含 admission-only blocked、terminal-only 与实际 started execution                                                 | turn 完成                                                         | 详情只计实际 started execution；全部 admission/terminal-only 时不显示图标                                                                                    |
| HK10 | completed history 的 Hook 带 runtime turnId；同 runtime 经 queue drain 拆多 product turn；或 resume `SessionStart` 无 product mapping | cold reopen；或打开历史后发送下一条真实 prompt                    | Hook 按 message boundary 归入对应 hydration/product footer，无 orphan runtime turn、`session-hooks:*` synthetic turn 或空容器                                |
| HK11 | interrupted/error/无 assistant text 的终态 turn 实际执行 Hook                                                                         | turn 收口                                                         | 仍显示 Hook action；assistant 专属 copy/feedback/fork 不被伪造                                                                                               |
| HK12 | desktop live 与 mobile replayable snapshot/gap                                                                                        | 打开同一 turn 详情                                                | 安全摘要终态一致；payload 不含 command/path/stdin/stdout/stderr/tool input                                                                                   |
| HK13 | async Hook 在 turn 完成后终态                                                                                                         | Popover 打开或关闭时收到 upsert                                   | 同一 execution 原位更新；turn 不重新 running，组件身份不重置                                                                                                 |
| HK14 | 含 Hook 的历史分支被 edit/retry/rewind 截断                                                                                           | 应用 `row.removed`                                                | Hook action 与详情随目标 turn 一起消失，不追加到历史末尾                                                                                                     |
| HK15 | 15 个 actual execution 的 Hook footer 靠近 sticky composer / viewport 底部                                                            | 将真实 Anchor 滚入可视区并通过 WebDriver 点击，再滚动内部列表到底 | Popover 完整位于可用 viewport 内；`ul.scrollHeight > clientHeight` 且自身 `overflow-y:auto`，DOM 末项滚动后可见并与权威顺序末项一致                          |
| HK17 | 首条输入即 `/compact`，workspace 配置 client-visible SessionStart Hook；随后发送一条真实 prompt                                       | 观察 compact marker 轮与下一条真实 turn                           | compact 维护 turn 不渲染 Hook Anchor；SessionStart 摘要归位到下一条真实 turn 的 footer；只有 `/compact` 无后续输入时摘要保持 pending，不出现 orphan Hook row |

明确剪枝：

- 不与七个 Hook event 做完整笛卡尔积；用 prompt、tool、stop/session 三类落位代表。
- theme/locale 由共享组件和 i18n 单测覆盖，不复制 runtime 状态机 E2E。
- local/SSH/WSL/Docker 共用 desktop continuous 投影；SSH 只作为 workspace 隔离代表，不复制四套 UI case。
- mobile 只验证 replayable 恢复与点击交互，不复制 Desktop hover case。
- Trust 状态、matcher、process/command、sync/async 执行效果继续由 Hooks runtime/Trust 专项用例覆盖。

## 验证

- contracts/shared：strict schema 拒绝敏感字段，continuous/replayable 均保留安全 summary。
- bootstrap：live/cold、resume SessionStart 归位、admission-only blocked、async terminal、rewind、
  维护 turn（model-only TurnStarted）不承载 SessionStart 摘要（HK17）。
- UI：turn render unit 抽取、无空 work、Tooltip/Popover、来源/状态/i18n、无正文终态、手机宽度、
  timelineOnly 维护 turn 不渲染 Hook action（HK17）。
- E2E：复用正式 Hooks lifecycle fixture，断言 Anchor、Tooltip、点击详情以及至少一条 Hook 来源。
- 视觉 E2E 必须先把真实 Anchor 滚入 viewport，再使用 WebDriver pointer/click；禁止用
  `HTMLElement.click()` 打开不可见触发器后把截图当作布局通过证据。打开后同时断言 Popover rect 位于
  viewport 内、列表确定溢出且滚动容器是内部 `ul`；滚到底后必须验证末项可见。
- 机械门禁：`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`。

## 实施结果（2026-08-19）

- 2026-08-28 HK17 修复：Runtime 里 `runSessionStartHooks` 先于 `/compact` 输入解析执行，首条
  输入即 `/compact` 时 SessionStart Hook 真实执行且事件携带 compact turnId；live flush、cold
  merge 归属与 UI action eligibility 三层此前都只看「下一条 TurnStarted / turn 结束 +
  didExecute」，没有排除 model-only 维护 turn，Hook 图标错误出现在 compact marker 轮。修复：
  ProductProjection 跟踪 `currentTurnStartedModelOnly`，flush 与直挂路径都以 user-visible
  真实 turn 为唯一收口目标；cold `hookInvocationTurnIds` 跳过 model-only TurnStarted；UI
  `hasHookActions` 与 copy/feedback/fork 共用 `!timelineOnly` eligibility。回归证据：
  bootstrap `product-projection.test.ts` HK17×2、`cold-event-merge.test.ts` HK17×1、UI
  `v4ConversationTurnGroup.test.ts` HK17×1；E2E `conversation-session-hooks-lifecycle.test.ts`
  新增 HK17 case（首条输入即 /compact）。
- 2026-08-28 review 回归修复：首版直挂 gate 无差别拦截了所有 model-only turn 的 Hook，导致
  background_task / subagent_message / goal continuation 这三类 model-only 真实 agent 轮的工具
  Hook（PreToolUse 等）被 pending 吞掉、错误 flush 到下一个用户轮，live 与 cold 归属分叉。
  收窄：直挂 gate 的维护 turn 条款只对 `SessionStart` 生效；工具 Hook 恢复按 `event.turnId`
  直挂原轮。回归证据：`product-projection.test.ts` "HK17 keeps tool Hooks of a model-only real
  agent turn attached to that turn"（PreToolUse 留在 turn-bg，不迁 turn-user）。
- 2026-08-28 SG-01 补测：model-only turn 异常终态（TurnError 非 controlOnly 路径不清侧表、
  TurnComplete cancelled 清侧表）两条收口路径行为等价——pending SessionStart 不泄漏到异常
  turn、终态后新到的 SessionStart 不直挂死 turn、下一条真实用户 turn 同时收口 startup 与
  resume 两条 pending 摘要。回归证据：`product-projection.test.ts` "HK17 keeps a pending
  SessionStart summary off an abnormally terminated model-only turn"（it.each ×2）。
- 已登记未修的防御缺口（非本次引入，暂不阻塞）：UI `shouldKeepRenderUnit` 仍会为 hook-only
  空 unit 保留整个 section（pt-14 幽灵空白），修复后正常投影难触发；pending SessionStart 在
  runtime resume 时被 `onSessionResumed` 静默清空（epoch 切换语义，新 epoch 会重新产生
  resume SessionStart）。
- 2026-08-24 review 修复：terminal-only completed/failed 不再反推“实际执行”；cold merge 在同一
  runtime turn 经 queue drain 切分多个 product turn 时，按持久 message boundary 冻结 Hook invocation
  归属。HK15 正式 Electron 独立 replay 1/1 通过，15 条 execution 已证明内部 `ul` 确实溢出、
  `overflow-y:auto`，滚到底后权威末项可见；artifact：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260823-165442-024`。相邻 HK-EF-01 独立复验 1/1
  通过，artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260823-170301-439`。
- 2026-08-21 Popover 密度微调：保持 `w-80`、字号与信息层级不变，标题/列表/行垂直 padding
  分别收紧到 8px/2px/6px；正式 Electron replay 4/4 通过，artifact：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260821-030515-480`，截图：
  `/private/tmp/zcode-hook-turn-summary-compact.png`。
- 2026-08-21 逐条耗时已加入来源之后：运行中保持空缺，终态显示紧凑 `Nms` / `N.NNs`；
  定向 UI tests 5/5、正式 Electron replay 4/4 通过，artifact：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260821-032205-891`，截图：
  `/private/tmp/zcode-hook-turn-summary-duration.png`。
- client-safe Hook row、startup/resume SessionStart product-turn 归位、cold merge、continuous/replayable
  delivery 已实现。
- Renderer 使用 `ConversationTurnRenderUnit.hookInvocations` 独立承载摘要，不进入 assistant work、
  “已工作”折叠或 ChatLoading 判定。
- Tooltip 与点击 Popover、中英文来源/状态、无正文终态、纯 admission blocked、async terminal open-state
  保持均有 focused test。
- bootstrap 定向测试 3 files / 211 tests 通过；shared/UI 定向测试 4 files / 94 tests 通过。
- 正式 Desktop Hooks lifecycle replay 4/4 通过：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260819-141042-191`。
- 2026-08-20 反馈确认：此前深色主题截图由测试直接点击 viewport 外 DOM 触发器，且 Popover 高度只按
  `100dvh` 计算，面板越过可用界面；该截图不再算视觉验收通过。HK15 完成并留下真实可见点击证据后再回填结果。
- 2026-08-20 边界修正版已确认：详情回到 event + 来源 + 异常状态的最小集合；重复 execution 按顺序
  逐条显示，不再聚合为 `×N`，也不再显示 runtime、脚本文件名、tool 名或命令衍生名称。
- 2026-08-20 cold recovery review 修复：旧 merge 直接比较 runtime turnId 与 `hydrate-turn-*`，
  导致 completed Hook 形成 orphan row、SessionStart 残留 pending。现在通过持久 message anchor 做
  runtime → hydration 映射后再进入 ProductProjection；cold/replay focused tests 117/117、Hook projection
  定向 tests 17/17 通过。
- 2026-08-20 逐条版正式 Electron replay 4/4 通过，artifact：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260820-055755-608`；视觉抽样 1/1 通过，artifact：
  `desktop-e2e-20260820-055915-282`，本地截图：`/private/tmp/zcode-hook-turn-summary-v3.png`。
  1200×800 viewport 中 Popover bounds 为 `left=450.0, right=769.7, top=55.9, bottom=375.6`。
- 2026-08-20 旧聚合版复验记录：正式 Electron E2E 先将 Anchor 滚入 viewport、hover 后使用 WebDriver
  click；1200×800 viewport 中 Popover bounds 为 `left=450, right=770, top=55.5, bottom=375.5`。
  当时同类 Hook 聚合、成功态状态/耗时已移除，full-chain 4/4 通过，artifact：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260820-050537-413`；可见路径截图抽样 run：
  `desktop-e2e-20260820-050654-995`。该 artifact 只继续证明 Popover 视口边界，不作为当前逐条信息布局的视觉证据。

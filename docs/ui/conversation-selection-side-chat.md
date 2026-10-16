# Conversation Selection Side Chat

## Feature summary

桌面 Electron 与桌面 Web 的主会话时间线支持框选单行文字，并提供两个动作：

1. **添加到当前任务**：把选区作为结构化引用 chip 追加到主 composer。
2. **在辅助对话中提问**：优先把选区追加到当前激活的
   `selection_side_chat` child tab；当前未激活辅助对话时创建一个新的 hidden child，
   并在右侧 Side Pane 中继续多轮对话。

右侧 Side Pane 的空面板启动页和顶部 `+` 菜单同时提供 **辅助对话** 入口。入口与框选动作
共享主 `SessionPane` 的创建能力，但固定入口每次都创建并激活一个新的辅助对话 tab。
同一父 session 可以同时保留多个 child、composer 草稿和阻塞交互。

主 composer 的 `/` 面板额外提供 App 层命令 **`/side`** 及其等价别名 **`/btw`**（适配不同
用户习惯，面板中各自独立展示）。裸命令从面板选中时新建并激活一个空辅助对话 tab，同时把
输入中的命令 token 移除，不发送消息；直接提交 `/side <文字>` 或 `/btw <文字>` 时，命令后的
文字作为新 child 的首条普通消息立即发送。参数只支持文字：存在文件附件、代码评论、网页/PPTX
元素或划词引用时不消费为 App 命令，继续走主会话原有发送逻辑。两个命令由渲染层在 CLI slash
catalog 之外包装注入，不修改 CLI 命令目录；若 CLI 返回同名命令，以 CLI 为准隐藏并不消费 App
命令。草稿态（尚未创建 session）、辅助对话自身 composer、只读与手机 viewport 均不提供这两个命令。

手机端不注册框选入口；“更多详情”不属于本功能。副屏用于解释和轻量探索，允许正常工具、
文件修改与权限交互，但不提供 goal、edit/retry 或 fork。

## Clarification log

| Boundary            | Decision                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| child 基准          | 由父 session 最新稳定落盘边界派生；父 turn 正在生成时保留已提交 user input，排除未完成 assistant/tool 增量                                                                                                                                                                                                        |
| 框选历史行          | 只影响引用内容，不改变 child 的 fork 基准                                                                                                                                                                                                                                                                         |
| 生命周期            | 主任务推进、切换任务、长时间未使用均不自动过期；不实现 TTL/数量回收和过期卡                                                                                                                                                                                                                                       |
| 关闭                | 关闭 tab、关闭其他/全部、父任务删除/归档、窗口退出均关闭 live runtime 并移除 tab                                                                                                                                                                                                                                  |
| 重启                | 不恢复 tab、草稿或 parent-child UI 绑定；隐藏 child 历史可继续留在 SQLite                                                                                                                                                                                                                                         |
| 缺失 child          | `proto.sessionNotFound` 直接移除 tab；本次框选动作可重新创建一次，不显示失效页                                                                                                                                                                                                                                    |
| blocked             | 主 session composer 被 Permission/AskUserQuestion/ExitPlanMode 隐藏时不显示浮层；副屏 blocked 时仍允许“添加到当前任务”，副屏动作禁用                                                                                                                                                                              |
| 能力限制            | 副屏正常发送、compact、工具和权限交互；协议与 UI 同时禁止 goal、edit/retry、fork                                                                                                                                                                                                                                  |
| assistant 选区      | completed 与 streaming assistant 正文、Markdown 和代码均允许框选；动作发生时冻结选中文字，后续 delta 不改写引用                                                                                                                                                                                                   |
| 发送载荷            | 新发送使用 `# userselect:` / `userselect` 结构块，数组元素只保留 `{ text }`；来源字段仅用于发送前去重，旧完整结构块继续只读兼容                                                                                                                                                                                   |
| 固定入口            | 空面板启动页与顶部 `+` 菜单均提供“辅助对话”；每次点击新建 tab；主任务 running/blocked 时仍可用，无 active task 与手机端隐藏                                                                                                                                                                                       |
| `/side` `/btw` 命令 | App 层斜杠命令与等价别名，渲染层在 CLI catalog 之外注入，不改 CLI（CLI 同名时以 CLI 为准）；裸命令选中即新建空辅助 tab 并移除 token，带文字参数时提交 child 首条消息；附件/结构化上下文不消费；草稿态、辅助对话自身、只读、手机不提供；描述文案随 locale 中英文适配，搜索关键词同时匹配 `side`/`btw` 与“辅助对话” |
| 多开路由            | 同一父任务可同时打开多个辅助对话；划词追加到当前激活的辅助 tab，当前激活项不是辅助对话时新建并激活                                                                                                                                                                                                                |
| 历史可见性          | 父历史继续作为 provider context，但 child timeline、搜索、分页、轮次导航和可见 row count 均从空白开始                                                                                                                                                                                                             |
| Goal 父任务         | `active`、`paused`/`budget_limited`、`complete` 均允许创建；child 复制正文时移除 `anchor.goalBoundary`，不复制 session target、verifier entries、queue 或 active work                                                                                                                                             |
| 视觉密度            | 框选浮层使用约 32px 高、12px 字号、紧凑 padding、`rounded-lg` 与 `shadow-md`；用户文案统一为“辅助对话”                                                                                                                                                                                                            |
| fork 切换           | 父任务已有辅助对话时 fork 到 child，只隐藏父绑定 tab；child 展开 Side Pane 显示启动页，切回父任务恢复原 tab、child 与草稿                                                                                                                                                                                         |

## State and ownership

```text
主时间线合法选区
    |
    +-- 添加到当前任务 ----> 主 composer 引用 chip
    |
    +-- 副屏动作
           |
           v
查找当前 Side Pane activeTabId
           |
           +-- 当前父任务的 live 辅助 tab ---> 校验 child、激活 tab、追加去重引用
           |
           +-- 非辅助 tab / 无 active tab ---> 创建隐藏 child、打开新 tab、追加引用
           |
           +-- 同一创建手势仍 pending ------> 合并 pending promise，避免双击重复创建

Side Pane 启动页 / 顶部 + 菜单 / 主 composer `/side`、`/btw`
    |
    +-- 无 active task / 草稿态 / 手机 --> 不显示“辅助对话”入口，`/` 面板无 `/side`、`/btw`
    |
    +-- 有 active task（含 running/blocked）
           |
           +-- 裸命令点击 / 选中 --------> 创建隐藏 child、打开新 tab、聚焦空 composer
           |                             （移除输入中的命令 token）
           +-- 带文字参数提交 ----------> 创建并注册 child，首条文字在 child startNow 发送，打开新 tab
           |                             （父任务 queue/guide 不变）

主任务推进 / 切换任务 / 长时间未使用
    ---> 不改变 child 生命周期

关闭 tab / 父任务删除归档 / sessionNotFound / 应用退出
    ---> 关闭 live runtime ---> 移除 tab
```

| State / fact                       | Authority                            | Renderer state                                 | Persistence                    |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------- | ------------------------------ |
| child conversation 与工具/权限状态 | CLI runtime/session store            | V4 projection                                  | SQLite hidden child            |
| 当前窗口 parent → children/active  | renderer Side Pane registry          | tab 按 child 唯一，`activeTabId` 决定划词目标  | 不持久化                       |
| composer 草稿与待发送引用          | 对应 composer                        | session/tab scoped state                       | 不持久化                       |
| 已发送引用 chip                    | CLI session user message             | `# userselect:` 文本数组                       | 随 user message 持久化         |
| workspace 隔离                     | session workspace ref                | `workspaceIdentity?.trim() \|\| workspacePath` | tab key 与 command route       |
| live 列表可见性                    | CLI sessions-index/task-index filter | task list cache                                | root query 排除 parented child |

## Start 同模型推荐

`/side <text>` / `/btw <text>` 创建并提交首条消息前，使用父 session snapshot 已生效的 provider/model/thought 判断同模型 Start 推荐；不读取父 Composer 尚未提交的模型草稿。缺少完整可验证的继承选择时，继续原有 Host 继承行为并跳过推荐。

确认切换将完整 `firstInput.modelSelection` 随唯一 `createSelectionSideSession` 命令传入，Host 用它创建 child 并启动首条输入；“不了”省略该字段，保持原继承；关闭弹窗不发命令、不创建 child，保留原输入。裸命令与空副屏入口不推荐。原 ACK admission、去重及 continuous/replayable 边界不变。

## Selection and reference contract

- 监听范围归属 `SessionPane/ConversationTimeline`，不依赖 input DOM，也不监听 Side Pane。
- 支持鼠标和键盘产生的单 row 选区。可选内容为用户/助手正文、代码、推理和工具结果。
  assistant 的 selectable region 必须落在真实 DOM 容器上，不能依赖不会透传 `data-*` 的 Markdown
  组件 props；completed 与 streaming assistant 均适用。
- streaming assistant 引用在用户点击动作时按当前 `Selection.toString()` 冻结，之后的模型 delta
  不回写已创建的 `ConversationSelectionReference`。
- 选区端点落在控件、菜单、状态标签或阻塞弹窗中时不产生入口；同一 selectable region 内从
  普通 Markdown 跨选到表格单元格时，DOM 顺序中夹着的 `select-none` 表格工具栏不算控件选区，
  仍产生入口。跨 row、纯空白和已经卸载的虚拟行不产生入口。
- 滚动、Esc、选区折叠、切任务和进入主会话阻塞态关闭浮层。
- `ConversationSelectionReference` 包含 `id`、`sourceSessionId`、`sourceRowId`、
  `contentType` 与原始 `text`。去重键包含全部来源字段和文本；不同 row 的相同文字不是重复。
- 单条最多 8,000 字符、每个 composer 最多 8 条、总计最多 16,000 字符。超限原子拒绝并
  显示本地化提示，不截断、不清除已有引用或草稿。
- 发送前的 composer reference 继续保留完整来源字段，用于精确去重、限制与待发送 hover；发送时只把
  `{ text }` 数组追加到 `# userselect:`、语言标签为 `userselect` 的结构块，避免把 session、row、content type
  和内部 id 暴露给模型。timeline 解析后仅显示正文与引用 chips，已发送 chip 的 hover 只展示已持久化
  的选中文字。
- 旧 `# Conversation selections:`、语言标签为 `zcode-conversation-selections` 的完整结构块继续只读解析，保证
  既有历史 chip 可见；新消息不再写旧格式，也不迁移已落盘消息。与 Web element context 同时存在时，
  先解析末尾 Web element block，再解析 selection block。

新发送格式：

````text
# userselect:
```userselect
[{"text":"云计算"}]
```
````

## Protocol and runtime contract

- V4 新增非 CAS 命令 `createSelectionSideSession`。父 session 由 command envelope 的
  `sessionId` 指定，payload 为 `{}` 或 `{ firstInput: { text } }`；带 `firstInput` 时由 child
  复用首发 `sendText` admission/startNow 路径。ACK result 为
  `{ type: "createSelectionSideSession", sessionId, input? }`，同一 commandId 重试不得重复创建或发送。
- 服务端从父 record 派生完整 workspace ref、remote identity、model、thought、mode、
  followup mode 与权限规则；UI 不传 workspace identity 拼装字段。
- child task type 为 `selection_side_chat`，带 `parentSessionId`。不复制 goal、queue、后台任务、
  continuation inbox 或 pending interaction。
- 复制的父历史逐条标记 `model-only`、`uiVisibility=hidden`、`providerVisibility=visible`；live 和
  cold hydration 必须使用同一 projection policy。隐藏历史不进入 child 可见 rows、total count、
  load-older、conversation find 或 turn navigator。
- copied history 之后写入 model-only boundary：继承历史只作参考，不继续父任务；仅处理副屏中新
  问题；修改工作区必须由用户在副屏明确请求。
- boundary 作为 persisted `selection_side_chat` reminder 注册，channel 为 `history_continuity`、
  lifecycle 为 `resume_history`。原子 fork bundle 中保存 raw text 和 source-aware part metadata；
  child 首次挂载和后续恢复均 hydrate 成 Runtime Attachment。该 source 明确跳过 MCS，始终由
  共享投影器在 child 新问题之前输出 user `<system-reminder>`，对齐 `/btw` 的提醒位置；
  其他 source 的 MCS 投影保持原有规则。
  不在落盘正文预包标签，不每轮追加重复提醒，不迁移旧的缺少 part metadata 的 side chat。
- `sendGoalCommand`、`resumeGoal`、`editUserQuery`、`retryTurn`、`forkAssistant` 对该 kind
  返回 `guard.selectionSideChatRestrictedCommand`。
- live sessions-index、task-index、项目/对话/分组/置顶/归档列表过滤该 kind；直接订阅 child
  conversation topic 仍正常工作。

## 首轮 reminder E2E 回归（SSC33）

正式用例 `conversation-session-side-chat-reminder.test.ts` 在同一次 default replay 中运行
MCS/non-MCS 两个独立场景。父会话完成一次只读工具调用后，通过裸 `/btw` 打开空 child，
等待 child 输入框可编辑后，发送一条要求固定回复的普通问题，并等待该回复完成。

- non-MCS 使用默认 `deepseek-v4-flash` 与本地 replay endpoint。
- MCS 通过设置页添加并选择 `claude-opus-4-8`，触发生产模型能力判定；请求仍交给本地 replay。
- 两个场景均断言：fork boundary 的 source-aware part metadata 保留；继承历史不显示在 child
  timeline，但进入 provider context；提醒正文恰好出现一次，以 user `<system-reminder>` 位于
  新问题前；父会话消息不被 child 输入改写。
- 独立检查请求中其他 `role: system` 消息：MCS 场景存在，non-MCS 场景不存在，避免把整体
  关闭 MCS 误判为 side-chat source 正确排除。响应由 case-local synthetic fixture 固定，
  不将响应内容作为模型身份感知证据。core 单测另从实际 fork bundle JSON 往返验证恢复。

```text
fork: inherited history -> selection_side_chat Attachment -> child question
wire (MCS / non-MCS): user [<system-reminder>boundary</system-reminder>, question]
```

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/conversation-session-side-chat-reminder.test.ts'
```

正式回归仅保留 UI、持久化和 provider 请求断言；运行报告与网络证据由共享 E2E runner
统一采集，不在用例中额外写全量 session dump、复制 model-io 或保存重复截图。

## Side Pane and lifecycle

- 每个窗口、每个 `(workspaceKey, parentSessionId)` 可以同时存在多个 live child；不要求跨窗口同步
  tab 列表或 active 目标。
- stable tab key 使用 `workspaceKey + parentSessionId + childSessionId`。固定入口每次完成点击都创建
  新 child；同一点击在命令 pending 期间合并，失败不留下空 tab。
- 同父辅助 tab 以本地化“辅助对话 N”命名；`N` 从当前父任务已使用的正整数中取最小可用值，
  关闭后允许复用编号，tab identity 始终以 childSessionId 为准。
- 新引用保留目标 child 的问题草稿；完全重复只激活目标 tab，不新增 chip。兄弟 child 的草稿、
  引用和 blocked 状态不受影响。
- Side Pane 收起或显示其他 tab 时，展开并激活目标 tab，保留其他 tab。
- 空面板启动页与顶部 `+` 菜单共享同一个“辅助对话”item resolver；入口只在 desktop
  Electron/desktop Web 且存在 active parent session 时出现。
- 固定入口不受父 session running、Permission、AskUserQuestion 或 ExitPlanMode 阻塞影响；它不追加
  引用，并始终新建空 child。已有 child（包括自身 blocked）继续保留，用户可通过 tab 切换处理。
- 切换主任务只隐藏不关闭；切回父任务恢复原 live session、草稿和引用。
- Side Pane 是否显示 tab strip 必须以当前任务过滤后的可见 tab 集为准。workspace registry 即使仍保存
  其他任务的隐藏 tab，当前任务可见集合为空时也显示“打开标签页”启动页，不能渲染空 tab shell。
- 所有关闭路径调用 child `deleteSession`/close lifecycle；不进入最近关闭。
- 不存在用户可见的 expired 状态；临时网络断连沿用既有重连 UI，不创建替代 runtime。

## Remote and delivery boundaries

```text
desktop renderer / desktop Web
        |
        v
parent session attached host --createSelectionSideSession--> child runtime
        ^
        |
relay / desktop main 仅鉴权、attachment 调度与 rpc-frame 透传
```

- 本地与 SSH/WSL/Docker 都沿父 session 的 shared-host attachment 创建 child。
- 远程链路贯穿 `workspaceIdentity` 与 `remoteSessionId`，禁止按 `workspacePath` 单独匹配。
- desktop `desktop-continuous` 保持 direct continuous；Web remote
  `web-remote-replayable` 保持 snapshot/gap/owner/lease 恢复边界。
- 手机 viewport 不显示入口，也不会为本功能启动独立 runtime。

## Accepted cases and pruning

| ID    | Setup / action                                                      | Expected evidence                                                                                               | Status                                                                                            |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| SSC01 | 普通单行文字首次框选并打开副屏                                      | 新 hidden child + active tab + pending chip，不自动发送                                                         | accepted                                                                                          |
| SSC02 | 当前激活辅助 tab 已输入问题后再次框选                               | 复用 active child，保留草稿并追加引用                                                                           | accepted                                                                                          |
| SSC03 | 重复框选完全相同来源与文本                                          | 激活原 tab，无重复 chip                                                                                         | accepted                                                                                          |
| SSC04 | 主会话普通生成中框选                                                | 允许创建；复制稳定输入边界，排除流式输出，发送沿 queue/guide                                                    | accepted                                                                                          |
| SSC05 | 主会话 Permission/AskUser/ExitPlanMode                              | 整个框选浮层不显示，解除后恢复                                                                                  | accepted                                                                                          |
| SSC06 | 副屏自身 blocked                                                    | 主任务动作可用；副屏动作禁用，处理后恢复                                                                        | accepted                                                                                          |
| SSC07 | child sessionNotFound                                               | 无过期页；移除旧 tab，本次动作创建新 child                                                                      | accepted                                                                                          |
| SSC08 | 手动关闭/关闭其他/全部                                              | runtime 关闭、tab 移除、不进最近关闭                                                                            | accepted                                                                                          |
| SSC09 | 应用重启                                                            | 不恢复 tab；再次框选创建新 child                                                                                | accepted                                                                                          |
| SSC10 | 切换主任务再切回                                                    | 按父任务隐藏/恢复，不串 session、workspace 或草稿                                                               | accepted                                                                                          |
| SSC11 | 跨行、超限、控件文字、手机端                                        | 不创建 session；超限给出本地化提示                                                                              | accepted                                                                                          |
| SSC12 | 远程同路径不同 identity                                             | 精确绑定 shared host，不串远端、不启动独立 runtime                                                              | accepted                                                                                          |
| SSC13 | 副屏多轮工具与权限请求                                              | 正常执行并阻塞交互，但不进入任务列表                                                                            | accepted                                                                                          |
| SSC14 | 添加到当前任务并连续框选                                            | 主 composer 保留草稿、累加 chips；新块只持久化 `{ text }`，旧块可读                                             | accepted                                                                                          |
| SSC15 | 主任务进入后续真实用户轮次                                          | 原副屏仍可继续输入，不自动过期或重建                                                                            | accepted                                                                                          |
| SSC16 | 副屏尝试 goal/edit/retry/fork                                       | UI 无入口，协议直接调用被统一 guard 拒绝                                                                        | accepted                                                                                          |
| SSC17 | completed/streaming assistant 正文框选                              | 两个动作均出现；引用冻结为动作时文本，contentType=assistant                                                     | accepted                                                                                          |
| SSC18 | 启动页或顶部 `+` 点击“辅助对话”                                     | 两处入口语义一致；每次创建并激活新的空 composer                                                                 | accepted                                                                                          |
| SSC19 | child 继承父历史后首次打开或冷恢复                                  | provider 保留历史；所有 UI timeline/search/page/count 均为空                                                    | accepted                                                                                          |
| SSC20 | 父任务 running/blocked 时点击固定入口                               | 入口仍可用；无 active task 与手机端不出现                                                                       | accepted                                                                                          |
| SSC21 | 框选浮层显示中英文动作                                              | 约 32px 高、12px 字号；中文统一“辅助对话”术语                                                                   | accepted                                                                                          |
| SSC22 | 父任务有辅助对话后 fork 到 child                                    | child 展开侧栏显示启动页；切回父任务恢复同一 tab/child/草稿                                                     | accepted                                                                                          |
| SSC23 | Goal 父任务为 active、paused 或 complete                            | 三类状态均创建 child；保留 provider 正文，不继承 Goal 运行态或 identity                                         | accepted                                                                                          |
| SSC24 | 同一 assistant row 内从普通 Markdown 跨选到带操作工具栏的表格单元格 | 浮层正常出现；夹在 Range DOM 中的 `select-none` 工具栏按钮不把选区误判为控件选区                                | accepted                                                                                          |
| SSC25 | 同一父任务连续点击固定辅助对话入口                                  | 创建两个不同 childSessionId 的 tab，标题按辅助对话 1/2 展示                                                     | accepted                                                                                          |
| SSC26 | 同一父任务有多个辅助 tab，激活其中一个后主时间线划词                | 引用只进入 active child，保留其草稿；兄弟 tab 不新增引用                                                        | accepted                                                                                          |
| SSC27 | 同一父任务存在辅助 tab，但当前激活浏览器/代码等非辅助 tab           | 主时间线划词创建新的辅助 child 并激活，不猜测最近使用 tab                                                       | accepted                                                                                          |
| SSC28 | 主 composer 输入裸 `/side` 或 `/btw` 并从 `/` 面板选中              | 两个命令独立展示且行为等价：新建并激活空辅助 tab；输入中的命令 token 被移除，不发送消息；命令不写入 CLI catalog | accepted                                                                                          |
| SSC29 | 草稿态（未创建 session）或辅助对话自身 composer 打开 `/` 面板       | 面板不包含 `/side`、`/btw`；CLI 返回的命令列表不受影响                                                          | accepted                                                                                          |
| SSC30 | desktop 主会话 idle，主 composer 输入 `/side 你好` 或 `/btw 你好`   | 直接提交文字参数                                                                                                | 创建并激活新的 child；child 首条 user input 为 `你好` 并立即发送；父 timeline 不出现 `/side 你好` | accepted |
| SSC31 | desktop 主会话 running（可有既有 active turn/queue）                | 提交 `/btw 继续查一下`                                                                                          | child 首条消息 startNow；父 active turn 继续，父 queue/guide 与 workspace 不变                    | accepted |
| SSC32 | 主 composer 带附件、代码评论、网页/PPTX 元素或划词引用              | 提交 `/side 你好`                                                                                               | 不消费 App 命令，不创建 child；沿主会话原有输入路径发送                                           | accepted |

剪枝：手机只验证入口缺失，不把 selection UI 与 replayable 物理恢复做笛卡尔积；theme/locale 通过
组件和视觉代表覆盖；普通生成、queue/guide 只验证既有路由未回归；tool family 用代表性只读工具、
文件写工具和一次 permission 覆盖，不枚举所有工具；相同 path 远程只与 identity/attachment 组合，
不扩散到 relay 业务状态。SSC22 已于 2026-07-16 确认只保留 desktop continuous 的辅助对话代表
路径；其他 session-scoped tab 类型、remote/mobile、theme/locale 不重复叉乘。SSC23 只枚举
active（无 verifier）、paused（failed verifier）和 complete（passed verifier）；`budget_limited`
与 paused 同属“未完成 Goal snapshot”等价类，不再与客户端、provider 或主题做笛卡尔积。
SSC24 只保留同一 assistant row 的“普通 Markdown → 表格单元格”代表路径；反向拖选共享浏览器
规范化后的同一 Range，streaming、theme、locale、remote/mobile 不重复叉乘。SSC25/26/27 只覆盖
desktop continuous、本地 workspace 与两个辅助 tab；remote identity 继续由 SSC12 覆盖，不与多开数量、
blocked 类型、theme/locale 做笛卡尔积。SSC28/29 只验证 App 层注入、选中即开与草稿态/副屏门禁；
`/side` 与多开数量、locale 的组合由 i18n 关键词单测覆盖，不做 E2E 叉乘。SSC30/31 只保留
文字参数、desktop continuous、本地 workspace 的 idle/running 两个代表状态；SSC32 由 focused
composer/parser tests 覆盖，不与每类结构化上下文做笛卡尔积。

## E2E handoff

- SSC01/02/05/07/08/09/13/14/15/17/18/20/22/25/26/27/28/29/30/31 先进入 conversation-session
  `manual-review/pending`，使用稳定 `E2E_SSC_*` marker。
- SSC03/04/06/10/11/12/16/19/21/23/24/32 以组件、协议、service/core focused tests 为主；SSC22 另用
  Side Pane 可见性 focused test 覆盖共享渲染分支；SSC28/29/30/31 的建议构建、参数解析与命令幂等细节另由单测/协议测试覆盖。
- provider fixture 使用 case-local `fast-text`；SSC13 permission 使用已有交互 fixture，SSC07 使用
  确定性的 sessionNotFound 注入，不以 sleep 模拟。
- 人工确认后再执行 promote、fixture check、默认 replay 与 Docker admission。

# Tool Display Rendering

> **当前状态**：V4 row 通过适配层复用统一的 ToolCall renderer；本文描述当前渲染边界。

## 目标

统一聊天区 tool 的展示入口，避免在 conversation row 里按 `kind` 堆分支，同时给后续 `execute`、`search`、`fetch` 等 tool 的专用渲染留扩展口。

## 当前结构

- `packages/ui/src/lib/toolDisplay.ts`
  - 负责把 `ChatToolCall` 归一成 `ToolDisplayModel`
  - 输出 `inlinePreview`、`viewerSource`、`showInput`、`showOutput`、`showKind`
- `packages/ui/src/lib/codeViewer.ts`
  - 负责提取 `text / patch / file / image` 预览数据
  - 不直接决定最终 UI，只提供预览能力
- `packages/ui/src/v4/ConversationRowView.tsx` 与 `packages/ui/src/v4/toolCallRowAdapter.ts`
  - 把 V4 `ToolCallRow` 适配成统一 renderer 所需的输入，不在 row 组件内复制各类 tool UI
- `packages/ui/src/ToolCallBlocks.tsx`
  - 负责 renderer 注册和选择；`packages/ui/src/ToolCallBlocks/renderers/` 承载 kind/family 专用展示
- `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`
  - 负责通用参数、结果、文件和 Markdown 预览

## 会话流可见性

- `EnterPlanMode` 是会话模式切换的内部边界，不向用户提供可操作详情；主会话流在 `inputStreaming` / `running` / 终态下都不渲染它的 tool row。
- 可见性过滤只作用于 UI render unit：协议投影仍保留原始 `ToolCallRow`，运行态、冷恢复、模式切换和诊断轨迹不得因隐藏展示而丢失。
- 过滤在桌面 `desktop-continuous` 和手机 `web-remote-replayable` 共用的渲染单元上执行，不改写两类 delivery 的快照、gap 恢复或消息顺序。
- conversation work items 会把连续的非只读 Shell 派生为 `Execute` UI 分组；该父节点不是协议工具调用，展开后继续复用单条 `ExecuteToolCallBlock`。PermissionDialog 不经过该聚合路径，仍按真实 tool call 单独审批和展示。

## 扩展方式

- 新增 kind 专用优化时，优先在 `toolDisplay.ts` 里增加 strategy
- strategy 只做“展示决策增强”，不要重写主渲染骨架
- 文件型 tool 优先复用 `codeViewer.ts` 的预览提取结果
- 多媒体资源如果是图片，优先走 `image` preview；其他二进制继续走兜底提示

## 专用 Tool Renderer

- `Node REPL` / Browser Use 工具的展开布局保持透明，并与工具摘要正文保持同一水平基线；不得在 `ToolLayout` 的详情间距之外再次叠加整块横向 padding。文本结果内容块和“查看执行细节”展开后的代码/错误栈分别使用 `bg-card border border-border rounded-xl`；图片、“查看执行细节”按钮和折叠布局本身留在卡片外。单行、非 JSON、长度不超过 160 字符的短结果使用普通次级正文展示；JSON、多行或更长的日志继续使用带复制/换行操作的 CodeBlock。图片结果在消息流展开区始终使用单列，避免窄桌面栏和手机 Web 中被响应式断点切成过窄的双列缩略图；大图查看器行为保持不变。
- `CUA` 工具的展开区只展示面向用户的动作、结果、失败原因、建议、截图、权限、环境、列表和应用状态，不提供完整 tool call JSON 的“查看原始数据”入口。原始 input、output、display 和生命周期元数据仍按既有协议与持久化链路保留，只是不进入桌面端与手机 Web 共用的 CUA 展开界面；其他工具 renderer 的原始数据能力不受影响。
- `ReadSessionContext` 通过 `ReadSessionContextToolCallBlock` 渲染，不走 fallback 的 `Parameters` / `Result` JSON 块。
- 摘要行展示本次上下文读取的 `query`，并把 `sessionId` 作为次级标识。
- 展开区只展示 `query` 和返回的上下文内容；若 output 是结构化对象，优先读取 `output.content`，再回退到文本型 output 或 `rawOutput`。
- `SendMessage` 归入 `message` family，并通过 `SendMessageToolCallBlock` 渲染。收起态按“已发送/正在发送 + input `summary` + 给/to + 目标 agent `to`”组成一句完整摘要；展开态只展示目标智能体、摘要和消息正文，不展示投递状态、message/agent/task id、输出路径、result 或整段 tool call JSON。目标、摘要和消息都尚未到达时必须禁用展开，禁止在 streaming input 或字段未加载的 snapshot 上出现空详情面板。
- `SendMessage` 的主展示数据使用 Core 在 model content 格式化和 hook additional context 拼接之外生成的 `local_agent_message` display payload。payload 只保留 `status`、失败 `error` 和结果 `message`，不得携带或展示 delivery、message/agent/task id、输出路径；`error` 与 `message` 必须分别受 4 KiB UTF-8 预算约束，超出时保留完整 code point 并追加 `...[truncated]` 标记，避免 display 绕过 tool result budget 放大实时事件和持久化快照。lowercase `send_message` 是另一条 session mailbox 语义，不得复用 `SendMessage` identity、display 或 renderer。
- `SendMessage` 的 display 若返回 `status: "failed"`，即使外层 tool call 已 completed，也按业务失败展示“消息发送失败”和 failure status；真实 tool failure 同样不得继续显示“已发送”。结构化 output、JSON 字符串、纯文本 model content 和 `rawOutput` / `result.content` 只作为旧快照/provider 兼容 fallback，禁止通过错误文案推断成功或失败。
- `SendMessage` 的收起态必须显式覆盖完整终态：`completed` 显示“已发送”，`failed` 或 display 业务失败显示“消息发送失败”，`denied` 显示“发送已拒绝”，`stopped` 显示“发送已停止”；不得把非成功终态落入成功文案。
- `TaskStop` 归入 `task-control` family，并通过 `TaskStopToolCallBlock` 渲染。收起态只使用停止中/已停止的动作文案和 `task_id`（输入阶段兼容 deprecated `shell_id`），不得展示 `task_type`；展开态的摘要行继续保留 task id，详情区只展示 task type、任务描述或命令，以及结果消息，不重复 task id，也不展示整段 tool call JSON。
- `TaskStop` 的主展示数据使用 Core 生成的 `task_stop` display payload，字段只包含 `taskId`、`taskType`、可选 `command`、结果 `message` 和可选 `truncated`。`command` 与 `message` 必须分别受 16 KiB UTF-8 预算约束，任一字段被截断时设置 `truncated: true`，避免 display 绕过 tool result budget 放大实时事件、持久化快照和展开 DOM；UI 展开态必须明确提示详情已截断。实时事件从 `raw.result.display` 读取，持久化恢复从 `raw.display` 读取，其他 provider 可从 `raw.rawOutput.display` 读取；三个入口必须由同一个 UI reader 做严格 kind/字段校验。
- `TaskStop` 的成功 output/model content 继续保持原始工具契约；runtime 必须让 `local_bash` 的 `command` 表示实际命令、`local_agent` 的 `command` 表示短 `description`，不得把完整 subagent `prompt` 放入结果。UI 对 `local_agent` 将可信 `task_stop` display 中的 `command` 按“任务描述”以正文样式展示；命令型任务继续按“命令”以等宽样式展示。没有 display 的历史 `local_agent` 结果不得把旧 `output.command` 当作描述展示，因为该字段可能保存完整 prompt；旧字段只允许用于精确识别并压缩标准成功文案。display projection 只负责去掉标准成功文案中已经由 `command` 字段单独展示的重复内容：`Successfully stopped task: <taskId> (<command>)` 在 UI 的“结果”中显示为 `Successfully stopped task: <taskId>`。UI 对没有 display 的历史结果只做同一模板的精确匹配，任意自定义结果文案必须原样保留。
- `TaskStop` 继续兼容旧结构化对象、JSON 字符串和 `rawOutput`。历史结果若带 hook additional context，只允许识别明确的 `\n\n[Hook additional context]` envelope 并解析前段 JSON，不得做任意前缀截断或文案猜测。停止操作本身不使用 destructive 颜色；只有真实失败态继续复用 `ToolLayout` 的 failure status 与错误 tooltip。
- `TaskStop` 的收起态必须显式覆盖完整终态：`completed` 显示“已停止”，`failed` 显示“停止任务失败”，`denied` 显示“停止操作已拒绝”，`stopped` 显示“停止操作已取消”；失败、拒绝或中断不得与“已停止”同时出现。
- `TaskStop` 的 `failed` / `denied` / `stopped` 若带错误原因，展开态将该原因作为“结果”展示；若 task type、任务描述或命令、结果和截断提示都不存在，则必须禁用展开，禁止出现可点击但内容为空的详情面板。
- `TaskOutput` 归入 `task-control` family，并通过 `TaskOutputToolCallBlock` 渲染。收起态使用等宽 `task_id` 作为主内容，状态按“工具执行终态 > retrieval status > 被查询 task status”的优先级投影：工具执行失败显示统一的“执行失败”，运行中显示“任务运行中”，等待超时显示“等待超时”，成功读取 completed task 显示“已获取”，failed/lost 显示“任务失败”，cancelled/killed/stopped 显示“任务已停止”。未知 task status 原样显示，禁止把成功读取结果一律当作 task 成功。
- `TaskOutput` 的主展示数据使用 Core 生成的 `task_output` display payload，只包含 `retrievalStatus`、最长 64 字符的可选 `taskStatus`、最长 2000 字符的可选 `output` 和可选 `truncated`。`task_id` 继续直接读取 tool input，不在 display 重复保存。output 使用 `trimEnd()` 后保留前 2000 字符；空白 output 不生成字段，运行中已取得的部分 output 允许展示。仅非空 output 提供展开入口，展开区使用固定最大高度的滚动 `<pre>`；截断时提示后续内容已省略。task type、description、error、prompt、result、output path 和原始 provider XML/JSON 不得进入 display、摘要正文或展开内容；真实 tool execution failure 仍复用 `ToolLayout` 的通用失败状态 tooltip，通过 `context.errorText` 在 hover/copy 时展示错误原因，且不因此生成展开区。
- `RespondToCoordinator` 归入 `message` family，并通过 `RespondToCoordinatorToolCallBlock` 渲染。收起态只使用 input `summary` 作为主内容，不提供展开区；运行中显示“正在回复”，success 显示“回复已排队”，业务或执行失败显示统一的“执行失败”，拒绝和停止显示对应终态。“已排队”只表示 response command 已进入 parent runtime command queue，不得写成已送达、已读取或已处理。
- `RespondToCoordinator` 的主展示数据使用 Core 生成的 `respond_to_coordinator` display payload，只包含 `status: "success" | "failed"`。`message`、`responseId`、`error` 和原始 result 不得复制到 display、摘要正文或展开内容；真实 tool execution failure 仍复用 `ToolLayout` 的通用失败状态 tooltip，通过 `context.errorText` 在 hover/copy 时展示错误原因，业务 `status: "failed"` 不凭空生成错误详情。普通 child tool row 只在 child session topic 中物化；父会话继续只显示 Agent/Task 摘要，不得为了专属卡片恢复 mirrored child tool row。
- 新增 display 通过 completed tool metadata 和 V4 `ToolCallRow.display` 传输。旧记录没有对应 display 时，两个 renderer 只使用 input 与通用 tool lifecycle 展示最小摘要，不解析 provider-visible XML/JSON，也不新增持久化迁移。
- 正式 desktop WDIO 复用 background Agent 生命周期验证两条投影链：成功 case 在父会话真实调用 `TaskOutput` 并展开 output，随后从 Agent 摘要进入 child 会话检查 `RespondToCoordinator` 的 summary/“回复已排队”以及父会话隔离；组合错误 case 让 TaskOutput 查询不存在的 task，并让 child 调用缺少必填 `message` 的 RespondToCoordinator，当前覆盖两个 tool row 的 error 终态、统一的“执行失败”文案、卡片正文不包含 provider error wrapper 或原始错误，以及 child-only 边界。两张错误卡 hover 通用失败状态后展示对应 `context.errorText` 的 WDIO 断言尚未补齐，因此 O19 保持 `partial`。E2E 不重复枚举 retrieval/task 状态、业务 queue failure、2,000 字符边界或 mobile replayable；这些组合由 Core display、V4 projection/wire 和共享 renderer 定向测试覆盖。
- 这些 renderer 都复用 `ToolLayout`、`ToolSnapshotFieldNotice`、semantic color token、`text-ui-base` 正文排版和 lucide 图标。Execute/Shell 工具收起态 summary 中的 command 使用 UI sans 字体，与同一摘要行保持一致；展开后的命令正文继续使用等宽字体。传给 memoized `ToolLayout` 的 JSX props 必须通过 `useMemo` 保持稳定引用；详情布局必须在窄屏纵向自然换行，并兼容桌面/Web、Zai Light/Zai Dark 与中英文文案长度。
- `Read` / `Edit` / `Write` 摘要在会话流变窄时优先保留文件名：窄于 `360px` 的 conversation container 先隐藏动作标签、来源徽标和父目录路径，文件 chip 使用剩余宽度并在自身内部截断；文件图标、diff 统计和展开入口继续保留。普通宽度仍显示完整动作标签与路径，桌面分栏与手机 Web 共用同一容器规则。
- 所有 ToolCall 运行中都保留静态 kind 图标，不再替换成旋转 loading 图标；运行态通过 kind 文案扫光、状态文案和摘要内容表达，避免大量 toolcall 同时 streaming 时持续触发动画渲染开销。
- ToolCall 文案统一遵循“运行态动作名称、终态稳定类别名称”：中文 `pending` / `in_progress` 的 kind label 使用 `正在 + 动作`；英文沿用简洁自然的现有动作词（如 `Reading`、`Sending`、`Working`），不为句式对称机械扩写。进入 `completed` / `failed` / `denied` / `stopped` 后统一回到不带“已”的类别名称，目标、命令、文件和业务结果继续放在摘要正文中，失败、拒绝、停止等异常状态继续由 status label 表达。例如单个 Read 显示 `正在读取 · package.json`，完成后显示 `读取 · package.json`；单个 Execute 显示 `正在执行 · pnpm test`，完成后显示 `终端 · pnpm test`。禁止把“已读取”“已执行”等成功动作当作终态类别名称，也禁止在类别名称和摘要正文中重复同一个进行中动作。
- 专属业务状态优先于通用生命周期文案：`RespondToCoordinator` 的成功结果仍是“回复已排队”，`TaskOutput` 仍区分任务运行中、等待超时、任务失败和任务已停止，`TaskStop` 仍区分成功停止任务与停止操作自身被拒绝/取消。类别名称只负责说明工具是什么，不能覆盖这些业务结果。
- Explore、Terminal、Changes 只在同一可见工作段内连续同类工具达到 2 个及以上时创建 UI 合成父组；最大连续片段只有 1 个工具时直接显示原始工具，不套父组。流式阶段首个工具立即按原工具显示，第二个连续同类工具到达后再升级为以首个工具锚定身份的父组。异类工具、可见 reasoning 和 assistant text 继续切断片段；隐藏 reasoning 与等待命令分类的 Shell 继续作为透明边界处理。
- 普通 Explore 聚合工具（搜索、列目录、读文件等）在运行态也允许用户手动展开/收起；运行态只表示当前消息尾部仍处在查阅段，不再强制展开或锁定交互。同一段 Explore 在流式过程中新增子工具时，聚合组件和展开状态的身份必须锚定首个子工具，禁止把末尾子工具或当前数量放进身份 key，避免内容增长把用户已经展开的详情重置为收起。进行中时图标仍固定显示放大镜，不替换成 loading spinner。收起态的 `kindLabel` 始终使用无时态的 `Explore` / `查阅`，不再显示 `Exploring` / `Explored`；摘要正文和 kind label 始终用静态分隔点隔开，完成态也显示为 `Explore · 3 lists, 2 files`。只在最新子工具摘要已经明确时借用它的 `primaryText` / `secondaryText`。子工具摘要始终补充 ing 动作态，例如 `Explore · Reading 文件名 路径`、`Explore · Searching 查找 xxx`、`Explore · Running command`，不随子工具完成态消失或切成完成文案。其中 read 子工具必须等到路径解析出来后才放进收起态，并复用 Read 工具自己的文件 chip，以保留文件图标、路径 tooltip 和文件预览点击行为，禁止用 `Read` 这类半成品 fallback 抢占摘要。子工具从 running 变 completed 时，收起态保持最新子工具内容，避免在子工具状态词和父级聚合统计之间来回闪动。收起态内容变化默认使用纵向滚动动效：单次滚动 300ms，滚动完成后稳定停留 500ms 再播放下一条，单条总耗时必须小于 1s；`ToolCallBlock.disableSummaryContentAnimation` / `AssistantMessage.disableToolSummaryContentAnimation` 是统一开关，会同时关闭 Agent 和 Explore 的摘要滚动，关闭后直接显示最新摘要并清空待播队列；底层 `ToolLayout.disableSummaryContentAnimation` 或 `QueuedSummaryContent.disableAnimation` 继续保留为局部开关。总队列最多三项，分别是当前项、第二条待显示项、第三条可插队项；当前项不被打断，第二条不被后来摘要覆盖，动画期间继续到来的新摘要只替换第三条，避免把过期摘要无限排队。若主线程繁忙导致滚动 timer 明显晚到，不再补播旧队列，直接压缩到最新摘要，避免卡顿后继续回放过期状态。Explore 结束时把待播队列压缩成最终聚合摘要，不继续播放过期子工具摘要。展开态展示父级聚合统计和子工具明细。Explore 父节点只是 UI 合成容器，不代表一次真实工具执行；子工具失败只在对应子工具明细内展示，禁止把任一子工具的 `error` 汇总成父 Explore 的失败状态。真实协议工具自身的失败展示不受此规则影响。
- Explore 与 Execute 父级运行态都按阶段边界派生：只有分组位于 `running` work segment 的最后一个可见 assistant work chunk，且组后没有其他可见 row 时才为 `in_progress`。后续其他工具、assistant text 或可见 reasoning 都结束前一阶段；被设置隐藏的非首 reasoning，以及 command 尚未到达而暂缓渲染的 Shell row，都不构成可见边界，也不参与尾部位置判断。terminal segment 尾部为 completed（存在 cancelled child 时可显示 stopped）。子工具生命周期只影响展开明细，不反向决定父级运行态。
- Explore 聚合的 shell 命令归类必须同时覆盖 Unix shell 和 Windows PowerShell。`pwsh` / `powershell.exe -Command` 包裹的命令先解包再判定；已知只读 PowerShell 命令如 `Get-ChildItem` / `gci` / `dir`、`Get-Content` / `gc` / `type`、`Select-String` / `sls`、`Get-Location`、`Test-Path`、`Resolve-Path` 进入 Explore；已知写入或破坏性命令如 `Remove-Item` / `del` / `erase`、`Set-Content`、`Add-Content`、`Clear-Content`、`Out-File`、`New-Item`、`Move-Item`、`Copy-Item`、`Rename-Item`、`Set-Item` 不进入 Explore。写入判定优先于只读判定。
- Tool 摘要和 Execute 详情中的 command 文本统一继承 UI sans，不使用 `font-mono`；命令输出仍保留 `font-mono`，维持 terminal-like 数据的对齐与辨识度。这是 command 展示对全局 typography 默认规则的产品例外。
- Execute 父组使用跨平台类别标题 `Terminal` / `终端`，不指代具体 Windows Terminal 应用；PowerShell、cmd.exe、Git Bash、WSL 和 Unix shell 都沿用该标题，单条 Execute 子工具的 Running/Ran 文案不变。父组 `kindLabel` 与摘要始终用静态 `·` 分隔。运行中每个滚动快照必须包含完整动作语义 `Running <command>` / `执行中 <command>`，不能只滚动裸 command；摘要结构和 Explore shell 子摘要对齐：动作词使用 `text-foreground-subtle`，command 使用 `text-foreground-subtlest`，两者作为同一个滚动快照播放。运行中展开父组后，父 summary 只显示 `Terminal · N commands`，不得继续显示动作词或当前 command，当前状态由下方子 tool summary 表达。完成态显示 `Terminal · N commands` 及失败/停止统计。
- 连续 file-write rows 聚合为 `Changes` / `更改` 父组，父运行态与 Explore/Terminal 一样由可见阶段边界决定，不依赖 child 生命周期。进行中收起态纵向滚动最新 `Writing/Editing + file chip + relative directory`；进行中或完成展开态只显示 `Changes · N files`；完成收起态显示 `Changes · N files · file chips`。文件跨 children 扁平化后按完整 path 去重并保持首次顺序；首次渲染完整列表，再根据 summary 实际可用宽度保留尽可能多的前序 chip，其余显示 `+N`，宽度变化时通过 ResizeObserver 重算并恢复或收起文件。单个 Edit 的多文件 summary 继续复用现有子文件 renderer。Changes 只是 UI 合成容器，child failure/stopped 不汇总为父失败。
- Edit 与 Changes summary/滚动内容复用的 file chip 文件名统一使用 `text-foreground-subtle`，比普通主文本低一级；其后的相对目录继续使用 `text-foreground-subtlest`，保持文件名与路径的层级差。
- Agent / SubAgent 工具始终使用 bot 图标和外层 SubAgent kind label，禁止把 agent 类型（例如 `Explore`）显示成外层 kind；运行中也不把 bot 图标替换成 loader。收起态摘要正文和 kind label 始终用静态分隔点隔开，完成态也显示为 `SubAgent · xxx`。当子工具存在可确认 summary 时，收起态正文借用最新子工具 summary，例如 `SubAgent · Reading 文件名 路径`、`SubAgent · Searching 查找 xxx`、`SubAgent · Running command`；只有点后面的子工具 summary 参与滚动动效。子工具摘要始终保留 ing 动作态，不随完成态消失。展开态仍展示 Agent 自己的 prompt、活动内容和子工具列表。没有明确子工具 summary 时，继续显示 Agent 自己的标题或描述。
- SubAgent 的视觉运行态只看父 Agent tool 的 `pending` / `in_progress`。子工具是展开区明细，不反向续住父 Agent 运行态；父 Agent 已经 completed 时，即使子 tool 仍 running，外层也收敛成静态 `SubAgent · xxx`。
- Agent / SubAgent 收起态遇到 `TodoWrite` 子工具时展示待办语义摘要，不展示裸工具名：优先展示 in-progress 项，否则展示下一条未完成项，否则展示最后一条完成项；格式为 `Updating todo 2/5 · 当前任务`，全部完成时为 `Updated todo 5/5 · 当前任务`。这样子 agent 更新计划时，滚动摘要仍能表达具体内容，而不是 `Running TodoWrite`。
- 当前主轮仍为 running 时，Agent / SubAgent 卡片与聊天底部 `ChatLoading` 同时显示。Agent 卡片及其内部子工具只负责工具详情，不控制 `ChatLoading`；底部 loading 在主轮进入终态时隐藏，等待 AskUserQuestion 或权限确认期间也隐藏，避免把“等待用户”误表达成“正在思考”。
- 流式过程中，running shell tool 要分两个场景处理：
  - `tool_input_start` 刚到、命令参数还没拼完整时，先不要渲染这个未分类 shell。无论它是 active Explore 后续 tool，还是当前轮第一个独立 tool，都要等命令可分类后再展示，避免用户先看到 `Run`，下一帧又因为只读命令被升级成 `Explore`。
  - active Explore 后面紧跟的未分类 shell 即使已经完成，也不要单独显示成 `Ran Bash`。这类 tool 没有可展示命令，应该由前面的 Explore 视觉进度吸收，避免 Explore 摘要下方残留无意义的 Bash 行。
  - 命令已经可分类时，立即按分类结果渲染：只读探查命令进入 `Explore`，非探查命令保持独立 `Run` / shell tool，避免真实执行命令没有进度反馈。
- `Goal` 工具、用户消息里的 `/goal` 命令 mention、goal 摘要和 goal 校验分割线统一使用 lucide 的 `GoalIcon`。
  这个图标与用户可见的 `/goal` 语义一致，避免继续用 `TargetIcon` 造成项目内图标和 lucide `goal` 图标不一致。

## 编辑行数计数

- `Edit` / 写文件类工具的摘要行继续复用 `changeStat.added` / `changeStat.removed` 作为唯一统计来源，UI 不在渲染层重新推导 diff 行数。
- 行数变化时，`+N` / `-N` 中的数字可使用一次短字符槽翻页动画；`+` / `-` 符号保持静态，颜色继续使用 `text-diff-added` / `text-diff-removed`。
- 翻页动画必须使用固定字符宽度和 `tabular-nums`，避免桌面端连续流式更新或手机端 replayable 恢复补帧时造成摘要行抖动。
- 用户开启 `prefers-reduced-motion: reduce` 时，数字降级为静态字符槽，只保留完整读数的辅助技术标签。
- 运行中的 `Write` / `Edit` 预览由 projection 最多每秒提供一次新的真实 `changeStat`；同一个采样点的路径、内容、diff 与 `+N/-N` 必须原子更新。
- UI 禁止用 `requestAnimationFrame` 逐行追赶目标值。目标从 `12` 更新到 `45` 时直接把 `45` 交给一次短翻页，不补播 `13`、`14` 等中间值。
- 工具结束、取消、恢复历史 snapshot 或手机 replayable 终态时立即显示真实目标，不回放已经过期的流式行数。

## 历史一致性

- ZCode persisted tool call 现在会持久化 `status` 和 `raw`
- 这样实时流里的 diff / image / 特殊 tool payload，刷新后仍然能复用同一套展示逻辑
- Core 的 `ToolResultDisplayPayload` 是 UI 结构化事实边界：display 从原始 tool output 生成，通过实时 `ToolCallResult.result.display` 传输，并通过 completed tool part metadata 持久化。模型可见 content 的格式化、截断和 hook additional context 不得改变 display。
- V4 product projection 必须把 CUA、file diff 等通用 display 保留在 `ToolCallRow.output.display`；`ToolCallRow.display` 只保留既有 `node_repl_images` 专用通道。UI adapter 优先读取 `output.display`，并兼容旧 Node REPL 顶层 display。
- CUA display v1 的 `input` 仅作为旧历史记录兼容字段继续可读；新事件不再重复写入。工具调用自身的 `ToolCallRow.input` 是唯一输入事实源，UI 解析旧 display 时丢弃其中的副本。
- UI 读取 display 时必须同时覆盖桌面 `desktop-continuous` 的实时 raw event 与手机 `web-remote-replayable` 的持久化 metadata；不得把 replayable 恢复数据拼接进 desktop continuous 主链路，也不得绕过现有 snapshot/gap 恢复边界。

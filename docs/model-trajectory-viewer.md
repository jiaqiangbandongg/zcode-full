# 模型调用轨迹查看器（Model Trajectory Viewer）

> E2E 行为目录与覆盖状态见
> [`docs/testing/model-trajectory-e2e-coverage-matrix.md`](./testing/model-trajectory-e2e-coverage-matrix.md)。

在任务右键菜单 / Header 更多菜单里新增「查看调用轨迹」，在右侧边栏以专业、可读的方式
可视化某个 task/session 的模型调用全过程：区分 system / user / assistant / tool 角色，
展示每次调用的模型、token 用量、耗时、finishReason、工具调用入参与工具结果、错误堆栈等。

## 数据来源

- `~/.zcode/cli/debug`（开发态）与 `~/.zcode/cli/rollout`（生产态，最多保留最近 3 个会话文件）
  下的 `model-io-*.jsonl`。
- 由 `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` 落盘，文件名形如
  `model-io-<sanitizedSessionId>.jsonl`。一个 session 只对应一个 JSONL 文件；首条记录保存完整
  `request.messages`，后续模型调用只保存相对上一条新增的消息 delta，避免完整上下文按梯度重复。
  每条记录带 `sessionId` / `turnId` / `traceId` / `querySource`、`request`（messages / toolNames）、
  `response`（text / reasoningText / toolCalls / usage / finishReason）、`error`。AI SDK 返回的
  `response.reasoning` 必须在落盘前按 reasoning block 顺序提取文本，并以空行连接为
  `response.reasoningText`；块内换行保持不变。无有效 reasoning 文本时省略该字段，避免制造空的“思考过程”行。
  `querySource` 与 `model.role` 用来区分主会话请求、标题生成、compact、subagent 等来源；
  旧日志缺少 `querySource` 时，服务层会对已知标题生成 prompt 做兼容识别。
- TOOL 消息的 `content` 在实际 model-io 中通常是字符串，而 `toolCallId` / `toolName` 位于消息顶层；
  服务层归一化为 `tool-result` 时必须把这些顶层关联字段一并保留，不能只映射 output，否则 UI 无法关联和展示 tool call ID。
- 写入链路必须是有界的：模型请求完成后写 model-io 属于 agent 主流程上的诊断旁路，禁止为了 append
  新记录同步读取并 expand 整个历史 JSONL。长会话曾把单个生产 rollout 文件写到 1GB 量级，旧实现每次写入前
  `readFileSync(filePath, "utf8")` 并逐行 `JSON.parse` / expand，可能在 UTF-8 转换或 V8 字符串分配阶段触发
  native crash，导致 agent 子进程直接退出且普通 JS 日志来不及落盘。
- 新实现只用进程内上一条请求摘要判断 delta；进程重启、缓存缺失、历史不匹配或文件超过生产硬上限时，写入当前请求的
  bounded baseline（必要时只保留最近 tail messages），并继续从该 baseline 之后追加 delta。生产 rollout 是“最近有界轨迹”，
  不承诺无限完整回放；开发态 debug 保留更多原始字段，但同样不能在写入时回读整份历史文件。
- ZCode Agent 把 `taskId` 当作 `sessionId`（见 `zcodeTaskServiceAdapter` 里多处 `sessionId: params.taskId`），
  所以轨迹只读取 `model-io-<sanitizedTaskId>.jsonl`，并按 `record.sessionId === taskId` 精确匹配。
  仅 ZCode Agent（glm）会落盘 model-io。
- 读取链路同样必须有界且异步：Host 从文件尾部按块读取，最多扫描 32 MiB，并只保留最近 `limit`
  条记录；不得使用 `readFileSync + split` 同步加载整个 JSONL。若扫描起点落在一条记录中间，丢弃该残行；
  文件不可读时降级为空结果。开发日志记录扫描字节数与耗时，便于定位异常大文件，同时避免高频诊断信息进入生产日志。

## 分层与关键文件

服务层（host 侧读盘，桌面读本机、手机远控读远端 host，UI 只消费结构化结果）：

- `packages/services/src/session/zcodeTaskService.ts`：新增 `ZCodeModelTrajectory*` 类型与
  `IZCodeTaskService.getModelTrajectory({ taskId, limit })`。
- `packages/services/src/zcode-agent/modelTrajectory.ts`：异步、有界地读取 session 单文件尾部，还原 delta messages、
  归一化 messages / parts / toolCalls / usage，按 `startedAt` 排序，超出 `limit`（默认 200）保留最近 N 条。
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`：实现 `getModelTrajectory`。

UI 层：

- 调用内容不显示 `INPUT` / `OUTPUT` 大分区标题，输入消息行与 `ASSISTANT` 输出标题直接按数据顺序排列，减少无信息量的纵向层级。

- 入口：`TaskActionMenuContent.tsx` 新增「查看调用轨迹」项，经 `TaskListItemContextMenu` →
  `TaskListItem`（任务列表）与 `WorkspaceHeaderSections`（Header）两处接入。
- 桥接：`store/modelTrajectoryStore.ts` 单例 store + `hooks/useModelTrajectoryOpenBridge.ts`。
  菜单深处通过 store 发起「打开轨迹」请求；目标 workspace 的 `useAppPanels` 订阅，按 `workspaceKey`
  匹配后打开侧边栏 tab，避免把回调贯穿整棵任务列表树，也避免多 workspace 实例串开。
- 侧边栏 tab：`lib/workspaceSidePane.ts` 新增 `model-trajectory` tab 类型与 `openModelTrajectorySidePane`；
  `app-shell/AnimatedSidePanePanel.tsx` 渲染 `ModelTrajectoryPane`；
  `app-shell/SidePaneTabTrigger.tsx` / `SidePaneTabOverview.tsx` 补图标与标题。
- 视图：`ModelTrajectoryPane.tsx` + `ModelTrajectoryPaneParts.tsx`，数据走 `hooks/useModelTrajectory.ts`。
  轨迹内容区使用原生纵向滚动容器，不使用 Radix `ScrollArea`；避免其内部自动插入
  `min-width: 100%; display: table` 的内容包装层，导致长轨迹内容参与异常宽度计算。
- Side Pane 的 `ResizablePanel` 壳必须使用 `!overflow-hidden` 覆盖 `react-resizable-panels` 注入的内联 `overflow:auto`，不得让面板壳与 tab 内容同时形成纵向滚动；各 tab 自行持有内容滚动区，调用轨迹仅由 `ModelTrajectoryPane` 的原生 `overflow-y-auto` 容器滚动。

## 展示模型

每条 model-io 记录是「一次模型调用」。视图按时间顺序把轨迹组织成
**输入（user / tool 结果）→ 输出（assistant 文本 / reasoning / 工具调用）** 的链路：

- 首条调用展示完整起始上下文（system + 初始 user）。
- 后续主会话调用只展示相对上一条新增的非 assistant 消息（assistant 由上一条的 Output 呈现），避免重复刷历史。
- 标题生成、compact、prompt enhance 等 sidecar 请求展示自己的完整 prompt，不套用主会话 delta。
- 头部汇总调用次数、总 token、用到的模型；每张调用卡片的单行 Header 展示来源、finishReason、in/out token、耗时与时间。
- 每张调用卡片头部显示来源 badge（如“主会话”“标题生成”“上下文压缩”“子代理”）。
- 来源标题和 finish reason pill 除本地化展示文案外，还必须分别暴露稳定的
  `data-trajectory-source-kind` / `data-trajectory-query-source` 与
  `data-trajectory-finish-reason` 语义属性。E2E 使用这些属性验证轨迹投影，不得把英文展示文案
  当作功能合同；国际化文案由显式固定 locale 的代表性断言验证。

## 紧凑布局与交互

- 轨迹采用单列调用日志，不使用多层卡片：每次调用由一行摘要和按需展开的详情组成，调用之间仅用
  独立的 `h-px bg-border` 分隔，不在容器上使用 border；列表不设置四边外层 padding，分隔线直接贴合面板边缘。
- 面板 Header 与每次调用的摘要 Header 均使用 `px-3 py-2`，让序号、标题、标签与元数据保持紧凑且一致的留白。
- 调用摘要使用单行结构：左侧为“序号 + 来源标题 + 语义化 finish reason pill”，右侧按
  `IN {inputTokens} · OUT {outputTokens} · 耗时 · 时间` 排列并右对齐。每条调用不再重复展示模型 pill 和 attempt；
  模型集合保留在面板总览 Header。来源标题与 finish reason pill 必须紧邻，剩余弹性空白位于 pill 和右侧指标之间；
  窄侧栏下来源标题优先截断，右侧指标保持完整。
- 调用来源使用 `text-ui-sm font-medium text-foreground`；语义化结束原因使用
  `bg-tag border-border text-ui-xs` pill，序号与右侧元数据使用 `text-ui-xs`。
- 序号使用 `size-5` 行盒水平、垂直居中，与标题和 pill 对齐，不跟随两行摘要整体居中。
- 每次调用的摘要行在轨迹内容滚动时吸附于顶部，使用半透明 `surface` 背景、轻量背景模糊与 `border-border/50` 底边线，确保下方载荷滚过时标题仍清晰可辨。
- 每次调用的 IN / OUT 大层级始终展开，不提供整次调用的收起交互；仅具体消息与载荷保留二级折叠。
- 面板 Header action 区在“打开源目录”左侧提供单个“全部展开 / 全部收起”切换按钮，仅在存在轨迹记录时显示。图标复用 Task List 的 `Maximize2 / Minimize2`，使用 `size-3.5 text-foreground`。所有消息行初始化默认展开，因此初始动作是全部收起，触发后按钮动作切换为全部展开；每次批量动作通过递增 command version 同步覆盖当前所有消息行。单行仍可独立切换，不反向改写批量按钮的下一动作。默认状态直接由共享 command 与行内 lazy state 初始化，不通过逐行 `useEffect` 触发二次更新。
- “全部展开 / 全部收起”左侧提供自定义展开菜单。菜单按 System、User、Reasoning、Assistant、Tool Call、Tool Result 顺序列出六类内容，右侧使用 `sm` Switch 表达该类型的目标展开状态；点击整行或 Switch 均只更新该类型，菜单保持打开以便连续配置。全部展开/收起会同步更新六个开关。类型命令和全局命令共用单调递增 version，后发命令覆盖对应类型的旧单行 override；未被本次类型命令命中的类型保持原状态。菜单和所有文案必须国际化。

```text
Header toggle
    ├─ expand all   -> command(open=true, version+1)  ┐
    └─ collapse all -> command(open=false, version+1) ┴─ row render 直接读取最新 command

row trigger -> local override(open, current command version) -> only that row changes
next header command(version+1) -> supersedes every older local override
```

批量命令不得由每行 `useEffect` 再同步到本地 `open` state，否则 N 条消息会在 Context 更新后追加 N 次状态写入和第二轮提交。每行应在 render 阶段比较批量 command version 与本地 override version，直接派生本次 `open`；单行操作记录当前 command version，下一次更高版本的批量命令自然覆盖它。

- 展开内容按 `IN` / `OUT` 分区。system、用户、tool、assistant、reasoning 与 tool call/result 消息默认全部展开，与 Header 初始动作“全部收起”保持一致；点击单行后可在同一层收起为单行预览，再次展开直接展示全文、思考过程、工具输入或工具结果，展开内容内部不再嵌套第二层折叠。
- 调用内容区外层使用 `p-2 gap-y-2`，统一提供四边 8px 内边距和相邻大组之间的 8px 间距；INPUT / OUTPUT 各自作为独立大组卡片，使用 `overflow-hidden rounded-lg border border-card-border`，自身不设置 margin 或背景色。消息行在卡片内连续排列，由各分区与消息行自身控制布局。
- `INPUT / OUTPUT` 分区各显示独立标题行，使用 `h-8 px-3 bg-surface text-ui-sm font-mono uppercase text-foreground`，与消息斑马纹的 `bg-surface/30` 拉开层级。标题不显示左侧色线或装饰图标，不设置 `mt-*`、`mb-*`；两组使用相同中性样式，只负责表达请求与产出分组，不参与消息行斑马纹。
- 相邻消息行之间不设置 gap；INPUT / OUTPUT 标题与第一条消息之间、相邻消息之间插入独立的 `col-span-full h-px bg-border/50` 分隔元素，不使用消息行自身的 border。
- 整个轨迹列表共用最外层 `max-content minmax(0, 1fr) auto` 三列 grid；每个 Call Card、调用内容区、输入区、输出区和消息行都通过 `subgrid` 继承同一组“角色 / 内容 / 操作”列轨道，像 table 一样由全列表最长的本地化角色标签决定第一列宽度。Grid 使用 `gap-x-2`，将内容与 Chevron 的间距收紧为 8px；角色标签额外使用 `pr-1`，使角色与内容的视觉间距仍保持 12px。不得让不同 Call Card 或 Input / Assistant 输出分别计算角色列宽，也不得用固定宽角色列在短中文标签后制造大块空白。内容列必须保持 `minmax(0, 1fr)`，确保长摘要仍可正常收缩和截断。
- 共享操作列仅由 Chevron 确定宽度；操作列使用 `-ml-1 mr-1`，在不改变角色列与内容列间距的前提下，把内容或工具 ID pill 到 Chevron 的可见间距由 8px 收紧为 4px。展开态复制按钮使用 `absolute right-full mr-1` 放在 Chevron 左侧，不撑宽共享操作列。展开态元数据使用 `mr-7` 精确预留“24px 按钮 + 4px 间距”，避免复制图标覆盖日期时间；收起行不保留该空位。所有行的 Chevron 始终贴齐同一条右边线，不得在箭头右侧留下空槽。
- 标题行操作列只保留 Chevron；任意行展开或收起时，其他行的 summary、标签与 Chevron 都不得横向跳动。
- 模型输入中的 `tool` 角色显示为英文 `Tool result`、中文“工具结果”，与 assistant 输出中的 `Tool call` / “工具调用”明确区分。
- 中文角色文案使用完整语义名称：system 为“系统提示词”、user 为“用户消息”、assistant 普通文本为“助手消息”；不使用容易与分组或产品身份混淆的“系统 / 用户 / 助手”短标签。
- Tool name pill 不设置最大宽度且不截断，必须完整显示；Tool call ID 在界面展示时移除开头的 `call_` 前缀，底层消息数据保持原始 ID。空间不足时优先压缩 summary，Tool call ID pill 仍允许截断以保护窄侧栏和手机 Web 布局。
- Tool Result 与 Tool Call 的收起行在 summary 前显式显示内容自适应宽度的数据方向标签：Tool Result 使用 `OUTPUT`（中文“输出”），Tool Call 使用 `INPUT`（中文“输入”）。方向标签使用 `text-ui-sm` 与主要文字颜色并按实际文字宽度收缩，随后以标准紧凑间距显示第三等文字颜色的向右箭头图标，再进入次要层级的 summary；不得用固定宽度在短中文标签与箭头之间制造空槽。展开后 summary 与向右箭头同步隐藏，方向标签保留且不在展开正文中重复。
- 内容区的分区标题、角色标签、消息预览、正文、思考与工具内容统一使用 `text-ui-sm`；调用摘要 Header 的序号、pill 与元数据继续使用 `text-ui-xs`。
- Tool Result 的 output 若为 `{ type: "error-text", value: string }`，收起摘要和展开正文必须直接使用 `value`，不得把错误包装对象序列化成 JSON。收起摘要继续折叠连续空白，展开正文保留错误文本的原始换行。
- Tool Result 的 output 或 Tool Call 的 input 为 `error-text` 时，收起行在 INPUT / OUTPUT 前显示 `CircleAlertIcon`，图标与方向标签使用 destructive 错误色，普通工具 payload 不显示该状态。展开后的错误 payload 使用 `rounded-lg bg-destructive/10` 无边框错误容器与 destructive 文字色包裹；工具名、调用 ID、复制和溢出展开行为保持不变。标准化 model-io 中字符串 TOOL 消息的顶层 `isError` / `is_error` 必须还原为 `{ type: "error-text", value: content }`，不得在服务层映射时丢失错误状态。
- system、user 与 tool 复用同一套撑满可用宽度的透明消息布局。system 收起摘要取第一条非空行；user、assistant 普通消息与思考过程的收起摘要读取完整文本，并将换行等连续空白折叠为单个空格；tool 收起摘要取 `tool-result.output` 的完整内容并以同样方式压成单行，不使用工具名代替摘要。各摘要均在单行内截断，最右侧显示 Chevron；tool 摘要右侧另依次使用两个独立 outline pill 展示 `toolName` 和 `toolCallId`，单个字段缺失时只隐藏对应 pill。展开时头部隐藏摘要、方向右箭头、`toolName` 和 `toolCallId` pill，保留方向标签并展示“本次调用耗时 · 完整日期时间”；工具名与 ID pill 移到展开内容顶部的第一行，payload 从下一行开始。完整 ISO datetime 通过悬停提示保留。这里展示的是 model-io 调用级 `durationMs` / `startedAt`，不是单条消息自身的耗时或时间。Chevron 按钮容器使用 `size-5`，图标使用 `size-3`。展开行在 Chevron 左侧显示 `icon-sm ghost` 复制按钮，收起时隐藏；复制操作使用原始完整数据。展开正文中 system / user 展示完整消息，tool 展示完整 payload，不重复“工具结果/工具调用”标题。正文作为容器内部普通内容展示，不使用卡片背景、圆角或外边距；默认使用 `max-h-64 overflow-hidden`，不允许内部滚动。内容超过 256px 时底部增加 72px CSS mask 渐隐，并在 `bottom-3 left-1/2` 水平居中悬浮 `sm outline`“展开”胶囊；该 pill 使用 `bg-surface/90` 作为无 backdrop-filter 时的回退，支持时切换为 `bg-surface/70 backdrop-blur-md` 高斯玻璃背景。溢出正文使用 `pb-14` 预留空间，让正文末行与悬浮按钮保持标准间距；无溢出操作时仅使用 `pb-2`。展开后移除最大高度与 mask，居中按钮切换为“收起”；展开只影响当前消息，消息行收起时恢复限高状态。
- assistant 输出不再使用 `ASSISTANT` 分组标题或嵌套 surface 卡片。思考过程、assistant 消息与每个 assistant tool call 都直接渲染为独立的共享 Grid 消息行，与 system / user / tool result 使用相同的单行摘要、整行展开、溢出截断和悬浮胶囊操作。assistant tool call 收起时将 `toolCall.input` 序列化为压缩单行摘要，并以两个独立 outline pill 展示工具名和 tool call ID，避免摘要与工具名标签重复；展开时仅以透明、可换行的正文样式显示完整格式化输入参数，不重复“输入”标题、工具调用标题、背景卡片或圆角。
- `INPUT > TOOL` 与 `OUTPUT > ASSISTANT > Tool` 的收起行已经承载工具名（Assistant Tool 同时承载 ID），因此展开区不得重复渲染“工具结果/工具调用 + 工具名 + ID”标题，只保留 Output 或 Input 有效载荷卡片。
- 消息摘要右侧 Chevron 使用 `ml-1.5`，与工具 tag 或消息预览保持 6px 的控件间距。
- 展开卡片外层使用 `p-3`，四边统一保留 12px 间距。
- 左侧竖线移除后，标题、消息行和展开正文恢复 12px 左侧 padding：标题与正文使用 `px-3`，消息触发区使用 `pl-3` 并由独立操作列控制右侧空间；展开正文按溢出状态使用 `pt-0 pb-14` 或 `pt-0 pb-2`。展开正文的文本与工具 payload 仅在展示时执行 `trim()`，去除首尾空白但保留中间换行；复制仍使用未经裁剪的原始数据。
- system / user / assistant 等消息角色行统一使用 `min-h-8`（最小 32px），左侧角色标签与右侧内容分别在首行内垂直居中；展开或多行内容可自然增高。
- 颜色严格使用 `DESIGN.md` 语义 token：主背景 `background`、展开态 `selected`、
  内容层 `surface` / `card`、分隔线 `border` / `card-border`，只在真实错误状态使用 `destructive`。
- 模型调用级 `record.error` 显示在对应 Call Card 的 INPUT / OUTPUT 之后，使用 `rounded-lg`、无边框的 `bg-destructive/10` 半透明错误背景；左侧使用 `CircleAlertIcon`（`size-4 text-destructive`）并与标题首行对齐，错误名称与消息使用 `text-destructive`，stack 使用同色弱化层级。错误块不得使用描边或普通 surface 背景。
- 角色主要依靠紧凑文字标签区分，不为 system / user / assistant / tool 铺设不同的大面积背景色。
- 消息行不显示左侧竖线；SYSTEM 使用次要文字色 `text-foreground-subtle`，USER 使用 `--color-trajectory-user` 蓝色，ASSISTANT 使用 `--color-trajectory-assistant` 青绿色，思考过程使用 `--color-trajectory-reasoning` 紫色，TOOL CALL 使用 `--color-trajectory-tool-call` 琥珀色，TOOL RESULT 使用 `--color-trajectory-tool-result` 青蓝色。彩色角色标签统一使用专用 token 的 `/80`；五个专用 token 必须分别定义默认 Light、Dark、Zai Light、Zai Dark 值，不得借用 success、warning 或 destructive 状态色。思考过程继续复用 USER 的整行摘要、点击展开、正文限高、复制与“展开/收起”结构，不使用独立卡片。
- 同一个 Call Card 内的全部输入与输出消息行使用连续序号绘制斑马纹，Input 与 Assistant 输出之间不得重新计数。首行保持透明，交替行使用 `bg-surface/30`；展开内容继承所属消息行背景，调用 Header 与分割线不参与交替，消息行不添加 hover 背景或颜色过渡。
- 窄侧栏与手机 Web 保持单列结构；技术载荷必须换行且不得撑宽面板，悬浮胶囊操作允许在窄宽度下保持紧凑。

## 长列表虚拟化

### 内容搜索

- Header 操作区在“自定义展开”左侧提供搜索按钮；点击后在调用统计信息下方显示内联搜索栏，包含输入框、`当前/总数`、上一条、下一条与关闭按钮。打开时聚焦输入框；Enter 前进、Shift+Enter 后退、Escape 关闭，不覆盖应用全局 `Cmd/Ctrl+F`。
- 搜索只在 UI 内对当前已加载的轨迹投影建立索引，不新增服务端 API、RPC、协议字段或持久化。范围包括 system、user、reasoning、assistant 正文、Tool Call input、Tool Result output、tool name 与去掉 `call_` 前缀后的可见 ID；时间、token、模型与角色标签不参与。匹配为大小写不敏感的字面量搜索，查询与正文中的连续空白统一视为单个空格，并保留原文 offset 用于高亮。
- 普通已挂载命中使用 `--color-find-highlight`，当前命中使用 `--color-find-highlight-active`。当前命中若位于折叠消息或正文限高区域，搜索 reveal 状态必须临时强制展开消息与完整正文；该状态不得写入用户 expansion override，切换结果、清空或关闭搜索后恢复搜索前状态，用户原本手动展开的内容保持不变。
- 虚拟列表定位分两阶段：先按 `callIndex` 调用 virtualizer 定位并挂载 Call，再在搜索 reveal 展开并重新测高后的下一帧定位具体文本 Range。定位请求使用稳定 match key 去重，避免 ResizeObserver 或虚拟行重挂重复滚动。上一条/下一条首尾循环；被截断的轨迹只搜索当前已加载记录，并继续显示现有截断提示。

- 轨迹按 Call Card（一次模型调用）做动态高度虚拟化，不拆分卡片内部的 INPUT / OUTPUT 与消息行。滚动容器仍是面板现有的原生 `overflow-y-auto` 容器。
- 虚拟项使用实际 DOM 高度测量，展开、收起或“显示全部”造成高度变化后必须重新计量；上下各保留少量 overscan，避免快速滚动时闪白。
- 外层虚拟画布继续提供共享的三列 Grid。不可见的零高度角色标签测量行参与第一列 `max-content` 宽度计算，确保虚拟项挂载数量变化时，SYSTEM / USER / ASSISTANT / TOOL 的内容列不会横向跳动。
- 单条消息的展开状态必须由稳定消息 key 保存于 Call Card 之外；虚拟项离开视口被卸载再挂载后，仍恢复离开前状态。批量展开命令仍通过共享 command version 覆盖旧的单行状态，不允许每行用 effect 二次同步。

```text
native scroll viewport
        │ scrollTop / viewport height
        ▼
Call Card virtualizer ── overscan ──> visible Call Cards only
        │                              │
        │ dynamic measurement          └─ INPUT / OUTPUT / message rows
        └─ total canvas height

row toggle ──> keyed expansion state ──> survives Call Card unmount/remount
bulk toggle ─> command(version + 1) ────> supersedes older keyed state
```

## 多端

- 读盘收口在服务层，桌面端读本机 `~/.zcode/cli`，手机远控经 RPC 读远端 host 的同名目录。
- 入口在桌面与手机 Web 均可用（移动端不隐藏）；无记录时给出空态提示。

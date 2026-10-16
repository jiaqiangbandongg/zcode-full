# 定时任务主视图入口

# 目标

定时任务管理从设置页分区迁移为 workspace 主视图入口。用户在左侧点击「定时任务」后，左侧仍保持 workspace 队列 / 任务列表，右侧主内容切换为定时任务管理页。

# 产品语义

- 定时任务属于当前 workspace 的工作流管理，不属于全局设置。
- 打开定时任务不创建 Settings tab，不改变左侧队列列表，不卸载 workspace sidebar。
- 选择任务、新建任务时，右侧主内容回到聊天或对应 workspace 主视图。
- 定时任务页继续复用现有 `AutomationsSection`，按 `workspaceIdentity?.trim() || workspacePath` 加载对应 workspace 的 automations。

## 立即运行语义

- 「立即运行」是独立的 manual run，不是把 cron 的 `next_run_at` 改成当前时间；不得修改原计划的 `next_run_at`、`run_count`、启停状态或生命周期。
- 定时调度实际触发和用户点击「立即运行」产生的 prompt，都必须在用户消息气泡上方展示与左侧任务列表一致的时钟图标和「由定时任务发送」来源文案。消息级来源以持久化 `userInput.sourceCommandId` 对应的 automation runId 为准：`automationId:scheduledAt`（`trigger=schedule`）与 `automationId:manual:uuid`（`trigger=manual`）均展示；同一 cron 会话内的普通手动输入不展示。该标识由 row 自身推导，桌面 continuous 与手机 Web replayable 恢复保持一致，不读取 task 上粘性的 `cronAutomationId`。
- 当前 desktop host 必须在 `runAutomationNow` RPC 内直接恢复或创建目标会话并提交 prompt。正常路径不经过 scheduler 的轮询、wake 或二次认领；RPC 成功只表示 prompt 已被 host 接受，可能仍处于 runtime queue。
- `runAutomationNow` 必须在认领前确认当前 service 已注入 manual dispatcher；dispatcher 缺失时直接失败，
  不创建 `automation_runs` 台账、不设置 `running` claim。能力确认后 manual run 才写入台账；若 host 在
  认领后的派发过程中崩溃，scheduler 只可在认领超时后回收该台账作为故障恢复，不得影响原 cron 节奏。
- manual run 的 automation `running` single-flight 锁必须覆盖 queue 等待和实际 turn：`sendPrompt`
  admission 后继续持有，直到对应 `runId/inputId` 的 `turn.completed` / `turn.failed` 终态才释放。
  同一 automation 在锁持有期间再次 Run Now 必须拒绝，不得向同一 task 追加第二条 queued prompt。
- scheduler 仅用于 stale manual run 的故障恢复。恢复派发收到 host `cron-dispatch-result ok` 时只回写
  `automation_runs.dispatch_status = dispatched`，不得释放 manual claim；host 已建立的 terminal outcome
  subscription 与 heartbeat 接管后续生命周期，并在真实 turn 终态释放。只有 dispatch result 失败时
  scheduler 才立即释放 claim。
- `runAutomationNow` 管理 RPC 必须显式返回 `queued` 或 `duplicate`。只有本次成功创建并派发 manual run
  的 `queued` 才展示「已触发」成功提示；single-flight 拒绝的 `duplicate` 展示「上一条正在运行」
  信息提示，但不刷新列表、不得重复展示成功提示。禁止把无内容的 RPC success 同时解释成这两种状态。
  UI 只在本次 RPC 请求尚未返回时使用瞬时操作态防止同步重入；请求返回后立即恢复「立即运行」入口，
  不根据运行历史持续禁用或轮询入口状态。活动 run 的重复触发统一交由 host single-flight 返回
  `duplicate`，并由 UI 展示上述信息提示。
- terminal outcome 回写或 claim 释放失败只记录独立错误，不得覆盖原始 dispatch / turn 结果；host
  存活且 run 仍在 queue / running 时必须定期续租 `claimed_at`，避免长任务被 stale 误释放；host
  崩溃后续租停止，再依赖 stale claim 回收。
- 会话内创建的定时任务若目标 session 当前未激活，直接派发前必须先恢复该 session，再应用任务保存的权限、模型和思考强度。
- UI 手动创建且未绑定会话的任务，执行时新建的空 session 必须使用 deferred persistence；首条 `sendText` admission 先持久化 session 主记录，再写带外键的 `session_input`，禁止用延时规避创建/首发提交顺序。
- automation 派发创建或恢复带 `automationId` 的执行 task 时，必须通过 session
  `toolDenylist: ["CronCreate", "CronUpdate", "CronDelete"]` 在 runtime 工具注册边界隐藏
  automation 写工具，只保留只读 CronList。不要把 runId 写入 task meta：
  runId 属于 `automation_runs` 台账，写进 task meta 会污染 UI 立即执行和绑定会话恢复路径。
- 对已经 active 的绑定会话，`session/resume` 不会重建 runtime；host 派发 prompt 时还必须把
  `automationId` 随本轮 `sendText/sessionSend` 透传。CLI 在该 turn 的 provider 请求中临时移除
  `CronCreate/CronUpdate/CronDelete`，让模型无法递归创建、自改或自删；`activeAutomationId` 与
  `automation-port` 的 CronCreate 拒绝逻辑继续作为伪造创建调用的兜底，命中时不得调用
  `automation/create`。turn 结束后恢复原工具面，普通用户输入不受影响。
- Highspeed 期间仍允许用户调用 `CronCreate`；创建记录保存会话稳定 `modelSelection`，不保存当前 Turn
  指向加速卡内建 Provider 的临时选型。后续定时执行以 `automationId` 为最终门禁，使用记录中保存的
  provider/model，并忽略误传的加速 `modelSelection` / `modelExecution`，因此不会抽取、复用或安装
  Highspeed 卡。
- 若目标 session 正处于 active/routing busy，turn-scoped `toolDisallowlist` 必须随 automation 输入进入
  deferred queue item，并在 replay、重排和 drain 后原样传给 `startPromptTurn`；不得只在立即启动或
  `steerTurn` fallback 路径隐藏 automation 写工具。
- 已归属定时任务的 task（`cronAutomationId` 已写入 task meta）后续普通用户输入也必须随
  `sendText/sessionSend` 下发 turn-scoped automation 写工具隐藏规则，防止下一次 model step 绕过
  当前任务的归属边界继续创建、自改或自删。

```text
runAutomationNow RPC
  -> INSERT manual automation_run（不触碰 automation.next_run_at）
  -> desktop host resume/create task（新 session 使用 deferred persistence，automation 执行 task 隐藏写工具）
  -> apply mode/model/thought
  -> sendPrompt（本轮携带 automationId；可能 queued）
  -> ACK: 回写 dispatched，继续持有 running claim
  -> queue drain / turn start
  -> turn terminal: 回写 outcome，按 workspaceKey 释放 manual claim

scheduler stale recovery
  -> host sendPrompt ACK / cron-dispatch-result ok
  -> scheduler 只回写 dispatched，不释放 claim
  -> host heartbeat + terminal subscription
  -> turn terminal: host 释放 manual claim

busy session
  -> enqueueDeferredInput(toolDisallowlist=[CronCreate,CronUpdate,CronDelete])
  -> queue replay / drain
  -> startPromptTurn(toolDisallowlist=[CronCreate,CronUpdate,CronDelete])
  -> provider automation tools 只保留 CronList

第二次 Run Now（首个 run 未终态）
  -> repo.runNow 看到 running=1
  -> RPC 返回 duplicate / no-op，不创建第二条 manual run
  -> 展示“上一条正在运行”信息提示，不展示“已触发”成功提示
```

# UI 边界

- 顶层功能名统一为英文 `Automations`、简体中文「自动化」；「定时任务」只表示 Scheduled tasks 子类型，不得再用于侧栏入口或主视图标题。该边界使「全部 / 定时任务 / 闲时任务」三个筛选项与其上层容器语义保持区分。
- 主视图与编辑页内容容器统一复用 Settings 的共享框架内容令牌：`max-w-4xl`、响应式横向 padding、`pt-0` 和统一的底部留白；Automations 列表、定时任务编辑、闲时任务编辑与 Settings 各功能必须保持相同的内容列宽、左右起点和顶部基线。外层 workspace shell 继续保留桌面拖拽区、稳定滚动槽以及现有 `max-w-5xl` 响应式 route frame；Settings 对齐由内层共享内容令牌负责，禁止各 Automations 子页面再分别定义内容列宽和 padding。
- 空首页以 Figma `⚫️ Z.ai - Zcode` 节点 `4798:2443` 为视觉事实源。桌面内容列的可见宽度为 802px；标题说明之后依次是 226px 空状态卡、44px 保持唤醒提示条、闲时任务模板和定时任务模板。空状态卡与提示条间距 16px，各主分区间距 32px，禁止把提示条移到空状态卡上方。
- 空状态卡使用 16px 圆角和弱边框，文案与操作整体垂直居中。定时任务的 `Create via chat` 分体按钮与闲时任务创建按钮统一使用主按钮层级，Zai Dark 下为白底黑字，Zai Light 下按主按钮语义反转；左侧点击直接进入会话创建，箭头仅打开创建方式菜单。定时任务主按钮的文案在默认、hover 与菜单展开态都使用完整不透明度的 `text-primary-foreground`，不得通过降低默认透明度削弱可读性；outline 创建按钮继续保留既有的默认弱化层级。
- 闲时任务模板与定时任务模板均按两列展示 Client Scenes 下发的当前目录。两类模板卡统一使用“标题行 / 可伸缩描述 / 底部时间信息”的三段纵向结构；定时模板的周期时间必须位于描述下方，不得拼接在标题行。模板卡统一使用 `114px` 最小高度、12px 圆角、12px 内边距和 16px 栅格间距；桌面双列布局中，同一行的卡片必须拉伸到该行内容最多卡片的高度，使两行与三行描述的卡片底边对齐，不得为此写死全局最大高度；手机端降为单列，文案可换行但不得挤出卡片。
- Client Scenes 模板目录加载期间，当前可见的闲时 / 定时模板区保留分区标题，并分别显示默认 4 张模板卡骨架：桌面双列共两行，手机单列自然排为四行。骨架复用模板卡的 `114px` 最小高度、圆角、描边和栅格间距，不用整页 Spinner 替换已有任务与手动创建入口；请求成功、业务失败或网络失败后结束骨架态，再按真实目录或既有失败降级规则渲染。
- Figma 的像素值必须映射到 `DESIGN.md` 的语义颜色、`text-ui-*` 字号和已有按钮/菜单基础组件；不得为了单一深色截图引入 raw hex、`text-[…]` 或只在 Zai Dark 下成立的透明白色样式。
- 自动化主视图、定时任务创建/编辑、运行历史与相关菜单统一使用 UI 字号 token：既有 `text-ui-xs` 提升为 `text-ui-sm`；历史 `text-base` / `text-sm` / `text-xs` 分别迁移为 `text-ui-lg` / `text-ui-base` / `text-ui-sm`；`16px` / `14px` / `13px` / `12px` 分别迁移为 `text-ui-lg` / `text-ui-base` / `text-ui-base` / `text-ui-sm`，小于 `10px` 才使用 `text-ui-xs`。禁止继续新增 arbitrary UI font size。
- 自动化首页的已创建任务卡片、闲时任务模板和定时任务模板中，标题之外的指令说明、调度信息、运行次数与“最早可用时段”也统一使用 `text-ui-base`；会话内创建成功卡片的“去到定时任务”按钮同样使用 `text-ui-base`，并以纯文字 `text-foreground` 高亮展示，不在文案后附加箭头或其他图标。按钮文字热区使用上下 `6px`、左右 `12px` 的内边距，兼顾紧凑密度与中英文点击区域。禁用态继续通过整体透明度表达不可用。这些文字不得因辅助信息角色降为 `text-ui-sm` / `text-ui-xs`，层级只通过字重与语义色表达。
- 定时任务指令工具栏中的项目、权限和模型触发器统一使用 `text-ui-base`，与会话 composer 的主要操作控件保持一致。
- 定时任务指令工具栏选中完全访问等高权限模式时，权限图标与文案必须和会话 composer 一样持续使用 `text-warning`，hover / 菜单展开态不得闪回普通前景色；其它权限模式保持默认文字色。
- 定时任务设置页的状态胶囊固定为 `32px` 高；状态圆点实际尺寸为 `6 × 6px`，并居中嵌套在 `20 × 20px` 的图标 frame 中。文字、状态语义色与现有水平 padding 保持不变。
- 已暂停的定时任务卡片中，执行时间与运行次数统一使用 `opacity-40` 弱化，明确表达它们当前不会继续推进；暂停状态标签及恢复操作保持正常可读性。
- 定时任务卡片不展示内部重试队列状态或 `nextRunAt` 绝对/相对时间。失败与已完成任务均在状态旁展示可视化 cron 摘要，无法安全可视化时展示“自定义”；重试次数与退避过程保留在运行历史和日志中。
- 已完成任务卡片保持固定弱化透明度，鼠标悬停时不得恢复透明度或切换卡片背景；键盘焦点与进入详情能力保持不变。
- 已完成闲时任务的更多菜单只保留「删除」时，不显示删除项上方的分割线；分割线只用于隔开前置任务操作与 destructive 操作，禁止在单项菜单中形成无语义顶线。
- 卡片 cron 摘要后可追加 `· 下次运行时间`：`nextRunAt` 必须严格晚于当前时间才展示，30 天内使用相对时间，超过 30 天使用绝对时间；已过期或缺失的时间不渲染分隔点及时间文案。
- UI 创建的定时任务进入编辑页后继续使用原有可编辑调度控件。会话内创建且无法按 UI 规则回显的任务显示无图标、无 `nextRunAt` 的只读“自定义”行，并提供删除按钮；删除后进入 UI 的“添加调度”流程，重新设置并保存时以新 UI cron / scheduleRule 替换旧会话调度。
- UI 创建任务的「自定义重复」支持分钟、小时、天、周、月、年。重复频率使用可直接编辑的整数输入，而非下拉选项；输入控件范围为 `0–200`，但只有 `1–200` 的正整数可以确认，避免把无执行语义的 `0` 保存为 cron / scheduleRule。输入框禁用浏览器原生 spinner，右侧使用垂直排列的上/下步进按钮并采用输入控件的边框与 hover 语义色，达到桌面与手机 Web 一致的视觉和点击反馈。桌面端与手机 Web 复用同一控件、范围及确认校验。所有自定义重复的真实间隔以 `scheduleRule` 为准；cron 只承担兼容展示与旧链路候选。分钟超过 `59`、小时超过 `24`、天超过 `31`、月超过 `12` 时，必须分别降级为合法的每分钟、每小时、每日、每月兼容 cron，绝不能因 cron 单字段范围缩小 `1–200` 的产品语义。
- 可编辑调度栏的首个频率选择器在「每小时 / 每天 / 每工作日 / 每周 / 每月 / 自定义」任一已选状态下都必须使用完整不透明度的 `#363636` 背景，与时间、分钟等同层选择控件一致；不得再用透明度或主题浅色与输入区背景混色，也不得因频率值或分支不同退回透明背景。调度栏内所有 tag 统一为 `20px` 文本行高、上下各 `1px` padding（总高 `22px`）和 `8px` 圆角；频率 Select 不得保留透明 border 或 padding-box 背景裁切导致可见背景向内缩小。hover 与展开态使用 `#404040` 提升反馈。
- 调度语句中位于 tag 之间的连接词（如「于」「第」「分钟」）使用与 tag 内文字一致的 `text-foreground`、`text-ui-base` 和 `20px` 行高，禁止单独降为二级文字色；「每周」后的星期多选 tag 也必须使用同一 `text-foreground`，不得以 raw 高亮色强化已选星期，选中状态只通过下拉勾选与菜单背景表达。星期下拉项统一采用左侧文案、末尾 `16px` 状态位的菜单布局，选中勾必须位于行末，未选中项保留同宽空状态位以避免布局跳动；时区与完整调度摘要仍保持 `text-foreground-subtle`，维持信息层级。
- 「添加计划」展开的频率菜单项在鼠标 hover 与键盘高亮时统一使用 `bg-menu-hover` 和主前景色，Light / Dark 均须提供清晰反馈；禁止使用 `bg-white/5` 等只在深色背景可见的 raw 透明色覆盖共享菜单语义样式。
- 时间选择浮层中的小时与分钟选项统一遵循菜单交互语义：hover 和已选状态都使用 `bg-menu-hover` 与 `text-foreground`，Light / Dark 下必须与频率 dropdown 的 hover / 选中项一致；禁止将已选时间渲染为 `bg-primary text-primary-foreground` 的黑色主按钮。
- 时间、频率、权限、模型等可操作浮层打开时必须位于辅助 tooltip 之上，tooltip 不得覆盖选项或阻挡 pointer 操作。该约束由共享 Popover、Select、Dropdown Menu 与 Context Menu 的浮层层级统一保证，不在 Automations 页面逐个写局部 z-index。
- 创建方式与任务操作 Dropdown 打开后必须从首帧开始持续显示标准 `shadow-md`；菜单根节点获得键盘焦点时不得被全局 focus reset 清除阴影，hover item 只改变选项背景，不得成为阴影出现的触发条件。
- 定时任务调度输入区在「添加计划」、普通调度、自定义 tag 和只读调度任一状态下都固定为 `36px` 高，并与 Task title 一样使用全局 Input 的 `border-input-border`、hover `border-input-border-hover` 和 focus `border-input-border-focused` 描边语义。闲时任务页的 `Soonest available` 只读输入、Task title 和 Instructions 复合输入也必须复用同一套描边语义，不得保留透明边框。可编辑态第一个 tag 距输入区左侧 `8px`；tag 增加上下各 `1px` padding 后，总高为 `22px`，在 `36px` 输入区内垂直居中。1px 描边必须通过内部 padding 校正，不得改变输入区总高度。内部控件必须保持单行，调度摘要作为唯一可收缩区域并在空间不足时截断；禁止使用 `min-height`、`flex-wrap` 或 `basis-full` 让新增 tag 把输入区撑高。
- 自定义调度确认后的频率、重复周期与时间三个 tag，内部文本统一使用 text/primary 对应的 `text-foreground`，圆角统一使用 `rounded-lg`（8px）；禁止重复周期单独写死 `#F8F8F8` 等 raw 色值，或让两侧控件退回更小圆角，避免三段 tag 的颜色和外形不一致。尾部 chevron 仍可使用弱化前景色。
- 主列表卡片与会话内 `CronCreate` 成功卡片只展示能够被现有 UI 稳定可视化的调度摘要。固定月日 cron 存在单次日期与年度重复歧义，无法识别或异常的 cron 也不能安全解释，这两类统一展示本地化“自定义”，不得猜测为“每年”或直接暴露原始表达式。
- 定时任务列表、创建/编辑、运行历史、菜单、Toast 与模板文案必须通过 `useZCodeIntl` 获取，并跟随系统设置中的简体中文 / English 选项即时切换。已保存任务的 title / prompt 属于用户数据，不因语言切换被翻译；只有尚未被用户修改的本地化默认值可以随 locale 更新。
- 调度菜单选择「自定义」时立即打开独立 `CustomRepeatDialog`；确认后调度栏只展示紧凑频率摘要，并允许点击摘要再次编辑。首次打开时取消或关闭不得提交自定义调度，编辑已确认调度时取消则保留原值。
- 自定义重复的间隔下拉最多同时展示 8 个选项，更多选项在面板内部滚动。弹窗按 Figma 节点 `4727:3803` 使用 400px 宽、12px 圆角、20px 内容边距与纵向间距、36px 控件和操作按钮。
- 自定义重复确认后的调度栏使用三列布局：频率摘要靠左、时间选择严格居中、删除操作靠右；不得用两端内容宽度决定时间控件位置。
- 按小时重复的调度摘要只展示间隔和分钟偏移，例如「每 2 小时的第 00 分」；不得拼接 builder 中仅供其它频率使用的默认小时值（如 `09:00`）。
- 定时任务编辑页的必填项告警只在用户明确点击「保存」或「立即运行」后展示。清空标题或指令、删除计划等正常编辑动作只更新草稿和未保存状态，不得立即显示 destructive 描边；删除计划还必须清除该计划已有的告警状态。仅缺少必填内容时，「保存」与可运行状态下的「立即运行」仍可点击以触发校验；保存中、模型配置未就绪、项目不可用或任务已有活动运行等操作性禁用条件继续生效。
- 新建或编辑定时任务产生未保存变更后，返回前必须确认丢弃；未产生变更时直接返回。列表卡片删除、编辑页删除、定时任务与闲时任务的未保存返回弹窗必须统一复用 Automation confirmation presentation，仅按钮文案、颜色与动作语义不同。该 presentation 以 Figma `⚫️ Z.ai - Zcode` 节点 `4582:1605` 为视觉事实源：桌面宽度固定为 `448px`、最小高度 `180px`，窄屏收敛到 `calc(100vw - 32px)`，使用 `20px` 内边距、`rounded-2xl`、`20px` 内容间距、`bg-popover/98` 与无边框阴影层级。标题使用 `text-ui-lg font-semibold`，正文使用 `text-ui-base leading-6`；正文最多展示 3 行，超长任务标题或连续文本必须允许断行并在第 3 行省略，不得继续增高弹窗。底部 `36px` 高按钮右对齐，操作区距弹窗右侧和底部均固定为 `20px`；弹窗最小高度产生的额外空间必须留在正文与操作区之间，不得被 Grid 行拉伸成额外底距。未保存返回操作固定为「取消 / 丢弃」，丢弃使用 destructive 主按钮，不再提供保存入口；destructive 按钮文字必须使用 `text-destructive-foreground`，且 Zai Dark 下该语义色固定解析为白色。Automation confirmation 的按钮只展示文字，不展示 glyph 或 `esc` / `⏎` 键盘提示；该规则不改变其他共享确认弹窗。指令输入区最多展示 4 行，超出后仅输入区内部滚动，底部设置工具条保持固定。
- 定时任务与闲时任务设置页的返回入口共用文本型交互：默认使用 `text-foreground-subtle`，hover、键盘聚焦与按下时仅将图标和文案提升为 `text-foreground`；点击热区可以保留内边距，但禁止出现 hover / focus 背景填充。
- 定时任务与闲时任务设置页的字段标题与下方输入、调度或复合组件之间统一使用 `6px` 垂直间距。字段容器必须使用纵向 flex + gap，禁止依赖 `space-y` 给行内 label 添加 margin，避免字体行盒使实际可见间距缩小。
- 闲时任务指令区下方的无人值守说明属于中性信息，不使用橙色警告语义。说明行在字段默认纵向间距之外额外增加 `4px` 上间距，与 Instructions 复合输入拉开层级；前置图标统一为 16px 圆形信息图标，放在 20px 图标位中；图标与文案都使用 `text-foreground-subtle`，文案使用 `text-ui-base`。
- 闲时任务以非完全访问权限提交时展示的权限建议属于中性、非阻塞提示，不得使用橙色警告三角形。Toast 使用 Lucide `Info` 圆形提示图标，图标使用 `text-foreground-subtle`，正文继续使用标准前景色，并在页面顶部居中展示；该规则只调整权限建议的消息语义，不得削弱真正的 warning Toast。
- 定时任务与闲时任务中的 Coding Plan 升级提示、定时任务手动运行提示，同样在页面顶部居中展示；操作按钮、关闭能力和自动消失时间保持各自业务配置。
- 自动化主视图内触发的所有 Toast 优先以 Automations `main` 区域而非整个窗口作为横向居中基准。Toast 继续 portal 到 `body`，避免被主视图滚动容器裁切；区域宽度变化、窗口 resize 或布局滚动后必须重新读取锚点边界。锚点缺失或展示期间卸载时必须立即回退到全窗口顶部居中，Toast 仍需挂载并正常启动自动消失计时器，禁止因区域定位增强导致消息不可见或常驻内存。顶部偏移、堆叠和动画保持全局 Toast 契约。

```text
窗口
┌────侧边栏────┬──────── Automations main ────────┐
│              │              Toast               │
│              │                │                 │
│              │          main 横向中心            │
└──────────────┴──────────────────────────────────┘

main resize / layout scroll
            │
            ▼
getBoundingClientRect()
            │
            ▼
body portal 更新 fixed left
```

- 新建定时任务与新建闲时任务都允许切换到运行历史 tab 查看空态；不得因为任务尚未保存而禁用历史入口。新建态进入历史后隐藏创建按钮，且因为尚无任务标识不得发起历史请求；切回设置后恢复创建操作。设置内页的「创建定时任务 / 创建闲时任务」提交按钮统一为纯文本按钮，不在文案前展示 Play 或其他图标。
- 定时任务运行历史直接展示加载态、错误态、空态或历史表格，不在内容顶部重复展示「仅在电脑唤醒时运行」的辅助说明；保持唤醒规则只在设置入口和对应控制项附近说明。
- 定时任务与闲时任务没有运行历史时必须复用同一个空态容器，以 Figma `4617:1176` 与 `4866:3110` 为事实源：容器最小高 `226px`，使用页面背景、默认卡片边框和标准卡片圆角，提示文案水平与垂直居中，并使用 `text-ui-base text-foreground-subtle`。禁止定时任务退回透明的纯文本留白。
- Automations 首页的「定时任务 / 闲时任务」tabs 参考插件市场的公开/个人 tabs：使用独立 `rounded-full` pill、`px-3 py-1` 与 `text-ui-base font-medium`；选中态为 `bg-selected text-foreground`，未选中态为二级文字并在 hover 使用 `bg-hover`。定时任务与闲时任务详情页共用的「设置 / 历史」tabs 则参考 Hooks scope tabs：容器固定 `h-8 rounded-full bg-surface p-0.5`，选项固定 `h-7 rounded-full px-2.5`，选中态使用 `bg-background text-foreground`，未选中态保持透明。中文名称统一为「设置 / 历史」，英文统一为 `Settings / History`。
- 定时任务与闲时任务的 Instructions 复合输入统一复用同一个结构组件，不得分别维护尺寸。父级容器不显示边框并使用 `bg-surface`；textarea 自身使用 `rounded-xl border border-input-border bg-input`，承担 hover、focus 与 invalid 描边状态。正文默认且最小为 `116px` 高并使用 `12px` 内边距，底部工具条固定 `40px` 高并使用 `6px` 内边距（`h-10 p-1.5`）。桌面端与手机 Web 均禁止手动 resize，内容仍自动增高到约 7 行，超过后在正文内部滚动；窄屏允许工具条换行并按内容增高。
- 定时任务与闲时任务的 Instructions 底部工具栏必须使用同一套控件视觉和触发态：项目、权限、模型与推理控件统一为 `h-7`、`rounded-full`、`text-ui-base font-normal`，菜单项之间统一 `gap-0`；图标与文字内部仍保留 `4px` 间距。默认无背景，hover 与菜单展开期间统一使用 `bg-hover` 并提升为主文字色。权限 trigger 与项目、模型一致按内容自适应宽度；禁止用固定最小宽度或 `flex-1` 把箭头推离文案。下拉箭头统一使用 Lucide `ChevronDown` 的原生 `24 × 24` viewBox 与 `2px` 描边，在工具栏内渲染为 14px：项目、权限使用 20px 操作位，模型、推理使用 18px 操作位；禁止在操作位内再嵌套固定 20px 包装，避免紧凑项被裁切或视觉偏小。权限选择「完全访问」/ `yolo` 后，前置图标、文案和尾部箭头必须统一使用 `text-warning`，hover 与展开态也不得退回默认前景色。菜单统一向工具栏上方展开，和 trigger 保持 `4px` 间距。Draft New 的共享 Workspace 菜单 wrapper 必须使用 `contents`，只保留内部 trigger 作为唯一视觉与布局盒，避免双层控件；普通会话项目 chip 保持原样。
- 定时任务的模型与 Think 选择必须直接复用会话 composer 的响应式触发器构成，不得在 Automations 内再维护一套常显文案或隐藏图标的变体：模型 trigger 在紧凑宽度下展示 `Package` 图标、达到 composer `sm` 宽度后展示模型身份文案与 chevron；该身份文案必须复用会话侧 `resolveV4ModelTriggerLabel` 规则，普通自定义供应商显示 `providerName/modelName`，Z.ai / BigModel 内置 family、失效值回落与窄屏裁剪继续以会话侧事实源为准，禁止 Automations 自行截掉 provider 只展示最后一级模型名。Think trigger 始终展示 `Brain` 图标，达到 composer `xl` 宽度后再展示档位文案与 chevron。Automations 的 Instructions 外框必须建立同名 `@container/composer` 查询上下文，使桌面端、普通 Web 与手机 Web 都按控件自身可用宽度切换；模型菜单、Think 档位排序、国际化文案、选中态及单档模型只读态继续由会话侧共享组件负责。Automations 仅允许保留“菜单向上展开、不恢复聊天输入焦点、模型元数据预览期间禁用”这三类页面语义差异。
- 「添加计划」使用 Lucide `Plus` 的原生 `24 × 24` viewBox 与 `2px` 描边，在 20px 图标容器内渲染为 16px；图标颜色继承当前文本语义色。
- 定时任务卡片菜单的更多、立即运行、暂停/恢复、编辑和删除统一使用 Lucide 图标的原生 `24 × 24` viewBox 与 `2px` 描边，渲染尺寸为 16px。模板卡片统一使用 12px 内边距、12px 内容与栅格间距，桌面双列、手机单列；描述和执行时间使用主题语义色 `text-foreground-subtle`。定时任务模板标题图标优先展示 Client Scenes prompt item 的可信 HTTPS `img`，以 `16px` 等比完整显示；`img` 缺失、不受信任或加载失败时，回退 Lucide `Target` / `Activity` / `FileText` / `List`，以 `16px` 尺寸和 `2px` 描边放入 20px 操作位并继承当前文字色。
- Automations 通用图标统一在 `AutomationIcons.tsx` 维护，并由 `AutomationDesignPrimitives` 对外复用；不得由各页面重复定义几何或加载裁切后的 Figma SVG / mask 资产。除下拉箭头的显式紧凑尺寸外，图标统一使用 Lucide 原生 `24 × 24` viewBox、16px 渲染尺寸和 `2px` 描边，颜色继承 `currentColor`，保证 Light / Dark / Zai 主题一致。
- 通用图标语义映射固定为：提示 `Info`、闲时 `Moon`、定时状态 `Clock`、暂停状态与暂停动作 `CircleStop`、立即运行 `Play`、继续/恢复 `CirclePlay`、编辑 `Pencil`、更多 `Ellipsis`、跳转会话 `ExternalLink`、刷新 `RefreshCw`、删除 `Trash2`；取消运行使用填充 `currentColor` 的 `Square`。页面不得用其它近似图标覆盖这些映射。
- 侧栏「自动化」按钮切换 workspace 主视图时，必须把 Automations 作为独立导航目标写入与会话共用的浏览器式前进/后退历史；从会话进入 Automations 后，顶部「后退」必须返回原会话，「前进」必须重新进入 Automations。会话创建卡片携带 `automationId` 打开详情时，该 ID 必须随导航条目保留，保证前进可恢复同一详情；推荐提示词可以携带 renderer-local 的 `automationTab` intent，前进恢复时仍应在目标 tab 实际可见的前提下切换。历史回放不得重复入栈或截断自身的前进分支。手机 `/remote` 不展示 Automations，因此不得生成此类导航条目。

```text
用户选择 task A
      |
      v
[task A] --打开 Automations--> [automations / automationId?]
      ^                              |
      |----------- 后退 ------------|
      |----------- 前进 ------------>

历史条目身份：workspaceIdentity?.trim() || workspacePath
路径执行语义：workspacePath
```

- 定时任务创建入口使用拆分按钮：左侧主按钮文案为「创建定时任务」/ `Create scheduled task`，点击后直接进入 UI 创建表单；只有点击右侧箭头才展开单项「去会话中创建」/ `Create in chat` 菜单，菜单项不展示图标。相邻闲时任务按钮使用同一动作句式「创建闲时任务」/ `Create idle-time task`，不得只展示任务类型名。
- 自动化主视图与编辑页复用共享菜单规则：Dropdown Menu、Context Menu 与 Select 浮层中的相邻选项统一保留 2px 纵向间距；创建方式、任务操作、工具栏和调度选择不得再各自覆盖为无间距列表。
- 有任务的列表顶栏在创建入口左侧保留手动刷新按钮；刷新期间图标旋转且按钮禁用。刷新操作同时重新拉取定时任务、闲时任务，以及灰度开启时的闲时可用名额，并更新时间文案基准。
- 手动新建定时任务表单里的 Project 选择器以 TabStore 为候选权威：除当前窗口左侧仍打开且可用的本地项目外，必须保留一个逻辑上的“无项目会话任务”选项。该选项展示必须与会话侧统一为「不在项目中工作」及 `MessageCircle` 图标，不得暴露 conversation backing workspace 的 `default` 目录名或使用普通 `Folder` 图标。多个 conversation backing workspace 属于同一个逻辑选项，只能绑定 service 解析出的 canonical conversation workspace；持久化遗留或测试目录产生的非 canonical conversation workspace 必须在恢复阶段清理，并在选择器边界继续合并，禁止出现两个无项目选项。backing workspacePath 仅用于模型预览、保存和派发，不作为展示文案。不得混入 `recentProjects`、已关闭/目录不可用的旧项目或远程 workspace。创建后目标不可修改；既有远程 automation 仍可查看和管理，不做数据迁移。闲时任务仍只允许绑定真实本地项目，不展示无项目选项。
- 新建表单既没有 canonical conversation workspace、也没有有效本地项目候选时，工作区选择必须收敛为 `null`，以普通弱提示引导用户先打开可用项目，并禁用创建；模型预览和提交边界均不得回退到 `defaultWorkspacePath` 或不可用目录。候选恢复后优先保留仍有效的当前选择，其次选择仍在候选中的默认目标，最后选择首个有效目标。编辑已有任务不受当前候选过滤影响，继续使用任务已持久化的 `workspacePath` / `workspaceIdentity`。
- 桌面远程 workspace 的「通过对话创建」不得绕过本地项目限制；手机 `/remote` 完全隐藏 Automations 导航和路由，陈旧路由回退聊天。
- 「通过对话创建」切回当前 workspace 的会话草稿时，输入框预填可直接发送的 Showcase“每个工作日 9 点，汇总当前项目的代码变更和待跟进事项。”，用一句话示范“周期 + 项目范围 + 任务目标”，但不得自动发送；用户可继续修改。桌面 continuous 与普通 Web 草稿使用同一预填语义，手机 `/remote` 不暴露该入口。
- 工作区选择器必须传递完整 workspace 身份，选中态、模型预览、保存和派发统一按 `workspaceIdentity?.trim() || workspacePath` 判定，禁止只传 `workspacePath` 后反查候选。它复用普通会话的工作区菜单时，定时任务项目 chip 不显示脱离项目的 `X`，但下拉菜单必须保留一个「不在项目中工作」固定项，并复用会话侧文案、`MessageCircle` 图标和选中态；conversation backing workspace 不得再作为普通项目行渲染。进入已有任务详情时也必须按 automation 的 workspaceKey 与当前 canonical conversation workspace 候选匹配恢复 purpose：匹配成功后锁定的项目字段继续展示「不在项目中工作」和 `MessageCircle`，不得退化为 `default` 与项目文件夹图标；无法匹配的历史目标才回退到普通路径名称。普通会话草稿仍保留 `X` 与「不在项目中工作」，不得为了定时任务修改全局 hover/focus 交互。
- 会话轮尾的定时任务创建卡片是本轮工具结果的最终状态投影，不是所有成功 `CronCreate` 的历史列表。
  UI 必须按 `automationId` 顺序归并成功的 `CronCreate` / `CronDelete`：后续成功删除会移除对应创建卡片，
  删除失败或取消不影响卡片；普通工具历史仍完整展示。多个未被删除的创建结果继续按创建顺序展示。
- 会话内 `CronCreate` 成功卡片点击「去到定时任务」时，必须携带结果中的 `automationId` 进入定时任务主视图；列表数据就绪后直接打开对应任务详情，而不是停留在列表。导航目标是 renderer-local 一次性状态：成功定位后立即消费；列表加载完成仍找不到目标时提示任务不存在、消费意图并停留列表，避免失效意图长期保留。该状态不得进入 relay、main 或 session realtime 状态。
- 已创建任务区最多同时展示 8 张卡片；桌面双列展示 4 行，手机单列展示 8 行，超出部分在卡片区内纵向滚动查看，不改变任务的数据加载和排序。
- 已创建任务卡片不展示所属项目名称或文件夹图标，保持标题、指令、运行状态与次数为主要信息；任务的 workspacePath / workspaceIdentity 仍保留用于编辑、执行和隔离。
- 卡片的「下次运行」时间在 1 个月内展示相对时间；超过 1 个月展示本地绝对时间，避免远期任务出现难读的超大天数。
- 已创建任务区与下方「更多灵感」之间使用整宽分割线区分内容层级；分割线使用与 Card 描边一致的 `card-border` 语义颜色，保证 Light / Dark 下层级清晰。
- 首页的「定时任务模板」来自 `clientScenesService.list()` 响应中的 `scheduled-task` scene。卡片标题取 prompt item 的当前语言 `labels`，描述和表单 instructions 取当前语言 `contents`；两种语言标题均为空的模板直接拒绝。`defaults.cronExpr` 引用同 scene 的 `options.cronExpr.items`，实际 cron 只取被引用 item 当前语言 `contents`。cron 必须同时通过 Service 合法性校验与 Automation 编辑器无损往返校验，避免模板点击后在未编辑的情况下被 builder 静默改写。底部调度文案必须由客户端现有 cron 解析与本地化展示逻辑生成，不得把服务端 `labels` 当作调度外显真源。
- 远程 cron 在模板映射阶段必须使用与 Service 最终校验相同的解析器校验；缺失引用或非法 cron 的模板不得进入卡片列表和创建链。`AutomationService` 保存前的最终校验继续保留，不能因为 UI 已过滤而删除。
- 点击模板只打开创建表单并预填 title、cronExpr 与 instructions，不创建任务、不发送消息。点击时把当前语言配置值复制为普通用户草稿；进入表单后，语言切换、Client Scenes 重新请求或后台配置刷新不得覆盖用户编辑。远程模板对象与 option/default 元数据不得写入 automation 持久化，只有用户确认后的最终表单值可以保存。
- Client Scenes 请求失败、返回业务错误、缺少 `scheduled-task` scene，或所有模板均被校验拒绝时，加载态必须结束，定时任务模板区展示本地化的「无可用模板」；手动创建、创建上限、项目候选、`workspaceIdentity?.trim() || workspacePath` 隔离和现有 Service/Repo/Scheduler 链路保持不变。
- scheduled 与 off-peak 模板通过共享 `useClientScenesResource()` 从同一份 SWR 内存缓存映射。冷缓存才显示模板骨架；已有缓存时立即展示 last-known-good 目录并在后台重验，不回退骨架。10 分钟 dedupe 窗口内的重复挂载不再请求；不轮询。重验失败保留已展示目录，首次请求失败仍按空目录降级。缓存以注入的 Client Scenes Service authority 隔离，不进入任务持久化；locale 变化只重新映射缓存内容，不发起网络请求。Desktop 窗口关闭隐藏或 Web 页面进入后台后，只有实际经历 `hidden -> visible` 才绕过去重窗口强制重验；同一 Service/cache authority 的多个消费方合并为一次请求，普通 focus 不强制失效。

```text
clientScenesService.list()
        |
        +--> pending: 当前可见模板区显示两行骨架，手动创建入口保持可用
        |
        v settled
scheduled-task 远程候选目录 -- cron contents 本地校验/解析 --> 模板卡 / 失败空目录
        |                                                   |
        | 后台刷新只更新候选目录                            | 点击时复制当前语言值
        v                                                   v
下一次进入列表                                      AutomationEditView 本地草稿
                                                            |
                                                            `-- 用户确认 --> AutomationService --> automation record
```

- 模板图标把远程 prompt item 的 `img` 解释为 Lucide canonical 名称并按名动态加载，不再发起图片 URL 请求。SVG 使用 `currentColor` 继承图标槽字色；空白值、未知名称或模块加载失败都进入本地回退。回退图标继续按远程 item id 的已知任务语义映射为 Lucide：morning/standup 使用 `Target`、risk/CI 使用 `Activity`、release/file 使用 `FileText`，其它动态模板统一回退 `List`；`imgs` 不参与图标选择，也不得为未知服务端模板临时引入页面内近似图标。
- Settings 页当前仍通过 `settingsPageConfig.ts` 暴露 Automations 分区，并直接渲染 `AutomationsSection`；该入口没有工作区主视图的 Automations `main` 锚点，因此其 Toast 必须走全窗口居中回退。若未来移除此兼容入口，再同步删除本条事实说明。
- 定时任务主视图不渲染 `WorkspaceHeader` 或草稿标题栏占位，避免出现聊天 / 项目顶部栏。
- 定时任务管理操作失败时，底层 RPC / Agent 错误只写入 UI logger 供诊断；主视图不得把原始错误以持久红色横幅或原文 toast 暴露给用户。用户侧仅显示与当前动作对应的简短本地化提示，避免重复反馈和泄露 session、command、reasoning effort 等实现细节。
- 自动化管理 UI 统一上报三个可通过 `automation_id` 关联真实运行结果的生命周期事件：手动创建接口终态 `automation_create_result`、确认立即运行意图 `automation_run_now_ck`、确认删除意图 `automation_delete_ck`。事件区域固定为 `app.automations`，列表与编辑页通过 `action_source` 区分且不得重复上报；模板创建携带配置平台下发的稳定 `template_id`，`item-*` 原值透传，不兼容或归一化为旧的无前缀本地 ID。不得上报标题、任务指令、工作区信息或完整 endpoint，自定义 provider 只允许携带 hostname；埋点失败不得中断业务流程。
- `automation_create_result`：成功时 `error_code` / `error_msg` 均为空；失败时 `error_code` 为固定枚举 `limit` / `timeout` / `network` / `auth` / `validation` / `unknown`。只在本地按已知错误码或错误模式匹配分类，匹配顺序同上述枚举；不能识别或没有错误文本时使用 `unknown`，不宣称精确根因。`error_msg` 非空原文为 `[redacted]`，空值保持空，不上传路径、URL、凭据或原文片段。
- `agent_step` 中成功完成的 `CronCreate` 工具步骤必须携带该工具结果新生成的 `automation_id`；执行中、失败、取消和其它工具不得猜测或携带该字段。该 ID 表示“本步骤创建出的任务”，不得与当前 automation 派发上下文的任务 ID 混用。
- 主视图容器使用普通 workspace 背景与受限内容宽度；桌面与普通 Web 模式保持同一布局语义，手机 `/remote` 按上面的产品边界隐藏 Automations。

```text
CronCreate(A) success  -> final cards: [A]
CronDelete(A) success  -> final cards: []
CronCreate(B) success  -> final cards: [B]
assistant turn complete -> render [B]
```

# 兼容性

- 新建与编辑定时任务的标题、调度和 Instructions 输入外框统一参考设置搜索框：采用 large 输入尺寸、`h-9`（单行控件）、`rounded-xl`、`bg-input` 与 `border-input-border`，并继承标准输入的 hover/focus 边框状态。标题与 Instructions 内容使用 12px 内边距（`px-3` / `p-3`）；Schedule 保留 8px 紧凑内边距及原有删除操作位。复合输入内部工具栏和调度标签继续保留各自的紧凑层级。
- Schedule 行内的频率、日期、时间、自定义周期等子菜单触发按钮统一使用 `rounded-full` pill；展开后的菜单容器与菜单选项继续遵循标准 menu 样式，不改为 pill。

- 桌面端 `continuous` session 主链路不受影响；该改动只切换 UI 主视图，不修改 stream、snapshot、queue 或 owner command。
- 手机 Web 远控不展示 Automations，不新增独立 runtime、host 或远控业务状态。
- 远程 workspace 的存量任务继续按 `workspaceIdentity?.trim() || workspacePath` 隔离；本次不新增远程任务。

# Todo151：Plan 独立状态、输入框标记、Queue 提交字段保真与保存恢复

状态：执行中。2026-09-15 用户批准补齐讨论并开始实施。本条统一替代 Todo152 的 `prePlanMode` hotfix；文件名保留以兼容已有引用。

## 最新裁决

- 用户权限为 `mode: build | edit | yolo`，Plan 单独用 `planEnabled: boolean`；Runtime 内部预留的 `auto` 不借机重构。
- 权限和 Plan 独立，`yolo + Plan=true` 合法但仍执行现有规划工具限制。批准只关闭 Plan，不恢复／改写权限；新链路不再依赖 `prePlanMode`。
- Plan 与 Goal 保持互斥。批准继续当前 Turn，不自动发送新用户消息。
- 不做进入／退出 Plan 的可见历史提示，不为这些提示新增事件类型。运行状态仍需由既有配置同步链路正确送达客户端。
- 不改系统提示词内容、MCS 传输方式或现有工具能力规则；仅调整已有规划／退出提醒的触发依据。

## UI 与草稿

- 选择菜单仍保留四项：“计划”置顶，其下加分隔线，再展示三种权限（权限之间沿用现有顺序）。三种权限选项只修改权限；“计划”项按勾选状态切换：未勾选时开启 Plan，已勾选时再次点击关闭 Plan；不覆盖权限，不另放常驻入口。
- 标记在权限右侧，以独立的 12px 高竖线分隔，竖线两侧布局间距均为 `gap-1`（4px）；图标与英文“Plan”／中文“计划”组成一个按钮，复用相邻菜单按钮的 ghost 样式、28px 高度、字号和内边距。文字沿用 `@xl/composer` 容器断点，并由工具栏按实际空间统一裁决（先收权限，再收供应商前缀、Computer 和 Plan）：窄宽度仅显示图标，权限和 Plan 两个按钮均为 28×28px 正方形（`size-7 p-0`）；宽度足够时恢复自动宽度和左右内边距，并显示 Plan／计划，整按钮始终可关闭并保留无障碍名称；宽窄态均使用工具栏共享 Tooltip，悬停或键盘聚焦显示“关闭计划模式”／“Turn off Plan mode”。按钮文字和图标统一使用次要前景色（`text-foreground-subtle`），hover 时保持该颜色。默认显示灯泡，hover／键盘聚焦时原位替换为关闭图标，不追加尾部叉号；触控端保留灯泡，点击整个按钮即可关闭 Plan。关闭仅清除草稿 Plan，不修改权限或发起模型请求。遵守 DESIGN.md、主题与国际化。
- `/plan` 复用开启标记逻辑；权限循环快捷键只循环三种权限，其他 Agent 的模式支持不受影响。
- 标记不因提交成功、Guide 发送或一轮结束清除。只有用户主动点叉，或本次计划批准已被处理，才关闭对应标记。
- 拒绝／修改意见不修改草稿：原标记在则保留，用户已叉掉则不能自动补回。一般 Runtime 快照不得持续覆盖草稿。
- 正文、附件、模型和权限不随审批清理。2026-09-15 用户明确接受简化：前一次批准结果首次到达时仍关闭标记，即使期间重新选择了 Plan；同一工具结果只应用一次。
- 模型通过 EnterPlanMode 真正进入时，定向开启对应会话的草稿标记；结果首次到达时直接应用，不再收集忽略工具列表、不关联草稿修改版本。一般快照仍不持续覆盖草稿，拒绝／反馈不产生标记转换。
- 菜单 Plan 为独立选中态，分隔线下的三种权限才是互斥单选。沿用老 staging V4 隐藏 EnterPlanMode 工具行的行为，不因已有“已开启 Plan Mode”组件而重新显示历史提示。

## Submission 与 Runtime

```text
菜单选择权限／Plan 或点叉
  → 仅更新输入框草稿
  → 提交时冻结 mode + planEnabled
  → 普通消息／队列／Guide 实际消费
  → 分别应用 Runtime 权限与 Plan

接受计划 → Agent 处理批准 → Runtime Plan=false，mode 不变
                              → 同步清除对应草稿标记
                              → 继续当前 Turn
```

- 新 Submission 明确携带两个值。`false` 表示关闭，不能等同字段缺失；旧请求缺字段在兼容入口处理。
- Guide 不特殊：携带 true 就进入／保持 Plan，携带 false 就退出／保持非 Plan。点叉本身不立即改变执行；后续提交被消费时才应用关闭。
- 已接纳的队列项保留提交时的状态，不因后来草稿或批准结果被改写。不改队列接纳、消费时机和所有权，不收回已执行操作。
- Submission、EnterPlanMode、ExitPlanMode 使用统一 Plan 转换逻辑。首次权限判断及参数变化后的重新校验都读取它，避免 yolo 提前放行；保留原有 MCP、记忆文件等特例。
- Runtime 状态变化与草稿变化是两件事。拒绝沿用现状结束本轮但不主动退出 Plan；修改意见继续规划；两者都不写草稿。批准请求未送达／未被处理不能冒称已批准；不等后续模型请求或整个任务成功才清标记。
- 已有完整／简短规划提醒改读 `planEnabled`；真正退出时接上已有退出提醒，覆盖 Guide 与工具退出，避免权限已解除但模型仍按旧规划指令工作。提示内容保持不变。
- 配套修改 SessionModePort、工具状态转换返回类型、Enter/ExitPlanMode 返回 Schema、handler 和消费方；避免状态已经切换却被旧 `mode=plan` 返回校验判为失败。历史工具结果兼容展示，不重写旧结果。
- 旧请求在接纳边界一次性转换：显式 planEnabled（含 false）优先；仅旧 mode=plan 则开启 Plan 并保留当前基础权限；仅旧非 Plan mode 则按旧语义切权限并关闭 Plan；二者都缺失则固定当前执行状态。队列执行不得重新读取当前状态猜值。

## Queue 提交字段保真：纳入本次实现

2026-09-15 用户确认：修复现有 Queue 字段丢失，作为本条改动的一部分，不另留到后续修复。

- 已定位根因：`product-projection.ts` 的 `onTurnSteerQueued()` 手动构造 QueueItem，遗漏 `mode`、`modelSelection`、`sharedContextRefs`、`provenance`。当前 QueueItem schema 已复用 `ConversationInputIntent`，但字段可选，因此遗漏不会被校验拒绝。队列提升执行又从 QueueItem 重建 intent，导致已提交权限／模型等事实丢失；并非仅影响队列展示。

```text
Composer 固定本次提交
  → Command payload → Runtime intent → 待执行输入
  → QueueItem → 提升执行时的 intent → Runtime 应用
       全程保留同一份提交事实，不重新读取输入框
```

- 复用现有公共输入事实及协议适配入口，集中处理 intent 与 QueueItem 的转换；不另造一份嵌套 Submission 协议，也不直接把完整 sendText payload 塞入队列。临时 `modelExecution` 鉴权材料不进入持久化队列。
- 完整传递现有模型选择、权限、附件／共享上下文引用、来源关联及投递／顺序信息；补齐反向转换中的来源关联。新增 `planEnabled` 必须同时贯穿，明确保留 `false`，不能用 truthy 判断漏掉关闭操作。
- 排队、原位编辑、重排、自动及手动提升执行均保留未被该操作明确修改的提交字段。只改正文的队列编辑不能清空模型／权限／Plan；不改变队列顺序、接纳／消费时机、命令去重和来源 ID 语义。
- Queue 修复本身不需要数据库结构迁移。已有缺字段记录走原有兼容处理，不从当前草稿猜回历史选择；与本条 Plan 保存格式评估分开。
- 普通 Guide 验证其原始 intent 消费路径；请求 Guide 但回退排队时，同样验证 Queue 往返。固定执行模型任务继续限制模型切换，但不能因此跳过本次明确要求应用的权限／Plan 状态，须拆清应用边界而不是删除固定模型保护。

## 持久化：不批量迁移旧数据

固定旧基线为 `staging_backup @ 790884b1ce4b990583ab40625b5f283e2169eb36`。已核实：`prePlanMode` 仅在内存；默认 `SessionModeChanged` 也是内存事件，不是可依赖的 SQLite 历史。`session.permission.mode` 是创建时写入的信息，`local_setting` 是项目偏好，App `tasks.mode/meta_json` 是任务索引快照；不能把它们混作最新会话状态或进入前权限。

- 不扫描回填／重写旧会话，不为转换旧数据新增 migration；在统一读取入口适当兼容旧格式，保留旧字段、旧值及未知内容。
- 采用现有 session_entry 保存 `runtime/execution_state`，data 为 `{mode, planEnabled}`；同一条记录保存两个值，仅保存 Runtime 已应用状态。创建／实际状态变化时正常写入，不在启动时扫描旧会话回填。session.permission 保留原数据；补齐冷恢复与分支恢复，不拿任务索引或项目偏好覆盖新版会话记录。
- 旧非 Plan 模式可转为同权限＋Plan=false；旧 Plan 转为 Plan=true，有可靠进入前权限才采用，无信息保守使用 build，不猜完全访问。项目偏好／过时索引不能无条件当原权限。
- 新旧远端协议不能悄悄丢弃 Plan 再执行；兼容旧请求不等于允许新请求被旧执行端忽略。回滚验证区分“旧版任务／会话可读”与“旧版准确恢复新版 Plan”：本次保证前者及新版恢复，不额外重构旧版本身不完整的 Plan 冷恢复机制，不宣称新记录能让旧程序理解独立 Plan。若旧读取契约要求兼容写入，限于保证内容可读的必要范围并留证据。
- 会话内容／任务在升级、回滚、再升级时都应可打开，不因新字段缺失异常；不强求恢复旧版未保存的事实。若最终确需新增表／列，另行确认结构 migration 并同步数据库负责人，不擅自扩大本条为旧数据迁移。
- 本次以零 SQL 结构迁移、零历史批量改写为实施边界。session_input.payload、message/part JSON、任务索引和自动任务启动配置兼容旧 mode=plan，不因新枚举删值导致记录不可读；新输入正常保存新字段。Queue 保真修复不扫描历史补猜。
- localStorage 草稿与最近选择分别兼容：已有任务旧 Plan 草稿保留规划意图；最近偏好的旧 Plan 不传给另一个新任务。新任务仍默认 Plan=false，缺乏可靠基础权限时保守处理；不得连带清正文或模型。

## 影响范围与不变量

- 草稿初始化、保存、切换／刷新、新建预热与首发转移；普通发送、排队、Guide；分享导入等复用新建行为的入口。
- 共享类型与运行时 schema、命令 admission／输入事实、配置同步与快照、会话恢复和分支恢复；现有 `snapshot.plan` 是待办步骤，禁止复用为模式开关。
- Goal 双向互斥检查；CLI 旧 Plan 参数；Subagent 权限声明／继承；定时、闲时任务保存及启动参数。保留各入口既有执行与固定模型边界，不顺便重做策略。
- 桌面、本地／远端 workspace、手机 shared-host 语义一致；保持 desktop-continuous 与 web-remote-replayable 边界，workspaceIdentity 隔离、remoteSessionId 路由和 Runtime 队列权威不变。
- Provider、模型解析策略、签名、用量与其他 Agent 实现不在改动范围；模型选择仅修复 Queue 传递丢失，不重新裁决默认值或固定模型策略。新任务不继承 Plan，默认关闭；权限继续沿用现有新建任务规则。

## 验收与实施顺序

1. 先明确 JSON 保存／兼容方案并更新正式 spec、功能图、会话 case catalog 和覆盖矩阵；纠正功能图中 `/plan` 先切 mode 再发送的旧描述。
2. 先写测试：Queue 的真实事件投影及提升执行往返，断言模型、mode、planEnabled（含 false）、附件／上下文和来源不丢；覆盖原位编辑、重排、自动／手动提升和 Guide 回退。回归运行中提交 yolo、排队后执行仍按 yolo 检查工具权限，不因字段丢失沿用 build。
3. 再覆盖三种权限＋Plan；批准、拒绝、反馈、主动点叉；Guide true/false 切换及对应提醒／权限；同值幂等；不依赖模型变化才应用 Plan，包括固定执行模型任务。
4. 覆盖新建首发、预热、草稿转移、排队冻结、迟到批准首次到达覆盖标记但重复结果不再次应用、旧格式缺字段、冷恢复、分支恢复、回滚可读及权限不被放宽。
5. 补桌面交互 E2E（含 Plan 置顶、分隔线、三种权限及排队后权限生效）、触控／键盘、主题／国际化，以及手机审批／重连验证；不为测试改系统提示词。旧数据兼容使用隔离 fixture，不操作用户库。
6. 实现后统一 review，执行 typecheck、lint、架构检查及相关单测／E2E，记录实际结果和未验证环境，再提交。

验收须同时覆盖 `yolo + Plan=false` 排队后正确应用权限，以及 `yolo + Plan=true` 仍有规划限制和计划审批；不能把“yolo 无需审批”泛化到 Plan。

## 实施记录（2026-09-15，仍执行中，未完整验收）

已落地到本地工作区：

- 共享执行状态解析、权限与 Plan 分离、普通输入／Guide 消费、固定模型分支的权限应用。
- Queue 投影与提升保留 Submission 中的模型、权限、Plan（含 false）、共享上下文和来源。
- Enter／Exit 工具、首次与再次权限校验、提醒触发；不修改现有提示词正文。
- Composer 四项菜单、独立标记、草稿保存、新任务不继承 Plan；工具转换的定向同步初版。
- session_entry 正常保存／冷恢复，不加 SQL 结构或批量回填；历史分支的 entry 与提示消息使用同一历史状态。
- Subagent 在继承 Plan 时保留父基础权限，不改变 Explore 与显式权限声明的既有分支。
- 新 Host 与实际 CLI 的独立 Plan 能力确认，避免旧端剥掉字段后按完全访问执行。
- V4 Goal 创建／恢复的互斥检查；已增加失败测试后实现。

实际验证：

- Core 相关 9 文件、324 项通过（含真实 Runtime 的 Guide、持久化、分支和 Subagent 执行）。
- Bootstrap 相关 5 文件、113 项通过（Queue 与原生命令）。
- UI／草稿／分享／审批回执／服务端能力检查相关 8 文件、55 项通过；另有共享解析与传输测试通过，计数有重叠，不累计成总覆盖率。
- 根 typecheck、CLI contracts/core/bootstrap 类型检查通过；根 lint 0 error、42 warning。
- 根 lint 默认排除 CLI；另用无忽略配置对本条 CLI 文件运行 oxlint，0 error，不能当作全 CLI lint 已覆盖。
- architecture:check --changed 为 0 violation，git diff --check 通过。
- 曾运行更大范围 Core／Bootstrap 套件，有其他失败尚未全部与 HEAD 对照；不能声明全部为基线问题或全量回归通过。
- 桌面 E2E 已增加并尝试运行，但 Electron 在 ChromeDriver 建立 session 时退出，测试正文尚未执行；不计为通过。手机、触控与重连也未实测。

完整验收前仍须完成（用户后续要求先推送并建 MR，不代表验收完成）：

1. 定向草稿同步已按最新裁决简化（见下方记录）；进程重启后未收到的工具通知恢复仍须单独验证，不以普通 Runtime 状态强制覆盖已有草稿。
2. 复核旧 Goal 控制入口与 V4 互斥的一致性，以及新旧端／回滚读取的权限边界。
3. 补齐审批／拒绝／反馈／手动叉、Queue Guide 权限实际生效、手机重连等交互验收；当前仅新增菜单 E2E 不能代表整条链路覆盖。
4. E2E 必须在 MacBook Pro 执行；之前 Electron 启动失败来自 Linux 工作区，不是 Pro。当前已转到 Pro 隔离副本执行，下方记录本次范围；其余交互验收和全量失败归因仍待完成。

2026-09-15 用户要求先推送并新建 MR：按评审草稿交付，保留本条未完整验收状态。保留开工前用户已有的其他改动，不把本条实现标为完整交付。

### 草稿同步简化与 Pro 验证（2026-09-15）

- 已按用户确认删除 `ignoredPlanToolCallIds`、消息窗口工具 ID 收集及相关 hook 参数。
- 新工具转换直接赋值 `planEnabled`；保留 `lastPlanTransitionId`，同一结果重复快照不再应用。
- 已验证进入／退出首次到达覆盖手动改选、已批准后重新开启不被同一回放再清除、无转换不改草稿；4 文件 23 项通过。
- typecheck、lint（0 error，42 warning）、E2E 类型检查、审批 fixture check 与架构检查通过。
- E2E 转到专用 MacBook Pro（Darwin）的隔离副本 `/Users/dev/Desktop/projects/Z.AI/todo151-pro.hGJ5yI/repo`；不使用 Pro 原工作区及真实用户数据。
- 实际审批用例新增进入／批准前后 Plan 标记变化与 yolo 不变的断言。Pro 已完成依赖安装、CLI 与 Electron 构建，并实际运行测试正文。
- 复跑排查并修正测试同步：Plan 标记更新先于 DropdownMenu 关闭动画完成，测试须等旧菜单卸载再打开；种子会话标题请求异步发出，空 `/plan` 的请求计数须先等该标题请求。均不改产品逻辑或提示词。
- Pro 最终运行 `desktop-e2e-20260915070056792-p63678-7820fb061f2b3987`：3 个 spec、6 项全通过（独立标记／权限／叉号 1 项，工具进入与批准同步 1 项，`/plan` 4 项），使用真实 Electron 与 CLI、模型 fixture 回放，不代表线上供应商请求验证。
- 推送前受影响单测补齐旧断言：草稿兼容读取应拆成基础 mode 与 planEnabled，普通提交显式携带 false，`/plan` 提交携带 true；菜单测试改为验证 Dropdown 的权限单选、Plan 独立勾选及焦点恢复，不再 mock 已移除的旧组件。不改变产品代码或旧格式 fixture。
- 产物位于上述 Pro 副本的 `packages/desktop/.e2e-artifacts/desktop-e2e-20260915070056792-p63678-7820fb061f2b3987/`。仅确认本次简化及这 6 项交互，Todo151 整体仍未完整验收；手机重连、完整 Queue／Guide 等待补，推送 MR 不代表这些项目已通过。

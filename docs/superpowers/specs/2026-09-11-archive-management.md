# 设置：归档管理

用户要求：设置 → 数据与统计 → 归档管理。布局参考截图“已归档的聊天”：标题/全部删除、搜索、排序方式与项目筛选、项目分组标题/数量/更多、卡片内任务标题/时间/删除/取消归档。项目候选与分组必须使用虚拟项目，而非 cwd。

## 行为与边界

- 页面名与顶部页面标题均为“归档管理”，位于自动归档设置之前；列表标题为“已归档的会话”。只显示 Host readTree 的 archived 行；CLI 删除镜像排除已删除任务，不能从 sessions-index 补行。
- 自动归档设置统一放在“归档管理”顶部、已归档聊天列表之前：“自动归档旧会话”和“归档保留时长”保持同一设置卡片，常规页移除这两项。沿用现有设置键和 3/7/14/30 天选项。2026-10-19 起默认关闭、保留 30 天；已有天数不覆盖。关闭时也允许选择并保存时长，关闭期间只保存配置、不执行归档；开启后按已保存时长执行。开启时修改时长沿用设置变更补扫，已归档会话不会因时长变化自动恢复。2026-10-14 起，旧配置的开启状态一次性归位为关闭，保留天数，用户重新开启后才执行；迁移合同见 virtual-project-design 的“自动归档修复后的重新开启”。中英文、明暗和窄屏布局沿用公共设置行。
- 页内固定文案统一使用“会话”，覆盖自动归档标签/说明、列表标题、搜索、数量、加载/空态/失败提示和删除确认；英文对应统一为 session。用户自定义会话标题与项目名称原样展示。标题复用 SettingsPage 公共页头与 archives.nav，列表仍使用 archives.title；仅展示调整，不改状态 owner、命令、持久化或失败语义，无迁移。
- 默认更新时间/所有项目，搜索标题（不区分大小写）；用户明确中间下拉是“排序方式”，只提供更新时间、创建时间，均倒序。搜索与项目筛选取交集。
- 筛选区复用公共 Select：触发框仅显示当前选项与下拉箭头；“排序方式”标签放在排序框外左侧，不显示排序或项目装饰图标。外部排序标签关联 Select，保留键盘操作与可访问名称；窄屏换行、中英文和明暗主题保持可用。只调整展示，筛选状态继续由 ArchiveManagementContent 持有，不新增组件或状态同步路径。
- 分组和选择以 Host + projectId 为 key；同目录多项目、同名不同 Host 不合并。显示项目名字，远端附 Host 名。无 projectId 显示“未归类”；已删除容器保留名字及“已移除”标识，不恢复项目或改变 session cwd。候选来自同一树，包含仍有归档的已删除容器和未归类。
- 时间显示当前排序选用的 CLI updatedAt/createdAt，降序稳定排序，标题单行省略、完整 title 可读；组内首屏 50 条，显示更多增加 50。数量与批量操作使用全部匹配项，不限渲染页。
- 所有归档分组（含未归类、已移除项目）默认收起，在名称右侧显示折叠箭头；名称与箭头共用可键盘操作的展开按钮，数量和更多菜单独立保留。复用公共 Collapsible，聊天卡片、行按钮及“显示更多”只在展开时构造/挂载，收起立即卸载。每个 Host+projectId 对应的 ArchiveGroupCard 独立持有本页 open，仍在结果中的分组在排序/筛选时保留状态；新出现或重新进入页面的分组默认收起，搜索不自动展开。已加载条数沿用本页组内 limit；数量、搜索结果和批量操作不依赖折叠或 DOM 是否挂载，不新增持久化偏好。
- 每行取消归档/删除；组更多菜单提供该组取消归档/删除；右上全部删除作用于当前搜索/筛选结果。删除均需确认，明确数量和操作不可从 UI 撤销；不更改 CLI 既有软删除语义。确认期间固定候选身份，不能把后来新增的匹配项纳入。
- 同一页同一时刻仅一个操作批次，按钮禁用。逐项发既有命令，成功才清理对应 UI 状态，最终刷新；部分失败报告成功/失败数量，失败项仍在权威树中，不能吞错、回滚成功项或伪造全成功。取消确认不发命令。过期/已取消归档/已删除目标不再纳入执行。
- 本地与在线远端共用页面，离线不伪造会话缓存，不为只读拉起 Agent；离线项目可被识别但无可操作的离线索引。加载/空态/无搜索结果/读取失败分别呈现，失败可重试。异步刷新复用原请求序号，不新增同步定时器。
- DESIGN.md 的语义颜色、text-ui 字号和组件复用；明暗、键盘操作、中英文、窄屏可用，窄屏筛选换行。手机沿用已有 Host attachment，不能为归档页创建 runtime。

## 架构决策

归档 UI 属于现有 managed project-sidebar/ui 模块，经 index 公开 ArchiveManagement；设置导航只注册入口。ProjectDirectoryProvider 提升到 RootWorkspaceContent，侧栏、composer、settings 同源；嵌套 Provider 复用已有 owner，独立壳层仍能使用，不能多次执行 useProjectTree。Host 管 projects/roots/archived；CLI 管存在性/标题/时间。UI 仅搜索、筛选、折叠、分页、确认快照与在途批次。

```text
Host readTree -> 单一 ProjectDirectoryProvider -> sidebar / composer / archive settings
用户筛选 -> 纯派生分组（Host+projectId；任务地址仍 workspaceKey+taskId）
确认固定候选 -> 既有 Controller.mutateTask / TaskService
             -> Host archive=false 或 CLI delete -> 索引事件 -> 同一树刷新
桌面：continuous 原链路；手机：shared-host + replayable 原链路
```

任务操作地址/路由复用一个模块内 mutation adapter，侧栏和归档页共用；remoteSessionId 从现有注册表解析，sourceServerId 从统一 identity parser 取得，不按路径猜远端。无新协议、schema、migration、持久化缓存或 accepted queue。

自动归档卡片由 SettingsPage 在 archives 分区组合，设置值及回调继续由 SettingsPage 持有，SettingsService 仍是持久化权威；project-sidebar 的查询/列表组件不接管设置状态。保存成功后才更新页面，失败沿用原设置操作反馈。Host 扫描调度、远端配置作用域、桌面 continuous 和手机 shared-host/replayable 边界不变；手机不新增设置入口。

```text
归档管理设置卡片 → SettingsPage 原回调 → SettingService.update
                                      ├→ 原 Host 扫描调度：关闭则退出，开启则按已存天数扫描
                                      └→ 保存成功 → SettingsPage 更新展示值
```

## 影响分析与测试决策

| 项目              | 结论                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 层级/模式         | presentation、option-source、validation、commit-effect；planning→implementation                                                                                                 |
| 必查入口          | SettingsPage/navigation/config；RootWorkspaceContent/WorkspaceShellLayout；ProjectDirectoryProvider；任务 archive/delete 命令                                                   |
| 同源/差异         | 三处目录同源；归档页只取 archived，包含已删容器；侧栏不显示归档，composer 不显示已删容器                                                                                        |
| UI Surface Matrix | 设置筛选：页面草稿→tree 纯投影；行/组/全部动作：确认与在途→既有命令→Host/CLI；侧栏：同一事件刷新，导航不变                                                                      |
| Owner/落点        | 查询与偏好由 Provider；归档由 Host tasks-index；删除由 CLI mutateSessionFacts→镜像；无新落点                                                                                    |
| 不变量            | workspaceIdentity 隔离、Host+projectId 分组、旧 cwd 不变、不改时间/标题、不写对方库、continuous/replayable 分离                                                                 |
| Codegraph         | explore SettingsPage/createSettingsPageConfig/useProjectTree/mutateTask，计划深度 2；两次返回 no such table: unresolved_refs，索引不可用，改用限定源码/rg。未声称图调用分析成功 |
| 图谱漂移          | 旧 surface.project-task-list 仍指向已删除 grouped/workspace 节点，作为历史漂移记录；本次只登记新归档入口与现有权威端口                                                          |
| 关系分级          | must-inspect：设置入口/共享树/命令；should-inspect：侧栏/composer；invariant-only：两库与 stream；evidence-only：fixture                                                        |
| 不展开            | provider/工具/消息流/队列不改变归档管理；不做全笛卡尔积，也不新增 runtime 请求                                                                                                  |
| 可选澄清          | 用户明确中间下拉是排序方式，仅更新时间/创建时间；全部删除采用当前过滤结果范围，确认框清晰显示数量                                                                               |

| Case  | 设置→动作→断言                                                                                                         | 状态/证据                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| ARM01 | 设置数据与统计入口，多个虚拟项目共享 cwd、长标题、未归类、已删除项目→搜索/时间排序/项目筛选→分组/数量/候选只用虚拟项目 | accepted；unit + pending E2E                       |
| ARM02 | 归档行→取消归档→索引 archived=false、页面消失、侧栏重现；删除取消不变，确认后 CLI time_deleted 与镜像删除，刷新不复活  | accepted；unit + pending E2E                       |
| ARM03 | 搜索/项目过滤后→组/全部批量动作→只处理确认时匹配项；重复点击只执行一次、失败项保留并报告，组外不动                     | accepted；unit + pending E2E                       |
| ARM04 | 同 projectId/任务 ID/真实路径不同 Host→路由→完整 identity/source/attachment 保留；本地与远端隔离                       | accepted；unit；真实远端/手机 GUI 待验             |
| ARM05 | 长标题、50+列表、中英文、390px、明暗→搜索/更多/按钮/滚动可用                                                           | accepted；unit + E2E 共享 renderer，不冒充手机配对 |
| ARM06 | 默认全部收起→鼠标/键盘展开与收起→只挂载展开组；折叠组数量和批量动作仍完整有效                                          | accepted；unit + pending E2E                       |
| ARM07 | 常规页无自动归档项→归档管理默认关闭/30 天→关闭时切换并保存时长、刷新恢复→开启后使用已存时长；关闭后仍可修改                           | accepted；pending E2E；复用 ARM05 布局覆盖          |

E2E 放 manual-review/pending，fixture 在隔离 HOME/工作区创建；只用历史数据无需模型，provider policy=none。功能与批量语义按用户请求及既有命令约束确定；未改流协议，formal-proof 消息状态组合剪枝。不晋升 formal/Docker，等待人工 review。

### 2026-10-19：默认 30 天，关闭时可预设时长

默认设置、SettingsPage 初始值/缺省值及 Host 扫描缺省值统一为 30 天，不迁移已有天数。移除时长下拉框与开关的禁用绑定；继续通过原 SettingService 保存，关闭时扫描退出，开启后读取已存值，不新增状态或同步路径。

先运行新增默认值断言，旧实现的 schema 与设置服务均返回 7 天；旧桌面构建的 ARM07 在“关闭时下拉框可用”断言失败。修改后运行 `desktop-e2e-20261019062710421-p61805-cfee647173bf3a00`，ARM07、ARM08、ARM01/05/06 共 3/3 通过：默认关闭/30 天、关闭时改 7 天并刷新、开启保留 7 天、开启时改 14 天、再次关闭后改 30 天、已有归档不恢复；中英文 × 明暗 × 1200/390px 布局验证通过并检查截图。用例保持 pending，窄屏不等同真实手机/远端 Host 验证。旧构建的额外 ARM02/ARM03 取消归档用例已失败，本次没有修改这些动作，不将其计入通过范围。

验证：root/E2E typecheck、fixture check、格式检查、架构检查（0 违规）通过；lint 0 errors / 188 warnings。从任务起点运行受影响单测，选中 1432/2496 文件，首次 16152 项通过、2 项失败、6 项跳过；失败均在 subagentsService 测试，分别为 afterEach 清理超时和随后临时文件 ENOENT，该文件完整复跑 29/29 通过。没有修改失败用例或放宽超时，也没有将首次整批运行记为全通过。

## 验证结果

验证：相关单测 12 文件 / 67 项通过；最终 Electron `desktop-e2e-20260911073549408-p8673-2d528e9e7a8486a5` 3/3 通过，包含真实创建/更新时间反向排序、虚拟项目筛选、取消归档回写、删除确认取消、CLI time_deleted 与 Host cli_deleted、重新打开后的持久化结果、搜索范围批量删除、分组取消归档，以及 1200/390px 明暗截图和溢出检查。root typecheck、E2E typecheck、fixture check、lint（48 个既有 warnings / 0 errors）与架构门禁（baseline 0 / new 0）通过。真实手机配对/远端 Host/Windows/Linux 未运行，不能以窄屏截图替代。

语义图新增归档 surface、共享目录 owner 和任务 mutation adapter 关系；YAML 无重复 ID，新 seeds 文件/符号存在。四条悬空引用与 HEAD 完全相同，本次无新增；codegraph 扫描仍因索引错误不可用，未将静态检查写成图调用分析成功。

### 2026-09-15：简化筛选控件

两个下拉原本已复用公共 Select，本次仅调整 project-sidebar/ui 的组合布局（展示代码净增 12 行），将图标及排序标签移出触发框。筛选状态、命令和桌面 continuous / 手机 replayable 链路不变。

旧实现的真实 Electron 运行被新增“排序框仅显示当前值”断言拦截；修改后 `desktop-e2e-20260915045116820-p26982-f2a50b4911fb90b8` 3/3 通过，包含键盘排序、项目筛选、归档/删除回归，以及中英文 × 明暗 × 1200/390px 的 8 张截图和框外标签/图标位置断言。相关单测 2 文件 / 8 项、root typecheck、E2E typecheck、fixture check、lint（48 个既有 warnings / 0 errors）通过。

本次相对 HEAD 的架构检查 0 违规；默认相对 origin/staging 的检查仍报分支已有 `packages/ui/src/root/resolveConversationWorkspaceTarget.ts` 未登记 managed 模块，与开工基线一致。真实手机配对、远端 Host、Windows/Linux 未运行；窄屏证据仅来自共享 renderer。

### 2026-09-15：去除装饰图标与展开卡顿定位

按用户后续要求移除排序标签前和项目选择器前的图标，保留排序文字与公共 Select 的下拉箭头。同步更新 E2E，筛选栏只保留搜索图标和两个箭头。展示代码净减少 4 行；没有修改公共 Select 或列表渲染策略。

真实开发窗口（CDP 9229）的性能录制复现卡顿：42 个归档项目组累计挂载 1,142 行、约 1.7 万 DOM 节点。`ArchiveGroupCard` 的 50 条限制只作用于每个项目，`ArchiveManagementContent` 仍一次渲染全部分组，因此不限制整页规模。Radix Select 展开时注入滚动锁样式，并修改 body 的 `pointer-events`；时间线显示大范围 `UpdateLayoutTree` 样式重算，调用栈落在 Select 定位与滚动位置读取。去掉图标后仍可稳定复现。

不开 CPU profiler 的三次重复测量（pointerdown → 下一帧）：

| 当前筛选 | 挂载归档行 | 排序菜单（2 个选项） | 项目菜单（43 个选项） | 样式重算耗时 |
| -------- | ---------: | -------------------: | --------------------: | -----------: |
| 所有项目 |      1,142 |            406–416ms |             461–487ms |    384–405ms |
| 单个项目 |         18 |              59–62ms |             106–107ms |      47–52ms |

对照保持同样的菜单选项，仅通过现有项目筛选减少列表节点；测量后已恢复所有项目。主要瓶颈是列表规模放大了全局样式变更的成本。后续应评估整页虚拟滚动，限制实际挂载的屏幕外条目；本轮只完成图标修改和原因定位，没有擅自更改渲染策略。这些数字来自当前开发构建，不代表生产包或其他设备基准。

```text
点击 Select → 滚动锁 / 外部点击锁 → 大量归档 DOM 样式重算 → 测量菜单位置 → 首帧显示
```

验证：Electron `desktop-e2e-20260915045706636-p29422-d491265af9e775d1` 3/3、相关单测 8/8、typecheck、E2E typecheck、fixture check、lint（48 个既有 warnings / 0 errors）、相对 HEAD 架构检查通过。既有分支架构登记问题及真实手机/Windows/Linux 未验证边界与上一轮相同。

### 2026-09-15：归档分组默认折叠

按用户裁决，采用默认折叠、展开时挂载的方案。ArchiveGroupCard 复用公共 Collapsible，名称右侧的箭头表达状态，open 只由该分组实例持有；聊天卡片及行元素在 open 分支内构造，收起立即卸载。标题、数量和更多菜单保持可用，组内分页保持本页进度。展示实现净增 27 行，无新持久化、协议、运行态或远端链路。

```text
进入归档页 → 所有组 open=false → 仅挂载组标题/数量/更多
点击名称或箭头 → 当前组 open=true → 挂载该组分页聊天
再次点击 → 当前组 open=false → 卸载该组聊天
批量命令 → 原始匹配数据 → 既有 Host/CLI 命令（不依赖挂载状态）
```

在同一真实开发窗口、同样 42 个项目组下复测三次，默认挂载归档行由 1,142 降到 0，菜单展开期间 DOM 约 2,800–2,900。排序 Select 从 406–416ms 降到 66–74ms，项目 Select 从 461–487ms 降到 90–124ms；样式重算降到 58–64ms。手动展开组后仍按需挂载该组，结果仅代表本次开发窗口测量。

验证：先写的默认不挂载单测在旧实现返回 50 行时失败；修改后相关单测 8/8、Electron `desktop-e2e-20260915060232956-p48402-9950aaaf3bc92911` 3/3 通过。覆盖独立展开、键盘收起后无行 DOM、更多菜单不展开、过滤后新组默认收起/保留组状态、折叠组批量删除及取消归档真实落库，以及中英文 × 明暗 × 1200/390px × 收起/展开共 16 张截图。截图与逐组点击等待真实动画完成，不靠固定延时。root/E2E typecheck、fixture check、lint（48 个既有 warnings / 0 errors）通过；相对 HEAD 架构 0 违规。默认分支比较仍有既有 unmanaged-file 问题，真实手机配对、远端 Host、Windows/Linux 未实测。

### 2026-09-15：自动归档设置迁入归档管理

从 GeneralSectionContent 移出整组设置，在 SettingsPage 的 archives 分区顶部组合 TaskAutoArchiveSettings 与原 ArchiveManagement。卡片无内部状态，读取与保存仍走 SettingsPage 的既有设置回调；复用公共设置行的窄屏堆叠布局与原中英文文案，补齐控件可访问名称。仅 ui 模块展示变更，产品代码净增 22 行，未改 project-sidebar 合同、Host 调度、持久化键或协议。

先添加 ARM07 后运行旧实现，因“常规”仍出现自动归档文案而失败。修改后 Electron `desktop-e2e-20260915071025117-p90265-99d42137cf736fb1` 4/4 通过：常规移除、归档页顶部展示、开启/14 天保存并刷新恢复、关闭禁用且保留时长，以及既有归档列表操作和中英文/明暗/1200/390px 布局。原自动归档扫描用例同步入口后，Electron `desktop-e2e-20260915071146456-p91125-9eaca16185a5fcc7` 通过，验证旧任务归档、置顶保护与近期任务保留。

相关单测 4 文件/34 项、root typecheck、desktop typecheck:e2e、两份 fixture check、lint（48 个既有 warnings/0 errors）通过；HEAD 增量架构 0 违规。默认全分支检查仍被开工前既有 `packages/ui/src/root/resolveConversationWorkspaceTarget.ts` unmanaged-new-file 阻挡。真实手机 shared-host、远端 Host 和 Windows/Linux GUI 未实测；窄屏仅代表共享 renderer 布局。用例保持 pending。

### 2026-09-15：归档页标题与会话称呼

恢复公共设置页头，使用“归档管理”，列表保留独立的“已归档的会话”标题。原实现专门隐藏 archives 页头，配置又将页面标题映射为列表标题，自动归档卡片迁入后顶部没有页面标题。移除这两个特例，复用公共页头；归档专属中英文文案统一为会话/session，用户内容不替换。ARM08 覆盖标题在自动归档设置上方、固定文案和删除确认；复用 ARM05 的中英文、明暗及 1200/390px 布局验证。

验证：开发窗口 CDP 9229 确认页头恢复与中文文案。Electron `desktop-e2e-20260915-122925-103` 5/5 通过，覆盖页头位置、搜索/数量/无结果/删除确认、设置落盘和既有归档操作，以及中英文 × 明暗 × 1200/390px × 折叠/展开共 16 张截图；自动归档扫描 AMT02 在 `desktop-e2e-20260915-123058-715` 1/1 通过。相关单测 3 文件/21 项、root/E2E typecheck、两份 fixture check、lint（47 warnings/0 errors）通过；HEAD 增量架构 0 违规。产品变更限于 ui 展示层的 4 个文件，净增 0 行；状态 owner、事件顺序、桌面 continuous 与手机 replayable 边界均保持原合同。默认全分支架构仍有开工前的 resolveConversationWorkspaceTarget.ts 未受管文件问题；真实手机 shared-host、远端 Host、Windows/Linux 未实测。用例保持 pending。

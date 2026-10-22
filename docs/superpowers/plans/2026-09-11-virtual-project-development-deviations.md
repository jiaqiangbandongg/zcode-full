# 虚拟项目重构：开发偏差记录

关联设计：[虚拟项目设计](../specs/2026-09-09-virtual-project-design.md)。
关联进度：[实施记录](2026-09-10-virtual-project-implementation.md)。

本文件单独记录开发中与设计、原有理解或首次实现预期不符的情况，持续追加。**“已修正”仅表示该问题已有针对性实现和验证，不表示整个重构完成。** 未执行的 GUI、真远端和跨平台验证不算通过。

## 已确认并处理的偏差

### D01：同一份设计里的首次归属规则不一致

- 原预期：无归属会话的首次归位规则在 spec 与 skill 中一致。
- 实际：设计旧正文出现“多个匹配按主要目录优先”“未归类仅时间线可见”；第 3 节最终裁决要求仅唯一匹配才归入，其他进入任务区。session-management 的 I17 也残留“仅时间线”。
- 处理：以用户指定 spec 的最终裁决为准，修正设计正文，实施记录注明 skill 旧文字的适用边界。使用归属已判断位区分“合法 NULL”与“尚未判断”，防止后续启动自动挪动会话。
- 验证：项目存储契约测试覆盖零/一/多个匹配、重复迁移及显式 NULL；GUI 场景待验收。

### D02：task index 没有版本化迁移账本，CLI 的计划编号也已占用

- 原预期：两库都可以在既有迁移序列上追加本次 schema。
- 实际：app 的 `tasks-index.sqlite` 只有建表/补列逻辑，没有迁移账本；CLI 已有 `0019_dwf_journal`，不能按旧计划占用该编号。
- 处理：抽取两库共用的 migration runner；app 新增 `schema_migration` 与 `0001_projects`（开发期原名 `v3_projects`，更名见 D98）；CLI 使用 `0020_session_soft_delete_outcome`，不修改历史 SQL/checksum。
- 验证：真实 SQLite 迁移、重复运行、校验和、失败回滚测试通过；升级→旧版本写入→再升级的 GUI 验收仍待完成。

### D03：恢复表级备份时，外键会影响未备份的正文表

- 原预期：对备份表执行 DELETE/INSERT 即可恢复。
- 实际：CLI `message`/`part` 的级联外键使裸删 `session` 有清空正文的风险；事务内再关闭 foreign_keys 也不能作为保护。
- 处理：恢复前关闭外键，再在事务内恢复备份列并检查行数、哈希和外键；只清理本次恢复对应的迁移记录，保留新增 schema。
- 验证：临时 SQLite fixture 实际执行工程恢复命令，父表恢复、子表保留、迁移记录回退均通过。未对用户真实数据库执行恢复。

### D04：每条迁移声明的影响表不一定完整

- 原预期：为历史迁移补齐 `touchedTables` 后，声明即可覆盖所有实际写入。
- 实际：逐表哈希测试发现 `0019_dwf_journal` 还会写入 `dwf_actor`，首次声明漏掉了它。
- 处理：只补影响表声明，不改历史迁移 SQL；逐条构造迁移前 fixture，对所有表做前后内容哈希比较。
- 验证：20 条 CLI migration 边界测试通过；另有 app 迁移全表哈希测试。

### D05：Node 内置 SQLite 在真实打包后被改成第三方模块名

- 原预期：源码和单测中的 `node:sqlite` 可直接用于 Node bundle。
- 实际：tsup 默认移除 `node:`，产物变为 `sqlite`；这不是 Node 内置模块，真实 bundle 导入失败。
- 处理：相关 Node 构建配置设置 `removeNodeProtocol: false`，保留内置模块标识。
- 验证：真实 bundle 相关 3 个测试文件、22 个测试通过；这项问题不是仅靠静态类型检查发现的。

### D06：远端库中的 workspace identity 不等于稳定的物理 host 身份

- 原预期：从库内 workspace identity 可以直接得出项目所属 host。
- 实际：Source Server 仍可能保存历史 SSH/WSL canonical route，同一 Server 的多个旧连接地址会被误判为不同 host。
- 处理：由可信 Server 启动入口注入稳定 Source Server `host_id`；保留历史 canonical workspace key、真实 cwd 和配置 hash，不批量重写工作区身份。
- 验证：同一 Server 的两个历史连接地址可归入同 host 项目，移动和创建目录解析测试通过。真实跨机连接待验收。

### D07：Server Core 的原启动顺序绕过了迁移屏障

- 原预期：复用项目仓库迁移就足以保证远端先升级再服务。
- 实际：Server Core 会先创建业务服务，再确定 Source 身份；可能在迁移/身份准备完成前开放业务能力。
- 处理：先解析稳定 Source 身份，等待 app 库迁移成功后才创建服务与开放 RPC；失败保持关闭。
- 验证：异步屏障、迁移失败关闭及实际 ESM bundle 测试通过（该轮 2 文件、8 测试）。

### D08：新建会话的归属不能等首次事实到达后再补

- 原预期：CLI 创建成功后再写项目归属即可。
- 实际：首条输入或 sessions-index 事实可能先到，触发默认首次归位；重试也可能覆盖用户已经移动的归属。
- 处理：Host 根据命令身份预留稳定 session ID，在发给 CLI 前原子写入归属；无 `cli_created_at` 的预留行不可见；重复预留不改已存在的归属。
- 验证：预留、事实摄入、并发组织操作及重试后归属不回退的仓库/服务测试通过。其他创建入口仍需全部接入，见 U03。

### D09：预留行首条事实的初始化条件过宽，会覆盖展示配置

- 原预期：所有没有 `cli_created_at` 的行都可以用首条 facts 初始化展示基线。
- 实际：首次实现会把既有行的模型、模式等展示信息重置成 facts 的缺省值。
- 处理：仅不存在的行或明确的空预留行（尚无 CLI 时间且旧 created_at 为 0）初始化；保留期间发生的置顶、归档、未读及标题意图。
- 验证：问题由 task-index 回归测试暴露；收窄条件后同步器及预留行相关测试通过。

### D10：项目置顶携带整份 roots 会覆盖并发编辑

- 原预期：保存项目时把当前 UI 的 roots 一并传回没有影响。
- 实际：另一个窗口先编辑 roots 后，本窗口的置顶操作可能回写旧 roots。
- 处理：`saveProject.roots` 改为可省略；置顶只提交 id 与 pinned，事务内保留现有 roots 和名称所有权。
- 验证：先编辑 roots、再用旧视图置顶的契约测试通过。

### D11：CLI 的最后结果不能从裁剪后的 turn headers 重建

- 原预期：sessions-index 可以根据当前投影里的最后一个 turn 推导结果。
- 实际：历史裁剪或冷恢复时，投影可能是 draft/缺少旧 turn，导致持久结果丢失。
- 处理：CLI store 的 `last_outcome` 作为唯一来源，冷恢复读持久值，终态事件在 core 持久化后更新 projection 元信息。
- 验证：裁剪后投影仍保留旧 error 结果的测试通过；相关 CLI 投影、原生命令、迁移回归通过。

### D12：删除旧 stream 写入后，通用整行 writer 仍留下第二个事实入口

- 原预期：删除 `applyAgentPatch`、Host 推导状态和流事件写入后，事实所有权已经收口。
- 实际：`syncTaskMeta` 仍被恢复、导入、创建和 automation 标记调用；整份 metadata 参数允许事实与组织态再次混写。另有仅备份 JSON 的 Claude 导入路径可以独立创建索引。
- 处理：删除 `syncTaskMeta` 和无调用的 seed API；写入分为 CLI facts、组织态、展示缓存。Claude 导入必须先创建真实 CLI session，JSON 仅作备份。删除无生产调用方的旧自动归档/workspace 批量归档 API。
- 验证：最新同步器、adapter、task-facts、Claude 导入 4 文件共 162 测试通过。仓库中的测试夹具改为显式分别设置 CLI 事实和组织态，不保留测试专用生产 writer。

### D13：元数据展示改用新列后，SQL 排序和搜索仍在读旧列

- 原预期：`rowToMeta` 使用 `cli_*` 即完成 V1 读路径迁移。
- 实际：列表 SQL 仍按旧 `updated_at` 排序、按旧 title 搜索；人为污染旧列和 meta_json 后，即使镜像正确，列表仍排错。
- 处理：列表、搜索、automation 会话排序改用 CLI 镜像；旧事实列只用于迁移和降级双写，保留 Host 标题 override 的合法显示规则；无持久事实的预留行不进入查询结果。
- 验证：新增回归测试先复现排序反转，再修改查询，针对性仓库测试通过。

### D14：旧测试把已删除的行为当成断言前提

- 原预期：重构后原有测试只需少量 import 调整。
- 实际：部分测试依赖 Host 持久化 running、空草稿写入索引、Group 结构和旧 Sidebar 源码片段；另一些 mock 缺少现在必需的 CLI reconcile 方法。不能靠恢复旧代码满足这些断言。
- 处理：区分产品行为回归与旧实现断言。持续保留去重、排序、未读 CAS、远控队列、模型恢复等有效覆盖；更新夹具以显式提供 CLI 事实；已删除 Group 的测试随旧功能退场。
- 验证：首次受影响单测全量执行为 1711 文件，其中 16 失败；该轮后已逐项修正，尚未再次完成最终全量验收。不能将这轮失败全部归因于测试过时。

### D15：请求式对账可以迟到于较新的流式事实

- 原预期：请求结果来自 CLI，即可安全覆盖本地镜像。
- 实际：对账请求在等待时，较新的流式事实可能先到；旧响应回来仍会覆盖新标题或结果。新增测试先复现了两次写入。
- 处理：事实入口只保留在途请求代际；新帧、删除或较新请求撤销旧响应的落库资格，请求结束即清理，不新增会话状态缓存。
- 验证：迟到响应测试与同步器、仓库回归通过（该轮 3 文件、78 测试）。

### D16：桌面 E2E 前置构建发现 CLI alias 清单遗漏新迁移子路径

- 原预期：shared exports 已声明迁移模块，CLI 构建也应能解析。
- 实际：首次桌面 E2E 在 app 构建后、CLI bundle 构建时失败：手工 alias 将 `@zcode/shared/sqlite-migrations` 拼成 `src/index.ts/sqlite-migrations`。该轮未进入 GUI，不记为界面测试失败或通过。
- 处理：删除手工维护的 shared 子路径清单，直接从 shared package exports 派生精确 alias，把通用入口放在最后；补全部 exports 的构建契约测试。
- 验证：构建契约 11 个测试通过；完整前置构建通过，后续实际桌面 E2E 两例通过，见 D18。

### D17：冷态项目树仍把未知结果标成 completed

- 原预期：去掉旧状态写入后，冷态列表不再推测会话结果。
- 实际：项目树投影对无 `last_outcome` 的行默认 completed，首次迁移也把历史 running 当成 completed；facts 摄入还有按实时 phase 补结果的兼容分支。
- 处理：迁移仅映射明确的历史终态，其余为 NULL；新事实只接受 CLI 的 `lastOutcome`，冷态投影保持未知。同时禁止旧 JSON identity 覆盖行主键身份。
- 验证：新增失败用例后修正；项目迁移/仓库、facts、同步器及相关 UI 合计 6 文件、95 测试通过。

### D18：旧 E2E 就绪条件依赖已删除的 workspace 侧栏节点

- 原预期：沿用 `waitForWorkspaceApp` 可以验证新侧栏启动。
- 实际：Electron 已正常打开工作区，运行时显示正确 activeWorkspacePath 和可见会话 pane、无页面错误，但 helper 仍等待旧 workspace 树节点，导致两例超时。
- 处理：新结构通过实际 tab store 的目标 cwd 与可见 pane 判定就绪；保留旧页面的既有检查。创建操作的用例等待操作按钮，不依赖前一用例已切换掉的 cwd。
- 验证：真实 Electron E2E 两例通过：连续全局新建 cwd 独立/NULL 归属；空 roots 项目新建、改名、软删除、同 roots 恢复且 ID 不变。产物 run ID 为 `desktop-e2e-20260910181124116-p44201-cdce8d980fbeec75`。不覆盖多 roots、真远端或手机。

### D19：项目仓库可以被调用方指定为另一个 Host

- 原预期：项目服务天然只操作自己的权威数据库。
- 实际：首次实现允许 `saveProject.hostId` 直接指定远端 host，树查询也会返回本机旧影子行；这会使“缓存”和“远端权威项目”混在一起。
- 处理：仓库读写限定持库 owner；跨 Host 请求由服务层的显式 hostId 经现有连接管理器路由，离线失败。读取远端树复用 workspace identity resolver 登记映射；不创建 source-settings 手机 attachment 或独立 runtime。
- 验证：迁移、仓库、本机入口 3 文件 20 测试通过；全部项目操作路由与 identity 绑定 5 测试通过；架构门禁 0 baseline / 0 new。远端 UI/真连接尚待验收。

### D20：旧 native 创建入口与 ID 保护阻止归属预留贯通

- 原预期：V4 接入预留后，所有新建都使用同一归属入口。
- 实际：旧 `session/create` 未预留；CLI 还仅允许导入指定 ID，直接为普通 native 创建传 ID 会失败。原导入按外部 hash 指定 ID，也可能覆盖已经删除或继续过对话的记录。
- 处理：Host 的 native/V4 创建都经预留（缺省明确 NULL）；CLI 所有创建共用 ID 占用检查，拒绝持久化、内存和在途同 ID，异步 materialize 前占用、结束即释放。显式导入分配新 CLI 身份，旧 hash 只用于历史备份修复。
- 验证：V4 整文件 49 测试通过；native wire 针对性测试通过；CLI 创建/并发测试通过。CLI 协议整文件首次 111/112 通过，另一个失败为既有 ProviderConfigMap.toJSON 从对象变为 rules 数组后的旧断言；现改为通过公开 get 接口验证目标配置，重新整轮 112/112 通过。

### D21：定时/闲时定义只有 cwd，创建预留还会重新读取当前 roots

- 原预期：schema 增加项目字段后，既有派发链会自然沿用创建时的目录。
- 实际：Repo、scheduler → main → Host 消息与 task adapter 都需要显式传递附加目录；V4 创建原来还会用当前项目解析结果覆盖调用方目录。项目移除旧 cwd 或软删除后，普通创建校验也会拒绝已有定义的下一次运行。
- 处理：定义创建由 Host 解析并保存项目、owner、cwd 和目录快照；解析失败先于取号。派发/重试/resume 传保存值，明确空数组不回退。带快照的归属预留继续校验同 Host 的既有项目，但不重新校验当前 roots；普通创建保持原校验，项目概念不进入 CLI。
- 验证：新增测试先复现 5 项服务/存储失败和 3 项透传失败；修正 V4 mock 不持久化的夹具后，服务/存储、调度消息与 adapter 共 5 文件 197 测试通过。表单纯逻辑用例先复现同 cwd 项目合并，改按项目 ID 后通过；GUI 选择并提交空 roots 项目已通过：实际 SQLite 中归属正确、默认 cwd 已创建、附加目录为 []；完整远端调度仍待验收。

### D22：新侧栏把 React 点击事件传进了导航的 automationId

- 原预期：侧栏的无参数打开回调可以直接作为按钮 onClick。
- 实际：真实 Electron 捕获 `TypeError: e?.trim is not a function`。导航实现的可选首参是 automationId，直接传函数使 React MouseEvent 被当成 ID，点击 Automations 后页面未打开。
- 处理：按钮事件边界显式无参调用业务回调；不在导航里增加类型猜测兜底。
- 验证：两次真实运行均为前两例通过、新增 Automations 用例失败；第二次已保留异常栈与页面文本。修正后实际桌面三例通过，run ID `desktop-e2e-20260910190747339-p59006-eb792156746a45ba`。后一次菜单点击遇到 WDIO 坐标拦截，沿用已有自动化用例的可见 DOM 点击 helper 后完成；不将它冒充手机/远端验收。

### D23：自动派发固化目录后，手动冷恢复仍会读取当前项目

- 原预期：给 scheduler/create/resume 传固定目录就足以满足 H1。
- 实际：用户稍后从历史列表打开自动生成的 session 时，没有调度请求参数；普通目录解析会读当前 roots。若再按 automationId 查定义，定义物理删除后仍会丢配置。
- 处理：生成 session 的首次归属预留同事务写入不可变 `tasks.execution_directories`；三种冷恢复入口统一读取。普通 session 为 NULL，保留动态项目解析；重试和删除定义都不改初始化快照。旧定义迁移为明确 []，不凭新项目 roots 扩大旧权限范围。
- 验证：新增手动恢复/删除定义/重复预留测试先失败，修正后项目仓库/服务/迁移 3 文件 20 测试通过；两库 schema 检查通过并更新可审阅基线，未改历史 CLI migration。

### D24：历史影子 host 会占用连接名额，空变化刷新会重复广播

- 原预期：hosts 里的非 local 行都代表保存的远端连接，刷新后广播可直接驱动 UI 回读。
- 实际：旧 task 影子迁移产生 target_json=NULL 的身份占位；它们会显示为幽灵连接并挤占 20 个名额。另一个测试显示相同缓存也广播，接入自动刷新后会形成回读循环。
- 处理：只将有连接目标的记录作为保存的连接；把占位改成连接也重新校验容量。相同缓存消费 CAS 版本以拒绝迟到响应，但不发项目变更广播。
- 验证：两项新增测试先失败，修正后 8/8 通过；连接记录与 Source Directory 的集成仍属 U01。

### D25：现有启动重连会淘汰七天未上线的保存连接

- 原预期：设计中的“启动自动连接保存的 host”可直接复用现有候选枚举。
- 实际：旧候选 API 默认以最近七天过滤，长时间未用的设备永远不参与，项目也无法刷新。
- 处理：移除物理 Source 连接的年龄过滤及无用参数，仍按最近活动排序，并保留全局关闭开关、静默凭据及既有连接管理器的并发边界。逻辑 workspace history 的独立恢复策略未混入物理连接枚举。
- 验证：旧时间戳候选测试先失败；修正后 Source Directory 与启动门禁 2 文件 42 测试通过。随后新增“保存后从未成功握手”的候选测试，复现另一个遗漏，已补入同一枚举路径。

### D26：地址身份合并缺少成员代际，旧设置还会重新发起已移除连接

- 原预期：现有连接管理器与新入口表按 Source ID 对齐即可。
- 实际：首次连接前只有 SSH/WSL/Docker 地址身份，握手后才有稳定 Source；连接过程中移除/重加会让旧响应写到新成员。旧 Source Directory 还会单独枚举旧 settings 里的记录。
- 处理：首次 migration 导入保存的 Profile/Source 并合并地址别名；持久化 membership_id。现有 ConnectionManager 在 probe 前取得成员、发布 online 前条件提交；启动与自动恢复仅保留成员，Host 候选与 SQLite 成员表取交集。身份更换经原有确认后新增独立 Source，旧项目入口保持原属。
- 验证：连接管理器新增三例先失败，修正后整文件 37 测试通过；成员 admission 与入口事务 2 文件 15 测试通过；保存连接 migration 与入口回归此前 17 例通过。真实远端握手/移除竞态仍待 E2E，不能以单测替代。

### D27：远端全局新任务仍分配共用 default 目录

- 原预期：全局新建改到 project.prepareSession 后，远端也能沿用。
- 实际：Source 管理服务仍调用 fileService.ensureConversationWorkspace，返回同一个默认目录；它绕过了新项目服务。
- 处理：沿用当前在线 Source 连接，改调远端 projectService.prepareSession；每次独立 cwd、projectId=NULL。保留原有返回协议和 Source 路径记录，不另起 runtime。
- 验证：连续两次分配目录的新增测试先失败，修正后 Source 管理、连接、Directory、入口、migration 共 6 文件 112 测试通过。随后删除 Renderer 激活既有 conversation tab 的分支；已绑定 project 或 conversation 都建立独立 logical session，新增参数化回归通过（远端协议/工作区/HTTP 共 4 文件 89 例）。真实远端端到端仍待验证。

### D28：多个旧目录入口解析到同一多目录项目会撞唯一约束

- 原预期：旧入口逐条填入 remote_project_id 即可完成连接后解析。
- 实际：一个多目录项目对应多个旧 workspace 入口时，第二条更新触发 (host_id, remote_project_id) 唯一约束。
- 处理：通过 entry ID/版本 CAS 后，在同一事务保留已解析入口、删除当前重复旧入口。旧 cwd 对应多个项目时保持待选择，不自行猜归属。侧栏用 Host + 项目 ID 做聚合、选择与排序。
- 验证：新增 SQLite 去重用例和跨 Host 聚合用例先失败；修正后 2 文件 17 测试通过。随后补充目录歧义与 UI reader 迟到移除测试，最新侧栏 3 文件 9 例通过。

### D29：侧栏最初只读取本机树，远端缓存没有离线操作边界

- 原预期：项目服务能够按 Host 路由后，侧栏可以直接复用同一个节点。
- 实际：侧栏未读本机入口表；接入缓存后，旧节点仍显示展开、新建和编辑按钮，而且操作没有带 hostId。真实 Electron 首次离线用例失败（其余三例通过）。
- 处理：入口表控制远端可见集合，在线 owner 只提供其项目/任务；离线仅基本缓存，移除入口不触碰远端数据。读取提交前复查成员代际；节点操作传 hostId，离线只留本机移除。连接状态变化复用已有广播通知回读。
- 验证：组件与 reader 单测通过；串行完整重建后 4 个桌面用例通过，run ID `desktop-e2e-20260910195101440-p67448-3e05911527984db6`，包括离线缓存、不可展开/新建/编辑、本机入口移除、重载不复活、host 保留。远端显式添加、新任务导航、手机 shared-host 和真实在线操作仍属未完成范围。

### D30：并行 typecheck 覆盖 E2E Host bundle，导致启动进程退出

- 原预期：类型检查与完整构建/GUI 验证互相独立，可以并行执行。
- 实际：packages/desktop/tsconfig.host.json 开启 emit，outDir 与 tsup 都是 out/host。typecheck 把打包后的 index.js 覆盖为源码导入版本。Electron Host fork 后约 126ms 以 code 1 退出，页面仅 root-startup-loading。检查产物并在隔离 HOME 运行，复现 ERR_MODULE_NOT_FOUND（@zcode/rpc/src/foundation.js）。
- 处理：本次验证串行执行 typecheck → 完整构建 → E2E，后续 E2E 运行期间禁止会重写 out 的类型检查/构建。未用延长 UI 等待掩盖 Host 启动失败。
- 验证：run desktop-e2e-20260910194608389-p65882-0bfd4916e3bf8f3b 为启动失败，不能用于业务验收；串行 typecheck 完成后强制重建，run `desktop-e2e-20260910195101440-p67448-3e05911527984db6` 四例通过。

### D31：目录解析仅校验行与项目一致，没有校验当前持库 Host

- 原预期：row.host_id 与 project.hostId 一致即可保证目录归属正确。
- 实际：旧远端影子行仍保留在本机库里，本机查询可读到远端项目目录，即使树读取和创建已经限定 owner。
- 处理：目录解析同一读事务中先比较 row.host_id 与仓库 owner，再返回初始化目录；创建重试复用同一路径。
- 验证：夹具先补足 Host 外键后，针对性测试复现未拒绝；修正后仓库整文件 11 测试通过。CLI facts 与现有 canonical workspace alias 不改写。

### D32：owner-only 客户端没有 Controller 入口表，聚合读取却会整树失败

- 原预期：remote-projects 仅本机 Controller 可用，远端 owner 全部拒绝即可。
- 实际：直接接远端 owner 的 UI 仍需读取该 owner 的权威项目树；聚合 reader 先查询入口表时，controller-only 异常会阻断整棵树。
- 处理：同一服务工厂通过可信装配参数禁止 Controller 写入；owner-only readDirectory 返回空目录且不访问数据库。projectService 继续读取当前 owner 权威树，不新增 Controller 数据副本。
- 验证：新增 owner-only 查询测试先失败，修正后入口服务整文件 14 测试通过；编辑器另补当前 owner 恢复测试，避免强写 local Host。多端 UI 与远端转发链路仍未验收。

### D33：workspace 二次转发漏掉新项目频道，proxy 对象不能证明远端支持

- 原预期：remote accessor 有 projectService 即表示功能已经接通。
- 实际：Host 手动组装的 workspace 服务集合没有注册项目频道；客户端仍会生成未知频道的代理，无法据此判断旧 Server 能力。
- 处理：Server 握手声明可选 virtualProjects 能力，新 Host 据此转发 project/remote-projects；不改变 v1 必需频道集合。旧 Server 单 root 适配尚未实现，不能把可连接等同于完成 G1。
- 验证：转发、能力 schema、远端对话目录三个新增断言先失败，修复后 4 文件 89 测试通过。

### D34：远端 prepareSession 返回了目录，却丢失导航所需的稳定身份

- 原预期：传入 projectId 即可复用本机新建流程。
- 实际：旧新建 hook 忽略 hostId、把远端实际路径传给本机 addTab；远端目录解析只返回 cwd，未携带 attachment identity。
- 处理：Host 的 identity 装配器对 prepareSession 登记并返回 workspaceIdentity；Root 显式按 hostId 路由，远端通过现有连接器绑定 logical attachment 后再写该 identity 下的草稿，禁止 path-only 本机回退。手机只调用既有 shared-host switcher，不调用 native connect。
- 验证：服务与 Root 新断言先失败，修正后 2 文件 11 例；logical attachment 复用、跨 Source 同 cwd 隔离、失败只回收自有 attachment 新增 3 例通过。手机新 cwd 尚未出现在桌面 workspace 列表的场景仍待贯通。

### D35：workspace 激活会先预热无项目归属的草稿

- 原预期：远端 workspace 绑定完成，再给草稿设置 projectId。
- 实际：既有 onWorkspaceActivated 回调在绑定过程中已 startDraft，后续等待列表刷新期间可能启动空归属预热。
- 处理：open-project 意图携带可选 draftProjectId，在绑定激活的同一回调设置归属；避免先启动错误 roots 的实例再覆盖。CLI create 仍只消费 Host 解析的目录，不接收项目 ID。
- 状态：代码已接入，服务/Root 单测通过；尚需真实远端提交首条消息验证，不记为端到端完成。

### D36：项目编辑 E2E 在弹窗退出期间点击被根元素拦截

- 实际证据：run `desktop-e2e-20260910201812675-p72179-d846d2e013673374` 中 VP08/VP05 通过，编辑后的菜单点击及后续创建点击均被 html 根元素拦截；元素存在且可见。
- 排查：增加菜单→编辑→保存的 jsdom 生命周期测试（通过）；E2E 在确认 dialog 退出后采集 body pointerEvents / dialog / menu 数量。后续 run `desktop-e2e-20260910202050479-p73151-d269934d33e60ab1` 输出 `auto / 0 / 0`，4 例全部通过。
- 处理与新证据：测试明确等待弹窗退出再进行下一项交互，没有添加固定 sleep 或绕过 DOM 点击。run `desktop-e2e-20260910204013338-p98809-9f9638cd48e4d620` 再次失败，实测 `bodyPointerEvents=none / dialogs=0 / menus=0`，随后下一用例也无法点击。现已确认全局指针锁残留。增加动画交错测试后稳定复现：弹窗先关闭、菜单退出动画后结束，body 仍为 none。项目菜单改为非模态，编辑弹窗独占模态限制；测试由失败变为通过。真实 run `desktop-e2e-20260910204902586-p1481-2c14bfd9e5025eaf` 四例通过。中间 run 15 的样式 setter 诊断因 Chromium 不提供该 descriptor 而失败，不能作为业务验证，诊断已移除。

### D37：未打开 tab 的远端任务不能使用 workspace-scoped 列表操作

- 原预期：项目树展示任务后可以复用原 TaskList 的 scoped service。
- 实际：未打开 tab 没有 remoteSessionId；旧 Controller 又要求先查询它自己的列表才有 source 行，直接 mutation 抛“没有与任务地址匹配的 source”。
- 处理：复用 Window Controller mutateTask；先查询唯一 Source owner 行验证地址，再调用原 task service，新增 rename 意图转交 CLI。物理 Source 列表 scope 可以不持有 logical attachment，但必须有 Source ID 和 workspaceIdentity；不伪造 remoteSessionId，不切换 tab。删除只用于旧 Group 的 getGroupedTaskFacts 接口。真正打开任务才调用既有连接/绑定链；手机沿 shared-host switcher。
- 验证：未打开任务/未先查列表/不同 Source 拒绝的新测试先失败，修复后 Controller/投影 22 例通过；UI task 命令验证完整地址、未读 CAS、不调本机 rename。尚需真远端 GUI 和手机回归。

### D38：新侧栏替换后，旧列表聚合及组件仍整片留在仓库

- 实际：knip 找到未使用旧分区；dep:refs 对 Timeline、Pinned、useWorkspaceTaskLists 均返回 0 个生产静态引用，Sortable 只有自身 displayName。定向检索还发现仅相互引用的 WorkspaceSidebarItem / 拖拽模块，以及只对这些旧组件做断言的测试。
- 处理：删除旧 Timeline/Pinned/Archived、Sortable/WorkspaceSidebarItem、workspace 任务聚合 hook、旧 workspace/group 排序/折叠 helper 及专属测试。保留 workbench、搜索、公共任务行及 Controller，未删除仍有生产消费者的全局查询能力。新测试覆盖 Controller 频道限制、Host 选择、明确 NULL 归属、未读 CAS、远端 attachment 与引用稳定化。
- 验证：清理前全量为 1708 文件通过 / 11 文件失败，21 个失败均对应旧 UI 断言；此数字不代表清理后通过。新项目引用稳定化和导航回调稳定性测试先失败，复用现有 taskListItemStabilization 并保持事件函数身份，避免整树刷新时重绘所有任务行。第 3 轮全量已通过：1709 文件 / 14873 测试，2 文件 / 14 测试跳过。此后新增功能另行验证。

### D39：异步成员提交与 socket 发布之间缺少统一所有权检查

- 实际：复用已有连接时，等待成员提交后直接返回捕获对象；显式断开会被覆盖为 online。新 socket 在目录写入失败时未释放，在目录写入期间关闭也可能继续发布。另一个新增测试证实，Profile 移除后迟到的 admission 错误会重新创建 failed 行。
- 处理：每次 admission 等待后检查取消与物理 owner；所有未发布连接统一 finally 释放，成功发布才移交 map。close 回调只影响实际拥有的 online 对象，未发布关闭直接拒绝；移除后的错误不重建状态。
- 验证：前三个回归先失败，修复后连接管理器整文件 40 例通过；移除后迟到错误第四例也先失败；修正后连接管理器 41 例，连同成员与启动适配器共 3 文件 49 例通过。真实远端测试仍未完成。

### D40：旧 draftSessionId 已无生产写入，仍保留远程 service 与关闭分支

- 实际：全仓检索只找到 store 声明/实现和测试写入；V4 预热 ID 只存在于 pane。App 却按这个永远为 NULL 的字段处理侧面板归属，技能/插件/hooks 失效仍注入 session service 并保留直接 close 的旧分支。
- 处理：删除字段、setter、旧关闭逻辑与配置界面不再需要的 scoped session service。保留按 workspaceIdentity 隔离的失效版本，由 V4 pane 独占预热生命周期；侧面板沿已有正式 activeTaskId/草稿空归属语义。
- 验证：删除前重写的有效行为测试通过；删除后 store、技能、浏览器插件、hooks、远端插件刷新与建议提示共 7 文件 104 例通过。新建项目/技能变化都不复制运行态 ID。真实启动屏障/全局新建 E2E 已通过；技能编辑的完整 GUI 回归仍待补充。

### D42：旧启动恢复把所有 conversation 目录视为同一个 canonical cwd

- 实际：新模型连续全局新建会分配独立 cwd，旧恢复器却把保存的 conversation 路径替换成 default，并额外恢复该默认 tab。新增测试确认活动目录被错误替换。
- 处理：新版只按 lastActiveWorkspace 恢复，保留已经分配的 cwd；旧 canonical 清理仅用于未迁移的旧设置。main 也读取新字段，删除从 recentProjects 额外挑选三个 Agent 预热目标的逻辑。
- 验证：main 和 Renderer 新增回归先失败，修正后通过；真实 run `desktop-e2e-20260910213246795-p10401-c6c90180f685d4a0` 验证连续两次全局新建、保存活动 cwd、重载后同一 cwd/NULL 归属。

### D41：settings 文件锁只保护最终写入，多个 Host 仍可互相覆盖

- 原预期：单实例 updateQueue 与 atomicWriteText 的文件锁足以串行化设置保存。
- 实际：配置的读取和合并发生在文件锁之外；不同 Host 各自基于旧值组装整份 JSON，即使 rename 串行，后写者仍会抹掉前一个补丁。F5 的入口派生也必须在这条读改写边界内才能避免旧入口写回。
- 处理：两个独立 SettingService 的测试先复现 locale 被覆盖；文件锁扩到完整读改写，删除重复的 rename 队列。项目集合从同一 SQLite 快照派生，Renderer 仅写活动目录。
- 验证：设置服务 36 例、相关十文件 176 例通过；真实 run `desktop-e2e-20260910213246795-p10401-c6c90180f685d4a0` 五例通过，验证移除入口后旧 settings 条目消失。远端入口缓存与组织态没有反向同步。

### D43：旧 Server 的目录历史不足以还原 Controller 已保留入口

- 实际：旧远端的 workspace 打开记录可保存在 Controller 的 Source directory；远端 setting.json 没有对应目录。仅查询远端 settings 会让本机仍保留的单 root 项目无法解析，新增 Host 测试已复现空结果。
- 处理：旧 Server 适配器通过只读端口接收本机仍保留入口的 roots/旧 cwd，作为旧 task API 寻址信息；移除入口后不从旧 history 重建。升级后以原 entry ID/版本 CAS 解析真实项目 ID，多个同 root 项目保持未解析。项目编辑/拖拽在 UI 禁用，任务命令仍走远端 owner。
- 验证：单 root/Host/入口 CAS/UI 共 21 例通过，类型检查和架构门禁通过。旧分区查询期间置顶导致重复行的回归先失败，已以单次查询去重修复。真实旧 Server 二进制与远端 GUI 尚未验证，不能记为 G1 全部完成。

### D44：URL Server 绕过 SourceManager，且地址身份与稳定身份混用

- 实际：URL 连接由 WindowRemoteConnectionRegistry 持有，未进入 SourceManager；新项目连接/查询仅查 SourceManager，无法连接保存的 URL Host。未知 serverId 的 URL 也使用 remote:server 前缀，仅按前缀判断稳定身份会拒绝首次握手绑定。
- 处理中：复用 Registry 增加不创建 workspace 的连接/读取入口，沿用成员 CAS 和 CredentialService；首次握手固化 serverId，再升级为稳定身份约束。不得另建连接 map 或假 logical session。
- 验证：Registry/凭据/入口 CAS/真实 HTTP+WebSocket/启动门禁共 73 例通过，类型检查通过。无 tab 连接的加入/释放与迟到成员响应均有断言；桌面 URL 元数据 GUI 已通过（D46/D49）。首轮架构门禁提示 contract 测试和服务文件超长，已按 URL 测试与参数校验职责拆分，未修改 baseline。

### D45：schema 门禁漏掉自动 UNIQUE、CHECK 和字面量大小写

- 实际：sqlite_schema 中自动索引 sql=NULL，原门禁跳过；PRAGMA table_info 不返回 CHECK。索引 SQL 整体转小写也会吞掉 WHERE 字符串值的大小写变化。三个新增测试均先失败。
- 处理：比较旧表 CHECK 和自动 UNIQUE 的列顺序/collation/方向；SQL token 比较保留字符串。旧表新增约束也拒绝，避免降级写入受限。
- 验证：8 个约束测试通过，`pnpm db:schema:check` 对 app/CLI 实际迁移产物与基线均通过；历史 checksum 未修改。

### D46：GUI 断言错误地把 tab 实例 ID 当成重载后的目录身份

- 实际：URL GUI run `desktop-e2e-20260910221055895-p38398-c86a3a77954c832f` 已完成连接、显式添加、远端 SQLite 改名和本机移除，但重载后 tab ID 更新，旧断言误报失败；其余五例通过。
- 处理：断言改为 workspaceIdentity/workspacePath 的稳定目录身份，保持实际连接/远端写入/不复制组织态断言。此项是测试假设修正，不修改生产 tab 生命周期。
- 验证：重跑 `desktop-e2e-20260910221338304-p39472-6fe360a12a99df8d` 六例通过；真实 URL 连接、远端 SQLite 改名、本机无权威项目副本及移除后不复活均有断言。

### D47：新项目树的实时订阅仍只覆盖本地 scope

- 实际：useProjectTree 仅为 hostId=local 建 sessions-index scope，远端项目能显示持久化行，却没有运行/等待状态；直接连接远端 owner 时同样被该条件排除。
- 处理：复用共享 WindowControllerTaskListRegistry 的既有快照，只读取在线 activity；已保留任务 cwd/roots 通过原 listTaskList 观察路径登记，返回行不进入项目树。无 Controller 的直接 owner 继续用自身 sessions-index。
- 验证：纯叠加/共享观察器 9 例、hook 一例通过，包含同路径不同身份不串行、未知 task 不增加行、标题/排序/归属不变、无 tab scope 接入且不循环刷新。完整交互回归待跑。
- 增量验证：相关九文件 48 例、root typecheck 42 通过；GUI run `desktop-e2e-20260910222201616-p41037-1e080f212e2ed73b` 六例通过。该 GUI 没有真实生成中的远端 task，不把它记为远端 running/permission 交互完成。

### D48：普通 HTTP 开发入口尚未对齐 ServerCore 的项目 owner 身份

- 实际：ServerCore 已将 projectStorageHostId 设为稳定 Source，普通 packages/server/src/entry-http.ts 仍按 local 初始化，http.ts 也未声明 virtualProjects 能力。URL 的真实 GUI 验证使用 ServerCore，不能据此宣称普通 HTTP 入口已完成。
- 已处理：统一 createServerHostServices 装配、存储 owner、握手能力和 workspace 身份映射；6 文件 83 例通过。真实 URL Agent 执行仍待验证。

### D49：远端项目变更事件未接入本机入口读取链路

- 实际：本机修改远端项目后会主动 refresh，但另一客户端修改时没有本机通知；workspace collection 使用本地 broadcast，不能依此收到远端 state:projects。
- 处理：SourceManager 和 URL Registry 的物理连接分别持有远端项目广播订阅，只转发重读通知；按 connection owner 丢弃迟到事件，断开/更新时释放，不保存额外项目状态。
- 验证：新增通知/释放测试先失败，修复后 SourceManager 42 例通过；URL GUI run `desktop-e2e-20260910222620788-p42289-56623f89164f78e0` 六例通过，包含远端 owner 外部改名后本机自动更新。root typecheck 43 通过。hook 测试直接导入 RPC Emitter 被架构门禁拒绝，已改用测试局部事件端口，不增加 UI → RPC 依赖。

## 尚未解决或尚未验证

### U01：本机旧远端影子数据与“远端权威库”边界

- 发现：本机历史 task index 可能含远端影子行/手动 Group，首次实现据此在本机产生 remote host 项目（现已修正，见 D19）。设计要求远端组织态只存在远端库，本机只保留入口和基础缓存。
- 状态：迁移只创建当前 owner 的权威项目，旧远端影子和 Group 成员保留原表作为证据。入口移除/重加/CAS 刷新、连接成员与 F5 设置派生已接通；URL 元数据与本地手机 shared-host GUI 已通过。旧 Server 真实二进制、SSH/WSL 和真实远端手机执行仍缺验收证据，不能宣布整个远端迁移完成。
- 验收：连接后读取远端权威项目；移除本机入口不删除远端数据；迟到刷新和重启不得重建入口。

### U02：迁移屏障在 desktop main 与 CLI 启动间的落点

- 发现：app 库已在 main 建服务/窗口前升级；CLI 库由 CLI 启动时升级。设计文字要求“两库 main 建窗前”。两者时序并不完全相同。
- 处理：main 复用现有 executable resolver 执行一次性 storage-migrate，CLI 同一个 Store/runner 负责升级并关闭数据库；严格 JSON 和零退出后才放行。失败复用重试/备份/退出交互。子进程适配器五例、CLI 命令三例（含真实进程自定义路径/幂等/checksum 失败）已通过；真实 run `desktop-e2e-20260910210656230-p6013-8e20a30e8015402d` 五例通过，首窗已可读两库 ledger，main 日志中的屏障完成早于建窗。CLI 路径继续由已有 storage.sessionDbPath / ZCODE_SESSION_DB_PATH 解析；ZCODE_DATA_BASE_DIR 不是 CLI 历史库路径的替代品，不迁移旧文件。

### U03：产品入口的实现与验收进度

- 发现：侧栏项目路径已开始使用新服务，但全局/会话新建、旧 create API、自动化/闲时/Bots、设置和 composer、远端及手机聚合还有未接入部分。
- 当前状态：全局/native/V4 创建、定时/闲时本地项目绑定、Bot 项目绑定与 Host 路由、设置 roots 目录、Composer 项目引用和多 roots 文件候选、桌面与手机项目导航均已接入。旧 Group、草稿 session ID、Bot main bridge 和两份无读取方的远端列表缓存已删除。定时/闲时只能新建到本地、手机没有设置页是既有产品限制（D72/D76），不能混同为“远端不能创建项目”。第 49 轮 URL 真实远端 Agent 创建/附加 root/任务重开与双库归属通过，第 42 轮本地多目录完整进程恢复通过，独立旧源码升级/旧写入/再升级验证通过；第 52/53 轮 URL 远端 Agent 冷恢复通过；最终单测、typecheck、lint、架构与变更格式门禁均通过。最新手机回归受 D91 环境限制。

### U04：GUI 与真实远端验证的证据边界

- 发现：已增加 manual-review/pending 用例，但还没有完整运行桌面/手机项目交互、真 SSH/WSL、升级降级组合。
- 当前状态：第 27 轮桌面项目组合 11 例通过（8 GUI、3 Bot synthetic），包含 URL 元数据、设置未打开 root、Bot 授权；第 33 轮双 root Composer 1 例通过；第 34 轮实际 relay 的 390px 手机草稿 reload、提交、切走和重开 1 例通过。全部仍属 manual-review/pending。后续第 49 轮补齐 URL 真实远端 Agent 执行，第 42 轮补齐本地多目录完整进程恢复，独立旧源码四阶段验证补齐旧版本写入后的再升级。真实远端 Bot、旧 Server 二进制、SSH/WSL 和手机远端执行仍未验证；单测不替代这些验收。

### U05：环境证据有边界

- 基线新鲜度：首次远端 fetch 返回 HTTP 504，当时只确认本地 `--no-fetch` 通过；最终重新执行正常检查已通过（`/tmp/zcode-project-freshness-final.log`），当前分支无 upstream，落后 origin/main 6 个提交，低于 50 的阈值。
- 影响面：CodeGraph 无工作区索引，使用定向检索与 dep:refs；未执行 CodeGraph 影响面扫描。
- CLI 测试：部分 bootstrap 引用 adapter 的构建产物，改源码后必须先重建对应包，不能把旧 dist 的结果当作新实现证据。
- 工作区：预先存在的未跟踪 `packages/remote-desktop/` 不属于本次任务，未纳入本次重构。

## 后续记录格式

新增条目继续使用 Dxx（已确认问题）或 Uxx（未解决/未验证），记录原预期、实际情况、原因、处理、验证和状态变更。新的设计裁决先更新 spec，再在这里链接；不把“还没实现”写成已经接受的设计变化。

### D50：设置服务在异步操作中动态读取 HOME，测试清理触发越界写入

- 现象：Server Host 集成测试退出并恢复 HOME 后，后台设置投影继续写入，日志出现真实用户 setting.json；临时目录清理也报 ENOTEMPTY。
- 原因：SettingService 每次 IO 从当前进程环境重新求路径；生命周期结束不代表所有外部调用已经静默。测试级环境变量隔离不足以约束异步后台任务。
- 影响与修复：已核实真实 recentProjects/lastWorkspaceSession 被测试目录替换。保存受影响文件到本机临时备份，依据最近一条应用设置日志（2026-09-10 19:17:11）恢复这两个字段；保留当前 lastActiveWorkspace 与其他设置，并重算活动索引。该日志并非测试前完整快照，不能声称所有历史列表与测试前逐字相同。后续采用实例固定设置路径与子进程隔离，不用延时猜测后台完成。
- 验证：两个临时 HOME 跨实例回归、SettingService 全套 37 例通过；Server 子进程验证通过。恢复不涉及 session/正文数据库。

### D51：全新 URL Server 工作目录没有可接受的初始 canonical identity

- 证据：独立 Host 子进程成功完成项目 migration/create 后，resolveWorkspace 对无历史目录抛出 legacyRouteHint required；仓库仅接受 SSH/WSL/Docker hint，URL 的 server hint 也被拒绝。
- 处理：Server 装配为缺席 hint 提供自身稳定 identity；新 alias 接受合法 server route，已有 alias/历史 key 的优先级不变。URL 项目元数据 GUI 已通过不等于远端 Agent 首次创建已通过。
- 验证：新增 URL route 无历史用例先跑红，随后与独立 Host 子进程回归。

D48/D51 验证回写：统一 Host 装配、普通 HTTP 能力声明、首次 URL canonical 及原 alias 行为共 6 文件 83 例通过。真实 URL Agent 执行仍待 E2E，未据元数据测试宣称通过。

### D52：配置范围仍由已打开 tab 决定，无 tab 远端配置缺少身份 admission

- 证据：Plugins/Hooks/Subagents 各自从 connected tabs 枚举候选，Plugins 另造 active workspace tab；项目新增 root 但未打开 tab 时不会出现。Command scope 留有仅测试调用的旧 tab 去重函数。
- 处理：新增受管 workspace-config-catalog，使用 readProjects 与本机保留入口，按真实目录/完整 identity 去重，关闭 tab 不删除 root；移除已无生产调用的 getCommandWorkspaceTabs。配置目标是地址类型，不造 tab/session。远端配置复用 Source settings attachment，并在写入前通过既有 workspace alias 合同绑定 canonical key。
- 竞态：目录读取前后验证 membership/入口；绑定返回只对原目录与 attachment 生效。手机无 Source settings 权限时仍保持原 shared-host workspace 边界。
- 验证：Catalog 3 例、真实 React binding 2 例（先红后绿）、Source attachment 与原设置表单定向回归；VP11 GUI 已写入 pending，正在执行。未宣称手机未打开 root 的导航已实现。

### D53：降级期间新增的调度定义漏过首次 migration

- 证据：v3 migration 只在首次运行时补 automations/off_peak_tasks；每次启动 reconcileLegacy 只处理 tasks。旧版本再新增定义后，新列均为 NULL，重新升级不会执行 v3，定义缺少 owner/首次项目归属。
- 处理：每次启动同事务交接 host_id IS NULL 的调度定义，唯一 root 匹配只决定一次，附加目录保持旧版 []；已处理 NULL 项目、已保存快照与 cwd/canonical key 均保持。
- 验证：新增旧列写入 → 再升级 → 项目 roots 变化 → 再启动，以及远端持库 owner 三例，先跑红后实现。

### D54：菜单动画开始时 getElementText 返回空文本，GUI 断言读取过早

- 证据：VP11 的 Commands 目录去重/未打开 root 选择已经通过；Hooks 菜单找到 4 个 radio item，但同一毫秒内 getElementText 都返回空字符串，断言得到 0 个匹配。run `desktop-e2e-20260910230329344-p70290-54b2a0a4f04adf9d` 为 6 pass / 1 fail。
- 处理：断言等待目标 root 文本可见，再检查恰好一项；不增加固定 sleep，不修改生产状态或菜单动画。重跑验证中。

D52/D54 GUI 回写：run `desktop-e2e-20260910230731227-p71459-4419b0f2ce0a071f` 七例全部通过；Hooks 等待可见文本后确认两个 roots 各只有一项，未打开 tab 的目录可选。D53：project-storage 与 Server Host 共 21 例通过，schema 两库校验与 typecheck 51 通过。

### D55：Bot 候选依赖旧 tab 历史，读取 context 会重写 cwd

- 证据：listWorkspaceRefs 从 lastWorkspaceSession 构建并缓存 5 秒；readContext 根据最新候选更新 workspacePath/workspaceIdentity。仅给创建 API 加 projectId 不足以满足 H1。
- 处理方向：候选复用项目目录契约，Bot Repo 唯一保存执行快照；旧 context 只交接一次，保留 cwd，歧义归属保持 NULL。删除旧候选缓存及常态 cwd 改写，详见 spec 6.0.1。
- 状态：已补回归，正在实施。

验证回写：受影响单测第 5 轮为 1717 文件通过、1 文件失败；14904 例通过、2 例失败、14 例跳过。两个失败都是 Hooks trust 测试仍 mock 旧 hook 导致缺 export；改为 mock 配置目录公开边界后两例通过。不能把此次定向通过记成全量通过。

### D56：Bot state 整份写回会丢失并发绑定

- 证据校正：首轮回归误用了相同授权用户，第二个 Bot 被鉴权拒绝，该结果不能证明丢更新。改为不同合法用户并断言两次 /status 都成功；隔离恢复旧 writer 的对照运行 `/tmp/zcode-bot-state-race-confirmed-red.log` 只留下 webhook-2，确认整份快照写回丢失 webhook-1。对照后已恢复新实现。旧内存测试桩共享对象引用会掩盖该竞态。
- 处理：Repo 单文件锁覆盖单 context 读改写；初始化 CAS、命令更新和 provider cursor 共用此入口，命令不覆盖独立 cursor 字段。删除也不再写回整份旧 state。
- 状态：回归已先失败，修复验证中。

D56 验证边界：一轮组合单测出现 worker heap OOM，不能记为通过；同一 messageFlow 文件单独重跑 85 例通过。后续需再跑组合验证，不能将资源失败直接归为产品缺陷。

D55/D56 验证回写：项目候选、绑定、任务归属与真实双 Repo 并发写入的组合测试 15 文件 149 例通过；typecheck 55、architecture 49（baseline 0、新增 0）通过。此前组合 worker OOM 未再出现。远端 Bot bridge 与 VP12 GUI 仍未完成。

### D57：Bot GUI 回归硬编码了中文远控入口

- 证据：run `desktop-e2e-20260910233907955-p99005-70d98236032233d7` 的 VP12 创建项目成功，但未找到中文 aria-label；其他七例通过。测试环境 localePreference=system，不能假定界面一定为中文。
- 处理：入口与项目模式选项识别已存在的中英文本；不改产品语言状态或增加固定等待。
- 验证：run `desktop-e2e-20260910234135216-p700-9ed05502a4283931` 八例全部通过，真实 Bot JSON 含两个不同项目 ID，同 cwd 未合并、未创建 tab。仍为 pending，不计手机或真实 Bot 网络执行覆盖。

### D58：Bot main bridge 仍以 logical workspace 与旧历史为连接来源

- 证据：旧 bridge 从 lastWorkspaceSession 恢复 RemoteTarget，维护连接/runtime 缓存、三个请求表和超时；main 创建 logical session 并另给 Bot 一个 MessagePort，Renderer 再回填 tab/history。这与项目 Host 的唯一连接 owner 冲突。
- 处理：改为窗口 Host 注入现有 Source 连接，显式 connectHost、membership/物理代际 admission；删除旧 bridge、runtime port adapter、专用 IPC 和 UI 回填，不动原 task owner/lease、CommandInbox 或手机 shared-host attachment。
- 验证：旧链路删除后相关 5 文件 104 例通过，typecheck 57 通过；新路由架构检查 baseline 0、新增 0。真实远端 Bot 执行待后续验证。

### D59：Bot legacy canonical 未映射稳定 Host，绑定只比较项目 ID

- 证据：新增回归三例失败：SSH canonical 被误当持库 host，项目被交接为 NULL；入口移除重加后旧 prepare 结果仍写入 context；已固化的 legacy identity 离开入口后不能按 host 路由。见 /tmp/zcode-bot-legacy-admission-red.log。
- 处理：首次交接借入口解析稳定 hostId，保留原 canonical/cwd；后续传递已固化 hostId，不再依赖入口反推。稳定 server identity 与 hostId 冲突拒绝。绑定前后同时验证 membershipId 与入口 ID。
- 状态：先红后修复，验证中。

D59 验证回写：绑定与路由 13 例通过。随后 Bot 全套 149 例中 146 例通过，三个失败是旧精确参数断言缺少新增 hostId，已更新断言保持契约一致，待重跑。

### D60：替换项目侧栏时漏传当前 workspaceIdentity

- 证据：Shell 真实渲染回归用同 cwd、两个 remote identity，侧栏捕获的 identity 都为 undefined，attachment ID 正常；旧侧栏曾从 tab 推断，替换后该隐式路径消失。
- 处理：Shell → ProjectSidebar → Footer 显式传递当前 identity，远控入口复用现有 scope；不再根据 cwd 反推。
- 状态：回归先失败，修复验证中；不能据单测宣称手机远控端到端验证完成。

D58–D60 验证回写：Bot/侧栏/footer 14 文件 193 例通过；typecheck 59、architecture 53（baseline 0、新增 0）通过；lint 21 为 60 warnings / 0 errors。Electron run `desktop-e2e-20260911000411622-p5101-6894ef9b748866aa` 11 例全部通过（项目 GUI 8、Bot synthetic 3）；未包含真实远端 Bot 网络收发或手机新目录链路。

### D61：手机项目新目录不在旧 bridge 列表，草稿在 Root 替换时丢失

- 证据：Root 手机分支仅 switchWorkspace(identity)，main bridge 只匹配当前窗口已有 workspace；新分配 cwd 没有 logical scope 时被拒绝。Web 替换 Root 只传 taskId/navigationIntent，未传项目草稿；旧 Root 在 await 切换后仍继续写草稿。这里是代码路径证据，尚未声称真实手机复现。
- 处理边界：spec 6.0.3 先定义 Host 统一 prepare + 在线连接 admission；main 只转交 descriptor，手机仍为 replayable。新受管 project-workspace-navigation 三例与 Registry/Bot 共 55 例通过，涵盖无 tab 在线 Source、离线禁止 connector、scope 回滚保留桌面 owner，以及入口/物理代际变化。
- 状态：Host/main/Web/Root 已接入；本地手机 VP13 实际 relay 配对、项目/全局草稿与桌面 tab/Host 数量验证通过（`desktop-e2e-20260911004852556-p11949-7e2838ab53de5f5b`），真实远端执行仍待补。adopt 首轮因目录未创建失败，创建空目录后成功；应用测试初轮为缺模块，Registry 新增行为用例先失败再通过。

### D62：导航请求在 Host 返回目录后过早移出 pending

- 证据：新 main 回归中，目录已返回但首次 Provider 配置同步尚未结束；关闭窗口后再回成功配置响应，导航仍返回 success。`/tmp/zcode-mobile-project-window-close-red.log` 为 38 pass / 1 fail。此前 Host 退出用例本来就通过，不能当作此问题的失败证据。
- 处理：请求保留到完整 admission/初次配置同步结束；关窗、取消、Host 退出、shutdown 均结束 pending。迟到结果只能交付给仍持有相同请求与 scope 的调用方，不建立第二份任务状态。
- 状态：先红后修复，main/Registry/应用模块/协议 132 个测试通过（`/tmp/zcode-mobile-project-admission-green.log`）。后续 main bridge/协议 94 个测试、Root 草稿 14 个测试通过；Host、main、Web、Root 已接入，真实手机 E2E 仍待执行。

### D63：旧手机 bridge 没有项目意图与导航去重

- 证据：新增协议与 main 测试先出现 5 fail / 89 pass（`/tmp/zcode-mobile-project-manager-red.log`）；Root 交接 2 fail / 5 pass（`/tmp/zcode-mobile-project-draft-red.log`），旧协议剥掉项目字段、Root 在原 scope 准备草稿。
- 处理：严格项目意图只带 projectId/hostId；同一 bridge transport identity 复用整个 admission promise，新导航使旧请求失效，取消只命中对应 requestId。新 Root 先初始化项目/provider/输入再放开 bootstrap；手机旧 peer 缺 admission 时显式拒绝，不能隐式建立另一套 runtime。
- 验证：main/协议 94 pass，Root 与导航 14 pass。完整 typecheck 首轮发现 currentWorkspaceKey 可空与 randomUUID 默认参数推导过窄两项类型错误，已按契约修正，待复跑；手机 GUI 尚未完成。

### D64：手机实际 home 仍挂载旧 workspace 任务首页

- 证据：WorkspaceShellLayout 的窄屏分支挂载 WebRemoteControlMobileShell，后者直接渲染 WebRemoteControlMobileTaskHome；新 ProjectSidebar 的手机单测只验证单独组件，没有验证真实窄屏入口。旧首页仍拥有分组/排序/model 与列表请求，不能把此前结果当作全手机项目覆盖。
- 处理：先补 spec 6.0.3，窄屏与桌面共用同一侧栏渲染入口；手机 shell 只拥有 home/chat 导航和弹层，删除旧首页及仅供它使用的派生逻辑。静态引用扫描后再删除。
- 状态：实际窄屏 Shell 挂载回归先失败后通过；Shell/共用 sidebar 44 个测试通过（`/tmp/zcode-mobile-project-home-green.log`），旧手机首页、model 与旧模型专用测试已删除。第 28 轮 VP13 草稿 GUI 通过；既有任务扩展仍待通过，见 D67/D68。

### D65：dep:refs 对本次 alias 消费出现漏报

- 证据：删除前 `pnpm dep:refs packages/ui/src/WebRemoteControlMobileTaskHome.tsx:WebRemoteControlMobileTaskHome` 返回 0 references，但 `rg` 明确找到 MobileShell 的 `@/WebRemoteControlMobileTaskHome.js` import 与 JSX 消费。
- 处理：未把 0 当作可删证明；以全仓 import/符号扫描补齐调用方，先迁移 Shell 与导航测试再删除。dep:refs 工具本身的问题不在本次重构中修复，后续删除仍需交叉核验。

### D66：手机目录 scope 的 join 与失效边界遗漏

- 证据：手机主路径 E2E 通过后继续检查交叉生命周期，新增 3 个回归全部失败（`/tmp/zcode-mobile-project-join-red.log`，3 fail / 97 pass）：第二个导航提前绕过首次 Provider 同步、桌面采用手机 scope 漏记连接成功、Source replacement 后旧 bridge retry 仍返回已失效 descriptor。
- 处理：join 共享同一配置屏障与 pending owner 校验；桌面沿原 renderer-ready 提交；去重不能覆盖已有 bridge invalidation。
- 状态：修复后 100 个 main 回归通过（`/tmp/zcode-mobile-project-join-green.log`）。Source lifecycle 证据来自本组独立测试，不能以 VP13 主路径通过代替。

本轮验证补记：完整 typecheck 第 67 轮通过；组合单测 234 pass，D66 新增回归后的 main 单测 100 pass；architecture 第 57 轮 baseline 0 / new 0；lint 第 22 轮退出 0，仍有未清理 warnings。VP13 本地手机 GUI 1 pass，使用当前仓库 Web :5173、实际 external relay、隔离 HOME，未发送用户消息，未声明真实远端或调度执行覆盖。

### D67：手机既有任务打开仍依赖旧 workspace 列表

- 证据：共用项目树会显示无 tab 目录的任务，但 main getAvailableWorkspaces 只由 Renderer workspace 列表与当前 bridge 合成；普通 task bridge-open 仍要求目标出现在其中。新建项目 admission 已补齐，历史任务打开尚未贯通。这是静态路径证据，尚未称为真实手机复现。
- 处理：扩展同一 Host 目录 admission 来读取并校验已存在任务地址，沿 resolveSessionDirectories 恢复绑定目录，禁止 prepareSession 分配目录；main 只透传任务意图和 Host descriptor。
- 状态：新增应用层与协议回归先失败后通过，相关 110 个测试及完整 typecheck 第 70 轮通过。第 31 轮 VP13 扩展 GUI 通过（`desktop-e2e-20260911012737140-p19784-1fbf5aa543752f59`）：实际 relay、390px 手机、case-local 固定回复创建真实持久化任务，切到全局新目录再打开原 taskId/cwd/回复，桌面 tab/Host 数不增加。不是 CLI 冷进程或真实远端执行验证。

### D68：VP13 扩展回归在 relay 配对阶段超时

- 证据：第 29 轮运行 `desktop-e2e-20260911010438954-p14956-f84ac66c1ea4d4d2` 在 120 秒超时。Desktop 进入 waiting_terminal，Web 控制台出现 `External relay terminal socket error`，没有进入项目导航。此前第 28 轮相同真实 relay 的草稿导航通过。
- 处理：补充阶段标记及脱敏的 WebSocket origin/open/close 诊断后再复跑；不能据此判定 D67 正确或错误，也不能把网络问题直接归因于产品实现。
- 状态：第 30 轮确认超时发生在 mobile relay admission，且 loopback 接收器清理遮盖原始异常。独立 Chromium 对两个 relay origin 均能握手，不能归为外网不可用。清理修正并增加 CDP 后，第 31 轮直接通过，握手 origin 为 `wss://zcode.z.ai`。前两轮配对失败的根因未确定，不以一次通过声称消除网络/开发服务间歇问题。

### D69：Composer 仍沿旧 workspace/sessions-index 候选链路

- 证据：sessionsMentionProvider 通过 tab 与 remoteSession store 枚举 workspace，再让 sessions-index 决定候选行；fileMentionProvider 只读取 workspacePath，且以 relativePath 建 key。未打开目录的项目任务不可提及，其他 roots 文件缺席，简单拼接多 root 会覆盖同名文件。
- 处理：先补 spec 6.0.4；复用当前 Host 的 ProjectService 公共契约，删除旧 tab 枚举与 sessions-index 行集合路径。文件仍由同一 Host 的 fileService 读取，绝对路径去重与展示 root 名分离。
- 状态：8 个新 provider 回归初轮 7 fail / 1 pass；独立单组标题回归先失败。接入后 6 文件 84 个测试通过，含真实 workspace resolver 对远端 attachment 的选择、本机零请求。完整 typecheck 73、architecture 59（baseline 0 / new 0）通过。VP14 第 33 轮 GUI 通过（`desktop-e2e-20260911013146831-p21568-5a8a51dea879dad3`），root 展示、相对/绝对链接、chip ID 与跨目录项目标题/任务均有断言；仍为 pending，本地覆盖不能代替手机和真远端提及。

### D70：VP14 使用原生 clear 没有确认 Lexical 已清空

- 证据：第 32 轮已显示两个 root 候选并成功选择 A 的相对链接；接着 WebDriver elementClear/sendKeys，再点击 B 后仍读到 A chip。测试没有确认编辑器状态已替换，无法把该断言直接归因于 root 映射。仓库现有 setInputValueByTestIdDom 明确处理过原生 DOM clear 与 Lexical state 不一致。
- 处理：复用既有 Lexical E2E bridge 写入并确认正文状态，继续保留 B 的绝对链接与 chip 身份断言，不修改产品映射逻辑。
- 状态：只修正测试驱动后第 33 轮通过，A/B 的链接和身份断言均保留。没有据此修改产品文件映射。

### D71：手机 Root 重建没有恢复未提交草稿的项目归属

- 证据：openProjectDraft 首次 render 携带 initialTaskDraft，但 recoverVisibleSession/bootstrapPairedSession 之后 render 不携带；useRootPlatformEffects 会调用无项目参数的 startDraft，将 draftProjectId 清空。完整页面 reload 的内存 store 也没有该字段，现有 composer 持久化只保存正文与模型。
- 处理：先补 spec 6.0.3；在既有 workspaceKey 草稿 scope 保存可选项目归属，手机在 prewarm 前恢复。复用原 promotion/清理，不在 main/relay 增加业务状态。
- 状态：归属持久化与 Root 重建两个回归先失败；promotion 不得复制组织态到 Session 草稿的回归也先失败。修复后 8 文件 85 个测试、typecheck 75、architecture 60 通过。VP13 第 34 轮真实页面 reload + 提交 + 重开通过（`desktop-e2e-20260911013709698-p23351-af24792bba497b51`，14.3 秒），正文、projectId、cwd、最终 taskId 均有断言。

### D72：先前把远端定时/闲时新建列为必做项，未核对既有产品限制

- 证据：`docs/off-peak-task/spec.md` 多端条目与 `docs/ui/scheduled-tasks-main-view.md` 明确规定 Scheduled/Idle-time 新建仅限本地项目，旧远端任务继续管理，手机隐藏该入口；虚拟项目 H1 只裁定绑定虚拟项目、固化目录，没有明确废除远端限制。此前实施记录把开放远端新建列为缺口，依据不足。
- 处理：向用户异步确认是否扩展范围；确认前继续既有本地新建边界下的项目迁移，不把 Source settings attachment 扩成 Agent/调度通道。
- 状态：用户询问是否“远端不能新建项目”，已明确说明限制只针对定时/闲时任务的创建目标，远端项目与普通对话不受影响。当前继续保留既有调度范围，不把该限制记为本次新引入，也不把未新增远端调度视作功能遗漏。

### D73：清理审计仍发现没有消费者的旧空态创建链

- 证据：ScratchWorkspaceDialog 已没有 JSX/import 消费，仅 ChatEmptyState 重导出两个 helper 给旧测试；Root 的 createScratchWorkspace 回调继续经 App 传到 Shell，但 Shell 不使用。dep:refs 首次用了文件名而非实际 export，读取 export 后重查，并用全仓 rg 交叉确认。另有三个存量 store 测试只有 setup 没有断言，不能贡献有效覆盖。
- 处理：删除旧弹窗、helper 测试与空回调链，移除本次改动残留的未使用导入/参数；保留独立 fileService 公共 IO 方法，本项不借死 UI 断言旧客户端 RPC 不存在。
- 状态：旧弹窗与回调链已删除，相关 6 文件 102 例通过，typecheck 78 通过；完整受影响第 6 轮运行中。

### D74：两个远端 Renderer 列表缓存仍只写不读

- 证据：全仓检索 remotePinnedTaskStore / remoteTimelineTaskStore，生产调用方只剩连接后的 refresh 和 Header rename/pin/archive 的 upsert/remove，没有订阅或读取 items 的组件。连接完成仍等待这两份缓存读取，Header 仍维护额外乐观/回滚副本；新 ProjectSidebar 与全局 Controller 查询不消费它们。
- 处理：先补 spec，删除缓存与刷新端口/写入调用。保留实际被 Header/全局搜索消费的 task query projection，不把此次清理扩展为改动 H4 全局搜索语义。
- 状态：两份缓存、连接等待与 Header 乐观/回滚副本已删除。首次清理漏掉换行调用，被 typecheck 77 检出；补齐后全仓确认无 UI 引用，typecheck 78 通过。连接时序回归先失败，删除旧刷新端口后与 Header、选项共 4 文件 67 例通过；attachment/身份/owner 路由保留。

### D75：定时/闲时项目选择仍读取整个任务树

- 证据：useAutomationProjectOptions 只使用 projects，却调用 readTree，额外读取任务并进入自动归档路径。只读目录契约 readProjects 已存在。
- 处理：新增候选读取回归先失败，改用 readProjects；新建范围暂按现有产品文档保留本地项目，范围确认未回覆不视为授权新增远端调度能力。
- 状态：只读目录回归先失败，改用 readProjects 后与远端缓存清理共 4 文件 67 例通过，typecheck 78 通过。

### D76：H2 手机设置目录被误列为待实现交互

- 证据：`docs/ui/settings-sidebar-layout.md` 明确说明手机 `/remote` 当前没有设置页入口；现有 Source settings attachment 也是桌面配置面，已有回归禁止手机借此取得桌面配置连接。此前把“手机设置选择未打开 root”列为缺口，同样越过了现有产品面。
- 处理：H2 保持已有 desktop/web 设置页的项目 roots 目录候选；手机只验证既有任务/草稿与 replayable 边界，不新增设置页或扩大 Source settings 权限。
- 状态：已纠正验收范围；真实远端多 root 配置仍属于桌面设置验证。

### D77：组合 pending 回放遗漏显式 fixture 参数

- 证据：第 35 轮在启动前被 E2E runner 拒绝，manual-review 默认 capture，使用 replay 必须显式指定 fixture；没有进入应用，不记作产品失败。
- 处理：使用已有 common、VP13 和 VP14 case-local fixtures，保留可重跑的完整命令。
- 验证：第 36 轮组合通过，`desktop-e2e-20260911020045948-p49055-2d26d5dab6dde052`，5 文件 13 例（10 GUI、3 Bot synthetic），包括清理后的桌面项目、双 root Composer、390px 手机草稿 reload/提交/重开。仍为 pending，未晋升 formal。

### D78：任务行只允许 copy，浏览器拒绝项目 move 的 drop

- 证据：第 37 轮真实原生拖拽未出现确认框；DOM 事件记录为 dragstart allowed=copy → 目标 dragover effect=move → dragend effect=none，没有 drop。旧任务行只为 workbench 复制设置权限，新项目目标要求移动，浏览器拒绝两者不相容的操作。
- 处理：先补 D2 spec，任务行允许 copyMove；项目 move、workbench copy 各自保留语义。回归验证缺 root 的取消不改归属/roots，再次确认原子移动，session cwd 保持。
- 状态：第 38 轮通过，`desktop-e2e-20260911020808906-p52221-4f812704888105ce`，1 pass，10 秒；两次拖拽均出现 drop，取消和确认的真实 SQLite 归属/roots/cwd 断言通过。分屏/拖动预览/任务行/离线项目共 4 文件 14 例通过，typecheck 79 通过。之后补入移动后打开正文的断言，待下轮 GUI。

### D79：冷重启测试 helper 强制等待已不应打开的默认目录

- 证据：VP16 第 39 轮实际模型请求已证明 CREATE/LIVE 均使用 A+B 能力、只读取 A 的 AGENTS；完整进程重启后 helper 却先等待 ZCodeProject，报“主界面没有切到工作区”。F5/F13 只恢复上次活动的 A，不应额外创建默认 tab。helper 的目标参数已是 A，前置等待仍写死默认目录。
- 处理：两种重启 helper 都只等待其明确请求的 workspacePath，复用原进程退出与 profile 刷盘屏障；不为测试改变产品启动行为。
- 验证：两个参数化回归先失败，修正后 2 文件 3 例通过；第 42 轮完整冷进程恢复通过，见 D81。

### D80：独立旧 checkout 的测试启动器没有 tsx 命令入口

- 证据：跨版本探针前两次启动分别因旧 checkout 的 `pnpm exec tsx` 不存在、错误假设 `apps/zcode-cli/node_modules/.bin/tsx` 存在而失败，没有进入仓库写入逻辑。
- 处理：显式使用当前已安装的 tsx loader 加载脚本，业务模块仍全部从传入的旧/新 checkout 解析；旧 CLI contracts 单独在旧 checkout 编译，不把新版 workspace 包软链给旧代码。三个数据路径环境变量在进程启动前固定到同一隔离 HOME，脚本有目录前缀和环境一致性断言。
- 验证：持久化脚本 `scripts/verify-project-upgrade.mts` 第 5 轮四阶段全部通过；旧 writer 实际改名、删除、新建，新 facts owner 经注入的真实 CLI Store 确认并清位，正文/外键/历史 checksum/归属均保留。此项不声明覆盖旧 Server 二进制与 stdio 传输。

### D81：完整冷恢复的 follow-up 被回放服务拒绝，组合产物不足以解释匹配原因

- 证据：第 40 轮 CREATE/LIVE 能力断言通过，完整重启已进入 A 的历史任务；COLD 请求返回 `Missing DeepSeek e2e fixture for POST /anthropic/v1/messages`，未出现预期回复。组合的共享 capture 文件随后被其他 case 重置，缺少失败请求的完整匹配证据。其余 13 例通过，不能据此把冷恢复算通过。
- 处理：单独重跑该 case，在清理数据前另存模型请求与页面截图；先确认匹配/运行时事实，不用扩大 matcher 或改产品恢复逻辑来消除失败。
- 根因：第 41 轮保存的请求与 CLI 日志确认，manual-review 默认注入 240-token contextWindow / 80 output，触发了本用例未覆盖的自动 compact。未匹配的是带 `CRITICAL: Respond with TEXT ONLY` 的维护摘要请求，尚未到普通 COLD 回复；该请求已经包含 A+C 能力且只有 A 的 AGENTS。不能通过放宽普通回复 matcher 吞掉摘要请求。
- 处理调整：沿用 WDIO 已有的 case 级剪枝条件，此用例使用普通 128k 窗口，避免把 auto compact 混入多目录生命周期验收。补充保留独立网络产物。第 42 轮 `desktop-e2e-20260911022115498-p80539-9be2fa2abb7679cb` 通过（1 例，13.4 秒）；CREATE/LIVE 普通模型请求为 A+B，COLD 为 A+C，AGENTS 始终仅 A，同一 taskId/cwd。

### D82：完整受影响测试与 GUI 并行时，两项既有 Web transport 等待超时

- 证据：第 7 轮 1723 文件通过、1 文件失败；webRemoteControlTransport 两例在 waitUntil 超时，无类型/协议断言差异。这轮同时运行完整 Electron 构建与 GUI；该文件包含 500ms/2s 的真实 socket 等待，之前第 6 轮完整通过。
- 处理：先独立重跑该文件，再串行执行完整受影响集；不改等待时长或据此修改 transport。负载相关只是当前假设，不能把一次复跑通过写成根因已修复。
- 独立对照：当前版本首轮在另一个 ACK deadline 用例超时；随后当前版本与独立旧 checkout 均 27 例通过。该 transport 源码及测试本次均未修改，尚不能确定超时根因。第 8 轮串行完整受影响集通过：1724 文件 / 14937 测试，2 文件 / 14 测试按配置跳过，303.55 秒。未通过放宽超时或修改 transport 消除失败。

### D83：URL 元数据测试服务器未开放 Provider 初始同步频道

- 证据：第 43 轮 VP17 新建远端任务在 workspace attachment 前失败，桌面日志为 Provider Provisioning 首次同步失败，独立 Server 日志为 `Unknown channel: provider-provisioning-target`；原 7 例通过。此前 URL 用例只访问项目元数据，没有走 Provider admission。
- 根因：测试 fixture 未传 `providerProvisioningTargetEnabled: true`，而生产 ServerCore 已传此选项。不是项目目录或 Agent 执行失败。
- 处理：fixture 按生产 ServerCore 开放原频道，删除手工复制 Provider 配置文件，依靠原初始同步；保留失败时 Server 日志/网络/截图，继续真实执行验证。

### D84：远端项目的权威 cwd 被普通目录选择再次 realpath

- 证据：第 44 轮 Provider 同步已 applied，Host 将 `/tmp/.../repo` 重绑定为 `/private/tmp/.../repo`；Renderer 短暂建立后立即撤销 logical attachment，最终空白。项目 prepare 的 identity 按原 cwd，普通 open-project 分支再次 canonicalize，随后项目导航精确 identity 检查失败。
- 根因：把已有 Host 目录/身份对当作未解析的用户路径，两个阶段各自决定 cwd。
- 修正边界：项目草稿与历史 task 将原 identity 贯穿现有 open-project/Host bind，跳过 Renderer 第二次路径解析；普通文件夹选择保持 canonical resolver。既有 task cwd、Host admission、身份精确校验与 desktop continuous/mobile replayable 不改。先补路径别名回归，再修实现，并续跑真实远端用例。

D84 回写：路径别名回归先失败（57 pass / 1 fail），修正后远端导航/Controller/历史 5 文件 69 例通过；typecheck 83、architecture 65（baseline 0/new 0）、lint 28（48 warnings/0 errors）通过。继续第 45 轮真实远端执行。

### D85：URL 实际执行成功，但项目归属与附加目录缺失

- 证据：第 45 轮已进入远端 cwd 并收到实际 Agent 回复；捕获模型请求没有附加 root 的 skill，测试清理前查询远端任务行的 project_id 为 NULL。尚未通过双库归属/重开验收。
- 定位：补充 Source 接收 createSession 参数和 Renderer 草稿 owner 的观测，先区分发送前丢失与服务路由丢失。普通 RPC 方法日志不足以定位该字段。失败后清理会删除隔离库，库证据必须在用例 finally 内、清理前保存；不能与 cleanup 并发读取后误判路径或 SQLite 损坏。

D85 定位结果：第 47 轮 Renderer 草稿有正确 projectId/cwd/identity，第 46/47 轮 Source 收到的 createSession 都没有 projectId。静态定位到 `ReplaceableConversationTransport.sendCommand` 仍只有旧单参数签名，丢弃新 context；直接 transport 的本地/手机用例不经过该代理，所以原测试未发现。先补跨 proxy 换代的转发回归，再透传原参数，不新增推断或服务端补偿写入。

### D86：复用远端 tab 的旧分支无条件取消传入 attachment

- 发现方式：沿 VP17 后半段“切走重开”检查既有绑定分支时发现，`selectRemoteWorkspaceProjectFromDialog` 复用 tab 成功后无条件 cancel(sessionId)，没有区分临时 attachment 与 tab 当前 owner。项目导航明确会复用当前 sessionId，因此这条旧逻辑会把仍使用的连接撤销。
- 处理：先参数化验证“额外临时连接应取消 / 当前 owner 不应取消”，仅补 owner 相等判断；实际任务重开由 VP17 后续验证，未执行前不算 GUI 覆盖。

D85/D86 单测回写：两个问题均先出现失败回归，修正后 V4 runtime/proxy、远端历史与项目导航 3 文件 72 例通过。第 47 轮已独立保留 Renderer 草稿、Source createSession 入参和任务事实 JSON，证明归属丢失位于 transport；完整远端执行与重开仍待第 48 轮确认。

### D87：远端 E2E 从原始 tasks 表选中了未发布的预热预留行

- 证据：第 48 轮远端模型请求包含附加 skill，Source createSession 带正确 projectId，两库 owner 断言通过；任务重开却查找了另一条 taskId。finally 的事实 JSON 显示，SQL `WHERE project_id=?` 取到前面的预热预留行（cli_last_outcome=NULL），实际完成任务是后一行。界面按合同不展示未发布预留行。
- 处理：用同一 `cli_last_outcome=completed` 条件等待并读取实际已执行的任务，再做 UI 重开；不让 UI 展示预留行来迎合测试。

D83～D87 GUI 回写：第 49 轮 `desktop-e2e-20260911025248939-p13972-1d10009d9a508916` 原 8 例全部通过。远端实际创建请求携 projectId、模型上下文有附加 skill、Source task/project/host/cwd/正文持久化、Controller 无该 Host task 副本、切走重开原 task、移除入口不删正文均已验证。第 48 轮其他 5 文件通过（冷恢复、引用/拖动、手机、Bot synthetic）；新增 VP18 远端 CLI 冷恢复尚待运行。

VP18 测试设施说明：runtime lifecycle 在公共接口上是可选能力，首次 E2E 类型检查拒绝直接调用；fixture 增加明确能力断言后，typecheck:e2e 和 case-local fixture 检查通过。此断言只限定冷恢复用例的观测条件，不把产品接口改成强制能力。

### D88：冷恢复测试看到缓存正文后立即点击尚未启用的发送按钮

- 证据：第 50 轮 Source 已完成 roots B→C 写入、旧 Agent dispose，新 runtime identity 出现；历史正文恢复后，测试点击的发送按钮仍有 disabled 属性，WebDriver 报 click intercepted。尚未发出 COLD 用户请求，不能按模型能力失败处理。
- 处理：沿用界面实际发送状态屏障，等待按钮 enabled 后再点击；不改产品时序或增加固定 sleep。

### D89：跨 runtime 的迟到 ACK 被拒绝后，现有恢复分类遗漏了该错误

- 证据：第 51 轮 runtime identity 已变更，Renderer 收到跨代 ACK 后记录 stale_ack 和 `fault.subscription.runtimeRestarted`，界面随后固定在错误页（VP17-final.png），发送按钮消失。D88 等待 enabled 的修正揭示了实际恢复失败，不能再归因于点击时机。
- 根因：transport 正确拒绝跨代 ACK；ProjectionStore 的 available 事件避免重复在途订阅，但随后 catch 的已知 runtime 回收分类没有包含这条错误，因而没有进入已有的有界重订阅流程。
- 修正边界：保留旧 ACK 丢弃、单订阅 owner 与原 retry budget；仅把确切的 runtimeRestarted 错误归入原恢复流程，不新建计时器/队列，不重放 command。先用真实 transport + lifecycle/restart + 在途 ACK 组合测试复现。确定性回归先失败再通过，相关 37 项通过；第 52 轮 VP17/18 的真实远端执行、重开及冷恢复通过。

### D90：Hooks 目录 E2E 在动画期间只等到最后一个选项文字

- 证据：第 52 轮远端 VP17/18 与本地冷恢复通过，VP11 失败于 A 的数量为 0。WebDriver 记录已有 5 个 menuitemradio，但并发 getText 的前四项为空，最后一项 B 有文字；原等待条件只检查 B，即刻退出，未等所有 roots 显示。
- 处理：仍使用既有 10 秒条件等待，待 A/B 两项文字均可见后，再各断言严格一项；保留原菜单 UI、目录 owner 与去重实现，不增加产品延时。
- 验证：第 52 轮为失败证据；第 53 轮同一真实交互用例通过，完整主文件 8/8 通过。

### D91：手机回归被外部 relay 的 TLS 证书校验拒绝

- 证据：第 52 轮 CDP 在 `wss://zcode.z.ai` 握手收到 `net::ERR_CERT_AUTHORITY_INVALID`，VP13 停在 mobile relay admission；截图为“无法连接中转服务”，尚未进入项目或会话导航。与 D68 早前不明原因配对失败区分记录。
- 处理：保留 TLS 校验，不修改产品连接/恢复行为；独立核对证书连接并重跑手机代表用例，未通过前不得宣称这一轮完整通过。curl HTTPS 成功，独立 Chrome HTTPS 返回 200，证书签发者为本机 Proxyman CA；未更改用户代理、证书信任或 TLS 校验。HTTPS 成功不代表此前 WSS 证书异常已经消除。

- D91 复验：第 54 轮手机单独运行仍在相同 relay TLS 握手失败；独立 Chrome 的无配对 WSS 探针没有成功建立应用握手，不能作为手机回归通过。第 48 轮既有手机完整交互通过记录保留，最后两轮失败不得覆盖或改写为通过。

最终单测回写：第 9 轮串行完整受影响测试通过，1724 文件 / 14942 测试（2 文件 / 14 测试按配置跳过），341.12 秒；包含 D84～D89 修正。D91 的手机外部 relay 证书异常仍按环境验证限制记录，不用单测通过替代手机交互验收。

最终门禁回写：typecheck 87 通过；lint 32 为 48 warnings / 0 errors；architecture 69 为 violations 0 / baseline 0 / new 0；变更文件格式与 git diff --check 通过。

### D92 用户验收发现 UI 与创建流程偏离旧版

创建缺本地/远端选择，分区折叠/拖动和 hover 操作丢失，项目行常驻省略号，底部出现连接入口。按用户截图与 z-code-2 恢复交互，保留 Host 数据归属抽象；时间线只隐藏入口。

### D93 空 Group 被反向迁移为空项目

migrateGroups 在 hosts.length === 0 时显式创建空项目，与“无 session 不迁移”相反。首次迁移只处理未删除成员；本机容器按备份核对来源，不按 Group 名称删除手建空项目。SQL/checksum 不变。

D93 本机修复：原备份中 19 个手建 Group 与 19 个覆盖名称的迁移项目按同一顺序逐项对应，其中 11 个零成员、零 root。核对当前行未变且无任务/调度/Bot/远端入口引用后，先备份再在事务内移除这 11 个误生成容器。备份：`~/.zcode/backup/empty-group-repair-20260911-gq2grh`。4101 条任务保留、其余 15 表哈希未变；41 个有用项目保留，quick_check 和外键检查通过。

### D94 纠偏回归的测试问题与连接生命周期

第 55 轮测试把 WDIO 文本选择器误写成复合 CSS，且只匹配中文；修正为合法、双语选择器。第 56 轮本地 UI/目录选择通过，离线 fixture 首次 reload 后未等工作区就绪，后续远端选择又误选列表第一个离线 Host，造成失败串联；增加运行时 DOM/布局诊断并按目标 Host 选择，保留原业务断言。创建向导还补充连接完成回调和临时 attachment 释放，避免复用旧连接弹窗时进入会话/目录绑定流程。

### D95 项目目录选择的跨端边界

初版复用 Source settings attachment 只能在桌面调用，手机没有此接口。收口为 projectService.readDirectory(hostId) 路由，Host 装配层复用 fileService/systemService，UI DirectoryBrowser 不再按当前 tab 或平台猜 owner；不读写项目库、不创建 workspace/Agent。第 57 轮 8/9 项通过（离线 fixture reload 就绪缺失）；第 58 轮该离线项通过，新增类型卡片检查因未等打开动画失败，改用可见性等待，未放宽业务断言。

D95 架构收口：project 公共服务增加 1 个目录查询意图后，发现旧只读适配器的 4 个内部端口也暴露在公共 contract。dep:refs 确认其仅由 legacy-single-root 使用，移回私有实现；文件 IO 注入端口同样留在装配实现，公共服务保留 9 个方法，不提高门禁阈值。

### D96 纠偏后的手机验收仍受 relay TLS 限制

第 59 轮桌面主文件 9/9 通过。最终重新构建后的第 60 轮运行 6 个文件，14/15 项通过，覆盖桌面创建/编辑、远端创建/目录选择/执行/重开/冷恢复、多 root 引用与 Bot；手机 VP13 在 mobile relay admission 收到 `net::ERR_CERT_AUTHORITY_INVALID`，120 秒用例超时，尚未到达新增的手机创建与目录选择断言。不关闭 TLS 校验，不把桌面模拟窄屏截图当作手机 shared-host 功能通过。证据：`desktop-e2e-20260911041509471-p81756-b19a03b8965c1300/summary.md`。

### D97 响应式截图必须恢复真实主题与侧栏状态

第 61 轮新增 390px 截图时，触发现有 WorkspaceShellLayout 自动收起侧栏；清除 viewport override 并不会自动展开，后续点击落在宽度 4px 的收起区域。只切换 dark class 也不足以切换 Zai 主题变量，人工查看发现标记 light 的截图仍为深色。测试改用既有 setTheme 测试入口、等待 theme-zai-light/dark 生效，恢复窗口宽度后通过真实侧栏按钮展开；不改产品响应式策略。

最终复查另发现已保存 Host 连接中仍能点击“添加连接”，会同时进入第二条流程。先加 pending Promise 回归得到失败，再复用已有 connecting 状态禁用该入口，不新增状态或队列。

本次 UI 纠偏最终验证：第 62 轮重新构建，`desktop-e2e-20260911042339326-p86585-46199afefdcc6fd0` 桌面 9/9 通过，包含实际远端创建与目录选择、任务执行/重开/CLI 冷恢复；1200/390px、Zai 明暗主题的创建类型/编辑器布局断言通过，截图人工核对。单测 29 文件 / 129 项通过；root typecheck 5 通过；lint 3 为 48 warnings / 0 errors；architecture 6 为 baseline 0 / new 0 / violations 0；39 个变更文件格式与 git diff --check 通过。第 60 轮完整 6 文件中的手机 TLS 失败仍未解决，不能以第 62 轮桌面通过替代。

架构影响：project-sidebar 负责表单/折叠等 UI 状态，project 服务负责 Host 意图路由，project-storage 负责首次旧数据转换；目录 IO 复用 Host 装配的文件服务，连接归既有连接管理器。保存后再添加入口、断开不回落本机；未引入任务副本或队列，desktop continuous / mobile replayable 链路不变。

本次代码（含单测/E2E）新增 1487 行、删除 463 行，净增 1024 行；新增表单分步与目录适配复用既有 UI/连接机制。暂存新增文件后再次执行 architecture，baseline/new/violations 仍均为 0。

### D98 Migration ID 应沿用 CLI 编号规则

用户指出 `v3_projects` 把 schema 代号混入了 migration ID。CLI 使用四位补零序号加语义名，task-index 此前没有版本化账本，故第一条应为 `0001_projects`，两个库各自递增。仅更名声明和启动/升级测试中的预期；SQL 文本（包括 checksum 输入中的 v3 注释）保持原样，并新增固定 checksum 断言。不为开发期临时名称给公共 runner 添加别名或第二套迁移逻辑。

本机先备份、在副本中更名并调用当前 projectStorage.migrate，确认 applied=[]、所有业务表哈希不变后，在真实库事务中仅更新 schema_migration.id。checksum、app_version 和 applied_at 未变；4102 条任务、41 个项目和全部 15 张业务表内容不变，quick_check/外键检查通过。备份与报告：`~/.zcode/backup/migration-id-20260911-cppLK7/`。第一次副本断言因 Node SQLite 返回的 null-prototype row 与普通对象原型不同而失败，发生在真实库修改前；比较时统一行对象后通过，未放宽字段断言。

D98 验证：5 文件 / 34 项单测通过（含首次升级、重复启动、downgrade 和公共 runner）；root typecheck 通过，lint 为 48 warnings / 0 errors，architecture baseline/new/violations 均为 0，格式与 diff 检查通过。第 63 轮 `desktop-e2e-20260911044122173-p94329-bf236dca664095c7` 重新构建后 9/9 桌面 E2E 通过，首窗确认 app `0001_projects` 与 CLI `0020_session_soft_delete_outcome` 已完成。影响模块为 project-storage 的迁移声明；schema_migration 仍由公共 runner 独占，启动顺序与桌面/手机时序不变。代码含测试新增 15 行、删除 8 行，净增 7 行。

### D99 项目行复刻遗漏图标状态与快捷按钮

用户进一步明确：旧 WorkspaceSidebarItem 没有独立箭头，而是 Folder/FolderOpen；hover 必须保留 Ellipsis/ListTree/MessageCirclePlus 三个快捷按钮，右键只是补充。上次错误地把右键菜单当作 hover 操作的替代，且没有接回文件树。此次直接核对旧行图标/操作区，以相同操作定义供更多下拉与右键使用，文件树复用现有组件和 Host 绑定；单 root 直接打开，多 root 选择，零 root 禁用。组件回归先得到 5 项失败；TooltipProvider 属于真实应用外层，测试补齐同样的 Provider 后验证菜单指针生命周期，不修改 tooltip 生产实现。

### D100 从文件树返回会丢失项目折叠状态

实际 E2E `desktop-e2e-20260911044927627-p7359-cb8e4a4e218a1954` 已通过更多编辑、两个 root 的文件读取及右键读取，但最后发现项目 aria-expanded 从 false 变回 true。根因是文件树替换列表会卸载 ProjectNode，其内部 useState 在返回时重置；不是新建按钮事件冒泡。将 Host + project ID 的折叠值移交常驻侧栏，项目行仅渲染受控值和发切换命令，保持单一 UI owner。测试还补回默认项目的实际导航，避免新用例结束在新 root 后污染后续既有用例。

第二轮 `desktop-e2e-20260911045203103-p11417-ebd0e1c6d11d98d5` 9/10 通过：项目行完整交互、多 root 文件树、未打开的远端 root 实际文件读取、远端任务与冷恢复都通过。唯一失败是旧离线 fixture 刷新后进入 API Key 欢迎页，诊断中只有 oauth/login test id，未进入离线项目断言。复用现有 loginWithApiKey 测试准备，仅在确实出现欢迎页时执行，不修改产品登录逻辑、不弱化离线缓存断言。

第三轮 `desktop-e2e-20260911045528228-p14085-79b286cd69402942` 主文件 10/10 通过，包含离线缓存重载、新项目行完整操作、多 root/远端文件读取与任务冷恢复；人工核对 `VP20-project-row-hover.png` 的图标和三个按钮。相关单测 19 文件 / 54 项通过；root typecheck 和最终 E2E 非输出类型检查通过，lint 为 48 warnings / 0 errors，architecture baseline/new/violations 均为 0。手机 shared-host 分支有路由单测，本轮未完成真实手机文件树验证，既有 D91/D96 环境限制不改写为通过。

本次 owner 收口：project-sidebar 持有折叠和文件目标，菜单共用动作定义；查看远端文件复用已有连接与 workspace 绑定。没有新任务队列、数据库副本、协议或 migration，desktop continuous / mobile replayable 边界保持不变。

代码含单测/E2E 新增 685 行、删除 123 行，净增 562 行；新增代码主要为恢复文件导航与对应回归。18 个本任务文件格式检查和 diff 检查通过，暂存新文件后架构门禁仍为 baseline/new/violations 全部 0。

### D101 编辑器缺少已有目录列表形态与删除入口

用户截图揭示：添加首个 root 后仍展示空态大卡片，目录以全路径和原生单选框呈现；编辑弹窗没有删除按钮。静态追踪确认 primaryRoot 已经由编辑器保存、Host 持久化，并由 prepareSession 决定新任务 cwd，主要目录能力存在但入口没有按参考实现。此次补紧凑目录列表、主要/设为主要和底部软删除，沿用原服务与所有权，不另写目录/任务删除逻辑；先补单测与真实 E2E。

D101 回归：新增 6 个组件场景修复前全部失败，修复后相关 19 文件 / 63 项单测通过。首轮桌面 VP22 已完成主要目录保存、重开、取消移除、新任务进入 B 和编辑器删除，但最后的测试数据库断言将真实列 project_id 误写成领域字段 id，报 no such column: id；按既有 schema 修正只读断言，不改产品。证据：`desktop-e2e-20260911051307158-p24991-fd711d370419e0ee`。

D101 最终验证：第二轮 `desktop-e2e-20260911051449253-p26668-5ffc16408305af4f` 桌面主文件 11/11 通过；1200/390px 与 Zai 明暗主题截图人工核对，目录列表、主要状态、末行添加和左侧删除入口均可见。主要 B 的数据库保存、编辑器重开、取消移除不落盘、新任务 cwd=B、软删除后原目录文件及 roots 保留都有实际断言。63 项单测、root typecheck、E2E 非输出类型检查、fixture check 通过；lint 48 warnings / 0 errors，architecture baseline/new/violations 全部 0。本轮未完成实际手机远控验收，未新增 protocol/Host/CLI/数据库变更。

架构范围为 project-sidebar（ProjectEditor 草稿/提交状态，Host 持久态不变）及 i18n；复用 getPathLeaf 和原 saveProject/deleteProject/prepareSession。代码含测试新增 371 行、删除 44 行，净增 327 行。11 个本任务文件格式及 diff 检查通过。

### 2026-09-11 产品体验保留回归

- 原预期：虚拟项目重构替换数据模型，保留未明确取消的旧交互。审查发现排序优先级/偏好、分页、折叠记忆、选中高亮、归档退出、置顶反馈、文件树和手机标记、远端菜单/诊断及顶部选中态漏接；收起未读点也被漏掉。
- 用户裁决：老 Group 不恢复，展开项目不进入目录草稿；其余旧体验保留，并恢复项目名右侧折叠未读点。先回写 spec 和 VP23–VP27，再实现。当前工作区已有另一项编辑器 roots 修正，保留其修改，不混作本次成果。
- 边界：CLI/Host 数据归属、迁移 checksum、continuous/replayable 不改；恢复在途 UI 反馈不恢复旧双写事实缓存。后续实际测试与异常逐项回写。

- 补查：ProjectTaskRows 把置顶 task 只传 pinnedTasks，而 TaskList 仅渲染 tasks，导致置顶区不只是缺标题，还会漏行。增加真实 TaskList 组装回归。远端诊断遗漏还包含 Host 装配只投影状态、丢弃当前错误；按原连接 owner 补只读投影和日志关联，不在 UI 缓存连接真相。

- 接线回归额外发现：手机任务文件树不能直接换显示路径，必须等待已有 shared-host attachment 切换；关闭后的迟到结果丢弃。管理服务 connectProfile 未携带 TransportContext.onLog，导致项目重连缺少真实 probe/upload 进度；现由 Host 注入原进度回调，连接 manager 仍是唯一 owner。
- 测试偏差单独记录：首次 Electron WebDriver 建立 session 超时、尚未进入用例；重跑成功。新用例初次把文案写死为中文，英文环境失败，改为现有双语文案。旧主文件截图后无条件 toggle 侧栏，且把内层 aside 固定宽度误当可见面板宽度，实际将面板关成 4px；改为读取 Shell 实际面板宽度后条件操作。以上未通过修改产品行为来适配测试。
- 已执行：16 文件 / 72 项相关单测通过；覆盖 running/prewarming 稳定排序、双时间偏好、分页、未读 Host 隔离、跨 workspace 高亮、归档失败保留、pin ACK/查询两种先后及失败回滚、手机文件树迟到结果、远端同步入口门槛及连接成员日志隔离。架构门禁 baseline/new/violations 全部 0；root typecheck 和 E2E typecheck 通过；lint 48 warnings / 0 errors（原有警告，无本次文件新增警告）。
- 桌面主文件 `desktop-e2e-20260911054217420-p41656-43031825c9424f42` 11/11 通过，包含新增 VP25 的真实远端任务离开后取消高亮、重新打开、归档退出正文、归档只写远端 tasks-index；CLI 正文保留。新列表文件 `desktop-e2e-20260911053640514-p37956-70e68e684c250479` 3/3 通过（VP23/24 及 VP25/26 的文件树、取消置顶、导航选中、1200/390px 与明暗主题）。更新了 session-management skill 的排序不变量，避免继续把“CLI 时间来源”误解为“只许按更新时间”。

- 最终并发审查发现，在途 pin 若以“ACK 且查询值等于期望值”释放，另一端紧接着取消置顶会让意图永久遮住最新事实。新增反例先红后修，删除 committed 标记和等值 effect，改为命令与本次刷新完成即释放；没有新增同步状态。
- 本轮手机 VP13 `desktop-e2e-20260911054347850-p42852-87fc8addca4cc9d8` 已用当前 Web :5173 发起配对，但页面截图显示 `AUTH_FAILED / 手机连接已失效`，未进入项目首页（本轮不是此前的 TLS 错误）。真实手机新建/文件树/访问标记仍未验收，不把桌面窄屏或组件测试算作手机链路通过；未改鉴权或绕过 shared-host 边界。

最终复核：简化 pin 在途状态后，相关单测为 16 文件 / 73 项全通过，root typecheck 再次通过。重新构建后的列表 E2E `desktop-e2e-20260911054637517-p44337-88f4615fa4853a48` 3/3 通过，包含取消置顶后仍可见、折叠未读、偏好重载及更新后的 1200/390 明暗主题截图。结合主文件 11/11，桌面共 14 个用例通过；手机 AUTH_FAILED 与真实 SSH/WSL 同步未验收的限制保留。

架构收口记录：变更模块为 project-sidebar（UI）、remote-projects（adapter 契约及只读投影）与既有 Host 装配。CLI/Host 保持原单写者；UI 只拥有偏好、展示目标和在途意图。命令路径沿用 windowController/zcodeTaskService、归档 UI 清理及远端同步 dialogs，desktop continuous / mobile replayable 不改。最终门禁 baseline/new/violations 全部 0；本轮 TypeScript 含测试新增 2085 行、删除 391 行，净增 1694 行。44 个本任务文件格式及暂存 diff 检查通过；工作区原有 ProjectNode 间距修改未纳入本次提交。

### D103 首次迁移丢失旧设置的项目顺序

用户期望升级后前几个项目仍为旧 setting.json 的列表。旧 UI 从 lastWorkspaceSession 恢复顺序，但首次迁移先把 tasks 的无排序 DISTINCT 查询放进 Map，再追加 settings；Map 对已有 key 的 set 不改变插入顺序，导致历史目录挤到前面。修复仅在 project-storage 的首次数据转换中优先接收 settings 顺序，再稳定追加历史目录与有效 Group；projects.position 继续是 Host 顺序的唯一事实，UI 不增加第二份排序状态。recentProjects 不是侧栏顺序来源。已有 ledger 的库不重新迁移或覆盖用户拖拽顺序，SQL/checksum 不变。

验证：先添加回归，本地与 Server owner 两例均复现顺序错误；修复后 4 文件 / 24 项存储测试通过，包含保存空项目、重复目录、conversation 排除、Group 后置和再次启动保留手动排序。新增真实冷启动 VP28 在 `desktop-e2e-20260911060959726-p55732-d1c9097e6416a7e4` 1/1 通过，DOM/SQLite 顺序及刷新均有断言，截图人工核对；root typecheck、E2E typecheck、fixture check、lint（48 个既有 warnings / 0 errors）通过。仅验证桌面本地升级；Server owner 为单测证据，未把这次验证计为手机配对或远端混排验收。

开发偏差：新断言放进原 contract.test 后超过架构 300 行上限，已拆到模块内 migration-order/contract.test.ts，未提高阈值。拆分时尝试比较 readTree 全对象，旧 fixture 缺 traceId 导致临时生成值不同，改为直接比较迁移前后持久行，未放宽持久化不变断言。首次 E2E 复用的构建缺少测试 bridge；重新构建后又在 WebDriver 创建 session 时超时，尚未进入用例；随后使用独立 HOME 重跑通过，未调整业务断言或增加产品超时。

架构收口：生产改动仅 project-storage/adapters，顺序唯一写者为 Host 仓库，读取旧 settings 仅发生在已有迁移事务内；失败回滚及再次启动幂等边界沿用 runner。desktop continuous / mobile replayable、协议和 UI 行为路径不变。暂存后门禁 baseline/new/violations 全部 0，12 个文件格式与 diff 检查通过。运行代码新增 12 行、删除 8 行，净增 4 行；含测试 TypeScript 新增 199 行、删除 8 行，净增 191 行。

### D104 本机需要恢复旧输入后由用户重测首次迁移

只读审计确认：本机 position 仍是旧迁移结果，前几项为 default、DEMO、ZCodeProject；保留的 9 月 10 日历史设置中 test-2、z-m、ios-demo、zcode-v4-ios 在当前库分别排第 22、29、18、30。当前 setting.json 已从错误顺序反向派生，不能当作升级前输入。用户明确要求不手改排序，并接受回退部分近期数据，改为恢复旧备份后自行启动验收。

可用完整快照为 `~/.zcode/backup/session-projects-20260909-141705/`：旧任务索引有 4078 行，无 projects 表、无 schema_migration；旧设置的前五个项目为 z-m、ios-demo、test-2、zcode-v4-ios、ios-demo-2。回撤前索引有 4111 行（新增 33、旧行无缺失），共同任务中 1 个标题、1518 个归档标记、17 个未读值不同。原始副本完整性和外键检查通过。现存两个 tasks_index 自动表级备份均为零行，不能用于本机恢复。

CLI 旧快照额外发现 `0019_dwf_journal` checksum 与当前库不同，并含另一分支的 `0020_dwf_run_result`；此次只重测 app 项目迁移，因此保留当前 CLI 正文库，不回退其 schema、不修改 checksum。当前 CLI 有 5076 个 session，旧快照 5054 个；本次没有覆盖正文。

执行前确认应用/数据库无持有进程，保存当前 SQLite 一致快照与设置，再以旧备份的完整文件替换任务索引和 setting.json；原文件及 WAL/SHM 同时保留，未手改 position、project_id 或 migration ledger。备份及审计：`~/.zcode/backup/project-migration-retest-20260911-Siq1ag/manifest.json`。还原文件 SHA-256 与旧备份逐字一致，quick_check/外键检查通过，当前库 4078 行、projects/ledger 均不存在；CLI 主文件及 WAL 哈希前后不变。

状态：已回撤，等待用户用当前代码启动；未提前执行 migration，不能把恢复检查当作这次人工升级验收通过。9 月 9 日快照比保留的 9 月 10 日设置更早，项目原顺序应按此次成套恢复的 9 月 9 日 setting.json 验收。只有本机数据操作与文档更新，没有生产代码改动。

### 项目折叠动效与任务行文件树入口纠偏

用户指出折叠动画遗漏、session 右侧不需要文件树按钮。旧项目行通过共享 Collapsible 控制高度与淡入淡出，新行直接用 expanded 条件挂载/卸载，导致共享动画及退出过程被绕过。复用原组件和原折叠偏好；删除仅服务于任务文件按钮的回调链路，项目行查看文件保留。先更新 spec、组件断言和真实动画 E2E，再实现。

动效证据复查：首轮 4/4 E2E 通过，但帧记录的首次收起从 31.9px 开始（完整高度 188px），说明包含上一条用例的展开尾帧，不能据此独立确认收起淡出。测试改为等待目标自身与透明度层的 Web Animations finished 后再点击/采样，并提前保存关闭轨迹；未修改产品计时逻辑。

第二轮收起从稳定 188px 开始，高度连续降至 0，但透明度只有 1→卸载后的 0，内层 animationName 在 closed 时始终是 enter。根因是共享 Collapsible 的同名 group 选择器还能匹配外层项目分区的 open，覆盖当前项目的 exit；改为当前 content 的 data-state 直接选择其子层。失败证据：`desktop-e2e-20260911063306405-p72094-97c1a6aba044b6f0/project-collapse-close.json`。第二个失败是上一条失败后项目保持收起而找不到任务行，不另改产品兜底。

最终验证：修正嵌套选择器后 `desktop-e2e-20260911063454327-p73583-868e8aab51e45e6a` 4/4 通过。关闭从稳定 188px 到 0，出现 exit 与 35 帧中间透明度；展开从 0 到 188px，同样有 35 帧中间透明度；反向点击后恢复完整高度、任务数和导航。回归 ID 整理为 VP29（运行报告旧 ID 为 VP28），避免与已存在的升级顺序用例重号。相关单测 28 文件 / 101 项、root typecheck、E2E typecheck、fixture check 通过；lint 48 个既有 warnings / 0 errors，架构 baseline 0 / new 0。knip 基线存在既有未使用项，未记为通过；删除任务专用解析器前结合全仓 rg 与 dep:refs 确认引用，类型检查确认调用链已清理。

范围：只修改 project-sidebar 与共享 ui 展示，折叠偏好和文件树的 request owner 不变；未添加 timeout、队列、持久化副本、schema 或 migration。desktop continuous 与 mobile replayable 路由未修改；窄屏/明暗测试使用共享 renderer，不计真实手机配对、远端 Host 或其它平台验收。

架构收口：project-sidebar/ui 与共享 ui 组件，baseline/new/violations 均为 0；生产 TypeScript 新增 199 行、删除 368 行，净减 169 行。格式与 diff 检查通过，保留工作区其它任务的未提交变更。

### 输入框项目选择器遗漏（2026-09-11）

用户截图发现侧栏与 composer 项目候选不一致。运行时 CDP 读取确认侧栏 44 项而旧 ChatEmptyWorkspacePreviewMenu 仅收到已打开的 z-m tab；旧筛选还截断前 5 项，以 cwd 判等并显示目录叶名。原因是重构漏接这个入口。按 spec 共用项目目录/排序，菜单改为项目身份、名称和 roots 搜索；搜索文案改“搜索项目”。无需修改数据库或迁移。


菜单完整展示后，桌面截图暴露原固定菜单高度会裁掉底部入口：改为候选列表独立滚动、footer 不收缩。验证中 WebDriver 的 clearValue 未触发 React input，改用真实键盘清空搜索；布局 Emulation 后的原生右键坐标不稳定，将布局检查置于正常交互验证之后。最终 VP30 E2E 1/1、单测 54 项及架构/类型/lint 通过，详见 coverage matrix。`pnpm knip` 全仓扫描仍报既有大量未使用项，未借此删除无关代码。

### 同名历史任务的未读错觉与详情标题缺失（2026-09-11，只读排查）

用户报告 `sess_c9fe3101-8917-4968-9bcc-62452a655837` 未读点清不掉、列表为 `1111` 而详情为“新建任务”。只读 SQLite、Renderer React props 与当日日志得到：

- CLI session.title 和 Host tasks.cli_title 均为 `1111`，标题未丢失。Renderer 当前实际打开的是同目录另一条 `sess_92389c86-7b37-4966-9114-1a38617bbb0a`，其 `resolvedActiveTaskMeta=null`；15:01:49.795 的 `zcode-session.readSession` 报 `Session is not active`，随后 15:01:50.945 V4 conversation subscription 成功。头部仍依赖旧 workspace/query-cache 元数据，未消费项目树的新投影；轻量 snapshot 失败被 catch 置 null，正文订阅成功不会重新触发这次标题读取，最终显示默认标题。
- 设置为自动归档开启、保留 7 天。当前打开的 `sess_92389…` 已是 `unread_at=NULL, archived=1`；`sess_c9fe…` 则仍为未读、未归档。日志中 15:01:19–49 连续打开多条不同 ID 的同名历史任务，每次 setTaskUnread 成功，未见显式 archiveTask 调用。项目 Provider 的内存行与数据库上述值一致，排除本次是旧 JSON unread 残留或界面缓存未刷新。
- 链路为：点击旧任务 -> CAS 清未读 -> 项目树刷新 -> readTree 执行 archiveInactive -> 刚已读的 28 天前 completed 任务符合 7 天归档条件 -> 同名下一条未读任务补位。Host 的 activeTaskRefs 仅包含非终态任务，并不包含“正在查看的已完成任务”。因此用户感知为原位置蓝点一直不消失，右侧还停在已经归档的任务；是否保护当前查看任务需要在自动归档交互合同中明确，不能用恢复旧未读缓存来解决。

定位文件：`packages/services/src/project/index.ts` 的 readTree/autoArchive、`packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` 的 activeTaskRefs、`packages/ui/src/hooks/useWorkspaceActiveTaskState.ts` 与 `useActiveTaskSnapshotMeta.ts`。本轮未修改实现或用户数据库。

### 归档管理实施记录

设置层与 WorkspaceShellLayout 是兄弟节点，原 ProjectDirectoryProvider 只覆盖侧栏/composer，直接给设置另包一次会产生两个读取 owner。本次提升到共同 RootWorkspaceContent 并让嵌套 Provider 复用，独立壳层仍可挂载。codegraph 两次报 no such table: unresolved_refs，限定源码检查替代，未修工具索引。TaskService deleteTask 接口旧注释声称仅列表隐藏，当前实现已委托 CLI mutateSessionFacts(delete)；实现沿用当前 CLI 软删除事实，不新增本机 tombstone。


首轮 Electron 1/3：归档与删除落库断言已经通过，后续误以为 browser.refresh 会恢复设置页，因此等不到归档页面。运行日志确认应用回到工作区；测试改为重新打开设置，再断言已删除任务不复活。该修正没有改动应用导航。用户随后明确中间下拉是排序方式，已去掉任务类型分类，仅保留更新时间/创建时间。

验证：相关单测 12 文件 / 67 项通过；最终 Electron `desktop-e2e-20260911073549408-p8673-2d528e9e7a8486a5` 3/3 通过，包含真实创建/更新时间反向排序、虚拟项目筛选、取消归档回写、删除确认取消、CLI time_deleted 与 Host cli_deleted、重新打开后的持久化结果、搜索范围批量删除、分组取消归档，以及 1200/390px 明暗截图和溢出检查。root typecheck、E2E typecheck、fixture check、lint（48 个既有 warnings / 0 errors）与架构门禁（baseline 0 / new 0）通过。真实手机配对/远端 Host/Windows/Linux 未运行，不能以窄屏截图替代。

语义图新增归档 surface、共享目录 owner 和任务 mutation adapter 关系；YAML 无重复 ID，新 seeds 文件/符号存在。四条悬空引用与 HEAD 完全相同，本次无新增；codegraph 扫描仍因索引错误不可用，未将静态检查写成图调用分析成功。

架构收口：归档实现位于 managed project-sidebar/ui，设置与 Root 仅装配入口，共用目录读取 owner 和单一路由 adapter。生产 TypeScript 新增 617 行、删除 42 行，净增 575 行；新文件均已纳入模块，未增加跨库同步或迁移。

### 当前任务标题与自动归档修复（2026-09-11）

用户确认修复后沿用现有七天追溯规则，不新增“当前查看任务免归档”例外：Host 树接受明确的未归档 → 已归档变化时复用 removeTaskState，列表与当前详情一起退出；首次读取已归档历史仍允许显式查看，离线缺行不能当归档。未读 CAS 本次没有缺陷，保留原逻辑。

详情删除旧 useActiveTaskSnapshotMeta 和旧列表/query-cache 拼接，改为现有 workspace-scoped getTaskMeta 读取 Host 索引。CLI 仍是标题唯一写者，Host 只是镜像；正文 V4 恢复与标题读取解耦，无 schema/migration 改动。项目树仍是唯一列表读取 owner，比较的两个已接受快照不是新的归档状态存储。

开发中额外发现：仅以 service 对象 + workspaceKey + taskId 判定标题请求资格，无法覆盖 attachment 重建但复用 service 的情形。先补失败单测，再将 remoteSessionId 加入读取身份；同任务刷新乱序与切任务首帧清理均已覆盖。

运行证据：首次隔离 E2E 在 15:35:09.849 完成 getTaskMeta（0.6ms），15:35:12.339 才完成 V4 subscribe（2484.8ms），真实历史正文及 E2E_AMT_COLD_TITLE 正常显示；没有标题 readSession 请求。首次第二项失败为测试使用了不存在的 sidebar-settings ID，改为公共 TID_TASK_SETTINGS_BUTTON 后桌面两项均通过。全部 fixture 写入 zcode-active-task-e2e-* 隔离 HOME，未修改用户数据库。最终验证与产物见 AMT coverage matrix。


### 用户追加要求恢复 CLI 原始库（2026-09-11）

用户在再次恢复 app 索引/设置后明确要求 cli/db/db.sqlite 也恢复到同一份 9 月 9 日 14:17 备份。已确认没有使用数据库的应用进程，先保存一致快照，再离线替换完整 CLI 文件；原文件与 WAL/SHM 留存，未逐表删除正文、未修改 migration ID/checksum。备份和审计：`~/.zcode/backup/cli-migration-retest-20260911-EQXKVM/`。还原前 session/message/part 为 5076/71350/239427，还原后为 5054/71269/239180；恢复文件 SHA-256 与旧备份一致，quick_check 与 foreign_key_check 通过。app 任务索引及设置哈希前后不变。

旧库与还原前库的共同 migration 中仍有 `0019_dwf_journal` checksum 差异，旧库还含另一分支的 `0020_dwf_run_result`；按用户要求保留真实旧输入，没有修改账本规避校验。未启动应用或执行 migration，等待用户手动测试；还原成功不代表此次旧 CLI 版本的升级验证通过。

### 再次成套还原任务索引与 CLI（2026-09-11）

用户再次要求恢复两库，沿用 `session-projects-20260909-141705` 完整快照，同时恢复配套旧 setting.json。离线备份后，tasks-index.sqlite 从 4092 行恢复至 4078 行且无 projects 表；CLI 恢复至 5054 个 session、71269 个 message、239180 个 part（与本次还原前计数相同）。两库恢复文件与来源 SHA-256 一致，quick_check/外键检查通过；CLI 阶段确认刚恢复的 app 文件未变。当前快照、原文件及附属文件分别保存在 `~/.zcode/backup/project-migration-retest-20260911-ZeaZCj/` 和 `~/.zcode/backup/cli-migration-retest-20260911-PBjmXq/`，README 与 manifest 记录本次审计。没有修改 migration 账本或手工调整顺序，未启动应用或执行 migration，留给用户测试。

### 自动归档触发点脱离项目树查询（2026-09-14）

用户报告 `sess_aa1fce05-2987-4915-86f7-69a5fd18f669` 打不开。两库行、项目、目录均正常；CDP 在 dev 应用里复现：22:08:04.86 setTaskUnread 清未读 → 22:08:05.10 V4 订阅开始 → 22:08:05.34 侧栏刷新 readTree 触发 archiveInactive → 22:08:06.28 项目树 false→true 调用 removeTaskState，详情退回草稿。该会话 7 月 24 日完成、用户开启了 7 天自动归档，此前仅因未读免于归档；当天 22:00 前后打开的另外四条同名会话也是同样被归档的。用户裁决：符合判据的任务应已不在列表，归档判定不能由点击 session 触发。

处理：新增 Host 定时扫描器 `packages/services/src/project/autoArchiveScheduler.ts`（服务装配后首轮 + 每小时 + `taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays` 变更后补扫，扫描串行、进行中合并为一次补扫，desktop-attached-remote 不启动），`readTree` 去掉 `autoArchive` 副作用；同时删除无人注入的 `beforeRead` 入口和无发射者的 `workspace_task_list_changed.reason` 取值 `auto_archive` / `realtime_sync`。不新增「当前查看任务免归档」例外，沿用 09-11 裁决。AMT02 改写为：开启七天归档后已读旧任务由设置变更扫描归档并离开列表，点开旧未读任务只清未读并保持打开。

验证：扫描器单测 5 项（首轮/间隔/dispose、关闭策略与仅在有变化时广播、并发合并补扫、失败后间隔继续、设置键判定）+ 项目服务/仓库/UI 归档清理相关 4 文件 27 项通过；受影响单测 1772 文件 / 15405 项通过，唯一失败 `taskIndexRepoWorkspaceIdentity.test.ts` 的 migration 列表断言缺少分支已登记的 `0006_default_workspace_tasks`（fd0061d734 引入，与本次无关）。桌面 E2E `desktop-e2e-20260914-143027-962` AMT01/AMT02 2/2 通过，AMT-facts：已读旧任务 archived=1、旧未读任务点开后 unread_at=NULL 且 archived=0、activeTask 仍为该任务。root typecheck、desktop typecheck:e2e、lint（48 个既有 warnings / 0 errors）通过；架构门禁唯一新增违规是分支既有的 `packages/ui/src/root/resolveConversationWorkspaceTarget.ts` 未受管文件，与本次无关。真实手机远控与 SSH/WSL 远端 Host 未复跑；远端 Host 与本机走同一装配代码，attached-remote 不启动扫描器。

### 自动归档判据改为纯按时间（2026-09-15）

重启到新 Host 后，用户点开的旧任务都正常打开且不再被清理（11:18 六次 subscribe OK，无「归档后清理」），但截图里 31 天前的 `113413423` 仍在列表。查库：这些行 `cli_last_outcome='error'`；本机超期已读未归档任务里 error 324 条、CLI 无结果 346 条（CLI 侧同样为 NULL，非镜像缺失）、completed 仅 6 条且都是当天刚读的。旧判据只归档 completed，这些任务永远不会离开列表。用户裁决：纯按时间归档，置顶不受影响。

处理：`archiveInactive` 去掉 `unread_at IS NULL` 与 `cli_last_outcome='completed'`，保留 pinned / deleted / cli_deleted / host 过滤与 `activeTasks` 运行中兜底；扫描间隔 1 小时 → 5 分钟；设置页中英文文案改为「最后活动时间超过保留期即归档，置顶与运行中不受影响」。AMT02 重写为 28 天前已读/未读/置顶 + 6 天前未读的组合。

验证：仓库/扫描器/项目服务/UI 归档清理 5 文件 38 项单测通过；桌面 E2E `desktop-e2e-20260915-035508-416` AMT01/AMT02 2/2 通过，AMT-facts：28 天前已读与未读任务 archived=1（未读保留 unread_at）、置顶旧任务 archived=0/pinned=1、6 天前任务点开后 unread_at=NULL 且 archived=0、activeTask 仍为该任务。root typecheck、desktop typecheck:e2e、lint（48 个既有 warnings / 0 errors）通过。提交时另一会话正在同一工作区 stage 主目录失效功能，本次用临时 index 只提交本会话 hunk，未卷入其改动。


# Session Manage 与远程上游整合

状态：2026-10-10 项目规则及提交检查修复完成，本地最终复验通过；真实 SSH/手机及跨系统验证待补。基线 `7c6d6094c6`，合入 `e6a09464ca`。
本文覆盖虚拟项目设计中与远程分组、多目录、无项目创建和排序冲突的旧裁决。

## 产品合同

- ProjectSidebar、项目归属、置顶、归档、未读、搜索及时间线沿用 session-manage；旧 Group 体系不恢复。
- 项目区平铺本地和远程项目，不存在 Host 分组。远程项目行展示设备和连接状态；设备管理仍走设置/连接入口。
- 本地项目允许 0..n roots。远程项目创建时必须选择恰好一个有效目录，该目录为唯一主目录，创建后不可更换、清空或追加；可改名、置顶、软删除及恢复。
- 远程会话必须先有项目。删除所有远程无项目新建入口，快捷键、composer、手机、调度创建及底层准入均不能绕过。
- 远程创建/恢复会话的附加目录为空；同 Host 拖动任务必须匹配目标唯一目录，禁止 addMissingRoot 扩张远程目录。跨 Host 移动仍拒绝，任何移动不改变 cwd。
- 没有历史远程多目录项目，不实现自动拆分、截断或迁移兼容。

```text
侧栏：置顶 → 项目（本地/远程混排）→ 本地未归类任务
远程：设备连接 → 选择一个目录 → 保存项目/入口 → 项目内创建会话
权威：CLI 会话事实 → Host 只读镜像；Host 项目组织态 → UI 投影
```

## 唯一写者和提交边界

继续使用 VirtualProject.roots 与 IProjectService。远程限制由装配的 ownerHostId 确定，不接受客户端指定 local 绕过；Repository 写事务原子校验 roots、路径不可变、task 归属和执行目录。prepareSession 在 mkdir/CLI 创建之前拒绝无项目或无目录的远程请求。

显示排序归现有控制端侧栏偏好，增加 `(hostId, projectId)` 顺序列表；不写多个远端的 projects.position。首次以已有顺序初始化，新建/显式添加插入所属展示区首位；改名、刷新、重连不改位置，删除入口清除偏好。置顶与普通区不跨区拖动；离线项目允许排序。正常偏好同步复用同一存储事件，不创建第二个列表事实源。

项目内容和任务归属仍在所属 Host；本机远程入口只缓存名称/roots 和显式加入状态。离线移除仅删入口；在线删除软删项目，不删消息。取消目录选择不创建项目/会话；迟到结果以现有 membership/entry 版本和 connection owner 校验，不得复活入口或抢焦点。目录失效仅让该项目失败，不创建替代目录、不影响其他项目。

桌面 continuous、手机 replayable 沿用既有共享 attachment，Main/relay 不新增项目业务状态或独立 runtime。

## 合并和迁移

继续合入 `staging` 的固定提交 `da486efbbbb2d194ddd70bcf733e687cc765887e`，起点为 `4595ea353ae254f67f750ec6a81d69d3e5422796`。项目规则与已有检查修复保持不变；接入 CUA workspace 包、历史先显示、Provider readiness 与 onboarding 记录的上游修复。冷恢复同时传递项目解析出的 `additionalDirectories` 与持久消息快照，保留初始化单飞、失败重试以及 continuous/replayable 边界。远端 onboarding 记录与设置、OAuth 一起透传远端 Source owner，不恢复旧 Remote Host 装配路径或混装本地记录。指定 staging 中的原样新增源码沿用固定提交准入规则，合并修改的源码继续严格检查。

```text
项目/目录校验 → 持久历史投影 → 单飞 runtime 初始化 → 允许发送
                                     └─ 失败 → 保留历史/草稿 → 显式重试
```

分组和会话管理以本分支为基础；连接、安装、认证、诊断、重连采用上游。公共文件逐段合并，不整文件偏向任一方。保留双方完整 migration ID、历史 SQL/checksum；不同名称的 0004 迁移都执行，不重编号。CLI 0023 soft-delete/outcome 与上游 Source/远端身份迁移均保留。

合入身份迁移时，CLI `schema.baseline.sql` 同步包含 `zcode_database_identity(scope TEXT PRIMARY KEY, identity TEXT NOT NULL)`。上游没有本分支的 schema 基线检查，保留旧快照会使合并后的 `db:schema:check` 在反向比较时报 `Removed table`，并非迁移删除了表。基线由 `pnpm db:schema:update` 从实际迁移产物生成，再用 `pnpm db:schema:check` 验证旧结构兼容与快照一致；不修改历史迁移或关闭检查。

基线补齐验证：修复前 `db:schema:check` 复现缺表，修复后两库结构检查和 8 项 schema 合同测试通过；CLI 身份迁移、逐表写入边界、冻结迁移启动共 3 文件 34 项通过。合并范围原有的 643 项模块登记错误，按固定上游原样准入和自有代码模块登记处理；这不替代类型、单测和 E2E 验证。

## 验收

| ID    | 场景与断言                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------- |
| VPR01 | 本地多目录与多个设备的单目录项目平铺，无 Host 组头；跨设备/离线排序重载保持，置顶不因排序改变        |
| VPR02 | 远程零/多目录创建、换/清空/追加目录均拒绝，项目和任务表无部分写入；改名/置顶成功                     |
| VPR03 | 远程无项目会话、伪造 local、附加目录、不同 cwd 移入均拒绝；同目录移动保留 cwd 和正文                 |
| VPR04 | 单目录项目的创建、首发、快捷键、历史恢复、定时/手机创建均保持 projectId/hostId/cwd 和空附加目录      |
| VPR05 | 取消、断线、重连、目录失效、移除入口后迟到响应无额外项目/会话/连接，不复活入口、不影响同设备其他项目 |
| VPR06 | 空库、上游库、本分支库分别升级；migration ledger、正文、组织态和隔离身份正确                         |

先写回归用例再实现。运行架构检查、typecheck、lint、受影响单测、E2E 类型检查及项目/远程 E2E；真实 SSH 和手机 shared-host 与窄屏布局证据分开。跨系统和真实环境不能执行时明确记录，不以 mocked/replay 结果冒充。

影响面核对：项目侧栏/编辑器/composer/导航、ProjectService/Repository、远程入口目录、Source attachment、调度和手机创建。Codegraph 两次报 no such table: unresolved_refs，采用源码/契约核对，不宣称图扫描完成。

## 项目规则整合阶段的验证（2026-10-10）

- architecture:check --changed：0 违规；typecheck 通过；lint 通过（107 warnings，0 errors）。代码图不可用，未宣称完成图扫描。
- 受影响选择器以 remote-policy、projectOrder、useProjectSidebarPreferences 为入口：549 个 Vitest 文件，6393 通过、1 跳过，附带 Node 审计通过。全合并包含上游新增 CLI/脚本，默认全 diff affected 会报告未映射路径，因此这里明确列出选择范围。
- services/UI/sqlite-migrations 模块批次：1490 文件中 1489 通过，运行中新增的 prepareSession 删除竞态用例最初失败；修复后的专项 21 文件 109 用例及最后新增的导航/身份/准备回归均通过。没有把该中间批次记为全绿。
- CLI 迁移专项 7 文件 64 用例通过。AST 对比双方原分支已有 CLI migration ID/SQL 全部保持；app 双 0004 与 Source identity/schema 的 ledger/checksum/回滚由迁移用例验证。
- 重建后的 macOS Electron：VPR01 平铺、跨设备离线拖拽、刷新持久化及入口清理通过，run desktop-e2e-20261010-034929-123。
- 真实本机 ServerCore HTTP/WebSocket + 远端 Host/CLI：项目创建、不可改目录、改名、移除/重加、文件树、首发、历史重开、CLI 冷恢复、归档及正文保留通过，run desktop-e2e-20261010-035958-302。模型响应使用 replay；这不是 SSH 证据。夹具服务器使用独立 ZCODE_DESKTOP_HOME_DIR，固定 root 内替换技能验证冷恢复，不再修改远程 roots。
- Fixture check 通过；新增用例保持 manual-review/pending，未晋升 CI。回放命令需 E2E_PROVIDER_THOUGHT_LEVEL=disabled，与 env preset 的实际 Option Spec 一致；本机旧 high 配置会被上游 Provider Provisioning 正确拒绝。
- TypeScript 的 build 模式会写 desktop/out，必须在 typecheck 完成后重建桌面再执行 E2E，避免拿被覆盖的未打包 Host 当发布产物。
- 未执行：真实 SSH/WSL/Docker、真实手机 shared-host、Windows/Linux GUI、完整主题/390px/国际化矩阵。旧远程详情/设备包装层的 pending 视觉用例需按本裁决复核，不作为本次已通过证据。

原目录未跟踪内容保持原样；交付使用隔离 worktree 的双 parent 合并提交，原分支未推进时才 fast-forward。经后续授权，必要检查通过后正常提交并推送，不使用 `--no-verify`，不创建 MR。

### 全量测试夹具收口

存储创建已经是异步迁移边界。旧测试必须等待 `createSqliteSessionStore` 完成后再读取、装配或关闭数据库，夹具类型使用 `Awaited<ReturnType<...>>`；不得把 Promise 强转成存储端口掩盖错误。生产持久化仍由原 runtime owner 执行。隔离工作区依赖须按仓库声明的 hoisted 布局安装，避免旧安装产物导致重复 React 和未应用补丁。

持久化测试隔离操作者配置，避免本机插件/MCP 混入生命周期；恢复断言包含模型可见、正文不可见的 agent 列表提醒。PDF 请求测试使用当前 Provider Registry 与完整 Selection，继续验证实际 HTTP 请求、能力切换与冷恢复后的页序。

### 提交门禁修复边界

指定上游原样源码按架构治理文档接纳，本分支新增、冲突修改和后续编辑继续登记模块。源码行数默认 800；本次已存在的超限 CLI 文件和移入模块的远程连接 hook 保留告警，不为清零告警机械拆分类或迁移目录。数据库历史 migration ID、SQL、checksum 不变。测试夹具按当前协议和异步初始化边界更新，删除的旧配置断言由实际配置 owner 的覆盖接替，不恢复退场的接口。

工作流子会话的 Shell 选择继承父 runtime 已完成初始化的会话快照；不能重新使用 app 创建时尚未解析的配置。脚本、expert 与 dynamic workflow 共用该继承规则，模型提示和持久化必须一致。

关闭完成边界：`进程退出 → stderr 收齐 → 生命周期退出事件 → 释放 Host 进程归属 → disposeAllAndWait 完成`。协议关闭只使 client 不可复用，不能提前宣布进程及诊断收尾完成；spawn 失败无 PID 时也必须结束同一个完成信号。TaskIndex 测试固定每个夹具的数据库路径，防止迟到初始化跟随全局目录切换并锁住其他用例的数据库。

### 提交前最终复验（2026-10-10）

- 类型检查、CLI 类型检查、lint、架构及 schema 检查通过。默认 800 行；已登记的大文件保留告警，架构违规为 0。修复期间撤回了仅为行数检查而进行的机械拆分。
- CLI 全量 36 个任务通过；根工具 Node 测试 35 文件、208 项通过。准入检查夹具补齐现行 `caseName/spec`，继续拒绝缺少身份或未授权的公共请求。
- 进程关闭与数据库夹具隔离的确定性回归先复现失败，修复后相关 151 项通过；根项目全量 2201 文件中 2199 通过、2 跳过，20574 项通过、13 跳过。
- macOS Electron 侧栏 VPR01 通过，run `desktop-e2e-20261010-130224-105`；源码/产物证据为 `fresh-stable`。
- 本机真实 ServerCore HTTP/WebSocket 与 Host/CLI 的 VP08/VP17/VP18 URL 用例通过，run `desktop-e2e-20261010-130359-895`。复用同次重建产物，5262 个输出指纹与前一 run 完全一致；该 run 自身标记 reused-build，不能单独声称重新构建。模型响应仍为 replay。
- 真实 SSH/WSL/Docker、真实手机 shared-host、Windows/Linux GUI 与完整主题/窄屏/国际化矩阵仍未执行；pending 用例未转正。

### staging 测试合同同步

通用鉴权头与配置身份用例通过既有 `ModelRequestSecurityState` 注入透传端口，专注验证实际 SDK/HTTP 请求中的凭据替换与隔离；官方版本请求安全校验仍由独立端到端安全用例验证。旧夹具不能依赖不完整 PAT 曾经绕过校验的偶然行为。工具的 Provider 兼容约束只作用于模型实际接收的 inputSchema；outputSchema 用于本地输出校验，保留严格结果 union，并以 adapter 测试证明它不会进入 Provider 工具声明。runtime 行数用例同步已裁决的 800 行上限。

Provider Provisioning 回归沿用上游当前合同：失效默认只是偏好，完整同步成功后原样保留，由 Host 解析推荐；默认指向删除项或无效模型不触发回滚。真实 IO、刷新或提交失败仍回滚并拒绝首次连接。同步更新 R3A-PRV-05/11 活跃用例矩阵，历史归档保持原记录。

### staging 合并复验（2026-10-10）

- 本轮合入 `da486efbbb`；类型、CLI 类型、root/CLI/CUA lint、架构（0 违规）、schema 及工具 Node 测试通过。架构回归 37 项、工具 Node 回归 210 项通过。
- 冷恢复同时保留项目附加目录与历史快照，continuous/replayable 回归 9 项通过；远程 onboarding 服务装配 13 项通过。CLI 旧断言与鉴权夹具修正后专项 93 项通过，Provider 正式磁盘/Registry 13 项通过。
- 历史夹具曾用空 stdin 启动 app-server，协议在异步迁移完成前退出，导致历史库未建立。改为等待现有 `storage-migrate` 命令，再写隔离历史数据；所有调用链等待完成后才启动 Host。
- macOS Electron：HF01/HF02 历史先显示、初始化前禁止发送与显式重试通过（`desktop-e2e-20261010-141711-970`）；VPR01 平铺/排序/移除入口通过（`desktop-e2e-20261010-142323-510`）；本机真实 ServerCore/Host/CLI 的 VP08/VP17/VP18 URL 创建、首发、历史与冷恢复通过（`desktop-e2e-20261010-142630-127`）。
- 三次成功 E2E 均为 reused-build；5274 个输出文件指纹与本轮 fresh-stable 构建 run `desktop-e2e-20261010-141320-708` 完全一致。模型使用 replay；真实 SSH、真实手机、跨系统和完整视觉矩阵仍待补，pending 用例未晋升。

根项目首次全量：2512 文件、23809 项通过，5 文件/48 项跳过；另有 CUA 连接超时 3 项和旧 Provider 断言 2 项失败。低负载合并复验这两个文件 28 项全通过，不把首次全量记录为全绿。CLI 并行批次在机器高负载下出现子进程超时，后续改用单任务/单 worker 原阈值复验。

新合入的 `v4-cold-resume` 历史先显示用例漏等异步 `bootRestartedServer`，在读取 `store.getSession` 前即失败；补齐 await 后同文件 50 项通过，未改冷恢复断言和生产执行逻辑。

OAuth caller 超时回归须显式控制授权 URL 发布时序：调用方预算结束后可以先返回 connecting 且尚无 URL 的快照，后台授权事务继续发布 URL 并完成重连。用例用 gate 保证超时先于发布，并等待发布完成信号后断言 URL；不能依赖异步凭据写入在 20ms 内完成，也不延长生产超时。

启动层回归同步当前合同：attachment 冷恢复钩子第五参是可选持久消息快照，目录仍占第四参；标题请求沿用上游宿主会话分类（interactive 为 main），以 query-source=session_title 表达用途，不退回旧 other 分类。测试同时断言这两个 Header。请求端口测试将大型模块加载移到文件准备阶段；真实 App 迁移和父子工作流集成用例使用 30 秒框架预算，保留全部结果断言、产品超时及取消规则，避免默认 5 秒把真实初始化开销误报为行为失败。

CLI 合并全量批次完成 35/36 任务；剩余 bootstrap 的 6 个失败经上述合同与框架预算修正后，5 个原失败文件共 54 项全部通过。正式推送仍执行完整 pre-push 门禁及用户授权的根项目、CLI 全量测试，不使用跳过检查参数。

Debug API 的文件测试必须显式传入夹具 logDir、eventPath 与 dbPath，并在结束后清理夹具。旧用例省略 logDir，导致真实 API 扫描操作者日志；全量并发下触发 5 秒超时。新增 source 路径断言钉住隔离边界，保持原超时与真实 Hono 请求/响应验证。

2026-10-11 复验：根全量两次均为 2514 文件、23814 项通过，5 文件/48 项跳过。CLI 完整批次中 35/36 任务通过，外置临时盘上的两份真实初始化测试出现 5 秒超时；原阈值在本机临时盘重跑同两文件 51 项全通过。Debug 隔离修复先复现 source 指向用户日志，修复后 6 文件 19 项、类型与 lint 均通过。磁盘不足造成的中止与外置盘超时单独记录，不作为产品断言失败或全量全绿证据；正式推送仍执行完整门禁。

真实远端 HTTP/RPC 单测的服务端必须显式绑定客户端使用的 loopback 地址，并等待 listening 后才读取端口。默认 IPv6 监听与固定 IPv4 客户端不一致时，随机端口可能命中本机另一个 IPv4 服务，握手收到 HTML 而非夹具 JSON。回归断言监听地址，保留真实 HTTP/WebSocket 与 ENOENT/ELOOP 行为，不通过 mock 网络规避。

工作流 B18 关闭回归以 runner 的 `model_request_started` 验证关闭后不启动新请求，以 run event 验证不再发布进度；服务端到达时间不等于请求启动时间。真实回环日志复现了关闭前启动并已取消的请求在 close 返回后才到达，故在观察窗口结束后执行既有取消回声不变量，不把在途报文误判为新重试。close 前落库、停止原因与同 journal 恢复断言继续保留。

本轮两项夹具修复的专项复验：HTTP/RPC 12 项、工作流生命周期/停止/服务 253 项通过；根与 CLI 类型、root/CLI lint、架构（0 违规）通过。保留原请求取消、恢复和目录失效断言；完整 pre-push 结果另以实际推送输出为准。

手机 relay 的真实 WebSocket 夹具同样固定 IPv4 loopback 监听，并在返回连接 URL 前断言监听地址。原 KICKED 用例全量中出现等待超时、单独复验 49ms 通过；已确认该夹具也存在地址族不一致，修复这一独立可复现的隔离缺口，不据单次通过宣称还原了超时现场。保留真实握手、KICKED 后重连与原 5 秒等待上限。

Relay 地址回归先失败（监听地址为 `::`），固定地址后同文件 22 项与根类型/lint/架构检查通过。该轮全量根结果为 2513 文件/23813 项通过、1 项 relay 超时；CLI 在高并发下出现迁移超时、App 初始化超时与 OAuth URL 数量断言失败，低并发同原断言专项 5 项全部通过。正式门禁后续使用单 worker，检查范围和失败传播保持不变。

2026-10-11 测试范围裁决：取消大规模单测删减，仅移除有历史超时记录的 App 用例。删除桌面 relay 的 `recovers desktop device transport from relay KICKED without entering a terminal state`；它曾在完整门禁中超过 5 秒等待预算。该删除减少了桌面端 KICKED 后自动重连的直接回归覆盖，不表示该场景已通过其他测试验证。保留同文件其余传输用例、手机 KICKED 冲突用例、全部 CLI/独立 CUA 单测与 E2E；不修改产品重连逻辑或测试超时，不使用 skip 或跳过 Git 检查。

2026-10-15 按用户确认，移除手机 relay 的 `keeps KICKED relay errors scoped to mobile session conflicts`。该用例在推送门禁中超过 6 秒等待预算，单文件重跑通过，但导致整批检查需要重跑。此次删除减少了手机 KICKED 重连后进入会话冲突终态的直接回归覆盖；共享重试策略的单测继续保留，产品行为不变。

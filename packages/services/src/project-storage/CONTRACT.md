# project-storage

Host 项目组织态的持久化升级。调用者持有 app SQLite 连接，CLI 通过协议交接事实，不导入此模块。

- `0005_projects`（旧 ID `0001_projects`）首次迁移旧 settings 中保留的 workspace；不删除或改写旧列语义、不移动目录。
- 首次项目集合与 position 仅来自 lastWorkspaceSession 中本 Host 保留的项目条目，按原顺序去重，保留无任务的已保存项目。conversation、历史 tasks、recentProjects 和 Group 不创建项目；settings 缺失或列表为空时不推断项目。历史任务保留 cwd 与组织态，无匹配项目时保持 NULL；已有 ledger 不重跑转换、不重排或自动清理项目。
- ID 沿用 CLI 的四位递增序号 + snake_case 名称，两个库独立编号；开发期旧 ID 的本机更名不修改 SQL/checksum 或重新执行转换。
- 初始 cli\_\* 从旧列复制一次，之后只由 syncer 写。handoff_pending 为意图与首次判定 bit；NULL project_id 是合法最终组织态。
- 老版本新写行以 host_id IS NULL 识别，同一事务补身份、首次归位与 bit 8；用户在新版移出/新建的空归属不能再次自动分配。
- 同 host 唯一 root 匹配才归位，主要目录没有优先级。Group 保留独立组织态，不转换为项目。
- settings 的 remote 条目只首次导入本机入口缓存，不能变成本机权威 project；普通启动不再导入。
- 迁移依赖 sqlite-migrations 公共端口；内部文件不被 UI/其他服务直接导入。目录/备份位置与 logger 均由启动入口注入。

项目仓库的事务面：save/delete/move/reorder/reserveCreatedTask 不写 cli\_\* 列。列表与目录解析在同步 SQLite 读事务中完成，不跨 await。缺 root 移动需要 addMissingRoot=true；恢复必须同 host 且 roots 集合完全相同。项目唯一名称在写事务中分配。新建 task 归属只在未决定时提交，后续由 moveTask 显式变更。

项目树任务沿用原列表/Controller 的执行后端过滤：仅 `provider=ZCODE_AGENT_PROVIDER`（当前 glm）。旧后端行即使已补齐 cli\_\* 也不进入项目、置顶、未归类、时间线、归档和未读投影；新导入的当前 CLI 会话保留，不按 migration_source、模型供应商或目录存在性过滤。只读，不改旧数据或 migration，已升级数据库无需再次转换；本地与远端持库 Host 使用同一规则。

新建项目在原写事务内分配同 Host 的最小 position 减一（空集合为 0），排在已有项目之前；编辑/恢复不改 position。position 保留为首次显示的初始化依据；控制端拖拽使用侧栏偏好，不向远端调用 reorderProjects。既有行不重排，不增加迁移。

自动归档以 cli_updated_at/cli_last_outcome 为筛选依据，排除已有非终态订阅，只写 archived；不按 project_id 或默认目录过滤。

定时/闲时派发提供已保存的附加目录快照（含空数组），预留只验证同 Host 的既有项目，允许 roots 已编辑或项目已软删除；普通创建仍校验 cwd 属于当前未删除项目。快照不改写项目 roots，重复预留不覆盖已有归属。

带显式附加目录的新建将执行快照同事务写入 tasks.execution_directories，后续任何恢复从此不可变值读取；普通 session 为 NULL，继续读取项目当前 roots。重试不得覆盖快照，定义删除不改变生成会话的初始化配置。

旧 Group、成员与顺序保持独立，不按成员目录新增项目。用户手建空项目合法；不修改已发布的 SQL/checksum。

0006_default_workspace_tasks 一次性纠正系统 default 目录误迁移：只处理旧迁移时已创建且未编辑、未改名、单 root 的自动项目，任务 project_id 清空且容器软删；CLI 事实、执行目录、归档/置顶/未读及定时定义不变。只触及 tasks/projects，旧 checksum 不变；后续手建/恢复不会重复纠正。

## 2026-10-10 远程单目录合同

本地仍允许 0..n roots；可信 ownerHostId 非 local 的持库宿主只允许恰好一个固定 root。远程创建必须有项目，prepareSession、reserveCreatedTask 与 moveTask 不得产生无归属或附加目录；根路径更新和缺 root 拖动在写事务中拒绝。客户端 hostId 不能改变持库身份。历史迁移数据不被裁剪，失败不得部分写入。

启动入口复用 session 模块公开的旧 Repo 与迁移适配器：先 SQL 迁移并提交，再逐一 ensureReady/close，最后标记 prepared。Worker 必须注入旧 settings 以完成首次项目导入；进度复制迁移事实，失败不撤回已提交计数。storage-startup 子路径保持不变。

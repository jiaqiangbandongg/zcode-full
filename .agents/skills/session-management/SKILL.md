---
name: session-management
description: 修改 ZCode 会话管理（左侧任务列表、tasks-index.sqlite、sessions-index、CLI session store、标题/状态/置顶/归档/未读/删除、虚拟项目与 roots、workspace 身份、相关 migration）之前必读。它把 2026-09 「虚拟项目与数据归属收口」重构及分组恢复的设计理由、历史 bug 根因与不变量蒸馏成检查清单，让后来者知道为什么这样设计、哪些线不能踩。
---

# Session 管理设计蒸馏

改动范围命中下列任一项时使用本 skill：`packages/services/src/session/taskIndexRepo.ts`、`packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`、`zcodeTaskServiceAdapter.ts`、`packages/ui` 侧栏 / 任务列表 / 项目树、`apps/zcode-cli/packages/adapters/src/storage/session-store/*`、sessions-index 协议、workspace / project / roots 数据结构、两库 migration。

权威 spec：`docs/superpowers/specs/2026-09-09-virtual-project-design.md` 与 `docs/ui/task-grouped-view.md`。2026-10-13 分组恢复裁决覆盖历史 Group 合并 Project 方案。本 skill 不重复 spec，只讲「为什么」和「怎么不踩坑」。

## 1. 一句话原则

**会话事实归 CLI，组织态归 Host；每个字段只有一个写者。**

```text
CLI  db.sqlite      存在性(软删除 time_deleted)、title+title_source、time_created/updated、last_outcome、正文、goal、fork、trace
Host tasks-index    project_id、pinned、archived、unread_at(+CAS)、sort_order、projects/roots/hosts、定时/闲时；控制端另存跨设备分组成员与顺序
                    cli_* 列 = CLI 事实的只读镜像，唯一写者 taskIndexSyncer
禁止：CLI 写 app 库；Host 写 db.sqlite；Host 对任何 cli_* 列写 Date.now() 或从 snapshot 推导的值
```

### 为什么

重构前 title / status 相关 Bugfix 注释有 30 多处（`rg "Bugfix" packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts packages/services/src/session/taskIndexRepo.ts`），几乎全部属于两类：

1. Host 替 CLI 写会话事实：`updated_at = Date.now()`（rename / 状态变更）与 CLI 的 `time_updated` 分叉，导致排序跳动，UI 被迫只信 sessions-index 的 `lastActivityAt`；rename 先写本地再 best-effort 通知 CLI，失败只 warn，两边「是否手动标题」不一致；`task_status` 从 snapshot 反推，冷启动恒为 completed，残留 running 只能靠 UI 规则吸收。
2. CLI 替 Host 决定行集合：3.4.0 曾因 sessions-index 快照缺 summary 导致历史任务在 Grouped 视图消失（`docs/superpowers/specs/2026-07-20-sidebar-task-row-authority-design.md`）；CLI 冷种子会复活 app 已删的 session，app 只能靠 tombstone 压制。

结论：不是「哪个库更好」，而是「谁第一手知道这个事实」。会话发生了什么只有 CLI 知道；用户对列表做了什么只有 Host/UI 知道；CLI 是每 workspace 一进程且可不在线，跨 workspace 的列表必须有 Host 侧落盘（`onDynamicWorkspaceEvent` 注释明确禁止为列表拉起 Agent）。

## 2. 不变量（改代码前逐条对照）

| #   | 不变量                                                                                                                                                                      | 违反时的典型症状                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| I1  | `workspaceKey = workspaceIdentity?.trim() \|\| workspacePath` 只表达身份隔离；执行路径永远用 `workspacePath` / `root_path`                                                  | 远程 identity 被写进 cwd（3.4.2 事故）                              |
| I2  | session 绑定目录（cwd）创建后永不变；项目移动只改 `project_id`，分组移动只改成员与顺序                                                                                      | 冷启动后 provider / memory / permissions 找不到                     |
| I3  | 项目其余 roots 只作为 `additionalDirectories` 供 skills / commands / subagents / 可写范围；AGENTS.md、settings、MCP、hooks、plugins、memory、permissions 只按绑定目录链解析 | 另一目录的可执行配置混进当前会话；同名 MCP/hook 冲突                |
| I4  | CLI 不感知项目；协议里只有目录列表                                                                                                                                          | CLI 出现 project 概念 = 设计漂移                                    |
| I5  | 行集合由 app 库决定，sessions-index 只补实时字段（phase、lastActivityAt、pending interaction）                                                                              | 任务在列表里消失 / 复活                                             |
| I6  | 排序时间只取 CLI 创建/活动时间镜像；沿用 running/prewarming 优先、运行层创建时间稳定排序及普通层创建/更新时间偏好；pin / archive / rename / 未读不改时间                    | 重命名后跳到顶部                                                    |
| I7  | 未读用 CAS（`expectedUnreadAt`），只有 Host 显式 `unreadSignal` 才制造未读                                                                                                  | 手机已读被桌面覆盖；每轮完成全表闪烁                                |
| I8  | 标题优先级：用户 override(`title_source=custom`) > 模型生成 > 首条 prompt > 占位 "New session"；快照永不覆盖 override                                                       | 手动标题闪回                                                        |
| I9  | 删除 = CLI 软删除（`time_deleted`），app `deleted` 是镜像；冷种子 / listSessions / TUI 必须过滤                                                                             | 已删 session 复活                                                   |
| I10 | 两库 schema 只加不删不改旧列语义；新列可空或带默认；`ON CONFLICT(workspace_key, task_id)` 的唯一约束必须保留                                                                | 降级后旧版本崩溃                                                    |
| I11 | 派生目录 hash（`sessions/{hash}`、`agent-config/{provider}/{hash}`、CLI memory）输入是真实目录 + identity，与项目无关，不迁移                                               | 升级后配置 / 记忆丢失                                               |
| I12 | 手机远控 bridge / queue / snapshot key 只用 workspaceKey；桌面 continuous 与手机 replayable 边界不变                                                                        | 远控串会话                                                          |
| I13 | Host 组织态只存在原列，不做副本；旧列 `deleted` / `title_overridden` 是「待交接给 CLI 的意图」，每次启动全表对账，不能只补 NULL                                             | 降级期删除 / 重命名在再升级后丢失                                   |
| I14 | sessions-index snapshot 缺席不等于删除；删除只能来自 `session.removed` 或 `sessionsIndex/reconcile` 返回 deleted                                                            | 事件丢失后任务复活或误删                                            |
| I15 | 恢复 CLI 库备份必须关闭外键并校验行数 / 哈希；`message`/`part` 对 `session` 是 ON DELETE CASCADE，裸 DELETE 会清空正文                                                      | 恢复后消息全丢                                                      |
| I16 | 附加目录由 Host 统一解析并贯穿 create / 显式 resume / V4 subscribe 冷恢复；排除的是 session cwd 不是主要目录；运行实例存在时不刷新                                          | 桌面打开历史任务拿不到附加目录；换主要目录后老会话目录范围错乱      |
| I17 | 空归属 session 只在首次发现时判定一次归位（bit 8）；不自动建项目；不归入者在任务区、时间线或分组中可见。app 行缺失 = 未归类 `[]`，项目缺失 / 读取失败 = 显式报错            | 已移除的 workspace 复活；会话后来被悄悄挪进项目；TUI 新建会话打不开 |

## 3. 关键裁决速查（详见 spec 第 3 节）

- 2026-10-10 远程裁决：本地/远程项目平铺，Host 不作为分组；远程先建单目录项目再建会话，不允许无项目创建或拖拽追加目录。统一项目顺序归控制端侧栏偏好。详见 `docs/superpowers/specs/2026-10-10-session-manage-upstream-integration.md`。
- 侧栏 = 全局置顶区（session + 置顶项目）→ 项目区 → 任务区（`project_id IS NULL`，任意 cwd）；`~/.zcode/workspace/*` 只作为全局新建任务的默认执行目录。筛选含按项目 / 按分组 / 最近更新；真实目录不是节点，不恢复旧两级切换器。
- 项目：本地 0..n 个同 host 的 roots + 一个主要目录，远程恰好一个固定目录；同一目录可属多个项目；新建 session cwd = 主要目录；仅本地 0 root 时自动建 `~/.zcode/workspace/<ts>` 并加为主要 root。
- 本地项目及在线远端权威项目删除 = 软删除容器，session 保留归属，时间线可见；新建 roots 集合完全相等的项目时提示恢复；不提供彻底删除。远程项目离线删除只移除本机入口与缓存，不触发远端软删除或恢复。
- 本地项目移除 root / 换主要目录不影响已创建 session、定时任务、闲时任务、Bots（它们在创建时固化 cwd 与附加目录）；roots 变更对运行中 session 下次 resume 生效。
- 同名 skill / subagent 来自不同 root 时并存，由 CLI 赋限定名 `<rootName>/<name>`。
- 分组：控制端 Host 唯一持有跨设备分组，手机复用该 Host；不按 workspace 建组，不将分组转换为项目。分组不改变 cwd、项目、CLI 时间、配置或权限。读取只读，单节点移动在事务内复检来源/锚点，缺席不删除；系统任务只首次归组，手工移出后不拉回。
- 展示偏好：有效新版 view 优先，否则沿用旧 organizeBy；旧 grouped 默认进入按分组。新建任务固化 draft 的分组 placement，首次发送后幂等提交，不在导航时猜测。
- 远程：项目与任务组织态留在远端 app 库；本机持久化 host 连接记录、用户已添加的项目入口及基础信息缓存。离线不可展开、改名或编辑 roots，项目操作仅允许移除本机入口与缓存，远端项目与会话保留，无待同步删除队列。远程只允许创建时确定的一个固定 root，host 上限 20，启动自动连接已保存 host。
- 重连只刷新本机仍存在的入口，迟到响应不得 upsert 已移除入口；setting.json 从本机入口列表派生，不反向重建已移除入口。重新添加远程项目须由用户主动选择，或由在线创建成功显式添加；删除本机 host 只移除连接及所属入口。
- 设置页 agent 配置管理按真实目录（roots 去重平铺）；定时 / 闲时 / Bots 选虚拟项目。

## 4. 数据与迁移纪律

- 版本化 migration runner 两库共用（抽自 `apps/zcode-cli/.../session-store/migration-runner.ts`）：`schema_migration(id, checksum, app_version)`，checksum 不可变，未知 id 忽略。
- 每条 migration 显式声明 `touchedTables`；runner 在同一读事务里只备份这些表（`ATTACH + CREATE TABLE AS SELECT`）；备份只为迁移失败恢复，正常流程只产生不消费，不做整库快照（本机整库 770MB vs 表级 16MB）。
- 每条 migration 一个单测：fixture 前后对全部表做内容哈希，只允许 `touchedTables` 变化。`schema.baseline.sql` 由 CI 做只增 diff。
- 兼容退场三阶段：V1 只读新列、旧列只写不读；V2 写 `schema_floor` 并停双写；V3 物理删退场列 / `time_archived` 并重建主键。分组表已恢复为运行态，不能按旧计划删除。不要在任何阶段引入「永久」兼容分支。
- 降级靠加法 schema，不靠备份；首次迁移遗留、旧版本新增或 CLI 首次发现的未归属 session 只判定一次：目录唯一匹配同 host 下未删除项目才归入，零个或多个匹配保留 NULL 并进入任务区，不自动建项目。唯一例外是远端 Source Server 的首次迁移：远端自身没有旧 workspace 清单，按历史任务目录建单 root 项目（虚拟项目 spec 2026-10-15 裁决）。旧 group、空组、系统组、颜色、成员和顺序继续读取；旧 Group → Project 转换取消，workspace → Project 保留。
- `project_id IS NULL` 是合法未归类状态，不是待迁移标记。启动时先识别 `host_id IS NULL` 的旧版本新增行，再在同一事务补齐身份与首次归属；新版本创建或首次插入行时原子写入身份和归属。已处理的 NULL 行不因启动、对账或新增同目录项目而自动归入；全局新建任务显式保持未归类。
- 迁移复用同一 SQL / Repo，启动门禁在 Host Worker 完成后才初始化业务服务；异步等待锁，迁移事务提交后再发布 ready，失败 fail-closed（重试 / 打开备份目录）。不得另造迁移实现。

## 5. 改动前检查清单

1. 这个字段的**唯一写者**是谁？如果你要在另一侧写它，先回到第 1 节重新判断，通常应改为发命令（`renameSession` / `deleteSession`）再等镜像。
2. 你写入的时间戳来自 CLI 事件还是 `Date.now()`？后者只允许写 Host 组织态自己的时间列（`pinned_at`、`meta_updated_at`），不允许进任何排序依据。
3. 是否会让 sessions-index 决定行的存在或消失？不允许。
4. 是否用 `workspacePath` 做了身份判等或建 key？远程必须带 `workspaceIdentity`。
5. 新增列 / 表是否可空或带默认、是否更新了 `schema.baseline.sql` 与 migration 的 `touchedTables`、是否有逐表哈希单测？
6. 改了 CLI 配置发现逻辑？只允许在 skills / subagents / 路径策略三处消费 `additionalDirectories`；其余保持只按 `workingDirectory`。
7. 涉及标题 / 状态 / 未读 / 归档 / 删除的行为变化，e2e 是否覆盖了「桌面 + 手机远控」「本地 + SSH/WSL」两组交叉？
8. 涉及 schema 的改动，是否跑过「旧 fixture 升级 → 旧代码路径读写（含修改既有行：删除、重命名）→ 再升级」的 e2e？
9. 触碰删除 / 标题的代码，是否保持了「意图位 → 惰性交接 → 镜像回写」三段，以及 orphan 的处理？

## 6. 参考实现与文档

- 现状事实：`docs/task/task-sqlite-index.md`、`docs/v4-refactor/14-sessions-index.md`、`docs/ui/task-title-authority.md`、`docs/ui/task-unread-state.md`、`docs/task-list-refresh-semantics.md`、`docs/wsl-task-status-inconsistency.md`（订阅被静默替换的根因）。
- 历史决策：`docs/superpowers/specs/2026-07-13-v4-sidebar-task-state-authority-design.md`、`2026-07-20-sidebar-task-row-authority-design.md`、`docs/local-workspace-path-cold-resume-identity.md`。
- 当前分组与视图：`docs/ui/task-grouped-view.md`、`docs/ui/sidebar-task-view-switcher.md`。
- 已废弃（保留仅供降级理解）：`docs/grouped-task-workspace-bootstrap.md`、`apps/zcode-cli/docs/design/v2/multi-workspace.md`。

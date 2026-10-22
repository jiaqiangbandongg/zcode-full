# 虚拟项目实施记录

开发中与预期不符的情况单独记录于 [开发偏差记录](2026-09-11-virtual-project-development-deviations.md)，后续持续更新。

## Feature Summary

| 字段   | 决定                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| 目标   | 实施 `2026-09-09-virtual-project-design.md`，按第 8 节顺序交付                                                            |
| 层级   | presentation、option-source、draft-default、validation、commit-effect、persistence、recovery                              |
| 模式   | planning → implementation                                                                                                 |
| 种子   | `taskIndexRepo`、`createZCodeTaskIndexSyncer`、`IZCodeTaskService`、`WorkspaceSidebar`、`V4Gateway`、`SqliteSessionStore` |
| 范围外 | workbench 分屏组、队列 owner、bridge identity、目录 hash、普通会话配置解析链                                              |

## UI Surface Matrix

| 场景 / 入口                     | 共享实现                    | 草稿 / 默认值              | 校验与提交                 | 权威落点                     | 模式边界 / 隔离                                     |
| ------------------------------- | --------------------------- | -------------------------- | -------------------------- | ---------------------------- | --------------------------------------------------- |
| 侧栏项目 / 时间线 / 置顶        | 项目查询、任务行组件        | UI 只保存折叠、排序偏好    | Host project CRUD / move   | app SQLite                   | 桌面、Web、手机相同归属；远端独立 Host              |
| 新建任务                        | 现有 createSession 链路     | 项目主要目录；全局独立目录 | Host 解析 roots 后创建     | CLI 会话 + app 归属          | cwd 创建后固定                                      |
| 打开历史 / 重连                 | V4 subscribe 与 cold resume | 任务明确 project_id        | Host 同一读快照解析目录    | CLI single-flight runtime    | continuous / replayable 各自订阅，不刷新 live roots |
| composer 文件 / 技能 / 子 Agent | 既有能力发现与建议列表      | 当前任务目录范围           | qualifiedName / 路径       | CLI 能力目录                 | 不合并附加目录的 settings、MCP、hooks               |
| 设置页 Agent 配置               | 目录选择器                  | 全部 roots 去重            | 既有目录配置服务           | 目录级配置                   | 不把虚拟项目用作路径或配置身份                      |
| 定时 / 闲时 / Bots              | 各自配置编辑器              | 项目主要目录与其余 roots   | 创建时固化执行配置         | 各自 Host repo               | 之后不追随项目 roots 编辑                           |
| 离线远程项目                    | 本机入口列表                | 最近成功基础信息缓存       | 只移除入口；在线编辑经远端 | 本机 entries / 远端 projects | 迟到刷新只 UPDATE，禁止重建入口                     |

## Shared And Divergent Behavior / Feature Relationships

- must-inspect：CLI store → sessions-index → Host syncer → task index。会话事实唯一写者是 CLI，Host 只能镜像。
- must-inspect：项目服务 → create / resume / V4 cold subscribe。统一目录解析，不在 UI 拼 roots。
- must-inspect：schema runner → desktop startup / remote server / CLI startup。表级备份与事务失败关闭。
- should-inspect：composer、设置、automations、off-peak、Bots 的目录选项与创建默认值。
- conditional：SSH/WSL/Docker/server 重连与旧远端单 root 降级。
- invariant-only：CommandInbox、owner/lease、workspaceIdentity、手机 replayable、desktop continuous。
- evidence-only：现有 session-store、v4-cold-resume、sessions-index、task index、task title/unread 单测与 TSL 系列 E2E。

## State Owners And Commit Sinks

```text
CLI db.sqlite ── facts / sessions-index ──> Host syncer ── cli_* ──> app SQLite
                                           ↑                         ↑
                                 rename/delete commands      project/pin/archive/read

task + project roots（同一读快照）→ Host → create/resume/cold subscribe
                                             ↓
                                    CLI 单一运行实例初始化
desktop continuous ───────────────────┤
mobile replayable ─ snapshot/gap ─────┘
```

组织态只保留原列；CLI 时间不得由 Host `Date.now()` 合成。标题意图 / 删除意图保留到交接确认；snapshot 缺席通过 reconcile 查询，不能当作删除。会话目录、workspace identity、remoteSessionId 不随项目移动改变。

离线标题 / 删除命令复用 CLI 的 READY 冷恢复：CommandInbox 先查幂等结果并取得 session admission，再初始化运行实例，随后执行原有命令。重复删除先返回已记录结果，不因会话已删除而再次恢复；Host 不维护第二个命令队列。

```text
rename/delete → CLI CommandInbox（去重、FIFO）→ READY → 原有 handler → CLI 持久事实 → Host 镜像
```

## 重构边界与删除清单（2026-09-11）

用户明确本次为重构：先追踪旧任务管理依赖，再删除被替代的实现，不保留并行写者。现有 `session` / `services` 仅为 unmanaged 目录划分，不能作为新抽象的完成证据。

| 旧实现                                                                   | 处理                                   | 新职责                                                |
| ------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| TaskOverlay / overlays / applyOverlayToMeta                              | 删除                                   | Host SQLite 组织态经服务读取；UI 只保留未提交草稿     |
| adapter.updateTaskIndexFromStreamEvent                                   | 删除                                   | sessions-index / reconcile 唯一事实摄入               |
| applyAgentPatch、snapshot status 合并、shouldPreserveNewerTerminalStatus | 删除                                   | CLI 明确 last_outcome；实时 phase 仅用于活动展示      |
| rename/delete 的 Host 先写与 best-effort CLI 同步                        | 删除                                   | CLI 命令确认 → syncer 读取事实；失败保持原值          |
| closeTask 写 deleted                                                     | 删除                                   | close 仅释放 runtime；delete 独立命令                 |
| task_groups 管理、混排与 workspace 自动建组                              | 迁移完成后删除运行 API / UI / 排序缓存 | project / roots / task.project_id；旧表只用于首次迁移 |
| 完整 snapshot 回写 title/status/time                                     | 删除事实写入；搜索正文和展示信息独立   | 展示缓存不得写 cli\_\*                                |
| 旧版本数据兼容                                                           | 限定在启动迁移与惰性交接               | 不新增永久 fallback 或第二套运行实现                  |

```text
CLI command / session store                         Host organization
  title / deleted / activity / outcome                project / pin / archive / read
                |                                                  |
      sessions-index + reconcile                         project service contract
                |                                                  |
        one facts projector ----------------------> app read model
                |                                                  |
       generic topic transport                         project tree / timeline
                |
 desktop continuous / mobile replayable（保留各自恢复边界）
```

`CommandInbox`、owner/lease、remote attachment、会话运行态的协议适配与本次组织态重构分离；删除前按引用证据确认，不把仍服务手机、bot 或跨 Host 路由的代码当成无用状态。每个新模块按架构 skill 提供五件套、运行时输入校验、失败语义和契约测试。完成时报告删除项与净行数，不能仅以新增模块数量宣称重构完成。

## Must-Preserve Invariants

执行 session-management I1–I17（I17 的旧“仅时间线”文字以裁决 A5/F3 为准：空归属进入任务区）。数据库只加列/表/索引；历史 migration checksum 不改；恢复时关外键并逐表校验后提交，不删除正文。普通运行实例初始化后目录范围固定；跨 host 拖动拒绝，缺 root 必须确认后原子写入。

## Codegraph Evidence / Graph Drift Candidates / Graph Delta

CodeGraph 返回本工作区无索引，未执行 CodeGraph 影响面扫描；改用上述种子的定向检索，限制为调用入口、权威 owner 与相邻测试。现有 graph 的 grouped-task-list 将被项目树替代，实施完成后更新已验证的 seed 与语义边，不把静态可达当作功能依赖。

## Clarification Log / Boundary Decisions

- 第 3 节裁决优先：修正 6.1 的“多匹配按主要目录归入”“无匹配仅时间线”旧文本。
- 当前代码已有 `0019_dwf_journal`（2026-09-10），新增软删除迁移使用下一个编号 `0020_session_soft_delete_outcome`，不改已占用迁移。
- 初始架构门禁：0 baseline / 0 new。完整 freshness 的 fetch 返回 HTTP 504；`--no-fetch` 检查通过，ahead main 1095 / behind 6；远端新鲜度暂未确认。
- 已有未跟踪 `packages/remote-desktop/` 与本次任务无关，不纳入修改或提交。

## Dimensions / Accepted Cases

| ID   | Setup → Action                                         | 断言                                                    | 证据层                   |
| ---- | ------------------------------------------------------ | ------------------------------------------------------- | ------------------------ |
| VP01 | 旧库含正文 → 升级 / 备份恢复                           | 仅 touchedTables 变化；message/part 完整；checksum 不变 | SQLite fixture / unit    |
| VP02 | 升级 → 旧写者删除、改标题、新建 → 再升级               | 意图交接、orphan、空归属只判一次                        | SQLite fixture / service |
| VP03 | 冷种子遗漏 / 删除事件丢失 → reconcile                  | exists/deleted 区分；缺席不删行                         | protocol / CLI / Host    |
| VP04 | 0 / 1 / 多 roots → 创建编辑、软删、同集恢复            | cwd 固定、名称唯一、同 host、取消无副作用               | service / UI E2E         |
| VP05 | NULL 归属、0/1/多匹配 → 首次发现 / 重启                | 仅唯一匹配归位；之后不再归位；任意 cwd 进任务区         | service / UI E2E         |
| VP06 | A+B 项目 → create / explicit resume / subscribe 冷恢复 | B skills/subagents/可写范围可用；AGENTS/config 仅 A     | CLI / Host / E2E         |
| VP07 | live B 改 C / 换主要目录 / 同 cwd 双项目 / 并发订阅    | live 范围固定；重建按归属；不串用；single-flight        | unit / E2E               |
| VP08 | 离线入口删除 + 迟到刷新 / 重启重连 → 手动重新添加      | 不复活、不改远端项目和会话；主动添加原 ID               | repo / service / E2E     |
| VP09 | 未置顶超期旧任务（不看结果/未读）→ Host 定时扫描 / 设置变更补扫（2026-09-14 起不随项目树加载或点击触发） | 任意 cwd 自动归档；置顶/运行中除外；组织操作不重排；点击任务不改 archived | unit / E2E               |
| VP10 | 项目创建定时/闲时/Bot → 修改 roots → 执行恢复          | 继续使用固化 cwd/additionalDirectories                  | unit / E2E               |

## Pruning Decisions / Unresolved Questions

跨 host 移动由 D2/G2 排除；运行中刷新 roots 由 B15 排除；空归属自动建项目由 F3 排除；彻底删项目由 E1b 排除。核心行为已由用户指定 spec 裁决，无需重复确认。桌面与手机、本地与远端分别保留代表用例；不把 Linux/Windows/真 SSH 尚未运行的检查标记为通过。

## Planning Handoff / Matrix Backfill / E2E Handoff Notes

先 contract / spec，再失败测试，再实现。新增 GUI 用例放 manual-review/pending；使用隔离 HOME、真实 SQLite 与确定性 provider fixtures。沿用已有 E2E helpers，不自动 promotion。各阶段完成后把实际证据回填本文件及 conversation catalog/matrix。

## 实施结果与验证（2026-09-11）

核心实现与最终代码门禁已完成，以下单独列出外部环境及尚未实机验证的范围。数据库迁移、任务事实单向摄入、项目/roots、侧栏、旧 Group 退场、全局独立 cwd、按 CLI 活动归档、桌面/手机导航、Composer、配置目录与定时/闲时/Bot 绑定均已接入。定时/闲时保持既有“只允许新建到本地项目”的限制；远端项目及普通远端会话可新建。手机保持没有设置页的既有产品边界。

### 架构与删除结果

| 受管模块                                   | 唯一职责与状态 owner                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| sqlite-migrations / startup-storage        | 两库共用异步 migration runner、表级备份、验证恢复与建窗前失败关闭 |
| project-storage / project                  | Host 项目/roots/任务归属持久化；统一 create/resume/cold 目录解析  |
| task-facts                                 | CLI 事实的唯一摄入与交接 owner；组织态不写 cli\_\*                |
| remote-projects                            | Controller 的连接成员、项目入口与基础缓存；远端组织态仍在 Source  |
| project-catalog / bot-project-runtime      | 项目候选与 Bot 固化执行绑定；通过现有 Source/Registry 路由        |
| project-workspace-navigation               | shared-host 草稿/历史任务 admission 与代际防护                    |
| project-sidebar / workspace-config-catalog | 项目展示与配置目录候选，均通过服务契约读取                        |

已删除 TaskOverlay、流事件回写任务状态、Host 先改名/删除再 best-effort 同步、Group 管理 API/UI、旧 workspace 自动建组、旧 timeline/pinned/archived 侧栏实现、无消费者的远端任务缓存、Scratch 弹窗回调链和 Bot main bridge。保留当前消费者使用的查询投影、CLI CommandInbox、owner/lease、workspaceIdentity、remote attachment。普通运行实例的目录范围固定；定义类任务保存不可变执行快照。

按暂存区 numstat 统计，源码/测试/SQL/脚本合计新增 24,859 行、删除 39,226 行，净删除 14,367 行（不含 docs 与配置）。

新模块均已登记 policy、提供五件套与运行时契约；architecture baseline 没有扩张。CodeGraph 无工作区索引，未执行 CodeGraph 影响面扫描，使用依赖引用与定向检索，不能将其宣称为 CodeGraph 证据。

### 验证证据

| 验证                   | 实际结果与边界                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整受影响单测         | 最终第 9 轮 1724 文件 / 14942 测试通过；2 文件 / 14 测试按配置跳过，341.12 秒。包含 D84～D89 的全部源码修改                                                                                              |
| 两库 schema            | 第 3 轮实际迁移产物与只增约束检查通过；CLI 历史 SQL/checksum 保留                                                                                                                                        |
| 架构门禁               | 最终第 69 轮 violations 0 / baseline 0 / new 0                                                                                                                                                           |
| 类型与 lint            | 最终 typecheck 87 通过；lint 32 为 48 warnings / 0 errors；460 个候选变更文件的格式检查通过（oxfmt 实际检查 459 文件）                                                                                   |
| 桌面与 URL 远端        | 第 53 轮 8/8 通过：迁移账本、全局唯一 cwd/NULL 归属、CRUD/同 roots 恢复、离线入口、URL 元数据/真实 Agent/附加 root/重开/冷恢复、定时定义、配置 roots、Bot 授权 JSON                                      |
| Composer 与拖动        | 第 52 轮 VP14/15 通过：同名多 root 文件、项目分组引用、原生拖动缺 root 取消/确认、固定 cwd、移动后重开正文                                                                                               |
| 手机 shared-host       | 第 34/36/40/48 轮通过：390px、真实 relay、项目草稿 reload、发送/任务切走重开，并验证 taskId/projectId/cwd/正文及桌面 tab/Host 数。第 52/54 轮在导航前被 relay WSS 的证书错误阻塞，不能记最新组合整轮通过 |
| 本地多目录完整冷恢复   | 第 42/48/52 轮通过：CREATE/LIVE 使用 A+B，完整退出 Electron/Host/CLI 后，同 taskId/cwd 的 COLD 使用 A+C；AGENTS 始终仅 A                                                                                 |
| URL 远端 Agent 冷恢复  | 第 52/53 轮 VP18 通过：旧 CLI 退出、新 runtime identity、实际 COLD 模型请求包含 C 且不含 B 的 skill；taskId/cwd/projectId 固定，Controller 没有远端权威 task 副本                                        |
| 旧源码升级/降级/再升级 | 独立旧 checkout 与当前源码四阶段通过，见下方复现；不等同旧应用二进制升级安装                                                                                                                             |
| Bot runtime            | 193 项定向单测与第 52 轮 3 项 synthetic E2E 通过；真实远端第三方发送/流订阅未执行                                                                                                                        |

第 52 轮 `desktop-e2e-20260911030401818-p18811-a137ff2609ad1117` 共 14 例，12 pass / 2 fail：VP11 在菜单动画期间过早读取文字，VP13 在 relay TLS 握手失败。修正 VP11 等待条件后，第 53 轮 `desktop-e2e-20260911030852184-p21904-e7779266b9d13bb3` 主文件 8/8 通过（42 秒）。不得将这些证据合写为“最新整轮全部通过”。新增交互用例保留 manual-review/pending，未自动晋升或加入 Docker verified preset。

D82 的 Web transport 偶发等待超时保留记录：当前与重构前 checkout 均独立 27 例通过，第 8 轮串行完整集通过。负载相关仍是推测，未放宽超时或宣称根因已修复。D91 的手机 WSS 错误已有 CDP/截图证据；独立 HTTPS 成功且证书来自本机 Proxyman，未修改代理或 TLS 信任配置，不能据此断言证书异常已消除。

### 跨版本数据验证复现

旧 checkout 为 `ad1fc7d414ee71c58d3539efdeb028b5d6e2e8f4`。先在旧 checkout 执行 `pnpm install --offline --ignore-scripts --frozen-lockfile`、`pnpm exec tsc -b apps/zcode-cli/packages/contracts`；不将新版 workspace 包软链给旧代码。通过现有 Node tsx loader 执行 `scripts/verify-project-upgrade.mts <对应 checkout 根> <phase> <隔离目录>`，四个 phase 依次为 `old-seed`、`upgrade`、`old-write`、`reupgrade`。

隔离目录名必须以 `zcode-project-upgrade-` 开头，HOME/USERPROFILE/ZCODE_DATA_BASE_DIR 在每个进程启动前全部指向该目录。旧版真实 TaskIndexRepo/SqliteSessionStore 新建数据，新版升级，旧版实际改名/删除/新建，新版再升级。正文/FK、旧 checksum、已有归属、新行首次归属、旧意图交接及清位均通过。CLI 端口在进程内直连真实 Store；旧 CLI 仍列出新软删除会话是已接受的降级限制。

### 未验证范围与收尾

真实旧 Server 二进制、SSH/WSL、Windows/Linux GUI、真实远端 Bot、手机远端执行、Source Server 进程重启、远端运行中权限交互和 Docker preset 尚无运行证据；本地多目录模型请求 E2E 不替代工具权限/settings/MCP/hooks 的独立断言。最终第 9 轮完整受影响测试、类型/lint/架构与变更文件格式检查已通过。测试隔离 HOME 和诊断产物保留供复核；本次 Vite 服务与独立旧 checkout 已清理。当前运行时明确提供 CODEX_SESSION_ID，已与本次 session_meta.id / cwd 核对一致；提交使用该实际 ID，不猜测或复用其他会话 ID。

开发意外、失败回合与根因均保存在 [开发偏差记录](2026-09-11-virtual-project-development-deviations.md)。D50 包含测试隔离失效导致真实 settings 被写入及恢复边界，不能从完成报告中抹去。

## 残留清理（2026-09-12）

用户复核后指出「删除清单」并未清干净。本轮用三种证据交叉审计：按区域人工审计（services 事实层 / 存储与身份 / UI / shared-desktop-web / CLI / 测试与文档）、knip，以及「不把单测当入口」的 import 可达性分析（对比 58c1b0d484 与当前树每个文件的生产 importer）。最后一种抓到了 knip 漏掉的一整类：源码被删、其 helper 只剩单测在 import。

### 已删除

| 批次            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 主要位置                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 孤儿模块        | 27 个失去生产消费者的 UI 模块（约 2,900 行）及 23 个只为它们存在的单测：WebRemoteControlTaskIndex(.Row)、buildTaskListResultFromSessions、taskStatusUnreadSync、workspaceTaskListDisplayGroups / OptimisticOverlay / RefreshSignatures、taskListRefreshPolicy、taskListWorkspaceEventCoordinator、WorkspaceSourceGroupHeader、workspaceSourceGroups、CollapsedRail、workspaceSidebarSelection、taskTimelineGroups、workspaceRemovalSafety、chatStatus、workspaceSourceConnection、sidebarTaskPreferences、workspaceRuntimeRelease、restrictVerticalDragWithinContainer、workspacePurpose、workbenchNewTaskTarget、chatActionHelpers、useLocalWorkspaceScopes、TaskListRemoteSyncHint、taskRuntimeDisplayStatus；taskListMetaSync 只保留 Bot 广播仍用的两个函数 | packages/ui                       |
| 手机任务快照链  | Root 三个 useGlobalTaskList → IPC SyncWebRemoteControlTasks → main availableTasksByWindowId → workspace-list/bootstrap 的 tasks 字段，唯一读者已随手机旧首页删除；task target 上只供旧首页签名用的 displayStatus/pinned/archived 同删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | shared、desktop main/preload、web |
| services 死接口 | closeTask、createTask.draftSessionId（含 sameModelSelection）、taskIndexRepo.listSessionsByAutomation、TaskIndexWriteRecord.writeUnreadAt/searchableText 与 @write_unread_at CASE、syncer 接口上的 refreshSessionFacts 与 ensureSessionSubscription.includeSnapshot、ISettingService.ensureDefaultProject、ProjectCatalogContract、resolveStartupWorkspacePath                                                                                                                                                                                                                                                                                                                                                                                                 | packages/services、desktop main   |
| CLI 归档字段链  | SessionInfo.time.archived / timeArchived / includeArchived / archivedAt（含 shared 协议与 services 参数）、createSession 显式写 time_archived=null、旧 runner 孤儿 ensureParentDir / SchemaMigrationRow、cold-session-resume 三层三元兼容调用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | apps/zcode-cli、shared、services  |
| 文案与注释      | 116 个无引用 i18n 键 × 2 语言；十余处仍描述 grouped / overlay / applyAgentPatch / closeSession 的注释                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ui、services、CLI                 |
| 文档            | sidebar-task-view-switcher.md、CLI multi-workspace.md 加废弃横幅；e2e 覆盖矩阵与 case catalog 退场 Group 语义用例（TSL22/27/37、CWP05）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | docs                              |

### 顺带修复

- 闲时任务绑定会话的忙碌判断已失效：归属收口后 tasks-index 行的 status 只镜像 CLI last_outcome，永远不会是 running，host 按 `listTasks(...).status === "running"` 的守卫形同虚设。新增 `IZCodeTaskService.listActiveTaskIds`（来自 syncer 活动集合），host 改用它；offPeakHostDispatch 测试按活动集合断言 busy。
- 分支上两处已失效的旧测试：pinnedTaskFileTreeAction 断言 79de8c7fab 已移除的文件树按钮（删除）；workspaceShellRemoteMobileLayout 的 TabStoreProvider mock 缺 useTabStore（8d06343e22 后 useProjectTree 直接订阅），24 例报错（补 mock）。
- core resume 改为拒绝恢复已软删除会话（旧 time.archived 判断永远 false）。

### 验证

每批提交前：`tsc -b` 对应包、oxlint / oxfmt 变更文件、`pnpm architecture:check --changed`（0 violations）、`pnpm test:unit:affected` 三轮全绿（1715 文件 / 14789 例）；CLI 侧 `pnpm -r run typecheck` 通过，adapters / bootstrap / core 相关单测通过。`v4-gateway.test.ts` 的「Core admission ACK 不等待 TurnStarted projection」在清理前的 HEAD 上就已失败，与本轮无关，未处理。

### e2e 切换到新侧栏 test id

src 已不渲染 `TID_WORKSPACE_ITEM / LIST / CLOSE / FILE_TREE_BUTTON / OPEN_BUTTON`、`TID_CONVERSATION_NEW_TASK`，但 47 个 e2e 文件（含 15 个正式 spec）仍经 helper 依赖它们，实施记录里的 e2e 证据只覆盖 VP 系列。本轮把 helper 整体切到项目侧栏：`ensureProjectExpanded` / `waitForRestoredProjects` / `openWorkspaceDraftFromSidebar`（hover 项目行 → create-task）/ `openProjectFileTree` / `removeRemoteProjectEntry` / `reconnectRemoteProjectHost` / `readTaskRowInProject`，项目行按 `data-project-name` = 目录 basename 定位（老 workspace 首次迁移成同名单 root 项目）；`selectTaskOrganizeMode` 与 app.page 的 tabBar / workspaceList getter 删除；test-ids.ts 删除 9 个死常量、新增 `TID_VIRTUAL_PROJECT_*` / `TID_PROJECT_PINNED_TASKS` / `TID_REMOTE_PROJECT_HOST` 并登记到 testid contract。删除 Group 视图专属 e2e（grouped-archive-resurrection、grouped-header-pin-visibility）及其 4 个 fixture json，marquee fixture 去掉 group 三表；wdio.conf 里对这两个 spec 的 fixture 分支同步删除。

实跑：`desktop-e2e-20260912125729585-p62209-5ccdd017382630da` 通过 workspace-file-tree-refresh、task-list-archive-confirmation、conversation-session-conversation-workspace、conversation-session-task-title-marquee、repo-wiki-generation-settings；`desktop-e2e-20260912130133547-p67653-79b12a4ab84b4780` 通过 workspace-agent-warmup-small-set / -lifecycle、workspace-passive-agent-startup、workspace-provider-save-dormant-agent、browser-tab-close-cross-workspace（预热 fixture 期望按 spec F13 由 3 个改为 1 个，TSL29/31/36 文档同步）。未实跑：SSH 系列（无真实 SSH 环境，helper 只改到语义一致）、repo-wiki 其余三条 / workspace-file-tree/\* / configurable-data-directory / pasted-image-path-projection / markdown-preview-selection（同一 helper 路径已由上面用例验证）、manual-review/pending 下约 30 个 spec 只做机械替换。`workspace-removal-runtime-release` 因侧栏已无「移除 workspace」入口降级到 pending：删除项目是否应释放该目录的 Agent runtime 待裁决。src 侧待补：项目 section 加 `data-primary-root`（同名目录的项目目前无法区分）；project-sidebar 仍硬编码 testid 字符串，应改用新增常量。

### 保留待裁决（未删，需要产品/设计决定）

- `taskIndexRepo.applyCliFacts` 里 `cli_updated_at=max(...)`、`cli_last_outcome=coalesce(...)` 的「取较新 / 保留旧终态」合并：删除清单要求删的 snapshot status 合并以 SQL 形式仍在，D15 已用请求代际解决迟到问题；两条以已删 applyAgentPatch 为前提的单测（zcodeTaskIndexSyncer.test.ts:1839-1922）因此仍能通过。
- 两套未读源并存：窗口角标读 store 的 taskUnreadByTaskId / optimisticTaskListByTaskId / taskListCache，侧栏读 task query cache 的 unreadAt；新侧栏不读前者但 WorkspaceHeaderSections 仍在写。
- 旧 group 四表的运行时维护：controllerRemoteIdentityMigration.ts 与 sourceServerWorkspaceAliasRepo.ts 在 identity 迁移事务里仍改写 task*group*\_ 三表（约 150 行），spec F2/F4 规定迁移后只读一次；taskIndexRepo.initialize 仍为新库建这四张表；mergeTaskDatabase 只合并旧列不合并 cli\_\_ / project_id。
- 旧列只读违规的小项：listDeletedTaskIds 只读 deleted 不看 cli_deleted；旧索引按 updated_at 而查询已改 cli_updated_at（补索引需要新 migration）；legacy ACP 迁移每次启动读旧列且不在 runner 里。
- bots/workspaceHelpers.resolveCanonicalWorkspaceId 的三重旧格式永久 fallback；adapter 六个 unsupported 存根与 checkCodexConnectivity / getTaskTokenUsage（legacy ACP 接口面，零调用）；CLI migration 0020 的 `apply` 列存在兼容分支；`packages/ui/src/workspace-grouped-tasks/` 目录名（只剩一个活文件，ProjectNode.tsx 有用户未提交改动暂不动）；TaskList.tsx 在单行调用下不可达的分支与 TaskListItem timeline variant。

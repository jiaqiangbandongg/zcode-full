# 一键删除所有归档任务

## 需求与确认记录

2026-09-07 经两轮 grilling 确认：

1. 删除当前窗口归档列表覆盖的所有 workspace 的归档任务，包含折叠的第 21 条及以后任务；不扫描已从窗口移除的项目。
2. 归档工具栏在筛选和关闭按钮之间提供中性“更多”图标，在菜单中显示归档数量和红色“删除所有归档任务…”；空列表禁用。桌面与手机 Web 均可用，保留单条操作。
3. 点击后读取各 workspace 的完整归档集合，再弹出一次确认，显示准确可处理数量及不可访问的项目。确认正文仅说明任务将从任务列表和归档列表中移除，不展示会话记录或文件保留细节；单条归档删除共用此文案，中英文同步。取消不写入任何数据。
4. 沿用当前删除语义：持久写入 deleted 标记、移除列表与分组引用；CLI 会话记录、项目文件和 worktree 保留。同步修正单条归档删除确认文案。
5. 一项失败不阻断其它项；报告成功、跳过、失败数量和未处理项目，保留未删除任务供用户再次操作。离线项目不自动连接，也不在恢复连接后自动续删。
6. 目标集合以确认框打开时为准；执行时在持久化写事务内再次检查 archived。已恢复或已删除任务跳过，之后新增的归档不进入本次操作。

## 交互与状态

```text
归档视图（窗口 workspace 范围）
  -> 工具栏 […] -> 菜单：归档数量 / 删除所有归档任务…
  -> 选择删除所有 -> 关闭菜单 -> 查询全部归档（不受 UI 折叠/排序影响）
  -> 确认框：数量 + 不可访问项目 + 从列表移除的说明
       | 取消：结束
       v 确认
  -> 按 workspaceIdentity + remoteSessionId 路由原 source
  -> SQLite 事务：仍 archived 且未 deleted？
       | 否：跳过
       | 是：写 deleted + 清理分组引用 -> task_deleted
       | 失败：保留，继续其它目标
  -> 桌面 Controller/列表缓存刷新；Web 列表快照更新；展示结果
```

查询、确认和删除期间批量入口禁止重复提交；删除期间显示处理中。结果保留在归档列表顶部，全部成功后保留空态和禁用入口。所有 source 都不可访问时显示原因，不弹出可确认的零项删除。

### 批次执行与刷新边界

归档批量删除以 workspace 为请求边界：`deleteArchivedTasks({ workspacePath, workspaceIdentity, taskIds })`
只接收确认时固定的目标 ID，返回 `deletedTaskIds`、`skippedTaskIds`、`failedTaskIds`，每个目标恰好归入一类。
重复 ID 去重；空集合不写入、不发事件。单条 `deleteArchivedTask` 的既有契约保持不变。

```text
旧：UI 对 N 个目标逐条 RPC -> 每条事务 -> 每条事件 + Host 重读 -> UI 重查
新：UI 按 workspace 发一次 RPC -> 原 source adapter 逐条事务并汇总
                              -> 有成功项时一次 workspace task_deleted
                              -> Host / UI 按批次读取最新列表
```

批次持有确认集合，不保存第二份任务事实或输入队列。每项仍复用 Repo 的事务内归档检查、
tombstone 与分组清理；失败项独立回滚并继续后续项。持久化成功后才更新 overlay，批次结束后
发布不带单条 taskId/taskMeta 的 workspace 级 `task_deleted`，使所有观察者重读 deleted membership。
只处理原 attachment 对应的 source；remoteSessionId 不匹配或 source 离线时禁止写入，不自动重连或续删。

Host 复用现有事件刷新、最终 mutation 刷新和 single-flight。事件投递与 RPC 回包可能先后到达，
允许常量轮次的收敛读取，但每个 source 的刷新次数不得随本批目标数量增长。UI 仅移除回包中的
成功目标，跳过和失败项保持原处理方式；一个工作区 RPC 失败不阻断其它工作区。
本契约仅扩展 App service / Controller，不改 App-Agent wire、desktop continuous 或 mobile replayable。

验收：同一 source 删除 1/8/72 条时，批量 RPC 各一次、有成功项的 workspace 事件各一次，
Host 分区读取次数保持常量；覆盖混合成功/跳过/失败、全失败、空批次、重复 ID、同路径不同 identity、
远端离线及旧 remoteSessionId，继续验证保留 CLI 会话与分组事务回滚。

### 2026-09-07 入口设计决策：采用 B「更多菜单」

用户已选择 B。设计原型及选择记录保存在 `prototype/archived-task-actions` 分支（`eeb9244647`，文档 `docs/task/archived-task-actions-prototype.md`）；正式分支只保留选定设计。

本轮属于 presentation 变更：`WorkspaceSidebar` 提供工具栏 DOM 插槽，桌面归档组件与 Web 归档索引通过共享批量控件将菜单入口 portal 到该插槽；任务集合、服务解析、确认及删除状态仍归原组件所有。成功/失败提示在列表中展示，无结果时不占额外一行。菜单关闭不会销毁异步删除状态。桌面 continuous / 手机 replayable、workspaceIdentity / remoteSessionId 路由与持久化逻辑无改动。

```text
WorkspaceSidebar 工具栏: [筛选] [归档动作插槽] [关闭]
                                   ^ portal（仅渲染位置）
Desktop archived list / Web task index
  -> 共享控件（数量、busy、确认、结果） -> 原有 scoped services
  -> 列表顶部结果状态
```

accepted：工具栏菜单定位、打开菜单不查询/删除、菜单选择后全量确认、取消及再次打开、空态禁用、Web 共享入口、窄屏与深浅主题代表验证。pruned：重复验证全部 Repo/Controller 状态排列，因为此次只移动入口，核心 guard / 路由不变。TSL39 原用例更新为先展开菜单再选择删除，仍保留 pending 状态。

## Impact Brief

### Feature Summary

| 字段 | 内容 |
| --- | --- |
| Capability / mode | 归档任务批量删除 / planning |
| Change layer | presentation、validation、commit-effect、persistence |
| Primary seeds | WorkspaceArchivedTasksFlatSection、WebRemoteControlTaskIndex、createControllerRoutedTaskService、TaskIndexRepo |
| Out of scope | 会话物理清理、工作区文件、CLI lifecycle、自动重连、全局磁盘项目扫描 |

### UI Surface Matrix

| 场景/入口 | 共享实现 | 展示状态/默认来源 | 校验与提交 | 权威落点 | 模式及隔离 |
| --- | --- | --- | --- | --- | --- |
| 桌面归档平铺 | 工具栏更多菜单、确认框、workspace services resolver | useGlobalTaskList；默认折叠 20 条 | 全量 listArchivedTasks；deleteArchivedTasks | 对应 Host tasks-index | 当前窗口全部 tabs；local/remote 按完整身份路由 |
| 手机 Web 归档索引 | 同一批量控件和服务接口 | desktop workspace-list snapshot；不受显示过滤影响 | 只处理当前 attachment 可操作的 workspace | shared-host / 对应远端 tasks-index | 不能把本地任务送往远端 baseServices |

### Shared And Divergent Behavior

集合读取、确认、按 workspace 批次执行和结果报告共用；desktop Controller membership 与 Web workspace-list snapshot 各自刷新。没有草稿继承或运行态默认值变更。单条删除入口保持既有行为，仅纠正文案。

### Feature Relationships / State Owners And Commit Sinks

| 等级 | 关系 | 原因/证据 |
| --- | --- | --- |
| must-inspect | 归档入口 -> scoped task service -> Controller -> Repo | 跨 source 写入必须保留 host 路由与事务内归档检查 |
| must-inspect | deleted -> task_deleted -> 列表 membership | CLI session 保留，不能被后续 summary 重新展示 |
| should-inspect | 删除 -> 分组引用与选中任务状态 | 与单条删除相同，事务成功后清理 |
| invariant-only | 桌面 continuous / 手机 replayable | 本功能不改 stream、snapshot recovery、queue、owner/lease，不向 main/relay 下沉状态 |
| evidence-only | TSL20、task-index row authority fixture | 提供保留会话和全量列表的回归证据 |

### Must-Preserve Invariants

- 身份 key 为 `workspaceIdentity?.trim() || workspacePath`；实际执行参数继续传 workspacePath。remoteSessionId 选定已有 source，不能回退到其它同路径 source。
- 任务仍归档的检查与删除、分组清理在同一 SQLite 写事务；失败不设置 deleted 内存 overlay，也不发布成功事件。
- 只复用已有 attachment，不新建 Agent/Host/远程连接。按任务保存的成功结果刷新 UI，不能将失败项乐观移除。
- 深浅主题、英文/中文、键盘确认取消、窄屏可访问性沿用 DESIGN.md 组件规范。
- `deleteArchivedTask` / `deleteArchivedTasks` 仅属于 App service / Controller 的条件删除接口；不增加 App-Agent wire 命令，不读取或改写 CLI runtime snapshot，不改变可信 attachment 注入的 clientMode。

### Codegraph Evidence / Graph Drift / Graph Delta

本会话无可调用 codegraph，采用文件/符号与直接调用方阅读替代，范围两层。已核对 Sidebar 两个入口、Service adapter、Repo、Controller 路由和 tests。现有图缺少归档批量语义；新增经用户确认的 capability、两个入口和持久化边。新增节点、边和文件 seed 的校验通过；图谱原有 `capability.mcp-oauth-authorization`、`persistence.desktop-user-data-root` 缺失引用未在本次扩大修改。

### Unresolved Questions

无；用户已同意以上全部边界。

## 用例规划与交接

主域为 UI、持久化、workspace 隔离。维度为任务数量 0/1/大于20、确认/取消、归档状态变化、成功/失败/离线，以及 desktop/Web。

| Case | Setup -> Action | Assertions | Evidence / 状态 |
| --- | --- | --- | --- |
| TSL39 | 25 条归档 + 普通任务；点击批量、取消、再确认 | 确认数量含折叠项；取消无写入；全部归档 deleted，普通项保留，UI 空态禁用 | 真实 SQLite + desktop pending E2E |
| TSL39-guard | 同路径不同 identity；确认后恢复/新增归档；重复删除 | 只删除确认集合且仍归档目标；恢复/已删除跳过；身份隔离 | Repo/adapter focused tests |
| TSL39-partial | 一个 source 不可访问、一个 task 写失败 | 明示未处理项目；其它项继续；失败项保留、无成功广播 | 批量 orchestration + Repo focused tests |
| TSL39-web | Web 归档入口，attachment 可写 scope 与只读 scope 混合 | 同一确认/全量删除行为；成功项移除快照，未授权 source 不调用 | Web UI / shared control focused tests |

accepted：以上用例。pruned：provider/Goal/queue/工具/主题与删除状态全排列（删除只修改 membership）；主题/locale 使用 UI 代表验证，stream 边界维持既有回归。undefined：无。bug-candidate：旧确认框虚称清理会话数据，本次纠正。

Catalog 与 coverage matrix 登记 TSL39；新 E2E 保留 manual-review/pending，不自动转正。使用现有 tasks-index cold-start fixture 的隔离数据，无需模型请求，provider replay 仅 common fixture；无时序性模型流或 Docker admission 变更。

## 验证记录

### 2026-09-17 批次刷新修复

- 根因基线为 `d1e524b2df`：UI 按目标调用单条条件删除，导致每条提交分别广播并强制重读 Host 分区。
  修复将批次传到原 workspace service，由 adapter 保留逐项事务、汇总结果并只通知一次。
- 同一真实 UI 编排 / Controller 边界的 1、8、72 条回归：删除请求均为一次，Host 内部分区读取
  从 3、24、216 次收敛为 3、3、3 次。该测试的 source 使用可观察夹具；真实 Repo / adapter
  另验混合成功/跳过/失败、重复 ID、并发批次、identity 隔离与无成功项不广播。
- 181 项相关测试分批通过，包含 Web 菜单、workspace 级批次事件刷新 tombstone、Controller
  离线/旧 remoteSessionId 拒绝写入，以及刷新失败不改报已提交结果；`pnpm typecheck`、
  `pnpm lint`（52 条既有警告、0 错误）、`pnpm architecture:check --changed` 通过。
- 桌面 pending E2E `desktop-e2e-20260917044517738-p61874-adfc3f6d1db019f0` 通过，25 条删除、
  取消、空态、普通任务及 CLI 会话保留均通过。对比同一用例基线运行
  `desktop-e2e-20260917040534711-p42824-ae8a264ab2d3c00d`，取首条删除 RPC 前 100ms 到末条后 500ms
  的执行窗口，删除 RPC 25→1，五类 membership 查询各 25→1，Controller 查询 26→2。
  本次服务汇总为 requested=25、deleted=25、skipped=0、failed=0；这些计数不等同于跨环境耗时基准。
- coverage audit 仍有 10 条既有文档错误，与隔离原始基线逐项一致；没有扩大本次修复。
  手机真实 shared-host、跨机断线、Windows/Linux 未实机复测，E2E 继续保留 pending。

### 2026-09-07 初版验证

- 143 项相关单测通过：全量收集/取消阶段不写入、部分失败、归档检查、重复删除、事务回滚、同路径跨 identity 隔离、Controller 路由、Web 入口与空态。
- 桌面 pending E2E 通过：25 条归档全部删除、取消不写入、普通任务与 CLI 会话保留、成功空态和入口禁用。运行 ID：`desktop-e2e-20260907102609958-p94926-cacb5afb92b7b9fc`。
- 已重新构建当前桌面与 CLI；第一次启动因临时 ChromeDriver 缓存缺少二进制失败，恢复缓存后运行。测试取消弹框后等待退出动画卸载，避免点中旧确认按钮；最终重跑复用同一份当前桌面构建。
- `pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`、conversation coverage audit 通过；lint 有 43 条原有警告，无新增错误。
- 已查看中文深色确认框和删除后空态截图。手机真实 shared-host 远控、真实 SSH/WSL/Docker 断线、Windows/Linux 及浅色实机 UI 尚未回归；相关代码按共用组件、身份隔离和现有交付边界实现，focused tests 不等于这些实机覆盖。

### B 方案落地验证

- 18 项 UI/编排单测通过：工具栏 portal、菜单打开不查询/删除、确认期间禁用、取消重试、列表内结果、Web 索引删除后移除快照任务并保留禁用入口。
- 当前桌面与 CLI 已重新构建。桌面 pending E2E 通过，运行 ID：`desktop-e2e-20260907110058327-p25062-fe50e38b20b124f9`；键盘菜单复验：`desktop-e2e-20260907-111050-819`。25 条全量确认、取消、实际删除、普通任务与 CLI 会话保留、空态均通过。
- 截图复核发现 ChromeDriver 的元素自动滚动会将侧栏内部 `overflow-hidden` 容器横移 65px。运行时几何记录显示 body/viewport 均为 1200px、sidebar 为 264px；等待入口启用后，通过键盘打开菜单时所有横向 scroll offset 为 0，截图完整。E2E 采用该键盘路径，移除了临时诊断输出。
- `pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`（43 条既有警告、0 错误）、conversation coverage audit 及图谱 YAML/更新的导出 seed 检查通过。
- 本轮实机截图为桌面中文深色；B 原型的 390×844 英文深色验证保留在原型分支。正式手机 shared-host 远控、Windows/Linux 和浅色实机尚未回归，未把组件测试等同于这些覆盖。

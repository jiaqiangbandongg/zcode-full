# Task SQLite Index

## Scope

`~/.zcode/v2/tasks-index.sqlite` is the app/host-side index for task list queries. ZCode Agent owns core session content and runtime state; the sqlite index owns fast list metadata and product shell state.

The index is not a replacement for ZCode Protocol session snapshots.

## 库级迁移（Todo109）

`tasks-index.sqlite` 还容纳 Automation 与 Off-Peak 表。三个 Repo 在开放读写前
复用 `runTasksDatabaseMigrations`；库级 `tasks_schema_migration` 通过
`BEGIN IMMEDIATE` 串行检查并应用迁移，失败回滚且不记成功。
`0001_adopt_task_schema` 接管八张已有表、历史补列和索引；
`0002_provider_selection` 收口已裁决的 Automation 转换。之后只追加新迁移，
不得修改已发布 SQL、冻结转换实现或其语义版本。checksum 覆盖声明式 SQL/列清单及
转换语义版本，不使用会被打包器改写的函数文本。

```text
任意 Repo 首次打开 → 库级账本/事务 → 所有表就绪 → Repo 正常读写
其他 Repo / 其他进程 → 同一账本校验 → 跳过已应用版本
```

旧列及时间戳不被 Provider 转换覆盖；正常 Reader/派发只使用新列。
Automation 的 JSON `null` 表示明确使用默认配置，SQL NULL 表示配置缺失，需要重选。
回滚产生的新旧格式记录不通过重复执行既有迁移追赶，内容仍须可列出、打开。
Off-Peak 缺失 Provider 的旧选择不查询当前账号补猜，不改变 Ticket 或读取时补迁；
缺配置只影响后续执行资格。TaskIndex 既有关联清理与投影维护不属于 Provider 转换。

## Responsibilities

- Keep task list queries fast without starting every workspace agent.
- Persist product shell state such as title, pinned, archived, deleted, unread, and title override.
- Store a compact `ZCodeTaskMeta` snapshot in `meta_json` for list rendering.
- Store bounded searchable text for global task search.
- Keep remote workspace identity isolation consistent through `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## Table

The `tasks` table is keyed by `(workspace_key, task_id)`.

Core columns:

- `workspace_key`
- `workspace_path`
- `workspace_identity`
- `task_id`
- `title`
- `task_status`
- `provider`
- `mode`
- `model`
- `migration_source`
- `forked_from_task_id`
- `created_at`
- `updated_at`
- `unread_at`
- `last_unread_at`
- `pinned`
- `archived`
- `deleted`
- `title_overridden`
- `searchable_text`
- `meta_json`

Indexes cover active workspace list queries, pinned list queries, archived list queries, deleted list queries, recent global timeline, and bounded text search.

## Runtime Rules

- Writes are serialized per `(workspace_key, task_id)` to avoid concurrent metadata overwrites.
- `unread_at` is the current unread membership/CAS marker. `last_unread_at` is an internal
  allocation watermark that survives clearing `unread_at`; repository writes allocate each new
  unread marker above that watermark so same-millisecond writes and clock rollback cannot reuse
  a stale compare-and-clear version.
- `unread_at` is authoritative over the copy in `meta_json`. Writes that do not explicitly mutate
  unread state must preserve the current row value at the SQLite conflict boundary, so a stale
  snapshot from another Host cannot roll back a newer marker.
- Every task-index connection uses a bounded SQLite busy timeout. Additive schema migrations are
  idempotent under concurrent Host startup: after lock contention, a duplicate-column result is
  accepted only when the column is present.
- `meta_json` is parsed with `zcodeTaskMetaSchema`; invalid rows fall back to scalar columns and log a warning.
- SQLite row columns are authoritative for entity coordinates: reads must overwrite `meta_json` values with
  `task_id` and `workspace_path`. Because `(workspace_key, task_id)` is the actual query/primary-key boundary,
  a valid remote `workspace_key` is authoritative over a missing or stale `workspace_identity` projection;
  non-remote rows use the identity column only when it equals `workspace_key`. This keeps list queries and
  sessions-index joins on the same isolation key without ever falling back to a remote path.
- `searchable_text` is capped so long tasks cannot grow the sqlite file without bound.
- Query scopes must pass `workspaceIdentity` for remote workspaces; `workspacePath` remains the execution/display path.
- Task-list queries and dynamic workspace-event listeners are passive observers. Registering either one must not
  start a workspace Agent runtime, reconnect a remote workspace, or promote a dormant runtime retry.
- The desktop Main startup warmup is an explicit lifecycle action rather than a task-list side effect. When multiple
  local workspaces are restored, it may start at most three deduplicated targets selected from the last active
  workspace and persisted recent-project order. A failed warmup does not pull in a fourth target.
- The task-index `sessions-index` / `workspace-config` ingestion subscriptions attach only after an explicit
  workspace operation has made that exact `workspaceKey` runtime available. Their subscribe and retry paths use
  an `existing-only` policy, so a stopped runtime returns to dormant state instead of being started by observation.
- Runtime availability is keyed by `workspaceIdentity?.trim() || workspacePath`. An available event for one SSH,
  WSL, or Docker identity must not attach observers belonging to another identity with the same execution path.
- The first authoritative `sessions-index` snapshot is a silent reconciliation boundary: non-draft sessions seed
  only missing task rows, existing product-shell state is never overwritten, and no per-row list-change broadcast
  is emitted. This keeps late attachment/reconnect safe without replaying historical terminal events or causing a
  startup broadcast storm.

## Relationship To Session State

ZCode Agent session state remains authoritative for messages, model/runtime settings, permission requests, stream events, and active turn state.

The task index may cache enough metadata for list rendering, but it must not become the source of truth for session content. Missing rows are seeded from the authoritative `sessions-index` summary during initial reconciliation; opening, resuming, or completing a task later enriches that row from the full session snapshot (including model and searchable message text).

### Index read profile（2026-09-30）

Host task-index 回源（`resyncTaskIndexRowFromAgent`：`phase.completed/error`、`meta.titleUpdated`、
`session.became-visible`）调用 `session/read` 时带 `contentProfile: "index"`：

```text
task-index syncer ──session/read {runtimePolicy: existing-only, contentProfile: "index"}──▶ CLI
                                                          │ 先按 full 构建完整 snapshot（语义不变）
                                                          │ 再只剥离大载荷字段（不增删 message/part）
task-index syncer ◀── 同结构 snapshot（几十 KB~数百 KB，而非 15 MB）──┘
   └─ buildMetaFromSnapshot / searchableText / hasUserVisibleContent：结果与 full 逐字节一致
```

- 剥离规则（`elideSessionSnapshotForIndex`，`@zcode/shared`）：tool part 的 `state.input` → `{}`、
  `state.output/raw/error` → `""`、`state.metadata` → `{}`；reasoning part 的 `text` → `""`；
  file part 的 `data:` URL → `data:,`。message 数量与顺序、`info`、所有 part 的 `type/id/metadata`、
  text/compaction/timeline/subagent 等其它 part 全部原样保留。
- 为什么不用 `messageLimit`：它保留尾部 N 条，而 searchable text 取开头 200K 字符、标题回退取
  第一条真实用户消息、可见性判断看全部消息，截尾会改变索引结果。
- 修订原因：旧实现每轮 turn 完成都读完整 snapshot，长 session 单行 NDJSON 达 15 MB（主要是 3 MB
  级 tool output），Host 每轮做一次 15 MB JSON/zod 解析；task index 实际只用文本、info 和 part 结构。
- 这是只给 task index 用的读取视图：其它 `session/read` 调用方不得传 `index`，拿到的 snapshot
  也不得回写到 UI/conversation 状态。缺省或 `full` 行为不变。

## Task Status Projection

`task_status` is a product task state, not a direct mirror of `session.status`.

- `session.status=running|waiting|paused` maps to `task_status=running` when the snapshot still has active runtime.
- `session.status=error|completed` maps directly to the same terminal task status.
- `session.status=idle` only means the agent engine has no active turn. If the latest user-visible assistant message has a completed timestamp and is not a tool-call continuation boundary, the task status is `completed`.
- `projection.lastError` takes precedence over a previously completed assistant message, because provider failures can happen before a new assistant message is persisted.

All snapshot-to-task-status callers must use the shared projection helper from `@zcode/shared`. UI projection, service adapter, and sqlite index sync must not carry separate copies of this logic, otherwise switching workspaces can restore a task from a different terminal-status interpretation than the one used while streaming.

## Implementation

- `packages/services/src/session/taskIndexRepo.ts`
- `packages/services/src/session/zcodeTaskService.ts`
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`
- `packages/shared/src/zcode-task-types.ts`
- `docs/ui/pinned-task-storage.md`

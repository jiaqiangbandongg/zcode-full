# Local Settings And SQLite Migrations

## Goal

ZCode needs a durable local state layer for project-scoped runtime choices, while keeping hand-authored config files declarative. The current users are project permission rulesets and project permission mode. Model selection and reasoning are intentionally not global local settings: configured defaults, App Recent, sparse Session Selection, and Active Model each have their own documented owner.

This layer also needs ordered SQLite migrations so users can safely jump versions without relying on ad hoc `create table if not exists` blocks.

## Storage Boundary

The table is named `local_setting` because it stores local mutable state, not source-controlled project config.

```sql
create table local_setting (
  scope text not null,
  scope_id text not null,
  namespace text not null,
  key text not null,
  value text not null,
  schema_version integer not null,
  time_created integer not null,
  time_updated integer not null,
  primary key(scope, scope_id, namespace, key)
);
```

Initial keys:

| Scope     | Scope ID   | Namespace    | Key       | Value                    |
| --------- | ---------- | ------------ | --------- | ------------------------ |
| `project` | project id | `permission` | `ruleset` | `PermissionRuleset` JSON |
| `project` | project id | `permission` | `mode`    | `{ "mode": "build" }`    |

The table is generic, but callers should not read or write arbitrary keys directly. Adapters expose typed methods, and each namespace/key pair gets runtime validation when it becomes part of public behavior.

Older builds may have written `user/default/model/reasoningLevel`. Current code ignores that row; it is not migrated into a Selection because doing so would turn an obsolete global preference into an explicit model option.

## Migration Ledger

SQLite migrations use a ledger table:

```sql
create table schema_migration (
  id text primary key,
  checksum text not null,
  app_version text,
  time_applied integer not null
);
```

Migration rules:

- Migrations are append-only and run in deterministic order.
- Each migration declares the app version that introduced it; future migrations use their own version while historical entries keep their original version.
- Each migration is wrapped in `begin immediate` / `commit` so concurrent CLI startups serialize schema writes.
- Applied migrations are checked by `id` and `checksum`. A checksum mismatch is a startup error because historical migration SQL must not be edited in place.
- Migration SQL must be idempotent where practical, because old databases can already contain tables created by pre-ledger builds.
- The ledger records a migration only after its SQL succeeds.

## Startup Migration Gate

SQLite schema migration is a startup gate. After config and database path resolution, but before runtime, provider, model, MCP, TUI, ZCode app-server, or session command logic is initialized, bootstrap must open the SQLite store and finish all pending migrations. Later layers receive a migrated store; they must not continue with an unverified schema.

Fast paths that do not need local state, such as `--help`, `--version`, and `doctor`, may skip the gate. Any path that reads or writes session, permission, local setting, input history, workflow, or ZCode app-server state must pass the gate first.

Startup behavior by entrypoint:

| Entrypoint                   | Migration timing                                            | Output behavior                                                                                                                                                         | Failure behavior                                                           |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| prompt / non-interactive CLI | Before app construction and before model adapter creation.  | Normal CLI errors go to stderr; verbose mode may include cause/stack.                                                                                                   | Return exit code `1`; do not create runtime.                               |
| TUI                          | Before entering the full-screen TUI.                        | Avoid raw stderr while the TUI owns the screen. Pre-TUI status may use the controlled stderr path; failures are printed as ordinary CLI errors before entering the TUI. | Return exit code `1`; do not call `runTui`.                                |
| ZCode app-server             | Before `zcode app-server --stdio` accepts protocol traffic. | Never write migration progress to stdout, because stdout is the protocol stream. Default to structured logs; failures may be summarized on stderr.                      | Return exit code `1`; do not establish the app-server protocol connection. |

The storage adapter still owns the actual SQLite transaction and checksum checks. Bootstrap owns the ordering: migration is a named, observable startup stage and blocks all later side effects.

Migration errors are structured around stable categories where possible:

- `open_failed`: SQLite file or parent directory could not be opened or created.
- `checksum_mismatch`: an applied migration checksum differs from the current migration SQL.
- `sql_failed`: migration SQL failed after the migration transaction began.

Errors preserve the original cause and include the database path plus migration id when known. CLI and ZCode app-server entrypoints format these errors at their boundary instead of calling `process.exit` from the adapter.

## Provider 数据迁移（Todo109）

保留 staging 的 `0019_dwf_journal` 及其历史 checksum；之后追加
`0020_provider_model_selection`，在同一启动门禁内执行，不再在恢复某个会话时补迁。
它只增加 JSON 成员：Session 当前选择、User/Assistant 历史模型来源、模型切换和
Subtask Part 的新结构。旧成员与旧值保留，历史执行身份不按当前账号重新解释。
`session_input` 未记录的模型和模式不补猜；其余表不因这次转换改写。

```text
旧库 → 启动 migration/事务 → 新字段 Reader → 展示/执行边界
        旧值原样留存           缺配置可重选，内容仍可读
回滚写入旧格式 → 再升级 → 已记账 migration 不重跑、不从旧字段逐读补值
```

存储使用独立成员避免新旧同名冲突：模型切换为 `fromModelSelection` /
`toModelSelection`，Subtask 为 `modelSelection`。adapter 将它们解包为现有 Port
的逻辑字段，Core 不读取旧字段。只为冻结旧读取器的内容可读性保留必要写入：新
User 的 `model` 对象和模型切换的 `toModel` 对象；更新已有记录保留其原旧值，
不持续双写配置。fork/复制由 adapter 按原记录坐标复制旧快照，业务层不解释旧配置。

本节只约束 Provider 重构；下面既有 permission 迁移的兼容阶段不在本次范围内。

## Permission Migration

The old `permission(project_id, data)` table is migrated into:

```text
project/<project_id>/permission/ruleset
```

The backfill uses `insert or ignore` so repeated startup cannot overwrite newer `local_setting` rows with stale legacy data.

During the compatibility phase:

- Reads check `local_setting` first and fall back to the old `permission` table.
- New writes go to `local_setting`.
- The old table remains in the database until a later cleanup migration removes fallback support.

## Tests

- Fresh databases apply all migrations and record their ids in order.
- Reopening a migrated database does not duplicate ledger or `local_setting` rows.
- A database with only the legacy `permission` table backfills rulesets into `local_setting`.
- A recorded migration checksum mismatch fails startup.
- App bootstrap opens the migrated session store before model adapter, runtime, MCP, or TUI initialization.
- app-server startup migration failure prevents ZCode app-server connection and does not write progress to stdout.
- TUI startup migration failure returns before entering the full-screen TUI.

# SQLite 多 Agent 并发启动设计

## 背景

ZCode 的本地工作区和远程工作区都会启动独立 Agent 进程；同一系统用户下的 Agent
共享 `~/.zcode/cli/db/db.sqlite`。窗口级 SSH host pooling 允许同一 SSH 主机上的多个
workspace 在 host 就绪后并行启动 Agent，因此数据库初始化必须支持多个进程同时进入。

2026-07-15 在 `mac-studio` 上观测到两个远程 workspace 同时启动时：两个 Agent 都进入
SQLite migration，其中一个在 migration prelude 抛出 `database is locked` 并退出。App
随后只看到 `ZCode agent transport closed`，表现为同组的另一个 workspace 未重连。

现有 `migration-runner` 先执行 `pragma journal_mode = wal`，之后才设置
`pragma busy_timeout = 5000`；同时 `schema_migration` 建表也位于 migration transaction
之外。因此，第一个需要数据库锁的初始化操作没有等待或串行化保护。

## 行为合同

1. 本地和远程 Agent 必须使用同一个 session-store 启动入口和并发语义，不增加
   workspace 类型分支。
2. 多个 Agent 同时打开同一个 session DB 时，SQLite 是初始化顺序的唯一权威；UI、Host
   和 SSH 重连层不负责串行化数据库 migration。
3. 数据库连接必须从打开时就具备有限的 busy timeout，不能等到首次加锁操作之后再设置。
4. WAL journal mode 初始化仅对外部写者竞争的 `SQLITE_BUSY` 做有限重试；`SQLITE_LOCKED` 立即报错，避免对同连接冲突空等。已经是
   WAL 时不得重复执行 journal mode 写操作。
5. `schema_migration` 建表、checksum 校验、未应用 migration 和 migration 记录写入必须
   位于同一个 `BEGIN IMMEDIATE` transaction 中。第二个进程获得写锁后必须重新检查
   migration 状态，不得重复执行已经提交的 migration。
6. 超过锁等待期限必须关闭数据库并返回结构化 `lock_timeout`；checksum mismatch、SQL
   错误、打开失败等非锁错误不得重试或降级。
7. migration 结束后，已有 SessionStorePort、数据库路径、session 数据模型和读写 API
   保持不变。本地工作区启动、读写历史、恢复 session 的功能和调用顺序不得改变。
8. `:memory:` store 保持 SQLite 原生 `memory` journal mode；它不跨进程共享，不强制切换
   WAL，既有本地测试和注入路径继续可用。

## 启动时序

```text
Agent A                                  Agent B
   |                                        |
   +-- open DB (busy timeout active)        +-- open DB (busy timeout active)
   +-- ensure WAL --------------------------+-- ensure WAL / observe WAL
   +-- BEGIN IMMEDIATE (lock owner)          +-- BEGIN IMMEDIATE (wait)
   +-- create migration table               |
   +-- verify/apply migrations              |
   +-- COMMIT ------------------------------+-- acquire lock
                                            +-- verify migrations (no-op)
                                            +-- COMMIT
   +-- startup continues                    +-- startup continues
```

## 非目标

- 不把同一 SSH host 的 workspace 改成串行重连。
- 不为每个 workspace 拆分 session DB。
- 不在 UI、desktop main、Host 或 relay 中持有 migration 锁。
- 不对所有 Agent 启动失败进行无差别重试。

## 回归验证

1. 两个真实 Agent process 同时打开同一个全新 DB，二者都能完成 migration，
   最终 migration id 唯一且完整。
2. 一个 Agent 持有 migration 锁时，另一个 Agent 等待并在前者提交后成功，而不是立即抛
   `database is locked`；并发进程测试需要重复运行以放大竞态窗口。
3. 锁持续超过期限时返回 `SqliteSessionMigrationError(kind=lock_timeout)`。
4. checksum mismatch 仍立即返回 `checksum_mismatch`，不会被锁重试吞掉。
5. 既有 session-store 单测全部通过，证明本地工作区共同使用的创建、读写、恢复路径没有
   行为回归。
6. `:memory:` store 能完成全部 migration，验证本地 bootstrap 的既有注入方式不变。

## 2026-09-14 大库启动补充

CLI/TUI 与 Protocol 启动改用异步入口；WAL 与 BEGIN 的外部锁等待共享 60 分钟预算，单次 native busy 25ms，异步退避 10–200ms。同步构造器保留原 5 秒兼容入口；异步迁移结束也恢复业务连接 5 秒策略。SQLite 长 SQL 本身仍同步执行，但每一阶段控制帧先 flush，Host/UI 因进程隔离可以继续展示状态。

Migration/账本仍全部处于同一 IMMEDIATE 事务，ready 只在 COMMIT 成功后发送。历史 SQL/ID/checksum 不变，白名单等价执行器仅用于尚未记账项。完整设计、错误和验证边界见 `docs/desktop/database-migration-startup-gate-plan.md` 与 Todo 144；Host tasks-index 初始化不包含在本次 loading 中。

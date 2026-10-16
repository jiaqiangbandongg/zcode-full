# Todo 37：撤销未发布的 Model Usage 数据库列重命名

> 状态：已实现
>
> 日期：2026-08-28
>
> 来源：Provider Refactor 上线前降级兼容性 Review

## 1. 背景

Provider Refactor 已将领域中的推理档位从含义模糊的 `variant` 收口为 `reasoningLevel`。提交
`8c55290f1f` 在完成领域命名清理的同时，又增加了 SQLite migration：

```sql
alter table model_usage rename column variant to reasoning_level;
```

该物理列重命名没有改变数据含义、查询能力或产品行为，只是让数据库列名与新领域字段一致。它会使执行过新 migration
的数据库无法被旧版本正常写入：旧版本仍向 `model_usage.variant` 写数据，因此降级后会遇到列不存在错误。

本次变更尚未正式发布，只有极少数开发或体验环境执行过该 migration。没有必要为未发布的物理命名调整永久增加反向
migration、双列兼容或运行时 Schema 探测。

## 2. 已裁决目标

数据库继续保留既有物理列名，领域继续使用已经收口后的准确名称：

```text
ModelUsageRecord.reasoningLevel
              |
              | Repository 映射
              v
model_usage.variant
```

具体裁决如下：

1. 删除 `0019_model_usage_reasoning_level` migration；
2. `model_usage` 永久继续使用 `variant` 列，不新增 `reasoning_level` 列；
3. 领域、协议和 Runtime 中已经采用的 `reasoningLevel` 命名保持不变；
4. Usage Repository 将 `reasoningLevel` 写入数据库的 `variant` 列；
5. 不增加数据库反向 migration；
6. 不增加 `variant/reasoning_level` 双列兼容、列存在性探测或启动时自动修复；
7. 已执行该未发布 migration 的少量环境由维护者人工修复；
8. `0019_model_usage_reasoning_level` 作为已撤销的开发期 ID 保留在历史记录中，后续正式 migration 不复用该 ID。

## 3. 实现范围

### 3.1 撤销物理 Schema 变更

- 从 `SQLITE_MIGRATIONS` 删除 `0019_model_usage_reasoning_level`；
- 新建数据库仍由 `0010_usage_observability` 创建 `model_usage.variant`；
- 更新 migration 顺序与幂等测试，不再把 `0019_model_usage_reasoning_level` 视为正式 migration；
- 检查生产 SQL，确保不存在对 `model_usage.reasoning_level` 的读写。

### 3.2 保留领域语义

- `ModelUsageRecord`、Runtime、Telemetry 和调用方继续使用 `reasoningLevel`；
- 只在 SQLite Usage Repository 边界做命名映射；
- 不重新引入领域字段 `variant`，也不把模型身份与推理档位重新混为一个概念。

### 3.3 人工修复已受影响环境

人工修复不是仓库 migration，也不在应用启动时自动执行。操作前必须退出 ZCode 并备份对应 SQLite 文件：

```sql
BEGIN IMMEDIATE;
ALTER TABLE model_usage RENAME COLUMN reasoning_level TO variant;
DELETE FROM schema_migration
WHERE id = '0019_model_usage_reasoning_level';
COMMIT;
```

只对已经确认存在 `reasoning_level` 且记录过 `0019_model_usage_reasoning_level` 的数据库执行。未受影响的正式或开发环境
不得执行该 SQL。

## 4. 明确不做

- 不发布 `reasoning_level -> variant` 的反向 migration；
- 不在 Repository 中同时兼容两套物理列；
- 不在启动时读取 `pragma_table_info` 并猜测数据库形态；
- 不删除或重建 `model_usage` 表；
- 不改变已有 usage 数据含义和保留策略；
- 不借此调整其他 Session Store 表、列或 migration；
- 不回退 Provider Refactor 已完成的 `reasoningLevel` 领域命名。

## 5. 测试计划

1. 先更新失败测试，再修改生产代码；
2. 新建 SQLite Session Store，断言 migration 列表止于当前正式 migration，不包含已撤销的 `0019`；
3. 使用 `pragma_table_info(model_usage)` 断言存在 `variant`、不存在 `reasoning_level`；
4. 以带有 `reasoningLevel` 的 `ModelUsageRecord` 写入数据，断言值正确落入 `variant`；
5. 覆盖同一 usage record 的 upsert，确认冲突更新仍写入正确列；
6. 运行 adapters Session Store 与 Usage Query 定向单测；
7. 运行相关 package typecheck；
8. 最终执行根 `pnpm typecheck`、`pnpm lint` 和 `git diff --check`。

## 6. 完成标准

- 分支相对 `origin/staging` 不再包含任何 SQLite 表或列变更；
- 全新数据库和未受影响的既有数据库继续使用 `model_usage.variant`；
- 领域代码继续只表达 `reasoningLevel`；
- 旧版本降级后不会因为本分支重命名了 `model_usage.variant` 而写入失败；
- 仓库不存在自动反向迁移、双列兼容和运行时 Schema 猜测；
- 受影响环境的人工修复步骤经过临时数据库演练确认，但不进入正式 migration 链。

## 7. 实施记录

- 已从正式 migration 链删除 `0019_model_usage_reasoning_level`，新建数据库继续由
  `0010_usage_observability` 创建 `model_usage.variant`；
- Usage Repository 在唯一持久化边界将领域字段 `reasoningLevel` 映射到物理列 `variant`，领域契约未回退；
- Session Store 测试已固定 migration 清单与真实表结构，并覆盖首次写入和同 ID upsert；
- 已审计生产代码，不存在 `model_usage.reasoning_level`、双列兼容、Schema 探测或自动反向修复；
- 本文第 3.3 节的人工修复 SQL 已在临时 SQLite 数据库演练，确认原 usage 值保留且 `0019` 记录被删除。

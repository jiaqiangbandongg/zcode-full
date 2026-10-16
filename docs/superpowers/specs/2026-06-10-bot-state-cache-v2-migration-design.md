# Bot State/Cache V2 迁移设计

## 背景

Bot 当前使用 `bot-state.json` 保存运行态和 draft 选择，使用 `bots-model-cache.json` 保存模型供应商缓存。模型供应商配置已经迁移到 `config.json` 后，Bot 仍可能从旧 state/cache 中读到历史 provider id 或旧模型快照，导致 `/model` 展示当前模型时能看到旧的 `providerId/modelId`，但选择供应商时提示未找到模型供应商。

`model-providers.json` 已有到 `config.json` 的迁移逻辑。Bot 的 state/cache 不应重新实现 provider 配置迁移，而应复用 `modelProviderService.getAll()` 获取迁移后的权威 provider 数据，再把 Bot 自己的运行态和缓存升级到新文件。

## 目标

- 新增 `bot-state.v2.json` 和 `bots-model-cache.v2.json`。
- 新版本 Bot 优先读写 v2 文件。
- v2 文件不存在时，只读旧 `bot-state.json` 和 `bots-model-cache.json` 作为迁移输入。
- 迁移后不修改、不删除旧文件，老版本应用继续按旧逻辑工作。
- Bot provider/model 快照以 `config.json` 迁移后的 provider 数据为准。
- 避免继续保留无法在新 provider 结构中解析的 draft model。

## 非目标

- 不把 Bot 运行态合并进 `config.json`。
- 不修改旧 `bot-state.json`、`bots-model-cache.json` 或 `model-providers.json` 的写入逻辑。
- 不改变 Bot 指令语义、授权模型、workspace 选择规则或第三方平台适配器协议。
- 不迁移或暴露 provider API key；Bot model cache 仍只保存可用于选择展示的非敏感字段。

## 文件与版本

`bot-state.v2.json` 的顶层结构包含：

- `version: 2`
- `migratedAt`
- `source?: { stateUpdatedAt?: number }`
- `bots`: 现有 bot state 的 v2 形态

`bots-model-cache.v2.json` 的顶层结构包含：

- `version: 2`
- `updatedAt`
- `migratedAt?`
- `source?: { cacheUpdatedAt?: number }`
- `providers`: 来自 `modelProviderService.getAll()` 的脱敏 provider/model 快照
- `modelIdRemaps?`: 仅保存迁移时可证明唯一的旧模型到新模型映射，便于 state 迁移复用

v2 cache 的 provider 列表不是旧 cache 的直接拷贝。旧 cache 只作为辅助输入，用于理解旧 draft model 或旧缓存项是否还能映射到新 provider。

## 迁移流程

Bot service 初始化时按顺序加载：

1. 如果 v2 state/cache 都存在且 schema 合法，直接使用 v2 文件。
2. 如果任一 v2 文件不存在，读取对应旧文件作为只读迁移输入。
3. 调用 `modelProviderService.getAll()` 获取当前权威 provider 列表。该调用继续复用 `model-providers.json -> config.json` 的既有迁移逻辑。
4. 生成 `bots-model-cache.v2.json`：
   - provider 快照来自当前权威 provider 列表；
   - 过滤敏感字段；
   - 记录迁移来源时间；
   - 对旧 provider/model 生成可验证的唯一映射。
5. 生成 `bot-state.v2.json`：
   - 保留 workspace、active task、pending permission、平台 offset、reply mode、mode、thoughtLevel 等非 provider 字段；
   - 对 `draftOptions.model` 执行 provider/model 校验和迁移；
   - 匹配失败或存在歧义时清空该 draft model，让 Bot 回到未选择模型的安全状态。
6. 后续运行只读写 v2 文件，不再写旧 state/cache。

## 模型迁移规则

迁移 draft model 时按保守顺序处理：

1. 如果旧值的 `providerId` 在权威 provider 列表中存在，且 `modelId` 仍属于该 provider，直接保留。
2. 如果 `providerId` 不存在，但旧 cache 能提供 provider name，且 `(provider name, modelId)` 在权威 provider 列表中只匹配到一个 provider，则迁移到该 provider id。
3. 如果旧值只包含 modelId，且该 modelId 在权威 provider 列表中只出现一次，可以迁移到该 provider。
4. 其他情况视为无法安全迁移，清空 draft model，并记录一次 `warn` 日志。

这里不做模糊匹配，不按相似名称猜测 provider，也不因为 modelId 相同但多 provider 命中而随机选择。

## 兼容与回滚

- 新版本写 v2 文件后，旧版本仍可继续使用旧文件；因为新版本不会修改旧文件，所以不会破坏旧版本的读取。
- 如果用户回滚到旧版本，旧版本看不到 v2 文件，会继续读旧 state/cache。
- 如果 v2 文件损坏，新版本可以重新从旧文件和当前 provider 配置生成 v2 文件；若旧文件也损坏，则按空 state/cache 启动。
- 删除 v2 文件可触发重新迁移，但不会恢复旧文件中已经失效的 provider/model。

## 日志

迁移只记录低频生命周期日志：

- `info`: v2 文件缺失并开始迁移、迁移完成。
- `warn`: 旧 state/cache 读取失败、v2 schema 无效、draft model 无法安全迁移。
- `error`: v2 文件写入失败且 Bot 无法继续加载状态。

日志使用服务层 `createServiceLogger(scope)`，不记录 API key 或完整 provider secret。

## 验证

添加 Bot service 存储/迁移单测覆盖：

- v2 文件存在时优先使用 v2，不读取旧文件作为权威数据。
- v2 文件不存在时从旧 state/cache 迁移，并只写 v2 文件。
- providerId/modelId 仍有效时保留 draft model。
- providerId 变化但 provider name + modelId 唯一匹配时迁移 draft model。
- 多 provider 匹配或无法匹配时清空 draft model。
- 生成的 model cache provider 快照来自 `modelProviderService.getAll()`，不是旧 cache 直拷贝。
- 迁移输出不包含 provider API key。

完成实现后执行：

- 相关 Bot migration 单测
- `pnpm typecheck`
- `pnpm lint`

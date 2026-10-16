# Todo 35：Legacy Personal Provider 用户意图迁移收口

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：Todo 33 上线前 Legacy Importer 复核
>
> 关联任务：[`Todo 33`](./todo-33-personal-provider-config-file-cutover.md)

## 1. 问题

Todo 33 已把正式 Personal Provider/Model Config 切换到 `provider_config.json`，但现有 Legacy Importer
仍按“旧 Effective Config 与当前 Built-in 求差异”的方式迁移。旧 `config.json` 中混入了 Built-in Preset、
Catalog enrichment、设置页默认回填、账号运行态与已经退役的模型 hardcode，因此差异不能等同于用户意图。

当前实现还存在三类直接偏差：

- `source=builtin` 仍可能迁移 API Key、enabled、用户新增模型和 Model Rule；
- Personal Provider 缺少 `group=standard-personal`，迁移后不能作为完整 Personal Provider 投影；
- `maxOutputTokens`、modalities、tools、structured output、reasoning 等系统生成事实会被固化为 Personal Rule。

## 2. 最终裁决

迁移只保留可以稳定表达的用户自定义 Provider 调用意图、模型成员/顺序，以及自定义模型的
`contextWindow`。Importer 不再解析或比较当前 Built-in Config，不创建第二套模型事实推断。

```text
旧 config.json
      |
      +--> source = builtin
      |      `--> 整个 Provider 丢弃
      |
      `--> 用户自定义 Provider
             |
             +--> Personal Provider Config
             |      ├─ providerId / group
             |      ├─ label / logo
             |      ├─ API Key / 管理地址
             |      ├─ API Schema / Base URL / Headers
             |      ├─ enabled
             |      └─ modelIds / modelOrder
             |
             `--> Personal Model Config Rules
                    `─ 仅保留合法 contextWindow
```

`models-dev` 已废弃，`workspace` 不属于本迁移的现实输入；Importer 不为它们建立兼容分支。缺少
`source`、但由旧 Reader 识别为用户自定义结构的 Provider，继续按旧 Reader 的 `custom` 缺省语义处理。

## 3. Provider 迁移

### 3.1 Built-in

`source=builtin` 整体丢弃，不产生 Provider Overlay 或 Model Rule。API Key、Endpoint、Schema、Headers、
enabled、模型新增/删除、模型顺序和所有账号状态均不抢救。当前 ZCode Built-in Config 与 Account Overlay
重新提供正式事实。

### 3.2 用户自定义 Provider

有效自定义 Provider 迁移以下字段：

- trim 后非空的 `providerId`；
- 固定 `group=standard-personal`；
- 用户名称与 logo；名称等于 ID 时可省略 label；
- API Key 与 API Key 管理地址；
- 旧配置明确保存的 API Schema、归一化 Base URL 与 Headers；
- `enabled` 原样保留，`undefined` 不回填；
- 非空、未删除、去重后的 `modelIds`；
- 同一有效成员顺序写入 `modelOrder`。

不迁移 source、Catalog 身份、created/updated 时间、`systemDisabledReason`、登录/套餐/连接失败等运行态。

## 4. 模型迁移

旧字符串模型只提供成员身份，不产生 Model Rule。旧对象模型在 `deleted=true` 时从成员和规则中同时移除；
其他对象模型只在 `contextWindow` 是有限正整数时产生精确的 `providerId + modelId` Personal Rule：

```ts
new ModelConfig({
  properties: new ModelPropertiesConfig({ contextWindow }),
});
```

`contextWindow` 不依赖 `modified`、不和 Built-in 默认值比较，也不在 Importer 内调用 Resolver。

下列模型事实全部丢弃，由当前 Built-in Model Config Rules 重新解析：

- `maxOutputTokens` 与 `hasMaxOutputTokens`；
- Text/Image/Video/Audio/PDF 输入输出格式与 `modalitiesConfigured`；
- tools、structured output、native web search、mid-conversation system；
- reasoning spec/mapping/profile；
- compatibility、priority、disabled reason、model headers/options、`modelIdByKind`；
- Catalog 名称与展示元数据。

`modified` 只是整个旧模型条目参与过编辑的标记，不能证明某个叶子字段由用户修改，因此不参与迁移判断。

## 5. 文件与运行时边界

Todo 33 的生命周期保持不变：仅当 `provider_config.json` 不存在时只读旧 `config.json` 并执行一次导入，
不备份、不读取 `model-providers.json`，成功落盘后只监听 `provider_config.json`。本 Todo 不增加 Provider v1/v2
中间格式兼容，也不修改账号、模型选择或 Active Model 冻结语义。

## 6. 测试计划

先写失败测试，再修改生产实现：

1. Built-in Provider 即使包含 API Key、modified 模型和新增模型也零迁移；
2. 自定义 Provider 完整保留调用配置、`standard-personal` group、enabled、成员和顺序；
3. 字符串/对象/删除/空白/重复模型正确投影；
4. 有效 context 全量迁移，不依赖 `modified`；非法或缺失 context 不产生 Rule；
5. max output、modalities、tools、structured output、reasoning、compatibility 等均不进入 Personal Rule；
6. 迁移结果经正式 codec JSON round-trip 后语义不变；
7. 迁移后的自定义 Provider 能与 Built-in 通用 Model Rules 组合为完整 Registry 模型；
8. Provider Runtime 首次导入、已有正式文件跳过导入及文件监听回归通过。

## 7. 完成标准

- Legacy Importer 不再依赖 ZCode Built-in Snapshot 或 Effective diff projection；
- Built-in、Catalog/账号状态和退役模型能力不会进入 Personal Config；
- 自定义 Provider 在迁移后具有完整 group、调用配置、成员与排序；
- Personal Model Rule 只可能包含 `properties.contextWindow`；
- 定向单测、相关 Services/Provider 测试、根 `pnpm typecheck` 与 `pnpm lint` 通过；
- 完成后提交 Conventional Commit。

## 8. 实施结果

- Importer 已删除 ZCode Built-in Snapshot 输入与 Effective diff projection，`source=builtin`、退役
  `models-dev` 和非 Personal 的 `workspace` 输入均不会写入正式文件；
- 仅为旧迁移提供的 `projectEffectiveProvidersToPersonalConfig` 已确认无生产调用方，并连同公开导出和
  自测一并删除，避免继续暴露“从 Effective Config 反推 Personal 意图”的错误入口；
- 自定义 Provider 直接生成带 `group=standard-personal` 的 Personal Config，保留调用配置、enabled、
  去重后的模型成员和原始顺序；
- 旧字符串/对象/删除/空白/重复模型统一经过单一成员收集器；Personal Model Rule 只可能包含合法正整数
  `properties.contextWindow`；
- reasoning 转换、max output、modalities、tools 和 structured output 等旧能力迁移实现已删除；
- 纵向测试证明迁移 context 与当前通用 Built-in Model Rule 合成后，完整格式、能力和 max output 均来自
  当前规则，并能进入正式 Resolver；
- Services 首次迁移测试证明 `provider_config.json` codec round-trip 保留 group、成员顺序和 context Rule；
- 后续生命周期 Review 发现 Standalone CLI importer 仍引用已经删除的 Effective→Personal projection；现已同步
  改为直接生成 `standard-personal` Provider，并同样只保留模型成员、顺序与合法 `contextWindow`，避免 CLI
  启动时因缺失导出而把迁移静默降级为空配置；
- 定向 Services 测试 13 条、`@zcode/provider` 151 条、`@zcode/provider-node` 44 条全部通过；根
  `pnpm typecheck` 与 `pnpm lint` 通过，lint 仅报告 33 条本轮无关既存 warning；全量 `pnpm test:unit`
  1486 个文件通过、1 个跳过，12672 条测试通过、25 条跳过。

# 06 Config 存储外壳 Repository 私有化

> 状态：已完成
>
> 日期：2026-08-24
>
> 来源审查：[`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> 目标设计：[`../design/registry/configuration.md`](../design/registry/configuration.md)
>
> 建议前置：[`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)、
> [`todo-05-model-ref-retirement.md`](./todo-05-model-ref-retirement.md)

## 1. 任务目标

从 Provider Domain 的公共 API 删除 `ProviderConfigDocument` 和 `ModelSelectionConfigDocument`，把
`schemaVersion`、JSON 外壳、解析、序列化和 migration 收回 Node Repository 的私有存储实现。

本 Todo 不删除版本化文件，也不降低持久化可靠性。配置文件仍然需要严格 Schema、版本迁移、备份、原子
写入、文件锁、revision 和 watcher；变化只在于领域层和调用方不再感知这些物理存储概念。

```text
当前

Settings / Config Service / Projection / Legacy Importer
                          |
                          v
         ProviderConfigDocument / ModelSelectionConfigDocument
          |- schemaVersion
          |- Domain Config
          |- toJSON()
          `- parse / migrate
                          |
                          v
                    Node Repository

目标

Settings / Config Service / Projection / Legacy Importer
                          |
                          v
 ProviderConfigLayerUpdate / ModelSelection | undefined
                          |
                          v
                    Node Repository
          |- private Stored*Vn schema
          |- parse / serialize / migrate
          |- backup / atomic write / file lock
          `- revision / watcher
```

## 2. 核心裁决

### 2.1 `Document` 不是领域概念

Provider Domain 只认识：

- `ProviderConfigMap`；
- `ModelConfigRules`；
- `ProviderConfigLayerSnapshot`；
- `ProviderConfigLayerUpdate`；
- `ModelSelection`；
- Config Overlay、完整性校验、Registry 和初始模型选择解析。

`schemaVersion`、文件顶层对象、JSON 字段布局和 migration 只描述“如何保存”，不构成新的 Config Layer、
Effective Config 或运行时状态。因此 `@zcode/provider` 不得再导出带 `Document` 语义的对象。

### 2.2 不用新中间层替代 `Document`

不新增公共 `ConfigEnvelope`、`ConfigPayload`、`ConfigState`、`SerializedConfig` 或同形 DTO。现有领域值已经足够：

```ts
interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly models: ModelConfigRules;
}

interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly models: ModelConfigRules;
}
```

Provider Repository 继续以 Snapshot/Update 为边界。Model Selection Repository 的业务读写值直接使用
`ModelSelection | undefined`；不要仅为了保留 `.configuredDefault` 包装层而建立新的公共对象。

### 2.3 存储结构可以有名字，但必须私有

`provider-node` 内部可以按版本声明类似结构：

```ts
interface StoredProviderConfigV1 {
  readonly schemaVersion: 1;
  readonly providers: unknown;
  readonly models: unknown;
}

interface StoredModelSelectionConfigV1 {
  readonly schemaVersion: 1;
  readonly configuredDefault?: unknown;
}
```

准确字段类型由私有 Zod Schema 和序列化函数约束。名称可以使用 `Stored*Vn` 或 `*FileVn`，但不能从
`@zcode/provider-node` 的公共 barrel 导出，也不能成为 Service、UI、Runtime 或 Protocol 的 Contract。

### 2.4 存储可靠性完整保留

Repository 私有化不等于直接 `JSON.parse()` 后信任类型。以下能力全部保留：

- 严格运行时 Schema 校验；
- 当前 `schemaVersion` 与未来相邻版本 migration；
- 高版本拒绝与可诊断错误；
- Personal 文件 migration 前的原文件备份；
- 私有权限的原子写入和文件锁；
- 基于规范化内容的 revision；
- watcher 去重和变更通知；
- Official Source 与 Personal Repository 对同一正式文件 Schema 的一致理解。

这些行为由 Repository/codec 测试保证，不能因删除公共 class 而弱化。

## 3. Provider Config 目标边界

### 3.1 Domain 与 Repository

```text
@zcode/provider
|- ProviderConfigMap
|- ModelConfigRules
|- ProviderConfigLayerSnapshot
|- ProviderConfigLayerUpdate
|- ProviderConfigService
`- Overlay / Resolver / Registry
             |
             | read/update
             v
@zcode/provider-node
|- NodeOfficialProviderConfigSource
|- NodePersonalProviderConfigRepository
`- private provider-config-file-codec
   |- StoredProviderConfigVn
   |- parse / serialize
   `- migrate
```

- Official Source 解析文件后返回 `ProviderConfigLayerSnapshot`；
- Personal Repository 接收 `ProviderConfigLayerUpdate`，内部构造并写入版本化文件；
- revision 继续由 Repository 根据规范化的持久化内容产生；
- Domain 不负责选择文件格式，也不调用 `toJSON()` 生成存储外壳。

### 3.2 Personal 投影

`projectEffectiveProvidersToPersonalConfig()` 当前返回 `ProviderConfigDocument`。目标是返回
`ProviderConfigLayerUpdate`，只表达投影得到的 Personal Provider Map 和 Model Rules。

本 Todo 只修正返回边界，不重新认可 Effective -> Personal 作为 Settings 正常保存路径。正式 Settings 继续
提交用户实际修改形成的稀疏 Personal Overlay；该投影函数只服务于仍在兼容窗口内的明确旧配置导入，后续应随
Legacy importer 一起退役。

### 3.3 Migration 类型

`ProviderConfigDocumentMigration = (input: unknown) => unknown` 不再从 Domain 导出。正式版本 migration 是
存储 Schema 的实现，应由 `provider-node` 私有 codec 管理。

如果 Bootstrap 在过渡期需要注入无版本 Legacy importer，它返回 `ProviderConfigLayerUpdate | null`；
Repository 负责校验领域值、套上当前版本文件外壳并写入。Legacy importer 不产生 `schemaVersion`，也不认识
正式文件的序列化 class。

## 4. Model Selection 目标边界

当前 `model-selection-config.ts` 混合了文件存储和领域解析，必须拆开：

```text
@zcode/provider
|- ModelSelection
|- InitialModelSelectionResolution
`- resolveInitialModelSelection()

@zcode/provider-node
|- NodeModelSelectionConfigRepository
`- private model-selection-config-file-codec
   |- StoredModelSelectionConfigVn
   |- strict schema
   `- parse / serialize / migrate
```

Repository 公共行为收紧为：

```ts
read(): Promise<ModelSelection | undefined>;
saveConfiguredDefault(selection: ModelSelection | undefined): Promise<void>;
```

如果调用方确实需要保存后值，`saveConfiguredDefault()` 可以返回冻结的 `ModelSelection | undefined`，但不能
返回存储 Document。最终签名以调用方测试证明的最小需要为准。

`resolveInitialModelSelection()` 继续接收 `configuredDefault?: ModelSelection` 和 Registry View；它与文件版本、
文件缺失和 migration 无关，必须留在 Domain。

## 5. Legacy 与正式 Migration 的边界

两类迁移必须区分：

```text
无版本旧配置
    |
    v
Legacy Importer（过渡发布设施）
    |
    v
当前 Domain Value
    |
    v
Repository 写入当前版本文件

正式 schemaVersion N 文件
    |
    v
Repository private N -> N+1 migration
    |
    v
当前版本文件
```

- Legacy importer 只转换旧配置明确表达的事实，不猜模型能力；
- 强制升级窗口结束后，Legacy importer、旧 parser、兼容常量和测试整体删除；
- 已发布正式文件格式的相邻版本 migration 长期保留；
- 未发布过的中间 Schema 不建立兼容历史；
- Legacy 和正式 migration 都不能重新扩散到 Core、Registry、Settings 或 Runtime。

## 6. 当前影响面

实施前至少检查以下消费者：

| 范围                                                                | 当前泄漏                                  | 目标                       |
| ------------------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| `packages/provider/src/config/document.ts`                          | 公开 Provider Document、parser、migration | 删除公共存储外壳           |
| `packages/provider/src/model-selection-config.ts`                   | 存储与选择解析混合                        | 只保留选择领域逻辑         |
| `packages/provider/src/personal-config-projection.ts`               | 返回 Document                             | 返回 Layer Update          |
| `packages/provider-node/src/personal-provider-config-repository.ts` | 导入公共 Document                         | 使用私有 codec             |
| `packages/provider-node/src/official-provider-config-source.ts`     | 导入公共 migration                        | 使用同一私有 codec         |
| `packages/provider-node/src/model-selection-config-repository.ts`   | read/save 返回 Document                   | 直接读写 Selection         |
| `packages/provider-node/src/provider-config-runtime.ts`             | importer 类型泄漏 Document                | importer 返回 Layer Update |
| CLI/Services Legacy importer                                        | 构造 Document                             | 只产生领域值               |
| Provider/Provider Node 测试                                         | 以公共 Document 为测试主体                | 按领域与存储职责拆分       |

实施时以 `rg`、TypeScript 引用和 package exports 复核完整范围，不能只按上述文件清单机械迁移。

## 7. 测试先行

### 7.1 Domain

1. Personal 投影返回 `ProviderConfigLayerUpdate`，providers/models 语义不变；
2. `resolveInitialModelSelection()` 对 configured default、不可用 default 和 Registry fallback 的行为不变；
3. Domain 测试和 exports 不再引用 `schemaVersion`、Document、parse/migrate 或文件 JSON；
4. Config Overlay、完整性校验和 Registry 发布行为不变。

### 7.2 Provider Repository

1. 当前版本 Provider 文件严格解析并得到相同 Layer Snapshot；
2. Layer Update round-trip 后 providers/models 与 revision 正确；
3. 缺版本、未来版本、缺失 migration 和非法字段按既有规则拒绝；
4. 相邻版本 migration 逐级执行且不能跳级；
5. Personal Legacy import 成功后备份原文件并原子写入当前格式；
6. importer 失败、Schema 失败、备份失败时不修改原文件；
7. Official 与 Personal 使用同一正式存储 Schema；
8. watcher 对相同 revision 去重，真实变更正常通知。

### 7.3 Model Selection Repository

1. `undefined` 与完整 `ModelSelection` 正确 round-trip；
2. Selection options 保持严格校验和冻结语义；
3. 不支持版本和非法字段拒绝；
4. 文件缺失、Legacy import、保存和重启恢复行为不变；
5. 调用方不再访问 `.configuredDefault` Document，而直接消费 Repository 返回的 Selection。

### 7.4 机械归零

- `@zcode/provider` 不再导出 `ProviderConfigDocument*`；
- `@zcode/provider` 不再导出 `ModelSelectionConfigDocument*`；
- `packages/provider` 生产代码无 `schemaVersion` 和 Config 文件 migration；
- Service、Bootstrap、UI、Runtime 不传递 `Document`、`Envelope` 或同形存储 DTO；
- JSON/version/migration 测试全部归属 `provider-node`；
- 不新增公共 `Stored*`、`Serialized*`、`ConfigState` 替代类型。

## 8. 实施顺序

### Step A：冻结当前存储行为

- 先在 `provider-node` 补齐 Provider Config 与 Model Selection 文件行为测试；
- 固定现有 JSON、版本错误、migration、备份、revision、watcher 和原子写行为；
- 确认 TODO 03 的 Provider/Model 字段结构和 TODO 05 的 `ModelSelection` 已稳定，避免重复修改存储 Schema。

### Step B：建立 Repository 私有 codec

- 在 `provider-node` 建立私有 Provider Config 和 Model Selection codec；
- 将存储 Schema、版本常量、parse/serialize/migrate 和错误迁入；
- Official Source 与 Personal Repository 复用 Provider Config codec；
- 不从 package barrel 导出 codec 和 Stored 类型。

### Step C：收紧 Repository 与 importer API

- Personal Provider Repository 保持 Snapshot/Update 边界；
- Personal 投影和 Legacy importer 改为返回 Layer Update；
- Model Selection Repository 改为直接返回 Selection；
- Bootstrap、CLI 和 Services 调用方停止读取或构造 Document。

### Step D：删除 Domain Document

- 从 `@zcode/provider` 删除两个 Document class、存储 parser/migration 和对应 exports；
- 把 `resolveInitialModelSelection()` 与相关领域类型留在 Provider Domain；
- 移动并重组测试，删除只证明公共 Document class 存在的测试。

### Step E：验证与提交

- 运行 Provider、Provider Node、Services、Bootstrap 和 CLI 相关单测；
- 运行 Legacy import 与重启恢复代表回归；
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
- 复查 `rg` 机械归零项；
- 独立 Conventional Commit。

## 9. 非目标与不变量

本 Todo 不负责：

- 修改 Built-in -> Account Built-in -> Personal 的 Overlay 顺序；
- 修改 `builtinModelIds` / `modelIds`、冲突或 `enabled` 语义；
- 修改 Model Config Rule 合并、完整性校验或 Active Model；
- 修改鉴权、Access Type、Provider API 装配或最终授权；
- 重构 Settings UI、模型选择器、队列、Session 或远端同步；
- 提前删除仍在产品兼容窗口内的 Legacy importer；
- 借机建立通用 Persistence、Document 或 Serialization Framework。

必须保持：相同持久化输入产生相同领域 Config，相同领域更新产生兼容的正式文件；运行时、Settings 和 Registry
看不到文件 Envelope，也不需要知道配置来自 JSON、其他文件格式还是未来的不同 Repository 实现。

## 10. 完成定义

Provider Domain 的公开词汇只剩配置层、配置规则、选择和解析结果。所有版本化 JSON 外壳、文件 migration 和
持久化生命周期均封装在 Node Repository 内；调用方只传递准确的领域值。正式配置文件和兼容行为保持稳定，
但替换存储实现不再要求修改 Provider Domain、Settings、Registry 或 Runtime。

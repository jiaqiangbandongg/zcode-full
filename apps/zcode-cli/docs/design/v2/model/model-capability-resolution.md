# Model Capability Resolution（历史设计，已退役）

> 本文原先描述 `models.dev`、Model Catalog、配置 override 与按 modelId 默认策略共同推断模型能力的旧实现。
> 该实现已由 Provider Refactor 退役，不能作为当前代码或新功能的实现依据。

当前唯一事实链为：

```text
ZCode Built-in Model Config Rules
              +
Personal Model Config Rules
              |
              v
Effective Model Config
              |
              v
Provider Registry lookup / validate
              |
              v
ModelFactory
              |
              v
Active Model.properties / optionSpecs / options
```

当前实现不得：

- 从 `models.dev`、Model Catalog 或远端模型元数据补齐运行时能力；
- 按具体 modelId 在生产代码中推断 context、reasoning、输入输出格式或请求参数；
- 让 Runtime Config、Turn、Adapter Registry 或 UI capability map 保存第二份模型事实；
- 让旧 `modelCatalog.overrides` 进入当前 Config、Registry 或 Runtime。

已发布旧 CLI Provider/Model JSON 只在一次性 importer 的私有解析边界读取，并立即转换为 Personal Provider
Config 与 Personal Model Config Rules。

当前规范见：

- [`configuration.md`](../../../../../docs/working-memory/provider-refactor/design/registry/configuration.md)
- [`registry.md`](../../../../../docs/working-memory/provider-refactor/design/registry/registry.md)
- [`model-creation.md`](../../../../../docs/working-memory/provider-refactor/design/registry/model-creation.md)
- [`contract.md`](../../../../../docs/working-memory/provider-refactor/design/model/contract.md)

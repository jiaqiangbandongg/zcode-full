# Todo 74：模型能力分层与 PDF／工具调用／JSON Schema 输出契约

> 状态：已完成（流式 JSON Schema 仍由 Todo 80 单独处理）
>
> 日期：2026-09-04
>
> 覆盖：GLM-5.3-Flash PDF、工具调用能力展示、严格 JSON Schema 输出
>
> 说明：Option `default` 退役、Reasoning Spec 完整化和请求预算显式传入已经由 Todo 58、Todo 60 及后续实现完成，本 Todo 不重新讨论这些内容。

## 1. 目标

收口模型能力配置的职责边界，避免把模型自身事实、API 协议映射和供应商／Endpoint 特例混在同一层。最终以当前 Effective Model Config 作为运行时唯一能力来源；不在 Adapter 或 UI 中按模型名称临时猜测能力。

```text
Model ID
  -> Model + API Schema
  -> Provider Site / Base URL
  -> Template + Model
  -> Provider Instance + Model
  -> Personal Provider Instance + Model
  -> Effective Model Config
  -> UI 能力展示与 Runtime 请求
```

## 2. 三项产品要求

### 2.1 GLM-5.3-Flash 仅在 Anthropic Messages 下支持 PDF

- Model baseline 不把 GLM-5.3-Flash 标记为全局支持 PDF。
- 仅增加 `glm-5.3-flash + anthropic-messages` 的 Model + API Rule，令该组合支持 PDF。
- OpenAI Chat 和 OpenAI Responses 在本轮保持不支持 PDF，不添加后续层覆盖。
- PDF 的具体编码属于 API Schema／Adapter 层。
- 本项采用产品内部已确认的能力要求，不再等待泛化的供应商能力讨论。
- 覆盖设置页展示、Model Selection、附件转换及实际请求链路。

### 2.2 工具调用不再作为设置项

- 设置页隐藏“工具调用”编辑项。
- 内置 Provider 与 Provider Template 的能力基线统一为 `supportsToolCall: true`。
- 运行时继续使用该能力字段；不能因为隐藏 UI 而删除能力或让 ZCode 失去工具调用。

### 2.3 Structured Output 改为严格 JSON Schema 语义

- 现有字段实际表达“调用方提供 JSON Schema，并要求响应满足该 Schema”。
- 评估将字段改名为 `supportsJsonSchemaOutput`，清除“普通 JSON／JSON mode／提示词 JSON”歧义。
- 能力必须按 Model、API Schema、Provider/Endpoint 证据确认，不能仅按 Model ID 全局推断。
- 流式 JSON Schema 另由 Todo 80 讨论，本 Todo 不提前扩大流式结果契约。

## 3. Model Config 分层约束

本 Todo 使用 Todo 76 定义的固定顺序和 Rule 类型，不重复定义另一套 Provider/Endpoint 层级：

```text
Model
    -> Model + API Schema
    -> Provider Site / Base URL
    -> Template Model
    -> Provider Model
    -> Personal Provider Instance overlay
```

本 Todo 只负责 PDF、工具调用和严格 JSON Schema 的字段取值、运行时透传及测试；每个字段应按 Todo 76 的维护范围和 Site override 规则落位。

## 4. 当前实现事实与待核验项

- 当前 `ModelConfigRule` 已支持 `modelMatch`、`apiMatch`、`providerMatch` 和 `baseURLMatch`；Builtin JSON 也已有多个规则分组。类型拆分与分组迁移由 Todo 76 负责。
- 当前 Resolver 采用顺序 overlay；本 Todo 不改变其顺序，只消费 Todo 76 产出的统一 Effective Model Config。
- 需要建立最小能力矩阵：GLM PDF、工具调用、严格 JSON Schema 分别在 Model、API Schema、Provider/Endpoint 哪一层声明。
- 流式 JSON Schema 的现状和后续支持边界记录在 Todo 80，不在本 Todo 重复实现。

## 5. 实施顺序

1. 更新本 Todo 关联的 Model Config 设计说明，确认三层字段职责。
2. 更新 GLM-5.3-Flash PDF 能力及相关测试。
3. 隐藏工具调用 UI，保留运行时能力并补回归测试。
4. 将 Structured Output 统一为严格 JSON Schema 语义并完成字段改名；流式透传按 Todo 80 单独处理。
5. 检查 Settings、Model Selection、Adapter、Runtime 和测试是否仍存在旧字段或重复推断。
6. 在 MacBook Air 上完成 UI 与真实请求验证；图形 E2E 另按现有 E2E 流程执行，不把环境阻塞伪装成通过。

## 6. 验收标准

- GLM-5.3-Flash 在设置和选择链路中显示 PDF 输入能力，实际附件请求不会因配置缺失失败。
- 设置页不再提供工具调用开关，但工具调用模型仍能正常执行。
- 严格 JSON Schema 能力名称、配置和 Runtime 校验语义一致；流式行为以 Todo 80 的边界为准。
- Provider、API Schema、Endpoint 三层规则的职责在代码和文档中唯一明确。
- 不新增 Option `default`，不改变已完成的 Reasoning 和请求预算语义。

## 7. 与旧 Todo 的关系

2026-09-09 遗留工作区复审：当前 Model Properties、Wiki 测试 fixture 统一使用 `supportsJsonSchemaOutput`。已发布旧数据的私有 `legacy*` DTO/reader 仍保留原始 `supportsStructuredOutput` 字段，不对历史输入格式机械改名；旧 Provider 导入仍按既定裁决仅保留模型 contextWindow，不将旧 capability 带入新配置。正式 Model Option 协议继续拒绝新旧两种平铺 capability 字段，能力只来自 properties。此处澄清私有旧格式边界，不增加未上线中间态兼容，也不重新打开本 Todo。

- Todo 39 的“严格 JSON Schema 输出能力命名收口”由本 Todo 覆盖；Todo 39 应标记为 `superseded`，不再单独执行。
- Todo 58、Todo 60 保持已完成状态，本 Todo 不重复实现 Option default 或 Reasoning 逻辑。

## 实施记录（2026-09-04）

- 完成 `supportsStructuredOutput` → `supportsJsonSchemaOutput` 的全仓字段切换；Schema 保持严格对象校验，旧字段不做迁移兼容。
- 在设置页移除“工具调用”编辑项，保留运行时能力字段；Builtin 基线继续以 `supportsToolCall: true` 提供 ZCode 必需能力。
- 将 GLM-5.3-Flash 的 PDF 能力放在 `modelApiRules` 的 `glm-5\\.3-flash + anthropic-messages` 规则中；Model baseline 和其他 API Schema 仍不声明 PDF。
- 新增 Builtin 完整性回归，确认 Anthropic 组合支持 PDF、Chat 组合不支持，且配置文件不再含旧字段；受影响 Provider、Adapter、UI 测试通过，`pnpm typecheck` 和 `pnpm lint` 通过（0 error）。
- Todo 80 的流式 JSON Schema 传递仍未改动，继续保持草案边界。

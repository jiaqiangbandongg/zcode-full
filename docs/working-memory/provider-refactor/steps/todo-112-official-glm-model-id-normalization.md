# Todo 112：官方 GLM 真实 Model ID 大小写统一

> 状态：官方 ID 规范化、增量 migration 与回滚边界验证完成。2026-09-10。实施/测试证据、逐条边界复审及真实环境限制见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。

## 1. 目标与边界

用户要求统一官方 GLM 的真实 `modelId`，不是新增显示名称或只美化 UI。目标风格为 `GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`；新选择、保存和实际请求使用统一后的 ID。

- 仅处理 Z.ai／BigModel 官方模板及官方账号模型来源；不改 OpenRouter、OpenCode、MiniMax 等第三方／聚合入口，不按模型名全局改写自定义 Provider。
- 不涉及额度卡、余额提示、套餐宣传文案及其格式化函数。
- 不新增显示名字段，不在 UI、Registry 通用比较或请求 Adapter 中增加全局大小写转换。
- 不改 Provider ID、Access、协议、Base URL、推理档位或模型能力。模型增删由对应 Todo 承接，不借大小写整理恢复已裁决删除的型号。

## 2. 当前事实与必须修改的位置

### 2.1 官方模板：名单与精确规则一起改

`config/provider/zcode-builtin.json` 中，当前 `zai-api`、`bigmodel-api` 各有 21 个小写 GLM 成员，对应合计 42 条 GLM `templateModelRules`。

- 修改两个模板的 `builtinModelIds`，同时修改对应 `templateModelRules[].modelId`；后者严格匹配，不能只改名单。
- 例如 `glm-5.3` → `GLM-5.3`，`glm-5.3-flash` → `GLM-5.3-Flash`，`glm-5-turbo` → `GLM-5-Turbo`。
- 实施前列出所有在范围内型号的目标拼写，覆盖其余 GLM 型号及 FlashX、Air、视觉和日期后缀；不能用整体 `toUpperCase()` 猜测规范拼写，不能修改版本号、分隔结构或删掉后缀。
- 当前名单及规则只是调查基线。与 [Todo111](./todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md) 的四模板拆分协调：按最终模板身份更新官方普通 API／Coding Plan API 的名单与精确规则，不重新引入旧模板或重复执行改名。

### 2.2 Start：在官方模型名单入口统一

`packages/services/src/model-provider/zaiStartPlanBilling.ts` 的 `resolveZaiStartPlanBalanceModelIds()` 从余额 `capabilities` 提取 `model:<id>`，没有时使用 `show_name`；目前仅大小写无关去重，输出保留原始拼写。

`codingPlanProviderAvailability.ts` 将结果交给账号解析，`packages/provider/src/account-provider-resolution.ts` 再用其替换 Start 的静态 `builtinModelIds`。所以只改 Built-in JSON 无效，刷新后仍可能出现小写。

```text
官方 Start 余额响应（保持原数据）
    -> 提取能力中的 model ID
    -> 已知官方 GLM ID 规范化、去重
    -> Account Provider 模型名单
    -> Registry / 模型选择
    -> 保存与实际请求使用规范化后的真实 ID
```

- 在该官方名单边界处理已知 GLM 的目标拼写，未知型号保留原样；不改写余额响应，不让规范化扩散到其他 Provider 或额度展示。
- 保持原有权益、空名单、pending 和去重语义；不能因映射增加服务端没有授予的模型。
- 个人／团队和闲时账号当前静态名单已使用上述大写风格，检查一致性即可；不改已绑定的闲时 Ticket、已固定执行或其模型身份。

### 2.3 公共消费链不改

- `packages/provider/src/config/model-config.ts` 的推荐规则 `modelMatch` 已忽略大小写，无需重写通用规则；模板／Provider 的精确规则仍严格匹配。
- `effective-model-selection.ts`、模型校验及 Registry 继续按精确身份比较，不能为本次官方名单整理放宽所有供应商。
- 设置列表和聊天／自动化／Subagent／Wiki 共用 Registry／Selection View 结果，不逐个增加显示转换；各自草稿、保存时机和持久化归属不变。
- Adapter 当前将绑定的 `modelId` 原样传给 SDK，保持这一行为；不设置“显示大写、请求偷偷改回小写”的旁路。

## 3. 已裁决的兼容边界

### 3.1 已有小写选择和个人覆盖

旧的小写 Selection、个人模型精确覆盖、个人成员／排序不会因 Built-in 改名自动更新。新名单严格匹配时，这些旧引用可能失效或不再生效。

- Todo111 的“不迁移”裁决限定于尚未使用的两个模板，不自动扩大为全部 Start 历史选择和用户个人配置。
- 用户补充裁决：在已有选择迁移入口，对明确属于官方 GLM 的旧模型 ID 按本轮已确定的改名表做大小写归一，提高迁移鲁棒性；不扩大到第三方、自定义 Provider 或公共运行时匹配，也不为此新建一套迁移系统。
- 本轮不额外扩展个人模型精确覆盖／成员／排序的迁移，不与旧 Selection 迁移混为一谈，不再列为待确认项。
- 无论如何，历史消息中的实际执行模型、使用统计记录不按新命名重写；已有运行中的执行也不收回或换模型。

### 3.2 官方端点接受情况

改真实 ID 会改变实际请求中的 `model`。用户已明确确认本轮官方端点接受目标大小写，以此作为实施前提，不再要求重复裁决或以联网证明兼容作为开工／收尾门禁。

- 实施仍需验证名单、精确规则、迁移结果及最终请求 ID 一致，不悄悄改成显示名方案或运行时转小写。
- 此项证据为用户确认，不写成已由本轮实机请求验证；若实施出现相反的真实证据，再记录具体问题，不预先扩大第三方兼容范围。

## 4. 实施、测试与完成标准

落地补充：Todo109 已将数据库转换冻结到带 checksum 的迁移中，不能修改历史脚本。
在既有库级机制追加 Agent `0021` / App `0003`，仅修改 `session_entry` 当前
`runtime/model_selection.modelSelection.modelId` 和 `automations.model_selection.modelId`。
只接受明确官方账号 ID；不碰 Personal ID、历史 message/part、automation_runs、
session_input、闲时 Ticket、旧字段或时间戳。迁移 SQL 冻结常量，不依赖实时推荐目录。
非数据库的旧 Subagent / Bot / Wiki 导入继续在各自已有迁移入口做同样的已知 ID 规范化。

实施精确拼写表（仅大小写，不改版本、分隔符及数字）：`GLM-5.3`、`GLM-5.3-Flash`、
`GLM-5V-Turbo`、`GLM-5.2`、`GLM-5.1`、`GLM-5.1-Highspeed`、`GLM-5`、`GLM-5-Turbo`、
`GLM-4.7`、`GLM-4.7-FlashX`、`GLM-4.7-Flash`、`GLM-4.6`、`GLM-4.5-Air`、`GLM-4.5`、
`GLM-4.6V`、`GLM-4.6V-Flash`、`GLM-4.6V-FlashX`、`GLM-4.1V-Thinking-FlashX`、
`GLM-4.1V-Thinking-Flash`、`GLM-4-FlashX-250414`、`GLM-4-Flash-250414`、`GLM-4V-Flash`。
普通模板 `zai-standard-api` / `bigmodel-standard-api` 使用原宽目录；套餐模板 `zai-api` /
`bigmodel-api` 仅保留 Todo111 确认的两款。非 GLM 成员保持原样；未知 GLM 不猜拼写。

- [x] 先更新相关 spec，列出在范围内所有 GLM 的精确改名表和最终模板归属。
- [x] 先补有区分力的测试，再实现名单／精确规则及 Start 名单入口改动；覆盖大小写变体、重复条目、未知型号、空名单与能力集合不扩大。
- [x] 官方模板成员与精确规则对应，原有启停、能力、推理配置保持不变；第三方同名 GLM、自定义模型和非 GLM 不变。
- [x] 核对公共选择仍精确匹配，个人覆盖和旧选择按最终裁决处理；不改历史消息／使用统计，不引入新的 Selection 执行旁路。
- [x] 定向交互 E2E 检查官方设置／选模显示的即是真实 ID，实际绑定和 wire 使用相同 ID；本地和远程复用原交付链，不改桌面 continuous／手机 replayable 边界。
- [x] 整批执行相关单测、类型检查、lint 和请求 ID 断言，不为每个型号重复全量回归；官方端点大小写接受性沿用用户确认，不另设联网验收门禁。
- [x] Review 全部改名去向、官方范围限制和 Todo111 交集，提交代码与证据，不自动推送。

所有获准范围实现、复审并验证后才能声明完成；当前无待裁决项，不因收口讨论而扩大迁移范围。

## 5. 调查记录

本次使用 feature-boundary-planner 的 impact-only 模式，通过配置枚举及精确引用静态检查得出上述影响范围；当前无可用 codegraph 工具，未执行测试。建议后续功能图补充“官方 Start 模型名单规范化”到 Registry 的来源关系；本轮未修改图谱。调查不是接口大小写兼容的实机证明。

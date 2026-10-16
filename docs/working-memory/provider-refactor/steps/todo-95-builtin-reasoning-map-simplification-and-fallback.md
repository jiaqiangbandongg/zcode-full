# Todo 95：专用 Reasoning Map 等价美化与兜底增强

> 2026-09-12 后续裁决：[Todo138](./todo-138-reasoning-level-ui-and-api-defaults.md) 将 Model 通用档位改为 disabled/enabled，三种 API 通用 map 增加 enabled → high；取代本文原先“不新增 enabled → high”的限制。专用 map、个人覆盖及规则层级仍按原语义。本文其余内容保留为当时实施记录。


> 状态：A/B/C 已完成并关闭，2026-09-09 更新。关闭档位统一及旧 Selection 最佳努力映射已实现；未上线 Personal 配置不做兼容。排版回归也已由 Todo98 修复。所有残余欠测及人工晋级只在 [Todo102](todo-102-verification-debt-closeout.md) 跟进。历史证据见 [执行记录](../research/todo94-97-execution-and-review.md)。
> 总原则：**美化已有模型的专有 Reasoning Map，强化兜底 Reasoning Map。已有专用规则仅做等价美化，不借机更改模型行为。** 关闭档位名称整理及历史选择兼容是单列的变更，不混入“美化”。

## 1. 三条工作线与边界

| 工作线 | 允许改变 | 必须保持 |
| --- | --- | --- |
| A：专用 Map 美化 | 表达式结构、重复分支、条件位置 | 每个合法输入对应的最终请求字段、值、缺省/删除语义、模式和预算 |
| B：兜底 Map 增强 | 按 API Schema 提供可用的通用推理字段映射 | 专用规则覆盖能力、Personal 覆盖、模型选择校验与输出上限权威 |
| C：关闭档位整理 | 非 API 原生的关闭名称尽量统一为 `disabled`，兼容受影响的旧选择 | 旧选择的关闭语义、用户自定义档位/Map、各业务保存边界 |

- 不调整专用规则的模型匹配范围、前后缀规则、站点范围、优先级或其他模型能力。不得把专用 Map 全部替换成通用混合 Map。
- 不改模型 ID、不新增 Provider 特判执行路径，不扩展表达式语言来追求更短代码。
- 不修改正在运行的 Active Model、历史记录、Off-Peak Ticket 或账号连接迁移。
- Wiki 输出预算统一属于 [Todo 94](todo-94-wiki-model-output-limit.md)，不是本项实施内容。

## 2. 当前事实与表达式原则

主要配置位于 `config/provider/zcode-builtin.json`。当前通用模型规则只声明 `disabled`，Reasoning Map 为 `{}`；API Schema 兜底规则已有输出上限映射，但缺少本次讨论的推理映射。专用规则中存在逐档位返回同名字符串、重复构造相同对象的分支。

1. `values` 声明合法档位，统一校验层拒绝非法档位；Map 只负责把合法输入转换成请求字段。
2. 相同名称直接透传，不写 `low → low / high → high / max → max` 的枚举三目。
3. 条件尽量下沉到实际变化的字段；只有字段存在性或对象结构确实不同，才保留外层分支。
4. 不以最后一个 `else` 将未知输入偷偷变成最高档、关闭或其他默认档。
5. 不为了短小将省略字段改为 `null`：这里使用 JSON Merge Patch，`null` 表示删除，不能视为省略。
6. 不机械消除所有三目；语义清楚、请求等价优先于字符数。

例如，原有合法档位本来就直接对应 API 的 effort，可以化简为：

```text
{"reasoning":{"effort":reasoningLevel}}
```

但原值为 `off/enabled` 时，不能直接把 `reasoningLevel` 透传给只接受 `disabled/enabled` 的 `thinking.type`。名称变更须先按工作线 C 处理；美化不能掩盖这个差异。

## 3. 兜底增强：配置分层与目标

用户添加未知型号、只补充它支持的推理档位时，尽量能直接使用 API Schema 层的兜底 Map，不要求普通用户先编写表达式。

```text
通用模型默认配置
      |
      v
API Schema 兜底 Map
      |
      v
现有更具体的模型 / 站点 / 模板等规则（沿用现有合并顺序）
      |
      v
Personal 配置覆盖
      |
      v
生效 values 校验 -> Option Map -> 最终请求
```

- 基于 [Todo 76](todo-76-builtin-provider-config-layering-and-site-rules.md) 的现有分层实现，不另建运行时映射系统。
- 通用 `values` 保持保守，不因为增强 Map 就宣称所有未知模型支持 `low/high/max`。用户或更具体配置负责声明支持的档位。
- 专用 Map 仍覆盖兜底；Personal 显式 Map、关闭“智能配置”的完整配置不被自动重写。
- 不承诺任意自造档位都能被 API 理解；透传只是请求组织方式，不是能力探测。
- 以下代码是计划中的受限 CEL 表达式，实施时须通过现有编译器和最终请求测试。

### 3.1 Chat Completions：最大兼容的混合兜底

按用户接受的兼容性假设，同时携带各协议常见且语义一致的控制字段：

```text
{
  "thinking": {
    "type": reasoningLevel == "disabled" || reasoningLevel == "none"
      ? "disabled" : "enabled"
  },
  "enable_thinking": reasoningLevel != "disabled" && reasoningLevel != "none",
  "reasoning_effort": reasoningLevel == "disabled" ? "none" : reasoningLevel,
  "reasoning": {
    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel
  }
}
```

- `thinking.type` 覆盖智谱等思考开关形式；`reasoning_effort` 覆盖 OpenAI 接口的参数形式；`enable_thinking` 覆盖 Qwen/SiliconFlow 接口的参数形式；`reasoning.effort` 覆盖 OpenRouter 接口的参数形式。
- `disabled` 与原生 `none` 均表达关闭，不能出现开关关闭、另一开关开启的矛盾；其他合法具体 effort 直接透传。
- 不加入预算、`reasoning.exclude`、`reasoning_split`、`chat_template_kwargs` 等语义不同或站点私有字段。
- 不新增 `enabled → high/max` 的隐式映射；仅开关型模型继续由专用规则处理，通用兜底不宣称任意档位受支持。

**接受的假设及其精确边界：**

1. 服务端忽略不认识的额外字段。
2. 服务端接受多个语义一致的重复控制字段，不因组合本身拒绝请求。
3. 对以 `thinking.type` 控制关闭的服务，在 **`type=disabled` 的前提下**，多传的 effort 不再适用，可被忽略，或该接口允许 `none`。这不是假设开启思考时也接受 `none`。
4. 对以 effort 控制的服务，`none` 表示关闭，额外的 thinking 开关可被忽略。

这是一份“基于假设、尽量兼容”的兜底，不是对所有兼容站点的无损保证。严格服务端即使收到关闭开关，也可能先校验并拒绝已知字段的非法值；未知字段也可能被严格拒绝。已知差异由专用规则处理；未知情况正常报错，不自动删字段重试、换档位或改模型。

### 3.2 Anthropic Messages：关闭或 Adaptive

```text
reasoningLevel == "disabled"
  ? {"thinking":{"type":"disabled"}}
  : {
      "thinking":{"type":"adaptive"},
      "output_config":{"effort":reasoningLevel}
    }
```

- 本次兜底不适配手动 `enabled` + `budget_tokens` 模式；具体 effort 直接交给 Adaptive。
- 讨论过的 `enabled` 分支、12,800 预算和顺带 override 最大输出的方案已撤回，**不实施**。
- 这一撤回仅限兜底：已有专用模型的 `enabled`、预算模式保持原行为。
- 不能仅凭 Anthropic API Schema 保证目标模型支持 Adaptive/effort；不支持者使用专用配置，不自动切模式。

### 3.3 Responses：保持自身字段结构

```text
{"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel}}
```

只使用 Responses 的 effort 结构；原生 `none` 等合法值保留，不把 Chat Completions 的四组字段复制过来。

### 3.4 输出上限与默认关闭的影响

- Reasoning Map 不写 `max_tokens`、`max_output_tokens` 等最大输出字段；现有 maxOutputTokens Option Map 继续独立负责。不得绕过多 Map 写入冲突校验。
- 通用模型仍只有 `disabled` 时，新兜底也会发出上述显式关闭字段，区别于原 `{}`。这是本项增强的真实行为变化，必须纳入兼容测试和风险记录。
- 不偷偷新增“根据 values 是否增加而自动换 Map”的第二套动态规则来掩盖上述变化；若实测需要改变关闭策略，记录证据再裁决。

## 4. 关闭档位名称与历史选择兼容

目标是整理项目自己发明的 `off/nothink` 等关闭名字，而不是统一改写所有厂商值。API 原生透传的 `none` 可以保留；当前并非所有用户口头提到的 `disable` 拼写都实际存在，实施时以配置清单为准。

```text
持久化原 Selection / 当前用户草稿
                 |
                 v
目标 Host 生效配置与统一选择解析
                 |
       原档位仍合法？ -- 是 --> 原样保留
                 |
                 否
                 v
命中受影响规则的明确改名表，且目标档位受支持？
       | 是                          | 否
       v                             v
临时 effective 档位              现有失效处理，不猜最高档
       |
       v
业务原有成功提交 / 显式保存边界（不是读取时写回）
```

- 改名表必须绑定受影响的 Built-in 规则/来源，不能全局把任意 `off/none/disable` 都替换成 `disabled`；不凭模型名片段猜测。
- 原值优先：用户显式保留且仍合法的 `off`、原生 `none` 不迁；未知值不猜。
- 每项改名验证“旧输入 + 旧 Map”与“新输入 + 新 Map”产生相同请求，而非要求输入字面相同。
- 复用 [Todo 87](todo-87-selection-view-unified-resolution.md) 的有效选择解析和变更通知。读取返回临时结果，不覆盖持久意图；任务长期设置仍按原显式保存边界更新，本次 run 可以冻结已解析结果。
- 不新增存储版本、不批量重写历史、不修改用户 Subagent Markdown，不解析并重写用户 Map 表达式。
- **最新兼容边界：** 不兼容未上线的 Personal 配置，不自动改写旧个人 Map、不为这类中间格式新增迁移。当前正式的显式 values/Map 仍按覆盖规则生效；旧 Selection 的改名只在原值不合法、明确命中受影响来源且目标支持时执行，保留原意图与既定保存边界。
- 显式 Subagent 已由 Todo99 接入 Worker 本地公共解析；C 应复用该入口验证纯档位映射，不再将缺少 Host RPC 作为阻塞。未指定模型及内部 override 保持冻结，不借改名扩展协议或更改继承语义。
- Off-Peak 的原 Provider 和 Ticket 保持不变，纯档位兼容不得重新授权跨账号切换。

## 5. 影响面与唯一权威

### C 执行记录：来源限定的关闭档位迁移

- 本轮改名清单为 25 条 `modelRules`：24 条 `off`、1 条 `nothink`；`none`、`enabled` 不改。清单保存旧规则选择器及旧关闭值，不保存第二份完整模型配置。
- Node 统一 Facade 从同一已应用快照构造旧值域投影：只对清单中完全相同的 Built-in 规则恢复旧关闭值，规则匹配和覆盖顺序仍复用 `ModelConfigRules.resolve`。因此不是模型名片段猜测，也不会让被后续规则覆盖掉的旧值域重新生效。
- 仅原档位不合法时尝试别名，再用现有校验检查新档位。显式 Personal 推理 values/Map 或固定配置不参与推断；仍合法的原值直接保留。此限制不是未上线配置兼容，而是避免把用户自定义值误认成内置旧值。
- Host 与 Worker 共用 Node Facade；配置默认选择也做同一纯档位归一化。最终 Registry/Factory 保持精确校验，不新增别名。
- 验收分层：真实 25 条规则清单与原请求等价、公共 Facade 来源/覆盖/只读测试、实际 Composer/任务入口回归。运行中请求、隐式继承及 Ticket 不增加重解析；102 的历史验证债不在本次范围。
- 全规则/API 复审补充：专用 Map 的改名前后请求等价；继承通用兜底的组合则纠正 A/B 与 C 分步实施留下的临时错配。例如 GLM Chat 的 `off` 曾被新兜底当作开启 effort 透传，统一后正确进入关闭分支；Responses 的旧 `off/nothink` 透传改为 `none`。这是已裁决兜底关闭语义的收口，不把这些错误中间请求保留下来，也不宣称全部兜底请求字节等价。开启档位和专用预算仍保持原值。

本项为配置/请求语义与有限选择兼容，不是 UI 重新设计。边界梳理使用现有功能图的 model-capabilities、model-selection 节点；当前环境无可用 codegraph，已以配置和已知种子文件定向阅读替代，未声称完成全调用图审计。

| 优先级 / 入口 | 公共边界及应查内容 | 提交 / 保存边界 |
| --- | --- | --- |
| 必查：Built-in / Resolver | `zcode-builtin.json`、`packages/provider/src/resolver.ts`；规则层级、来源与专用覆盖 | Personal 配置不因加载改写 |
| 必查：编译与请求 | `packages/model-option-map/src/`、Agent `model-option-map-fetch.ts`；编译、Merge Patch、与输出 Map 的冲突 | 最终 Model 构建校验与请求仍为权威 |
| 必查：共享选择解析 | `packages/provider/src/effective-model-selection.ts`、Registry 校验 | 临时 effective 与持久意图区分 |
| 必查：添加/编辑模型 | 共用模型草稿、`useModelSelectionView`；只加档位可继承兜底，显式 Map/固定配置保持 | 用户保存时写 Personal；不改变智能配置开关语义 |
| 必查：Composer / 会话 | 共享 View 与草稿；旧档位解析、新选择合法性 | 原发送成功/显式选择保存边界，不修改运行中 Model |
| 应查：定时任务 / Bot / Wiki | 复用解析的入口、显示与执行是否一致 | 各自显式保存与执行冻结边界，不批量刷记录 |
| 条件必查：Subagent / Off-Peak | 是否绕过 Host 解析、原身份与执行锁定 | 按第 4 节限制，不改 Markdown/Ticket |
| 不变性：桌面/Web、Local/Remote | 使用目标 Host 配置，无本地替代或发送前强制同步 | workspaceIdentity 隔离；continuous/replayable 不改变 |

## 6. 执行顺序与验收

1. 先补齐规则清单：规则位置、API Schema、站点/型号范围、生效 values、旧 Map、拟改 Map、所属 A/B/C 工作线。记录改名与 Personal 覆盖的风险，不用测试条数替代覆盖证明。
2. 按本 Todo 更新现有 Model Option Map / Built-in 配置 / Selection 规范中确实改变的契约，再先写测试、后改实现。已有规范不能被“兜底增强”误写成专用行为改变。
3. 专用 Map：逐条覆盖所有合法档位；对于等价规则可参数化复用用例，但不能漏掉站点规则。比较最终合并请求 JSON，包括缺失、null、空对象、预算和最大输出字段。
4. 兜底：验证 Chat 的关闭/原生 none/具体 efforts、Messages 的关闭/Adaptive、Responses 的关闭/effort；测试仅增加 values 的未知型号、已知专用型号覆盖、Personal Map 和智能配置关闭。非法值仍在统一校验层失败。
5. 兼容：验证原值合法优先、受影响旧值映射、未知值不猜、Personal 覆盖组合、只读不落盘、已有 run 不变；覆盖实际消费方，而不是只测试一个纯函数。
6. 交互 E2E：在 MacBook Pro 用隔离 fixture/mock 验证添加模型仅修改档位后的请求、旧选择展示/提交、个人配置不被覆盖；根据实际改动覆盖定时任务等入口。截取最终请求，不用表达式快照替代。不得依赖真实账号领取或实际消耗额度。
7. 运行 `pnpm typecheck`、`pnpm lint`、相关单测及 E2E。实现涉及 Agent/UI 前读取对应 AGENTS/DESIGN 和测试技能；记录环境失败与产品失败，不把未运行写成通过。
8. 最后复审差异：专用合法请求等价；只有兜底及显式改名属于语义变更；无预算 override、静默重试、额外同步或持久化副作用。按工作线记录验证证据后提交。

## 7. 执行记录表

| 项目 | 状态 | 证据 / 后续必须补齐 |
| --- | --- | --- |
| 讨论结论与三条工作线 | 已实施 | 本 Todo |
| 全部专用规则清单及等价基线 | A 完成 | `reasoning-map-before-todo95.json` 19 种表达式、逐条规则索引/范围；每个合法档位比较最终 Merge Patch 请求，包含已存在字段/预算 |
| 三种 API 兜底映射 | B 完成 | 未知模型仅改 values、Personal Map 覆盖、非法档位拒绝；Pro 真实 Model 请求验证 Chat high |
| 关闭档位改名与 Personal 组合 | C 完成 | 25 条规则改名；原值合法优先、具体规则覆盖、未知值拒绝与只读原意图由真实 Built-in Facade 测试验证；不兼容未上线配置 |
| 各消费方兼容（含 Subagent 边界） | C 完成 | Host/Worker 共用 Node Facade；Composer/任务实跑、Wiki/Bot/UI 33 条回归、显式 Subagent 9 条回归；冻结的执行、继承和 Ticket 不增加重解析 |
| 类型/Lint/单测/Pro E2E | A/B/C 已验证 | C：Provider / provider-node / Option Map 352 条通过；全仓 typecheck、lint 通过。Pro `desktop-e2e-20260909-121842-573`：R95C-01、SR87-01、SR87-06 共 3/3 通过；pending 不自动晋级 |
| 二次审阅与收口 | A/B/C 完成 | C 仅改 revision、25 处 values、10 处 Map 关闭字面值及公共解析；专用请求等价，兜底的临时旧名称错配按关闭语义纠正。未加预算 override、发送前同步、请求层别名或静默替换 |

### C 实跑与测试前置纠正

- R95C-01 验证历史 `nothink` 草稿重载后显示 `disabled`，正文编辑仍保留历史值，发送后才保存新值；捕获实际模型请求 `thinking.type=disabled`，不附错误 effort。
- 首次运行失败定位为测试前置竞态：直接改 localStorage 后，旧页面 `beforeunload` 将内存草稿重新刷盘，覆盖注入的历史选择。临时日志证明新页面第一次读取时已是 `disabled`，不是新解析写坏持久状态。
- 用例在 `pagehide`（退出保存之后）注入旧记录再重载；移除临时诊断，没有修改生产 Composer 保存机制。修正后整组通过。手机＋SSH 实机与其他历史欠测仍归 Todo102，不借本项冒充全端通过。

## 8. 讨论依据与关联

- 架构基线：[Model Option Map](../design/model/model-option-map.md)、[Selection State](../design/interaction/selection-state.md)、Todo 76 / 87；智能配置交互沿用 [Todo 92](todo-92-model-smart-config-and-override-feedback.md)。
- 协议资料：[智谱思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)、[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Qwen OpenAI 兼容接口](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)、[OpenRouter Reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[Anthropic Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Anthropic Effort](https://platform.claude.com/docs/en/build-with-claude/effort)。
- 这些资料用于说明各字段来源，不证明混合字段被所有服务端接受；实际兼容假设和限制以第 3 节为准。实施时如发现协议差异，不能借最新资料悄悄改变已有专用模型行为。

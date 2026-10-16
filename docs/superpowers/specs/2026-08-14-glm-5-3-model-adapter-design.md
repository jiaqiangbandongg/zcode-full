# GLM-5.3 模型适配设计

## 背景

GLM-5.3 已由 App 动态 provider 配置下发。供应商既可能直接使用官方模型 ID，也可能
在前后拼接 ToB 路由标识，因此以下 ID 都代表同一能力身份：

- `glm-5.3`；
- `toB-glm-5.3`；
- `proxy/GLM-5.3-cc`。

识别规则为大小写不敏感地包含 `glm-5.3`，但该 token 后不能紧跟十进制数字，避免把
`glm-5.30`、`glm-5.31` 等未来模型误识别为 GLM-5.3。模型 ID 只用于能力识别，最终
provider 请求仍保留配置中的原始 ID。

当前 catalog 默认配置事实为：

- 模型 ID：`glm-5.3`；
- 上下文窗口：1,000,000 tokens；
- 最大输出：128,000 tokens；
- 输入/输出模态：text -> text；
- reasoning 档位：`low` / `high` / `max`，默认 `max`。

这些 context、output 和模态值是 catalog 对精确模型的默认 metadata，不是对 App 动态
provider 的强制覆盖。App 创建和读取模型时会先把缺失或非法 context 归一化为 200K，并尝试
从已知 metadata 解析 max output；用户随后修改的 context、max output 和输入模态继续作为
显式配置沿用。读取期 catalog enrichment 不参与 context 覆盖；max output 采用 fill-only，
已有合法值一律保留，字段缺失时才补 catalog 值；catalog 也没有对应 output 时保持既有 32K
runtime fallback。

CLI 默认策略和 workspace 动态投影需要让上述模型身份拥有最高能力判定优先级，并在读取
可能缺失或过时的入站 reasoning metadata 之前，按真实 transport 重建三个官方档位。
否则同时包含 DeepSeek、Claude、GPT 等其他 token 的路由别名可能被宽泛策略覆盖。

App catalog metadata enrichment 保持更窄的持久化边界：只对大小写不敏感的精确
`glm-5.3` ID 补齐缺失的 canonical metadata。带路径、前缀或后缀的真实路由 ID 不在 App store
中关联 canonical metadata，统一交给 CLI 默认策略和 workspace dynamic overlay 识别。

GLM-5.3 的 image 能力采用 GLM-5.2 已有的 provider-aware 判定，而不是由模型身份写死：

- provider registry 或 catalog 明确下发的 `supportsImages=true/false` 优先；
- 未知能力经 OpenAI Chat transport 时按 text-only 处理；
- 未知的 `glm-5.2-*` / `glm-5.3-*` 真实后缀变体保留 unknown，由显式配置或 provider
  决定；归一化后最终模型段精确为 `glm-5.2-highspeed` 或 `glm-5.3-highspeed` 时例外，
  大小写不敏感地按 text-only 处理；OpenAI Chat 仍统一按 text-only 处理；
- 未知能力经官方 GLM provider/host 的 Anthropic transport 时保留 unknown，允许既有
  provider-side media 链路处理；
- 其他未知的第三方 GLM provider fail closed 为不支持 image。

[智谱官方通用参数文档](https://docs.bigmodel.cn/cn/guide/start/concept-param)确认 GLM-5.2
及以上模型使用 `reasoning_effort` 表达推理深度。

## 目标

- 在中国模型目录的 Z.AI、BigModel 及各自 Coding Plan provider 中注册 `glm-5.3`。
- 在 bundled models.dev catalog 的对应四个 OpenAI-compatible provider 中注册
  `glm-5.3`。
- CLI 默认策略与 workspace dynamic overlay 使用同一 GLM-5.3 身份判断：大小写不敏感
  地包含 `glm-5.3`，且 token 后不能紧跟数字；GLM-5.3 在所有宽泛模型策略之前判定，
  或在顺序合并的策略列表中作为最终覆盖项。
- App catalog 只对大小写不敏感的精确 `glm-5.3` ID 补齐缺失 metadata；带路径、前缀或后缀
  的 ID 不做 canonical enrichment。精确模型已有的 200K 或其他合法 context 也视为显式配置，
  不升级为 catalog 的 1M。
- catalog 和无显式 override 的 CLI 默认能力为 1M context、128K output 与 text -> text；
  App 动态 provider 保留入站或用户配置的 context、max output 和输入模态，仅统一重建
  `low` / `high` / `max` 三档，默认 `max`。
- GLM-5.3 缺失 image metadata 时复用 GLM-5.2 的 provider-aware 判定，不把所有
  GLM-5.3 路由别名一律视为 text-only 或 vision-capable。
- OpenAI-compatible 请求把所选档位投影为
  `openaiCompatible.reasoningEffort`，最终 wire 字段为 `reasoning_effort`。
- Anthropic 动态 provider 把三档投影为 `anthropic.effort` 与固定 thinking budget。
- 不改写原始模型 ID，保证 ToB provider 仍收到其真实路由名。

## 非目标

- 不给 GLM-5.3 增加 `off`、`none`、`nothink`、`medium` 或 `xhigh` 档位。
- 不改变 GLM-5.2 的 `max` / `high` / `nothink` 语义。
- 不改变其他 GLM 模型的 `enabled` / `disabled` thinking toggle。
- 不用 GLM-5.3 模型身份覆盖用户显式配置的 context、max output 或 image 能力。
- 不改变 builtin provider 的远端 entitlement、默认模型或可见性决策。
- 不修改 UI、模型选择提交语义、session/task 状态或 desktop continuous / web
  remote replayable 边界。

## 能力与请求链路

```text
中国模型目录                      bundled models.dev snapshot
  Anthropic providers               OpenAI-compatible providers
  glm-5.3                            glm-5.3
  context=1,000,000                  context=1,000,000
  output=128,000                     output=128,000
  low/high/max                       reasoning=true
          │                                  │
          └──────────────┬───────────────────┘
                         ▼
                 CLI model catalog
                         │
          shared GLM-5.3 identity matcher
              contains glm-5.3, next != digit
                         │
                 default policy 收敛
                 levels=[low, high, max]
                 default=max
                         │
          session.settings.thoughtLevel
                         │
                         ▼
 OpenAI-compatible: reasoningEffort=level
                         │
                         ▼
 provider wire: reasoning_effort="low|high|max"

App 动态 provider（含 ToB 别名）
          ├─ context / output / media：保留显式配置
          │                         │
          │                         └─ image 未知时复用 GLM-5.2
          │                            provider-aware fallback
          │
          └─ shared identity matcher
             在入站 reasoning 前重建官方三档
                          │
                          ▼
             anthropic.effort + thinking budget
                          │
                          ▼
             provider wire: output_config.effort + thinking
```

模型能力仍是思考档位的事实源。既有 UI 根据能力列表渲染并切换档位，不增加
`glm-5.3` 模型 ID 分支。

## 实现

1. 在 `reasoning-policy.ts` 新增 GLM-5.3 的三档常量与 OpenAI-compatible factory。
2. 在 shared 增加统一模型身份判断，并由 `default-policy.ts` 使用；该策略放在所有宽泛
   模型策略之后，作为顺序合并的最终覆盖项。互斥分支则在 Kimi、DeepSeek、Claude、GPT
   等模型判断之前先判断 GLM-5.3。
3. 更新 `models_catalog_china_llm_zcode_2026-06-03.json`，为四个 Anthropic
   provider 增加 GLM-5.3，档位与当前动态 Anthropic 请求事实一致。
4. 更新 `apps/zcode-cli/api.json` 中四个对应 provider，并重新生成
   `models-dev-snapshot.ts`。
5. App catalog 仅在模型 ID 大小写不敏感地精确等于 `glm-5.3` 时使用 canonical catalog
   metadata；带路径、前缀或后缀的路由 ID 不做关联。
6. workspace dynamic overlay 在通用 GLM 分支之前识别 GLM-5.3，按 OpenAI-compatible
   或 Anthropic transport 重建官方三档和 provider options；不覆盖入站 context、max
   output 或媒体能力。
7. GLM-5.3 默认 reasoning 策略不声明 `supportsImages`；runtime 媒体能力缺失时与
   GLM-5.2 共用 provider-aware fallback，并把 `glm-5.3-*` 后缀变体纳入相同 unknown
   语义；精确 Highspeed 变体除外，该已知 text-only 变体 fail closed。

## 测试

- shared/default policy：官方 ID、大小写、provider path、任意前缀与非数字后缀均命中
  1M/128K/三档；即使同时包含 DeepSeek、Claude、GPT 或 Opus token 也以
  GLM-5.3 为准；`glm-5.30`、`glm-5.31` 与 GLM-5.2 不误命中。
- reasoning factory：三个档位都只生成对应的
  `openaiCompatible.reasoningEffort`，默认 `max`。
- models.dev snapshot：四个 provider 都包含 GLM-5.3 的基础能力。
- 中国模型目录：四个 provider 都包含 GLM-5.3、三档 reasoning 与 Anthropic patch。
- wire：OpenAI-compatible 的 `low` / `high` / `max` 都生成顶层
  `reasoning_effort`。
- App catalog：`glm-5.3` / `GLM-5.3` 能补齐缺失 output 等 metadata 并扩展 canonical
  reasoning；缺失 context 使用 App 的 200K 默认值，已有其他合法 context 保持不变；带路径、
  前缀或后缀的 ID 不做 canonical enrichment，非目录自定义 reasoning 保持不变。
- dynamic overlay：无 reasoning metadata 或带通用 toggle 的 GLM-5.3 别名仍被重建为
  `low` / `high` / `max`，并按真实 transport 生成参数；显式 context、max output 和
  media 配置保持不变。
- runtime media：GLM-5.3 与 GLM-5.2 一样保留显式 `supportsImages`；缺失时覆盖
  OpenAI Chat、官方 Anthropic、第三方 provider 和后缀变体的 provider-aware 分支；
  精确 Highspeed 为 text-only，更长后缀仍保持 unknown。

## 影响简报

### Feature Summary

| Field            | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Developer intent | 按 Kimi K3 的分层方式补齐 GLM-5.3，并与 GLM-5.2 共用媒体能力判定            |
| Capability       | Model capabilities / provider catalog                                       |
| Change layer     | option-source、validation                                                   |
| Operating mode   | implementation-handoff                                                      |
| Primary seeds    | matcher、catalog、dynamic overlay、reasoning policy、runtime media resolver |
| Out of scope     | UI、session/replay、builtin entitlement                                     |

### Shared And Divergent Behavior

| Concern              | Shared across surfaces                   | Deliberately different                            | Why it matters               |
| -------------------- | ---------------------------------------- | ------------------------------------------------- | ---------------------------- |
| Option source        | 各模型选择入口消费同一 provider registry | 各入口保持既有过滤与默认值                        | catalog 补齐后无需 UI 硬编码 |
| Reasoning capability | low/high/max、默认 max                   | OpenAI-compatible 与 Anthropic 各自映射 wire 参数 | 不能把 namespace 混用        |
| Media capability     | 显式 provider/catalog metadata 优先      | 缺失时按 GLM-5.2 provider-aware fallback 判定     | 避免误 strip 或误透传图片    |
| Persistence/recovery | 保持既有 provider/session 持久化         | desktop continuous 与 web replayable 各守原边界   | 本次不引入同步状态           |

### Feature Relationships

| Rank           | From                   | Semantic edge                    | To                             | Condition             | Evidence                      |
| -------------- | ---------------------- | -------------------------------- | ------------------------------ | --------------------- | ----------------------------- |
| must-inspect   | model catalog          | projects capabilities to         | provider registry              | 加载 GLM-5.3          | catalog source tests          |
| must-inspect   | default policy         | supplies missing facts to        | CLI model catalog              | 静态或自定义 provider | adapter tests                 |
| must-inspect   | thought level          | projects to                      | provider request options       | low/high/max          | wire tests                    |
| must-inspect   | shared model identity  | classifies                       | CLI policies + dynamic overlay | GLM-5.3 aliases       | shared/adapter/protocol tests |
| must-inspect   | App catalog lookup     | enriches exact model only        | provider store metadata        | exact `glm-5.3` only  | service tests                 |
| must-inspect   | App dynamic provider   | rebuilds reasoning before        | workspace catalog overlay      | GLM-5.3 aliases       | protocol tests                |
| must-inspect   | runtime media resolver | classifies unknown image support | provider request projection    | GLM-5.3 metadata 缺失 | model-selection tests         |
| invariant-only | provider registry      | must not change                  | session/replay boundaries      | all clients           | no UI/protocol state diff     |

### State Owners And Commit Sinks

| State/fact           | Draft/display owner         | Authoritative owner           | Commit sink            | Evidence                 |
| -------------------- | --------------------------- | ----------------------------- | ---------------------- | ------------------------ |
| GLM-5.3 静态能力     | 各模型选择入口              | catalog + CLI default policy  | 既有 provider registry | catalog/adapter tests    |
| 当前 reasoning 档位  | composer/runtime projection | session settings              | 既有 model switch      | wire test                |
| 动态 reasoning patch | workspace overlay           | shared identity + CLI overlay | 既有协议同步           | protocol regression test |
| 动态 image 能力      | provider registry / catalog | runtime media resolver        | provider request 投影  | model-selection tests    |

### Must-Preserve Invariants

| Invariant                                      | Proof needed                                | Evidence              |
| ---------------------------------------------- | ------------------------------------------- | --------------------- |
| 只有 low/high/max，默认 max                    | capability equality                         | adapter/catalog tests |
| GLM-5.2 与普通 GLM 策略不变                    | negative assertions + existing suite        | default-policy tests  |
| ToB alias 不落入其他宽泛模型策略               | 冲突 token 下仍得到官方三档                 | adapter/protocol test |
| 原始 ToB 模型 ID 不被 canonical 化             | provider registry key 与请求 model 保持原值 | service/wire test     |
| App catalog 不 enrichment 路由别名             | 前后缀和 path ID 保持入站 metadata          | service test          |
| 显式 image 配置优先，unknown 与 GLM-5.2 同判定 | provider/transport/后缀组合断言             | bootstrap unit tests  |
| 不改变 provider entitlement 与 UI/session 状态 | related files absent from diff              | diff review           |

### Codegraph Evidence

当前环境没有可用 codegraph 工具，按 skill 约定使用 `rg` 回退。调用链为：

```text
catalog/default-policy
        -> ModelCatalogSource / ModelCatalogService
        -> workspace model catalog override
        +-> runtime thought-level providerOptions -> AI SDK request body
        +-> runtime media capability resolver -> provider-visible messages
```

### Graph Delta

| Status    | Node                            | Semantic reason                                                | Action             |
| --------- | ------------------------------- | -------------------------------------------------------------- | ------------------ |
| confirmed | `capability.model-capabilities` | GLM-5.3 spec、reasoning factory 与 media resolver 成为事实入口 | 更新 feature graph |

### Unresolved Questions

无。用户已明确任意前后缀都允许，只排除 `glm-5.3` 后紧跟数字；动态 context/output/media
保留显式配置，缺失 image 能力与 GLM-5.2 使用相同 provider-aware 判定。

## 用例规划

| Case ID   | Setup                             | Action                         | Assertions                           | Evidence layer        | E2E status |
| --------- | --------------------------------- | ------------------------------ | ------------------------------------ | --------------------- | ---------- |
| GLM53-001 | 关闭 models.dev                   | 查询官方/ToB/带 path/近似 ID   | 非数字后缀命中，数字续写拒绝         | shared + adapter unit | not-needed |
| GLM53-002 | 加载 bundled snapshot             | 遍历四个 provider              | 都有 GLM-5.3 基础能力                | adapter integration   | not-needed |
| GLM53-003 | 加载中国模型目录                  | 遍历四个 provider              | 三档/default/Anthropic patch 正确    | service unit          | not-needed |
| GLM53-004 | OpenAI-compatible fake fetch      | 分别选择三档                   | wire 有对应 reasoning_effort         | adapter wire          | not-needed |
| GLM53-005 | 动态 Anthropic/OpenAI fixture     | 同步无 metadata 的 ToB alias   | 重建三档与对应 transport options     | protocol integration  | not-needed |
| GLM53-006 | App config 含 exact 与路由 ID     | 加载 provider                  | exact ID 补齐；路由 ID 不 enrichment | service integration   | not-needed |
| GLM53-007 | GLM-5.3 缺失或显式 image metadata | 按 provider/transport 解析能力 | 与 GLM-5.2 fallback 一致；显式值优先 | bootstrap unit        | not-needed |

本次不增加 conversation E2E：没有修改 UI 交互、模型切换提交、session 状态或
realtime/replayable 语义，分层单元与 wire 测试直接覆盖新增行为。

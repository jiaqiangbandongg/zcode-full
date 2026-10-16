# Kimi K3 模型适配设计

## 背景

Kimi K3 已进入 Moonshot 官方模型列表。首发时官方 API 文档只开放 `max`，因此 ZCode 最初把它建模为单一固定档位；最新 Kimi Code 模型文档已经开放 `low` / `high` / `max` 三档，旧策略会让用户无法选择新档位。

2026-07-28 产品模型名调整：

- 保留 `kimi-k3`；
- 新增 `k3`，能力与 `kimi-k3` 完全一致；
- 原 `kimi-k3-256k` 更名为 `k3-256k`，不再把旧名称注册为可选模型。

本机运行日志确认当前 K3 请求使用 `openai-compatible` transport；Moonshot 官方文档同时明确：

- 模型 ID 为 `kimi-k3`；
- 上下文窗口为 `1,048,576` tokens，支持文本、图片和视频输入；
- `k3` 与 `kimi-k3` 都使用 `1,048,576` tokens 上下文；
- `k3-256k` 的上下文窗口固定为 `262,144` tokens，其余能力与 `kimi-k3` 一致；
- 默认输出上限为 `131,072` tokens；
- K3 支持 `"low"` / `"high"` / `"max"` 三档；ZCode 保持既有 `"max"` 默认值；
- 未知 effort 会返回 HTTP 400；`none` 会关闭 K3 路由并降级到其他模型，因此不作为 K3 档位暴露；
- K3 不能沿用 K2.x 的 `thinking` 开关参数。
- Kimi Code 的 OpenAI-compatible 与 Anthropic-compatible endpoint 都支持 K3 三档。
- K3 的工具参数校验只接受以 `#/$defs/` 开头的 `$ref`；MCP 工具可能产出指向 `#/properties/...` 的复用引用，必须在模型适配边界提升到 `$defs` 后再发送。

官方参考：

- https://platform.kimi.com/docs/guide/kimi-k3-quickstart
- https://platform.kimi.com/docs/models
- https://www.kimi.com/code/docs/en/kimi-code/models.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/release-notes/changelog.html

## 目标

- 在中国模型目录与 bundled models.dev snapshot 中维护 `kimi-k3`、`k3` 和
  `k3-256k` 的基础能力。
- 在 zcode-cli 默认策略和 App 动态 provider overlay 中把三个 K3 模型建模为
  `low` / `high` / `max`，默认 `max`。
- OpenAI-compatible 请求把所选档位映射为 `openaiCompatible.reasoningEffort`，由 AI SDK 输出顶层 `reasoning_effort`。
- Anthropic-compatible 请求使用 `anthropic.effort`，由 AI SDK 输出 `output_config.effort`；不注入 K2.x `thinking.type`。
- K3 请求发送工具时，把可解析的非 `$defs` 本地 JSON Pointer 引用提升到根 `$defs`，并把 `$ref` 改写为 `#/$defs/...`。
- 输入框展示“低 / 高 / 最高”三个可选值，不展示“关闭”“中”或“较高”。

## 非目标

- 不为 Kimi K2.5/K2.6/K2.7 改写现有思考协议。
- 不继续暴露 `kimi-k3-256k`；这次变更是模型 ID 更名，不是再增加一个旧名兼容槽位。
- 不把 Kimi 的别名输入（如 `medium` / `xhigh`）作为 UI 档位暴露。
- 不把 `none` 建模为 K3 的关闭档；关闭会改变实际模型路由，不是 K3 reasoning depth。
- 不改变桌面 continuous 与手机 Web replayable 的 session/task 消息边界。

## 状态与请求链路

```text
中国模型目录 / CLI 默认策略
          │  kimi-k3: context=1048576
          │  k3: context=1048576
          │  k3-256k: context=262144
          │  三者: levels=["low", "high", "max"], default="max"
          ▼
App provider metadata
          │  精确命中的旧档位若是新目录档位的真子集，则扩展并写回
          │  非目录自定义档位保持不变
          ▼
workspace provider registry
          ▼
session.settings.thoughtLevel
          │  available=["low", "high", "max"]
          ▼
输入框展示“低 / 高 / 最高” ── 菜单和 Ctrl+T 在三档间循环

OpenAI-compatible: reasoningEffort=level ──► reasoning_effort="low|high|max"
Anthropic-compatible: anthropic.effort=level ──► output_config.effort="low|high|max"

工具 contract: $ref="#/properties/..."
          │  K3 adapter 提升引用目标到根 $defs
          ▼
provider wire: $defs={zcode_ref_0: ...}, $ref="#/$defs/zcode_ref_0"
```

模型能力是唯一事实源；UI 只根据 option 数量派生是否可切换，不按模型 ID 硬编码 K3，也不保存额外 React 状态。

## 实现

1. 更新 `models_catalog_china_llm_zcode_2026-06-03.json`，保留 `kimi-k3` 的
   1M 上下文，新增同能力的 `k3`，并把 256K 模型改名为 `k3-256k`；三个模型都使用
   多模态输入、131072 输出预算和 `low` / `high` / `max` 三档，默认 `max`。
2. 更新 `apps/zcode-cli/api.json` 并重新生成 `models-dev-snapshot.ts`，保证纯 CLI
   catalog 也能取得三个 K3 模型的基础能力。
3. reasoning/default policy 为 OpenAI-compatible 与 Anthropic-compatible K3 分别生成三档 request patch。
4. workspace dynamic provider overlay 在读取入站 metadata 前按 transport 收敛 K3 能力，避免旧配置中的单 `max` 或通用 thinking toggle 污染结果。
5. App 读取 provider store 时，对精确 catalog 模型的 reasoning 档位做单向扩展：旧档位是新目录档位的真子集时采用新目录档位并持久化；包含非目录档位的用户自定义配置不覆盖。这样已有 `config.json` 的新建任务草稿也能获得三档。
6. tool transform 根据目标模型应用 K3 schema compatibility：扫描可解析的本地 `$ref`，复用同一引用目标的 `$defs` 条目，不修改原始 tool contract；其他模型保持原 schema。
7. 继续复用能力驱动的思考控件，不在 UI 中按 K3 model id 硬编码选项。

## 测试

- adapter default policy：`kimi-k3`、`k3` 精确命中 1M，`k3-256k` 精确命中 256K；
  三者都命中视觉/131072/三档 reasoning 且默认 `max`，`kimi-k3-256k` 和 K2.x
  不误命中。
- models.dev catalog：三个 K3 模型的 metadata 都能从 snapshot fixture 投影。
- workspace provider protocol：两种 transport 有/无旧 metadata 时均下发三档及对应 request patch。
- App provider store：历史 `variants=["max"]` 会扩展并写回 `low/high/max`，含非目录档位的自定义 reasoning 保持不变。
- wire test：`low` / `high` / `max` 在 OpenAI-compatible 下生成顶层 `reasoning_effort`，在 Anthropic-compatible 下生成 `output_config.effort`，且都不携带 K2.x `thinking`。
- tool wire test：K3 的 `#/properties/...` 引用会提升为根 `$defs` 并改写成 `#/$defs/...`，其他模型不改写，原始 contract 不被修改。
- 运行定向测试、`pnpm typecheck`、`pnpm lint`。

## 影响简报

### Feature Summary

| Field            | Value                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Developer intent | 新增 `k3`，把 `kimi-k3-256k` 更名为 `k3-256k`                                            |
| Capability       | Model capabilities / model selection / provider registry                                 |
| Change layer     | `option-source`、`validation`                                                            |
| Operating mode   | planning                                                                                 |
| Primary seeds    | China LLM catalog、models.dev snapshot、model default policy、workspace provider overlay |
| Out of scope     | session 状态、模型切换提交语义、远控 replay、workspace identity                          |

### UI Surface Matrix

| User scenario               | UI entry                | Shared implementation                    | Display/draft owner     | Default/inherit source | Validation/gating       | Commit action                       | Authority/persistence                                    | Mode boundary                                              | Must remain isolated from        |
| --------------------------- | ----------------------- | ---------------------------------------- | ----------------------- | ---------------------- | ----------------------- | ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| 对话模型选择                | V4 composer             | provider registry / model option builder | session 或 draft config | App provider config    | registry 中存在且未禁用 | `switchModelConfig` 或 draft config | Agent runtime / workspace default                        | desktop continuous 与 web remote shared host 共用 registry | 自动化、Subagent、Repo Wiki 草稿 |
| 自动化、Subagent、Repo Wiki | 各自模型选择器          | 同一 provider registry                   | 各入口本地草稿          | 各入口既有继承规则     | registry 中存在且未禁用 | 各自 service                        | automation record / agent Markdown / generation settings | 不新增平台分支                                             | 当前对话模型                     |
| 供应商设置                  | Model Provider settings | model provider service                   | provider 编辑草稿       | China LLM catalog      | catalog schema          | provider save                       | `~/.zcode/v2/config.json`                                | 远程 workspace 仍由既有 registry sync                      | session/task 业务状态            |

### Shared And Divergent Behavior

| Concern              | Shared across surfaces                 | Deliberately different                                    | Why it matters for this change                  |
| -------------------- | -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Option source        | 都消费 provider registry 中的 model id | 各入口可有自己的二次过滤                                  | 新旧 model id 必须在统一来源一次收敛            |
| Default/inheritance  | 都读取模型能力 metadata                | session、automation、Subagent、Repo Wiki 的默认值归属不同 | 本次不改任何默认选择                            |
| Commit effect        | 都提交 provider/model ref              | commit sink 各自独立                                      | 只换候选名，不能串改其他入口状态                |
| Persistence/recovery | App provider config 是 registry 来源   | session/replay/业务草稿各自持久化                         | 不改变 desktop continuous / web replayable 边界 |

### Feature Relationships

| Rank           | From              | Semantic edge                   | To                                         | Condition             | Why inspect it                      | Evidence                     |
| -------------- | ----------------- | ------------------------------- | ------------------------------------------ | --------------------- | ----------------------------------- | ---------------------------- |
| must-inspect   | model catalog     | projects capabilities to        | provider registry                          | 三个 K3 id            | 决定 UI 候选和 App metadata         | catalog source tests         |
| must-inspect   | provider registry | configures                      | CLI default policy / workspace overlay     | metadata 缺失或旧档位 | 必须仍得到正确 context/reasoning    | adapter/bootstrap tests      |
| must-inspect   | K3 model id       | selects compatibility transform | tool schema projection                     | 三个新目录 id         | K3 `$ref` 限制不能因改名失效        | tool transform tests         |
| should-inspect | provider registry | options-from                    | 对话、自动化、Subagent、Repo Wiki          | registry 刷新后       | 所有入口应看到同一组新名称          | shared model-selection graph |
| invariant-only | model rename      | must not change                 | desktop continuous / web remote replayable | 所有 workspace        | 本次不改 session/task realtime 协议 | current architecture         |

### State Owners And Commit Sinks

| State/fact    | Draft/display owner           | Authoritative owner                  | Commit command/service | Persistence/cache             | Evidence               |
| ------------- | ----------------------------- | ------------------------------------ | ---------------------- | ----------------------------- | ---------------------- |
| K3 候选与能力 | 各 UI 入口                    | model provider service / CLI catalog | provider registry sync | App config / bundled snapshot | model provider docs    |
| 当前请求模型  | composer / runtime projection | Agent `defaultModelRef`              | session model switch   | session/runtime config        | chat model select spec |

### Must-Preserve Invariants

| Invariant                                | Surfaces/modes     | Proof needed                                  | Evidence                     |
| ---------------------------------------- | ------------------ | --------------------------------------------- | ---------------------------- |
| `k3` 与 `kimi-k3` 除 id/name 外能力一致  | catalog / CLI      | catalog 与 default-policy equality assertions | service/adapter tests        |
| `k3-256k` 仅 context 为 262144           | catalog / CLI      | capability assertions                         | service/adapter tests        |
| 旧 `kimi-k3-256k` 不再注册或命中默认策略 | catalog / CLI      | absence assertions                            | catalog/default-policy tests |
| 命名变化不改各 UI 入口的 commit sink     | desktop/web/mobile | 不修改 UI/session/replay 代码                 | diff review                  |

### Codegraph Evidence

| Seed                                           | Query                           | Direct callers / key path                         | Depth | Interpretation                       |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------- | ----- | ------------------------------------ |
| `KIMI_K3_MODEL_ID` / `isKimiK3ModelId`         | explore / affected tests        | default policy、tool transform、workspace overlay | 2     | 必须统一扩展三个模型名               |
| `loadLocalChinaLlmZCodeCatalog`                | explore / callers               | model provider service、store metadata migration  | 2     | catalog 同时驱动候选与 metadata 补齐 |
| `buildModelSelectGroups` / `useModelProviders` | graph declaration + live source | 对话、自动化、Subagent、Repo Wiki                 | 2     | 共享候选来源，无需修改 UI            |

### Graph Drift Candidates

| Candidate                   | Live-code evidence                                                | Missing/stale graph relation                       | Proposed follow-up        |
| --------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ------------------------- |
| model capability code seeds | K3 default policy、catalog source、workspace overlay 是当前事实源 | `capability.model-capabilities` 缺少精确 code seed | 本次补充 graph code seeds |

### Graph Delta

| Status    | Node/edge                                  | Semantic reason                       | Evidence               | Action             |
| --------- | ------------------------------------------ | ------------------------------------- | ---------------------- | ------------------ |
| confirmed | `capability.model-capabilities` code seeds | 让后续模型命名/能力扫描直接命中事实源 | 当前实现与本次用户决策 | 更新 feature graph |

### Unresolved Questions

无。用户已经明确三个最终可选模型名及能力关系。

## 用例规划

### Boundary Decisions

| Boundary     | Decision                   | Includes                                                           | Excludes / prunes        | Source           |
| ------------ | -------------------------- | ------------------------------------------------------------------ | ------------------------ | ---------------- |
| 最终模型集合 | `kimi-k3`、`k3`、`k3-256k` | catalog、snapshot、default policy、dynamic overlay、tool transform | `kimi-k3-256k`           | 用户决策         |
| UI 行为      | 只随 registry 候选变化     | 所有复用模型列表的入口                                             | UI 组件、交互、i18n 改动 | 现有能力驱动实现 |
| delivery     | 保持既有边界               | desktop continuous、web remote shared-host registry                | 新 realtime/session 状态 | 架构约束         |

### Accepted Cases

| Case ID     | Setup                                  | Action                       | Assertions                              | Evidence layers      | E2E status |
| ----------- | -------------------------------------- | ---------------------------- | --------------------------------------- | -------------------- | ---------- |
| K3-NAME-001 | 加载 China LLM catalog                 | 查找 K3 模型                 | 只有三个最终 id，能力关系正确           | service unit         | not-needed |
| K3-NAME-002 | 关闭 models.dev，仅使用 default policy | 查询三个最终 id 与旧 256K id | 三个最终 id 能力正确，旧 id 不命中      | adapter unit         | not-needed |
| K3-NAME-003 | 加载 bundled models.dev snapshot       | 查询 Moonshot 模型           | 三个最终 id 均存在，旧 id 不存在        | adapter integration  | not-needed |
| K3-NAME-004 | 动态 provider 缺失 K3 metadata         | upsert `k3` / `k3-256k`      | 按 transport 合成三档 reasoning         | protocol integration | not-needed |
| K3-NAME-005 | K3 tool contract 含本地 `$ref`         | 分别投影 `k3` / `k3-256k`    | `$ref` 提升到 `$defs`，原 contract 不变 | adapter wire unit    | not-needed |

本次不增加 conversation E2E：模型选择提交、session 状态和 realtime/replayable 语义均未改变；
目录、默认策略、协议 overlay 与 wire transform 已由分层单元/集成测试直接覆盖。

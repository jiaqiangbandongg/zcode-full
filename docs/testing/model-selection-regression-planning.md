# 模型选择与供应商超大回归矩阵规划

## Feature Summary

| Field                | Value                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent     | 罗列所有与模型供应商、模型选择、思考深度、模型能力、请求投影和模型相关产品功能有关的因子，并为后续笛卡尔积、剪枝和测试生成提供稳定输入。                                                                                                                                                                                                |
| Capability           | Model selection / Provider Registry / Model Runtime / Model Request Projection                                                                                                                                                                                                                                                          |
| Change layer         | option-source、draft-default、validation、commit-effect、persistence、recovery；presentation 只作为低权重交叉维度                                                                                                                                                                                                                       |
| Operating mode       | planning                                                                                                                                                                                                                                                                                                                                |
| Primary catalog      | [model-selection-regression-factor-catalog.yaml](./model-selection-regression-factor-catalog.yaml)；隐含决策见 [backlog](./model-selection-regression-decision-backlog.yaml)，可直接填写的 [决策问卷](./model-selection-regression-decision-questionnaire.md)                                                                           |
| Current product code | [ModelSelection](/Users/dev/workspace/z-code-3/packages/shared/src/model-selection.ts)、[Provider Resolver](/Users/dev/workspace/z-code-3/packages/provider/src/resolver.ts)、[V4 model command handler](/Users/dev/workspace/z-code-3/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts) |
| Out of scope         | 本轮不写产品代码、不直接生成正式 E2E、不把 undefined 或 bug-candidate 当成 accepted 断言、不把所有 literal model ID 做无约束全排列。                                                                                                                                                                                                    |

## 1. 语义分层

```text
Provider / account / entitlement / personal config
                         │
                         ▼
              Resolver + Provider Registry
                         │
                         ▼
               visible candidates / preferred
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
        Chat Draft   Session Runtime  Automation/Subagent
           │             │             │
           └─────────────┼─────────────┘
                         ▼
                V4 Command / Service
                         ▼
                 Canonical Submission
                         ▼
                 ModelFactory / Model
                         ▼
       API format / auth / history / option projection
                         ▼
              provider request + usage + events
```

必须分别断言四层：

1. `ModelSelection`：provider/model 加显式 option override。
2. Active Model：ModelFactory 根据当前 Registry 补齐默认值后创建的执行对象。
3. Request Projection：针对 Anthropic、OpenAI Chat、OpenAI Responses 和 OpenAI-compatible 的请求形态。
4. Provenance：最终回复、压缩、标题、Subagent、Automation 等结果实际使用的 provider/model。

模型 ID 是 opaque value。展示态可以编码为 `providerId/modelId$variant`，但 V4 command、Agent snapshot
和持久化不得把该展示态字符串当成新的跨进程协议；model ID 中的 `/`、`:` 和 `$` 都需要保留原义。

## 2. UI Surface Matrix

| 用户场景           | 入口                            | 草稿/展示 owner            | 默认/继承                            | 校验                             | Commit sink                           | 权威落点                           | 必须隔离                                  |
| ------------------ | ------------------------------- | -------------------------- | ------------------------------------ | -------------------------------- | ------------------------------------- | ---------------------------------- | ----------------------------------------- |
| 新建对话           | V4 composer toolbar             | renderer draft             | Recent -> Host preferred -> fallback | target Host Registry             | `createSession.config` / `firstInput` | Session runtime + Snapshot         | 不改已有 Session                          |
| 已有对话切模       | V4 composer toolbar             | Conversation Snapshot      | 当前 Session config                  | CAS、target model capability     | `switchModelConfig`                   | CLI session runtime                | 不改其他 Session                          |
| 历史任务恢复       | Session/task switch             | Snapshot hydrator          | persisted Session config             | cold-resume + Registry           | resume path                           | Session timeline                   | Task index 不是 authority                 |
| Automation 编辑    | `AutomationEditView`            | automation form draft      | inherit 或 automation record         | automation model options         | automation save                       | automation record/run snapshot     | 不改 Chat Session                         |
| Automation 运行    | scheduler / manual dispatch     | run snapshot               | saved selection                      | run-time Registry/auth           | dispatch                              | automation execution               | 不重新读取 Chat Draft                     |
| Off-Peak 编辑      | `OffPeakEditView`               | Off-Peak form              | task record                          | hidden exact model + entitlement | offpeak save                          | Off-Peak task record               | 不写 Recent/default                       |
| Off-Peak 执行      | scheduler                       | task/run record            | persisted selection                  | ticket、JWT、Team scope          | task dispatch                         | Off-Peak runtime                   | 不创建普通 Chat runtime                   |
| User Subagent      | `SubagentsSection`              | profile/Markdown           | parent inherit                       | child profile + Registry         | Markdown save / child create          | child runtime/timeline             | readonly child 无 picker                  |
| Built-in Subagent  | Built-in model control          | built-in override          | built-in profile                     | Registry                         | built-in override save                | child runtime                      | 不污染 parent timeline                    |
| Provider 设置      | provider settings section       | settings form              | source overlay                       | schema/complete/revision         | Provider facade                       | personal/account config + Registry | 不直接创建 runtime model                  |
| 登录初始选择       | login/welcome                   | login form                 | family/provider first model          | key/OAuth/entitlement            | account connection                    | account settings                   | 不绕过 Provider Registry                  |
| Bot                | Bot `/model`                    | bot config                 | bot default                          | model selection view             | bot service                           | bot config/request                 | 不假设 Chat toolbar 状态                  |
| 官方 MCP           | official MCP credentials        | account/family selection   | active plan provider                 | coding plan access               | credentials service                   | auth context                       | 不把 MCP provider facts 当 Registry owner |
| Git commit message | git generator                   | request-local              | current/explicit model               | output budget 256                | generateText                          | commit result provenance           | 不改主会话 thought                        |
| Title/Goal title   | sidecar                         | request-local              | configured title model/current model | JSON/no tools                    | sidecar request                       | title provenance                   | 强制关闭 reasoning                        |
| Goal verifier      | runtime verifier                | start-time snapshot        | Session model                        | verifier policy                  | verifier request                      | goal execution                     | 不跟随中途模型切换                        |
| Compact            | compact runtime                 | request-local              | current model                        | context/output budget            | compact request                       | compact timeline                   | 不生成普通 user row                       |
| Project memory     | memory helpers                  | request-local              | current model                        | memory policy                    | generateText                          | memory result                      | 不制造额外产品 turn                       |
| Connectivity       | provider/model test             | request-local              | explicit model                       | credentials/provider facts       | connectivity service                  | result only                        | 不修改 Session model                      |
| CLI/TUI            | `/model`、`/effort`、`/variant` | CLI config                 | CLI current config                   | runtime validation               | CLI command                           | CLI runtime                        | 与 UI 展示层分开验证                      |

共享 UI 不代表共享行为。`ModelConfigSelect`、`buildModelSelectGroups` 和 `useModelSelectionView` 只
共享候选来源或展示约定；每个 surface 的 draft、默认、commit 和 persistence 都必须独立断言。

## 3. 状态 owner、校验点和持久化

| 状态/事实            | Authority                         | Mirrors/cache                   | 校验/commit                                  | 持久化                                           |
| -------------------- | --------------------------------- | ------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Provider/Model facts | target Host Provider Registry     | Settings/Selection facade       | `ProviderConfigResolver`、`validateComplete` | Built-in/Account/Personal config                 |
| 用户选择             | surface-local draft 或产品 record | toolbar、form、recent           | target Worker Registry + ModelFactory        | Session/Automation/Subagent/Off-Peak record |
| Active Model         | CLI runtime                       | Snapshot、usage、provenance     | ModelFactory、Adapter capability checks      | session model timeline / message provenance      |
| Session config       | CLI Session runtime               | Conversation Snapshot、Renderer | V4 command barrier/CAS                       | Session persistence                              |
| Queue Submission     | CLI CommandInbox/FIFO             | renderer optimistic journal     | admission/queue guard                        | queue facts/discard ledger                       |
| Recent selection     | workspace-keyed renderer storage  | draft initializer               | selectable check                             | workspaceKey：identity trim，否则使用 path       |
| Plan/entitlement     | Account/plan services             | provider UI badges/usage        | account/provider access resolution           | account settings/usage data                      |
| Request auth         | execution service/provider access | request-local only              | fail before network                          | 不落盘动态凭据                                   |
| Delivery profile     | trusted Host attachment           | connection subscription         | host injection                               | 不由 renderer 自选                               |

## 4. 交付边界

```text
desktop / SSH / WSL / Docker
  -> window-scoped Local Host
  -> Local Agent or Remote Workspace connection
  -> desktop-continuous

mobile /remote
  -> attach existing shared host
  -> same CLI Session Runtime
  -> web-remote-replayable
```

必须保持：

- relay 和 main 只做鉴权、配对、心跳、透传和 attachment 调度，不拥有 Session/Task/Queue/Snapshot。
- 手机不另起 Agent、Local Host 或独立 remote runtime。
- Desktop continuous 和 mobile replayable 是两个 delivery contract，不能互相拼接。
- 远程请求贯穿 `workspaceIdentity` 和 `remoteSessionId`。
- `workspacePath` 用于执行和展示；`workspaceIdentity` 用于身份隔离和 key。
- accepted input 只有 CLI/runtime CommandInbox 一个权威 FIFO。

## 5. 因子和组合策略

完整因子在 [YAML catalog](./model-selection-regression-factor-catalog.yaml) 中维护，第一层维度为：

```text
surface × operation × provider/access/entitlement
        × api/auth/endpoint
        × model capability/reasoning/max-output
        × selection/default/draft/session/queue
        × recovery/persistence/delivery/workspace
```

不直接展开成全局笛卡尔积。模型采用以下等价类签名：

```text
provider access profile
+ API transport profile
+ auth profile
+ model capability profile
+ reasoning wire profile
+ context/max-output profile
+ lifecycle/recovery profile
+ product operation profile
```

生成规则：

1. 第一轮 pairwise，覆盖每个行为维度和共享 owner。
2. Provider/API/reasoning、Registry/session/queue、remote/recovery 等高风险关系做 3-wise。
3. 仅在明确声明的 cross-product 内展开 full Cartesian。
4. 颜色、主题、语言、viewport、键盘/鼠标等 presentation 维度做共享 UI 代表，不和所有模型组合。
5. `accepted` 才能进入正式 E2E；`undefined` 必须先有决策；`bug-candidate` 需要产品契约确认后转回归。
6. 每个剪枝都必须有明确 guard 或 invariant，不能以“组合太多”为理由删除。

## 6. 第一批高风险 case

YAML 中已经放入完整 seed cases。最先应落地的主线为：

| Case             | 场景                                      | 证据重点                                |
| ---------------- | ----------------------------------------- | --------------------------------------- |
| MSR-REG-001      | Personal custom Provider 选择并首发       | UI、Registry、真实 request body、持久化 |
| MSR-REG-002      | 两个 Provider 下同名模型                  | provider/model 完整身份                 |
| MSR-REG-003      | Remote Registry loading 不 fallback 本地  | target Host authority                   |
| MSR-REG-004      | Built-in/Account revision 不匹配          | atomic Registry publish                 |
| MSR-AUTH-002     | entitlement loading 保留 saved selection  | plan gating                             |
| MSR-REASON-001   | GLM-5.2 max/high/nothink                  | reasoning wire mapping                  |
| MSR-REASON-002   | Qwen/Kimi/MiMo toggle                     | extra-body minimal projection           |
| MSR-REASON-003   | Anthropic fixed/adaptive budget           | max output 与 thinking budget           |
| MSR-REQ-001      | modality/tool/structured output           | adapter preflight + request body        |
| MSR-DRAFT-002    | Draft 切模后首次发送                      | createSession/firstInput freeze         |
| MSR-SESSION-002  | noop/stale/duplicate/failed switch        | protocol ACK/CAS                        |
| MSR-SESSION-003  | switch barrier 与 send 竞态               | command ordering                        |
| MSR-SESSION-004  | provider.notInRegistry 一次 refresh/retry | remote identity                         |
| MSR-SESSION-005  | stream 中切模                             | in-flight model immutability            |
| MSR-QUEUE-002    | Desktop + mobile busy input 共用 FIFO     | CommandInbox + delivery                 |
| MSR-RECOVERY-001 | Anthropic unsigned reasoning repair       | canonical history immutability          |
| MSR-RECOVERY-002 | empty completion retry                    | exactly-once output                     |
| MSR-REMOTE-001   | remote workspace identity 隔离            | workspaceKey + reconnect                |
| MSR-SURFACE-001  | Automation 保存后运行                     | record/run snapshot                     |
| MSR-SURFACE-002  | Subagent 继承/显式模型                    | child authority/provenance              |
| MSR-OFF-001      | 隐藏 Off-Peak provider 内部执行           | hidden Registry + ticket                |
| MSR-SIDE-001     | title 强制 no reasoning                   | sidecar projection                      |
| MSR-SIDE-002     | Git commit 显式 thought 语义              | querySource-specific behavior           |

## 7. 隐含决策审计结果

上一版只列了 3 个 hard blocker，确实过度压缩了范围。现在单独维护的 decision backlog 有 114 项，但它们不是 114 个都要产品逐条拍板：

| 分类                   | 数量    | 含义                                   | 下一步                           |
| ---------------------- | ------- | -------------------------------------- | -------------------------------- |
| `undefined`            | 64      | 真实产品行为未定义，必须先裁决         | 每轮裁 3–7 项                    |
| `contract-conflict`    | 12      | 新旧 spec、实现、既有 case 互相矛盾    | 先确定权威口径，再改文档/测试    |
| `resolved-needs-proof` | 38      | 已有较强设计或实现倾向，不应重复问产品 | 用 unit/integration/E2E/日志证明 |
| **合计**               | **114** |                                        |                                  |

### 7.1 需要先收敛的 12 个契约冲突

- Registry：`DEC-019`、`DEC-020`、`DEC-021`，旧 legacy 来源、identity scope 和 atomic publish 是否仍有效。
- Entitlement：`DEC-030`，旧 I56/I58/I61 的 silent fallback 是否仍是当前行为。
- Reasoning：`DEC-041` 已裁决为 frozen Submission；queue 消费时不得用最新 Session Selection
  改写已入队的 Provider、Model 与思考深度。
- Session：`DEC-046` 已裁决为 queue item 的 Provider、Model 与 thought 按 admission 冻结。
- Product surface：`DEC-065`、`DEC-066`、`DEC-067`，Automation/Subagent 继承和 Recent 写入时点。
- Migration：`DEC-091`、`DEC-092`，旧 snapshot/case 如何重分类和迁移。

其中 Queue 冲突的当前证据链是：

```text
accepted input
      │
      ▼
CommandInbox admission
      │ freeze complete Submission: provider/model/thought
      ▼
queue wait ───────────────┐
                          │ refresh latest provider facts/credentials only
                          ▼
                   ModelFactory
                          │
                          ▼
                 request + provenance

desktop-continuous  ─────┐  业务事实相同
web-remote-replayable ───┘  只改变 snapshot/gap/owner 的投递与恢复边界
```

较新的 Provider interaction design、`conversation-product-state-space.md` 和当前 `input-intent.ts` 都支持冻结 Submission；
`conversation-protocol-declaration.md` / `conversation-product-protocol.md` 已统一为
`queuedSubmissionPreservesSelection`。
因此 `MSR-QUEUE-001` 及其相关项可以按 frozen Submission 语义进入 formal E2E。

### 7.2 64 个真正需要产品决策的 edge domain

完整问题、选项、建议、证据和阻塞 case 在 backlog 中逐项展开。覆盖面包括：

1. 空选择、Recent、Host preferred、provider default、provider/model 同名和 draft 原子回滚。
2. Picker 打开后 Registry 变化、disabled/deprecated、revision、旧 snapshot 和远端 target Host authority。
3. entitlement loading、账号切换、OAuth refresh、个人 key/团队代理、组织 policy 和 operation 级能力。
4. missing/default/explicit-off thought、effort/budget 优先级、nothink wire、reasoning 与 tools/schema 冲突。
5. Queue admission、FIFO、Guide boundary、取消/停止/超时、Edit/Retry、compact、Goal 和内部 Submission。
6. Automation、Subagent、Off-Peak、Bot/TUI/CLI、MCP、Git commit、Title、Verifier、Memory。
7. desktop continuous 与 mobile replayable、shared-host attachment、workspaceIdentity、remoteSessionId、owner/lease、gap recovery。
8. 长列表排序/搜索/键盘/触摸/无障碍、双主题/i18n/窄屏，以及 migration、correlation ID、脱敏日志、错误分类和 pruning report。
9. Node persistence：Configured Default 的 schema/损坏/legacy import/watcher/dispose，以及 Built-in Release 的 Bundled/Active/LKG、revision、retired provider、远端 refresh lease、backoff、atomic write。

第一轮建议裁决以下 7 项，它们的答案会最大幅度影响笛卡尔积剪枝：

1. `DEC-046`：已裁决为 Queue 冻结 Submission Selection；Provider 配置在 Model 创建时读取最新事实。
2. `DEC-067`：Recent 在 picker、switch ACK 还是 accepted Submission 时写入。
3. `DEC-030`：不可用 explicit model 是否允许 silent fallback。
4. `DEC-066`：Subagent 无显式 model 的继承源。
5. `DEC-001`：没有任何 selectable model 时的空状态和发送行为。
6. `DEC-016`：Provider endpoint/config 变更是否影响 Active Model。
7. `DEC-091`：旧 snapshot 缺 provider/thought 信息时如何恢复。

### 7.3 29 个已有口径但需要证据的项目

这些不是“再问一个产品偏好”，而是要补测试或运行时证据：ModelSelection 的结构化 round-trip、Recent 的 accepted-Submission 时点、
Provider config 对 Active Model 的不可变性、reasoning repair、Edit/Retry 复制完整 selection、跨端 queue provenance、
Automation/Subagent/Off-Peak 隔离、remote snapshot authority、workspaceKey 迁移、脱敏日志和 pruning report。

## 8. Graph drift 和范围缺口

- 当前没有 live codegraph index，因此本目录的 code evidence 标记为 source-reading/rg evidence；不能把 graph 未索引误判为功能不存在。
- `OffPeakEditView` 是实际模型选择入口，但 feature graph 对它的独立 surface 描述不完整。
- Login、Bot、官方 MCP、Git commit、标题、Goal verifier、Project memory 都是实际模型消费者，但当前 graph 只部分表达了它们和 model-selection 的语义边。
- 旧 client-config、`magic_name`、fallback、tombstone 相关路径只能作为 migration/legacy boundary，不应继续作为当前 Provider Registry 的来源。
- 这次新增 backlog 专门记录 code graph 之外通过 spec、resolver、input-intent、ModelFactory 和 case catalog 交叉发现的隐含边，不把它们悄悄塞进单一 `surface` 因子。
- `packages/provider-node` 不是简单文件存储：它同时决定 Configured Default、Bundled/Active Release、远端同步 lease 和 Registry 的启动可用性；因此新增 `DEC-098`–`DEC-114`，不能只覆盖 renderer picker。

## 9. E2E 交接规则

模型专项正式 E2E 需要遵循现有 conversation E2E 工作流：

1. accepted case 先写 setup/action/assertion 和至少一个非 UI 证据层。
2. Provider 请求使用 case-local fixture；普通功能使用 `fast-text`，时序场景使用 `controlled-stream`，故障场景使用 `fault-stream`。
3. UI-only picker/keyboard case 显式声明 `providerRequestPolicy: none`，不能用空 fixture 掩盖漏配。
4. Desktop case 默认 `desktop-continuous`；Remote case 额外验证 `web-remote-replayable` 的 snapshot/gap/owner boundary。
5. 只把 provider/model capability signature 的代表 case 放入 E2E；映射细节由 provider-unit 和 adapter-wire 测试覆盖。
6. 先通过 fixture check 和 local replay，再进入 formal promotion/Docker preset。

当前不生成 `manual-review/pending` spec，因为 Queue contract、旧 fallback、Recent timing、Subagent/Automation inheritance、
legacy snapshot migration 等仍有未决/冲突项。待这些问题裁决后，再把 YAML 的 accepted cases 回填到专项 case catalog 和 coverage matrix。

## 10. 后续执行顺序

```text
YAML factor catalog
        │
        ▼
决策回填（undefined / contract-conflict）
        │
        ▼
实现证明（resolved-needs-proof）
        │
        ▼
生成 legal combinations + pruning report
        │
        ▼
按 owner 分派 unit / integration / desktop E2E / remote replay
        │
        ▼
回填 conversation case catalog + coverage matrix
```

# Todo121：补回 0020 回填 Session 选择时遗漏的思考档位

> 状态：2026-09-11 已实现追加迁移 0022，正式 runner／存储 Reader 定向验证与局部 review 通过，整批最终交付复审待执行。承接 [Todo109](./todo-109-database-migration-consolidation-and-rollback-readability.md) 的数据迁移遗漏，不修改真实用户数据库。

## 问题与目标

0020 在没有 `runtime/model_selection` 条目时，按消息顺序取最后一个候选。旧用户消息可能有 `model.variant = max`，后面的 assistant 消息却只有模型身份。结果用户消息的新 `modelSelection` 保留档位，回填的 Session 选择没有 options；新版只读 Session 的新选择，因此恢复后档位为空。

直接执行现有 0020 SQL，已对自定义模型和 Coding Plan GLM 复现上述结果。对方提供的 140 条可恢复等统计仅代表其机器，未独立核验，不作为全量影响范围或验收数量。

目标：新增一条正式迁移，只补回确定遗漏的档位。已经执行 0020 后继续使用或保存过选择的会话直接跳过，不追求挽救全部历史状态，不引入复杂历史还原或不必要防御。

## 最终方案

### 1. 一条追加迁移覆盖两类用户

0020、0021 的内容和 checksum 不改；不重跑、不修改账本来绕过校验。当前会话库最新编号为 0021，实施前确认最新占用后追加编号，不预先强占 0022。

```text
从未执行 0020
  → 0020 回填条目，保留消息的历史时间
  → 账本记录执行时间 T
  → 0021
  → 新修复迁移

已经执行 0020
  → 跳过已执行迁移，保留原执行时间 T
  → 新修复迁移
```

读取 `schema_migration` 中 `0020_provider_model_selection.time_applied` 作为 T。现有 runner 在同一启动事务内顺序执行、执行后记账，因此首次升级也可直接使用这份时间，不需要两套修复流程。

### 2. 先跳过迁移后动过的会话

以下任一成立即跳过整个会话：

- `session.time_updated > T`：正常消息／内容等写入会更新会话活动时间。
- 目标选择条目的 `time_updated > T`：单独保存选择使用 `touchSession: false`，不会更新会话时间，所以必须另查选择条目。

这是利用现有写入时间的保守筛选，不建设完整操作审计，不追踪任意外部修改或还原历史。因为其他操作更新时间而多跳过部分会话可以接受。0021 仅规范化身份、不更新这些时间，不应把它误作用户后续活动。

### 3. 对未再动过的会话，只按以下条件补回

1. 条目类型为 `runtime/model_selection`，ID 为标准的 `sessionId:runtime-model-selection`。
2. 条目 data 没有旧平铺的 `providerId`、`modelId`、`thoughtLevel`；新的 `modelSelection` 有有效 Provider／Model 身份，且 `options` 成员不存在。已有 options（包括空对象、明确 null 或其他值）、明确空选择均不覆盖。
3. 按 0020 的顺序约定（`sequence desc, time_created desc, rowid desc`）取同 Session **最后一条 role=user 消息**；先选最后一条，再检查其 `modelSelection.options.reasoningLevel` 是否为非空字符串。不能先过滤出有档位的消息而越过较新的空选择。
4. 直接从这条 user 的新 `modelSelection` 读取身份和档位。0020 已转换旧 `model.variant`，不再增加旧字段 fallback。
5. 用户消息身份按既有冻结迁移规则规范化后，与条目身份相同才补：包含 Provider 改名和 0021 限定的官方 GLM 大小写规则；不对任意 Provider／模型全局忽略大小写，不查询账号、权益、实时目录或 Registry。

符合时仅新增 `data.modelSelection.options.reasoningLevel`，保留该用户消息记录的档位值，不借本项新增档位重命名语义。模型不同、最后一条 user 无档位、坏数据等不符合条件的直接跳过。

不做 parentID 推理，不重建 Guide／分叉／切模历史，不向更早消息搜索档位，不重跑 0020 的候选表达式来做历史取证，不新增运行时旧字段回读。

### 4. 数据与实现边界

- 只修改会话库目标 `session_entry.data` 的上述位置；不改模型身份、其他 options、旧字段、历史消息、正文、任务或任何活动时间。
- 沿用现有启动 migration runner、事务和账本。修复成功只记一次；再次启动不重跑。
- 转换规则冻结在 migration 边界，不能引用随版本变化的 Resolver／目录实现；保持 SQL 简洁，不扩建迁移框架。
- 正常 Session 恢复、Registry、UI 不改。继承 Todo109 的最高原则：回滚或回滚后再升级允许模型选择失效，但会话／任务必须能打开，不能因缺失新字段报告异常。
- 先写测试再实现；不操作真实用户数据库，不把旧 checksum 校验失败当作可以忽略的异常。

## 验收与 review

- [ ] 首次升级：真实旧格式 user 有 max、assistant 无 variant、无选择条目，依次运行 0020／0021／新迁移后恢复 max；覆盖自定义模型及 Coding Plan GLM。
- [ ] 已执行 0020：保留原账本时间，未再使用的回填会话可修复；确认不是重跑 0020。
- [ ] 迁移后新增消息／更新会话，以及仅保存选择但不更新 Session 时间，两种情况分别跳过；覆盖后续无档位改选、明确清空与新建会话。
- [ ] Provider 旧身份与官方 GLM 大小写按冻结规则对应；不同 Provider／模型不借档位，第三方模型不做任意大小写归一。
- [ ] 最后一条 user 无档位或明确空选择，即使更早 user 有 max 也不补；已有 options、旧平铺选择条目、不合法 JSON／身份不改、不阻塞内容读取。
- [ ] 只补目标字段：旧值、消息、正文及所有活动时间逐项断言不变；再次启动不重跑，checksum 不变，失败事务不留下部分修复。
- [ ] 验证存储 Reader／Session 冷恢复读到补回档位；按 Todo109 标准检查回滚及再升级内容可读、不因缺字段异常，不把只写盘成功当作恢复链路通过。
- [ ] 合批执行相关测试、类型检查、lint 和完整 review；不为每个小项重复全量回归。核对两类用户、跳过范围、Selection/Provider 抽象及全部条目后再关闭。

## 调查起点

- `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations/0020-provider-model-selection.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations/0021-official-glm-selection.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-entries.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/session-store.ts`
- `apps/zcode-cli/packages/adapters/tests/provider-database-migration.test.ts`

已有内存探针只证明问题和筛选方向：首次／已迁未动的案例入选；后续消息、后续改选、不同模型、已有档位、最后 user 无档位、user 明确空选择均跳过。这不是正式修复实现或完整回归证据。

## 本轮实施与 review

- 确认最新编号仍为 0021，追加 `0022_backfilled_session_reasoning`，未改 0020/0021 SQL、checksum 或活动时间，未增加表/列。
- 新增 19 个真实临时 SQLite／启动 runner 用例，修复前均失败；修复后与原全库迁移、官方 GLM 迁移合批 **3 文件 / 29 tests 通过**。包含首次升级三种身份、已迁未动、后续活动/改选、空 options/null、旧平铺、不匹配/第三方大小写、最后 user 空/缺档位、坏 JSON、坏身份/非标准条目、失败整笔回滚与重试、重启不重跑。
- 存储正式 Reader 读取新增档位及原会话标题/消息；消息、Session、旧账本和选择条目时间逐项不变。原全库迁移回归继续验证回滚再升级缺新字段时历史可读。未操作真实用户库，不宣称真实桌面/手机端全量验收。
- 复审 SQL：先选择最后 user 再检查档位，不越过较新的空选择；只引用其新字段；冻结身份表与 0020/0021 对照，无实时 Registry/账号依赖；已有 options 不覆写，不试图修已继续使用的会话。
- 根 typecheck、Adapter typecheck 及架构门禁通过；新增 0022 文件单独 lint 通过，Adapter 全量 lint 被现有多处 max-lines 错误阻挡，不能视为全绿。批量最终回归与交付记录见 [执行账本](./provider-stabilization-20260911-execution.md)。

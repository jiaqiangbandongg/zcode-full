# Conversation Session E2E Plan

目标：把 `docs/conversation-session-case-catalog.md` 里的会话区状态枚举落成 WDIO E2E，并把线上桌面端验证与 Docker replay 验证分层。测试必须从用户路径进入：API Key 登录、配置 DeepSeek provider、切换 `deepseek-v4-flash`，再操作会话区。

逐条覆盖状态见：[conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md)。该矩阵只把有明确 setup/action/assert 的条目标记为自动化覆盖，避免把“场景路径经过了某状态”误判为“case 已验证”。

Goal 相关组合已经从主路径里单独拆出更细的专项矩阵：[conversation-session-goal-specific-coverage-matrix.md](./conversation-session-goal-specific-coverage-matrix.md)。主矩阵里的 `H` 只表示 goal 基础协议，不能替代 queue、compact、fork/edit、session/model、环境异常这些 goal 组合验证。

## 当前口径纠偏

当前不能只说“测试全过所以会话区没问题”。准确口径是：已写出的 WDIO spec 可以按各自命令统计通过率，形式化 case catalog 仍必须按覆盖矩阵逐条统计。

截至当前矩阵，A-J 共 153 条且均已 accepted；其中 104 条有自动化证据，49 条仍是 missing accepted case，当前 failing probe 和 undefined case 均为 0。也就是说，“某次测试命令全通过”只代表那批 spec 通过；描述形式化矩阵时必须同时报告 accepted、covered、partial 和 missing，不能把 pending legacy 证据或单批运行结果扩大成 formal gate 已闭环。

F09、G11、G12 的产品语义已于 2026-07-05 裁决，不再属于 undefined；尚未落成稳定自动化的条目继续以 `missing` 保留在覆盖矩阵中。

外部环境故障不计入 A-J 主路径统计，单独在 [conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md) 里跟踪。目前该 catalog 有 40 条产品 fault row 和 4 条测试基础设施 case；其中 3 条是 `F09/G11/G12` 的环境视角别名，已随源 case 裁决为 accepted/missing，去重后新增的 37 条外部故障产品 case 仍为 `decision-needed`，不能直接写成稳定通过断言。

## 分层

| 层                     | 用途                                 | 运行方式                                                                                                         |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| desktop capture        | 连接线上 DeepSeek，验证真实桌面链路  | `E2E_PROVIDER_HTTP_MODE=capture E2E_PROVIDER_API_KEY=... pnpm --filter @zcode/desktop test:e2e -- --spec <spec>` |
| desktop replay         | 本地快速认证，使用已录制 SSE fixture | `pnpm --filter @zcode/desktop test:e2e -- --spec <spec>`                                                         |
| docker replay-isolated | 隔离网络后的最终可复现认证           | `E2E_NETWORK_MODE=replay-isolated E2E_SPEC=<spec> bash scripts/test-desktop-e2e-container.sh`                    |

当前先放大桌面端 case，Docker 只作为阶段性认证，不阻塞 case 编写。

## Manual Review 流转

conversation 主路径 spec 先统一放在 `packages/desktop/test/e2e/conversation-session/manual-review/pending/`。这些 case 用来自动执行复杂用户路径、生成 UI / network / log / session artifact，再由人确认产品预期；它们不参与默认 conversation 质量门禁。

流转规则：

1. 新枚举或尚未人工确认的 case 进入 `manual-review/pending/`。
2. 人工 review 时只要求 case 能跑到观察点并留下证据，不用把所有预期写死成断言。
3. 产品预期确认后，补充确定性断言和需要的 `data-testid` / 协议 / 日志 / 抓包 / snapshot 校验。
4. 断言稳定后，把 spec 移回 `packages/desktop/test/e2e/conversation-session/`，并同步更新 [conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md)。

WDIO 默认全量 E2E 会排除 `manual-review`；显式传入 `manual-review` spec 或设置 `ZCODE_E2E_MANUAL_REVIEW=1` 时才运行这些人工 review case。`ZCODE_E2E_MANUAL_REVIEW=1` 且没有显式 `--spec` 时，默认只运行 `manual-review/**/*.test.ts`。

## Spec 拆分

下表中的短文件名混合记录默认 conversation-session 目录下的正式 spec，以及
`manual-review/pending/` 下尚待确认的候选 spec。人工确认并升格后，文件会回到默认
conversation-session 目录，并在覆盖矩阵里更新为正式路径。

| Spec                                                       | Catalog 覆盖                              | 当前优先级 | 说明                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-session-first-send.test.ts`                  | A01、C01、C03                             | P0         | 首发建 session、完成后下一轮                                                                                                                       |
| `conversation-session-prewarming-queue.test.ts`            | A02                                       | P0         | 首轮请求已发出但首个 SSE event 尚未返回时继续发普通文本，必须进入 queue，不能打断首轮                                                              |
| `conversation-session-running-queue.test.ts`               | A03-A08                                   | P0         | running 中普通文本、`/goal`、`/compact` 按各自 command kind 入队，不启动并行 compact                                                              |
| `conversation-session-running-actions.test.ts`             | A09、A10、E06 running 分支、K02、K03、K10 | P0         | running 中 stable assistant fork 仍按目标稳定性裁决；最后一轮 real user query 可 edit 并抢占当前 turn，历史 query 不显示 edit；历史 assistant 回复不显示 retry |
| `conversation-session-stop-held-queue.test.ts`             | B02-B04、B06                              | P0         | stop 后 held queue 保留、不自动消费；继续输入仍追加队尾                                                                                            |
| `conversation-session-stop-empty.test.ts`                  | B01、B05                                  | P0         | stop 后 queue=0 进入 interrupted completed，后续普通文本立即下一轮                                                                                 |
| `conversation-session-queue-operations.test.ts`            | B09-B11                                   | P0         | held queue 编辑、重排、删除只影响 queue 本身，不触发消费                                                                                           |
| `conversation-session-compact-manual-queue.test.ts`        | F01、F03、F08、C08、C09                   | P0         | 手动 compact 与 held queue 共存；stop 后 held queue 不自动消费，compact 成功后也不自动消费；success completed 的 held queue 下继续输入只追加       |
| `conversation-session-compact-actions.test.ts`             | F04-F07、H05、K05、E06 compacting 分支    | P0         | compacting 中普通输入和 `/goal` 入队、重复 `/compact` reject、stop compact、fork 禁止                                                              |
| `conversation-session-interrupted-actions.test.ts`         | D02、E02、E03                             | P0         | interrupted 后允许 edit；被 stop 的 assistant partial 不提供可用 fork 入口；held queue 保留在父 session 且不自动消费                              |
| `conversation-session-edit.test.ts`                        | D01、D03-D08、D10                         | P1         | edit 最新 real user query 重跑、queue 保留、running 中普通文本和 `/goal` 入队、running latest edit 抢占重跑、assistant 不可 edit、interrupted 后 edit rerun 不触发 turnIndex 解析错误 |
| `conversation-session-fork.test.ts`                        | E01、E04、E06 running 分支、K06 user 分支 | P1         | completed success 下 assistant fork；user 不提供 fork；running 中禁止 fork                                                                         |
| `conversation-session-tool-actions.test.ts`                | D09、E05、K06 tool 分支、K07 tool 分支    | P1         | 用真实 Read tool block 断言 tool call block 内不暴露 edit/fork 入口                                                                                |
| `conversation-session-goal.test.ts`                        | H01-H04、H06、B07                         | P1         | goal 设置/更新、running 与 held queue 中入队；H02 从 verifier 自然完成后的 completed target 更新，不用 stop 收尾态造数；goal continuation/验证窗口不产生独立 `validating` lock |
| `conversation-session-goal-queue.test.ts`                  | Goal 专项 G1                              | P1         | 多个 queued goal、text/goal/compact 混合、goal 队列项编辑/删除/重排、立即引导 goal 消费顺序                                                        |
| `conversation-session-goal-session-model.test.ts`          | Goal 专项 G0/G1/G3/G4                     | P1         | queued goal 消费使用最新模型/思考深度；goal running/queued goal 切换 session 不串；新草稿只断言不继承历史 goal/queue；goal running 中历史 assistant fork 禁用 |
| `conversation-session-goal-run-cases.test.ts`              | Goal 人工判定组合                         | P1         | manual-review live probe：请求 capture 只作为证据；已有 goal 更新接受新 goal 进入 queue 或 target；已有 paused target 下普通输入未形成 running 窗口、manual/auto compact 与 goal controls 恢复等采集只记录 outcome |
| `conversation-session-turn-steer-probe.test.ts`            | M01-M05                                   | P1         | `manual-review/pending` 候选在 queue 行为下保留首轮 running/tool 窗口里 text、`/goal`、`/compact` 的硬断言证据；不参与默认 conversation gate |
| `conversation-session-model-switch-queue.test.ts`          | 模型切换交叉：queue / held queue          | P1         | running 中 queued text 消费前切模型；stop 后 held queue 切模型再“立即发送”，均以网络请求断言消费时模型/思考深度                                    |
| `conversation-session-model-switch-compact.test.ts`        | 模型切换交叉：manual compact              | P1         | completed 后切 secondary 再 `/compact`，断言 summary 使用 secondary 模型；summary 思考档按 compact 链路默认 high 口径观测                         |
| `conversation-session-model-switch-auto-compact.test.ts`   | 模型切换交叉：auto / guard compact        | P1         | 已迁移 V4 helper 与 stream-first 断言；N05 confirm/cancel 当前稳定暴露“无 guard 弹窗、直接切模型”的产品缺口；N06 只有真实触发 marker 时断言不中断，健康 no-op 时只证明 pendingAction 正常继续 |
| `conversation-session-model-switch-tool-edit-fork.test.ts` | 模型切换交叉：tool / edit / fork          | P1         | tool prompt 窗口切模型先做可执行探针；completed 后切模型再 edit/fork 后续请求，断言使用 secondary 配置                                             |
| `conversation-session-config-and-multisession.test.ts`     | J01-J04                                   | P1         | 多 session 并发、active session 可见消息隔离                                                                                                       |
| `conversation-session-model-config.test.ts`                | I01-I05、J05                              | P1         | 已打开并通过：断言 session 级模型/思考深度恢复、新建继承、queue 消费使用当前 session 配置、inactive session 不被 active 草稿污染                   |
| `conversation-session-compact-interrupted.test.ts`         | F02                                       | P1         | completed interrupted 下仍允许手动 compact                                                                                                         |
| `conversation-session-compact-auto.test.ts`                | G01-G04、G08-G10                          | P2         | manual-review live probe：触发 auto compact 时断言其前置于 pendingAction；未达到 needsCompact 时记录 no-op 并证明 pendingAction 正常继续            |
| `conversation-session-compact-auto-actions.test.ts`        | G05-G07                                   | P2         | auto compact 进入 `started` 时覆盖长任务窗口里普通文本和 `/goal` 入队、重复 `/compact` reject；健康 no-op `skipped` 时只断言 marker 与 pendingAction |

2026-07-15 compact transport 迁移说明：

- `conversation-session-compact.test.ts`、`conversation-session-model-switch-compact.test.ts`
  当前仍断言 compact 为 non-stream；
- `conversation-session-model-switch-auto-compact.test.ts` 已改用 V4 helper，并把可达的正常 success
  收紧为唯一 streaming SSE 腿；实跑 N06 健康 no-op 通过，N05 confirm/cancel 因产品缺少 guard 弹窗失败，
  该失败发生在 compact transport 之前；
- 前两者在改成“正常 success 为唯一 streaming 腿”的断言并复跑前，不计入 compact transport 覆盖或
  转正准入；MG 因 N05 产品缺口同样不作为 transport 证据；
- stream failure 后的 non-stream fallback 顺序由正式 `conversation-session-compact-stream-fallback.test.ts`
  单独证明，不在上述正常 success case 中兼容两种 transport。

## 最小断言合同

每条 case 至少包含：

- UI：使用 `data-testid` 和 `data-*` 断言，不用截图作为通过条件。
- Error Banner：正向 / 非故障 case 默认必须断言没有 `ChatViewErrorBanner` / `ChatErrorBanner`；只有 case 明确声明 fault、negative、error recovery 或 provider/network failure 时才允许出现，并且必须断言错误来源、可 dismiss 状态和后续 queue / action 状态。
- Network：DeepSeek capture/replay 里能证明是否发起模型请求，以及请求顺序。
- Runtime DOM projection：`chat-view` 的 `data-session-id`、`data-state`、`data-queue-count`。
- Queue：`chat-queue-item-*` 的内容、kind、status、顺序。
- Message：`chat-user-message-*`、`chat-assistant-message-*` 的 message id、role、文本。

## 当前已落地的断言与候选合同

- `conversation-session-turn-steer-probe.test.ts` 曾于 2026-06-24 转入默认 conversation E2E，V4 迁移后已重新降级到 `manual-review/pending`。当前文件名仍会命中 WDIO 的 guide seed，因此 spec 前置通过设置页切回 `queue`，以硬断言保留 M01-M05 的候选执行证据；这些证据不代表当前 V4 版本已完成人工 review、formal replay 或 Docker admission。M06 guide/steer 语义继续由 pending `conversation-session-running-guide-steer.test.ts` 提供相邻历史证据。
- running 中普通输入、`/goal` 和 `/compact` 必须按各自 command kind 进入同一权威 queue；`/compact` 显示 queued toast 和维护命令项，不作为普通 user message，也不能绕过 queue 启动并行 compact。
- prewarming 是首轮请求已发出但模型首个 SSE event 尚未返回的窗口；该窗口继续发普通文本必须进入 renderer queue，不能打断首轮，也不能提前发出第二次模型请求。
- 首发或下一轮刚进入 streaming 时，`activeInputId` 是 session 正在消费输入的 owner 标记；自动 drain 必须同时检查 runtime busy、`activeInputId` 和 streaming assistant 占位，避免触发 `A prompt is already running for this session`。
- stop 后存在 queue 时，queue 进入 held 状态，默认不自动消费；只有队列项“立即发送/继续队列”会显式请求 stop 后 drain。
- stop 后 runtime 已完成且清掉 `activeInputId` 时，允许用户发 `/compact`；不能被 stale composer `streaming` 状态误判为仍在 running。
- 手动 compact 如果历史不足，terminal marker 可以是 `skipped`；成功路径 E2E 需要先构造至少两轮已完成历史，再断言 `started -> completed`。
- fork 入口对 ZCode agent provider 开放，但只允许稳定 `completed(success)` assistant message；被 stop 的 interrupted partial 不提供可用 fork 入口。fork 后切换到派生 session，父 session queue 不复制。
- user query edit 是显式重跑动作；stop 后 held queue 存在时仍应立即重跑，queue 保留且不自动 drain；assistant/tool 不暴露 edit 入口。
- tool call 预期渲染为 assistant message 内部的 `TID_CHAT_TOOL_CALL_BLOCK`，不是独立 message；tool 负向能力断言只检查 tool block 内没有 edit/fork 入口，assistant message 自身的 fork 入口按 assistant 规则另行判断。
- edit 重跑 running 中，后续普通文本和 `/goal` 都只能进入 queue，不能抢占当前重跑 turn。
- held queue 不是稳定 completed assistant fork/edit 的禁用理由；同 session 正在 compacting 时禁止 fork/edit，running 时 latest real user query edit 走 stop barrier，历史 user query 不提供 edit，历史 assistant 回复不提供 retry；被 stop 的 interrupted assistant partial 也不能 fork。
- `/goal` 在 completed 下设置或更新 session goal，并继续启动 goal continuation；同 session running 或 stop 后 held queue 存在时，`/goal` 只作为 `goal` 队列项追加，不能抢占当前 turn，也不能绕过 held queue 自动发起请求。
- `/goal` continuation 被 Stop 取消后，UI runtime 必须退出 streaming，且 `activeInputId` 必须清空；当前 E2E 只断言目标内容保留，不把 target `active/paused` 写死。
- goal continuation/验证窗口不应该暴露独立 `validating` 产品状态来锁住用户操作；UI `chat-view` 的 target status 在该窗口仍按目标本身状态表达，例如 `active`。
- compacting 是同 session 的长任务状态，不允许 fork 或再次 `/compact`；但普通文本和 `/goal` 可以进入 queue。手动 stop compact 后 marker 进入 `interrupted`，queue 保留，且默认不自动消费。
- 多 session 是真实并发：A running 时切到 B/C 并发送 prompt，B/C 必须能分别进入 running；inactive session 的 streaming event 不允许覆盖当前 active session 的 `chat-view`、可见消息或 sidebar selection。
- 模型和思考深度是 session 级配置：切到历史 session 时工具栏必须恢复该 session 的 model/thought；新建 session 继承用户上一次选择；queue 真正消费时必须使用当前 session 最新配置，且其他 session 的配置变化不能污染 inactive running session。
- 模型切换是横向交叉维度：除基础 session 配置外，已补 queue auto-drain、held queue send-now、manual compact、auto compact、model switch context guard compact、tool prompt、edit rerun、fork 后续请求的 E2E probe；其中 N05 guard compact 当前是明确 failing probe（V4 没有弹窗），不能表述为可执行通过；tool prompt、auto compact pendingAction 和 guard compact 之后是否完成目标模型切换仍待确定性 replay 收口。
- DeepSeek replay fixture 支持按最后一条 user message 匹配；stop-held 的“立即发送队列项”另有优先 fixture，避免历史里的慢流式标记让回放误走 90 秒慢流。
- 自动 compact replay 使用低 context window 的 spec 级模型配置触发 `needsCompact`；fixture 用 `maxMatches` 表达“前两次 compact summary 失败、第三次成功”的请求序列。`manual-review/pending` 的 live auto compact case 不强行制造低窗口，未触发 marker 时只记录 no-op 路径。
- edit 重跑前的自动 compact 必须作为系统前缀维护步骤出现：在 replay/确定性低窗口 case 中网络请求顺序必须是 compact summary 请求先于 edit 后用户 query 的主模型请求；`manual-review/pending` live probe 若未捕获对应请求 body，则以 UI/session 完成和 marker/artifact 记录为准。
- Goal manual-review 组合的线上请求 capture 不是唯一通过条件：已有 goal 更新时，新 `/goal` 可以先进入 queue 或直接成为 target；已有 paused target 后的普通输入可能先保留为 queue 而不形成 running 窗口；manual/auto compact 相关场景里，seed 造数消息可能因线上流量迟迟不 idle 而被 stop，compact marker/outcome 只做短窗口观察，compact 前后或 compact 窗口中 composer 若仍未恢复输入，只记录 compact marker、queue 和 chat snapshot；completed goal 后控件恢复采集也只把 goal 请求命中作为证据，不把抓包 miss 或造数/元素等待超时作为产品失败。

## 当前未定义项

- F09：手动 compact failed 后 session 是 `completed(success)`、`completed(interrupted)`、`error`，还是保持 completed 并只标 failed marker。
- G11：自动 compact 连续 3 次失败后，pendingAction 是丢弃、入队并暂停，还是继续无压缩执行。
- G12：自动 compact 被 stop 后，pendingAction 是丢弃、入队并暂停，还是保持待执行。

## 已知限制

- 线上 capture 需要真实 `E2E_PROVIDER_API_KEY`；没有 key 时只能跑 replay 认证。
- 自动 compact 3 次 retry 已有 replay 覆盖；429/503、断网、磁盘满、app/agent 关闭恢复这类环境 case 已进入外部故障 catalog，但必须先确认产品预期，再用 mock/replay 构造稳定断言。
- Undefined case 先不写自动化：F09、G11、G12。
- 已确认的产品协议说 Stop 后没有独立 paused 产品态，但当前 agent core 仍会把 active goal target 标记为 `paused`；这需要单独决策后再收紧 E2E 断言。
- 文件变更摘要 toggle / rewind 需要稳定的 tool-writing replay fixture；现有 DeepSeek 文本 fixture 不能可靠产出 `fileChanges`，暂不纳入第一批桌面回放认证。

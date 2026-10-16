# V4 Guide 与 Goal Queue 消费边界实施计划

> 本计划先冻结产品语义和证明范围，再进入实现。实现阶段必须按任务清单先补测试、再改代码。

**Goal:** 恢复 V4 的“引导”提交入口，并把 guide 与普通 queue 拆成两条可机械验证的消费路径：guide 只在完整 tool result batch 落事实后注入当前轮；普通 queue 只在 session ready，且当前 goal 不存在或 target 已 `complete` 时自动消费。verifier fail-open 视为通过，手动终止 verifier 不视为通过。

**Architecture:** CLI/runtime 继续拥有唯一 `CommandInbox` 与 conversation product facts。guide 是当前 turn 的 inline delivery，普通 queue 是未来 turn 的 promotion；两者共享输入身份和 FIFO admission，但不共享 drain trigger。desktop `continuous` 与 mobile `replayable` 只改变投递/恢复方式，不改变消费 guard。

**Tech Stack:** TypeScript、ZCode V4 protocol、CLI core/runtime、bootstrap projection、React 19、Vitest、WDIO controlled-stream E2E。

## Feature Summary

| Field | Value |
| --- | --- |
| Change | 恢复 V4 guide 提交；普通 queue 延迟到 goal verify pass（含 fail-open）并完成 target 更新后消费 |
| User-visible surfaces | Settings 的“引导”偏好、V4 Composer、queued prompt 列表、goal status panel |
| Existing docs | `docs/chat/interaction-behavior.md`、conversation protocol/state space、case catalog、E2E matrices、V4 protocol spec |
| Existing code owners | `packages/ui/src/v4`、CLI core runtime steering/turn loop、bootstrap V4 bridge、contracts projection |
| Out of scope | 跨端全局 FIFO、relay/main 持有业务 queue、CLI restart 自动重放、扩大附件 guide 能力、重新设计 Stop/立即发送 |

## Clarification Log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | fail-open 是否等于手动终止 verifier；普通 queue 是否必须等 goal 通过 | fail-open 是 verifier 自身异常后按通过收口；手动终止不是通过；其余推荐语义确认 | fail-open 走 `passed=true`，cancel/abort 走 paused/cancelled | no |
| 2 | 没有 tool 的 guide、多条 guide、Stop/paused/budget-limited、混合 queue kind 如何处理 | 均接受推荐方案 | 无 tool 回退 queue；每批最多一条 guide；非 complete goal 持续阻塞所有普通 queue kind | no |
| 3 | parallel tool call、tool 前提交 guide、eligibility fallback、desktop/mobile 是否共享产品终态 | 均接受推荐方案 | 等完整 tool batch；guide 可提前等待；沿用 eligibility；两端共享 CLI 事实 | no |
| 4 | guide 是否需要按模型/provider 限制 | 不需要；这是 runtime 的通用 model-step continuation | 模型/provider 从 eligibility 中删除；此前“沿用 eligibility”的 provider 部分被本轮决定覆盖 | no |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| Guide trigger | 仅在一次 model step 的全部 sibling tool results 已提交后，最多消费一条 guide | 单 tool、parallel tool、成功/失败 tool result | text-only completion、单个 sibling 提前完成 | user + protocol |
| Guide no-tool fallback | 当前 turn 在未出现可用 tool batch 的情况下收口，原 guide intent 原地改投普通 queue | 保留原文、附件、client、IDs、admission order | 丢弃、另建新 intent、终态后仍永久等待 guide | user |
| Guide eligibility | 模型/provider 无关；不适用时回退 queue | 任意模型/provider、无附件、无既有 queue、未 Stop 的 eligible running turn | 本轮扩大 attachment steer 能力 | current user decision + runtime architecture |
| Ordinary queue trigger | 只在 session ready 后自动提升；存在 target 时还必须 `target.status=complete` | text、goal command、compact 共用 FIFO gate | tool result 边界直接 drain、verification marker 单独 drain | user |
| Fail-open | verifier 基础设施/输出/工具误用异常返回 `passed=true`，随后完成 target，等同显式 pass | fail-open 记录、target complete、正常 queue drain | 绕过 target update 的特殊 drain 分支 | user + code |
| Manual verifier stop | cancelled/aborted，target paused，queue 保留且 `autoDrain=false` | Stop 与独立 pause 的既有语义 | 当作 fail-open 或 pass | user |
| Explicit send-now | 保留现有显式抢占例外 | reservation、Stop barrier、selected item promotion | 受普通 auto-drain goal gate 约束 | user + existing protocol |
| Transport | desktop/mobile 收敛到相同 CLI facts | desktop-continuous、web-remote-replayable live/cold 等价 | relay/main 新业务状态、双队列 | architecture docs |

## Domain Scope

| Domain | Include? | Why it can change behavior | Primary sources |
| --- | --- | --- | --- |
| conversation/session runtime | yes | guide 注入与 queue promotion 都改变 turn 边界 | CLI core turn loop/steering |
| goal/target | yes | queue gate 依赖 target terminal status | target verifier + bootstrap bridge |
| V4 command/projection | yes | delivery fallback 和 queue 状态必须 live/cold 一致 | contracts + bootstrap projection |
| UI/composer | yes | 当前 V4 `mode=guide` 禁用了按钮和 Enter | `ConversationComposer` / `SessionPane` |
| tool lifecycle | yes | guide 的唯一 inline drain boundary 是完整 tool batch | runtime tool execution |
| remote/replay | yes, representative | 证明同一 CLI fact 在 continuous/replayable 不分叉 | architecture + bootstrap tests |
| relay/main process | no | 只透传，不拥有 queue/goal/stream 业务状态 | remote architecture |
| workspace identity | no new behavior | 本功能按 session 隔离，不新建 workspace key | architecture constraints |
| model/provider eligibility | pruned invariant | runtime 在 model-step 边界追加统一 user history，不依赖 provider 原生 steer | current user decision + core runtime |

## High-Risk Cross-Products

| Cross-product | Candidate risk | Initial handling |
| --- | --- | --- |
| guide × single/parallel/failed tool result | sibling 未完成就注入，或失败 result 永远不触发 | 枚举 single、parallel、failed result 三个代表 |
| guide × text-only/Stop | guide 永久悬空或丢失 | accepted fallback-to-queue case |
| queue kind × goal target status | 只 gate text，goal/compact 越权消费 | 枚举 mixed FIFO，一个共同 gate |
| verifier result × target update | verification marker 与 target complete 竞态 | 显式 pass、fail-open、manual cancel 三代表 |
| guide × active goal phase | 引导误 Stop target，或 verifier 被当可 steer turn | output/continuation 可 guide；verifier busy fallback queue |
| delivery × client profile | desktop 与手机产生不同产品终态 | 业务 case 不做全排列；用 live/cold projection 等价证明 |

## Concept Map

| Concept | Why it matters | Source |
| --- | --- | --- |
| `ConversationInputIntent` | queue/guide 共享的输入身份；fallback 不能换 ID 或顺序 | V4 protocol spec |
| `delivery.admitted` | 决定 inline guide 还是 future queue | V4 protocol spec |
| `CommandInbox` | desktop/mobile busy input 的唯一 FIFO authority | protocol declaration |
| tool result batch | guide 可以进入当前 turn 的唯一提交边界 | CLI runtime |
| session ready | 普通 queue promotion 的第一层 guard | conversation behavior |
| `target.status` | goal queue promotion 的第二层 guard | target contracts |
| `autoDrain` | 普通 queue 是否已武装 | queue projection |
| explicit send-now reservation | 用户主动绕过自动消费等待的显式路径 | protocol declaration |

## State Owners

| State / fact | Authority | Mirrors / caches | Evidence |
| --- | --- | --- | --- |
| queue/guide intent、admissionSeq | CLI CommandInbox/session input ledger | V4 QueueState、renderer projection | command ACK + live/cold snapshot |
| tool batch completion | CLI core runtime | tool rows/timeline | ordered runtime facts |
| target status | CLI target store | V4 goal projection、task meta compatibility mirror | target changed event + snapshot |
| session ready/active controller | CLI/bootstrap runtime | V4 control projection | controller lifecycle + snapshot |
| followup preference | app setting，已打开 session 同步到 CLI config | V4 config projection | setting + command ACK |

## Delivery State And Event Order

guide 与 queue 共享 admission，但从 admission 之后立即分流：

```text
sendText while running
  -> CLI admission: stable sourceCommandId + queueItemId + admissionSeq
  -> delivery decision
       |
       +-- guide eligible
       |     -> wait for next complete tool result batch
       |     -> commit every sibling ToolCallResult
       |     -> drain exactly one guide inline
       |     -> persist guided user fact
       |     -> next provider request of the same product turn
       |
       |     no usable tool batch before turn terminal
       |     -> reclassify the same intent to queue
       |
       +-- queue / guide ineligible
             -> ordinary queue
             -> wait for session ready
             -> target absent OR target.status=complete ?
                    no  -> keep FIFO unchanged
                    yes -> promote one head item by original kind
```

Goal verification 的提交顺序必须单向推进：

```text
explicit verifier pass ─┐
                        ├-> verification passed=true
verifier fail-open ─────┘        -> target.status=complete
                                      -> session ready
                                      -> ordinary queue may drain

manual verifier Stop/abort
  -> verification cancelled/failed
  -> target.status=paused
  -> queue retained, autoDrain=false
  -> no automatic drain
```

## Dimensions

| Dimension | Values / equivalence classes | Source | Include? | Reason |
| --- | --- | --- | --- | --- |
| delivery | queue、guide、guide→queue fallback | product setting/protocol | yes | 核心变化 |
| tool batch | none、single、parallel、failed-result | runtime | yes | guide boundary |
| guide count | one、2+ | user decision | yes | 每批一条、FIFO |
| goal status | none、active、paused、budget_limited、complete | target contracts | yes | ordinary queue gate |
| verifier terminal | explicit pass、fail-open、fail/continue、manual cancel | verifier runtime | yes | pass/cancel 区分 |
| queue kind | sendText、sendGoalCommand、compact、mixed | CommandInbox | yes | gate 不得只覆盖文本 |
| queue action | auto drain、resume、send-now | protocol | yes | send-now 是明确例外 |
| client profile | desktop-continuous、web-remote-replayable | remote architecture | representative | 不复制业务笛卡尔积 |
| provider/tool name | eligible provider；readonly representative tool | current eligibility/tool matrix | representative | 不扩产品支持面 |

## Candidate Combinations

| Candidate ID | State | Event | Target/surface | Expected guard/effect | Initial status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GDQ-01 | running + followupMode=guide + eligible | Composer submit/Enter | V4 UI/command | 按钮和 Enter 可提交；accepted 后才清空 | bug-candidate | 当前 V4 composer 将 guide 当 disabled |
| GDQ-02 | eligible guide waits + single tool | tool result committed | current turn | result 后 inline drain 一条 guide，再发下一 provider request | accepted | 核心顺序代表 |
| GDQ-03 | eligible guide waits + parallel tools | last sibling result committed | current turn | 所有 sibling result 先落事实，之后最多一条 guide | accepted | 不按单个 tool 提前 drain |
| GDQ-04 | 2+ guide intents + repeated batches | each batch completes | CommandInbox/current turn | 每批一条，按 admission FIFO | accepted | 不一次清空全部 guide |
| GDQ-05 | guide admitted + text-only terminal | turn completes without tool | queue | 同一 intent 原地 fallback queue | accepted | 保留 IDs/order |
| GDQ-06 | guide requested but ineligible | admission/runtime reject | queue | 同一 intent fallback queue + reason | accepted | provider/attachment/existing queue/Stop/compact/verifier |
| GDQ-07 | active goal output/continuation + eligible guide | guide submitted, tool batch completes | goal current turn | inline guide；不 Stop/pause target，不等 verifier pass | accepted | verifier request 本身不 steer |
| GQD-01 | queue>0 + target active/paused/budget_limited | session becomes otherwise ready | queue | 所有 kind 保留，不启动 provider/goal/compact | bug-candidate | 当前 ready drain 缺 target gate |
| GQD-02 | queue>0 + explicit verifier pass | target becomes complete | queue | ready 后按 FIFO 自动提升 | accepted | marker alone 不够 |
| GQD-03 | queue>0 + verifier fail-open | target becomes complete | queue | 与显式 pass 同终态、同 drain | accepted | 不增加特殊 bypass |
| GQD-04 | queue>0 + manual verifier cancel | target becomes paused | queue | queue held；不自动 drain | accepted | cancel 不等于 fail-open |
| GQD-05 | mixed text/goal/compact queue + active goal | target complete | queue | 三种 kind 共用 gate，随后保持原顺序和语义 | accepted | compact 不生成 user row |
| GQD-06 | queue>0 + no target | session ready | queue | 按既有 ready/autoDrain 规则消费 | accepted | 无 goal 回归 |
| GQD-07 | noncomplete target + queued item | explicit send-now | selected item | reservation + Stop barrier + promote | accepted | 明确例外，不是 auto-drain |
| GQD-08 | queue>0 + autoDrain=false + noncomplete target | user resumes queue | queue | 只设置 autoDrain=true；仍等待 target complete | accepted | “继续”不是显式 send-now |

## Pruning Decisions

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| --- | --- | --- | --- | --- |
| P-01 | 每个具体 tool 名 × guide | guideAfterCompletedToolBatch | 消费边界只依赖 batch terminal，不依赖工具业务 | readonly success + failed result + parallel batch |
| P-02 | desktop/mobile × 全部业务状态 | trustedDeliveryBoundary | 两端共享 CLI facts，传输恢复维度独立 | desktop E2E + bootstrap live/cold equivalence |
| P-03 | active/paused/budget_limited 分别 × 每种 queue kind | incompleteGoalBlocksQueueDrain | 都是 `status !== complete` 同一 guard | mixed FIFO + status reducer/unit representatives |
| P-04 | fail-open 的每种底层异常 | verifierFailOpenCompletesTarget | 格式/网络/工具误用共享 `passed=true` contract | 一种 deterministic fail-open E2E + contract unit cases |
| P-05 | 每个模型/provider × guide | guideIsModelAgnostic | runtime 不改写 in-flight request；统一在 model-step 边界追加 user history | 非 GLM bootstrap 代表回归 |
| P-06 | relay/main queue state | cliOwnsConversationProjection | 业务状态不得下沉到 relay/main | architecture/static review |
| P-07 | guide 扩展到附件 | guideModeEligibilityGuard | 本轮不扩大附件 steer 能力 | attachment fallback case |

## Questions For User

| Question ID | Candidate(s) | Need to decide | Options | Impact |
| --- | --- | --- | --- | --- |
| Q-01 | GDQ-05 | 无 tool 时 guide 是否丢弃/等待/回退 | 已决定：回退普通 queue | resolved |
| Q-02 | GDQ-03/04 | parallel/multiple guide 的消费粒度 | 已决定：完整 batch 后、每批一条 | resolved |
| Q-03 | GQD-03/04 | fail-open 与手动 cancel 是否等价 | 已决定：不等价；只有 fail-open 通过 | resolved |

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| GDQ-01 | eligible running V4 session，setting=guide | button/Enter send | command accepted；composer clears after ACK；guide fact appears | UI + command | missing |
| GDQ-02 | provider step returns one readonly tool call，guide already admitted | commit tool result | `ToolCallResult < TurnSteerDrained < next provider request` | runtime + protocol + network | missing |
| GDQ-03 | provider step returns parallel tool calls | complete siblings in varied order | every sibling result precedes one drain；无 second guide drain | runtime + protocol | missing |
| GDQ-04 | two guide intents and two tool batches | complete both batches | exactly one per batch；source IDs and FIFO preserved | runtime + projection | missing |
| GDQ-05 | guide admitted，provider returns text-only terminal | finish turn | delivery changes to queue in place；later obeys ordinary queue gate | runtime + live/cold projection | missing |
| GDQ-06 | attachment/existing queue/verifier busy representative | submit guide preference | accepted as ordinary queue with fallback reason；payload preserved | command + projection | partial |
| GDQ-07 | active goal continuation uses tool | submit guide and complete batch | guided row in same turn；target remains active；no Stop | UI + runtime + network | missing |
| GQD-01 | active target + mixed FIFO queue | current active work settles without target completion | no queue promotion/provider request | runtime + projection + network | missing |
| GQD-02 | same setup | verifier explicitly passes | target complete precedes FIFO promotion | runtime + protocol + UI | missing |
| GQD-03 | same setup + deterministic verifier malformed result | trigger fail-open | passed=true；target complete；FIFO promotion | runtime + protocol + logs | missing |
| GQD-04 | verifier streaming + queue | user Stop | verifier cancelled；target paused；autoDrain=false；no promotion | UI + runtime + network | missing |
| GQD-05 | queue order text→goal→compact | target completes | each item starts by original kind and original order | protocol + timeline + network | missing |
| GQD-06 | no target + normal queue | session becomes ready | existing FIFO auto-drain unchanged | regression E2E | partial |
| GQD-07 | active target + queued item | click send-now | target/current work stops；selected item starts once；others retain order | UI + runtime | covered adjacent |
| GQD-08 | paused queue + paused/active target | click queue resume | autoDrain becomes true but no promotion；target complete 后才 drain | UI + runtime + projection | missing |

## Matrix Backfill

| File | Change |
| --- | --- |
| `docs/conversation-session-case-catalog.md` | 扩充 H08/H12 与 M06a-g，记录 fail-open/cancel、完整 tool batch、每批一条、V4 composer 与无 tool fallback |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | 把旧 guide “covered”降为真实缺口，拆分 M06a-g；H08/H11/H12 对齐新 guard |
| `docs/testing/conversation-session-goal-specific-coverage-matrix.md` | G1-10/G1-13/G1-14 增加 pass/fail-open/cancel 与 UI 恢复缺口 |
| `docs/testing/conversation-session-tool-cross-product-matrix.md` | 增加 guide × tool-batch 的代表等价类，不按全部 tool 名爆炸 |
| `docs/conversation-protocol-declaration.md` | 新增 guide batch、fallback identity、incomplete goal queue gate 不变量 |
| `docs/conversation-product-state-space.md` | 增加 delivery/toolBatch/verifier terminal 维度与规则 |

## Implementation Tasks

### Task 1: Focused Tests First

**Files:**

- Modify: `packages/ui/test/*ConversationComposer*.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/*steer*.test.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/tests/v4-native-queue.test.ts`
- Modify: contracts/projection focused tests

- [ ] 增加 V4 guide mode 按钮、Enter、ACK 后清空测试，并确认当前实现失败。
- [ ] 增加完整 tool batch 后一条 guide 的事件顺序测试。
- [ ] 增加多 guide 每批一条、text-only fallback、ordinary queue 不在 tool boundary drain 测试。
- [ ] 增加 active target 阻塞 text/goal/compact、queue resume 只武装、explicit pass/fail-open drain、cancel no-drain 测试。

### Task 2: Restore V4 Guide Composer

**Files:**

- Read first: `DESIGN.md`
- Modify: `packages/ui/src/v4/ConversationComposer.tsx`
- Verify: `packages/ui/src/v4/SessionPane.tsx`

- [ ] `inputRouting.mode=guide` 保持正常 composer/button/Enter 可提交，不增加第二套输入框。
- [ ] 保留 attachment readiness、Plan-mode、held queue choice 与 ACK-before-clear 现有 guards。
- [ ] guide 不适用由 CLI 返回同 intent 的 queue fallback，UI 不自行制造第二队列。
- [ ] UI 日志如有新增统一使用 `packages/ui/src/logger.ts`。

### Task 3: Split Inline Guide From Ordinary Queue Drain

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`
- Modify: tool execution/model-step runtime methods

- [ ] 删除 generic round-trip 对普通 queue 的 inline drain 能力。
- [ ] 在完整 tool result batch 持久化/提交之后检查 guide 队首，最多 drain 一条。
- [ ] 保证 parallel siblings 全部完成后才 drain；失败 tool result 与成功 result 使用相同 terminal boundary。
- [ ] text-only/Stop/terminal 前仍未 drain 的 guide 原地 reclassify 为 ordinary queue。
- [ ] 高频 tool/steer 顺序日志只使用 `debug`，中文注释解释旧实现为何会过早消费。

### Task 4: Add Durable Guide Fallback Fact

**Files:**

- Modify: contracts turn-steer events/reducer/schema
- Modify: core persistence adapters
- Modify: bootstrap live/cold projection

- [ ] 优先新增明确的 delivery-changed/fallback fact，不用“重复 queued event”暗示原地改投。
- [ ] 事件携 `queueItemId/sourceCommandId/requested/admitted/reasonCode`，严格 schema 校验。
- [ ] reducer 原地更新 intent，保留 admissionSeq、payload、attachments、clientId 和 FIFO 位置。
- [ ] live projection、cold hydration 和 session-input ledger 收敛到同一结果。

### Task 5: Gate Ordinary Queue On Target Completion

**Files:**

- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`
- Reuse: target completion verification/fail-open contracts

- [ ] 将普通 auto-promotion guard 收敛成一个可单测 helper：head queued + autoDrain + no active controller + session ready + (`target=null` 或 `target.status=complete`)。
- [ ] 所有 `sendText/sendGoalCommand/compact` 都通过同一 helper，禁止 kind-specific bypass。
- [ ] target 更新与 controller 清理后都重新评估，避免 pass 已完成但无人唤醒 drain。
- [ ] fail-open 不增加特殊 drain；复用 `passed=true -> target complete`。
- [ ] manual cancel/Stop 保持 target paused、queue retained、autoDrain=false。
- [ ] `sendQueuedNow` 继续保留 reservation + Stop barrier 的显式例外。

### Task 6: Runtime And E2E Proof

- [ ] controlled-stream：V4 设置 guide 后真实按钮/Enter 提交。
- [ ] controlled-stream：single tool 与 parallel tool batch 顺序。
- [ ] goal queue：explicit fail→continue→pass 后 drain。
- [ ] goal queue：deterministic fail-open 后 target complete/drain。
- [ ] goal queue：manual verifier Stop 后 paused/no drain。
- [ ] mixed FIFO：text/goal/compact 在 complete 后按原 kind 顺序执行。
- [ ] desktop formal E2E 证明交互；bootstrap live/cold 测试证明 mobile replayable 不改变业务终态。
- [ ] 用 runtime debug log/provider capture 证明 ordering；用 CDP 证明 Composer 的 disabled 状态已恢复，避免只凭静态阅读。

### Task 7: Required Verification And Commit

- [ ] 运行 focused unit/integration tests。
- [ ] 运行新增/受影响 conversation E2E；无法运行的 remote/mobile 项在提交说明列风险。
- [ ] 运行 `pnpm typecheck`。
- [ ] 运行 `pnpm lint`。
- [ ] `git diff --check`，审阅只包含本功能文件。
- [ ] Conventional Commit，例如 `feat(conversation): restore guide and gate goal queue drain`。

## E2E Handoff Notes

- Provider fixture: controlled SSE 必须能稳定生成 text-only、single tool、parallel tool、failed tool result、goal verifier explicit pass 和 malformed fail-open。
- File-system fixture: readonly tool 使用 case-local 临时文件；不依赖真实外网或用户目录。
- Timing strategy: 以 command ACK、runtime fact 和 provider request marker 为 barrier；不使用固定 sleep 猜测 tool/verify terminal。
- Docker preset: 若 provider fixture 需要 replay isolation，沿用 conversation E2E Docker preset；本轮不扩大真实 mobile network。
- Review risks: 并行 tool result 提交顺序、target complete 与 active controller 清理竞态、guide→queue live/cold projection、现有 paused queue choice/send-now 回归。

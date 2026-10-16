# Plan Mode Goal Command Guard

## Feature/change summary

| Field                 | Value                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Change                | Plan 模式下从 composer 提交 goal 控制命令时，在 UI admission 边界拒绝并提示切换模式                                                        |
| User-visible surfaces | 桌面端 composer、普通 Web composer、手机 `/remote` composer                                                                                |
| Existing docs         | `docs/conversation-protocol-declaration.md`、`docs/conversation-product-state-space.md`、`docs/v4-refactor/v4-goal-command-parity-plan.md` |
| Existing code owners  | `packages/ui/src/v4/SessionPane.tsx`、`packages/ui/src/v4/ConversationComposer.tsx`、`packages/ui/src/v4/slashCommands.ts`                 |
| Out of scope          | 改写 CLI goal runtime、修改 queue/goal persistence、改变 desktop continuous 或 mobile replayable 的交付协议                                |

## Clarification log

| Round | Question                                                                                           | User answer | Boundary fixed                                          | Follow-up needed |
| ----- | -------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------- | ---------------- |
| 1     | Plan 模式下提交 `/goal` 或 `/goal <内容>`，是否全端都只 toast、不创建 goal、不发送消息并保留输入？ | 是          | 全端共享 UI guard；零 command 副作用；composer 原文保留 | no               |

## Boundary decisions

| Boundary            | Decision                           | Includes                                                                                      | Excludes / prunes                                                               | Source                             |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| Collaboration mode  | 仅 `config.mode=plan` 拒绝         | draft/prewarmed session、已有 session                                                         | build/edit/yolo 保持原语义                                                      | user                               |
| Command class       | 拒绝 parser 已识别的 goal 控制命令 | `/goal`、`/goal <内容>`、`/goal replace/resume/...` 及既有 `/target` 等价入口 | `/compact`、普通文本                                                            | user + existing parser equivalence |
| Attachments/context | 沿用现有 parser guard              | 无附件、无网页/会话选择上下文时才是 slash command                                             | 带附件或 context 的 `/goal` 文本仍走普通 `sendText`                             | existing code                      |
| Side effects        | 只 toast 并返回 `blocked`          | 输入、附件、草稿记录保持                                                                      | 不 dispatch `sendGoalCommand`/`resumeGoal`，不创建 session，不写 prompt history | user                               |
| Client boundary     | 共用 `SessionPane` admission guard | desktop continuous、普通 Web、web-remote replayable                                           | 不在 relay/main/Host/CLI 各写一份 guard                                         | architecture docs                  |

## Domain scope and high-risk cross-products

| Domain                        | Include?            | Why it can change behavior                   | Primary sources                     |
| ----------------------------- | ------------------- | -------------------------------------------- | ----------------------------------- |
| Conversation/session behavior | yes                 | `/goal` 原本会创建、更新或排队 goal          | conversation protocol + goal matrix |
| UI shell/locale/mobile        | yes                 | toast、输入保留和全端一致性都在共享 composer | `DESIGN.md` + UI i18n               |
| Permission/collaboration mode | yes                 | `config.mode=plan` 是本次 guard 的权威状态   | V4 snapshot/config                  |
| Remote/replay delivery        | representative only | 终端行为相同，交付协议不能被改写             | message flow                        |

高风险叉乘：Plan × goal alias 可能产生绕过；Plan × draft promotion 可能错误创建空 session；Plan × composer 清理可能让被拒输入丢失。三者均在 UI admission 前裁决。

## Concept map and state owners

| Concept               | Why it matters                 | Source / owner                                                        |
| --------------------- | ------------------------------ | --------------------------------------------------------------------- |
| collaboration mode    | 判断是否命中 Plan guard        | CLI projection `snapshot.config.mode`；draft 期间由 draft config 镜像 |
| visible slash command | 区分 goal 控制意图和普通文本   | `parseV4VisibleSlashCommand`                                          |
| command dispatch      | 任何 goal/session 副作用的入口 | `SessionPane.dispatchSendTextAfterConfig`                             |
| composer draft        | 被拒绝时必须保留               | `ConversationComposer` + Lexical editor/draft store                   |
| toast copy            | 全端、双语提示                 | UI i18n + shared toast component                                      |

```text
composer submit
  -> parse visible slash command
  -> read effective collaboration mode
  -> mode=plan AND command=goal-control
       |-- yes -> toast -> return blocked -> keep editor/draft -> no V4 command
       `-- no  -> existing config barrier -> V4 command -> ACK/projection

desktop-continuous --------\
                             +-> shared SessionPane guard -> existing Host/CLI
web-remote-replayable -----/
```

## Dimensions and candidate combinations

| Dimension           | Values / equivalence classes               | Include?       | Reason                            |
| ------------------- | ------------------------------------------ | -------------- | --------------------------------- |
| collaboration mode  | plan / non-plan                            | yes            | 决定 guard                        |
| input intent        | goal-control / compact / text              | yes            | 区分副作用                        |
| session surface     | draft/prewarm / existing session           | yes            | 防止 draft promotion 创建 session |
| client mode         | desktop-continuous / web-remote-replayable | representative | 共享 UI effect 相同               |
| attachments/context | none / present                             | yes            | present 时不是 slash command      |

| Candidate ID | State    | Event                                            | Target/surface | Expected guard/effect                     | Status                          |
| ------------ | -------- | ------------------------------------------------ | -------------- | ----------------------------------------- | ------------------------------- |
| PG01         | plan     | submit `/goal` 或 `/goal <内容>`                 | composer       | toast；返回 blocked；保留输入；零 command | accepted                        |
| PG02         | non-plan | submit goal command                              | composer       | 沿用 set/update/queue 语义                | accepted                        |
| PG03         | plan     | submit ordinary text or `/compact`               | composer       | 沿用既有 send/compact 语义                | pruned from change              |
| PG04         | plan     | submit goal-looking text with attachment/context | composer       | parser 返回普通文本，沿用 `sendText`      | pruned by command applicability |
| PG05         | plan     | submit goal alias                                | composer       | 与 PG01 等价，不能绕过 guard              | accepted                        |

## Pruning decisions and unresolved questions

| Decision ID | Pruned combinations             | Guard/invariant               | Product reason                             | Representative coverage         |
| ----------- | ------------------------------- | ----------------------------- | ------------------------------------------ | ------------------------------- |
| PG-P01      | desktop/mobile 各自重复业务终态 | shared UI admission           | delivery profile 不改变本地 composer guard | PG01 + shared component test    |
| PG-P02      | 所有 goal alias 全排列          | parser equivalence            | 只取 `/goal` 与一个 alias 代表             | parser/SessionPane focused test |
| PG-P03      | queue/running/completed 全排列  | Plan guard 发生在 dispatch 前 | runtime phase 不再影响结果                 | PG01                            |

无未决产品问题。

## Accepted case list and coverage handoff

| Case ID | Setup                                                                   | Action                 | Assertions                                                                                                           | Evidence layers                        | Status   |
| ------- | ----------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| PG01    | V4 snapshot 或 draft effective mode 为 `plan`，composer 有 `/goal` 原文 | Enter 或点击发送       | toast 文案正确；`sendGoalCommand`/`resumeGoal`/`createSession` 均未 dispatch；editor 未 clear；prompt history 未写入 | UI + command mock + draft/editor state | covered  |
| PG02    | mode 为 build/edit/yolo                                                 | 提交 `/goal objective` | 仍 dispatch `sendGoalCommand`                                                                                        | command mock                           | existing |
| PG05    | mode 为 plan                                                            | 提交一个 goal alias    | 与 PG01 相同                                                                                                         | parser + command mock                  | covered  |

## Matrix backfill

| File                 | Change                                                            |
| -------------------- | ----------------------------------------------------------------- |
| case catalog         | 新增 PG01，并移除 EnterPlanMode 后 `/goal` 可更新 target 的旧口径 |
| main coverage matrix | 新增 Plan × goal composer guard 行                                |
| goal-specific matrix | 新增 Plan 模式拒绝项                                              |

## E2E handoff notes

- Provider fixture: 不需要；产品合同是零 provider 请求。
- File-system fixture: 不需要。
- Timing strategy: focused UI test；后续若升格 E2E，manifest 使用 `providerRequestPolicy: none`。
- Docker preset: 当前不进入。
- Review risks: 重点验证 draft/prewarm 不被 promotion，以及 mobile shell 复用共享 `SessionPane`。

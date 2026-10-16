# Conversation Prompt Scroll Focus

## Feature Summary

| Field                 | Value                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Change                | 用户在阅读上文时提交新的 prompt，只有立即发送路径才执行一次现有“滚动到底部”动作                         |
| User-visible surfaces | V4 conversation composer、queue item “立即发送”、desktop/Web/mobile shared UI                           |
| Existing docs         | `docs/conversation-session-case-catalog.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md` |
| Existing code owners  | `ConversationTimeline` 持有 renderer-local 滚动状态；`SessionPane` 编排 composer/queue command          |
| Out of scope          | 永久强制吸底、协议/CLI queue 改动、跨 renderer 同步滚动位置、edit/retry/自动 drain                      |

## Clarification Log

| Round | Question                                    | User answer                                  | Boundary fixed              | Follow-up needed |
| ----- | ------------------------------------------- | -------------------------------------------- | --------------------------- | ---------------- |
| 1     | 普通发送、入队、queue send-now 是否都触发？ | 消息入队列不触发；点击消息队列的立即发送触发 | 立即发送与 enqueue 分开裁决 | no               |

## Boundary Decisions

| Boundary | Decision                          | Includes                                         | Excludes / prunes                   | Source                               |
| -------- | --------------------------------- | ------------------------------------------------ | ----------------------------------- | ------------------------------------ |
| Trigger  | 复用现有 instant “滚动到底部”动作 | composer 直发 accepted；queue item 点击 send-now | 仅 enqueue、自动 drain、edit、retry | user                                 |
| Lifetime | 一次性恢复 `following=true`       | 本次到底部及之后既有的自然跟随                   | 永久锁底；用户上滚后继续强拉        | user + existing scroll state machine |
| Failure  | composer 发送失败不改变阅读位置   | accepted/no-throw send                           | rejected/throw                      | existing ACK boundary                |
| Client   | shared renderer 语义              | desktop continuous、普通 Web、mobile remote UI   | 跨设备同步滚动位置                  | architecture invariant               |

## Domain Scope

| Domain                | Include?      | Why it can change behavior                                      | Primary sources                       |
| --------------------- | ------------- | --------------------------------------------------------------- | ------------------------------------- |
| Conversation/session  | yes           | `inputRouting.mode` 区分 start-now 与 enqueue                   | conversation protocol declaration     |
| Renderer scroll state | yes           | `followingRef`、scroll memory 和 bottom action 决定用户阅读位置 | `ConversationTimeline.tsx`、SRM cases |
| Mobile replayable     | boundary only | 共享 UI，但恢复协议不能拥有滚动状态                             | message flow architecture             |
| Protocol/CLI          | no            | 不新增 command/result 或 queue 状态                             | renderer-local invariant              |

## Concept Map And State Owners

```text
composer start-now --ACK accepted--\
                                  +--> SessionPane intent --> ConversationTimeline bottom action ref
queue send-now click -------------/
composer enqueue -----------------X

scrollToBottom(): following=true -> instant bottom -> existing content-follow behavior
user scrolls up: following=false -> hold reading position
```

| State / fact              | Authority                                                  | Evidence                             |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| start-now vs enqueue      | current V4 `snapshot.inputRouting.mode` + held disposition | focused policy unit test             |
| queue send-now click      | `ConversationQueuePanel` user action                       | SessionPane component test           |
| scroll position/following | `ConversationTimeline` component instance                  | timeline action-ref unit test         |
| conversation/queue truth  | CLI projection                                             | unchanged                            |

## Dimensions And Candidate Combinations

| Candidate ID | State                                                      | Event                                           | Expected effect                                | Status                                                      |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| PSF01        | existing session, user is above bottom, routing=`startNow` | composer send resolves accepted                 | instant bottom; `following=true`               | accepted                                                    |
| PSF02        | existing session, user is above bottom, routing=`enqueue`  | composer input is accepted into queue           | keep reading position; `following=false`       | accepted                                                    |
| PSF03        | queue visible, user is above bottom                        | click queue item send-now                       | immediately run the same bottom action         | accepted                                                    |
| PSF04        | direct composer send throws/rejects                        | send fails                                      | keep reading position and draft                | pruned from trigger by success guard                        |
| PSF05        | PSF01/PSF03 already moved to bottom                        | user scrolls up again                           | existing scroll handler sets `following=false` | accepted invariant                                          |
| PSF06        | automatic queue drain                                      | runtime consumes an item without send-now click | no new forced scroll intent                    | ignored; existing following state decides content anchoring |

## Pruning Decisions

| Decision ID | Pruned combinations                                         | Guard/invariant                                   | Product reason                                | Representative coverage      |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| P1          | provider/model/goal/tool × prompt scroll                    | routing result is the only relevant UI dimension  | these axes do not change scroll intent        | PSF01/PSF02                  |
| P2          | desktop continuous × mobile replayable product-state matrix | scroll is renderer-local                          | delivery changes recovery, not this UI action | shared component unit        |
| P3          | edit/retry/automatic drain                                  | no composer-new-prompt or explicit send-now event | avoid unrelated jumps while reading history   | absence of trigger in wiring |

## Accepted Cases And Coverage

| Case ID | Setup                                                                 | Action                                          | Assertions                                                                                      | Evidence layers             | E2E status |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- | ---------- |
| SRM05   | long session, user scrolled away from bottom, routing start-now       | submit composer prompt and receive accepted ACK | bottom action runs once, latest content visible, following restored; later user up-scroll holds | UI + command ACK            | planned    |
| SRM06   | long running session, user scrolled away from bottom, routing enqueue | submit composer prompt                          | queue gains item; scroll position/following unchanged                                           | UI + projection             | planned    |
| SRM07   | long session with visible queue, user scrolled away from bottom       | click a queue item “立即发送”                   | bottom action runs immediately; command still follows existing send-now lifecycle               | UI + command ACK/projection | planned    |

## E2E Handoff Notes

- Reuse the existing V4 long-conversation scroll fixture and queue fixture.
- Use controlled-stream only for SRM06; SRM05/SRM07 need no new provider contract beyond existing fixtures.
- Desktop continuous is the formal representative. Mobile replayable only needs a shared-component assertion unless a future remote-specific regression appears.
- Keep the implementation renderer-local; do not add protocol fields, snapshot state, relay state, or persistent scroll state.

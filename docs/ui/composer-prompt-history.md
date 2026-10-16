# Composer Prompt History

## Feature/change summary

| Field                 | Value                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Change                | Composer 提交文本时只过滤与上一条相同的连续历史；`↑/↓` 继续读取历史                                                                  |
| User-visible surfaces | Desktop / Web 共用的 V4 conversation composer                                                                                        |
| Existing docs         | `docs/v4-refactor/m5-composer-parity.md`、`docs/conversation-session-case-catalog.md`                                                |
| Existing code owners  | `packages/ui/src/lib/promptHistory.ts`、`packages/ui/src/lib/promptHistoryStorage.ts`、`packages/ui/src/v4/ConversationComposer.tsx` |
| Out of scope          | 全局去重、旧数据迁移、历史容量和 workspace key 变更、协议/Agent/relay 状态                                                           |

## Clarification log

| Round | Question                 | User answer      | Boundary fixed                                               | Follow-up needed |
| ----- | ------------------------ | ---------------- | ------------------------------------------------------------ | ---------------- |
| 1     | 连续重复还是全局重复     | 只过滤连续的     | `A,A` 只留一条；`A,B,A` 全部保留                             | no               |
| 1     | 相等前如何归一化         | 去掉首尾空格就行 | 仅比较 `trim()` 后的完整文本；内部空白、换行和大小写仍有意义 | no               |
| 1     | 读取旧历史时是否清理重复 | 不用清理         | 读路径不做去重迁移；历史里已有的重复项保持原顺序             | no               |

## Boundary decisions

| Boundary | Decision                                                   | Includes                     | Excludes / prunes                      | Source        |
| -------- | ---------------------------------------------------------- | ---------------------------- | -------------------------------------- | ------------- |
| 写入去重 | 新条目与当前最后一条在 `trim()` 后完全相同则跳过追加和写盘 | 连续相同提交、仅首尾空白不同 | 非连续重复                             | user          |
| 文本等价 | 只去首尾空白                                               | `" A "` 与 `"A"` 相同        | 内部空白折叠、大小写折叠、Unicode 改写 | user          |
| 读取兼容 | 不在 read path 去重                                        | 旧数组原顺序和重复项         | 迁移/全量清洗                          | user          |
| 导航接管 | 沿用现状：空输入或已进入历史浏览态时才接管 `↑/↓`           | 单行/多行 composer           | 覆盖非空草稿时的正常光标上移           | existing code |
| 失败回滚 | 沿用现状：发送失败不新增历史                               | send reject/failure          | 把失败正文留在历史                     | existing code |

## Domain scope and high-risk cross-products

| Domain                  | Include?       | Why it can change behavior                                      | Primary sources                                    |
| ----------------------- | -------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Conversation composer   | yes            | 提交和 `↑/↓` 都发生在共享 Lexical composer                      | `ConversationComposer.tsx`、`LexicalChatInput.tsx` |
| Renderer persistence    | yes            | 历史是 renderer `localStorage` 状态                             | `promptHistoryStorage.ts`                          |
| Desktop/Web client mode | representative | 两端复用同一 UI 逻辑；本功能不进入 continuous/replayable 数据链 | `docs/architecture/message-flow.md`                |
| Agent/protocol/queue    | no             | 历史写入不改变已提交 command、queue 或 projection               | `docs/conversation-protocol-declaration.md`        |

高风险组合收敛如下：发送成功/失败会影响是否保留新历史；连续/非连续重复会影响是否追加；旧存储重复项只影响读取结果。`desktop-continuous` 与 `web-remote-replayable`、session phase、provider、queue、theme 和 locale 不改变纯 renderer 去重结果，因此各保留共享实现代表，不做全排列。

## Concept map and state owners

```text
composer submit
  -> read per-workspace localStorage snapshot
  -> trim submitted text
  -> compare with last entry only
     |-- same      -> send command; history/storage unchanged
     `-- different -> append (max 30) -> persist -> send command
                                      `-> send failed: compare-and-rollback

empty composer / history-browsing state
  -> ArrowUp / ArrowDown
  -> PromptHistoryPlugin
  -> replace Lexical editor text
```

| State / fact             | Authority                                                     | Mirrors / caches                                 | Evidence                                    |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Prompt history entries   | Browser `localStorage` for the current existing workspace key | `ConversationComposer.promptHistory` React state | stored JSON + composer `promptHistory` prop |
| Current navigation index | `PromptHistoryPlugin` ref                                     | none                                             | focused navigation unit behavior            |
| Submitted text           | Lexical/composer draft until command accepted                 | `textRef`                                        | `onSendText` call                           |

## Dimensions and candidate combinations

| Candidate ID | Stored history     | Submitted text / event | Expected guard/effect                      | Status   |
| ------------ | ------------------ | ---------------------- | ------------------------------------------ | -------- |
| PH01         | `["A"]`            | send `" A "`           | trim 后等于最后一条；不追加、不写盘        | accepted |
| PH02         | `["A", "B"]`       | send `"A"`             | 只比较最后一条 `B`；追加为 `["A","B","A"]` | accepted |
| PH03         | `["A B"]`          | send `"A  B"`          | 内部空白不同；正常追加                     | accepted |
| PH04         | 旧数据 `["A","A"]` | read / mount           | 不做读取去重，仍返回两条                   | accepted |
| PH05         | `["A"]`            | send `"A"` 失败        | 未写入历史，无需回滚写盘，原历史不变       | accepted |
| PH06         | `["A"]`            | 非空多行草稿按 `↑`     | 现有 guard 保留光标导航，不进入历史        | pruned   |

## Pruning decisions and unresolved questions

| Decision ID | Pruned combinations                    | Guard/invariant                            | Product reason     | Representative coverage          |
| ----------- | -------------------------------------- | ------------------------------------------ | ------------------ | -------------------------------- |
| PHD01       | provider/model/session phase × 去重    | 去重在 command 前的 renderer 纯函数完成    | 不影响比较结果     | PH01-PH05                        |
| PHD02       | desktop continuous × mobile replayable | 历史不进入 conversation delivery           | 两端复用 composer  | PH01                             |
| PHD03       | 非空草稿的 `↑/↓` 历史接管              | `currentIndex === null && text.length > 0` | 不破坏多行光标移动 | 既有 `PromptHistoryPlugin` guard |

未解决问题：无。

## Accepted cases and coverage handoff

| Case ID | Setup                     | Action                   | Assertions                                          | Evidence layers               | Status       |
| ------- | ------------------------- | ------------------------ | --------------------------------------------------- | ----------------------------- | ------------ |
| PH01    | 最近历史为 `A`            | 提交首尾带空白的 `" A "` | command 仍发送；历史仍只有 `A`；不调用 storage 写入 | UI integration + localStorage | focused test |
| PH02    | 历史为 `A,B`              | 再提交 `A`               | 历史为 `A,B,A`；上读顺序保留非连续重复              | pure function + localStorage  | focused test |
| PH03    | 最近历史为 `A B`          | 提交 `A  B`              | 两条都保留                                          | pure function                 | focused test |
| PH04    | localStorage 已含连续重复 | 读取历史                 | 返回原重复顺序，不迁移写盘                          | localStorage                  | focused test |
| PH05    | 最近历史为 `A`            | 重复提交 `A` 且发送失败  | 原历史不变且不产生补偿写盘                          | UI integration + localStorage | focused test |

Matrix backfill：`docs/conversation-session-case-catalog.md` 新增 `PH` 组；`docs/testing/conversation-session-e2e-coverage-matrix.md` 登记 focused UI/storage 自动化。该变更不发 provider 请求、不改变协议和视觉，不需要新增 replay fixture；如果后续补 WDIO，可声明 `providerRequestPolicy: "none"`。

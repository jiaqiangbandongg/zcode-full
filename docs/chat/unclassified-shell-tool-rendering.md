# 未分类 Shell 工具渲染

## Feature/change summary

| Field                 | Value                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Change                | 修复 v4 conversation 中 Shell 工具在 command 到达前先显示普通 Bash/Shell、随后又并入“探索”的闪烁       |
| User-visible surfaces | 桌面 `desktop-continuous`、普通 Web、手机 `/remote` 的 `web-remote-replayable` conversation work items |
| State owner           | CLI v4 projection 持有 `ToolCallRow`；renderer 只派生当前 row 是否可见以及是否属于 Explore             |
| Out of scope          | 不修改 tool input 协议、delta 节奏、工具执行时机、permission、relay/main、snapshot schema              |

## Clarification log

| Round | Question                                         | User answer     | Boundary fixed                                                | Follow-up needed |
| ----- | ------------------------------------------------ | --------------- | ------------------------------------------------------------- | ---------------- |
| 1     | 只处理 Bash 还是所有 Shell family                | 所有 Shell 类型 | 按 `resolveToolCallIdentity(...).family === "shell"` 统一处理 | no               |
| 1     | 最终失败或被拒绝且始终没有 command 是否显示      | 显示            | 错误/拒绝结果优先于待分类隐藏规则                             | no               |
| 1     | desktop continuous 与 mobile replayable 是否一致 | 一样            | 两种 delivery profile 使用同一 renderer 可见性合同            | no               |

## Domain scope and concept map

| Domain/concept                | Owner                                    | Contract                                                                                  |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Conversation/session behavior | CLI ProductProjection                    | `tool_input_start` 可以先产生只有工具名、没有 command 的 `ToolCallRow`                    |
| Rendering/performance         | renderer `buildAssistantWorkRenderItems` | 未分类 Shell 是临时输入态，不是普通 Shell 的最终产品分类                                  |
| Permission/tool               | shared tool identity                     | 所有 Shell 工具通过 family 收敛；Read/Write 等非 Shell 工具不受影响                       |
| Mobile replayable             | delivery profile + renderer              | replayable 可以过滤 live `inputText` delta，但最终 upsert/snapshot 到达后使用相同分类规则 |

```text
tool_input_start { toolName: Shell, command: absent }
  -> ToolCallRow(inputStreaming)
  -> renderer: defer

tool input becomes classifiable
  |-- readonly command -> Explore group
  `-- other command    -> Execute group

tool reaches error/denied without command
  -> visible error row
```

## Dimensions and candidate decisions

| Candidate ID | Row state                                  | Shell input          | Expected effect                                         | Status   |
| ------------ | ------------------------------------------ | -------------------- | ------------------------------------------------------- | -------- |
| USR01        | `inputStreaming` / `running`               | command absent       | 不产生可见 work item，等待后续 row 更新                 | accepted |
| USR02        | nonterminal                                | readonly command     | 立即按现有规则并入 Explore group                        | accepted |
| USR03        | nonterminal                                | non-readonly command | 立即进入 Execute group                                  | accepted |
| USR04        | `error` / denied result                    | command absent       | 显示错误 Shell row，不吞错误正文                        | accepted |
| USR05        | desktop continuous / web remote replayable | 任一上述终态         | 相同 row 输入得到相同可见结果；不改变各自 delivery 语义 | accepted |

## Pruning decisions

| Decision ID | Pruned combinations                    | Guard/invariant                                                                    | Representative coverage                      |
| ----------- | -------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| USR-P01     | Bash/execute/shell 等工具名全排列      | `resolveToolCallIdentity` 已将它们收敛为 Shell family                              | family 代表用例 + identity 既有测试          |
| USR-P02     | theme/locale/OS/workspace 类型         | guard 是无文案、无布局、无平台依赖的纯 row 派生                                    | focused renderer unit test                   |
| USR-P03     | continuous/replayable 物理网络全排列   | 本变更不修改 transport；最终 row 的 renderer 合同相同                              | renderer unit + 既有 STIP03 profile 收口测试 |
| USR-P04     | permission UI 行为                     | permission/elicitation 有独立 blocker surface；本变更只决定 conversation work item | 既有 permission tests                        |

## Accepted cases and evidence

| Case ID | Setup                                                                       | Action                                                       | Assertions                                                                      | Evidence layers                          | E2E status              |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------- |
| STIP04  | v4 running turn 收到 Shell `tool_input_start`，input/inputText 尚无 command | renderer 构建 work items；随后分别补 readonly 与普通 command | 首帧无 Bash/Shell；readonly 更新后只出现 Explore；普通 command 更新后只出现 Execute group | UI row derivation + runtime log ordering | partial（focused unit） |
| STIP05  | Shell row 无 command 且状态为 error/denied                                  | renderer 构建 work items                                     | 错误 row 可见，错误正文继续由 tool error surface 展示                           | UI adapter + tool error rendering        | partial（focused unit） |

## E2E handoff

- 本次不新增 conversation E2E；核心 guard 是纯 deterministic row-to-render-item 函数，先由 focused unit tests 回归。
- 若后续升级正式 E2E，使用 `controlled-stream` fixture 分开发送 `tool_input_start` 与 command delta，并同时断言 Bash 文案在首帧不存在、分类后只出现一个稳定 work item。
- 手机真实 gap/snapshot 恢复仍沿用 STIP03，不用 desktop continuous fixture 冒充物理 replayable 证明。

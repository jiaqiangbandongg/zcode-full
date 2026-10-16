# Agent Step 真实模型与 Token 归属

## 范围

本期只修正已有 message 生命周期内的 `agent_step`：

- step 使用实际请求的 model/provider/hostname，不复用 message 最后一次请求覆盖后的共享字段。
- Provider 的一次完整 request usage 只归属一条 step，保证 step token 可加总。
- 前台 Subagent usage 聚合到对应的父 `Agent` 工具 step。
- foreground Subagent 的 child `thought/text` 不直接生成 step；相关 step 来自 parent
  session 的 Agent/tool mirror lifecycle。
- background Subagent 的 child tool 继续逐条上报；另外在 child 终态上报一条 `Agent`
  step，承载该 child 已完成模型请求的累计 usage，复用 foreground 的字段 builder。
  不消费 child `thought/text` 生成 reasoning/generation。
- 不新增 background child 独立的 `message_completion`。
- main `message_completion` 增加 `agent_composition`：`main_only` 表示本轮没有消费任何
  Subagent 结果，`main_plus_fg` 表示只有 foreground 结果，`main_plus_bg` 表示只有
  background 结果，`main_plus_fg_bg` 表示两者都有。

```text
用户 message M1
  |
  +-- 主请求 R1(model=A)
  |     +-- reasoning step   model=A, tokens=0
  |     `-- generation step  model=A, tokens=usage(R1)
  |
  +-- Agent tool step         model=B, tokens=sum(child requests), agent_id=child
  |     |
  |     +-- child request C1  model=B
  |     `-- mirrored WebFetch model=B, tokens=0, agent_id=child
  |
  `-- 主请求 R2(model=A)
        `-- generation step  model=A, tokens=usage(R2)

background child B
  +-- child thought/text     -> 不直接生成 agent_step
  +-- child tool lifecycle   -> tool_call step, model=B, tokens=0, agent_id=child
  `-- 首个 terminal/stopped  -> Agent step, tokens=sum(已收到的 child requests)，无 usage 时默认 0

main wake round from background notification
  `-- main message_completion -> agent_composition=main_plus_bg
```

## 归属规则

1. 同一请求产生的各 step 都冻结该请求的真实模型身份。
2. 完整 request usage 只写入请求结束时最后一个模型输出 step。
3. 同请求更早结束的 reasoning step 和纯工具执行 step 保持 token 为 `0`。
4. 前台 child 的模型和累计 usage 随 request fact 增量写入父 `Agent` step；不能等
   `SubagentStopped` 才首次回填。
5. 镜像 child 工具保持独立 `tool_call_id` 和 token `0`；它与父 `Agent` step 使用相同
   `agent_id`，且模型取 child 的真实请求模型。
6. background child 的 usage 只归属它自己的 `Agent` step，不回填已结束父轮的 completion。
   child tool 保持 token `0`，Agent step 在首个 child terminal 或 SubagentStopped 追加，
   使用 child-local 下一 loop_index。
   Agent step 的 tool_call_id 使用 `tool_subagent_<agentId>_<parentToolCallId>`；父会话中原有
   Agent launch step 仍只描述启动动作。累计 usage 不是每个工具结束时的 so-far 快照。
   活跃 child 收到上述任一终态时，即使没有 usage，也保留 Agent step 的状态、错误与已知模型；
   token/request count 沿用 foreground 的默认 `0`，不伪造 requestId 或 usage scope。
   对齐 foreground 异常收口时的已知 usage 快照，不重复汇总、不追补收口后才收到的 usage。
7. background mirror 的 tool/permission fact 必须携带 `background=true`，进入 main prompt
   telemetry 前过滤，避免同一 child tool 或 permission wait 重复计入 main。
8. background child 的上报使用 parent session、`sourceCommandId`、`parentToolCallId` 和
   `childSessionId` 建立归属；缺少必要归属字段时不猜测上报。
9. `message_completion.agent_composition` 只描述当前 main turn 已消费的结果：foreground
   child 在结果收口时置位；background notification 在独立 wake 被 dequeue，或在 active-loop
   合法边界实际合流后置位。失败、取消仍保留已消费的事实；不能因 child 仅 spawned/stopped 就置位。

## 事实与归属链路

```text
model_request_started/completed + ModelComplete(usage)
          |
          v
normalizer: requestId + model identity + usage
          |
          +-- main session  ------> 当前 model-output step
          |
          `-- child session ------> childSessionId 累计
                                      |
SubagentSpawned(childSessionId, parentToolCallId, agentId)
                                      |
                                      +--> parent Agent step
                                      `--> mirrored child tool
```

权威字段来源：

| 字段             | 事实源                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `model_name`     | `ModelNetworkStatus.modelId`，沿用 `<provider>/<model>` 上报编码 |
| `model_provider` | `ModelNetworkStatus.providerId`                                  |
| `provider_name`  | `ModelNetworkStatus.baseURL` 经过 hostname 裁剪                        |
| token usage      | 与该 completed request 相邻的 `ModelComplete.usage`                    |
| child 归属       | `SubagentSpawned.childSessionId + parentToolCallId + agentId`          |

`ModelComplete` 没有独立 requestId，因此 normalizer 只在同 session、同 `querySource` 内关联最近完成的
request；无法关联时仍可用于 message completion 总量，但不得伪造 step 模型归属。

## `agent_step` 字段

保留既有字段，并补齐：

| 字段                       | 口径                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `model_request_id`         | usage 所属真实模型请求；非 token owner step 为空                                                                     |
| `model_request_count`      | 当前 step 聚合的真实请求数；普通主 Agent request 为 `1`，subagent Agent step 可大于 `1`                              |
| `token_usage_scope`        | 主 Agent 单请求为 `model_request`；前台/后台 child 生命周期聚合为 `subagent_requests`；否则为空                      |
| `input_tokens`             | request usage input                                                                                                  |
| `output_tokens`            | request usage output                                                                                                 |
| `reasoning_tokens`         | request usage reasoning                                                                                              |
| `cached_tokens`            | request usage cache read，保留旧字段名                                                                               |
| `cache_write_input_tokens` | request usage cache write                                                                                            |
| `total_tokens`             | request usage total                                                                                                  |
| `agent_id`                 | Subagent 的稳定 agent 标识；父 `Agent` step、foreground mirror tool 和 background child tool 取自身 child 值         |
| `agent_role`               | Subagent step 的来源角色：`foreground subagent` 或 `background subagent`；main agent step 不填                       |
| `tool_call_id`             | foreground mirror 使用 Runtime 已生成的 scoped ID；background child 使用 `tool_subagent_<agentId>_<childToolCallId>` |

## `message_completion.agent_composition`

该字段表示当前 main turn 的 Agent 组成：

| 值                | 含义                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `main_only`       | 没有 foreground 或 background Subagent 结果                         |
| `main_plus_fg`    | 只有 foreground Subagent 结果                                       |
| `main_plus_bg`    | 只有 background Subagent 结果，且 notification 已进入当前 main turn |
| `main_plus_fg_bg` | foreground 与 background 结果都有                                   |

background child 完成本身不置位该字段；其合成 notification 被 dequeue 并启动独立 main turn，
或在当前 active-loop 被实际消费后，才计入对应轮次。Bash 通知不计为 Subagent 结果。

Todo103 重接保留当前扁平请求模型事实与 ModelSelection 执行边界；统计不读取 Provider
配置来猜模型，也不调用有效选择解析二次替换已执行模型。来源提交的 E2E artifact 仅是
历史证据，不表示整合分支已经复验通过。

所有数值字段继续使用 string 编码。没有真实 usage 的 step 必须写 `0`，不能估算。

## 时序与异常

- request status、usage fact 和 step 均按 `eventId/requestId` 去重，重放不能重复累计。
- 模型身份在 step 创建时冻结，后续主 Agent 或 child 请求不能覆盖历史 step。
- 主模型直接返回 `tool_use` 且没有正文时，补一个零时长 generation step 承接主 request usage；
  不得把主模型 usage 混入随后的工具 step。

```text
child request started(B) -> child usage -> parent Agent failed -> SubagentStopped
          |                    |
          `-------- 增量回填 parent Agent(model=B, usage=child) -------->
```

- foreground runner 的成功、失败、activity timeout 与 abort 都统一发出 `SubagentStopped`；
  外层 `Agent` 工具另有 timeout。两种真实终态谁先到就用当前已知 child usage 收口，不能再增加
  telemetry 自己的 grace timer。父 `turn.terminal` 到达后必须先上报剩余 `agent_step`，紧接着
  上报 `message_completion`。

```text
SubagentStopped ─┐
                 ├─ first terminal wins -> Agent step -> remaining normal steps -> message_completion
Agent timeout ───┘
```

- `sendQueuedNow` 会先终止当前 turn，再用队列项原始 `sourceCommandId` 启动下一 turn。若前一
  message 的 terminal 正等待前台 Subagent 收口，后一 message 的 `turn.started` 与后续 facts
  必须按 command 暂存；前一 message 完成 `agent_step -> message_completion` 后才能激活后一
  message。该屏障只存在于真实 deferred terminal 窗口，不能扩展成通用消息串行器。

```text
message A turn.terminal -> wait SubagentStopped -> A agent_step -> A message_completion
                                 |
message B turn.started/facts ----+---- buffer ----------> activate/replay B
```

- child 只要已经发出真实 `model_request_started`，父 Agent 工具 step 就使用 child model；即使请求
  没有 usage 也不能回退到父 message 模型。失败或取消只保留终态前已完成请求的 usage，不估算。
- `SubagentStopped` 后仍保留 child 关联到父 message 收口，以处理迟到的镜像工具终态。
- renderer reload/recovery 不补造历史埋点，保持现有 live-only 边界。
- desktop continuous 与 web remote replayable 共用无正文事实 schema；现有产品规则仍只允许可信
  desktop continuous attachment 消费 workspace telemetry，恢复重放不补报。
- background child 的 `model.request.status(started)` 冻结工具模型；`usage.delta` 按 requestId
  去重后累计。`turn.terminal` / `SubagentStopped` 共用一次性 Agent 汇总结算，取首次收口时
  已收到的 usage；没有 usage 时仍上报，token 默认 `0`。停止不等于 child 已退出，因此
  stopped 收口后只保留已开始的工具及其权限等待状态，供迟到的工具终态逐条上报；全部工具
  收口或 child terminal 到达后清理，不再以模型请求/usage 是否存在猜测清理时机。
- 只消费已有 Runtime 事件：normalizer 保留既有 `SubagentStopped.error` 为 `errorMessage`。
  不新增 Runtime 事件，不改变执行、取消、通知、main wake 或 foreground 行为；不增加 timer，
  不补 child completion。异常收口后的晚到 usage 不计入已发出的汇总，不承诺完整尾部消耗。

## Main turn ID

普通用户 turn 和独立 background notification wake 共用 UUID v7 生成器。每个 wake batch
生成自己的新 `inputId`，沿 `TurnStarted.inputId -> sourceCommandId -> message_id` 上报，
同轮 step/completion 共用该值，不复用原始用户轮 ID。持久化 synthetic `msg_*` ID 保持原用途，
不得再被 normalizer 用作 telemetry inputId。active-loop 消费不创建新轮或新 telemetry ID。

## 验证

后台生命周期 E2E 的每个新草稿必须在提交前显式选择完全访问（yolo）；suite 开头一次设置
不能代替后续草稿前置。BG13 的运行日志已证明默认 build 会使 child Bash 等审批，
不能把权限等待误判为 notification 或统计丢失；产品审批逻辑不因此改变。

至少覆盖：

1. 单请求 reasoning + generation：两条 step 都是请求真实模型，usage 只出现一次。
2. 主模型 A → 前台 Subagent 模型 B → 主模型 A：三段 step 的模型和 token 不互相覆盖。
3. 同一请求 usage 重复到达：只累计一次。
4. 后台 Subagent：child thought/text 不产生 step；child tool lifecycle 产生与 foreground
   mirror 相同格式的 tool step，token 为 `0`。child terminal 后的 Agent step 独占累计 usage，
   同样带 child `agent_id` 与 `agent_role`；最终 HTTP 上报验证 request count、token 总量与顺序。
5. provider hostname 只上报 hostname，不泄露 URL path/query/credentials。
6. child 取消且父 `Agent` step 先失败：仍保留已完成 child usage 和真实模型。
7. 镜像 WebFetch：与父 `Agent` step 的 `agent_id` 相同，模型为 child 模型，token 为 `0`。
8. 活跃 background child 没有 usage 时，成功/失败/取消的 terminal 或 stopped 仍产生一条零
   token 的 Agent step；与收到全零 usage 区分 request count/scope。覆盖仅 stopped、有无
   usage、两种终态先后顺序、重复终态及 stopped 后迟到工具；汇总只报一次，错误原文保留，
   不产生独立 `message_completion`，不追补迟到 usage，也不因清理丢失已开始工具的终态。
9. background child 多个 tool step 的 `loop_index` 在 child 内递增，并行 child 独立从 `1` 开始。
10. 普通 reasoning、generation、tool_call 与前台 `Agent` step 同处一条 message 时全部保留，
    `agent_step_cnt` 与实际上报数量一致。
11. `message_completion.duration_ms` 保持用户可见墙钟口径，即 `turn terminal - sendTime`，
    天然覆盖本轮主 Agent、前台 Subagent、工具等待与最终生成。
12. `message_completion.agent_composition` 只在 main completion 生成时计算，不改变
    `agent_step` 数量或 background child 的独立上报。
13. 前一 message 等待前台 Subagent 收口时点击队列“立即”：前一 message 使用自己的
    `request_time`、真实墙钟 duration 与 step 计数先完成，随后后一 message 使用原始
    `sourceCommandId` 独立上报 step 和 completion。

## 追记（2026-09-14）：第三种来源——动态工作流子代理

规则见 `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`「Token telemetry for subagents」。与前两种来源的差异只有三点：

- 登记事实不是 `subagent.lifecycle`，而是由父会话 `DynamicWorkflowRunProgress` 派生的
  `workflow.lifecycle`（`actor-spawned` / `run-settled`）；归属键是 `runId + childSessionId`，
  `message_id` 是 run 的 `run-launched.inputId`（不是任何一次 `Agent` 工具调用）。
- 终态是 **run 结算**而不是子会话自己的 `turn.terminal`：一个子代理会话可承接多次 ask，每次 ask
  是一个 turn；汇总 step 只在 `run-settled` 时对该 run 的每个子代理各发一条。
- `agent_role = "workflow subagent"`，另带 `workflow_run_id` / `child_session_id` /
  `workflow_tool_call_id`；`token_usage_scope` 仍复用 `subagent_requests`。

其余规则（工具 step token `0`、requestId 去重、终态后不补、live-only、无 usage 也报零值汇总）逐字沿用。

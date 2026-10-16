# 后台 session event 降频

## 背景

深度检索类任务并发运行时，多个后台 task 会持续产生 `model.streaming`、`tool.updated:progress` 和恢复进度事件。即使当前界面只展示一个 task，renderer 仍会被后台任务的每个协议事件唤醒，继续做 projection、Zustand 写入和 React 更新，导致 5 并发时 renderer CPU 明显升高。

## 策略

- active task 继续使用 `desktop-continuous` 实时订阅，保留流式正文、思考和工具调用的体感。
- inactive task 的后台 monitor 在订阅 `desktop-continuous` session event 时声明 `background-summary` 合并模式。
- inactive desktop task 进入 tombstone 内容模式：后台 monitor 只维护运行态、标题、权限、usage、plan、队列、未读和终态，不再把正文/思考/tool progress chunk 持续写入 React 消息树。
- 合并只发生在订阅者侧，不改变共享 emitter，不改变 agent/runtime 的事件事实源，也不改变手机 `/remote` 的 `web-remote-replayable` snapshot/gap 恢复语义。
- 后台可合并事件：
  - `model.streaming:text_delta`
  - `model.streaming:reasoning_delta`
  - `model.streaming:tool_input_delta`
  - `tool.updated:progress`
  - `streamRecovery.updated`
- 后台不可延迟事件必须先 flush 已合并事件再立即投递：
  - turn start / terminal
  - tool scheduled / started / result / error / batch
  - permission / user input
  - snapshot / state update / provider runtime headers
  - title、mode、target 等结构化 session 变更

## 目标

后台 task 仍能保持运行态、权限请求、终态、未读状态和切回后的恢复能力，但不可见任务不再按 token/tool progress 频率驱动 renderer。用户切换到某个任务时，前台订阅通过 snapshot/live stream 重新接管完整 UI；后台合并只承担低频摘要，不作为 replayable 恢复边界。

## Tombstone 内容模式

- 桌面后台任务收到 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、普通 `tool_call_update` 时，不再调用 `updateTaskMessages`。
- `tool_call_update:completed` 仍会用工具标题轻量补齐 todo plan，例如 `Write/Edit <path>` 对应某个 plan step 文件名时将该 step 标成 completed。
- `task_complete` / `task_error` 对不可见桌面任务只收口 runtime、usage、错误、未读和队列，不主动拉 residual snapshot 写入大消息。
- `task_snapshot_updated` 对不可见桌面任务只作为恢复提示；除归档/删除等显式释放原因外，不在后台读取全量消息。
- 当前 active task、active task 前台订阅建立前的兜底窗口，以及手机 `web-remote-replayable` mirror 不使用 tombstone，仍保持原有实时/恢复语义。
- 批量 session 压测不会在触发完成后自动切到最后一个成功任务；这些任务保持后台 tombstone，用户显式点开时再恢复完整内容。
- 批量 session 压测的首发 session 会按 1000ms 轻微错峰启动，最多延迟 5s；这样 5 并发会在 4s 内全部进入运行态，10 并发在 5s 内完成触发，不会把 task 创建、订阅和运行态写入全部压在同一秒打到 renderer。
- 批量 session 压测产生的后台首发任务使用轻量初始化：task 列表插入、optimistic meta、runtime=`streaming`、`activeInputId` 和 provider 绑定合并为一次 Zustand 写入，不再为不可见任务写入首发 user/assistant optimistic messages。
- 后台 monitor 的单个事件处理包在 React batched updates 中，减少终态同时更新 runtime、usage、未读、权限等状态时的 React commit 次数。
- 不可见桌面任务的 title-only `session_info_update` 会按 2s 合并写回任务缓存；带 `target` 的 goal/status 更新和终态事件会先 flush pending title，再继续通知和收口。
- 工具输入投影采样、消息写入采样、后台 usage breakdown 等随流诊断日志必须走 `debug`，避免深度检索时 renderer 反复做大对象序列化和生产日志落盘。

## 边界

- `clientMode` / `deliveryKind` 边界不扩散：本策略只在 UI 后台 monitor 的 `desktop-continuous` 订阅参数上启用。
- 手机远控 replayable 不使用该合并模式，仍由 `seq`、gap recovery 和 snapshot 保证恢复。
- app-agent 协议 `@zcode/protocol` 不新增字段；合并参数是 services 内部订阅者策略，不传给 zcode-cli runtime。

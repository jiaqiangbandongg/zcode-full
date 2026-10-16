# Rewind 与 Compact 协同设计 v2

## 文档定位

本文定义 ZCode v2 中 rewind、checkpoint 与 compact 的共同状态模型。它不是 UI 设计稿，也不是文件恢复 adapter 的实现细节；它先固定三件事：

- compact 之后哪些 conversation rewind 是合法的。
- compact 前的 file checkpoint 如何继续可用。
- 消息附件和大文件 artifact 在 compact、rewind、fork 中如何保留或降级。
- rewind / checkpoint 需要进入哪些可恢复、可审计的 contract。

Compact 管模型可见上下文；rewind 管会话和工作区状态恢复。二者共享 session event log 和 message/checkpoint 锚点，但不能互相直接篡改对方的历史。

Conversation rewind 的分阶段实施计划见 [`rewind/plan.md`](./rewind/plan.md)。该计划把本文的 contract 落到 runtime、session store、TUI 和 ZCode app-server 的实现顺序，并记录了需要保留的语义边界。

## Auto Compact 触发依据

Auto compact 的触发必须优先使用 provider 返回的真实输入 token 用量，而不是本地字符估算。模型每次请求完成后，runtime 记录该请求的 `usage.inputTokens`、请求时的 provider-visible message 数量、模型引用和 trace 信息；下一次进入 auto compact 判断时：

1. 如果存在可用的真实 `usage.inputTokens`，以它作为基线 token 数。
2. 如果上一轮请求后又追加了 assistant、tool 或 user message，只对新增 message 做本地估算，并加到真实基线上。
3. 如果没有真实 provider 用量，才退回到对当前 active chain 的全量本地估算。

这样做的原因是 OpenAI-compatible provider 可能在 tokenizer、工具 schema、reasoning 或服务端包装上与本地估算存在数量级差异；真实服务端用量是 compact 决策的最高优先级事实源。

本地估算是 provider usage 不可用时的保守水位判断。它必须同时计算普通正文和
`reasoning` block 的文本；不能复用只投影可见正文的 helper 后把 reasoning 计为 0。
provider 返回的 `reasoningTokens` 已包含在 `outputTokens` 中，复用 usage anchor 时不得再次
累加。该估算仍使用字符数近似 token，不承诺与具体 provider tokenizer 完全一致，也不会修改
canonical history 或 provider-specific reasoning 回放规则。

如果 provider 通过 finish reason 表示上下文溢出，例如 GLM SSE 中的 `model_context_window_exceeded`，runtime 必须把它归一为 `ModelContextExceeded`，触发 reactive compact 或向上抛出结构化错误，不能把空内容当成普通 `end_turn`。

## 核心原则

### 1. Event log 是事实源

所有 compact、checkpoint、rewind 都追加 event 或 part，不删除旧历史。UI 可以隐藏 compact 前的 scrollback，provider active chain 可以从 compact boundary 后开始，但审计和高级恢复仍应能从 event log 或 transcript 找到旧状态。

### 2. Active chain 是模型可见投影

Full compact 后，active chain 默认只包含：

```text
compact boundary
compact summary
preserved messages
attachments
hook results
messages after compact
```

因此 conversation rewind 默认只能选择 active chain 内的 message。选择 compact boundary 之前的 message，不能假装是普通 rewind。

### 3. Workspace checkpoint 独立于 conversation visibility

文件修改 checkpoint 不应因为 compact 被删除。即使 checkpoint 的锚点 message 已经被 compact 覆盖，仍可以执行 file-only rewind。执行后必须追加新的 `rewind_triggered` 事件，并在下一轮模型上下文中说明工作区已恢复到哪个 checkpoint。

### 4. 跨 compact boundary 的 conversation rewind 使用 append-only branch cut

用户回到 compact 前的 conversation point 时，当前 session 不物理删除旧 message/part，也不自动
创建 child。session 持久化 `keptMessageIDs + branchCutAfterMessageID + branchGeneration`，active
branch 由保留前缀与 cut 之后的新消息组成；随后才在 active branch 内选择最后一个 compact
boundary 构建 provider history。被 cut 掉的 compact summary/boundary、microcompact、context usage
和 read-file 派生状态必须重建，且不得追加描述旧 prompt 的 model-visible reminder。

### 5. 附件 artifact 独立于 workspace checkpoint

用户消息里的图片、PDF、二进制和大文本 preview 属于 session input artifact，不属于 workspace mutation checkpoint。file-only rewind 恢复工作区文件时，不应重新解释已经提交的附件；conversation rewind 清理 message/part 时，也不应立即删除附件 artifact。附件 artifact 通过引用计数或未引用扫描延迟 GC。

## Rewind 范围

`RewindScope`：

- `conversation`：只恢复模型可见消息链，不改文件。
- `workspace`：只恢复文件/工作区 snapshot，不改 conversation active chain。
- `both`：同时恢复 conversation 与 workspace。

`RewindStrategy`：

- `active_chain`：目标仍可从 append-only transcript 重建，当前 session 可直接应用；允许跨 compact boundary。
- `file_only`：目标 checkpoint 可恢复，但 conversation target 已被 compact 覆盖。
- `fork_required`：仅保留给显式 fork/workspace fork 结果；conversation edit/retry 不再因 compact 命中该策略。
- `unavailable`：目标不存在，或没有可用 checkpoint。

## Compact 与 Rewind 的交集

### Full compact

Full compact 写入 `CompactBoundary.lastSummarizedMessageId`，表示边界之前最后一个被 summary 覆盖的 message。之后：

- active chain 从 compact boundary 开始。
- compact 前 conversation checkpoint 默认不出现在普通 message selector 中。
- compact 前 file checkpoint 可以出现在高级 checkpoint 列表中，但必须标注 `covered_by_compact`。

### Partial compact

Partial compact 必须记录 `preservedSegment`：

- `headMessageId`
- `anchorMessageId`
- `tailMessageId`

如果 target 在 preserved segment 中，conversation rewind 可以按 active chain 处理。如果 target 被 summary 覆盖，则按 full compact 的规则处理。

Partial compact 不能拆开 tool_use/tool_result pair，不能拆开同一个 assistant message id 的 thinking/tool block。`up_to` 方向保留的 segment 里必须移除旧 compact boundary 和旧 compact summary，避免后向扫描命中旧边界。

### 最近保留段的持久化与冷恢复

Auto/reactive compact 已选中的 recent groups 不进入 summary，必须在 live 与冷恢复中保留相同的已持久化内容。以既有 assistant-started round 为选择单位：持久化侧按相同的组数取最近组，再记录原始 `headMessageId / tailMessageId`；不得把 runtime 中按来源过滤得到的消息数用于截取数据库中的另一份候选列表。`keptMessageCount` 从实际选中的持久化记录计算，仅作统计，不能反过来决定区间。

组内 user、coordinator、子 Agent 回信、后台任务通知及已持久化的 Runtime Attachment 均保留原文、身份和呈现标记。`synthetic`、`model-only` 和 `source` 表达输入身份或 UI 可见性，不是丢弃 provider 上下文的依据。工具结果随所属 assistant 的 tool parts 一起恢复。compaction 控制记录、`providerVisibility=hidden` 的 timeline 记录和没有模型内容的失败记录继续排除；request-local 的提示不新增持久化副本，仍按各自生命周期生成。

```text
runtime 最近 N 个 assistant groups ──> live 原样保留
                  |
active session 同样取最近 N 组 ──> 保存区间 ID ──> 冷恢复整个区间
                                                    |
                                     统一 MCS / 非 MCS 投影
```

复用既有区间 schema，不迁移旧数据库。旧区间也恢复其中已有的 synthetic/attachment；无法从历史区间推断当时被错误排除在区间外的消息，不追溯扩展边界。保留段只参与 provider history，不改变 compact 后 timeline 的最新消息锚点。Desktop continuous 和手机 replayable 继续消费同一 CLI 权威历史，不改变各自传输、恢复边界。

回归必须经过实际 compact boundary 持久化与冷 hydration，并验证 MCS 开关下原文、完整 reminder、角色、工具批次和次数；仅复制 runtime entries 的测试不能证明冷恢复正确。

### File rewind after compact

执行 compact 前 checkpoint 的 file-only rewind 时，runtime 必须：

1. 校验 checkpoint snapshot 可用。
2. 恢复 workspace snapshot。
3. 追加 `rewind_triggered` event，`strategy=file_only`。
4. 追加一条可进入模型上下文的 synthetic user/status message，说明恢复的 checkpoint、文件数量和风险。
5. 不改变 active chain 的 compact boundary。

### Fork rewind

`/fork latest` 和 `/fork <checkpointId>` 创建新的 child session，而不是在当前 session 中删除或改写历史。第一版 fork 的目标是提供“从这里开一条新线”的体验，同时保持实现可恢复：

1. 当前 session 保留完整历史和 compact boundary。
2. child session 的 `parentID` 指向当前 session。
3. child session 复制父 session 从开头到 checkpoint 所在 message 的 message/part，并重新生成 message/part id，避免跨 session 主键冲突。
4. attachment `FilePart` metadata 随 message/part 复制；immutable attachment artifact 可以共享 URI 或增加引用计数。
5. 如果父 session 的 attachment artifact 缺失，child session 必须把对应 part 降级为 `[Missing attachment: ...]` fallback，并记录 debug event。
6. runtime 恢复 checkpoint artifact 中的 workspace 文件。
7. child session 追加 synthetic user/status message，说明 fork 来源、checkpoint、恢复文件、附件降级和 compact 风险。
8. 当前 session 追加 `session_forked` event；TUI 可以把 active app 切到 child session。

如果 checkpoint 的锚点 message 已经被 compact 覆盖，fork 仍然允许；这正是 compact 前 conversation rewind 的默认路径。它不是在原 session 里假装回到旧消息，而是显式开新 session。

### Attachment artifact after rewind

conversation rewind 的 cleanup 只改变 active chain 或删除目标点之后的 message/part 引用，不立即删除附件 artifact。这样可以支持：

- 用户误 rewind 后再 fork 回旧分支。
- compact summary 仍能解释曾经存在过的附件。
- artifact store 后续按引用扫描或保留期做 GC。

file-only rewind 只恢复 workspace checkpoint。即使恢复后的工作区文件路径和某个附件原始 `file://` 路径相同，已提交附件仍以提交时 snapshot 的 artifact 为准，不能重新读取当前工作区文件覆盖历史附件。

part 级 rewind 如果目标在同一 user message 内，必须用 `FilePart.source.text` 判断哪些附件 placeholder 被删除。删除 placeholder 后，对应 `FilePart` 不再进入模型投影，避免 orphan attachment 继续发送给 provider。

## Contract

### CheckpointCreatedPayload

字段：

- `checkpointId`
- `messageId`
- `scope`
- `snapshotRef`
- `diffRef?`
- `fileCount?`
- `compactBoundaryId?`
- `coveredByCompact?`

`coveredByCompact=true` 表示该 checkpoint 的 message 锚点已经不在当前 active chain 中，但 snapshot 仍可能可以 file-only restore。

### RewindTriggeredPayload

字段：

- `rewindId`
- `scope`
- `strategy`
- `targetMessageId?`
- `targetCheckpointId?`
- `compactBoundaryId?`
- `restoredSnapshotRef?`
- `createdMessageId?`
- `reason?`

`strategy=fork_required` 的 event 可以作为 UI/SDK 的 intent 记录；真正 fork 由 session service 追加 `session_forked`。

### SessionForkedPayload

字段：

- `originalSessionId`
- `forkedSessionId`
- `targetMessageId?`
- `targetCheckpointId?`
- `restoredSnapshotRef?`
- `restoredFileCount?`
- `strategy`
- `attachmentArtifactRefs?`
- `missingAttachmentRefs?`

### CompactBoundary 附件字段

Compact boundary 需要记录附件摘要字段，供 debug、fork 和 rewind 判断：

- `attachmentMessageIds?`
- `strippedAttachmentCount?`
- `strippedAttachmentBytes?`
- `strippedAttachmentRefs?`
- `missingAttachmentRefs?`

这些字段只描述 compact 时被 strip 或降级的附件，不表示附件仍在 active model context 中。

## 第一批实现

- runtime schema：checkpoint payload、rewind payload。
- workspace checkpoint artifact schema：`workspace_file_before_change`，包含每个文件的路径、是否原本存在、修改前内容和结构化 diff。
- `evaluateRewindTarget()`：根据 message list、target id、scope、checkpoint 可用性判断策略。
- event payload 类型接入 `SessionEventPayload`。
- projection 记录 `lastCheckpoint` 和 `lastRewind`。
- 文件 mutation 成功后写 checkpoint artifact，并追加 `checkpoint_created`。
- `/rewind` 展示最近 checkpoint；`/rewind latest` 或 `/rewind <checkpointId>` 执行 workspace file-only restore。
- `/fork latest` 或 `/fork <checkpointId>` 创建 child session、复制消息链并恢复 workspace snapshot。
- restore 只通过 `ToolArtifactStorePort.readToolResultArtifact()` 和 `FileSystemPort.writeTextFile/removeFile()` adapter 完成，不直接触碰底层 fs。
- attachment artifact 先只做保留和引用，不随 rewind cleanup 立即删除。
- 单测覆盖 compact 后 active target、compact 前 file-only、compact 前 conversation fork-required、missing target、fork attachment fallback、rewind 不误删 artifact。

不做：

- TUI message selector。
- partial compact runtime。

## 后续里程碑

1. `contracts: rewind checkpoint payloads`
   - schema、event payload、projection、纯函数。
2. `core: create checkpoints around file mutations`
   - 写文件前后通过 file-system adapter 建 snapshot，事件带 traceId。
3. `core: file-only rewind`
   - 恢复 snapshot，追加 synthetic context message。
4. `tui: checkpoint selector`
   - 当前先通过 `/rewind` 命令和 live event 展示；后续再做 active chain target selector，compact-covered checkpoint 进入高级列表。
5. `core: fork-required conversation rewind`
   - compact 前 conversation rewind 创建 fork，而不是污染当前 active chain。
   - 第一版通过 `/fork` 明确触发；后续可以在 message selector 中把 compact-covered conversation rewind 自动转成 fork proposal。

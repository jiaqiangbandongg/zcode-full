# Read File State Resume

## 背景

用户反馈 `ZCT-202606-B2299F52` 中，Win11 上编辑既有 HTML 文件时多次被
`File has not been read yet. Read it first before writing to it.` 阻断。日志显示同一
session 里模型多次 `Read limit` 后继续 `Write` 仍失败，直到完整 `Read` 后才成功。

根因是两层语义有缺陷：

- ZCode 的 `readFileState` 只存在于当前 `ToolExecutor` runtime 内，`resume` 只恢复
  provider-visible message history，没有从历史 tool transcript 重建 read-state。
- ZCode 把 `offset` / `limit` read 当作 `isPartialView`，并且 `Write` 只接受 strict
  full read；正确的 same-runtime guard 是拒绝没读过或 `isPartialView`，`offset`
  / `limit` 本身不是 `isPartialView`。

## Resume 契约

普通 `resume` 不新增独立持久化表，也不把 read-state 写入 provider-visible history。
它从当前 active transcript 重建 runtime-local `readFileState`。Read state 至少包含
模型看到的 `content`、`offset`、`limit`、`isPartialView` 和用于 stale guard 的时间戳；
恢复来源只允许使用 completed tool part metadata 里持久化的结构化 read-state，其中时间戳
使用 `mtimeMs`，并同时保留文件系统 adapter 暴露的 `revisionId`：

- 只扫描 compact / rewind 后仍 active 的 message。
- 成功的 full `Read` 会恢复；如果该 full `Read` 被 token cap 截断，则恢复为
  `isPartialView: true` 的最新状态。显式带 `offset` 或 `limit` 的历史 `Read` 不恢复，
  也不清除同文件更早恢复出的 full `Read` 状态。
- 成功的 `Write` 会用 tool input 的完整 `content` 和 completed tool part 的结束时间恢复
  为当前文件状态。
- 成功的 `Edit` 会从当前磁盘重新读取文件内容和 mtime，恢复为当前文件状态；如果文件已
  删除或不可读，则跳过该条恢复，不阻断 session resume。
- 恢复过程只影响本 runtime 的文件 mutation guard，不产生新的模型消息、stream 事件或
  app protocol 字段。

same-runtime 读取语义：

- `isPartialView` 表示模型看到的内容不完整或被工具截断，例如 token cap 截断。
- 显式 `offset` / `limit` 是 range view，不自动等价于 `isPartialView`。
- `Write` / `Edit` 修改既有文件前必须找到同文件最新 read-state，并拒绝
  `isPartialView`。
- stale fallback 只有 strict full read 可以在 mtime 前进但内容相同的情况下放行；range
  read 遇到 mtime 前进必须要求重新读取。

## ZCode 实现边界

`AgentRuntime` 持有一个 session 生命周期内共享的 `ReadFileStateMap`，构造
`ToolExecutor` 时传入同一个 map。`resumeFromStore` 在恢复 provider-visible history 的
同阶段清空并重建该 map，保证恢复边界和 message history hydration 一致。

read-state hydrator 必须独立于 UI、desktop service 和远控 replayable stream。它只读取
`SessionStorePort.messages()` 返回的 tool parts 和当前 `FileSystemPort`，不新增
`@zcode/protocol` 字段，不改变 desktop continuous 或 web remote replayable 的消息流。

成功 full `Read` 的 completed tool part metadata 需要额外保存一个 versioned
`readFileState` snapshot：

- `tool: "Read"`，避免其他 tool metadata 被误用。
- `schemaVersion`，用于后续兼容演进。
- `path`、`content`、`offset`、`limit`、`isPartialView`、`mtimeMs`、`sizeBytes`、
  `revisionId`，对应 runtime `ReadFileStateEntry` 的可恢复字段；`mtimeMs`、
  `sizeBytes` 和 `revisionId` 必须完整存在，否则该 metadata 不参与恢复。
- `readAtMs`，使用 tool completed time 作为恢复后的水位时间。

resume 恢复优先级：

1. `metadata.readFileState` 存在、schema 匹配且 freshness metadata 完整时，直接恢复
   结构化 snapshot。
2. `metadata.readFileState` 缺失或缺少 `mtimeMs` / `revisionId` / `sizeBytes` 时跳过
   该历史 `Read`，不从 `state.output` 字符串解析 cat-n 文本。
3. 成功的 `Write` / `Edit` 仍可恢复当前文件状态；`Write` 来自 tool input 的完整
   `content`，`Edit` 来自 resume 当下的文件系统读取。

代码注释需要说明两个容易误判的点：

- 历史 range `Read` 不恢复且不清旧状态是 resume 语义，不代表 same-runtime range
  `Read` 不能作为 mutation guard 水位。
- `isPartialView` 是“模型视图不完整”的语义，不是 `offset` / `limit` 的别名。

## 验证要求

- full `Read` 后 resume，下一次 `Write` 既有文件不再报未读。
- 只有 range `Read` 的历史 resume 后，下一次 `Write` 仍报未读。
- full `Read` 后又 range `Read` 的历史 resume 后，range `Read` 不覆盖也不清除恢复出的
  full `Read`。
- full `Read` 后又 token-truncated full `Read` 的历史 resume 后，后者恢复为
  `isPartialView` 并覆盖旧 full `Read`。
- same-runtime range `Read` 后，文件未变化时 `Write` 可通过未读 guard。
- `isPartialView` read-state 仍被 `Write` 和 `Edit` 拒绝。
- compact / rewind 后，只有 active message 里的 tool 结果会恢复 read-state。
- Windows drive-letter path normalization 保持现有行为。

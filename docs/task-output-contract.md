# TaskOutput 工具契约

## 范围

- 本规范只覆盖 provider-visible `TaskOutput`、兼容别名、运行状态读取、输出投影和完成通知去重。
- 不新增 `TaskCreate`、`TaskList`、`TaskGet`、`TaskUpdate`、`remote_agent` runtime 或 ToolSearch/deferred-loading 基建。

## Provider-visible contract

Provider 只接收一个 canonical tool：

```text
TaskOutput
```

以下名称只作为本地调用别名，不重复进入 provider tools：

```text
AgentOutputTool
BashOutputTool
AgentOutput
BashOutput
```

Provider-visible description 必须逐字等于：

```text
DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
```

输入 schema 是 strict object：

| 字段      | Provider schema                                                       | Runtime                             |
| --------- | --------------------------------------------------------------------- | ----------------------------------- |
| `task_id` | required string，`The task ID to get output from`                              | 空字符串报 `Task ID is required`    |
| `block`   | required boolean，default `true`，`Whether to wait for completion`              | 省略时仍补默认值；额外兼容字符串 `"true"` / `"false"` |
| `timeout` | required number，default `30000`，min `0`，max `600000`，`Max wait time in ms` | 省略时仍补默认值；单位毫秒          |

Provider `input_schema.required` 固定为
`["task_id", "block", "timeout"]`。其中 `block`、`timeout` 同时保留 runtime default；
required 约束模型生成的 wire input，default 继续兼容本地别名、历史调用和手工调用。

工具只读、并发安全、无需审批。不声明 deferred-loading（`shouldDefer`），ZCode 当前不实现 ToolSearch 发现机制。

Provider-facing 输入错误分为两层：

- 缺少 `task_id` 字段或字段类型错误：沿用通用初始 schema validation，返回
  `<tool_use_error>InputValidationError: ...</tool_use_error>`，并标记 `is_error:true`。
- `task_id` 是空字符串：返回
  `<tool_use_error>Task ID is required</tool_use_error>`，并标记 `is_error:true`。
- `task_id` 非空但 registry 中不存在：返回
  `<tool_use_error>No task found with ID: <task_id></tool_use_error>`，并标记
  `is_error:true`。

后两项由 `TaskOutput` 的 `validateInput` 在初始 schema validation 之后、
`PreToolUse` 之前返回 `{ result:false, errorCode:1|2, message }`。失败时不运行
`PreToolUse`、权限判断、handler 或 `PostToolUseFailure`。executor 不识别具体 tool
name，只负责统一组装失败结果并结束 tool event；provider-facing `modelContent` 使用
`<tool_use_error>`，UI、日志和结构化错误继续保留不带标签的原始 message。

handler 在实际读取前仍重新检查 registry，覆盖校验后任务被删除或 hook 修改输入的竞态；
该防御性检查不改变正常任务读取和等待路径。

## 状态与通知

`RuntimeTaskRegistry` 是唯一任务存在性和状态来源：

```text
running / pending + block=false -> not_ready + 当前 task
running / pending + block=true  -> 每 100ms 轮询
                                   terminal -> success + 当前 task
                                   timeout  -> timeout + 最新 task
                                   removed  -> timeout + task:null
terminal                         -> success + 当前 task
```

- 初次查找不到任务：`No task found with ID: <task_id>`。
- `block=true` 在等待前发出一次标准 `ToolCallProgress`。ZCode 复用现有 progress
  schema，不新增 TaskOutput 专属 Protocol 字段；该内部投影不影响
  provider-visible result。
- `timeout=0` 不 sleep，直接返回当前快照。
- abort 抛出 AbortError。
- 终态输出投影成功后再原子写入 `notified:true`；投影失败或 abort 不得消费通知 claim。
- 完成通知入队前同样检查并写入 `notified`，保证 TaskOutput 与 completion 的竞争最多产生一次 `<task-notification>`。

## 输出来源

- `local_bash`：语义上优先取活动 shell task output 的 stdout、stderr，以单个 `\n` 拼接；不可用时读取任务输出文件；`exitCode` 来自执行结果。
  - 新 Bash 任务的 stdout/stderr 直接写同一个 canonical output file，
    flags、软上限和生命周期见 `docs/bash-background-parity.md`。运行中 TaskOutput 仍从
    offset 0 读取最多 30000 bytes，不添加前部省略提示，不新增环境变量覆盖；文件不可用
    时回退到执行结果 inline text / progress tail。终态或活动 snapshot 不可用时沿用
    通用 task output 文件读取，最多读取末尾 8 MiB。
  - root shell exit 即结算，不等待后代关闭输出句柄。registry 终态不承诺文件稳定，
    后代仍可继续写；再次查询可读到晚到内容，但不重新激活任务或重复发送完成通知。
    头部超过预算后，运行中重复查询可能保持相同内容；最新进度来自 Bash 的有界尾读。
  - framework error、timeout/cancel 文本仍可能存在于结构化 stderr。TaskOutput 将其追加到 canonical command output 后；由于 canonical file 不包含这部分文本，此时不得把该文件描述为完整合并输出。
  - 历史 split-path snapshot 仍可按 stdout 后 stderr 读取，但两个不同文件共同组成结果时，不新增合并 artifact，也不把任一单流路径伪装成 `Full output`。超大文本交给 TaskOutput 自身的 100000 字符持久化边界处理。
- `local_agent`：终态优先取 Agent result content blocks，以单个 `\n` 拼接；否则读取任务输出文件。输出文件缺失不影响任务存在性或状态。
- 其他已注册 ZCode task type：读取 registry 记录的通用输出文件。
- 输出文件读取失败或不存在时返回空字符串。
- 通用及终态输出文件最多读取末尾 8 MiB；省略前部时添加
  `[NKB of earlier output omitted]\n`。运行中 Bash 使用上述独立的文件头部读取规则。

`TASK_MAX_OUTPUT_LENGTH` 默认 `32000` 字符，最大 `160000` 字符；使用十进制 `parseInt` 解析，因此带合法数字前缀的字符串按该数字生效；空值、无法解析的值或非正数使用默认值。超限输出必须变为：

```text
[Truncated. Full output: <task-output-path>]

<保留的尾部>
```

当有效限制不小于前缀长度时，前缀与尾部总字符数等于有效限制。有效限制小于前缀长度时，保留原始负数 `slice` 边界行为，不额外修正。

## Provider-visible result

普通结果是纯文本。各块以两个换行分隔，且不做 XML escaping：

```text
<retrieval_status>success|not_ready|timeout</retrieval_status>

<task_id>...</task_id>

<task_type>...</task_type>

<status>...</status>

<exit_code>...</exit_code>

<output>
...
</output>

<error>...</error>
```

- `task` 为 `null` 时只输出 `retrieval_status`。
- `exit_code` 仅在值不是 `null` / `undefined` 时输出。
- `output.trim()` 为空时省略整个 output 标签；正文使用 `trimEnd()`。
- `error` 仅在 truthy 时输出。
- 禁止输出 `description`、`prompt`、`result`、`output_file`、`truncated` 或 JSON wrapper。

映射后的完整文本超过 100000 字符时，以 `text/plain` 保存完整文本（本地 artifact 使用 `.txt`），并向 provider 返回 `<persisted-output>` envelope；持久化失败时保留原始文本。ZCode 通用 `resultBudget` 不得再次改写 TaskOutput 文本。

## UI display projection

UI 专属卡片使用独立的 completed tool metadata，不解析或改写上述 provider-visible 文本：

- `task_id` 直接读取 tool input。
- Core 从 handler result 生成 `task_output` display，只保留 `retrievalStatus`、最长 64 字符的
  可选 `taskStatus`、最长 2000 字符的可选 `output` 和可选 `truncated`。
- output 使用 `trimEnd()` 后保留前 2000 字符；空白 output 不进入 display，运行中已读取的部分
  output 可以展示。
- display 不包含 task type、description、error、prompt、result、output path 或 provider XML；这些字段也不进入卡片摘要正文或展开内容。真实 tool execution failure 的错误原因只通过 `ToolCallRow.error` 形成的 `context.errorText` 进入 `ToolLayout` 通用失败状态 tooltip，允许用户 hover/copy，且不写回 `task_output` display。
- display 通过现有 completed metadata 和 V4 `ToolCallRow.display` 进入共享 UI；旧记录缺失 display
  时只展示 task id 和通用 tool lifecycle，不增加 XML/JSON fallback 或持久化迁移。

该投影仅用于桌面、普通 Web 和手机远控共用的渲染组件，不改变 TaskOutput handler、状态机、
provider adapters 或 desktop continuous / web remote replayable 的交付语义。

## 验收

- provider tool name、description、input schema 与上述 golden 完全相等。
- 两条 provider adapter 链路都原样传递 TaskOutput result 文本。
- running Agent 即使尚无输出文件，仍返回 `not_ready` 和 `running`。
- TaskOutput 读取终态与 completion notification 的两种竞争顺序都只产生一次通知。
- 默认、最大、非法、数字前缀和小于截断前缀的 `TASK_MAX_OUTPUT_LENGTH`、8 MiB 文件尾读、100000 字符文本持久化均有 focused test。
- Bash focused test 必须覆盖 canonical output file、运行中固定读取 30000 bytes 文件头部、
  timeout 后仍运行的投影、inline/tail 回退、framework stderr、历史 split-path 兼容，以及
  canonical file 对应的真实 `Full output` 路径。

# Grep Tool

实现状态（2026-05-08）：L1 已落地。core handler 只通过
`FileSystemPort.searchText` 发起内容搜索并传播 `traceId` / abort signal；Node
adapter 默认使用打包的 ripgrep WASM，并在 WASM 不可用时降级到 JS fallback。
失败路径现在包含稳定的 `cancelled` FileSystemPort 错误码和
`grep_cancelled` 工具契约码，handler 会把搜索取消映射为 `tool_cancelled`，避免
把用户取消误报成普通 I/O 失败。

## 能力

`Grep` 用于搜索文件内容。它语义上等价于受控的 ripgrep 能力：正则匹配、按 glob/type 限定文件、按输出模式返回文件列表、匹配行或计数。

模型可见 description 和 input schema description 使用 direct fallback 分支的短文案；
embedded branch 不暴露 direct `Grep` tool。input schema 不添加 `minLength`、`minimum`、
`integer` 等额外限制。

当前 ZCode 不按 model 动态切换 `Grep` description，所有模型使用同一份短文案。

`Grep` 原本按 Explore-only 内置工具设计。当前默认采用
embedded search 分支，主智能体和 `Explore` child runtime 都不暴露 direct `Grep`；
仓库内容搜索通过 Bash 中的 `grep` function 接管。Windows CMD 或 legacy shell fallback
无法注入 Bash function 时，才回到 non-embedded/direct 分支并暴露 `Grep`。

模型提示应明确：

- embedded branch 下，主智能体和 Explore 内内容搜索应使用 Bash `grep`。
- direct fallback branch 下，主智能体和 Explore 内内容搜索可以用 `Grep`。
- 主智能体不应假装当前 provider-visible tool pool 中不存在的 `Glob/Grep` 可用。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | `string` | 是 | `The regular expression pattern to search for in file contents` |
| `path` | `string` | 否 | `File or directory to search in (rg PATH). Defaults to current working directory.` |
| `glob` | `string` | 否 | `Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob` |
| `output_mode` | `"content" \| "files_with_matches" \| "count"` | 否 | `Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".` |
| `-B` | `number` | 否 | `Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.` |
| `-A` | `number` | 否 | `Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.` |
| `-C` | `number` | 否 | `Alias for context.` |
| `context` | `number` | 否 | `Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.` |
| `-n` | `boolean` | 否 | `Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.` |
| `-i` | `boolean` | 否 | `Case insensitive search (rg -i)` |
| `-o` | `boolean` | 否 | `Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.` |
| `type` | `string` | 否 | `File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.` |
| `head_limit` | `number` | 否 | `Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).` |
| `offset` | `number` | 否 | `Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.` |
| `multiline` | `boolean` | 否 | `Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.` |

`-o` 只在 `output_mode: "content"` 生效；`files_with_matches` 和 `count` 模式必须忽略
`onlyMatching`。当 `multiline: true` 的 match 跨行时，adapter 必须按 `rg -n -o`
语义把匹配文本展开成多条非空行 entry，并递增 `lineNumber`，不能把内嵌换行保留在
单条 provider-visible entry 中。若同时请求 `-A` / `-B` / `-C` / `context`，上下文行仍应
作为 `matched: false` 的完整行 entry 返回。provider-visible runtime 以 `--json`
解析路径为准：LF/CRLF 是行结束符，末尾换行不产生额外空行，单独的 `\r` 保留为匹配文本；
零长度 regex match 仍按 native ripgrep 结果保留空字符串 entry。

## 输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | `"content" \| "files_with_matches" \| "count"` | 实际输出模式。 |
| `durationMs` | `number` | 搜索耗时。 |
| `numFiles` | `number` | 返回文件数。 |
| `filenames` | `string[]` | `files_with_matches` 模式下的文件列表。 |
| `content` | `string` | `content` 或 `count` 模式下的文本结果。 |
| `numLines` | `number` | content 模式返回行数。 |
| `numMatches` | `number` | 搜索到的匹配数。 |
| `truncated` | `boolean` | 是否因 `head_limit` 或结果预算截断。 |
| `appliedLimit` | `number` | 实际触发的条数限制。未截断时省略。 |
| `appliedOffset` | `number` | 实际偏移。未设置时省略。 |

## 权限与副作用

- `readOnly: true`
- `destructive: false`
- `sideEffectScope: "none"`
- `concurrentSafe: true`
- `needsApproval: false`

`Grep` 只能通过 `FileSystemPort.searchText` 访问文件系统。core 不得直接调用 `fs`、`child_process` 或 shell。

Node adapter 默认使用随包发布的 ripgrep WASM 能力执行内容搜索。WASM ripgrep 是基础设施层细节：它不暴露给 core，不要求用户系统安装 `rg`，也不通过 shell 执行外部命令。adapter 必须保留受控 JS fallback，用于 WASM 初始化失败、打包环境不支持 WASI 或测试注入；fallback 的行为应尽量保持与 ripgrep 输出契约一致。

第一版不新增 `ZCODE_` 环境变量开关。普通 npm 包和 SEA 打包都必须把 ripgrep WASM 运行时代码纳入发布产物，详见 `docs/design/v2/tool/11-ripgrep-wasm-packaging.md`。

## 结果预算

默认 `head_limit` 为 250，避免宽泛搜索污染上下文。`head_limit: 0` 是显式无限输出请求，但 executor 仍必须应用 `resultBudget`，必要时落盘到 artifact/storage。

## 失败路径

- `invalid_path`：`path` 不是文件/目录、不存在，或被后续 filesystem permission adapter 拒绝。
- `invalid_pattern`：ripgrep 报告正则解析失败，或 JS fallback 无法编译正则。
- `permission_denied`：路径权限被拒绝。
- `too_large`：单文件、总结果或 WASM 输出超过 adapter 能力上限且无法降级。
- `io_error`：底层文件系统错误。
- `cancelled`：调用取消时 adapter 应在进入搜索前和搜索返回后检查取消状态；JS fallback 在遍历和读取期间也必须持续检查取消状态。

## Trace

handler 调用 `FileSystemPort.searchText` 时必须传播统一执行上下文。搜索的 adapter I/O、截断状态、错误和结果预算序列化都应归属同一个 `traceId`。

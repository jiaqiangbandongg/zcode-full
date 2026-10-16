# Glob Tool

## 能力

`Glob` 用于按文件名或路径 glob 模式查找文件。它只回答“哪些文件路径匹配这个模式”，不读取文件内容，也不承担内容搜索职责。

`Glob` 原本按 Explore-only 内置工具设计。当前默认采用
embedded search 分支，主智能体和 `Explore` child runtime 都不暴露 direct `Glob`；
仓库路径搜索通过 Bash 中的 `find` function 接管。Windows CMD 或 legacy shell fallback
无法注入 Bash function 时，才回到 non-embedded/direct 分支并暴露 `Glob`。

模型提示应明确区分：

- embedded branch 下，主智能体和 Explore 内找文件名、扩展名、目录结构时应使用 Bash `find`。
- direct fallback branch 下，主智能体和 Explore 内找文件名、扩展名、目录结构时可以用 `Glob`。
- 主智能体不应假装当前 provider-visible tool pool 中不存在的 `Glob/Grep` 可用。

模型可见 description 使用短文案：direct fallback branch 中 `Glob` 的 provider-visible
description 固定为：

`Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.`

当前 ZCode 不按 model 动态切换 `Glob` description，所有模型使用同一份短文案。

开放式多轮搜索不在 `Glob` description 中引导。ZCode 当前按 branch 切换 provider-visible
search surface：embedded branch 通过 Bash `find` / `grep` 接管；direct fallback branch 才保留
`Glob`、`Grep`、`Read` 组合完成多轮搜索。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | `string` | 是 | `The glob pattern to match files against` |
| `path` | `string` | 否 | `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.` |

Provider-visible input schema 不添加 `minLength` 等额外限制；运行时路径解析仍由 tool layer 和 `FileSystemPort` 负责。

## 输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `durationMs` | `number` | 搜索耗时。 |
| `numFiles` | `number` | 返回文件数。 |
| `filenames` | `string[]` | 匹配文件路径。路径尽量相对 session cwd，节省 token。 |
| `truncated` | `boolean` | 是否因结果上限截断。 |

## 权限与副作用

- `readOnly: true`
- `destructive: false`
- `sideEffectScope: "none"`
- `concurrentSafe: true`
- `needsApproval: false`
- 权限规则匹配 `path` 和 `pattern`，deny 优先于 ask。

`Glob` 只能通过 `FileSystemPort.searchFiles` 访问文件系统。core handler 不得直接调用 `fs`、`child_process` 或 shell。

## 结果预算

默认最多返回 100 个路径。结果超过模型预算时必须通过 `resultBudget` 截断或进入 artifact/storage。

## 失败路径

- `invalid_path`：`path` 为空、不是目录，或被后续 filesystem permission adapter 拒绝。
- `invalid_pattern`：glob pattern 为空或无法解析。
- `permission_denied`：路径权限被拒绝。
- `io_error`：底层文件系统错误。
- `cancelled`：调用取消时 adapter 应停止遍历。

## Trace

handler 调用 `FileSystemPort.searchFiles` 时必须传播 `traceId`、`spanId`、`parentSpanId`、`sessionId` 和 `turnId`。

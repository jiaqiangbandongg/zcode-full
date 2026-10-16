# Ripgrep WASM Packaging

## 背景

`Grep` 是 NL->Code 中最常用的探索工具之一。之前的 Node adapter 使用 TypeScript 文件遍历和正则匹配实现内容搜索，能满足基础契约，但在大型仓库中性能、glob/type 语义和 multiline/context 行为都容易偏离成熟的 ripgrep。

从 v2 开始，`FileSystemPort.searchText` 的 Node adapter 默认使用随 npm 包发布的 ripgrep WASM。这样普通 Node CLI、SEA 单文件包和跨平台发布都不依赖用户机器预装 `rg` 原生命令。

## 目标

- `Grep` 默认走 bundled ripgrep WASM，语义向 ripgrep 靠齐。
- core 仍只依赖 `FileSystemPort.searchText`，不知道 ripgrep 的存在。
- 不新增 `ZCODE_` 环境变量；搜索能力由 adapter 和发布产物决定。
- 普通 npm 包发布和 SEA 打包都包含 ripgrep WASM 运行时代码。
- WASM 不可用时保留 JS fallback，保证工具可降级。

## 非目标

- 不通过 shell 调用用户系统里的 `rg`。
- 不要求用户安装 Rust ripgrep 原生命令。
- 不在 core/tool handler 中引入 `fs`、`child_process` 或 WASI 细节。
- 不把大体积搜索结果直接灌入模型上下文；仍由 `head_limit` 和结果预算约束。

## 依赖与边界

Node adapter 依赖 `ripgrep@0.3.1`。该包以 ESM 形式导出 WASM ripgrep API，WASM 字节码随包嵌入，不依赖平台原生二进制。

依赖边界：

- `@zcode/adapters` 负责导入和调用 WASM ripgrep。
- `@zcode/contracts` 只定义 `FileSystemPort.searchText` 输入输出和错误契约。
- `@zcode/core` 只调 port，不依赖 ripgrep 参数、WASI、包路径或打包细节。

## 搜索参数映射

| `FileSystemSearchTextRequest` | ripgrep WASM 参数 |
| --- | --- |
| `pattern` | `-e <pattern>`，避免以 `-` 开头的 pattern 被解析为 flag。 |
| `path` | 作为 WASI preopen root 下的搜索目标。 |
| `glob` | `--glob <glob>`。 |
| `type` | adapter 转换为 ripgrep `--glob` 扩展名过滤，并在解析结果后再次按 `matchesFileType` 校验，避免 ripgrep 内置 type 别名差异影响契约。 |
| `ignoreCase` | `-i`。 |
| `multiline` | `--multiline --multiline-dotall`。 |
| `outputMode: "content"` | `--json`，解析 match/context event。 |
| `outputMode: "files_with_matches"` | `--count`，再从非零 count 推导文件列表和匹配数。 |
| `outputMode: "count"` | `--count`。 |
| `beforeContext` / `afterContext` / `context` | `-B` / `-A` / `-C`。 |
| VCS 目录 | adapter 追加排除 `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl` 的 glob。 |

`headLimit` 和 `offset` 仍在 adapter 侧应用，保证三种输出模式的截断语义一致。

## 打包

普通打包路径必须让 bundler 能解析 `ripgrep` 及其内部 WASM ESM 模块。构建验证应覆盖 `packages/cli` bundle。

SEA 打包路径必须继续从标准 Node CLI 产物出发构建单文件包。因为 ripgrep WASM 已嵌入为 JavaScript 模块，SEA 不需要额外复制平台原生二进制；如果后续更换依赖为外置 `.wasm` 文件，必须先更新本 spec，明确 asset 复制、运行时定位和跨平台测试。

## 错误行为

- ripgrep exit code `1` 表示无匹配，返回空结果，不视为错误。
- ripgrep 正则解析错误映射为 `invalid_pattern`。
- ripgrep 路径、权限或 WASI I/O 错误映射为 `not_found`、`permission_denied` 或 `io_error`。
- WASM 初始化、加载或运行时不支持时，adapter 可降级到 JS fallback；降级失败后按原始错误归类。
- 取消信号至少在搜索前后检查；JS fallback 还需要在遍历和读文件之间检查。

## 测试覆盖

- adapter 单测覆盖 `content`、`files_with_matches`、`count`。
- 覆盖以 `-` 开头的 pattern，证明实现使用 `-e`。
- 覆盖 `glob`、`type`、`ignoreCase`、`context`、`multiline`。
- 覆盖 ripgrep invalid regex 到 `invalid_pattern` 的映射。
- 覆盖普通 CLI bundle 能构建；SEA 脚本测试继续验证构建参数和 asset 行为。

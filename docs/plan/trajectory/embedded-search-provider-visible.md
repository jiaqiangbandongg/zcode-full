# Embedded Search Branch

## 目标

ZCode 默认启用 embedded search branch：provider-visible 默认隐藏 direct Glob/Grep，并在 prompt 中指导 Bash `find` / `grep`；runtime 层通过 Bash prelude 接管 `find` / `grep`。

Windows CMD 和 legacy shell fallback 暂时不启用 embedded branch，回到 direct Glob/Grep，避免 provider-visible 文案声称存在 Bash function 但运行时无法注入。

## Branch 目标行为

- embedded search gate 开启且 Bash 可用时进入 embedded search branch。
- Bash 初始化时注入 `find` / `grep` function，由 embedded search backend 执行（bundled 形态下分发到 `bfs` / `ugrep`）。
- shell snapshot 检查 `rg` 可用性：只有当 `unalias rg` 后仍找不到系统 `rg` 时，才补充 embedded `rg` function 或 alias。`rg` 是缺失补齐，不像 `find` / `grep` 一样强制 shadow。
- `grep` function 默认通过 `ugrep` 加上 `-G --ignore-files --hidden -I`，并排除 `.git/.svn/.hg/.bzr/.jj/.sl`；遇到 `-*-filter*`、`-*-pager*`、`-*-view*`、`-*-format-open*`、`-*-config*`、`---*`、`-@*`、`-*-save-config*` 时绕回系统 `grep "$@"`。
- shell function 会检查内部 binary 是否可执行，不可用时降级为系统 `find` / `grep "$@"`。
- Windows 下只在 Git Bash/MSYS/Cygwin 这类 POSIX shell 里注入 embedded search function；遇到 `msys` / `cygwin` / `win32` 时使用 `ARGV0=... "<binary>"` 形式调用，避免依赖 `exec -a`。
- Windows shell snapshot 会把内部 binary、snapshot 文件、cwd capture 文件等宿主路径转换成 Git Bash 可识别的 `/c/...` 或 `//server/...` 形式，并会过滤 Git Bash 自动生成的 `winpty` aliases。
- embedded branch 下 provider-visible `tools[]` 不暴露 direct `Glob` / `Grep`。
- embedded branch 下 Bash description 的 avoid list 不包含 `find` / `grep`，exact 剩余项是 ``cat``, ``head``, ``tail``, ``sed``, ``awk``, or ``echo``。
- embedded branch 下 Explore prompt 使用：
  - `Use \`find\` via Bash for broad file pattern matching`
  - `Use \`grep\` via Bash for searching file contents with regex`
- embedded branch 下 Plan prompt 使用 ``find``/Glob, ``grep``/Grep, and Read 查找 patterns/conventions。
- Glob/Grep direct tool description 另有 short/long prompt 分支，按模型选择；它不等同于 embedded search gate。
- embedded branch 的 provider-visible request 以合同测试为证据；direct branch 的 short Glob/Grep description 由 dedicated contract baseline 单独校验。

## ZCode 实现策略

实现拆成三层：

- branch capability：模型感知的 `evaluateEmbeddedSearchBranchCapability` / `resolveEmbeddedSearchBranchCapability`，形态参考 MCS capability helper。当前默认 global flag 为开启，后续可在同一函数里按模型或 runtime gate 决定是否启用。
- Bash prelude builder：根据 backend 生成 `find()` / `grep()` shell function，并在用户环境缺少 `rg` 时补充 `rg()` function。
- embedded search backend：第一版使用 `internal-cli` 透明转发到宿主环境真实 `find` / `grep`，未来可切换到 `argv0-dispatch`（单 binary 按 `ARGV0` 分发 `bfs` / `ugrep`）。

## 当前实现边界

- capability helper 位于 `apps/zcode-cli/packages/core/src/embedded-search/capability.ts`，供 runtime 和 tool executor 共用，避免 tool 层反向依赖 runtime helpers。
- bootstrap 默认注入 `internal-cli` backend；可用 `ZCODE_EMBEDDED_SEARCH_COMMAND` 覆盖一期 backend command。
- `internal-cli` 不手写 `find` / `grep` 参数子集解析；它默认透传 argv、stdin、stdout、stderr 和 exit code，避免模型生成真实参数时被 ZCode shim 拒绝。
- `internal-cli rg` 复用 `ripgrep` WASM 依赖执行真实 `rg` 参数，并只在 shell 中没有可用 `rg` 时由 prelude 补齐；它不是 `grep` 的替代，也不改变 `Grep` tool 的 provider-visible contract。
- `grep` shell function 会先按上述 bypass 列表绕回系统 `grep "$@"`；`internal-cli grep` 也保留同一套 bypass，保证直接调用 backend 时仍不混入默认参数。
- `internal-cli` 的 `grep` 会低成本实现 embedded branch 的默认噪音控制：非特殊参数场景前置 `-G -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl`。
- provider-visible embedded search branch 独立于 shell prelude support；即使 shell selection 是 CMD，main 和 Explore 仍按 embedded branch 隐藏 direct Glob/Grep。
- runtime Bash prelude 注入默认对 POSIX shell selection 和 Windows Git Bash 开启；CMD / legacy shell fallback 不注入 POSIX function。
- adapter 的 Git Bash prelude path conversion 会在 Git Bash prelude 注入时使用，确保 backend command 和 Windows 绝对路径参数转换成 Git Bash 路径。
- 默认 main 和 Explore 的 runtime provider-visible tools 在 embedded branch 下不暴露 direct Glob/Grep；只有 embedded branch 被关闭或 Bash 不可用时才回到 direct Glob/Grep。
- Bash request 只有在 `embeddedSearch.enabled === true`、backend 存在且 session shell selection 支持 runtime prelude 注入时才带 `bashPrelude`。
- Bash prelude 的 `internal-cli` backend 会先检查 backend command 是否可执行；如果不可用，shell function 降级到系统 `find` / `grep "$@"`。
- `argv0-dispatch` 已在 prelude contract 中保留，并带完整 `ugrep -G --ignore-files --hidden -I --exclude-dir=...` 默认参数；当前默认仍是 `internal-cli`。

## Provider-visible tool contract 边界

本轮以 provider-visible tool contract 合同测试为基线，而不是本地导出的请求记录；导出的 provider-visible fixture 只作为回归证据。排序分区内的工具按 `name.localeCompare(...)` 排序，并在 embedded search branch 的候选列表里跳过 direct `Glob` / `Grep`。

本轮只调整 ZCode 已支持的 provider-visible 表面：

- `AskUserQuestion`：更新 provider-visible input schema。
- `Bash`：使用 embedded search branch 的短版 description；该分支 avoid list 不包含 `find` / `grep`，timeout 文案使用默认 `120000` 和 max `600000`。运行时 timeout 默认值不在本轮范围内。
- `Read`：不新增 `pages` 等 ZCode 未支持的 provider-visible 参数，只更新短版 prompt 中 ZCode 已支持能力的文本。
- `EnterPlanMode`：使用短版 prompt。embedded search branch 中探索工具文案使用 ``find``/Glob、``grep``/Grep、Read。
- `ExitPlanMode`：保留 ZCode 当前没有 plan file 系统、schema 仍要求模型传 `plan` 参数；在这个边界内使用短版 prompt 结构和语义。
- `WebFetch`：使用短版 prompt。
- `WebSearch`：更新 provider-visible input schema。
- 工具顺序：排序分区只包含 ZCode 已注册的工具；分区内工具（含本地约定纳入分区的工具）按 `name.localeCompare(...)` 排序，其余工具按本地注册/过滤后的相对顺序追加到末尾。

`TodoRead` / `TodoWrite` 作为本地约定纳入排序分区并按自身名称排序；这不映射到 `Task*` 排序槽位，也不表示 ZCode 已实现 `Task*` 的 id-based task-store 语义。

## 实现取舍

- 当前 gate 不区分 provider/source/variant，统一视为启用。
- embedded branch 的第一版不使用 `ARGV0=bfs/ugrep` 自分发二进制，而是通过 `internal-cli` backend 降低实现成本；参数能力不打折，跟随宿主真实 `find` / `grep`，并补齐低成本的 `grep` 默认排除、`-I`、`-G`、特殊参数 bypass 和 prelude fallback。
- `internal-cli` 是实现策略，不是架构事实；公共边界命名为 `EmbeddedSearchBackend`。
- CMD 当前有意走 non-embedded/direct branch。后续若要支持 PowerShell/CMD 等非 POSIX shell，需要单独设计 provider-visible wording 与运行时 shim，不能复用 Bash function prelude。
- ZCode 暂不新增 `Cron*`、`EnterWorktree`、`ExitWorktree`、`LSP`、`NotebookEdit`、`ScheduleWakeup`、`Task*`、`Workflow` 默认注册能力。
- `ExitPlanMode` 暂不实现 plan file 读取系统，因此 prompt 会明确要求 `plan` 参数。

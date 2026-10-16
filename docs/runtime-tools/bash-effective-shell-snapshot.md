# Bash Effective Shell Snapshot

## 背景

Bash tool 的 shell 选择会同时影响三类行为：

- Bash 命令实际由哪个 shell 执行。
- provider-visible 的 `# Environment` 里展示哪个 Shell。
- Explore 子任务继承到的执行环境和 prompt 环境。

过去这些信息分别从环境变量、执行 adapter、settings/runtime config 中读取，容易出现“模型看到的 shell”和“Bash 实际执行的 shell”不一致。这个文档定义统一后的运行时契约。

## 核心契约

运行时维护一个 session 级别的 `ExecutionShellSelection`，它是 Bash tool 的有效 shell 快照。新 session 的初始状态是未初始化；第一次真正接受用户 prompt 前才把当前候选 shell 初始化为 session-start 快照。

- 普通 session 创建和 deferred draft 预热都不解析用户配置的 shell selection。
- `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` 是 session shell environment 的唯一 owner，负责初始化、读取、EnvInfo patch、持久化和 resume 恢复。
- session 第一次接受输入前，统一用户执行边界通过 `session/requestRuntimePreferences` 的 `user-execution` scope 向所属 Host 读取一次当前 shell 候选值，再由 `initializeSessionShellEnvironmentIfNeeded()` 初始化。该请求最多等待 15 秒；超时按协议错误阻断首次用户执行，不重试或静默回退到其他 shell。
- 初始 `# Environment` 的 `Shell` 字段只展示这个 session-start 快照的 `display.name`。
- Bash tool 执行时使用同一个 selection。
- Explore 子任务的 prompt 环境和 child runtime 继承同一个 selection。
- 如果用户在同一 session 中切换 shell，当前 session 不会热更新；用户需要新建 session 才会生效。
- deferred draft session 只是新会话的隐藏预热态，不是用户已经开始的稳定会话。预热创建时不读取用户配置的 shell selection。
- legacy `session/send`、V4 `sendText`、create/resume/subscribe 都不携带 shell 候选值；Host 读取只发生在 Agent 的统一首次用户执行边界，不能让 desktop/mobile 或各 command 入口分别维护分支。
- app 层的普通 prompt、goal external activity、expert workflow 和 script workflow 共用同一个用户执行边界。任何会创建首条用户可见事实、启动模型 turn 或 workflow child agent 的入口，都必须先调用这个边界初始化 shell snapshot，再持久化 session 或创建子 runtime。
- Protocol 的 `session/create` / `session/resume` 不接受 shell 候选值，避免调用方误以为可以在创建或恢复阶段覆盖 session shell。
- session 第一次真正落库时，runtime 会把创建时的 shell selection 写入 `session_entry`。
- cold resume 时由 core runtime 优先读取这个持久化 selection 重建 runtime config，而不是重新读取最新 settings。
- cold resume 会先校验持久化 selection 是否仍可用：`legacy-shell` 可以没有 path；Windows `cmd.exe` fallback 继续按原有语义接受；其他具体 shell path 必须仍是可执行文件。失效时不把旧 path 交给 Bash executor，而是回退到 resume 入口已经解析出的当前 selection。
- legacy session 如果没有持久化 selection，或持久化 selection 已失效，只能按当前自动解析逻辑 best-effort 恢复；当历史 `# Environment` 的 Shell 与当前执行 shell 不一致时，必须通过 `shell_environment_change` attachment 告知模型。Windows legacy session 被当前 auto Git Bash 接管时，即使历史 `# Environment` 没有可靠 Shell 字段，也会插入一次 Git Bash shell 提醒，避免模型继续沿用旧 shell 习惯。

## Bash Runtime `.sh` Snapshots

Bash tool 运行时有三种名字相近但职责不同的 snapshot：

1. session shell selection snapshot
   - 由 `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` 管理。
   - 决定当前 session 的有效 shell、provider-visible `# Environment` Shell 字段、Explore 继承的 shell display。
   - session 创建后不会因为 settings 切换而热更新。

2. shell init snapshot
   - 由 `apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts` 管理。
   - POSIX/Git Bash 下，adapter 首次用 login shell 执行 snapshot creation script，source 用户 rc 文件，并把 functions、aliases、shell options、PATH 写入 ZCode storage 下的 `shell-snapshots/snapshot-${shell}-${timestamp}-${random}.sh`。
   - functions/options/aliases 的导出策略：只在用户 rc 存在时导出，过滤单下划线补全函数，options/aliases 输出最多 1000 行，并在 Git Bash/MSYS/Cygwin 下过滤 `winpty` aliases。
   - snapshot creation script 使用 adapter 侧 host path 写文件；Git Bash path 转换只发生在后续真实命令 source snapshot 时。
   - 创建成功后，后续 Bash tool command 会先 source 这个 snapshot，再用非 login shell 执行真实命令，即 spawn args 从 `-c -l <command>` 变为 `-c <command>`。
   - 创建失败时降级为原行为，继续使用 `-c -l <command>`。
   - hot resume 如果仍复用同一个 adapter/manager，可以继续复用当前进程内 ready snapshot。
   - cold resume 不恢复 snapshot 文件 path；恢复 session shell selection 后，第一次 Bash toolcall 重新创建 shell init snapshot。
   - cold resume 或新 adapter 不会扫描/复活旧 snapshot，也不会按 session/hash 复用同名文件；新进程会创建新的随机 snapshot 文件，旧残留只由 retention cleanup 处理。
   - 每次真实 Bash command 执行前都会重新检查 cached snapshot 文件是否仍可访问；如果文件已丢失，本次回退为 login shell，不跳过 `-l`。
   - 如果用户在 snapshot 创建期间取消命令或关闭 adapter，真实模型命令不会继续 spawn。
   - 当前进程创建成功的 snapshot 会在 `NodeExecutionAdapter.close()` 时尝试 unlink；异常残留会由 retention cleanup 清理。
   - retention cleanup 默认删除 `shell-snapshots/` 顶层 mtime 超过 30 天的 `.sh` 文件。
   - CMD 和 legacy shell 不创建也不 source shell init snapshot。

3. ZCode startup script snapshot
   - 由 `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts` 根据 execution request 的 `bashPrelude` 生成并物化；不再有 core 侧 `bash-startup.ts` descriptor。
   - 这个脚本是 ZCode 内部执行基础设施，不是 provider-visible prompt content，也不改变 tool schema。
   - `rg` fallback 始终保留；`find` / `grep` 是否映射到 `bfs` / `ugrep`，由根 Session runtime 物化时固定的增强搜索启动偏好决定，默认启用。

执行顺序是：先 source shell init snapshot，再 source ZCode startup script，最后执行模型命令和 cwd capture trailer。snapshot 文件 path 不作为 session state 持久化；cold resume 后由 adapter 基于恢复后的 shell selection lazy 创建新的随机 snapshot。旧文件不能直接作为 ready snapshot 被恢复。

## Selection 结构

`ExecutionShellSelection` 是跨 contracts、adapters、core、bootstrap 的唯一 shell selection 数据结构。

- `dialect`：执行包装语义，当前为 `posix`、`git-bash`、`cmd` 或 `legacy-shell`。
- `source`：selection 来源，当前为 `auto-detected`、`user-config` 或 `legacy-fallback`。
- `path`：已解析出的可执行路径。legacy fallback 可以没有路径。
- `display.name`：provider-visible 的稳定名称，例如 `zsh`、`bash`、`Git Bash`、`CMD`、`system shell`。这里禁止展示绝对路径。
- `id` / `label`：设置项或诊断展示用元数据，不作为 provider-visible contract。

Runtime config 只以 `bashShellSelection` 作为 source of truth。底层 execution adapter 的 command 仍使用既有 `shellOverride` 字段承载这个 selection，但 runtime / tool context 不再维护第二份 `bashShellOverride` 状态。

## 解析规则

macOS / Linux:

- 优先解析可用的 `zsh` / `bash`。
- 如果 `$SHELL` 本身是可执行的 `zsh` 或 `bash`，可以直接使用。
- 如果用户使用 `fish` 等非 Bash-compatible shell，不把 `fish` 作为 Bash tool shell；继续从 `PATH` 和固定路径中找 `zsh` / `bash`。
- 找不到 `zsh` / `bash` 时，返回 `legacy-fallback`，保留旧的 generic shell fallback 行为。

Windows:

- 用户显式选择 Git Bash 时，优先使用该 selection。
- 用户显式选择 CMD 时，优先使用 CMD。
- 自动模式下优先解析 Git Bash。
- 找不到 Git Bash 时返回 `legacy-fallback`，保留旧的 cmd / ComSpec fallback 行为。

## Prompt 与缓存

`# Environment` 是 session-start 快照，不会因为同一 session 内用户切换 shell 而被重写。这样可以避免 prompt-cache 被整段 system context mutation 击穿。

切换 shell 不会向已有 session 追加 `shell_environment_change` attachment。因为 Bash 执行仍然使用 session-start selection，模型看到的初始 `# Environment` 和真实 Bash 执行环境保持一致。

例外是 legacy/no-usable snapshot 的 cold resume：这类会话没有稳定的 session-start shell selection 可恢复，runtime 只能用当前解析出的 selection 继续执行。若 Windows 上最终由 auto Git Bash 接管，会通过 `shell_environment_change` 插入一次短提醒，告诉模型后续 Bash command 当前使用 Git Bash 执行。这不是同 session 内 shell hot update，也不会读取用户最新设置覆盖已有可用 snapshot。

`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` 在统一用户执行边界 lazy 请求一次 Host 候选值，并在 app 生命周期内复用该结果。Host 候选无效或未显式选择时，再由 CLI 运行环境的 `resolveEffectiveBashShellSelection()` 自动解析。已有或持久化 selection 的 session 会忽略候选值；持久化 selection 的读取、可用性校验和 fallback 应用统一由 `AgentRuntime.resumeFromStore()` 负责。

deferred draft 预热不冻结 shell；首次真实用户执行前才读取。desktop continuous、web-remote replayable、legacy/V4 prompt、goal external activity、expert workflow 和 script workflow 都必须经过同一 app/runtime admission。desktop-attached remote 通过 workspace-scoped Agent service 请求回到 desktop shared Host 的本地 `SettingService`；手机 `/remote` 复用该 Host。relay/main 不保存 shell 设置，远端 `~/.zcode/v2` 也不作为 desktop-attached workspace 的权威源。

旧 Host 返回 `-32601` 或 Agent 尚未连接 Host 返回 `-32020` 时，保持 CLI 自动解析；其他协议、resolver 或传输错误原样失败。这里不新增 per-send pull、设置广播、缓存同步或 Session 级 setting snapshot。

## Explore 继承

Explore 子任务继承父 runtime 的有效 shell selection：

- child prompt 的 `EnvInfo.shell` 使用父 selection 的 `display.name`。
- child runtime 的 Bash tool 执行也使用同一个 selection。

这样 Explore 里模型看到的 Shell 和真实 Bash 执行路径保持一致。

## 非目标

- 不在 provider-visible 文本里暴露绝对 shell 路径。
- 不把 app-global shell 设置复制为 remote-scoped setting；远端只通过所属 shared Host 按需读取一次。
- 不因为自动解析失败而让 Bash tool 直接 spawn error；解析失败继续走原来的 generic shell fallback。

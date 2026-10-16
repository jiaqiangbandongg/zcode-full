# Git 自动刷新

## 背景

顶部 Git 操作入口和底部 Git 分支切换器都依赖 `useGitRepository` 读取的
`GitRepositorySummary`。历史实现只在 workspace 切换、Git pane 打开、用户手动刷新，
以及 Git 操作完成后重拉状态；如果用户在外部编辑器修改文件或切换分支，UI 会停留在旧状态。

## 实现

`useGitAutoRefresh` 在当前 workspace 可见且 Git 可用时，根据 workspace Host 的平台和
`gitSummary.autoRefreshWatchPaths` 注册 `fileWatcherService.watch()`。Git service 只返回
Git 自身解析出的 gitdir/common-dir 元数据路径，避免把 workspace 内容路径作为跨端共享的
递归监听事实源；这同时兼容 monorepo 子目录和 linked worktree。

- macOS / Windows workspace：保留 workspace 内容路径的递归 watcher，并补充 Git 元数据路径。
- Linux workspace（包含本地 Linux、SSH、WSL、Docker）：只监听 Git 元数据路径，不递归监听
  整个 workspace。Linux 上的递归 `fs.watch` 需要遍历子目录，在慢挂载或大型生成目录下会
  阻塞 workspace Host，进而延迟 task/session RPC。
- workspace Host 平台尚未返回，或旧 server summary 仍携带 workspace 内容路径时：按 Linux
  的保守策略处理，不注册 workspace 递归 watcher；手动刷新和 Git 操作完成后的刷新链路保持不变。

事件到达后，hook 会做 1 分钟防抖，然后触发现有 `onRefreshGit()`，复用原来的
`gitRefreshVersion` 刷新链路。

这条链路覆盖：

- macOS / Windows 外部编辑器修改、创建、删除文件后，顶部 Git 操作入口重新判断 dirty 状态。
- 所有平台的外部命令切换分支、提交、stage/unstage 后，底部分支名和 push/commit 入口同步更新。
- Linux workspace 的工作树外部编辑不会由 workspace watcher 触发即时 dirty 刷新；用户可手动刷新，
  ZCode/Git 操作完成后的既有刷新链路不变。
- 远程 workspace 继续通过 workspace-scoped services 注册 watcher；WSL/SSH/Docker 的平台事实
  来自远端 Host 的 `systemService.info()`，不能使用桌面端平台判断。远程断连或平台不支持
  watch 时，监听失败只记录 warn，保留手动刷新和操作后刷新链路。

## 取舍

这里没有使用固定间隔轮询。轮询会在大仓库和远程 workspace 上持续产生 Git CLI/RPC 开销；
事件触发只在文件系统实际变化时刷新，更适合桌面端和 Web 远控共享的工作区模型。

## 大仓库状态降级

`git status --untracked-files=all` 的详细输出可能因为缓存目录或生成产物包含上万个未跟踪文件而
超过 Git 命令的输出预算。此时不能直接放大预算：详细状态返回后还会逐个读取未跟踪文件统计行数，
会把一次 UI 刷新放大成上万次并发文件读取。

Git repo 在首次发现详细状态超限后，必须对当前 `repoRoot` 做运行期能力降级：

- 重新执行 `git status --untracked-files=normal`，把未跟踪目录折叠成目录级记录，保证分支、
  tracked change、dirty 状态和可操作的未跟踪入口仍能返回。
- 同一个 repo 实例内后续刷新直接使用折叠模式，不再重复触发一次必然超限的详细命令。
- 降级只按实际路径语义的 `repoRoot` 建 key，不使用 `workspaceIdentity`；不同远端 server 的
  Git service 进程天然隔离。
- 正常规模仓库仍使用 `--untracked-files=all`，保持逐文件展示语义不变。
- 第一次降级记录一条 `warn`，后续刷新不重复刷相同告警；折叠模式仍超限时继续按真实失败处理，
  不解析被截断的 Git 输出。

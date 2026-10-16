# 项目移除释放 Workspace Runtime

## 背景

Windows 会把进程当前工作目录和打开的文件句柄视为目录占用。用户在 ZCode 侧边栏移除项目并退出应用后，如果该项目对应的 Agent、终端、文件监听或远端 runtime 仍未释放，项目目录可能仍无法删除或重命名。

另一个 Windows 兼容风险是保留设备名文件。`nul`、`con`、`aux`、`com1`、`lpt1` 等名字在 Windows Win32 路径解析中不是普通文件名；一旦项目内存在这类文件，用户后续在资源管理器或普通 PowerShell 命令里删除、重命名项目目录时可能遇到 “MS-DOS 功能无效”。

## 问题

“移除项目”是一个 workspace 生命周期动作，不只是 UI 入口移除。旧行为只关闭 tab 并失效任务缓存：

```text
点击侧边栏项目移除
  -> closeTab(tab.id)
  -> invalidateTaskQueryCacheByScopes(...)
```

这会让项目从侧边栏消失，但不会保证 host 内该 workspace 的预热 Agent 或 runtime 被释放。`useWorkspaceShellLifecycle` 只在 App workspace 组件卸载时 best-effort 回收未使用预热态，无法覆盖侧边栏直接移除项目的入口。

旧行为也不会在移除前提示该 workspace 下仍有运行中 chat/runtime。用户可能无感移除一个仍在 `creating`、`restoring` 或 `streaming` 的对话。

## 目标行为

侧边栏移除项目时，必须先检查运行中 chat/runtime，再触发 workspace runtime 释放：

```text
点击侧边栏项目移除
  -> 读取当前 workspace task runtime 状态
  -> 如果存在 creating/restoring/streaming task 或 draft runtime
       -> 弹确认：移除会停止该项目运行中的对话/Agent
       -> 用户取消：不移除
       -> 用户确认：继续
  -> closeTab(tab.id)
  -> zcodeTaskService.releaseWorkspacePreparation({ workspacePath, workspaceIdentity?, provider })
       -> zcodeAgentService.disposeWorkspace(...)
       -> zcodeAgentProcessManager.disposeWorkspace(...)
       -> Windows taskkill /T /F 清理 Agent 子进程树
  -> invalidateTaskQueryCacheByScopes(...)
  -> 异步轻量扫描 Windows 保留设备名文件并提示风险
```

约束：

- 运行中 chat/runtime 检查只读取 ZCode 当前 workspace UI/runtime 状态，不扫描磁盘，允许同步阻塞移除。
- 有运行中 chat/runtime 时必须由用户确认后才能继续移除。
- runtime 释放是 best-effort，不阻塞 UI 移除项目。
- 必须传递 `workspaceIdentity`，避免远程 workspace 与同路径本地 workspace 混淆。
- 释放失败只记录日志，不能把已移除的项目重新显示回来。
- 不归档、不删除 task 历史；移除项目只移除入口和 runtime 占用。
- Windows 保留设备名检查不是用户系统删除失败诊断，也不承诺项目一定可删除；它只对 ZCode/Agent 可能触达的常见项目文件做轻量风险提示。
- Windows 保留设备名检查异步执行，不阻塞项目从侧边栏移除。
- 默认跳过 `.git`、`node_modules`、`dist`、`build`、`.next`、`out`、`coverage`、`.cache`、`.turbo`、`.vite` 等高成本低相关目录。
- Windows 保留设备名检查需要限量，找到前若干个风险路径即可提示，扫描失败只记录日志。
- 桌面端 `desktop-continuous` 与手机远控 `web-remote-replayable` 的 realtime 边界不变；本修复只调用已有 workspace-scoped release API，不新增 replay/snapshot 行为。

## Windows 保留设备名规则

风险判断按 path segment 执行：

```text
文件名 segment
  -> 去掉尾部空格和点
  -> 取扩展名前 basename
  -> 转大写
  -> 匹配保留设备名
```

首版覆盖：

```text
CON
PRN
AUX
NUL
COM1 ~ COM9
LPT1 ~ LPT9
```

示例风险文件：

```text
nul
NUL
nul.txt
con.md
aux.log
COM1.json
LPT1.tmp
```

## 验收

- 本地 workspace 点击移除后会调用 `releaseWorkspacePreparation({ workspacePath, provider })`。
- 远程 workspace 点击移除后会调用 `releaseWorkspacePreparation({ workspacePath, workspaceIdentity, provider })`。
- 释放失败时项目仍从侧边栏移除，并通过 UI logger 记录错误。
- workspace 存在运行中 task/draft runtime 时，点击移除会先弹确认。
- 用户取消运行中确认时，不关闭 tab，不释放 runtime，不失效 task cache。
- 用户确认运行中确认时，继续关闭 tab、释放 runtime 并失效 task cache。
- 移除后异步发现 `nul` / `con.md` / `COM1.json` 等 Windows 保留设备名文件时，通过 toast 提示风险。
- Windows 保留设备名扫描默认跳过高成本目录，且失败不影响移除流程。

# WSL UNC 工作区打开提示

## 背景

Windows 用户可以从系统目录选择器直接打开 `\\wsl.localhost\Ubuntu\home\...` 或 `\\wsl$\Ubuntu\home\...` 这类 WSL UNC 路径。该路径能被 Windows 文件 API 访问，但如果按本地工作区打开，Agent / Bash / terminal 会运行在 Windows host 环境中，而不是 WSL Linux 环境中。

这会导致以下问题：

- 命令需要反复通过 PowerShell / Git Bash / `wsl.exe` 间接进入 WSL，容易出现引号和路径转义问题。
- `git`、`node`、`npm`、`live-server` 等工具解析的是 Windows PATH，不是 WSL 内的 Linux PATH。
- PowerShell 环境变量语法和 Bash 不同，用户容易把 `$FOO` / `FOO=bar command` 误用于 Windows shell。

## 设计

当用户选择的本地路径匹配 WSL UNC 前缀时，ZCode 不自动切换到远程 WSL 工作区。自动切换会改变命令执行环境、配置隔离键和远程会话生命周期，属于需要用户确认的抉择。

正确行为是提示用户：

1. 推荐通过“远程连接 -> WSL”打开该工作区，让命令在 WSL Linux 环境中执行。
2. 用户确认后只唤起远程连接弹窗并预选 WSL，不自动连接、不自动转换路径。
3. 用户取消或关闭提示时，继续按原 UNC 路径作为本地工作区打开。

## 影响面

- 仅影响桌面端本地打开工作区入口。
- 不改变已有 WSL remote workspace、SSH、Docker 或 Web 远控链路。
- 不改变 `\\wsl.localhost` 路径的可打开性；用户仍可选择按路径继续打开。

## 验证点

- `\\wsl.localhost\Ubuntu\home\user\repo` 和 `\\wsl$\Ubuntu\home\user\repo` 会触发提示。
- 普通 Windows 路径、普通 UNC 网络共享路径不会触发提示。
- 选择推荐操作后打开远程连接弹窗并预选 WSL。
- 选择继续路径后仍调用原本的本地工作区打开流程。

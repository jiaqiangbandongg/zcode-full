# Subagent Timeout Policy

## 背景

`Agent` / `Task` 是父 runtime 调度子 agent 的入口。此前 ZCode 在工具层给
`Agent` 设置固定 `600000ms` 超时；当前目标是移除这层固定墙钟限制，避免长时间
但仍健康运行的子 agent 被父工具执行器提前判定为 `tool_timeout`。

## 目标语义

- `Agent` / `Task` 不设置固定工具执行超时。
- 前台 subagent 由子 runtime 自身完成、失败或被取消来结束。
- 用户停止父 turn、父 turn abort、进程退出等取消信号仍会传递给正在等待的
  `Agent` / `Task` 调用。
- child session 的 setup、persist、resume 和 `onSessionReady` 等待都属于前台调用的
  可取消、可检测 inactivity 生命周期；Ready 只是 `SubagentSpawned` 的发布屏障，不是
  abort/watchdog 的安装边界。
- 后台 subagent 的生命周期继续由 `SubagentPort` / runtime task registry 管理，
  不通过工具执行器的固定 timeout 清理。

```text
register task -> child setup/persist/resume -> onSessionReady -> foreground/background race -> settle
      ^                    ^                       ^                       ^
      |                    |                       |                       |
      +------------- parent abort + inactivity watchdog -----------------+
```

- pre-ready 阶段收到父 abort 或 inactivity timeout 时，外层 `Agent` / `Task` 必须及时失败，
  清理未发布的 runtime task，不能继续等待 child 主动调用 `onSessionReady`。
- foreground task 转为 background 后，child tool mirror 的 `background` provenance 必须在
  每条事件发出时读取 runtime task registry 当前状态；不能复用 child 启动时的布尔快照。
  因此前台阶段的事件不带 `background: true`，切后台后的迟到事件必须带
  `background: true`，允许父 turn 结束后继续投影真实 terminal lifecycle。

## 非目标

- 不改变 Bash、WebFetch、Read、Edit 等普通工具的 timeout 策略。
- 不恢复 `120000ms` 前台自动转后台逻辑。
- 不改变 `subagents.backgroundEnabled` 默认关闭的临时策略。

## 实现约束

- 工具执行器必须显式支持 `timeout: { kind: "none" }`，不能让无 timeout 工具回退到
  executor 默认 timeout。
- `Agent` / `Task` 的 provider contract 不再暴露 `timeoutMs`，避免模型或 UI 误以为
  subagent 有固定 10 分钟上限。
- 无 timeout 只取消墙钟计时器；父级 `AbortSignal` 仍必须能取消等待中的 handler。
- subagent inactivity watchdog 必须在 child setup 开始前启动；ready wait 与 completion wait
  必须共同监听同一 task abort signal，且保留 watchdog 产生的 `ToolTimeout` 原因。

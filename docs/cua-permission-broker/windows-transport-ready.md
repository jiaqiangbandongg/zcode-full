# Windows CUA Helper 两阶段就绪

## 目标

Windows named pipe 没有 Unix socket 的 `.pending -> final` 原子让渡语义。Helper 冷启动时，Host 因此需要在功能初始化完成前先拿到一份已经完成认证绑定的 transport tuple，让 Agent 可以立即启动 `zcode-cua` MCP；功能层仍在初始化时，工具调用由 broker 以可重试的 `broker_unavailable` 响应表示 warming-up。

## 状态与时序

```text
Host                         Helper                         Agent / MCP
 |                            |                               |
 | fork(socket, token)       |                               |
 |--------------------------->| bind + authenticate           |
 |                            |-- transport_ready ----------->|
 |<---------------------------|                               |
 | publish socket/token       | load native + build backend  |
 |--------------------------->|                               |
 |                            |-- ready + broker_info ------->|
 |<---------------------------|                               |
 |                            |                               | tool call
 |                            |<------------------------------|
 |                            | warming_up => broker_unavailable
 |                            |------------------------------>|
```

`transport_ready` 只代表 named pipe 已由当前子进程绑定并完成 bearer-token 认证配置，不代表 UIA、截图或输入能力已就绪；`ready` 仍代表完整 health probe 成功。旧 Helper 只发送 `ready` 时，Host 将其同时视为 transport ready，保持向后兼容。

## 约束

- Host 只接受自己 fork 的精确 child PID 和自己 mint 的 pipe 名，收到 `transport_ready` 后才向 Agent 发布 tuple。
- Windows 不复用旧 pipe，也不通过关闭后重绑伪造原子切换；Helper 失败或退出时，已发布 tuple 进入既有 recovery/recycle barrier。
- Agent 的 MCP 进程保持存活，`broker_unavailable` 只能用于未发送请求的 warm-up 重试；动作请求仍遵守 delivery-state，不自动重放可能已发送的副作用。
- 完整 `ready`/health 失败仍走原有清理路径，方案只消除正常冷启动阶段因 1 秒窗口产生的 stranded Agent。

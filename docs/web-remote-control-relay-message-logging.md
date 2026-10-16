# Web Remote Control Relay Message Logging (Disabled)

## 目的
记录远控 relay 消息链路的历史设计与当前关闭策略，避免高频消息摘要继续落盘到 `~/.zcode/v2/logs/web-remote-control`。

## 生效环境
桌面端当前在开发环境和生产环境都不启用 relay message trace，不再写入 `~/.zcode/v2/logs/web-remote-control/web-remote-control-relay-YYYY-MM-DD.log`。

普通 Web 远控生命周期日志不受影响，仍写入主日志 `~/.zcode/v2/logs/YYYY-MM-DD.log`。

## 覆盖范围
- 桌面端：`packages/desktop/src/main/webRemoteControlTransport.ts`

## 日志内容
历史 trace 只允许输出消息摘要，不允许输出完整 payload。若未来要重新启用，必须先更新本文件并重新评估日志体积与敏感信息风险。

历史摘要字段包括：
- `type`
- `pair_status`（若有）
- `role`（若有）
- `code`（若有）
- `payload` 摘要：`zcode_type` / `requestId` / `bridgeSessionId`
- 桌面端 `recv` 额外带 `bytes`

## 不记录内容
当前不记录 relay message trace。未来即使重新启用，也必须继续禁止输出 `data.payload` 全量正文，避免：
- 日志体积随消息流线性膨胀
- 敏感信息泄露（文本内容、路径、请求参数）
- 生产环境 I/O 压力与性能抖动

## 典型日志前缀
- 桌面端已禁用：`[web-remote-control][relay-message]`

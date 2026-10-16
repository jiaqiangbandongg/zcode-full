# WSL 远程 workspace realtime 边界修复

> **状态：历史故障记录，边界结论仍有效。** 文中的 `sendPrompt`/dynamic stream 是修复发生时的旧入口；
> 当前 conversation 主链路已迁移到 V4 command/topic，但普通 WSL/server 桌面连接仍不得注册
> 手机 replayable 使用的 `relay_bridge`。

## 背景

桌面端普通 WSL remote workspace 应继续走 `desktop-continuous` 主链路。
手机远控 replayable 附着链路，以及现有 SSH / Docker / Bot remote runtime 的 relay 行为，先保持不变，避免扩大回归面。

## 问题

当前用户反馈集中在普通 WSL remote workspace。
之前主进程会把这条桌面链路也注册成 `relay_bridge`。

这会导致：

1. 远程 host 在 `sendPrompt` 时额外订阅远端 `onDynamicStreamEvent`
2. 每条流事件都镜像成 `task_stream_mirror_batch`
3. 桌面 host 自身并不需要消费这条 replayable mirror，但 host bridge 仍会按 `eventId`
   去重并持有缓存
4. WSL 场景下流量更高，短时间内就会造成 host 内存膨胀；Windows/WSL swap 与 VHDX
   也会跟着快速放大，表现为“内存泄露 + 硬盘占用暴涨”

## 本次修复边界

- 普通桌面 WSL Remote Host：不注册 `relay_bridge`
- SSH / Docker 普通 remote workspace：保持现有 `relay_bridge` 行为不变
- Bot remote runtime / 手机 replayable 附着链路：继续使用 `relay_bridge`
- host 侧 realtime bridge 的 `eventId` 去重缓存增加固定上限，作为通用防御，避免异常路径再次线性占用内存

## 验证点

- 桌面端打开普通 WSL workspace 时，不再创建 `relay_bridge` host
- SSH remote workspace 仍保留原有 `relay_bridge` 注册
- Bot remote runtime 仍保留 `relay_bridge`，不影响手机远控和 bot 链路
- host bridge 在超过去重窗口后允许旧 `eventId` 被重新接受，但常驻内存保持有界

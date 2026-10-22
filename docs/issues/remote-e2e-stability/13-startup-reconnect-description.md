# 自动重连设置仍描述已取消的 7 天过滤

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`。
批次 `r3-server-20261011105317614-4a6780` 的 `version-optional` 运行日志实际读取到设置页说明：
“启动时静默重连最近 7 天内在线过的设备”。这是可见设置文案，不是测试夹具中的预期字符串。

[当前恢复合同](../../remote/desktop-remote-session-renderer-reattach.md) 明确：全部保存连接按最近在线时间
排序，各尝试一次，不再按 7 天过滤；全局关闭开关与可静默取得凭据的限制保留。
设置说明因此会让用户误以为超过 7 天的设备不会自动连接。

应把说明改为当前范围与排序规则，同时核对中英文。较早 R3 主规格及 case catalog 仍有 7 天条目，
应按上述现行恢复合同同步，而不是把产品逻辑改回旧过滤条件。本轮只记录，未修改业务文案或逻辑。

此项是独立的说明不一致；`version-optional` 的实际失败是更新提示未在首次读取时出现，
不能用本记录代替该失败的继续分诊与复验。

补充实机证据：批次 `r3-server-20261011125749338-152f05` 的 `recov/recovery-guards.json`
记录 Source.lastOnlineAt 被设置为 8 天前后，冷启动得到新的 remoteSessionId、hostCount=1、
dialogShown=false，证明实际没有按 7 天排除该连接。该 case 后续的手动恢复失败，
本记录仅引用已到达的冷启动阶段，不把整个 case 记为 PASS。

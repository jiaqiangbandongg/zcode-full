# desktop-web-remote-relay

将 Main 的 HTTP、存储和 device WebSocket 与 manager 装配隔离。

仅 index.ts/contract.ts 供外部消费。manager 仍唯一拥有 window runtime 与 attachment；transport 唯一拥有 socket/generation。storage 只保存非敏感身份，clearLegacy 合并并发且失败可重试。凭据从注入端口读取，HTTP 错误只返回分类。

完整语义见 [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md)。

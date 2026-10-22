# web-remote-relay

定义 relay V2 消息、HTTP 结构与连接生命周期规则。

contract.ts 是 wire schema 与错误分类；domain 只计算退避和心跳间隔，adapters 拥有定时器。每个 transport 独占 retry/heartbeat，stop 清理两个定时器。不得记录 JWT/token，不持有 task/workspace 状态。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。

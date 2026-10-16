# Z Code 通信协议分层（当前事实）

> 本文给出理解当前进程通信的最简模型。它是项目架构的三层心智模型，不是要求每条链路都严格经过同一套协议栈。

## 先记住三层

```text
第 3 层：内容 —— 要做什么
第 2 层：信封 —— 如何描述、编号和匹配消息
第 1 层：通道 —— 消息通过什么管道传输
```

可以类比成寄快递：

```text
快递里的物品 = 业务内容
快递单和包装 = 消息协议
卡车、公路、飞机 = 传输通道
```

发送时从第 3 层向下打包，接收时从第 1 层向上拆包。

## 第 1 层：通道（Transport）

通道只负责搬运字节或结构化消息，不理解聊天、文件、Git 等业务。

当前项目的通道包括：

- `MessagePort`：Renderer 与 Window Host 之间的本地端口。
- `stdio`：Host 与 `zcode-cli`，以及 `zcode-server` 与其 Agent 子进程之间的标准输入输出。
- `WebSocket`：连接已存在的 `zcode-server`，或连接手机远控 Relay。
- Electron IPC：Renderer 与 Main 之间的平台调用。
- UtilityProcess `postMessage`：Main 与 Window Host 之间的进程控制消息。

这一层回答：**“消息走哪根管道？”**

## 第 2 层：信封（Message / Call Protocol）

这一层负责把内容包装成可处理的消息，解决：

- 这是请求、响应还是事件？
- 请求编号是多少？
- 调用哪个服务、哪个方法？
- 响应应该匹配哪个请求？
- 数据如何序列化？

当前有三种主要形式：

### `@zcode/rpc`

通用的 Service 调用协议，支持 `call`、`response`、`listen` 和事件通知。它主要用于：

- Renderer ↔ Window Host；
- Window Host ↔ 远程 `zcode-server`。

### ZCode Protocol JSON envelope

Host 与 `zcode-cli` 使用的 JSON 请求/响应/通知外壳，典型结构如下（为便于阅读省略了部分身份字段）：

```json
{
  "id": 42,
  "method": "v4/command",
  "params": {
    "commandId": "cmd-123",
    "clientId": "desktop-client",
    "sessionId": "session-1",
    "type": "sendText",
    "payload": { "text": "你好" }
  }
}
```

这些 JSON 对象通常以 NDJSON（一行一个 JSON）通过 stdio 传输。

### Typed IPC / `postMessage`

Main 的控制消息不经过通用 `@zcode/rpc`，而是直接发送带有 `type` 的结构化对象，例如：

```ts
{
  type: "attach-service-port",
  attachmentId: "...",
  clientMode: "desktop-continuous",
}
```

这里的 `type` 本身就是消息路由信息。

## 第 3 层：内容（Business Meaning）

这一层定义消息真正要表达的业务含义。

### V4 对话协议

V4 负责 Agent 会话和对话事实，例如：

- 命令：`createSession`、`sendText`、`stop`、`compact`、`switchModelConfig`；
- 命令 ACK：接受、拒绝、过期、重复等；
- conversation topic：snapshot、delta、`seq`、`revision`；
- 订阅、断线恢复、resync；
- `desktop-continuous` 与 `web-remote-replayable` 交付语义。

V4 的最终事实源和命令裁决者是 workspace 对应的 `zcode-cli`，不是 Renderer、Main 或 Relay。

### Service API

Service API 是 Host 对外暴露的能力，例如：

- `fileService.readFile`；
- `terminalService.create`；
- `gitService.status`；
- `zcodeAgentService.sendConversationCommandV4`；
- `zcodeAgentService.subscribeConversationV4`。

Service API 可以承载 V4，也可以承载文件、终端、Git 等非 V4 能力。

### Host 控制消息

Main 与 Host 之间传递的是进程和连接控制，例如：

- 初始化 Host；
- `ConnectRemoteWorkspace`；
- `AttachServicePort` / `DetachServicePort`；
- Renderer reload 后重新绑定 attachment。

这些不是 V4 对话命令。

## 各链路对应关系

| 链路 | 第 3 层：内容 | 第 2 层：信封 | 第 1 层：通道 |
| --- | --- | --- | --- |
| Renderer → Host | Service API、V4 命令/查询/订阅 | `@zcode/rpc` | `MessagePort` |
| Renderer → Main | 平台操作 | Electron IPC channel | Electron IPC |
| Main → Host | Host 控制消息 | typed `{ type, ... }` | `postMessage` |
| Host → 本地 CLI | V4、少量 legacy 操作 | ZCode Protocol JSON | stdio NDJSON |
| Host → `zcode-server` | 远程 Service API，参数可携带 V4 | `@zcode/rpc` | SSH stdio 或 WebSocket |
| `zcode-server` → 远端 CLI | V4、少量 legacy 操作 | ZCode Protocol JSON | stdio NDJSON |
| 手机 → Relay → Main | 远控 Service/V4 调用 | relay envelope + `rpc-frame` | WebSocket |

手机远控还会通过 shared-host attachment 进入已有 Window Host；Relay 和 Main 只负责鉴权、配对、心跳、frame 透传与 attachment 调度，不持有 conversation/task/stream 业务状态。

## 一条远程 `sendText` 的完整路径

```text
第 3 层：V4 sendText 命令
        │
        ▼
Renderer
  第 2 层：@zcode/rpc 调用 sendConversationCommandV4(...)
  第 1 层：MessagePort
        │
        ▼
Window Host
  第 2 层：远程 @zcode/rpc Service 调用
  第 1 层：SSH stdio / WebSocket
        │
        ▼
zcode-server
  第 2 层：ZCode Protocol JSON，method = "v4/command"
  第 1 层：子进程 stdio
        │
        ▼
远端 zcode-cli
  CommandInbox 裁决并执行 sendText
```

同一条 V4 命令可以被多次“调用”承载，但“命令”和“调用”不是同一个概念：

```text
V4 命令 = 具体业务意图，例如 sendText
V4 调用 = 调用 Service API，把这条命令送到下一跳
```

因此，截图中“Host → zcode-server：V4 调用”更准确的说法是：

> **远程 Service RPC，参数中携带 V4 命令或 V4 查询。**

## 相关实现入口

- [代码架构总览](./zcode-code-architecture-overview.md)
- [Message Flow](./message-flow.md)
- [`@zcode/rpc` 分层实现](../../packages/rpc/src/index.ts)
- [V4 command schema](../../packages/shared/src/zcode-protocol-v4/command.ts)
- [V4 transport schema](../../packages/shared/src/zcode-protocol-v4/transport.ts)
- [远程 RPC 连接](../../packages/server/src/remote/connect.ts)
- [zcode-server stdio RPC server](../../packages/server/src/stdio.ts)
- [Agent ZCode Protocol client](../../packages/services/src/zcode-agent/zcodeProtocolClient.ts)

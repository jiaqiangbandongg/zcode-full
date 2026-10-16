# ZCode 早期分层架构（历史）

本文记录项目从共享 UI + Channel RPC + service interface 起步时的分层背景。它不再描述当前 Host 数量、
remote topology、Root props 或 conversation 数据流；当前事实请读
[Z Code 代码架构总览](./zcode-code-architecture-overview.md)。

## 仍然有效的设计原则

- Desktop、Web 和 mobile remote 复用 `packages/ui`，平台差异通过依赖注入处理。
- UI 依赖 service/protocol interface，不直接调用 Repo、Node implementation 或 Electron main。
- `packages/rpc` 只提供 channel、transport、proxy、事件和日志中间件，不拥有业务语义。
- `packages/services` 定义 Host 业务接口和 Node 实现；`packages/client` 负责创建 service proxy。
- `packages/desktop` / `packages/web` 负责平台装配，不能把平台对象泄漏回共享 UI。
- 新增 service 仍应注册 descriptor、实现、accessor 和 client proxy，并保持 browser-safe type import。

## 已失效的早期假设

早期文档曾把系统描述为“单 server + HTTP/WebSocket/stdio 三入口”，并让 renderer 从 task/session event
自行拼 chat 状态。这些假设已经被以下实现替代：

```text
旧：Renderer reducer -> task state -> UI
新：ZCode CLI ProductProjection -> V4 topic -> read-only UI store

旧：一个抽象 server 承载所有部署形态
新：每个窗口的 Host/service graph + workspace-scoped CLI + remote attachment
```

同样已经失效的内容包括：

- `Root` 通过 `credentialStore` / `onConnectRemote` props 直接装配平台能力；
- UI 使用 `window.zcode` 或 service concrete singleton；
- credential 可以经 platform bridge 直接暴露给 renderer；
- task list、conversation rows、queue、stop/fork availability 由 renderer store 统一拥有；
- remote workspace 可以只按 `workspacePath` 识别。

## 当前依赖方向

```text
packages/shared  <- schema / platform contracts
packages/rpc     <- transport / channel mechanics
packages/services<- Host service interfaces + Node implementations
packages/client  <- typed service proxies
packages/ui      <- hooks + V4 projection consumers
desktop/web      <- platform composition
apps/zcode-cli   <- Agent runtime + V4 authority
```

跨域代码只能依赖对方公开 Types/contract。conversation 的新增协议先改
`packages/shared/src/zcode-protocol-v4/`，再同步 CLI、Host transport 和多端消费者。

## 当前入口

- [代码架构总览](./zcode-code-architecture-overview.md)
- [Message Flow](./message-flow.md)
- [RPC 架构](./rpc.md)
- [ZCode Protocol](../zcode-protocol.md)

# @zcode/rpc

VS Code 风格的 IPC 通信抽象框架。传输无关、类型安全、支持双向 RPC 和远程连接。

## 架构总览

框架分 7 层，从底到顶依次构建：

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 6: Remote                                             │
│  RemoteAuthorityResolver → SocketFactory → PersistentProtocol│
│  → IPCClient → channel.call()                                │
├──────────────────────────────────────────────────────────────┤
│  Layer 5: ProxyChannel                                       │
│  fromService(service) ↔ toService(channel)                   │
├──────────────────────────────────────────────────────────────┤
│  Layer 4: IPCServer (1:N) / IPCClient (1:1 双向)             │
│  连接管理、路由、多播                                          │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: ChannelServer / ChannelClient                      │
│  基于 Channel 的 RPC (call / listen)                          │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: IMessagePassingProtocol                            │
│  send(buffer) / onMessage: Event<buffer>                     │
├──────────────────────────────────────────────────────────────┤
│  Layer 1: Serialization (VQL + 类型标签)                      │
│  serialize() / deserialize()                                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 0: Foundation                                         │
│  Event / Emitter / Disposable / VSBuffer / CancellationToken │
└──────────────────────────────────────────────────────────────┘
```

**关键洞察**：每一层只依赖下面一层。Layer 3+ 完全不关心底层传输——Electron IPC、MessagePort、WebSocket、TCP 都能用同一套 RPC 代码。

## 文件结构

```
packages/rpc/src/
├── index.ts            # 统一导出
├── foundation.ts       # Layer 0: Event, Emitter, Disposable
├── buffer.ts           # VSBuffer 跨平台二进制抽象
├── serialization.ts    # Layer 1: 二进制序列化
├── protocol.ts         # Layer 2: 消息传递协议
├── channels.ts         # Layer 3: Channel RPC
├── ipc.ts              # Layer 4: 多连接管理
├── proxy-channel.ts    # Layer 5: 服务自动代理
└── remote.ts           # Layer 6: 远程连接基础设施
```

---

## Layer 0: Foundation

### Disposable — 资源生命周期

```typescript
import { IDisposable, toDisposable, DisposableStore } from "@zcode/rpc";

// 包装清理函数
const d = toDisposable(() => socket.close());

// 批量管理
const store = new DisposableStore();
store.add(subscription1);
store.add(subscription2);
store.dispose(); // 一次性清理全部
```

### Event / Emitter — 事件系统

`Event<T>` 是一个函数签名：`(listener: (e: T) => void) => IDisposable`。订阅返回 disposable，用于取消订阅。

```typescript
import { Emitter, Event } from "@zcode/rpc";

class FileWatcher {
  private _onDidChange = new Emitter<string>();
  readonly onDidChange: Event<string> = this._onDidChange.event;

  detectChange(path: string) {
    this._onDidChange.fire(path);
  }
}

// 使用
const watcher = new FileWatcher();
const sub = watcher.onDidChange((path) => console.log("changed:", path));
sub.dispose(); // 取消订阅
```

Emitter 支持懒初始化钩子，这是整个框架网络效率的核心：

```typescript
const emitter = new Emitter<Data>({
  onWillAddFirstListener: () => {
    /* 第一个订阅者来了，开始拉取数据 */
  },
  onDidRemoveLastListener: () => {
    /* 最后一个订阅者走了，停止拉取 */
  },
});
```

**Event 工具方法**：

| 方法                      | 用途                 |
| ------------------------- | -------------------- |
| `Event.once(event)`       | 只触发一次，自动取消 |
| `Event.toPromise(event)`  | 事件转 Promise       |
| `Event.filter(event, fn)` | 过滤事件             |
| `Event.map(event, fn)`    | 变换事件值           |

### CancellationToken — 异步取消

```typescript
import { CancellationTokenSource } from "@zcode/rpc";

const cts = new CancellationTokenSource();
doWork(cts.token);
cts.cancel(); // 通知取消
cts.dispose(); // 释放资源
```

---

## Layer 1: Serialization

二进制序列化，格式为 `[1 字节类型标签] [VQL 编码长度] [数据]`。

支持的类型：Undefined、String (UTF-8)、Buffer、VSBuffer、Array (递归)、Object (JSON fallback)、Int (VQL 编码)。

VQL (Variable-Length Quantity) 编码：小整数只需 1 字节（vs JSON 的 4 字节），非常节省空间。

```typescript
import { BufferWriter, BufferReader, serialize, deserialize } from "@zcode/rpc";

const writer = new BufferWriter();
serialize(writer, { name: "test", count: 42, data: [1, 2, 3] });
const buffer = writer.buffer;

const reader = new BufferReader(buffer);
const value = deserialize(reader); // { name: 'test', count: 42, data: [1, 2, 3] }
```

---

## Layer 2: Protocol

### IMessagePassingProtocol — 传输抽象

这是整个框架的关键抽象边界。任何传输只要实现这个接口，就能接入所有上层能力：

```typescript
interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  readonly onMessage: Event<VSBuffer>;
  drain?(): Promise<void>;
}
```

### 内置协议实现

| 实现                  | 场景                      | 特性                                             |
| --------------------- | ------------------------- | ------------------------------------------------ |
| `SocketProtocol`      | TCP / 原始 Socket         | 13 字节消息帧头，处理 TCP 粘包/拆包              |
| `PersistentProtocol`  | 需要可靠传输的场景        | ACK 确认 + 未确认消息重放 + 心跳 (5s) + 断线重连 |
| `MessagePortProtocol` | Web Worker / Electron IPC | 无需分帧（MessagePort 天然保持消息边界）         |
| `createQueuePair()`   | 测试 / 进程内通信         | 返回两个内存中互联的 protocol                    |

### createQueuePair — 测试利器

```typescript
import { createQueuePair } from "@zcode/rpc";

const [clientProtocol, serverProtocol] = createQueuePair();
// clientProtocol.send() 的数据会出现在 serverProtocol.onMessage 中，反之亦然
```

---

## Layer 3: Channel RPC

### 核心概念

**IChannel**（客户端视角）：

```typescript
interface IChannel {
  call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T>;
  listen<T>(event: string, arg?: any): Event<T>;
}
```

**IServerChannel**（服务端视角）：

```typescript
interface IServerChannel<TContext = string> {
  call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T>;
  listen<T>(ctx: TContext, event: string, arg?: any): Event<T>;
}
```

区别只有一个 `ctx` 参数——标识请求来自哪个客户端。

### ChannelServer + ChannelClient

```typescript
import { ChannelServer, ChannelClient, createQueuePair } from "@zcode/rpc";

const [cp, sp] = createQueuePair();

// 服务端
const server = new ChannelServer(sp, "server-ctx");
server.registerChannel("calc", myCalculatorChannel);

// 客户端
const client = new ChannelClient(cp);
const calc = client.getChannel("calc");
const result = await calc.call<number>("add", [1, 2]); // 调用方法
calc.listen<string>("onDidLog")((msg) => console.log(msg)); // 订阅事件
```

### 消息协议

```
客户端 → 服务端:
  Promise(100)       调用方法
  PromiseCancel(101) 取消调用
  EventListen(102)   订阅事件
  EventDispose(103)  取消订阅

服务端 → 客户端:
  Initialize(200)      握手完成
  PromiseSuccess(201)  调用成功
  PromiseError(202)    调用失败 (Error)
  PromiseErrorObj(203) 调用失败 (非 Error)
  EventFire(204)       事件触发
```

---

## Layer 4: IPCServer / IPCClient

### IPCServer — 一对多

一个 server 管理多个 client 连接。支持反向 RPC（server 调用 client）。

```typescript
import { IPCServer, IPCClient, StaticRouter, createQueuePair } from "@zcode/rpc";

// server 监听连接事件
const server = new IPCServer(onDidClientConnect);

// 注册全局服务（所有 client 都能访问）
server.registerChannel("config", configChannel);

// 反向 RPC：server 调用特定 client
const windowChannel = server.getChannel(
  "windowInfo",
  new StaticRouter((ctx) => ctx === "window-1"),
);
const title = await windowChannel.call<string>("getTitle");

// 多播：聚合所有 client 的事件
const allEvents = server.getChannel("notifications", () => true).listen("onNotification");
```

### IPCClient — 一对一双向

既是 client 又是 server，适合对等通信：

```typescript
const ipcClient = new IPCClient(protocol, "my-client-id");

// 作为 client 调用远程
const remote = ipcClient.getChannel("service");

// 作为 server 注册本地服务
ipcClient.registerChannel("localService", myChannel);
```

---

## Layer 5: ProxyChannel ⭐

**这是框架的杀手锏**——零样板代码暴露和消费服务。

### 问题

没有 ProxyChannel 时，每个服务都要手写 switch-case 映射：

```typescript
// 😩 每个服务都要写一遍
class FileServiceChannel implements IServerChannel {
  call(ctx, command, arg) {
    switch (command) {
      case "readFile":
        return this.service.readFile(arg[0]);
      case "writeFile":
        return this.service.writeFile(arg[0], arg[1]);
      // ... 每个方法都要手动映射
    }
  }
}
```

### 解决

```typescript
import { ProxyChannel } from "@zcode/rpc";

// ✅ 服务端：一行暴露
const channel = ProxyChannel.fromService(fileService);
server.registerChannel("fs", channel);

// ✅ 客户端：一行消费
const fs = ProxyChannel.toService<IFileService>(client.getChannel("fs"));
await fs.readFile("/path"); // 就像调用本地方法
fs.onDidChangeFile((e) => console.log(e)); // 事件订阅也是透明的
```

### 命名约定

ProxyChannel 通过命名约定自动区分方法和事件：

| 命名模式            | 类型                       | 示例                          |
| ------------------- | -------------------------- | ----------------------------- |
| `onXxx` (on + 大写) | 静态事件                   | `onDidChange`, `onError`      |
| `onDynamicXxx`      | 动态事件（方法返回 Event） | `onDynamicDidChangeFile(uri)` |
| 其他                | RPC 方法                   | `readFile`, `writeFile`       |

### 事件缓冲

`fromService` 会自动缓冲事件——在第一个订阅者出现之前触发的事件不会丢失，订阅时会先 flush 缓冲区。

---

## Layer 6: Remote

完整的远程连接基础设施，支持 SSH、WSL、Docker 等场景。

### 核心组件

**RemoteAuthorityResolverService** — 解析远程 authority：

```typescript
// authority 格式: "type+identifier"，如 "ssh+myserver", "wsl+Ubuntu"
const resolver = new RemoteAuthorityResolverService();
resolver.register("ssh", sshResolver);

const result = await resolver.resolve("ssh+myserver");
// → { authority, connectTo: WebSocketRemoteConnection | ManagedRemoteConnection }
```

**RemoteSocketFactoryService** — 创建连接：

```typescript
const factory = new RemoteSocketFactoryService();
factory.register(RemoteConnectionType.WebSocket, webSocketFactory);

const socket = await factory.connect(connectTo, path, query);
```

**createURITransformer** — URI 方案转换：

```
客户端 → 服务端:
  vscode-remote://ssh+myserver/home/user/file.txt → file:///home/user/file.txt

服务端 → 客户端:
  file:///home/user/file.txt → vscode-remote://ssh+myserver/home/user/file.txt
```

### RemoteAgentConnection

完整生命周期管理：解析 authority → 创建 socket → 包装 PersistentProtocol → 返回 IPCClient。支持断线自动重连（指数退避：0, 5, 5, 10, 10, 10, 10, 10, 30 秒）。

```typescript
const connection = new RemoteAgentConnection("ssh+myserver", resolver, socketFactory);
const ipcClient = await connection.connect();

// 透明使用远程服务
const remoteFS = ProxyChannel.toService<IFileService>(ipcClient.getChannel("filesystem"));
await remoteFS.readFile("/remote/path");

// 监听连接状态
connection.onDidStateChange((state) => {
  // 'connected' | 'reconnecting' | 'disconnected'
});
```

---

## 典型使用模式

### 最简模式：直连 RPC

```typescript
const [cp, sp] = createQueuePair();
const server = new ChannelServer(sp, "ctx");
const client = new ChannelClient(cp);

server.registerChannel("myService", ProxyChannel.fromService(myService));

const remote = ProxyChannel.toService<IMyService>(client.getChannel("myService"));
await remote.doSomething();
```

### Electron 主进程 ↔ 渲染进程

```typescript
// 主进程
const protocol = new MessagePortProtocol(electronPort);
const server = new ChannelServer(protocol, "main");
server.registerChannel("app", ProxyChannel.fromService(appService));

// 渲染进程
const protocol = new MessagePortProtocol(electronPort);
const client = new ChannelClient(protocol);
const app = ProxyChannel.toService<IAppService>(client.getChannel("app"));
```

### 多窗口管理

> 通用 RPC 能力说明：ZCode 的每个 workspace window 各自拥有唯一 Window Host。base 与 remote-scoped
> MessagePort 都连接该 Host；SSH/WSL pool 和 Docker/Server dedicated connection 是 Host 内部资源，
> 不再对应额外 Host 进程。channel/context 必须保持窗口、remoteSessionId、attachment 和 workspaceKey 隔离。

```typescript
const server = new IPCServer(onDidWindowConnect);
server.registerChannel("config", ProxyChannel.fromService(configService));

// 向特定窗口发送命令
const targetWindow = server.getChannel("window", (ctx) => ctx === "window-2");
await targetWindow.call("focus");

// 聚合所有窗口的事件
const allCloses = server.getChannel("window", () => true).listen("onDidClose");
```

---

## 设计原则

1. **传输无关** — `IMessagePassingProtocol` 是唯一的抽象边界，新传输只需实现这个接口
2. **懒订阅** — 事件只在有订阅者时才产生网络流量（Emitter 钩子驱动）
3. **Disposable 一切** — 每个组件都实现 `IDisposable`，杜绝资源泄漏
4. **错误透传** — 异常自动序列化重建，保留 stack trace
5. **零样板代理** — ProxyChannel 利用命名约定 + ES6 Proxy，消除手写映射
6. **可靠传输** — PersistentProtocol 提供 ACK + 消息重放 + 心跳 + 断线重连

## 运行示例

```bash
pnpm --filter @zcode/rpc demo:basic    # 基础 RPC
pnpm --filter @zcode/rpc demo:proxy    # ProxyChannel
pnpm --filter @zcode/rpc demo:remote   # 远程连接
```

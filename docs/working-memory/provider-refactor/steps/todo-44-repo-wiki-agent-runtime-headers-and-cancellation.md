# Todo 44：Repo Wiki Agent Runtime Headers 与取消链路收口

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：MacBook Air Repo Wiki 长时间无产物的运行时调查

## 1. 问题现象

MacBook Air 对多个仓库发起 Repo Wiki 生成后，界面长时间保持运行中，未出现 Catalog、页面草稿或最终 Wiki。
任务最终可能在接近一小时后失败，并记录：

```text
Wiki 模型请求超时（900000ms）
```

这不是数据库、模型速度或 Wiki 页面投影问题。运行时证据表明：

- 同一账号的 Team Plan 普通聊天、Session Title 和 Web Search 均能收到模型 SSE；
- Repo Wiki Agent 已完成启动、Provider/Model Readiness 和 Active Model 创建；
- Repo Wiki 请求没有对应的 Host Runtime Headers 接收日志；
- Repo Wiki Agent 进程没有建立模型服务 TCP 连接；
- 模型流没有 SSE chunk、文本增量或工具调用；
- Catalog 成功前不会写 `draft.json`，因此当前没有任何可展示的中间产物。

结论：Repo Wiki 第一笔模型请求卡在账号 Provider 的执行期访问材料准备阶段，尚未发送 HTTP。

## 2. 正常模型调用链路

```text
Repo Wiki Service
        |
        | workspace/generateText
        v
Desktop Local Host / Services
        |
        | ZCode Protocol over stdio
        v
repo-wiki Agent Process
        |
        | Registry -> ModelFactory -> Active Model -> Adapter
        v
Account Provider 执行期访问材料准备
        |
        | interaction/requestProviderRuntimeHeaders（反向 RPC）
        v
Host Account Credential Service
        |
        | Runtime Headers response
        v
Agent Adapter
        |
        | HTTP / SSE
        v
模型服务
```

API Key Provider 可以由 Agent 从 Personal Provider Config 取得静态访问材料；Team、Individual、Start Plan 等
账号 Provider 的执行期访问材料由 Host 账号服务提供。Host 不重新构造 Model，也不形成第二套 Provider Config；它只响应
Agent 在正式模型请求前发出的 Runtime Headers 反向 RPC。

## 3. 已确认根因

### 3.1 Repo Wiki Client 没有安装 Host Protocol Handlers

普通 Agent Client 取得后会执行 `wireClient(client, workspace)`。该函数不仅消费通知，也注册 Agent -> Host 的反向
RPC，包括 `interaction/requestProviderRuntimeHeaders`。

Repo Wiki 为隔离分钟级后台生成，使用独立 `repoWikiProcessManager`。当前 `getRepoWikiClient()` 只执行：

```ts
const client = await repoWikiProcessManager.getClient(params);
repoWikiProcessManager.markReady(params, client);
return client;
```

没有调用 `wireClient(client, params)`。结果是：

```text
Agent 发出 Runtime Headers Request
        |
        v
Host ZCodeProtocolClient 解析成功
        |
        v
requestEmitter.fire(request)
        |
        v
0 个监听器
        |
        v
无人 respond，Agent Promise 保持 pending
```

现有 `docs/repo-wiki/repo-wiki-agent-lane.md` 中“不 wire 通知处理器（Wiki 只需要请求-响应）”的前提错误地只考虑了
Host -> Agent 的请求响应，遗漏 Agent -> Host 的反向请求。Lane 隔离只应隔离进程、队列和生命周期，不应切断 Host
Protocol 能力。

### 3.2 Runtime Headers 反向请求确实没有默认超时

Agent `requestClient()` 仅在调用方明确提供 `options.timeoutMs` 时创建 timer：

```ts
if (options?.timeoutMs !== undefined) {
  pending.timeout = setTimeout(...);
}
```

Runtime Headers Port 只传父模型请求的 `AbortSignal`，没有传 `timeoutMs`。因此该 Promise 只会在以下事件中结束：

```text
Host 正常响应
父 AbortSignal 触发
Protocol 连接关闭
```

不存在隐藏的 3 分钟或其他默认反向 RPC 超时。Host -> Agent 的普通 Protocol Client 默认 3 分钟是另一层；Repo Wiki
又把该层显式覆盖为“Wiki Deadline + 30 秒取消缓冲”，不能与 Agent -> Host 的反向请求混同。

### 3.3 `workspace/cancelGenerateText` 无法进入正在执行的 Agent

Repo Wiki 单次模型 Deadline 为 900 秒。Deadline 到达后，Host 停止本地等待并发送
`workspace/cancelGenerateText`，希望触发 Agent 为本次 operation 保存的 `AbortController`。

但 Agent NDJSON Transport 对请求串行处理，当前仅允许 `session/stop` 越过在飞请求：

```text
workspace/generateText
└─ 等待 Runtime Headers，handler 不返回

workspace/cancelGenerateText
└─ 排在 generateText 后面，无法执行
```

于是形成：

```text
generateText 等待 AbortSignal
AbortSignal 等待 cancel handler
cancel handler 等待 generateText 返回
```

Host 侧 cancel RPC 5 秒后超时，但其 best-effort 超时被 Process Manager 明确豁免进程回收；Agent 内部
`AbortController` 没有触发，Runtime Headers Promise 和旧物理请求继续存活。

### 3.4 重试把一次确定性故障放大到约一小时

Repo Wiki 默认 `maxRetries = 3`，语义为首次请求加三次重试。每次 Host 本地 Deadline 都是 15 分钟：

```text
attempt 1：15 分钟
attempt 2：15 分钟
attempt 3：15 分钟
attempt 4：15 分钟
-------------------
最终约 60 分钟后失败
```

由于旧物理请求没有被取消，后续 cancel 和 generate 请求都堆在第一个在飞请求之后。Service 层重复结束本地等待，Agent
队列实际没有前进。

## 4. 设计裁决

### 4.1 Lane 隔离不改变 Host 能力

```text
Chat Lane
├─ 独立进程与请求队列
└─ 完整 Host Protocol Wiring

Repo Wiki Lane
├─ 独立进程与请求队列
└─ 完整 Host Protocol Wiring
```

所有 `ZCodeAgentProcessManager` 产出的、允许执行正式 Model 的 Client，都必须安装 Host Protocol Handlers。不得为 Repo
Wiki 复制一份 Account Auth、Runtime Headers 或 Provider 解析逻辑。

### 4.2 取消消息属于控制面

`workspace/cancelGenerateText` 与 `session/stop` 一样，必须在其前面的普通请求进入 handler、建立 AbortController 后，越过
该请求的异步等待。取消请求不能排在被取消操作完成之后。

### 4.3 父级取消是本轮主要期限边界

本轮不通过随意增加 Runtime Headers 固定超时来掩盖问题。Team/Individual 的 Host 自动应答与 Start Plan 可能涉及的执行期
交互并不具有相同耗时语义；Runtime Headers 继承父模型请求的 `AbortSignal` 可以保留，前提是父级取消能够真正送达 Agent。

如果后续需要给自动账号 Headers 增加独立短期限，必须单独定义按 Account Access 行为区分的契约，不在本 Todo 内顺手加入。

### 4.4 重试前必须结束旧物理请求

任何 Repo Wiki 重试开始前，上一 attempt 的 Agent 操作必须已经结束或得到明确 cancel acknowledgement。禁止只结束
Services 本地 Promise 后继续叠加底层模型请求。

现有重试会覆盖空响应、非法 JSON、输出截断和临时 Provider 错误。本 Todo 先证明不发生物理请求重叠；是否进一步把
timeout、鉴权、配置和 Protocol 错误从可重试集合中排除，依据测试暴露的现行错误分类最小收口，不新增泛化 Retry Policy
抽象。

## 5. 实施计划

### 5.1 测试先行：Repo Wiki 反向 Runtime Headers

扩展 Repo Wiki Lane 测试，不再只用 `client.request()` 直接返回成功的 Mock。测试 Client 必须主动发出
`interaction/requestProviderRuntimeHeaders`，并断言：

1. Repo Wiki Client 已安装 Host Request Handler；
2. Host 使用正式 Account Runtime Headers 服务响应；
3. Agent 收到 response 后才继续模型请求；
4. 不引入 Host Registry Snapshot、Repo Wiki 专用 Provider Config 或第二套鉴权实现。

### 5.2 修复 Client Wiring

- `getRepoWikiClient()` 在 `markReady` 和返回前执行幂等的 `wireClient(client, params)`；
- 保持 `wiredClients` 的单次安装语义；
- 更新 `repo-wiki-agent-lane.md`，删除“Repo Wiki 不 wire”的错误结论；
- Lane 仍不进入 Chat 的 `activeClientsByWorkspaceKey`，不改变进程隔离和终态回收。

### 5.3 测试先行：真实 Transport 取消

使用真实 `ZCodeProtocolNdjsonConnection`，而不是直接调用 `server.handleMessage()`：

```text
generateText handler 已开始并挂起
        |
        v
发送 workspace/cancelGenerateText
        |
        v
cancel 越过在飞请求
        |
        v
Agent operation AbortSignal 触发
        |
        v
Runtime Headers request 拒绝
        |
        v
generateText 结束并释放队列
```

断言 cancel response 为 `cancelled: true`，在飞请求结束，后续普通请求仍可执行。

### 5.4 修复取消队列

在 Transport `shouldBypassProcessingQueue()` 中将 `workspace/cancelGenerateText` 与 `session/stop` 置于同一控制面边界。
继续等待前一个请求真正进入 handler 后再 bypass，避免 cancel 抢在 AbortController 登记前成为空操作。

### 5.5 重试并发证明

增加 Deadline/Retry 测试，记录底层物理 attempt 的进入、退出和并发数：

```ts
maxConcurrentPhysicalRequests === 1;
```

必须证明 attempt N 已 abort 并释放后，attempt N+1 才开始。若当前 Service 在 cancel 未确认时仍能立即重试，则最小修正
时序，不建立第二套任务队列。

### 5.6 诊断轨迹

保留低频生命周期日志，足以区分：

```text
Runtime Headers requested
Runtime Headers applied / failed
HTTP request started
SSE first chunk received
attempt aborted / completed
retry scheduled
```

逐条 SSE 和高通信量内容继续使用 debug，不增加生产日志洪泛，不记录 Header 或凭据正文。

## 6. 明确不做

- 不提高 Repo Wiki 的 15 分钟 Deadline；
- 不增加默认重试次数；
- 不创建 Repo Wiki 专用 Registry、Config、Model、Headers DTO 或 Account Auth；
- 不让 Host 重新构造 Active Model；
- 不给所有 Agent -> Host 反向 RPC 统一拍一个任意固定超时；
- 不为 Event Emitter 增加大规模“是否已处理”协议改造；
- 不修改普通 Chat、Desktop continuous 或 Mobile replayable 的 Session/Task 状态边界。

## 7. 验证计划

1. Repo Wiki Lane Services 定向测试；
2. Account Runtime Headers Services 定向测试；
3. Bootstrap ZCode Protocol 双向请求与真实 Transport 取消测试；
4. Repo Wiki Deadline、Retry、终态回收定向测试；
5. API Key Provider 与 Account Provider 各做一次本地 Repo Wiki 纵向验证；
6. 运行时确认 Account Provider 出现 Runtime Headers applied、模型服务 TCP/HTTP 和 SSE 首包；
7. 停止或 Deadline 后确认 Agent 中不存在遗留 operation，下一次生成可立即开始；
8. 相关包 typecheck、根 `pnpm typecheck`、`pnpm lint`、格式检查与 `git diff --check`。

如果 HTTP 已实际发出但模型仍失败，再使用 `/v1/messages` 网络采集定位 Provider、请求体或 SSE；在 HTTP 前置阶段不得用空抓包
代替 Protocol 根因验证。

## 8. 完成标准

- Repo Wiki Account Provider 可以完成 Runtime Headers 反向 RPC 并发出真实模型 HTTP；
- API Key Provider 行为不回归；
- Catalog 成功后正常写入 `draft.json`，页面生成和 `wiki.json` 流程恢复；
- `workspace/cancelGenerateText` 能在在飞 `workspace/generateText` 期间执行并触发 Agent AbortSignal；
- Deadline、用户停止和任务终态均不遗留 Repo Wiki 物理请求或 Agent operation；
- 重试最大底层并发为 1；
- Repo Wiki Lane 文档、测试和实现对“完整 Host Protocol Wiring”的表述一致；
- 不新增第二套 Provider/Model/Account 权威，也不以延长 timeout 或增加重试掩盖故障。

## 9. 实施记录

2026-08-28 完成：

- Repo Wiki 独立 Client 在进入 Ready 前复用正式 `wireClient()`，Account Provider 的
  `interaction/requestProviderRuntimeHeaders` 已由 Host 账号服务应答；
- `workspace/cancelGenerateText` 与 `session/stop` 进入同一 Transport 控制面旁路，但仍等待前序
  `workspace/generateText` 已建立 operation controller，避免提前取消成为空操作；
- 保留 Services Deadline 与重试实现不变。真实 NDJSON 测试证明取消会先释放旧请求，后续普通请求才进入 handler，
  `maxConcurrentPhysicalRequests === 1`；因此无需新增取消确认队列或 Retry Policy；
- 增加 Runtime Headers requested / applied / failed 的低频生命周期日志，不记录 Header 或凭据正文；
- 更新 Repo Wiki Lane 当前事实：Lane 隔离进程、队列和生命周期，不隔离 Host Protocol 能力。

验证结果：

- Repo Wiki Lane、Account Runtime Headers、Services Deadline/Retry 定向测试通过；
- Bootstrap Transport 全文件 13 项通过，Server workspace cancellation 定向测试通过；
- `@zcode/bootstrap` typecheck、根 `pnpm typecheck`、根 `pnpm lint`、修改文件 lint 与
  `git diff --check` 通过；
- CLI 全仓 `format:check` 仍报告 296 个既存格式基线文件，本次修改的 CLI 文件已单独格式化且检查无新增问题。

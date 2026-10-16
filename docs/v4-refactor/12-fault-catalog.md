# Fault Catalog：`fault.*` 协议错误枚举（G-12）

本文把 [conversation-session-environment-fault-catalog.md](../testing/conversation-session-environment-fault-catalog.md)
中的环境故障整理为 `fault.*` reasonCode 与 `SessionErrorInfo` 映射，并记录仍未收口的产品裁决。

当前代码事实：`SessionErrorInfo.code` 和 ACK `reasonCode` 在 schema 中仍是 `string`，尚未由 zod enum
机械封闭；实现除下表环境故障外，还使用 `fault.command.*`、`fault.subscription.*`、
`fault.attachment.*`、`fault.projectionEventCommit.*`、`fault.runtime.*` 等执行/传输错误。因此本文是
环境故障基表，不是完整运行时代码枚举。新增 code 仍应回写相应规格，但不能声称当前已由类型系统强制。

两个口径要分清：

- **环境 code 基表（本文定义）**：provider/network/storage/lifecycle/workspace 的稳定命名和默认分类；
- **执行与传输 code**：以当前 handler/gateway 代码和 `10-protocol-spec.md` 为准，后续应补齐到本目录的协议表；
- **每个 fault 的产品行为**：仍由 decision worksheet 逐条裁决。下表保留 `decision-needed`，表示代码可能仍用通用 fallback，而不是已经确认的产品语义。

## 1. 结构

```ts
interface SessionErrorInfo {
  code: string;                  // 本文 fault.* 词表（或 proto.*，见 10 §6.2）
  message: string;               // 兜底英文；本地化文案由客户端按 code 生成
  recoverable: boolean;          // true → UI 提供重试入口
  at: Timestamp;
  source: "provider" | "runtime" | "tool" | "network";
  attribution?: {
    source?: "provider" | "runtime" | "tool" | "network";
    reason?: string;
    providerId?: string;
    modelId?: string;
    providerKind?: string;
    transport?: "http" | "sse" | "websocket";
    statusCode?: number;
    providerErrorCode?: string;
    retryable?: boolean;
  };
}
```

`attribution` 是兼容旧事件和旧持久化数据的可选事实层，不承担产品策略。它由 CLI 从已知错误上下文
按白名单投影，并在 live TurnError 与 persisted cold hydration 中保持一致；不得携带 URL、header、
token、请求/响应正文、prompt/tool 内容、stack、完整 detail 或 requestId。存在
`attribution.source` 时，`SessionErrorInfo.source` 取该值；缺失时继续回退为 `runtime`。
`attribution.retryable` 只描述失败事实，不替代本层 `recoverable`，因此不会改变 UI 重试入口。

命名空间划分（与 10-protocol-spec §6.2 的 reasonCode 命名空间并列）：

| 命名空间 | 语义 | 对应故障 catalog 组 |
| --- | --- | --- |
| `fault.provider.*` | provider 返回了明确的失败响应 | N01–N05、N08 |
| `fault.network.*` | 请求/流在网络层失败或中断 | N06–N07、S01–S07 |
| `fault.storage.*` | 本地文件系统/存储失败 | D01–D05 |
| `fault.lifecycle.*` | 进程/应用生命周期导致的中断 | L01–L08 |
| `fault.workspace.*` | workspace/tool 外部环境变化 | W01–W05 |

跨 session 隔离（X01–X03）不产生独立 code——它们断言的是「A 的 fault 不污染 B」，复用 A 自身的 code。

## 2. 词表

`决策` 列指该 fault 的产品行为裁决状态（源自 fault catalog / decision worksheet）；`recoverable` 是协议默认值，裁决可覆盖。

### fault.provider.*

| code | 触发 | source | recoverable | 来源 case | 决策 |
| --- | --- | --- | --- | --- | --- |
| `fault.provider.authFailed` | 主请求 401/403 | provider | false（需重新配置凭据） | N01 | decision-needed |
| `fault.provider.notConfigured` | provider 未配置 / API Key 缺失 | runtime | false | N02 | decision-needed |
| `fault.provider.rateLimited` | 429 | provider | true（自动重试候选） | N03 | decision-needed |
| `fault.provider.serverError` | 502/503 | provider | true | N04 | decision-needed |
| `fault.provider.requestFailed` | 500 JSON error body | provider | true | N05 | decision-needed |
| `fault.provider.malformedResponse` | 200 但非法 JSON/SSE | provider | true | N08 | decision-needed |
| `fault.provider.errorEvent` | SSE 流中 provider 主动发 error event | provider | true | S05 | decision-needed |
| `fault.provider.compactFailed` | compact 请求失败（手动或 auto 三连败终态） | provider | true | C01/C02 | **已裁决（2026-07-05）**：不进 `phase=error`，经 compact marker `failed` 表达；手动失败保持 completed + retry 入口，auto 三连败继续无压缩执行 |

### fault.network.*

| code | 触发 | source | recoverable | 来源 case | 决策 |
| --- | --- | --- | --- | --- | --- |
| `fault.network.unreachable` | DNS/connection refused/proxy/TLS，未拿到响应头 | network | true（TLS 类除外，按子因判定） | N06 | decision-needed |
| `fault.network.timeout` | 长时间无响应头 | network | true | N07 | decision-needed |
| `fault.network.sseDisconnected` | 响应头后 / message_start 后 / 部分 delta 后断流 | network | true | S01–S03 | decision-needed |
| `fault.network.sseMalformedEvent` | SSE event JSON 非法 | network | true | S04 | decision-needed |
| `fault.network.sseStalled` | stream stall 超过阈值 | network | true | S06 | decision-needed |

> S07（stop 后 late SSE event）不产生 code：按协议它必须被静默忽略（stale inputId 拒收），是正确性断言不是错误态。

### fault.storage.*

| code | 触发 | source | recoverable | 来源 case | 决策 |
| --- | --- | --- | --- | --- | --- |
| `fault.storage.historyWriteFailed` | session history 写入 ENOSPC/EACCES | runtime | true（释放空间后） | D01 | decision-needed |
| `fault.storage.workspaceWriteFailed` | tool 写 workspace 失败（磁盘满等） | tool | true | D02 | decision-needed |
| `fault.storage.settingsWriteFailed` | 设置/凭据保存失败 | runtime | true | D03 | decision-needed |
| `fault.storage.snapshotCorrupt` | 启动恢复时 session 数据损坏 | runtime | false（该 session 只读降级） | D04 | decision-needed |
| `fault.storage.logWriteFailed` | 日志/artifact 写失败 | runtime | true（产品流程应继续，仅 warn） | D05 | decision-needed |

### fault.lifecycle.*

| code | 触发 | source | recoverable | 来源 case | 决策 |
| --- | --- | --- | --- | --- | --- |
| `fault.lifecycle.agentExited` | CLI/agent 进程崩溃或异常退出 | runtime | true（可重启续接） | L06 | decision-needed |
| `fault.lifecycle.interruptedByQuit` | running/compacting 中退出 app，重启后发现未收口 turn | runtime | true | L03、L08 | decision-needed |

> L01/L02/L04/L05/L07（后台、关窗、renderer/host crash、sleep-wake）在 v4 架构下**不是 conversation fault**：它们是连接层事件，由 `subscribe(base)` 恢复路径吸收（04-sync-and-recovery），不进 `SessionErrorInfo`。这是 v4 相对旧架构的语义简化——「显示是易失的，事实是持久的」。

### fault.workspace.*

| code | 触发 | source | recoverable | 来源 case | 决策 |
| --- | --- | --- | --- | --- | --- |
| `fault.workspace.missing` | workspace 目录被删/改名 | runtime | false | W01 | decision-needed |
| `fault.workspace.fileConflict` | tool 操作中文件被外部修改/删除 | tool | true | W02 | decision-needed |
| `fault.workspace.gitDegraded` | repo 不存在/异常，降级普通目录 | runtime | true | W03 | decision-needed |
| `fault.workspace.remoteDisconnected` | SSH/WSL/Docker 连接断开 | network | true | W04 | decision-needed |

## 3. 约束

1. **目标是词表封闭，当前尚未机械实现**：新增环境 code 应先更新本文；新增执行/传输 code 应同步更新字段级协议。最终应把稳定集合收敛为共享 schema，而不是长期保留任意字符串。
2. **code ≠ 展示文案**：客户端按 code 查本地化文案表（i18n），`message` 只是兜底英文；禁止 UI 解析 message 字符串做逻辑分支。
3. **`recoverable` 驱动 UI 重试入口**，与行级 `canRetry` 的关系：session 级 `lastError.recoverable` 控制错误 banner 的重试按钮；行级 `canRetry` 控制该 turn 的重跑入口，两者由 reducer 分别计算。
4. **X 组隔离断言**进黄金测试：任意 fault 注入 session A，断言 session B 的投影逐字节不变。
5. 37 条 decision-needed 的产品行为裁决继续走既有 decision worksheet 流程（下一批建议 N01–N08 + S01–S07，它们决定 `phase=error` 的进入条件）；裁决结果回写本文`决策`列。

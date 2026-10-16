# MCP servers 设置页：刷新按钮不刷新 MCP 连接状态

> 类型：Bug（连接池 + UI）
> 影响面：`packages/ui` 设置页 → 插件 → MCP servers；`apps/zcode-cli` MCP 连接池
> 状态：已修复（见「修复」一节）

## 现象

1. 设置页 → 插件 → **MCP servers** tab，某个 MCP server 显示"已连接并可用"
2. 停掉该 MCP server 进程/服务
3. 点该 tab 工具栏的**刷新按钮**
4. **状态仍显示"已连接并可用"**，且此后无论等待多久、点多少次都不会变

唯一可靠的手动恢复：开关该 MCP server（关 → 开），或重启 app。

## 根因：进程级 lease 命中连接池复用，connect 模式根本没有重新探测

链路（改动前）：

1. `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts:115` —— 设置页用的
   `mcpPort` 是**进程级**的单个 lease：`acquireLease({ leaseId: "protocol-settings" })`。
2. `apps/zcode-cli/packages/adapters/src/mcp/pool.ts` 的 `connectionKey` =
   `serverName + leaseId（默认 session 隔离）+ stableStringify(config)`。
   同一个 lease + 配置未变 ⇒ **key 恒等**。
3. `acquire` 命中已有 entry 时只做「清 closeTimer、加 ref」，然后
   `return await entry.connecting` —— 返回**首次连接那个早已 resolve 的 promise**：
   不 close、不重连、不探测、不打日志。
4. 设置页的 `mcp/list` 虽然调 `connectConfiguredServers`，但走的是 **pool lease 的实现**，
   不是 `McpAdapter` 里那个"先 closeRecord 再重连"的实现。也就是说
   "connect 模式会真重连"只对直连 adapter 成立，对 pooled lease 不成立。
5. 快照来自 `entry.adapter.status()`，即 adapter 的 records。stdio 子进程死亡有
   `client.onclose` 兜底（`adapters/src/mcp/index.ts`）会翻成 `disconnected`；
   **HTTP/SSE 服务被停掉时没有任何 close 事件**，record 永远停在 `connected`。

叠加的第二个同形状缺陷：stdio 服务死亡被 onclose 标成 `disconnected` 后，点刷新也只会拿回
那条陈旧 `disconnected`，**永远不会重试连接**。

"会话侧已知失败不回灌设置页"也是同一条 key 规则的结果：session lease 用自己的 leaseId，
拿到的是不同 entry、不同 adapter。

### 实测证据

日志 `~/.zcode/cli/log/zcode-<日期>.jsonl`，`sess=-` 即设置页的 `protocol-settings` lease：

```text
08:40:04.732  mcp.server.connect.started   sess=-   plugin:official-tools:server
08:40:04.778  mcp.server.connected         sess=-   plugin:official-tools:server   ← 46ms，HTTP 特征
（之后停服务并多次点刷新，零条新 MCP 事件）
```

"零条事件"正是 entry 复用路径的特征：pool 复用分支只有 `previousKey !== key` 才打
`mcp.pool.lease.acquired`，命中复用时一条日志都不产生。而且每次点刷新都会 clear closeTimer，
entry 连 30s 空闲回收都不会走到 —— 于是状态永久冻结。

UI 显示的"已连接并可用"来自 `settings.mcp.plugin.connectedDescription`
（`zh-CN.ts`，"该插件 MCP 服务器已连接并可用。"），即 08:40 那份陈旧快照。

## 已被上游修掉、不再是原因的一项

早期分析认为刷新按钮绑的是 `PluginsSection.tsx` 的 `refreshAfterPluginChange()`（只刷插件清单）。
这一条在 `f876db289e feat: settings page upgrage`（2026-08-14）之后不成立：
`PluginsSection.tsx:508` 那个按钮属于 **plugins tab**（在 `PluginList` 内部渲染），
mcps tab 渲染的是 `McpSettingsSection`，它有自己的 header actions 并调用
`requestMcpServerStatusList()`。按 tab 分派已经做过了。

## 修复

### ① 连接池支持存活校验（P0，根因）

- `contracts/src/interfaces/mcp.port.ts`：`McpConnectOptions` 增 `revalidate?: boolean`；
  `McpPort` 增可选 `pingServer?(name, { timeoutMs })`。
- `adapters/src/mcp/index.ts`：实现 `pingServer`，用 MCP 基础协议的 `client.ping()`（5s 上限）。
  transport 级失败（`REQUEST_TIMEOUT` / `CONNECTION_CLOSED` / … 字符串 code 的 SdkError）判死，
  同时把 record 翻成 `disconnected` 并记 `mcp.server.ping.failed`；
  server 回了 JSON-RPC 错误（数字 code，例如未实现 ping）判活，不能据此拆掉可用连接。
- `adapters/src/mcp/pool.ts`：`acquire` 命中已有 entry 且 `revalidate` 为真时先跑 `revalidateEntry`：
  - `connected` → ping，活则复用（`mcp.pool.connection.revalidated`）；
  - `connected` 但 ping 判死、或已是 `disconnected` / `failed` / 首连失败 →
    在**同一个 entry 上原地重连**（`mcp.pool.connection.stale`）。保持 entry 身份是关键：
    共享该连接的其他 lease 不会掉成 `MCP server is not leased by this session`；
  - `connecting`（含 OAuth 待授权）/ `disabled` / `untrusted` → 原样返回，不打扰进行中的握手，
    否则会作废浏览器里已打开的授权 URL 和 PKCE/state。
  - 并发刷新共享同一次校验（`entry.revalidating`），不会重复 ping / 重复重连。
- `bootstrap/src/zcode-protocol/mcp.ts`：默认/connect 模式传 `revalidate: true`；
  `mode: "status"`（OAuth 1s 轮询）保持只读、不付 ping 成本。

### ② 手动刷新不再静默失败（P1）

`packages/ui/src/settings/McpSettingsSection.tsx`：

- `requestMcpServerStatusList` 增 `trigger: "auto" | "manual"`，guard 收敛到可测试的
  `resolveMcpStatusListRefreshSkipReason`。workspace 一致性判断全部保留（不能把 A 的配置发给 B），
  但 `serverStatusListKey` 为空只拦自动刷新——只有宿主/插件内置 MCP、没有任何用户 MCP 时
  这个 key 就是空串，用户点了刷新必须真的发请求。
- 被跳过时打 `[mcp] manual status refresh skipped` + reason，复现时能从日志判断
  "没发请求"还是"发了但读到旧状态"。
- `handleManualRefresh`：先 `loadMcpFromUserDirectory`，配置未就绪时补一次
  `ensureLoadedForWorkspace`（并同步补写 refresh input ref，否则同一 tick 内的请求仍会被
  `config-not-ready` 跳过），再以 manual 触发刷新；期间按钮进入 loading 态。
- 请求失败弹 `settings.mcp.refreshFailed` toast。

### 回归测试

- `apps/zcode-cli/packages/adapters/tests/mcp-connection-pool.test.ts`：ping 判活不重连 /
  判死原地重连 / 已 disconnected 直接重连且不 ping / OAuth 握手不打扰 / 无 ping 能力视为活 /
  未要求 revalidate 时不 ping / 并发刷新共享一次校验。
- `apps/zcode-cli/packages/adapters/tests/mcp.test.ts`：ping 成功保持 connected；
  transport 失败翻 disconnected 并告警；JSON-RPC 错误判活；未知 server 判死。
- `apps/zcode-cli/packages/bootstrap/tests/mcp-protocol.test.ts`：connect 模式带 `revalidate`，
  status 模式不触发 `connectConfiguredServers`。
- `packages/ui/test/mcpSettingsSectionStatusList.test.ts`：manual 不受空 key 拦截，
  workspace 一致性 guard 对 manual 仍然生效。

## 未做（可另开）

- **被动新鲜度**：`McpSettingsSection` 仍然没有面向连接状态的定时刷新；
  focus / visibilitychange 刷新被 `!pendingMcpOAuthAuthorizationRefreshKey` 门控，
  对无 OAuth 流程的 MCP 不通。可选方案：设置页可见时按低频（如 60s）跑 connect 模式刷新，
  或让 agent 在 MCP 状态变化时推 notification、设置页订阅（更准且无轮询开销）。
  注意 connect 模式会顺带重连已死的 server（stdio 会重新拉起进程），这是产品取舍。
- 自动刷新的 `serverStatusListKey` 仍只由 servers/plugins **列表**算出，对连接状态变化不敏感。
  手动刷新已绕开它；要做被动刷新时需要一并设计。

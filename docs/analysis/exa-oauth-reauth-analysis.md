# Exa MCP OAuth 重认证问题根因分析

> 分析日期：2026-08-13
> 分析基线：`exa-oauth-analysis` / `bfc91c54a9507beae4820c58f86a25fc3c44104d`
> 范围：只分析，不修改生产代码，不执行 OAuth 授权或 token 请求
> MCP server：`plugin:exa:exa`

## 1. 结论摘要

### 问题 1：为什么过一段时间后要求重新认证

已确认的直接机制是：

1. ZCode 当前实现会持久化并加载 refresh token；refresh 成功后也会原子更新 client/token pair。当前实现未发现“正常保存后重启必丢 refresh token”的代码 bug。
2. MCP SDK 在 MCP 返回未授权时，会优先使用已保存的 refresh token。若 Exa 返回 `invalid_grant`，SDK 会删除 token、保留 client，然后重试并进入浏览器授权。
3. 本机运行时现场正是“只剩 client/discovery，没有 token/canonical pair”，所以当前状态必然进入重新授权，而不是继续 refresh。
4. 2026-08-12 的日志显示 Exa 在 `08:54:49Z` 仍可连接，`09:00:13Z` 已进入交互授权，符合“access token 失效后 refresh 未恢复，token 被失效处理”的时间线。

但是，现有日志没有记录 Exa token endpoint 的响应状态和 OAuth error code，因此无法仅凭当前证据唯一判定 refresh 失败的上游原因是：

- Exa 主动过期/撤销了 refresh token；
- 历史旧版本或并发授权曾生成 client/token 不配对；
- 其他 Exa 服务端策略或临时错误。

当前凭据实现已经用 canonical pair、跨进程文件锁和 compare-and-delete 处理 client/token 交错覆盖。因此“desktop 与 CLI 的当前代码仍会普通地互相覆盖 token”不是本次可确认根因；未升级的旧进程写 legacy key 仍属于兼容窗口风险。

**定性：**

- refresh 失败后重新授权：OAuth 的正常降级行为。
- 未记录 token endpoint 错误码，导致无法区分 token 过期、撤销、client mismatch 和服务端错误：**可观测性设计缺陷**。
- 当前现场缺 token：**已确认事实**；具体删除原因受 2026-08-11 的人工 reset 操作影响，不能全部归因于程序。
- 多个独立运行时可同时发起同一 MCP 的 OAuth/DCR：**架构设计缺陷**，会放大凭据换代和重认证不稳定性。

### 问题 2：为什么二次认证超时

直接根因已确认：

- Session 启动路径把人工 OAuth 等待上限硬编码为 **15 秒**。
- 该值覆盖 `oauth.ts` 的默认 **5 分钟**。
- 15 秒后，连接被标记为 `MCP server plugin:exa:exa OAuth authorization timed out`，本地 callback server 被关闭，当前 state 的 PKCE verifier 被清理。
- 用户在浏览器登录、选择 team、阅读页面并点击 Authorize，通常无法稳定在 15 秒内完成。

设置页自己的后台连接通常不传 15 秒，走 5 分钟；但设置页 lease 和 Session lease 默认按 session isolation 建立不同连接，所以它们有不同的 `mcpConnectionId`、callback 端口、state 和浏览器 URL。设置页的 5 分钟等待不能延长或接管 Session 的 15 秒 OAuth。

**定性：**

- Session 把人机浏览器授权限制为 15 秒：**实现 bug / 产品行为 bug**。
- 设置页和 Session 对同一 OAuth 身份建立多个独立授权事务，缺少跨 lease/process single-flight：**架构设计缺陷**。
- callback listener 与 PKCE state 的超时清理本身基本正确，不是 stale state 根因。

### Exa `Server Components render` 错误

最强的 ZCode 侧诱因是：

1. DCR 注册时把当次随机 localhost 端口写入 `redirect_uris`。
2. 后续 OAuth session 每次重新监听另一个随机端口。
3. ZCode 优先复用持久化的旧 `client_id`。
4. refresh 失败后二次授权因此可能发出“旧 `client_id` + 新 `redirect_uri`”。

本机当前 client 注册的 redirect URI 端口是 `54735`；2026-08-13 的失败授权使用过 `58670`、`58676` 等新端口。若 Exa 对 DCR redirect URI 做精确匹配，这会触发 redirect 校验失败；Exa Next.js 授权页没有把它转为正常 OAuth 错误页时，可能表现为 generic Server Components production error。

这是**高可信推断，不是已直接抓到的 Exa 服务端堆栈**。RFC 8252 对 loopback native client 允许授权时使用任意端口，合规服务端可以忽略端口差异；本次没有登录态网络 trace，无法确认 Exa 是否实现了该例外。匿名只读探针中，两种 redirect 都先 `307` 到登录入口，说明 Exa 把最终校验推迟到了登录后，未能在匿名阶段证实或排除 mismatch。

另外，多 connection 并发产生多个 client/state/authorization URL，会使用户点击到已超时 URL 或非目标连接 URL；这是已确认的放大因素。Exa 页面自身用 generic SSR 错误代替结构化 OAuth 错误，也是对方页面的健壮性问题。

## 2. 事实边界与证据等级

本文使用以下标记：

- **确认**：代码、日志或本机持久化状态可直接证明。
- **强一致推断**：实现行为与现场形态吻合，但缺少 token endpoint 或 Exa 服务端日志。
- **候选诱因**：协议上成立，当前证据不能排序到唯一根因。

未取得的关键证据：

- Exa `/api/oauth/token` 对失败 refresh 的 HTTP 状态、`error`、`error_description`。
- 登录态下 `dashboard.exa.ai` / `auth.exa.ai` 的浏览器 Network trace 和 Next.js digest。
- Exa 服务端的 client registry、redirect 校验和 Server Components 堆栈。

因此本文不会把 `invalid_grant`、`invalid_redirect_uri` 或 Exa 删除 DCR client 写成已直接观测事实。

## 3. 实际插件配置与 OAuth discovery

### 3.1 实际加载的插件配置

实际官方插件 manifest：

`~/.zcode/cli/plugins/cache/claude-plugins-official/exa/3.4.0/.claude-plugin/plugin.json:10-17`

```json
{
  "exa": {
    "type": "http",
    "url": "https://mcp.exa.ai/mcp?client=claude-code-plugin",
    "headers": {
      "x-exa-source": "claude-code-plugin"
    }
  }
}
```

插件根目录另有 `mcp.json:3-9`，URL 参数是 `client=agent-plugin`。但当前 loader 默认查找的是 `.mcp.json`（带前导点），而该目录没有 `.mcp.json`；实际定义来自 manifest。若存在 `.mcp.json`，loader 才会使用 `{ ...fromFile, ...fromManifest }`，并由 manifest 覆盖同名项，见：

- `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:17-24`
- `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:34-42`

因此当前实际配置和凭据 prefix 对应的是 `claude-code-plugin` URL，根目录的 `mcp.json` 未进入这条加载路径。

manifest 没有显式 OAuth 配置。对于没有 Authorization header 的 HTTP/SSE MCP，ZCode 自动启用 authorization_code discovery：

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:1012-1025`

### 3.2 2026-08-13 现场 discovery

对 MCP endpoint 做了无凭据只读请求：

```text
HTTP 401
WWW-Authenticate:
  Bearer resource_metadata="https://mcp.exa.ai/.well-known/oauth-protected-resource/mcp"
```

resource metadata：

```text
resource              https://mcp.exa.ai/mcp
authorization_server  https://auth.exa.ai
scope                 mcp:tools
```

authorization server metadata：

```text
authorization_endpoint              https://auth.exa.ai/oauth/authorize
token_endpoint                      https://auth.exa.ai/api/oauth/token
registration_endpoint               https://auth.exa.ai/api/oauth/register
grant_types_supported               authorization_code, refresh_token
code_challenge_methods_supported    S256
token_endpoint_auth_methods         none
```

Exa 明确声明支持 refresh token 和 public client。其 scope 中没有 `offline_access`，但不能据此断言它不签发 refresh token；MCP SDK 仅在服务端声明 `offline_access` 时自动追加该 scope。

## 4. 首次授权时序

以下时序综合代码和 2026-08-11 的真实日志。当天同时出现三个 OAuth connection；其中两个约 15 秒失败，另一个约 74 秒后成功。

```text
用户/浏览器       设置页 lease          Session lease A/B        OAuth Provider       Exa Auth        凭据文件
    |                  |                       |                       |                 |              |
    |                  | connect              | connect               |                 |              |
    |                  +---------------------->|                       |                 |              |
    |                  |                       +---------------------->|                 |              |
    |                  |                       |   每个连接各建 callback server          |              |
    |                  |                       |   端口 54723 / 54726 / 54735             |              |
    |                  |                       |<----------------------|                 |              |
    |                  |                       |                       | discovery       |              |
    |                  |                       |                       +---------------->|              |
    |                  |                       |                       | DCR: redirect_uri=当次端口       |
    |                  |                       |                       +---------------->|              |
    |                  |                       |                       |<-- client_id ----|              |
    |                  |                       |                       | save client_information         |
    |                  |                       |                       +------------------------------->|
    |<-----------------+-----------------------+--- 展示一个或多个 authorization URL ----|              |
    |                  |                       |                       |                 |              |
    |                  |                       |-- 15 秒超时 ----------X                 |              |
    |                  |                       | close callback + 清当前 state verifier  |              |
    |                  |                       | failed / tools=0                        |              |
    |                  |                       |                       |                 |              |
    | 登录/选择 team/点击 Authorize（约 74 秒） |                       |                 |              |
    +---------------------------------------------------------------->|<-- callback code-|              |
    |                  |                       |                       | code exchange    |              |
    |                  |                       |                       +---------------->|              |
    |                  |                       |                       |<-- access/refresh tokens -------|
    |                  |                       |                       | saveMany(canonical, client, tokens)
    |                  |                       |                       +------------------------------->|
    |                  | connected / 2 tools   |                       |                 |              |
```

真实日志（字段已最小化，未包含 URL、code、token）：

```text
~/.zcode/cli/log/zcode-2026-08-11.jsonl

3779  11:25:53.335Z authorization.required connection=9df9... callback=54723
3781  11:25:53.627Z authorization.required connection=06c8... callback=54726 session=yes
3785  11:25:54.502Z authorization.required connection=85a0... callback=54735
3819  11:26:08.351Z failed connection=9df9... OAuth authorization timed out
3824  11:26:08.631Z failed connection=06c8... OAuth authorization timed out
3936  11:27:08.338Z authorization.completed connection=85a0...
3948  11:27:11.248Z connected connection=85a0... tools=2
```

从 `11:25:54.502Z` 到 `11:27:08.338Z` 是约 73.8 秒，直接证明真人授权所需时间可以远大于 15 秒，同时小于 5 分钟。

## 5. 问题 1：refresh token 保存、加载与失效

### 5.1 当前实现会保存并加载 refresh token

OAuth provider 从同一 credential pair 读取 client 和 tokens：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:182-199`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:213-215`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:434-505`

token exchange 或 refresh 后，`saveTokens` 会把：

- `authorization_credentials`：canonical client/token pair；
- `client_information`：legacy client 镜像；
- `tokens`：legacy token 镜像；

通过一次 `saveMany` 发布：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:217-250`

`saveMany` 在一个 read-modify-write 中更新多个 key：

- `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:152-161`

整个 read-modify-write 受跨进程文件锁保护，再原子写回：

- `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:260-270`

凭据文件权限现场为 `0600`。

结论：当前实现中，refresh token 不是只存在内存，也不是由 desktop 和 CLI 无锁地各自覆盖整份文件。

### 5.2 client/token 配对保护

当前 canonical v2 逻辑显式处理以下并发情况：

- legacy token 被删除时，不从 canonical 复活旧 token：`oauth.ts:439-447`
- 只有 legacy token 与 canonical token 一致时，才继续使用 canonical pair：`oauth.ts:448-460`
- client 不变时，可接收旧进程写入的新 refresh 结果：`oauth.ts:461-467`
- client 和 token 都变化、无法证明属于同一事务时，保留 client、丢弃不可信 token：`oauth.ts:468-476`
- 失效旧快照时使用 compare-and-delete，不删除其他事务刚写入的新 pair：`oauth.ts:334-373`

对应测试：

- 并发 adapter 的 PKCE state 隔离：`mcp-oauth.e2e.test.ts:248-349`
- DCR client 绑定到各自事务：`mcp-oauth.e2e.test.ts:351-375`
- canonical pair 原子发布：`mcp-oauth.e2e.test.ts:482-512`
- mixed-version 读写：`mcp-oauth.e2e.test.ts:514-601`
- 拒绝拼接不同事务的 legacy client/token：`mcp-oauth.e2e.test.ts:603-643`
- compare-and-delete：`mcp-oauth.e2e.test.ts:645-680`
- refresh 使用获胜 canonical pair：`mcp-oauth.e2e.test.ts:686-773`

因此，当前版本中“client 与 refresh token 经常被并发覆盖成错误组合”没有静态或测试证据支持。历史旧版本确实存在这种风险，这也是上述兼容和 canonical 逻辑的修复原因；若机器上同时运行未升级进程，legacy 写入仍可能使新 reader 因无法证明配对而主动丢弃 token、要求重新授权。

### 5.3 access token 过期后的 SDK 行为

仓库锁定：

`apps/zcode-cli/packages/adapters/package.json:105`

```text
@modelcontextprotocol/client 2.0.0
```

对 npm 发布包 `@modelcontextprotocol/client@2.0.0/dist/index.mjs` 的只读核对：

- `754-779`：存在 refresh token 时先调用 token endpoint，refresh 成功后调用 `provider.saveTokens`。
- `780-790`：没有可用 refresh，或可回退的 refresh 错误发生后，生成新的 authorization URL、PKCE verifier 并进入交互授权。
- `610-624`：
  - `invalid_grant`：invalidate tokens 后重试；
  - `invalid_client` / `unauthorized_client`：invalidate client 和 tokens 后重试。

ZCode provider 的 invalidate 实现位于：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:296-305`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:334-373`

因此 access token 失效后的路径是：

```text
MCP 401
  -> SDK 尝试 refresh_token
     -> 成功：saveTokens，新 access token 持久化
     -> invalid_grant：删除 token，保留 client，转浏览器授权
     -> invalid_client：删除 client + token，重新 DCR/授权
     -> 部分 server_error：可直接回退浏览器授权，未必先删除旧 client
```

### 5.4 本机凭据现场

权威凭据文件是：

```text
~/.zcode/v2/credentials.json
mode: 0600
Exa credential prefix: mcp:oauth:c50fd1fa63fb88a233be0688
```

当前仅有：

```text
discovery_state
client_information
```

当前没有：

```text
tokens
authorization_credentials
code_verifier
```

当前 client 信息仅以脱敏摘要记录：

```text
client_id SHA-256 前 12 位：d31ae07a373b
client_name：ZCode plugin:exa:exa
client_secret：无
client_id_issued_at：2026-08-11T11:25:54Z
grant_types：authorization_code, refresh_token
registered redirect URI：
  http://127.0.0.1:54735/oauth/callback/mcp/plugin%3Aexa%3Aexa
```

`credentials.json:27-28` 也只显示上述两个 Exa key；本文没有读取或记录任何 token 明文。

历史人工备份/reset 文件中的 Exa key 同样只有 client/discovery/verifier，没有 token，且 client 多次变化：

```text
credentials.json.exa-backup-20260725-215609   client hash c27de9b37128
credentials.json.exa-backup-20260725-215921   client hash 1ed8dd1faa86
credentials.json.exa-backup-20260725-220036   client hash a040da9c8465
credentials.json.exa-reset-20260811-192515    client hash fa0c35e0d90f
credentials.json                              client hash d31ae07a373b
```

这些文件名本身表明现场包含人工 backup/reset。故：

- “当前无 token”是事实；
- “全部 token 都被程序异常删除”不是可证明结论；
- 反复产生新 DCR client 是事实，与多授权事务并发和人工重置均一致。

用户指定的 `~/.zcode/db` 在本机不存在；实际 SQLite 位于 `~/.zcode/cli/db/db.sqlite`。其 schema 没有 OAuth credential/MCP credential 表，OAuth 凭据权威源仍是 `~/.zcode/v2/credentials.json`。

### 5.5 运行时间线

```text
~/.zcode/cli/log/zcode-2026-08-12.jsonl

1816  08:54:49.770Z  Exa connected, tools=2
1899  09:00:13.958Z  Exa authorization.required, callback=61820
1909  09:00:28.969Z  OAuth authorization timed out
```

“先连接成功，约 5 分钟后新连接进入授权”排除了“首次授权从未保存/从未生效”。它与 token 后续失效或不可 refresh 一致。

### 5.6 问题 1 的根因结论

| 层级 | 结论 | 证据等级 | 定性 |
|---|---|---:|---|
| 直接触发 | 当前无可用 token，SDK 只能重新授权 | 确认 | 状态事实 |
| refresh 流程 | 有 refresh 时会加载、尝试 refresh、成功后持久化 | 确认 | 实现正确 |
| refresh 失败后 | `invalid_grant` 会删 token；`invalid_client` 会删 client+token | 确认 | 合理降级 |
| 本次具体 refresh error | 日志未记录，无法唯一判定 | 确认缺口 | 可观测性设计缺陷 |
| 当前多进程覆盖 | canonical pair + 文件锁已保护普通写入 | 确认 | 非当前主根因 |
| 旧进程/legacy 混写 | 无法证明配对时会主动丢 token | 确认代码行为 | 兼容性风险 |
| 并发 OAuth/DCR | 不同 lease/process 可重复授权和注册 client | 确认 | 架构设计缺陷 |

## 6. 问题 2：15 秒超时链路与连接隔离

### 6.1 15 秒从哪里传入

Session runtime 定义：

- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts:5`

```ts
const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;
```

Session 启动时传入：

- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts:37-46`

```ts
connectConfiguredServers(servers, {
  oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
  // ...
})
```

adapter 把它传到 OAuth session：

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:680-719`
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:770-787`

```ts
authorizationTimeoutMs:
  oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs
```

等待 callback 时实际使用 `oauthSession.timeoutMs`：

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:570-600`

```ts
withTimeout(
  oauthSession.waitForAuthorizationCallback(),
  oauthSession.timeoutMs,
  `MCP server ${name} OAuth authorization timed out`,
)
```

OAuth 模块的默认 5 分钟只在调用方没有覆盖时生效：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:20`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:96-107`

```ts
timeoutMs:
  input.options?.authorizationTimeoutMs
  ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS
```

所以二次认证若由 Session startup 触发，确定命中 15 秒，不是 5 分钟。

### 6.2 设置页为什么救不了 Session

设置页 `mcp/list` 发起后台连接时没有传 `oauthAuthorizationTimeoutMs`：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:81-105`

该连接通常使用默认 5 分钟。日志中多次存在约 `300xxx ms` 后才 timed out 的无 session 连接，例如：

```text
~/.zcode/cli/log/zcode-2026-08-11.jsonl:1920
durationMs=300864
error=MCP server plugin:exa:exa OAuth authorization timed out
```

但是 protocol entrypoint 给设置页和 Session 发放不同 lease：

- 设置页：`protocol-settings`
- Session：`appOptions.sessionId`

见：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts:101-115`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts:126-133`

连接池默认 isolation 是 `session`，connection key 对非 workspace-isolated server 使用 `leaseId`：

- `apps/zcode-cli/packages/adapters/src/mcp/pool.ts:296-308`
- `apps/zcode-cli/packages/adapters/src/mcp/pool.ts:317-328`

因此：

```text
protocol-settings lease
  -> connection A
  -> callback port A
  -> state A
  -> 默认 5 分钟

session lease
  -> connection B
  -> callback port B
  -> state B
  -> 15 秒
```

`index.ts:153-168` 的 pending connection 复用只在同一个 adapter/record 内成立，不能跨 pool entry 共享。

### 6.3 2026-08-13 并发运行时证据

```text
~/.zcode/cli/log/zcode-2026-08-13.jsonl

6657  08:25:15.711Z required
      connection=461a95... session=yes callback=58676 state=17f0...
6658  08:25:15.747Z required
      connection=fb8aa7... session=no  callback=58670 state=7c51...

6680  08:25:30.722Z connection=461a95... timed out
6683  08:25:30.754Z connection=fb8aa7... timed out
```

两个 connection 在同一时刻为同一 Exa server 建立了不同 callback 端口和 state，并各自在约 15 秒后失败。它直接证明当前运行时没有形成全局 OAuth single-flight。

### 6.4 二次授权失败时序

```text
Session/设置页       OAuth Provider        凭据文件          MCP SDK          Exa Auth/Page       浏览器
     |                    |                   |                 |                    |               |
     | connect            |                   |                 |                    |               |
     +------------------->| load client/tokens|                 |                    |               |
     |                    +------------------>|                 |                    |               |
     |                    |<-- 旧 client；token 可能存在/不存在 |                    |               |
     |                    |                   |                 | MCP 401 / refresh |
     |                    +------------------------------------>|------------------->|
     |                    |                   |                 |                    |
     |                    |                   |      refresh 失败/不可用              |
     |                    |<------------------------------------|                    |
     |                    | invalidate token（具体 error 未记录）|                    |
     |                    +------------------>| delete token    |                    |
     |                    |                   |                 |                    |
     |                    | 新建随机 callback 端口 + 新 state   |                    |
     |                    | 复用旧 client_id                   |                    |
     |                    +------------------------------------>| authorize request  |
     |                    |                                     | 旧 client_id       |
     |                    |                                     | 新 redirect_uri    |
     |                    |                                     +------------------->|
     |                    |                                     |                    | Authorize 页
     |                    |                                     |                    | 可能 SSR error
     |                    |                                     |                    |
     |<-- authorization URL/status -----------------------------+                    |
     |                                                                 15 秒计时      |
     |--------------------------- 15 秒 ------------------------------X               |
     |                    | close callback server                                  |
     |                    | clear 当前 state verifier                              |
     |<-- failed/tools=0  |                                                         |
     |                                                                 用户稍后点击  |
     |                                                                 callback 到旧端口
     |                                                                 -> 已关闭/失败 |
```

若是设置页独立连接，最后一个计时点通常是 5 分钟；它仍可能与 Session 的 15 秒事务并行存在。

### 6.5 超时后是否留下 stale state

callback server：

- 随机监听 `127.0.0.1:0`：`apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts:69-83`
- 严格检查 path、state 和 code：`localhost-callback.ts:32-59`
- `close()` 关闭 HTTP server：`localhost-callback.ts:83-90`

OAuth session：

- `close()` 先关 callback server，再关 provider：`oauth.ts:96-100`
- provider `close()` 清理当前 state 的 verifier：`oauth.ts:312-331`
- verifier key 包含完整 state：`oauth.ts:538-545`

当前凭据中没有 Exa `code_verifier`，与清理成功一致。`discovery_state` 会保留，它是可复用 discovery metadata，不是 callback stale state。

真正残留的是：

- 浏览器中仍打开、但 callback 端口已经关闭的 authorization URL；
- Exa 服务端已经注册但不再使用的 DCR client；
- 用户面对多个 URL 时无法知道哪一个仍有效。

因此：

- 本地 callback listener 未清理：**否，未发现**。
- PKCE verifier 跨 state 误删/遗留：**当前实现和现场均不支持该判断**。
- stale browser URL / stale DCR client：**存在设计上的产生路径**。

## 7. Exa Server Components 错误的证据链

### 7.1 旧 client 与新 redirect URI

每次 OAuth session 都创建新 state 和随机端口：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:67-80`
- `apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts:69-83`

DCR metadata 使用当次完整 callback URL：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:163-175`

后续优先读取并复用存储 client：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:182-199`

MCP SDK 构造 authorization request 时使用：

- `clientInformation`：旧 client；
- `provider.redirectUrl`：当前新随机端口。

见 npm 包：

- `@modelcontextprotocol/client@2.0.0/dist/index.mjs:698-730`
- `@modelcontextprotocol/client@2.0.0/dist/index.mjs:780-790`

本机对照：

```text
注册时 redirect port：54735
后续日志端口示例：61820、58670、58676
```

这证明 ZCode 确实会构造“持久化 client + 新 callback 端口”的组合。

### 7.2 为什么只能定为高可信推断

对当前脱敏 client 做了不带登录态、无授权点击的只读探针：

```text
registered redirect  -> HTTP 307 -> auth.exa.ai /?callbackUrl=...
mismatched redirect  -> HTTP 307 -> auth.exa.ai /?callbackUrl=...
```

两个请求都先进入登录页，匿名响应没有暴露最终 redirect 校验结果，也没有出现 Server Components 错误。因此：

- 不能声称已经抓到 `invalid_redirect_uri`；
- 不能排除 Exa 按 RFC 8252 正确允许 loopback 端口变化；
- 用户登录态页面的 generic SSR error 仍需 Network trace 或 Exa 日志确认。

页面仍能显示 `Authorize ZCode plugin:exa:exa`，说明它至少取得了 client 展示信息；这降低了“client_id 完全不存在”的概率，但不能排除 client 状态不完整、team 绑定异常或授权记录异常。

### 7.3 其他候选诱因

按当前证据排序：

1. **旧 DCR client + 新 callback 端口的 redirect 校验/页面处理异常**
   ZCode 组合已确认；Exa 是否拒绝未确认。
2. **并发授权 URL / 已超时 URL**
   多 connection、多 state、多端口已由日志确认。用户可能在错误事务上登录或点击。
3. **Exa Personal team / account 的服务端数据异常**
   与页面的 Server Components 错误兼容，但 ZCode 侧无证据可验证。
4. **重复 DCR 本身冲突**
   ZCode 会产生多个 client 已确认；但 DCR 通常允许注册多个 client，目前没有 Exa 返回冲突的证据。

### 7.4 定性

- ZCode 长期复用绑定了某次 callback URI 的 DCR client，同时每次使用随机 callback 端口：**实现/设计边界缺陷**。即使 Exa 支持 loopback 端口例外，也不应依赖未验证的服务端宽松行为。
- ZCode 缺少同一 OAuth identity 的 single-flight，生成多 URL、多 DCR client：**架构设计缺陷**。
- Exa 页面把 OAuth 参数/账号数据问题展示为 generic Server Components production error：**Exa 页面健壮性 bug**。

## 8. 测试覆盖与缺口

已有测试覆盖：

- 单 adapter 内复用 pending OAuth，bounded caller 超时不关闭共享连接：`mcp.test.ts:880-932`
- per-connect OAuth timeout 生效：`mcp.test.ts:994-1032`
- 两 adapter 并发 PKCE 隔离：`mcp-oauth.e2e.test.ts:248-349`
- DCR client 事务绑定、canonical pair、mixed-version、refresh：见第 5.2 节。

关键缺口：

1. 没有测试“DCR client 在 session 重建后，注册端口与新 callback 端口不同”。
2. 没有严格模拟授权服务器对 `redirect_uri` 精确匹配或 RFC 8252 loopback 端口例外。
3. 没有覆盖 `protocol-settings lease + session lease` 对同一 server 并行授权。
4. 没有测试 refresh 返回 `invalid_grant` 后的完整 ZCode 状态、日志和二次授权 URL。
5. 没有人机授权耗时大于 15 秒的产品行为测试。
6. 没有断言 token endpoint 错误被脱敏地记录为可诊断 event。

## 9. 修复建议（仅建议，不实施）

### P0：修复 15 秒人机授权超时

不要让 Session startup 的阻塞预算等同于 OAuth 事务生命周期：

```text
Session 启动预算 15 秒
  -> 只决定“本次 Session 是否继续等待”
  -> 不关闭全局/设置页 OAuth transaction

OAuth transaction 生命周期
  -> 独立 5 分钟或用户取消
  -> 状态持续展示在设置页
  -> 成功后后续 Session 自动复用凭据
```

如果暂时不能拆生命周期，至少不要对已进入浏览器交互的 OAuth transaction 使用 15 秒硬关闭。

### P0：为同一 OAuth identity 增加 single-flight

协调 key 应基于 OAuth credential identity，而不是 connection lease：

```text
serverName + serverUrl + clientId + scope + redirectPath
```

只允许一个 leader：

- 执行 discovery/DCR；
- 持有 callback server/state/verifier；
- 暴露唯一 authorization URL；
- 发布 client/token pair。

其他 settings/session connection 只订阅该事务结果，各自的 15 秒 startup waiter 超时不能取消 leader。

跨 Node 进程时需要文件锁/lease 或集中在共享 host 中管理；单 adapter 内的 `record.connecting` 不够。

### P0：稳定 DCR 与 callback URI 的关系

建议按优先级评估：

1. 使用稳定 callback broker / deep link，再由 ZCode 转发到当前事务；
2. 若坚持 loopback，注册不含固定端口的 native redirect，并确认 Exa 按 RFC 8252 支持任意端口；
3. 若 Exa 只接受精确 URI，发现当前 callback URI 不在 client 注册集合时，先失效旧 client 并重新 DCR，不复用旧 client；
4. 把 redirect 兼容性纳入 discovery/DCR capability 缓存和测试。

### P1：增加脱敏 OAuth 诊断事件

应记录但不得记录 token、code、client secret：

```text
event=mcp.oauth.refresh.failed
mcpServerName
oauthErrorCode=invalid_grant | invalid_client | server_error | transport_error
httpStatus
clientIdHash
credentialPairVersion
credentialSource=canonical | legacy
willInvalidate=client | tokens | none
willStartInteractive=true/false
```

authorize 页面失败时也应记录：

```text
clientIdHash
registeredRedirectOrigin/path/portHash
currentRedirectOrigin/path/portHash
stateIdHash
connectionId
leaseId/isolation
```

### P1：改善 stale URL UX

- 授权 URL 超时后，设置页应明确显示“此链接已失效，请生成新链接”。
- 多连接请求同一 OAuth 时只展示 leader URL。
- callback 到已关闭端口时，若采用 broker，应显示可恢复页面，而不是浏览器连接失败。

### P1：补齐回归测试

至少增加：

- `refresh invalid_grant -> tokens invalidated -> one interactive transaction`
- `stored DCR client + new loopback port`
- `settings lease + N session leases -> one DCR/one URL`
- `session waiter 15s timeout -> leader remains alive -> callback at 60s succeeds`
- `old browser URL after replacement -> explicit stale response`
- `OAuth error log contains code/status but never contains token/code/secret`

## 10. 最终定性表

| 问题 | 根因/因素 | 定性 |
|---|---|---|
| 过一段时间要求重认证 | token 已不存在；refresh 未恢复后进入交互授权 | 直接机制已确认 |
| refresh token 是否保存/加载 | 当前实现会保存、加载、refresh 后更新 | 非 bug |
| 本次 refresh 为什么失败 | token endpoint 错误码缺失，无法唯一判定 | 可观测性设计缺陷 |
| client/token 跨进程覆盖 | 当前 canonical pair + 文件锁已保护；旧进程仍有兼容风险 | 当前非主根因 / 历史实现风险 |
| 二次认证 timed out | Session 硬编码 15 秒并关闭自己的 OAuth session | 实现 bug |
| 设置页 5 分钟为何无效 | settings/session 是不同 lease 和 connection | 架构设计缺陷 |
| 超时后 callback/verifier | listener 关闭、当前 state verifier 清理 | 实现基本正确 |
| stale state | 浏览器旧 URL、废弃 DCR client、多 URL 并存 | 设计缺陷 |
| Exa Server Components error | 最可能由旧 client/新 redirect 或并发 stale URL 触发；未抓到服务端错误 | ZCode 边界缺陷 + Exa 页面健壮性 bug |

## 11. 一句话根因

ZCode 把“Session 最多等 MCP 15 秒”错误地实现成了“OAuth 人工授权事务只能活 15 秒”，同时设置页与 Session 又按 lease 各自创建 OAuth/DCR 事务；refresh 不可用后，系统会在多个随机 callback 端口上复用或重建 client 并生成多个授权 URL，最终造成必现的短超时，以及高概率触发 Exa 授权页对 client/redirect/stale transaction 处理不健壮的问题。

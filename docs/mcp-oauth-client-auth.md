# MCP OAuth Client Authentication

> 后续设计：跨进程 OAuth 单飞与 refresh 竞态修复见 `docs/mcp-oauth-two-phase.md`（v4 两阶段连接）。
> 本文描述配置形态、凭据完整性与设置页边界；两阶段连接的 provider 形态、锁契约与错误分类以该文为准。

## 背景

MCP 2025-11-25 Authorization 规范把授权定义在 HTTP-based transport 上：

- HTTP/SSE MCP client 需要支持 `WWW-Authenticate` challenge、OAuth Protected Resource Metadata（RFC 9728）、Authorization Server Metadata/OIDC discovery、Resource Indicators（RFC 8707）和 Bearer token 请求头。
- stdio MCP 不走该规范，仍从进程环境变量读取凭据。
- access token 禁止进入 URL query，必须通过 `Authorization: Bearer <access-token>` 发送。

ZCode 当前 MCP adapter 已支持 `stdio`、`http`、`sse` transport，但 HTTP/SSE 原先只支持静态 headers。受保护 MCP server 返回 401 时，客户端必须能发现 OAuth metadata、完成用户授权或机器凭据授权、保存 token、重试请求，否则 Figma remote MCP 这类 OAuth server 无法开箱即用。

## 目标

把 OAuth 完整接入现有 MCP client 能力：

1. 配置层允许 HTTP/SSE MCP server 声明 `oauth`。
2. Agent runtime 将 `oauth` 从 UI/desktop protocol、CLI config、plugin MCP config 原样传入 MCP adapter。
3. MCP adapter 为 HTTP/SSE transport 注入 SDK `OAuthClientProvider`，复用 SDK 的 401 challenge、metadata discovery、token 获取、refresh、resource parameter 和 bearer header 逻辑。
4. `authorization_code` 交互式 OAuth 使用 PKCE、动态客户端注册、localhost callback、浏览器授权、token 持久化和重连 retry，覆盖 Figma remote MCP 这类用户授权 server。
5. `client_credentials` 继续支持机器凭据 OAuth，不要求浏览器。
6. stdio MCP 不消费 `oauth`，保持环境变量凭据路径。
7. 端到端测试使用本地受保护 MCP HTTP server 和本地 OAuth authorization server 验证：未带 token 的 initialize 请求收到 401 后，客户端发现 metadata，打开授权 URL，接收 callback code，换取 token，带 bearer token 重试，最终 listTools 成功。
8. 当授权服务器需要用户交互时，MCP 设置页展示手动“打开授权”入口；默认不自动打开系统浏览器，避免状态刷新、后台连接或启动检查打断用户当前操作。
9. Session 启动 MCP 时，`authorization_code` OAuth 的 **caller 等待预算**固定为 15 秒；超过后该 MCP server 在本轮 session 标记失败并继续，避免无人工授权时把模型请求卡住数分钟。15 秒只是本 caller 的等待上限，不是授权事务寿命：授权事务在后台按 300 秒全局 TTL 继续存活，完成后由后台重连注册工具。见 `docs/mcp-oauth-two-phase.md`。

## 配置

支持的配置形态：

```json
{
  "mcp": {
    "servers": {
      "protected": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "oauth": {
          "type": "authorization_code",
          "clientName": "ZCode",
          "scope": "mcp:connect"
        }
      }
    }
  }
}
```

字段：

- `oauth.type`: 支持 `"authorization_code"` 和 `"client_credentials"`。
- `clientId`: OAuth client id；交互式 OAuth 可省略，省略时通过授权服务器动态注册获取。
- `clientSecret`: OAuth client secret；仅机器凭据或预注册 confidential client 需要。
- `scope`: 可选；如果 MCP server 要求固定 scope，建议显式配置。未配置时客户端不主动指定 scope，是否能通过取决于授权服务默认策略。
- `clientName`: 可选，默认由 MCP server name 派生。
- `redirectPath`: 可选，仅 `authorization_code` 使用；默认是 `/oauth/callback/mcp/<serverName>`，实际 redirect URI 使用本机随机 localhost 端口。

## 手动授权入口

`authorization_code` OAuth 仍由 agent MCP adapter 持有 PKCE verifier、localhost callback server 和 token 持久化。UI 不持有 token，也不把 OAuth 状态下沉到 desktop main、relay 或 web remote 业务状态。

凭据持久化 key 按 `serverName`、`serverUrl`、`clientId`、`scope`、`redirectPath` 五个维度隔离；其中任一授权语义字段变化都会触发重新授权，不复用旧 token 或动态注册 client 信息。

当 MCP adapter 发现需要用户授权时，会把本次 pending 授权的 authorization URL 放入 MCP status snapshot，但默认不自动打开系统浏览器。`mcp/list` 在检测到 pending OAuth 后应快速返回当前 status，而不是等待完整 5 分钟授权超时。设置页收到该状态后，在对应 MCP server 行展示手动打开按钮，点击后通过平台 `openExternal` 打开同一 authorization URL。

Agent runtime 仍保留显式注入 `openAuthorizationUrl` 的能力，供端到端测试或特定自动化流程主动驱动授权跳转；未注入时，授权跳转必须由 UI 中的用户动作触发。

授权 URL 只在当前 pending 授权期间有效；用户完成浏览器授权后，localhost callback 回到 agent，adapter 完成 `finishAuth`、保存 token 并重连。access token 和 refresh token 不进入 URL，也不传给 UI。

## Session 启动超时

Session runtime 和设置页状态刷新使用不同的 OAuth 授权等待策略：

- Session runtime 在 `connectConfiguredServers` 时传入 15 秒 OAuth 授权等待上限。用户没有立即完成浏览器授权时，只失败对应 MCP server，不阻塞本轮模型请求，也不终止后台授权事务（见 `docs/mcp-oauth-two-phase.md` 的 caller 预算与事务寿命分离）。
- `mcp/list` 设置页状态刷新不传 session 上限，仍由 adapter 使用默认授权窗口，并在发现 pending authorization 后快速返回 URL、后台继续等待授权完成。
- 设置页与 Session 命中同一份 pending OAuth 连接时，只共享 authorization URL、PKCE/state、callback 和底层连接生命周期；每个调用方仍使用自己的 `oauthAuthorizationTimeoutMs` 与 `AbortSignal` 等待边界。单个调用方超时或取消后返回当时的 runtime snapshot，不得关闭仍由其他调用方等待的 OAuth session。
- MCP transport 的普通 `timeoutMs` 只约束 connect/listTools/callTool 等协议请求，不应把 session 的 15 秒 OAuth callback 等待重新拉长。

## 并发授权事务边界

OAuth 状态分成事务态和配置级快照，禁止把独立字段跨生命周期拼接：

- 动态注册 client information 和 PKCE `code_verifier` 在授权进行中都属于单次事务。provider 必须在同一个 OAuth `state` 生命周期内固定本事务 client；SDK 注册阶段、authorization code exchange 阶段重复调用 `clientInformation()` 时，不得重新读取其他事务发布的 client。动态注册结果同时立即写入 legacy client key，作为 provider 重建后发起新授权的恢复种子；当前事务仍只使用内存中固定的 client，不能因并发注册而换绑。
- 成功换取 token 后，动态 client information 与 `access_token` / `refresh_token` 组成一个配置级 canonical credential pair。pair 必须写在同一个 credential key 中，通过一次带跨进程锁的 read-modify-write 原子发布；禁止继续分别覆盖共享 `client_information` 和 `tokens` key，否则最后写入的 client 与 token 可能来自不同事务。
- canonical pair 的 provider 读取也必须按快照进行。同一 provider 的 `clientInformation()` 和 `tokens()` 读取同一个 pair，避免两次独立文件读取之间被其他进程换代。只有共享凭据 I/O、解析和快照派生全部成功后才能把缓存标记为已加载；锁超时或临时 I/O 失败必须保持未加载，使同一个 provider 的下一次调用能够重试。
- discovery metadata 仍是配置级共享缓存；PKCE verifier 继续在 credential prefix 下按 OAuth `state` 隔离。不同 adapter、不同 callback 端口或并发重连不得读写同一个 verifier key。

每次 `authorization_code` 授权保持独立的随机 `state`、PKCE verifier、localhost callback server 和动态端口。一个调用方超时、取消或关闭时，只能关闭自己的 callback server 并清理本事务的 verifier/client；不得清理相同 MCP 配置下其他 pending 授权，也不得无条件删除配置级 canonical pair。

SDK 在 invalid client/grant 后会调用 `invalidateCredentials()` 并重试。provider 只能删除自己实际读取或发布的 canonical 原始快照：删除必须在凭据文件锁内比较当前值与期望值，匹配才删除。若另一个进程已经发布新 pair，compare-and-delete 必须失败并保留新值；随后当前 provider 清空本地快照并重新读取。仅比较 `publishedBy` 与当前 state 不足以覆盖 refresh，因为 refresh session 合法消费的是之前 state 发布的 pair。

升级兼容采用双向兼容窗口：`saveTokens()` 在同一个凭据文件临界区原子发布 v2 canonical pair 及匹配的 legacy `client_information` / `tokens` 镜像。v2 reader 只在 legacy client 与 canonical client 相同时采用旧进程单独写入的新 token，此时可以确认是同一 client 的 refresh；legacy token 缺失仍表示旧进程已 invalidate。若 legacy client 与 token 相对 canonical 同时变化，无 generation 的旧格式无法证明两者来自同一事务，v2 reader 必须保留 legacy client、丢弃不可信 token 并重新授权，禁止猜测性拼接。v1 canonical 没有镜像承诺，仅在 legacy tokens 被旧进程重新写入且身份可确认时优先采用该更新。待所有共享凭据的受支持版本均能读取 canonical 后，再通过独立迁移版本移除 legacy key。CLI 与 desktop 可能独立升级却共享凭据文件，因此客户端遇到未知 canonical version 时必须保留原值并回退，禁止把新版本快照当损坏数据删除。

成功换取 token 后或授权会话关闭时，应清理本事务 verifier。callback server 继续使用 `listen(0)` 分配随机端口，不引入固定端口或跨进程端口互斥。

localhost callback 的随机端口、监听 socket 和 OAuth `state` 属于当前进程，进程退出后原浏览器回调不能继续投递；重建 provider 只恢复已注册 client 并发起新的授权尝试，不承诺恢复已失效的 callback URL。授权完成后的 verifier 清理是 best-effort，清理失败必须记录安全日志，但不能把已经成功的 token exchange 或连接重试反转为失败。

## 共享凭据文件完整性

CLI adapter 与 desktop host process 会共同读写同一个 `credentials.json`。所有 read-modify-write 变更必须遵守以下约束：

- 整个 read-modify-write 临界区使用同一套跨进程文件锁；只给单次 `writeFile` 加锁不能防止旧快照覆盖其他进程刚写入的 key。
- 写入必须在目标目录创建临时文件，设置私有文件权限后通过 rename 原子替换；macOS/Windows 上的瞬时 rename 占用错误需要做有界重试。
- `ENOENT` 才表示空凭据文件。JSON 损坏、schema 不合法或其他读取错误必须先按内容哈希幂等保留一份权限为 `0600` 的 `.corrupt-<content-hash>.bak` 证据，再抛出错误；同一损坏内容无论被多少进程重复读取都只能生成一份备份。禁止把损坏内容降级成 `{}` 后继续保存，否则会清空全部凭据。
- 锁只覆盖本地凭据 I/O，不覆盖等待浏览器授权、网络 token exchange 或 15 秒 Session 授权窗口。

并发诊断日志只记录安全标识：进程 PID、adapter instance id、credential key prefix、OAuth state 的短哈希和 callback 端口。不得记录 verifier、authorization code、access token、refresh token 或 client secret。

## 影响与用例边界

本次完整性修复的影响面限定为 `persistence + validation/recovery`，不改变设置页交互、MCP protocol DTO、desktop continuous 或 web-remote replayable 交付语义。

| 触发                                          | 归属边界           | 必须保持的结果                                                                         |
| --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| 两个 adapter 同时对相同 MCP 配置发起授权      | OAuth 事务状态     | 两个 state 分别读取自己的 verifier/client，并都能通过严格 PKCE 与 code/client 绑定校验 |
| 两个授权事务先后成功并发布 token              | OAuth 配置快照     | canonical client 与 tokens 始终来自同一事务，后续 refresh 不发生身份错配               |
| 旧进程注册新 client 与另一旧进程 refresh 交错 | 版本兼容窗口       | 无 generation 时丢弃无法证明归属的 token，重新授权而不拼接不同身份                     |
| 失败事务与成功事务并发收口                    | OAuth 凭据失效     | 失败方只能 compare-and-delete 自己读取的旧快照，不得删除成功方新发布的 pair            |
| CLI 与 desktop host 同时写不同凭据 key        | 共享凭据持久化     | 两个变更都保留，不发生 whole-file lost update                                          |
| 凭据文件是无效 JSON 或 schema                 | 凭据恢复           | 保存失败、原文件不被覆盖，并产生可诊断备份                                             |
| 单个授权等待超时或关闭                        | OAuth 事务生命周期 | 只清理本 state 的 callback/verifier，不影响其他 pending state                          |

暂不在本次修复中合并设置页与 Session adapter 实例。

跨进程 OAuth leader/lease 与 refresh-token single-flight 两项已在补齐真实进程/PID 运行时证据后转正，成为 v4 两阶段连接设计，见 `docs/mcp-oauth-two-phase.md`。该设计取代本节此前「暂不增加」的表述：

- 被动连接改用纯 `AuthProvider`，零 listener、零 discovery、零 DCR；
- 所有 refresh（主动与 reactive）汇入一把独立于 credentials 文件的跨进程 refresh 锁；
- 交互授权由独立授权锁做跨进程与进程内两级单飞，DCR client 在授权事务内只存内存；
- canonical pair 增加每次 publication 唯一的 `generation`，失效改用 generation 条件事务。

## 设置页 status-only 刷新边界

- OAuth pending、授权回调后的 follow-up，以及从浏览器回到 app 的刷新统一使用 `mcp/list mode=status`，只读取 runtime status，不执行连接集合收敛。
- 普通全量 `connect` 仍负责新增、删除、配置变更和 stale server 收敛；若同名 server 配置未变且已有 authorization-code OAuth 正在等待 callback，重复收敛必须复用该 pending 连接，不能关闭 callback/session 或生成新的授权 URL。
- pending/follow-up 缓存、配置加载 readiness、排队请求和响应合并必须绑定 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。切换 workspace 时立即清空旧配置与 OAuth 缓存；旧 workspace runner 尚未发送时直接丢弃，已发送请求的结果也不得合并到新 workspace，更不能把旧 workspace 的 env、headers 或 OAuth `clientSecret` 发送给新的本地或远程 Agent。
- follow-up 是 pending 消失边沿触发的一次有界重试窗口；创建后，同 workspace 的 status snapshot merge 不能把它清空。只有重试耗尽、workspace 切换、重新进入 pending 或明确停止轮询时才结束该窗口。
- pending 状态轮询使用从窗口创建时计算的 5 分钟墙钟 deadline；每次调度前和请求完成后都检查 deadline，不能用请求次数近似持续时间，避免慢请求把轮询窗口放大到数小时。
- status-only 与全量 connect 使用独立 request epoch；status-only 开始时只推进自身 epoch，不清 authorization/tool count、不把其他 changed/unknown 行投影成 connecting，也不能作废同时进行的 connect 结果。
- status-only 请求失败时，设置页保留已有 status snapshot、authorization URL 和其他 MCP 的连接态；不能按全量 connect 失败清空 snapshot 或批量标记错误。
- 旧 Agent 若拒绝 `mode=status`，service 不得省略 `mode` 后静默重试默认 `connect`，并应返回稳定的“不支持 status-only”错误码。设置页识别后保留现有 UI snapshot，停止 pending/follow-up 定时轮询和焦点刷新，并一次性提示用户升级或重启后重新打开 MCP 设置执行完整刷新；切换 workspace 或成功执行显式全量刷新后再允许探测，避免持续告警或兼容路径改变 runtime 连接集合。

## 规范依据

- MCP Authorization specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- TypeScript SDK OAuth providers: https://www.npmjs.com/package/@modelcontextprotocol/sdk

## 非目标

- 不把 OAuth token 下沉到 desktop main、relay 或 web remote 业务状态；OAuth 行为只存在于 agent MCP adapter 的 HTTP/SSE transport。
- 不为手机 `/remote` 创建独立 Agent runtime 或独立 MCP runtime。
- 不实现 renderer 内嵌 OAuth WebView 或弹窗式登录；交互仍使用系统浏览器 + localhost callback，设置页按钮只是显式打开同一授权 URL。
- 不为 stdio MCP 增加 OAuth 流程。

## 验证

自动化验证需要覆盖：

- 配置 schema 接受 HTTP/SSE `oauth.authorization_code` 和 `oauth.client_credentials`，并拒绝缺少必要字段的配置。
- ZCode Protocol DTO 在 session create/resume/mcp list 链路中保留 `oauth` 配置。
- MCP adapter 对 HTTP/SSE transport 传入 `authProvider`，且静态 headers 仍保留。
- MCP status snapshot 在 pending authorization_code OAuth 时返回 authorization URL，设置页展示手动打开按钮。
- 端到端测试确认受保护 Streamable HTTP MCP server 在 401 -> authorize redirect -> callback code -> token -> retry 后连接成功并列出工具。
- 严格 fake authorization server 每次动态注册返回不同 client，并校验 authorization code、client、redirect URI、S256 challenge/verifier 的绑定；两个并发 adapter 必须分别完成授权。
- 并发事务完成后，持久化 canonical client/tokens 必须来自同一事务；新 provider 使用该 pair refresh 时不得退回重复授权。
- 一个事务失败并触发 credential invalidation 时，不得删除另一个事务刚发布的 canonical pair。
- 同进程并发和独立 Node 进程并发写入共享凭据文件时不丢 key。
- CLI adapter 与 desktop credential service 遇到损坏凭据文件时都拒绝覆盖，并保留 `.corrupt-*.bak` 证据。
- 同一损坏凭据被同进程或多进程重复读取时，备份按内容幂等且权限为 `0600`；内容变化后才创建新的诊断证据。
- 新 provider 发布后旧 provider 仍能读取 legacy pair；旧 provider refresh 或 invalidate 后，新 provider 不得继续读取 stale canonical。

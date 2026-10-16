# ZCode 官方 Server MCP 客户端接入（第一阶段，历史 Decision Log）

> 当前实现事实统一见 `zcode-official-server-mcp-auth-spec.md`。本文保留阶段性设计与决策演进，
> 不再作为当前鉴权头、scope、额度或 UI 行为的直接实现依据。

> 日期：2026-08-14（2026-08-15 实现完成）  
> 状态：已实现（客户端侧；后端待开发，见 §12）  
> 范围：ZCode 客户端/Agent 运行时；不改 UI，不改官方 MCP 后端，不提交 fake 能力到正式发布目录

## 1. 目标

第一阶段让 ZCode 能从官方 Plugin 加载远程 Streamable HTTP MCP，并在每次实际 HTTP 请求前，
为受信任的官方 Origin 注入当前用户的 Coding Plan 身份头。

本阶段交付以下能力：

1. Plugin 的单个 HTTP MCP 可以声明 `zcode_official`；
2. `jwt_token` provider 使用当前 ZCode 用户 JWT 作为 Bearer Token；仅在 Registry 存在有效
   Coding Plan Provider 且 MaaS JWT 可用时附加 `X-Bigmodel-Authorization`，并按对应
   `wireScope` 附加 `Bigmodel-Target-Type` 及 Team 的 organization/project（完整头集合与
   identity-only 例外见 §6.1）；
3. 只有目标 Origin 等于当前 ZCode API origin 时，MCP transport 才能取得并注入身份头
   （本条最初要求“官方 Plugin 身份 + Plugin 内 MCP key + 精确 Origin”三者同时命中宿主可信映射，
   2026-08 收敛为只校验 Origin，理由与残留风险见 §5.1）；
4. 增加一个测试专用的 fake 官方 Plugin 与 fake HTTP MCP server，覆盖插件解析、信任判断和
   MCP `initialize` / `tools/list` / `tools/call` 的真实请求头；
5. 不新增或修改任何 UI 页面、组件、store、文案、i18n 或设置项。

`serverId`、`capabilityId` 均不在本方案中。Plugin 内 `mcpServers` 的 key 就是该 Plugin 下的
MCP 身份；运行时仍使用现有命名空间 `plugin:<pluginName>:<mcpKey>` 防止不同 Plugin 重名覆盖。

## 2. 当前代码事实

| 当前事实 | 代码位置 | 本阶段结论 |
| --- | --- | --- |
| MCP runtime config 已支持 `stdio`、`http`、`sse`，HTTP 当前只有 `headers` / `oauth` | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts` | 只扩展 HTTP config 的官方鉴权声明，不新增新的 MCP transport |
| Plugin loader 会把 `.mcp.json` 的 MCP key 投影为 `plugin:<pluginName>:<mcpKey>`，但当前会丢弃未知 `auth` 字段 | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` | 在 Plugin 解析边界严格解析 `zcode_official`，同时保留宿主生成的 provenance |
| Streamable HTTP transport 通过 `createMcpTransportFetch(...)` 发请求，静态 header 进入 `requestInit` | `apps/zcode-cli/packages/adapters/src/mcp/index.ts`、`network.ts` | 敏感身份头必须由动态 fetch wrapper 注入，不能写回 config 或长期放在 `requestInit` |
| **`http`/`sse` MCP 在没有 `oauth` 字段且静态 `headers` 无 `authorization` 时，默认被赋予 `{type:"authorization_code"}`**，进而创建 OAuth session、起 localhost 回调 server 并把 `authProvider` 交给 transport | `adapters/src/mcp/index.ts` 的 `resolveAuthorizationCodeOAuthConfig` / `hasAuthorizationHeader`；transport 构造见同文件 HTTP 分支 | `zcode_official` 必须显式退出该默认路径（§6.3）。本方案禁止静态 `authorization` 且不配 `oauth`，若不显式关闭，官方 MCP 必然落入隐式 OAuth |
| SDK 在有 `authProvider` 时把 401/403 转成 OAuth 重授权流程，并经 `onAuthorizationRequired` 把 authorizationUrl 写入 MCP record status | `@modelcontextprotocol/sdk` client `streamableHttp` 的 401/403 分支；`adapters/src/mcp/oauth.ts` 的 `redirectToAuthorization`；`adapters/src/mcp/index.ts` 的 `createAuthorizationCodeOAuthOptions` | 与"无 UI 自动鉴权"目标冲突。`zcode_official` 需自有 401/403 语义（§6.3），不得触发授权 URL 或浏览器 |
| SDK 组装请求头时 `requestInit.headers` 优先级高于 `authProvider` 写入的 `Authorization`，且能覆盖 `mcp-session-id` / `mcp-protocol-version` | SDK client `streamableHttp` 的 `_commonHeaders()` | 保留头黑名单需覆盖协议头，且身份头注入必须发生在最后一棒的 fetch wrapper（§6.3） |
| 当前选中 Coding Plan 的 JWT、API Key、Team organization/project 已能被解析成同一份凭证快照 | `packages/services/src/session/offPeakRuntimeModel.ts` | **作为逻辑参考，不复用、不修改**（§6.1.1）。官方 MCP 另写一套等价实现，避免与 Off-Peak 耦合 |
| 官方 Plugin 的内置身份、版本及打包根由 Bootstrap 清单管理 | `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | 该清单**不参与**官方 MCP 授权（§5.1 已移除映射表）；Plugin 声明的 URL 仍不被信任，但校验依据是运行时解析的 ZCode API origin |

本次扫描使用当前工作区静态代码与 `rg` 证据；当前环境未提供 codegraph 索引，因此没有把
未验证的间接可达关系当成产品事实。

## 3. 范围与非目标

### 3.1 范围内

- `http` / Streamable HTTP MCP；
- 官方 Plugin 中逐 MCP 声明鉴权类型；
- 客户端 host/service 解析当前 Coding Plan 身份；
- Agent 协议中的无 UI 自动鉴权请求/响应；
- MCP HTTP transport 的动态 header 注入和 Origin 校验；
- fake Plugin + fake HTTP MCP 的 adapter/bootstrap/service 定向测试。

### 3.2 范围外

- `stdio`、`sse` MCP 的 `zcode_official`；
- **Start Plan 用户的工具调用权益**。官方 Server MCP 的工具调用仍是 Coding Plan 专属权益；
  Start Plan 只有 ZCode JWT、没有可用的 Coding Plan Provider。API Key 模式或 Registry 缺少有效
  Coding Plan Provider 时也走同一 identity-only 语义：连接/发现请求只携带 ZCode JWT，不携带 MaaS
  JWT，由服务端区分登录态和套餐态错误（`1006` / `3101`）。
- 官方 MCP 后端工具实现、计费、限流和业务接口设计；
- `/api/v1/client/configs` 灰度逻辑；第一阶段仅保持现有灰度能力不变；
- MCP 设置页、Plugin 设置页、状态展示、登录引导等 UI 改动；
- 新增 usage record 或 capabilities 接口（端点本身已由后端实现，见 §12.3）；
- 短期 Token 签发。第一阶段 `jwt_token` 使用现有用户 JWT，不在客户端生成新 Token；
- 把 fake MCP 随正式安装包发布。

## 4. Plugin 配置合同

### 4.1 `.mcp.json` 示例

测试 Plugin 的配置形状如下：

```json
{
  "mcpServers": {
    "fake-official-search": {
      "type": "http",
      "url": "${ZCODE_FAKE_OFFICIAL_MCP_URL}",
      "auth": {
        "type": "zcode_official",
        "provider": "jwt_token"
      },
      "timeoutMs": 30000
    }
  }
}
```

字段语义：

| 字段 | 语义 |
| --- | --- |
| `mcpServers.fake-official-search` | Plugin 内 MCP key；仅作凭证解析与日志的归属标识（不参与授权，§5.1），不再重复声明 `serverId` |
| `type: "http"` | 使用现有 Streamable HTTP MCP client |
| `url` | MCP endpoint；可以继续使用现有 Plugin 模板解析，但解析结果必须再做 Origin 校验 |
| `auth.type` | 精确值 `zcode_official`（区分大小写）；不接受 `zcode-official_auth`、`zcode-official`、`zcode_official_auth` 等别名或大小写变体，避免配置语义分叉 |
| `auth.provider` | 第一阶段只允许 `jwt_token`；后续若增加短期 Token，应新增 provider，而不是改变该值的既有语义 |
| `timeoutMs` | 复用现有 MCP 协议请求超时 |

`auth` 放在具体 MCP 定义上，而不是 `plugin.json` 顶层。一个 Plugin 可以包含多个 MCP，且每个
MCP 可以使用不同 URL 或鉴权方式；Plugin 级声明会错误扩大凭证注入范围。

### 4.2 类型

```ts
export interface ZCodeOfficialMcpAuthConfig {
  type: "zcode_official";
  provider: "jwt_token";
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ZCodeOfficialMcpAuthConfig;
}
```

约束：

- `auth` 只允许出现在 `type: "http"`；stdio/sse 出现时 Plugin loader 报
  `plugin_mcp_server_disabled` 并禁用该 MCP；
  **已被第二阶段修订**：stdio 现在也可声明 `zcode_official`，身份头改经 `tools/call` 的 `_meta`
  下发，见 `zcode-official-server-mcp-stdio-meta-phase-2-spec.md`。`sse` 仍拒；
- 第一阶段不允许同一个 MCP 同时配置 `oauth` 与 `zcode_official`；两者同时出现时 Plugin loader 报
  `plugin_mcp_server_disabled` 并禁用该 MCP，不做优先级裁决；
- `zcode_official` 命中时必须**显式关闭**该 MCP 的隐式 OAuth 兜底：`authProvider` 传 `undefined`，
  不创建 OAuth session、不起 localhost 回调 server。仅"不写 `oauth` 字段"不足以达到该效果，
  原因见 §2 的既有默认行为与 §6.3；
- 官方身份不是由 `auth` 字符串单独证明。Plugin loader 仍会生成不可由 `.mcp.json` 控制的运行时
  provenance：`pluginId`、原始 `mcpKey`、`source`；它们用于日志归属与凭证解析，**但自 2026-08
  起不再参与信任判定**（见 §5.1）；
- 因此，第三方 Plugin 复制同一 `auth` 字段并把 url 指向 ZCode API origin，**确实能取得身份头**。
  这是移除 marketplace 检查后有意接受的结果：凭证只流向真实 ZCode 后端，风险是滥用而非外泄，
  由服务端的权益／配额校验兜底。详见 §5.1 的残留风险第 1 条。

## 5. 信任模型与 Origin 映射

### 5.1 权威映射

信任判定实现在 `packages/shared/src/official-mcp-auth.ts`
（`isOfficialMcpOriginTrusted` / `createOfficialMcpTrustedOriginRegistry`）。

**规则（决策已变更两次，当前为最新）**：

```text
目标 origin === 当前 ZCode API origin（https）
```

**为什么不再要求 pluginId 来自官方 marketplace（2026-08 决策变更）**：该检查曾作为第二道
控制存在（要求 pluginId 以 `@zcode-plugins-official` 结尾）。移除原因有两条：

1. **它让官方插件在发布前无法自测。** 本地安装的插件 id 是 `official-tools@inline`
   （`plugins.dirs`）或 `official-tools@<本地 marketplace>`，永远拿不到官方后缀。而 dev
   loopback 开关只放开 http loopback，救不了指向真实 https 端点的自测。结果是"要测真实后端
   就必须先发布到官方 marketplace"——死锁；
2. **它防御的场景已被其它能力覆盖。** 第三方插件若要冒领凭证，它同样可以携带 hook /
   command，而那是以用户身份执行的任意代码，能直接读取 `~/.zcode` 下的同一份凭证。因此这道
   检查并非"第三方拿不到凭证"的真实屏障。

**为什么不再维护 per-mcpKey 白名单**：官方插件不完全随 app 发版，可经带外渠道更新。
维护 mcpKey 清单会让"插件更新里新增的 MCP"必须等下一次客户端发版才能用，构成真实的发布
摩擦；而该清单对本地篡改场景几乎无防护价值（名字就写在常量里，照抄即可）。因此
`OfficialPluginDefinition` 上不再声明 `trustedMcpOrigins`，也不存在 canonical 域名表。

**为什么域名用运行时解析而不硬编码**：ZCode API origin 随环境变化（production/test、
自建环境），硬编码 prod 域名会让非生产环境全部 fail closed。解析口径与闲时任务一致
（host 侧走 `resolveCurrentZCodeEndpointOrigin`，含 settings 覆盖；CLI 侧走
`resolveRuntimeZCodeEndpointOrigin(env)`）。

**为什么把该 origin 纳入信任不扩大信任面**：同一 origin **已经**在收同一批凭证——闲时任务发
`authorization` + `x-coding-plan-api-key`（`offPeakServerClient`），Coding Plan reset / usage 接口发
`authorization` + `x-bigmodel-authorization`，而官方 MCP 自 2026-08 起走的正是后者（§6.1）。
因此这是等价性论证，而不是"官方域名所以可信"。

**为什么在 shared 而不是 CLI bootstrap**：判定有两个消费者且分属互不可见的包——MCP adapter
（请求发出前）与 host/services（身份权威边界的二次校验，只依赖 `@zcode/shared`）。单源是硬
要求，双处判定分叉会让一侧放行、另一侧拒绝。CLI 侧文件只做转发。

**唯一的控制与残留风险**：

| 控制项 | 防什么 |
| --- | --- |
| origin 相等（https、无 username/password） | 凭证被导向攻击者服务器——**唯一承重项** |

因为只剩一道，该检查必须保持严格：https、拒绝带凭证的 URL、逐字符等于运行时解析结果。

残留风险有五处，均已知并接受：

1. **任何插件都能声明官方鉴权**（移除 marketplace 检查后新增的风险）。第三方插件只要
   `auth.type = zcode_official` 且 url 指向 ZCode API origin，就能让客户端为它注入身份头。
   凭证只流向真实 ZCode 后端，**不构成外泄**，但构成滥用：以用户身份消耗额度、触发有副作用
   的官方接口。缓解依赖服务端——官方 MCP 端点走 `requireAuth` + `WithCodingPlan`，服务端对
   每次调用仍做权益与配额校验；
2. 能写入官方 plugin 缓存目录的本地攻击者，可在官方插件里加 MCP 并获得凭证注入。同上属
   滥用而非外泄，per-mcpKey 白名单对该场景本来也无效；
3. 校验只约束"我们批准哪些请求"，不约束"agent 拿到字节后干什么"。host 把身份头返回给
   agent 后，被攻破的 agent（尤其 desktop-attached remote）可自行改用它。要彻底解决需让
   host 代发请求、凭证永不出 host，属更大的设计改动，不在本阶段。因此当前设计的定位是
   **防御纵深**（防 agent 侧 bug、防未走 wrapper 的新代码），不是防已被攻破的 agent。
   顺带纠正一处曾经写错的推论（SG-03）：targetOrigin 校验**挡不住"知道该 origin 的请求方"**
   ——agent 经 `ZCODE_BASE_URL` 就知道它，插件也能在配置里写出它。它的作用只是把凭证的
   **流向**钉死在 ZCode origin；
4. **没有用户可见的授权确认**。插件声明官方鉴权、宿主发放身份头，全程用户无感。补一次性确认
   是收紧方向（见 `isOfficialMcpOriginTrusted` 末段），属产品决策，未做；
5. **审计粒度只到"首次发放"**。host 侧现在会为每个
   (pluginId, mcpKey, workspaceKey) 在本进程内首次发放时记一条 info 级
   `官方 MCP 身份头已解析`（`firstIssuance: true`），后续同三元组仍走 debug。因此能回答
   "凭据被哪个插件取走过"，但回答不了"取了多少次"。全量记 info 是消息量级的日志膨胀，
   本阶段不做。

**若后续要重新收紧**：不要恢复 marketplace 后缀检查（会再次造成上述死锁）。正确方向是给 dev
场景留显式旁路，或把"插件声明官方鉴权"改为需要用户可见的一次性授权确认。

### 5.2 安全规则

```text
Plugin MCP 配置
      |
      v
auth 是否精确为 zcode_official/jwt_token? -- 否 --> 普通 MCP 路径
      | 是
      v
URL.origin 是否 === 运行时 ZCode API origin 且为 HTTPS? -- 否 --> fail closed
      |                                                        (official_mcp_origin_untrusted)
      | 是
      v
向 host 请求当前身份头 --> 动态注入本次 HTTP 请求
```

判定不再包含"是否官方 marketplace 插件"与"(pluginId, mcpKey) 是否命中可信映射"两步；
pluginId / mcpKey 仍随请求传递，但只用于日志归属与凭证解析归属。

stdio 形态的判定输入不同（没有 URL 可供校验，targetOrigin 由客户端自行解析），见
`zcode-official-server-mcp-stdio-meta-phase-2-spec.md` §5。

- 正式判定只允许 `https:`，并拒绝 URL 中的 username/password；
- 单元/集成测试通过依赖注入增加 `http://127.0.0.1:<ephemeral-port>`，本地自测通过
  `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` 显式登记 loopback origin；两者都不得放开非 loopback；
- authenticated fetch 使用 `redirect: "manual"`。第一阶段遇到 3xx 直接失败，避免 Bearer Token
  被跨 Origin redirect 带走；正式 endpoint 应配置为 canonical URL；
- Plugin 的静态 `headers` 不得包含（大小写不敏感）任一保留头：`authorization`、
  `x-coding-plan-api-key`、`x-bigmodel-authorization`、`bigmodel-target-type`、
  `bigmodel-organization`、`bigmodel-project`，以及协议头 `mcp-session-id`、
  `mcp-protocol-version`；解析时直接禁用该 MCP，不采用静默覆盖。协议头必须入黑名单的原因见
  §2：SDK 组装时 `requestInit.headers` 优先级高于协议头，静态配置可覆盖 session id；
- 保留头黑名单与 §6.1 实际注入的头集合必须同源：常量放在 `packages/shared` 由 Plugin parser 与
  MCP adapter 共同引用，新增身份头时只改一处；同时在 §6.3.2 的 fetch wrapper 合并点二次强制，
  不只在解析期拦截；
- 日志只记录 `pluginId`、`mcpKey`、Origin、失败分类、HTTP status 和 request/trace id；禁止记录
  JWT、Coding Plan key、完整请求头或凭证指纹；
- **服务端 request id 的对账口径**：客户端不发送 `X-Request-Id` / `X-Trace-Id`（服务端
  `logx.RequestID()` 自行生成、不采纳入站值），只从**响应头**读回 `x-request-id`，作为客户端日志
  与服务端日志唯一的关联键。因此：
  - 成功响应记在 `debug`（高频，且成功时不需要对账）；
  - **任一非 2xx 响应必须记在 `warn`**，字段含 `httpStatus` 与 `serverRequestId`。理由是生产
    构建的 logger 最低级别是 `Info`（`getDefaultMinLevel`），只记 debug 等于出错时拿不到这个 id；
  - §6.3.3 的分类错误（401 / 403 / 3xx）message 里附带该 id，让它随 MCP record 的失败原因
    一起可见，而不是只躺在日志里；
  - **in-band 失败（HTTP 200 + `isError: true`，如配额耗尽）也要带上该 id**。这类失败对
    HTTP 层是成功，上面那条非 2xx warn 覆盖不到；而响应头只有 fetch wrapper 看得见（它之上
    是 MCP SDK，只交出 JSON-RPC 结果）。因此 wrapper 通过回调把 id 上报给 adapter，adapter
    按 **span** 关联回本次 `tools/call`：写一条 `mcp.tool.call` 的 warn，并在结果的 `_meta`
    上附 `zcode/officialMcpServerRequestId`（成功路径不附，避免每次调用都塞排障字段）。
  - 关联键必须是 span 而非 traceId：traceId 覆盖整个顶层 session，同一 session 的多次调用
    共用它，用它关联会串号。取不到 span（`initialize` / `tools/list` 没有 `_meta`，或调用方
    未传 trace）时**不填**该字段，绝不用"最近一次响应"兜底——那会把上一次调用的 id 贴到这次
    失败上，比没有更糟。

## 6. 鉴权头与凭证归属

### 6.1 `jwt_token` 的请求头

对可信 MCP 的每个 HTTP 请求，动态生成：

```http
Authorization: Bearer <current-zcode-jwt>        # 由服务端 requireAuth 校验，始终发送
X-Bigmodel-Authorization: Bearer <current-family-maas-jwt>   # 仅有效 Coding Plan Provider + MaaS JWT 可用时发送
Bigmodel-Target-Type: PERSONAL | TEAM            # 仅存在对应 wire scope 时发送
Bigmodel-Organization: <organization-id>         # 仅 TEAM，且与 project 同时存在
Bigmodel-Project: <project-id>                   # 仅 TEAM，且与 organization 同时存在
```

服务端契约依据（已按 `zcode-server` 当前代码核对）：`WithCodingPlan` 中间件读取
`X-Coding-Plan-Api-Key`、`X-Bigmodel-Authorization`、`Bigmodel-Organization`、`Bigmodel-Project`、
`Bigmodel-Target-Type` 五个头，JWT 的 `Authorization` 由 `requireAuth` 单独读取。要点：

- **`Bigmodel-Target-Type` 仅在存在对应 `wireScope` 时发送**，取值 `PERSONAL` / `TEAM`。
  对 BigModel Personal/Team，wire scope 分别为 PERSONAL/TEAM；ZAI Team 的 wire scope 为
  `null`，因此不发送该头并沿用服务端 fallback 分支。对 identity-only 请求（Start Plan、API Key
  模式或 Registry 缺少有效 Coding Plan Provider），同样不发送该头；这些请求只携带 ZCode JWT。
  当该头发送为 TEAM 时，organization/project 必须成对存在；任一缺失时两者都不发送。
- 服务端 `CodingPlanContext.Valid()` 在 `TargetType=TEAM` 时要求 organization 与 project 同时非空。
  因此客户端也遵守成对原子性：两者任一缺失时都不发送；发送半套身份头会被直接判为 bad request；
- **凭证通道（2026-08 变更，本条取代第一阶段决策）**：`X-Bigmodel-Authorization` 与
  `X-Coding-Plan-Api-Key` 在服务端是**二选一**的通道（`credential := cmp.Or(Authorization, APIKey)`，
  Authorization 优先）。第一阶段的决策是"沿用 `X-Coding-Plan-Api-Key`、不发 MaaS JWT"，并把切换
  记为技术债；后端确认后（`middleware/coding_plan.go` 已把 API Key 通道注释为"仅存量客户端兼容，
  新接入必须用 MaaS JWT 头"），官方 MCP 在套餐凭证可用时改为**只发
  `X-Bigmodel-Authorization`**。identity-only 请求仍只发 ZCode JWT。三个要点：
  - **是换凭证，不只是换头名。** 新头必须携带 **MaaS 登录 JWT**
    （`oauth:<family>:access_token`，与 Coding Plan reset / usage 接口同一份），服务端会
    `ParseWithoutVerification` 取其 `customer_id` 并要求与当前用户一致。把 Coding Plan 业务 key
    填进新头会直接解析失败；
  - **两个头不能同时发。** JWT 会赢得 ZAI 绑定与额度查询，但 API key 的归属校验
    （`validateIdentityFromApiKey`）仍会照跑一次，一把过期或不属于本人的 key 会让整个请求 403/3101。
    因此这是替换而不是叠加；
  - **值带 `Bearer ` 前缀。** 服务端 `strings.CutPrefix(..., "Bearer ")`，裸 token 也接受；
    这里按 `zcode-server/docs/api_server_mcp.md` 规定的形式发送。
  Off-Peak 与 model relay 仍走 `X-Coding-Plan-Api-Key`（不同接口族、不同服务端契约），本次刻意不动；
- 头名大小写不敏感（服务端经 Gin `GetHeader` 做 `textproto` 规范化），按上方 http 块的写法发送即可，
  无需为大小写单独适配。

#### 6.1.1 独立实现，不复用 Off-Peak 代码（本阶段决策）

官方 MCP 的凭证解析与身份头构造**另写一套**，与 Off-Peak 逻辑等价但代码独立：

- **不复用** `resolveOffPeakCredentials(...)`、`buildOffPeakPlanIdentityHeaders(...)`、
  `resolveSelectedOffPeakCodingPlan(...)` 等 Off-Peak 函数，也不把它们改造成共享 helper；
- **不修改** `packages/services/src/session/offPeakRuntimeModel.ts` 的任何现有导出与行为，
  Off-Peak 链路零改动、零回归风险；
- 新实现建议独立落位（如 `packages/services/src/official-mcp/` 下的
  `officialMcpCredentials.ts` / `officialMcpAuthHeaders.ts`），命名不带 Off-Peak 业务名。

理由：两者的判定规则**当前一致但未来预期分叉**——官方 MCP 的套餐门槛、Team 支持范围、
凭证通道（§6.1 的 `X-Bigmodel-Authorization` 技术债）都可能独立演进。共享 helper 会让任一侧的
调整变成需要评估双方影响的改动；独立两套的重复成本远低于耦合成本。

代价是同一套规则存在两份实现，需靠测试守住一致性：§8.2 的 OMCP-021 覆盖 credential kind 到请求头
的完整映射，OMCP-025 守住 Off-Peak 零回归。两份实现出现行为差异时，以本 spec 的 §6.1 为准，
而非以 Off-Peak 现状为准。

Off-Peak 现有实现中的四处特性，新实现需**照抄语义但自行编码**：

1. **`Bigmodel-Target-Type` 当前完全没有生产者**，属新增能力（按 credential kind 映射）；
2. **`zai-team` 与 Off-Peak 保持一致（本阶段决策）**：Off-Peak 的
   `buildOffPeakPlanIdentityHeaders` 以 `kind !== "bigmodel-team"` 提前返回空对象，因此 `zai-team`
   不发送 organization/project——尽管 `resolveSelectedOffPeakCodingPlan` 其实已解析出这两个值。
   新实现沿用该行为。**连带约束**：服务端 `CodingPlanContext.Valid()` 要求 `TargetType=TEAM` 时
   organization/project 必须同时非空，故 `zai-team` 也**不能**发送 `Bigmodel-Target-Type: TEAM`
   （会被判 bad request）。`zai-team` 因此不发送 `Bigmodel-Target-Type`，落入服务端 fallback 分支，
   并继承与 Off-Peak 相同的已知风险（该分支并发查询 PERSONAL/TEAM，任一路失败即整体失败）。
   因此 §6.1 的 `Bigmodel-Target-Type` 不是无条件发送：ZAI Team 及所有 identity-only 快照均
   不发送该头。若后续要支持 ZAI Team 的精确 wire scope，在官方 MCP 侧单独放开即可，不需要同步改
   Off-Peak；
3. **防竞态的凭证一致性检查必须保留，且需覆盖所有 identity-only 路径**：每轮先读取由
   `providerFamilyDomain`、选中连接指纹、`oauth:active_provider`、`zcodejwttoken` 组成的身份快照；
   在返回仅身份凭证或完整 Coding Plan 凭证前再读取一次。任一字段前后不一致即整轮重来，两轮
   仍不稳定则返回 `official_auth_unavailable`。完整凭证路径还必须把当前 family 的 MaaS JWT 纳入
   同一轮一致性检查。这样既能挡住跨 family 混搭，也能挡住同 family 的 token 轮换；JWT 原文只在
   内存比较，不进日志、不进错误信息；
4. **mock 凭证不得默认开启**：Off-Peak 的 `resolveOffPeakCredentials` 在 `ZCODE_OFFPEAK_MOCK=1`
   且未显式传 `allowMockCredentials: false` 时返回占位 JWT/Key。新实现**不应引入该 mock 分支**；
   官方 MCP 没有对应的 mock 网关，测试通过依赖注入替换 credential 来源即可。若确需保留开关，
   必须默认关闭且使用独立环境变量，不复用 `ZCODE_OFFPEAK_MOCK`。

Start Plan 的套餐限制**在新实现中显式编码**（而非靠继承 Off-Peak）：选中连接为 Start Plan 时
返回 `official_auth_plan_required`，但仍允许连接/发现请求发送仅身份的 ZCode JWT。不要沿用
Off-Peak 的 `start_plan_not_supported` 等 reason 字符串；工具调用是否放行由服务端套餐校验决定。

身份认证与套餐凭证是两个独立维度。选中 Coding Plan、但无权益 Provider 已被 Registry 过滤时，
必须在要求 MaaS JWT **之前**识别该状态，并返回仅含 ZCode JWT 的 identity-only snapshot；不能因为
MaaS JWT 缺失把已登录请求降级成匿名。identity-only snapshot 的 `planScope` / `wireScope` 均为
`null`，且不包含 `codingPlanAuthorization`。

### 6.2 状态 owner

- JWT 权威源：host `credentialService` 中当前 ZCode 登录身份；
- Coding Plan 选择态、MaaS JWT 与 Team context 权威源：host 当前 settings、credentialService 与同一份
  provider registry snapshot；业务 key 不作为官方 MCP 出站凭证；
- Plugin 配置只声明“需要哪种鉴权”，不保存、不生成、不刷新凭证；
- Agent/MCP adapter 只消费一次请求所需的 header，不把 header 写入 `McpServerConfig`、Session
  snapshot、Plugin cache 或日志。

身份头解析不能推迟到模型真正发出 `tools/call` 时才首次执行：MCP 在模型调用工具之前必须先完成
`initialize` 与 `tools/list`，这两个请求同样需要鉴权。因此解析发生在**每个 MCP HTTP 请求发送前**，
覆盖 `initialize`、`tools/list`、`tools/call` 及后续协议请求。

#### 6.2.1 允许 in-flight 去重，禁止时间维度缓存

每请求解析一次的成本不低：一次解析包含跨进程往返、两次 settings 读取（前后比对指纹以防连接在
读取期间被切换）、一次 provider registry snapshot，以及指纹不一致时的重解析。而 MCP 的调用频率是
每个协议请求一次——一个 agent loop 连续调用 N 个工具即 N 次解析，且全部位于用户等待的关键路径上。

因此第一阶段允许且仅允许 **in-flight 去重**：

- 同一时刻若已有一次解析在进行中，后续请求复用同一个 pending Promise，不重复发起；
- 该 Promise settle 后**立即丢弃**，下一个请求重新完整解析；
- 不做任何时间维度缓存（不缓存 N 秒、不按 Plugin/连接常驻、不写入任何持久层）。

安全性不变：只有真正并发的请求才共享结果，而并发请求本就应看到同一份凭证快照；任何请求都不会
读到已被替换的旧凭证。这与"缓存若干秒"是不同的机制，后者存在过期窗口，本阶段明确不采用。

去重判据只有一个：当前是否存在正在进行的解析。作用域为 **host 全局**，不按 `pluginId` /
`mcpKey` / `targetOrigin` / workspace 分桶——凭证是 host 级全局状态（§7.1），同一时刻不同 Plugin、
不同 MCP、不同 workspace 的请求本就应拿到同一份凭证。按维度分桶只会削弱去重效果，不提升隔离性。

### 6.3 与 OAuth 隔离，以及 `zcode_official` 自有的鉴权失败语义

`zcode_official` 与 MCP OAuth 是两条互斥的鉴权路径。官方鉴权失败是**用户身份/套餐问题**，
只能由 ZCode 自身的登录与 Coding Plan 选择解决，不可能由目标 MCP 的 OAuth 授权解决；把 401
交给 OAuth 会把"请重新登录 ZCode"错误地呈现成"请授权这个 MCP"。

#### 6.3.1 必须关闭隐式 OAuth 兜底

如 §2 所载，`http`/`sse` MCP 缺少 `oauth` 字段时会**默认**得到 `{type:"authorization_code"}`，
其唯一逃生口是静态 `headers` 里存在 `authorization`——而 §5.2 恰好禁止该静态头。因此本方案
必须在 OAuth 配置解析处新增一条前置短路：

```text
resolveAuthorizationCodeOAuthConfig(config):
  if auth?.type === "zcode_official" -> return undefined   # 新增，位于所有既有分支之前
  ...既有分支保持不变
```

由此得到的硬性要求：

- `authProvider` 必须为 `undefined`；不得创建 OAuth session，不得起 localhost 回调 server；
- 不得写入 `authorization` 字段到 MCP record status，不得调用 `onAuthorizationRequired`，
  不得调用 `openAuthorizationUrl`；
- 普通 MCP、显式 `oauth` MCP 的既有默认行为完全不变——本条短路只对 `zcode_official` 生效。

#### 6.3.2 身份头注入必须是最后一棒且为覆盖语义

身份头只能在传给 transport 的 `fetch`（即包裹 `createMcpTransportFetch(...)` 的 wrapper）内注入，
该处是 SDK 组装完 `_commonHeaders()` 与 `requestInit` 之后的唯一出口。

- 对 §6.1 的每个身份头使用**覆盖**语义（`set`），禁止 `append`，禁止"缺失才补"。`append` 会产生
  逗号拼接的多值 `Authorization`，"缺失才补"会让非预期的既有值存活；
- wrapper 不得修改 `mcp-session-id`、`mcp-protocol-version`，也不得删除 SDK 设置的
  `accept` / `content-type`。

#### 6.3.3 失败分类与响应处理

`zcode_official` 的 MCP 请求按下表处理；凭证缺失时不得回退 OAuth、不得读环境变量猜凭证：

> 本表适用于 `type:"http"`。stdio 形态的失败语义**有意不同**（下发 `{ok:false, reason}` 而不是
> 置 failed，因为拿不到头的插件不会去打官方端点，不存在匿名请求），见
> `zcode-official-server-mcp-stdio-meta-phase-2-spec.md` §6.3。

| 情况 | 分类 | 行为 |
| --- | --- | --- |
| host auth port 不可用（如 standalone CLI） | `official_auth_unavailable` | 连接置 failed，不发任何请求 |
| 未登录，或无当前选中的 provider family / connection | `official_auth_unavailable` | 连接置 failed，不发任何请求 |
| 已登录但持有的是 Start Plan、API Key 模式，或当前选中 Coding Plan Provider 已从 Registry 移除 | `official_auth_plan_required` | 连接/发现请求仅发送 ZCode JWT，不发送 MaaS JWT 或 scope 头；工具调用仍由服务端判定套餐权益 |
| Origin/provenance 校验不通过（adapter 本地校验） | `official_mcp_origin_untrusted` | 连接置 failed，网络请求次数为 0 |
| host 侧二次校验 Origin 不匹配 | `official_mcp_origin_untrusted` | host 在读取凭据前拒绝，`resolveHeaders` 零调用；agent 侧置 failed |
| 后端 401 | `official_auth_rejected` | 按下方规则重试一次；仍 401 则置 failed |
| 后端 403 | `official_auth_forbidden` | 不重试，置 failed。403 表示身份有效但无权限/套餐不足，重取同一份凭证不会改变结果 |
| 后端 3xx | `official_auth_redirect_blocked` | 不跟随，置 failed（§5.2 `redirect: "manual"`） |

`official_auth_plan_required` 必须是独立分类，不得复用 Off-Peak 的
`start_plan_not_supported` 等 reason，也不得合并进 `official_auth_unavailable`——后者代表"环境/登录
态缺失"，前者代表"套餐层级不满足"，两者的后续动作不同（重新登录 vs 升级套餐），需要可区分地
落到 record status 与日志。第一阶段两者的用户可见表现都只是该 MCP 处于 failed，不弹任何引导。

401 的重试规则（唯一允许的重试路径）：

- 重新解析身份头并重试，**上限一次**，无条件（不比较凭证是否变化）；
- 重试仍 401 → 置 failed，分类 `official_auth_rejected`；重试次数硬上限为 1，不存在自旋可能；
- 该重试只针对 `zcode_official`，不改变普通 MCP 与 OAuth MCP 的既有 401 行为。

之所以无条件重试、不做"凭证变了才重试"的判定：身份头是每请求现解析的（§6.2），401 时凭证在毫秒
前才取得，能靠重试自愈的只有"请求发出后凭证恰好被刷新"这一窄竞态。为它引入跨进程的凭证变更
检测不划算；而持续 401 的连接会在 `initialize` 阶段即置 failed，无条件重试的代价只是每次连接尝试
多一个请求。

上述分类只进入 MCP record status 与日志（日志字段受 §5.2 约束）。第一阶段**不**因此弹出任何
登录引导、授权提示或其它 UI；`packages/ui` 保持零改动。用户可见表现即该 MCP 处于 failed，
与既有失败态渲染一致。

#### 6.3.4 第一阶段不启用 GET SSE 流

`zcode_official` MCP **不开启** SDK 的 GET `text/event-stream` 服务端推流。

原因：该流的请求头在开流瞬间一次性算好，之后连接长期挂着，没有"下一次请求"可供重新注入。
若启用，§11 的"切换登录身份或 Coding Plan connection 后不复用旧 header"对这条流无法成立，
等于留下一条持有过期凭证的长连接。

实现与后端约定（已按 SDK 实际行为核对）：

- 该 GET 流**不是**在 `start()` 时开启的。SDK 的触发点是：客户端发出
  `notifications/initialized` 后，**若服务端对该通知返回 202 Accepted**，SDK 才开启 GET 流；
  另两个触发点（`send` 传入 `resumptionToken`、公开方法 `resumeStream(...)`）本方案都不会调用；
- 因此"不启用"的落地方式是：服务端对该端点的 GET 返回**任意非 2xx**，SDK 将其视为"服务端不支持
  推流"并正常返回、不重试、不报错。客户端会发出恰好一次 GET 探测（携带正常身份头），这是可接受的
  固定开销；
- 实测现状：go-sdk 的 `StreamableHTTPOptions{Stateless: true}` 文档声明 GET/DELETE 返回 405，但
  gin 只为该路径注册了 POST（`router.go`），GET 根本到不了 handler，实际返回 **404**。对 SDK 行为
  等价，无需后端改动；
- 可选加固：fetch wrapper 可在本地直接短路对该 Origin 的 GET 请求并合成 405 响应，连探测都不发。
  第一阶段不强制，但若采用需保证与真实 405 的处理路径一致；
- 因此第一阶段官方 MCP 只有 client→server 的请求/响应语义，没有 server→client 主动推送。

若后续要开启推流，需同时补齐三件事，不能只让服务端开始支持 GET：服务端 GET SSE 且事件带 `id:`
（否则 `Last-Event-ID` 恢复形同虚设，断流即丢事件）、客户端的凭证变更检测与换流机制、
以及 `reconnectionOptions` 调优（SDK 默认 `maxRetries: 2`，对长连接偏少）。其中服务端事件 `id:`
最好在后端首版就做——后补属协议层改动，成本高于客户端侧。

## 7. 客户端实现边界

### 7.1 新端口

MCP adapter 不直接依赖 `packages/services`，通过依赖注入消费身份头：

```ts
type OfficialMcpAuthFailureReason =
  | "official_auth_unavailable"
  | "official_auth_plan_required";

type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}
```

契约要点：

- **失败走返回值而非抛异常**，返回 §6.3.3 定义的分类；adapter 不得把失败原因从错误文本里解析。
  网络层错误（401/403/3xx）不属于该端口的职责，由 adapter 在收到响应后自行分类；
- `workspaceIdentity` / `workspacePath` **仅用于请求上下文与审计，不参与凭证选择**。凭证权威源是
  host 全局的登录身份与 app settings，不按 workspace 隔离——不要据此实现 per-workspace 身份。
  也**不用于路由**：响应经 `client.respond(request.id, ...)` 回到发起请求的那条 stdio 连接，
  路由由连接本身决定。但端口仍必须遵守仓库约定
  `workspaceKey = workspaceIdentity?.trim() || workspacePath` 并完整透传 identity（CR review CR-01），
  否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
  **剩余缺口**：CLI agent 进程当前没有 workspaceIdentity 来源
  （`RunZCodeProtocolAgentOptions` 仅有 cwd/env/… ，也无对应环境变量），故该字段实际退化为
  workspacePath。端口保证的是"拿到 identity 就正确透传"，不是"identity 一定存在"；
  若审计需要真实远端身份，需在 spawn 或协议层把 identity 传给 agent，不在本阶段范围；
- `pluginId` / `mcpKey` / `targetOrigin` 用于**host 侧的二次校验**与日志，不参与凭证选择。
  该校验已在 host 实现（CR review CR-01）：`zcodeAgentService` 的 handler 在调用凭据解析
  **之前**用同一份 shared registry 校验三元组，未命中即返回
  `official_mcp_origin_untrusted`，`resolveHeaders` 不被调用，因此没有任何凭据被读入内存。
  validator 缺省时一律拒绝（fail closed），不退化为"只做 schema 校验就发凭据"。

  **为什么不能只靠 adapter**：adapter 的 fetch wrapper 运行在 agent 进程内，而 host 才是
  身份权威。desktop-attached remote 场景下 agent 跑在远端、host 持有本地用户身份，若只有
  adapter 校验，远端 runtime 只要发这个 RPC 就能取到本地 JWT 与 Coding Plan key；agent 侧
  wrapper 被改坏或被绕过时也没有兜底。等于让被审查方自己当审查者。

  注意 dev 开关 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` 必须**同时**对 host 生效
  （`node.ts` 装配时传入 `env`），否则本地自测会被 host 单方面拒绝。

职责分离：

1. Plugin loader：严格解析 `auth`，附加宿主生成的 official provenance；
2. Bootstrap：从 `OFFICIAL_PLUGIN_DEFINITIONS` 构造可信 Origin registry，并注入 MCP adapter；
3. MCP adapter：在动态 fetch 中先校验 provenance/Origin，再调用 `OfficialMcpAuthHeadersPort`；
4. MCP adapter：`zcode_official` 命中时短路 OAuth 配置解析，`authProvider` 传 `undefined`，并按
   §6.3.3 自行分类 401/403/3xx；
5. host/service：解析当前身份与 Coding Plan 凭证并返回条件化 header（独立实现、无 mock 分支，见
   §6.1.1）；
6. MCP adapter：以覆盖语义合并非保留静态 header 与动态身份头后发送请求（§6.3.2）。

### 7.2 Agent 协议

Desktop 启动的 Agent 进程不能自行成为用户身份权威。增加一个严格 schema 的内部请求：

```text
interaction/requestOfficialMcpAuthHeaders
```

命名与归类有现成先例：`interaction/requestProviderRuntimeHeaders` 同样是 Agent 发起、host 自动
响应、不产生任何 UI 的 header 请求。因此 `interaction/` 前缀并不等于"需要用户交互"，本请求沿用
该惯例即可，无需新建命名空间。

请求只携带非敏感上下文：

```json
{
  "requestId": "mcp-auth-...",
  "workspace": {
    "workspacePath": "/repo",
    "workspaceIdentity": "optional-remote-identity"
  },
  "pluginId": "zcode-tools@zcode-plugins-official",
  "mcpKey": "image-search",
  "targetOrigin": "https://mcp.zcode.example"
}
```

响应只在现有私有 stdio/remote host attachment 链路上传输。成功：

```json
{
  "ok": true,
  "headers": {
    "Authorization": "Bearer <jwt>",
    "X-Bigmodel-Authorization": "Bearer <maas-jwt>",
    "Bigmodel-Target-Type": "TEAM",
    "Bigmodel-Organization": "<org-id>",
    "Bigmodel-Project": "<project-id>"
  }
}
```

失败：

```json
{ "ok": false, "reason": "official_auth_plan_required" }
```

schema 用 `.strict()`（与既有协议一致），`reason` 为 §6.3.3 的枚举而非自由文本。响应中**不含**
`errorMessage`：失败原因必须可枚举，避免调用方按文本分流。

协议 schema 放在 `packages/shared/src/zcode-protocol/index.ts`。host 收到后由 service 自动解析并
响应，不产生 renderer event，也不经过 React controller。

Standalone CLI 若没有可用的 host auth port，第一阶段必须以 `official_auth_unavailable` 失败，不能
回退到无鉴权请求，也不能扫描环境变量猜测凭证。Standalone CLI 的本地 Coding Plan identity resolver
作为后续独立范围处理。

### 7.3 请求时序

```text
User            ZCode host/service        Agent + Plugin loader       HTTP MCP backend
 |                      |                           |                         |
 | start/resume task    |                           |                         |
 |--------------------->| create/reuse Agent        |                         |
 |                      |-------------------------->| load official Plugin    |
 |                      |                           | parse per-MCP auth       |
 |                      |                           | verify official provenance
 |                      |                           | verify exact Origin      |
 |                      |                           |                         |
 |                      |<--------------------------| request auth headers    |
 |                      | resolve one credential snapshot                     |
 |                      | ZCode JWT + 条件化套餐头（MaaS JWT / wire scope）     |
 |                      |-------------------------->| private response         |
 |                      |                           | inject headers           |
 |                      |                           |------------------------>|
 |                      |                           | initialize / tools/list  |
 |                      |                           |<------------------------|
 | model selects tool   |                           |                         |
 |------------------------------------------------->| resolve headers again   |
 |                      |<--------------------------|                         |
 |                      |-------------------------->|                         |
 |                      |                           | tools/call + headers     |
 |                      |                           |------------------------>|
 |                      |                           |<------------------------|
 |<--------------------------------------------------------------------------|
```

### 7.4 local / remote / web 边界

- Desktop local：请求通过当前 window-scoped Local Host 与其 Agent stdio 链路完成；
- desktop-attached SSH/WSL/Docker：继续复用既有 Remote Host 和
  `workspaceIdentity` / `remoteSessionId` 路由，不为 MCP 新建 Agent runtime；身份头只能响应给发起请求的
  已配对 Agent client；
- mobile `/remote`：只复用 desktop shared-host attachment 已有的 Agent/MCP runtime；relay 和
  desktop main 不保存 JWT、Coding Plan key 或 MCP session 状态；
- desktop `continuous` 与 mobile `replayable` 的 conversation 投递语义不变。官方 MCP 鉴权是网络
  transport 能力，不新增 conversation snapshot/queue 状态。

远端 Agent 会在其进程内短暂持有本次请求 header，这是远端执行 HTTP MCP 的必要条件；header 不得
进入 runtime config、持久化或日志。实现时必须增加 desktop-attached remote 定向协议测试；无法建立
真实远端环境时，应在验证记录中明确列为待补，不得把 local 测试宣称为 remote 已验证。

## 8. Fake Plugin 与测试设计

### 8.1 目录与身份

fake Plugin 使用测试 fixture，不加入 `OFFICIAL_PLUGIN_DEFINITIONS`、SEA asset、Desktop bundle 或
remote prebuild 清单。建议目录：

```text
apps/zcode-cli/packages/bootstrap/tests/fixtures/zcode-official-http-mcp/
  .zcode-plugin/plugin.json
  .mcp.json
```

测试通过 `officialPluginRoots` 注入该 root，并通过 adapter option 注入仅本测试有效的 loopback
Origin。fake HTTP MCP server 监听 `127.0.0.1` 随机端口，避免固定端口冲突。

### 8.2 Case Planning

| Case ID | Setup | Action | Assertions | 证据层 |
| --- | --- | --- | --- | --- |
| OMCP-001 | official fixture + 合法 auth | 解析 Plugin | runtime name 为 `plugin:<name>:fake-official-search`；auth/provenance 保留 | Adapter unit |
| OMCP-002 | inline/third-party Plugin 复制相同 auth | 解析/连接 | 不请求身份头，MCP fail closed | Adapter unit |
| OMCP-003 | official identity，但 URL Origin 与映射不符 | 连接 | `official_mcp_origin_untrusted`；网络请求次数为 0 | Adapter unit |
| OMCP-004 | official identity + 精确 loopback Origin | initialize/list/call | fake server 三类请求均收到当前 ZCode JWT；有有效套餐凭证时同时收到 MaaS JWT 与对应 wire scope | Adapter HTTP integration |
| OMCP-005 | BigModel Team snapshot 完整 | 发 MCP 请求 | organization/project 成对出现 | Services + integration |
| OMCP-006 | Team snapshot 缺任一字段 | 发 MCP 请求 | 两个 Team header 均不存在 | Services unit |
| OMCP-007 | Plugin 静态 header 覆盖任一保留头 | 解析 | MCP 被禁用并产生明确 diagnostic | Plugin unit |
| OMCP-008 | backend 返回 3xx | 请求 | 不跟随 redirect，目标 Origin 未收到凭证 | Adapter HTTP integration |
| OMCP-009 | JWT/套餐凭证/host auth port 缺失 | 连接 | 身份-only 场景仅发送 ZCode JWT；host auth port 不可用时 status 为 failed；日志不含 secret | Adapter/Bootstrap unit |
| OMCP-010 | 同 Plugin 两个 MCP、不同 key/origin | 分别连接 | 各自按映射授权，不共享或串用 identity | Bootstrap integration |
| OMCP-011 | desktop-attached remote workspace identity（与 local 同 `workspacePath`、不同 `workspaceIdentity`） | 请求 auth | 响应只回到发起请求的那个 Agent client 与其 request id；同路径 local client 零调用；交错请求不串台 | Services protocol unit |
| OMCP-012 | MCP connection pool 被多个 session 复用 | 并发请求 | 每个 HTTP 请求使用当时解析的 credential snapshot，不把首个 session 的 secret 固化进 config | Adapter pool unit |
| OMCP-013 | official fixture + `zcode_official`，无 `oauth` 字段、无静态 `authorization` | 建立连接 | `authProvider` 为 `undefined`；未创建 OAuth session；未监听任何 localhost 回调端口 | Adapter unit |
| OMCP-014 | 同上，fake server 对所有请求返回 401 | initialize | 分类 `official_auth_rejected` 且 status 为 failed；`onAuthorizationRequired` / `openAuthorizationUrl` 零调用；record status 无 `authorization` 字段；未打开浏览器 | Adapter HTTP integration |
| OMCP-015 | 同上，fake server 返回 403 | initialize | 分类 `official_auth_forbidden`；请求次数恰为 1（不重试） | Adapter HTTP integration |
| OMCP-016 | 首次 401，重解析后第二次 200 | initialize | 恰重试 1 次并最终成功；第二次请求携带重解析的凭证 | Adapter HTTP integration |
| OMCP-017 | 持续 401 | initialize | 恰重试 1 次后置 failed；请求次数恰为 2，不再继续 | Adapter HTTP integration |
| OMCP-018 | `zcode_official` 与 `oauth` 同时配置 | 解析 Plugin | `plugin_mcp_server_disabled` 并禁用，不做优先级裁决 | Plugin unit |
| OMCP-019 | 普通 HTTP MCP（无 `auth`、无 `oauth`、无静态 `authorization`） | 建立连接 | 仍得到既有 authorization_code 兜底行为，回归不受官方短路影响 | Adapter unit |
| OMCP-020 | 静态 `headers` 覆盖 `bigmodel-target-type` 或 `mcp-session-id` | 解析 | MCP 被禁用并产生明确 diagnostic | Plugin unit |
| OMCP-021 | 个人 / BigModel Team / ZAI Team 三种 credential kind | 发 MCP 请求 | wire scope 分别为 `PERSONAL` / `TEAM` / `null`；仅 `TEAM` 时 organization/project 成对出现 | Services unit |
| OMCP-022 | 身份头注入前 header 已存在 `Authorization` | 发 MCP 请求 | 最终请求恰有一个 `Authorization`，值为当前 JWT（覆盖而非 append） | Adapter unit |
| OMCP-023 | 已登录，但选中连接为 Start Plan | 建立连接 | 仅发送 ZCode JWT，不发送 MaaS JWT；记录服务端返回的登录/套餐错误分类 | Services + Adapter unit |
| OMCP-024 | `ZCODE_OFFPEAK_MOCK=1` | 发 MCP 请求 | 官方 MCP 不受该变量影响（新实现无此分支），不发送任何占位凭证 | Services unit |
| OMCP-025 | 官方 MCP 全量用例执行前后 | 运行 Off-Peak 既有测试套件 | Off-Peak 行为零变化，测试全绿（验证 §6.1.1 的隔离） | Services regression |
| OMCP-026 | 并发发起 N 个 MCP 请求 | 并发 | 底层凭证解析恰执行 1 次（in-flight 去重生效）；N 个请求拿到同一份 header | Services unit |
| OMCP-027 | 一次解析 settle 后再发请求 | 顺序两次 | 第二次重新完整解析（无时间维度缓存）；切换 Coding Plan connection 后第二次拿到新 header | Services unit |

本阶段没有 UI 行为，不新增 WebdriverIO/UI E2E，也不修改 conversation session case catalog 或 coverage
matrix。核心证据应放在 contracts schema、Plugin parser、MCP adapter、Bootstrap 和 services protocol 的
unit/integration tests。

## 9. Impact Brief

### 9.1 must-inspect

| 关系 | 改动面 | 原因 |
| --- | --- | --- |
| 配置合同 | `contracts/interfaces/mcp.port.ts`、Plugin MCP parser | `auth` 必须从文件配置进入 runtime，且只允许 HTTP |
| 请求出口 | `adapters/src/mcp/index.ts`、`network.ts` | 所有 Streamable HTTP MCP 请求必须在唯一出口动态注入并校验 redirect |
| OAuth 隔离 | `adapters/src/mcp/index.ts` 的 `resolveAuthorizationCodeOAuthConfig`、`createAuthorizationCodeOAuthOptions`、`adapters/src/mcp/oauth.ts` | `zcode_official` 必须短路隐式 authorization_code 兜底并自行处理 401/403；同时不得影响普通 MCP 的既有兜底行为 |
| 官方身份 | `bootstrap/official-plugin-definitions.ts`、Plugin discovery | Origin 映射和 bundled official provenance 是授权前提 |
| 身份权威 | 新增 official MCP credential resolver（如 `services/official-mcp/`）、services 装配 | JWT、Plan key、Team context 必须来自同一当前 snapshot；独立于 Off-Peak 实现（§6.1.1） |
| Off-Peak 隔离 | `services/session/offPeakRuntimeModel.ts` 及其调用方 | 本阶段**只读参考**，不得修改导出、签名或行为；Off-Peak 既有测试必须全绿 |
| 跨进程协议 | shared zcode protocol、bootstrap protocol server、zcodeAgentService | Agent 不持有身份权威，且实现不能依赖 UI 响应 |
| pool 隔离 | MCP connection pool | 共享连接不能把首个 session/workspace 的凭证固化或串给后续请求 |

### 9.2 should-inspect

- `mcp/list` control-plane 与 session runtime 共用 adapter；官方鉴权缺失时均应返回一致 failed 状态，
  不能设置页探测匿名、session runtime 却带鉴权；
- Plugin cache/official root 可被本地文件修改，因此只有 Bootstrap 硬编码 Origin mapping 能作为 endpoint
  信任事实；
- HTTP proxy、自定义 CA、No Proxy 继续由 `createMcpTransportFetch` 生效，官方 auth wrapper 只能包裹
  它，不能绕过现有网络策略。

### 9.3 invariant-only

- 不修改 `packages/ui`；
- 不修改 Off-Peak 任何现有代码路径（`offPeakRuntimeModel.ts` 等）；官方 MCP 为独立实现（§6.1.1）；
- 不改变普通 HTTP/SSE MCP 的 headers/OAuth 行为；
- 不改变 stdio MCP、`node_repl`、MCP 版本协商和 tool `_meta`；
- 不把鉴权状态下沉到 relay、desktop main、conversation snapshot 或 session persistence；
- 不新增 `serverId` / `capabilityId`，也不按 URL path、tool name 或模型输出推断官方身份。

### 9.4 建议的 feature graph delta

后续进入实现时，可新增 `capability.zcode-official-server-mcp-auth`，关联：

```text
official Plugin definition
  -> plugin MCP parser
  -> trusted Origin registry
  -> MCP HTTP transport
  -> host Coding Plan credential resolver
  -> private Agent protocol bridge
```

本次只写 spec，不直接修改 feature graph。

## 10. 实现顺序

必须遵循 tests first：

1. 先补 contracts/parser 的失败与成功测试；
2. 再补 trusted Origin、保留 header、redirect 的 adapter 测试；
3. 再补 OAuth 短路与 401/403/3xx 分类的 adapter 测试（OMCP-013 ~ OMCP-019、OMCP-022）；
4. 再补 host Coding Plan header resolver 和 Agent protocol 测试（含 `Bigmodel-Target-Type` 与
   mock 隔离，OMCP-021 / OMCP-024 / OMCP-025）；
5. 再加入 fake Plugin + fake HTTP MCP integration test；
6. 最后实现 contracts、parser、Bootstrap registry、protocol bridge、service resolver 和动态 fetch；
7. 运行定向测试后执行 `pnpm typecheck` 与 `pnpm lint`。

## 11. 验收标准

- 官方 Plugin 的 HTTP MCP 能通过 `.mcp.json` 的 per-MCP `auth` 声明启用
  `zcode_official/jwt_token`；
- 正确官方 identity 但错误 Origin、正确 Origin 但第三方 Plugin、复制 auth 字段、跨 Origin redirect
  四种情况都不会发出任何敏感 header；
- MCP `initialize`、`tools/list`、`tools/call` 均携带当前 ZCode JWT（`Authorization`）；仅在
  Registry 存在有效 Coding Plan Provider 且当前 family 的 MaaS JWT 可用时携带
  `X-Bigmodel-Authorization`，并仅在存在对应 `wireScope` 时携带 `Bigmodel-Target-Type`。
  `TEAM` wire scope 时 organization/project 必须成对出现；
- `zcode_official` MCP 不创建 OAuth session、不占用 localhost 回调端口，`authProvider` 为
  `undefined`；后端 401/403 时按 §6.3.3 分类为 failed，`onAuthorizationRequired` /
  `openAuthorizationUrl` 零调用，record status 不含 `authorization` 字段；
- 401 最多重试一次，持续 401 时请求次数恰为 2 且不再继续；
- Start Plan、API Key 模式及 Registry 缺少有效 Coding Plan Provider 的官方 MCP 归类为
  `official_auth_plan_required`，`initialize` / `tools/list` / `tools/call` 的连接与发现请求仅
  发送 ZCode JWT（不发送 MaaS JWT 或 target/scope 头），与 `official_auth_unavailable` 可区分；
- 切换登录身份或 Coding Plan connection 后，后续请求不复用旧 header；
- fake Plugin 只存在于测试 fixture，不进入正式 bundled assets；
- 普通 MCP、OAuth MCP、stdio MCP 和现有 proxy/CA 行为回归通过，隐式 authorization_code 兜底对
  非 `zcode_official` 的 MCP 保持不变；
- 无任何 `packages/ui` 改动；
- `pnpm typecheck`、`pnpm lint` 通过。

## 12. 对后端的接口约定

后端实现不在本阶段范围内（后续单独开发）。本节固定客户端**已确定会发出什么**、**如何解读响应**，
使后端可以据此实现而无需回头改客户端。客户端侧按本节实现即可推进，不阻塞。

### 12.1 客户端发出的请求（已确定）

对每个可信官方 MCP 的每个 HTTP 请求：

| Header | 取值 | 条件 |
| --- | --- | --- |
| `Authorization` | `Bearer <zcode-jwt>` | 始终 |
| `X-Bigmodel-Authorization` | `Bearer <当前 family 的 MaaS 登录 JWT>` | 仅在 Registry 存在有效 Coding Plan Provider 且 MaaS JWT 可用时发送（2026-08 起替代 `X-Coding-Plan-Api-Key`） |
| `Bigmodel-Target-Type` | `PERSONAL` \| `TEAM` | 仅在存在对应 wire scope 时发送；无 scope 时省略 |
| `Bigmodel-Organization` | organizationId | 仅 `TEAM`，与 project 成对 |
| `Bigmodel-Project` | projectId | 仅 `TEAM`，与 organization 成对 |

同时携带现有统一来源头（`User-Agent`、`X-Platform` 等），语义与其它 ZCode 业务接口一致，无新增
字段。**链路 id 例外**：`X-Request-Id` / `X-Trace-Id` 不发送，只从响应头读回，理由与口径见 §5.2
末条。传输为 Streamable HTTP MCP 协议，body 由 MCP SDK 生成。

凭证通道已于 2026-08 切换：满足上表条件时客户端只发 `X-Bigmodel-Authorization`（MaaS 登录
JWT），**不再发送** `X-Coding-Plan-Api-Key`；identity-only 请求则只发 `Authorization`。原因与
"为什么不能两个头都发"见 §6.1。
第一阶段那条"待后端确认是否必须使用 MaaS JWT 通道"的开放项由此闭环。

### 12.2 客户端对响应的解读（已确定）

后端只需保证语义落在下表内即可；客户端不依赖具体业务码文案：

| 响应 | 客户端行为 |
| --- | --- |
| 2xx | 正常处理 MCP 协议响应 |
| 401 | 凭证无效/过期。按 §6.3.3 最多重解析重试一次，随后 failed。**不会**触发 OAuth 授权流程 |
| 403 | 身份有效但无权限/套餐不足。不重试，直接 failed |
| 3xx | 不跟随（`redirect: "manual"`），直接 failed。正式 endpoint 需配置为 canonical URL，避免依赖
  尾斜杠或大小写归一化的重定向 |
| 405（GET 流） | 视为"不支持服务端推流"，属正常情况，不报错 |

因此后端**不应**依赖 `WWW-Authenticate` 触发客户端 OAuth discovery——官方 MCP 路径已显式关闭该
能力（§6.3.1）。鉴权失败请用 401/403 表达。

客户端侧的请求约束，供后端了解流量特征：官方 MCP 为 Coding Plan 专属权益（§3.2）。Start Plan
用户与无 Coding Plan 连接的用户在连接/发现阶段仍可能到达后端，但只携带非空 ZCode JWT，不携带
`X-Bigmodel-Authorization`；选中项仍指向 Coding Plan、但无权益 Provider 已从 Registry 移除时也遵循
同一规则。后端应据此区分已登录与未登录，并执行自身的套餐校验。客户端判定依据是"选中的连接
形态 + 当前 Registry 是否仍有可用 Provider"，而不是 MaaS JWT 或业务 key 是否存在；只有 Registry
中存在有效 Coding Plan Provider 时，MaaS JWT 缺失才表示登录态不完整（2026-08 起业务 key 不再是
凭证，也不再作门槛）。

### 12.3 需要后端/发布侧提供的值

已确认（`zcode-server`，2026-08 实测）：

1. **端点与路由**：`POST /api/v1/mcp/server/:mcp_group`（`internal/interfaces/web/router.go`）。
   两条硬约束：`:mcp_group` **必填**（只写 `/api/v1/mcp/server/` 返回 404），且 **不能带尾斜杠**
   （`…/image_search/` 返回 307，客户端 `redirect: "manual"` 会判为
   `official_auth_redirect_blocked`，报错原因与真实成因不相关）；
2. **鉴权中间件**：**复用** `requireAuth` + `WithCodingPlan`，与 off-peak 一致，§6.1 的 5 个头
   契约成立；
3. **group 清单**：目前仅 `image_search`（`internal/domain/servermcp/service.go` 的
   `MCPGroupTools`），暴露工具 `search_image`。每个 group 是独立端点，客户端侧对应独立 MCP 条目；
4. **无 session**：handler 用 `StreamableHTTPOptions{Stateless: true}`，**不下发**
   `Mcp-Session-Id`。因此真实端点下 session id 为空属预期；只有 fake server 会下发。

仍待后端确认：

1. ~~§12.1 末尾的 `X-Bigmodel-Authorization` 取舍~~ —— **已闭环（2026-08）**：后端确认 API Key
   通道仅存量兼容，官方 MCP 在套餐凭证可用时改为只发 `X-Bigmodel-Authorization` + MaaS 登录 JWT
   （§6.1）；identity-only 请求只发 `Authorization`；
2. 新 group 上线时的通知机制——每个 group 一个端点，意味着新增 group 仍需改 `.mcp.json`，
   与"新增官方 MCP 零改动"的目标存在张力（见下段部署约束）。

canonical HTTPS Origin **不再是待锁定项**：官方 MCP 必须与 ZCode API 同 origin，客户端运行时
解析（§5.1）。若后端要把官方 MCP 部署到独立域名，则需要回到显式清单并承担发版摩擦——
这是一条需要提前对齐的部署约束。

以上未确定时，客户端可完成 fake fixture 与全部依赖注入测试（本地自测经 loopback dev 开关）。

## 13. 实现落位

客户端侧已按本 spec 实现。文件与职责对应关系：

| 职责 | 文件 |
| --- | --- |
| 头集合 / 保留头黑名单（两侧同源，§5.2） | `packages/shared/src/official-mcp-auth.ts` |
| Agent 协议 schema（§7.2） | `packages/shared/src/zcode-protocol/index.ts` |
| 凭证解析 + 身份头构造 + in-flight 去重（§6.1 / §6.2.1） | `packages/services/src/official-mcp/officialMcpCredentials.ts` |
| host 侧反向请求处理（§7.2） | `packages/services/src/zcode-agent/zcodeAgentService.ts` |
| 装配（host 为唯一身份权威） | `packages/services/src/node.ts` |
| 配置合同与端口类型（§4.2 / §7.1） | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts` |
| Plugin 严格解析 + provenance（§4.2） | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` |
| 动态注入 + Origin 校验 + 失败分类（§6.3.2 / §6.3.3） | `apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts` |
| OAuth 短路（§6.3.1） | `apps/zcode-cli/packages/adapters/src/mcp/index.ts` 的 `resolveAuthorizationCodeOAuthConfig` / `createOfficialAuthFetch` |
| 可信 Origin registry（§5.1） | `packages/shared/src/official-mcp-auth.ts` |
| Agent 侧 auth port（§7.1） | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts` |
| 运行时装配 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` |

用例落位：`plugin-official-mcp-auth.test.ts`（解析）、`packages/shared/test/officialMcpTrust.test.ts`（信任）、
`mcp-official-auth.test.ts`（注入与分类）、`mcp-official-auth-integration.test.ts`（fake 端到端）、
`officialMcpCredentials.test.ts`（凭证）、`officialMcpAuthProtocol.test.ts`（协议 schema）、
`officialMcpAuthRemoteRouting.test.ts`（desktop-attached remote 路由）、
`official-mcp-auth-port.test.ts`（端口→协议参数构造，含同路径不同 identity 的可区分性）。
共 87 个用例，OMCP-001 ~ OMCP-027 均有对应断言（OMCP-025 为 Off-Peak 回归动作，命令记录在
`officialMcpCredentials.test.ts` 头注释）。

### 13.1 实现期澄清的三处事实

1. **§6.3.4 的 GET 探测已实测固化**：SDK 在 `notifications/initialized` 收到 202 后会发起
   **恰好一次** GET，服务端 405 后安全放弃且连接保持 connected。该数字由
   `mcp-official-auth-integration.test.ts` 断言锁定，避免后续误以为"客户端完全不发 GET"。
2. **保留头黑名单只在官方鉴权路径生效**：普通/第三方 HTTP MCP 静态携带 `authorization`
   是既有合法用法（`resolveAuthorizationCodeOAuthConfig` 正依赖它退出 OAuth 兜底），
   全局拦截会造成回归。OMCP-019 锁定该边界。
3. **失败分类不能从 error 对象读**：SDK 的 version negotiation 会把 `OfficialMcpAuthError`
   重新包装成普通 `Error`（message 前缀 `Version negotiation probe failed: `，对象身份丢失），
   因此 `instanceof` 在 `failConnection` 处不可靠；按错误文本反解又违反"不依赖错误文本做流程判断"。
   最终在**抛出点**经 `onAuthFailure` 上报分类，adapter 用 per-server 暂存槽在
   `failConnection` 取用后立即清除，并在每次 connect 开始时清空以免串台。
   §6.3.3 的分类由此可在生产日志按 `officialAuthKind` 字段检索。

### 13.2 真机验证记录（2026-08-16）

在本机 desktop（`pnpm dev:desktop`）+ 本地 fake 官方 MCP（`scripts/dev-official-mcp-server.mjs`）
+ 真实登录身份与个人 Coding Plan 下验证通过：agent 日志出现 `mcp.server.connected`
（`plugin:dev-official-mcp:dev-search`），零 `mcp.server.failed`、零 `official MCP` 鉴权失败，
fake server 收到 `initialize` / `tools/list` 并携带完整身份头，GET 推流探测被 405 安全放弃。

自测所需的两项本地设施：

- `scripts/dev-official-mcp-server.mjs`——loopback fake MCP，打印每个请求的鉴权头
  （JWT 与 Coding Plan key 脱敏，`Bigmodel-Target-Type` / organization / project 原样显示）；
- `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`——本地 dev 开关，**只**接受 http loopback
  （`normalizeTrustedOrigin` 的 `"loopback"` 模式会拒绝 https 与非 loopback 主机，
  避免一个环境变量就把真实 JWT 导向远端）。不设置时行为与实现前完全一致。

自测踩坑记录（供后续复现时省时间）：

- 本地 plugin 经 `~/.zcode/cli/config.json` 的 `plugins.dirs` 加载，**不是**
  `~/.zcode/v2/config.json`（后者是 desktop/services 配置），也不是设置页的「添加 marketplace」
  （那个入口要 marketplace 目录）；
- 经 `dirs` 加载的 plugin marketplace 固定为 `inline`，故 pluginId 形如
  `dev-official-mcp@inline`。该后缀**不影响授权**（§5.1 移除了 marketplace 检查），
  本地自测能否通过只取决于 Origin：https 端点需等于当前 ZCode API origin，
  http loopback 需列入 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`；
- MCP 连接在 session 建立时一次性发起，失败后停留在 failed 不自动重连；必须**先起 fake server
  再启动 desktop**。desktop 的 MCP 状态展示存在刷新滞后（重启后才与 agent 实际状态一致），
  属既有行为，不在本阶段范围（§9.3 不改 `packages/ui`）。

### 13.2.1 设置页状态刷新时机（既有行为，非本次引入）

自测时发现"agent 已 connected、设置页仍显示旧状态，重启才正常"。查明是既有刷新机制与官方 MCP
特性叠加的结果，**不在本阶段修**（§9.3 invariant-only：不改 `packages/ui`），此处记录供后续立项。

`McpSettingsSection.tsx` 只有三个刷新触发源：

| 触发源 | 条件 | 对官方 MCP |
| --- | --- | --- |
| key 变化自动刷新 | `autoStatusListRefreshKey` 变化才刷（`transitionMcpAutoStatusListRefreshKey` 的 `previousKey !== nextKey`）。该 key = workspaceIdentity + workspacePath + `serverStatusListKey`，而后者由 **servers/plugins 列表**算出 | ❌ 连接状态变化不改列表，key 不变 |
| 1 秒轮询 | 需存在待授权 OAuth server（`pendingMcpOAuthAuthorizationRefreshKey` 非空），上限 5 分钟 | ❌ 官方鉴权按 §6.3.1 无 `authorizationUrl` |
| 窗口 focus / visibilitychange | 同样被 `pendingMcpOAuthAuthorizationRefreshKey` 门控 | ❌ 同上 |

即：**没有面向"连接状态变化"的订阅，也没有非 OAuth server 的定时刷新**。官方 MCP 三条路全不通。

**实测结论（2026-08-16，纠正早期推断）**：关闭 fake server 后，切换设置 tab、切换 workspace、
**开关 plugin** 三者都不会让状态转为失败。开关 plugin 时设置页链路确实被取用
（出现 `sess=-` 的 `protocol-settings` lease 取/放），但**未产生任何 dev-search 探测事件**，
因此显示的仍是旧快照。日志证据——13:55 之后
所有 MCP 事件都带 `sessionId` 且 `mcpIsolation: session`，没有一条来自设置页的
`protocol-settings` lease：

```text
13:50:27  mcp.server.connected  sess_fb0c0db  session   （服务在）
13:55:36  mcp.server.failed     sess_8517a98  session   （服务已关）
13:55:36  mcp.server.failed     sess_95448b8  session
13:55:37  mcp.server.failed     sess_72bae46  session
13:55:37 ~ 13:59 切 workspace / 切设置 tab → 零条新事件
```

原因是 `serverStatusListKey` 只由 servers/plugins **列表**算出，连接状态变化不改这个 key；
设置页切 tab 时组件保持挂载，`lastAutoStatusListRefreshKeyRef` 不重置，因此
`transitionMcpAutoStatusListRefreshKey` 返回 `shouldRefresh: false`。
**重启 app 是当前唯一可靠重建该 store 的方式。**

需要区分的两条链路：设置页走 entrypoint 的 `protocol-settings` lease，session 走各自的
session lease；两者共用连接池但状态互不回灌。因此"session 侧已知失败"不会反映到设置页。

另外确认：`mcp/list` 默认（connect）模式**会真正重连**（`bootstrap/src/zcode-protocol/mcp.ts`
调用 `connectConfiguredServers`），并非只读缓存。所以问题不是"读到旧缓存"，而是"没人去读"。

Plugin 列表同理：`pluginManagementStore.initialize` 按 workspace 在 `useEffect` 调用，
`refresh()` 只在启用/禁用/安装/卸载等变更后主动触发，无定时器。因此手工编辑
`~/.zcode/cli/config.json` 的 `plugins.dirs` 后，UI 不会自行发现。

对普通 MCP 影响有限（有 OAuth 的走轮询；无 OAuth 的通常连接够快，在首次挂载前后就已完成），
但官方 MCP 的连接是 session 级按需发起、时间上常晚于设置页挂载，因此必然看到旧状态。
后续修法方向：给 `serverStatusListKey` 之外增加连接状态变化订阅，或为非 OAuth server 开低频轮询。
两者都属 UI 层改动，应单独立项。

### 13.2.2 异常路径的本地故障注入

`scripts/dev-official-mcp-server.mjs` 支持注入故障，用于验证 §6.3.3 的分类。两个参数：
`--mode ok|401|403|redirect|tool-quota`、`--fail-on all|initialize|tools/call`。

| 场景 | 命令 | 预期 |
| --- | --- | --- |
| 连接时无额度 | `--mode 403 --fail-on initialize` | `officialAuthKind=official_auth_forbidden`，MCP failed，注入日志**仅一次**（403 不重试） |
| 连上后调用撞 403 | `--mode 403 --fail-on tools/call` | MCP 保持 connected、工具已挂载；仅该次 tool call 失败 |
| tool call 额度耗尽 | `--mode tool-quota` | HTTP 200 + `isError: true` 业务错误；MCP 保持 connected |
| 凭证被拒 | `--mode 401` | `official_auth_rejected`；注入日志**恰好两次**（1 原始 + 1 重试），超过即为自旋缺陷 |
| 重定向劫持 | `--mode redirect` | `official_auth_redirect_blocked`；目标 Origin 收不到任何请求 |

**关键区分**：`--fail-on tools/call` 与 `tool-quota` 都**不会**产生 `officialAuthKind`——前者发生在连接
建立之后的单次调用上，后者根本不是鉴权问题。MCP 业务错误走 in-band `isError` 而非 HTTP 状态码，
因此"额度耗尽"不应让连接断开。这是设计预期，不是漏报。

一个**不需要服务端**的 fail-closed 场景（验证"拒绝时不泄露凭证"，比服务端故障更重要）：

- `official_mcp_origin_untrusted`：不设 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` 启动，同样零请求。

统一判读：`grep '"officialAuthKind"' ~/.zcode/cli/log/zcode-<日期>.jsonl`。
注意连接时故障需重启 desktop 才会重连（§13.2.1 的刷新盲区），tool-call 时故障不需要。

### 13.3 已知未接通项

- ~~正式 `OFFICIAL_PLUGIN_DEFINITIONS` 尚未登记任何 `trustedMcpOrigins`~~：该机制已随 §5.1
  的决策变更删除。registry 不再持有映射表，判定改为"目标 origin 等于运行时解析的 ZCode API
  origin"，因此不存在"待填入 Origin"这一步；未解析出 origin 时仍 fail closed
  （`zcode_origin_unresolved`）；
- desktop-attached remote 的**定向协议测试已补**（`officialMcpAuthRemoteRouting.test.ts`，
  OMCP-011）：覆盖"同 `workspacePath`、不同 `workspaceIdentity`"两条独立链路的响应路由、
  交错请求不串台、plan-required 原样透传、无 resolver 时 `official_auth_unavailable`、
  以及畸形参数走 `respondError` 且不触发凭证解析。
  **剩余风险**：该测试在 service 层以假 Agent client 验证路由与响应通道，未在真实
  SSH/WSL/Docker 环境跑通完整链路。真实远端的进程启动、传输与网络出口仍未验证，
  按 §7.4 的要求在此明确保留，不宣称"真实远端已验证"。

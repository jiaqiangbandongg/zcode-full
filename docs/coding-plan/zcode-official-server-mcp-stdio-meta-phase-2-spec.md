# ZCode 官方 Server MCP：stdio Plugin 经 `_meta` 取身份头（第二阶段，历史 Decision Log）

> 当前实现事实统一见 `zcode-official-server-mcp-auth-spec.md`。本文只保留 stdio 方案的历史背景。

- 状态：已实现；当前事实已合并到统一规格
- 前置：`zcode-official-server-mcp-client-phase-1-spec.md`（下称"phase-1"）。本文只描述增量，
  未提及的一切（信任判定口径、身份头集合、凭证解析、in-flight 去重、日志约束）全部沿用 phase-1
- 驱动需求：`video-agent-kit` 插件的 `transcribe` / `tts_generate` 要改调 `zcode-server` 的
  `speech_transcribe` / `speech_synthesize`（group `video_edit`），去掉用户手配的火山引擎 key

## 1. 目标

让 **stdio** 形态的 Plugin MCP server 也能以当前用户身份调用官方 Server MCP 端点，凭证不落盘、
不进 env、不会因 JWT 轮换而失效。

phase-1 只解决了 `type:"http"`：宿主在 fetch wrapper 里逐请求注入身份头（`official-auth.ts`），
凭证从不进入插件可控的进程。stdio 走不到那条路——它的请求由插件自己的进程发出。

## 2. 为什么不能让 agent 直接用 http 官方 MCP 顶替

一个自然的想法是：不改 stdio，直接在插件里再声明一个 `type:"http"` 的官方 MCP，把
`speech_transcribe` / `speech_synthesize` 作为工具暴露给 agent，让模型自己编排。

这条路对本需求不成立，原因与鉴权无关：这两个工具的音频是 `audio_base64` 进、`audio_base64` 出
（`internal/domain/servermcp/gateway.go`）。一旦它们成为 agent 可见的 tool，参数与结果就必须过
模型上下文——ASR 侧是几十 MiB 的 base64，TTS 侧是几百 KiB。因此**调用必须发生在能直接读写本地
文件的进程里**，也就是插件自己的 stdio server。

同理也排除了"插件工具只收发文件路径、让 agent 转发字节"的变体：字节仍要过上下文。

## 3. 范围

### 3.1 范围内

- `McpStdioServerConfig` 支持 `auth: { type: "zcode_official", provider: "jwt_token" }`；
- 对声明了该 auth 的 stdio server，**每次 `tools/call`** 在 `params._meta` 上附带当前身份头；
- stdio 场景的 targetOrigin 解析口径与失败语义；
- 相应的 Plugin loader 解析、adapter 注入、测试。

### 3.2 范围外

- `sse` 形态（无对应通道，继续拒绝）；
- 把身份头注入 stdio 进程的 **env**：env 在进程生命周期内是死值，而 Plugin MCP server 活整个
  会话，JWT 一轮换就必然 401 且无法自救。这正是本方案要避开的问题，故显式否决；
- 让宿主代发插件的整个 HTTP 请求（凭证完全不出宿主）。它是 phase-1 §5.1 残留风险 3 指出的更彻底
  方向，但需要宿主转发数百 MiB 的分片流量，成本与收益不匹配，留待后续；
- server→client 反向自定义请求（如 `zcode/officialMcpAuthHeaders`）。新鲜度更强（单次 tool call
  内可重取），但 Python SDK 的 `send_request` 是 typed union，发非标准 method 要绕到裸 JSON-RPC 层
  自行对 id，且其它 MCP 宿主一律 Method not found。第二阶段不做，见 §7 的已知缺口；
- 后端改动。`zcode-server` 侧零改动。

## 4. 配置合同

```json
{
  "mcpServers": {
    "video-edit": {
      "type": "stdio",
      "command": "python3",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/video_edit_server.py"],
      "auth": { "type": "zcode_official", "provider": "jwt_token" },
      "timeoutMs": 900000
    }
  }
}
```

- `auth` 的严格解析完全复用 phase-1 §4.2 的 `parseZCodeOfficialAuth`：精确值、区分大小写、
  不接受别名，形状不合法即 `plugin_mcp_server_disabled`；
- **stdio 上没有 `url`**，因此也没有"插件声明的 origin"。这不是缺陷而是收紧：见 §5；
- `oauth` 与 `zcode_official` 并存仍是配置错误（stdio 本来就不支持 oauth，属无效声明，一并拒绝）；
- `official` provenance 仍由宿主生成（`pluginId` / `mcpKey` / `source`），`.mcp.json` 里写了也被覆盖；
- 静态保留头黑名单（phase-1 §5.2）对 stdio 不适用——它没有 `headers` 字段。stdio 的 `env` **不**纳入
  黑名单：插件通过 env 自带第三方凭证是既有合法用法（如降级回退路径），与身份头注入通道无关。

## 5. 信任模型：origin 不再由配置提供

phase-1 的判定是"`URL.origin` === 运行时 ZCode API origin"。stdio 没有 URL，改为：

```text
targetOrigin := resolveRuntimeZCodeEndpointOrigin(env)     # 客户端自行解析，不读任何插件配置
```

口径与 `zcode-protocol-entrypoint.ts` 现有的 4 处调用一致（`ZCODE_BASE_URL` 由宿主
`resolveSpawnEnv` 下发权威值，见 commit `9c9d1683`）。

**为什么这比 http 路径更严**：http 路径下插件能写 url，判定的作用是"把它挡回官方 origin"；
stdio 路径下插件根本没有表达 origin 的渠道，身份头只可能被解析为"当前 ZCode API origin 的凭证"。
`isOfficialMcpOriginTrusted` 的调用照旧保留（同一份 `@zcode/shared` 实现），此时它退化为一条
恒真断言——**仍要调用**，因为它同时校验 https 与不带 username/password，且 dev loopback 开关
（`ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`）必须继续生效。

host 侧二次校验（`zcodeAgentService` 在读取凭据**之前**用同一份 registry 校验三元组）不变：
agent 上报的 `targetOrigin` 就是它自己解析出的那个值，未命中即 `official_mcp_origin_untrusted`，
`resolveHeaders` 零调用。

**新增的残留风险**：phase-1 的三条残留风险全部继续成立，另加一条——**身份头会进入插件的进程内存**。
http 路径下凭证只在 agent 进程的 fetch wrapper 里出现，插件拿不到；stdio 路径下插件读到的是明文
`Authorization`，它可以拿去打别的地址。这与 phase-1 §5.1 残留风险 2/3 属同一类（能在插件里跑代码
的人本来就能读 `~/.zcode` 下的同一份凭证），因此定位仍是**防御纵深**而非防已被攻破的插件。
要彻底解决只能走 §3.2 的"宿主代发"方向。

## 6. 下发通道：复用既有的 `_meta` 注入点

`adapters/src/mcp/index.ts` 的 `callTool` 已经在每次 `tools/call` 上写
`_meta = mcpRequestMeta(trace, runtimeScope)`（trace_id / session_id / runtime_scope）。身份头搭这
同一趟车下发，不新增任何通道、端口、token 或监听面，remote attach 场景也照样走。

### 6.1 载荷形状

只放命名空间键，不放扁平键（与 `com.zcode/request-context` 的扁平+命名空间双写不同——身份头
不需要兼容任何既有消费者，少一处出现就少一处泄漏面）：

```json
{
  "_meta": {
    "com.zcode/official-mcp-auth": {
      "ok": true,
      "headers": {
        "Authorization": "Bearer <jwt>",
        "X-Bigmodel-Authorization": "Bearer <maas-jwt>",
        "Bigmodel-Target-Type": "TEAM",
        "Bigmodel-Organization": "<org-id>",
        "Bigmodel-Project": "<project-id>"
      }
    }
  }
}
```

失败：

```json
{ "_meta": { "com.zcode/official-mcp-auth": { "ok": false, "reason": "official_auth_plan_required" } } }
```

- `headers` 的键集合、Team 成对原子性、`Bigmodel-Target-Type` 的取值，全部由
  `buildOfficialMcpAuthHeaders` 单点产出，与 http 路径同源（phase-1 §6.1）；
- `reason` 为 `OfficialMcpAuthFailureReason` 枚举，不发自由文本（禁止按文本分流）；
- 该键**只**出现在声明了 `zcode_official` 的 stdio server 的请求上。普通 stdio server 的 `_meta`
  里不得出现——否则等于把身份头广播给任意第三方插件。

### 6.2 新鲜度

`resolveHeaders` 在**每次** `tools/call` 派发前调用，因此每次工具调用拿到的都是刚解析的凭证；
phase-1 §6.2.1 的 in-flight 去重与"禁止时间维度缓存"照旧生效。

**已知窗口**：单次 tool call 内部长跑时（如 2 小时视频转写会在一次调用里连续发数十个 HTTP 请求），
中途 JWT 轮换后插件无法重取。约定：插件收到 401 时**不重试**，直接把
`official_auth_rejected` 报回给 agent，由 agent 重试整个工具调用来获得新头。因此插件侧必须把 401
标记为不可重试，避免用旧头空转。

### 6.3 失败语义：与 http 路径**有意不同**

phase-1 §6.3.3 对 http 是全 fail closed。stdio 路径改为**把 `{ok:false, reason}` 照样下发**，
理由是二者的风险面不同：

- http 路径放行 = 一个匿名请求真的打到官方端点，必须 fail closed；
- stdio 路径没拿到头的插件**根本不会去打官方端点**（它会走自己的回退路径或直接报错），不存在
  匿名请求；反过来，把 reason 交给插件才能让它把"未登录"与"无 Coding Plan 套餐"如实呈现给用户，
  而不是静默降级成一句莫名其妙的失败。

因此：

| 情况 | 下发 | agent 侧 |
| --- | --- | --- |
| host auth port 不可用（standalone CLI） | `{ok:false, reason:"official_auth_unavailable"}` | 连接保持正常，仅该键为失败 |
| 未登录 / 无选中 connection | `{ok:false, reason:"official_auth_unavailable"}` | 同上 |
| Start Plan 或无 Coding Plan key | `{ok:false, reason:"official_auth_plan_required"}` | 同上 |
| host 二次校验未命中 | `{ok:false, reason:"official_mcp_origin_untrusted"}` | 同上，凭据零读取 |

注意"连接保持正常"这一条与 http 路径的"连接置 failed"也不同：stdio server 上通常还挂着大量与
官方 MCP 无关的工具（`video-edit` 有 30+ 个），因为拿不到身份头就把整个 server 置 failed 会误伤
它们。身份头的可用性是**每次工具调用**的属性，不是连接的属性。

### 6.4 OAuth 隔离

phase-1 §6.3.1 的短路（`resolveAuthorizationCodeOAuthConfig` 遇 `zcode_official` 返回 undefined）
对 stdio 天然成立（stdio 不走 OAuth 分支），但仍要保证 `isOfficialAuthConfig(config)` 的既有
短路点不因新增 stdio 分支而被绕过。

### 6.5 日志

沿用 phase-1 §5.2 与 `official-auth.ts:summarizeIdentityHeaders`：只记 header **名**、
`Bigmodel-Target-Type`、成对性、失败分类；**绝不**记 header 值、JWT、Coding Plan key，也不得
把 `_meta` 全文写进任何日志（现有 `describeJsonRpc` 只取结构性字段，不取 `params.arguments`，
新增字段不得破坏这条约束）。

## 7. 实现落位

| 职责 | 文件 |
| --- | --- |
| stdio 配置类型 | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`（`McpStdioServerConfig` 加 `auth?` / `official?`） |
| Plugin loader 解析 | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`（`officialAuth && type !== "http"` 改为只拒 `sse`；stdio 分支带上 auth + provenance） |
| 身份头解析与注入 | `apps/zcode-cli/packages/adapters/src/mcp/index.ts`（`callTool` 的 `_meta` 注入点；`mcpRequestMeta` 扩参） |
| 凭证解析 / 身份头构造 | 复用 `packages/services/src/official-mcp/officialMcpCredentials.ts`，零改动 |
| 信任判定 | 复用 `packages/shared/src/official-mcp-auth.ts`，零改动 |
| host 二次校验 | 复用 `packages/services/src/zcode-agent/zcodeAgentService.ts`，零改动 |

不需要改 `SANITIZED_RUNTIME_ENV_KEYS`：身份头不进 env，没有新的子进程泄漏面。

## 8. 验收标准

- 声明 `auth` 的 stdio Plugin MCP 能正常装载，`official` provenance 由宿主生成且不可由 `.mcp.json` 伪造；
- `sse` + `zcode_official` 仍被 `plugin_mcp_server_disabled` 拒绝；
- 对该 server 的每次 `tools/call`，`_meta["com.zcode/official-mcp-auth"].headers` 含 phase-1 §6.1
  规定的头集合；Team 场景 org/project 成对出现；
- `resolveHeaders` 失败时下发 `{ok:false, reason:<枚举>}`，且**不含** `headers` 键；连接不置 failed；
- 普通 stdio server 的 `_meta` 里不出现该键；
- 日志中不出现任何 header 值；
- `pnpm lint`、`pnpm typecheck`、`pnpm test` 通过；`packages/ui` 零改动。

## 9. 已知缺口

1. §6.2 的单次长跑窗口。彻底解决需要 §3.2 的反向自定义请求或宿主代发，本阶段用"401 不重试 +
   agent 层重试"覆盖；
2. 身份头进入插件进程（§5 新增残留风险）。定位为防御纵深，缓解依赖服务端的权益与配额校验；
3. `_meta` 会随该 server 的**所有**工具调用下发，而非只随真正需要它的那几个工具。收紧需要在
   配置里声明工具白名单，当前判断收益不足（同一进程内，粒度收紧不改变泄漏面）。

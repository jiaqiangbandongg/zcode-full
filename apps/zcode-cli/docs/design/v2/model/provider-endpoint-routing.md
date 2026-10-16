# Provider Endpoint Routing

## 状态

- 本文是 ZCode CLI 模型 provider 端点转发的事实规范；动态路由与静态网关共用同一契约和调用链。
- 能力只存在于 `apps/zcode-cli` 的默认 AI SDK provider transport，不修改用户 provider 配置、
  ZCode Protocol、Desktop/Web renderer 网络、WebFetch、MCP、OAuth、插件下载或 tool 子进程。
- 受信 `custom` provider 自己持有 transport，不在透明转发范围内。

## 目标

### 实现装配边界

`ProviderEndpointRoutingPort` 与 `createProviderEndpointRoutingFetch` 是公共边界。
bootstrap 通过 `createProviderEndpointRoutingPort` 创建实现；CLI、TUI、桌面 stdio Agent、
workflow 与 subagent 保留相同的依赖注入，不根据发行版本删除接线。

```text
bootstrap process registry（endpoint origin + network policy）
  -> createProviderEndpointRoutingPort
       -> 动态实现：按需读取远端配置，拥有原有快照和 single-flight
       -> 静态实现：仅匹配内置端点，不发起配置请求或读取来源标识
  -> 同一个 ProviderEndpointRoutingPort
  -> 同一个 fetch wrapper：保留 query/body/auth/signal，清理旧 Host
  -> 原有 proxy / No Proxy / CA transport
```

实现目录为 adapters `model/endpoint-routing-edition/`。公开工厂参数与静态 resolver 放在目录外；
导出只替换该目录，不改公共源码。动态实现的专属测试显式排除，公共 fetch 与静态实现测试两版都保留。
公共工厂不向上暴露 snapshot、刷新预算或实现 class。网络客户端和来源标识以依赖传入，静态实现不调用它们。

静态实现保持既有开源网关行为：

| 精确匹配的 HTTPS 端点 | 当前 runtime ZCode origin 下的目标路径 |
| --- | --- |
| `open.bigmodel.cn/api/anthropic/v1/messages` | `/api/v1/ultra/anthropic/v1/messages` |
| `api.z.ai/api/anthropic/v1/messages` | `/api/v1/ultra-zai/anthropic/v1/messages` |

默认端口、主机大小写、末尾 `/` 与 query 的处理遵循下文匹配规则；其它协议、端口、路径、子域和
第三方 Provider 不改写。origin 复用 `resolveRuntimeZCodeEndpointOrigin`，不增加用户配置或环境变量。
静态实现无路由快照或刷新 timer。进程 registry 的复用与网络隔离仍由 bootstrap 负责。

本次不改变公共请求处理的顺序：SDK/最终 body 转换、官方版本的请求安全校验、路由、网络代理。
请求期 apiKeyId 仍只来自账号 owner，普通请求不因版本装配产生额外等待。
桌面 continuous 与手机 replayable 继续进入原有 CLI，不增加 runtime、队列或协议字段。

### 动态实现

ZCode CLI 在模型请求发生时按需读取：

```text
GET https://zcode.z.ai/api/v1/agent/configs
```

测试与非生产环境必须复用 `buildRuntimeZCodeApiUrl` 的现有 endpoint 选择规则，禁止另加平行环境变量。
响应中 `data.proxyEndpoint.mapping` 决定是否把一个明确的 provider endpoint 改写到 ZCode 代理 endpoint。
服务端返回合法空映射即关闭转发；客户端不修改或持久化 provider `baseURL`。

示例：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "proxyEndpoint": {
      "mapping": [
        {
          "from": "https://open.bigmodel.cn/api/anthropic/v1/messages",
          "to": "https://zcode.z.ai/api/v1/proxy/anthropic/v1/messages"
        },
        {
          "from": "https://api.z.ai/api/anthropic/v1/messages",
          "to": "https://zcode.z.ai/api/v1/proxy/anthropic/v1/messages"
        }
      ]
    }
  }
}
```

## 边界

| 项目         | 约束                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| 生效 runtime | 独立 CLI、TUI、桌面 stdio Agent、主会话、workflow 与 subagent 子 runtime                 |
| 生效请求     | 默认 AI SDK provider 发出的模型 HTTP(S) 请求                                             |
| 不生效请求   | WebFetch、MCP、OAuth、插件、Bash/tool、Desktop/Web renderer、`custom` provider transport |
| 配置 owner   | ZCode CLI 进程内共享 routing registry                                                    |
| 持久化       | 无；进程重启后重新读取                                                                   |
| 协议/配置    | 私有 requestAuth 增加可选 apiKeyId，不新增用户配置或环境变量                             |

桌面 `desktop-continuous` 与手机 `web-remote-replayable` 仍只描述 session/task 消息交付。
本能力只修改 Agent 到模型 provider 的最终 HTTP 目的地，不改变 stream、snapshot、queue、owner、
workspace identity 或恢复语义。

## 状态与时序

```text
AI SDK provider request
          |
          v
ProviderEndpointRoutingPort.resolve
          |
          +-- snapshot fresh (< 5m) -------------------+
          |                                            |
          +-- snapshot stale / absent                  |
                    |                                  |
                    v                                  |
          shared in-flight agent/configs GET           |
                    |                                  |
          +---------+----------+                       |
          |                    |                       |
       valid code=0       timeout/error/invalid         |
          |                    |                       |
    atomically replace     keep last-known-good         |
    mapping snapshot       or cold-start direct         |
          |                retry no sooner than 30s     |
          +---------+----------+-----------------------+
                    |
                    v
       endpoint match -> rewritten/original URL
                    |
                    v
       HTTP proxy / No Proxy / custom CA
                    |
                    v
            provider streaming response
```

- 成功快照从刷新完成时起有效 5 分钟。
- 缓存过期只在新的模型请求到来时刷新，不创建 timer，空闲进程不联网。
- 同一 routing key 的并发刷新必须 single-flight；所有等待者观察同一次原子结果。
- 配置请求最长 3 秒、响应体最长 256 KiB。
- 刷新失败后 30 秒内不再发起配置请求；已有快照可继续使用到下一次成功刷新，冷启动无快照则直连。
- 单个模型请求取消时必须立刻停止等待，但不能取消其他请求共享的配置刷新。

## 配置请求与校验

配置请求必须通过独立的通用 `HttpClientPort` 发起，并复用显式 proxy、No Proxy 与自定义 CA。
它不得经过 provider endpoint routing，避免 `/agent/configs` 自递归。

请求为无参数 GET。除 `Accept` 外，来源标识必须复用与
`buildZCodeSourceHeaders` 相同的共享构造规则，发送：

- `Accept: application/json`
- `HTTP-Referer`，跟随当前 runtime ZCode endpoint origin
- `User-Agent: ZCode/<version>`
- 有有效版本时发送 `X-ZCode-App-Version`
- `X-Title`，独立 CLI/TUI 为 `Z Code@cli`，桌面 stdio Agent 为 `Z Code@electron`
- `X-Platform`、`X-Release-Channel`、`X-Client-Language`、`X-Client-Timezone`、
  `X-Os-Category` 与有效的 `X-Os-Version`
- 已有 `~/.zcode/v2/telemetry-state.json`（或 `ZCODE_DATA_BASE_DIR` 对应目录）中存在
  合法 `deviceMid` 时发送 `X-Device-Mid`；配置请求不得创建新的设备身份
- 账号请求的 `requestAuth.apiKeyId` 非空时，配置 GET 携带 `x-api-key-id`；值必须在 trim 后为可打印 ASCII。

ID 来自鉴权 owner 的同一次 PAT 换证结果，通过专用参数传入，不从模型请求 Header 读取。
不得发送 `x-api-key`、`Authorization`、OAuth/PAT、请求 body 或 provider query；手动 Provider
仅发送客户端来源 Header。快照仍有效时不发起 GET；single-flight 刷新使用启动者的 ID。
空白、控制字符或非 ASCII ID 不进入 Header，但不阻止配置刷新。

共享来源 header 注入点只允许提供上述 ZCode 来源标识；即使被错误注入
`x-api-key-id`、`Authorization`、Cookie 或其它未声明 header，也不得越过配置请求边界。配置 GET
的 `x-api-key-id` 只能来自本次 `resolve` 的专用参数。

```text
runtime/env + OS/locale + existing deviceMid
                    |
                    v
       shared ZCode source headers ------------------+
                                                     |
requestAuth.apiKeyId --explicit ID only-----------------+--> agent/configs GET
                    |
                    +----X----> Authorization / other model headers
                    +----X----> WebFetch / MCP / OAuth / tool
```

配置 endpoint 会在路由决策前收到 provider `x-api-key-id`，属于受信敏感控制面；客户端不得记录、
持久化或放入 routing registry key、快照和错误上下文。

只有以下响应可替换当前快照：

1. HTTP 2xx。
2. JSON envelope 的 `code` 严格等于 `0`。
3. `data` 是对象；`proxyEndpoint` 缺失或 `mapping` 为空表示合法空快照。
4. mapping 最多 256 条，且整份通过校验；坏项、重复 `from` 或超限时整份拒绝。
5. `from` 与 `to` 都是 HTTPS URL，不含 username、password、query 或 fragment。

`data` 中与本功能无关的字段允许存在。`to` 是受信控制面的任意 HTTPS 目标；这意味着命中时原模型
鉴权头与请求内容会发送到该目标，服务端配置发布权限必须按敏感控制面管理。

## 匹配与改写

- mapping key 是规范化的 `scheme + hostname + effective port + pathname`。
- URL parser 负责 scheme/hostname 大小写和默认端口归一化；除根路径外，末尾 `/` 视为等价。
- 匹配忽略模型请求 query；命中后用完整 `to` 替换目标，并把原 query 原样附加到 `to`。
- 不做 hostname-only、前缀或通配匹配，避免一个映射意外接管同域其它 API。
- method、headers、body、AbortSignal 和响应 stream 必须保持不变；最终 `Host` 由 fetch 按目标 URL 生成。
- URL 重写必须早于 HTTP proxy/No Proxy 解析，使出口策略按最终目标判断。
- 后续 Model 创建使用的新 provider/model 配置不能丢失注入的 routing port；已创建 Model 的执行事实保持冻结。

## 日志与隐私

- 新快照与上一快照内容变化时记录一次 `info`，只包含 mapping 数量。
- 刷新失败按 30 秒冷却窗口记录 `warn`，只包含错误类别和配置 endpoint host。
- 单次命中只允许记录 `debug`，只包含源/目标 host 和规范化 path。
- 禁止记录配置响应原文、query、headers、API Key、OAuth token、模型 body 或模型输出。

## Impact Brief

| Field            | Value                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Developer intent | 通过同一个 port 装配动态路由或静态网关，保持公共模型请求链一致                                           |
| Capability       | provider endpoint routing                                                                               |
| Change layer     | commit-effect / persistence / recovery                                                                  |
| Operating mode   | implementation-handoff                                                                                  |
| Primary seeds    | `createProviderEndpointRoutingPort`, `createProviderEndpointRoutingFetch`, `AiSdkModelExecution.bindModel` |
| Out of scope     | UI、provider 配置持久化、非 provider 网络出口                                                           |

本能力没有 UI surface、草稿状态或用户提交动作。权威 owner 是进程内 routing registry；
Model execution、workflow child 与 script workflow child 只持有同一个 port 引用。必须检查的下游是
provider fetch 组合顺序和所有默认 model adapter 创建路径；WebFetch/MCP/tool 与桌面/手机交付语义仅作为
隔离不变量。仓库当前没有 codegraph 索引，调用方证据来自上述 live source seed 与测试。

`x-api-key-id` 没有 UI、草稿或持久化 owner；其唯一权威来源是账号鉴权 owner 返回的 requestAuth.apiKeyId，唯一 sink 是独立配置 `HttpClientPort` 的当次 GET。功能图已增加
`supplies-x-api-key-id-on-stale-refresh` 隔离边；仅动态实现消费该值。本次未执行 codegraph 影响面扫描，
以源码调用链与两版测试验证边界，不引入 conversation/E2E 状态组合。

## 已确认用例

新增实现替换验收：

| Case | Setup / Action | Assertions |
| --- | --- | --- |
| PER-019 | 两个官方端点、默认端口、末尾斜线、query | 静态目标路径正确，query 不变，远端配置调用数为零 |
| PER-020 | 不同 scheme/host/port/path 和第三方 URL | 静态实现原样返回，不扩大匹配范围 |
| PER-021 | 静态 port 经公共 wrapper 发送 Request/URL/string | method/body/auth/signal/response 不变，旧 Host 删除 |
| PER-022 | 同 endpoint/network 重复创建，或改变 network | 工厂共享或隔离符合现有进程 registry 契约 |
| PER-023 | 替换 edition 后构建并实际发送模型请求 | 默认装配走静态网关，动态源码缺席，公共调用链与测试保留 |

PER-019—023 与以下动态用例先于实现更新。动态测试继续覆盖缓存、失败、取消和 ID 隔离；
本次没有 UI 交互变更，以真实 HTTP/模型执行集成与导出树运行验证入口，不新增 conversation 产品状态。

| Case    | Setup                                                          | Action                | Assertions                                              |
| ------- | -------------------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| PER-001 | 冷启动、合法 mapping                                           | 首次模型请求          | 一次配置 GET，命中后改写 URL                            |
| PER-002 | 5 分钟内已有快照                                               | 多次模型请求          | 不重复 GET，按同一快照路由                              |
| PER-003 | 快照过期、并发请求                                             | 并发模型请求          | 只发一次 GET，原子应用新快照                            |
| PER-004 | 已有快照、刷新失败                                             | 模型请求              | 继续使用旧值，30 秒内不重试                             |
| PER-005 | 冷启动、刷新失败                                               | 模型请求              | 保持原 URL 直连                                         |
| PER-006 | 合法空 mapping                                                 | 刷新后模型请求        | 清空旧转发并直连                                        |
| PER-007 | 部分 mapping 非法/重复                                         | 刷新后模型请求        | 整份拒绝，旧快照不变                                    |
| PER-008 | 请求携带 query/stream/body                                     | 命中 mapping          | query 与请求/响应语义保持                               |
| PER-009 | WebFetch/MCP/tool/renderer                                     | 发起非 provider 请求  | 不读取或应用 routing snapshot                           |
| PER-010 | CLI 或桌面 stdio Agent 发起配置 GET                            | 刷新 routing snapshot | 携带对应来源、平台、语言时区及可选已有 deviceMid        |
| PER-011 | 触发刷新的账号鉴权材料含真实 apiKeyId                          | 刷新 routing snapshot | 配置 GET 携带同值 `x-api-key-id`，日志与快照不包含 ID   |
| PER-012 | 请求期材料无 apiKeyId，即使模型头存在 Key / Authorization      | 刷新 routing snapshot | 配置 GET 不合成或发送 `x-api-key-id`                    |
| PER-013 | 手工 `x-api-key` 位于 Request 或 RequestInit                   | 冷启动刷新            | 不向配置接口透传，模型鉴权仍保留                        |
| PER-014 | ID 为空白、含控制字符或非 ASCII                                | 冷启动刷新            | 配置 GET 仍执行，但不携带 `x-api-key-id`                |
| PER-015 | fresh snapshot 存在，后续请求使用不同 ID                       | 模型请求              | 不刷新配置，也不发送或缓存后续 ID                       |
| PER-016 | 携带 ID A 的刷新失败，冷却结束后请求携带 ID B                  | 再次刷新              | 第二次 GET 只携带 ID B，ID A 不进入快照                 |
| PER-017 | 来源 header builder 被错误注入敏感或未声明 header              | 冷启动刷新            | 只发送来源 allowlist；`x-api-key-id` 仍只能来自触发请求 |
| PER-018 | 携带 ID 的首个 waiter 取消，另一个 waiter 仍等待 single-flight | 刷新进行中取消        | 取消不终止共享 GET；配置 GET 使用启动刷新时的 ID        |

### 测试维度与剪枝

| 维度       | 等价类                                                  | 代表用例                           |
| ---------- | ------------------------------------------------------- | ---------------------------------- |
| 快照状态   | absent / fresh / stale / failure cooldown               | PER-011、PER-015、PER-003、PER-016 |
| ID 来源    | 有效 requestAuth.apiKeyId / 手工 Key / 来源 header 注入 | PER-011、PER-012、PER-017          |
| ID 形态    | 显式参数 / 空白 / 控制字符或非 ASCII                    | PER-013、PER-014                   |
| 并发与取消 | 单请求 / single-flight 多 waiter / 单 waiter 取消       | PER-011、PER-003、PER-018          |
| fetch 输入 | URL/string / Request / Request + RequestInit override   | PER-012、PER-011、PER-013          |

个人、团队账号和手工 Provider 使用实际 HTTP 回归：账号配置 GET 携带真实 ID，模型请求只携带 PAT；手工配置 GET 不携带凭据，模型请求仍用手工 Key。缓存过期后切换 ID，不能复用前一请求的 ID。Desktop/TUI/workflow 共享同一 adapter 与进程级 port，并由 bootstrap 协议测试覆盖 ID 透传。

本功能不改变 conversation 产品状态，不进入 conversation case catalog、coverage matrix 或 formal-proof。

账号 ID 从请求期鉴权材料 `requestAuth.apiKeyId` 显式传入 routing port；禁止从模型 Header、PAT 或手工 Provider Key 推导。手工 Provider 不再传递凭据到配置接口。

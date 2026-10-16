# Host 外部业务 API 代理设计

## 状态

- 阶段：已实现；2026-08-28 增补远程资源下载的显式 port 消费方。
- 关联反馈：`ZCT-2092222819015462912`。
- 改动层级：`commit-effect`、`validation`。
- 本文描述的 `NodeApiClient` Host 代理已经实现；后续远程资源下载扩展继续复用同一 request-scoped transport。

## 问题摘要

设置页已经把 `httpProxy`、`httpProxyNoProxy` 和 `httpProxyCaCertPath` 应用到 Electron
Session，并在启动 Agent 时注入对应网络配置，但 Window Host 自己的外部业务 API 请求没有消费这三项设置。
OAuth 浏览器授权和 deep-link 回调可以成功，Host 随后的 token exchange 仍会直连公网；在强制代理网络中，
请求因此超时。

```text
Browser                  Electron Main              Window Host
   | OAuth authorize          |                         |
   |------------------------->|                         |
   | callback / deep-link     |                         |
   |------------------------->| route callback          |
   |                          |------------------------>|
   |                          |                         | NodeApiClient
   |                          |                         | -> global fetch
   |                          |                         | -> direct egress
   |                          |                         X corporate firewall
```

## 事实、推断与未知

### 已确认事实

- `AppSettings` 是桌面端显式代理、No Proxy 和自定义 CA 的持久化权威；设置页提示重启后生效。
- `packages/services/src/providers/api/nodeApiClient.ts` 默认调用 `globalThis.fetch`，没有 Host 网络策略。
- `packages/services/src/node.ts` 创建本地服务集合共享的 `NodeApiClient`，OAuth、模型供应商配置、
  Coding Plan、usage、client scenes、feedback、Repo Snapshot 元数据等服务复用它。
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` 为 desktop-attached remote 的本机全局服务
  创建第二个 `NodeApiClient`；OAuth、凭据和套餐事实仍由桌面 Host 持有。
- Main 到 Host 的环境构造会清理 shell 的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 和 CA
  变量；这属于既有隔离设计，不能通过重新继承环境变量绕过。
- Host 仍有 Bot、telemetry、对象存储上传、off-peak 等直接 `fetch` 出口，它们不属于 `NodeApiClient`
  的当前统一业务 API 边界。

### 受证据支持的推断

- 对 `NodeApiClient` 注入显式 proxy-aware fetch 足以修复工单里的 OAuth、Coding Plan 和
  `client-scenes` 失败，而不需要修改各业务服务。
- 进程全局 dispatcher 会同时改变 Host 中不属于本工单的第三方、内网、本地和对象上传流量，回归面明显更大。

### 已分类的后续出口

- Desktop-attached SSH/WSL/Docker 的远程资源 manifest、组件归档和进度 `HEAD` 已完成出口分类：
  它们属于 app-managed 下载，复用本设计的 Host 生命周期 transport，但通过显式
  `RemoteAssetNetworkPort` 注入，不设置全局 dispatcher。
- Bot、telemetry、Repo Snapshot 对象上传和其它裸 `fetch` 是否都应跟随 App 代理，仍需单独做出口分类；
  不以全局 dispatcher 提前替产品作答。
- 系统代理不是 Host app-managed API 的隐式来源。设置为空时保持直连；如未来要增加 system fallback，
  必须单独定义与 Electron embedded browser 不同的信任边界。

## 架构合同

### 边界图

```text
setting.json
  httpProxy / httpProxyNoProxy / httpProxyCaCertPath
                 |
                 | Host 首次构造网络出口时异步读取并冻结
                 v
       HostApiNetworkPolicySnapshot
                 |
                 v
        request-scoped fetch transport
          | final URL -> No Proxy?
          |             | yes -> direct dispatcher + optional CA
          |             ` no  -> proxy dispatcher + optional CA
          v
             NodeApiClient
          /       |        \
       OAuth   Coding Plan  client-scenes / provider / usage / feedback

通过显式 port 复用该 transport：
  desktop-attached remote manifest / component archive / progress HEAD

不进入该边界：
  Electron Session | Agent/CLI | Bash/stdio MCP | Bot direct fetch
  telemetry direct fetch | object-upload fetch | RPC/WS/SSH | relay
```

### 决策 D1：设置权威不变

**选择**：Host 只读取 `AppSettings.httpProxy`、`httpProxyNoProxy`、`httpProxyCaCertPath`；空值表示直连或默认
TLS 信任。继续清理用户 shell 的标准代理和 CA 变量。

**原因**：与现有 app/provider 网络隔离规则一致，避免从启动 shell 获得不可见、不可诊断的行为。

**未选择**：取消 `sanitizeZCodeRuntimeEnv` 对标准网络变量的清理；使用 `NODE_USE_ENV_PROXY`。

### 决策 D2：使用请求级 dispatcher，不设置进程全局 dispatcher

**选择**：在 `packages/services` 的 Node HTTP provider 边界创建 proxy-aware fetch，并通过
`NodeApiClientOptions.fetchImpl` 注入。代理模式使用 `undici` 的显式 dispatcher；直连模式保留直连 dispatcher。

**原因**：只改变已经声明为外部业务 API 统一出口的请求，保留依赖注入和测试替换能力。

**未选择**：Host 启动时调用 `setGlobalDispatcher`。它会接管 remote server 探测、Bot、telemetry、上传和
localhost 请求，要求额外产品决策和回归矩阵。

### 决策 D3：按 Window Host 生命周期冻结配置

**选择**：每个 Window Host 第一次需要网络策略时，通过单飞 Promise 异步读取设置、CA 文件并构造不可变快照；
同一 Host 生命周期内复用该快照。设置修改后由下一次应用/Host 重启生效。

策略 transport 是 Host collection 的非 RPC 托管资源：本地 collection 和 desktop-attached remote collection
各自登记生命周期 disposer；同步退出触发 best-effort destroy，等待式退出 await dispatcher close。不得把 transport
注册成 renderer 可调用的业务 service，也不得仅依赖进程退出回收连接池。

**原因**：保持设置页现有“重启后生效”合同，避免每个请求读取磁盘，也避免请求进行中切换连接池。

**失败边界**：读取设置失败时当前请求 fail closed，且不得缓存 rejected promise；后续请求可重新读取设置并
重试。显式配置存在但代理或 CA 无效时必须 fail closed 到该请求，不得静默回退直连。

### 决策 D4：先重写 endpoint，再选择出口

**选择**：`NodeApiClient` 先按现有规则把默认 ZCode endpoint 重写为当前有效 endpoint，再对最终 URL 执行
No Proxy 和 dispatcher 选择。

**原因**：No Proxy 必须匹配真实目标，不能匹配重写前的生产域名。

### 决策 D5：No Proxy 和自定义 CA 与现有显式语义一致

**选择**：No Proxy 支持 `*`、精确 host、host:port、`.example.com` 和 `*.example.com`；命中后只绕过代理，
不绕过自定义 CA。自定义 CA 同时用于直连 TLS、HTTPS proxy 和 HTTP CONNECT 后的目标 TLS。

**失败边界**：CA 文件不存在、不可读或无法解析时，受策略管理的请求返回结构化网络错误；不得关闭 TLS 校验。

### 决策 D6：本地与远程 workspace 的 owner 边界保持不变

**选择**：

- desktop local：本地 `createLocalServices` 的 `NodeApiClient` 使用 Host 策略。
- desktop-attached SSH/WSL/Docker：远端 Agent/文件 IO 不变；桌面 Host 内 app-global OAuth、provider、usage、
  Coding Plan 和 client scenes 使用同一类 Host 策略。
- server remote：继续使用 server 权威服务，不由桌面 Host 覆盖其网络出口。
- 手机 `/remote`：只复用已有 shared-host attachment；不新增 Agent、Host、relay 状态或网络配置协议。

### 决策 D7：诊断日志低频且脱敏

**选择**：策略快照构造成功或失败最多记录一次生命周期日志；请求级出口选择仅允许 `debug`，字段只包含
`mode`、脱敏后的目标 host、代理 host、No Proxy 命中和 custom CA enabled，不记录代理凭据、完整 URL、
OAuth code、token 或 header value。

## Impact Brief

### Feature Summary

| Field            | Value                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| Developer intent | 让 Host 外部业务 API 遵循设置页显式代理策略                                      |
| Capability       | Host app-managed API network policy                                              |
| Change layer     | commit-effect、validation                                                        |
| Operating mode   | planning                                                                         |
| Primary seeds    | `NodeApiClient`、`createLocalServices`、`createRemoteWorkspaceServiceCollection` |
| Out of scope     | 全局 dispatcher、裸 `fetch` 治理、UI、协议、session/replayable 状态              |

### UI Surface Matrix

| User scenario | UI entry                                              | Shared implementation            | Display/draft owner      | Default/inherit source | Validation/gating              | Commit action           | Authority/persistence | Mode boundary                                    | Must remain isolated from            |
| ------------- | ----------------------------------------------------- | -------------------------------- | ------------------------ | ---------------------- | ------------------------------ | ----------------------- | --------------------- | ------------------------------------------------ | ------------------------------------ |
| 配置代理      | Settings / General / Network                          | `GeneralSectionContent`          | SettingsPage local draft | `AppSettings`          | setting schema + normalization | `settingService.update` | `setting.json`        | desktop 设置；重启后 Host/Agent/Session 各自应用 | shell 环境隐式代理                   |
| OAuth 登录    | provider 登录入口                                     | `OAuthService` + `NodeApiClient` | OAuth pending state      | Host policy snapshot   | state、callback、network/TLS   | token exchange          | credential repo       | local 与 desktop-attached remote 的本机身份      | server remote 身份与 remote Agent    |
| 后台业务 API  | Coding Plan、scenes、provider、usage、feedback 等入口 | shared `NodeApiClient`           | 各业务服务               | Host policy snapshot   | URL、No Proxy、TLS、timeout    | API request             | 各业务 owner          | 不改变 desktop/mobile delivery                   | Bot、telemetry、object upload 裸出口 |

### Feature Relationships

| Rank           | From                     | Semantic edge               | To                                            | Condition                 | Why inspect it      | Evidence                                         |
| -------------- | ------------------------ | --------------------------- | --------------------------------------------- | ------------------------- | ------------------- | ------------------------------------------------ |
| must-inspect   | desktop network settings | supplies explicit policy to | Host API network policy                       | next Host lifecycle       | 配置权威            | `settingService.ts`、设置页文案                  |
| must-inspect   | Host API network policy  | injects transport into      | `NodeApiClient`                               | app-managed HTTP(S)       | 统一修复点          | `nodeApiClient.ts`                               |
| must-inspect   | Host API network policy  | wires into                  | local and desktop-attached remote collections | local app-global services | 两个 client 装配点  | `node.ts`、`remoteWorkspaceServiceCollection.ts` |
| conditional    | endpoint switching       | rewrites before             | proxy/No Proxy selection                      | dev/test override         | 必须匹配最终 URL    | `NodeApiClient.request`                          |
| invariant-only | Host API network policy  | must not alter              | desktop-continuous / web-remote-replayable    | all requests              | 无 session 状态变化 | 架构文档                                         |
| invariant-only | Host API network policy  | must not become global      | direct fetch / WS / SSH / RPC                 | first phase               | 控制回归面          | 当前直接出口清单                                 |
| evidence-only  | Host API network policy  | covered by                  | focused unit/integration tests                | implementation            | 证明而非产品依赖    | 下方 accepted cases                              |

### State Owners And Commit Sinks

| State/fact                      | Draft/display owner  | Authoritative owner | Commit command/service   | Persistence/cache                  | Evidence                              |
| ------------------------------- | -------------------- | ------------------- | ------------------------ | ---------------------------------- | ------------------------------------- |
| proxy / no-proxy / CA path      | SettingsPage         | `AppSettings`       | `settingService.update`  | `setting.json`                     | `settingService.ts`                   |
| effective Host policy           | none                 | Window Host process | lazy snapshot creation   | process-memory snapshot + disposer | planned provider boundary             |
| OAuth pending callback          | OAuth UI/service     | `OAuthService`      | `handleCallback`         | process memory + credential repo   | `oauthService.ts`                     |
| remote workspace app-global API | remote UI projection | desktop Window Host | local service collection | local settings/credentials         | `remoteWorkspaceServiceCollection.ts` |

### Must-Preserve Invariants

| Invariant                                                                   | Surfaces/modes        | Proof needed                                 | Evidence                     |
| --------------------------------------------------------------------------- | --------------------- | -------------------------------------------- | ---------------------------- |
| 未配置显式代理时 Host 业务 API 继续直连                                     | all                   | direct test                                  | `HAP-001`                    |
| 显式代理失败不得回退直连                                                    | forced-proxy network  | capture upstream direct connection count = 0 | `HAP-004`                    |
| desktop-attached remote 的本机身份 API 使用桌面策略，server remote 不被覆盖 | remote modes          | wiring tests                                 | `HAP-008/009`                |
| 不改变 Agent、Electron Session、Bot、telemetry、object upload 出口          | all                   | dependency and regression checks             | `HAP-010`                    |
| 不改变 continuous/replayable、workspace identity 或 session 状态            | desktop/mobile/remote | no protocol/schema/state diff                | static diff + existing tests |

### Codegraph Evidence

当前环境没有可调用的 codegraph 工具；按 skill 的 fallback 使用精确 symbol/text 跟踪，展开深度 2。

| Seed                    | Query             | Direct callers / key path                                                       | Depth | Interpretation           |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------- | ----- | ------------------------ |
| `createNodeApiClient`   | callers           | `createLocalServices`、`createRemoteWorkspaceServiceCollection`                 | 1     | 两个必须接线点           |
| `NodeApiClient.request` | callers/consumers | OAuth、provider、Coding Plan、usage、client scenes、feedback、snapshot metadata | 2     | 共享业务 API 出口        |
| `settingService.get`    | key path          | AppSettings -> lazy Host policy snapshot                                        | 2     | 设置权威和重启语义       |
| direct `fetch`          | text inventory    | Bot、telemetry、object upload、off-peak、system probe                           | 1     | 证据项；不是本次产品依赖 |

### Graph Drift And Delta

现有 feature graph 只声明 Electron renderer / embedded Browser 的网络策略，没有 Host app-managed API
网络策略节点。规划阶段新增独立 capability、service、evidence 和边，不扩大既有 Browser capability 的语义。

## Case Planning

### Clarification Log

| Round | Question                    | User answer                                                         | Boundary fixed                            | Follow-up needed |
| ----- | --------------------------- | ------------------------------------------------------------------- | ----------------------------------------- | ---------------- |
| 1     | Host 覆盖的修改量和影响范围 | 用户继续调用 `zcode-plan`；沿用已建议的 scoped `NodeApiClient` 方案 | 先修 app-managed API，不用全局 dispatcher | no               |

### Boundary Decisions

| Boundary        | Decision               | Includes                        | Excludes / prunes          | Source               |
| --------------- | ---------------------- | ------------------------------- | -------------------------- | -------------------- |
| transport scope | scoped fetch injection | `NodeApiClient` consumers       | global/direct fetch        | code + risk analysis |
| config source   | AppSettings only       | proxy/no-proxy/CA               | ambient shell/system proxy | existing spec        |
| activation      | next Host lifecycle    | local + desktop-attached remote | live hot swap              | settings UI contract |
| remote owner    | keep current authority | desktop app-global services     | server remote override     | architecture docs    |

### Dimensions And Candidate Combinations

| Candidate ID | State                                 | Event                           | Target/surface                | Expected guard/effect                               | Status   | Notes                  |
| ------------ | ------------------------------------- | ------------------------------- | ----------------------------- | --------------------------------------------------- | -------- | ---------------------- |
| HAP-001      | no explicit policy                    | API request                     | ZCode endpoint                | direct, existing behavior                           | accepted | baseline               |
| HAP-002      | explicit proxy                        | OAuth callback                  | final token URL               | exactly one proxied request                         | accepted | core ticket            |
| HAP-003      | proxy + matching No Proxy             | API request                     | exact/suffix/host:port target | direct, CA still applies                            | accepted | bypass semantics       |
| HAP-004      | unreachable proxy                     | API request                     | external endpoint             | structured failure, zero direct fallback            | accepted | security invariant     |
| HAP-005      | custom CA, no proxy                   | HTTPS request                   | private CA endpoint           | direct TLS succeeds                                 | accepted | direct CA              |
| HAP-006      | proxy + custom CA                     | CONNECT request                 | private CA endpoint           | tunnel TLS succeeds                                 | accepted | enterprise path        |
| HAP-007      | settings changed during Host lifetime | later request                   | same Host                     | old snapshot until restart; new Host uses new value | accepted | restart contract       |
| HAP-008      | desktop-attached remote               | local OAuth/Coding Plan request | desktop Host local service    | desktop policy applies                              | accepted | local authority        |
| HAP-009      | server remote                         | remote-owned API request        | server service                | desktop Host policy does not replace it             | accepted | authority isolation    |
| HAP-010      | explicit proxy                        | non-ApiClient direct fetch      | Bot/telemetry/object upload   | unchanged in this phase                             | accepted | scope guard            |
| HAP-011      | endpoint override + No Proxy          | request                         | rewritten endpoint            | match final URL                                     | accepted | ordering               |
| HAP-012      | timeout/abort                         | proxied streamed response       | ApiClient                     | existing abort/timeout/stream behavior preserved    | accepted | transport parity       |
| HAP-013      | system/shell proxy only               | API request                     | Host                          | ignored; direct                                     | accepted | sanitization invariant |

### Pruning Decisions

| Decision ID | Pruned combinations                  | Guard/invariant                                            | Product reason                                     | Representative coverage               |
| ----------- | ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| P-001       | proxy x every business service       | all share injected `NodeApiClient`                         | avoid duplicated business tests                    | OAuth + generic client + wiring tests |
| P-002       | desktop/mobile delivery permutations | no protocol/state changes                                  | network transport is below RPC business semantics  | static boundary check                 |
| P-003       | every remote target type             | SSH/WSL/Docker share desktop-attached app-global authority | representative desktop-attached remote wiring test | `HAP-008`                             |
| P-004       | direct-fetch product behaviors       | outside scoped transport                                   | requires separate owner decision                   | `HAP-010` invariant only              |

### Accepted Cases And Evidence

| Case ID     | Setup                                    | Action                                    | Assertions                                    | Evidence layers            | E2E status |
| ----------- | ---------------------------------------- | ----------------------------------------- | --------------------------------------------- | -------------------------- | ---------- |
| HAP-001     | no settings                              | request test server                       | direct success, no proxy agent                | unit + network             | planned    |
| HAP-002     | local CONNECT proxy; direct route denied | complete OAuth token request              | proxy observes final URL; response succeeds   | unit + integration/network | planned    |
| HAP-003     | explicit bypass patterns                 | request matching and nonmatching targets  | correct dispatcher chosen                     | unit                       | planned    |
| HAP-004     | dead proxy                               | request reachable direct upstream         | fails without upstream hit                    | integration/network        | planned    |
| HAP-005/006 | private CA endpoint; direct/proxy        | request endpoint                          | TLS succeeds only with configured CA          | integration/network        | planned    |
| HAP-007     | write setting after first request        | second request, then recreate Host/client | old/new lifecycle policies observed           | unit                       | planned    |
| HAP-008/009 | remote collection fixtures               | resolve local and server-owned services   | correct client authority                      | wiring unit                | planned    |
| HAP-010     | direct fetch spy                         | construct scoped client                   | global fetch/dispatcher unchanged             | unit/static                | planned    |
| HAP-011     | test endpoint rewrite                    | request production URL                    | No Proxy sees rewritten origin                | unit                       | planned    |
| HAP-012     | slow/stream server                       | abort and timeout                         | current `ApiError`/stream semantics preserved | unit + network             | planned    |

不需要 conversation formal-proof 或 conversation E2E handoff；本改动不增加产品状态、command、snapshot 或
replayable 组合。真实 Windows 强制代理 smoke 是发布前补充验证，不替代确定性的本地代理集成测试。

## 实现顺序（测试先行）

1. 为 Host 网络策略快照和 request-scoped fetch 写失败测试：直连、代理、No Proxy、CA、fail-closed、abort。
2. 为 `NodeApiClient` 写 endpoint rewrite 后选路及注入测试。
3. 实现 `packages/services` 内的 Host API network provider；禁止同步文件 IO。
4. 接入 `createLocalServices`，再接入 desktop-attached remote 的本机服务集合，并把 transport close 纳入两类
   collection 的同步/等待式资源释放。
5. 增加装配/隔离测试，确认没有调用 `setGlobalDispatcher`，server remote 与 direct fetch 不变，dispatcher
   不留下 open handle。
6. 执行定向测试、`pnpm typecheck`、`pnpm lint`；能运行时再做 Windows 强制代理 smoke。

## 风险与回滚

| 风险                                    | 收口方式                                                          |
| --------------------------------------- | ----------------------------------------------------------------- |
| 误代理 localhost / 内网 / remote server | scoped client + No Proxy + 禁止 global dispatcher                 |
| endpoint override 匹配错误              | rewrite-before-routing 测试                                       |
| 代理失败后泄漏直连                      | fail-closed 集成测试，统计 direct upstream hit                    |
| CA 只覆盖某一段 TLS                     | direct、HTTPS proxy、CONNECT 分别验证                             |
| 连接池或 dispatcher 泄漏                | Host lifecycle 持有并在 service dispose 时关闭；测试 open handles |
| 设置热更新语义漂移                      | immutable lifecycle snapshot，设置页文案不变                      |

回滚只需撤销 `NodeApiClient` 的 fetch 注入和 Host policy provider；没有 schema、协议、凭据、设置格式或数据迁移，
已有 Electron Session 与 Agent 网络路径不受影响。

## 实现结论

Owner、配置来源、作用域、激活时机、远程边界、失败模式、测试和回滚均已实现并收口。
其它 Host 裸网络出口是否都应跟随 App 代理仍需逐项分类，且不得通过全局 dispatcher 偷渡。远程资源下载
已经按独立 spec 收口为显式 port 消费方，不改变 Bot、telemetry、object upload 等剩余出口。

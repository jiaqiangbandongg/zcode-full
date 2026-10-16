# ZCode 登录凭据 HTTP/业务 401 自动退出

## 目标

服务端对确认失效的登录凭据返回 HTTP `401`，或 HTTP `200` 且完整 JSON 正文包含数值 `code: 401`。Desktop 服务层通过请求 Authorization 与当前凭据比对，通知 Host 复用现有 OAuth 退出清理、登录过期弹窗及确认重启。

2026-09-08 最小兼容范围：保留现有 ZCode JWT 判断，增加当前唯一 active provider（BigModel 或 ZAI）的业务 `access_token` 判断。新增判断只覆盖当前环境的 `/api/biz/customer/getCustomerInfo`，以及各平台配置的 userinfo URL，兼容裸 Authorization 和 `Bearer <access_token>`。URL 必须同时匹配 origin 与 pathname，查询参数不参与身份判断。

2026-10-08 补充：HTTP `200` 的完整 JSON 响应中，数值 `code: 401` 也表示登录失效。当前平台业务 token 的白名单增加 `/api/biz/subscription/enterprise/v2/pricing` 和 `/api/biz/team/subscribe/product/querySubscribeDetail`，与 customerInfo/userinfo 共用 HTTP 401 和业务 401 判断。

支付/订单、API key 列表/创建/复制、模型 API key 请求和 WebView 内请求不纳入新增判断。同一个 customerInfo 接口即使被模型配置刷新调用，也仍属于用户/团队身份查询；不因上层调用方不同改变该接口的 401 语义。

## 请求出口

```text
服务层 -> NodeApiClient.request -> HTTP 401 或 HTTP 200 + JSON code=401
                                    |
                     +--------------+----------------+
                     |                               |
              当前 ZCode JWT              当前平台身份/定价/订阅详情白名单
                     |                     + 当前 access_token
                     +--------------+----------------+
                                    |
                       现有 logout -> 广播 -> 过期弹窗
                                    |
                          确认后重启（Web 刷新）
```

观察点只发出带请求 URL/Authorization 的回调，不直接读写凭据。Host 侧通过会话队列内的当前凭据复核去重，并调用现有 logout/派生 provider 清理流程。401 返回后读取当前凭据，旧 token 或非 active 平台请求不得触发新增处理。读取 access token 后再次确认 active provider，避免异步读取跨越平台切换。

## 兼容边界

旧服务端普通 401 可按请求凭据分类；启动恢复仍负责本地 JWT `exp` 预判，该预判不替代服务端撤销判断。直接绕过 ZCode 请求出口访问官方服务的 API Key 不在本机制的保护范围内。

不新增刷新、到期解析、主动探测或历史键清理。HTTP 200 内除数值 `code: 401` 外的业务错误、空正文、HTML、损坏 JSON、403、网络失败不触发本机制。业务 401 观察只在明确的 OAuth 业务接口白名单上运行，副本读取限制为 64 KiB 且每次请求最多等待 1 秒；超时、超限或解析失败会取消观察副本并立即交还原响应，不消费调用方正文。SSE 响应不读取、不等待结束。独立 CLI 账号架构不纳入 Todo103。

复用原弹窗、国际化与主题，不修改 UI、广播协议或重启动作。手机 shared-host attachment 继续消费既有 Host 广播，不新增 Host/Agent，也不改变 desktop-continuous 与 web-remote-replayable 的消息语义。独立 Web OAuth 与 Agent 官方 MCP transport 不因此获得新的拦截器。

## 验收

- BigModel/ZAI 当前业务 token 的目标接口 HTTP 401 触发同一失效回调；裸 token 和 Bearer 均覆盖。
- BigModel/ZAI 白名单接口 HTTP 200 + JSON `code: 401` 触发相同失效回调；响应正文仍可由调用方正常解析。
- 错误域名、错误环境、支付/订单/API key 路径、匿名/普通 API key、旧 token、非 active 平台均不触发新增回调。
- 环境隔离测试为 BigModel/ZAI 显式注入 `production.example` 与 `test.example` 两套业务和 userinfo 地址，
  在两种产品环境下分别验证当前地址触发、另一环境地址不触发；测试不依赖真实测试域名与生产域名不同，
  经开源地址改写后仍保留同一组断言。
- 延迟 401 返回前更新 token 或切换平台，不通知旧会话失效。
- HTTP 200 其它业务错误、空/损坏正文、SSE、403、500 不触发；原 ZCode JWT 401 测试保持通过。
- 隔离 Electron E2E 分别通过真实 Host 请求得到本地 HTTP 401 与 HTTP 200 + 业务 401，确认提示前认证凭据已清理，确认后调用既有重启命令；不使用真实用户凭据或请求真实平台。

业务 401 的原因是服务端以 HTTP 200 封装登录过期；旧观察器只判断 HTTP status，导致项目可用性退化为 unknown、定价抛普通消息、订阅汇总丢失原因，旧登录态继续保留。修复复用同一失效入口、凭据复核及广播，不把临时空响应解释为过期。解析副本期间也可能完成新登录，最终清理仍必须在会话队列内复核；并发接口只产生一次实际清理和提示。观察副本的有界读取保证异常 chunked body 不会改变主请求生命周期。

## SG-01：迟到 401 的会话提交保护（2026-09-09）

原因：分类器读到旧 access token 后，同一平台可能完成新登录；仅复核 active provider 仍会放行旧响应。分类结果只是候选，不能直接作为清理当前登录的授权。

Host 将该请求的 URL/Authorization 交给 OAuthService 的本地 `logoutIfCurrentCredentialRequest`。该方法在既有 `sessionMutationQueue` 内重新分类，并在同一队列任务中清理凭据；只有实际清理成功才通知派生 provider 并广播过期提示；派生配置清理失败记录 warning，仍保留已退出会话的提示。每个候选均入队，避免旧候选等待期间丢弃新凭据的 401。原手动 logout、JWT 判定及接口白名单保持兼容，不增加 UI/RPC 方法。工厂返回具体 OAuthService 以供同模块 Host 装配调用，本地方法不加入 IOAuthService 的跨端契约。

```text
HTTP 401 -> 初步分类 -> 请求凭据进入 OAuthService 会话变更队列
                           |
              新登录/刷新先提交 -> 凭据不匹配 -> 忽略、无广播
              旧 401 先提交    -> 核对并清理 -> 广播
                           |
              后续新登录仍按原队列写入，不被旧清理覆盖
```

refreshToken 的网络交换保持在队列外，写回进入同一队列，并校验交换前的会话 generation、provider 和 access token；过期刷新不得在退出后复活凭据或覆盖新登录。不新增刷新能力，当前 BigModel/ZAI adapter 不提供 refreshToken 交换。

状态 owner 仍是当前 Host 的 OAuthService；该队列串行化本实例的登录、退出和刷新写回，不引入跨进程事务或变更 credentials.json 格式。跨 Host/CLI 的并发文件操作继续遵守原凭据存储边界。桌面 continuous / 手机 replayable 的 attachment、广播、提示与重启边界不变。

### Todo103 整合约束：保留退出账号身份

条件退出与手动退出一样，在会话队列内、清理凭据之前读取原账号的 accountIdentity，
再把 provider + accountIdentity 交给现有派生清理回调。不能恢复为仅传平台的旧清理入口，
也不能在凭据清空后再猜身份。队列外派生清理仍遵循现有按账号身份清理的服务边界；
不因此重做账号状态同步或跨 Host 事务。需覆盖 BigModel/ZAI 两端身份传递、手动退出
错误语义、并发重复 401 和旧请求在新登录/刷新后返回不误清理的回归。

回归：分类器读旧 token 后同平台换新 token；候选入队前同平台重新登录；失效核对期间新的会话写入等待；刷新结果在退出后返回；正常当前 token 401 仍只触发原清理与提示。通过隔离服务层受控时序测试证明队列边界，Electron AUTH-06 复核正常 401 链路；旧 token 的竞态不广播由服务层受控测试覆盖。

## CR-01：隔离 URL 配置异常（2026-09-09）

原因：候选地址集中构造时，业务 base URL 的异常会阻断另一个有效 userinfo 地址；为了取 userinfo 而构造完整平台配置，也会引入无关授权/登录地址的异常。

仅在 access token 分类阶段安全解析请求地址，并分别构造、解析 customerInfo 与 userinfo 候选；非法地址（含相对地址、非 HTTP(S) 协议）仅跳过自身，不阻断有效候选。全部候选无效或请求地址非法时返回 false，HTTP 响应照常交还调用方。空白 override 仍复用原配置的默认地址规则。userinfo 地址解析由平台配置和分类器共用，不改变平台启动时原有配置校验，也不输出原始配置或凭据。

验收：BigModel/ZAI 无效 userinfo 不影响有效 customerInfo；无效业务 base 不影响有效 userinfo；无关配置异常不参与分类；空白 override、非法请求和全部候选无效均有回归，原 JWT 分支不依赖新增 URL 解析。

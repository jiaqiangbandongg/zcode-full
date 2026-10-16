# Desktop Auth/Config E2E Cases

## Todo103 G09：固定 staging 登录行为整合验收

本节是整合验收范围，不覆盖或改写下文历史运行记录。

| Case | 来源与操作 | 验收与限制 |
| --- | --- | --- |
| AUTH-05 | d17cb6a800；正式 oauth-login-failure-cancel.test.ts，通过 preload 回调投递无效 state | 真实 Host 拒绝回调后 UI 仅展示失败块；取消后回到渠道列表，登录入口不关闭。保留上游正式用例身份，不是本轮擅自晋级 |
| AUTH-06 | a172e9c398 / 71a195b6be / f26d4e75fb；pending access-token-401-auto-logout.test.ts | case-local HTTP 暂停真实 Host userinfo，再返回 401；清理当前 OAuth、保留 Bot 凭据、只展示一次过期提示；确认发出既有 RelaunchApp。IPC 截断实际重启，不冒充真实重启已验证 |

两条用例都不产生模型请求，manifest 明确 providerRequestPolicy=none。AUTH-06 的
业务 token/JWT 是值不同的合成凭据，其它控制面 HTTP 200，避免原 JWT 失效路径掩盖
新增 access token 分类。mock 仅统计是否命中合成 token，不在产物输出凭据。
服务层受控时序测试负责迟到 401、刷新写回、重复候选和 accountIdentity 保护；
Electron 用例不声称覆盖这些微观竞态。AUTH-06 保持 pending，Pro 本地验证不等于
手机 shared-host / Windows 全端验证；没有新增 Host 或修改 continuous/replayable 链路。

上游 AUTH-06 运行记录将作为固定 staging 历史证据保留，不计作本分支运行通过；
本轮实际结果记录在 Todo103 账本 G09。

本文记录桌面端 auth/config 相关正式 E2E case。范围只包含 desktop local 冷启动、OAuth 登录态恢复和本地配置清理；不覆盖手机 `/remote`、remote workspace、replayable 恢复或真实 OAuth 浏览器回调。

每条 case 必须满足：

- 有独立 setup、action、assert，不能只因为启动路径经过登录页就算覆盖。
- 如果不触发模型请求，manifest 必须显式声明 `providerRequestPolicy: "none"`。
- 如果通过 WDIO seed 写入本地配置，文档必须写明 seed 文件和需要验证的清理边界。

## AUTH-01: 损坏 OAuth 凭据冷启动恢复

### Case 定义

| 字段             | 内容                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/oauth-credential-recovery.test.ts`                         |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/oauth-credential-recovery.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                                   |
| 当前状态         | 已转正，正式路径 cold-start case                                                      |

### 测试场景

用户本地 `credentials.json` 中残留 OAuth 登录态，但其中 `oauth:active_provider` 是当前机器无法解密的密文。桌面端冷启动时，OAuth session restore 不能让登录入口进入“加载失败 / 没有登录渠道”的死态；系统应清理损坏登录态，并重新展示可登录渠道。

这条 case 只验证“损坏 OAuth 凭据 -> 冷启动恢复 -> 登录渠道可见 -> 损坏登录态清理”。它不覆盖真实网页登录、OAuth callback、token refresh、购买链路、remote workspace 或模型发送。

限制：AUTH-01 当前只覆盖 desktop local host；remote workspace 与手机 `/remote` 的 OAuth 损坏恢复已由 service 级回归测试保护，正式 remote E2E case 待后续补充。

### 操作步骤

1. WDIO `beforeSession` 清理隔离 HOME。
2. `wdio.conf.ts` 识别 `oauth-credential-recovery.test.ts` 后，在 `~/.zcode/v2/credentials.json` 写入损坏 OAuth seed。
3. 启动桌面端本地默认窗口。
4. 等待登录入口渲染。
5. 检查 Z.ai 与 BigModel 登录渠道均可见。
6. 检查没有展示 OAuth 错误提示。
7. 读取隔离 HOME 下 `credentials.json`，确认损坏 OAuth 登录态已清理。

### 验证条目

| 编号      | 验证项                    | 有效性说明                                                      | 当前断言位置                                                |
| --------- | ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| AUTH-01-A | Z.ai 登录入口可见         | 证明 `oauthService.getProviders()` 没有因损坏凭据导致入口不可用 | `waitForTestIdByDom(testId(TID_OAUTH_LOGIN_BUTTON, "zai"))` |
| AUTH-01-B | BigModel 登录入口可见     | 证明多 provider 登录渠道仍能完整展示                            | `waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON)`                |
| AUTH-01-C | 登录页没有 OAuth 错误提示 | 证明损坏凭据被当作可恢复登录态处理，不向用户暴露底层解密错误    | `expectNoOAuthErrorAlert()`                                 |
| AUTH-01-D | OAuth 相关损坏凭据被清理  | 证明下次启动不会继续卡在同一份无效登录态                        | `waitForCorruptOAuthCredentialsCleanup()`                   |

### Fixture 合同

- 本 case 不触发 provider 请求，manifest 使用 `providerRequestPolicy: "none"` 和空 `requests`。
- 本 case 的输入 fixture 是 WDIO 冷启动 seed：`~/.zcode/v2/credentials.json`。
- 需要清理的 key 包含 `oauth:active_provider`、Z.ai/BigModel access token、refresh token、user info，以及旧 `zcodejwttoken`。

### 转正说明

该 spec 已位于正式路径 `packages/desktop/test/e2e/oauth-credential-recovery.test.ts`，会被默认 `./test/e2e/**/*.test.ts` 收集，不在 `manual-review/pending` 下。因此不执行 `promote-conversation-e2e.mjs` 的移动流程；本次转正补齐正式 manifest 与 auth/config 覆盖文档。

### 实际验证结论

2026-07-09 已执行：

- `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/oauth-credential-recovery.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260709-042306-597/summary.md`。
  - 结论：冷启动遇到无法解密的 OAuth 凭据时，Z.ai 与 BigModel 登录渠道均可见，页面没有 OAuth 错误提示，损坏登录态被清理。

Docker 准入暂不执行：该 case 不依赖 provider replay，也不属于 conversation Docker preset。

## AUTH-02: Provider readiness 门禁与恢复

### Case 定义

| 字段             | 内容                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/provider-readiness-agent-startup.test.ts`                         |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/provider-readiness-agent-startup.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                                          |
| 当前状态         | 已转正，正式路径 cold-start case                                                             |

### 测试场景

desktop local 使用隔离 HOME 冷启动；CLI session DB 预置一条 interactive 历史，但用户没有 OAuth 登录态、API Key 或其它结构可用 provider。登录入口完成渲染后，用户暂时跳过并进入默认 workspace；sessions-index 必须按需启动唯一只读会话 Agent，把这条真实历史展示在侧栏，点击后能读取已持久化正文，同时首页继续展示 `modelConfigMissing` banner。用户新建草稿并尝试首发时不得创建 session/model command。随后重新打开登录/provider 配置入口，保存一个已启用、具有 runtime Base URL、未禁用模型和所需 credential 的 provider；同一 workspace 必须复用该 Agent、保持数量为 1，完成草稿模型水合，并清除该 banner。

本 case 只验证本地结构 readiness、进程启动边界和草稿水合，不发送 prompt、不联网验证 provider 连通性，也不覆盖插件/MCP management Agent。remote workspace 使用 service/integration case 验证 desktop registry 下发前后边界。

### 验证条目

| 编号      | 验证项                                          | 有效性说明                                                                                                                                                          |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-02-A | 未配置时登录/provider 入口可用                  | `waitForTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON)`                                                                                                                  |
| AUTH-02-B | 跳过后草稿首页展示缺模型 banner                 | `TID_CHAT_ERROR_BANNER` 回显“当前没有可用模型”                                                                                                                      |
| AUTH-02-C | 未配置时点击发送被 UI admission 拒绝            | composer 原文保留；没有 `createSession` pending 记录或 unknown/discarded 恢复横幅                                                                                   |
| AUTH-02-D | 未配置时历史可见且可读                          | 预置 interactive CLI session 的侧栏 row、用户正文与助手正文均可见，证明真实 sessions-index/conversation topic 已工作                                                |
| AUTH-02-E | 未配置时没有 deferred draft/retry               | service/UI focused tests 断言 `provider_not_ready` 保持 idle 且投影 banner                                                                                          |
| AUTH-02-F | 未配置时目标 workspace 只读 Agent 数为 1        | 资源管理器快照按 `ZCodeProject` workspace tag 断言为 1；系统 conversation sibling 不计入，只允许 sessions-index/history 读取，不产生 session create/model command |
| AUTH-02-G | 保存 provider 后仍复用目标 workspace 唯一 Agent | 资源管理器对同一 workspace 的 Agent 行数保持 1，稳定窗口后二次断言仍为 1，read→write 不重复启动                                                                      |
| AUTH-02-H | 草稿模型水合且缺模型 banner 清除                | 模型 trigger 回显首个未禁用模型，`TID_CHAT_ERROR_BANNER` 不再存在                                                                                                   |

### Fixture 合同

- manifest 使用 `providerRequestPolicy: "none"` 和空 `requests`；整个 case 不产生模型请求。
- 输入 fixture 只向 Agent CLI SQLite 写入 interactive session/message/part；不写 App `tasks-index`，侧栏 membership 必须由真实冷启动 sessions-index baseline 创建。其余输入是隔离 HOME 的空 auth/provider 状态，以及测试过程中通过真实 API Key 登录入口保存的本地 provider 配置。
- 进程断言读取资源管理器与主进程 lifecycle registry 同源的进程快照，不使用只适配单一操作系统的 `pgrep`/`ps` 断言。

### 实际验证结论

2026-07-20 已执行：

- `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/provider-readiness-agent-startup.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260720121301941-p51454-824198917812e029/summary.md`。
  - Provider capture：`upstream-provider.json` 的 `records` 为空，符合 `providerRequestPolicy: "none"`。
  - 结论：空 provider 冷启动时真实历史可见、可点开读取，新草稿首发仍被门禁拒绝；保存 provider 后复用同一目标 workspace Agent 并完成模型水合。

Docker 准入不执行：该 auth/config case 不依赖 provider replay，也不属于 conversation Docker preset。

## AUTH-03: ZCode JWT 过期后重新认证

### Case 定义

| 字段             | 内容                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/manual-review/pending/jwt-expiry-reauthentication.test.ts`   |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/jwt-expiry-reauthentication.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                                     |
| 当前状态         | 候选 case，等待人工确认过期提示与重新登录入口后转正                                     |

### 测试场景

desktop local 使用隔离 HOME 冷启动；`credentials.json` 预置一份完整 Z.ai OAuth 缓存会话，以及一枚 `exp` 明确早于当前时间的 `zcodejwttoken`。Local Host 恢复缓存会话时必须先清理失效认证事实，再通知 renderer 显示“登录已过期”提示；用户点击“重新登录”后直接进入现有 Welcome 登录页，不经过主动退出确认或 App relaunch。

本 case 只验证 desktop local 的冷启动恢复和 UI 交互，不触发真实 OAuth callback、token refresh、provider/model 请求，也不修改 remote workspace、手机 `/remote` 或 task/session realtime 状态。

### 状态与操作时序

```text
WDIO 冷启动 seed
  完整 OAuth 缓存 + 已过期 JWT
             |
             v
Local Host restoreCachedSessionState
             |
             +--> 先清理 active provider / token / user_info / JWT
             |
             v
renderer 显示“登录已过期” AlertDialog
             |
             +--> 弹窗仍打开时读取 credentials.json，确认清理完成
             |
             v
用户点击“重新登录”
             |
             v
Welcome 展示 Z.ai + BigModel 登录入口
```

### 验证条目

| 编号      | 验证项                        | 有效性说明                                                               |
| --------- | ----------------------------- | ------------------------------------------------------------------------ |
| AUTH-03-A | 过期提示标题和说明可见        | 证明结构化 `reauthentication-required` 已传到 renderer，而非恢复伪登录态 |
| AUTH-03-B | 提示确认前认证凭据已清理      | 证明 AlertDialog 不是清理认证事实的阻塞点                                |
| AUTH-03-C | 点击“重新登录”进入 Welcome    | 证明用户能从过期态回到现有登录流程，不会停留在无法退出/无法重登的死态    |
| AUTH-03-D | Z.ai 与 BigModel 登录入口可见 | 证明重新认证页具备完整 provider 选择能力                                 |
| AUTH-03-E | 不展示主动退出确认            | 证明过期恢复没有误走“确认断开连接”或运行中会话二次确认流程               |

### Fixture 合同

- manifest 使用 `providerRequestPolicy: "none"`、`noProviderRequests: true` 和空 `requests`。
- 输入 fixture 是 WDIO 在 App 启动前写入隔离 HOME 的 `~/.zcode/v2/credentials.json`。
- JWT 只包含测试用 header/payload/signature；payload 的 `exp` 固定在过去，不依赖签名有效性。
- 需要清理的 key 包含 `oauth:active_provider`、Z.ai access token、refresh token、user info 和 `zcodejwttoken`。
- 当前位于 `manual-review/pending`；人工确认可视交互后才能移动到正式路径并更新本节状态。

### 自动运行结论

2026-08-06 已执行：

- `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/manual-review/pending/jwt-expiry-reauthentication.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260806040559238-p94707-95e800e8762670fe/summary.md`。
  - 运行时发现并修复：provider 启动门禁的 `open=false` 曾无条件清空 `session-expired`，导致用户确认后重新登录页被工作区覆盖；现在门禁只关闭自己拥有的 `startup-provider-required`。
  - Provider capture 没有模型请求，符合 `providerRequestPolicy: "none"`。

当前只完成自动运行，尚未记录人工视觉验收，因此继续保留在 `manual-review/pending`，不执行转正或 Docker 准入。

<!-- 固定 staging 的 JWT 场景原编号 AUTH-05，与上方登录取消编号冲突；此处命名为 AUTH-JWT-401，历史证据不算本轮通过。 -->
## AUTH-JWT-401: 运行中 ZCode JWT 401 退出并重启

### Case 定义

| 字段             | 内容                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/manual-review/pending/jwt-401-auto-logout.test.ts`   |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/jwt-401-auto-logout.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                             |
| 当前状态         | 候选 case，等待人工确认 401 触发提示、凭据清理和重启动作后转正                  |

### 测试场景

desktop local 使用隔离 HOME 冷启动并恢复一份有效 OAuth 会话。进入工作区后，测试通过 Electron 网络 mock
让后续 ZCode 控制面请求返回普通 HTTP 401；请求携带的 Authorization 与本地 `zcodejwttoken` 相同，
因此必须触发 Host 的统一 logout，而不是展示普通网络错误。测试断言凭据在提示确认前已清理，用户确认后
调用现有 `RelaunchApp`，避免真实退出测试进程。

本 case 只验证运行中 desktop local 的 401 失效观察、凭据清理、提示和重启命令；不覆盖真实 revoke、
Agent 模型 transport、Official MCP、remote workspace 或手机 `/remote`。

### 状态与操作时序

```text
有效 OAuth 会话 + zcodejwttoken
             |
             v
打开模型供应商设置，触发 ZCode 请求
             |
             v
Electron net.fetch mock 返回 401
             |
             v
Host 比对当前 JWT -> logout 清理凭据 -> 广播失效事件
             |
             v
Renderer 显示“登录已过期”
             |
             +--> 确认前：credentials.json 已无 OAuth/JWT key
             |
             v
用户确认 -> DesktopCommandIds.RelaunchApp
```

### 验证条目

| 编号      | 验证项                         | 有效性说明                                            |
| --------- | ------------------------------ | ----------------------------------------------------- |
| AUTH-JWT-401-A | 运行中 401 能显示登录过期提示  | 证明请求出口观察和 Host 广播链路实际工作              |
| AUTH-JWT-401-B | 确认前 OAuth/JWT 凭据已清理    | 证明提示框不会阻塞认证事实清理                        |
| AUTH-JWT-401-C | 确认后调用 `RelaunchApp`       | 证明提示动作复用现有重启流程                          |
| AUTH-JWT-401-D | 普通 401 mock 不依赖专用响应头 | 证明兼容当前没有 `X-ZCode-JWT-Invalid` 响应头的服务端 |

### Fixture 合同

- manifest 使用 `providerRequestPolicy: "none"`、`noProviderRequests: true` 和空 `requests`。
- 输入 fixture 是默认 E2E 启动凭据 seed；运行中 401 由 Electron `net.fetch` mock 注入，不访问真实服务。
- mock 只返回状态和成功标志，不记录或暴露 Authorization/JWT 值。
- 当前位于 `manual-review/pending`；人工确认后再转正，不执行 Docker 准入。

## AUTH-04: 登录后 Subagent Coding Plan Model Selection 就绪

### Case 定义

| 字段             | 内容                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/subagent-coding-plan-login-catalog-stale.test.ts`                             |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/subagent-coding-plan-login-catalog-stale.json`     |
| Provider fixture | 无模型请求；OAuth、`release/latest`、`client/configs`、套餐与 API key 接口均由 case-local HTTP mock 固定 |
| 当前状态         | 已转正，正式路径登录后 UI 可用性与当前 Environment Model Selection 就绪 case                             |

### 测试场景

desktop local 使用隔离 HOME 冷启动：OAuth 凭据为空，当前 Environment 预置一个带 reasoning 档位的自定义 DeepSeek 模型。用户从 Welcome 完成 BigModel OAuth；回调后，Account Overlay 与当前 Environment 的 Provider Runtime 刷新，使 `builtin:bigmodel-coding-plan/GLM-5.2` 进入 Model Selection View。用户不重启、不手动保存 Provider，直接打开 Subagent 设置，在同一个 `general-purpose` 行依次选择自定义模型和内置 Coding Plan 模型。

该 case 同时读取 renderer 暴露的 workspace `configOptions`，避免仅凭文案猜测能力状态。`configOptions` 是当前 Environment Model Selection View 的会话投影，不是 Desktop 持有并向 Worker 推送的第二份 Provider Registry。该 case 只观察 desktop `desktop-continuous` 本地链路，不修改业务实现，不触发手机 `/remote` 的 replayable 恢复边界。

### 状态与操作时序

```text
隔离 HOME 冷启动
  OAuth 未登录；当前 Environment 只有 custom DeepSeek
                 |
                 v
用户点击 BigModel 登录 ----> OAuth callback
                 |                |
                 |                +--> setUser，App/workspace 开始挂载
                 |                +--> Account Overlay 刷新
                 |                +--> 当前 Environment Registry 重建
                 |                                  |
                 v                                  v
直接打开 Subagent 设置                    Model Selection View 出现 GLM-5.2
                 |                                               |
                 +----------------+-----------------+
                                  |
                                  v
                    workspace configOptions 投影就绪
                 |
                                  +--> custom DeepSeek：effort 可选
                                  `--> Coding Plan GLM-5.2：无需重启即可展示 effort
```

缺陷链路中，OAuth 回调已经完成，但 workspace `configOptions` 的状态仍未收敛，Subagent 把 readiness 当成 UI 门禁而无限 loading。当前边界是：Provider 与 Model 的事实均由当前 Environment 的 Effective Config 和 Registry 产生；renderer 只消费 Model Selection View 及其会话投影，不维护可反向覆盖 Registry 的 App 快照。E2E 分别验证登录完成后的控件可用性，以及 workspace `configOptions` 最终进入 `ready` 并包含 Coding Plan reasoning 档位。

### 验证条目

| 编号      | 验证项                                       | 有效性说明                                                           |
| --------- | -------------------------------------------- | -------------------------------------------------------------------- |
| AUTH-04-A | OAuth token、用户信息和 Coding Plan 配置完成 | 排除“登录回调尚未结束”造成的瞬态 loading                             |
| AUTH-04-B | Model Selection View 出现 GLM-5.2 reasoning  | 证明当前 Environment 的账号约束与模型配置已经生效                    |
| AUTH-04-C | workspace 投影从未就绪状态收敛               | 证明 UI 不会因为 `configOptionsStatus` 的过渡状态永久阻塞            |
| AUTH-04-D | 自定义 DeepSeek effort 可选                  | 证明已有 Runtime 明确能力仍正常驱动 Subagent 控件                    |
| AUTH-04-E | Coding Plan effort 无需重启即可用            | 证明登录后的 Account Overlay 与 Model Selection 刷新能被当前页面观察 |
| AUTH-04-F | `configOptions` 最终出现 GLM-5.2 high/max    | 独立证明当前 Environment 的 Host/Worker Registry 与会话投影最终一致  |

### Fixture 合同与边界

- manifest 使用 `providerRequestPolicy: "none"`、`noProviderRequests: true`，不会向模型 provider 发送请求。
- 共享 Coding Plan HTTP mock 在每次 `beforeSession` 中按当前 worker spec 重置 case mode；只有本 spec 启用 OAuth token、`/api/v2/releases/latest`、`/api/v1/client/configs` 和 Start Plan balance 响应。随后运行的其它 Coding Plan E2E 会先恢复默认模式，不继承该目录行为或 OAuth 状态。
- Desktop OAuth polling 路径下，case-local mock 固定返回 `/api/v1/oauth/cli/init` flow，`/api/v1/oauth/cli/poll/:flowId` 保持 pending；case 继续通过 deep link 完成登录，避免把 polling 完成语义与本用例的 catalog 断言耦合。
- `release/latest` 登录前后返回不同的 `config_version`；带版本的 `client/configs` 按请求版本返回不可变目录，避免客户端旧版本缓存被当前 OAuth 状态静默替换为新目录。
- `client/configs` 固定下发 `builtin:bigmodel-coding-plan/GLM-5.2` 以及 `high`、`max`、`nothink` 三档 reasoning metadata。
- 当前 case 分别断言登录后 UI 可用与当前 Environment 的 Model Selection 会话投影最终一致；正式 spec 由默认 desktop E2E 根目录收集，矩阵标记为 covered。

### 自动运行记录

- `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e:serial -- --spec ./test/e2e/manual-review/pending/subagent-coding-plan-login-catalog-stale.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Runtime 证据：`workspace/readState` 返回 `modelCount=5`，renderer workspace catalog 包含 `builtin:bigmodel-coding-plan/GLM-5.2` 及其 reasoning 档位，Subagent effort 控件为 supported。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-070650-011/summary.md`。
  - Provider capture 没有模型请求，符合 `providerRequestPolicy: "none"`。
- 隔离回归：同一 WDIO run 中先执行 AUTH-04，再执行 `coding-plan-team-usage.test.ts`。
  - 结果：通过，2 个 spec / 19 个 case passed；后续 18 个普通 Coding Plan case 全部恢复默认 Team Plan mock 状态。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-102158-548/summary.md`。
- 转正后正式路径：`pnpm --filter @zcode/desktop test:e2e:serial -- --spec ./test/e2e/subagent-coding-plan-login-catalog-stale.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed；首次通过率 100%，无 flaky 或 infra failure。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-103737-817/summary.md`。
- Review 优化后重跑正式路径：登录前后使用不同 `config_version`，带版本目录保持不可变。
  - 结果：通过，1 个 spec / 1 个 case passed；首次通过率 100%，无 flaky 或 infra failure。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-114837-011/summary.md`。
- 2026-08-27 合并 `origin/staging` 并适配 Desktop OAuth polling mock 后重跑正式路径：catalog 保持 `loading` 且缺 GLM-5.2 时先验证控件 supported，再切到 `ready` 等待 runtime catalog 出现 Coding Plan `high` / `max`。
  - 结果：通过，1 个 spec / 1 个 case passed；无 provider request。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260827-103453-349/summary.md`。

### 转正说明

该 case 已从 `manual-review/pending` 移入正式路径。它不发送模型请求，不依赖 provider replay，也不属于 conversation Docker preset；正式准入以 case manifest 的 `providerRequestPolicy: "none"`、本地正式路径运行和默认 desktop E2E 收集为边界。

<!-- 以下 AUTH-06 场景与运行记录来自固定 staging，运行编号不是 Todo103 本轮结果。 -->
## AUTH-06: 用户资料 access token HTTP/业务 401 复用退出提示

- 候选 spec：`packages/desktop/test/e2e/manual-review/pending/access-token-401-auto-logout.test.ts`。
- manifest：`packages/desktop/test/e2e/fixtures/cases/auth-config/access-token-401-auto-logout.json`。
- 输入：隔离 HOME 的 BigModel 旧版用户资料缓存、不同值的业务 access token 与未被判定过期的 ZCode JWT，以及一个独立 Bot 凭据。
- 动作：启动资料迁移真实发出 userinfo 请求；本地 HTTP fixture 暂停响应，待 UI 可用后返回 HTTP 401，或通过 `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200` 返回 HTTP 200 + `{"code":401,"msg":"登录状态已过期","success":false}`。用例确认 fixture 实际启用的状态码；其它控制面请求返回正常 200，避免 JWT 401 掩盖新增判断。
- 断言：fixture 确认请求用的是业务 token；原过期弹窗出现；确认前 active/token/profile/JWT 已清除且 Bot 凭据保留；确认后经 preload 发出原 RelaunchApp 命令。测试在主进程 IPC 边界截断命令，不实际执行退出/重启，避免 Host 关闭屏障干扰 WebDriver 收尾。
- HTTP fixture 不记录凭据原文；不访问真实平台，不需要模型请求。支付、API key、旧请求与多平台判定由服务层单测覆盖。
- desktop local 的 HTTP/Host/Renderer 链路必须自动运行通过；人工验收、手机 shared-host 与跨平台 UI 回归未完成前保持 pending，不宣称完整多端验证。

```text
隔离旧缓存 -> 后台 userinfo 请求 -> fixture 暂停
                                      |
                             测试放行 HTTP 401
                                      |
                     当前 access token 匹配 -> 原 logout
                                      |
                        清凭据 -> 弹窗 -> 确认重启
```

### AUTH-06 自动验证记录（2026-09-08）

- 服务层先在原 JWT 判断上复现 4 项失败；增加匹配后，凭据分类及既有 API client 回归共 41 项通过，另有 4 项原 OAuth logout/资料迁移清理回归通过。
- Electron E2E 最终 1/1 通过，运行 ID：`desktop-e2e-20260908035743975-p37710-5701199aa046d5f2`。最后一次仅调整测试的 IPC 截断点，复用此前同一业务源码构建的产物（`ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1`）。
- 首轮并行类型检查覆盖 Host 构建输出导致启动失败；分开执行后定位到测试 mock 重启仍执行 Host 关闭屏障，引发 WebDriver 收尾超时；改在 IPC 边界记录命令后完整通过。业务实现未因这些测试环境问题扩展范围。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint` 均通过；Lint 有 43 条既有警告，新增文件专项检查为 0 警告/0 错误。
- 当前 fixture checker 不支持 auth/config pending spec，命令返回不支持该目录；不将此结果计为 fixture 校验通过。
- macOS arm64，测试 runner Node 24.12.0，Electron 41.0.3 内置 Node 24.14.0。未验证真实平台失效响应、Windows/Linux、手机 shared-host UI 或人工视觉验收。

## 帮助配置迁移 HC-01～HC-05

正式用例：`help-client-config.test.ts`（8 个 case），来源 staging 已经用户授权转正，保留默认 desktop E2E 收集。
覆盖真实帮助菜单、中英文链接、成功缓存、同语言默认值、内置反馈弹窗、跨 endpoint
反馈地址、HTTP/业务/JSON 失败恢复，以及窄屏 Chromium Web 重载后的 HTTP cache 行为。
使用 case-local HTTP fixture；无模型请求。历史验证不计成本轮通过。
详细覆盖矩阵、剪枝、fixture 合同见 [帮助配置验证](help-client-config-e2e.md)。
Todo103 本轮运行证据记录在 staging-integration ledger。

### AUTH-06 SG-01 回归补充（2026-09-09）

- 服务层：受控凭据读取与刷新写回，覆盖“初步分类读到旧 token 后同平台 token 已更新”、队列中的条件退出、过期刷新不得复活退出会话。
- Electron：重跑既有隔离 AUTH-06，验证当前 token 的真实 Host userinfo 401 仍完成原凭据清理、Bot 独立、唯一提示和确认重启命令。精确的读取/入队竞态由上述服务层测试覆盖，未将其记作 Electron 并发场景覆盖。
- 沿用现有 pending case 与合成凭据，不使用真实平台或用户文件。
- 最终验证：`pnpm exec vitest run packages/services/test/oauthUnauthorizedLogout.test.ts packages/services/test/oauthUnauthorizedRequest.test.ts packages/services/test/nodeApiClient.test.ts packages/services/test/nodeApiClientEndpoint.test.ts packages/services/test/oauthService.test.ts`：148/148 通过，含 9 项新竞态/通知回归。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 为 46 条既有警告、0 错误。
- `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/manual-review/pending/access-token-401-auto-logout.test.ts`：最终代码重新构建 App/Agent 后 1/1 通过，未设置 skip build。制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260909071607852-p66392-b7f49a248cd9bd36/summary.json`。
- macOS arm64；保留现有 IPC 拦截以验证 RelaunchApp 命令，不执行真实进程重启。手机 shared-host、Windows/Linux 和真实平台响应未补跑。

- 跟进审查基线检查后，已 rebase 到 `a1fcf91ec11ab34d263b6347bc704b5dd09ac016`；WDIO 冲突保留新增的安全校验 fixture 与认证 fixture 两个按 case 启用的入口。rebase 后再次通过上述 148 项单测、typecheck、E2E typecheck、lint 和 architecture 检查，App/Agent 重新构建后 AUTH-06 为 1/1 通过。最新制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260909072706868-p75427-b55cce637bf05b15/summary.json`。

### AUTH-06 CR-01 URL 配置回归（2026-09-09）

- 新增 25 项 URL 边界测试：BigModel/ZAI 非法、相对、非 HTTP(S) 与空白配置；坏候选不影响有效候选；无效请求与全部候选非法；无关配置不参与 userinfo 分类；原 JWT 分支保持兼容。实现前 13 项失败，修复后分类器测试 51/51、上述五个服务测试文件合计 173/173 通过。
- 运行真实 NodeApiClient/helper 的合成凭据探针：无效业务 base + 有效 userinfo、无效 userinfo + 有效 customerInfo 均保留 HTTP 401，并各触发一次失效回调。未请求真实平台或读取用户凭据。
- `pnpm typecheck`（含 Desktop E2E）、`pnpm lint`（46 条既有警告、0 错误）、`pnpm architecture:check -- --changed`（0 violations）通过。
- 重新构建 App/Agent 后运行上述 AUTH-06 命令，1/1 通过；制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260909081228959-p89316-72990aef331d8ad0/summary.json`。异常配置分支由服务测试覆盖，Electron 验证正常 401 交互链路；保留前述 pending、macOS 与重启 IPC 拦截边界，手机 shared-host/Windows/Linux 未补跑。

### AUTH-06：HTTP 200 业务 401 回归（2026-10-08）

- 原因：业务登录过期返回 HTTP 200 + JSON 数值 code=401，旧请求观察器没有进入退出与重启提示链路。身份、企业定价、团队订阅详情复用同一当前凭据白名单及会话队列复核。
- 服务层 8 个相关测试文件 260/260 通过；覆盖 BigModel/ZAI 三接口、并发仅一次清理/通知、重新登录/刷新后旧响应不清理新会话、原响应正文可读、空/损坏正文及 SSE 不误判。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`（68 条其它文件既有警告、0 错误）、`pnpm architecture:check --changed`（0 violations）、变更代码格式检查通过。
- pending replay 需显式传入 `E2E_PROVIDER_HTTP_MODE=replay` 和 `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json`，再以 `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200` 或 `401` 运行本用例；没有模型请求。fixture checker 当前只支持 conversation-session/plugin，不支持此 auth-config 路径；AUTH-06 manifest 保持无模型请求声明。
- HTTP 200 + 业务 401：重新构建 App/Agent 后 1/1 通过；制品 `packages/desktop/.e2e-artifacts/desktop-e2e-20261008081902034-p54677-f19c52bf23b72057/summary.json`。
- HTTP 401：复用上一次相同源码的 App 产物（`ZCODE_E2E_SKIP_BUILD=1`）、重新构建 Agent 后 1/1 通过；制品 `packages/desktop/.e2e-artifacts/desktop-e2e-20261008082005216-p55748-74de9060da312d0b/summary.json`。
- 两次均验证确认前凭据清理、Bot 凭据保留、唯一原过期弹窗及确认后 RelaunchApp 命令。沿用 IPC 拦截，不声称实际进程重启；macOS arm64 验证，手机 shared-host、Windows/Linux 未实机回归。复用原 UI、广播及重启动作，不改 continuous/replayable 边界；用例保持 pending。

## HM-01～HM-04：帮助菜单应用入口

用户于 2026-09-16 确认转正。正式用例 `packages/desktop/test/e2e/help-menu-about.test.ts`，默认 desktop E2E 收集 Preview 分支，production 使用 `ZCODE_E2E_HELP_MENU_FLAVOR=production` 与 production 构建单独运行。HM-02 对下载完成状态分别验证动作文案和版本 pill，关闭重开后再次验证版本。共 4 个 case，覆盖草稿页/设置页、中英文关于窗口、更新状态及禁用/重开、真实开发包检查更新回执和 Preview 隐藏。无模型请求，无 provider replay fixture 依赖；合成更新事件仅用于菜单状态展示。完整矩阵和运行命令见 [桌面帮助菜单](../windows-caption-help-menu.md)。

## AUTH-07: OAuth 回调与轮询完成竞态（pending）

- Spec：`packages/desktop/test/e2e/manual-review/pending/oauth-completion-race.test.ts`。
- Fixture：`helpers/oauth-completion-race-fixture.ts` 启动本地 HTTP，init 后真实 Host 轮询；
  preload 回调启动 token 兑换并挂起，poll ready 返回后才释放 token HTTP 500。
- 先挂起一次兑换并通过 UI 取消，释放兑换成功响应；等待 Host 回调完成后确认未登录、无错误，再重新发起登录。
- 断言：客户端继续用 polling 凭据登录、登录面板退出、无失败提示、归因参数保留；
  再投递同 state 迟到回调，更新归因且 token 请求次数仍为 1。
- 无模型请求，无真实第三方登录。浏览器打开用 Electron mock 拦截，Host OAuth 服务保持真实。
- 两种先到顺序、双失败、取消和旧响应由服务层受控 Promise 测试覆盖；此 E2E 仅覆盖桌面
  local 的用户可见回退，不宣称覆盖手机 shared-host 或 Windows。保持 pending，等待人工 review。

### AUTH-07 本次验证（2026-09-17，macOS）

- Electron E2E：通过；产物 run id `desktop-e2e-20260917065456399-p21750-95ee455f2fa5007d`。
  使用本分支已构建产物，最后一次重跑仅修改 fixture，跳过重复 App/CLI 构建。
- Host 日志证实 `/oauth/token` 500 后 `oauth.pollPendingOAuth` 和 `oauth.handleCallback` 正常返回；
  断言加密落盘的业务 token、归因字段、登录面板退出及迟到回调不再兑换均通过。
- OAuth 服务测试 109 项、UI/桥接边界测试 38 项通过。服务层及 E2E 类型检查、lint、架构门禁通过。
- 全仓 `pnpm typecheck` 被基线 `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts` 重复键
  TS1117 阻塞；两文件本分支未改动。fixture checker 当前不支持 auth-config pending 目录，
  无模型请求 manifest 已保留，未进行 promotion/CI admission。手机、Windows/Linux 未实测。

### !2703 Suggestions 回归（2026-09-17，macOS）

- SG-01：manifest 指向实际 pending spec 路径。
- SG-02：服务声明 nullable 回调，Root 忽略失效结果；单测复现原 TypeError 后验证修复。
  E2E 先取消挂起兑换，再放行成功响应，确认凭据未替换、无登录错误；随后重新登录完成原回退场景。
- SG-03：双路径均失败时分别保留原错误，两种到达顺序均验证。
- SG-04：可控时钟验证 pending 和成功后窗口内接收的回调即使排队超过 30 秒仍保存归因，
  窗口外的新回调拒绝；未增加处理时刻的过期判断。
- 相关单测 151 项通过；服务/E2E 类型检查、lint、架构门禁通过。全仓类型检查仍仅有上述基线 TS1117。
- Electron E2E 通过（1 case），run id `desktop-e2e-20260917074228667-p30511-55b50bde685ed92b`。
  首轮重新构建 App，修正测试日志路径和预置账号断言后复用同一构建重跑。

### 最新 staging 基线复验

- 已 rebase 到 `origin/staging` 的 `c7a795d2df`，旧基线的翻译重复键已不存在。
- 全仓 `pnpm typecheck`、lint（0 errors / 54 warnings）、架构门禁及 151 项相关单测通过。
- 重新构建 App 后 AUTH-07 通过，run id `desktop-e2e-20260917075008349-p32477-57ae7b5093a2bbd0`。

## PAT-KEY-UPGRADE：有效登录态与坏旧 Key 共存

候选用例：`packages/desktop/test/e2e/manual-review/pending/account-key-usage-scene.test.ts`。
复用该文件 Z.AI 恢复用例：在隔离 HOME 的 credentials.json 中保存有效合成 OAuth 与账号资料，同时将同账号 account-provider:*:api-key 写为损坏密文；重启 Electron，要求直接恢复工作区，Host 创建 usageScene=1 的专用 Key 并签发 Token，不调用 Copy，原坏旧记录保持不变。BigModel 用例覆盖无旧 Key 的创建/换证路径。
此用例不触发模型推理；HTTP 为既有本地 Coding Plan mock，不代表真实后端联调。手机/远程链路由 Provisioning 与鉴权服务测试覆盖，本轮不宣称设备级远程 E2E。保持 pending，不自动转正。

本轮自动复测：2026-09-23，2 cases passed；artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260923070315610-p85476-12717808333f5136/summary.md`。未进行人工确认或转正；手机、真实后端及混版本远端不在本 case 范围。

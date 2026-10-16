> **Todo103 / G09：保留为历史审计，不是当前重构契约。** 本文来自 staging 提交
> `846b31c21b`，下文的“当前”均指 `baffd62dcf`。代码链接/行号也只对应该基线；
> 查证旧文件请用 `git show baffd62dcf:<仓库相对路径>`，不能把当前分支的同名文件
> 当成原证据。旧 model-provider / preset / family 路径已由当前 Account、Provider
> Runtime 和 Model Selection 边界替代，不据本文恢复旧接口。G09 的 401 修复见
> [当前契约](../oauth/jwt-401-auto-logout.md)，包括队列内凭据复核及 accountIdentity 清理。
> 本文列举的 CLI、MCP、加密、跨进程事务等既有问题不因合并自动转成修复任务。
> 单连接过渡态及 Todo101 延期裁决不变。以下原审计内容和验证记录原样保留，
> 不计作 Todo103 当前代码验证通过。

# credentials.json 凭据与生命周期代码梳理

审计日期：2026-09-08。代码基线：`baffd62dcf7e5762b24bee9d0003128793101a11`（`origin/staging`）。

本文记录该基线的代码事实，供后续检查和修复使用；不代表文中问题已经修复。示例和运行验证均使用合成凭据，不包含真实 token、用户资料或解密后的本机数据。文内源码链接从 `docs/analysis/` 出发，行号对应上述基线。

阅读顺序：存储与权限边界 → OAuth 字段及消费者 → CLI/MCP 生命周期 → Bot/远端/relay → [审计结论与验证记录](#审计结论与验证记录)。

## 范围与已对齐规则

App 的 ZAI、BigModel 登录互斥：登录完成必须清理旧平台登录凭据，只保留当前平台的登录状态与新 JWT。`zcodejwttoken` 是当前 App 会话的共用字段，并非每个平台各持有一份的凭据。

据此，删除旧 JWT 本身不是问题。检查点是旧登录是否清理完整、新凭据是否来自同一次登录、退出后是否还有 active provider 或登录凭据残留。取消流程也不能未经确认就按“恢复旧 JWT”修复。

```text
当前平台会话
    |
    +-- 新登录完成 --> 清理旧登录凭据 --> 当前平台的新会话
    |
    +-- 退出登录 --------------------> 无 App active provider / 登录凭据

其它凭据域：MCP 授权 / Bot / 远端连接 / relay 设备认证
    `-- 各自具有更新、失效与删除流程；当前 App logout 不清空整个文件
```

单平台规则作用于 App 登录身份。MCP、Bot、SSH、relay 凭据也保存在同一个文件中，但当前代码没有把它们纳入 App 登录切换的全量删除范围。是否新增账号绑定清理策略是另外的设计决策。

## 存储实现与访问边界

### 文件位置

| 入口                   | 路径规则                                                                                                                              | 代码依据                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Desktop / Node service | `{dataBaseDir}/.zcode/v2/credentials.json`                                                                                            | [credentialService.ts](../../packages/services/src/credential/credentialService.ts#L27)             |
| service 的 dataBaseDir | `setDataBaseDir()` 覆盖值 > 模块初始化时读取的 `ZCODE_DATA_BASE_DIR` > `HOME` > `os.homedir()`；前三项去除首尾空白                    | [paths.ts](../../packages/services/src/paths.ts#L57)                                                |
| CLI / MCP shared store | 显式 `filePath` 优先；否则 `{baseDir ?? env.ZCODE_DATA_BASE_DIR ?? os.homedir()}/.zcode/v2/credentials.json`；支持 `~`、`~/` 和绝对化 | [shared-credentials.ts](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L257) |

因此“共用文件”的前提是两端解析出的数据目录相同。CLI 不调用 App 的 `setDataBaseDir()`，空白路径的处理也不完全相同；不能仅凭文件名推断所有进程使用同一文件。

### 访问者与真正的持久化位置

```text
Desktop renderer
    `-- hook / RPC --> ICredentialService（Host） --------+
Desktop main 的 relay / telemetry service --------------+--> 本机凭据文件
CLI login / MCP --> SharedZCodeCredentialStore -----------+
                         （解析到同一路径时共用）

SSH / WSL / Docker workspace
    `-- 本机 OAuth / credential service --------------------> 本机凭据文件

Server remote
    `-- connectionServices.credentialService RPC -----------> Server 的凭据文件

浏览器自身 OAuth
    `-- BrowserOAuthCredentialRepo --------------------------> localStorage
        pending nonce --------------------------------------> sessionStorage
```

- `ICredentialService` 公开 `load/save/delete`；UI 使用 `useCredentials()` 等 hook。泛用存储层不理解 OAuth provider、账号或 workspace，只接受 key/value。[接口](../../packages/services/src/credential/credential.ts#L11)、[hook](../../packages/ui/src/hooks/useCredentials.ts#L8)。
- 本地服务在 `createLocalServices` 中创建并注册 credential service；Desktop main 还为 relay 和 telemetry 创建同种文件服务，因此不能将其描述成只有一个 Host 实例访问文件。[services/node.ts](../../packages/services/src/node.ts#L1213)、[main/index.ts](../../packages/desktop/src/main/index.ts#L675)。
- SSH/WSL/Docker workspace 服务集合显式创建本机 credential/OAuth service；Server remote 则转接连接目标的服务。这是两个不同的归属边界。[remoteWorkspaceServiceCollection.ts](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L83)、[Server 分支](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L315)。
- 浏览器 OAuth 虽然复用 `oauth:active_provider`、`zcodejwttoken`、`oauth:zai:*` 名称，但其本地存储不是 `credentials.json`。浏览器自己的登录状态与已连接 Host 的服务应分别追踪。[browserOAuthCredentialRepo.ts](../../packages/web/src/auth/browserOAuthCredentialRepo.ts#L11)。
- 本文不改变桌面 continuous 或手机 replayable 的消息恢复边界；凭据归属不能据此推导为另建手机 Agent/runtime。

### 文件格式、加密和兼容

顶层是 `Record<string, string>`。复杂值先序列化为 JSON 字符串，再对整个 value 加密；键名仍以明文保存。文件没有顶层版本、全局账号 id 或 token 类型标签，语义由各 key 的调用方决定。

```text
业务值 / JSON 字符串
    --> AES-256-GCM
    --> "enc:v1:<base64url(iv)>.<base64url(authTag)>.<base64url(cipherText)>"
    --> credentials.json[key]
```

| 项目             | 当前行为                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 算法             | AES-256-GCM；12-byte 随机 IV，16-byte auth tag                                                                          |
| 密钥             | `SHA-256(secret)`；优先 `ZCODE_CREDENTIAL_SECRET`，否则使用 `zcode-credential-fallback:<platform>:<homedir>:<username>` |
| Desktop/CLI 差异 | Desktop 原样使用非空环境变量；CLI 先 `trim()`，只含空白时回退默认值                                                     |
| 旧明文           | 不以 `enc:v1:` 开头的值直接返回，不会因一次读取自动重新加密                                                             |
| 普通读取         | key 不存在返回 `null`；文件不存在视为空对象                                                                             |
| 损坏文件         | JSON/schema 非法时保留按内容 hash 命名的 `.corrupt-<hash>.bak`，再抛错；禁止按空对象覆盖                                |
| 解密失败         | Desktop 抛结构化 credential decrypt error；CLI cipher 抛普通 `Error`。业务层决定是否清理 OAuth 会话                     |

代码依据：[Desktop cipher](../../packages/services/src/credential/providers/credentialCipherProvider.ts#L6)、[CLI cipher](../../apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts#L4)、[schema](../../packages/shared/src/validation.ts#L365)、[备份](../../packages/shared/src/node/privateFilePersistence.ts#L109)。

当前默认密钥由系统信息推导，不是操作系统钥匙串托管的随机密钥；AES-GCM 格式不等于使用了 Electron `safeStorage`。若要改变密钥来源，需要单独设计旧密文迁移，不能只替换密钥推导函数。

两端对 `ZCODE_CREDENTIAL_SECRET` 的空白处理差异已使用真实 cipher 实现和合成值验证：普通字符串互相可解密；相同的含首尾空白字符串、相同的全空白字符串都使 Desktop/CLI 互相解密失败。修复时应同时考虑已按原规则写出的历史密文，避免为了统一新写入而让旧凭据失效。

### 原子写入不等于完整登录事务

两套 store 复用同一个跨进程文件锁及原子文件替换工具：

```text
同进程写请求排队
    --> <credentials path>.lock 目录锁
    --> 读取最新文件 --> 修改所需 key
    --> 同目录 0600 临时文件 --> rename 替换 --> 释放锁
```

锁有 owner、进程存活检查、失主回收和默认 8 秒等待上限；rename 对 Windows 常见占用错误重试。损坏备份也以 `0600` 创建。同平台权限语义仍取决于文件系统，不能把 POSIX mode 等同于 Windows ACL。[privateFilePersistence.ts](../../packages/shared/src/node/privateFilePersistence.ts#L46)、[atomicFileLock.ts](../../packages/shared/src/node/atomicFileLock.ts#L177)。

| 层次                         | 已有保证                                                               | 保证范围之外                                                         |
| ---------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Desktop `save/delete`        | 一次 key 变更覆盖完整 read-modify-write，不丢掉其它进程的独立 key 更新 | 一个登录内多个 `save/delete` 不是一笔跨进程事务                      |
| CLI `saveMany` / 登录保存    | 同一次回调内的多 key 变更一次发布                                      | 调用前网络、调用后 config 更新不在文件事务中                         |
| CLI 条件删除                 | `deleteIfValue`、`deleteManyIfValue` 在锁内比较旧值后删除              | 逐 key 的 `deleteIfValues` 不等于整组凭据条件删除                    |
| Desktop OAuth mutation queue | 串行同一个 OAuthService 实例的登录完成、退出等操作                     | 不是多个窗口、多个 Host、CLI 共享的登录级队列                        |
| 读取                         | 原子替换使读者通常看到某次完整文件；CLI `loadMany` 同次读取多个 key    | 多次独立 `load` 仍可能跨过其它进程的写入，不能自动认为是同一会话快照 |

代码依据：[Desktop store](../../packages/services/src/credential/credentialService.ts#L90)、[CLI store](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L88)、[OAuth 队列](../../packages/services/src/oauth/oauthService.ts#L366)。这是并发边界事实，不单凭它断言已有线上串号。

CLI 还导出 `loadSharedZCodeCredentialSync`：同步读取中发生任何错误都返回 `undefined`，不会按异步读取路径保留损坏证据。本次检索未发现生产调用者，不能将它描述为当前所有 CLI 读取的行为。[同步兼容入口](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L234)。

### 整个文件的删除与数据目录迁移

- **Clear All Data 是全文件删除入口。** Desktop 用户确认清除全部数据后，`clearAllDataAndRelaunch` 对传入的 `credentialsDir` 执行递归删除；该目录来自当前 `getAppConfigDir()`，默认是 `~/.zcode/v2`，也可跟随自定义数据目录。操作会一起移除该目录中的 App OAuth、MCP、Bot、远端连接、relay 等凭据与配置，而非仅清 OAuth 字段；随后清浏览器存储并重启。命令还调用购买 WebView 分区清理。这与普通 App logout 的定向删除不同，也不是删除远端 Server 的数据。[清除实现](../../packages/desktop/src/main/desktopCommandHandlers.ts#L162)、[目录来源](../../packages/desktop/src/main/desktopRuntimeEnv.ts#L81)、[命令分发](../../packages/desktop/src/main/desktopCommandHandlers.ts#L763)。
- **数据目录变更会复制凭据文件。** Setting service 调用 `copyDataDirectory` 将旧 `.zcode/v2` 复制到新位置。过滤器排除 `setting.json` 及其临时兄弟文件、符号链接，没有专门排除 credentials.json，也没有对其中的值解密再加密；该 helper 是 copy，不删除原目录。因此新路径解析成功不代表旧文件副本已经销毁，跨用户/系统复制还可能因密钥材料不同而无法解密。[调用方](../../packages/services/src/setting/settingService.ts#L452)、[复制实现](../../packages/services/src/paths.ts#L587)。

### 日志与归档边界

- RPC 中间件常规成功日志只记录频道、命令和耗时，不记录 credential 请求参数或返回值；失败日志附带错误对象。[logging-middleware.ts](../../packages/rpc/src/logging-middleware.ts#L40)。
- Desktop 日志导出按文件名排除 `credentials.json` 和 `.credentials.json`；反馈 fallback 归档使用包含 `credentials.json` 的路径匹配。其它业务日志仍应逐调用方检查，不能由这两处推导为所有 token 都不会进入日志。[Desktop 导出](../../packages/desktop/src/main/exportLogs.ts#L716)、[反馈归档](../../packages/services/src/feedback/compactLogArchive.ts#L15)。

## OAuth / ZCode 平台登录凭据：代码事实

本章的“平台”指 Z.AI / BigModel 身份域，不指 macOS / Windows / Linux。

### 已确认的单平台约束与现有实现

本次梳理采用用户确认的规则：**登录清理所有旧平台 JWT，登录完成后只允许一个平台身份生效。** 旧平台 JWT 不作为并存账号保留。用户尚未明确清理应发生在点击登录时，还是 ready/token 交换完成后的提交时；取消或失败时的旧会话处理也需随该提交边界明确，不能自行把“登录清旧”解释成“点击登录立即登出”。OAuth 清理范围与 SSH、bot、远控配对等独立凭据的生命周期分开定义。

现有源码已经把 `oauth:active_provider` 注释为“互斥 provider 域的唯一事实源”，成功落盘前也会清理相反平台；清理发生在完成 token 交换后的 `persistOAuthSession`，发起登录本身只替换 pending flow，取消落盘时还有恢复旧会话的 rollback。这些是当前时序事实；pending 阶段保留旧会话本身不能直接判为违反用户规则。正常成功路径会清理相反平台的命名空间字段，但不会清理 legacy `auth_token/refresh_token`，所以不能据此声称“全部旧平台凭据已经清空”。

依据：[oauthCredentialRepo.ts:172](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L172)；[oauthService.ts:374](../../packages/services/src/oauth/oauthService.ts#L374)、`:554`、`:791`。

```text
目标身份关系
  未登录
    -> 发起平台 P 登录
    -> 在明确的登录提交边界清理全部旧平台登录 JWT
       （点击时或 ready 提交时：尚未决定）
    -> P 登录完成：只保存 P 的平台业务 token + 当前 ZCode JWT
    -> oauth:active_provider = P

  任一时刻：Z.AI 身份 XOR BigModel 身份
  禁止：P 的 active provider + 另一平台的业务 JWT + 上一代 ZCode JWT

当前代码的成功路径
  startOAuth / startOAuthWithPolling
    -> 只创建或替换 pending flow，旧落盘会话仍可存在
    -> deep link 或 polling 取得新 token
    -> persistOAuthSession
       -> 暂存旧两域 token / profile / active provider（供 rollback）
       -> clearProvider(相反平台)：业务 token、refresh token、user_info、共享 JWT
       -> saveTokenSet(当前平台)：业务 token、可选 refresh token、新共享 JWT
       -> saveUserProfile(当前平台)
       -> saveActiveProvider(当前平台)
```

### credentials.json 中的字段

字段值通过 `ICredentialService` 保存为字符串；用户资料和归因先 JSON 序列化。凭据文件的加密、密钥、权限、锁及路径由存储章节说明。OAuth provider 类型允许扩展字符串，但当前内置域是 `zai`、`bigmodel`；已知损坏清理集合总是包含这两者，并可加入注册的其它 adapter ID。

依据：[oauth.ts:56](../../packages/shared/src/oauth.ts#L56)、`:132`；[oauthCredentialRepo.ts:13](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L13)、`:36`。

| key                            | 实际语义 / 数据来源                                                                          | 正常写入                                                                | 正常读取 / 清理                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth:active_provider`        | 当前 App 平台身份，内置值为 `zai` / `bigmodel`；不是 token                                   | 登录最后一步写入；由 `saveActiveProvider` 管理                          | 决定缓存恢复、模型/官方 MCP/空闲套餐使用哪个平台；active logout、all logout、损坏恢复删除                                                                                                                 |
| `zcodejwttoken`                | ZCode 后端 `data.token`；当前平台登录身份的共享 JWT，key 不按平台拆分                        | ZAI / BigModel adapter 交换后随 `OAuthTokenSet.zcodeJwtToken` 保存      | ZCode 业务、Start Plan、官方 MCP、反馈等；任一内置平台的 `clearProvider` 都会删除                                                                                                                         |
| `oauth:zai:access_token`       | **Z.AI 业务 token / MaaS 登录 JWT**：原始 Z.AI OAuth access token 经业务登录接口转换后的结果 | Desktop ZAI adapter 在 deep link 和 polling 两条路径都先转换再保存      | `/api/biz/*`、`/api/pay/*`、套餐项目和业务 API key 获取、官方 MCP 套餐身份、reset；退出或切换删除                                                                                                         |
| `oauth:bigmodel:access_token`  | **BigModel 业务 token / MaaS 登录 JWT**：后端响应的 BigModel 业务 access token               | Desktop BigModel adapter / polling 归一化后保存                         | BigModel customer、套餐、项目 API key 获取、官方 MCP 套餐身份、reset；退出或切换删除                                                                                                                      |
| `oauth:bigmodel:refresh_token` | BigModel 可选 refresh token，来源 `data.bigmodel.refresh_token` / `refreshToken`             | deep link / polling 有值则保存，无值则删除旧值                          | generic refresh 接口会读取，但内置 BigModel adapter 当前没有 refresh 实现；随平台清理删除                                                                                                                 |
| `oauth:zai:refresh_token`      | 通用 Repo 支持的同名字段；**当前 ZAI adapter 没有产出 refresh token**                        | 通用 `saveTokenSet` 可接收；正常 ZAI 登录会因缺少 refreshToken 删除旧值 | 当前无内置续期用途；随平台清理删除                                                                                                                                                                        |
| `oauth:zai:user_info`          | 用户资料 JSON；有 rawProfile 时按后端 `data.user` 原样保存                                   | 登录写入；读取时将 `user_id/name/email/avatar` 转为展示资料             | 缓存登录、账号 ID / 展示；不是 token；随平台清理删除                                                                                                                                                      |
| `oauth:bigmodel:user_info`     | 归一化用户资料 JSON，包含展示字段；登录保存时加当前 profile schema 标记                      | 登录 / legacy profile 后台迁移                                          | 缓存登录展示；不是 token；随平台清理删除                                                                                                                                                                  |
| `oauth:login_attribution`      | JSON：`channel_id`、`utm_source`、`utm_campaign`；不是 token                                 | 归因回调 / 带归因授权回调写入；只保存非空字符串                         | 读时只接受这三个字段，兼容旧 `{params, expiresAt}`；当前无 TTL，logout 不清理；无法解析或有效字段为空则删除                                                                                               |
| `auth_token`                   | 旧 BigModel access token key                                                                 | 当前 OAuth 正常登录不写；只保留历史兼容读取                             | `BigModelProviderAdapter.loadLegacyTokenSet` 与 `useAuthToken.getToken` 读取；`restoreSession` 回填命名空间 key；当前 OAuth logout / corrupt 清理不删除，`useAuthToken.clearToken` 对 BigModel 会特殊删除 |
| `refresh_token`                | 旧 BigModel refresh token key                                                                | 当前正常 OAuth 登录不写                                                 | BigModel legacy loader 兼容读取；正常 OAuth 清理及 useAuthToken.clearToken 都不删除它；不是当前命名空间字段的别名写入                                                                                     |

依据：[oauthCredentialRepo.ts:151](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L151)、`:226`、`:284`、`:292`、`:321`、`:398`、`:415`；[bigmodelProviderAdapter.ts:196](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L196)、`:274`；[zaiProviderAdapter.ts:364](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L364)；[oauthService.ts:476](../../packages/services/src/oauth/oauthService.ts#L476)、`:753`；[useCredentials.ts:28](../../packages/ui/src/hooks/useCredentials.ts#L28)。登录保存对 profile 的 schema 处理入口见 [oauthService.ts:420](../../packages/services/src/oauth/oauthService.ts#L420)。

`OAuthTokenSet` 类型有 `expiresAt`，ZAI adapter 也会从后端 `expires_in` 计算它；**OAuthCredentialRepo 不保存 expiresAt，也不在 loadTokenSet 中还原它**。不要在字段清单里凭类型添加 `oauth:*:expires_at`。代码依据：[oauth.ts:132](../../packages/shared/src/oauth.ts#L132)；[zaiProviderAdapter.ts:389](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L389)；[oauthCredentialRepo.ts:292](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L292)、`:321`。

Desktop 正常登录中的以下值不存入 credentials.json（CLI 当前落盘原始 ZAI OAuth token 的偏差另见 CLI 章节）：一次性授权 `code/authCode`、`state`、polling 的 `flowId/pollToken/expiresAt`，以及转换前的原始 ZAI OAuth access token。pending 数据只在 `OAuthService.pendingState` 中；业务 token resolver 的缓存只在 adapter 实例内存中。依据：[oauthService.ts:43](../../packages/services/src/oauth/oauthService.ts#L43)、`:568`、`:638`；[zaiBusinessTokenResolver.ts:17](../../packages/services/src/providers/zaiBusinessTokenResolver.ts#L17)、`:35`。

### 三种凭据不能混用

1. **ZCode JWT**：`zcodejwttoken`，标识 ZCode 当前登录身份。
2. **平台业务 token / MaaS JWT**：`oauth:<platform>:access_token`，标识对应平台的业务登录身份，用于业务接口和套餐身份校验。
3. **模型 / Coding Plan / Team Plan API key**：用于模型与 monitor 请求，可通过业务 token 调业务接口取得，但不是该业务 token 本身。

ZAI 的业务 token 可能本身就是 JWT，并且代码明确允许它与 ZCode JWT 的字符串相等；判断应依据来源、字段和消费者，不应只靠 token 外形或相等性。BigModel 则有针对历史误写的专项防御：若 `oauth:bigmodel:access_token === zcodejwttoken`，套餐入口拒绝使用该旧污染状态。

依据：[modelProviderService.ts:968](../../packages/services/src/model-provider/modelProviderService.ts#L968)；[bigmodelCodingPlanSubscriptionProvider.ts:813](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L813)；[official-mcp-auth.ts:15](../../packages/shared/src/official-mcp-auth.ts#L15)。

App 模型配置读取/序列化 `config.json` 的 `provider[id].options.apiKey`；显式刷新 Coding Plan key 才通过业务接口获取真正 API key，普通 preset 同步不把 ZCode JWT 当 Coding Plan API key。`model-provider:<id>:api-key` 当前写入 CLI workspace model catalog 的内存 secrets Map，不是 credentials.json 持久化键，详见 CLI 章节。

依据：[modelProviderServiceStorage.ts:93](../../packages/services/src/model-provider/modelProviderServiceStorage.ts#L93)、`:942`、`:1137`；[oauthPresetProviderRepo.ts:535](../../packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts#L535)。

### token 的来源与转换链路

```text
Desktop ZAI deep link
  浏览器授权 code + state
    -> POST ZCode /api/v1/oauth/token
       body = { provider: "zai", code, redirect_uri, state }
       data.token ---------------------------> zcodejwttoken
       data.zai.access_token（原始 OAuth token）
          -> POST ZAI /api/auth/z/login
             body = { token: 原始 OAuth token }
             data.access_token / accessToken -> oauth:zai:access_token（业务 token）
       data.user ----------------------------> oauth:zai:user_info

Desktop BigModel deep link
  浏览器 authCode/code + state
    -> POST ZCode /api/v1/oauth/token
       body = { provider: "bigmodel", code, redirect_uri, state }
       data.token ---------------------------> zcodejwttoken
       data.bigmodel.access_token/accessToken -> oauth:bigmodel:access_token
       data.bigmodel.refresh_token/refreshToken -> 可选 refresh_token
    -> BigModel getCustomerInfo ----------------> user_info

Desktop polling（两平台共用完成落盘逻辑）
  客户端 random pollToken
    -> POST /api/v1/oauth/cli/init，Authorization: Bearer pollToken
    -> GET /api/v1/oauth/cli/poll/<flowId>，同一 pollToken
    -> ready.token + ready.<platform>.access_token + ready.user
       ZAI：仍先走业务 token 转换
       BigModel：读可选 refresh_token，直接使用业务 access token
    -> runPendingSessionCompletion -> persistOAuthSession
```

Deep link 的 BigModel access token 解析保留历史响应形状兼容：依次读 `data.bigmodel.access_token`、`data.bigmodel.accessToken`、`data.access_token`、`data.accessToken`；polling 分支只接受 `ready.bigmodel` 内的两种 key。BigModel 一次性 code 只交给 ZCode token 路由，不先去 `tokenByAuthCode` 消耗，也不在 Start Plan 查余额阶段用 access token 再兑换 JWT。

依据：[zaiProviderAdapter.ts:318](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L318)、`:364`；[zaiBusinessTokenResolver.ts:70](../../packages/services/src/providers/zaiBusinessTokenResolver.ts#L70)；[bigmodelProviderAdapter.ts:130](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L130)、`:301`；[oauthService.ts:554](../../packages/services/src/oauth/oauthService.ts#L554)、`:683`、`:729`；[bigmodelStartPlanZcodeJwt.ts:31](../../packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts#L31)。

端点由 runtime config 按环境构造，生产示例是 `zcode.z.ai`、`chat.z.ai`、`api.z.ai`、`bigmodel.cn`，测试环境和明确 env 覆盖会改变域名。不要把示例域名当唯一允许部署环境。依据：[zaiProviderConfig.ts:30](../../packages/services/src/oauth/providers/zaiProviderConfig.ts#L30)；[bigmodelProviderConfig.ts:25](../../packages/services/src/oauth/providers/bigmodelProviderConfig.ts#L25)。

### 主要消费者和真实认证头

| 消费场景                                        | 使用的凭据                                                               | 真实头 / 边界                                                                                                                                             | 代码依据                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZAI 业务套餐、项目、支付等接口                  | `oauth:zai:access_token` 业务 token                                      | `Authorization: <token>`，不添加 Bearer                                                                                                                   | [bigmodelCodingPlanSubscriptionProvider.ts:963](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L963)、`:1206`                                                                                                                           |
| BigModel customer、套餐和项目等业务接口         | `oauth:bigmodel:access_token`                                            | `Authorization: <token>`；检测旧 ZCode JWT 误写                                                                                                           | [bigmodelProviderAdapter.ts:245](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L245)；[bigmodelCodingPlanSubscriptionProvider.ts:813](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L813)、`:1197`            |
| ZAI adapter 的 userinfo 补偿请求                | `OAuthTokenSet.accessToken`，Desktop 当前已是转换后的业务 token          | `Authorization: Bearer <token>`，不是上述业务接口的裸头；已有 backend user 时优先复用资料                                                                 | [zaiProviderAdapter.ts:398](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L398)                                                                                                                                                                                     |
| ZCode billing preview / claim / Start Plan 余额 | `zcodejwttoken`                                                          | `Authorization: Bearer <JWT>`                                                                                                                             | [bigmodelCodingPlanSubscriptionProvider.ts:258](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L258)、`:322`；[bigmodelUsageQuotaProvider.ts:491](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L491) |
| Start Plan 模型运行配置                         | ZCode JWT 的当前运行时投影                                               | 当前 credentialService 的 JWT 覆盖旧 provider/runtime header；`Authorization: Bearer <JWT>`                                                               | [modelProviderService.ts:707](../../packages/services/src/model-provider/modelProviderService.ts#L707)、`:1163`、`:1215`                                                                                                                                                                |
| Coding Plan reset / reset history               | ZCode JWT + **所选 family 的业务 JWT**                                   | `Authorization: Bearer <ZCode JWT>`；`X-Bigmodel-Authorization: <业务JWT>`（裸 token），可带 organization/project/target type                             | [bigmodelUsageQuotaProvider.ts:673](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L673)、`:1045`                                                                                                                                                      |
| 官方 Server MCP 与其额度凭据解析                | ZCode JWT + 所选 Coding Plan family 的业务 JWT                           | `Authorization: Bearer <ZCode JWT>`；`X-Bigmodel-Authorization: Bearer <业务JWT>`；此处实际添加 Bearer，与 reset 不同                                     | [officialMcpCredentials.ts:216](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L216)、`:330`、`:382`；[official-mcp-auth.ts:22](../../packages/shared/src/official-mcp-auth.ts#L22)                                                                                 |
| Coding Plan monitor 用量 / Team Plan 用量       | 真正 Coding Plan / 项目 API key                                          | 使用所选 provider 或团队项目 API key；不能回退 OAuth、普通 API key、其它平台或环境变量                                                                    | [bigmodelUsageQuotaProvider.ts:708](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L708)、`:834`、`:853`                                                                                                                                               |
| Team Plan 项目 API key 获取                     | 对应 family 的业务 token                                                 | 先用业务登录身份获取具体 organization/project 的 API key；后者才用于团队模型/monitor                                                                      | [bigmodelUsageQuotaProvider.ts:869](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L869)                                                                                                                                                               |
| 空闲套餐运行                                    | ZCode JWT + Coding Plan API key                                          | `Authorization: Bearer <JWT>`；`X-Coding-Plan-Api-Key: <模型业务key>`；另带 ticket 与计划身份头。这里仍是 API key 通道，不能套用官方 MCP 的 MaaS JWT 规则 | [offPeakRuntimeModel.ts:251](../../packages/services/src/session/offPeakRuntimeModel.ts#L251)、`:403`                                                                                                                                                                                   |
| 反馈接口                                        | `zcodejwttoken`，存在时才添加                                            | `Authorization: Bearer <JWT>`；另有 `X-Device-Mid`                                                                                                        | [feedbackService.ts:76](../../packages/services/src/feedback/feedbackService.ts#L76)                                                                                                                                                                                                    |
| Repo snapshot 上传                              | 当前 active tokenSet；优先 ZCode JWT，当前代码缺失时回退平台 accessToken | 最终 `Authorization: Bearer <token>`；这是现存 fallback，是否允许须依据后端契约判断，不能仅凭 token 类型不同直接定为 bug                                  | [node.ts:1288](../../packages/services/src/node.ts#L1288)；[repoSnapshotUploadClient.ts:117](../../packages/services/src/repo-snapshot/repoSnapshotUploadClient.ts#L117)                                                                                                                |

官方 MCP 在解析时校验 `settings.providerFamilyDomain === oauth:active_provider`，并在异步解析结束再次核对身份快照和业务 JWT；空闲套餐也核对所选 family 与 active provider。两者避免不同代或不同平台凭据拼接。某些历史消费入口仍允许缓存 provider.apiKey 作为 Start Plan JWT fallback，或在没有 active provider 时读共享 JWT，不能据此推导“当前文件中任意 JWT 都有效”。

依据：[officialMcpCredentials.ts:222](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L222)、`:341`；[offPeakRuntimeModel.ts:251](../../packages/services/src/session/offPeakRuntimeModel.ts#L251)；[bigmodelStartPlanZcodeJwt.ts:18](../../packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts#L18)；[oauthPresetProviderRepo.ts:587](../../packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts#L587)；[bigmodelUsageQuotaProvider.ts:491](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L491)。

### Renderer 读取入口、购买鉴权与 WebView 副本

**`useAuthToken` 是 access token hook，不是 ZCode JWT hook。** `getToken()` 先查 active provider，再读 `oauth:<active>:access_token`；只有 active 为 BigModel 且命名空间 token 缺失时，才回退 legacy `auth_token`。`setToken()` 仅写 active 平台 access token；`clearToken()` 仅删除该 access token，BigModel 时额外删除 `auth_token`，不会删除 `zcodejwttoken`、refresh token、user_info 或 active provider。因此 `clearToken` 不是 OAuth logout，也不能作为“清全部旧平台 JWT”的实现。它是公开导出的 hook，当前仓库检索未发现函数调用点；这条事实说明存在的读写 API，不等于断言当前界面正在调用它。

依据：[useCredentials.ts:28](../../packages/ui/src/hooks/useCredentials.ts#L28)；[index.ts:43](../../packages/ui/src/hooks/index.ts#L43)；[index.ts:70](../../packages/ui/src/index.ts#L70)。

**购买页的 authenticated 是本地可用性判断。** `readCodingPlanPurchaseTokenState` 并行读取 active provider 与两个业务 access token，只将“active 恰好匹配 family 且该业务 token 非空”标为 authenticated，并映射到该 family 的 Coding Plan 和 Start Plan 入口。它不读 ZCode JWT、不检查 `exp`、不进行远端校验。`ModelProviderSection.refreshCodingPlanPurchaseTokenState` 中还有同样的本地判断。不能把这个布尔值解释为已经验证了平台 token、JWT 和套餐权益都有效。

依据：[codingPlanPurchaseAuth.ts:25](../../packages/ui/src/settings/model-provider-section/codingPlanPurchaseAuth.ts#L25)；[ModelProviderSection.tsx:648](../../packages/ui/src/settings/ModelProviderSection.tsx#L648)。

**购买 WebView 将 Host 凭据复制到独立持久分区 localStorage。** `getCodingPlanCredentialKeys` 对 ZAI 返回 `oauth:zai:access_token` 和 `zcodejwttoken`，对 BigModel 只返回 `oauth:bigmodel:access_token`。因此 BigModel 购买页并没有从这个注入入口取得共享 ZCode JWT。Dialog 从 credentialService 读取这些值，生成脚本注入当前可信购买页；它按购买目标 provider 选字段，注入函数本身不读取 `oauth:active_provider`，身份正确性依赖外围选择和旧凭据清理。

```text
Host credentials.json / CredentialService
  -> Renderer CodingPlanEmbeddedWebviewDialog.injectAuth
     -> 校验 webview 当前 URL 是可信 coding-plan 页面
     -> 读取目标 provider 的凭据
     -> 先清 webview localStorage 中三个凭据 key
     -> 写入当前 provider 对应值，派发 zcode-coding-plan-auth-ready
        ZAI:      zai access token + ZCode JWT；删 BigModel token
        BigModel: BigModel access token；删 ZAI token + ZCode JWT
     -> 官网使用当前分区凭据完成购买

持久分区: persist:zcode-coding-plan（独立于 App renderer / Web 浏览器存储）
```

可信检查针对**当前导航 URL**，不是只信任初始 src；离开可信页只执行该 origin 的清理，不注入 App 凭据。PayPal 的受信 `/coding-plan/payment/callback` 回跳通过同源 returnTo 规则继续允许注入。注入前清理和注入在同一次 `executeJavaScript` 中顺序执行。关闭时尝试清理三个 token key 和报告上下文，但 WebView 已销毁时允许失败；Root 主动 logout 和设置页 provider unlink 会另发 `ClearCodingPlanWebviewStorage`，Main 清整个持久分区；Clear All Data 也明确清该分区。

依据：[CodingPlanEmbeddedWebviewDialog.tsx:149](../../packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx#L149)、`:386`、`:540`；[codingPlanEmbeddedWebview.ts:60](../../packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts#L60)、`:124`、`:175`、`:257`、`:310`；[useRootWorkspaceActions.ts:298](../../packages/ui/src/root/useRootWorkspaceActions.ts#L298)、`:315`；[ModelProviderSection.tsx:1087](../../packages/ui/src/settings/ModelProviderSection.tsx#L1087)；[desktopCommandHandlers.ts:213](../../packages/desktop/src/main/desktopCommandHandlers.ts#L213)、`:763`。

购买完成消息用于关闭购买页并刷新当前 provider key/权益/团队项目，并不把购买网站的新 token 写回 credentials.json。依据：[CodingPlanEmbeddedWebviewDialog.tsx:340](../../packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx#L340)；[CodingPlanUpgradeDialog.tsx:52](../../packages/ui/src/settings/CodingPlanUpgradeDialog.tsx#L52)、`:66`、`:108`。

**legacy 清理的边界必须单列。** 当前正常 login 切换、`clearProvider`、OAuth logout、corrupt 恢复不删除磁盘旧 `auth_token/refresh_token`；只有 `useAuthToken.clearToken` 对 BigModel 的特殊逻辑会删除 `auth_token`，仍不删除旧 `refresh_token`。WebView 的三 key 清理也不是磁盘 legacy 清理。用户要求“清所有旧 JWT”时，应核定这些历史兼容字段的清理策略；不能只看到命名空间切换正确就宣称 legacy 已全清。

依据：[oauthCredentialRepo.ts:415](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L415)、`:432`；[bigmodelProviderAdapter.ts:274](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L274)；[useCredentials.ts:63](../../packages/ui/src/hooks/useCredentials.ts#L63)；[codingPlanEmbeddedWebview.ts:257](../../packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts#L257)。

### 有效期、刷新、401 和损坏恢复

**有效期。** 共享 `resolveJwtExpiration` 只解码 JWT 的 `exp`，不验证签名；默认提前 30 秒视为过期。缺 `exp`、格式异常等返回 `unknown`，继续交服务端判断。Desktop cached restore 读 active provider、user_info、共享 JWT；明确过期则在 mutation queue 中重新比对 generation/provider/profile/JWT，清当前登录和派生 provider，返回 `reauthentication-required: jwt-expired`。ZAI 缺 JWT 返回 signed-out；BigModel 当前未设置同样的缺 JWT 门槛，仍可从 user_info 恢复 authenticated。

依据：[oauth.ts:164](../../packages/shared/src/oauth.ts#L164)；[oauthService.ts:177](../../packages/services/src/oauth/oauthService.ts#L177)、`:253`、`:266`。

**刷新。** `OAuthService.refreshToken` 只有通用 adapter 扩展入口：要求 adapter 有 refreshToken、目标为当前 active provider、已有 refresh token，然后交换并保存。当前 ZAI / BigModel adapter 都没有实现这个方法，因此保存 BigModel refresh token 不等于实现自动续期，也不能保证平台业务 JWT 或 ZCode JWT 会续期。`ZaiBusinessTokenResolver` 的 5 分钟偏移只控制同一原始 OAuth token 转业务 token 的进程内缓存；它没有持久化，也不是后台登录续期器。

依据：[oauthService.ts:913](../../packages/services/src/oauth/oauthService.ts#L913)；[providerAdapter.ts:31](../../packages/services/src/oauth/providers/providerAdapter.ts#L31)；[zaiBusinessTokenResolver.ts:4](../../packages/services/src/providers/zaiBusinessTokenResolver.ts#L4)、`:44`、`:99`。

**401。** 审计基线的 Node API client 根据出站 `Authorization` 是否精确等于**当时本地当前** `Bearer zcodejwttoken` 来识别失效。2026-09-08 最小修复在此基础上增加当前 active 平台 userinfo/customerInfo 的业务 `access_token`（裸 token 或 Bearer），并限定当前环境的 origin/path；支付、API key 管理和其它业务路径不纳入新增判断。匹配后仍由 Host 去重执行 `oauthService.logout()`，清派生 provider，并广播 `auth:zcode-jwt-invalid`。该机制不刷新 token，不处理 HTTP 200 内的业务错误，也不自动覆盖 WebView 或 Agent transport。详细范围见 [401 自动退出 spec](../oauth/jwt-401-auto-logout.md)；实现见 [oauthUnauthorizedRequest.ts](../../packages/services/src/oauth/oauthUnauthorizedRequest.ts)。

`restoreSession` 是另一条主动联网校验路径：调用 provider userinfo；错误文本匹配 401/403/unauthorized/forbidden 时 logout，其它错误继续抛出。

依据：[nodeApiClient.ts:134](../../packages/services/src/providers/api/nodeApiClient.ts#L134)；[node.ts:1226](../../packages/services/src/node.ts#L1226)、`:1872`；[oauthService.ts:518](../../packages/services/src/oauth/oauthService.ts#L518)、`:1061`。

**解密损坏。** OAuthCredentialRepo 在 active provider、tokenSet、user_info 读取时捕获稳定 `CredentialDecryptError`：清两内置平台及其它注册平台的 access/refresh/user_info、共享 JWT、active provider，再通知清理派生模型 key；派生清理异常只记录 warn。该路径不删除 SSH、bot 等非 OAuth key，也不删除旧 `auth_token/refresh_token`、归因 key。model-provider 的 OAuth-aware 包装读取也复用此 Repo 行为。

归因 key 的解密失败只返回 null，不触发全账号登出。当前 cached restore 直接读 `zcodejwttoken`，绕过 Repo 统一恢复，单独 JWT 解密损坏仍会抛错，详见偏差表。

依据：[oauthCredentialRepo.ts:159](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L159)、`:241`、`:292`、`:346`、`:432`；[modelProviderService.ts:136](../../packages/services/src/model-provider/modelProviderService.ts#L136)；[oauthService.ts:206](../../packages/services/src/oauth/oauthService.ts#L206)。

### 注销、取消与并发边界

| 操作                         | 当前代码行为                                                                                                      | 对单平台约束的含义                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 发起普通登录                 | mutation queue 内清 pending，生成新 state；不清落盘登录                                                           | 当前以完成提交为清理时点；用户尚未决定是否提前到发起时                                     |
| 发起 polling 登录            | 增加 flow generation、替换 pending；init 异步返回时验证 generation                                                | 旧 init 不覆盖新 flow；不负责清旧落盘登录                                                  |
| deep link / polling 同时完成 | 同一 pending 共用 completionPromise；串行进入 mutation queue；交换前后和每段落盘前验证 pending 是否仍有效         | 避免重复完成、迟到登录写回；多 key IO 本身不是一次 OAuth 事务                              |
| 成功登录                     | 清相反平台命名空间及共享 JWT，再保存当前 tokenSet/profile/active provider                                         | 正常完成时有单平台意图；当前过程仍存在多次独立 IO 的中间状态                               |
| `logout()`                   | 查当前 active provider，清当前平台 access/refresh/user_info/JWT，再删 active；之后取消该平台 pending 并清派生 key | 不是扫描所有遗留平台字段的全量清理；active 缺失时不会删孤立 JWT                            |
| `logout(provider)`           | 只有参数等于 active provider 才清登录并通知派生清理；另外取消匹配 pending                                         | 非当前平台 unlink 不应误删当前共享 JWT；也不会主动扫除非当前遗留字段                       |
| `logoutAll()`                | 清所有已注册 adapters 对应平台，删除 active，取消 pending，清派生 key                                             | 范围由已注册 adapters 决定；与 Repo corrupt 清理总含两内置域不同                           |
| `cancelPending()` / timeout  | 使 pending 或 flow generation 失效；普通取消不直接清落盘旧会话                                                    | 不能把它理解为 logout；落盘中取消会进入当前 rollback，取消语义应随最终登录提交边界一起明确 |

依据：[oauthService.ts:367](../../packages/services/src/oauth/oauthService.ts#L367)、`:374`、`:431`、`:554`、`:630`、`:791`、`:948`、`:980`、`:990`；[oauthCredentialRepo.ts:284](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L284)、`:424`。

`onProviderLogout` 的标准 handler 同时清对应 family 的 Coding Plan 和 Start Plan API key，避免单删 OAuth 字段后运行配置还持有派生凭据。它不把手工配置的普通模型 API key 自动等同于 OAuth 会话 key。依据：[oauthProviderLogout.ts:14](../../packages/services/src/oauth/oauthProviderLogout.ts#L14)。

### Web 浏览器同名字段的独立边界

Web `BrowserOAuthCredentialRepo` 将同名 ZAI 字段放在 **localStorage**，不是磁盘 credentials.json；`oauth_pending_nonce` 放 sessionStorage。当前浏览器实现只支持 ZAI active provider。浏览器 token 交换直接将后端 `data.zai.access_token` 保存，未经过 Desktop `ZaiBusinessTokenResolver` 的业务转换，因此同名 `oauth:zai:access_token` 在两套存储中的来源语义不能直接混同。

浏览器 cached restore 要求 active 为 zai、JWT/access/user_info 全部存在；任何残缺态、用户 JSON 不合法都会 clearAll；JWT 明确过期返回 reauthentication-required。浏览器 logout 仅清自己的 localStorage；它不是 Desktop credentialService 的 OAuth logout。远控 attachment / Host 权威及 credential 转发限制由远控章节说明。

依据：[browserOAuthCredentialRepo.ts:11](../../packages/web/src/auth/browserOAuthCredentialRepo.ts#L11)、`:58`、`:94`、`:137`；[zaiWebOAuthProvider.ts:102](../../packages/web/src/auth/zaiWebOAuthProvider.ts#L102)、`:180`；[webAuthService.ts:128](../../packages/web/src/auth/webAuthService.ts#L128)、`:160`。

### 当前偏差与后续检查项

以下包含已确认实现问题、当前兼容残留和需要明确的边界；不把尚未决定的清理时机列为既定 bug。本章没有修改实现。

| 项目                                                        | 证据 / 当前结果                                                                                                                                             | 归类与边界                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录清旧的提交时点和取消语义待明确                          | `oauthService.ts:554`、`:791` 只换 flow；`:390` rollback 写回旧两域会话                                                                                     | **待明确边界**。用户确认的是清旧结果和单平台身份，不是点击时立即清理；不得把另一平台 JWT 设计成正常并存登录，也不能未经确认改变取消行为                                                 |
| 同平台重登取消后的 rollback 会话字段不一致                  | `oauthService.ts:391` 恢复 JWT，`:397` 又 clear 相反平台；Repo `:420` 删除共享 JWT                                                                          | **已用内存假凭据取得运行时证据**：ZAI / BigModel 均恢复旧 access/user/active 却丢 JWT。说明现有 rollback 会生成残缺会话；具体修复应与最终登录提交/取消语义一致，不能导向两平台 JWT 并存 |
| 单独 ZCode JWT 解密损坏绕过统一恢复                         | `oauthService.ts:206`、`:275` 直接调用 credentialService；Repo 统一清理在 `oauthCredentialRepo.ts:432`                                                      | **已用受控解密错误取得运行时证据**：cached restore 直接抛 `ZCODE_CREDENTIAL_DECRYPT_FAILED`，active 未清；应纳入 JWT 单字段损坏场景                                                     |
| BigModel 缺 JWT 仍能恢复 authenticated                      | cached restore `oauthService.ts:253` 的缺 JWT 检查仅限 ZAI，`:262` 统一返回成功                                                                             | **当前两平台恢复条件不一致**。新单平台完整会话规则需要明确消除残缺态                                                                                                                    |
| 旧 BigModel `auth_token/refresh_token` 正常切平台后仍可残留 | `oauthCredentialRepo.ts:415` 不删除 legacy；`bigmodelProviderAdapter.ts:274` 仍读取；`useCredentials.ts:63` 仅特殊删除 `auth_token`                         | **静态确认的兼容残留，清理边界待核定**。正常切换合成成功只证明命名空间 key 清理，不证明 legacy 全清；用户要求清所有旧 JWT 时必须单列核对这两项，而不能扩大为删除全部 credentials.json   |
| 孤立 OAuth 字段和 adapter 清理集合不一致                    | logout 只清 active；all 清理取 adapters 列表；corrupt 清理总包含两内置平台                                                                                  | **需要明确清理集合**。active 缺失或 adapter 禁用/未注册时的遗留字段应独立覆盖                                                                                                           |
| 泛型 refresh 缺 generation / mutation queue 防护            | `oauthService.ts:936` 异步交换后 `:945` 按最新 active 保存                                                                                                  | **扩展接口隐患**。内置 adapter 当前无 refresh，不能把它描述成当前内置自动刷新串写已经在发生                                                                                             |
| 部分消费者有跨类型 / 副本 fallback                          | repo snapshot `node.ts:1294` 回退业务 accessToken；Start Plan JWT helper 允许 provider.apiKey 副本                                                          | **静态确认的审计项**。新清旧语义下要检查这些副本是否能继续让旧账号请求；不能直接断言 fallback 都正在使用错误凭据                                                                        |
| `expiresAt` 未落盘，业务 JWT 无自动刷新链路                 | Repo 只保存 access/refresh/JWT；官方 MCP 注释也明确业务 JWT 无刷新链路                                                                                      | **能力边界**。当前依赖重新登录或服务端拒绝；是否新增刷新属于后续设计选择                                                                                                                |
| 历史文档写错 ZAI token 语义                                 | [oauth-multi-provider-implementation.md:99](../../docs/oauth/oauth-multi-provider-implementation.md#L99)、`:105` 写为 `data.token`；`:173` 描述消费时再转换 | **文档事实漂移**。当前 Desktop 是登录阶段转换后保存业务 token，ZCode JWT 单独保存                                                                                                       |

本轮前序运行时证据只使用内存 fixture 与从当前源码加载的函数，没有读取真实 token；本章不重复运行。正式修复仍需按仓库要求先补测试/spec，覆盖登录清旧、取消/失败、两平台切换、独立 JWT 损坏、派生 key 清理以及 desktop / web 远控边界。

## CLI 与 MCP 的 credentials.json 使用情况

本节按 2026-09-08 当前源码梳理，只说明代码事实及本轮已完成的合成运行时验证。所有示例均为结构示意，不含真实 token。产品规则采用本轮用户明确的“只能登录一个平台，登录需删除所有旧 JWT”；这条规则针对 ZCode App 的 ZAI/BigModel 登录会话，不能自动扩展为删除无关第三方 MCP OAuth、SSH、Bot 或独立模型 API Key。

存储路径、加密和文件锁见前文；以下聚焦 CLI 与 MCP 的业务行为。

### CLI 应用登录字段完整清单

字段常量及 CLI 写入入口见 [shared-credentials.ts:11](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L11)、[shared-credentials.ts:215](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L215)。下表描述的是**解密后的值**。

| 完整 key                  | 值结构/语义                                                                                                      | 当前 CLI 行为                          | 状态                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `oauth:active_provider`   | provider 字符串；CLI ZAI 登录写 `zai`。是身份选择标记，不是 token                                                | 登录覆盖；logout 仅在值为 `zai` 时删除 | 当前主链路                                    |
| `oauth:zai:access_token`  | 桌面要求 `/api/auth/z/login` 返回的 MaaS 业务 JWT；CLI 当前实际存 `ready.data.zai.access_token` 原始 OAuth token | ZAI 登录覆盖；logout 删除              | 当前主链路，存在语义分裂                      |
| `zcodejwttoken`           | 后端 ready 响应 `data.token`，ZCode 应用身份 JWT；ZAI/BigModel 共用同名 key                                      | ZAI 登录覆盖；logout 无条件删除        | 当前主链路                                    |
| `oauth:zai:user_info`     | `JSON.stringify(user)`；CLI user 为 `{user_id: string, avatar?: string, email?: string, name?: string}`          | ZAI 登录覆盖；logout 删除              | 当前主链路，非 token                          |
| `oauth:zai:refresh_token` | 历史/其他 writer 可留下的 refresh token 字符串                                                                   | CLI 登录不产生也不清除；logout 删除    | CLI 仅清理兼容字段，不是当前 CLI 新登录的输出 |

CLI OAuth ready 响应的源码类型仅含 `status`、`token`、`user`、`zai.access_token`，没有 refresh token 和持久化到期字段：[cli-oauth.ts:32](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L32)。CLI 登录存储方法也没有 `expiresAt` 参数，因此不能从该方法推断存在应用 JWT 自动刷新管理。

以下三个 BigModel key 由桌面 OAuth repo 定义；当前 CLI ZAI 登录和 logout 都不处理它们。它们是核对“单一平台登录”时必须一起考虑的旧会话状态，不是当前 CLI BigModel Coding Plan setup 的落盘输出：

| 完整 key                       | 解密后的值                     | 代码依据                                                                                       |
| ------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `oauth:bigmodel:access_token`  | BigModel 业务 access token/JWT | [oauthCredentialRepo.ts:24](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L24) |
| `oauth:bigmodel:refresh_token` | 可选 refresh token 字符串      | [oauthCredentialRepo.ts:28](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L28) |
| `oauth:bigmodel:user_info`     | 用户资料 JSON 字符串           | [oauthCredentialRepo.ts:32](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L32) |

### CLI 登录、退出与模型 Key 的生命周期

#### ZAI CLI 登录

[loginZCodeCli](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L130) 的实际时序：

```text
生成临时 poll_token
  |
  +--> POST /oauth/cli/init（Bearer poll_token）
  +--> 展示/打开 authorize_url
  +--> GET /oauth/cli/poll/:flow_id（Bearer 同一个 poll_token）
          |
          +--> pending：继续等待
          +--> failed/timeout/cancel：结束，本方法尚未写共享凭据
          +--> ready
                |
                +--> 保存 active=zai + 原始 ZAI OAuth access + ZCode JWT + user
                |      旧 BigModel namespace、旧 ZAI refresh 当前不清
                |
                +--> POST api.z.ai/api/auth/z/login（用原始 OAuth access 换 MaaS JWT）
                +--> 用 MaaS JWT 查询机构/项目、查找或创建 zcode-api-key、copy secret
                +--> 最终模型 API Key 写 ~/.zcode/cli/config.json
```

- init/poll 的 `poll_token` 只作为当前设备授权流请求凭据，不写 `credentials.json`：[cli-oauth.ts:88](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L88)、[cli-oauth.ts:106](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L106)。
- 共享凭据先于业务 token 兑换和 config 更新落盘：[auth-login.ts:165](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L165)。
- MaaS 业务 token 在 resolver 内使用，resolver 当前只返回最终模型 API Key，不返回给 shared store：[coding-plan-api-key.ts:96](../../apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts#L96)、[coding-plan-api-key.ts:111](../../apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts#L111)。
- 模型 API Key 由 config adapter 写 config，而非凭据 store：[file-config.adapter.ts:331](../../apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L331)。

#### CLI BigModel Coding Plan setup / 手动 API Key setup

`loginBigmodelCodingPlan()` 是“取模型 API Key 并配置 CLI”的流程：localhost callback 收 auth code，兑换 BigModel access token，获取 API Key，写 config，关闭 callback server。该方法**没有 shared credential store，也不写 `oauth:bigmodel:*` 或 `zcodejwttoken`**，不能把它当作桌面 BigModel 应用登录的另一入口。[auth-login.ts:212](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L212)、[auth-login.ts:254](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L254)。

手动 API Key setup 同样只校验非空后写 provider config，不写应用 OAuth state：[auth-login.ts:279](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L279)。

#### CLI logout

`logoutZCodeCli()` 只调用 `clearZaiLoginCredentials()`。后者在单次文件锁事务中删除 ZAI access/refresh/user 和共享 `zcodejwttoken`，但 active marker 只在它等于 `zai` 时删除；BigModel namespace 完全保留。[auth-login.ts:298](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L298)、[shared-credentials.ts:70](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L70)。

该 CLI logout 路径没有删除 `~/.zcode/cli/config.json` 中的模型 API Key，也没有遍历或删除 `mcp:oauth:*`。应用账号登出、CLI 模型调用凭据、第三方 MCP 授权是当前代码中的三个不同生命周期。

### MCP OAuth 命名空间与隔离范围

只有 MCP authorization-code OAuth 使用本共享 store。当前运行期入口 `createOAuthClientProvider()` 对 HTTP/SSE authorization-code 返回 `createMcpOAuthTokenProvider()`；stdio 和官方鉴权不走此 provider；client-credentials 模式直接创建 SDK `ClientCredentialsProvider`，没有把本 store 注入给它。[mcp/index.ts:1527](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1527)。

命名空间函数见 [oauth.ts:558](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L558)：

```text
serverName
serverUrl（完整原始字符串）
config.clientId 或 ""
config.scope 或 ""
config.redirectPath 或 ""
        |
        +-- 用 "\n" 连接
        +-- SHA-256，hex 前 24 个字符
        +-- P = "mcp:oauth:" + hash
```

实际隔离范围：

- 同一凭据文件内，同 `serverName + serverUrl + clientId + scope + redirectPath` 的各 CLI/Host/session 共用 OAuth pair、refresh 锁和授权 lease。
- `workspacePath`、`workspaceIdentity`、当前 ZCode provider/account、OAuth issuer、`clientSecret`、`clientName` 不参与此 hash。
- 改 server name/URL/scope/client ID/redirect path 会换命名空间，旧命名空间不会因为 key 变了自动删除。
- `issuer` 另存于 canonical，参与 discovery cache 一致性检查，**不参与凭据 namespace**。
- 因此当前是“共享文件 + MCP 配置授权语义”隔离，不是“workspace + 应用登录账号”隔离。是否要增加后者属于产品/架构决策，不能仅凭缺少 workspace 就定为 bug。

### MCP OAuth 全部持久化字段

以下 `P` 指上一节的 `mcp:oauth:<hash>`。所有 JSON 都是先 `JSON.stringify`，再作为一个加密字符串写入外层字典。

| 完整 key 模板                  | 解密后结构与用途                                                                                                               | 当前状态/写入来源                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `P:authorization_credentials`  | canonical 整对凭据，见下一张结构表                                                                                             | 当前主记录；交互授权/刷新成功发布                   |
| `P:client_information`         | SDK `OAuthClientInformationMixed` JSON；至少有 `client_id`，可能含 `client_secret` 和注册返回字段                              | 当前仍维护的旧 reader 镜像，不是可以直接删除的垃圾  |
| `P:tokens`                     | SDK `OAuthTokens` JSON；含 `access_token`、`token_type`，可有 `refresh_token`、`expires_in`、scope 等 SDK/服务器字段           | 当前仍维护的旧 reader 镜像                          |
| `P:discovery_state`            | 裸 SDK `OAuthDiscoveryState` JSON；当前代码读取 `authorizationServerUrl`、`authorizationServerMetadata`、`resourceMetadata` 等 | 当前 metadata 缓存，非业务 token                    |
| `P:discovery_state_fetched_at` | `String(Date.now())`，毫秒 epoch 的十进制字符串                                                                                | 当前 discovery 缓存时间戳                           |
| `P:pending_authorization`      | `{attempt_id, authorization_url, baseline_generation?, expires_at, state}` JSON                                                | 当前授权事务共享状态，不是长期 refresh/access token |
| `P:code_verifier:<state>`      | PKCE verifier 原始字符串                                                                                                       | 旧 provider 的持久化形态；当前 Phase 2 只放内存     |

前三个 key 的常量、类型和原子发布见 [oauth-credentials.ts:6](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L6)、[oauth-credentials.ts:143](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L143)。后四类见 [oauth-shared.ts:5](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-shared.ts#L5)、[oauth-lease.ts:82](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L82)、[oauth.ts:535](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L535)。

`authorization_credentials` 的完整本地包装结构：

| 字段                 | 含义                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `version`            | reader 支持 1、2；当前 writer 为 2                                                                          |
| `client_information` | 与 token 同一次授权的 client 信息对象                                                                       |
| `tokens`             | 与 client 同一次授权的 token 对象                                                                           |
| `published_by`       | 授权发布者/事务标识；refresh 写 `refresh:<P>`                                                               |
| `generation?`        | 每次 publication 新生成的 16 随机字节 hex；不是 token。旧记录缺少时可用 canonical 原文 hash 派生 generation |
| `obtained_at?`       | 获取 token 的毫秒 epoch                                                                                     |
| `expires_at?`        | `obtained_at + expires_in * 1000`；服务器未返回可用 `expires_in` 时缺省                                     |
| `issuer?`            | 授权服务器 issuer/URL，用于发现元数据一致性，不改变 key                                                     |

类型及读取规则见 [oauth-credentials.ts:19](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L19)、[oauth-credentials.ts:62](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L62)。对 SDK 对象的完整存储并不意味着本地为每个 SDK 扩展字段定义了独立 schema；当前 canonical shape checker 主要检查版本、`published_by`、client ID、access token、token type。

### MCP OAuth 授权、刷新、失效与历史兼容

#### 当前主链路是两阶段

```text
Phase 1：纯 AuthProvider（运行期请求）
  token()
    +-- 读 canonical + mirrors，派生一份 pair
    +-- 未临期：交付 access token
    +-- 临期且有 refresh：进入独立 refresh 锁
    +-- 无 token：请求不带 token，401 再分类
  onUnauthorized()
    +-- 有 refresh：锁内刷新
    +-- 无 refresh：要求交互授权

Phase 2：交互授权事务
  获取按 P 隔离的 authz lease
    +-- follower：观察共享 pending/generation
    +-- leader：fresh localhost listener -> discovery -> fresh DCR/静态 client
                     -> pending URL/state -> 等回调 -> code exchange
                     -> 原子写 canonical + 两个 mirrors
                     -> 关闭 listener、按 attempt 删除 pending、释放 lease
```

Phase 1 在 [oauth-provider.ts:47](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-provider.ts#L47)。临期余量为 30 秒；缺 `expires_at` 也当临期，但没有 refresh token 就用现有 access token 等待资源服务端最终返回 401：[oauth-credentials.ts:179](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L179)。

Phase 2 默认等待授权事务 5 分钟，leader/follower 使用 authz lease；pending TTL 只决定显示/可读性，不承担锁所有权。DCR 注册 client 和 PKCE verifier 在当前事务内存中保留，只有拿到 token 时才发布整对 client/token；回调等待可超时/取消，code exchange 阶段等 settle 后再释放 lease，避免 token 已写回但旧事务提前放锁。[oauth-interactive.ts:37](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L37)、[oauth-interactive.ts:77](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L77)、[oauth-interactive.ts:168](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L168)、[oauth-interactive.ts:246](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L246)。

#### 刷新与 token 删除

refresh 使用独立于 credentials 文件的锁路径，等待预算 45 秒。先观察 generation，拿锁后重读：其他进程已经换代就复用结果，避免多进程同时消耗同一个 rotation refresh token。成功后重新生成 generation，一次 `saveMany` 原子更新 canonical 和两个 mirrors。[oauth-refresh.ts:70](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L70)、[oauth-refresh.ts:127](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L127)。

| 触发条件                                                                        | 当前处理                                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `invalid_grant` 且有 canonical 原文快照                                         | 以 canonical 原文作 CAS guard，删除 canonical 与 tokens mirror，保留 client mirror；转交互授权 |
| 动态 client 的 `invalid_client` / `unauthorized_client` 且有 canonical 原文快照 | 同一个 canonical CAS guard 下删除 canonical、tokens mirror、client mirror；转交互授权          |
| 静态 client 的 `invalid_client` / `unauthorized_client`                         | 作为配置错误上报，避免不断用同一个无效 client 重新授权                                         |
| 网络/5xx/discovery 临时错误                                                     | 不当作 grant 确定失效；proactive 可继续现 token，reactive 抛临时刷新错误                       |
| legacy-only pair，没有 canonical `raw`                                          | 上述 canonical 删除 helper 不执行；仍按错误分类进入交互授权/配置错误                           |

代码：[oauth-refresh.ts:173](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L173)、[oauth-refresh.ts:190](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L190)、[oauth-credentials.ts:207](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L207)。这里 `tokens` 失效删的是存储记录，不是向 OAuth 服务端发送 revoke 请求。

#### metadata、pending 和锁文件

- discovery metadata TTL 为 24 小时；缺有效缓存、过期或 issuer 不匹配时返回 undefined，触发重新发现；过期读取本身不删除 key，下次保存覆盖 state + 时间戳。[oauth-shared.ts:43](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-shared.ts#L43)。
- pending 在 leader 提供授权 URL 时写入；结束时只按所属 attempt 做 compare-and-delete。过期读取仅视为不存在，不等于物理清理；进程崩溃可留下过期 pending，后续授权会覆盖/清理。[oauth-lease.ts:108](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L108)、[oauth-lease.ts:148](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L148)。
- authz/refresh 锁与 credentials 放在同目录，以去掉冒号等字符的 prefix 派生 `<sanitized-P>.authz` / `<sanitized-P>.refresh` 作为锁资源路径；底层锁目录再追加 `.lock`。这些锁是进程互斥元数据，不是 `credentials.json` 字段或业务 token。[oauth-lease.ts:33](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L33)、[oauth-refresh.ts:285](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L285)。
- 本轮在当前 CLI/MCP adapter、bootstrap 和 service MCP/plugin 代码中没有找到按整个 `mcp:oauth:<hash>` namespace 遍历删除的业务入口。不能声称断连、停用或移除 MCP 一定会清除全部授权材料；当前明确可见的是成功覆盖、确定失效 CAS 和 pending/verifier 清理。

#### mirrors 不等于废弃凭据；旧 provider 不等于当前主链路

`loadCredentialPair()` 一次读 canonical 与两个 mirrors，根据版本与内容兼容旧 reader/writer。v1 没镜像是正常状态；v2 删 tokens mirror 表示旧 writer 已失效，不能用 canonical 把 token 复活；client 未变而 legacy tokens 变化时可接受旧进程 refresh；client/token 都变化且不能证明同一事务时不会猜测拼接。[oauth-credentials.ts:239](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L239)、[oauth-credentials.ts:289](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L289)。

`oauth.ts` 仍包含完整旧 `ZCodeMcpAuthorizationCodeProvider` 和 `createMcpAuthorizationCodeOAuthSession()`，但当前仓库调用搜索中只有 `mcp-oauth.e2e.test.ts` 使用这一 session factory，生产创建点已经切到纯 token provider。该旧 provider 仍会把 PKCE verifier 写 `P:code_verifier:<state>` 并在 close 尝试清理，也仍存在逐 key CAS 的兼容代码。不要据此描述当前生产 Phase 2 把 verifier 落盘，也不要把旧 provider 中的逐 key CAS 风险当作已证明的生产主链路 bug。[oauth.ts:67](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L67)、[oauth.ts:289](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L289)、[oauth.ts:361](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L361)、[mcp/index.ts:1537](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1537)。

### 官方 MCP 读取的 token 与实际请求承载

官方 MCP 没有单独新增一种 `official-mcp:*` credential key，也不使用第三方 MCP 的 canonical OAuth pair。来源是 Host service 按当前应用登录和模型套餐选择解析共享凭据：

```text
Host setting 的 provider family / 选中连接
  + oauth:active_provider
  + zcodejwttoken
  + oauth:<当前 family>:access_token（MaaS JWT）
        |
        +-- 前后读身份快照，检查选择、active provider 和两种 token 一致
        +-- 构造身份 header
        +-- official auth port，经现有协议回复 CLI
              +-- HTTP 官方 MCP：请求 headers
              +-- stdio 官方 MCP：params._meta["com.zcode/official-mcp-auth"]
```

Host 要求 `oauth:active_provider` 与当前 setting family 一致且有 ZCode JWT，不能跨 family 回退找另一把 MaaS token；完整套餐路径还会前后比较 MaaS JWT。缺套餐时存在 identity-only 分支，可以只带 ZCode JWT，让服务端决定权益；有套餐 provider 却缺 MaaS JWT 时返回不可用。[officialMcpCredentials.ts:216](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L216)、[officialMcpCredentials.ts:283](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L283)、[officialMcpCredentials.ts:330](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L330)。

| Header                     | 来源                                                | 何时发送                                                       |
| -------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `Authorization`            | `Bearer <zcodejwttoken>`                            | 成功解析应用身份后发送                                         |
| `X-Bigmodel-Authorization` | `Bearer <oauth:<family>:access_token>`，是 MaaS JWT | 完整 Coding Plan 身份可用时；ZAI 同样使用这个历史命名的 header |
| `Bigmodel-Target-Type`     | `PERSONAL` / `TEAM`                                 | wire scope 存在时                                              |
| `Bigmodel-Organization`    | 选中 Team 连接的 organization ID                    | TEAM scope 且组织/项目能成对确定时                             |
| `Bigmodel-Project`         | 选中 Team 连接的 project ID                         | 同上                                                           |

常量与构造：[official-mcp-auth.ts:22](../../packages/shared/src/official-mcp-auth.ts#L22)、[officialMcpCredentials.ts:382](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L382)。`X-Coding-Plan-Api-Key` 是旧服务端兼容通道，当前客户端不再发，且仍禁止插件用静态 headers 注入：[official-mcp-auth.ts:41](../../packages/shared/src/official-mcp-auth.ts#L41)。

HTTP adapter 每次请求重新走 auth port；endpoint/origin 不可信时不解析凭据、不发网络请求。**身份解析失败与不可信 origin 是不同分支**：当前 HTTP 实现对前者发匿名请求，让服务端权威裁定，不使用旧 token；已有身份请求遇 401 最多重取身份再试一次，这不是 OAuth refresh token 兑换，也不删除 credentials。403/重定向分别分类失败。[official-auth.ts:115](../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts#L115)、[official-auth.ts:155](../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts#L155)、[official-auth.ts:296](../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts#L296)。

stdio 官方 MCP 每个出站协议消息通过 `requestMetaProvider` 注入同名 namespace；普通第三方 stdio MCP 不注入。缺 auth port 时显式给 `{ok:false, reason:"official_auth_unavailable"}`，不会通过 env 或 credentials 文件另找兜底身份。[mcp/index.ts:568](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L568)、[mcp/index.ts:599](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L599)、[mcp/index.ts:1428](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1428)。

Standalone CLI 不因为本地有 credentials 文件就自动构造官方 MCP 身份头；协议 auth port 需要 Host 上下文和 workspace 才能请求 service resolver。[official-mcp-auth-port.ts:48](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts#L48)。

### 相关秘密中哪些不由这条路径写入 credentials.json

| 秘密/字段                                                           | 当前保存或传递位置                                                                                            | 依据与边界                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI 最终模型 API Key                                                | `~/.zcode/cli/config.json` 的 provider 配置                                                                   | [file-config.adapter.ts:331](../../apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L331)；桌面 provider 存储另见总文档，不把 CLI 规则泛化到桌面                                                                                                                                           |
| 模型环境变量 API Key                                                | 运行期读取 provider `apiKeyEnv` 或默认 env 名                                                                 | [registry.ts:493](../../apps/zcode-cli/packages/adapters/src/model/registry.ts#L493)；优先显式 provider `apiKey`，无 shared credential fallback                                                                                                                                                              |
| app-server 模型 `session-secret`                                    | 按 `workspace.workspaceKey` 隔离的 `catalog.secrets` 内存 Map，key 形如 `model-provider:<providerId>:api-key` | [workspace-model-catalog.ts:1275](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L1275)、[workspace-model-catalog.ts:1446](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L1446)；这个像 credential key 的名字不是本文件的 key |
| app-server 模型 `env` secret reference                              | 保留 env 引用，解析时从传入 env 读取                                                                          | [workspace-model-catalog.ts:1523](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L1523)                                                                                                                                                                               |
| ZAI CLI `poll_token`、flow/state                                    | 当前登录方法内存和 init/poll 请求                                                                             | [cli-oauth.ts:88](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L88)；不是长期 access/refresh token                                                                                                                                                                                           |
| CLI BigModel setup 中间 access token                                | 回调兑换之后的内存变量，用来取最终模型 API Key                                                                | [auth-login.ts:254](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L254)                                                                                                                                                                                                                          |
| 当前 MCP Phase 2 的 PKCE verifier、尚未成功交换 token 的 DCR client | 当前交互授权 provider 内存                                                                                    | [oauth-interactive.ts:246](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L246)、[oauth-interactive.ts:409](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L409)；成功后 client 进入 canonical/mirror                                                              |
| MCP client-credentials 配置 `clientId/clientSecret`                 | MCP 配置对象传给 SDK `ClientCredentialsProvider`                                                              | [mcp/index.ts:1547](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1547)；本分支不注入 shared store，不能声称写了 `P:tokens`                                                                                                                                                                       |
| MCP 静态 headers / stdio env                                        | MCP 配置/进程启动环境直接传递                                                                                 | [mcp/index.ts:1423](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1423)；不是从 shared store 自动展开的凭据                                                                                                                                                                                       |
| `ZCODE_CREDENTIAL_SECRET`                                           | 环境中的本地加密 key material                                                                                 | [credential-cipher.ts:87](../../apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts#L87)；不是业务 JWT                                                                                                                                                                                            |

模型 registry 替换会清旧 `model-provider:*` 内存 secrets，移除 provider 会删对应 secret：[workspace-model-catalog.ts:245](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L245)、[workspace-model-catalog.ts:370](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L370)。这不等于修改 credentials 文件。

### 本轮已验证的 CLI 三个问题

#### CLI-1：同一 ZAI access key 的 token 类型分裂

CLI 将 ready 原始 OAuth access token 写入 `oauth:zai:access_token`；桌面已明确该 key 必须存 `/api/auth/z/login` 返回的 MaaS JWT，并在自己的 polling adapter 正规化。CLI 后续确实取得 MaaS JWT，却只在 API Key resolver 内使用。影响是 CLI 登录可能覆盖桌面/官方 MCP/业务用量消费者依赖的 MaaS token。[auth-login.ts:166](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L166)、[zaiProviderAdapter.ts:307](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L307)。

本轮合成 harness 执行真实 CLI login、OAuth adapter、API Key resolver、加密存储和锁，注入合成 HTTP 响应，最终 config writer 为仅记录参数的 stub；结果：业务请求使用 MaaS JWT=true，shared store 存原始 OAuth token=true，shared store 存 MaaS JWT=false，最终模型 API Key 配置成功=true。未进行真实网络登录。

现有 [auth-login.test.ts:95](../../apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts#L95) 已提供不同 OAuth token 与业务 JWT 响应，但 [auth-login.test.ts:176](../../apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts#L176) 错误断言原始 OAuth token 落共享 key。后续修复应先更新该回归测试及跨桌面消费者的契约覆盖。

#### CLI-2：成功登录未整体替换旧平台会话

`saveZaiLoginCredentials()` 只覆盖四个 key，不清 BigModel access/refresh/user，也不清旧 ZAI refresh。按用户“仅允许一个平台登录、清旧 JWT”的契约，这是成功发布后的直接不一致，不能只把 active marker 换成 zai 就认为清理完成。[shared-credentials.ts:215](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L215)。

#### CLI-3：从 BigModel 当前会话执行 CLI logout 只清一半

`clearZaiLoginCredentials()` 无条件删共享 ZCode JWT，保留 active=bigmodel 与全部 BigModel namespace。问题是**全局单一会话没有完整退出**；按用户最新规则，不能将修复建议写成“保留另一个平台登录”。[shared-credentials.ts:70](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L70)。

CLI-2/3 已使用两个独立临时文件、真实共享存储源码与真实加密/锁执行。只输出 active provider 与 key 存在性：

| key / marker                   | BigModel -> CLI ZAI 登录发布后 | BigModel -> CLI logout 后 |
| ------------------------------ | ------------------------------ | ------------------------- |
| `oauth:active_provider`        | `zai`                          | `bigmodel` 残留           |
| `zcodejwttoken`                | 存在（新值覆盖同名记录）       | 不存在                    |
| `oauth:bigmodel:access_token`  | 存在，旧会话残留               | 存在，旧会话残留          |
| `oauth:bigmodel:refresh_token` | 存在，旧会话残留               | 存在，旧会话残留          |
| `oauth:bigmodel:user_info`     | 存在，旧会话残留               | 存在，旧会话残留          |
| `oauth:zai:access_token`       | 存在                           | 不存在                    |
| `oauth:zai:refresh_token`      | 存在，旧值残留                 | 不存在                    |
| `oauth:zai:user_info`          | 存在                           | 不存在                    |

**确定问题与待决时机分开：** 成功发布必须保证单一平台凭据集合一致、登出必须完整清除当前应用会话，已经能由规则和运行结果确认。“点击开始登录就先退出旧会话”“用户取消是否仍保持退出”“API Key/config 更新失败是否回滚应用登录”则是清理时机和事务边界，不能从单平台规则独自推导。本轮不擅自确定这些行为，也不将第三方 MCP OAuth 和独立模型 Key 纳入应用登录 JWT 清理集合。

## Bot、远端连接与 Relay 凭据

表中 value 均指解密后的业务值。ICredentialService 是通用字典，本节列出当前生产者定义的键族，不是限制历史文件内容的白名单。

### Bot 凭据：同一键，按 provider 解释内容

| 键规则                                                   | 解密后的内容                                 | 来源                                                             | 主要消费者                                                              |
| -------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `bot:<botId>:credential`，provider=`telegram`            | Telegram Bot token                           | 用户在 Bot 凭据输入框提交的 token；通常来自 BotFather            | Telegram `getMe`、菜单同步、消息发送、长轮询                            |
| `bot:<botId>:credential`，provider=`feishu` / `lark`     | 飞书/Lark 应用 app secret，不是 access token | 手填，或扫码注册结果的 `client_secret`                           | app secret 换 `tenant_access_token`、飞书 WebSocket 与应用 API          |
| `bot:<botId>:credential`，provider=`weixin`              | Weixin iLink Bot token                       | 扫码登录响应 `bot_token`，兼容字段 `token`；通用服务也接收手填值 | iLink 请求的 `Authorization: Bearer ...` 及轮询                         |
| `bot:<botId>:webhook-secret`，provider=`webhook`         | 自定义 webhook shared secret                 | `saveBot({ webhookSecretValue })` 的调用方提供                   | 入站 callback 比较；出站使用自定义 header 名，默认 `x-zcode-bot-secret` |
| `bot:<botId>:webhook-secret`，provider=`feishu` / `lark` | 事件回调 verification token                  | `saveBot({ webhookSecretValue })` 的调用方提供                   | 与 payload 顶层 `token` 或 `header.token` 比较                          |

键由 [config.ts:70](../../packages/services/src/bots/config.ts#L70)、`:74` 生成。`botId` 在 `saveBot` 中 trim，键没有 workspace 或用户 OAuth provider 维度；每个 Bot 以其 ID 隔离。`BotConfig` 保存 `credentialRef` / `webhookSecretRef`，真实值另存凭据仓库。当前 service 接受已有任意 ref，读取与删除遵从 ref 本身，不能仅凭非标准键名判断记录无用（[bots.ts:96](../../packages/shared/src/bots.ts#L96)、[botsService.ts:6127](../../packages/services/src/bots/botsService.ts#L6127)、`:6221`）。

来源与使用的源码证据：

- 通用 UI 保存：[BotsDialog.tsx:347](../../packages/ui/src/BotsDialog.tsx#L347)；手填提交：`:816`。扫码完成后共用同一保存入口，飞书 `appSecret` 在 `:438` / `:445`，微信 `botToken` 在 `:564` / `:572`。
- 飞书注册将 `pollResponse.client_secret` 返回为 `appSecret`：[feishuAppRegistration.ts:164](../../packages/services/src/bots/providers/feishuAppRegistration.ts#L164)。微信从响应读取 `bot_token` / `token`：[weixinRegistration.ts:167](../../packages/services/src/bots/providers/weixinRegistration.ts#L167)。
- Telegram 读取 ref 并放入 `https://api.telegram.org/bot${token}/getMe`：[telegramProvider.ts:323](../../packages/services/src/bots/providers/telegramProvider.ts#L323)、`:327`。
- 飞书 app secret 换 tenant access token：[feishuProvider.ts:1093](../../packages/services/src/bots/providers/feishuProvider.ts#L1093)。换得的 token 放在模块内 `accessTokenCache`，并非新的 `credentials.json` 键（`:1105`、`:1130`）。
- 微信读取及 Authorization header：[weixinProvider.ts:97](../../packages/services/src/bots/providers/weixinProvider.ts#L97)、`:105`。
- Webhook/飞书 callback 校验：[botsService.ts:3273](../../packages/services/src/bots/botsService.ts#L3273)、`:3284`。Webhook 出站 header：[webhookProvider.ts:211](../../packages/services/src/bots/providers/webhookProvider.ts#L211)。
- 当前 `BotsDialog` 的 `saveBot` 包装仅传 `credentialValue`（[BotsDialog.tsx:347](../../packages/ui/src/BotsDialog.tsx#L347)）；`webhookSecretValue` 是服务 API 支持项，不应写成当前所有 Bot UI 都提供此字段编辑。

```text
用户手填 / 扫码注册返回 secret
            |
            v
BotsDialog -> IBotsService.saveBot
            |
            +-> credentialValue / webhookSecretValue 非空 -> trim
            |      -> credentialService.save(固定 bot key, secret)
            |      -> BotConfig 只保存 ref
            |
            +-> resolveName -> normalize -> validate -> repo.writeConfig
                   -> 刷新 provider runtime

provider runtime / provider adapter
    -> 按 BotConfig.ref 调 credentialService.load
    -> 解密值用于第三方鉴权
```

更新与回收：

1. `saveBot` 对非空新值覆盖同一个 bot 键；没有非空新值时不写入，保留的是调用方传来的 BotConfig/ref。写 secret、解析名称、校验及写配置的顺序见 [botsService.ts:6127](../../packages/services/src/bots/botsService.ts#L6127)、`:6140`、`:6171`、`:6174`。
2. 保存后会刷新 Telegram、Weixin、Feishu runtime；runtime 指纹纳入 ref 对应的实际凭据，因此同一个 ref 下换值也可识别（[botsService.ts:6175](../../packages/services/src/bots/botsService.ts#L6175)；`telegramChannelRuntime.ts:64`、`weixinChannelRuntime.ts:46`、`feishuChannelRuntime.ts:51`，均位于同目录）。
3. `removeBotSecret` 停止相关运行时、去掉两个 ref 和绑定身份、清 state，再删 ref 指向的凭据；Bot 本体保留，供重新绑定（[botsService.ts:6183](../../packages/services/src/bots/botsService.ts#L6183)、`:6199`、`:6221`）。
4. `deleteBot` 删除配置和 state，并删除两个 ref 指向的凭据（[botsService.ts:6229](../../packages/services/src/bots/botsService.ts#L6229)）。普通禁用未走这两个删除入口，因此不等同于撤销/删除凭据。
5. `saveConfig` 直接替换规范化 Bot 配置并刷新 runtime，没有扫描被移除 Bot 的凭据做差异回收（[botsService.ts:6099](../../packages/services/src/bots/botsService.ts#L6099)）。目前未见遍历 `bot:*` 的通用孤儿凭据 GC。清理依赖调用专用删除入口和保留 ref。
6. Bot 主凭据本身没有 expiresAt/refresh token 结构；失效后重新提供值或重新扫码。飞书短期 tenant token 的缓存/重新换取属于 provider 内存层，不应计入持久化键清单。

### 远端连接凭据：以 workspace identity 隔离

| 键规则                                                   | 值                                         | 关联配置字段                               |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `remote-workspace:<workspaceKey>:password`               | SSH 密码，保留原始值，不做 trim            | `target.passwordCredentialKey`             |
| `remote-workspace:<workspaceKey>:private-key-passphrase` | SSH 私钥口令，保留原始值                   | `target.privateKeyPassphraseCredentialKey` |
| `remote-workspace:<workspaceKey>:server-token`           | 连接完整 ZCode Server 的 token，保留原始值 | `target.tokenCredentialKey`                |

构造函数见 [remoteWorkspaceHistory.ts:30](../../packages/ui/src/lib/remoteWorkspaceHistory.ts#L30)、`:34`、`:38`。`workspaceKey = resolvedWorkspaceIdentity?.trim() || workspacePath`（`:402`）；连接 identity 由统一 `buildRemoteWorkspaceIdentity` 派生（`:202`），SSH 包含 host、port、username、workspace path，WSL 含 distro/可选 user，Docker 含 container，Server 复用 `buildServerRemoteWorkspaceIdentity`。WSL/Docker 当前无上述密码/token键。

来源是连接/重连提交的 `RemoteTarget.password`、`privateKeyPassphrase`、`token`。`createRemoteTargetSnapshot` 将这些明文转换为 ref，只把非敏感连接参数和 ref 放入持久化历史（[remoteWorkspaceHistory.ts:237](../../packages/ui/src/lib/remoteWorkspaceHistory.ts#L237)）。已有同类 snapshot 的 ref 会被复用，所以早期或自定义 ref 也可能继续有效；不能强制假定历史中所有 ref 都能重新按当前公式算出。

```text
连接输入 RemoteTarget（密码 / passphrase / server token）
   -> buildRemoteWorkspaceSessionMutation
      +-> snapshot（host/path/identity + credential refs）
      +-> credentialsToSave
      +-> credentialKeysToDelete
   -> commitRemoteWorkspaceSessionMutation
      -> 尝试删旧键 -> 写新键 -> 更新 lastWorkspaceSession

恢复/重连
   -> lastWorkspaceSession.target 中的 ref
   -> credentialService.load
   -> createRemoteTargetFromSnapshot
   -> connectRemoteWorkspaceTarget
```

读取与回收：

- UI 恢复 SSH 密码、私钥口令以及 Server token：[reconnectRemoteWorkspaceHistoryEntry.ts:121](../../packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts#L121)、`:132`；重建 target 后调用连接入口（`:136`）。Bot 对远端 SSH workspace 的恢复也按 settings 历史中的 ref 读取，见 [botRemoteWorkspaceBridge.ts:115](../../packages/services/src/bots/botRemoteWorkspaceBridge.ts#L115)、`:141`；该 helper 的显式凭据重建分支当前只覆盖 SSH。
- 变更时，旧 snapshot 中不再使用的 ref 加入删除列表；超过 20 条历史上限淘汰的条目，其 ref 也加入删除列表（[remoteWorkspaceHistory.ts:13](../../packages/ui/src/lib/remoteWorkspaceHistory.ts#L13)、`:344`、`:429`、`:440`）。保存值见 `:451`。
- 具体落库入口先尝试删除，再写新值，最后保存 settings；删除失败记 warn 后继续，写入失败则抛出（[useRemoteWorkspaceHistory.ts:746](../../packages/ui/src/root/useRemoteWorkspaceHistory.ts#L746)）。这是多次单键操作加一次 settings 写入，不是跨文件事务。
- 显式移除远端 workspace/tab 时，先保存移除后的历史，再删除引用的凭据，失败记录 warn（[useRemoteWorkspaceHistory.ts:1358](../../packages/ui/src/root/useRemoteWorkspaceHistory.ts#L1358)、`:1382`、`:1397`）。普通断线/临时 bridge 分离不等于移除历史，不会据此自动删除凭据。
- 没有独立远端凭据过期/刷新协议，更新发生在新的连接输入保存时；没有扫描所有 `remote-workspace:*` 的通用 GC。

### 外部 Relay 配对凭据

唯一固定键：`web-remote-control:external-relay:pass_hash`（[webRemoteControlRelayAuthStorageProvider.ts:4](../../packages/desktop/src/main/webRemoteControlRelayAuthStorageProvider.ts#L4)）。值是 `passHash` 字符串，虽然名为 hash，但它用于生成认证证明，是认证材料。`deviceSid` 是配套非敏感身份，保存在 settings 的 `webRemoteControlExternalRelayDevice.deviceSid`，不是另一个 credential 键。

来源：首次注册产生 24 字节随机 password，将其 SHA-256 后以 base64 编码为 passHash；认证证明为 `HMAC-SHA256(passHash, nonce|role|deviceSid)`，base64url 输出（[webRemoteControlRelayAuthProvider.ts:15](../../packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts#L15)）。随机原始 password 不另存 credentials.json。

```text
Main manager.start
   -> authStorage.load
       +-> 已有完整 {deviceSid, passHash}: persisted auth
       +-> 缺失: 随机 password -> passHash -> relay 注册
   -> transport ready + registeredAuth
   -> settings 写 deviceSid
   -> credentialService 写 passHash

relay challenge -> 用 passHash 生成 proof
invalid persisted auth / resetPairing
   -> 清 settings deviceSid + 删 pass_hash
   -> 下次 start 重新注册
```

调用链与生命周期：

- Main 注入 credential/settings service：[index.ts:931](../../packages/desktop/src/main/index.ts#L931)。启动读取并选择 persisted/register：[webRemoteControlManager.ts:1327](../../packages/desktop/src/main/webRemoteControlManager.ts#L1327)；新注册成功 ready 后保存：`:1446`。
- `load` 同时读取 settings/deviceSid 与 credential/passHash；两者都缺失返回 undefined，只有一边存在时先 clear 再返回 undefined（[webRemoteControlRelayAuthStorageProvider.ts:54](../../packages/desktop/src/main/webRemoteControlRelayAuthStorageProvider.ts#L54)）。
- `save` 先 patch settings 再写 passHash（同文件 `:80`）；`clear` 先清 settings 再删 passHash（`:44`）；公开 `rotate` 为 clear 后 save（`:96`）。同样不是两文件事务，但 load 会修复单边缺失状态。
- manager 收到 invalid persisted auth 时调用 clear（[webRemoteControlManager.ts:1398](../../packages/desktop/src/main/webRemoteControlManager.ts#L1398)）；用户 resetPairing 停旧 runtime、clear，再 start（`:1537`）。普通 start 会复用完整配对材料，所以关闭一次运行时不应被描述成删除配对凭据。
- 此键没有 workspace 隔离后缀，属于桌面应用的外部 relay 配对状态。它与模型服务 OAuth token、Bot token、Server workspace token 无关。

### 桌面、手机 Web 与远程主机的归属边界

```text
Desktop local workspace  -------------------------> 本机 credentialService
Desktop SSH/WSL/Docker workspace -----------------> 本机 credentialService
Mobile /remote -> shared-host attachment ---------> 所 attach scope 的 service
                                                    |
                                     local/SSH/WSL/Docker: 本机凭据
                                     Server remote: Server 自身凭据
Desktop Main external relay auth ------------------> 本机 credentialService

连接 Server 所需 server-token:
  存于发起连接侧的远端历史凭据；连接建立后的 Server 业务凭据另由 Server 提供。
```

- 桌面基础服务在 [node.ts:1213](../../packages/services/src/node.ts#L1213) 创建 credential service，并注入 Bots（`:1919`）。
- SSH/WSL/Docker 的 host scope 明确保留本机 settings/credential service，同时代理远端文件/任务；[remoteWorkspaceServiceCollection.ts:83](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L83)、`:239`、`:247`、`:255`。相应 renderer 合并只覆盖 workspace 服务，保留 base credential/Bot 服务：[remoteWorkspaceSessionServices.ts:3](../../packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts#L3)。不能因当前 workspace path 在远端就把 Bot/连接认证写到远端机器。
- Server remote 是例外：完整 Server 是业务状态权威，credential/Bot 服务直接转接 Server（[remoteWorkspaceServiceCollection.ts:316](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L316)、`:334`、`:339`；renderer 同文件 Server 合并入口位于 [remoteWorkspaceSessionServices.ts:53](../../packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts#L53)）。
- 手机 Web 建立 bridge 后通过协议得到 services，见 [main.tsx:1838](../../packages/web/src/main.tsx#L1838)；`RemoteServiceAccess` 将 credential/Bot 服务做成 RPC 代理，见 [remoteServiceAccess.ts:113](../../packages/client/src/remoteServiceAccess.ts#L113)、`:134`。未连接的 home-only 状态 credential load 返回 null（[main.tsx:1109](../../packages/web/src/main.tsx#L1109)），不创建浏览器端 credentials.json。
- 手机 `/remote` 依附窗口已存在的 shared-host scope；凭据文件归属与 attachment 相同，并不会因为手机 replayable 流另起 credential store/Agent。桌面 `desktop-continuous` 与手机 `web-remote-replayable` 是消息交付边界，不是此文件的键命名规则。当前事实来源：[task-realtime-sync.md:9](../../docs/web-remote-control/task-realtime-sync.md#L9)、`:22`；[web-remote-control-task-command-queue.md:20](../../docs/web-remote-control-task-command-queue.md#L20)。

### 已验证行为与待验证问题

| 事项                                       | 证据等级                   | 观察与影响                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook provider.test 对缺失存储值仍报成功 | 已执行合成运行复现         | 直接用 Node v24 import 真实 `createWebhookBotProvider`，ref 存在、无 webhookUrl、load 恒返回 null 时，返回 `{ok:true,message:"Webhook bot is enabled for inbound callbacks."}`，credential 读取次数为 0。源码 [webhookProvider.ts:172](../../packages/services/src/bots/providers/webhookProvider.ts#L172)。仅验证测试连接分支，未验证完整入站 service。 |
| Bot callback 缺失 secret 时可能跳过校验    | 静态高置信候选，未完整运行 | [botsService.ts:3273](../../packages/services/src/bots/botsService.ts#L3273)、`:3284` 只在 expectedSecret/expectedToken 为真且不相等时拒绝；ref 存在而 load 返回 null/空串将跳过该检查。不能将上一行 provider.test 复现当成本行已复现。                                                                                                                  |
| Bot 保存被拒后仍可能更新凭据或留下孤儿     | 静态候选，未运行           | 先 `credentialService.save`（`botsService.ts:6127`）后 `validateBotConfig`（`:6171`）。例如重复 providerUserId 校验失败可能晚于 secret 写入；需完整 service fixture 验证与确定修复事务边界。                                                                                                                                                             |
| 远端失败重连可能覆盖已有正确凭据           | 静态候选，未运行           | `remoteWorkspaceHistory.ts:404` 在 failed/currentEntry 时保留旧 snapshot，但 `:451` 仍用提交的 target 建 credentialsToSave。需真实连接失败/持久化调用链测试，未据此认定已复现。                                                                                                                                                                          |

## 审计结论与验证记录

### 已取得合成运行证据

| 场景                                            | 结果                                                                                | 结论范围                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Desktop ZAI → BigModel、BigModel → ZAI 成功提交 | 两个方向均删除相反平台的命名空间 key；JWT 操作顺序为 delete → save；新 JWT 保留     | 当前 Repo 与 persistOAuthSession 源码方法的合成验证。没有验证 legacy key 全清，不等于真实 UI E2E 通过    |
| CLI ZAI 登录                                    | 业务请求使用换得的 MaaS JWT，但共享 access key 仍为原始 OAuth token                 | CLI-1 已确认：共享字段的写入语义分裂                                                                     |
| CLI 从旧 BigModel 会话登录 ZAI                  | active 变为 zai，新 JWT 覆盖；旧 BigModel access/refresh/user 与旧 ZAI refresh 保留 | CLI-2 已确认：旧凭据清理不完整；不能把残留字段直接表述为两个 active provider 同时生效                    |
| BigModel 会话执行 CLI logout                    | JWT 消失，active=bigmodel 与 BigModel namespace 保留                                | CLI-3 已确认：会话只清一半；正确问题不是删除了应保留的旧 JWT                                             |
| Desktop cached restore 单独遇到 JWT 解密错误    | 抛错，active marker 未通过 Repo 的统一恢复逻辑清理                                  | 真实 restore 方法配合错误注入；需要补对应损坏恢复用例                                                    |
| Desktop 同平台重新登录落盘中取消                | rollback 写回旧 access/profile，曾恢复的旧 JWT 随后又被另一域 clearProvider 删除    | 确认的是当前回滚状态不一致。最终应保留旧会话还是保持登出取决于提交/取消契约，不能直接以补回旧 JWT 为修复 |
| Desktop/CLI 加密环境变量含空白                  | 普通值可双向解密；首尾空白、全空白两种情况均双向失败                                | 真正 cipher 的合成互操作验证，无真实 token 或密钥                                                        |
| inbound-only Webhook 的 test                    | ref 存在但不调用 loadCredential 就返回成功                                          | 只验证 test 分支；没有把它冒充为完整 callback 服务的验密复现                                             |

上表使用 Node 24 执行当前源码或从源码提取的实际方法；HTTP、配置写入或外围依赖按各场景注入 fixture。它们能证明对应函数路径的结果，不能代替桌面、手机、真实服务器和跨操作系统端到端验证。

### 需要继续验证或明确的边界

- **登录事务时机：** 点击开始、ready/兑换完成、凭据发布、模型 API key/config 更新不是同一时刻；用户取消或任一步失败时的最终状态应与提交边界一起确定。
- **旧会话清理集合：** legacy `auth_token/refresh_token`、active 缺失时的孤立 JWT、未注册 provider 残留、旧 OAuth 会话对应的内置 Coding Plan / Start Plan 凭据与 WebView 副本都应纳入清理场景核对（[派生清理实现](../../packages/services/src/oauth/oauthProviderLogout.ts#L14)）。普通手填模型 API key 不因此纳入 App 登录清理范围。不能把要求清旧 JWT 实现成清空整个凭据文件。
- **跨进程一致性：** 文件写锁已经存在，但多个独立 key 操作、多次读取、多个 OAuthService 实例不构成全局登录事务。是否需要批量发布/快照读取应结合交错复现决定。
- **Bot 和远端候选：** callback 缺失 secret 时跳过校验、Bot 校验失败前已写 secret、失败重连仍排入新凭据保存，目前是静态候选，完整调用链未执行。
- **MCP 和 App 账号关系：** MCP namespace 当前没有 App account/workspace 维度，App logout 不自动 revoke MCP 授权。是否需要跟随 App 账号清理属于独立设计选择。
- **本地加密迁移：** 默认密钥来源与两端空白差异需要兼顾旧文件，不能只改新密钥推导。明文兼容和未知加密前缀也应随版本迁移策略一起定义。
- **归档变体：** Desktop 当前按精确文件名排除 credentials.json，反馈 fallback 按路径子串排除；损坏备份与临时文件在两条归档路径中的实际处理需要单独用例，本文不声称所有凭据副本均已排除。

### 现有测试与文档核对入口

| 覆盖方向                                | 当前可检查的测试文件                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通用存储加密、并发写、损坏 JSON 保留    | [credentialService.test.ts](../../packages/services/test/credentialService.test.ts)、[CLI auth.test.ts](../../apps/zcode-cli/packages/adapters/tests/auth.test.ts)                                                           |
| Desktop 登录切平台、过期/损坏恢复、取消 | [oauthService.test.ts](../../packages/services/test/oauthService.test.ts)                                                                                                                                                    |
| CLI 登录兑换和字段落盘                  | [auth-login.test.ts](../../apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts)；其中原始 OAuth token 落共享 key 的断言需要随契约纠正                                                                                 |
| MCP OAuth、跨进程授权/刷新              | [mcp-oauth-refresh.test.ts](../../apps/zcode-cli/packages/adapters/tests/mcp-oauth-refresh.test.ts)、[mcp-oauth-cross-process.e2e.test.ts](../../apps/zcode-cli/packages/adapters/tests/mcp-oauth-cross-process.e2e.test.ts) |
| 官方 MCP 的身份选择                     | [officialMcpCredentials.test.ts](../../packages/services/test/officialMcpCredentials.test.ts)                                                                                                                                |
| 浏览器独立登录存储                      | [browserOAuthCredentialRepo.test.ts](../../packages/web/test/browserOAuthCredentialRepo.test.ts)                                                                                                                             |
| Desktop 交互回归入口                    | [desktop-auth-config-e2e-cases.md](../testing/desktop-auth-config-e2e-cases.md)；实际改动登录交互时需要补相应 E2E，不能只覆盖私有方法                                                                                        |

既有文档不能取代当前代码事实：例如 [OAuth 实施说明](../oauth/oauth-multi-provider-implementation.md)仍有 ZAI token 来源和转换时机的旧描述，[CLI auth-login](../../apps/zcode-cli/docs/design/v2/auth-login.md)记录了当前 CLI 原始 OAuth token 的落盘方式，与 Desktop 同文件消费契约不一致。后续修改应统一这些 spec 与测试，避免单独修代码后继续保留矛盾的约定。

本次仅新增梳理文档，没有实现修复。基线新鲜度检查通过；`pnpm typecheck` 和 `pnpm lint` 已执行，但当前 worktree 无 node_modules，分别因 tsc / oxlint 不存在而未能运行。未声明 Vitest、Desktop E2E、手机远控 E2E、Windows/Linux 回归通过。

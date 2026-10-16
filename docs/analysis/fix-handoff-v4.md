# Exa MCP OAuth 修复实施交接简报(v4)

> 交接自 staging 会话(2026-08-14)。本 worktree 已完成第一阶段根因分析(见同目录 `exa-oauth-reauth-analysis.md`)。本文是第二阶段:按 v4 方案落 spec 并实施 PR1-3。
> 你是实施者。评审方已完成三轮对抗评审。

## 0. 第一步:吸收第三轮终审结论

评审方的终审(v4 收敛性评审)结论单独交付:

- 结论若为"可实施":直接按本简报执行。终审结论未到时,先做下面与评审无关的第 2 步 spec 骨架。
- 结论若仍有阻断项:把阻断项吸收进设计(修订 spec 相应章节),阻断项只影响对应 PR 的细节,不推翻两阶段总体架构(该架构已经两轮评审确认方向成立)。

## 1. 背景与两个根因(已定案,勿重新分析)

生产包是 `@modelcontextprotocol/client@2.0.0`(`apps/zcode-cli/packages/adapters/package.json:105`)。注意仓库同时存在 `@modelcontextprotocol/sdk@1.29.0`,不要读错包。

- **根因 1(refresh 竞态)**:多个 CLI 进程共享 `~/.zcode/v2/credentials.json`,`withFileLock` 只覆盖凭据读写不覆盖网络 token exchange;access token 过期时各进程并发用同一 refresh token 刷新,撞服务端 rotation reuse-detection,token family 被撤销 → SDK invalidate tokens → 需重新授权。
- **根因 2(二次授权死循环)**:DCR 注册的 client 把 `redirect_uris` 锁死在注册当时的随机回调端口;回调服务器每次 `listen(0)` 换端口;redirect_uri 失配时授权服务器(RFC 6749 §4.1.2.1)禁止回跳就地渲染错误页(用户看到的 Exa "Server Components render error")→ 回调永不到达 → 超时,且重试永不自愈。
- 关键代码:`apps/zcode-cli/packages/adapters/src/mcp/oauth.ts`(595 行单文件 provider)、`src/auth/localhost-callback.ts`、`src/mcp/index.ts`(连接编排,连接成功后 oauthSession 长期存活仅在 closeRecord 关闭)、`src/auth/shared-credentials.ts`。

## 2. v4 方案(两阶段连接,已三轮评审)

### 设计原则

1. 被动连接零 listener/零 discovery/零 DCR。
2. 交互式授权才建 listener,跨进程单飞,DCR client 事务内存化。
3. 所有 refresh(主动+reactive)汇入一把跨进程文件锁。
4. 确定性 OAuth 错误 CAS 失效,非确定性错误才 fail-soft。
5. 15s 是 caller 等待预算,授权事务全局寿命 300s,两者分离。

### Phase 1 运行期:纯最小 AuthProvider

client@2.0.0 原生支持(`node_modules/@modelcontextprotocol/client/dist/index.d.mts:186`):传纯 AuthProvider(只有 `token()` + `onUnauthorized()`)时 transport 的 `_oauthProvider` 为空(`dist/index.mjs:4978-4980`),401 只调我们的 `onUnauthorized` 并自动重试一次;SDK 的 auth()/discovery/DCR 完全不参与。**不要**传 OAuthClientProvider 给运行期 transport(会被 adaptOAuthProvider 包裹,401 走 SDK auth() 绕过我们的锁)。

```ts
{
  async token() {
    const pair = await loadCanonical();
    if (!pair?.tokens) return undefined;                  // → 401 → onUnauthorized
    if (!isNearExpiry(pair)) return pair.tokens.access_token;
    return refreshUnderLock(pair);
  },
  async onUnauthorized() {                                // transport 之后自动重试一次
    const pair = await loadCanonical();
    if (!pair?.tokens?.refresh_token) throw interactiveRequired();
    return refreshUnderLock(pair, { reactive: true });
  },
}
```

refreshUnderLock(`refreshAuthorization` 从 `@modelcontextprotocol/client` 导入,已核实存在):

```
withFileLock(<独立 refresh 锁文件,basename 仅 hash/连字符,无冒号——Windows 非法>, async () => {
  cur = loadCanonical()
  cur.generation !== pair.generation → return cur.tokens?.access_token    // 合并,零二次请求
  meta = resolveAsMetadata()
    // discovery_state 存在且未过期(自定 TTL 24h)→ 直接用
    // 缺失/过期 → discoverOAuthServerInfo() 一次(公开元数据)→ 写回 → 继续
    // discovery 失败 → fail-soft 返回现值,绝不当 grant 失效
  next = refreshAuthorization(meta.url, { ...meta, clientInformation: cur.client, refreshToken, resource })
    成功 → publishCanonical({ client 不动, tokens: next, obtainedAt: now }); return next.access_token
    invalid_grant  → compareInvalidateTokens(cur.generation); throw interactiveRequired
    invalid_client → compareInvalidateBoth(cur.generation);  throw interactiveRequired
    网络/5xx → fail-soft 返回现值
})
```

- `interactiveRequired()` = 稳定 code + symbol 品牌的错误(不只 instanceof,抗 bundle 重复加载)。SDK 对非 OAuthError 原样冒泡且 transport 用 `Symbol.for("mcp.authSeamEscape")` 保 identity(`index.mjs:2263,2270-2277`);adapter 必须在 `failConnection()`(`mcp/index.ts:570` 附近)之前识别它,并为 Phase 2 新建 transport(被 negotiation 关闭的 transport 不能复用,`index.mjs:3283`)。
- canonical 凭据结构增加 `obtained_at`/`expires_at`/`issuer`(issuer 仅存字段,本次不做 per-AS 键控)。**迁移**:旧记录无时间字段 → 视为临期进锁尝试一次刷新(锁内重读防多进程并发触发);若该次收到 invalid_grant(旧 family 本就死了,正是 exa 现场)→ compareInvalidate + 进 Phase 2,这个路径是正确的。
- 403 insufficient_scope:纯 AuthProvider 下 SDK 无视默认 'reauthorize' 直接抛 `InsufficientScopeError{requiredScope,...}`(`index.mjs:5010`)→ adapter 计算 unionScope = token.scope ∪ requiredScope → 带 unionScope 进 Phase 2(DCR 的 clientMetadata.scope 与 authorize 都用),否则 403 无限循环。

### Phase 2 交互授权:独立授权锁 + baseline generation + 真 abort

```
G0 = 当前 canonical generation(baseline)
tryAcquire(authz-lock:<hash>, maxWaitMs≈0)          // 独立锁文件,不锁主 credentials 文件
 ├─ 未抢到 → follower:轮询 canonical,generation ≠ G0 即回 Phase 1 重连
 │            caller 预算(session 15s/设置 300s)到点 → 报"授权正在另一处进行",后台继续等
 └─ 抢到 → leader:
      锁内重读:generation ≠ G0(等待期间别人已完成)→ 放锁收工
      listen(0) 随机端口(彻底放弃端口复用——listener 在连接期长期存活,复用必撞)
      interactive OAuthClientProvider(全新 state,scope = unionScope):
        clientInformation(): 静态配置 clientId → 返回;否则 undefined
                            → SDK 必然用当前存活 listener 的 URL 重新 DCR → redirect_uri 失配从根上消除
        saveClientInformation(): 只写事务内存(全仓生产读取方只有 oauth.ts,已核实;
                                 client@2.0 会对旧 client 补 issuer 并回调 saveClientInformation,
                                 interactive 语义=内存,passive 无此方法,不会污染 canonical)
        tokens(): undefined(不触发 refresh)
        saveTokens(): 锁内 saveMany 原子发布 canonical+legacy(client 来自事务内存,与 tokens 同次授权)
      授权 URL + state 写共享 pending_authorization 键(带 TTL)→ session TUI / 设置页都能读来展示
      等回调至全局 TTL 300s
      放弃时 AbortController 真取消 listener/fetch/finishAuth
        // 现有 withTimeout 只忽略迟到结果不取消(timeout.ts:1);不真 abort 则迟到
        // token exchange 仍会发布,fencing(=锁)就漏了
      finally: 放锁 + 删 pending 键 + 关 listener + 销毁 transport → **回 Phase 1 重连**
```

- **Phase 2→1 交接是硬性要求**:授权成功后必须丢弃 Phase 2 transport,回 Phase 1 用 passive provider 重连。复用 Phase 2 的已认证 transport 会在运行期 401 走 SDK auth() 绕过 refresh 锁。
- 用独立授权锁而非 marker/长锁担忧已被代码推翻:`withFileLock` 的 maxWaitMs 只限获取不限持有(`packages/shared/src/node/privateFilePersistence.ts:51`),活 PID 锁不会被 stale 回收(`atomicFileLock.ts:69`);`67666ea256` 修的是 waiter 超时后误 cleanup。锁本身即 fencing。
- `EACCES/EMFILE/ENFILE/EADDRNOTAVAIL` 等所有 listen 错误都按 leader 失败处理(放锁重试/上报),不特殊处理 EADDRINUSE。
- localhost-callback 的 state 校验:不匹配 → 回 400 但**不得 reject 自己的 callback promise**(继续等正确回调);匹配 state 且带 `error=access_denied` → 立即 settle 失败。

### PR 序列(顺序不可颠倒)

| PR | 内容 |
|---|---|
| PR1 | localhost-callback:state 不匹配不 poison promise;匹配 state 的 error=access_denied 立即 settle。oauth.ts:invalidateCredentials 各分支、授权/刷新事件补 warn 级日志(不含 token 明文) |
| PR2 | Phase 2:独立授权锁 + fresh DCR 事务内存化 + 锁内原子发布 + pending_authorization 共享键 + caller 预算与事务寿命分离 + 真 abort。**修根因 2**。注意:PR2 落地时 Phase 1 仍是现 provider,交互路径先挂到新 Phase 2 编排上 |
| PR3 | Phase 1 换纯 AuthProvider + refreshUnderLock(锁+合并+确定性错误 CAS 失效)+ obtained_at/expires_at 迁移 + discovery TTL + 403 unionScope 传递 + Phase2→1 交接。**修根因 1**。PR3 必须在 PR2 之后:Phase 1 换纯 AuthProvider 后 SDK 不再自发交互授权,PR2 未就位则用户无法授权 |

## 3. 执行契约

1. **spec 先行**:先更新 `docs/mcp-oauth-client-auth.md`(把其中 deferred 的跨进程 OAuth leader/lease 与 refresh single-flight 两项转正为 v4 设计,补两阶段时序图;仓库规范见 apps/zcode-cli/.claude/CLAUDE.md)。新增 `docs/mcp-oauth-two-phase.md` 或并入前文,自行判断,保持文档结构一致。
2. **每个 PR 独立提交**(conventional commits,如 `fix(adapters): ...`),提交前跑 `npm run lint` 和相关测试。工作在当前分支 `exa-oauth-analysis`(基于 staging bfc91c54a9),不要 push、不要建 MR,完成后停下报告。
3. **测试矩阵**(各 PR 验收门槛,用生产包 client@2.0.0,现有 e2e 从 sdk@1.29 直连 import 切过来):
   - PR1:错误 state 请求先到、正确请求后到 → 仍成功;access_denied → 立即失败。
   - PR2:两个真实子进程争 leader → 恰好一个 listener/一次 DCR/一个授权 URL;A 超时 B 接管,A 迟到的 saveTokens 必须失败(fencing);ServerError/403 路径旧 canonical 仍在时 leader 不得把旧 token 当新 generation。
   - PR3:首次无凭据连接断言零 discovery/零 DCR/零 listener;rotation 严格服务器 + barrier 双进程仅一次 refresh 请求(可参考 feat/cli-opt 分支 22ba5d86c4 的测试 `mcp-oauth-proactive-refresh.test.ts`,注意文件布局已分叉不能直接 cherry-pick);invalid_client 断言 client+tokens 整对失效;旧 canonical 无时间字段 → 恰好一次刷新尝试,不反复。
4. **参考实现**(只读参考,不可 cherry-pick,文件布局已分叉):`git show e2b55fcd46`(固定端口方向,已被否决,仅看静态 client 配置部分)、`git show 22ba5d86c4`(refresh 锁与 barrier 测试思路)。
5. 已知限制写进 spec,不在本次修:issuer 不参与 keyPrefix 键控(仅存字段);远程 SSH/容器场景 callback 跨 host 不可达(既有问题)。
6. 遇到设计级两难(例如终审结论与本简报冲突且无法调和),停止并在报告中列明,不要自行拍板改架构。

## 4. 运行时证据(定位时已采集,供验证用)

- 日志:`~/.zcode/cli/log/zcode-2026-08-1{1,2,3}.jsonl`;8-11 11:27 唯一一次授权成功,8-12 09:00 refresh 失效后 121 次 authorization.required、0 次 completed。
- 凭据:`~/.zcode/v2/credentials.json` 键前缀 `mcp:oauth:c50fd1fa...`;exa 的 `client_information` 在(redirect_uris 锁 127.0.0.1:54735)、`tokens` 已被删。notion/linear/canva/atlassian 同样锁历史随机端口,是同类隐患。
- 复现:授权页对失配 redirect_uri 的渲染已实测(auth.exa.ai 就地渲染错误页)。

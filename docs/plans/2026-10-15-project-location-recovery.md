# Project Location Recovery Implementation Plan

**Goal:** 可重建的位置缓存异常先局部自愈，保留有效登录；不扩展登录失效条件。

**Architecture:** ProjectAccessTokenClient owns pending/代次/位置重建；CredentialService owns
共享文件锁内的条件恢复。OAuthService 保持身份 authority，沿用已有业务鉴权核验。

**Tech Stack:** TypeScript、Vitest、Electron/WDIO、本地 HTTP 合成夹具。

## 实施顺序

1. 更新 `docs/oauth/jwt-401-auto-logout.md` 与 auth-config case 清单。
2. 先补共享客户端失败分支、单飞与存储并发测试，运行确认失败。
3. 删除全局登出接线；实现 Host 私有 `recoverUnreadable` 缓存端口及共享客户端一次重建。
4. 修改 pending Electron case，验证自动恢复与 503 后保留登录，并记录运行时文件/HTTP/UI 证据。
5. 执行类型、Lint、格式、架构、受影响测试；复查 diff 后整理为一个提交，创建 staging MR。

## Impact Brief（planning）

### Feature Summary

- Capability：`capability.provider-registry`；变化层级：persistence / recovery / validation。
- Seeds：ProjectAccessTokenClient、createAccountProjectTokenClient、createCredentialService。
- 非目标：修改密钥推导、登录协议、整个账号的事务模型、平台 403 语义或 Standalone CLI 行为。

### UI Surface Matrix

| 场景 / UI 入口                      | 共享实现 / 显示 owner                   | 校验与提交                      | authority / 落点                    | 模式与隔离                                  |
| ----------------------------------- | --------------------------------------- | ------------------------------- | ----------------------------------- | ------------------------------------------- |
| 设置套餐连接 / ModelProviderSection | Account Provider → ProviderSettingsView | 请求期 Token 解析，位置异常重建 | Host Token owner / credentials.json | 桌面、shared-host；不能退出有效登录         |
| 侧栏头像 / useRootOAuthEffects      | OAuth cached session / Root user        | 原有鉴权确认后才重登            | OAuthService / oauth:\*             | 保留身份、无新增 UI 状态                    |
| 用量与模型请求                      | Account request auth / Token client     | 请求前换证，不重放已建立模型流  | Host runtime / 内存 Token           | 个人/团队命名空间隔离；远程继续原 authority |

### Shared And Divergent Behavior

所有 Host 消费位置缓存的入口共用一次重建及文件锁。Renderer 不读写缓存；没有恢复端口的
Standalone CLI 保持原有错误语义。本次不修改 UI 组件、主题、文案、手机 replayable 路由。

### Feature Relationships

- must-inspect：`capability.provider-registry` → `surface.provider-settings`，套餐可用性与配置独立。
- must-inspect：OAuth/Credential → Account Token client，身份不能被派生缓存反向撤销。
- should-inspect：个人/团队用量、官方 MCP、请求期鉴权，均消费 Host 项目 Token。
- invariant-only：`service.oauth`、`state.oauth-pending-callback`，成功恢复不改变登录或 pending。

### State Owners And Commit Sinks

位置 pending / 代次：ProjectAccessTokenClient；OAuth：OAuthService；密文文件修改：CredentialService
和现有 withFileLock；UI 仅读既有 ProviderSettingsView，不增加计时器或第二份缓存。

### Must-Preserve Invariants

普通 IO 不删除；仅删仍无法解密的目标缓存；锁内复核已修复则复用；clear 后旧任务不恢复；
恢复失败保留 OAuth；不记录 Token、账号 ID 或密文；不写短期 Token；不自动重放模型请求。

### Codegraph Evidence

当前无可用 codegraph 工具或索引，使用 dep:refs 和 rg 核对直接调用，展开两层：
node.ts → accountProjectTokenClient → ProjectAccessTokenClient；个人/团队 runtime → 同一 client；
CredentialService → withFileLock → 原子文件替换；Root OAuth 广播链路只作为不变边界。

### Graph Drift Candidates / Graph Delta

图中 provider-registry 未列项目 Token 和 credential store 的精确 seeds；补充已确认的 seeds
和缓存恢复隔离不变量，不新增能力或 UI surface。其余静态调用仅作为证据。

### Unresolved Questions

额外对账：历史 reasoning Map 的新增型号匹配规则漏列为新增型号，补齐测试排除清单；远端旧任务断言按现行首次迁移 spec 校正。两处仅修测试，不改模型配置或迁移实现。
原始用户异常触发原因仍未确定；不阻塞修复已经复现的局部恢复缺口，不在 MR 中宣称根因已定。

### Accepted Cases / Planning Handoff

接受：损坏缓存自动恢复；503 保留登录；修复先提交；多个恢复合并；clear 后失败无副作用。
剪枝：主题/语言不改变 Host 条件恢复，以现有双语 UI 和不改渲染规则为不变量；平台差异由
原异步文件锁适配，本轮 macOS Electron，其他平台和手机真机如实列未验证。
Spec 与 case 清单为上列两篇文档；E2E 继续 pending，不做转正或 CI admission。

## 评审修正范围

起点 `6546165b3e`；仅处理已批准的 SG-01 前置诊断事件、单测及 SG-02 契约引用。
先在共享客户端测试中验证恢复内 IO / 后续查询失败的事件顺序、普通读取错误不报恢复，
再补固定事件及 Host 日志标签；不新增恢复结果类型或改变恢复/登录行为。
两项基线测试仅补 spec 与现有独立覆盖的路径，断言不变。完成后运行定向与受影响测试、
类型、Lint、架构检查，并回放已有 Electron 恢复用例核对日志，提交推送后等待同提交评审。
评审图谱起点为 48 affected files / 466 impacted nodes；53 testGaps 仅为待核验候选。

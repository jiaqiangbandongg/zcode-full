# Todo114：账号不可用原因同步与个人套餐取 Key 失败收口

> 合并编号说明：上游原编号 Todo105；2026-09-10 合入本分支时改为 Todo114，避免与既有“个人／团队模型名单精简”Todo105 冲突。下文 T105 用例 ID、临时证据路径保持原样，便于追溯。

> 状态：已实现，定向单测/集成测试与组件浏览器验证通过；2026-09-10 用户授权先合并、记录 ToDo，再实施。完整 Electron / 手机远控链路未实测，不计入本次通过证据。
> 基线：从 staging 建立 `fix-account-status-sync`，已合并 `origin/fix/coding-plan-not-purchased-status`（`da708b7d4a`），无冲突。

> 2026-09-16 行为更新：个人套餐凭据失败的主动重试改为用户点击“重新登录”，具体契约见 [失败态规格](../../../ui/coding-plan-entitlement-failure-state.md)。下文为原实现历史；不再沿用“登录回调为零”的交互断言。

## 1. 背景与裁决

原分支修复“已登录、服务端明确无个人套餐，却显示未连接”：Host 把 `unavailableReason` 随 Account State 下发，UI 区分未开通和获取失败。这符合 Provider 重构的单一事实源，不恢复 UI 的第二次权益探测。

审查发现两处需要补齐：Host 发送新增字段，但 CLI 使用的严格同步 schema 未接受它，会拒绝整份 Account 快照；个人 Coding Plan 获取 Key 失败时，Z.ai 根据本地登录信息分类，BigModel 却固定报未连接。

用户确认：

- 同步 schema 接受可选原因字段，保留严格校验；不重组整套状态，不要求原因与 availability 使用判别联合。
- 两个 family 的个人套餐取 Key 失败分类对齐。接口域名、Authorization 和 secretKey 适配仍保持现状。
- **已登录但没拿到 Key，应提示“获取失败”，可重试；不能仅凭缺 Key 强制重新登录。** 本地用户信息只证明曾登录，不保证 Token 仍有效。
- 只有明确的登录凭据失效证据才足以要求重新登录。当前取 Key 服务将各种失败归一为 null，本次不扩建失败协议，不把 null 或模型 API Key 的 401/403 自动当作 OAuth 失效。
- 未登录仍走原有连接入口；成功查询明确无套餐仍显示未开通、提供订阅入口。Start、Team、Off-Peak 不扩展调整。
- 保留原分支已有原因命名；`credential-failed` 本轮表示获取/校验凭据失败，不断言 OAuth 已失效。

## 2. 修改后的结构与边界

### 同步状态成员

```ts
unavailableReason?:
  | "not-authenticated"
  | "not-connected"
  | "credential-failed"
  | "not-entitled";
```

原因枚举在 shared schema 定义一次，类型由 schema 推导，Provider 通过已有 shared 依赖复用。同步仍使用 `zcodeProviderUpdateAccountConfigParamsSchema`，不新建命令、不降低 strict、不另建状态 owner。

### 状态与重试链路

```text
Host 获取个人套餐 Key
  ├─ 缺 Key + 无本地登录信息 → 未登录/连接入口
  ├─ 缺 Key + 有本地登录信息 → 获取失败
  └─ 有 Key → 订阅查询 → 可用 / 明确未开通 / 既有未知态
                  |
                  v
       Account State（Host 唯一 owner）
            ├─ shared 同步 schema → CLI 接收完整快照
            └─ Settings View → 获取失败卡片
                                 |
                               点击重试
                                 |
                       既有 settings-manual 刷新
                                 |
                         Host 重新获取并发布
```

卡片重试复用现有刷新及其并发/版本守卫，不清理 OAuth、不发起登录、不新增定时器、缓存或状态同步旁路。桌面与手机使用共享设置组件和服务，Host/Agent 的同步路径不变；不修改 continuous/replayable、owner/lease 或 remote attachment。

## 3. 实施顺序

1. 先补协议往返、两家缺 Key 分类和卡片重试场景的失败测试。
2. shared 增加原因 schema 并由 Provider 复用推导类型，补全同步 states 成员。
3. services 将两家的缺 Key 判断统一到现有 helper，不改 Key 获取网络适配或缓存。
4. UI 个人套餐获取失败时提供重试，复用已有刷新入口；保留其他套餐和升级流程原有登录操作。沿用既有翻译、组件和加载状态。
5. 验证、复审、回写实际证据并提交；本次未授权推送或建 MR。

## 4. 验证与兼容

- 协议：四种原因无损往返；不带原因仍接受；错误原因和未知字段拒绝；混合可用/不可用 Provider 的快照能整体接收。
- 服务：Z.ai/BigModel 各自覆盖有/无登录信息的缺 Key 状态，不发 subscription 请求；成功有/无订阅及其他套餐既有用例回归。
- 交互：获取失败点击重试触发刷新而非登录；重试失败可再次操作，成功恢复当前状态。设置页实际场景用 E2E 验证，并区分桌面窄窗口与真实手机测试证据。
- 运行时通过真实 schema 与状态生产/消费函数验证，不能只用源码字符串断言替代协议回归。
- 执行定向测试、typecheck、lint、architecture:check；E2E 补 typecheck:e2e。环境阻塞记录实际结果，不冒充通过，不借机重建整个 E2E 基础设施。
- 仅新增可选运行态字段，无新增文件存储、数据库表或迁移。App 与 CLI 必须配套；旧 CLI strict 不接受新增字段，不宣称跨版本混用兼容。

## 5. 实际交付与剩余问题

### 推送门禁补充（2026-09-10）

用户要求将修复推回原 MR !2594 的 `fix/coding-plan-not-purchased-status` 分支。首次 pre-push 的受影响测试 14,484 通过、2 失败；失败均来自已有分享组件的 React 引用稳定性检查：SessionPane 给 memo 确认 Dock 传内联回调，Selection Dock 的默认 preflight 每次创建对象。

为通过正常推送门禁，只做引用稳定化：前者用依赖 `sessionId` 和 `updateShareDockState` 的 useCallback 保持当前会话绑定；后者将只读 idle 默认值提至模块常量。保留原函数体、状态归属、显示和交互，不改变分享协议或权限裁决。已有失败测试作为回归；单独提交，便于识别这项门禁配套修复。

修正后引用稳定性与分享相关四个测试文件 45/45 通过，typecheck、lint（41 warning / 0 error）、架构检查和两份代码的格式检查通过。本次是引用稳定化，没有新增分享交互，不重跑分享 E2E；完整推送门禁随后重新执行。

### 已接受的浏览器交互用例（实施前固定）

T105-UI01：分别渲染 Z.ai、BigModel 个人套餐“获取失败”卡片；点击重试，受控刷新未完成期间按钮不可重复提交；第一次刷新仍失败后可再次重试，第二次恢复到明确未开通后显示订阅。全过程登录回调为零。覆盖 390px 中文浅色与 1200px 英文深色，保存浏览器错误、截图和刷新次数。

用例进入 `packages/ui/test/browser/manual-review/pending/account-provider-key-retry.*`，复用现有 Vite + Playwright 组件浏览器工作流。它证明实际卡片交互，Host 的实际解析→协议由集成测试单独验证；不将组件 fixture 宣称为完整 Electron 或手机 shared-host E2E。

### 交付

- 同步协议增加可选原因字段并继续 strict；`shared/account-provider-state` 公共子路径提供唯一原因 schema 与推导类型，Provider 保留原导出名。使用轻量子路径避免 Provider 构建通过 shared 总入口引入 Node 环境定义；未改包依赖或同步命令。
- Z.ai/BigModel 个人套餐统一按对应 family 的本地用户信息处理缺 Key。上层缺账号身份的既有早退、其他套餐、缓存和网络适配不变。
- 个人套餐 `credential-failed` 卡片通过 Detail 获得重试动作；调用现有 `useModelProviders.refresh()` → `settings-manual`，其 loading/版本守卫与错误日志沿用。按钮不触发 OAuth 登录；Start/Team 和升级流程仍保留已有操作。
- 新增源码 schema 模块和测试文件属于代码组织，不是用户目录新增存储文件。

### 验证证据（2026-09-10）

- 先补测试得到 8 个预期失败：4 个协议原因、2 个 BigModel 分类、2 个重试按钮；实现后全部修复。
- 最终 7 个定向测试文件 280/280 通过：协议往返/严格拒绝、模型配置构建闭包、套餐可用性、账号 Connection Resolver、Account State 投影、卡片详情、导航投影。`/tmp/todo105-final-unit.log`。
- 服务集成测试使用真实 Family Availability → Connection Resolver → Account Config Resolver → 同步 schema：两家缺 Key 都发布 `credential-failed`，同快照的可用 Start Plan 不被阻断。没有用源码搜索代替运行时协议验证。
- 组件浏览器 T105-UI01 四组通过：两家 ×（390px 中文浅色 / 1200px 英文深色）。真实点击验证重试请求次数、刷新中禁用、失败后再次点击、恢复后订阅按钮、登录调用为零、无页面 JS 异常。日志 `/tmp/todo105-browser.log`；截图与浏览器日志 `/tmp/zcode-todo105-browser/`。初次环境缺 Chromium / libatk，安装浏览器并复用已有临时动态库后运行；首次英文断言误写为 Failed to fetch，按产品既有翻译 Fetch failed 修正，不改产品文案。
- `pnpm typecheck` 通过（包含 desktop `tsconfig.e2e.json`）；`pnpm lint` 0 error / 41 warning，warning 不在本次修改的生产代码中；`pnpm architecture:check --changed` 0 violation / 0 baseline / 0 new。格式与 `git diff --check` 通过。
- 改动模块 shared、provider、services、ui 均是当前 policy 中 unmanaged 模块，context 未声明独立 CONTRACT；本次没有新增跨层 IO 或可变状态 owner。

### 边界与剩余验证

- 当前取 Key 返回 null 仍不区分网络、创建 Key 或 OAuth 失败；没有新增“明确 OAuth 已失效”的检测或原因枚举。缺 Key 不触发强制重新登录。
- browser fixture 仅证明实际组件交互；完整 Electron、真实账号 API、真实手机 shared-host/SSH 未执行。前者沿用原分支记录的环境/fixture 缺口；剩余产品链路验证统一登记到 Todo102，不声称端到端全覆盖。
- 当前 Linux 浏览器缺中文字体，中文截图显示缺字方框；中文 DOM 文案和点击断言通过，但截图不能作为中文字形/排版验收证据。
- App/CLI 配套发布要求不变；新 App 搭配旧 CLI 仍不兼容新增字段。未写用户配置、未新增存储迁移、未推送远端或创建 MR。

原分支的历史文档为 `docs/coding-plan/connection-status-semantics.md`；其中“获取失败 → 重新登录”和 §7.2 的未裁决候选已被本 Todo 的用户裁决取代。

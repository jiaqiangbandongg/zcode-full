# Todo 48：Account API 与手填 API Key 边界清理

> 状态：研究完成 / 裁决记录；不作为独立实施 Todo
>
> 日期：2026-08-31
>
> 来源：Todo 26 收口后的 Account Provider 设置页与 Welcome API Key 链路 Review

## 1. 问题

Provider 重构曾将 `account:zai-api-key` 与 `account:bigmodel-api-key` 定义为
`zhipu-account / mode=api-key`，并假设当前登录账号会在请求期自动提供按量 API Key。

对最新 `origin/staging` 的纵向追踪证明，这不是原产品行为。staging 的 `API Key` 连接方式就是用户手填 Key；登录态
创建/复制项目 Key 的代码只服务 Coding Plan 凭据刷新，不构成一个独立的“账号按量 API Provider”。当前分支还同时存在
`zai-api` / `bigmodel-api` 普通 Key Provider，因此同一 Endpoint、模型成员和 API Schema 被重复建模了两次。

```text
用户手填 API Key
   |
   v
Built-in API Provider + Personal Key
   |
   v
正式 Model                                  staging 的 API Key 链

当前登录账号
   |
   +--> Start / Individual / Team / Off-Peak
   |
   `--> Coding Plan 所需项目 Key 的创建/复制   staging 的账号链
```

错误不是“Account API 页面漏隐藏输入框”，而是不存在产品依据的 Account API Provider 本身进入了正式 Config、Resolver、
Runtime 和 UI。

## 2. 已确认边界

### 2.1 staging 的手填 Key 是 Built-in Provider 预设

最新 `origin/staging@5ebc182b61` 的真实链路：

```text
Welcome 选择 Z.ai / BigModel 并输入 Key
        |
        v
builtin:zai / builtin:bigmodel（启动前已存在）
        |
        +--> 只更新 apiKey、enabled、updatedAt
        +--> Endpoint / API Schema / models 保持 Built-in 预设
        +--> Family mode 写为 apiKey
        `--> 默认模型选择为该 Provider 的首个模型
        |
        v
Registry 在 apiKey mode 精确选择该 Built-in Provider
        |
        v
Runtime 直接使用 Provider 中保存的 apiKey
```

它不会动态创建一个自定义 Provider，也不会在提交时复制 Endpoint、Schema 和模型列表。执行语义近似“创建一个已经填好
Endpoint/Schema/models 的自定义 Provider，再让用户只填 Key”，但产品身份仍是固定 Built-in Provider，并参与 Family
连接选择。

### 2.2 自动创建/复制 API Key 的真实用途

staging 的 `OAuthPresetProviderRepoProviderResolvers.resolveProviderApiKey()` 确实会通过个人账号链取得真实 Key：

```text
OAuth / 业务 access token
        |
        v
getCustomerInfo
        |
        v
个人 organization / project
        |
        v
查找或创建 zcode-api-key
        |
        v
copy secret
```

取得真实 Key。但调用方 `loadSinglePresetProvider(..., shouldResolveApiKey)` 创建的是
`builtin:zai-coding-plan` / `builtin:bigmodel-coding-plan`，并且只有显式
`refreshCodingPlanApiKey()` 才打开该分支。普通 `builtin:zai` / `builtin:bigmodel` 的 Built-in 同步明确写入空 Key，等待用户手填。

Team Coding Plan 不复用上述“自动发现个人 organization/project”的身份链。它使用用户已选择并校验的
`organizationId/projectId` 取得团队项目 Key。Individual 与 Team 可以共享底层项目 Key API，但身份来源、缓存键和
凭据 Owner 必须保持分离。

因此“存在自动取 Key 的底层能力”和“存在账号按量 API 产品入口”是两件事。前者存在，后者在 staging 没有证据。

### 2.3 目标访问边界

- `api-key`：用户手填 Key，Key 保存到 Personal Provider Config；
- `zhipu-account`：只用于确实依赖账号、套餐或请求期账号材料的 Start、Individual、Team、Off-Peak；
- `zhipu-account / mode=api-key` 从正式契约中删除；
- `account:zai-api-key` / `account:bigmodel-api-key` 删除，不再和普通 API Provider 重复；
- `zai-api` / `bigmodel-api` 作为每个 Family 唯一的手动 API Provider；其固定 Endpoint、API Schema 和 Built-in
  模型成员来自 ZCode Built-in，Personal 只保存 Key 和允许的 Overlay；
- `zai-api` / `bigmodel-api` 分别使用 `zai-family` / `bigmodel-family`，固定占据 Family 的“按量 API”槽位，
  不再进入普通“添加供应商”候选；
- 两个 Family 按量 API Provider 的 Built-in `enabled=true`，表示固定加入 Family 配置。缺少 Key 时保持可见但配置不完整、不可执行，不通过
  自动写入 `enabled=false` 冒充完整性；
- Family 连接选择的 `kind=api-key` 指向上述普通 API Provider，不进入 Account Overlay 或 Account Request Auth；
- Coding Plan 的自动项目 Key 解析能力保留在 Coding Plan 请求凭据链，不能用于证明一个不存在的 Account API Provider。
- Account Provider 的套餐资格只投影为 `access.entitled`，不再复用 Provider 顶层 `enabled`。

### 2.4 UI 直接按照 Effective Access 判别展示

Provider 设置页直接读取 Effective Provider Config 的 `access` 判别联合，不增加
`hideApiKeySection`、`readOnlyEndpoints` 或 Family 页面专用布尔值作为第二套访问类型事实：

```text
Effective Provider Config.access
        |
        +-- type = api-key
        |      `--> 展示并保存手动 API Key
        |
        +-- type = zhipu-account
        |      `--> 展示账号连接、套餐、额度和自动凭据状态
        |
        `-- 其他 access type
               `--> 按该 access 的正式契约展示
```

真正的 Account Provider 不展示、不读取、不保存手动 API Key。Family 中的“按量 API”选择虽然和 Account 套餐并列展示，
但其详情由 `access.type=api-key` 自然得到 API Key 表单，不伪装成 Account Access。

### 2.5 产品文案

Family 连接选择中的内部 `kind: "api-key"` 可以保留，但用户界面统一显示为“按量 API”。它明确表示使用标准按量
模型 API，进入详情后由用户手填 Key。

### 2.6 写入边界

Provider Config Service 在写入 Personal Overlay 前机械拒绝固定 `zhipu-account` Built-in Provider 的 Personal
`access`。不能允许无效配置先写盘、再等下次读取时由 Personal Source Schema 拒绝整份文件。

## 3. 已裁决的实施范围

以下内容由 [`todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md`](./todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md)
统一实施；本文件只保留研究证据和产品裁决，避免两份 Todo 成为互相漂移的执行清单。

1. 从 Built-in、ID 常量、Account Resolver、Request Auth、Protocol、UI 和测试删除两个虚构的 Account API Provider；
2. `zai-api` / `bigmodel-api` 迁入对应 Family group，Family 的 API Key 连接项引用它们；详情按
   `access.type=api-key` 展示手填表单，普通“添加供应商”不再列出它们；
3. Welcome 手填 Key 更新对应 Built-in API Provider 的 Personal Overlay，不写 Account Access；
4. 删除 `restoreFamilyApiKeyProviderForApiKeyMode` 及重复 API Key persistence/helper；
5. Account Resolver 不再处理 `mode=api-key`；Coding Plan 自动项目 Key 解析保留并按真实职责重新命名；
6. Config Service 继续拒绝真正 Account Provider 的 Personal `access`；
7. Family API Key 用户文案改为“按量 API”；
8. 更新 Provider Settings Design、Access Protocol Design、Feature Graph 与 Todo 26，撤销错误的 Account API 结论。

## 4. 验证

- Family “按量 API”页面展示并保存手动 Key；
- 普通 Built-in API Provider 和自定义 API Provider 均继续使用正式 `api-key` 链；
- UI 分支只读取 Effective `access.type`，不存在控制同一事实的页面布尔参数；
- 固定 Account Provider 写入 Personal `access` 必须失败；
- Welcome 手填 Key 使用对应 Built-in API Provider，不创建自定义 Provider，不进入 Account Request Auth；
- Registry 中同一 Family 不存在两份 Endpoint/models 相同、只因错误 Access 假设而重复的 API Provider；
- `rg` 与 `dep:refs` 证明旧 Family Key 恢复 helper 和 Account Key persistence 零残留；
- 补齐 UI、Provider、Services 单测与相关 E2E；执行 typecheck、lint、格式检查和 `git diff --check`。

## 5. 完成标准

- 不存在没有 staging 产品依据的 Account API Provider；
- 手填 Key 只属于唯一的 Built-in/Personal `api-key` Provider，并保留 Family “按量 API”产品入口；
- Coding Plan 自动项目 Key 与手填按量 Key 的凭据来源、保存位置和 UI 形态完全分离；
- 没有新增 Family 专用展示布尔值或第二套 Access 判别事实；
- 实施、清理、测试与 Design 同步完成后提交 Conventional Commit。

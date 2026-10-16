# Todo 51：Provider Access 消费语义与 Off-Peak 鉴权收口

> 状态：已完成
>
> 日期：2026-08-31
>
> 前置关系：Todo 47、49、50 已完成核心契约切换；本 Todo 收口 Review 发现的消费层漂移、重复鉴权装配与旧抽象残余。

## 1. 目标

本轮不再改变 Provider Config 的核心结构，而是让所有消费方真正遵守已经确定的唯一事实：

```text
ZCode Built-in Provider Config
Account Provider Config
Personal Provider Config Overlay
              |
              v
Effective Provider Config
├─ enabled                         是否加入当前配置
├─ access.type/family/mode         静态访问方式
├─ access.entitled                 Account 产品资格
└─ 完整调用配置
              |
       +------+--------------------+
       |                           |
       v                           v
Settings View                  Provider Registry
读取 placement/状态             只收 executable Provider/Model
```

同时收口两条相邻链路：

- Welcome 手填 API Key 只为固定 Built-in API Provider 保存稀疏 Personal Overlay，不建立自定义 Provider、不复制
  Built-in 事实，也不暗中修改 Family Connection Selection；
- Off-Peak 继续使用 ZCode JWT、Coding Plan 项目 Key 和 Off-Peak Ticket 三份既有请求材料，但 Provider/账号选择与
  Request Auth 只解析一次，Desktop Host 不再扫描 Settings View 猜测当前 Coding Plan。

## 2. 已确认边界

### 2.1 `enabled`、`entitled` 与 `executable`

| 事实                                    | 唯一含义                                                          | Owner                       | 允许的消费者                                         |
| --------------------------------------- | ----------------------------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| `provider.enabled`                      | Provider 是否加入当前配置；普通 Built-in 据此位于主列表或添加菜单 | Built-in + Personal Overlay | Settings placement、Resolver 的第一层执行门禁        |
| `access.entitled`                       | 当前账号是否具有对应 Account 产品资格                             | Account Overlay             | Account 状态 UI、Resolver 的 Account 执行门禁        |
| `provider.executable` / Registry 存在性 | Provider 已启用、有资格、配置完整且至少有可执行模型               | Resolver / Registry         | 模型选择、连接测试、真实执行、内部精确查找           |
| Account access descriptor               | `type/family/mode` 等静态访问描述                                 | Built-in Provider Config    | 展示分派、账号请求材料解析；不得被转成“已连接”布尔值 |

不得再用 `enabled` 推断账号已连接、已购买或有权益，也不得仅凭 Account access descriptor 存在推断 entitlement。
Renderer 不复制 Resolver 公式；需要执行能力时直接消费 `executable` 或正式 Registry。

### 2.2 Welcome API Key 只写 Personal Overlay

```text
用户选择 BigModel 并输入 Key
              |
              v
查找 Built-in `bigmodel-api`
              |
              v
保存稀疏 Personal Provider Overlay
{
  access: {
    type: "api-key",
    apiKey: "..."
  }
}
              |
              v
Effective Config / Registry 刷新
```

- `zai-api` / `bigmodel-api` 的 Provider ID、group、Endpoint、API Schema、Built-in models 和顺序继续来自 Built-in；
- Welcome 不动态创建 `standard-personal` Provider，也不把 Built-in 字段复制进 Personal Config；
- Welcome 不写 `providerFamilyConnectionSelections`。已有显式连接方式选择保持原值；API Key Overlay 是否存在不是当前连接
  方式的第二份权威；
- Welcome 现有 Family domain 与登录后默认模型行为保持不变，本 Todo 不借 API Key 保存重设计导航或模型选择；
- 设置页用户主动切换连接方式仍按该交互自身的契约处理，不与 Welcome 的“保存调用材料”混为同一个提交动作。

当前通用写入口 `savePersonalProvider` 实际保存“任意 Provider 的 Personal Config Overlay”，名称容易被误解为只保存
`standard-personal` Provider。统一重命名为 `savePersonalProviderOverlay`，贯穿 Facade、Service、Runtime、UI helper、mock
与测试。API Key 便利函数只负责合并 `access.apiKey` 后调用该通用入口，不另建持久化协议。

### 2.3 Off-Peak 三份请求材料与单一解析来源

```text
ZCode JWT                  当前登录身份
Coding Plan Project Key    当前 Individual/Team 套餐的模型请求材料
Off-Peak Ticket            本次闲时执行的调度准入
          \                   |                   /
           +------------------+------------------+
                              |
                              v
                   Off-Peak Request Auth
```

三者职责不同，Ticket 不替代 Coding Plan Key。本轮保留现有服务端 Header 契约，不改变计费、额度、Ticket 状态机或最终授权。

当前组合根已经为 Off-Peak Server Client、支持状态和 Mock Upstream 使用 Registry Provider 解析账号材料；Desktop Host
派发时却再次扫描 Settings View，并用旧 `provider.enabled` 语义寻找 Individual/Team Provider。Account Provider 固定
`enabled=true` 后该扫描会同时命中多个 Provider，既是重复实现，也会让请求鉴权解析失败。

目标链路：

```text
Provider Registry + Account Request Auth
                 |
                 v
组合根创建唯一 Off-Peak Credential Resolver
        +--------+------------------+
        |                           |
        v                           v
Server Client / Support       Host Dispatch(ticketId)
                                    |
                                    v
                           buildOffPeakRequestAuth
```

- 在 Node/Host 组合根只组装一次 Off-Peak credential resolver dependencies；
- Local Host 派发只提交 `ticketId` 并取得本次 Request Auth，不读取 Settings View、不判断套餐、不解析 Provider；
- 动态凭据继续留在 Host/Services 内存，不进入 Renderer、RPC DTO、Provider Config、Session Selection 或持久化；
- 不向公开 `IOffPeakTaskService` 增加会把秘密暴露给 Renderer/Remote client 的方法；复用现有 host-private capability/lookup
  边界，或在同一组合根提供等价的窄私有闭包；
- Off-Peak 仍使用普通 Registry、标准 ModelSelection 和正式 ModelFactory，不创建第二个执行 Registry。

### 2.4 Family Connection Selection 的边界

`ProviderFamilyConnectionSelection` 是显式设置页连接选择，不是 Personal Provider Config，也不是 API Key 配置完整性的
镜像。当前 `kind: "api-key"` 是否仍应保留属于连接方式产品交互，本轮不凭 Welcome 行为删除或重设计它；只固定：

- Welcome 保存 Key 不修改 selection；
- Account Overlay 可以读取显式 selection 决定当前账号连接，但不能把 `enabled` 当 selection/entitlement；
- Provider 的可执行性仍由 Effective Config/Registry 裁决，selection 不能成为第二个 Registry。

## 3. 当前确认的问题

### 3.1 UI 仍消费旧 `enabled = account connected`

需要逐一清理：

- `connectedAccountProviderIds` 按 `provider.enabled` 收集 Account Provider；
- `resolveAccountProviderAccess()` 同时承担 descriptor 读取和 connected 布尔判断；
- Subscription completion、首次 entitlement 同步、Plan 状态和 quota/usage 展示把 descriptor 存在当作已连接；
- Coding Plan funnel telemetry 按 `enabled` 上报 purchased；
- 注释、变量和测试 fixture 仍写“Account Overlay 已启用”。

处理原则：

- 需要静态描述时读取 `access.type/family/mode`；
- 需要账号资格时读取 `access.entitled === true`；
- 需要执行能力时读取 `executable`/Registry；
- 删除含义含混的 nullable/Boolean 转换，不新增 `AccountProviderState` 大 DTO 或第二套派生状态机。

### 3.2 Off-Peak Host 重复 Provider 解析

Desktop Host 与 Services 组合根各维护一份 `resolveAccountProvider`。删除 Host 侧 Settings View 扫描，保留一份基于正式
Registry 和 Account Request Auth 的解析来源。

### 3.3 Personal Overlay 公共接口命名错误

`savePersonalProvider`、相关 mutation target 和 helper 名称没有表达 Overlay 语义。机械重命名并删除旧导出，不保留 alias，
避免未来再次把 Built-in Provider Overlay 与 Personal-only Provider 身份混淆。

### 3.4 旧抽象与死逻辑

- 删除无生产调用方的 `ModelProviderFamilyModeSettings`、`resolveModelProviderFamilyMode`、
  `shouldShowModelProviderForFamilyMode`；正式结构化 selection 不再有平行的 `oauth | apiKey` mode；
- 将 Account Connection Resolver 中实际只加载 Coding Plan 项目 Key 的 `loadProviderApiKey` 收窄命名为
  `loadCodingPlanApiKey`；普通 `api-key` Provider 永远不经过该接口；
- 删除比较 Account Provider 表单 API Key 后刷新 entitlement 的死分支；Account Provider 已不承载手填 Key；
- 清理旧 Account API Provider、Account `enabled`、`accessId` 和“Personal Rule 决定编辑权限”等过时注释/测试命名。

## 4. Feature Impact Brief

### 4.1 改动层级

| Layer                | 本轮内容                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| validation           | Account connected/entitled/executable 的判断归位                                                         |
| commit-effect        | Welcome 只提交 Personal Overlay；设置页连接选择保持独立                                                  |
| persistence          | `provider_config.json` 仍是 Personal Provider Overlay 唯一落点；App Settings selection 不被 Welcome 修改 |
| option-source        | Registry 是可执行 Provider/Model 唯一来源                                                                |
| architecture/process | Off-Peak Host 复用唯一私有 Request Auth Source                                                           |

### 4.2 UI Surface Matrix

| 场景                          | 展示/草稿                            | 提交动作                              | 权威 Owner                                         | 必须隔离                                               |
| ----------------------------- | ------------------------------------ | ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Welcome 手填 Key              | 本地 API Key draft                   | `savePersonalProviderOverlay`         | Personal Provider Config                           | 不写 Account Overlay/Family selection，不复制 Built-in |
| Provider Settings 按量 API    | Effective Config + Key draft         | 同一 Overlay 保存入口                 | Personal Provider Config                           | 不进入 Account Request Auth                            |
| Provider Settings Coding Plan | Account access/entitlement +套餐状态 | 显式 connection selection/账号操作    | App Settings + Account Overlay                     | 不保存手填 Key，不用 enabled 推断 entitlement          |
| 连接测试                      | Provider/Model 行                    | flush Provider draft 后测试正式 Model | Registry/ModelFactory                              | 不重写 Model Rule，不猜账号状态                        |
| Off-Peak 创建与派发           | 支持状态 + idle selection            | Ticket + host-private Request Auth    | Off-Peak Service + Registry + Account Request Auth | 不暴露凭据，不改变普通 Session Selection               |

### 4.3 高风险关系

| Rank           | 关系                                   | 风险                                                           |
| -------------- | -------------------------------------- | -------------------------------------------------------------- |
| must-inspect   | Account Overlay -> Settings/telemetry  | `enabled=true, entitled=false` 被误报已连接/已购               |
| must-inspect   | Registry -> Off-Peak Host dispatch     | Settings 扫描命中多个 Provider，派发缺凭据                     |
| must-inspect   | Welcome -> Personal Config             | 写错 selection 或复制 Built-in 会制造双事实                    |
| should-inspect | Provider Settings -> connection test   | connected/executable 门禁不能重新混用                          |
| invariant-only | desktop continuous / mobile replayable | 本轮不改变 session stream、queue、snapshot 或恢复语义          |
| invariant-only | remote workspace                       | Provider Registry 既有同步保持不变，不新增 Remote 私有鉴权来源 |

### 4.4 Graph Drift

Feature Graph 仍描述 Account Overlay 投影顶层 `enabled`、`accessId` 和“仅启用选中 Provider”，与 Todo 49/50 及当前
Resolver 不一致。本 Todo 建立时先修正为：Account Built-in 固定 `enabled=true`，Account Overlay 只投影
`builtinModelIds + access.entitled`，动态账号凭据由请求期 Services 解析。

## 5. 实施顺序

1. 先补 `enabled=true + entitled=false` 的失败测试，覆盖 Settings、Plan 状态、同步、telemetry 与 Registry；
2. 拆清 UI 的 Account descriptor、entitlement 与 executable 消费，删除旧 enabled 判断和含混命名；
3. 补 Off-Peak 多 Account Provider 回归测试，先证明 Desktop Host 当前解析失败；
4. 将 Off-Peak credential resolver dependencies 收口到唯一组合根，删除 Desktop Settings 扫描；
5. 将 `savePersonalProvider` 机械重命名为 `savePersonalProviderOverlay`，让 Welcome/设置页 API Key helper 复用它；
6. 补 Welcome 纵向测试：只写 API Key Overlay、selection 不变、Built-in 字段不复制；
7. 删除 Family mode、Account API Key entitlement 刷新和 Coding Plan Key 错误命名等残余；
8. 更新当前 Design、Feature Graph、Todo 49/50 实施结果和代码注释；历史 Todo 只保留历史轨迹并标明被取代；
9. 机械扫描旧符号并执行定向、全量和交互验证；完成 Review 后提交 Conventional Commit。

## 6. 测试计划

### 6.1 Provider / Services

- Account Provider `enabled=true, entitled=false`：Settings 可见，Registry 不存在；
- Account Provider `enabled=true, entitled=true` 且完整：进入 Registry；
- descriptor 存在但 `entitled=false` 时不得被解释为 connected/purchased；
- Account Resolver 只投影 `builtinModelIds + access.entitled`；
- Individual/Team Coding Plan 项目 Key 继续按原身份和缓存边界解析；普通按量 API 不调用该链。

### 6.2 UI

- 未登录、未购买、接口失败和明确 entitlement=false 不跳过首次同步、不提前报告订阅成功；
- Plan 状态、quota/usage 和 funnel telemetry 不再读取 Account Provider `enabled` 作为权益；
- Welcome 保存 Z.ai/BigModel Key 只更新对应 Provider Personal Overlay；
- 保存前后 `providerFamilyConnectionSelections` 完全不变；
- Personal Overlay 只含用户输入的 Key/既有 Personal 字段，不复制 Built-in Endpoint、Schema、models 或 group；
- Provider Settings 主列表/添加菜单仍只按 `enabled` 投影。

### 6.3 Off-Peak

- Settings View 同时存在多个 `enabled=true` Account Provider 时，唯一 Registry-entitled Provider 仍能生成 Request Auth；
- Request Auth 保留 JWT、Coding Plan Key、Ticket 和 Team identity Header；
- Start Plan/API Key selection/无 entitlement/账号切换继续明确失败；
- 支持状态、Ticket client、真实派发和 Mock Upstream 使用同一 credential resolver；
- Desktop Host 不再导入 Settings View Account Provider 选择逻辑；凭据不进入 RPC/Renderer/持久化。

### 6.4 机械与回归

- `rg` / `dep:refs` 证明旧 `savePersonalProvider`、Family mode helpers、Account `loadProviderApiKey` 及旧 enabled 文案零残留；
- Provider、Services、UI、Desktop Host 与 CLI 定向单测；
- Welcome、Provider Settings API Key、Account entitlement、连接测试与 Off-Peak 受影响 E2E；
- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm test:unit`；
- 本轮文件格式检查与 `git diff --check`。

## 7. 完成标准

- `enabled`、`entitled`、`executable` 在生产代码、测试和文档中各自只有一个含义；
- UI 不再通过 `enabled` 或 descriptor 存在性推断 Account connected/purchased；
- Welcome 只保存固定 Built-in API Provider 的 Personal Overlay，其他连接选择保持不变；
- Personal Overlay 公共接口名称明确，不再把 Overlay 与 Personal-only Provider 混淆；
- Off-Peak 仍使用既有三份请求材料，但只有一份 Registry/Account Request Auth 解析实现；
- Desktop Host 不含 Account Provider 特化扫描，动态凭据不越过 Host 私有边界；
- 死 Family mode、错误 Coding Plan Key 命名、无效 entitlement 刷新和旧文档事实清零；
- 失败测试先行，定向/全量验证和 Review 完成后提交。

## 8. 实施结果（2026-08-31）

本 Todo 已完成以下代码收口：

- Renderer 的 Account access helper、套餐导航、状态卡、额度刷新与漏斗埋点统一只把
  `access.entitled === true` 解释为当前账号具有权益；`enabled` 不再参与账号已连接/已购判断；
- 通用 Personal Provider 写入口已无 alias 重命名为 `savePersonalProviderOverlay`，从 Config Service、Facade、
  Services 到 UI helper 统一表达“保存稀疏 Overlay”，不再暗示创建 Personal-only Provider；
- Welcome 的 Z.ai/BigModel API Key 继续只写固定 Built-in API Provider 的稀疏 Personal Overlay，并保留既有
  Personal 字段；没有复制 Built-in Endpoint、Schema、模型成员或 group，也没有改写连接 selection；
- Account Connection Resolver 中的凭据依赖已收窄命名为 `loadCodingPlanApiKey`，明确它不是通用 Provider API Key；
- Desktop Host 已删除 Settings View Account Provider 二次扫描。Services 组合根现在只通过 Host-private WeakMap
  暴露同一份 Registry-backed Off-Peak Request Auth builder；该闭包复用正式 Account Request Auth 与三份请求材料，
  不进入 RPC、Renderer、Config 或持久化；
- 无调用方的 `ModelProviderFamilyModeSettings`、默认 mode 与旧过滤 helper 已删除，保留仍在使用的连接选择类型；
- `x-zcode-session-type` 的 `main/subagent/other` 来源归因继续保持请求级事实，未进入 Provider/Model Config。

验证结果：

- Provider/Services/UI 定向测试、根 `typecheck`、`lint`、本轮 41 个文件的格式检查与 `git diff --check` 通过；
- 旧符号机械扫描通过：生产代码中不再存在旧 `savePersonalProvider`、Family mode helpers 或 Account
  `loadProviderApiKey`；
- 全量 unit 共 `12749 passed / 25 skipped / 2 failed`；两个失败均与本轮 Provider 改动无关且可独立复现：
  V4 模型触发器展示文案断言，以及 CUA permission broker 的 stable identity 断言；
- 全仓 `fmt:check` 仍被 Electron 上游示例中的既有非法 HTML 和 `apps/zcode-cli/tests/gb2312.js`
  读取失败阻断；本轮所有改动文件已单独通过 `oxfmt --check`。

# Todo 32：Team Plan 设置页与 Effective Provider 边界收口

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：Team Plan 设置页实机体验与 Provider Refactor 边界复核
>
> 关联任务：[`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md)、
> [`Todo 17`](./todo-17-provider-registry-settings-authority-boundary-closure.md)

## 1. 问题

Team Plan 设置页当前把导航身份、Effective Provider、账号连接、套餐权益、额度查询和错误展示压进同一个
`ModelProviderNavItem`。详情页再使用套餐 `status` 决定是否渲染整个 Provider 配置区域：

```text
Provider 配置事实
账号连接状态
套餐购买状态
Team quota 查询
Team Project API Key 状态
页面导航信息
        |
        v
ModelProviderNavItem.status
        |
        +-- purchased -> 套餐卡 + Provider/模型配置
        `-- 其他状态  -> 仅套餐卡，隐藏 Provider/模型配置
```

实际门禁要求 `dedicatedProvider !== null && status === "purchased"`。因此额度正在加载、请求失败、项目 Key
不可用或服务端明确未分配，都会让已经存在的 Effective Provider、模型列表和 Personal Model Config 编辑入口一起
消失。

当前实现还通过 `statusLabelId` 反推“团队套餐未分配”，并把多种原因合并成 `unavailable`：

```text
服务端明确未分配 ───────────────┐
Team Project Key 不可用 ─────────┤
quota 请求失败 / 状态未知 ───────┼─> unavailable / teamUnavailable
quota 正在加载且没有快照 ────────┘
```

这使“套餐状态卡显示什么”错误地成为“Provider 配置是否存在”的权威，也会把暂时未知误报成服务端已明确判定
未分配。

## 2. 已裁决的权威边界

### 2.1 ProviderSettingsView 的含义

`ProviderSettingsView` 不是新的配置层或第二份配置权威。它是同一次正式 Resolver 结果面向设置页的只读投影：

```text
ZCode Built-in Provider Config
             |
             v
Account Provider Config
             |
             v
Personal Provider Config
             |
             v
Effective Provider Config
             |
             +-------------------------+
             |                         |
             v                         v
ProviderSettingsView              Provider Registry
完整设置投影                      仅完整且可执行的成员
```

`ProviderSettingsView.providers[].effectiveConfig` 和 `models[].effectiveConfig` 是设置页展示 Provider/Model 的最终
结果。`effectiveBuiltinConfig`、`personalConfig`、`personalExactConfig` 和 `issues` 只补充编辑来源、恢复默认、
稀疏保存和修复不完整配置所需的信息，不参与第二次 Overlay。

设置页不能只读 Registry，因为 disabled 或不完整的 Provider/Model 会被 Registry 排除，但仍必须留在设置页供用户
查看和修复。

### 2.2 Renderer 不理解 Account Overlay

Account Provider Config 只在 Resolver 上游参与生成 Effective Provider Config：

```text
Built-in -> Account -> Personal -> Effective
```

Provider 设置页不得重新读取、应用或推断 Account Overlay 的 `enabled`、模型成员或 Access。页面统一读取
`ProviderSettingsView` 中的最终 `effectiveConfig`、`models`、`enabled`、`executable` 和 `issues`。

Team entitlement/usage 请求需要的静态账号 Access 同样从所选 Effective Provider 的 `effectiveConfig.access` 取得；
当前 Team 连接的 `productId / organizationId / projectId` 来自导航选择，只作为本次权益/额度请求上下文，不写回
Provider Config、Account Overlay、Personal Config 或 Registry。

### 2.3 套餐状态不拥有 Provider 配置可见性

Team Plan 页面固定由两条独立投影组成：

```text
ProviderSettingsView
└─ selected providerId
   ├─ effectiveConfig
   ├─ effective models
   ├─ enabled / executable
   └─ Personal 编辑来源
             |
             v
      Provider 配置区域

Team Plan selection
├─ productId
├─ organizationId
└─ projectId
             |
             v
      entitlement / quota
             |
             v
        套餐状态卡
```

两条投影只在右侧详情布局中组合。套餐查询结果可以影响状态卡、额度、重试和购买/管理操作，但不能决定 Effective
Provider、模型列表或模型编辑入口是否存在。

## 3. 目标页面结构

只要 `ProviderSettingsView` 中存在当前 Team Provider，右侧始终保持同一个 Provider 页面：

```text
┌─────────────────────────────────────┐
│ Provider 标题、状态与连接方式       │
├─────────────────────────────────────┤
│ Team Plan 状态卡                    │
│ 组织 / 项目 / 额度 / 错误 / 重试    │
├─────────────────────────────────────┤
│ Effective 模型列表                  │
│ Model A                  [开关][编辑]│
│ Model B                  [开关][编辑]│
└─────────────────────────────────────┘
```

- Team Provider 模型显示、排序、启停和 Personal Model Config 编辑继续使用统一 Provider 设置组件；
- Start Plan 的账号特定模型成员仍保持既有只读边界，本 Todo 不改变；
- Individual / Team Coding Plan 页面完全隐藏 Endpoint 与 API Schema。这只是设置页产品投影：字段继续保留在
  Effective Provider Config 并供 Registry/Runtime 使用，Renderer 不复制、不清除也不覆盖；
- 账号 Access 同样不作为可编辑表单字段展示；
- Provider disabled、配置不完整或套餐不可用时，模型仍可显示和编辑，但不可执行事实必须准确展示；
- Provider 尚在加载时显示加载态；加载完成后确实缺失时显示 Provider 配置异常，不能伪装成未购买或未分配。

## 4. 状态语义

Team Plan 状态必须保留明确原因，不能再由通用 `statusLabelId` 反向推断：

| 状态                     | 套餐卡行为                           | Provider 配置区域    |
| ------------------------ | ------------------------------------ | -------------------- |
| checking                 | 显示加载，清除上一 Team 的额度       | Provider 存在即显示  |
| available                | 显示团队身份与额度                   | 显示                 |
| explicitly-not-allocated | 明确显示“团队套餐未分配”             | 显示                 |
| credential-unavailable   | 显示 Project Key/凭据原因和可用操作  | 显示                 |
| request-failed / unknown | 显示获取失败并允许重试，不称为未分配 | 显示                 |
| provider-loading         | 显示 Provider 加载                   | 暂不显示编辑器       |
| provider-missing         | 显示独立配置异常                     | 不渲染虚假套餐购买页 |

具体类型可以复用现有上游判别结果或建立页面局部的判别联合，但只能作为套餐卡 View State，不能进入 Provider Config
或成为第二份 Account/Registry 状态。

## 5. 实施方案

### 5.1 先固定失败测试

1. Provider 存在且 Team quota 正在加载时，仍渲染模型列表；
2. Provider 存在且 quota 请求失败时，仍渲染模型列表和编辑入口；
3. Provider 存在且服务端明确未分配时，显示未分配提示但仍渲染模型列表；
4. Project Key 不可用时显示真实原因，不误称 quota 未分配，Provider 配置仍存在；
5. Provider 缺失与套餐不可用使用不同 UI 状态；
6. Team 与 Start 的模型编辑权限保持差异，不因共享组件被统一。
7. Individual / Team Coding Plan 页面不渲染 Endpoint 与 API Schema；隐藏不能改变保存 payload 或运行时配置。

### 5.2 解除错误门禁

- 删除 `status === "purchased"` 对整个 `InlineEditableProviderCard` 的渲染门禁；
- 只按当前 `providerId` 是否能在 `ProviderSettingsView` 中解析到 Provider 决定配置区域；
- `CodingPlanStatusPanel` 始终作为 Provider 详情中的独立 `statusSection`；
- 模型列表只消费当前 Provider View 的 `models` 和每项 `effectiveConfig`，不从 entitlement 数据构造模型成员。
- Individual / Team Coding Plan 复用统一 Provider 编辑器时固定关闭连接事实区；不得为显示模型列表而重新暴露
  Endpoint、API Schema，或建立删字段后的 Account Provider DTO。

### 5.3 拆开导航身份和页面事实

收窄 `ModelProviderNavItem` 的职责，使其主要表达导航与连接选择：

```text
Navigation identity
├─ key / type / label
├─ providerId
└─ Team productId / organizationId / projectId
```

Provider 详情从 `ProviderSettingsView` 按 `providerId` 独立解析；套餐卡状态从 entitlement hook 按 Team selection
独立解析。不得继续让一份导航 DTO 同时携带并覆盖 Provider、quota、购买状态和错误状态。

若一次性收窄类型会扩大无关 Family 页面改动，可以先建立单向页面投影并迁移调用方，最终必须删除以
`status/statusLabelId` 控制 Provider 详情存在性的旧分支。

### 5.4 清理状态反推

- 删除 `selectedTeamPlanUnassigned` 对 `statusLabelId` 的比较；
- 删除把 `apiKeyStatus=unavailable` 与 `quota unavailable` 合并后再统一生成 `teamUnavailable` 的逻辑；
- 请求失败、loading 和没有匹配快照只能表达未知，不能表达权威未分配；
- 只有权威响应明确证明没有 Team allocation/quota 时才显示“团队套餐未分配”；
- 状态卡操作按钮依据明确原因决定重试、重连或管理套餐，不从展示文案反推行为。

## 6. 状态 Owner 与提交边界

| 事实                         | 权威 Owner                        | 页面投影                    | 是否持久化         |
| ---------------------------- | --------------------------------- | --------------------------- | ------------------ |
| Effective Provider/Model     | Provider Config Resolver          | `ProviderSettingsView`      | 来自正式 Config 源 |
| Personal Provider/Model 编辑 | Personal Config Repository        | Settings Draft/Facade       | 是                 |
| Provider 可执行性            | Resolver + Registry 完整性        | `enabled/executable/issues` | 不是独立字段       |
| Team 当前连接身份            | Family connection selection       | 导航选择                    | 既有设置           |
| Team 套餐、额度和错误        | Entitlement/Quota Service         | `CodingPlanStatusPanel`     | 仅既有缓存         |
| 请求期凭据                   | Host Account Request Auth Service | 不在设置页常驻              | 否                 |

## 7. 不变量与范围外

必须保持：

- Overlay 顺序仍为 Built-in -> Account -> Personal；
- Model Rules 仍为 Built-in + Personal，Personal 后置；
- Renderer 不重新执行 Overlay、完整性校验或 Registry 准入算法；
- Account Overlay 仍可以约束 Built-in 账号 Provider，但只能通过 Resolver 反映在 Effective 结果中；
- Team quota/entitlement UI 不直接修改 Provider `enabled`；
- Settings 中 disabled/不完整成员可见，Registry 中仍只保留完整可执行成员；
- Team scope 不写回 Config；连接测试和真实请求继续通过正式 Registry/ModelFactory；
- Individual / Team 页面隐藏 Endpoint/API Schema 只影响 UI 可见性，Effective Config 和 ModelFactory 装配保持不变；
- Desktop、Web 和手机共享设置页面行为；不改变 desktop continuous、mobile replayable、远程 workspace 或模型选择生命周期。

本 Todo 不修改：

- Account Overlay 的业务生成规则和优先级；
- Team entitlement、quota、billing 的服务端接口契约；
- Start Plan 的账号模型白名单语义；
- Request Auth、Runtime Headers 和模型网络协议；
- Remote Provisioning、发布制品或真实账号验证。

## 8. 验证矩阵

| Provider View   | Team 状态                | 预期配置区                           | 预期状态卡           |
| --------------- | ------------------------ | ------------------------------------ | -------------------- |
| 存在且 enabled  | available                | 完整显示，可编辑允许的 Personal 字段 | 额度正常             |
| 存在但 disabled | available/unknown        | 显示并准确标记不可执行               | 对应状态             |
| 存在            | checking                 | 显示，不闪退模型列表                 | 加载                 |
| 存在            | request-failed           | 显示                                 | 获取失败 + 重试      |
| 存在            | explicitly-not-allocated | 显示                                 | 明确未分配           |
| 存在            | credential-unavailable   | 显示                                 | 凭据原因             |
| 加载中          | 任意                     | Provider loading                     | 状态不得伪装成未购买 |
| 确实缺失        | 任意                     | 配置异常                             | 可保留已知套餐事实   |

自动化至少覆盖：

- Resolver 生成的 Effective Provider/Model 经过 `ProviderSettingsFacade` 原样进入设置页；
- Account `enabled/models/access` 不在 Renderer 二次合并；
- Personal 最后一层覆盖仍由 Effective 结果体现，保存继续生成稀疏 Overlay；
- Team 状态变化只重渲染套餐卡，不卸载模型列表或丢失模型编辑 Draft；
- Provider/模型排序、开关、编辑、连接测试和保存反馈不回退；
- 中英文、明暗主题、桌面与窄屏布局可用；
- Provider UI 定向单测、`pnpm typecheck`、`pnpm lint`、本轮文件格式检查和 `git diff --check` 通过。

## 9. 完成标准

- Team Plan 任意套餐查询状态都不再控制 Effective Provider 配置区域的存在；
- 设置页只通过 `ProviderSettingsView` 消费最终 Effective Provider/Model，不理解 Account Overlay；
- 导航身份、Provider 设置事实和套餐状态至少在页面投影上形成三条独立链路；
- “团队套餐未分配”只由权威未分配事实产生，不再由错误、loading、凭据问题或 i18n label 反推；
- Provider 存在时模型列表始终可见，并按既有权限支持排序、启停和 Personal Model Config 编辑；
- Individual / Team Coding Plan 页面完全不展示 Endpoint 与 API Schema，但运行时仍使用 Effective Provider Config；
- 不新增第二套 Config、Overlay、Registry、套餐或 Account Access 权威。

## 10. 实施结果

- Team / Individual Provider 详情改为按 `providerId` 从 `ProviderSettingsView` 精确解析，不再把导航项中可能过期的
  Provider 副本作为页面事实；View 已完成加载但目标 Provider 缺失时显示独立配置异常。
- 套餐状态卡与 Provider 配置区解除渲染门禁。Team quota 加载、失败、明确未分配，以及 Project Key 不可用时，
  已存在的 Effective Provider 和模型列表仍然显示。
- `not-allocated` 与 `credential-unavailable` 成为显式页面状态原因；状态卡不再通过 i18n label 反推业务行为，
  quota 恢复后同时清除旧的“团队套餐未分配”状态。
- Team / Individual 页面继续复用统一 Provider 编辑器，但固定隐藏连接配置区与 API Key 区，因此 Endpoint 和
  API Schema 不出现在页面中；Effective Provider Config、Registry 和 ModelFactory 数据未被删减。
- Start Plan 保留既有只读模型及购买门禁，本次没有改变账号模型白名单语义。

验证结果：Provider UI 定向测试 220 条通过；全量 unit 1470 个测试文件、12480 条测试通过（另有仓库既有跳过项）；
根 `typecheck`、`lint`、本轮文件格式检查和 `git diff --check` 通过。全仓 `fmt:check` 仍会被仓库既有
Electron 示例 HTML 语法和 GB2312 fixture 阻断，本轮修改文件已单独通过格式检查。

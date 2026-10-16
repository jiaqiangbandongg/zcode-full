# Todo 49：手填按量 API 与 Coding Plan 凭据边界切换

> 状态：已完成
>
> 日期：2026-08-31
>
> 前置证据：[`todo-48-account-api-and-manual-api-key-boundary-cleanup.md`](./todo-48-account-api-and-manual-api-key-boundary-cleanup.md)

## 1. 目标

撤销 Provider 重构中没有 staging 产品依据的“Account API Provider”，恢复 staging 已有的产品语义：

```text
Family 按量 API
└─ zai-api / bigmodel-api
   ├─ access.type = api-key
   ├─ group = zai-family / bigmodel-family
   ├─ Built-in enabled = true（固定加入 Family 配置）
   ├─ 用户手填 API Key
   ├─ Built-in 提供 Endpoint / API Schema / models
   └─ Personal 保存 Key 和允许的 Overlay

Account Provider
├─ Start Plan
├─ Individual Coding Plan
├─ Team Coding Plan
└─ Off-Peak
```

Coding Plan 为执行模型请求而自动取得项目 Key 的能力继续保留，但只属于 Coding Plan 的内部请求鉴权，不得再被解释为
“账号按量 API”。

## 2. 唯一凭据链

### 2.1 按量 API

```text
用户手填 Key
      |
      v
Personal Provider Config
      |
      v
Effective access.type = api-key
      |
      v
ModelFactory / Adapter 直接使用该 Key
```

- Provider 身份固定为 `zai-api` / `bigmodel-api`；
- 两者分别固定占据 `zai-family` / `bigmodel-family` 的“按量 API”槽位，不进入普通“添加供应商”候选；
- Built-in `enabled=true`，不向用户提供 Provider 启停按钮；缺少 Key 只表示配置不完整、不可执行；
- 不动态创建自定义 Provider；
- 不复制 Built-in Endpoint、Schema 或模型成员到 Personal Config；
- Family 连接选择可以继续使用 `kind: "api-key"`，但必须引用上述普通 API Provider；
- 不进入 Account Overlay、Account Request Auth 或 Coding Plan entitlement 链。

### 2.2 Coding Plan

```text
当前登录账号
      |
      +--> Individual Coding Plan
      |       `--> 根据个人 organization/project 查找或创建项目 Key
      |
      +--> Team Coding Plan
      |       `--> 根据所选 organization/project 取得团队项目 Key
      |
      +--> Start Plan
      |       `--> 使用 Start Plan JWT
      |
      `--> Off-Peak
              `--> 使用当前兼容 Coding Plan 连接的请求材料
```

- 用户不填写 Coding Plan 项目 Key；
- 自动取得的 Key 不进入 Personal Provider Config；
- Individual 继续从当前账号发现个人 organization/project，再查找或创建个人项目 Key；
- Team 继续使用已经选择并校验的 `organizationId/projectId` 取得团队项目 Key；
- 两路可以共享底层项目 Key API，但不能共享身份发现、缓存键或凭据 Owner；
- 相关 Resolver 按真实职责命名，避免 `AccountProviderApiKeyResolver` 再次被误用于普通 `api-key` Provider；
- 不增加策略对象或新的通用 Access 抽象，使用现有 `zhipu-account` Mode 分派即可。

## 3. Config 与 Registry 修改

1. 从 ZCode Built-in Config 删除：
   - `account:zai-api-key`；
   - `account:bigmodel-api-key`。
2. 从 `ZhipuAccountMode` 删除 `api-key`；`zhipu-account` 只保留真实账号产品 Mode。
3. 保留 `zai-api` / `bigmodel-api`，将其 group 分别从 `standard-builtin` 改为 `zai-family` / `bigmodel-family`，
   并让它们成为各自 Family 唯一的按量 API Provider。
4. 两个 Family 按量 API Provider 在 Built-in 中固定 `enabled=true`。Built-in 继续拥有固定 Endpoint、API Schema、
   模型成员和默认顺序；Personal 只保存 Key 及允许的稀疏覆盖，不保存 Family Provider 排序，也不以
   `enabled=false` 表达 Key 缺失。
5. Family `kind=api-key` 选择解析到普通 API Provider；Account Resolver 不再枚举或投影 API Key Mode。
6. Registry 中同一 Family 不得再出现两份 Endpoint、Schema、models 相同、只因 Access 类型不同而重复的按量 Provider。
7. Personal Source 继续禁止真正的 `zhipu-account` Provider 覆盖 `access`；普通 `api-key` Provider 正常允许保存 Key。

### 3.1 统一的 Settings 与 Registry 语义

三类 Provider 不建立三套“启用 UI”。Provider `enabled` 只表达是否加入当前配置；Account 套餐资格由
`access.entitled` 表达。两者进入同一份 Effective Provider Config 后，由 Settings 与 Registry 并列消费：

```text
Effective Provider Config
├─ enabled
├─ visibility
└─ access.entitled（仅 zhipu-account）
        |
        +--> Settings：enabled 决定普通 Built-in 位于主列表还是添加菜单
        |
        `--> Registry：enabled + access entitlement + complete + model enabled
```

- 普通 Built-in 的 Built-in `enabled=false`，添加时由 Personal Overlay 明确写 `enabled=true`；Family 按量 API 与
  Account Provider 的 Built-in `enabled=true`，固定属于 Family；
- 缺少 API Key 或其他配置材料不改写 `enabled`；
- Account Overlay 不再改写 Provider 顶层 `enabled`，只更新 `access.entitled`；
- Provider 设置页不提供通用手动启停按钮。用户补齐相应访问材料后，由同一个 Resolver 自然使 Provider 进入 Registry。

## 4. Services 与 Runtime 修改

1. Account Provider Connection Resolver 删除 `mode=api-key` availability、账号身份检查和动态 Key 加载分支。
2. Account Request Auth 删除 `planKind=api-key` 分支，只处理 Start、Individual、Team 与 Off-Peak 所需动态材料。
3. 将当前过宽的 API Key Resolver 收窄为 Coding Plan 职责：
   - Individual 使用个人项目 Key；
   - Team 继续使用所选团队项目 Key；
   - 普通按量 API 永远不调用它。
4. Welcome 和 Provider Settings 保存的手填 Key只进入 `zai-api` / `bigmodel-api` Personal Overlay。
5. 删除通过手填 Key恢复 Account Provider enabled 的旧 helper、保存分支和相反测试。
6. 不改变 Start JWT、Team scope、Off-Peak 执行、官方版本请求安全校验或最终服务端授权语义。
   删除 `zhipu-account/mode=api-key` 前后，`zai-api` / `bigmodel-api` 真实请求的 V4 行为必须保持等价；不得因为
   删除错误 Provider 身份而静默删除已有签名，也不得把 V4 扩散给其他普通 `api-key` Provider。实施时先以现有
   Adapter 行为和请求测试固定该边界，再将静态准入迁到正确的 Family 按量 API 身份。

## 5. UI 修改

Provider 设置页只读取 Effective Provider Config 的 `access.type` 决定访问配置界面：

```text
access.type = api-key
└─ 展示 API Key 输入、管理入口和普通 Provider 模型配置

access.type = zhipu-account
└─ 展示账号连接、套餐、额度和相应产品状态
```

- 不新增 `hideApiKeySection`、`readOnlyEndpoints` 等重复表达 Access 的页面布尔参数；
- Family 菜单中的 `kind=api-key` 用户文案统一为“按量 API”；
- 选择“按量 API”后展示手填 Key 界面；
- `zai-api` / `bigmodel-api` 不出现在“添加供应商”菜单；
- Account Individual/Team 页面继续隐藏 Endpoint、API Schema 和账号凭据，但模型列表与模型配置保持可编辑；
- Welcome 的 API Key 入口与设置页使用同一 Provider 身份和保存原语。

Model Config 的编辑权限不由 Personal Model Config Rule 决定。Rule 只是用户修改后的稀疏持久化结果：所有设置页允许
编辑的 Built-in/Personal Model 都通过相同 Personal Rule 保存覆盖；模型成员能否改名或删除则由成员来源决定，
Builtin Model ID 只读且不能删除。

## 6. 清理范围

- `account:zai-api-key` / `account:bigmodel-api-key` 常量、Fixture、迁移特例和测试；
- `zhipu-account / mode=api-key` Schema、Protocol、Resolver、Runtime 与 Design 描述；
- Account Provider 的手填 Key persistence；
- `restoreFamilyApiKeyProviderForApiKeyMode` 及其调用方；
- UI 中按 Family/Provider ID 猜测 Key 展示的条件；
- 把 Coding Plan 项目 Key 错称为 Account API Key 的类名、注释和日志；
- Todo 26、Provider Settings Design、Access Protocol Design、Feature Graph 中的错误结论。

## 7. 测试计划

### Config / Provider

- Built-in 只包含 `zai-api` / `bigmodel-api` 两个 Family 按量 Provider；
- 两者使用对应 Family group、Built-in `enabled=true`，且不进入 `addableProviders`；
- `ZhipuAccountMode` 拒绝 `api-key`；
- 普通 API Provider Personal Key Overlay、JSON round-trip 和完整性校验；
- Account Personal `access` 越权仍被拒绝；
- 同一 Family 不存在重复按量 Provider。

### Services / Runtime

- Family `kind=api-key` 精确选择普通 API Provider；
- 手填 Key 原样进入 Active Model，不调用 Account Request Auth；
- Individual Coding Plan 自动取得个人项目 Key；
- Team Coding Plan 使用所选团队项目 Key；
- Start 使用 JWT；Off-Peak 使用当前兼容套餐材料；
- 未登录不影响已配置的手填按量 Provider；手填 Key 也不能伪造 Coding Plan 可用状态。

### UI / E2E

- Welcome 输入 Z.ai/BigModel Key 后进入对应 Built-in API Provider；
- Family“按量 API”显示手填 Key，保存后模型可选并能发送请求；
- Key 为空时 Provider 仍可见且保持 enabled，但不进入 Registry；清空 Key 不自动停用 Provider；
- Individual/Team/Start 不显示手填 Key；
- Family 切换不会复制 Key、重复 Provider 或污染 Account Selection；
- Desktop、Web 与手机远控的模型候选和选择身份一致。

### 机械验证

- `rg` / `dep:refs` 证明被删除 Provider ID、Mode 和旧 helper 零残留；
- 相关 Provider、Services、UI 单测；
- 受影响 Desktop E2E；
- `pnpm typecheck`；
- `pnpm lint`；
- 格式检查与 `git diff --check`。

## 8. 完成标准

- Family 按量 API 与 Account 套餐访问不再共享错误 Access 语义；
- 手填 Key、Coding Plan 项目 Key、Team 项目 Key和 Start JWT 各有唯一 Owner 与唯一请求链；
- Config、Registry、Runtime、UI 和文档中不存在 Account API Provider 幻象；
- `zai-api` / `bigmodel-api` 固定归属 Family 且不进入普通添加供应商流程；
- 没有为修复新增第二套 Access DTO、页面权限矩阵或凭据中心；
- 测试、Review 和机械清理完成后提交 Conventional Commit。

## 9. 实施结果与验证

- `account:zai-api-key`、`account:bigmodel-api-key` 及 `zhipu-account / mode=api-key` 已从 Built-in、Schema、
  Protocol、Resolver、UI、Fixture 与模型规则中删除。
- `zai-api`、`bigmodel-api` 成为两个 Family 唯一的“按量 API”配置；两者固定出现在 Family 设置入口，
  使用 `access.type=api-key` 和 Personal API Key，不再进入普通“添加供应商”目录。
- Account Start、Individual、Team、Off-Peak 只走账号访问材料；Account 页面根据 Effective
  `access.type=zhipu-account` 隐藏 Endpoint、API Schema 与手填 Key，模型配置仍使用统一 Personal Model Rule。
- Welcome API Key 与设置页共同使用真实 Family API Provider 身份；Coding Plan 项目 Key 的自动获取仍只属于
  Coding Plan 请求期凭据链。
- Built-in 完整性、Access Schema、Account/手填 Key Runtime、登录与设置页定向测试通过；机械扫描确认虚构
  Provider ID、旧 Mode 和恢复 helper 在生产代码中零残留。

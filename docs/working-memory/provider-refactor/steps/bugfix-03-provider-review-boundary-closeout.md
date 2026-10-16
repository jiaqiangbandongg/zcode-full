# Bugfix 03：Provider Review 边界收口

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：Provider Refactor 最近一批启动恢复与设置交互 Bugfix 的逐笔复审
>
> 关联任务：[`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md)

## 0. 任务定位

本任务修复最近 Bugfix 复审中已经完成裁决、无需重新设计 Provider 主架构的四个边界问题：

1. Account 首次解析失败时，fail-closed Overlay 漏掉 Off-Peak Provider；
2. 最大输出 Token 同时存在简化输入与完整 JSON 两个编辑入口，可能静默覆盖用户输入；
3. Configured Default 的损坏恢复在文件锁之外删除文件，存在跨进程删除竞态；
4. Host 向 ZCode CLI 执行进程同步 Account Overlay 时使用通用 Provider Parser 和手工门禁，没有使用 Account Source 专属 Schema。

本任务不改变三层 Overlay、Host/CLI 进程职责或 Account Config 同步架构：

```text
ZCode Built-in Provider Config
        |
        v
Host Account Resolver
        |
        v
Account Provider Overlay Snapshot @ revision
        |
        | provider/updateAccountConfig
        v
CLI Account Source（本地事实副本）
        |
        v
Personal Provider Config
        |
        v
CLI Effective Provider Registry
```

Host 在 Desktop 托管模式下继续拥有当前账号连接与套餐事实的权威；CLI 保存 revisioned Account Overlay 副本，用于构建自己的 Effective Registry 和 Active Model。协议不下发账号凭据，不同步完整 Registry，也不让 CLI 重新查询和解析一套账号上游事实。

## 1. Account fail-closed 覆盖 Off-Peak

### 1.1 当前问题

`createFailClosedAccountProviderConfigSnapshot()` 当前只为 `access.type = "zhipu-account"` 的 Built-in Provider 发布 `enabled=false`。两个 Off-Peak Provider 使用：

```ts
access: {
  type: "zhipu-account";
  family: "zai" | "bigmodel";
  mode: "off-peak";
}
```

它们在 Built-in 中没有显式 `enabled=false`，而 Resolver 将 `enabled` 缺省解释为启用。因此首次 Account 解析失败时，普通账号 Provider 被关闭，Off-Peak Provider 却仍可能进入 Registry，并被 Off-Peak 专属 Model Selection View 按固定 Provider ID 投影。

```text
首次 Account 解析失败
        |
        v
只关闭 zhipu-account
        |
        v
Off-Peak enabled 缺省为 true
        |
        v
进入 Registry / Off-Peak Selection View
```

### 1.2 目标行为

Account 首次事实未知且没有 Last Known Good Snapshot 时，所有受 Account Overlay 控制的 Built-in Provider 都必须显式关闭：

```text
Account-controlled Provider =
  access.type === "zhipu-account"
```

Todo 26 已把普通账号与 Off-Peak 的静态身份统一收口为 `zhipu-account`，并由 `mode` 区分产品路径。
正常 Account Resolver 与 fail-closed 复用同一 Account-controlled 判据，不能再维护旧 Access Type 白名单。

### 1.3 验收

- 首次 Account 解析失败时，Start、Individual、Team 与两个 Off-Peak Provider 均为 `enabled=false`；
- 普通 API Key 与 Personal Provider 仍可启动；
- Off-Peak Model Selection View 不包含 fail-closed Provider；
- 后续 Account 刷新成功后，以新 revision 原子替换 fail-closed Snapshot；
- 不修改固定 Off-Peak Provider ID、Provider group、visibility 或请求期鉴权运行契约。

## 2. 最大输出 Token 单一编辑入口

### 2.1 删除重复 UI

设置页删除“最大输出 Token Option Spec JSON”编辑器及对应 Draft 字段。底层正式配置继续保留：

```ts
optionSpecs: {
  maxOutputTokens: {
    type: "limit";
    max: number;
    default: number;
  };
}
```

不得删除 `LimitOptionSpec`、Provider Schema、Effective Model Config、Model Options 校验或 Runtime 对 `max/default` 的使用。推理档位 Option Spec JSON 与 Reasoning Mapping JSON 继续保留。

### 2.2 唯一输入语义

界面的“最大输出 Token”输入框表达用户希望使用的默认输出 Token 数 `N`。比较基准是排除当前 Personal `maxOutputTokens` 槽位后解析出的继承 `max`，记为 `inheritedLimit`：

```text
N <= inheritedLimit
└─ max     = inheritedLimit
   default = N

N > inheritedLimit
└─ max     = N
   default = N
```

示例：

```text
Inherited: max=32000, default=16000

输入 8000
-> Personal: max=32000, default=8000

输入 64000
-> Personal: max=64000, default=64000

随后重新输入 8000
-> Personal: max=32000, default=8000
```

第三步必须把 `max` 恢复为 `inheritedLimit`，不能拿已经被 Personal 扩大后的 Effective `max` 作为比较基准。输入等于 `inheritedLimit` 时保持继承 `max`，并将 `default` 设为该值。

用户输入即表达显式 Personal 意图；即使 `N` 恰好等于继承 `default`，仍保存为显式 Personal 槽位。清空该输入框会删除
`maxOutputTokens` Personal 槽位并重新继承；“全部恢复默认”则一次清除该模型的全部 Personal Model Config Overlay。

完整 Model Config 必须能够解析出 `inheritedLimit`；缺失时显示明确校验错误，不能根据 modelId、Provider 类型或任意常量猜测。

### 2.3 验收

- 页面只存在一个最大输出 Token 编辑入口；
- 小于、等于、大于继承 limit 的输入分别按上述规则生成完整 `LimitOptionSpec`；
- 先扩大 limit、再输入较小值时，`max` 恢复为继承 limit；
- 保存、重新打开和 JSON round-trip 后值不漂移；
- “全部恢复默认”删除完整 Personal 槽位；
- 不再存在 JSON 静默压过数字输入的优先级。

## 3. Configured Default 锁内恢复

### 3.1 背景

Configured Default 是 Environment 级、可重建的 Model Selection 偏好，不是 Provider Config：

```ts
{
  providerId: string;
  modelId: string;
  options?: ModelSelectionOptions;
}
```

文件损坏不能阻断 Registry、Model Selection View 或 ZCode CLI 执行进程启动；忽略或删除确定损坏的偏好、再使用 Registry fallback 是正确策略。

### 3.2 当前竞态

当前实现捕获 `withFileLock()` 的所有失败，并在离开文件锁后删除目标文件：

```text
进程 A                         进程 B
-------                        -------
读取或锁操作失败
离开 withFileLock

                               获得锁
                               写入合法 Configured Default
                               释放锁

rm(filePath)
└─ 删除 B 刚写入的合法偏好
```

同时，锁获取失败、权限错误、临时 IO 错误和 JSON/Schema 损坏被合并成同一种恢复动作。前几类错误不能证明文件内容损坏，不应触发删除。

### 3.3 目标行为

```text
withFileLock
    |
    ├─ 成功读取
    |    |
    |    ├─ JSON/Schema 合法 -> 返回 Selection
    |    `─ 确认内容损坏     -> 在同一锁内删除，返回 undefined
    |
    `─ 无法取得锁 / 临时 IO 失败
         `-> 不删除文件；本轮忽略偏好并报告恢复事件
```

Configured Default 可重建，因此不要求像 Personal Config 一样保留恢复备份；但删除必须同时满足“确定内容损坏”和“仍持有文件锁”。Legacy importer 失败不得删除另一个进程后来写入的正式文件。

### 3.4 验收

- 非法 JSON、非法 Schema 或不支持版本不会阻断启动；
- 确认损坏时只在持锁状态下删除；
- 锁获取失败、读取权限错误和临时 IO 错误只产生本轮 fallback，不删除目标文件；
- 并发保存与损坏恢复不能删除后来写入的合法 Selection；
- 保存与读取继续保留完整结构化 `ModelSelection.options`。

## 4. Account 同步使用专属 Source Schema

### 4.1 职责边界

Host Account Resolver 已经负责把登录、套餐和团队接口的上游结果解析成 Account Provider Overlay。CLI 同步入口不重新解析账号业务，只做物理 Schema 校验和 Snapshot 替换：

```text
Host Account Resolver
└─ 上游账号事实 -> Account ProviderConfigMap
        |
        v
Protocol JSON Envelope
        |
        v
CLI parseAccountProviderConfigMap()
        |
        v
Mutable Account Source.replace(snapshot)
        |
        v
通用 Registry Resolver 执行 Overlay
```

同步入口不得：

- 使用通用 `parseProviderConfigMap()` 后再手写 `access.type` 门禁；
- 重新实现 Account Connection Resolver；
- 根据 Provider ID、Family 或 Access Type 自行拼接一份 Account Config；
- 查询账号、套餐或凭据；
- 接受 `label`、`api`、`group`、`visibility`、`modelIds` 等不属于 Account Source 的字段。

### 4.2 目标实现

`parseProcessAccountProviderConfigSnapshot()` 对 `providers` 直接调用正式 `parseAccountProviderConfigMap()`。删除同步入口现有的通用 Provider Parser 和手工遍历门禁。

Account Source 专属 Schema 继续机械限制当前允许的字段：

- `enabled`；
- 当前账号约束的 `builtinModelIds`；
- Account Access 的非敏感产品与协议事实。

Off-Peak Account Overlay 只同步 `enabled`，因此切换专属 Schema 不影响 Off-Peak。公共 `accessId` 已由
Todo 23/26 删除；Account Source Schema 不接受任何替代名称的公共凭据引用。

### 4.3 验收

- 合法 Start、Individual、Team Account Overlay 可以跨进程 round-trip；
- `{ enabled: true/false }` Off-Peak Overlay 可以跨进程 round-trip；
- Account 同步拒绝 API Key、Endpoint、Headers、label、group、visibility、Personal modelIds；
- CLI 不重新执行账号业务 Resolver；
- 同步消息不包含 JWT、API Key、Team Key、临时 Header 或 Credential Store key；
- Host 与 CLI 使用相同 Account Snapshot revision，CLI 只保存本地执行副本。

## 5. 与 Todo 23 的边界

本 Bugfix 可以独立完成，不等待 Todo 23：

- fail-closed 覆盖 Off-Peak；
- 最大输出 Token 唯一入口与确定性 `max/default` 推导；
- Configured Default 锁内恢复；
- Account 跨进程专属 Schema。

以下问题没有在本 Bugfix 中叠补偿，已由 Todo 23 完成：

- 删除公共 `accessId`，账号凭据和连接版本收回 Account Service；
- Model 编辑一次原子 Host Mutation；
- rename、membership、modelOrder 和 Personal Rule 同事务提交；
- 保存失败保留弹窗与 Draft；
- Personal、Inherited 与 Effective Preview 分离的四态 Draft；
- Built-in 简化编辑器与 Personal-only 完整编辑器分流；
- 相关 Design、Feature Graph 与旧 Todo 的最终事实归零。

## 6. 实施顺序与完成条件

实施必须测试先行，建议顺序：

1. 为 fail-closed Off-Peak、Configured Default 并发恢复和 Account Source Schema 写失败测试；
2. 修复三项领域/持久化边界；
3. 为最大输出 Token 小于、等于、大于、扩大后缩小和恢复默认写失败测试；
4. 删除重复 JSON UI 并实现唯一输入推导；
5. 执行 Provider、Provider Node、Bootstrap、Services 与 UI 定向测试；
6. 执行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 和 `git diff --check`；
7. 检查 Desktop/Web/Mobile、中英文与两种主题下设置页没有布局或交互回归；
8. 完成后提交 Conventional Commit，并更新本文件状态与实施证据。

只有四项验收全部满足，且没有新增第二套 Account Resolver、Provider Parser、Model Config DTO 或运行时具体模型特判，才能将本 Bugfix 标记为完成。

## 7. 实施结果

- 第 1 项 Off-Peak fail-closed 与第 4 项 Account Source 专属 Schema 已由前序提交完成；
- 第 3 项 Configured Default 已收口：确认 JSON/Schema/版本损坏时在同一文件锁内删除；锁、读取与 Legacy
  importer 失败只做本轮 fallback，不再锁外删除；非法内容和非内容读取失败均有回归测试；
- 第 2 项已与 Todo 27 一并完成：删除完整 `maxOutputTokens` JSON 编辑器和对应 Draft 字段，唯一数字输入
  表达 Personal 默认输出值 `N`，确定性解析为 `max=max(inherited.max,N)`、`default=N`；清空重新继承；
  小于、等于、大于、先扩大后缩小均有回归测试；
- UI 定向测试与根 `pnpm typecheck` 已通过；最终 lint、格式与全量回归证据随 Todo 27 收口记录统一补充。

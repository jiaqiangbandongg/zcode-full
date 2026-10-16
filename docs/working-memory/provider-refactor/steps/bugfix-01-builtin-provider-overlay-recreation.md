# Bugfix 01：Built-in Provider Personal Overlay 删除后不可重新添加

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：正式版 ZCode 3.9.2 Provider Settings 运行时复现

## 1. 问题

普通 Built-in Provider 删除后会正确删除 Personal Overlay，并重新出现在“添加供应商”候选中；但同一 Host
进程内再次添加会失败：

```text
provider-settings.addBuiltinProvider FAIL
Provider deepseek 已删除或重命名
```

`ProviderSettingsFacade` 在删除开始时把 Provider ID 写入进程内 `retiredProviderIds`，删除成功后永久保留。
该集合来自旧的 Provider 重命名与删除竞态设计；当前 Provider ID 已只读，而普通 Built-in Provider 必须能够用
稳定 ID 反复创建、删除 Personal Overlay。它因此成为 Config 之外的第二份错误存在性事实。

## 2. 目标边界

```text
ZCode Built-in Provider Config
        |
        +-- Personal Overlay 不存在 --> “添加供应商”候选
        |
        +-- addBuiltinProvider() ------> 创建 { enabled: true } Overlay
        |
        +-- savePersonalProvider() ----> 只更新已有 Overlay
        |
        `-- deletePersonalProvider() --> 删除 Overlay，重新成为候选
```

- `standard-builtin` 只能由 `addBuiltinProvider()` 创建 Personal Overlay；
- `standard-personal` 只能由 `createPersonalProvider()` 创建，普通保存不能凭空创建；
- `savePersonalProvider()` 对这两类 Provider 都是 update-only；
- `zai-family` / `bigmodel-family` 是固定 Family 区域，没有普通“添加”入口，首次账号或 API Key 设置可以创建
  Personal Overlay；
- Facade 只维护同 Provider 操作串行，不维护跨 revision、跨 Overlay 生命周期的退休身份；
- 删除前已经开始的保存先完成，再执行删除；删除后的迟到保存由 Repository 中“Overlay 不存在”拒绝；
- 显式重新添加是新的合法配置操作，不受上一次删除影响。

## 3. 影响面

| 层级                 | 变更                                             | 不变量                                          |
| -------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Provider Settings UI | 无交互改造                                       | 删除后候选仍来自正式 Settings View              |
| Settings Facade      | 删除永久 `retiredProviderIds`                    | 同 Provider Mutation 继续串行                   |
| Config Service       | 普通 Built-in/Personal-only 保存改为 update-only | Family 首次 Overlay 仍可保存                    |
| Personal Repository  | 继续作为 Overlay 存在性的唯一权威                | 原子 update、providerOrder 和专属 Rule 删除不变 |
| Registry/Model       | 仅随正式刷新观察结果                             | Active Model、Selection、Account Overlay 不变   |

Desktop、Web 与 Remote Workspace 都通过目标 Environment Host 的同一 Settings Facade/Config Service，修复不引入
Renderer 本地 fallback，也不改变 desktop continuous、mobile replayable 或任务状态。

## 4. 接受用例

| Case    | Setup                                  | Action                    | Assertions                           |
| ------- | -------------------------------------- | ------------------------- | ------------------------------------ |
| BF01-01 | Built-in DeepSeek 无 Personal Overlay  | 添加                      | 生成 `{ enabled: true }` Overlay     |
| BF01-02 | Built-in DeepSeek 已添加               | 删除后再次添加            | 删除后成为候选；同进程内重新添加成功 |
| BF01-03 | Built-in Overlay 已删除                | 迟到普通保存              | 保存失败且 Overlay 不复活            |
| BF01-04 | Personal-only Provider 已删除/从未创建 | 普通保存                  | 保存失败；必须先走 create            |
| BF01-05 | Family Provider 无 Personal Overlay    | 首次保存 API Key/账号设置 | 允许形成稀疏 Overlay                 |
| BF01-06 | 同 Provider 已有在途保存               | 删除                      | 保存完成后删除，最终 Overlay 不存在  |

不新增 E2E：正式运行时日志已经证明 UI 请求正确到达 Host，缺口位于纯 Provider 领域和 Facade 生命周期；永久单测
覆盖 Config/Facade 边界，现有 Provider Settings E2E 继续承担页面入口回归。

## 5. 完成门禁

- 生产代码中 `retiredProviderIds` 与“已删除或重命名”归零；
- 普通保存不能创建 `standard-builtin` 或 `standard-personal` Overlay；
- Built-in 删除、重加、再保存完整闭环通过；
- Family 首次保存回归通过；
- Provider/Services 定向测试、根 `typecheck`、`lint`、格式检查通过。

## 6. 实施结果

- 删除 Facade 中跨 Overlay 生命周期保留的 `retiredProviderIds`，同 Provider 操作仍按原有 Mutation Queue 串行；
- `savePersonalProvider()` 对普通 Built-in 和 Personal-only Provider 改为 update-only，创建分别只由
  `addBuiltinProvider()` 与 `createPersonalProvider()` 承担；
- 固定 Z.ai/BigModel Family Provider 保留首次保存稀疏 Personal Overlay 的能力；
- 单测覆盖删除后重加、迟到保存、Personal-only 显式创建、Family 首次保存及保存/删除顺序；
- Provider、Provider Node、Services、UI 相关定向测试共 625 项通过，根 `typecheck` 与 `lint` 通过。

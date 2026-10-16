# 旧 IModelProviderService 调用面

> 调查日期：2026-08-17
>
> 适用范围：M2 Host Settings / Selection RPC 迁移
>
> 文档身份：M2 迁移前后的历史调用面证据。正文保留调查当时的“当前”状态；主要消费者已经迁移，
> 尚未物理退役的旧 DTO、Snapshot、接口和 fallback 统一由
> [`../steps/02-provider-config-and-registry-cleanup.md`](../steps/02-provider-config-and-registry-cleanup.md) 跟踪。

## 结论

`IModelProviderService` 不是一个可以整体替换的领域服务。它同时承载配置设置、模型选择、账号套餐、连通性工具和 Host→Worker 迁移桥。新链路按用途退出旧方法：

| 旧方法                                                        | 当前主要用途                                         | 目标归属                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `getAll` / `getAllCached`                                     | 设置页、模型选择、用量 UI、旧执行同步                | Settings View 或 Selection View；不再区分“触发远端同步”和“只读缓存”                                    |
| `save` / `delete`                                             | 设置页与 API Key 登录表单写 Provider                 | `ProviderSettingsService` 写 Personal Config                                                           |
| `getDisplayOrder` / `saveDisplayOrder`                        | 设置页与选择器排序                                   | ProviderConfig / ModelConfig 自身有序 Overlay；旧独立 Preference 退出                                  |
| `resolveWorkspaceModelSelection`                              | 旧 Provider、Workspace Preference 和配置文件混合解析 | 已删除；统一 ZCode Agent 的回显只使用 prepare 回包、App Recent 与 Model Selection View                  |
| `getEndpointSuggestions` / `getModelsByEndpoint`              | 旧 Add Provider 表单的 Endpoint 建议与远端模型探测   | 当前设置表单已改为显式填写 Provider Config；两个无生产调用方的旧接口及 `client/configs` 查询实现已删除 |
| `getCatalogProviders`                                         | 设置页读取旧 Catalog                                 | Official Config 取代 Catalog 后退出                                                                    |
| `testModelConnectivity`                                       | 设置页显式连通性测试                                 | 独立 Connectivity Service，结果不进入 Registry                                                         |
| `refreshPresetProviders`                                      | 同步远端 Builtin/Preset 并改写旧 Store               | Official Config Source / Account Access Source 各自刷新后退出                                          |
| `refreshCodingPlanApiKey` / `clearCodingPlanApiKey`           | 登录、重连和套餐切换                                 | Account Request Auth / Account Access Service                                                          |
| `setProviderRuntimeHeaders`                                   | Start Plan 一次性安全校验 Header 和临时 Header       | 已删除；一次性 Header 只通过请求级 Runtime Header response 传递                                       |
| `getProviderRegistrySnapshot`                         | 设置连通性测试及少量旧兼容调用                     | 本地启动门禁和模型选择已改读 Selection View；完整 Snapshot 仅保留剩余执行兼容，最终退出            |
| `applyToProvider`                                             | 把旧选择与完整 Provider 配置同步给 Agent             | 已删除；Submission 携带 Selection、Worker 自建 Registry                                                  |

旧 Preset 同步的网络失败 fallback 已停止创建 Start Plan。API Key Provider 的兼容兜底暂时保留；Account
Provider 必须由账号连接与权益事实形成 Account Overlay，不能由本地模型白名单推断。

## 新 Host 服务面

新 Runtime 先暴露两个独立 RPC 服务：

```text
ProviderSettingsService
├─ getView
├─ save / delete Personal Provider
├─ save / delete Personal Model Config
└─ reorder Personal Provider / Model

ModelSelectionService
├─ getView
└─ validate(ModelSelection)
```

它们共享同一个 `ProviderRegistryService`，通过读取最新 View 获取模型数据。旧 `IModelProviderService` 的全局 Registry
变更事件已经退出；Renderer 不读取文件、Catalog 或 Account Access，也不执行 Overlay。

## 当前设置页实际包含的四类职责

`ModelProviderSection` 与 `useModelProviders` 目前把四类不同工作编排在同一个页面和 Hook 中。迁移时按职责拆开，比按组件文件逐个替换更安全。

| 职责                      | 当前入口                                              | 目标边界                                                                    |
| ------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Provider / Model 配置编辑 | `getAll`、`save`、`delete`、独立 display order        | `ProviderSettingsService`                                                   |
| 账号与套餐连接            | OAuth、Credential、Subscription、Coding Plan key 刷新 | Account Access / Request Auth；不进入 Settings Config                       |
| 连接测试                  | connectivity test                                     | 独立设置辅助服务；结果不进入 Registry；旧 Endpoint 建议与远端模型发现已删除 |
| 运行时同步                | 保存后向已打开 Workspace 推完整 Registry Snapshot     | Worker 自建 Registry 后删除                                                 |

设置页的 Config 部分可以先按新 View 重写，账号卡片和连通性操作继续调用各自现有服务。迁移过程中不能让账号状态反向写入 Personal Provider Config，也不能因为保留连通性测试而继续使用旧 `save/getAll` 作为事实来源。

## 旧字段到新 Config 的归属

旧 `ModelProviderConfig` 同时包含配置、Catalog 标记、账号状态和运行时数据。真正进入新 Provider Config 的字段如下：

| 旧字段                                                       | 新字段或归属                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `id`                                                         | 外层 `providerId` key                                                         |
| `name`                                                       | 可选 `label`；缺省展示 `providerId`                                           |
| `logoUrl`                                                    | `logoUrl`                                                                     |
| `apiFormat`                                                  | `apiFormat`                                                                   |
| `endpoints.baseURL`                                          | `baseURL`                                                                     |
| `apiKey`                                                     | API Provider 的 `apiKey`                                                      |
| `apiKeyUrl`                                                  | API Provider 的 `apiKeyManagementUrl`                                         |
| `headers`                                                    | 静态 `headers`；当前设置页不提供编辑，但 Official / Account Provider 可以使用 |
| `models` 的成员与顺序                                        | Provider Config 的 `models`                                                   |
| 模型 properties/options/reasoning                            | 精确 Personal `ModelConfig` 或 Official `ModelConfigRules`                    |
| `source`、`modified/deleted`、`systemDisabledReason`、时间戳 | 不进入新 Config；由配置层、成员结果、Account Access 或运行状态表达            |

旧 `endpoints.paths` 不迁入新的公开 Config。当前设置页已经只允许选择一个 `apiFormat`；保存边界会清理历史多协议 path，并把用户填写的完整地址保留在 `baseURL` 中。运行时根据 `apiFormat` 使用对应默认 operation path。新 Config 再保存 paths 会重新制造已经退出的 endpoint 双轨。

当前只建立后端频道，现有 UI 尚未改用新类型。切换设置页时需要同时完成：

```text
冻结旧 save/delete 写入口
        |
        v
执行最后一次旧 Config -> Personal Config 导入
        |
        v
ProviderSettingsService 成为唯一写入口
        |
        v
删除旧 UI 写入和独立 display-order 写入
```

这四步必须处于同一迁移序列，不能让旧写入在新 Personal 文件生成后继续发生。

## 仍需单独处理的消费者

`getAll/getAllCached` 目前还被 Usage、官方版本安全校验、Provider Family 迁移和 Bot 兼容分支调用。本地 Bot 的候选、状态展示和启动迁移已切到 Selection View；本地 Repo Wiki 的展示与预热也已经退出旧 Snapshot。Session create/resume/set/send、V4 草稿预热、replayable/Bot V4 create 和 Automation 模型切换不再从旧 Snapshot 派生普通 runtimeModel，本地 V4 模型切换失败也不再用旧 Snapshot 恢复；旧读取只为未装配新服务的 Entry、desktop-attached remote 和显式兼容调用保留。其余调用并不都需要同一种数据：

- 只显示或选择模型的调用改读 Selection View。
- 需要编辑显式配置的调用改读 Settings View。
- 需要套餐身份或凭据的调用改读 Account Service。
- 需要执行模型的调用通过 Registry 创建 Model。
- 只为 Host→Worker 同步存在的调用随迁移桥删除。

因此 UI 切换不能以“把新 View 转回 `ModelProviderConfig[]`”实现；那会让旧完整结构继续成为隐性事实源，并保留同样的混合语义。

## Client 代理的迁移语义

`RemoteServiceAccess` 会根据频道名直接创建代理；代理对象存在，不等于对端已经注册频道。因此 `IServiceAccessor` 上的可选字段只是迁移期 TypeScript 装配兼容，不能用 `service !== undefined` 作为远端能力协商。

当前设置页从窗口自己的 Local Host 读取 Provider Settings。远端 Environment 的新 Registry 尚未接入时，继续走旧 Remote 服务链路。等所有 Entry 都注册新频道后，删除可选标记；如果未来需要跨版本 Host 能力探测，应增加显式协议能力，而不是靠代理对象是否存在推断。

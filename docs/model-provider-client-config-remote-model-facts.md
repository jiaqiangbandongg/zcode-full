# Client Config 远端模型事实同步（已移除）

> 状态：自 2026-08-22 的 Provider M3 收口起废止。
>
> 当前设计事实源：`docs/working-memory/provider-refactor/steps/03-staging-integration.md`。

## 结论

`/api/v1/client/configs` 不再是 Provider / Model Registry 的事实来源。旧协议中的
`builtinProviders`、`providers`、`builtinModels` 与 `magic_name` 已从客户端解析和同步链路删除，
不再写入个人 Provider 配置，也不再为 Runtime、Catalog 或 Workspace Snapshot 提供模型能力兜底。

静态配置现在只有两条明确路径：

```text
ZCode Built-in Provider Config
    -> Account Provider Config
    -> Personal Provider Config
    -> Effective Provider Config

ZCode Built-in Model Config Rules[]
    + Personal Model Config Rules[]
    -> Effective Model Config Rules[]
    -> 作用于 Effective Provider Config
    -> Effective Model Config
```

其中：

- Provider 的模型成员、Endpoint、API type 和执行期可见性由 Provider Config 表达；
- context、max output、modalities、reasoning 与 API 参数映射由 Model Config Rules 表达；
- Account 接口仍可为 Built-in 账号 Provider 返回账号态 `models[]`，但不提供模型静态能力；
- Personal Provider Config 最后生效；
- 具体模型 reasoning 行为不再由源码特判或远端正则下发，而由 Built-in / Personal Rules 声明。

## `/client/configs` 保留边界

该接口继续承载商品、风控、强更、Agent 灰度和产品功能开关等远端产品配置。它可以继续提供
`offPeak.enable_offpeak_task`，但不再提供闲时任务模型成员或模型能力。

闲时任务的当前链路是：

```text
Built-in Provider `builtin:offpeak-idle-plan` 的 models
    + Effective Model Config
    -> 创建表单和执行期模型静态事实

单次闲时执行绑定
    -> Endpoint、JWT、Coding Plan key、ticket 等访问材料
```

`builtin:offpeak-idle-plan` 使用 `executionOnly: true`，不进入普通模型选择和 Provider Settings。
服务端仍对模型白名单、账号资格和请求授权作最终裁决。

## 历史说明

旧实现曾把远端模型事实合并到本地 Provider，并使用 `modified` / `deletedModels` 处理用户覆盖和删除。
这套同步、墓碑与 fallback 语义已经退出，不应被重新作为兼容路径引入。需要新增或调整模型事实时，
应修改 ZCode Built-in Provider Config / ZCode Built-in Model Config Rules，或由用户通过 Personal Config 覆盖。

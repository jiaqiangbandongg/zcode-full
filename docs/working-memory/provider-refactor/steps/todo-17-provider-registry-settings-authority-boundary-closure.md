# 17 Provider Registry 与 Settings 权威边界收口

> 状态：已完成
>
> 历史说明：本 Todo 建立的 Host/Repository 权威和细粒度保存边界仍有效；Provider/Model 创建、删除、来源、启用、
> 重复成员与排序交互已由
> [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md) 重新裁决。
>
> 日期：2026-08-25
>
> 来源：新增 Provider 实现干净审查，以及随后逐项完成的人工裁决
>
> 相关任务：[`03`](./todo-03-provider-model-ownership-and-property-totality.md)、
> [`12`](./todo-12-model-selection-validation-boundary-cutover.md)、
> [`13`](./todo-13-target-host-model-selection-authority.md)、
> [`14`](./todo-14-post-refactor-mechanical-zero.md)、
> [`16`](./todo-16-unplanned-model-abstraction-residue-cleanup.md)
>
> 相关设计：[`configuration.md`](../design/registry/configuration.md)、
> [`settings.md`](../design/registry/settings.md)、
> [`registry.md`](../design/registry/registry.md)、
> [`model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md)、
> [`model-creation.md`](../design/registry/model-creation.md)

## 0. 任务目标

本 Todo 不新增 Provider 产品能力，而是让已经实现的代码重新服从既有设计，删除新增代码中形成的重复
计算、整包写回、手工字段复制和提前执行判断。

完成后只有一条配置权威链：

```text
Provider Config 路径
====================

ZCode Built-in Provider Config（在线配置）
                    +
Account Built-in Provider Config（只约束 Built-in）
                    |
                    v
Effective Built-in Provider Config
                    +
Personal Provider Config
                    |
                    v
Effective Provider Config


Model Config 路径
=================

ZCode Built-in Model Config Rules
                    |
                    | 对当前 Effective Provider 中的 providerId/modelId/api.type 解析
                    v
Effective Built-in Model Config
                    +
Personal Model Config Rules（数组后置）
                    |
                    v
Effective Model Config
```

两路结果经过一次完整性检查后才进入 Registry：

```text
Effective Provider / Model Config
                 |
                 v
       Registry 完整类型创建入口
            /             \
           /               \
    不完整：issues       完整：Registry Value
           |                   |
           v                   v
       Settings 展示       ModelFactory / 执行
```

Settings 读取 Resolver 已经算好的层次，只编辑 Personal；Registry 只消费完整结果；真正执行一个
`ModelSelection` 时，目标 ModelFactory 做最终判断。

## 1. 明确不做什么

- 不设计或实现 Remote Settings CRUD、远程 Provisioning、远程登录、配置同步与 Remote E2E。
- 不改变现有 Workspace/Environment 的服务路由；本 Todo 只整理一个已经装配好的 Provider Service 内部。
- 不实施 Todo 11 的进程组合根重构，也不处理 Todo 11A 之外的生命周期问题。
- 不改变 M4、Access 产品语义、账号套餐解析、Reasoning Mapping、模型选择持久化或任务队列。
- 不增加 legacy importer、一次性 migration 或兼容窗口。本分支尚未上线，旧的错误内部格式直接删除。
- 不让 Provider Config Service 扫描或改写 Session、Composer、Workspace Recent、Automation 或历史 Turn。
- 不为 Settings 建立临时 Registry、临时 Provider Config 或第二套 Overlay/完整性算法。

## 2. 固定设计

### 2.1 Resolver 是三层结果的唯一计算者

Resolver 必须同时产生设置和 Registry 所需的结果：

```text
Config Sources
      |
      v
Resolver
├─ Effective Built-in Provider Config
├─ Effective Provider Config
├─ Effective Built-in Model Config
├─ Effective Model Config
├─ 冲突、成员、enabled、visibility 与完整性 issues
└─ 可以进入 Registry 的完整 Provider/Model
      |
      +-----------------------+
      |                       |
      v                       v
Settings Facade          Registry Builder
只组织并序列化            只发布完整可执行项
```

Settings Facade 不重新执行 Overlay。Registry 也不能反向生成 Settings 数据，因为 Registry 已经丢弃
disabled、incomplete、重复成员和暂停的 Personal 冲突项。

Built-in Model Rules 必须作用于最终 `Effective Provider Config`。因此 Personal-only Provider 和用户新增的
Personal Model 只要能匹配 Built-in Rule，也会先得到 Built-in 默认模型配置，再叠加 Personal Rules。

`Effective Built-in Model Config` 只是“Built-in Rules 对当前模型的解析结果”，不替代
`ZCode Built-in Model Config Rules` 这个在线配置事实源。

### 2.2 Settings View 返回层次，Renderer 只编辑 Personal

Provider 设置项返回：

```ts
interface ProviderSettingsProvider {
  readonly effectiveBuiltinConfig?: ProviderConfigObject;
  readonly personalConfig?: ProviderConfigObject;
  readonly effectiveConfig: ProviderConfigObject;
}
```

Personal-only Provider 没有 `effectiveBuiltinConfig`。`effectiveConfig` 是服务端权威预览，只用于展示继承值、
最终状态和问题，不被复制成 Personal Draft。

Model 设置项返回：

```ts
interface ProviderSettingsModel {
  readonly effectiveBuiltinConfig: ModelConfigObject;
  readonly personalExactConfig?: ModelConfigObject;
  readonly effectiveConfig: ModelConfigObject;
}
```

这里必须叫 `personalExactConfig`。Personal Model Config Rules 还允许存在批量匹配的规则；单模型设置页只
编辑属于该 `providerId/modelId` 的精确 Rule，不能把全部 Personal Rules 的结果伪装成一份可编辑配置。

恢复某个字段的默认值时：

```text
删除 personalExactConfig 中对应叶子
              |
              v
精确 Rule 为空时删除该 Rule
              |
              v
Resolver 重新运行 Built-in + 全部 Personal Rules
              |
              v
返回新的 effectiveConfig
```

恢复后出现的值可能来自另一条批量 Personal Rule，不保证直接回到 Built-in 值。

### 2.3 Provider 与 Model 分开保存

设置页当前显示的集合永远不能充当 Personal Repository 的完整快照。正式写入按用户本次操作的配置单元
进行：

| 用户操作                                                   | 领域写入                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| 修改 Provider API、Access、Endpoint、Provider enabled      | `savePersonalProvider(providerId, config)`                |
| 修改 Model enabled、Properties、Options、Reasoning Mapping | `savePersonalModelConfig(providerId, modelId, config)`    |
| 恢复一个 Model 字段                                        | 保存删除该叶子后的精确 Config；Config 为空时删除精确 Rule |
| 新增 Personal Model                                        | 原子加入 `provider.modelIds` 并保存初始精确 Model Config  |
| 删除 Personal Model                                        | 原子删除 `modelIds` 成员及其拥有的精确 Rule               |
| 重命名 Personal Model                                      | 原子移动 `modelIds` 成员及其拥有的精确 Rule               |
| 调整 Personal Model 顺序                                   | 只重排 `provider.modelIds`                                |

Provider 页面上的 Model enabled 按钮仍然写 Model Config；控件出现在哪个页面，不改变配置所有权。

必须删除正常保存路径中的：

```ts
savePersonalProvider(providerId, providerConfig, allVisibleExactModels);
replaceExactForProvider(providerId, visibleEntries);
```

删除 Personal-only Provider 时可以批量删除其精确 Rules，但接口必须表达删除语义，例如
`deleteExactRulesForProvider(providerId)`，不能继续保留可被普通保存误用的“整包替换”操作。

### 2.4 同一 Provider 的写入保持用户操作顺序

Renderer 可以继续使用本地 Draft，但同一 Provider 的异步写操作必须按发生顺序提交。不同 Provider 之间
可以并行。

```text
同一 Provider 的操作
修改字段 -> 修改模型 -> 重命名 -> 测试
    |          |          |         |
    +----------+----------+---------+
                       |
                       v
                 逐个完成后再执行下一个
```

最低行为要求：

- 较早保存的迟到响应不能覆盖较新的本地输入或显示为最新成功。
- rename 等待旧 ID 的在途保存完成，然后切换后续操作使用的新 ID；旧 ID 不再接受写入。
- delete 是终止操作；开始删除后，迟到保存不能重新创建 Provider。
- connectivity test 等待相关 Provider 和 Model 的待保存操作完成，再测试保存后的配置。
- 切换设置节点可以保留本地草稿或继续完成已提交保存，但不能让旧节点的响应覆盖新节点。
- 外部刷新到达时，未编辑字段可以跟随新 View；正在编辑的字段保持本地输入。
- 保存成功后以返回的新 View 确认；保存失败保留用户输入和错误状态。

这只是 UI/Service 内部的写入排序，不新增持久化 revision、CAS、事务协议或新的领域对象。

### 2.5 Registry 完整类型拥有唯一受校验的创建入口

`RegistryProviderConfig` 与 `RegistryModelConfig` 表达 Effective Config 已经完整，不是另一套配置事实。

当前裸断言：

```ts
config as RegistryProviderConfig;
config as RegistryModelConfig;
config.toJSON() as RegistryModelConfigObject;
```

必须收口到唯一运行时创建入口。API 可以采用 `from()`、`parse()` 或同等形式，但它必须把结果表达为：

```ts
type RegistryConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly issues: readonly ConfigValidationIssue[] };
```

约束如下：

- 创建入口递归检查 Registry 必需字段；唯一必要的内部类型证明不能泄漏给调用方。
- Resolver 使用这一次结果同时生成 Settings issues 和 Registry value。
- 完整性只回答“必填字段是否齐全”；enabled、visibility、成员冲突和是否注册仍由 Resolver 判断。
- 完整类型的序列化出口返回完整静态结构，不重新暴露 optional 字段。
- Registry 以下不再调用 `requireComplete...`，不再读取 `unknown`，也不再为必填能力补默认值。
- 删除生产代码中其他 `as RegistryProviderConfig`、`as RegistryModelConfig` 和同义断言。

### 2.6 先完成细粒度保存，再应用 Visibility 投影

`visibility` 只影响用户入口，不影响内部 Registry 的精确执行能力：

```text
完整 Registry
├─ hidden Provider / Model 仍可由内部能力精确创建
├─ Settings View 过滤普通 hidden 项
└─ Model Selection 过滤 hidden 项
```

必须先删除整包 Model Rules 写回，再隐藏 Settings 项，否则不可见配置会被 UI 保存误删。

Built-in 与 Personal Model ID 冲突时，Settings 仍需返回解决 Personal 冲突所需的最小诊断；普通 hidden
项不因此重新进入设置或模型选择列表。现有 `builtinModelIds`、`modelIds`、Built-in-wins、Model enabled
与 visibility 设计保持不变。

### 2.7 Provider rename 是纯身份移动

`renamePersonalProvider(oldId, newId)` 只做：

```text
Personal ProviderConfigMap key
oldId -> newId
       +
属于该 Provider 的精确 Model Rules
oldId/* -> newId/*
```

Provider Config 对象原样保留，包括 `label`、`visibility`、`enabled`、`access`、`api`、
`builtinModelIds` 和 `modelIds`。删除 `withoutProviderLabel()` 及所有通过手工枚举字段重建 Config 的同义逻辑。

设置页当前导航节点跟随新 ID，保证用户继续停留在同一编辑对象。Provider Config Service 不改写
Composer、Session Selection、Workspace Recent、Automation 或历史 Turn；旧引用是否仍有效，继续由实际
提交任务、构建 Model 时的 Selection 校验处理。

本分支尚未上线，因此 rename 不承担历史格式清理，不增加 importer 或 migration。

### 2.8 Connectivity 只测试一个正式 Model

测试链路为：

```text
用户点击测试
      |
      v
等待当前 Provider/Model 的待保存操作
      |
      v
提交 providerId + modelId
      |
      v
目标 Agent 使用当前 Registry 的 ModelFactory 精确创建 Model
      |
      +--> 创建失败：返回错误
      |
      `--> 创建成功：通过正式 Adapter 发出最小真实请求
```

UI 可以使用当前 Settings View 的 `executable` 控制按钮状态，但 Renderer 和 Host Service 不再通过
“Provider selectable + Model 出现在设置列表”模拟最终准入。绕过 UI、并发失效或伪造的 Selection 都由
目标 ModelFactory 拒绝。

测试不拼 Endpoint、Header、Reasoning 参数或请求体，不创建独立 Probe Adapter；API Key、Request Auth、
账号访问和 Adapter 编码继续走正式 Model 请求链。

一次操作只测试一个 Model，Settings 返回值改为单结果：

```ts
type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly kind: "auth" | "model_not_found" | "rate_limit" | "network" | "server" | "unknown";
        readonly message: string;
        readonly httpStatus?: number;
      };
    };
```

删除单元素 `results[]`、`EndpointConnectivityResult`、`endpointType` 推断和聚合 UI。测试不改变
Composer Draft、Session Selection、Workspace Recent 或 Active Model。

### 2.9 删除没有生产用途的 Preview API

引用检查结果：

- `previewPersonalProvider()` 只有 Service 转发和测试，没有生产 UI 调用，删除。
- `previewPersonalModelConfig()` 只有 Service 转发和测试，没有生产 UI 调用，删除。
- `previewModelConfig(providerId, modelId, apiType)` 被新增 Personal Model 的页面用于解析 Built-in/Personal
  Rules 默认值，保留。

保存后的权威预览统一来自 Settings View；不再保留一套未保存 Personal Overlay 的整页服务端模拟接口。

## 3. 当前实现偏离

| 偏离                | 当前实现                                           | 目标                                                           |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Registry 完整性     | Resolver 校验后裸 `as Registry...`                 | 唯一受校验创建入口返回完整类型或 issues                        |
| Settings 层次       | 主要返回 Personal + Effective                      | Resolver/Facade 返回 Effective Built-in + Personal + Effective |
| Model 设置命名      | 单模型精确 Rule 也叫 `personalConfig`              | 明确叫 `personalExactConfig`                                   |
| Provider 保存       | 携带页面全部 Model Config                          | 只保存 Provider Config                                         |
| Model 保存          | Model 小页面最终绕回 Provider 整包保存             | 直接保存这一条精确 Model Config                                |
| 保存时序            | 多个异步请求可能交错完成                           | 同一 Provider 按用户操作顺序写入                               |
| Visibility          | 整包保存仍依赖 UI 当前集合                         | 先细粒度保存，再安全过滤不可见项                               |
| Provider rename     | `withoutProviderLabel()` 重建对象并漏 `visibility` | 原样移动 Config 与精确 Rules                                   |
| Connectivity gate   | UI 与 Host 用 Settings 列表重复判断                | 目标 ModelFactory 最终判断                                     |
| Connectivity result | 单元素 Endpoint 数组                               | 单个成功/失败结果                                              |
| Preview             | 两个无生产调用的模拟接口                           | 删除，只保留新增 Model 的规则解析                              |

## 4. Impact Brief

### 4.1 功能与范围

| 字段             | 内容                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 删除 Provider Settings 到 Registry 主链中的重复权威和新增胶水                                                                                                              |
| Capability       | Provider Config、Model Config、Settings、Registry、Connectivity                                                                                                            |
| Change layer     | option-source、validation、commit-effect、persistence                                                                                                                      |
| Operating mode   | planning                                                                                                                                                                   |
| 主要代码入口     | `ProviderConfigResolver`、`ProviderSettingsFacade`、`ProviderConfigService`、`ModelProviderSection`、`InlineEditableProviderCard`、Connectivity Service、目标 ModelFactory |
| 范围外           | Remote Settings/Provisioning、M4、Todo 11、Access/Reasoning 产品语义、任务与模型选择生命周期                                                                               |

### 4.2 UI Surface Matrix

| 用户场景             | UI 入口           | 展示与 Draft                           | 默认/继承                       | 校验                                | 提交                      | 权威落点                         | 必须隔离                  |
| -------------------- | ----------------- | -------------------------------------- | ------------------------------- | ----------------------------------- | ------------------------- | -------------------------------- | ------------------------- |
| 编辑 Provider        | Provider 详情     | Personal Provider Draft；展示三层 View | Effective Built-in + Effective  | Config issues                       | `savePersonalProvider`    | Personal Provider Repository     | Model Rules、Selection    |
| 开关 Model           | Provider 模型列表 | 单模型精确 Draft；展示 Effective       | Built-in Rules + Personal Rules | Model issues                        | `savePersonalModelConfig` | Personal Model Rules             | 其他模型 Rule             |
| 编辑 Model           | Model 小页面      | 单模型精确 Draft                       | Built-in Rules + Personal Rules | Model issues                        | upsert/delete 精确 Rule   | Personal Model Rules             | Provider 其他字段         |
| 新增/改名/删除 Model | 模型列表与小页面  | Personal 成员操作                      | 当前成员集合                    | ID/冲突                             | 领域原子操作              | `modelIds` + owned exact Rule    | Built-in 成员             |
| 重命名 Provider      | Provider 名称编辑 | 当前 providerId Draft                  | 当前 ID                         | 非空/重名                           | 原子 rename               | Provider Map + owned exact Rules | Session/Recent/Automation |
| 测试 Model           | Model 行测试按钮  | 无独立长期 Draft                       | 已保存配置                      | UI 展示 gate；ModelFactory 最终校验 | `testModelConnectivity`   | 无新持久化；正式请求             | 所有 Selection 状态       |

Desktop、Web 和 Mobile 复用同一 UI/Service 契约。本 Todo 不新增远程配置编辑行为，也不把现有远程路由
作为验收目标。

### 4.3 共享与差异

| 关注点      | 共享事实                               | 有意差异                                             |
| ----------- | -------------------------------------- | ---------------------------------------------------- |
| Overlay     | 全部由 Resolver 计算                   | Settings 保留失败候选；Registry 只保留完整可执行项   |
| Draft       | 都只表达 Personal 意图                 | Provider Draft、单 Model Draft、成员原子操作分别提交 |
| Visibility  | 来自 Provider/Model Config             | 内部 Registry 保留 hidden；用户入口过滤              |
| Execution   | 最终都通过 Registry/ModelFactory       | Connectivity 发送固定最小测试请求                    |
| Persistence | Personal Repository 是唯一用户配置落点 | Connectivity 不保存执行状态或测试专用配置            |

### 4.4 关系、Owner 与证据

| Rank           | From                          | 关系            | To                   | 为什么必须看               | 当前证据                                                  |
| -------------- | ----------------------------- | --------------- | -------------------- | -------------------------- | --------------------------------------------------------- |
| must-inspect   | Built-in + Account Built-in   | overlay         | Effective Built-in   | Settings 需要真实只读基线  | `packages/provider/src/resolver.ts`                       |
| must-inspect   | Effective Built-in + Personal | overlay/resolve | Effective Config     | UI 不能复制算法            | `packages/provider/src/facades.ts`                        |
| must-inspect   | Effective Config              | completeness    | Registry Config      | 删除裸类型断言             | `packages/provider/src/resolver.ts`                       |
| must-inspect   | Provider/Model Draft          | commit          | Personal Repository  | 删除整包 Rule 写回         | `providerPersonalSave.ts`、`config-service.ts`            |
| must-inspect   | Model 小页面                  | commit          | exact Model Rule     | 当前错误绕回 Provider 保存 | `InlineEditableProviderCard.tsx`                          |
| must-inspect   | Connectivity Selection        | validate        | Target ModelFactory  | 删除 Host 重复判断         | `providerFacadeServices.ts`、`workspace-model-runtime.ts` |
| should-inspect | Visibility                    | filter          | Settings/Selection   | 不可见数据不能被误删       | `facades.ts`、模型选择投影                                |
| invariant-only | Config refresh                | must-not-mutate | 已创建 Active Model  | 更新只影响后来创建的 Model | Registry runtime design                                   |
| invariant-only | Settings/Connectivity         | must-not-mutate | Model Selection 状态 | 测试与编辑不切换模型       | Settings design                                           |

状态归属固定为：Renderer 只拥有尚未提交的输入；Personal Repository 拥有用户配置；Resolver 拥有三层
计算与诊断；Registry 拥有当前可执行索引；ModelFactory 拥有具体 Selection 的最终构建结果。

### 4.5 Feature Graph 与未决问题

Feature Graph 已声明 Built-in -> Account Built-in -> Personal、完整类型边界、Visibility 过滤和 ModelFactory
最终校验等语义。本 Todo 只修正实现偏离，不新增语义节点。只有实施中符号移动时才更新 code seed；当前
Feature Graph 正由其他工作修改，本 Todo 不覆盖它。

会改变范围的未决问题：无。上文全部边界已经人工确认。

## 5. 实施顺序

每个切片先写失败测试，再修改实现。不要把所有改动压成一个提交。

### Slice A：先修订长期 Spec 与测试契约

1. 更新 `configuration.md`、`registry.md`、`settings.md`、`runtime.md` 和
   `model-membership-and-enablement.md`，写入本 Todo 已确认边界。
2. 删除设计中 Remote Settings 属于本任务、rename 改写当前 Model Selection、legacy importer 承担清理、
   Settings 使用整包 Provider+Model Draft 等错误表述。
3. 为后续每个切片先补对应失败测试；现有测试若固化错误行为，先改为目标契约。

### Slice B：Registry 完整类型与 Resolver 输出

1. 为 Provider/Model 完整创建、递归缺字段 issues 和完整序列化补测试。
2. 实现 Registry 完整类型的唯一受校验创建入口。
3. Resolver 使用同一次结果产生 issues 或 Registry value，删除裸完整类型断言。
4. Resolver 显式保留 Effective Built-in Provider/Model Config。
5. 验证 Personal-only Provider/Model 仍可匹配 Built-in Model Rules。
6. Registry 下游删除 optional/`unknown` 能力适配和重复完整性检查。

### Slice C：Settings 三层 View

1. Provider View 返回 `effectiveBuiltinConfig`、`personalConfig`、`effectiveConfig`。
2. Model View 返回 `effectiveBuiltinConfig`、`personalExactConfig`、`effectiveConfig`。
3. 恢复精确叶子后由 Resolver 重新计算，不从 Effective 反推 Personal。
4. Renderer 只把 Personal 或 Personal Exact 复制成 Draft；删除同时修改 Effective 与 Personal 的双写 helper。
5. 保留批量 Personal Rules 对最终 Effective 的影响，并覆盖 exact restore 后的结果。

### Slice D：分离 Provider 与 Model 保存

1. `savePersonalProvider()` 删除 `exactModels` 参数，只更新 Provider Config。
2. Model 小页面和 Provider 列表的 Model enabled 操作改用 `savePersonalModelConfig()`。
3. 恢复 Model 字段时只删除精确 Config 中该叶子；空 Config 才删除 Rule。
4. 为新增 Personal Model 建立成员 + 初始精确 Rule 的原子操作；删除、重命名和调序继续使用明确的领域操作。
5. 删除正常路径的 `replaceExactForProvider()`；删除 Provider 所需的批量清理改成私有删除语义。
6. 删除 `persistModelProvider()` 遍历全部模型和相关整包表单胶水。

### Slice E：保存顺序与 Visibility

1. 同一 Provider 的 Provider/Model/成员操作按用户顺序完成，不同 Provider 互不阻塞。
2. 覆盖保存后 rename、保存后 delete、测试等待保存、切换页面和迟到响应。
3. 外部 View 更新只更新未编辑字段，不覆盖正在输入的 Draft。
4. 在细粒度保存完成后，Settings/Selection 才过滤普通 hidden Provider/Model。
5. 保留 hidden Built-in 与 Personal 重名时用于解决 Personal 冲突的最小诊断。

### Slice F：Provider rename

1. 先补包含 `visibility`、`label`、Access、API 和成员字段的保留测试。
2. 删除 `withoutProviderLabel()`。
3. rename 原样移动 Provider Config 和 owned exact Model Rules，并保持顺序。
4. 设置页导航跟随新 ID；不改写任何 Selection、Recent、Automation 或历史数据。
5. 删除与 rename 相关的 importer/migration 计划和测试。

### Slice G：Connectivity 收口

1. 测试操作等待已提交的 Provider/Model 保存，不再整包保存全部 Model Config。
2. 删除 UI helper 和 Host Service 中基于 Settings 列表的重复 Registry 准入判断。
3. 使用现有 Workspace 执行链把精确 `ModelSelection` 交给目标 Agent；不新增远程配置能力。
4. 目标 Agent 用当前 Registry/ModelFactory 最终校验并通过正式 Model/Adapter 请求。
5. Settings 结果改成单个成功/失败联合类型，删除 `results[]`、`endpointType` 及 UI 聚合。
6. 验证测试不修改 Composer、Session、Recent、Active Model 或 Registry 配置。

### Slice H：删除无用新增接口和胶水

1. 删除 `previewPersonalProvider()`、`previewPersonalModelConfig()` 及转发、类型和专属测试。
2. 保留新增 Model 页面使用的 `previewModelConfig()`。
3. 使用 `pnpm dep:refs` 与精确文本搜索复核旧 preview、整包保存、裸完整类型断言、
   `withoutProviderLabel()` 和 Endpoint connectivity 类型已无生产引用。
4. 更新实现日志；Feature Graph 仅在真实 symbol/code seed 改变时更新。

## 6. 接受用例

| Case ID | Setup                                              | Action                                | Assertions                                                  | 证据层                    |
| ------- | -------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| PRS-01  | 完整 Effective Provider/Model                      | 创建 Registry Config                  | 返回完整静态类型；完整序列化                                | Provider unit + typecheck |
| PRS-02  | 缺 Endpoint 或 Model format 叶子                   | 创建 Registry Config                  | 返回精确 issues；不进入 Registry                            | Provider unit             |
| PRS-03  | Built-in + Account Built-in + Personal 同 Provider | 获取 Settings View                    | 返回 Effective Built-in、稀疏 Personal、最终 Effective      | Resolver/Facade unit      |
| PRS-04  | Personal-only Provider/Model 匹配 Built-in Rule    | 获取 Settings View                    | Provider 无 Built-in 层；Model 得到 Built-in Rule 默认值    | Resolver/Facade unit      |
| PRS-05  | Provider 下有模型 A、B 的精确 Rules                | 只保存 A                              | B 的匹配条件、内容和顺序语义不变                            | Config Service unit       |
| PRS-06  | 存在当前 UI 不展示的 Personal exact Rule           | 编辑 Provider 字段                    | 不可见 Rule 保留                                            | Service + UI unit         |
| PRS-07  | 普通 hidden Provider/Model                         | 获取 Settings/Selection；内部精确创建 | 用户入口不展示；内部创建仍成功                              | Facade + Registry unit    |
| PRS-08  | hidden Built-in 与 Personal 同 ID 冲突             | 获取 Settings                         | 只返回可解决冲突的诊断；Built-in 内部仍可执行               | Resolver/Facade unit      |
| PRS-09  | Personal Provider 含全部可选字段                   | 重命名 Provider                       | Config 全字段与顺序保持；owned exact Rules 迁移             | Config Service unit       |
| PRS-10  | 同一 Provider 快速连续编辑                         | 连续提交两个操作                      | 最终状态符合用户操作顺序；旧响应不覆盖新输入                | UI/Service unit           |
| PRS-11  | disabled/incomplete Model                          | UI 点击或绕过 UI 调用测试             | UI 正常禁用；绕过后由目标 ModelFactory 拒绝                 | UI + Agent unit           |
| PRS-12  | 保存后可执行 Model                                 | 测试连接                              | 正式 Model/Adapter 完成请求；返回单结果；Selection 状态不变 | Service/Core integration  |
| PRS-13  | 保存后、请求前 Registry 更新使模型失效             | 测试连接                              | 目标 ModelFactory 按当前 Registry 拒绝，不信任 Host 旧 View | Agent integration         |
| PRS-15  | 批量 Personal Rule + 单模型精确 Rule               | 恢复精确叶子                          | 最终值按全部 Rules 重算，可能回到批量 Personal 值           | Resolver/Facade unit      |
| PRS-16  | 用户正在编辑，外部 View 更新                       | 接收新 View                           | dirty 字段保留；未编辑字段更新                              | UI unit                   |
| PRS-17  | 保存尚未结束                                       | 重命名 Provider                       | 先完成旧 ID 保存，再迁移身份；旧 ID 不被重建                | UI/Service unit           |
| PRS-18  | 保存尚未结束                                       | 删除 Provider                         | 删除后迟到保存不能复活 Provider                             | UI/Service unit           |
| PRS-19  | Provider/Model 有待保存操作                        | 点击测试                              | 等待保存后测试最新正式 Model                                | UI/Service integration    |
| PRS-20  | 新增 Model 输入匹配现有 Rules                      | 请求 `previewModelConfig`             | 返回规则解析默认值；不产生持久化                            | Facade/UI unit            |

PRS-05 比较解析后 Rule 的身份、顺序、匹配条件和配置内容，不要求配置文件缩进等原始字节完全一致。

## 7. 剪枝与不变量

| Decision | 剪枝范围                               | 原因                                      | 代表验证                                      |
| -------- | -------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| PD-01    | 全部 Provider API/Access 笛卡尔积      | 本 Todo 不改变 Access 或 Adapter 产品语义 | API Key 与现有账号/Request Auth 各保留回归    |
| PD-02    | conversation phase、queue、goal        | Settings 不拥有任务状态                   | Connectivity 断言 Selection/Active Model 不变 |
| PD-03    | Remote Settings/Provisioning/登录/同步 | 已明确属于独立产品能力                    | 不增加 PRS 或 Remote E2E                      |
| PD-04    | legacy importer/migration              | 分支尚未上线，不保留错误格式兼容          | 更新当前 fixture/schema 即可                  |
| PD-05    | Todo 11、M4、Todo 13 的其他范围        | 不属于本次新增胶水收口                    | 只复用其已经存在的正式边界                    |

必须保持：

- Provider Overlay 顺序是 ZCode Built-in -> Account Built-in -> Personal。
- Account Built-in 只约束 ZCode Built-in Provider；Personal 始终最后覆盖。
- Model Rules 是 ZCode Built-in Rules + Personal Rules，并作用于 Effective Provider。
- Personal Config 与 Personal exact Rule 始终稀疏，不能从 Effective 反向展开。
- `builtinModelIds` 和 `modelIds` 的所有权、冲突、顺序与 enabled 设计不变。
- Config 更新只影响之后创建的 Model；已创建 Active Model 不被热修改。
- hidden 是产品可见性，不是鉴权、安全边界或执行能力豁免。
- Connectivity 不改变任何用户模型选择，也不保存测试专用 Runtime 状态。
- Settings UI 不直接调用 Repository，不自行解析 Config Rules。

## 8. 验证与完成定义

### 8.1 测试顺序

1. 每个切片先补失败的 Provider/Services/UI/Agent 单测，再修改生产代码。
2. Provider unit 覆盖 Overlay、完整类型、序列化、冲突、Visibility、rename 和精确 Rule mutation。
3. Services unit 覆盖三层 View、保存顺序和 Connectivity 错误投影。
4. UI unit/component 覆盖 Provider/Model 分离保存、Model 小页面、enable、恢复、dirty Draft 和测试按钮。
5. Agent/Core integration 覆盖 ModelFactory 最终校验和正式 Adapter 请求。
6. 复用已有 Provider Settings E2E 覆盖用户主路径；不为 Remote Settings 新增用例。
7. 最终执行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 和受影响测试。

### 8.2 完成条件

1. Resolver 是 Effective Built-in、Personal、Effective 和诊断的唯一计算者。
2. Settings View 返回明确三层事实，Renderer 只编辑 Personal/Personal Exact。
3. Registry 完整类型只能通过唯一受校验入口获得；下游没有 `require`、`unknown` 或裸完整类型断言。
4. Provider 与 Model 保存完全分开；任何普通操作都不会整包替换其他 Model Rules。
5. 同一 Provider 的异步操作保持用户顺序，rename/delete/test 与迟到响应行为有测试。
6. Visibility 过滤不丢失隐藏配置，冲突诊断与内部精确执行保持正确。
7. Provider rename 不重建 Config，不做兼容清理，不跨域改写 Selection。
8. Connectivity 由目标 ModelFactory 最终校验，返回单结果，不保留 Endpoint 聚合胶水。
9. 两个无生产调用的 Personal Preview API 和相关转发被删除；新增 Model 的规则预览保留。
10. 长期 Design、实现日志和必要 code seeds 与最终代码一致。
11. 所有接受用例和强制校验通过。
12. 实施按切片提交 Conventional Commits，不混入 Todo 11、M4 或远程配置产品能力。

## 9. 实施记录（2026-08-25）

- Resolver 现在唯一计算 Effective Built-in、Personal 与 Effective 三层结果，并用唯一完整类型创建入口同时
  产生 issues 与 Registry Value；完整序列化不再经过稀疏 `toJSON()` 断言。
- Settings View 已明确返回 Provider 的 `effectiveBuiltinConfig/personalConfig/effectiveConfig` 与 Model 的
  `effectiveBuiltinConfig/personalExactConfig/effectiveConfig`；普通 hidden 项在细粒度写入完成后过滤。
- Provider 与 Model 保存已经彻底拆分。新增 Personal Model 原子写入成员和初始精确 Rule；删除、重命名、
  调序与恢复默认分别使用明确领域操作；正常 UI 路径不再遍历全部可见模型或替换整组 Rules。
- 同一 Provider 的写操作由 Facade 串行化。rename/delete 的成功与失败身份边界、旧 ID 拒绝、外部 View 与
  dirty 字段合并均有测试；连接测试等待该队列后再向目标 Environment 提交精确 Selection。
- Provider rename 原样移动 Config 与 owned exact Rules，不修改 Selection 等其他领域状态。
- Connectivity 使用正式 Agent ModelFactory/Adapter 链并返回单结果；Host 重复准入判断、Endpoint 聚合、
  `endpointType` 推断及两个无生产用途的 Personal Preview API 已删除。
- `pnpm knip` 仍报告仓库既有的大量 unused/unlisted 基线；本轮再以 `dep:refs` 和精确文本搜索确认被删除
  符号及整包保存入口没有残留生产引用。

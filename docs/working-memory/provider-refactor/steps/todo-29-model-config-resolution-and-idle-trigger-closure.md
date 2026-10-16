# Todo 29：Model Config Resolution 与设置页 Idle Trigger 收口

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：Provider 设置页真实体验反馈
>
> 关联任务：[`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md)、
> [`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md)、
> [`Todo 28`](./todo-28-model-rule-precedence-and-order-canonicalization.md)

## 1. 问题定位

新增模型弹窗已经通过 Host 根据 `providerId/modelId/api.type/baseURL` 解析 Model Config Rules，
但 Renderer 对同一份解析结果采用了三套不一致的投影：

```text
Model Config Rules Resolution
├─ context/max output ──> inherited placeholder
├─ boolean properties ──> 复制进本地 Draft
└─ reasoning JSON ──────> 未接入，错误显示为“—”
```

因此 `GLM-5.3-Flash` 实际已经命中 1M context、128K max output、Image/Video 和 reasoning
规则，弹窗却只完整展示了部分默认事实。与此同时，新增模型解析使用 300ms debounce，编辑模型 ID
解析使用 180ms debounce，Provider 文本保存使用 800ms idle save；短暂停顿会频繁触发请求、字段跳变、
配置写入和 Registry 刷新。

本 Todo 收口默认配置解析、稀疏 Draft、成功反馈和文本 idle-trigger。它不改变 Model Config Rule
优先级、Provider/Model Overlay 顺序、Registry 完整性或 Active Model 冻结语义。

## 2. 统一领域命名

设置页不再使用 `previewModelConfig`、`previewPersonalModelDraft`、`resolvedDefaults` 等近义概念。
唯一操作命名为 `resolveModelConfig`：

```ts
const resolution = await providerSettingsService.resolveModelConfig(input);
setResolution(resolution);
```

- 方法：`resolveModelConfig`；
- 返回结构：`ModelConfigResolution`；
- Renderer 局部状态：`resolution`；
- 返回内容继续是 `inheritedConfig/effectiveConfig/issues`；
- 新增模型只解析当前候选 ID；编辑模型可以携带尚未保存的 Personal Exact Draft 和原 Model ID，
  但不写 Personal Config、不改变 Registry revision。

`resolve` 表达按当前 Rules 得到配置结果；是否持久化由独立保存命令决定，不再用 `preview` 作为领域名。

## 3. Draft 与继承事实

新增和编辑模型都遵守同一条 Overlay 展示链：

```text
ZCode Built-in + Personal Match Rules
                 |
                 v
        inheritedConfig
                 +
     sparse Personal Draft
                 |
                 v
        effectiveConfig display
```

- Renderer 可以在表单展示状态中缓存 Resolution 的布尔值，但该缓存不是 Personal Config；
- 用户明确触碰的字段单独记录，迟到的 Resolution 不得覆盖这些字段；
- 数字、布尔和 JSON 均从同一份 Resolution 派生展示值；
- context/max output 和 reasoning JSON 使用 inherited/effective placeholder；
- 布尔控件显示 `Personal Draft ?? inheritedConfig`，只有用户明确修改时显示 Personal Override 样式；
- 通用 Rule 中的 `false` 是完整默认事实，不是“未获得默认值”；
- 保存时只新增 Provider 的 Personal 模型成员以及真正存在的稀疏 Exact Rule，不反向物化 Effective Config。

## 4. 统一 Idle Trigger

Provider 文本保存、新增模型配置解析和编辑模型配置解析复用一个 idle-trigger 调度语义：

```text
onChange
├─ 立即更新本地 Draft
├─ 取消上一计时器
└─ 1200ms 无新输入
       |
       v
  执行当前动作
  ├─ Provider：保存 Personal Provider Draft
  └─ Model：解析 Model Config

onBlur / Enter / 显式保存
└─ 取消计时器并立即 flush 当前动作
```

- 统一 idle 时间为 1200ms；
- 连续输入只执行最后一次；
- IME composition 期间不触发；
- Resolution 请求使用单调序号或等价身份校验，过期响应不得更新当前 Model ID；
- 点击模型保存时若解析仍处于 scheduled/in-flight，必须立即 flush 并等待完成，再在同一次点击中保存，
  不要求用户二次点击；
- Provider blur/Enter/切换前保存和卸载保护保持不变；只替换定时调度，不建立第二份保存队列。

## 5. Resolution 成功横幅

模型弹窗在新的 Resolution 确实改变继承配置时显示绿色成功横幅：

> 已加载模型默认配置

```text
Resolution 完成
├─ inheritedConfig 与当前已应用结果相同
│  └─ 静默：不更新字段，不显示横幅
└─ inheritedConfig 确实变化
   ├─ 原子更新全部继承展示
   └─ 显示一条成功横幅
```

- 第一次成功加载出配置时显示；
- 重复失焦、重复解析、只改变大小写但配置相同，以及不同 ID 得到完全相同的继承配置时不显示；
- 失败、过期或不完整 Resolution 不显示成功横幅；
- 横幅位于模型弹窗内容区的固定反馈位置，使用现有语义成功色、对勾和国际化，不因内容滚动移出视野；
- 同一稳定 key 原位替换，不堆叠多条相同反馈。

“已加载”只说明已取得一份规则解析基线；通用 `modelMatch: ".*"` 同样可以提供默认配置，文案不宣称
服务端已经识别或授权该模型。

## 6. 影响边界

| 层级          | 本次处理                           | 保持不变                                     |
| ------------- | ---------------------------------- | -------------------------------------------- |
| draft-default | 统一 Resolution 投影与稀疏 Draft   | Rule 内容与覆盖优先级                        |
| presentation  | 新增成功横幅、消除 JSON 缺省误展示 | Model 字段顺序和可编辑范围                   |
| commit-effect | 统一 1200ms idle/blur flush        | Host 保存、Registry refresh 和 revision 权威 |
| validation    | 保存前等待当前 Resolution          | 完整性规则和 Adapter compatibility           |
| persistence   | Provider 文本仍自动保存            | Personal Config Schema 与物理位置            |

不修改模型选择、连接测试、账号套餐、Remote Provisioning、Desktop continuous、Mobile replayable、队列或恢复链路。

## 7. 测试计划

1. `GLM-5.3-Flash + anthropic-messages` 展示 1M、128K、Image/Video、reasoning spec 和 mapping；
2. Built-in `false` 能力作为继承值展示，但不写入 Personal Rule；
3. reasoning JSON 使用 Resolution placeholder，不再显示错误的“—”；
4. 1200ms 内持续输入不调用 Resolution/Provider save，稳定后只调用一次；
5. blur/Enter 立即 flush，点击保存等待 Resolution 并一次完成；
6. 迟到 Resolution 被丢弃；相同 inheritedConfig 不重复更新字段或显示横幅；
7. 配置变化时横幅显示一次，失败和不完整结果不显示；
8. Provider name/baseURL/API Key idle save 改为 1200ms，blur 与切换前保存不回归；
9. 新增模型未触碰字段时只保存成员和必要的稀疏 Personal Rule；
10. 中英文、浅色/深色主题、键盘与窄窗口下横幅可用。

## 8. 完成标准

- Settings 只有 `resolveModelConfig` 一套领域命名和一份 Resolution 状态；
- 新增/编辑弹窗的全部继承字段来自同一 Resolution；
- Renderer 不把继承布尔值物化为持久化 Personal Config；
- 文本 idle-trigger 统一为 1200ms，主动结束编辑会立即 flush；
- 成功横幅只在继承配置发生变化时出现；
- 相关 Design、Feature Graph、单测、typecheck、lint 和格式检查同步通过；
- 完成后提交 Conventional Commit。

## 9. 实施结果

- Settings Facade 与 Service 删除两套 `preview*` 接口，统一为 `resolveModelConfig()`、
  `ModelConfigResolution` 和 Renderer `resolution` 状态；
- 新增和重命名弹窗共用 1200ms idle-trigger，blur、Enter 和保存会立即 flush；保存不再因解析在途而要求二次点击；
- 数字、布尔、Reasoning Option Spec 与 Reasoning Mapping 全部由同一 Resolution 展示；
- 新增模型表单单独记录已触碰字段，迟到的 Resolution 不覆盖用户输入，最终 Personal Config 继续保持稀疏；
- “已加载模型默认配置”只在完整的 `inheritedConfig` 真正变化时显示；重复解析不续期、不堆叠；
- Provider name、Base URL 与 API Key 的停止输入保存统一延长至 1200ms，blur/Enter/切换前保存不变；
- 真实 Built-in Config、Facade、Provider 自动保存、模型弹窗、迟到响应和稀疏提交均已有定向回归证据。

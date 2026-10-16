# Todo 82：模型配置跟随推荐与 Draft 物化

> 状态：已完成
>
> 日期：2026-09-04

## 背景

模型编辑弹窗同时提供了模型列表行开关和弹窗内“开启”开关，两个入口修改同一个模型 `enabled` 配置，造成重复。当前弹窗底部还有“全部恢复默认”，但模型配置已经使用 Built-in 推荐值与 Personal Model Config Overlay 的稀疏合并，缺少一个明确的“跟随推荐”模式。

本 Todo 将两套交互收口为一个配置模式开关：用户可以继续跟随 Built-in 推荐配置，也可以把当前配置固定为完整的个人配置。切换只修改弹窗 Draft，点击“保存”后才持久化。

## 产品裁决

### 1. 删除弹窗内重复的模型启用入口

- 删除模型编辑弹窗中模型 ID 旁边的“开启”开关及其 Draft 字段。
- 保留模型列表行右侧的 `enabled` 开关，继续作为模型启用状态的唯一 UI 入口。
- `enabled` 仍是 Model Config 的正式字段，但不属于“跟随推荐配置”开关的编辑范围。

### 2. “跟随推荐配置”取代“全部恢复默认”

弹窗只保留一个配置模式开关，推荐文案为：

- 中文：`跟随推荐配置`
- 英文：`Follow recommended settings`

开关开启表示继续使用当前稀疏 Overlay 逻辑；关闭表示固定当前模型的个人配置。删除底部“全部恢复默认”按钮及其重复交互，不新增第二个重置入口。

### 3. 两种模式的配置语义

```text
跟随推荐配置：开
  -> 未覆盖字段使用 Built-in 推荐值
  -> Personal Overlay 保持稀疏
  -> 推荐配置更新后，未覆盖字段跟随更新

跟随推荐配置：关
  -> 当前 Effective 值写入 Personal Overlay
  -> 编辑器管理的字段全部显示为真实输入
  -> Built-in 推荐值不再参与这些字段的结果
```

关闭状态下保存的是一份完整的“编辑器管理字段” Personal Overlay，不是一次性的 UI 快照。打开状态下重新保存时，清空该模型的 Personal Overlay，恢复推荐值和 placeholder。

### 4. Draft-only 切换

```text
打开弹窗
    |
    v
读取当前 Personal Overlay + Effective Built-in
    |
    v
形成本地 Draft
    |
    +-- 开 -> 关：把当前 Effective 值物化到 Draft
    |
    +-- 关 -> 开：清空 Draft Personal Overlay，恢复 placeholder
    |
    +-- 继续编辑：只修改 Draft
    |
    +-- 取消：丢弃全部 Draft 修改
    |
    `-- 保存：一次性提交当前模式和配置
```

切换模式、编辑字段和“恢复推荐值”都不得直接写 Personal Config、刷新 Registry 或触发远端同步。只有保存成功后，才按现有 Provider Settings Facade 的单次保存入口提交并刷新。

### 5. 模式的存储位置

模式属于具体 `providerId + modelId` 的 Personal 精确模型配置记录，建议使用一个可选字段表达：

```ts
{
  type: "provider-model",
  providerId,
  modelId,
  useRecommendedConfig: true,
  config: {
    // Personal Model Config Overlay
  }
}
```

- 缺失或 `true`：跟随推荐配置；
- `false`：固定个人配置。

该字段是 Settings 配置模式元数据，不进入 `ModelConfigObject`，不参与 Model Registry、ModelFactory 或请求参数。现有 `provider-model` Rule 名称和 Provider/Model 身份不改；UI 使用“个人模型配置”或 `personalExactConfig` 等清晰名称。

### 6. `enabled` 的边界

“跟随推荐配置”只覆盖编辑器管理的配置字段：Context、Max Output、输入/输出类型、能力、Reasoning、Mapping 和高级配置。模型 `enabled` 由列表行开关单独管理，模式切换不得偷偷启用或停用模型。

因此“完整 Personal Overlay”指完整覆盖编辑器管理的字段；不以模式切换替代模型列表的启用操作。

## 实施范围

- 扩展当前 Personal 精确模型配置记录以保存配置模式；优先与 Todo 76 的 `provider-model` Rule 整理一并落地，不新增 Provider 层或 Registry 层配置。
- 将“跟随推荐配置”加入模型编辑 Draft，确保切换时表单值、placeholder、Personal 来源样式和保存按钮状态即时更新。
- 关闭跟随时，以当前最新 Effective 值生成完整的编辑器管理字段 Overlay；不能使用过期的 Built-in 快照。
- 打开跟随时清空 Draft Overlay；保存后恢复推荐值。该动作不保留此前的个人覆盖，用户如误操作可在保存前取消。
- 保存时复用现有模型 Draft 保存入口和 revision 校验，模式字段与配置在一次原子操作中提交。
- 关闭模式保存前校验 Personal Overlay 已覆盖所有编辑器管理字段，且解析结果不再依赖 Built-in 对这些字段的补值；校验失败不得部分保存。
- 保留现有“全部恢复默认”核心能力的结果，但由“跟随推荐配置”开关承载；删除旧按钮、旧回调和仅供旧入口使用的状态分支。
- 无 Built-in 推荐基线的纯自定义模型不显示或禁用该开关，继续使用普通 Personal 配置编辑。

## 非目标

- 不修改 Provider 顶层配置、Provider Template、Account Access 或 Provider/Model 身份。
- 不改变 Model Registry、ModelFactory、Adapter 和请求协议；Runtime 不读取配置模式字段。
- 不改变模型列表行的 `enabled` 开关语义。
- 不新增“跟随推荐策略”或另一套 Model Config Overlay 类型。
- 不在切换时自动保存、自动刷新 Registry 或单独触发远端 Provisioning。

## 测试与验收

先补测试，再实现：

- 弹窗不再出现重复的模型“开启”控件；模型列表行启用开关行为不变。
- 打开弹窗后切换开关只改变 Draft，Personal Config、Registry 和远端同步在保存前均不变化。
- 开 -> 关：所有编辑器管理字段填入当前 Effective 值，placeholder 消失，保存后形成完整 Personal Overlay。
- 关 -> 开：Draft Overlay 清空，字段恢复推荐值/placeholder，保存后不再保留原 Personal 覆盖。
- 切换后取消：恢复切换前的模式和所有字段，不能留下写盘结果。
- 关闭模式下修改任意字段后保存，仍保持完整 Personal Overlay；后续 Built-in 更新不改变这些字段。
- 打开模式下重新编辑并保存后，未覆盖字段继续跟随 Built-in 更新。
- `enabled` 在任何模式切换中保持原值，只能通过模型列表行开关改变。
- 已有配置缺少模式字段时按“跟随推荐配置”处理，不需要数据迁移。
- Built-in 基线缺失或不完整时不能生成半成品 Overlay，保存应明确失败且不写入部分结果。
- Registry revision 变化、并发保存和迟到响应不会用旧 Effective 值覆盖新 Draft。
- 运行 Provider Settings、Model Config、Registry、Settings UI 相关单测及桌面/远程端必要回归；确认不会改变 Model Selection、Automation、Subagent、Wiki 和 Composer 的模型选择语义。

## 与现有 Todo 的关系

- Todo 55 已确定 Model `enabled` 保留、Provider 顶层 `enabled` 删除；本 Todo 只删除弹窗重复入口，不改变该结论。
- Todo 76 已完成 Provider Site、Template Model 和 Provider Model Rule 的分层整理；本 Todo 的模式字段并入同一条 Personal 精确 `provider-model` 记录，没有另造一层。
- Todo 77 已完成，开关样式复用现有设计系统控件；本 Todo 只增加配置模式语义。
- Todo 81 负责 Composer/闲时任务的模型选择失效提示，与本 Todo 的模型配置继承模式相互独立。

## 9. 实施记录（2026-09-04）

- `provider-model` Personal Rule 增加可选的 `useRecommendedConfig` 元数据；缺省或 `true` 表示跟随推荐，`false` 表示固定个人配置。该元数据不进入 `ModelConfig`，不参与 Registry、ModelFactory 或请求参数。
- Settings Facade、Provider Config Service 和 UI Form Projection 已贯通该字段；保存仍使用原有 revision 校验和单次 Personal Repository 更新。
- 模型编辑弹窗删除重复的模型启用控件和“全部恢复默认”入口，保留列表行作为唯一 `enabled` 编辑入口；新增 Draft-only“跟随推荐配置”开关。没有 Built-in 继承基线的纯自定义模型不显示该开关。
- 固定模式保存时将当前 Effective 的编辑器管理字段物化为完整 Personal Overlay；切回推荐模式时仅在用户本次明确切换后清除旧 Overlay，同时保留独立的模型启用状态。
- 补充 Provider Config、Facade、Draft、Dialog 和模型行回归测试；受影响测试 119 个全部通过，`pnpm typecheck` 通过，`pnpm lint` 通过（仓库既有 40 条 warning、0 error）。

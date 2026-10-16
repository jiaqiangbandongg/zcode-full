# Provider 模型成员、启停与顺序

> 状态：当前有效设计
>
> 最近更新：2026-08-26

## 目标

模型成员、模型启停和模型顺序是三种不同事实：

```text
Provider Config
├─ builtinModelIds / modelIds  -> 有哪些模型
└─ modelOrder                  -> 按什么顺序展示

Model Config
└─ enabled                     -> 某个成员能否执行
```

Provider 成员数组不能声明模型能力或启停；Model Rule 不能创建成员或决定成员所有权。

## 成员所有权

```ts
interface ProviderConfig {
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
}
```

`builtinModelIds` 由 ZCode Built-in 或 Account Built-in 管理，`modelIds` 由 Personal 管理。完成 Overlay 后，
Resolver 将缺失或 `null` 归一化为 `[]`，再产生 source-aware inventory。

成员 ID 去除首尾空格后按大小写敏感的精确字符串比较：

- 同一数组重复：保留第一次出现，忽略后项；
- Built-in 与 Personal 同 ID：Built-in-wins，只产生一个 Built-in 成员；
- 正常 Settings 禁止 Personal 新增 Built-in 已有 ID；
- 用户手写重复配置仍能确定性读取，下一次保存相关 Provider 时从 Personal 数组删除重复和 stale 项；
- 不建立冲突对象、暂停身份或第二个同名模型。

Model Config Rule 命中一个不存在的 ID 不会创造成员；它只在将来某个 Provider 真正拥有该成员时参与解析。

## 显式 Built-in 来源

Provider 在 Effective/Registry/Settings DTO 中使用完整 `builtin: boolean`。Model 行的 `builtin` 由 Host 根据最终
source-aware inventory 显式返回；Renderer 不按 ID、Preset 白名单、Personal Map membership 或 UI 分组猜测。

Builtin Model ID 只读且不显示删除按钮。Personal Model ID 可通过原子 rename 修改，Personal Model 可以删除。

## Model Config `enabled`

### Provider 规则外层的启停（Todo107 后续裁决）

`ProviderConfigRule.enabled?: boolean` 与 providerId、providerName 同层，不放进 config 或 Access。
Resolver 将缺省统一解释为 true。Personal 开关只写外层 enabled，不改 Key、成员、模型开关或账号连接。
Facade 返回归一化的 enabled 和现有 executable；UI 只映射灰（关闭）、黄（开启但不可执行）、绿（就绪）。
账号组使用当前连接对应具体 Provider 的公共结果，不能用套餐菜单 statusActive 代替执行资格。
已绑定 Model 不受配置开关追溯撤销；历史选择保持，后续执行遵循原有解析与准入。

```ts
interface ModelConfig {
  enabled?: boolean | null;
  // properties / optionSpecs（含 per-option map）/ narrow encoding facts
}
```

`enabled` 是模型执行门禁，不是成员关系、可见性、授权或完整性：

```text
Provider complete
AND Provider Rule enabled（缺省 true）
AND Account Provider entitled（仅账号类型）
AND membership exists
AND Effective Model Config enabled
AND Model Config complete
        |
        v
Executable Model
```

Executable Model 才进入 Registry，因此也才可能被 fallback、测试、内部精确 ID 或 ModelFactory 使用。普通用户候选在此
基础上再要求 Provider `visibility=visible`。Model 没有独立 visibility，也不保存 selectable/executable。

disabled Model：

- 留在 Settings 中；
- 保留 Properties、Options、Reasoning 和顺序；
- 可以编辑或重新启用；模型列表不提供 enabled“恢复默认”；
- 不能测试、fallback、选择或精确创建；
- 不为内部任务提供绕过门禁的路径。

已经创建的不可变 Model 不因 Config 刷新中断；后续创建使用新的 enabled 状态。

## Built-in 默认与 Personal 覆盖

Built-in 通用 Rule 提供完整默认 `enabled=true`。更具体、位置更后的 Built-in Rule 可以将淘汰或不建议继续使用的模型
默认设为 `false`。这使 ZCode 发布新配置时能够调整官方默认，而不需要改 Provider 成员。

Personal Rules 在全部 Built-in Rules 之后：

```text
Built-in general enabled=true
            |
            v
Built-in specific enabled=false
            |
            v
Personal provider-model enabled=true/false
            |
            v
Effective Model Config enabled
```

用户切换开关只写 Personal `enabled` 叶子，并保存明确布尔值；模型列表不提供“恢复默认”入口。正常新建 Personal
Model 时明确写 `enabled=true`，避免新增流程依赖隐式猜测。Schema 和 Overlay 仍允许通过配置编辑删除该叶子，
但这不是模型列表开关的产品操作。

## Provider/Model 专属 Rule

Built-in 与 Personal Model Rules 使用共同的结构：

```ts
type ModelConfigRule =
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    }
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    };
```

`provider-model` 的目标是一个精确 Provider/Model 组合。它可以属于两个 Source：

- Built-in 专属 Rule 由 ZCode Built-in Release 管理，可以声明某个 Built-in Provider/Model 组合的官方特化；
- Personal 专属 Rule 由 Settings 管理，可以覆盖 Built-in 或 Personal Model。

只有 Personal 专属 Rule 参与用户生命周期：

- Settings 修改单模型字段时创建或更新；
- Personal Model rename 时移动；
- Personal Model delete 时删除；
- Provider Personal Overlay delete 时删除该 Provider 的全部专属 Rule；
- 恢复最后一个字段后删除空 Rule。

`match` Rule 同样可以属于 Built-in 或 Personal Source，用于一组模型/API/Provider/Endpoint 的共同事实。任何
Provider/Model rename、delete、去重都不猜测或改写 Match Rule；Built-in 专属 Rule 也不受用户操作影响。专属 Rule
使用结构化 ID，不把精确 ID 转义成正则，也不增加 `exclusive` 标志。

## Model 顺序

基础顺序分为三段：

```text
未出现在 modelOrder 的 Built-in
              +
modelOrder 中仍有效的成员
              +
未出现在 modelOrder 的 Personal
```

这保证在线配置新发布、用户尚未排序的 Built-in Model 默认在最前。正常 Settings 新增 Personal Model 时，会在同一次
原子操作中更新 `modelIds`、完整 `modelOrder` 和初始专属 Rule，所以未排序 Personal 只来自手写或异常输入。

用户拖动保存时：

1. 读取当前 Effective source-aware inventory；
2. 按用户结果排列；
3. 删除 stale 和重复 ID；
4. 补入所有遗漏成员；
5. 保存完整 `modelOrder`。

disabled Model 仍按 `modelOrder` 出现在 Settings。Selection 过滤 disabled 后，其他模型保持相对顺序。

## 生命周期操作

### 新增 Personal Model

```text
validate new modelId
        |
        v
atomic write
├─ modelIds += id
├─ modelOrder = complete current order
└─ provider-model rule { enabled: true }
```

如果 ID 与 Built-in 或已有 Personal 成员重复，正常保存拒绝。

### 重命名 Personal Model

原子替换：

- `modelIds` 中的旧 ID；
- `modelOrder` 中的旧 ID；
- 旧 `provider-model` 专属 Rule 的目标 ID。

预览必须先移动 Personal 专属 Rule，再用新 ID 和 Effective Provider API/Endpoint 解析 Built-in Rules，最后叠加原 Personal
稀疏值。用户明确填写的值不变，继承默认随新 ID 更新。通用 Match Rules 不改写。

### 删除 Personal Model

原子删除：

- `modelIds` 成员；
- `modelOrder` 位置；
- 对应 `provider-model` 专属 Rule。

通用 Match Rules 不删除。Builtin Model 没有此操作。

### 删除 Provider Personal Overlay

删除 Provider Personal Overlay，并删除该 Provider 的全部 `provider-model` 专属 Rules；通用 Match Rules 保留。
Built-in Provider 回落到 Built-in 基线，Personal-only Provider 因没有其他根定义而自然消失。

## Settings 与 Selection

Settings 返回全部 visible Provider 的完整成员，包括 disabled/incomplete Model，并显式给出：

- `builtin`；
- Effective `enabled`；
- Personal 是否明确覆盖 enabled；
- Effective/Personal Model Config；
- 完整性 issues；
- 派生 executable/selectable；
- 统一顺序。

Selection 只返回 visible Provider 中 executable 的模型，并保留 Registry 顺序。Renderer 不再过滤、排序、Overlay 或从
Connection/Preset/Catalog 制造候选。

## 接受用例

| 编号 | 输入/操作                                 | 结果                                                 |
| ---- | ----------------------------------------- | ---------------------------------------------------- |
| MM01 | Built-in `[A,B]`，Personal `[X]`          | Inventory 为 Built-in A/B + Personal X               |
| MM02 | 两个来源都有 X                            | 只产生 Built-in X；Personal 重复忽略，保存时清理     |
| MM03 | 一个数组出现 `[A,A,B]`                    | 保留第一个 A 与 B                                    |
| MM04 | Built-in Rule 将旧 A 设为 disabled        | A 留在 Settings；不进入 Registry/Selection/fallback  |
| MM05 | 用户把 A 的开关切为 true                  | A 重新 executable，并保留 Personal enabled=true      |
| MM06 | 新 Built-in C 不在用户 modelOrder         | C 出现在未排序 Built-in 前段                         |
| MM07 | Settings 新建 Personal Y                  | 成员、完整顺序、enabled=true 专属 Rule 原子保存      |
| MM08 | Personal Y 重命名为 Z                     | 成员、顺序、专属 Rule 原子移动；通用 Match Rule 不改 |
| MM09 | 删除 Personal Y                           | 成员、顺序、专属 Rule 删除；通用 Match Rule 保留     |
| MM10 | Provider disabled                         | 所有模型留在 Settings；Registry/Selection 不包含     |
| MM11 | Provider hidden 且 enabled，Model enabled | 普通 Settings/Selection 不展示；内部可精确创建       |
| MM12 | Model disabled 后 Config 刷新             | 已有 Active Model 完成生命周期；新创建拒绝           |

## 不采用的方案

- 单一 `models[]`：Personal 快照会遮蔽后来发布的 Built-in 成员；
- `enabledModelIds`：完整正向集合无法同时表达官方未来默认和用户逐模型覆盖；
- Provider 内 default + per-model enablement policy：重复 Model Rule 的 Overlay 能力；
- Model visibility：与 Provider visibility/Model enabled 重叠，制造第二套隐藏语义；
- 重复成员冲突 DTO：正常 UI 已禁止重复，手写输入可用 Built-in-wins + 保存规范化处理；
- 用正则编码 UI 精确 Rule：生命周期归属不清，rename/delete 必须猜测；
- 通用 equality/identity 抽象：成员判断使用明确 providerId/modelId 比较即可。

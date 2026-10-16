# Todo 28：Model Rule 优先级与 Provider/Model 顺序规范化收口

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：Todo 21/23 完成后的实现反向审查
>
> 关联任务：[`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md)、
> [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md)、
> [`Bugfix 02`](./bugfix-02-provider-reorder-drop-flicker.md)

## 1. 任务定位

Todo 21 已经确立 Model Rule 后置覆盖和 Provider/Model 三段顺序，Todo 23 已经完成 Model 编辑
的 Host Preview 与原子保存。完成后审查发现两处机械实现仍未完全满足已裁决语义：

1. Effective Model Rules 仍直接拼接 Personal Rule 原数组，不能保证 Personal 精确 Rule 始终后置；
2. Provider/Model 写入侧规范化把请求顺序放在前面，再追加遗漏成员，与 Resolver 的“未排序
   Built-in 在前”三段语义不一致。

本 Todo 是已有设计的收口 Bugfix，不重新设计 Rule、Overlay、Settings Preview 或拖拽交互。

## 2. 与最近 Todo 的边界

核对后没有产品设计冲突，边界固定如下：

- Todo 23 已完成 Host Preview：Host 会根据 `providerId` 读取 Effective Provider 的真实
  `api.type/baseURL`，并在预览态先移动 Personal 精确 Rule；本 Todo 只保留回归证明，不再建第二个
  Preview 接口；
- Todo 25 已完成 ZAPI 产品入口退役，不纳入本 Todo；
- Todo 26 只改变智谱 Access Type/Mode，不改变 Model Rule 优先级或顺序成员语义；
- Todo 27 处理 Model Overlay 视觉、成功反馈、Team 状态和 Runtime Headers，不修改本 Todo 的领域算法；
- Bugfix 02 只管理拖拽松手至 Host View 确认之间的短期乐观投影；本 Todo 只修正最终写入
  Personal Config 的权威顺序，不建第二份 UI Pending 状态。

## 3. Model Rule 优先级

Effective Model Rules 的唯一组合顺序固定为：

```text
ZCode Built-in Rules（完整保留 Built-in 内部顺序）
                       +
Personal Match Rules（保留 Personal Match 内部顺序）
                       +
Personal provider-model Rules（保留 Personal 精确 Rule 内部顺序）
```

这条顺序同时用于：

- Registry/Resolver 产生 Effective Model Config；
- Settings 新模型 Preview；
- Settings Personal Model Draft Preview；
- 连接测试、ModelFactory 和其他间接消费 Effective Model Config 的链路。

不重排 ZCode Built-in Rules 自身；Built-in 中的通用、API、Provider 和 Endpoint 特化仍由 Built-in 文件
的作者顺序决定。不要通过重写 Personal JSON 的物理排列实现优先级；应在组合 Effective Rule
数组的领域边界做一次确定性分组。

## 4. Provider/Model 三段顺序的唯一算法

对任意拥有 Built-in 与 Personal 成员的有序集合，结果固定为：

```text
未出现在 requestedOrder 中的 Built-in 成员
                       +
requestedOrder 中仍然有效的成员
                       +
未出现在 requestedOrder 中的 Personal 成员
```

同时遵守：

- Built-in 与 Personal 同 ID 时 Built-in wins，只有一个成员；
- 成员数组和 requested order 中的重复 ID 都只保留第一次；
- stale ID 直接丢弃；
- 结果是当前全部有效成员的完整顺序；
- `modelOrder` 和 `providerOrder` 只排序，不创建成员、不启用成员、不改变来源归属。

例如：

```text
Built-in = [A, B]
Personal = [P, Q]
Requested = [P, B, stale, P]

Canonical = [A, P, B, Q]
```

Provider 的该算法只作用于可排序的 `standard-builtin/standard-personal` 段；Z.ai/BigModel Family
Provider 保持固定前段，不写入 Personal `providerOrder`。Model 没有额外固定段。

读取 Resolver 和写入 Config Service 必须复用同一个 Provider 领域纯函数或共享同一组受测
试向量，不得继续维护两个外观相近但遗漏成员位置不同的算法。

## 5. 写入边界

以上规范化必须覆盖所有会改变成员或顺序的 Personal Config 操作：

- 添加 Built-in Provider Personal Overlay；
- 创建 Personal-only Provider；
- Provider 重排和删除；
- 保存 Provider 时对历史/手写成员与顺序做规范化；
- 添加、重命名、删除和重排 Personal Model；
- Model Draft 原子保存中的 membership/order 更新。

任何写入完成后，物理 `providerOrder/modelOrder` 都应已是完整、去重、无 stale ID 的规范结果。
读取侧仍保留容错规范化，以处理用户手写或异常中间态；不为未发布分支建 migration 或 dual-read。

## 6. 实施原则

- 先用失败测试证明 Personal Match/Exact 优先级和三段写入差异，再修改生产代码；
- 优先删除重复算法，不再增加 Resolver-only 和 ConfigService-only helper；
- 不新建 Rule Registry、Order DTO、冲突对象、影子 Config 或 Renderer 排序权威；
- 不改变 Personal Match Rule 的内部顺序，不改变精确 Rule 的内部顺序；
- 不改变 Model `enabled`、Provider visibility、executable/selectable、Active Model 冻结或 ModelSelection 语义；
- 不影响 Local/Remote Host 权威边界，不触碰 Desktop continuous 或 Mobile replayable 链路。

## 7. 测试计划

### 7.1 Rule 优先级

- Personal 精确 Rule 在物理数组中位于 Match Rule 之前时，有效解析仍是 Match 先、精确后；
- 多条 Personal Match 保持原内部覆盖顺序；
- 多条 Personal 精确 Rule 保持原内部覆盖顺序；
- Built-in Rule 数组保持完整顺序，Personal 仍只在 Built-in 之后覆盖；
- Registry 解析、新模型 Preview 和 Personal Draft Preview 对同一输入得到一致结果。

### 7.2 顺序规范化

- 未排序 Built-in 放在 requested order 之前，未排序 Personal 放在之后；
- requested order 中的 stale/duplicate ID 被删除；
- Built-in/Personal 同 ID 只保留 Built-in 位置；
- Provider 与 Model 使用同一组三段语义；
- 添加、重命名、删除、拖拽与 Model Draft 保存后都持久化完整规范顺序；
- 保存异常时 Bugfix 02 的 UI Pending 会回滚，不被本 Todo 的领域算法破坏。

### 7.3 权威回归

- `baseURLMatch` 在 Host Preview 中继续正确命中；
- API 不完整的 Provider 返回真实 validation issue，Renderer 不猜 `anthropic-messages`；
- Preview 不修改 Personal Config、order 或 Registry revision。

## 8. 完成标准

- Effective Rules 在所有解析面遵守 `Built-in + Personal Match + Personal provider-model`；
- Resolver 与 Config Service 不再存在两个语义不同的顺序 helper；
- 所有顺序写入边界产生完整、去重、无 stale ID 的规范顺序；
- Todo 23 已完成的 Host Preview 边界保持不变；
- 同步更新 `configuration.md`、配置体系综述与相关 Feature Graph，不再宣称写入规范化
  已完而代码仍使用另一套算法；
- Provider 定向单测、`pnpm typecheck`、`pnpm lint`、修改文件格式检查和 `git diff --check`
  通过；
- 完成后提交 Conventional Commit。

## 9. 实施结果

- `ModelConfigRules.composeEffective()` 成为 Resolver 与两个 Settings Preview 的唯一 Effective Rule
  组合边界，物理 Personal JSON 不再改变 Match/精确优先级；
- `resolveOwnedOrder()` 同时服务读取 Resolver 与 Provider/Model 写入规范化，删除写入侧 requested-first
  重复算法；Family Provider 继续位于固定段之外；
- 增加 Personal 精确 Rule 物理前置、Provider 三段写入及 Facade/Registry 一致性回归测试；
- `@zcode/provider` 155 个测试、typecheck、lint 与 `git diff --check` 通过。

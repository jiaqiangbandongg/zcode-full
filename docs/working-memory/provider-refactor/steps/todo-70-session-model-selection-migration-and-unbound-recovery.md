# Todo 70：Session Model Selection 迁移与未绑定恢复

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已完成实现与阶段验收（2026-09-04）。
>
> 来源：Provider 重构上线前的存量 Session 恢复失败复盘
>
> 执行顺序：先完成 Todo 72 的身份转换基础，再与 Todo 69 的存储边界衔接；之后实施本文，最后衔接 Todo 71。
> 遵守 Todo 69“不持续双写”的实用回滚边界，不依赖旧字段回写编码器。

## 1. 问题

存量 Session 恢复时，持久化的 Model Selection 可能出现以下情况：

- 仍是旧结构；
- 新结构中缺少 `reasoningLevel`；
- 已保存的 Provider、Model 或 Reasoning 已不再存在；
- 新旧字段同时存在，但内容不同。

当前恢复链路会过早把这类不完整 Selection 交给严格的 ModelFactory，导致 Session 连历史内容也无法
打开，例如：

```text
Reasoning level is required for provider/model
```

这不是模型请求失败，而是 Session 恢复与执行模型绑定没有分开。

## 2. 目标

本 Todo 只做两件事：

1. 旧 Session 在持久化读取边界尽量迁移成当前 Model Selection；不批量改写历史，不为降级回滚新增旧字段双写；
2. Session 恢复只读取迁移后的新字段。能确定的信息正常恢复，无法确定的信息保持未绑定，但不得阻止
   Session 打开和历史查看。

本 Todo 只负责 Session 的升级读取和恢复，不复制其他领域的升级逻辑。Todo 69 的范围已经收窄为降级回滚的
物理兼容边界，当前唯一生产改动是 Bot Config/State 文件隔离；它不再承诺各领域持续双写，也不能据此认为
其他领域的升级迁移已经全部完成。

旧 Provider 身份转换统一采用 [Todo 72](./todo-72-legacy-builtin-provider-and-model-selection-migration.md)。
其中旧 Coding Plan 的动态身份允许按迁移时同一 Family 当前选中的个人/Team 连接转换；
这是旧结构升级规则，不是当前 Selection 失效后的 Account-first 回退。本文继续负责 Session 的
唯一 Decoder 与未绑定恢复，不新增平行转换入口，不用旧字段修补已有当前结构。

## 2.1 共同原则

本 Todo 与 Todo 69 共同遵守以下原则：

1. 老数据尽量迁移；
2. 旧原始数据不做破坏性批量清理，但不持续生成旧字段；回滚退化按 Todo 69 接受；
3. 当前恢复只认新字段；
4. 能确定的缺失值直接补齐；
5. 无法确定的允许留空；
6. 不自动替换失效选择；模型或 Reasoning 留空时不弹提示，由控件空态表达；
7. 不能因为模型选择数据损坏而让整个 Session 无法打开。

这里必须区分三种行为：

- **迁移**：旧字段与新字段可以一一对应时，机械搬运同一个值；
- **补齐**：能由同一条持久化事实唯一确定新字段时，直接写入；
- **替换**：原值已经失效，系统改用另一个 Model、Provider 或 Reasoning。

迁移和确定性补齐不改变用户选择。当前计划对失效的 Model/Provider/Reasoning 不做自动替换，
而是保持未绑定并等待用户选择，不弹失效提示。Configured Default、模型规则
默认值、`values[0]`、`values.at(-1)`、列表首项和历史消息都不能被当作“确定的缺失值”。

```text
旧 Session 持久化数据
        |
        v
持久化读取边界
├─ 真正旧结构 ------> 转成当前 Model Selection
└─ 已有当前结构 ----> 只采用当前结构
        |
        v
Session 恢复
├─ Selection 完整且合法 ------> 绑定执行 Model
└─ Selection 缺失或失效 ------> 保持未绑定，正常打开 Session
                                      |
                                      v
                              用户重新选择后再绑定
```

## 3. 单向存储迁移与当前写入

### 3.1 读取优先级

- 存在当前 Model Selection 时，只读取当前字段；
- 不得再使用旧 `thoughtLevel`、旧消息字段、恢复提示或其他旁路补充当前 Selection；
- 只有数据中完全没有当前结构、能够明确判定为旧 Session 时，兼容 Decoder 才读取旧字段并转换；
- 旧字段能确定表达的 Provider、Model 和 Reasoning 正常转换；旧结构没有的信息保持缺失，不猜测。

“当前结构”不能仅按是否存在 `modelSelection` 字段判断：旧版也可能已经写这个字段，但使用明确的旧
`builtin:*` 身份。此类有旧格式/保留身份依据的数据按 Todo 72 在升级边界转换，然后才按当前选择恢复。
当前字段优先仍然成立：转换其自身能够确定的身份，不从旁边的旧 `thoughtLevel` 等字段修补它；
普通未知 ID 或 Registry 暂不可用也不能被当成旧数据依据。

旧字段只在真正旧记录的 Decoder 中提供升级输入，不是当前恢复逻辑的第二事实源。原始存储中已有的旧字段
不要求批量删除，但当前版本一旦看到当前结构，就必须忽略旧字段，即使当前结构本身不完整。

### 3.2 写入规则

当前写入继续走唯一 Session Store 边界：

- 当前 Model Selection 是权威字段；
- 只写当前结构，不从它反向派生旧消息别名或旧 `thoughtLevel`；
- 当前 Decoder 返回的领域对象不暴露旧别名；
- 单向 Decoder 的中文注释说明旧结构来源及当前字段优先规则；不新增回滚 Encoder 或通用兼容抽象。

不新增数据库表迁移，不批量重写全部历史 Session。历史消息在读取和后续正常写回时逐步迁移。
但当前 Session 选择若成功转换了旧 Coding Plan 动态身份，必须在本次恢复中通过现有保存入口固定新身份，
不等用户再次发消息；Reasoning 无法确定仍可留空。只写当前选择，不改历史请求身份，不反写旧字段。
写入前沿用现有串行化/并发保护，不能覆盖恢复期间用户新保存的选择；写入失败不能报告迁移已完成，
也不能因此阻止历史打开。失败按现有存储错误日志/反馈处理，与“留空不弹提示”不是同一类错误。

存储接入使用一个窄化的 `migrateLegacyModelSelection` 操作：Adapter 识别原始旧结构，
身份转换由调用方注入并复用 72 的规则，Adapter 不读取账号文件或猜测 Registry 顺序。
先读候选，再异步取得身份转换结果；写入事务内重新核对候选及当前选择，若已发生变化就放弃本次旧结果。
现有当前 entry（包括不完整数据）优先于历史消息。仅当没有当前 entry、且最近的选择证据确属旧结构时，
才允许从该旧消息导入。成功后保存为现有当前选择 entry，不修改消息和 Session 活动时间。

协议宿主通过只用于升级的 `session/resolveLegacyModelProvider` 返回旧 Provider 对应的当前 ID，
输入只有 `sessionId/providerId`，不传凭据。请求绑定产生它的 Workspace CLI/Host 连接；
Host 用自己所在 Environment 的账号连接解释旧 Coding Plan，不转发到桌面 UI 的偏好解析链。
Standalone 没有账号宿主时仍可转换静态旧身份，动态 Coding Plan 保持未绑定。
这不是可供正常执行使用的 Provider 别名接口：仅真实旧结构导入会调用，固定新 entry 后不再调用。
不改变 Desktop continuous / Mobile replayable 的订阅、owner 路由或队列，也不让手机另起 Host。

## 4. Session 恢复行为

### 4.1 完整且合法

Provider、Model 和 Reasoning 都仍然合法时，原样恢复并绑定执行 Model。

### 4.2 Reasoning 缺失或失效

保留仍然有效的 Provider/Model 身份，但将 Selection 视为未完成：

- 只清除缺失或已经不属于当前 `values` 的 `reasoningLevel`，不得改动仍然有效的 `providerId/modelId`；
- 不使用 `values[0]`、`values.at(-1)` 或 Configured Default 自动选择档位；
- 不读取旧字段或历史消息猜测档位；
- Session 正常打开；
- UI 显示尚未完成的模型选择，用户重新选择 Reasoning 后才能继续执行。

### 4.3 Provider 或 Model 失效

复用同一套“Selection 未绑定”恢复语义：

- 不自动替换成 Account Provider 第一个模型、Configured Default 或其他候选；
- 清除不可解析的执行绑定；
- Session 正常打开并保留全部历史；
- 用户重新选择当前可用模型后继续。

Reasoning 失效与 Provider/Model 失效不是两套恢复系统。差别只在于前者仍可保留模型身份，后者连模型
身份也无法绑定。两者复用同一个 Selection validator 和控件空态规则，但必须保留这一层级差异，不能因为
Reasoning 失效就整份清空 Selection 或切换到另一个 Provider/Model。

历史恢复与 Todo 71 的活跃 Draft 统一留空，不再区分两种失效回退策略。模型或 Reasoning 留空时不弹
Toast、弹窗或额外失效横幅，不维护对应通知去重状态；用户通过选择控件补全后继续。
取消的是留空提示，不取消真实执行、提交或存储故障的正常错误反馈。

### 4.4 未绑定不等于半成品 Model

未完成的 Selection 不得进入 ModelFactory：

```text
Session 历史恢复
        |
        +--> 可独立完成，不要求存在 Active Model
        |
        `--> 用户发起下一次执行
                  |
                  +-- Selection 完整 --> 创建 Active Model
                  `-- Selection 未绑定 -> 要求用户完成选择
```

不得通过放宽 ModelFactory、恢复 Runtime fallback 或构造缺少 Reasoning 的 Active Model 解决问题。

### 4.5 “未绑定”的具体表示与状态归属

“未绑定”不是新的持久化格式，也不是一种半成品 Active Model。它只描述 Session 历史已经恢复，但当前没有
一份可以交给 ModelFactory 的完整 Selection：

```text
Session 已成功打开
├─ 历史消息：已经恢复
└─ 执行绑定
   ├─ Selection 完整有效 ------> Runtime 持有完整 Session Selection
   ├─ Reasoning 缺失/失效 ----> 保留 Provider/Model 供 Composer 修复
   `─ Provider/Model 失效 ----> Runtime 暂无 Session Selection
```

具体约束：

- 持久化 Decoder 继续返回它能确定恢复的当前 Selection 候选；不新增 `unbound: true` 一类数据库字段；
- 只有完整、经当前 `ModelSelectionView` 校验的 Selection 才写入 Runtime 的 Session Selection，并允许创建
  Active Model；
- Reasoning 缺失或失效时，恢复结果保留仍有效的 `providerId/modelId`，只把 `reasoningLevel` 清空，作为
  Composer 的待修正选择；Runtime 不得提前把它绑定成可执行 Model；
- Provider/Model 失效时，Runtime 与 Composer 的可执行 Selection 都置空；原身份只可用于诊断日志，
  不能继续作为请求路由；
- 失效层级由恢复时根据最新 Registry 重新计算，通过现有恢复结果让 UI 呈现相应空态；不弹失效通知，
  不持久化一份可能过时的 `selectionIssue`；
- UI 显示历史不依赖 Selection。用户重新选择完整 Provider/Model/Reasoning 后，才更新 Session Selection 并
  恢复执行。

实现可以使用现有可选字段和恢复结果表达以上状态，不为此增加公共 `UnboundSelection`、Execution Binding 或
另一套模型 DTO。

落地时，Runtime 的 Session Selection 允许缺失，执行入口在调用严格 ModelFactory 前拒绝缺失选择。
历史消息的模型来源字段也允许缺失：旧数据可能没有来源，恢复产生的合成时间线也未必执行过模型请求。
不能为了满足消息类型而借用默认模型伪造来源；真实模型输出仍从当轮 Active Model 记录来源。

## 5. 与现有行为的边界

- 新建 Session 和用户正常选模仍按正式选择规则生成完整 Selection；本 Todo 不改变默认档位规则；
- 连接测试、标题生成、Git 等辅助请求继续使用 Todo 67 规定的 `values[0]`，与存量 Session 恢复无关；
- Active Model 一经创建仍保持冻结；Registry 更新不修改已经运行的 Turn；
- 会话模式、消息内容、Compact、队列和工具恢复不纳入本次模型选择修复；
- Todo 69 已裁决 Session、闲时和自动化不持续双写；本 Todo 保留单向旧 Session Decoder，不恢复降级写入逻辑。

## 6. 测试先行

先固定以下失败场景，再修改生产代码：

1. 只含旧字段的 Session 能被 Decoder 转成当前 Model Selection；
2. 新旧字段同时存在时，当前字段唯一生效，旧字段不能补写或覆盖它；
3. 旧结构中能够一一对应的值被机械迁移，无法确定的字段保持缺失；
4. 当前 Selection 缺少 Reasoning 时，Session 可以打开，历史完整，Provider/Model 保持不变，执行保持未绑定；
5. 当前 Reasoning 已不在模型 `values` 中时，只清空 Reasoning，Provider/Model 保持不变，并等待用户重新选择；
6. Provider 或 Model 已不存在时，Session 可以打开，不自动切换其他模型；
7. 用户完成模型与 Reasoning 选择后，可以正常创建 Active Model 并继续对话；
8. 未绑定状态和失效原因不写入新的持久化事实；Registry 恢复后重新打开 Session 会按最新 View 重新校验；
9. 当前完整 Selection 的冷恢复、重连、Fork 和继续执行不发生回归；
10. 当前写回仅使用当前结构，不新增旧消息别名；单向旧记录 Decoder 继续有效，符合 Todo 69 的非双写边界。
11. 模型/Reasoning 留空不弹提示；交给 Composer、切页或重启后不被默认初始化自动补齐。
12. 旧版已存在 `modelSelection` 但使用明确旧内置身份时正常转换；当前未知身份不触发猜测，旁路旧字段不补值。
13. 首次按个人连接迁移后，不发送消息即关闭；切换 Team 再次打开仍读取已固定的个人身份（不可用则留空），
    不重新迁成 Team；写入失败和并发新选择不会被误记为成功或被旧结果覆盖。

涉及 Desktop 交互时补充 E2E：打开 Selection 已失效的存量 Session、查看历史、重新选模并继续发送。

## 7. 实施顺序

1. 审计 Session 中所有当前/旧 Model Selection 的 Decoder 和编码入口；
2. 用测试固定“当前字段优先，真正旧结构才迁移”的存储边界；
3. 将 Session 历史恢复与执行 Model 创建解耦；
4. 收口 Reasoning 缺失、Reasoning 失效、Provider/Model 失效为同一未绑定恢复语义；
5. 删除恢复链路中从旧字段、消息或其他提示补齐当前 Selection 的旁路；
6. 验证用户重新选择后能够继续执行并正确持久化；
7. 联合 Todo 69 检查没有误加旧字段回写，且未破坏旧 Session 的单向升级入口；
8. 运行定向测试、E2E、`pnpm typecheck`、`pnpm lint` 和 `git diff --check`；
9. 形成实施记录，列明实际删除的旁路、保留的兼容入口和真实验证结果。

## 8. 完成标准

- 任何 Model Selection 缺失或失效都不会阻止 Session 打开和历史查看；
- 当前恢复逻辑只消费当前 Model Selection，不把旧字段重新发展为事实源；
- 真正旧 Session 仍能通过唯一存储 Decoder 迁移；
- 系统不会静默替用户选择 Model 或 Reasoning；
- 留空时不弹失效提示，交给 Todo 71 后仍保持空态，不自动填默认模型；
- 未绑定 Selection 不会进入严格 ModelFactory；
- 用户完成选择后可以继续原 Session；
- Todo 69 的实用回滚能力保持成立；
- 测试、类型检查、Lint、差异检查及相关 E2E 全部通过。

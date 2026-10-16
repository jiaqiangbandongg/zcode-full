# Todo 59：模型默认选择与远端 Provisioning 失败语义纠偏

> 状态：实现完成
>
> 日期：2026-09-01
>
> 前置：Todo 55、Todo 56、Todo 57 已完成。本 Todo 不重做 Provider Template、Environment 级同步或 E2E 基础设施，只纠正复核中确认的两处实现漂移。

## 0. 背景与目标

Todo 57 为修复 Account Registry 延迟发布和旧 Start Plan 选择失效的 E2E，在 Renderer 草稿初始化中加入了“当前 Account Provider 第一个模型优先于 Host preferredSelection”的特殊回退。该规则绕过 Configured Default，使 Renderer 开始理解 Account Family/Plan，并丢失 Configured Default 携带的 reasoning options。

Todo 56 的首次 Remote Environment Provisioning 已经成为远程 Workspace 发布前的同步屏障，但当前收到 `failed`、`rollback_failed` 或 `unsupported` 后仍只记录 warning 并继续发布连接。这会让远端在关键模型配置没有同步成功时以旧配置或空配置继续运行。

本 Todo 收口为两条唯一规则：

1. 新草稿的默认选择统一由目标 Host 的 `preferredSelection` 提供；Account Connection 只影响 Registry 可用事实，不在 Renderer 中形成第二套默认模型优先级。
2. 首次 Provisioning 未成功时不发布远程 Workspace；已经连接后的后续同步失败不拆除 Workspace，只记录结构化 warning，并在下一次正式触发时重试。

## 1. 模型选择优先级

### 1.1 唯一优先级

```text
任务明确继承的 ModelSelection
        |
        | 不存在
        v
当前 workspaceKey 下仍然有效的 Recent Selection
        |
        | 不存在或已失效
        v
目标 Host 返回的 preferredSelection
        |
        +-- 有效 Configured Default
        |
        `-- Registry 中第一个可见 Provider 的第一个模型
```

Renderer 不再读取或推导当前 Account Provider，不再以 `provider.models[0]` 抢占 Configured Default。

### 1.2 职责边界

- Task/Draft 的显式选择优先，因为它表达当前交互上下文中的用户意图；
- Recent 仅在当前目标 Host 的 Selection View 中仍然有效时使用；
- Configured Default、Registry fallback 和模型 options 的有效性由目标 Host 原子解析为 `preferredSelection`；
- Account Config 只约束 Account Provider 的 entitlement、成员和访问材料，并通过 Registry 间接影响“哪些选择仍然有效”；
- Renderer 不识别 Start Plan、Individual、Team，也不根据 Family Connection Selection 推断默认模型；
- 本 Todo 与 Todo 58 的 Option Default 退役契约共同生效：目标 Host 在标准 Model Selection 解析边界把普通缺省 reasoning 补为有序 Enum 的 `values.at(-1)`；Renderer 只消费已经完整的 `preferredSelection`；ModelFactory 只校验并冻结具体 Option，不再从 Model Config `default` 补值；
- 新写入的 Draft、Recent、Session Selection 和 Configured Default 必须携带具体 reasoning。旧稀疏选择若需要兼容，只能在 Host 的选择持久化读取边界归一化，不能把 fallback 分散回 Renderer、Service、Model 或 Adapter。

### 1.3 保留 Registry revision 重水合

Account Registry 延迟发布是真实时序问题，但不需要 Account-first 回退解决。

```text
早期 Selection View 发布
        |
        v
空白 Draft 被预热
        |
Account Overlay 完成，Selection View revision 更新
        |
        +-- Draft 已有用户显式模型意图 --> 保持不变
        |
        `-- Draft 没有用户显式模型意图 --> 使用最新 View 重新初始化
```

保留现有 revision 驱动的空白 Draft 重建；删除 Account-first 分支后，它最终会读取最新 Host `preferredSelection`。

### 1.4 清理范围

- 删除 `resolveDraftInitialModelSelection()` 的 `currentAccountProviderId` 参数和 Account Provider 首模型分支；
- 删除 `useDraftConfigControl()` 中为该分支读取 `providerFamilyDomain`、`providerFamilyConnectionSelections` 并推导 Provider ID 的逻辑；
- 删除仅服务于该分支的 import、memo、测试构造和注释；
- 更新 Todo 57、Selection Design 和 E2E 说明，明确其“recent → Account 首项 → Host preferred”实施记录已被本 Todo 的后续裁决取代；
- 不删除 Provider Family Connection Selection 产品能力本身，本 Todo 只禁止它进入通用 Draft 默认选择。

## 2. Remote Provisioning 失败语义

### 2.1 首次连接是严格屏障

Remote transport ready 不等于 Remote Workspace ready。首次 Provisioning 必须成功完成后才能发布 Workspace。

```text
Remote transport ready
        |
        v
Environment 0 -> 1 注册
        |
        v
首次 Provider Provisioning
        |
        +-- applied / already-applied
        |          |
        |          v
        |    发布 Remote Workspace ready
        |
        +-- failed / rollback_failed
        |          |
        |          v
        |    连接失败，展示真实同步错误
        |
        `-- unsupported
                   |
                   v
             连接失败，提示远端版本不支持模型配置同步
```

实现要求：

- `ProviderProvisioningExecutionResult` 不能再对所有状态无条件 `pending.resolve()`；
- 成功状态 resolve 首次连接屏障；失败状态沿现有 Remote Workspace 连接失败通道 reject/结束请求；
- 连接错误保留 Environment、trigger 和 status；Target 的自由文本错误可能来自任意远端实现，不能证明脱敏，因此不转抄到 Main 日志或 Renderer 错误；
- `unsupported` 是明确的版本/能力不兼容，不作为静默兼容模式；
- 不增加 deadline；若同步没有返回结果，连接保持 pending，以便直接暴露协议或外部 IO 卡死；
- 不用 timeout、sleep 或自动放行掩盖状态问题。

### 2.2 已连接后的同步失败不拆 Workspace

Provider 保存、Configured Default 变化、账号状态变化和 allowlist credential 变化会对已经在线的 Environment 触发后续同步。此时同步失败只证明远端模型配置没有追平，不证明 SSH、WSL、Docker 或 Server 文件连接已经失效。

```text
Remote Workspace 已连接
        |
本地模型/账号配置成功持久化
        |
        v
Environment 后续 Provisioning
        |
        +-- success
        |     `─ 保持 Workspace 连接
        |
        `-- failure / unsupported
              ├─ 保持 Workspace 连接
              ├─ 记录 Environment 级结构化 warning
              └─ 等待下一次正式 trigger 再重试
```

边界：

- 不因后台同步失败主动关闭现有 Workspace、终端或文件操作；
- 这套自动 Provisioning 是远程配置独立管理上线前的临时过渡能力；后续失败本轮只进入日志，不新增 Environment 错误状态、协议、Banner、设置页入口或第二份配置权威；
- warning 包含 Environment、trigger、status 和耗时，便于从生产日志确认远端没有追平；不转抄 Target 自由文本，也不新增 UI 状态；
- 当前轮失败且没有新 generation 时不无限自动重试；下一次正式 trigger 重新读取最新完整快照；
- 用户断开后重新连接，重新进入严格的首次同步屏障。

## 3. 与既有设计的关系

- Todo 56 的 Environment 去重、single-flight、尾随刷新、完整快照覆盖和 Main 只调度边界全部保留；
- Todo 56 第 5 节“失败或不支持时不阻断连接”被本 Todo 取代；
- Todo 57 的实际 E2E 运行证据保留，但其中 Account-first 回退的实现结论被本 Todo 取代；
- Provisioning Source 直接读取 Credential Store 物理文件继续作为已接受的 v0 临时耦合，本轮不抽象 Credential 导出接口；
- Coordinator 的空 Environment lane 不影响正确性，本轮不处理；
- 不改变 Desktop `continuous`、Mobile `replayable`、owner/lease、CommandInbox 或任务恢复语义。

## 4. 测试先行

### 4.1 Model Selection 单测

- 有效 Recent 优先于 Host preferred；
- 失效 Recent 直接回退 Host preferred，不读取当前 Account Provider；
- Host preferred 中 Configured Default 的 reasoning options 完整保留；
- 无 Configured Default 时继续使用 Host 的 Registry fallback；
- Account Selection 变化本身不改变通用 Renderer fallback；
- Selection View revision 更新时，无显式意图的空白 Draft 重水合；已有显式选择的 Draft 不受影响。

### 4.2 Conversation E2E

- 修正 I27/MP-R03、I28/MP-R04：旧 Account 模型失效后回到当前有效 Configured Default；
- 保留 Account Registry 延迟发布场景，证明 revision 更新后 Draft 使用最新 Host preferred；
- 断言 Provider、Model 和 reasoning options 一致，不能只检查 toolbar 文案；
- 不恢复已删除的 selected-key/mode 兼容逻辑。

### 4.3 Provisioning 单元与集成测试

- 首次 `applied`、`already-applied` 后发布 Workspace ready；
- 首次 `failed`、`rollback_failed`、`unsupported` 均不发布 Workspace ready，并通过正式连接失败结果返回错误；
- 首次同步 pending 时连接保持 pending，不使用定时放行；
- 已连接后的失败不注销 Environment registration、不关闭 Workspace；
- 已连接后的失败写入一条 Environment 级结构化 warning，不产生 UI 或持久状态；
- 下一次正式触发会重新尝试，成功后按现有成功日志记录；
- 同步中收到新 generation 时仍遵守 single-flight + trailing refresh；
- 日志与错误载荷不包含 API Key、OAuth Token 或完整 Credential value。

## 5. 文档与图谱

- 更新 `docs/working-memory/provider-refactor/design/interaction/selection-state.md`，删除 Account-first 默认选择，并与 Todo 58 的完整 Selection 语义对齐；
- 更新 `docs/remote/provider-provisioning.md`，写明首次严格屏障和已连接后的降级状态；
- 在 Todo 56/57 的实施记录中追加“由 Todo 59 后续取代”的指针，不改写历史执行事实；
- 更新 Provider Refactor E2E 分析/覆盖矩阵中的 I27/I28 预期；
- Feature Graph 已包含 Provider Template 和 Remote Provisioning 节点；本轮不新增失败状态 UI，因此不增加新的 surface 或状态 owner。

## 6. 实施顺序

1. 先写 Model Selection 和 Provisioning 失败语义的失败测试；
2. 删除 Renderer Account-first 回退及相关残余；
3. 修正 I27/I28 fixture/断言并定向实跑；
4. 将首次 Provisioning 非成功结果接入 Remote Workspace 连接失败通道；
5. 收口已连接 Environment 的失败 warning 与下一次真实 trigger 重试语义；
6. 更新 Design、Todo 取代关系、Feature Graph/覆盖矩阵；
7. 运行定向单测、相关 Desktop E2E、`pnpm typecheck`、`pnpm lint` 和 `git diff --check`；
8. 全面 review 状态所有权、错误生命周期、跨窗口 Environment 去重和 Secret 边界；
9. 提交 Conventional Commit。

## 7. 完成门禁

- Renderer 中不存在 Account Provider 默认选择特化；
- Configured Default 重新成为 Recent 失效后的唯一产品默认事实；
- Registry revision 更新不会覆盖用户已明确选择的 Draft；
- 首次 Provisioning 未成功时 Remote Workspace 不会被发布；
- 已连接后的同步失败不会拆 Workspace，并留下不含 Secret 的结构化 warning；
- 不新增 Environment/Workspace 级错误状态或 UI，下一次真实 trigger 重新尝试；
- 不新增默认模型、Registry Snapshot、Provider Config 或 Credential 的第二份权威；
- 定向测试与仓库强制门禁通过，相关 E2E 有真实运行证据。

## 8. 非目标

- Provider Family 产品结构调整；
- Remote Provisioning v1 双向编辑或远端管理 UI；
- Credential Store/Keychain 重构；
- 为旧远端增加静默兼容模式；
- Coordinator 空 lane 回收；
- 通过 timeout、重试风暴或断开整个已连接 Workspace 掩盖同步失败。

## 9. 2026-09-01 实施记录

本轮已经完成：

- 删除 Renderer 的 Account-first 默认选择和 Family/Plan 推导；失效 Recent 统一回到目标 Host 的 `preferredSelection`；
- 保留 Selection View revision 驱动的空白 Draft 重水合，已有用户显式选择不会被覆盖；
- 首次 Remote Environment Provisioning 的 `failed`、`rollback_failed` 与 `unsupported` 现在拒绝连接且不发布 Renderer service port；
- 已连接 Environment 的后续同步失败保持 Workspace 在线，只记录 Environment、trigger、status、耗时的结构化 warning，等待下一次真实 trigger 重试；
- 后续失败不新增 Banner、协议状态或持久化错误对象。Target 自由文本不进入 Main 日志，避免临时过渡链路引入凭据泄露面。

验证证据：

- Model Selection、Provisioning Coordinator 与 Remote Session 定向测试通过；
- 全量 unit、根 typecheck、lint、Desktop E2E typecheck 与修改文件机械检查均随 Todo 58 的同轮验证通过；
- 相关正式 Provider/Remote E2E 的既有运行证据保留；本轮新增设置页图形交互 Case 的实际运行受当前 Linux 显示环境阻塞，不将未运行写成通过。

# M2：Registry 聚合与刷新链路

> 状态：历史现状调研；结论已经进入目标设计和 M2 实现
>
> 日期：2026-08-13
>
> 用途：保存 M2 开始时的实现、边界和待裁决问题；正文中的“当前”与“仍待”保留当时语境

> 当前 M2 状态见 [`../steps/02-provider-config-and-registry.md`](../steps/02-provider-config-and-registry.md)，
> 剩余旧链路见 [`../steps/02-provider-config-and-registry-cleanup.md`](../steps/02-provider-config-and-registry-cleanup.md)。
> 本文中的候选命名、未决项和聚合方案只用于解释调研过程。

M2 要解决的是 Model 如何从当前 Provider 事实产生。讨论 Registry 时，容易把三件事情混在一起：Registry 如何查询多个 Provider Source、Registry 是否保存聚合结果，以及变化如何送达消费者。本篇先把它们拆开。

## 调研结论的去向

目标设计已经吸收以下结论：

```text
Config / Account Sources
          |
          | change
          v
Registry 构造不可变 View 与轻量索引
          |
          +-- 查询返回当前 View
          `-- 变化事件通知消费者重新读取
```

每个进程持有自己的 Registry 实例；Host 和 Worker 共享实现，不共享内存对象。事件表达旧 View 已失效，完整数据继续由查询接口提供。对应设计见 [`../design/registry/runtime.md`](../design/registry/runtime.md)。

仍待 M2 实施确定的是 Source 如何组合主动失效、文件 watcher 与 freshness check，单个 Source 刷新失败时采用什么策略，以及当前 Host → Worker 完整 Snapshot 如何退出。

本文中的 `Builtin Provider Source` 和 `Temporary Provider` 是调查当时的代码名称。当前设计分别使用 Official Config + AccountProviderAccess，以及 execution-scoped Provider 描述其目标边界。

## 已经确认的边界

同一个 Environment 内，需要 Provider 能力的进程各自持有 Registry 实例。Host、Core Worker、Prompt CLI 和 TUI 复用同一套 Registry 实现，但不共享进程内对象。

```text
同一 Environment 的 Provider Facts
               |
       +-------+--------+
       |                |
       v                v
 Host Registry     Worker Registry
       |                |
       v                v
 查看、选择模型       解析 Selection、创建 Model

Prompt CLI / TUI
└─ 在自己的进程内直接使用同一套 Registry 实现
```

Host 负责模型查看和选择。Submission 携带 `ModelSelection`，Core Worker 根据自己所属 Environment 的 Provider Facts 创建真正执行的 Model。Host 向 Worker 下发完整 Registry Snapshot 是当前迁移期链路，目标状态不再依赖这条链路。

Provider Config 只是 Provider Facts 的一种来源。Builtin Provider、Temporary Provider 和远端 Environment 有各自的状态与生命周期，不能从本地配置的刷新方式反推整个 Registry 的实现。

本阶段暂不展开 Model 内部是否缓存 HTTP Client、连接池、Provider SDK 对象等问题。M2 先确定来源、聚合、查询和刷新边界。

## 查询和通知是两个问题

Registry 可以在查询时直接访问各个 Source：

```text
registry.listModels()
        |
        +--> Local Provider Source
        +--> Builtin Provider Source
        +--> 其他 Source
        |
        v
     合并结果
```

这种实现不一定需要保存完整聚合副本，但它仍然可能需要变化通知。原因是 Host 中的模型选择器、模型可用性门禁等消费者在保持打开时，需要知道数据已经过期。否则只能在每次交互时重新拉取，或者由每个页面各自决定何时刷新。

因此更准确的职责是：

```text
查询接口
└─ 返回调用时的当前 Provider / Model 视图

变化事件
└─ 告诉长期存活的消费者：旧视图已经过期，请重新读取
```

“对外发布变化”首先表示进程内事件，不等于把整份 Registry 广播到其他进程，也不等于 Registry 之间互相同步。

## 调研中比较过的聚合方式

### 查询时聚合

Registry 不保存聚合结果，每次查询都访问各 Source 并合并。它的对象关系最简单，但每次查询都要重复执行冲突选择、排序和 Descriptor 计算；如果多个 Source 在查询过程中先后变化，同一次查询也可能看到不一致的时间点。

### 物化聚合视图

Registry 保存一份不可变的当前视图。Source 变化后构造新视图，再一次性替换旧视图。

```text
Source A contribution ----\
                           +--> Registry View v2
Source B contribution ----/            |
                                       v
                            list / lookup / descriptor
```

查询便宜且视图一致，但 Registry 需要处理刷新、并发和失败。这里的“保存一份”也不必意味着深拷贝所有 Provider、Model 或运行资源；它可以只保存 Source 的不可变贡献和轻量查询索引。

### 分来源状态加轻量索引

目前更值得继续验证的是这一种：Registry 保留每个 Source 的当前贡献，聚合层只维护查找、分组、排序和冲突选择所需的轻量索引。Source 自己负责取得和刷新事实，Registry 不接管 Source 的内部状态。

```text
Local Source   -> Local contribution ----\
                                         +--> lookup / grouped descriptors
Builtin Source -> Builtin contribution --/
```

这项比较推动了当前“不可变 View + 轻量索引”的目标设计。Source 仍拥有自己的获取与刷新机制；Registry 物化适合查询的静态视图，不接管 Source 的网络、文件或账号状态。

## 迁移前的代码如何工作

这段记录的是 M2 开始前的旧实现，保留它是为了说明迁移原因。旧 Desktop Host 曾经有一套“缓存快照、
失效并通知”的实现：

```text
Provider Store / Family Settings / Runtime Headers / Plan 状态
                              |
                              v
                 ModelProviderService
                 ├─ 缓存 Registry Snapshot
                 ├─ save/delete 等操作使缓存失效
                 └─ 重新构造 Snapshot 后触发全局事件
```

代码曾位于 `packages/services/src/model-provider/modelProviderService.ts`。`getProviderRegistrySnapshot()` 缓存
`ZCodeProviderRegistrySnapshot`；保存或删除 Provider、Plan 状态和运行时 Header 变化时，
`emitProviderRegistryChanged()` 会使缓存失效、重新读取并在事件中携带完整 Snapshot。

迁移前 Host 到 Core Worker 的链路如下：

```text
ModelProviderService.onDidChangeProviderRegistry
                    |
                    v
ZCodeAgentService
├─ 对每个 active workspace 排队
├─ 用 revision / generatedAt 去重和防旧快照覆盖
└─ workspace/updateProviderRegistry
                    |
                    v
Core Worker Workspace Catalog
├─ 清空并重建 Provider Map
├─ 更新现有 Session 的相关投影
└─ 发布 workspace state / session settings 变化
```

`packages/services/src/zcode-agent/zcodeAgentService.ts` 曾订阅 Host 侧事件并推送快照；
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` 曾在 Worker 内应用快照。
这是一条跨进程完整快照复制链，已在本轮 M2 迁移中退出本地生产路径；desktop-attached remote 的兼容退出链路
另行记录，不能据此恢复本地全局推送。

迁移前 Renderer 并非统一订阅一个 Registry View：

- `useModelProviders` 维护另一份模块级 Provider Config 快照，通过 `getAllCached()`、`getAll()`、乐观保存和显式刷新更新设置页与聊天页。
- Draft 模型可用性门禁曾订阅 `onDidChangeProviderRegistry`，事件到达时直接采用事件 Snapshot；首次挂载时主动读取一次 Snapshot。
- Repo Wiki 曾订阅同一事件，但事件只作为失效信号，随后重新调用 `getAllCached()`。
- App 根部的订阅主要用于把远端 workspace 标记为“需要重新同步 Provider Registry”。

所以旧系统同时存在 Provider Config UI Snapshot、Host Registry Snapshot、Worker Workspace Catalog，以及多种刷新方式。
通知机制本身不是问题；真正的问题是这些 View 的来源、语义和跨进程职责没有收敛。当前版本已经删除旧
`IModelProviderService.onDidChangeProviderRegistry`，保留的是新 Registry Service 自己的 View 变化通知，以及
旧 Service 内部为兼容连通性测试使用的缓存失效。

## 已进入目标设计的通知语义

对于同一进程内长期存活的消费者，采用“初次拉取 + 变化通知 + 重新拉取”比较清晰：

```text
消费者启动
    |
    +--> registry.list...() 取得当前视图
    |
    `--> 订阅 registry.onDidChange
                       |
                       v
                 收到失效通知
                       |
                       `--> 重新读取当前视图
```

事件可以只携带 revision、原因或受影响范围，完整数据仍由查询接口提供。这样通知和数据读取不会形成两套权威来源。是否需要更细粒度事件，要等设置页、模型选择器和执行侧的读取用途整理后再决定。

Core Worker 在创建新 Model 时还需要保证自己使用的 Registry 已经反映最新 Provider Facts。这个要求不等同于 UI 订阅：具体 Source 可以主动刷新、监听外部变化，或者在查询前做 freshness check。Registry 的调用方不应知道文件 watcher、mtime 或某个 Plan 请求的细节。

## M2 仍需解决的问题

1. Local Provider Source 如何统一处理 Service 写入、外部文件修改和并发刷新。
2. 单个 Source 刷新失败时，是保留上一份成功 View，还是发布去除失败来源后的结果。
3. Registry 失效事件是否需要携带 revision、原因或受影响范围；完整 View 不放进事件。
4. 当前 Host 向 Worker 推送完整 Snapshot 的链路按什么顺序退出，同时保持内部 CLI/TUI 使用能力。

Registry 内 Model 对象的缓存方式和 Provider 运行资源所有权不由本调研裁决，见 [`../design/registry/model-creation.md`](../design/registry/model-creation.md)。

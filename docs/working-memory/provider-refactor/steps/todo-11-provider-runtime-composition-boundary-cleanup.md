# 11 Provider Runtime 组合边界清理

> 状态：草案
>
> 日期：2026-08-25
>
> 来源审查：[`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> 相关设计：[`../design/registry/runtime.md`](../design/registry/runtime.md)、[`../design/environment/environment.md`](../design/environment/environment.md)、[`../design/registry/configuration.md`](../design/registry/configuration.md)
>
> 关联任务：[`06`](./todo-06-config-storage-envelope-repository-privatization.md)、[`08`](./todo-08-legacy-model-catalog-retirement.md)、[`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md)

## 0. 草案边界

本文只保存 2026-08-25 对 Provider 新增实现的组合边界审查结果。当前讨论尚未完成，目标结构、公共 API、
命名和删除范围都**尚未裁决**。在状态由“草案”改为“待执行”以前：

- 不得据此修改生产代码；
- 不得把候选结构写成正式 Design；
- 不得删除现有 Runtime 外壳或改变进程生命周期；
- 不得把本文中的示例名称当作稳定契约。

这项工作先搁置。恢复讨论时应从第 8 节的待裁决问题开始，而不是直接执行第 6 节的候选方向。

## 1. 审查问题

本轮不审查 M4，也不是继续清理旧模型抽象。它只回答一个新增实现问题：当前 Config、Registry、Settings
Facade 和执行进程的装配，是否因为抽象边界没有贯彻到底而形成了多层重复 Runtime 外壳、模糊的资源所有权和
别扭的桥接代码。

重点对象是：

1. `NodeProviderConfigRuntime`；
2. `NodeProviderRegistryRuntime`；
3. Services `ProviderConfigRuntime`；
4. Services `ProviderRuntime`；
5. Host 与 Agent 执行进程的两套真实组合根。

## 2. 已由代码确认的现状

### 2.1 四层 Runtime 外壳

| 当前对象                         | 实际拥有或装配的内容                                                                                    | 当前调用情况                                                   | 审查事实                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NodeProviderConfigRuntime`      | ZCode Built-in 文件 Source、Personal Repository、`ProviderConfigService`、watcher/dispose               | 被其上两层使用；`createNodeProviderConfigRuntime()` 无生产调用 | 主要是 Node IO 资源集合；`start()` 只调用 `configService.read()`，没有独立运行状态  |
| `NodeProviderRegistryRuntime`    | 上述 Config Runtime、`ProviderRegistryService`、可选 Account Source                                     | 生产上由 Agent 的 process root 使用；factory 无生产调用        | 又包一层 Registry 生命周期，并内置第二份 Empty Account fallback                     |
| Services `ProviderConfigRuntime` | Node Config Runtime、Personal 缺省路径、Legacy Personal importer                                        | Host 生产组合根使用                                            | 文件注释已明确它是“兼容装配层”；Legacy 读取边界实际退役后，长期职责可能只剩路径解析 |
| Services `ProviderRuntime`       | Config、Registry、Settings/Selection Facade、RPC service adapter、ready promise、Account Source dispose | Host 生产组合根使用；通用 factory 主要由测试使用               | Host 行为是真实需求，但名称和公开表面把 Host 专属装配描述成了通用 Runtime           |

这些对象并非全部都是错误代码。Node 文件 Source、Personal Repository、Registry、Facade、Account Source 和
watcher 都有真实职责。问题在于它们被多次包成“Runtime”，导致 `start`、`dispose`、空 Source 和所有权在不同
层重复表达。

### 2.2 两个真实进程组合根

当前系统不是只有一套 Provider Runtime，而是有两个目的不同的进程装配入口：

```text
                         同一份静态 Config 文件事实
                                   |
                   +---------------+---------------+
                   |                               |
                   v                               v
            Host 进程组合根                 Agent 执行进程组合根
                   |                               |
       Account Service / Source          Account Snapshot / Source
                   |                               |
                   v                               v
          Host-local Registry              Worker-local Registry
          |              |                         |
          v              v                         v
   Provider Settings  Model Selection          ModelFactory / Core
       RPC Facade       RPC Facade                模型执行
```

两边各自维护进程内 Registry 是既有设计，不是需要消除的重复：

- Host Registry 服务 Provider 设置、Personal 写入预览和用户模型候选；
- Agent Registry 服务 `ModelFactory` 和模型执行；
- 两边读取相同的静态 Config 事实，但拥有各自的内存索引和生命周期；
- Host 向 Agent 同步标准 Model Selection 和 Account Config snapshot/revision，不传一份可变 Registry snapshot。

### 2.3 Host 组合根的具体职责

Host 当前在 `packages/services/src/node.ts` 中按以下顺序装配：

```text
createProviderConfigRuntime
        |
        v
createAccountProviderConfigSource(configService, settings, account services)
        |
        v
createProviderRuntimeFromConfigRuntime
        |
        +--> ProviderRegistryService
        +--> ProviderSettingsFacade / RPC service
        +--> ModelSelectionFacade / RPC service
        `--> Account refresh/dispose ownership
```

它的真实特征是：

- 长期随 window-scoped Local Host / Service Collection 存活；
- Config Service 必须先创建，因为 Account Source 本身依赖同一份 Config；
- Settings 可以修改 Personal Config，并读取权威 Effective Preview；
- RPC 频道可能先同步注册，因此多个首次调用需要共享同一个 Registry ready promise；
- 连通性测试通过 Agent 执行，但设置和选择的权威 View 仍在 Host；
- 不应改变 Desktop continuous、Mobile replayable、remote workspace 或任务队列语义。

### 2.4 Agent 执行进程组合根的具体职责

Agent 当前通过 `startProcessProviderRegistryRuntime()` 服务 Protocol Worker、Prompt CLI 和 TUI：

```text
resolveNodeProviderRuntimePaths
        |
        +--> NodeProviderRegistryRuntime
        |      |- Config Runtime
        |      `- Process-local Registry
        |
        +--> MutableAccountProviderConfigSource
        +--> Model Selection Config Repository
        +--> Standalone credential subscription（仅 Prompt/TUI）
        `--> request-auth/runtime-header port（按入口需要）
```

它的真实特征是：

- Protocol Worker 从 Host 协议接收 Account Config snapshot；
- Standalone Prompt/TUI 从本地 Credential Store 派生 Account Config，并监听凭据变化；
- Worker 只需读取 Config/Registry，不提供 Provider Settings 写入口；
- Registry 必须在 App/ModelFactory 使用前显式启动完成，不需要 Host RPC 的 lazy ready barrier；
- Prompt 按命令拥有生命周期；TUI 在 `/new`、resume、fork 之间共享进程资源；Protocol Worker 随进程存活。

### 2.5 已发现的具体生命周期问题

`startProcessProviderRegistryRuntime()` 返回了两层可释放对象：

```text
outer result.dispose()
|- 取消 Credential Store subscription
|- dispose Model Selection Repository
`- runtime.dispose()
   |- dispose Registry
   `- dispose Config watchers/repositories

outer result.runtime.dispose()
`- 只执行最内层 Registry/Config 清理
```

Prompt 和 TUI 调用外层 `dispose()`；Protocol entrypoint 当前调用
`providerRegistryRuntime?.runtime.dispose()`。因此 Protocol 清理会绕过外层拥有的 Model Selection Repository。
若任何拥有 Credential subscription 的 Standalone 入口也调用内层 dispose，同样会泄漏该订阅。这是由嵌套
owner 暴露造成的具体 bug candidate，不只是命名偏好。

该功能性缺陷不等待本文的架构裁决，由
[`Todo 11A`](./todo-11a-provider-runtime-disposal-functional-fix.md) 单独恢复完整释放语义；本文继续只讨论组合边界，
不借该修复顺手实施候选重构。

## 3. 当前合理边界

无论最终如何裁决，以下事实不应被“去胶水”误删：

1. Host 与 Agent 各自拥有进程内 Registry；
2. Node 文件 Source、Personal Repository 的 watcher、锁、原子写和 dispose 是真实 IO 职责；
3. Account Source 与静态 Config Source 是不同事实来源；
4. Provider Settings mutation target 和 RPC facade adapter 是真实端口，不应让 Renderer 直接操作 Repository；
5. Worker 执行依赖只读 Registry，Host 设置依赖 Personal mutation；两边不需要相同的公开能力；
6. Account Snapshot、Model Selection 和 Request Auth 继续走现有标准边界；
7. 不建立一个包含大量 optional 参数、同时兼容 Host/Worker/Prompt/TUI 的万能 Runtime。

## 4. Node Config 资源边界候选

上一轮讨论提出：`NodeProviderConfigRuntime` 本质更接近一组共享 Node Config 资源，而不是新的领域 Runtime。
这是**候选理解，不是已裁决命名或 API**。

### 4.1 候选包含内容

- Node ZCode Built-in 只读文件 Source：严格解析、内容 revision、watch/change event、dispose；
- Node Personal Repository：read/update、文件锁、原子私有写、revision、watch 去重、dispose；
- `ProviderConfigService`：组合 ZCode Built-in 与 Personal 两层，提供分层读取和 Personal mutation；
- 上述资源的唯一对称 dispose；
- Repository 私有的 schema/migration；Legacy importer 只在兼容期限内临时存在。

### 4.2 候选不包含内容

- Account Provider Source；
- Effective Provider Registry；
- Provider Settings / Model Selection Facade；
- Account credential、Request Auth 或 runtime headers；
- Model Selection Config Repository；
- `ModelFactory`、Active Model、Adapter；
- RPC service；
- Host/CLI 的缺省路径决策和打包物化逻辑。

如果保留这层，其最小输出可以只是：

```ts
{
  configService,
  dispose,
}
```

是否需要 class、factory、公开 export，乃至是否仍使用 `Runtime` 一词，全部待裁决。

## 5. 两个组合根的候选差异

下表用于解释为什么不能把两个入口硬塞成一个万能 Runtime；它不等于最终 API 设计。

| 维度                    | Host 组合根                                       | Agent 执行进程组合根                                     |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| 主要消费者              | Provider Settings、Model Selection RPC            | ModelFactory、Core、Adapter                              |
| Config 能力             | 读取 + Personal mutation                          | 执行消费者只需读取                                       |
| Account 来源            | Settings/OAuth/Entitlement 驱动的 Account Service | Protocol snapshot 或 Standalone Credential Store         |
| 启动时序                | RPC 可先注册，第一次访问共享 ready barrier        | 创建 App 前显式 `await` Registry start                   |
| Model Selection         | 提供候选 View 与用户校验                          | 读取 configured default，供执行创建 Model                |
| 设置能力                | 有                                                | 无                                                       |
| Credential subscription | 由 Host account services 管理                     | Standalone Prompt/TUI 可有；Protocol Worker 没有本地派生 |
| 生命周期                | 随 Local Host / Service Collection                | Prompt 单命令、TUI 长进程、Protocol Worker 进程          |
| 对外结果                | Services/RPC 注册对象                             | Registry、Selection repo、按入口需要的 auth port         |
| 释放原则                | Host 最外层 owner 一次释放全部创建资源            | Process root 最外层 owner 一次释放全部创建资源           |

## 6. 候选收口方向（未裁决）

候选 B 是上一轮审查认为更干净的方向：保留共享 Node Config 资源，Host 与 Agent 在各自真实组合根直接装配
剩余能力。

```text
                   Node Config resources
                   |- Built-in Source
                   |- Personal Repository
                   |- ProviderConfigService
                   `- dispose
                            |
                +-----------+-----------+
                |                       |
                v                       v
       Host composition root   Execution process root
       |- Account Source       |- Account Source
       |- Registry             |- Registry
       |- Settings Facade      |- Selection Repository
       |- Selection Facade     |- optional auth resources
       `- one dispose          `- one dispose
```

它可能带来以下清理，但目前均不得实施：

- 删除 Services `ProviderConfigRuntime`，由 Host 显式决定 Personal 路径和临时 importer；
- 删除 `NodeProviderRegistryRuntime`，由 Agent process root 直接装配 Registry；
- 将 Services `ProviderRuntime` 收窄为 Host 专属组合 owner，而不是通用 Runtime 框架；
- Account Source 变为组合根显式依赖，不在内层悄悄创建 Empty fallback；
- 扁平化每个组合根返回值，只允许最外层 owner 暴露 `dispose()`；
- 删除无生产调用的便利 factory 和只为测试存在的宽入口；
- Worker 只通过 `ProviderSource<ProviderConfigSnapshot>` 等只读接口消费 Config，即使同一对象还具备 Personal mutation。

示例名称如 `createNodeProviderConfigResources`、`createHostProviderServices`、
`startProcessProviderEnvironment` 仅帮助讨论，不是命名决策。

## 7. 备选方案

### 方案 A：保留当前四层，只修生命周期 bug

- 优点：改动最小，风险最低；
- 缺点：重复 Runtime、Empty fallback、模糊 owner 和宽公共 API 继续存在；
- 适用前提：团队认为这些外壳提供的便利大于长期理解成本。

### 方案 B：共享 Node Config 资源 + 两个显式组合根

- 优点：边界与真实进程职责一致；单一 dispose owner；减少无行为 wrapper；
- 缺点：需要同步迁移 Host、Protocol、Prompt、TUI 和测试 helper；
- 风险：如果清理时误删两边独立 Registry 或把 Host 写能力带入 Worker，会偏离既有设计。

### 方案 C：建立一个统一 Provider Runtime

- 优点：表面上入口最少；
- 缺点：需要大量 optional dependency 和模式开关，掩盖 Host/Worker 的不同启动、写能力和 Account 来源；
- 当前审查倾向：不建议，但仍留给正式裁决，不在草案中宣告淘汰。

## 8. 待逐项裁决

恢复讨论时需要逐项确认：

1. 是否认可“Node Config 是 IO 资源集合，不是领域 Runtime”这个边界；
2. 该资源集合使用 class、factory 还是仅为组合根私有 helper，是否公开 export；
3. 是否删除 `NodeProviderRegistryRuntime`，让 Agent process root 直接装配 Registry；
4. Legacy Personal importer 的兼容读取实际退出后，是否删除 Services `ProviderConfigRuntime`；
5. Services `ProviderRuntime` 是保留并明确改为 Host 专属，还是完全内联到 Host composition root；
6. Account Source 是否必须由每个组合根显式提供；无账号入口是否显式创建空 Source；
7. 是否统一规定“只有最外层 owner 暴露 dispose”，禁止返回可单独释放的嵌套 owner；
8. Host ready barrier 与 Worker eager start 是否分别保留，不再抽象成同一套 start 状态；
9. Todo 11 与已完成的 Todo 06/08/10 是否还存在实际前置依赖，还是可独立实施；
10. 最终名称、公共 exports 和包级职责如何表达。

这些问题未逐项确认前，本文不能进入“待执行”。

## 9. Impact Brief（草案）

### 9.1 影响面

| 等级           | 关系                                    | 原因                                                                     |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| must-inspect   | `provider-node` Config/Registry runtime | 候选删除或收窄的直接对象                                                 |
| must-inspect   | Services Host composition               | Account Source、Settings/Selection Facade、ready/dispose owner           |
| must-inspect   | Bootstrap process runtime               | Protocol/Prompt/TUI 的 Registry、Selection repo、Credential subscription |
| must-inspect   | Protocol shutdown                       | 已存在绕过 outer dispose 的 bug candidate                                |
| should-inspect | Provider Node/Services/Bootstrap tests  | 当前测试大量直接依赖宽 Runtime factory                                   |
| invariant-only | Provider Domain Resolver/Registry 语义  | 不改变 Overlay、完整性或候选规则                                         |
| invariant-only | UI 与跨端状态                           | 不改变设置交互、选择状态、continuous/replayable、remote workspace        |

本轮没有可调用的 codegraph 查询能力。现状证据来自目标源码阅读、精确 `rg` 调用点扫描和 export reference
检查；正式实施前仍需重跑依赖图和受影响测试发现。

### 9.2 状态 owner

| 状态/资源                                     | 当前 owner                                   | 候选目标                             |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| Built-in Source / Personal Repository watcher | Node Config Runtime                          | Node Config 资源 owner               |
| Personal Config mutation                      | ProviderConfigService                        | 不变                                 |
| Host Account Source                           | Host Services composition                    | 不变，但显式交给 Host owner          |
| Agent Account Source                          | Process runtime                              | 不变，但显式交给 Process owner       |
| Host Registry ready promise                   | Services `ProviderRuntime`                   | 继续由 Host 专属 owner 管理          |
| Agent Registry startup                        | `NodeProviderRegistryRuntime` + process root | 候选由 process root 显式 await       |
| Model Selection Repository                    | process root outer result                    | 继续由 process root 管理             |
| Credential subscription                       | process root outer result                    | 继续由 process root 管理             |
| 全部资源释放                                  | 多层 `dispose()`                             | 候选改为每个组合根唯一 outer dispose |

### 9.3 必须保持的不变量

1. Host/Agent Registry 仍各自存在，不互传可变 Registry；
2. Host Settings 只写 Personal Config，Effective Preview 仍由服务端权威计算；
3. Agent 模型执行仍经 Registry -> ModelFactory -> Model；
4. Account Config snapshot/revision 和 Model Selection 协议不改变；
5. Config watcher 更新、revision、文件锁、原子写和 importer 既有行为不因改包装而丢失；
6. start 失败与部分创建失败时，所有已创建资源按 owner 对称释放；
7. dispose 幂等，且不能通过嵌套对象绕过 outer owner；
8. 不改变 Desktop continuous、Mobile replayable、remote workspace、Queue 或恢复状态；
9. 不引入第二套 Config、Registry、Account 或 Model 事实；
10. 不借组合清理改变 Account、Access、Request Auth 或模型产品语义。

## 10. 候选验收用例（尚未接受）

以下 Case ID 只为下次讨论保留结构；在 Todo 进入“待执行”前不构成测试承诺。

| Case ID | Setup                                   | Action                 | 候选断言                                                                       |
| ------- | --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| PRC-01  | Host 同时需要 Settings 与 Selection     | 并发首次调用两个 RPC   | 只启动一次 Registry，共享 ready 结果                                           |
| PRC-02  | Host Config 与 Account Source 均已装配  | 保存 Personal Config   | 权威 Effective Preview/Registry 更新，Account Source 仍使用同一 Config Service |
| PRC-03  | Protocol Worker 已收到 Account snapshot | 创建 App 并执行模型    | Worker-local Registry 在 App 前完成启动，不依赖 Host Registry 对象             |
| PRC-04  | Standalone TUI 已启动                   | `/new`、resume、fork   | 共用同一进程 Registry/watchers，不重复创建资源                                 |
| PRC-05  | Prompt/Protocol/TUI 分别退出            | 调用各自 outer dispose | Registry、Config watcher、Selection repo、Credential subscription 全部关闭     |
| PRC-06  | 任一步启动失败                          | 观察清理               | 已创建资源全部释放，原始错误不被清理错误覆盖                                   |
| PRC-07  | Config 或 Account Source 更新           | Host 与 Agent 分别刷新 | 两边本地 Registry 最终读取同一事实，不传 Registry snapshot                     |
| PRC-08  | Desktop/mobile/remote 代表路径          | 设置、选择、执行       | UI 状态、队列、replayable 与 workspace identity 语义不变                       |

## 11. 非目标

- 不处理 M4；
- 不继续清理 Core、ModelRef、Catalog 或 Off-Peak；
- 不改变 Provider/Model Overlay、成员所有权、enabled、visibility 或冲突语义；
- 不改变 Account Connection、Access ID、凭据解析或服务端鉴权；
- 不重构 Provider Settings UI、Model Selector 或跨进程协议；
- 不合并 Host/Agent Registry；
- 不创建新的领域中间态；
- 不借机处理 Telemetry、Queue、Recovery 或 Remote Provisioning。

## 12. 从草案进入执行的门禁

只有同时满足以下条件，才能把状态改为“待执行”：

1. 第 8 节逐项完成人工裁决；
2. 将最终结论写入正式 Design 和 Feature Graph；
3. 用依赖图、`rg` 和 TypeScript export 检查刷新真实调用面；
4. 明确保留/删除对象、最终命名、包级 public API 和唯一 dispose owner；
5. 把第 10 节改成已接受的测试计划，并先写失败测试；
6. 明确 Host、Protocol、Prompt、TUI 的启动失败和释放回归范围；
7. 确认不会改变 Desktop continuous、Mobile replayable 与 remote workspace 状态边界。

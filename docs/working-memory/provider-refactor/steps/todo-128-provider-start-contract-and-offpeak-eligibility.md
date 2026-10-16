# Todo128：Provider 启动契约与闲时资格刷新修复

> 状态：**本地实现与 review 通过，实机验收待整批完成**。2026-09-11 已统一启动/读取契约和闲时资格刷新；不把浏览器受控服务验证等同于 Air 实际套餐验收。
>
> 范围：Provider 生命周期接口、返回值消费点，以及闲时任务资格检查的刷新与并发控制。
>
> 关联：[Todo11 Runtime 组合边界草案](./todo-11-provider-runtime-composition-boundary-cleanup.md)、[Todo127 在线发布](./todo-127-builtin-online-release.md)。本 Todo 不启用 Todo11 中尚未裁决的外壳删除、重命名、owner 重组；不实施 Todo127 的在线下载与 Account/Built-in 对齐方案。

## 1. 背景与审查证据

用户反馈 Air 已有 Team Plan，但自动化页“创建闲时任务”仍禁用，提示“仅限 coding plan 用户使用”。

2026-09-11 只读排查 Air 的设置、日志与安装包，确认：

- 当前选择是 BigModel Team Plan；不在文档保存账号、组织、项目 ID 或凭据。
- Air 日志 `~/.zcode/v2/logs/2026-09-11.log` 在 23:01:21（日志原始时间）记录 BigModel Team Plan 为 `availability: available / entitled: true / current: true`，BigModel 闲时 Provider 也已 `entitled: true`。
- Air 安装包的 Host 代码与仓库一致：闲时 `resolveAccountProvider()` 从 `await providerRuntime.start()` 的返回值筛选 Coding Plan Provider，而该 Runtime 缓存首次启动 Promise 和首次快照。
- 未重启 Air、修改其账号配置、创建真实闲时任务或读取完整运行中内存；日志与包内代码证明账号更新和缺陷实现存在，不能把本轮调查写成修复后的端到端验收。

问题写法最早出现在提交 `90b2cf83ceb9f25af7fd32315a390729d83f22a8`，标题 `refactor(provider): unify provider config and registry`；作者时间 2026-08-20 18:43:17 +08:00，Commit 时间 2026-08-21 11:17:22 +08:00。同一提交里的 `start()` 已缓存首次返回值。2026-08-31 的 `bec05c983c1159126c10fbfcf578da73f85248a2` 只是把解析闭包提到外层供闲时服务和 Host 派发共用，不能依据当前行 blame 把它当成首次引入。

审查期间用实际类和 Store 做了本地隔离验证，数据位于临时目录、无真实网络请求：

```text
ProviderRuntime 首次启动：account-old
Account 更新并等待 Registry.refresh 完成：account-new
再次 runtime.start()：仍是 account-old，且与首次返回对象 ===
registryService.getSnapshot() / registryService.start()：account-new

NodeProviderConfigRuntime：Personal 更新完成后，start() 仍返回首次对象；
configService.read() 已返回新的 Personal revision。

闲时 Store：旧请求 A 尚未完成 → 新请求 B 返回 Team Plan supported=true
          → A 后返回 supported=false → Store 被覆盖回 false
```

这些是故障隔离证据，不是已补入仓库的回归用例。实施时必须先补正式测试。

## 2. 已确认裁决与范围

1. 四个 Provider `start()` 统一为 `Promise<void>`，只负责启动及等待首次就绪。
2. 业务数据显式从 Config/Registry 读取，不能通过启动 Promise 长期保留第一份状态。
3. 闲时资格在 Registry 完成相关更新后重新检查，页面手动刷新也包含完整资格检查。
4. 页面初始化、连接变化和手动刷新共用检查协调逻辑；过期结果和过期错误均不得覆盖当前状态。
5. 保留现有套餐、凭据、额度、模型可执行性规则，不通过放宽资格解决问题。
6. **不改 Composer**。前一轮关于定时任务 Session 与 Composer 草稿的讨论，用户已明确“先不改”，不得夹带实施。
7. 不改持久化 schema，不新增配置文件或数据表，不改变账号连接选择结构、请求鉴权协议或既有模型选择。

## 3. 修改后的接口与读取边界（一层层）

### 3.1 生命周期接口

| 对象 | 当前再次调用结果 | 确认后的结果 |
| --- | --- | --- |
| `ProviderRuntime.start()` | 缓存的首次 Registry 快照 | `Promise<void>` |
| `NodeProviderConfigRuntime.start()` | 缓存的首次 Config 快照 | `Promise<void>` |
| `ProviderRegistryService.start()` | 当前已完成的 Registry 快照 | `Promise<void>` |
| `NodeProviderRegistryRuntime.start()` | 转交底层 Registry 快照 | `Promise<void>` |

Services 的 `ProviderConfigRuntime.start()` 是 Node Config Runtime 的转交包装，也需同步改为 `Promise<void>`。

保留启动去重、既有失败重试、首次加载顺序、变更订阅和完整资源释放。不得为了让每次 `start()` 返回新数据而重复初始化、注册监听或触发网络刷新。相关 Facade 的 ready 回调类型应表达“只等待就绪”，不再靠 `Promise<unknown>` 放宽约束。

### 3.2 数据读取和刷新

```text
await start()                    仅等待首次就绪
      |
      +--> configService.read()          读取当前配置
      `--> registryService.getSnapshot() 读取当前已完成的派生快照

Account / Config 变化
      |
Registry 重算并发布新快照
      |
现有变更通知 → 消费者读取当前状态
```

“当前快照”表示最近一次**已完成**的 Registry 更新，不承诺等待正在进行的账号网络请求。`start()` 完成也不代表后续 Account 刷新完成；需要等待刷新应用的流程，继续使用明确的刷新完成/通知边界。

沿用当前 Config/Registry 为唯一事实源，不增加第二份“最新 Provider 状态”缓存。`refresh()` 的显式刷新职责不并入 `start()`。

### 3.3 所有返回值消费点

| 调用位置 | 当前用途 | 实施要求 |
| --- | --- | --- |
| `packages/services/src/node.ts` 的闲时 `resolveAccountProvider()` | 持续筛选 `start()` 返回快照中的套餐 Provider | 等待启动后读取当前 Registry；保留唯一当前连接、entitlement、模型和鉴权约束 |
| 同文件启动日志 | 记录启动配置版本与 Provider 数量 | 启动完成后显式读取 Registry |
| `packages/provider-node/src/provider-registry-runtime.ts` | Account Source 未初始化时，以 Config 构造默认不可用快照 | 等待 Config 启动后，从 `configService.read()` 读取所需配置 |
| `packages/services/src/model-provider/providerRuntime.ts` | 缓存并向外返回 Registry 启动结果 | 缓存就绪 Promise，不再返回业务快照 |
| `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts` | 把 Node Registry Runtime 启动结果保存为外层 `snapshot` | 显式读取启动快照供必要的一次性日志使用，不将该属性用作持续状态读取 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` | 使用上述 `snapshot` 写启动日志 | 与上一项一起适配；运行期仍使用 Registry 服务 |
| 测试与包装层 | 返回、断言启动快照 | 改为等待启动后通过读取接口断言；同步返回类型 |

已核查的 Provider 设置、模型选择、官方 MCP、Bot、Wiki、Git 提交信息生成、Agent 启动准备和配置分发入口，使用独立服务或仅等待就绪；不将它们误记为均存在旧快照故障。CLI Prompt/TUI 的执行面使用 Registry 服务，外层启动 `snapshot` 的生产消费目前为 Protocol 启动日志。实施前再跑引用检查，避免遗漏后续新调用。

## 4. 闲时资格刷新链路（一层层）

### 4.1 触发时机

当前 `AutomationsSection` 在打开页面时初始化，并在 Settings 的 family/连接选择变化时重查；它未以 Account 更新已应用到 Registry 为重查依据。手动刷新目前仅刷新任务列表和取号额度，漏掉套餐资格。

目标链路：

```text
切换账号连接
      |
旧资格失效，创建入口等待确认
      |
Account 刷新完成 → Registry 更新完成并通知
      |
重新检查当前套餐及请求凭据
      |
资格通过 → 查询取号额度 → 提交同一代有效结果给页面
资格不通过/失败 → 保持现有禁止创建规则
```

- 页面打开仍做一次完整检查。
- 复用现有 Provider 变更通知，确认相关 Registry 更新已完成后再触发资格检查；不能把 Settings 改变等同于账号解析完成。
- 手动刷新顺序为资格检查、必要时取号额度检查；任务列表刷新可独立进行。
- 对共享 Store 的其他闲时入口（包括 `OffPeakNewTaskEntry`）核对同一协调边界，防止重复挂载制造第二套检查。
- 不使用新增定时轮询或任意延时来等待 Account 状态。不为资格检查创建新 Agent/Host，不让页面成为账号事实 owner。

### 4.2 并发及过期结果

当前 `initialize()` 的单次并发去重不能覆盖 `refreshCodingPlanSupport()` 与额度请求。实施时统一协调：

1. 正在检查时收到连接/Provider 新变化，标记旧检查过期并记录需要重查；避免并发重复请求相同资格和额度接口。
2. 在途检查结束后处理最新一次待检查状态；变化合并不得丢掉最后一次重查。
3. 旧成功、旧失败和旧清理逻辑都不能改写更新一代的 Store 状态。
4. 套餐资格与取号额度必须属于同一次有效检查；不能拼接不同连接或不同检查的结果。
5. 保留“当前选择与返回支持快照一致”的既有防护；不通过清空用户连接选择、回退个人套餐等方式恢复创建。

## 5. 实施顺序与验证

1. 先更新相关当前 spec，并补正式单测/E2E；本 Todo 是已确认的实施依据，Design V2 的事实描述随代码落实更新。
2. 四个生命周期接口及转交包装统一返回 `void`，适配读取点、日志与测试。
3. 闲时解析改读当前 Registry；补齐更新完成通知和手动刷新。
4. 统一资格/额度检查协调，补上过期成功及失败结果保护。
5. 跑定向验证与架构、类型、Lint 门禁，再到 Air 验证实际 Team Plan 场景，记录结果后提交。

| 场景 | 必须证明的结果 |
| --- | --- |
| 启动接口 | 四个接口及转交包装返回 `Promise<void>`；并发首次访问不重复创建资源，失败与 dispose 行为不退化 |
| 启动后更新 Account / Personal | 显式读取返回更新后的状态；不得靠重启进程恢复 |
| 无套餐 → BigModel Team Plan | Registry 更新完成后入口自动恢复，不需要退出重进页面 |
| 已有 Team Plan 冷启动 | 首次账号解析较慢也能在更新完成后收敛到正确资格 |
| Team Plan 切走 / 登出 | 旧资格失效，不能被旧成功结果重新放开 |
| 快速切换连接 | 故意倒置请求完成顺序，旧成功、旧失败均不得覆盖新状态 |
| 手动刷新 | 重新解析套餐及凭据；仅资格通过时查询额度 |
| 多闲时入口同时挂载 | 检查去重，后续变化仍能触发必要重查，不因重复请求造成额度接口相互干扰 |
| 执行与其他消费者 | 闲时资格、取号、派发继续共用当前连接鉴权；模型选择、Provider 设置、配置分发和 Agent 启动正常 |

APP 交互修复须有对应 E2E。至少覆盖 BigModel Team Plan，并通过分层用例覆盖 Z.ai/个人套餐现有规则；在 Air 做真实账号运行时复核，真实创建/执行的动作与证据按实施时用户授权和 E2E 规则处理，不把纯 mock 结果写成真实服务成功。

跨端保持：Host/Worker 各自 Registry、远程 workspace 身份隔离与账号分发不变；手机复用 shared-host，不改变 desktop continuous / mobile replayable 消息流，不扩大闲时任务原有远程支持范围。

实施前运行基线新鲜度检查并对齐实际开发基线；本次审查时本地 staging 落后 origin/staging 5 个提交，所审相关实现与该远端引用相同，此事实不能替代后续开工检查。按仓库要求执行 architecture、typecheck、lint 和相关单测/E2E，未验证部分如实留账。

## 6. 当前交付与剩余工作

- 已完成：四个 start 和转交层统一 void，消费方显式读 Config/Registry；Facade ready 类型收紧；CLI 启动日志适配。
- 已完成：Store 统一串行资格/额度检查并同代提交，旧成功/错误丢弃；两入口共享 Hook，由 ProviderSettings 已完成 revision、连接变化、手动操作驱动，重复 key 去重。没有新轮询、缓存事实源或 Composer 改动。
- 规格/影响矩阵：[todo-128-impact-and-cases.md](./todo-128-impact-and-cases.md)。Design V2 与闲时 spec 同步。
- 先红后绿：启动返回值用例、4 个 Store 竞态用例均在旧实现失败；修复后 7 文件 70 项通过；Bootstrap 10 项通过。覆盖启动失败后重试/去重/dispose、Personal/Account 更新显式读取、旧资格/额度和错误晚到、双入口、手动刷新。
- 浏览器 pending：真实 Snapshot + Hook + Store + 创建门禁，受控 Host RPC，1 项通过，验证冷启动未就绪→Team 通知恢复、退出禁用、静默后端恢复后手动重查、当前错误禁用及通知恢复；两入口每次仅一对资格/额度调用。不是安装包/真实后端验收。
- 门禁：root typecheck、Bootstrap typecheck、root lint（0 errors）、architecture（0 violations）通过。CLI 目标文件 lint 无 error。图完整性原有 4 个悬空边，本次新增 0；修改 seeds 存在，Codegraph 工具不可用，使用 dep:refs/精确引用复核。
- review：没有改账号选择、有效性规则、Ticket 鉴权/绑定或数据格式。顺便修正本轮此前 Todo124/130 涉及的两条过时测试前置（未授权测试 Provider、手动模式隐藏字段来源），不为让测试通过放宽产品校验。
- 待整批验收：Air 当前 SSH 可用，但尚未安装/运行本次代码并复核真实 Team 按钮。保持此项未测；不通过修改真实账号、创建 Ticket 或把旧包的表现算成新实现通过。

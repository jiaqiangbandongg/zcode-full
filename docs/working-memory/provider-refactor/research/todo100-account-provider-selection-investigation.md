# Todo100 调查：Account / Provider / Effective Selection 的现状与收口方向

> 2026-09-09；纯调查完成，产品未修复。对应 [Todo100](../steps/todo-100-account-provider-selection-architecture-investigation.md)。
> 已提交基线：`86bbe157c88e8e599694afb53c39f6dac125ac08`。受暂停实验影响的文件以 `git show HEAD:<path>` 核对，不能用工作区试改证明基线已修。没有修改产品代码、测试、真实账号、远端配置或部署。

## 1. 结论

不是“完全没有公共架构”，也不是“只把同步加一个字段就全部好了”。公共 Registry 快照、有效选择算法和 UI 订阅已经存在；主要缺口在装配和消费边界。

优先处理的事情：

1. 让实际执行进程取得完整 Account 事实，且同步确认反映真正已应用的快照。
2. 显式 Subagent 等仍拿原选择直接创建模型的入口，接入已有公共解析；不是再写一份对应算法。
3. 检查有效选择从解析到派发是否丢失。已发现任务适配器带附件分支漏传本次选择；Bot 已有任务的下一条消息没有重新取得有效选择。
4. 把“新意图解析”与“已固定执行”在调用边界区分清楚，不能在 ModelFactory 内统一偷偷换模型。

临时同步机制不值得先做大重构。修完整性、应用确认、生命周期即可；公共模型选择语义不应依赖它的长期存在。独立终端 CLI 的完整账号装配仍按用户裁决暂不改。

证据分级：**确认**表示代码链明确或内存复现；**条件性缺口**表示能确定分支行为，但真实用户是否触发/产品边界仍需区分；**风险**表示尚不能断言发生错误。下文不把所有没有调用 resolver 的地方都报成 Bug。

## 2. 当前分层与状态归属

```text
一个执行环境的 Host
  Settings / OAuth / Team 查询 / Built-in / Personal
       |                    |
       v                    v
  AccountProviderService   ConfigService
  Overlay + states         Built-in + Personal
       |                    |
       +----------+---------+
                  v
        ProviderRegistryService
        [config + account + resolution + registry] 已应用快照
                  |
          +-------+--------------------+
          v                            v
  ProviderSettingsFacade       ModelSelectionFacade
  展示/编辑事实                 原 Selection -> Effective Selection

受 Host 管理的 Worker（普通 / Wiki 等）
  本进程 Config Source <---- 同环境配置文件/刷新机制
  Mutable Account Source <-- 当前临时 Account 协议
                  |
                  v
        相同 ProviderRegistryService / Resolver
                  |
                  v
        ModelFactory -> 固定 Model -> 请求期鉴权
        ^
        基线显式 Subagent 没有接公共 Effective Selection
```

几个容易混淆的点：

- `providerFamilyConnectionSelections` 是用户持久选择；Account `current` 是运行时事实，不新增一份持久 current。
- Account Overlay 和 Account states 是一次账号计算的两个投影；states 不是凭据，也不能因为“不是请求配置”就在跨进程时丢掉。
- Worker 与 Host 已复用 Provider 核心代码，但**注入数据与入口装配不同**。复用同一个 Resolver 不保证结果相同。
- `ModelSelectionFacade` 是纯公共层。读取同一已应用快照，返回候选和输入对应的有效选择；不需要各业务都认识个人/Team/Start。
- Host 网络账号编排位于 services；独立 CLI 当前只装配较简化的个人套餐来源。它不是“算法必须依赖 Host”，而是服务装配尚未对齐。

### SSH / 手机不是另一套业务算法

```text
桌面环境 -- 初始/变更 provisioning --> 远端环境配置存储
                                      |
                                      v
                                 远端 Host
                                 /       \
                            View 服务    远端 Worker

手机 /remote -- shared-host attachment --> 已存在的目标 Host
```

Desktop→远端环境 provisioning 与 Host→Worker Account 同步是不同边。不能为了修后者给手机另建 runtime，也不增加每次普通发送前追平 Desktop 最新配置的屏障。服务目标、缓存和回包归属继续按 `workspaceIdentity?.trim() || workspacePath` 隔离；实际文件操作仍用 workspacePath。

## 3. 已有正确机制：应保留，不重写

| 机制 | 调查结果 | 证据入口（基线） |
| --- | --- | --- |
| Registry 完整应用 | 并发读取 config/account，检查刷新 generation；Account 所基于的 Built-in 不匹配时保留上一份完整快照 | `packages/provider/src/registry-service.ts:180` |
| Facade 同快照解析 | 候选 Registry 和 Account states 来自一次 `getSnapshot()`；不是分别向两项服务取最新值再拼起来 | `packages/provider/src/facades.ts:483` |
| Account revision | 标识已经包含 Built-in 来源、Overlay 和 states；仅 current 改变也会变更，不必再造 revision 系统 | `packages/provider/src/sources.ts:60` |
| Account 刷新 | 合并 pending reasons、串行运行；失败保留上次结果；失败期间新事件会继续处理；初次失败仅账号 fail-closed | `packages/provider/src/account-provider-service.ts:95` |
| 账号作用域隔离 | Resolver 按身份/连接作用域选择可复用的旧结果，不因一次查询失败直接把另一账号的可用事实继承过来 | `packages/services/src/model-provider/accountProviderConnectionResolver.ts:76` |
| UI 异步隔离 | 公共 Hook 处理 owner、输入变化、请求代次、旧回包；有输入时收到通用 change 通知会重新带原选择取 View | `packages/ui/src/hooks/useModelSelectionView.ts` |
| Composer 原意图 | 草稿保存原意图，显示/提交派生有效选择；读取失败不把原意图清库；accepted 写回有独立边界 | `packages/ui/src/v4/composer/useDraftConfigControl.ts:173` |
| 最终创建 Model | 精确校验已经给定的 Provider/Model/档位，再创建冻结配置的 Model；不回退套餐首模型 | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts:43` |

因此，所谓“统一解决中间态”不是全仓加锁，也不是删除现有正确机制。应明确：Account 发布完整结果，Registry 发布完整应用结果，所有需要组合事实的消费者读后者；异步来源的生产还需要针对性保证作用域一致。

## 4. 确认的问题与影响

### P100-01：跨进程丢失 states，执行资格不一致（确认，优先修）

Host Account revision 已包含 states，但 `zcodeAgentService.ts:1169` 发出的信封只有 revision、basedOnZCodeBuiltinRevision、providers。基线协议和 Worker 接收路径也没有把 states 接通。

Resolver 使用 `accountStates?.[providerId]?.current !== false`。这对不定义 current 的普通 Provider / Off-Peak 有既定用途，但信息丢失后也会让非当前普通 Account 通过。

```text
Host:   entitled=true, current=false -> 该套餐模型不进入执行 Registry
传输:   只保留 entitled=true，丢掉 states
Worker: entitled=true, current=undefined -> current 条件放行
```

影响不只 Subagent，而是使用这个 Worker Registry 的精确模型创建、协议模型校验等入口。后续鉴权可能再拒绝请求，但不能把晚一步的失败当作前面正确。

另一个方向：只把 Worker 接上公共 Effective Selection、却不补 states，普通账号选择会因没有唯一 current 而解析为空。两个修复需成套验证。

建议：当前临时协议传完整同一快照；受管理 Worker 的边界明确“初始化 fail-closed”和“完整账号事实”，避免漏 states 被误当正常可执行状态。不能简单把所有 Provider 的 current 改成必填，也不能给 Off-Peak 加 current。

### P100-02：收到不等于应用，ACK 可以报错版本（内存复现，优先修）

链路：

- `bootstrap/src/zcode-protocol-entrypoint.ts:239` 替换 Account Source，await Registry refresh，但没有核实返回的 applied snapshot。
- `bootstrap/src/zcode-protocol/account-provider-config.ts` 无条件回复输入 `snapshot.revision` 为 `appliedRevision`。
- Host 把该结果存进每个 Client 的确认缓存，之后同 revision 跳过。
- Registry 在 Built-in 来源不匹配时允许 refresh 返回旧快照，这是**正确的 Registry 行为**。

```text
Worker 正在使用 A
  -> 收到账号 B，配套 Built-in B 尚未到达
  -> Account Source=B；Registry 仍为完整 A
  -> 协议回复 appliedRevision=B       [错误发生在这里]
  -> Host 认为 B 已完成，不再发送同一份
```

2026-09-09 无账号、纯内存执行 `ProviderRegistryService` 得到：

```json
{
  "sourceAccount": "account-B",
  "refreshReturnedAccount": "account-A",
  "appliedAccount": "account-A",
  "oldHandlerWouldAck": "account-B"
}
```

最后一项是按基线 handler 逻辑推导，并非伪称运行了整个旧协议进程。前面三项是实际运行结果。

建议：ACK 从实际 applied snapshot 得出；尚未应用必须明确区分，不能记成成功。不规定必须阻塞等到最新，也不靠无限等待/延时解决。如何表示 accepted-but-not-applied 可以在实现规格中选最小协议调整。

### P100-03：显式 Subagent 没接公共解析（确认，消费层重点）

基线 `core/src/runtime/methods/subagent.ts` 的同名 effective helper 实际只取 profile.modelSelection 或父选择，不调用 `packages/provider/src/effective-model-selection.ts`。随后使用精确 ModelFactory。

因此个人 Provider 的旧意图在当前 Team 存在同模型时，也不会自动对应。states 丢失时可能先错误通过 Registry，补齐 states 后反而会更明确地失败；所以“补同步后问题更明显”不是应该恢复宽松门禁的理由。

建议：在显式 profile 开始一次新执行时，注入同进程公共读取/解析能力，使用 Worker 已应用完整快照。Profile 不写回。嵌套 child、workflow/script child 必须贯穿相同依赖。隐式继承和内部 override 不经过这次重解析。

### P100-04：Bot 已有任务后续消息不重新解析（条件性缺口，消费边界要明确）

`botsService.ts:4842` 首次创建任务会带原选择读取 View、使用 effectiveSelection 创建任务；这是正确的。

但 `botsService.ts:4934` 已有 activeTask 分支是 resume + send。`sendPromptInBackground:4764` 不传 modelSelection；任务适配器不补解析，Core `turn.ts:105` 在 intent 缺省时直接冻结 Session 已保存的选择。

结论：如果同一 Bot task 已空闲，用户切个人→Team，再发下一条消息，这条路径**不会因 Account 更新自动对应同模型**。这里的“activeTask”是长期复用任务 ID，不等于某一轮仍在执行。

建议按本次目标：闲置任务的新消息属于新派发，应取得有效选择；已经 admission 的输入、已固定运行、重试及运行中的引导不能笼统重解析。具体 Bot busy 输入在哪个既定边界冻结，需要沿原 CommandInbox 语义实现，不能重建 Host 队列。此处记录语义分界，不擅自把所有后续输入改成相同行为。

### P100-05：任务发送有附件分支丢选择（确认分支缺口，尚无真机复现）

`zcodeTaskServiceAdapter.ts:363` 的 `sendPromptToAgent` 接收 modelSelection/modelExecution。

- 无附件：发送 V4 sendText，携带这两项。
- 有附件：调用旧 `zcodeAgentService.sendPrompt`，手工重建参数时两项都未携带。

它不会必然让每一次附件发送出错：若 Session 已经恰好处于同一选择，表现可能正常。但若调用方依靠本次选择覆盖或执行专用 scope，附件分支无法保留同等语义。上层“已经调用了 getView”不足以证明最终执行正确。

建议：针对实际协议能力恢复等价传递，明确 execution-only 边界；不能简单在已运行 Session 全局 setModel 代替。不要求本轮提前完成整个附件协议迁移。

## 5. 逐入口消费审查表

| 入口 | 基线实际行为 | 调查结论 / 后续归属 |
| --- | --- | --- |
| Composer 新建与已有会话草稿 | Hook 带原选择读目标服务；派生 draftConfig；accepted 才提交有效选择的成功写回 | 已接公共算法；保留 scope/request 防竞态，不持续回灌 Session snapshot |
| 普通 Core Turn | admission 前冻结传入 intent 或 Session 选择；随后精确创建 Model | 应保持执行层不偷偷 remap；要求上游新意图入口传完整结果 |
| 定时任务首次派发 | `automationModelSelection.ts` 有原选择时 getView(input)，派发返回结果 | 正确；不能只验证编辑器，需保持后台这条链 |
| 定时任务已固定 run / 重试 | fixedSelection 分支直接返回；调用方用 run 选择 | 正确例外；不要重新对应账号 |
| Bot 草稿展示/首次创建 | 展示返回副本有效值；创建解析并提交有效值 | 已接；P100-04 是另一个已有任务分支 |
| Bot 已有任务新消息 | 沿 Session 选择继续 | P100-04；区分空闲新轮与已接纳运行输入 |
| 任务适配器附件分支 | 未转发选择/执行上下文 | P100-05；有附件与无附件必须达到相同选择契约 |
| Wiki 新生成 | `resolveGenerationConfig` 带原选择读目标 View，校验 issue，固定生成配置 | 已接公共解析；`repoWikiModelClient.ts:95` |
| Wiki 固定生成重试 | `resolveConfig` 不再重新解释账号选择 | 正确例外，不能把 retry 改成 getView 后换套餐 |
| 显式 Subagent | 原 profile 选择直接进工厂 | P100-03；实际执行入口、内置 JSON 覆盖与用户 Markdown 解析结果统一对待 |
| 隐式 Subagent | 继承父 Active Model，有冻结模型工厂 | 正确例外；不能因后台 current 更新让子任务换模型 |
| Workflow / script child | 独立 child runtime 装配，依赖需要贯穿 | 接公共能力时必须覆盖该装配，不另写匹配表 |
| 标题 / Goal 标题 | `title-generation-sidecar.ts:103` 取 title 配置或 Session Selection，再精确建 Model | 不是 UI 消费；独立显式配置是潜在漏接点。已查 Host 当前创建通常只开关标题，没有普通 UI 独立选模入口；不夸大为已确认用户故障 |
| Compact | 有输入 Model 时继承；没有时精确创建 Session Model | 保留运行中继承；手动独立 Compact 的新意图与冻结执行应在入口区分，不把内部每个 model step 都重解析 |
| Memory Extraction / Dream | `project-memory-agent.ts:34` 优先输入 Model，否则从 Session 创建 | Extraction 继承正确；Dream 缺省路径需在后续入口规格明确新工作还是继承工作，不强制统一为最新账号 |
| 连接测试 | 测试明确的设置 Provider / Model，在 Worker 查实际模型 | 不应通过普通账号 remap 测成另一套餐。同步正确性适用，公共“当前套餐对应”不无条件适用 |
| Off-Peak | 创建时取 Ticket；派发校验，使用 Ticket 请求上下文 | 维持原绑定、原 domain 和执行专用 scope；不并入普通账号自动 remap；P100-05 不能丢执行上下文 |
| 手机远控 | 共用目标 Host 服务/任务命令，UI 共用公共 Hook | 不需新增手机 Account 计算；必须保持 replayable 恢复、workspaceIdentity 和 attachment 边界 |
| 独立终端 CLI | 同一 Provider 核心，简化 Account 来源，不完整 Team/Start 装配 | 用户已排除，记录差异即可 |

### 请求期鉴权不是第二个模型选择器

`accountProviderRequestAuthService.ts` / `accountProviderConnectionResolver.ts:253` 按静态 access 的 family/mode 获取当前凭据；mode 不匹配则拒绝，不在请求层把个人 Provider 改成 Team Provider。API Key/JWT/一次性安全校验材料不属于静态 Model Config。

这里的冻结是 **Provider/Model/静态请求配置与本次执行选择**，不是永远冻结 OAuth Token。当前代码允许兼容 family/mode 的请求材料按请求更新（包括当前 Team scope）；这与“同一 Model 永远绑定原账号”的更强语义不同。本项不擅自新增旧账号/旧 Team 锁定，也不借完整快照把 Token 放进去。Off-Peak 另有 Ticket 绑定规则，不能推广普通请求行为到它。

## 6. 临时同步：修正确性，不造第二套平台

### 时机、频率与生命周期

| 项目 | 当前事实 | 判断 |
| --- | --- | --- |
| 上游失效触发 | Family/connection/endpoint 设置变化、配置源变化；登录登出/购买等业务显式 refresh | 事件驱动；Account read 通常读取缓存，不等于每次查询远端 |
| 热推 | Account change 后遍历 `activeClientsByWorkspaceKey` | 普通 Worker 在此；不是全进程广播 |
| 按需检查 | 创建/恢复会话、部分读取/订阅、generateText、连接测试及启动就绪等 | 已共用一个 sync helper，不是每处各写一套网络同步；但策略入口分散 |
| 普通 V4 发送 | 同步检查在 createSession 分支，而非每次普通 sendText 强制追平 Desktop→SSH | 保留已裁决的无全局发送屏障 |
| 去重 | 每个 Client WeakMap 保存确认 revision；同值跳过 | 数据完整/ACK 正确后可继续用；revision 是内容身份，不是可比较新旧的数字 |
| 串行化 | 每 Client Promise 队列，失败不毒化下一个任务 | 已存在，不需要再叠队列；snapshot 在入队前读取，不能仅靠 revision 字符串宣称具备乱序丢弃功能 |
| Worker 重建 | 确认缓存以 Client 对象为 key，新对象不会继承旧确认；WeakMap 不形成永久强引用 | 不应额外制造按 workspace 永久确认表 |
| Wiki Worker | 独立 process manager；已 wire Host handlers；不在普通 active map 热推名单，generateText 前检查 | 不是“完全未同步”。允许旧完整快照；若未来其内部自主发起新工作，需要明确初始化/刷新范围 |
| Plugin / MCP 专用 Worker | 专用 manager，主要做插件/MCP 管理 | 不因“统一”强迫纯读取能力等待账号就绪 |

最低收口建议：保留现有同步 helper/队列，在模型执行 Worker 的初始化/使用契约中明确所需事实；修 P100-01/P100-02。不追求本轮消灭所有 ensure 调用，更不把账号检查加到每个无关 RPC。以后删除传输层，不应修改有效选择算法或各业务保存语义。

## 7. 中间态：真正需要统一的层次

```text
来源读取 / Account 查询（可以异步、可以失败）
             |
             v
同一次作用域的完整 Account 结果
             |
             v
Registry 检查来源配套 -> 发布完整 applied snapshot
             |
       +-----+----------------+
       v                      v
设置/候选/有效选择         传输应用确认
读取这一份结果             确认实际应用结果
```

不能把“全局一致”理解成所有进程同时切 B。旧完整 A 可以继续服务；新的组合不自洽就不发布。

已经证实 Registry 有这层保护、Facade 也正确消费。**尚不能证明 Account 异步上游天然自洽**：settings 在查询开始读取，身份与 API 材料随后异步取得；AccountService 串行化刷新，但没有在每轮返回时像 Registry 那样按更新代次丢弃过期查询。本轮没有用真实账号切换复现“旧选择+新身份/响应”的混合。

这应列为有针对性的生产侧竞态风险 R100-01，而不是宣称“全局到处已经坏了”。后续最小验证是用可控延迟的身份/权益端口，在查询期间切连接或账号，观察发布的 scope、current、模型和 LKG 是否属于同一轮。若不成立，修生产层的作用域捕获/过期结果发布，不在 UI 各自加 timeout。

R100-02：同步 snapshot 在排队前读取，通道只识别同值、不识别先后。目前 Account read 为缓存快照、Client 请求串行；本轮未复现倒序应用。不为了假设风险先引入第二个全局版本时钟。后续用延迟 read/reconnect 场景验证即可。

## 8. 希望重构成什么样

目标不是让每个业务“会同步”，而是让每个业务只说明自己给的是哪一种输入：

```text
保存配置 / 当前草稿                 已固定 Selection / Active Model / Ticket
        |                                        |
        v                                        | 原样使用
公共 Selection 读取入口                         |
  = 同一 applied snapshot + 原意图              |
        |                                        |
        v                                        |
effectiveSelection + issue + View                |
        |                                        |
        +--------------> 新派发边界 <-------------+
                              |
                              v
                       精确 ModelFactory
                       固定本次 Model
                              |
                       请求期合法鉴权
```

建议职责：

- `packages/provider`：继续拥有 Account 编排抽象、Registry applied snapshot、纯有效选择规则。不导入 Host/网络/文件，也不保存业务选择。
- 环境装配层：提供配置来源、Account 事实来源及身份分类器；Host 和受管理 Worker 装配同一套选择能力。临时传输只是 Account source 的一个适配器。
- Core：通过依赖端口解析**显式新意图**；依赖从父 runtime 传入 child/workflow。不能依赖具体 services Runtime，也不应为每次解析反向 RPC。
- UI：继续公共 Hook，不复制账号对应/刷新/过期回包处理。
- Bot/Automation/Wiki：各自拥有意图和执行记录；公共规则返回值，业务在既定新派发点使用。不要把 getView 变成扫描并改写任务文件的操作。
- Factory/adapter：精确执行，不偷偷 fallback，不在每个 HTTP retry 重选模型。

输入种类优先用清晰的函数/端口和现有执行 scope 表达，不急着新增一个通用“大上下文对象”或再造状态框架。是否未来把 Account 服务移到另一个进程是部署决策，不是纯解析算法的前置条件。

## 9. 修复建议顺序与待裁决

本节是调查建议，不是已授权实现：

1. **成套修最小状态闭环**：P100-01 完整事实 + P100-02 真实应用确认。覆盖只变 current、Builtin 不匹配、新 Client、失败后重试；不要以可选字段成功 round-trip 代替两端 Registry 结果对比。
2. **接完整公共消费链**：P100-03 显式 Subagent 的真实模型调用与所有 child 装配；原档位失效/同模型不存在必须按公共规则报结果，不能继承父模型掩盖失败。
3. **修派发丢失并核对新轮**：P100-05 附件协议传递；P100-04 Bot 空闲新输入。严格保持已固定 run、busy admission、Ticket，不改写已接纳输入。
4. **补生产侧竞态证据**：R100-01 延迟查询作用域；检查身份变化与 Config 刷新是否能发布混合结果。若成立在上游修，保留 Registry/Hook 已有保护。
5. **再做必要结构简化**：公共 Facade 装配、Worker 执行能力初始化归口；不把彻底统一临时同步当完成前提。

需要讨论的产品边界仅集中在：Bot busy/队列输入与独立标题、手动 Compact、Dream 的“新工作”和“继承当前工作”分界。隐式 child、运行内 Compact/Extraction、固定 Wiki run、Off-Peak 不需要重新裁决。

独立 CLI 完整账号服务、删除临时同步、全端即时一致、持久化结构重做都不在这轮最小修复目标内。

## 10. 验证、暂停实验及覆盖限度

### 本次已执行

- 工作区 freshness 检查通过；基线固定为 `86bbe157c8`。
- 只读追踪上表入口、Host/Worker 装配、协议、请求鉴权及模型工厂；未改产品文件。
- Registry/Resolver 现有单测 **2 文件 21 条通过**。
- Facade/AccountService/Account resolution 现有单测 **3 文件 31 条通过**。
- P100-02 纯内存复现；没有真实请求、账号凭据或用户数据。
- 第一组命令曾包含不存在的 `effective-model-selection.test.ts` 路径；Vitest 实际只运行另外两文件。随后运行包含相关行为的 `facades.test.ts`；这里按实际文件/条数记录，不称不存在的测试通过。

这 52 条验证的是已有公共机制，不证明传输端到端或产品缺口已修。测试文件和被测 Provider 核心本轮均未修改。

### Todo99 暂停实验的复审

工作区试改加了 states 传输、共享 Facade 装配、Core 可选解析端口和显式 Subagent helper。方向覆盖 P100-01/P100-03 的部分内容，但：

- 没修 P100-02 ACK；不能称完整快照已端到端应用。
- 可选 states 的严格性/缺失语义未形成完整契约。
- 未覆盖 P100-04/P100-05 和辅助消费者边界。
- mock helper 成功不等于真实 child 发出了正确请求；workflow、隐式继承、override 需要联合证明。
- 之前 bootstrap 测试有旧 fixture schema/配置不完整失败，局部类型构建也有依赖产物新鲜度问题；本轮没有继续改这些失败，也没有宣布实验可提交。

因此继续暂停，既不自动采纳，也不自动回滚；之后按裁决从中保留必要部分。实验的测试与产品改动不能混进本次“纯调查完成”。

### 未执行与后续验收要求

- 未做真实多套餐/账号切换、SSH 真机、手机 attachment、Bot 附件及多轮、真实 Subagent 网络请求验证。
- 未证明 R100-01/R100-02 在生产出现；不能把它们列为已复现事故。
- 实现后应验证请求的实际 Provider/Model/档位和执行 scope，而不仅 UI 文案/Schema 接收；运行中切换不能改旧 Model，下一次显式新工作能对应。
- 本轮是 docs-only，不用全仓 typecheck/lint 或 E2E 的历史结果为暂停实验背书；上述单测仅作为调查证据。

## 11. 影响梳理 / 图谱回写建议

采用 feature-boundary-planner 的 impact-only 路径；本次用户明确要求 Todo 和调查报告，未生成实施矩阵或直接改 feature graph。codegraph 工具不可用，使用功能图种子 + 定向文件/调用搜索，不声称已完成全仓自动引用图审计。

主要节点：AccountProviderService → ProviderRegistryService → ModelSelectionFacade → UI Hook / 后台新派发 / 显式 child → ModelFactory；临时 Account transport 是 source 边，不是有效选择规则 owner。

需要后续按真实实现更新的图谱事实：

- 旧“显式 Subagent 必须扩展 Host 解析 RPC”不是必然约束；已有纯 Facade 可经 Worker 本地应用快照复用。
- “Bot 已接公共解析”应拆为草稿/首次创建和已有任务后续消息，不能用前者代表全覆盖。
- “Worker 已共享 Resolver”不能推导 Account states 同样完整；传输缺口应单独标注。
- “同步成功”需要区分 source 接收和 Registry 应用；现有 applied snapshot 能作为证据源。

调查完成只说明这轮逐项已有结论和可追踪证据，不表示系统不存在其他 Bug，也不授权自动恢复 Todo99。

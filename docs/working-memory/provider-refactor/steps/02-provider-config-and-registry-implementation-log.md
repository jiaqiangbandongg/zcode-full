# M2 实施记录

> 状态：历史实施时间线；持续追加审计证据
>
> 开始日期：2026-08-17
>
> 实施目标：[`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)

本文按发生顺序保存 M2 实施中超出原计划、但不值得阻断开发的自主决策和审计证据。正文保留决策发生时的上下文，早期条目可能已经被后续裁决或实现取代，不能单独作为当前事实来源。

当前目标设计见 [`../design/registry/registry.md`](../design/registry/registry.md)，当前实施状态见
[`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)，人的最终裁决见
[`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md)，剩余退役项见
[`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)。

## 1. Registry Service 使用 Source 快照注入

纯领域 Resolver 已经接受 Config 与 Account Access 值。运行装配层继续使用两个窄 Source：

```text
ProviderConfigSource ───────┐
                            ├─> ProviderRegistryService
AccountProviderAccessSource ┘       ├─ resolve
                                    └─ publish Registry View
```

Source 负责文件、RPC、远端接口、缓存及 watcher；Registry Service 只读取不可变快照、监听失效信号并发布内存 View。每份 Source 快照携带 revision，使相同事实引发的主动通知和 watcher 通知可以自然去重。

## 2. 并发刷新使用代际守卫

Registry Service 不使用时间 debounce。每次失效递增请求代际；同一时刻只运行一条刷新循环。读取期间出现新失效时，当前读取得到的旧代际不会发布，循环会继续读取最新 Source。

这解决的是正确性和重复工作，不依赖“等待多少毫秒”猜测 Source 是否稳定。

## 3. 刷新失败暂定保留 last-known-good

Config 与 Account Access 共同决定一个完整 Registry View。任一 Source 读取、Schema 解析或 Resolver 失败时，当前实现保留上一份成功 View，发出刷新错误事件，并等待下一次失效或显式刷新恢复。

暂不发布去掉失败 Source 的部分 View。部分发布可能在瞬时网络或文件错误时大规模移除 Account Provider，并让模型选择和新 Agent Loop观察到非业务事实。首次启动且尚无成功 View 时，Registry 保持空 View并暴露错误。

这是一项可异步裁决的实施策略；如果后续确认某个 Source 允许独立降级，应在该 Source 内形成明确的 fallback 快照，而不是让 Registry 猜测如何拼接失败数据。

## 4. Facade 先建立只读投影

Settings 和 Model Selection 需要的数据形状不同。第一步 Facade 只把同一份 Registry Service Snapshot 投影成可序列化普通对象：Settings 同时看到 Personal 显式配置、Effective 配置和问题；Selection 只看到 Registry 已发布的可选项。

Facade 暂不拥有 Renderer draft，也不直接写文件。Personal 保存、删除和调序需要结合 Config Service 的并发写入边界，在 Host 接入切片中实现。这样不会为了尽早接 UI，把物理存储或 Renderer 状态塞回纯领域包。

## 5. Personal 持久化并发由 Repository 收口

`ProviderConfigService` 不实现文件锁、revision compare-and-swap 或网络重试。Personal Repository 提供原子 `update(transform)`，在它拥有的持久化边界内读取最新 Personal Snapshot、应用变换并保存。Config Service 只提供领域变换与 Source 聚合。

该接口允许本地文件 Repository 使用进程内写队列加文件锁，也允许远端 Repository 使用服务端版本号；两者不需要在 Registry 中建立不同分支。成功写入统一通过 Repository 的变化通知驱动 Config Service 和 Registry 刷新，避免写入回调和 watcher 分别维护两套内存状态。

## 6. 不接入旧 Registry Snapshot

已确认 Official Config、Personal Config 与 Account Access 是唯一事实来源，而且该收敛应高优先级完成。M2 不实现 `ZCodeProviderRegistrySnapshot -> ProviderConfigSnapshot` 适配器，也不让新 Registry 继续消费旧 ModelProviderService 已经混合完成的执行快照。

后续遇到现有 Catalog/Preset/hardcode 时，仍然有效的静态定义迁入 Official Config；用户配置迁入 Personal Config；登录与套餐判断收敛为 Account Access；API Key、JWT、Team Plan Runtime Key 和一次性安全校验 Header 留在请求期鉴权。完成对应迁移后删除旧分支，不保留双事实源。

## 7. 设置页精确 Model Config 对正则字符转义

ModelConfigRules 的 `providerMatch` 与 `modelMatch` 是完整匹配正则。设置页面保存的是精确 Provider/Model ID，因此 Config Service 在写入精确规则时转义 `. * + ?` 等正则字符；读取和删除精确规则使用同一转换。手工配置的 Pattern 规则保持原样。

否则模型 ID `model.1` 会被保存成可以同时匹配 `modelA1` 的规则，设置页面一次编辑可能改变其他模型的 Effective Config。

## 8. Personal Config 使用独立版本化文件

> 后续人类裁决已取代本项：Personal Config 保持原 `config.json` 路径，迁移前先备份；M2 最终完整 Schema 以 `schemaVersion: 1` 首次发布。见 [`Human in the Loop #10`](./02-provider-config-and-registry-human-in-the-loop.md#10-personal-config-保持原路径并以-schema-version-1-首次发布)。以下内容保留 Agent 当时自主决策的审计背景。

Personal Provider 配置从旧 `~/.zcode/v2/config.json` 单向迁移到 `~/.zcode/v2/provider-config.json`。新文件只属于 Provider Config 领域，使用递增整数 `schemaVersion`，避免 Provider 格式升级迫使整个 Environment Config 共用版本。

迁移先原子写入并校验新文件，再切换为唯一权威；旧文件清理可以稍后完成，但不会继续参与读取。未来版本按相邻版本逐级迁移；程序遇到更高版本时拒绝覆盖，避免旧客户端破坏新配置。

这是物理存储命名的实施决策，可以异步调整；版本化文档、单向迁移和新文件成为唯一事实源是已确认要求。

旧 config.json 中的 Builtin/Preset 是历史 Effective Config，不能按 `source` 整份复制到 Personal。迁移器先加载当前 Official Config，再对 ProviderConfig 与 ModelConfig 逐字段求稀疏差异；Custom Provider 因没有 Official 基线而整份迁入。这样既保留当前用户可观察行为，也不会用旧系统生成值冻结未来 Official 更新。

## 9. Personal Repository 使用整段读改写文件锁

Personal Repository 的 `update(transform)` 在同一个跨进程文件锁内完成读取、变换和原子替换。只给最后一次 rename 加锁无法避免两个 Host 同时读取旧值后互相覆盖，因此锁覆盖完整的 read-modify-write 临界区。

本进程保存成功与目录 watcher 都会发出失效通知，不增加 debounce。上层 Source Snapshot 使用内容 revision 去重；这样既不会依赖文件系统事件时序，也不会用延迟窗口掩盖并发更新。

Repository 已经支持注入 Legacy Importer，但当前没有直接复用旧 `ModelProviderService` 的读取结果。真正导入必须等待 Official Config Source 可用后执行差异计算；在此之前，新文件不存在时只返回空 Personal Config，不提前冻结旧 Effective Config。

## 10. Official API Provider 的 API Key 完整性

Official 会声明尚未连接的 API Provider 预置，而 Registry 只应发布当前可创建 Model 的 Provider。Provider 类型已经收敛为带 `kind` 判别字段的 `ApiProviderConfig | AccountProviderConfig`。

API Provider 的最终配置始终需要非空 API Key；Personal Config 可以在 Official 预置上补入 Key。当前阶段不增加无鉴权 Provider 类型，测试与内部 fake 使用 dummy key。Account Provider 的动态凭据继续由 Account Access 和请求期鉴权 Service 管理。缺少 Key 的 API Provider 仍进入设置 Facade 的解析结果并携带校验问题，不进入模型选择和执行 Registry。

## 11. 首批 Official Model Config 的机械迁移口径

首批 Official 文件收录普通 API Provider，并将旧 China LLM Catalog 中的模型静态事实一次性展开成新 Schema。重复模型只保留一份公共 Properties 与 Option Specs；同一模型的 Anthropic/OpenAI-compatible 差异拆成后续 `apiFormatMatch` 规则。旧 `set/unset` Patch 在迁移时展开为每个档位的完整 `ReasoningParameters`，运行时不再依赖 Patch 状态。

旧 Catalog 没有声明 `maxOutputTokens` 的模型沿用当前 Adapter 的 32K fallback。有明确上限的模型继续以该值作为 Model 的上限和缺省值，保持当前 Runtime Model Factory 行为。当前文件先承载事实并接受契约测试；生产链路切换和旧 Catalog/Preset 删除属于后续同一迁移切片，尚未宣称完成唯一运行时来源切换。

## 12. Personal 导入前确定 Provider Config 字段

准备实现旧 `config.json` 单向导入时，先确定新 ProviderConfig 必须承载设置页、选择页和执行共同使用的静态事实。

公共字段为 `kind`、`label`、`logoUrl`、`apiFormat`、`baseURL`、`headers`、`models` 和 `enabled`。API Provider 额外保存 `apiKey` 与 `apiKeyManagementUrl`；Account Provider 暂不预设未经调研的身份字段。Provider 身份由外层 `providerId` 提供，`label` 只负责展示并缺省回退到 providerId。

`apiFormat`、`baseURL` 和静态 Header 对 API、Account 两类都有效。动态 JWT、Runtime Key 与一次性安全校验 Header 不进入 Config。旧 `source`、Catalog 追踪 ID、时间戳、`modified/deleted` 标记和系统禁用原因也不迁入；这些字段的目标语义已经分别由配置层来源、`models` 数组和 Account Access 取代。旧 `providerMappings.claude` 已被当前 v2 Store 的迁移逻辑删除，同样不进入新 Config。

Provider Config Rules 与 Base URL 推断没有进入设计。当前 Official/Personal 直接按 providerId Overlay；如果未来出现足够明确的跨 Provider 配置需求，再根据真实用例增加规则系统。

## 13. Legacy Personal Import 只迁移用户差异

旧 `config.json` 的 Provider 读取结果已经混入 Catalog、Builtin 与迁移 fallback。导入器因此接受当前 Official Snapshot 与旧 Provider 列表，把旧 Effective 值转换后逐字段求差异，只把差异写入 Personal Config。

Provider 层迁移展示字段、请求入口、静态 Header、模型成员、启用状态和 API Key；旧 source、时间戳、系统禁用原因与 Provider Mapping 不进入新格式。Official 已经声明的 Provider 只保存差异，Personal-only Provider 保存完整 API 配置。

模型层只处理旧记录中 `modified: true` 的模型，以及 Official 模型集合中不存在的新增模型。转换后的 Properties、Option Specs 与 reasoning mapping 再和 Official ModelConfig 求差异，避免用户只改 contextWindow 时顺便冻结整个 Catalog 模型。旧 reasoning patch 在迁移边界展开成当前 API kind 对应的无状态参数对象；`unset` 对从空对象构造的映射没有额外含义。

没有 Official 基线的旧 `source: builtin` Provider 暂不导入。这些条目可能携带 JWT 或 Runtime Key，误迁为 API Provider 会把动态账号状态固化进 Personal。Account Provider 的 Official 定义接入后，同一导入器会按 Official 的 `kind: account` 迁移允许的静态覆盖，并忽略旧 API Key。

## 14. Official Config 作为显式安装资源发布

Desktop 正式包把 `config/provider/official.json` 作为独立资源发布到 `resources/config/provider/official.json`。Official Config 不进入 `app.asar`，也不依赖运行时工作目录；后续由 Desktop Main 解析实际路径并显式注入 Local Host。

资源发布与生产 Registry 切换分成两个可验证切片。本切片只保证开发仓库中的版本化 Official 文档能够随安装包到达运行环境，不改变当前 Host 的 Provider 读取链路。下一切片完成路径注入、Source 装配和生命周期管理后，生产 Registry 才开始消费该文件。

## 15. Config Runtime 先接入 Local Host，不提前切换消费者

Desktop Main 根据开发态或安装态解析 Official Config 的绝对路径，并通过 `InitLocal` 显式注入 Local Host。Services 由该路径组装 Official Source、Personal Repository 与 `ProviderConfigService`；共享 Provider 领域包不依赖 Electron、安装目录或当前工作目录。

Config Runtime 已支持注入旧 Provider 读取函数：首次读取发现 Personal 文件不存在时，Repository 使用 Legacy Importer 与当前 Official Snapshot 求稀疏差异。多个窗口的 Local Host 可能同时启动，Personal Repository 的跨进程读改写锁保证只生成一份最终文件。

生产 Local Host 暂不注入该读取函数。当前设置页面仍然写旧配置；如果现在提前生成新 Personal 文件，后续旧配置变化将不会再次进入一次性迁移。生产迁移因此必须与设置写入口切换处于同一个提交序列：先锁定旧写入，完成最后一次差异迁移，再让新 Personal Config 成为唯一写入目标。

本切片让新 Config 成为可持续读取和更新的生产事实源，但仍未把设置页面、模型选择或 Worker 执行切换到新 Registry。新运行栈由 Local Host 生命周期持有并显式释放；初始化失败记录生产错误日志，同时保留现有 Provider 链路，便于在后续消费者切换前发现配置问题。

## 16. Settings Facade 形成可序列化写入屏障

Settings Facade 的写方法接收 `ProviderConfigInput` 与 `ModelConfigObject`，使用和版本化配置文档相同的 Schema 解析，不允许 Renderer 构造 Config Class 或复制校验。保存、删除和调序仍由 `ProviderConfigService` 修改 Personal Overlay。

一次写操作依次执行 Config Service mutation、Registry `refresh()` 和 Settings View 投影。显式刷新只作为提交屏障；它复用 Source 通知、revision 去重和代际守卫，不创建第二份内存状态。RPC 调用返回时，调用方因此能得到与刚刚持久化结果对应的同一 Registry View。

## 17. Account Provider 不把动态凭据重新塞进 Registry

盘点 Start Plan、Personal Coding Plan 与 Team Plan 后确认，旧 Registry Snapshot 同时承载静态定义、套餐允许范围和请求凭据。M2 的 Account Source 只投影允许发布的 Provider、模型，以及创建 Model 时需要固定的非敏感账号访问身份；JWT、复制出的 Personal/Team API Key 和一次性 Header 留在请求期鉴权 Service。

访问身份是必要的执行稳定边界。Personal 与 Team 当前可能共用 providerId；如果 Model 每次请求只按 providerId 读取全局当前连接，用户在 Loop 中切换连接会让旧 Model 静默换凭据。领域接口将其命名为 `accessId`：Account Source 必须提供，Registry 的执行记录保留，Model Selection View 不投影。后续 ModelFactory 在创建 Model 时固定它，同时允许该身份内部的 Token 刷新。

Account Provider Endpoint 当前还会根据 `process.env` 分支。Official Config 成为唯一静态事实源后，不在 Registry 或 Factory 再次改写 Endpoint；Production、Test 与开发环境应由各自注入的完整 Official Config 表达。

详细现状与迁移边界见 [`../research/account-provider-facts-and-auth.md`](../research/account-provider-facts-and-auth.md)。每个 Family 发布一个当前连接还是同时发布多个连接仍是产品级裁决，当前代码未提前改变该行为。

## 18. ProviderRuntime 只负责进程内装配

`ProviderConfigRuntime` 继续只拥有 Official/Personal IO、一次性迁移和 Config Service。新增的 `ProviderRuntime` 在它上面组装可注入 Account Source、Registry Service、Settings Facade 与 Selection Facade。

```text
ProviderConfigRuntime ───┐
                         ├─> ProviderRuntime
Account Access Source ───┘   ├─ Registry
                             ├─ Settings Facade
                             └─ Selection Facade
```

Local Host 已改为持有并启动 `ProviderRuntime`，其生命周期随 ServiceCollection 释放。当前尚未接入 Account Source，因此显式使用空 Source：普通 API Provider 可以独立形成 Registry，Account Provider 不会从旧 Registry Snapshot 回退进入新 Registry。未来 Host、Worker、Prompt CLI 与 TUI 注入各自能够取得的同一 Account Source 接口。

Settings Facade 的写方法和 Selection Facade 的读方法已经通过该 Runtime 使用同一 Registry。现有 RPC/UI 消费者仍未切换，避免在旧 Personal Config 写入口尚存时提前形成双写；下一切片必须把最终一次旧配置迁移和设置写入口切换放在同一提交序列。

## 19. Settings 与 Selection 使用独立 RPC 服务

Local Host 已注册 `provider-settings` 与 `model-selection` 两个服务频道。前者提供 Personal Provider/Model 的保存、删除和调序，后者只提供可选择 View 与 Selection 校验。两者都由同一 ProviderRuntime 创建，RPC 层不重新解析配置。

当前 Renderer 的 `IServiceAccessor` 尚未增加这两个服务，旧 `IModelProviderService` 消费者也没有切换。这一顺序是刻意的：先建立后端契约并验证刷新屏障，再按调用用途迁移 UI；不能先把新 View 转回旧 `ModelProviderConfig[]` 维持表面兼容。

旧服务的方法分类与切换约束见 [`../research/legacy-model-provider-service-call-map.md`](../research/legacy-model-provider-service-call-map.md)。

## 20. Client 代理在迁移期作为可选能力

`RemoteServiceAccess` 已为 `provider-settings` 与 `model-selection` 建立独立代理。`IServiceAccessor` 在 M2 迁移期把它们声明为可选：新 Local Host 已注册频道，尚未注入 Official Config、因而没有 ProviderRuntime 的旧 Remote/Server Entry 不会被迫伪造一套实现。

这项可选性只服务跨 Entry 渐进迁移，不能作为运行时 feature detection。`RemoteServiceAccess` 会无条件创建指定频道的 Proxy，即使旧对端没有注册该频道，字段也不会是 `undefined`。当前设置页只能在确定已经装配 ProviderRuntime 的 Local Host 使用新服务；等 Host、Remote Server、Prompt CLI/TUI 全部完成装配后，删除可选标记，让缺失频道成为明确的装配错误。若需要兼容不同版本的远端 Host，应另建显式能力协商。

## 21. 设置页字段与职责审计

设置页当前同时承担 Config 编辑、Account/Plan 连接、连通性辅助和 Host→Worker Registry 同步。新 `ProviderSettingsService` 只接管第一类；其余能力按自己的领域边界迁移，不能继续通过旧 `ModelProviderConfig[]` 汇总。

旧 endpoint 结构虽然保留 `baseURL + paths`，当前设置页已经收敛到单一 `apiFormat`。保存时会移除历史多 path，自定义完整路径仍保存在 `baseURL`。因此新 Provider Config 不增加 paths 字段；ModelFactory 按 `apiFormat` 采用协议默认 operation path。

完整调用面、字段归属和切换顺序见 [`../research/legacy-model-provider-service-call-map.md`](../research/legacy-model-provider-service-call-map.md)。

## 22. Draft Preview 留在 Settings Facade

设置表单需要同时看到 Personal 显式值、继承后的 Effective 值和完整性问题。`ProviderSettingsService` 新增 Provider 与 Model 两个 preview 方法：它们把已经通过输入 Schema 的未保存 Draft 临时作为最后一层 Personal Config，复用 `ProviderConfigResolver` 计算完整 View，不写 Repository、不替换 Registry、不发变化事件。

这样 Renderer 可以用 Effective 值做 placeholder，并显示领域层校验问题；Renderer 不需要复制 ConfigOverlay、必填字段或 ModelConfigRules 逻辑。

Preview 不是原始字符串表单解析器。用户正在输入的半截 URL、非整数文本等由表单控件维持；形成合法的 `ProviderConfigInput` / `ModelConfigObject` 后才调用 Preview。这样 Provider 领域不需要引入 UI Draft 字符串类型。

## 23. Model Factory 接入前补齐视频 Property

准备让 Registry 创建 M1 `Model` 时，发现设计中的 `supportsVideo` 尚未进入实际 Model 契约。该缺口已在 M1 公共契约、Adapter 请求校验和 Core 媒体投影中补齐；旧 Factory 缺省为不支持，新 Registry 后续从完整 Model Config 提供明确值。

这属于接入前的契约补全，不为 M2 增加新的配置概念。Registry Model Factory 仍只消费最终 Provider 与 Model Config。

## 24. 现有 AI SDK Registry 降为执行投影

M2.5a 新增 API Provider Model Runtime。它从新 Registry View 单向生成现有 `AiSdkModelRegistryConfig`，并用新 Registry 中同一份 ProviderConfig 与 ModelConfig 创建 M1 Model。

旧 `AiSdkModelRegistry` 在这条链路中只承担 SDK Factory、网络、请求安全校验和请求执行所需的内部投影，不再读取 Catalog、CLI Config、Host Snapshot，也不参与 Selection 校验。Registry 更新会替换以后创建 Model 使用的执行投影；已经创建的 Model 持有此前解析完成的 SDK Model，不随配置更新改变。

Reasoning Mapping 在 Model 创建时按 `apiFormat` 放入现有 Adapter namespace：Anthropic Messages 使用 `anthropic`，OpenAI-compatible Chat 使用 `openaiCompatible`，OpenAI Responses 保持现有 canonical 参数入口。Sidecar 的关闭推理与 fixed-thinking 可见输出预算继续复用 M1 Adapter 语义。

当前只完成边界与测试，尚未切换 Worker 生产装配。Account Provider 明确拒绝从这条 API Provider 路径创建，后续接入请求期鉴权 Service；它不会回退到旧 Registry Snapshot。

## 25. Node Config Source 收敛到共享伴生包

M2.5b 需要让 Local Host、Core Worker、Prompt CLI 与 TUI 分别读取同一 Environment 的 Official/Personal Config。当前 Node 文件实现位于 `@zcode/services`：Official Source 依赖 Node 文件读取与 watcher，Personal Repository 还依赖 Services 的路径解析和原子文件工具。Bootstrap 若直接复用它们，就必须依赖包含大量 Host 能力的整个 Services 包；若在 Bootstrap 复制一份实现，文件锁、迁移、watcher 与 revision 行为会立即形成两套。

已经建立 Node 伴生包 `@zcode/provider-node`。纯领域包 `@zcode/provider` 继续只包含 Config、Resolver、Registry 与 Facade；伴生包包含 Official 文件 Source、Personal 文件 Repository、Config Runtime 与进程级 Registry Runtime，并依赖 `@zcode/provider` 与已有 `@zcode/shared/node` 文件持久化能力。旧 `ModelProviderConfig` 到 Personal Overlay 的转换器继续留在 Services，由迁移入口注入，因而新伴生包不依赖旧领域类型。

```text
@zcode/provider              @zcode/provider-node
├─ Config / Overlay          ├─ Official file source
├─ Resolver / Registry       ├─ Personal file repository
└─ Facade                    ├─ Node config runtime
                             └─ Process registry runtime
          ^                              ^
          |                              |
          +--------- Host / Worker / CLI / TUI
```

Official Config 的物理定位仍由 Entry 负责。Desktop Main 解析开发态或安装态文件路径；Local Host 把 Official 与 Personal 文件路径作为成对的进程环境变量交给其管理的 Worker。Worker 使用 `@zcode/provider-node` 自己读取并监听两个文件，不接收 Host 序列化的 Registry 数据。

独立 CLI/TUI 的普通构建与 SEA 仍需携带同一份 `config/provider/official.json`，再把文件或已解析内容交给相同 Source 边界。不能用内置 TypeScript 常量代替，否则会重新产生第二事实来源。

## 26. Registry 与执行 Adapter 使用不同生命周期

实现 Worker 装配时曾考虑把进程 Registry 与 `AiSdkModelAdapter` 合成一个 `NodeApiProviderRuntime`。现有 Adapter 包含 Session/App 级 Model IO、状态和遥测依赖；把它提升为进程单例会让不同 Session 共享不该共享的执行状态，按 Session 创建又会重复启动文件 watcher。

因此两个生命周期分开：

```text
Worker process
└─ NodeProviderRegistryRuntime
   ├─ Config Source / watcher
   └─ ProviderRegistryService

each ZCode App / Session runtime
└─ ApiProviderModelRuntime
   ├─ 订阅进程 Registry
   ├─ 当前 App 的 AiSdkModelAdapter
   └─ ModelFactory
```

Registry 是进程级事实视图；Adapter 与 Model Runtime 是 App/Session 级执行装配。后续 M2.5c 让每个 `createZCodeApp` 借用进程 Registry 创建自己的 Model Runtime，并在 App 释放时对称 dispose。Registry 自身只在 Worker 退出时释放。

## 27. Worker Registry 先以 shadow runtime 启动

M2.5b 已让 Desktop Local Host 向 Worker 注入 Official/Personal Config 路径，Worker 启动一份进程级 Registry 并保持自动刷新。未注入路径的 Standalone CLI/TUI 与旧 Entry 保持原行为；只注入其中一个路径会明确拒绝启动，避免意外混用半套事实源。

这一步没有立即替换生产 ModelFactory。当前设置页面仍写旧配置，Local Host 的最终一次 Legacy Personal 迁移也尚未与新写入口原子切换；此时让 Worker 直接以新 Registry 执行，可能得到空 Personal Config。M2.5c 必须把以下动作作为一个提交序列推进：

```text
锁定旧 Provider 写入口
        |
        v
最后一次迁移到 Personal Config
        |
        v
设置与选择改用新 Facade
        |
        v
每个 App 使用 Worker Registry 创建 Model
        |
        v
删除普通 API Provider 的旧事实读取
```

shadow runtime 只提前验证文件定位、进程所有权、watcher 与 Registry 生命周期，不形成新的业务事实分支。

## 28. App 已支持由 Provider Runtime 独占执行投影

`createZCodeApp` 增加可注入的进程 Registry。注入后，每个 App 创建自己的 `ApiProviderModelRuntime`，借用进程 Registry、拥有自己的 `AiSdkModelAdapter` 与 ModelFactory，并在 App 关闭时释放订阅。未注入时继续使用原 Runtime Model Factory。

当前 Workspace/Turn Model Overlay 过去会直接调用 `replaceRegistryConfig()`。新模式明确把 Adapter 执行投影的所有权交给 Provider Model Runtime；Overlay 仍可维护迁移期 Session 状态与旧投影数据，但不会再覆盖 Adapter Registry。`createModelAdapter` 同时支持直接接收一个空的、由外部管理的初始执行 Registry，因此新模式不需要用旧 Runtime Model Config 先构造一遍 Provider 事实。

```text
legacy app
└─ Runtime Model Overlay -> Adapter execution registry

provider-registry app
├─ Runtime Model Overlay -> 仅维护旧交互兼容状态
└─ ApiProviderModelRuntime -> Adapter execution registry
```

协议入口暂未启用这个选项。Turn Overlay 目前还承载闲时任务等 execution-scoped Provider；若提前启用，新 ModelFactory 无法从进程 Registry 找到临时 Provider。正式打开生产开关前，需要先让临时 Provider 通过统一 ModelFactory 的 execution-scoped 输入创建 Model，或者保留一个边界明确的临时执行分支。

## 29. 旧设置写入口以单向桥接完成 Personal Config cutover

设置页面尚未迁移到新 Settings Facade，但 Worker 已经独立读取新 Personal Config。为了让这两个切片可以连续上线，Local Host 在旧 `IModelProviderService.save/delete` 成功写入后，把当前用户 Provider 静态列表转换为 Personal Overlay，并原子替换新 Personal Config。Registry 随后显式刷新，因此旧设置调用返回时，新事实源与 Worker 将要读取的内容已经一致。

这条桥接只处理用户明确触发的保存和删除，不订阅旧 Registry Snapshot。账号刷新、套餐变化、一次性安全校验材料、临时 Header 和复制出的 Runtime Key 不会因此落盘。Personal 文件首次不存在时，Config Runtime 仍执行同一个转换器完成初始迁移；文件存在以后，以每次用户写操作的完整静态列表为准重新生成稀疏差异。

```text
旧设置页面 save / delete
          |
          v
旧 Service 完成兼容写入
          |
          v
Legacy Personal Importer
          |
          v
原子替换 Personal Config
          |
          v
刷新 Local Host Registry

Worker watcher
          |
          v
刷新 Worker Registry
```

桥接位于旧写队列内部。新 Personal 写入失败时，旧设置调用会失败而不是返回一个只有旧文件成功的假象；再次保存会用完整静态列表收敛。该设计是设置页切换期间的临时边界，退出条件是所有 Provider/Model 配置写入改用新 Settings Facade。届时删除回调和 Legacy 类型依赖，新 Personal Config 保持唯一写入事实源。

## 30. execution-scoped Provider 由 Model Runtime 统一合并

Provider Model Runtime 增加 `ExecutionScopedModelSource`。进程 Registry 继续提供长期 Provider/Model 事实；该 Source 只提供当前 App 正在执行的临时 Provider、内部 Adapter 投影和 Model 创建能力。两者在同一个 Model Runtime 中形成 Adapter 执行配置，execution-scoped 条目在 providerId/modelId 冲突时优先，但不会写入进程 Registry、Settings View、Selection View 或磁盘。

现有闲时任务的 per-turn Runtime Model Overlay 已经封装成这类 Source。Overlay Manager 向外只发布 turn 层的配置、Catalog 和变化事件；workspace/session 兼容 Overlay 不会借此重新进入新执行事实链路。Turn 开始时加入临时 Provider，Model Runtime 原子替换合并后的 Adapter 投影；Turn 结束时移除该层并恢复纯 Registry 投影。正在执行的 Model 已持有自己的 SDK Model，不因投影刷新而改变。

```text
process Provider Registry ───────────────┐
                                         ├─> App Provider Model Runtime
turn ExecutionScopedModelSource ─────────┘   ├─ Adapter execution projection
                                             └─ ModelFactory

Settings / Selection View
└─ 只读取 process Provider Registry
```

这一边界消除了“启用新 Registry 就会让闲时任务临时 Provider 消失”的生产切换阻塞。它仍复用现有 Runtime Model 数据格式和兼容 Factory；M4 将进一步把临时 Provider 输入改成正式 Config/ModelFactory 输入，届时删除这层旧格式转换，但 `ExecutionScopedModelSource` 的生命周期与优先级语义可以保留。

回归验证同时发现一条既有基线不一致：GLM-5.3 生产逻辑会按模型身份把默认 reasoning 档固定为 `max`，`offpeak-turn-model-overlay` 的旧断言仍期待入站的 `high`。本切片没有修改该模型能力分支，也不借 Provider 迁移决定其产品语义；其余 execution-scoped、Runtime、Overlay 和 App 生命周期测试通过。

## 31. Worker 生产 App 开始使用进程 Registry

Protocol Worker 创建 App 时开始注入进程级 Provider Registry。新的 Model Runtime 按三层优先级构造 Model 与 Adapter 执行投影：

```text
turn execution-scoped Provider
              >
process Provider Registry
              >
workspace compatibility Provider
```

workspace compatibility 层只包含 Host 当前下发的 workspace Overlay，不读取旧 CLI Config。它在新 Registry 缺少整个 providerId 时才允许创建 Model，用于维持尚未接入 Account Access/请求期鉴权 Service 的 Plan Provider；同 providerId 已经出现在新 Registry 时，旧配置、API Key 和模型条目都不能覆盖新事实。Adapter 内部执行投影按相反方向合并，使 Registry 覆盖 compatibility，turn execution-scoped 再覆盖本次执行目标。

这条兼容层有明确退出条件：M2.7 把 Account Provider 接入 Registry 与统一 ModelFactory 后，workspace Overlay 中不再存在新 Registry 缺失的 Provider，随后删除 `fallbackSource`。它不参与 Settings/Selection View，也不能成为新增 Provider 的事实入口。

Worker 启动和 Host 首次 Personal 迁移可能并发：Worker 初次 Registry 暂时缺少用户 API Provider 时，workspace compatibility 保持当前会话可执行；Personal 文件落盘后 watcher 刷新进程 Registry，后续创建的 Model 自动切到新事实源。已经创建的 Model 不被改写。

## 32. 模型选择消费面先切普通 API Provider

Renderer 增加独立的 `ModelSelectionView` 快照。Root 先订阅 `ModelSelectionService.onDidChange`，再读取初始 View；revision 守卫防止迟到的初始读取覆盖更新事件。UI 内存快照保留可序列化的 Registry View，不转换成旧 `ModelProviderConfig[]`。

主 Composer 的模型菜单开始直接消费这份 View。新 Registry 中 `kind = api` 的 Provider 按 Registry 顺序投影为模型组，并根据当前 Agent 支持的 `apiFormat` 过滤；同 providerId 的旧快照条目被排除，因此普通 API Provider 的名称、模型集合与顺序以新 Registry 为准。当前选中值、触发器名称和配置恢复资格也同时识别 Registry Provider，避免新 Provider 只能出现在菜单却无法正确回显。

Account/Plan Provider 暂时继续由旧选择投影补充。原因是它们的 Family 分组、个人/团队连接和权益状态尚未接入 `AccountProviderAccess`；提前把 Account Config 当成普通模型组会丢失现有交互语义。这条兼容边界只覆盖 Account/Plan，并在 M2.7 Account Provider 接入统一 Registry 后删除。

主 Composer 之后，Automations（含 OffPeak 共用表单）、Subagent 与 Repo Wiki 的模型菜单也接入同一 View。各功能原有的任务状态、Entitlement 和 Family/Team Plan 逻辑保持不变；普通 API Provider 由新 View 提供，Account/Plan 由迁移期旧投影补充。设置页的 Config 读写仍单独迁移到 `ProviderSettingsService`，不会借模型选择快照执行写入。

模型选择以外，聊天周边读取的 Provider 静态展示字段也遵循同一优先级。模型切换提示与时间线名称、发送遥测中的 Provider Base URL 优先从 `ModelSelectionView` 读取；Registry 尚未发布的 Account/Plan Provider 才回退旧投影。这样普通 API Provider 即使同时存在于两套迁移期对象中，也不会继续让旧快照决定展示或归因。

## 33. Account Access 先建立脱敏迁移 Source

Account Provider 的静态 Provider/Model 事实已经进入 `config/provider/official.json`。当前单文件代表生产环境，因此四个 Plan Provider 使用生产 Endpoint；测试或其他产品环境后续通过注入另一份完整 Official Config 表达，不允许 Registry 再读取 `process.env` 改写 Endpoint。

现有账号、套餐和 Provider Family 逻辑仍集中在旧 `ModelProviderService`。M2 暂时增加唯一的迁移 Source，把它已经筛选完成的 Registry Snapshot 压缩为：

```text
providerId + modelIds + accessId
```

Snapshot 中的 API Key、JWT、Header、Endpoint 和模型能力不会进入新 Account Access。Team Plan 使用完整的 selected connection key 作为 `accessId`；Personal Coding Plan 与 Start Plan 使用稳定的非敏感 ID。这样 Registry 能固定 Model 创建时的连接身份，同时继续把请求凭据留在后续 Request Auth Service。

Official Account Model 暂时保留旧链路实际使用的大小写形式 `GLM-5.2` 与 `GLM-5-Turbo`。ModelConfigRules 是大小写敏感的完整正则匹配，因此本次在 Official Config 中为这两个 ID 写入显式规则，没有全局改变规则匹配语义，也没有静默规范化历史 Session 的 modelId。远端 Official Config 上线后应直接发布完整 Account 模型全集；Access Source 只负责从中筛选账号当前可用的子集。

## 34. Worker Registry 接收账号访问范围，执行凭据暂留兼容投影

旧 Host Registry 协议增加可选的 `accountAccessId`。它只表示当前账号连接身份，不包含 Secret。Host 在构造旧 Snapshot 时根据当前 Personal/Team/Start Plan 连接写入该字段；Worker 收到 `workspace/updateProviderRegistry` 后，先将账号条目压缩为 `AccountProviderAccessSnapshot`，再等待进程 Registry 完成刷新，最后应用旧 Workspace 执行投影。

```text
Host Account / Plan 判断
        |
        | providerId + modelIds + accountAccessId
        v
Worker Mutable Account Source
        |
        v
Worker Provider Registry
        |
        | Account Model 静态事实
        v
ModelFactory

旧 Workspace Snapshot
└─ 暂时只为 Adapter 提供 API Key / JWT / Runtime Header
```

这个顺序保证 Session 创建紧随更新请求发生时，Worker Registry 已经能看到 Account Provider。Account Model 的 Properties、Option Specs、默认 Options 与 reasoningMapping 均来自 Official Config；旧 Snapshot 中同名模型的能力字段不再参与 Model 创建。

请求凭据尚未完成最终迁移。当前 Adapter 在 Model 创建时解析并持有对应的 SDK Model，因此 Coding Plan 的已创建 Model 不会在 Registry 后续刷新时原地换凭据；Start Plan 每次请求前仍沿用现有一次性安全校验 Header 刷新通道。下一切片需要以固定的 `accountAccessId` 建立 Request Auth Service，随后删除旧 Workspace Snapshot 中的账号 Secret 与 `fallbackSource`。在这之前，不把旧执行投影描述为新的 Registry 事实来源。

## 35. Account Access 身份固定在 Model 内部并传到请求边界

Account Model 创建时把 Registry 当前发布的 `accountAccessId` 写入 Adapter Model 的私有执行配置。业务调用方仍只提交通用 `ModelRequest`；它不读取账号连接，也不传递 Access ID。Adapter 在每个真实网络 attempt 调用现有 Runtime Header Port 时附加该 ID，Worker 再通过严格协议交给 Host。

```text
Registry Account Provider(accessId = A)
        |
        | create Model
        v
Model private execution config(accessId = A)
        |
        | each network attempt
        v
Worker Runtime Header Port
        |
        | providerId + modelId + accessId A
        v
Host request-auth boundary
```

这一步只建立稳定身份链路，没有改变现有 API Key、Coding Plan Runtime Key 或 Start Plan 一次性安全校验 Header 的解析与刷新行为。下一切片可以在 Host 端按 `accessId` 取得请求凭据，而无需根据可变的“当前连接”猜测；已创建 Model 即使跨过 Personal/Team 连接切换，也继续请求原连接的鉴权材料。

## 36. Adapter 增加 request-scoped auth material

进一步调研确认，Coding Plan API Key 不只对应一个 HTTP Header。现有 Adapter 会用它初始化 Provider SDK，并在部分 Endpoint 上参与官方版本的请求安全校验。因此 Host 不能提前把所有动态鉴权统一翻译为 Authorization Header。

Model 调用上下文增加内部 `ModelRequestAuth`，包含可选 `apiKey` 和 `headers`。Request Auth Port 可以在每个物理 attempt 返回它；Adapter 基于共享 Registry 中的静态 Provider 执行配置，为当前 attempt 临时创建 SDK Model。临时 API Key 会继续经过现有 SDK、Endpoint Routing 和请求安全校验路径，Header 则在 Provider 静态 Header 之后覆盖。共享 Registry、已绑定 Model 与并发请求都不会被修改。

这项类型不属于通用 `ModelRequest`，也不进入 Provider Registry View。协议 Schema 先支持可选的请求期鉴权结果；Host 尚未提供该字段时，现有 Runtime Header 更新行为保持不变。

## 37. 一次性安全校验 Header 首先接入 request-scoped auth 回执

Services 响应现有 Provider Runtime Headers 请求时，会把 Renderer 取得的一次性安全校验 Header 同时放入协议的 `requestAuth.headers`。Worker 新 Adapter 直接把它用于当前 attempt。旧 `session/updateRuntimeModelConfig` 仍暂时执行，以保护旧 Worker、desktop-attached remote 和尚未迁移的 Model 来源；两条路径使用同一 Header，因此不会改变当前请求结果。

这一步证明了请求期鉴权材料能够沿 Renderer → Services → stdio → Worker → Adapter 完整传输。退出旧 runtimeModel 更新之前，还需要让 Host Request Auth Service 同时提供 Start Plan JWT、Personal Coding Plan Key 与按固定 org/project 解析的 Team Plan Key；不能仅凭当前选中连接从旧 Snapshot 取 Secret。

## 38. Host 建立 Account Request Auth 自动应答边界

ZCode Agent Service 可注入一个窄的 Account Request Auth Resolver。Resolver 按 Model 已固定的 `providerId + modelId + accountAccessId` 取得当前 attempt 的 API Key 和 Header。Personal Coding Plan 与 Team Plan 由 Host 直接应答，不再依赖 Renderer 或 session pane；Start Plan 仍等待 Renderer 产生一次性安全校验 Header，然后把它与 Resolver 返回的 JWT 合并为同一份 Request Auth Material。

Worker 侧的 Runtime Auth Port 保持对所有 Model 可用，但 Adapter 只会在 Model 内部存在 `accountAccessId` 时调用它，因此普通 API Provider 不会多一次 Host 往返。当前完成的是通信、分流和合并边界；下一步把真实 Plan 鉴权解析器注入生产 Host。

## 39. 生产 Host 接入 Account Provider Request Auth Service

Services 新增独立的 `AccountProviderRequestAuthService`，它校验 `accountAccessId` 与 providerId 的归属，并分别解析三种执行身份：

- Start Plan 按 provider family 从 OAuth Token Set 读取 zcode JWT。
- Personal Coding Plan 每次读取该 provider 的最新 API Key。
- Team Plan 解析 accessId 中固定的 product / organization / project，再取对应项目 Key。

Team Key 的远端 ensure/copy 实现暂时复用旧 Model Provider Service 中的稳定逻辑，但输入由 Request Auth Service 用固定 accessId 单独构造，不再读取 UI 当前 selected connection。测试覆盖了“Loop 持有 Team A，当前选择已切回 Personal，请求仍取 Team A Key”的时序。后续删除旧 Registry Secret 投影时，再把远端 Team Key 实现从大型 Service 中物理拆出，不影响本次已建立的对外边界。

## 40. Account Provider 退出 Workspace Secret 创建依赖

Worker 的 AI SDK 执行投影现在同时包含 API 与 Account Provider。Account 投影只包含 apiFormat、baseURL 和静态 Header，初始化 SDK 时允许没有 API Key；`createModel()` 固定 `accountAccessId`，每个真实 attempt 再用 Request Auth Material 创建当次 SDK Model。

因此 Account Model 不再以 workspace compatibility source 中是否存在同名 Model 为创建前提。旧 Snapshot 目前仍可能被 Host 为其他未迁移消费者生成，但本地新 Account Model 的鉴权正确性已不再依赖其 Secret。

## 41. 本地 Host 下发的 Account Registry 去密

当 ZCode Agent Service 同时拥有本地 Provider Registry Source 和 Account Request Auth Resolver 时，它会在 Host → Worker 边界移除 Account Provider 的 `apiKey` 与请求期 Header，只保留 provider/model 静态投影和 `accountAccessId`。去密后的 revision 根据这份静态内容重新计算；Token 和 Team Key 刷新不再导致 Worker 误以为 Registry 静态事实变化。

这个切换暂时只用于本地新 Runtime。desktop-attached SSH / WSL / Docker 目前没有本地 Provider Registry Source，仍保留旧快照兼容；它们在 M2.8 接入同样的 Registry 和 Request Auth 边界后再删除 Secret。

## 42. Settings Facade 先切静态读取事实

Host 会在同步建立 Service Collection 后异步启动 Provider Runtime。新 Facade 最初直接读 Registry Snapshot，Renderer 若在首次 Source 解析前调用 `getView()`，会得到“尚未 start”错误并退回旧投影。`ProviderRuntime` 现在维护唯一 start Promise；Settings 查看、预览、写入以及 Selection 查看和校验都等待这个 ready barrier。

Renderer 增加 `ProviderSettingsView` 共享快照，同样遵循“先订阅、再读取、revision 阻止迟到值”的连接时序。设置页现有组件仍消费旧 `ModelProviderConfig` 展示类型，因此迁移边界先做一次单向投影：

```text
ProviderSettingsView
├─ API Provider 静态字段与 Model Config ──> 设置页兼容展示对象
└─ Account Provider
   └─ 暂时复用旧对象的套餐、连接与产品交互状态
```

API Provider 的 label、Endpoint、API Key、模型集合、Properties、Option Specs 和 reasoning 表现已不再由旧列表决定。Personal-only API Provider 的创建和编辑已经按第 46 节切到新 Config 第一写入；Official/Account Provider 的表单仍经第 29 节桥接。后续把表单的 Personal/Effective 状态与 Account 产品状态分开后，删除兼容投影和旧写入桥接。

## 43. Provider 顺序回归 Personal Overlay

设置页不再用独立 `display-order` 决定新 Provider View 的顺序。页面从 `ProviderSettingsView` 直接取 Effective 顺序，并只为 `canReorder = true` 的 Personal-only Provider 渲染拖动 handle。Official Provider 及其 Personal Override 保持 Official 位置。

拖动后先调用 Settings Facade 重排 Personal Provider Config。传入的 ID 序列是当前 Effective 最终顺序；Config Service 只提取 Personal Overlay 中已有的 key，因此 Official Override 会按 Official 顺序归一化到 Personal-only Provider 之前。本节最初保留了旧 `saveDisplayOrder` 镜像；第 89 节确认新 Host 已无该镜像消费者后，将新旧写入改为互斥路径。

## 44. Personal Model 顺序回归 Provider Config

设置页只为 `canReorder = true` 的 Personal-only Provider 显示模型拖动 handle。拖动使用当前模型 ID 顺序调用 `ProviderSettingsService.reorderPersonalModels()`；Config Service 只重排该 Personal Provider 的 `models` 字段，模型属性仍由 Model Config Rules 单独覆盖。

旧 `ModelProviderConfig.models` 在迁移期随后保存同一顺序，供尚未退出旧列表的消费者使用。镜像构造会把未参与拖动的墓碑或隐藏条目追加回列表，避免一次可见模型调序意外删除兼容状态。新 Personal 写入失败时 UI 恢复原顺序；新写入成功后，旧镜像失败只记录告警，不回滚唯一事实来源。

## 45. Personal-only Provider 删除切到新事实源

设置页删除 `canReorder = true` 的 Personal-only Provider 时，先调用 Settings Facade 删除 Personal Config，再删除旧 Provider 列表中的兼容镜像。新删除失败时保留旧行为并向 UI 报错；新删除成功后，旧镜像失败只记录告警，不能重新创建已从唯一事实来源删除的 Provider。

Official Provider 及其 Personal Override 不走这条入口。它们仍需在新的设置表单明确区分“删除 Provider”和“清除 Personal Override”后再切换，避免把两个产品动作混为一谈。

## 46. Personal-only Provider 先切原子配置写入

旧设置卡片一次保存完整的 `ModelProviderConfig`，其中混合 Provider 字段、模型字段和旧 Catalog 生成值。新设置契约表达的是 Personal 显式层与 Effective 结果；对 Official Provider 直接把旧表单结果写成 Personal Overlay，会冻结继承值，也无法区分“用户显式输入了与 Official 相同的值”和“用户没有覆盖”。因此本切片不对 Official/Account Provider 做 Effective 到 Personal 的反向差分。

Personal-only API Provider 没有 Official 基底，其完整表单可以无损转换为完整 Personal ProviderConfig 与该 Provider 的精确 ModelConfig 集合。Config Service 为这一交互提供单次 Repository update：更新 Provider，并整体替换该 Provider 的精确模型规则；其他 Provider、Pattern 规则和其他 Provider 的精确规则保持不变。设置 RPC 先完成这次新写入，再把相同结果写入旧存储作为兼容镜像。镜像写入不再触发 Legacy Importer 反向替换 Personal Config。

迁移期保留一个明确命名的 Legacy 表单转换入口，负责把旧 `ModelProviderConfig` 转成新 Facade 输入。它只接受 Settings View 已确认的 Personal-only API Provider。退出条件是设置卡片改为直接编辑 `personalConfig`、以 `effectiveConfig` 提供继承展示；届时删除 Legacy 转换入口和旧存储镜像，不把旧类型带入 `@zcode/provider` 领域 API。

## 47. Welcome API Key 登录只修改稀疏 Personal Override

Welcome 中的 API Key 表单只服务 `builtin:zai` 与 `builtin:bigmodel` 两个 Official API Provider。用户提交 API Key 时，新写入口读取 Settings View 中该 Provider 当前的 `personalConfig`，保留已有显式字段，并覆盖 `kind = api`、`apiKey` 与 `enabled = true`。Official 提供的 Endpoint、模型列表和模型配置继续继承，不会被旧 Effective 对象复制进 Personal Config。

保存完成后，旧 Provider Store 仍写入同一结果供尚未迁移的消费者读取，但关闭 Personal Config 反向同步。读取已保存 Key 时也优先使用 Settings View 的 Effective Config；新服务未装配或尚未收录该 Provider 时才回退旧列表。Provider Family mode、App Recent 模型选择和 Welcome 完成状态仍由原有交互状态管理，本切片不改变这些产品语义。

## 48. Custom Model 恢复使用 Selection View 判断可选模型

SessionPane 在恢复只有 providerId、没有 modelId 的旧 Custom Model 选择时，需要选择该 Provider 的第一个可用模型。Model Selection Snapshot 已水合后，这个候选项直接来自 Registry View；Provider 不存在或没有模型时视为当前不可选，不再回退旧 Provider 列表把已失效模型重新带回 UI。只有 Snapshot 尚未水合时，才保留 `getAllCached()` 兼容读取，避免启动早期恢复流程失效。

## 49. Personal-only Provider 删除同时清理精确模型配置

Provider Config 与精确 Model Config 是同一设置对象的两个持久部分。Settings Facade 根据 Official 层判断删除目标：Personal-only Provider 在同一次 Repository update 中删除 Provider 行及该 providerId 下全部精确 Model Config；同一 providerId 下的 Pattern 规则保留。Official Provider 的 Personal Override 被清除时不连带删除独立 Model Override，两个用户动作继续保持可分离。

## 50. 草稿启动门禁优先读取 Model Selection Service

V4 草稿首发只需要判断当前是否至少存在一个可选择模型。新 Host 已装配 `ModelSelectionService` 时，挂载检查、变化订阅和发送前复查都读取同一 Selection View；空 View 表示 Registry 已确认没有可绑定模型。旧 `ZCodeProviderRegistrySnapshot` 只在迁移期服务缺失时回退，继续承担旧 Host 与独立测试兼容。Host 的进程级 admission 仍保留，负责 UI 复查之后发生的配置竞态。

## 51. Prompt CLI 与 TUI 先接入可注入的进程 Registry

`app-server` 已经在 Worker 进程启动一份 `NodeProviderRegistryRuntime`，普通 `--prompt` 与 TUI 仍直接创建 App，因而即使 Entry 已提供 Official / Personal Config 路径，也不会把新 Registry 交给 Model Runtime。

本切片复用同一个启动函数。Prompt CLI 在单次命令中启动、借给 App，并在 App 关闭后释放 Registry。TUI 在首次创建 App 时启动一次；`/new`、resume 和 fork 只替换 App，继续借用同一 Registry，整个 Prompt Handler 关闭时才释放。这样每个 TUI 进程只有一组 Config watcher。

本切片不猜测 CLI 安装位置。只有 Entry 已注入两份 Config 路径时新链路才启用；CLI/TUI 随包 Official Config 与 Personal Config 的默认路径装配留在 M2.6 下一切片。这个边界是正式依赖注入入口，不是旧 Provider 事实回退。

## 52. CLI/TUI 从同一 Official 文件建立默认运行路径

> 本节及下一节记录当时的物理路径实现。后续 [`Human in the Loop #10`](./02-provider-config-and-registry-human-in-the-loop.md#10-personal-config-保持原路径并以-schema-version-1-首次发布) 已裁决 Personal Config 保持原 `config.json` 路径、迁移前备份，并以最终 Schema Version 1 首次发布。

普通 CLI bundle 在 `zcode.cjs` 旁携带仓库的 `config/provider/official.json`。SEA 构建把同一物理文件声明为 asset，启动时读取 asset 内容并按 SHA-256 物化到 `.zcode/v2/runtime-assets/provider/`；文件名包含完整内容哈希，因此新版本不会原地改写正在被其他进程读取的 Official 文件。两种打包方式最终都只向 `@zcode/provider-node` 注入文件路径。

Personal Config 默认指向当前数据根下的 `.zcode/v2/provider-config.json`，与 Desktop 使用同一 Environment 文件。`ZCODE_DATA_BASE_DIR` 继续决定数据根；Desktop Worker、测试和远端部署显式注入的 Official / Personal 路径优先，不会被 CLI 默认值覆盖。Doctor、登录和插件管理等不创建 Core 的命令不准备 Provider asset。

这个切片只完成事实源的物理装配。Standalone App 的默认 Model、`/model` 列表和 Session Selection 仍读取旧 Runtime Config；新 Registry 尚未收录的 Provider 仍由 M2.5 的 workspace compatibility source 执行。下一切片需要完成旧 CLI Personal Provider 的一次性差异导入，并把 Standalone 的模型查看与选择改为 Registry View，随后才能删除这条旧事实读取。

## 53. Standalone 迁移只读取旧用户 Provider 定义

旧 CLI Config 同时承载 Provider、当前模型选择、项目覆盖、MCP、Hooks 等多个领域。Personal Provider 迁移只读取旧用户文件中显式声明的 `provider`；`model` 是 Selection，项目配置、环境变量和 CLI 参数是运行覆盖，它们都不能被固化为 Environment Personal Config。

Desktop 的旧输入是历史 `ModelProviderConfig[]`，Standalone 的旧输入是旧版 CLI 用户配置文件（`provider` → `models` 嵌套格式）。两者先分别适配为当前 `ProviderConfig + ModelConfig`，随后共用一条与 Official 求差异的纯投影。这样旧格式解析留在各自装配层，而 Personal Overlay 的字段差异、精确模型规则和版本化文档生成只有一份实现。

```text
Desktop legacy provider list ──> current Provider/Model ──┐
                                                          ├─> shared Personal diff ─> new file
Standalone user provider JSON ─> current Provider/Model ──┘
```

只有 Prompt CLI 与 TUI 显式开启 Standalone 导入。`app-server` / `agent-server` 等协议 Worker 继续只读取 Entry 注入的 Official、Personal 与 Account Access；它们不会探测本机 `~/.zcode/cli/config.json`。新 Personal 文件已存在时 Repository 不调用 importer，因此旧用户文件后续残留不会重新覆盖新事实。

实现把“已经展开的当前 Provider/Model 与 Official 求差异”下沉为 `@zcode/provider` 的纯投影。Desktop 历史列表和 Standalone 用户 JSON 各自只负责适配旧字段，差异计算、精确模型规则与版本化文档生成共用同一实现。

Standalone 适配器当前迁移 Provider 名称、API Format、Base URL、API Key、静态 Header、模型顺序、Properties、Option Specs 与 reasoning mapping。旧格式还允许 `model.headers` 和 reasoning 之外的任意 `model.options`；当前正式 Model/Request 边界尚未裁决这些执行字段的归属。

迁移采用全有或全无：任一旧 Provider 含有这些未表达字段时，本次 importer 返回“未迁移”，Repository 不创建 Personal 文件，M2.5 compatibility source 继续保护旧执行行为。这样后续版本补齐字段后仍能重新尝试，不会被一份部分迁移的空文件永久截断。Standalone Selection View 退出旧模型列表前，必须先决定是把仍有效的固定字段纳入 Config，还是明确删除对应旧能力并提供迁移诊断。

## 54. Session 模型选择按 Provider 切换到 Registry

Standalone Prompt CLI / TUI 已经拥有进程级 Registry，但 `ZCodeApp.listModels()`、`setModel()` 和 `setThoughtLevel()` 仍由旧 Runtime Model Config 与 Catalog 解释。只替换模型列表会产生一个不可接受的中间状态：用户能够看到 Registry 模型，切换时却被旧配置拒绝。

本次把这组行为作为一个整体切换：

```text
Registry 已拥有 Provider
├─ 候选模型来自 Registry View
├─ Properties / Option Specs 来自 ModelConfig
├─ reasoning 档位通过 ModelRef.variant 交给新 ModelFactory
└─ 显式切换只更新 Session 运行状态与 Session Selection

Registry 尚未拥有 Provider
└─ 整个 Provider 继续使用 M2.5 compatibility source
```

兼容合并以 Provider 为单位。新旧来源不会为同一个 Provider 逐模型拼接，因此 Registry 一旦接管某个 Provider，旧 Catalog、旧 reasoning 和旧 capability 就不再参与这个 Provider 的选择链。

Registry 路径不再把 `/model` 切换写回旧 CLI Provider 配置文件。该动作表达当前 Session 的模型选择；旧文件写入只保留在未迁移 Provider 的兼容路径。CLI/TUI 新 Session 的 Configured Default 仍暂时来自旧 Runtime Model Config，后续建立正式默认 Selection 后再删除这项启动依赖。

## 55. `includeUsage` 归入 Provider Config（已被 74 覆盖）

旧 CLI Provider 的 `includeUsage:false` 会让 OpenAI-compatible 流请求不发送 `stream_options.include_usage`。这是 Provider 连接的稳定执行语义，不依赖 Session 或单次 Request，因此进入 Official/Personal Provider Config，并由 Model Runtime 投影到现有 Adapter。

该字段对 API 和 Account Provider 使用同一 Config 语义；当前只有 OpenAI-compatible Adapter 消费它，其他 API Format 忽略。旧 CLI Personal Importer 可以无损迁移该字段。

模型级 `headers` 和任意 `options` 仍不进入本切片。它们会改变 Model/Request 边界；Importer 继续对含有这些执行字段的 Provider 整体拒绝迁移，不产生部分成功的 Personal 文件。

## 57. 区分旧 Model 执行字段与无消费方元数据

旧 `interleaved` 和 `reasoningContentField` 会转换成 `ModelCapability.reasoningContentField`，但生产代码中没有 Model Request、历史消息转换或 Adapter 读取该字段。它们是未完成闭环的 Catalog 元数据，不应继续阻止 Provider 进入新事实源。Standalone Importer 因此忽略这两个旧字段。

`model.options.max_tokens` 和历史 `model.options.extra_body.max_tokens` 都表达模型输出上限。Importer 将它们归一为 `optionSpecs.maxOutputTokens`，不再将 raw Provider 参数带入新执行链。优先级保持旧逻辑：`limit.output > options.max_tokens > options.extra_body.max_tokens > maxOutputTokens > Catalog/Fallback`。

其余 `model.options` 和 `model.headers` 都会改变实际请求，不能作为无效元数据丢弃。本次审计先保持导入拒绝；后续切片需要把它们收敛进有类型的 Config 与 Adapter 装配边界。

## 58. 模型级静态 Header 由 ModelConfig 封装（已被 71 覆盖）

旧 CLI 会按 `Provider Header -> Provider options Header -> Model Header -> inline target Header` 合并静态 Header。inline target 已不属于新 Config 语义；前两层已收敛为 ProviderConfig.headers。Model Header 仍是同一 Provider 下按模型分化的有效执行配置，因此收敛为 `ModelConfig.headers`。

Registry View 携带已解析的 ModelConfig。Worker 创建 Model 时把 `headers` 交给 Adapter 的 Model 装配边界；Adapter 将它覆盖到当前 Provider Header 上，并在 Account 鉴权每次刷新 Header 后重新应用同一份 Model Header。对外 Model 和 ModelRequest 类型不新增 Header 字段。

`headers` 是 ModelConfig 的普通值字段：后一条命中规则整体替换前一条的 Header 字典。Personal 差异投影、JSON Schema 与 Standalone Importer 使用同一字段，不建立第二份运行时表达。

## 59. 模型固定请求参数收敛到 Adapter 装配边界（已被 71 覆盖）

旧 CLI 的 `model.options` 会在模型目标解析时合并进 Provider Options，`reasoningSummary` 等字段会真实改变请求，因此不能在迁移中丢弃。它也不能重新成为公开 `ModelRequest` 上的任意参数入口，否则 M1 已建立的通用请求边界会被绕过。

ModelConfig 增加 `requestParameters: ProviderRequestParameters`，保存模型固定使用的 Provider-native JSON 参数。Registry 创建 Model 时，先递归合并 `requestParameters` 与当前 reasoning 档位对应的 `reasoningMapping`，后者覆盖同名叶子；随后根据 Provider `apiFormat` 包装一次并交给 Adapter。Core、公开 Model 与 ModelRequest 不感知这些字段。

ModelConfig 规则之间仍遵守普通 Overlay 语义：后一条规则的 `requestParameters` 整体替换前一条。递归合并只用于同一个最终 ModelConfig 内的“模型固定参数 + 当前 reasoning 参数”，对应旧运行时已经存在的行为。

Standalone Importer 把旧 `model.options` 解开当前 API Format 的历史 namespace 后写入 `requestParameters`。`max_tokens` 与 `extra_body.max_tokens` 已归一为 `optionSpecs.maxOutputTokens`，导入时从原始参数删除，避免预算字段重复。该决定补齐了原计划没有明确列出的旧执行字段，同时保持 Official + Personal + Account Access 是唯一事实源。

## 60. 不迁移旧 Provider Schema 中没有消费方的字段

旧 Provider `options` Schema 接受 `timeout`、`chunkTimeout` 和额外未知字段，但模型目标解析与 Provider Registry 都不读取它们。实际 HTTP 超时来自独立的 `network.timeout`，流空闲超时来自 `modelStream.idleTimeoutMs`。这些字段在旧链路中已经不产生运行行为，因此 Standalone Importer 忽略它们，不再让整个 Provider 迁移失败。

`apiKeyRequired: false` 继续拒绝迁移。本轮 ProviderConfig 只有需要 API Key 的 API Provider 和请求期取得鉴权的 Account Provider；团队已明确暂不为无鉴权、自托管测试端点建立第三种正式形态。Importer 保持全有或全无，使这类内部配置继续走兼容链路，不会生成一份无法执行的新 Personal Config。

## 61. 旧设置表单保存时保留模型私有执行配置（已被 71 覆盖）

设置页面当前仍把新 ProviderSettingsView 投影为旧 `ModelProviderConfig` 表单。这个旧类型没有模型级 Header 和 `requestParameters`，因此用户只修改 Provider 名称、Base URL 或 API Key 后再保存，直接反向导入会整体替换精确 ModelConfig 并擦掉界面无法表达的执行事实。

迁移桥保存 Personal-only API Provider 时，以旧表单转换出的可编辑配置为准，同时从当前 Registry 同名模型保留 `headers` 与 `requestParameters`。两项字段只在 Adapter 装配边界消费，旧设置页没有编辑或清除它们的交互；保留当前值符合用户可观察语义。新设置表单直接编辑 ModelConfig 后，这段桥接逻辑随旧 `ModelProviderConfig` 投影一起删除。

## 56. Provider Config v2 与设置页迁移桥（已被 74 覆盖）

Provider Config 文档版本提升到 2，并内置 v1 到 v2 的相邻版本迁移。`includeUsage` 是可选字段，因此迁移保持原配置内容，只更新文档版本；Official Source 和 Personal Repository 都通过同一迁移入口读取，未来版本继续沿相邻版本逐级升级。

当前设置页仍把 `ProviderSettingsView` 投影成旧 `ModelProviderConfig` 表单对象。若迁移桥不携带 `includeUsage`，用户编辑其他字段再保存时会把这项新事实从 Personal Config 中抹掉。迁移期旧类型、Schema、Settings 投影与反向 Importer 因此显式携带该字段，保证一次设置页往返不丢配置；新表单直接编辑 Personal/Effective Config 后，这组桥接字段随旧类型一起删除。

## 62. Registry 模型的 main alias 来自正式 Environment 默认选择

`listRegistryBackedModels()` 已经从新 Registry 取得模型集合，却仍按 `providerId/modelId` 从旧 Runtime Model Config 复制 alias。这样同一个 Registry View 会因为进程里是否残留旧 CLI 配置而得到不同展示，违背唯一事实源。

Registry Provider 的 alias 改由正式 `configuredDefaultModelSelection` 计算：匹配 Environment 默认选择的模型获得 `main`，其他 Registry 模型没有 alias。尚未迁入 Registry 的整个 Provider 仍原样保留旧列表及其 alias，直到对应 compatibility source 退出。`lite` 不再从旧配置复制；它已经不是新模型选择状态的一部分。

## 63. Turn 与 Workspace Model Source 明确拥有各自 target

Worker Model Runtime 目前保留三类来源：长期 Process Registry、本轮 Turn Execution Source，以及尚待退出的 Workspace Compatibility Source。Workspace Source 过去用“workspace 或 turn 任一 overlay 命中”判断自己是否拥有 Model；它读取的配置却只有 workspace overlay。Turn Source 因为优先级更高而掩盖了这个不一致，但 source 单独查询时可能宣称能够创建一份自己并未持有的临时 Model。

本切片把 Workspace Source 的 target 判断收窄为 workspace overlay 自己的成员，并将 Model Runtime 中含混的 `fallbackSource` 命名改为 `workspaceCompatibilitySource`。来源优先级保持不变：Turn 临时模型先于 Registry，Workspace 兼容模型只在 Registry 缺少整个 Provider 时使用。协议写入、闲时任务切换以及旧 workspace snapshot 尚未删除；本次只建立后续 M2.8 可以逐项退出的准确边界。

## 64. Account Access 复用 Provider Config Overlay

第一次收敛尝试把旁路 `AccountProviderAccessEntry[]` 改成 `AccountProviderOverlay[]`，但仍然引入了 `{ id, allowedModelIds }` 和 `Provider.accountAccess`，没有真正复用已有 Config Overlay。人复核后确认：Account Source 应直接输出第三层稀疏 `ProviderConfigMap`，与 Official、Personal 使用同一种数据结构和 Overlay 算法。

`AccountProviderConfig` 增加 `accessId`，Account 层通过普通字段 Overlay 提供当前 `accessId` 与 `models`；不再保留 `allowedModelIds` 和模型交集过滤。最终 Registry 成员使用 `Provider` / `ProviderModel`，ModelFactory 从 `Provider.config.accessId` 固定请求身份。

Registry 只负责最终 Config 的 Overlay 与完整性校验，不验证 `accessId` 是否真实可用。即使 Personal 文件被手工写入无效身份，请求期 Account Request Auth Service 也无法据此取得 JWT、API Key 或 Header；动态鉴权仍是账号权限的最终边界。第一次迁移先从旧 Snapshot 投影 Account `ProviderConfigMap`，独立同步边界在下一切片替换这条来源。

## 65. Account Config 使用独立的进程级同步协议

Worker 不再从 `workspace/updateProviderRegistry` 的完整运行快照反向提取 Account Config。Host 持有的 Account Provider Source 通过 `provider/updateAccountConfig` 发送 `revision + ProviderConfigMap` 普通对象；Worker 使用 `@zcode/provider` 的正式 Schema 解析，拒绝混入 API Provider，替换进程级 `MutableAccountProviderConfigSource` 后刷新 Registry。

```text
Host Account Provider Source
        |
        | provider/updateAccountConfig
        v
Worker MutableAccountProviderConfigSource
        |
        v
ProviderRegistryService.refresh()
```

新 Worker 在应用 Workspace Registry Snapshot、创建 Session 或开始其他模型执行前，先同步当前 Account Config。Host 记录每个 Worker Client 已应用的 revision；相同 revision 不重复发送。Account Source 变化会直接推送所有本地 active Worker，无须重建 Workspace Snapshot。desktop-attached remote 暂时保持旧边界，随 M2.8 单独迁移。

协议只传 Account Provider 的 `accessId`、`models` 等静态 Config 字段。JWT、API Key 与动态 Header 继续由每次请求的 Account Request Auth Service 解析；静态 Config 同步与请求期鉴权之间没有 Secret 复用。Worker 未装配进程 Registry 时该协议明确失败，不返回伪造的 `unchanged`；这是本轮自主选择的 fail-closed 行为，用于尽早暴露 Host 与 Worker 装配不一致。

## 66. 本地执行先退出 Workspace Compatibility Source

完整 Workspace Registry Snapshot 同时承担旧 Workspace State 投影和 ModelFactory 兼容来源。直接删除协议会把展示、默认值、远端和执行四项职责一起改动，因此 M2.8 先切断风险最高的执行旁路。

本地 Worker 已经拥有 Official、Personal、Account 三层进程 Registry。它创建普通长期 Model 时只允许查询这份 Registry；Workspace Catalog Overlay 仍可短期参与旧 Workspace State 与模型列表投影，但不会再编译进 AI SDK 执行 Registry。Turn Execution Source 保持最高优先级，继续服务 execution-scoped 临时 Provider。

desktop-attached remote 尚未完成远端自身 Config/Registry 迁移。协议 Entry 根据明确的 runtime surface 为本地注入 `registry-only`、为远端注入 `legacy-snapshot`；兼容条件不放进 ModelFactory。Standalone CLI/TUI 仍缺省保留兼容来源，保护尚未迁入正式 Config 的内部 Provider，后续按其独立迁移进度退出。

## 67. Local Host 停止下发完整 Workspace Registry Snapshot

本地 Worker 已经独立读取 Official 与 Personal Config，并通过 `provider/updateAccountConfig` 接收第三层 Account Config。Session create/resume/read、Workspace read/generate、Conversation cold subscribe 和 V4 createSession 入口不再调用 `workspace/updateProviderRegistry`；它们只等待 Account Config 的 revision 屏障。

Host 的 Provider Registry 变化仍服务两类本地职责：未配置模型时的启动门禁，以及迁移期 Runtime Model 的解析/热更新。变化事件不再把完整 Provider 集合复制到 active Worker。旧同步队列、generatedAt 水位和 per-workspace revision 缓存随本地写入方一起删除。

`workspace/updateProviderRegistry` 协议及 Host 显式方法继续保留。desktop-attached remote、Bot Remote Workspace Bridge 和远端 UI 同步仍然依赖它们；这些调用会把已应用 Snapshot 缓存为远端 Runtime Model 与请求鉴权的兼容事实。该远端边界将在远端自身 Registry 装配完成后单独删除。

## 68. V4 草稿门禁退出旧 Provider Snapshot fallback

V4 草稿的 Renderer 前置门禁已经能够从 `ModelSelectionService` 取得 Registry 发布的可选模型 View。生产 `IServiceAccessor` 始终提供该服务，因此继续把旧 `IModelProviderService.getProviderRegistrySnapshot()` 作为可选 fallback，只会让测试桩保留第二份事实来源。

门禁现在只订阅和读取 `ModelSelectionView`。读取异常仍然表示“门禁无法确认”，继续交给 Host 启动门禁做竞态兜底；空 View 才表示确定没有可选模型。该切片不改变错误展示、草稿持久化或远端 Workspace 行为。

## 69. ZCode Agent 模型回显裁决改读 Selection View

`resolveModelSelectionForConfigOptions()` 的 ZCode Agent 分支需要判断当前回包或 App Recent 指向的 Provider 是否仍可选。它此前通过 Renderer 全局 `ModelProviderConfig[]` 快照完成判断，使同一选择语义继续依赖旧 Provider Service。

该分支现在只读取已经水合的 `ModelSelectionView`，并从其中建立 Provider ID 查询集合。View 未水合时仍保留用户的待提交选择；View 已确认 Provider 不存在时，不再用陈旧偏好覆盖 Agent 回包。非 ZCode Agent 的原有 supplier 裁决服务保持不变。

## 70. Provider 展示字段退出旧快照兜底

模型切换 Toast、模型切换时间线和发送埋点已经订阅 `ModelSelectionView`，但过去仍同时订阅旧 `ModelProviderConfig[]`，在新 View 未命中时从旧快照补充 label 与 baseURL。Account Config 已经作为第三层 Overlay 进入正式 Registry 后，这个 fallback 会让相同 Provider 的展示和埋点继续存在两个事实来源。

`resolveProviderLabel()` 与 `resolveProviderBaseURL()` 现在只读取 `ModelSelectionView`。View 尚未水合或 Provider 不存在时，label 稳定回退为 providerId，baseURL 返回 `undefined`；View 发布后 React 订阅会重新渲染展示。三处调用方不再订阅或即时读取旧 Provider 快照。该切片只收敛展示字段来源，不改变 Plan 权益、设置编辑或模型执行。

## 71. 删除任意 Model Options 与模型级 Header

人复核旧 CLI、Desktop 设置能力与内部评测用例后，否决了 58、59、61 为无损兼容而引入的扩展。任意 `model.options` 与模型级 Header 没有形成正式产品契约；继续保留会绕过 ModelOptionSpecs、ModelOptions 和 reasoningMapping 的强类型边界。

ModelConfig 因此只保留 Properties、Option Specs 与 reasoningMapping。Provider 静态 Header 继续由 `ProviderConfig.headers` 表达；账号动态 Header 继续由每次请求的 Account Request Auth Service 提供。旧 CLI Importer 只把 `options.max_tokens` 和 `options.extra_body.max_tokens` 归一为正式 `maxOutputTokens`，不再迁移其他任意 Options 或模型级 Header。旧设置页保存桥也不再维护界面无法表达的两项私有字段。

Provider Config 文档升级到 schemaVersion 3。v2 -> v3 的相邻迁移删除 `ModelConfig.headers` 与 `ModelConfig.requestParameters`，其余 Provider 和 Model 配置保持原样。当前 Schema 直接拒绝这两个字段，防止它们通过手写文件重新进入执行链。

## 72. Repo Wiki 独立进程使用同一 Registry 事实边界

M2 rebase 到最新 staging 时，Repo Wiki 新增的独立 Agent lane 与“本地 Host 停止下发完整 Workspace Registry Snapshot”发生代码冲突。独立 lane 解决 chat watchdog 回收长时间 Wiki 请求的问题，属于必须保留的运行时隔离；lane 专用的完整 Registry 同步 map 则属于 M2 已退出的旧事实链路。

合并后的 Repo Wiki 继续使用独立 Process Manager、Client 和显式 dispose 生命周期。它与普通本地 Worker 一样，自行读取 Official 与 Personal Config；Host 在生成前只建立 Account Config revision 屏障。测试分别覆盖两个 lane 的请求隔离，并确认二者都不会重新调用 `workspace/updateProviderRegistry`。

## 73. 本地 Repo Wiki 静态模型事实改读 ModelSelectionView

Repo Wiki 的模型请求已经进入统一 Worker Model，但 Host 在生成前仍通过旧 `IModelProviderService.getProviderRegistrySnapshot()` 解析 provider、模型、最大输出与 reasoning 档位，导致本地执行前置配置继续存在第二事实源。

本地 Host 现在优先从 `ModelSelectionService` 读取 Registry 发布的 View。迁移适配器只投影现有 Wiki 解析器需要的静态字段，不携带 API Key、Account Secret 或 Provider-native 请求参数；实际请求仍只携带 ModelRef，由 Worker Registry 创建 Model。已经装配新 Provider Runtime 时不会再读取旧 Source。

现有 Wiki 解析器暂时保留 `ZCodeProviderRegistrySnapshot` 输入形状，用来限制本切片的影响面。未装配 Provider Runtime 的旧 Entry 仍可回退旧 Source；desktop-attached remote 继续读取 workspace 镜像。两项兼容边界会在对应 Entry 和远端 Registry 迁移时删除，不能作为本地正式事实源扩散。

## 74. OpenAI Compatible 始终请求流式 Usage

Usage 是模型执行结果的一部分。OpenAI-compatible Adapter 现在固定向底层 SDK 传入 `includeUsage: true`，Provider Config、Model Target、Registry 执行投影与设置迁移桥不再提供关闭开关。

Provider Config 文档升级到 schemaVersion 4。v3 -> v4 相邻迁移删除 Provider 中残留的 `includeUsage`；Desktop 与 Standalone 的旧 Personal Importer 都忽略该字段。旧 CLI 配置解析仍可读取包含此字段的历史文件，但不会把它带入新的 Config 或 Model 执行链。不支持 `stream_options.include_usage` 的兼容服务不在正式支持范围内，也不提供删除字段后重试的旁路。

## 75. Account 权益判定退出旧 Provider 大对象

Start Plan、Coding Plan 与 Team Plan 的权益判断过去直接接收旧 `ModelProviderConfig`。这个类型同时携带 endpoint、models、Catalog 痕迹和设置状态，使账号逻辑看起来依赖整套旧 Provider 事实，阻碍 Account Source 独立产生第三层 `ProviderConfigMap`。

权益判断的输入已经收窄为 `providerId`、可选鉴权输入、启用状态和系统禁用原因；账号连接上下文继续由独立 Context 提供。旧 `ModelProviderService` 在自己的兼容边界完成一次适配，权益模块不再读取模型、endpoint 或 Adapter 配置。Start/Coding 的成对互斥、Team Plan 校验、断连原因和设置页连通性语义保持不变。

本切片只整理 Account Provider 的领域输入。权益刷新、缓存和 Account `ProviderConfigMap` 的直接生产仍由后续切片从旧 `ModelProviderService` 中提取；这里没有增加第二套 Account 状态。

## 76. Provider Runtime 显式接受 Config Runtime

`ProviderRuntime` 过去在构造函数内部创建 `ProviderConfigRuntime`。这使 Config Service 只有 Registry 构造完成后才能取得，真正的 Account Provider Service 无法依赖同一份 Official/Personal 配置状态，只能旁路读取文件或继续从旧 Registry Snapshot 反向投影。

现在组合根先创建 `ProviderConfigRuntime`，再把它显式交给 `ProviderRuntime`。原有 `createProviderRuntime(options)` 仍作为 Standalone 便利入口保留；Host 使用 `createProviderRuntimeFromConfigRuntime()` 表达正式装配顺序。`ProviderRuntime` 接管注入实例的生命周期，因此 Facade ready barrier、Config watcher 和 dispose 语义保持不变。

这个切片没有改变 Account Source 内容，生产仍暂时使用旧 Snapshot 适配器。它建立了下一步直接创建 Account Provider Service 所需的单向依赖：Account Service 可以读取同一个 Config Service，再把 Account Config Source 交给 Registry。

## 77. Account Provider Service 作为无 IO 的第三层 Config Source

`@zcode/provider` 新增 `AccountProviderService`。它读取与 Registry 相同的 Config Source，把 Official 与 Personal Provider Config 先行 Overlay，再把当前 Config View 交给注入的 Account Resolver。Resolver 只返回 Account `ProviderConfigMap`；文件、网络、OAuth、套餐和团队接口均留在外围实现。

Service 的首次 `read()` 是 ready barrier。Config Source 变化会触发后台重算，账号事件可以显式调用 `refresh()`；成功结果按内容生成稳定 revision，只有 Account Config 真正变化时才通知 Registry。刷新失败会报告错误并保留 last-known-good Snapshot；首次刷新失败则直接失败，不把网络异常伪装成“当前没有账号 Provider”。

本切片建立领域服务及其测试，尚未把生产 Host 从 `LegacyAccountProviderConfigSource` 切换过来。下一切片需要将 Start/Coding/Team 的现有查询实现成 Account Resolver，并由新的组合根把 Service 直接注入 Registry。

## 78. Account Connection Result 按 Provider 保留确定状态

Account 远端接口并不总是同时成功：Start Plan 的 `billing/balance`、Personal Coding Plan 的 `subscription/list` 和 Team Plan 的项目接口可以分别得到 available、unavailable 或 unknown。把任一 unknown 当成整个 Source 失败，会吞掉同一轮已经确定的结果；把 unknown 当 unavailable，又会因为网络抖动删除仍然有效的模型。

`@zcode/provider` 现在提供统一的 Connection Result 解析。available 生成 `accessId/models` Overlay，未返回专属模型集合时沿用当前 Config 的模型顺序；unavailable 明确删除该 Provider；unknown 沿用该 Provider 上一次成功的 Account Config。首次没有旧值时，unknown 项暂不发布；所有候选均 unknown 且没有上一份状态时抛出明确错误，交给 AccountProviderService 的首次失败边界处理。

解析按 Config 中的 Account Provider 顺序生成结果，拒绝重复连接、未配置 Provider、API Provider、空 accessId 和空模型集合。`createAccountProviderConfigResolver()` 已把远端 Connection Resolver 与 AccountProviderService 的 Config Resolver 接口连接起来；生产代码下一步只需提供真实连接结果。

## 79. Services 将当前 Plan 产品状态适配为 Connection Result

新增 `accountProviderConnectionResolver` 作为 Services 与纯 Provider 领域之间的过渡边界。它读取当前账号域、Family 的 API Key / OAuth 连接模式、Personal/Team 选择，并调用现有 Z.ai / BigModel Start/Coding 权益校验；对外只产生按 Provider 排序的 `available / unavailable / unknown`。

非当前账号域与显式 API Key 连接模式被解释为确定 `unavailable`，不再请求 Plan 接口。Coding Plan 在选中有效 Team connection key 时使用完整 key 作为 accessId，否则使用稳定 Personal accessId；Start Plan 使用稳定 Start accessId。某个 Provider 未从远端得到结论时保留 `unknown`，后续交给领域解析的按 Provider last-known-good 规则处理。

适配器的 Personal Coding Plan Key 来源是窄注入端口，本切片没有把旧 `ModelProviderConfig` 存储绑死到新领域。生产组合根切换前，还需将该 Key 的物理所有权收敛到凭据边界，并保留 Start Plan 远端权威模型集合的行为。

## 80. Start Plan 权益与模型成员共用 balance 响应

Start Plan 原有两个消费方：权益校验只读 `plans`，Preset 构建另外读 `balances.capabilities` 生成模型列表。新 Account Connection Result 需要同时表达两者，否则切换 Source 后会退化为 Official 文件里的静态模型集合。

`CodingPlanAvailabilityResult.available` 现在可选携带 `models`。Start Plan availability 在同一次 `billing/balance` 响应中校验 active plan 并提取去重后的模型成员；Services Connection Resolver 把该列表透传给领域层，Account Config 因此可以覆盖 Official 的 `models`。

## 80. 本地 Host 先退出旧 Account Registry Snapshot

Account Access 已经收敛为第三层 `ProviderConfigMap`，生产本地 Host 因此直接组装 `AccountProviderService + Account Connection Resolver`。Resolver 读取同一份 Official/Personal Config、当前账号域、Family 模式、已选 Personal/Team 连接与现有权益接口，输出 `available / unavailable / unknown`；领域 Service 再形成带 `accessId/models` 的 Account Config。

账号状态变化暂时复用旧 ModelProviderService 的 change event 作为 invalidation 信号，但事件只负责触发 `AccountProviderService.refresh()`。刷新结果不读取旧 `ZCodeProviderRegistrySnapshot`，旧 Snapshot 因而不再是本地 Host Account Provider 或模型成员的事实来源。`desktop-attached-remote` 保留原兼容 Source，等待 M2.8 的远端切片处理。

Personal Coding Plan API Key 的物理迁移没有夹带进本切片：Connection Resolver 与 Request Auth 仍可从旧 Provider Store 读取它，但只能把它当作凭据兼容输入。下一切片把该 Key 迁入 Credential Service 并删除旧读取后，Account 静态事实与请求凭据两条链路才会完全摆脱旧 Provider Store。

## 81. Personal Coding Plan Key 按 accessId 进入 Credential Service

Personal Coding Plan 的复制 Key 属于请求凭据，不属于 Provider Config。新的 `AccountProviderCredentialStore` 使用 Model 已固定的 `accessId` 形成凭据键；Connection Resolver 的权益判断与 Request Auth 的每次 attempt 从同一 Store 读取。显式 Coding Plan 刷新取得新 Key 后写入 Store，logout / unlink 通过原清理入口删除。

为兼容当前已安装用户，Store 在新键缺失时可以调用一次注入的旧 Provider Key Loader。读到非空旧值后先写入 Credential Service，再返回调用方；已有新值时不会访问旧 Store，空旧值也不会制造凭据记录。这是单向迁移，不形成 `new > old` 的长期优先级链。

旧 `ModelProviderService` 在迁移期仍会维护 Provider 文件中的影子 Key，供尚未迁移的旧消费者使用；新 Connection Resolver 与 Request Auth 已不再把它当作权威。删除这份影子字段属于后续“清除旧 Provider Store 消费者”切片，届时可以连同旧写入一起移除。

## 82. Workspace 模型偏好裁决改用 Model Selection View

非 ZCode Agent 的 workspace 配置回显此前由 Renderer 把旧 `ModelProviderConfig[]` 传给 Host。Resolver 因而重新检查 `enabled`、`apiKey`、endpoint 和模型数组，形成了 Registry 之外的第二套可选性判断。

现在 Renderer 对所有 Agent 类型都以进程级 `ModelSelectionView` 作为候选事实。Resolver 直接消费其中的 Provider View；Registry 已负责完整性、凭据、启用状态和模型有效性过滤，Resolver 只保留本职工作：读取 workspace 配置，比较 providerId 与规范化 baseURL，校验模型属于该 Provider，并按照原规则产生 ghost 或已匹配结果。

这项迁移没有改变 draft、session、last-selected 或提交行为，也没有改变 desktop continuous 与 web remote replayable 的交付边界。功能影响图中已有 `model selection -> provider registry -> conversation/model surfaces` 关系，本切片没有产生新的产品语义节点。

## 83. 本地 Bot `/model` 候选改用 Model Selection Service

Bot 内部有两类名称相近但归属不同的模型数据。Provider/Model 一级候选是 App 全局 Registry 投影；workspace `configOptions` 则是某个 Agent runtime 的当前值和能力目录。前者需要统一，后者必须继续按 `workspaceKey` 独立缓存。

本地 Host 现在向 Bots Service 注入同一进程的 `ModelSelectionService`。`/model` 优先从该服务读取 Provider 顺序、label 和可选模型；成功返回空列表也视为权威空状态，读取失败时才沿用最后一次成功的内存投影。Bot 不再在这条本地主路径读取旧完整 Registry Snapshot。workspace configOptions 的持久缓存、当前模型与写入 runtime 的命令链路均未改变。

desktop-attached remote 尚未装配正式的新 Registry Source，因此继续使用旧 Snapshot 兼容分支，等待 M2.8 与远端 Provider 权威边界一起退出。该兼容分支不会参与本地 Host 的模型候选裁决。

## 84. 本地 Bot `/status` 的 Provider label 改用 Model Selection Service

Bot 状态文本过去会在解析 `providerId/modelId` 或 custom model value 后，重新调用旧 `ModelProviderService.getAll()` 查询 Provider 名称。这使 `/model` 已使用新 Registry，而随后展示的 `/status` 仍可能显示另一份旧 Config 中的 label。

本地 Host 注入 Model Selection Service 后，Bot 现在用同一份 Selection View 取得 `/model` 候选与 `/status` label。读取成功的空 View 同样是权威结果；读取失败时沿用该 Bot 进程最后一次成功的 Selection 投影。只有尚未装配新服务的 desktop-attached remote 兼容路径继续读取旧 Provider Config。本次没有改动 Bot 启动期旧状态迁移、workspace configOptions 或远端 Registry 同步。

## 85. V4 custom provider 恢复删除旧 Config fallback

V4 在 configOptions error 场景恢复仅含 providerId 的 custom model value 时，已经先从 Renderer 内存中的 Model Selection View 选择该 Provider 的第一个模型；View 尚未就绪或不包含该 Provider 时，旧代码还会调用 `ModelProviderService.getAllCached()` 再查一次旧 Config。这使 Registry 明确给出的“当前不可选”可能被旧快照反向覆盖。

恢复入口现在只接受 `resolveFirstSelectableModelId()` 的结果。View 未水合返回 `undefined`、Provider 不存在返回 `null`，二者都停止恢复并保留现有告警；不会跨回旧 Provider Config 猜测模型。workspace restart、prepare、模型切换提示以及偏好确认时序均未改变。源码边界测试固定了 SessionPane 不再直接调用 `modelProviderService.getAllCached()`。

## 86. 本地 Bot 切换模型停止下发完整 Registry Snapshot

Bot 为活动任务选择 custom model 时，旧链路会先 `applyToProvider()`，再读取并向 Agent 下发完整 Registry Snapshot，最后调用 `setModel(modelRef)`。正式本地 Worker 已经持有进程级 Registry，并从与 Host 相同的 Official、Personal、Account Config 构建 Model；前两步会让旧 `ModelProviderConfig` 再次参与本地执行裁决。

本地 Host 已装配 Model Selection Service 时，Bot 现在直接把 `{ providerId, modelId }` 交给 Task Service。Worker 在下一次 Model 创建时查询自己的最新 Registry。desktop-attached remote 还没有远端自身的 Config/Registry，因此当 task 带有 `workspaceIdentity` 时仍执行 `applyToProvider + updateProviderRegistry`；未装配新 Selection Service 的旧 Entry 也保留原兼容链路。定向测试分别固定了本地“不下发 Snapshot”和远端“继续同步”的行为。

## 87. 设置保存后的 Snapshot 同步只保留远端 target

设置页保存 Provider 后会收集所有打开的 workspace，并调用 `workspace/updateProviderRegistry` 刷新旧 Agent 内存目录。此前 target 列表同时包含本地和远端 tab，因此即使本地 Worker 已经通过文件 watcher 更新进程 Registry，Renderer 仍会把旧完整 Snapshot 再下发一次，并以回包覆盖本地 configOptions。

target resolver 现在只返回能够解析到 `remoteSessionId` 的远端 workspace，并为每个 target 绑定对应 Remote Session Service。本地 tab 直接跳过；本地模型选择由 Host Model Selection View 更新，执行由 Worker Registry 更新。远端断连、同路径不同 identity 以及 session-bound 去重规则保持不变。相应接口删除了已无用途的 `baseZCodeSessionService` 参数，测试固定本地 tab 不进入同步列表。

## 88. Welcome API Key 登录的读取裁决切到新 View

Welcome API Key 表单已经先写 Personal Config、再镜像旧 Provider，但保存前仍调用旧 `getAll()` 判断目标 Provider 是否存在，保存后也从旧模型数组决定默认选择。这会让同一次提交的写入以新 Config 为权威，入口与默认值却继续受旧快照影响。

新 Host 上，表单现在从 Provider Settings View 投影目标 API Provider；完成 Personal 写入和 Registry refresh 后，再从 Model Selection View 取该 Provider 的第一个可选模型，写入 App 最近选择。这样缺失 API Key 导致保存前不可选不影响设置入口，而保存后的默认值只会指向 Registry 当前可选模型。旧 `ModelProviderConfig` 仍由兼容投影构造并写入旧服务，供尚未迁移的账号/设置消费者使用；Provider Settings Service 未装配的旧 Entry 保留原读取路径。

同一切片进一步收紧 API Key 持久化边界：当 Provider Settings Service 已装配时，读取失败、目标 Provider 缺失或类型不为 API 都直接向调用方报告错误，不再静默读取或写入旧服务。只有服务本身未装配的旧 Entry 才使用旧路径。新 Personal Config 写入成功后，旧镜像写入失败仍只记录兼容告警，不反向撤销权威写入。

回归测试还确认了一条现有兼容语义：balance 可能只返回 active plan，暂时没有 balances 模型明细。这种情况仍是确定的 available，Connection Result 不携带 `models`，领域解析沿用 Official/Personal Config 中的成员。把缺少明细解释为无权益会导致现有 Start Plan 恢复、连通性和入口缓存测试全部回归，因此不采用。

## 89. 新 Settings View 退出旧 display-order 读取

Provider 的 Effective 顺序已经由 Official 与 Personal 有序 Overlay 产生，`ProviderSettingsView.providers` 就是设置页和选择面的顺序事实。新 Settings Service 已装配时，`useModelProviders` 不再调用旧 `getDisplayOrder()`，也不再让独立 Preference 介入 Effective Provider 排序。拖动写入同样只调用 Settings Facade 重排 Personal Overlay，不再写旧 `saveDisplayOrder()` 镜像。

老 Entry 没有 Provider Settings Service 时，仍成对使用旧 `getDisplayOrder()/saveDisplayOrder()`，因此保持原兼容行为。新 Host 和老 Entry 的事实源不再交叉；等旧 Entry 支持退出后，可直接删除 Preference Store 与旧服务方法。

## 90. 本地 Bot 启动迁移退出旧 Provider Config 缓存

Bot 状态 v2 迁移只需要判断某个 `providerId/modelId` 是否仍存在，以及模型 ID 能否唯一映射到新 Provider。迁移算法过去因此读取整份 `ModelProviderConfig[]`，让本地 Bot 即使已装配 Model Selection Service，启动时仍会调用旧 `getAll()`。

迁移输入现在收窄为 `{ providerId, modelIds }`。新 Host 从 Model Selection View 构造该索引，老 Entry 才把旧 Provider Config 投影成相同形状。同时，已装配 Selection Service 的 Bot 不再调度旧 Provider Config 缓存预热；`/model`、`/status` 和启动迁移因此使用同一份可选模型事实。workspace `configOptions` 缓存及 remote/老 Entry 兼容路径保持原语义。

## 91. Personal Config watcher 按内容版本去重

Personal Repository 使用原子文件替换保存配置。一次进程内写入在文件系统层可能产生多次 `rename/change` 事件，旧实现会先发布 `updated`，再为每个 watcher 事件重复发布 `file-changed`。这会让同一份配置反复触发 Registry 解析，Account Source 还可能重复执行权益查询。

Repository 现在记录最近一次已知的 content revision。显式写入在释放文件锁前登记新 revision；watcher 收到事件后，在同一文件锁下重新读取并规范化配置，只有 revision 真正变化才发布 `file-changed`。多个原子写事件因此自然收敛，外部编辑产生的新内容仍即时通知。这里没有引入时间窗口或 debounce，通知语义只取决于配置内容是否发生变化。

## 92. Provider Family Domain 迁移改读 Model Selection View

启动期的一次性 `providerFamilyDomain` 迁移需要在没有旧 OAuth active provider 时，判断当前是否只有一个可选的 Z.ai / BigModel Family。旧实现读取 `ModelProviderConfig[]`，再用 API Key、enabled 和 endpoint 重做一遍可用性判断；这会让迁移结果与新 Registry 的选择事实分叉。

迁移现在直接读取 Model Selection View。View 中的 Provider 已由 Registry 完成 Config、Account Access、模型完整性与可选性解析，迁移只负责把 `providerId` 映射到 Family，并在唯一 Family 时写入历史设置。空 View 继续表示启动事实尚未恢复，本轮不标记迁移完成；OAuth active provider 的原有优先级和设置写入时序没有改变。

## 93. Official Config watcher 同样按内容版本发布变化

Official Config 未来由管理服务发布到本地文件，但 Node Source 面对的仍是文件替换事件。旧实现只按文件名转发 watcher 事件：相同内容被重新发布也会刷新 Registry，一次原子替换产生多个事件时还可能重复读取和解析。

Official Source 现在与 Personal Repository 使用同一条外部语义：首次读取记住当前 content revision，后续 watcher 事件串行读取最新完整文档，只在 revision 改变时发布一次 `file-changed`。相同 Official 文档的重复落盘不产生失效通知；真正的新版本仍由 watcher 自动进入 Registry。这项收敛不改变 Official 文件的版本迁移、覆盖顺序或错误处理边界。

## 94. 登出时的 Family 保留判断改读 Model Selection View

App 全局登出与设置页 Plan 解绑都需要在退出 OAuth 前决定：当前 Family 是否还有 API Key 模式可继续使用。旧实现读取完整 `ModelProviderConfig[]`，只检查内置 API Provider 的 Key 字符串；Account Provider 与 API Provider 的可选事实因而再次由旧服务解释。

两个操作入口现在都在用户确认后读取最新 Model Selection View。只有当前 Family 对应的内置 API Provider 以 `kind: api` 出现在 View 中，才保留 `providerFamilyDomain`；只有 Coding/Start/Team 等 Account Provider 时会清理 Domain。Selection View 的读取位于事件处理函数内，不新增组件订阅或渲染依赖。OAuth logout、WebView 清理、设置写入和 App relaunch 时序保持不变。

## 95. Family Selection 删除未参与裁决的旧 Provider Config 读取

OAuth 登录后和启动恢复时，Family Selection 会按个人 Coding Plan、Team Plan、Start Plan 与 OAuth fallback 的既定优先级选择连接。两个 resolver 的输入此前包含完整 `ModelProviderConfig[]`，调用入口也因此各执行一次 `getAllCached()`；实际算法从未读取这项参数，Provider Config 既不影响优先级，也不参与 selectedKey 的生成。

本轮删除了未使用的参数和两次旧 Config IO。登录后的选择只依赖当前权益与 Team Products；启动恢复还读取当前 Settings，用于保护仍然有效或暂时无法确认失效的 Team selectedKey。个人、团队、Start Plan 的优先级、Coding Plan Key 刷新和设置写入时序保持不变。边界测试将旧读取设置为失败，并确认启动恢复仍能完成，避免以后重新引入这条旁路依赖。

## 96. Settings Sync 的 Provider 占位项退出旧 Snapshot 刷新

Settings Sync 的公共 Category 仍包含 `providers`，Onboarding 也会构造这项占位展示；当前 Service 没有 Provider Discovery 或 Provider 数据载荷，收到该 Category 时明确返回 `skipped`。UI 过去在这个结果之后调用旧 `ModelProviderService.getAll()` 并覆盖全局 Provider Snapshot，实际没有导入任何配置，却额外触发了旧 Provider 远端同步与事实发布。

本轮删除了 `useSettingsSync` 对旧 ModelProviderService 和 Snapshot Store 的依赖，并用两层测试固定现状：Service 的 Provider Category 仍明确返回 `skipped`；UI Hook 不得因为占位项触碰旧 Provider 事实源。未来实现真正的跨 Agent Provider 导入时，需要为选择数据定义明确的 Provider Config 载荷，写入 Personal Config 后由 Registry 正常发布，而不是恢复旧 Snapshot 刷新。

## 97. 新 Host 的启动 Provider 门禁改用 Model Selection View

Root 已经在进程启动时连接 Model Selection Service，但 Provider 可用性门禁仍等待旧 Model Provider Snapshot 水合，并再次根据 API Key、endpoint、enabled 与模型数组判断“是否可用”。这使 Registry 与旧 Snapshot 可以给出不同结论，也让新 Registry 已就绪时仍可能被旧远端同步阻塞启动。

启动门禁现在按 Entry 能力选择唯一来源：装配 Model Selection Service 的新 Host 只读取 Model Selection View；未装配该服务的旧 Entry 继续使用 Legacy Snapshot。Registry View 本身只包含当前可选的 Provider/Model，因此门禁只判断是否至少存在一个模型。Registry 已确认空 View 时不会回退旧 Provider；Registry 尚未水合时也不会借已经水合的旧 Snapshot 提前放行。日志增加 `source: registry | legacy`，便于确认实际边界。

如果新 Host 的 Model Selection View 加载失败，Selection Snapshot 保持未水合，启动门禁不会转读旧 Snapshot。此时应用继续停留在 Provider 启动等待态并记录 error；后续可以补充面向用户的 Registry 加载失败界面，但不能以旧事实源作为恢复路径。

同一切片收紧 API Key 登录后的刷新行为。新 Host 保存 API Key 时，Provider Settings Facade 会写 Personal Config、刷新 Registry，并通过订阅发布新的 Selection View；表单不再额外调用旧 `getAll()`。只有没有 Provider Settings Service 的旧 Entry 仍主动刷新 Legacy Snapshot。旧 Provider 镜像写入暂时保留给尚未迁移的兼容消费者，但不再参与新 Host 的启动裁决。

## 98. 删除旧 Provider Store 到 Personal Config 的稳态反向同步

迁移早期为了尽快切换写入口，旧 `ModelProviderService.save/delete()` 可以通过 `onUserProviderConfigChanged` 把整份旧 Provider 列表重新导入 Personal Config。新 Settings 入口已经稳定采用相反顺序：先通过 Provider Settings Facade 写 Personal Config，再尽力更新旧 Store 镜像。继续保留反向回调会让兼容镜像重新成为新事实源的输入，并且一次局部修改会触发整表覆盖。

本轮删除了 `onUserProviderConfigChanged`、`syncPersonalConfig` 开关和 `ProviderRuntime.syncLegacyPersonalProviders()`。旧 `ModelProviderService` 的保存与删除现在只维护旧 Store；新 Host 的 Personal Config 只由 Provider Settings/Config Service 写入。未装配新 Settings Service 的旧 Entry 仍保持原有旧 Store 行为，但不会影响新 Registry。

首次迁移继续存在于 `NodePersonalProviderConfigRepository`：只有 Personal Config 文件不存在时才调用注入的 `importLegacy`，写入版本化文档后，后续进程重启直接读取该文件。新增重启测试明确验证已有 Personal Config 时不会再次读取旧 Provider Store。由此形成单向时序：

```text
首次启动且 Personal Config 不存在
旧 Provider Store -> importLegacy -> Personal Config

正常运行
Settings -> Personal Config -> Registry
        `-> 旧 Provider Store（兼容镜像，失败不回滚新事实）
```

## 99. Account Provider 的模型菜单不再重复裁决连接

Account Source 已根据账号、权益和 Family 设置选出当前可执行连接，并把固定的
`accessId` 与模型集合交给 Registry。模型菜单过去仍通过旧 Provider Family 数据重新
选择 Start、Individual 或 Team，因而可能与 Registry 得到不同结果。

新 Host 现在直接把 Registry Account Provider 投影成模型分组。同一 Provider ID 的旧
投影被排除，`accessId` 只用于展示 Start、Individual 或 Team 徽标，不再参与连接选择。
旧 Family Builder 仅服务尚未进入 Registry 的旧 Entry 兼容路径。

```text
Account settings + entitlement
              |
              v
Account Config -> Registry Account Provider -> Renderer model group
                                                `-> accessId 只生成徽标
```

## 100. Settings View 直接发布 Provider 的可选择结论

设置页迁移投影需要把 Account Provider 映射回旧 `ModelProviderConfig`，但 `enabled` 只表示
配置开关，不能回答 Provider 是否已经通过完整性校验并进入 Registry。本轮在
`ProviderSettingsView` 增加 `selectable`，由同一次 Resolver 结果中的 Registry 成员关系
直接产生，避免 Renderer 重复实现可用性判断。

Account Provider 的名称、Endpoint、Headers、模型 Properties 和 Option Specs 现在都由
Settings View 投影。旧对象暂时只提供 Usage/Plan 尚在读取的运行 `apiKey`，以及 Provider
不可选择时的细分禁用原因；旧静态字段和旧 enabled 状态不再覆盖 Registry 结论。没有旧
对象的 Official Account Provider 也会正常出现在设置投影中。

## 101. 模型思考档位改读 Registry Option Specs

Composer、Automation、Subagent 和 Repo Wiki 过去从旧 `ModelProviderConfig.reasoning`
读取思考档位；当 metadata 缺失时还会按 GLM-5.2 模型名补一套固定档位。Official
Config 已经通过 `ModelConfig.optionSpecs.reasoningLevel` 表达同一事实，继续读取旧字段会让
模型选择与实际 Model 使用不同的档位定义。

Renderer 现在共用 `resolveModelThoughtOption()`：`ModelSelectionView` 存在时，只按
`providerId/modelId` 读取 Registry 中的 Option Specs；模型不在 View 中或没有
`reasoningLevel` 时返回无思考档位，不再从旧 metadata 或模型名补值。只有没有装配新
Selection View 的兼容 Entry 才沿用旧解析器。Workspace 已经返回运行目录时，Subagent
和 Repo Wiki 仍优先使用该 Workspace 的目录投影；Registry 负责其无目录回落和草稿态
静态模型事实。

本切片只收敛 UI 对模型静态 Option Specs 的读取，不修改 Adapter 如何把 reasoning level
转换成 Provider 请求参数。闲时任务携带 execution-scoped 临时 Provider，当前不进入进程级
Registry，因此仍使用自己的临时模型配置解析；它将在 execution-scoped Provider 阶段统一。

## 102. 模型菜单不再按 Provider 缺口拼接旧快照

模型菜单聚合器过去先投影 `ModelSelectionView`，再把旧 `ModelProviderConfig[]` 中没有同名
Registry Provider 的项目追加到末尾。这种按 Provider ID 去重的兼容方式会绕过 Registry
裁决：配置不完整、显式禁用或账号不可用的 Provider 已经被 Registry 排除，却会因为“新 View
中没有它”而重新出现在模型菜单中。

聚合边界现在改为 Entry 级切换。调用方传入 `ModelSelectionView` 后，菜单只投影该 View；
`providers: []` 是 Registry 已确认无候选，不触发旧列表回落。只有尚未取得 View 的兼容 Entry
继续走完整旧菜单构建器。该变更统一作用于 Composer、Automation、Subagent 与 Repo Wiki，
没有改变旧 Entry 的 Family、Team Plan 或展示顺序算法。

## 103. Subagent 设置页停止订阅旧 Provider 快照

Subagent 设置页已经取得进程级 `ModelSelectionView`，但仍无条件调用 `useModelProviders()`，
再把旧 Provider、旧显示顺序和旧 Family Mode 交给混合菜单构建器。第 102 节收紧聚合边界后，
这些数据在 View 已水合时虽然不再影响结果，旧 Hook 仍会触发 `getAllCached()` 和后台
`getAll()`，使打开设置页继续读取并刷新第二事实源。

该页面现在直接调用 `buildRegistryModelSelectGroups()`。View 尚未发布时模型控件保持 loading，
不会用旧列表提前显示候选；View 发布后，模型候选、Provider 分组和无 Workspace 时的
reasoning Option Specs 都来自同一 revision。Workspace 作用域下的运行目录仍负责该
Workspace 的 reasoning 投影，Subagent 保存与启用协议没有变化。组件测试显式断言渲染模型
选择器不会调用旧 `useModelProviders()`。

## 104. Repo Wiki 分离展示事实与 Workspace 执行水合

Repo Wiki 已经使用 `ModelSelectionView` 构建模型菜单并读取 Option Specs，但组件仍在挂载时
调用旧 `ModelProviderService.getAllCached()`，订阅旧 Registry change event。这份旧列表一方面
作为模型菜单与 reasoning 的回退，另一方面用 Provider `updatedAt` 触发 workspace 模型目录
重新水合，使展示事实仍然依赖第二事实源。

组件现在只用 `ModelSelectionView` 提供模型列表、Properties 和 Option Specs，并以 View 的
`revision` 作为目录水合输入版本。View 尚未发布时不从旧列表提前恢复候选；空 View 同样表达
Registry 已确认没有可选择模型。旧 `ModelProviderService` 仍以窄边界保留：
`prepareRepoWikiThoughtCatalog()` 在 desktop-attached remote 等尚未迁移的 workspace runtime 中，
还需要 `getProviderRegistrySnapshot()` 通过旧协议注入执行快照。这个兼容依赖不再参与 Renderer
展示和模型可选性裁决，后续随 Host -> Worker Snapshot 链路一起删除。

## 105. Composer 的 Provider 静态判断以 Registry 为准

Composer 仍需旧 `useModelProviders()` 为 Coding Plan/Start Plan 的 Usage、Entitlement 和购买漏斗
提供动态状态；这不意味着旧 Provider 列表可以继续参与模型静态事实裁决。原实现把旧 Provider
与 `ModelSelectionView` 用 `OR` 合并，并优先读取旧 label。Registry 已过滤的 Provider 因而仍可能
被识别为可恢复的自定义 Provider，配置保存失败后走旧恢复链路。

现在只要 `ModelSelectionView` 已发布，Composer 便只从该 revision 判断 Provider 是否存在、读取
Provider label，并以 `config.kind === "api"` 判断自定义恢复资格。空 Registry View 会拒绝旧列表中
残留 Provider 的恢复；尚未装配 View 的兼容 Entry 继续使用旧判断。旧 Hook 暂时保留在组件中，
但其职责收窄为尚未迁移的 Plan/Usage 运行状态，不再成为模型身份与可选择性的并列事实源。

## 106. Automation 菜单与 Provider label 直接消费 Registry

Automation 已经把 `ModelSelectionView` 传入公共菜单构建器，但在进入构建器前仍先用旧 Provider
列表和 Entitlement Snapshot 过滤一遍候选；编辑页的触发器也优先显示旧 Provider name。公共构建器
最终会忽略这些中间结果，因此输出通常正确，但 Renderer 仍执行了一套没有裁决权的旧判断。

`buildAutomationModelSelectGroups()` 现在在 View 已发布时直接调用 Registry 投影，不读取旧 Provider，
也不调用旧 Entitlement 过滤回调。编辑页同样优先读取 Registry `config.label`；只有未装配 View 的
兼容 Entry 才读取旧 name。旧 `useModelProviders()` 仍为闲时任务的 Plan/Usage、购买漏斗和当前埋点
提供尚未迁移的动态数据，这些用途没有被伪装成模型静态配置。

## 107. Workflow 子 Runtime 继承进程 Registry ModelFactory

生产调用审计发现，主 `AgentRuntime` 已装配 `ApiProviderModelRuntime.modelFactory`，但 Expert
Workflow 与 Script Workflow 创建子 Runtime 时只复制了旧 `modelAdapter` 和 Runtime Config。
因此同一 App 内的普通 Turn 使用新 Registry，而 Workflow 子执行仍可能读取旧 Catalog、旧
Provider Options 和旧连接配置。

两类子 Runtime 依赖现在都显式接收主 App 创建的同一个 `modelFactory`。它是进程级执行入口，
每次调用仍按当前 Registry 创建独立 Model；这里共享的是工厂和 Adapter 基础设施，不共享某个
Agent Loop 的 Model 对象。旧 Entry 没有 `modelFactory` 时继续走原兼容 Adapter，行为保持不变。

测试分别从 Expert Workflow 和 Script Workflow 发起真实子 Agent 调用，并断言请求经过 Registry
Adapter 的 `createModel()`。修复前两个测试均观察到零次调用，证明这不是静态类型层面的假覆盖。
两组 Workflow 回归和仓库根 `typecheck` 通过；Bootstrap 包单独执行 `tsc --noEmit` 仍命中
`origin/staging` 已存在的 `SessionEntryInfo.touchSession` 类型不一致，本切片没有改动该契约。

## 108. Core 运行元数据以 Registry Model Config 为准

新 Registry ModelFactory 已经负责最终模型调用，但 `create-app` 仍给 Core 注入了两项旧解析器：
`resolveRuntimeModelLimits` 从 Catalog 读取 context/output，`resolveModelProviderOptions` 从 Runtime
Overlay 读取 reasoning 参数。Subagent 等子运行边界会先调用它们，因此一个模型仍可能同时被新旧
两套事实解释。

`resolveRegistryModelRuntimeMetadata()` 现在从同一份 Provider/Model Config 投影 context window、
默认 max output、媒体能力和按 API Format 归一化的 reasoning Provider Options。`create-app` 的
两项 Core 兼容解析器优先使用该投影。只有 Registry 完全没有对应 Provider 时才回到旧 Overlay；
Registry 已有 Provider 但缺少 Model 时直接返回 ModelNotFound，继续遵守 Provider 级迁移边界。

该投影同时校验 reasoning 档位，并复用 ModelFactory 的完整字段要求，避免为 Core 再造一套宽松
Schema。新增测试覆盖 OpenAI-compatible 参数映射、Provider 级回退边界和非法档位；Registry
Runtime、App Workflow 与 Core Subagent 相关回归通过。

## 109. 主动模型选择收紧为 Provider 级事实边界

模型菜单已经按 Provider 级别隔离 Registry 与旧 Runtime Overlay，但直接调用 `setModel()`
时，旧解析器仍会在 Registry 已拥有 Provider、却没有目标 Model 的情况下回到 Runtime
Overlay。协议调用者因此可以选择一个菜单中不存在的旧模型，让同一 Provider 的模型集合由
新旧两个事实源拼接。

主动选择现在使用严格的 Registry-owned 解析：只有整个 Provider 不在 Registry 时才返回
`undefined`，允许进入尚未迁移 Provider 的兼容链路；Provider 已存在而 Model 缺失时直接返回
`ModelNotFound`。新 Session 的显式初始模型和 Environment 默认选择采用同一边界。

Session 恢复保留另一种语义。持久化 Selection 表达历史用户意图，即使 Provider 仍存在、
其中的 Model 已被配置删除，也不能在恢复时静默换成默认模型。因此恢复入口继续使用宽容查找，
保留原 Selection；后续真正创建 Model 时由 Registry ModelFactory 明确报告不可用。集成测试同时
覆盖了主动选择拒绝旧模型与恢复已删除模型身份两条路径。

## 110. 已删除 Registry Model 的状态读取不回落旧 Catalog

Session 恢复允许保留已经从 Registry 删除的历史 Model，但 `getThoughtLevel()` 与
`listThoughtLevels()` 过去把“没有解析到 Registry Model”直接等同于“Provider 尚未迁移”，
转而从旧 Catalog 读取档位。只要旧 Catalog 仍按模型名识别该模型，例如 `glm-5.2`，恢复后的
Session 就会重新出现 Registry 已不再发布的默认 `max` 和旧档位列表。

当前模型查询现在显式区分两种状态：整个 Provider 不在 Registry 时继续服务旧 Provider
兼容链；Provider 已由 Registry 接管、但历史 Model 已删除时，只保留持久化 `ModelRef.variant`，
默认档位和可选档位均不再读取旧 Catalog。用户尝试为这个已删除 Model 设置新档位时仍由严格
Registry-owned 解析返回 `ModelNotFound`。回归测试使用旧 Catalog 能识别的 GLM 模型固定了这条
边界，避免普通占位模型让测试误判为已覆盖。

## 111. Registry 补齐 ModelSelection Option 校验

`ProviderRegistry.validateSelection()` 原先只确认 Provider 和 Model 是否存在。包含非法
`reasoningLevel` 或越界 `maxOutputTokens` 的 Selection 仍会返回成功，直到 Model 创建或请求
阶段才失败；Configured Default 则维护了另一份不完全相同的判断。这让同一 Selection 在
Facade、启动初始化和执行边界可能得到不同结论。

Registry 现在同时验证两个已进入公共契约的 Option：Reasoning 档位必须出现在模型的 Enum
Spec 中；输出上限必须是正整数，且不能超过 Limit Spec 的 `max`。模型没有声明对应 Spec 时，
显式提交该 Option 同样视为不支持。返回值增加稳定的错误码和相关模型、提交值、允许范围，
调用方可以展示问题，但 Registry 不会替调用方改值或静默截断。

Configured Default 的可选性判断复用同一 Option 校验函数，不再单独实现范围判断。领域测试覆盖
合法组合、非法 Reasoning、缺失 Reasoning Spec、输出越界，以及直接构造的非正输出值。

Bootstrap 的 `ProviderRegistryModelSource` 同时收窄为必须提供 `validateSelection()`。新 Session
初始化和主动 `setModel` 在创建 Registry Selection 前读取这份校验结果：整个 Provider 未迁入时
仍可进入旧 Provider 兼容链；Model 缺失返回 `ModelNotFound`；Option 不合法返回
`InvalidModelRequest`。历史 Session 恢复继续使用宽容查询，不会因为今天的 Option Spec 已变化而
改写过去持久化的用户意图。

## 112. Account 刷新退出旧 Registry 全量广播

本地 Host 的 `AccountProviderService` 已经从 Config、账号设置、Credential Port 与套餐接口重新
计算第三层 Account Config，但刷新时机仍订阅旧 `onDidChangeProviderRegistry`。该广播同时包含
普通 Provider 保存/删除、runtime header 和套餐刷新，导致无关操作也会重新请求账号权益，并让
新 Account Source 在生命周期上继续依赖旧 Registry。

本轮增加两个只在 Host 进程内使用的窄通知。`ObservableSettingService.onDidUpdate` 在底层设置
服务成功落盘后发布本次字段；组合根只关注账号域、Family 模式、Personal/Team 连接选择和
ZCode endpoint。
`ModelProviderServiceRuntime.onDidInvalidateAccountProviderFacts` 只发布登录预置、套餐入口、Coding
Plan Key 与可用性变化。二者统一调用 `AccountProviderService.refresh()`，刷新错误仍由 Service 的
错误事件记录并保留 last-known-good。

生产组合根不再订阅旧 Registry change event。普通 Provider 编辑与 runtime header 继续发布旧
Registry 兼容事件，但不会触发 Account 刷新。新增测试固定了设置通知必须发生在成功写入之后、
普通 Provider 操作不得发布 Account Facts，以及两路窄事件的过滤、刷新和释放行为。直接手工修改
旧 `setting.json` 仍没有 watcher；该文件当前是账号连接状态的迁移输入，正式账号状态模型将继续
收拢其持久化与跨进程更新边界。

## 113. 闲时任务套餐判断改读 Account Overlay

闲时任务首页原来从旧 `ModelProviderConfig[]` 判断用户是否拥有 Coding Plan。它需要同时理解
`enabled`、`systemDisabledReason`、个人 Coding Plan Provider ID 和动态 Team Plan Provider ID，
本质上是在 Renderer 再实现一次 Account Access 解析。旧 Provider Store 的残留条目也可能让已经
失效的套餐继续被当作可用。

现在首页与购买漏斗共同读取 `ProviderSettingsView`。Account Provider 只有在第三层 Account
Overlay 提供非空 `accessId` 时才代表当前账号确实拥有对应连接；Coding Plan Provider 优先于
Start Plan。Personal/Team 的差异已经编码在 `accessId` 中，不再通过另一组动态 Provider ID
判断。用户把 Provider 设置为 `enabled: false` 时，`accessId` 仍存在，因此仍保留“关闭入口不等于
退订”的既有产品语义。

Settings View 尚未发布时状态为 unknown。首页沿用原来的加载期行为，不会在初始化过程中把 unknown
误判为无套餐并弹出升级提示；View 发布且没有 Coding Plan access 时才进行拦截。新增测试覆盖
Start Plan、个人/Team Coding Plan 的统一表示、用户禁用、无 access 与未水合状态。旧的
`hasAnyOffPeakCodingPlanProvider()` 以及 `systemDisabledReason` 推断随之删除。

## 114. 闲时任务派发退出旧完整 Registry Snapshot

闲时任务派发过去调用 `getProviderRegistrySnapshot()`，再从旧 Snapshot 中寻找所选 Coding Plan
Provider 的 API Key 与 baseURL。这样静态账号连接、动态请求凭据和旧完整 Provider 投影被绑在
同一个输入里；即使 Account Overlay 已成为账号 Provider 的事实来源，派发仍会被旧 Snapshot 的
缓存和成员判断控制。

现在派发分成两项输入。Provider Settings View / Registry Resolution 提供 Account Provider 当前
固定的 `accessId` 和 baseURL；`AccountRequestAuthResolver` 在真正派发时根据同一个 `accessId`
取得当前 API Key。解析结果必须与 Settings 中的 selected connection key 完全一致，Team Plan
继续由统一 Request Auth Service 解析 organization/project 对应的凭据。用户把 Provider 设为
disabled 时，Account Overlay 仍保留 accessId，所以不会把“关闭模型入口”误判为“套餐连接消失”。

动态凭据缺失现在由 `AccountRequestCredentialUnavailableError` 明确表达，并映射为闲时任务已有的
`connection_unavailable`；不会因为旧 Snapshot 里残留一份 key 而继续派发。登录 JWT 仍由 Credential
Service 读取，账号 Family 与 selection 的前后指纹检查保持不变，防止设置切换过程中拼接两代凭据。

Local Host 中的 Account Request Auth 实现目前由具体 Model Provider runtime 持有。实现没有把它
注册为 RPC Service，因为该能力会返回真实 API Key，不应为了 Host 内部复用而开放给 Renderer 或
Remote client。Host 在本地 `createLocalServices` 组合根中取用这一运行能力；后续动态鉴权独立成
正式内部 Service 时，可以替换这个装配点，不影响闲时任务的依赖契约。

`reason: "off-peak"` 被加入 Request Auth 的用途枚举，便于后续审计和按用途刷新。当前 Resolver
仍要求 `modelId`，闲时任务暂用 `OFF_PEAK_PROVIDER_ID` 作为操作标识；Resolver 不依据该值选择
凭据。是否把动态鉴权输入进一步改成 purpose-oriented contract，留给鉴权 Service 独立设计，
本切片不扩张范围。

测试使用 Account Provider 固定字段与动态 Auth Resolver 两个独立 fixture，不再构造旧
`ZCodeProviderRegistrySnapshot`。覆盖个人/Team 连接、跨账号拒绝、选择切换、JWT 缺失和动态 API
Key 缺失；模块与测试均不再引用旧 Snapshot 读取接口。

## 115. Subagent 设置页删除 Legacy Provider 假兼容

Subagent 设置页此前已经停止订阅旧 Provider 快照，但组件树仍逐层传递一个永远为空的
`ModelProviderConfig[]`。无 Workspace 时的 reasoning 解析也把这个空数组交给兼容解析器；类型和
命名因此仍暗示旧 Provider metadata 是一条有效来源，后续修改很容易重新把它接回来。

本轮删除了 `SubagentsSection` 对 `ModelProviderConfig` 的导入，以及表单、内置 Subagent 控件和
列表行之间的 `modelProviders` 参数。加载状态改名为 `modelSelectionLoading`，明确它表示进程级
Model Selection View 是否已经发布。无 Workspace 时，reasoning Option Specs 直接读取该 View；
Workspace 模式继续以 runtime catalog 为执行侧权威，既有优先级不变。

兼容解析器的旧 Provider 参数改为可选，只供尚未迁移的 Entry 显式传入。Subagent 调用点不再传空
数组，也不会在 View 缺失时恢复旧 Provider 事实。测试改为使用 Registry Selection View 验证无
Workspace 的 reasoning 档位，并覆盖 View 刷新期间继续使用 last-known View 的行为。

## 116. Repo Wiki 生成设置退出 Legacy Provider 投影

Repo Wiki 生产组件与 Subagent 存在相同的过渡残留：模型菜单、workspace catalog 水合和 reasoning
解析仍要求传入 `ModelProviderConfig[]`，实际调用点却始终传递空数组。菜单在 Registry View 存在时
已经由新事实源短路，旧数组只留下了类型噪声；Registry View 尚未发布时，兼容解析器还会根据
`GLM-5.2` 名称补一份硬编码 reasoning 档位。

本轮让 Repo Wiki 的模型分组直接使用 `buildRegistryModelSelectGroups()`。Provider 可用性、账号访问
和模型成员均由 Model Selection View 给出；View 为空时菜单保持为空，不再重新执行旧 Family Mode
或 Provider entitlement 判断。Workspace catalog 仍负责运行目录水合和当前 workspace 的 reasoning
投影，这条执行侧链路没有改变。

Repo Wiki 的 reasoning helper 与水合 helper 删除 Legacy Provider 参数。Registry View 可用时从
Model Config Option Specs 读取档位；View 未发布时只使用已经取得的 workspace catalog，不再按模型
名称推断静态能力。Subagent 同步补上了相同的缺失 View 防护，避免“不传旧数组”之后仍隐式落回
GLM 名称规则。

测试 fixture 改为直接构造 `ModelSelectionView`，覆盖 Registry 菜单投影、reasoning 默认值、workspace
catalog 优先级、普通模型以及 Registry 未发布时不得按 GLM 名称猜能力。针对性测试共 57 条通过，
全仓 typecheck 通过；lint 保持既有 35 条 warning、没有新增错误。

## 117. Automation 编辑表单退出旧 Provider 静态事实

Automation 列表层仍因运行遥测和历史兼容持有旧 Provider 数据，但编辑表单实际已经取得完整的
Model Selection View 与 Registry 模型分组。它仍把旧 `ModelProviderConfig[]` 作为属性传入，只用于
Provider label 和 reasoning fallback，形成了同一表单内两份静态事实。

本轮从 `AutomationEditView` 的公共属性中删除 `modelProviders`。模型触发器的 Provider label 只从
Model Selection View 取得；reasoning Option Specs 同样只从 View 读取。View 未发布时，现有菜单
项仍可保留模型文本，但不会用旧 Provider metadata 或模型名称推断 reasoning 能力。Automation 的
Workspace 预览、保存协议、调度状态和列表层遥测没有改变。

`resolveAutomationModelTriggerLabel()` 同步删除旧 Provider label 参数，测试改为直接构造 Registry
View。编辑表单与模型投影的 26 条针对性测试通过，全仓 typecheck 通过；lint 保持既有 35 条 warning。

## 118. Composer 草稿 reasoning 退出旧 Provider metadata

Composer 草稿态通过 `resolveDraftModelThoughtOption()` 为尚未取得 runtime 投影的目标模型准备
reasoning 默认值。该 helper 同时接受旧 Provider 数组和 Model Selection View，因此 View 未发布时
会读旧模型 metadata，并对包含 `GLM-5.2` 的模型名应用硬编码档位。草稿默认值由此仍可能与 Registry
当前 Model Config 不一致。

本轮将 helper 收窄为 `providerId + modelId + ModelSelectionView`。View 未发布或目标模型没有
Reasoning Option Spec 时返回空，Composer 等待 runtime catalog 或 Registry View 给出事实；View
存在时直接读取对应 Model Config 的枚举与默认值。草稿文本、模型选择、显式 thought、Session 预热
和 runtime 投影优先级均保持不变。

测试删除旧 `ModelProviderConfig` fixture，直接覆盖 Registry 中不同模型的 Option Specs、缺失模型、
同名 GLM 无 Spec、默认档位，以及 Composer 恢复链路。两组针对性测试共 41 条通过，全仓 typecheck
通过；lint 保持既有 35 条 warning。

## 119. 删除 UI reasoning 的旧 Provider 解析器

Subagent、Repo Wiki、Automation 和 Composer 草稿四个生产调用点都已改为只在 Model Selection View
存在时读取 reasoning Option Specs。`modelThoughtOption.ts` 中旧 `ModelProviderConfig.reasoning` 解析、
`modelIdByKind` 匹配和 GLM-5.2 名称硬编码因此已经没有生产消费者。

本轮删除整条旧解析器，并把 `resolveModelThoughtOption()` 的输入收窄为非空
`ModelSelectionView`。调用方必须先处理 View 尚未发布的状态，统一 helper 只承担精确的
`providerId/modelId -> reasoning Option Spec` 投影。这样旧 Provider metadata 不能再被新的 UI 入口
偶然接回，也不会由一个共享 helper 重新建立第二事实来源。

专项测试删除旧 Provider fixture与“无 Registry 时回退”的预期，改为覆盖 Registry 权威、普通模型、
缺失模型和 stale 名称均不补事实。五组相关测试共 101 条通过，全仓 typecheck 通过；lint 保持既有
35 条 warning。

## 120. 设置页不再追加旧快照独有的 Provider

设置页已经通过 `ProviderSettingsView` 取得 Official、Personal 和 Account Access 合成后的 Provider，
但迁移投影仍会把 View 中不存在的旧 `ModelProviderConfig` 追加到结果末尾。旧 Store 的残留条目
因此仍能重新进入设置页、Usage 和部分 Plan 展示，形成新事实源之外的 Provider。

本轮删除了这条追加逻辑。Settings View 发布后，Provider 集合和顺序完全由 View 决定；旧快照仅按
相同 `providerId` 为 Account Provider 补充尚未迁移的 API Key、不可用原因和历史时间戳，不能再
贡献 Provider 或 Model 成员。没有新 Settings Service 的兼容 Entry 仍直接使用旧快照，本次没有
改变它们的启动行为。

新增测试固定空 Settings View 即使收到旧 Provider 也必须投影为空，并回归 API、Account、排序与
设置页 Hook 共 29 条相关测试。远端 Server 尚未完整装配 Provider Runtime，Root 的无 Service 兼容
守卫仍保留；该边界属于 M2.8，不在本切片中通过 UI fallback 隐藏。

## 121. Coding Plan 权益查询改用 Account Access 身份

`useCodingPlanEntitlements` 过去从旧 `ModelProviderConfig` 读取 API Key，用非空 Key 判断是否发起
权益查询，并把 Key 的哈希作为缓存与自动刷新身份。这让 Renderer 把动态请求凭据当作套餐连接事实，
也迫使 Composer、Automation、Provider 设置和购买弹窗继续传递完整旧 Provider 对象。

本轮把 Hook 输入改为 `ProviderSettingsView`。四个调用点统一从 Account Overlay 读取非敏感
`accessId`：存在 accessId 才发起对应 Provider 的权益查询，连接切换时 accessId 变化会形成新的
缓存与刷新身份；真正的 API Key、JWT 和 Team Project Key 仍由 Usage Service 在请求时解析。
Provider 静态存在但 Account Access 尚未建立时不会触发查询，也不再借旧 Key 补连接状态。

迁移过程中发现生产 Account Source 会在 `enabled: false` 时跳过连接解析，这与已经确认的“关闭模型
入口不等于断开套餐连接”冲突。领域 Resolver 与 Services Connection Resolver 现在仍为禁用的 Account
Provider 解析并保存 accessId；最终 Registry 继续根据 Effective Config 的 `enabled: false` 排除模型，
Settings 与 Usage 则可以保留账号连接。新增测试同时固定 Account Overlay、Registry selectable 和
entitlement 查询三层语义。

API Key 在相同 accessId 下刷新不会再改变 Renderer 指纹。认证、购买和设置操作已经显式调用权益刷新；
后续新增凭据刷新入口也必须通过对应状态事件或显式 refresh 通知消费者，不能重新把 secret 投影回 UI
来制造变更检测。本切片没有改变 Usage Service 的请求协议。

## 122. Session 提交的 Plan Identity 改用 Account Access

`usePlanIdentitySnapshot` 会在用户提交消息时捕获当前套餐身份，交给消息遥测和 Session 历史。它此前
单独订阅旧 `ModelProviderConfig` 快照，并再次使用 API Key 指纹决定 Coding Plan / Start Plan 的
Entitlement 查询与缓存身份。设置页权益已经切到 Account Overlay 后，这里仍会形成第二条旧事实链路，
并让相同套餐连接中的凭据刷新被误认为身份切换。

本轮增加共享的 `accountProviderAccess` 投影。它只接受 `ProviderSettingsView`，按 providerId 读取
Account Overlay 中的非敏感 `accessId`；Provider 被用户禁用时仍保留连接身份。设置页权益与 Session
提交快照共用这一个投影，分别用 `providerId + accessId` 构造查询刷新和缓存身份。动态 API Key、JWT
与 Team Project Key 继续由 Usage Service 在真实请求时解析，不进入 Renderer 的判断输入。

`usePlanIdentitySnapshot` 不再订阅旧 Provider 快照，也不再调用基于 API Key 的 fingerprint/cache helper。
Provider Family 仍决定应查询的 Coding Plan 和 Start Plan providerId，Start Plan fallback 与最终
`resolvePlanIdentitySnapshot()` 语义保持不变。新增测试固定 API Provider 不会被误认成 Account Access，
以及禁用模型入口不会删除套餐连接身份；现有权益与消息遥测回归共 43 条通过。

## 123. 设置页 Usage 退出旧 Provider 凭据事实

设置页 Usage 过去调用 `useModelProviders()`，用旧 Provider 的 `enabled`、不可用原因和 API Key 判断
Z.ai / BigModel Coding Plan 是否可以查询，并用 API Key 指纹构造 Entitlement Cache。随后又把完整旧
Provider 数组传给 Usage 面板，只为再次找到相同 Provider 并生成缓存 Key。Provider 静态配置、套餐
连接和动态请求凭据因此在一个 UI 链路中混合。

本轮让 SettingsPage 直接消费 `ProviderSettingsView`。只有 Account Overlay 提供非空 `accessId` 时才
查询对应 Entitlement 和 Team Products；缓存身份统一为 `providerId + accessId`。个人套餐 source 保存
原始 accessId、providerId 和展示 label，Team source 继续保存 organization/project 上下文。Usage 面板
只接收当前选中的 source，并据此选择个人或团队查询，不再接收 `ModelProviderConfig[]`，也不读取 API
Key、旧 enabled 状态或旧不可用原因。

SettingsPage 因而完全删除了为 Usage 建立的 `useModelProviders()` 订阅。Account Provider 被用户禁用时
accessId 仍在，Usage 入口继续可用；Account Access 消失时，即使旧 Entitlement State 尚未清理，也不会
继续生成个人套餐 source。新增测试固定个人 source 只携带非敏感 accessId，并回归 Usage source、Tab、
Entitlement 与 SettingsPage 挂载共 43 条测试；全仓 typecheck 通过，lint 保持 35 条既有 warning。

## 124. 侧栏 Usage 与公共余额状态退出 ModelProviderConfig

侧栏头像菜单仍通过 `useModelProviders()` 读取旧 Provider，用 `enabled`、不可用原因和 API Key 生成
“可查询 Coding Plan”集合，再把完整对象交给 Entitlement Cache、余额状态解析器和升级目标选择器。
这条常驻链路与设置页 Usage 使用相同的旧事实，却有独立的过滤和缓存逻辑。

本轮让侧栏订阅 `ProviderSettingsView`。Z.ai / BigModel 只有在 Account Overlay 提供非空 accessId 时
进入可用来源；用户禁用模型入口不会删除连接。个人 Entitlement 与 Enterprise Products 的门禁和
缓存身份都使用 `providerId + accessId`，动态凭据继续由 Usage Service 请求期解析。Account Access
缺失时，侧栏不会再根据静态 Provider 或残留 API Key 猜测连接。

公共 `CodingPlanUsageRemainingState` 和 `resolveSidebarCodingPlanUpgradeProviderId()` 同步收窄输入，
把完整 `ModelProviderConfig[]` 改为只包含 `providerId` 与 `label` 的
`CodingPlanUsageAvailableProvider[]`。余额与升级展示只需要来源身份和标签；API Key、Endpoint、模型
集合和旧可用状态不再能够穿过这层接口。Composer 迁移期调用点把已有候选显式投影为该窄类型，执行
语义未改变。

测试改为直接提供禁用但仍含 accessId 的 Account Provider，覆盖冷启动探测、共享 freshness window、
入口关闭与 access 缺失；公共余额、升级、个人/Team 和 Start Plan 相关 78 条测试通过。全仓 typecheck
通过，lint 保持 35 条既有 warning。

## 125. Composer Context Usage 改用 Account Access

V4 Composer 已经订阅 `ProviderSettingsView` 供权益 Hook 使用，但 Context Usage 的个人套餐候选、
加载状态与 Team Products 门禁仍从旧 `useModelProviders()` 推导。旧 Provider 的 API Key 或残留条目
因此仍可能让输入框展示套餐余额入口，也让 Settings、侧栏和 Composer 对同一账号连接采用不同判断。

本轮把 Composer 的 Usage 来源统一为 Account Overlay。当前连接对应的 Account Provider 只有提供非空
`accessId` 时，才会生成个人套餐候选并启用 Team Products 探测；候选标签直接来自 Effective Provider
Config。Settings View 尚未发布时，Context Usage 保持加载态。Account Access 消失后，即使旧 Provider
和 Entitlement Snapshot 仍在，也不会保留个人套餐的 hover 刷新入口。

`useModelProviders()` 暂时仍为模型菜单的旧展示和兼容逻辑服务，本切片没有把这部分职责混入 Usage
迁移。测试显式注入 `ProviderSettingsView`，并固定“旧 Provider 有 Key、Entitlement 有快照但没有
Account Access”时不产生 Coding Plan Usage。相关 26 条测试及全仓 typecheck 通过；lint 保持 35 条
既有 warning。

## 126. Automation 退出旧 Provider Snapshot

Automation 的模型表单已经在 Registry View 存在时使用新模型候选，但主页面仍订阅
`useModelProviders()` 和 Coding Plan Entitlement。Registry 尚未发布时，它会重新使用旧 Provider、Family
设置与 Entitlement 构造另一套模型菜单；创建、立即运行和删除遥测也继续接收完整旧 Provider 数组，
只为识别 Personal API Provider 的 Endpoint hostname。

本轮把 Automation 的模型候选收敛为唯一的 `ModelSelectionView`。View 尚未发布时返回空候选并等待
Registry，而不再执行旧 entitlement 过滤。Provider 顺序、账号可用性和模型集合都由 Registry 在上游
裁决。Automation 因而删除了 `useModelProviders()` 与仅供旧菜单使用的 Entitlement Hook 订阅。

遥测改读现有 `ProviderSettingsView`：只有非 Official 的 API Provider 才从 Effective Config 的 baseURL
提取 hostname，保持原有不上传 Official Provider 地址的语义。测试覆盖空 Registry、Registry 已裁决的
Account 模型、Personal API hostname 与 Official Provider 脱敏；Automation 相关 31 个文件、185 条测试
通过。

## 127. Composer 模型菜单删除旧 Provider 回退

V4 Composer 已经把 Registry View 传入模型分组构造器。View 存在时，构造器会直接返回 Registry
投影，旧 Provider、Family 设置、Entitlement、显示顺序和 Team Products 参数全部不会参与结果；但
Composer 仍常驻订阅 `useModelProviders()`，并在 View 尚未发布时用旧 Snapshot 重建模型菜单、判断
Provider 存在性、补 label 和裁决 Custom Provider 恢复资格。

本轮让 Composer 直接调用 `buildRegistryModelSelectGroups()`，删除旧 Provider Hook、Entitlement 过滤和
显示顺序回退。Registry View 尚未发布时模型候选为空，当前 Session 的模型仍可从运行投影显示为占位，
但用户不能从旧事实源选择模型。Provider label、Custom 恢复资格与选中值编码也只读取 Registry View。
Composer 的套餐 Usage 与 Team source 继续使用前几轮已经迁移的 Account Access/Entitlement 链路。

测试默认显式发布 Registry View，并新增“旧 Provider 存在但 Registry 未发布时不构造菜单”的回归；
空 Registry 也不再暴露或提交 legacy-only Provider。Composer、Coding Plan 与升级入口相关 3 个测试文件、
221 条测试通过。

## 128. 设置页套餐连接状态改用 Account Overlay

Provider Settings View 已经使用 Account Overlay 的 `accessId` 表达 Start Plan、Personal
Coding Plan 和 Team Plan 的当前连接，但设置页仍然从旧 `ModelProviderConfig.apiKey`
推断卡片登录态、登录完成、自动同步和 Start Plan 入口。这会迫使 Renderer
继续持有 Account Provider 的请求凭据，也会让旧 Key 残留覆盖新 Account 事实。

本轮在套餐导航项上增加非敏感的 `accountConnected` 投影。新 Host 明确传入
Provider Settings View 中已发布 `accessId` 的 Provider 集合；权益状态解析、Start Plan
可见性、Plan Card、登录完成等待、首次同步与同项重试均消费这一结论。
`ProviderSettingsService` 存在但首份 View 尚未发布时，页面保持 `checking`，不会短暂
借用旧 Key，也不会提前显示断开。

未装配新 Provider Settings Service 的旧 Entry 仍保留 `apiKey` 兼容语义；一旦 Service
存在，即使旧 Key 非空也不能代替缺失的 `accessId`。反向回归同时固定：旧 Key
为空但 Account Access 存在时，Z.ai 与 BigModel 均能正常显示已连接套餐。

设置页 Provider 相关 18 个测试文件、307 条测试通过；全仓 typecheck 通过，
lint 保持 35 条既有 warning。全量 pre-push 按当前约定留到后续集中执行。

## 129. 购买完成刷新穿透到 Account Source

全局 Coding Plan 购买弹窗在完成后会先调用 `refreshCodingPlanApiKey()`，再通过
`useModelProviders().refresh()` 重拉旧 Provider Snapshot。新 Account Source 虽然会收到
Account Facts 事件，但该监听是后台 fire-and-forget；`refreshCodingPlanApiKey()` 返回时，
Account Provider 重算可能仍在进行。只调用 Registry `refresh()` 也不充分，因为
`AccountProviderService.read()` 在已有 Snapshot 时会返回当前值，不会自动等待新一轮重算。

本轮为 Provider Settings Facade/Service 增加显式 `refresh(reason)`。Provider Runtime 将其
组装为两段可等待链路：先调用 Account Source 的 `refresh()`，再调用 Registry
`refresh()`。普通 Settings 写操作仍然只执行原有 Registry 刷新，不会因为一次 Personal
API Provider 编辑而多发账号/权益网络请求。

`CodingPlanUpgradeDialog` 因而删除 `useModelProviders()`。新 Host 购买完成后等待
Provider Settings Service 贯穿刷新；未装配该 Service 的旧 Entry 直接调用旧共享 Snapshot
刷新函数，不为一次刷新挂载长期 Hook 订阅。套餐权益和 Team Products 刷新顺序保持不变。

Provider Facade/Runtime 与 Coding Plan UI 相关 4 个测试文件、211 条测试通过，
全仓 typecheck 通过。全量 pre-push 按当前约定留到后续集中执行。

## 130. 设置页 Account Provider 退出常驻 Secret 投影

设置页已经使用 Account Overlay 的 `accessId` 表达套餐连接，旧投影却仍按相同 Provider ID
从 `ModelProviderConfig` 补回 API Key、不可用原因和历史时间戳。即使这些字段不再参与主要
展示判断，Renderer 的常驻 Provider 列表仍会持有旧请求凭据，也会在旧 Snapshot 更新时重新
计算新 Settings View 的投影。

本轮把迁移函数改为单向 `ProviderSettingsView -> ModelProviderConfig[]` 投影。API Provider
继续携带用户编辑所需的 Personal API Key；Account Provider 的投影固定不含旧 API Key，
Provider 集合、协议、Endpoint、模型、Properties 和 Option Specs 全部来自 Settings View。
旧 Snapshot 的独有 Provider、不可用原因与时间戳也不再进入这份常驻状态。

设置页“测试连接”仍调用尚未迁移的旧 Connectivity Probe。为了保持这项显式操作，本轮只在
用户点击测试 Account Provider 时调用一次 `getAllCached()`：按同 ID 取得兼容 API Key 和
运行 Header，再与当前投影组成一次性请求对象。当前 Settings View 的协议、Endpoint、模型
和静态 Header 优先，旧对象不能把它们覆盖回去。后续 Connectivity Probe 接入 Account Request
Auth Service 后即可删除这段按需兼容读取。

新增测试固定常驻 Account 投影不含 secret，并验证显式测试只能补运行凭据/Header，不能带回
旧静态事实。Provider 投影、设置页、Coding Plan 与订阅动作相关 4 个测试文件、228 条测试通过；
全仓 typecheck 通过，lint 保持 35 条既有 warning。全量 pre-push 按当前约定留到后续集中执行。

## 131. 新设置页冷启动和刷新退出旧 Provider Snapshot

Account secret 从投影中删除后，`useModelProviders()` 仍会在新 Settings Service 已装配时
订阅旧 Snapshot、触发 `getAll()`，并在首份 `ProviderSettingsView` 尚未到达时把旧 Provider
作为临时列表返回。这样不仅保留了无效的常驻读取，也让新 Host 的冷启动继续存在短暂双事实源。

本轮明确按 Service 能力分流：新 Settings Service 存在时，Provider View 发布前返回空列表并
保持加载态；Hook 不再订阅旧 Snapshot，也不触发旧 `getAll()` 或读取旧 display-order。
用户点击设置页刷新时直接调用 `ProviderSettingsService.refresh()`，由正式链路依次刷新 Account
Source 与 Registry。未装配新 Service 的旧 Entry 继续保留原快照订阅、缓存水合和刷新行为。

保存、删除和模型调序目前仍保留旧 Store 镜像及打开 Workspace 的兼容同步，它们涉及尚未完全
退出的 Worker/Remote 运行链路，本切片没有借读取迁移一并删除。新增测试固定“Service 已存在但
View 未发布”时不能回退旧 Provider；投影、设置页、Coding Plan 与订阅动作相关 4 个测试文件、
229 条测试通过。全仓 typecheck 通过，lint 保持 35 条既有 warning；全量 pre-push 延后集中执行。

## 132. 设置页新增模型退出独立 Catalog 查询

设置页新增模型时，旧实现会根据用户输入的 Model ID 查询一份独立的 China LLM Catalog，再从第一个
同名模型读取 `maxOutputTokens`。这条查询忽略 Provider ID 和 API Format；它既可能匹配到另一个
Provider 的同名模型，也让 Renderer 在 Official / Personal Config 之外维护了一条模型缺省值来源。

本轮在 `ProviderSettingsFacade` 增加无状态的模型配置预览。它复用当前 Snapshot 中的 Official 与
Personal `ModelConfigRules`，按照真实 Provider ID、Model ID 和 API Format 解析 Effective
`ModelConfig`，把可序列化结果及完整性问题返回设置页：

```text
providerId + modelId + apiFormat
                |
                v
      ProviderSettingsFacade
                |
                v
Official + Personal ModelConfigRules
                |
                v
   Effective ModelConfig preview
                |
                v
     maxOutputTokens.default
```

预览不会写入 Personal Config，也不会触发 Registry 重建。新增 Provider 的草稿在打开表单时即生成
稳定 `providerId`，保存时沿用该身份，因此包含 `providerMatch` 的规则在保存前后具有相同语义。

设置页同时删除了已经停用的 Catalog Provider 新增入口、对应组件以及
`IModelProviderService.getCatalogProviders()` 公共 API。旧 Catalog Loader 暂时仍被旧 Provider Store
用于迁移期 metadata 补充；只有该 Store 完成迁移后，才能宣称 Catalog 运行时事实源已经整体删除。

Provider Facade、设置页与旧 Service 回归共 6 个测试文件、371 条测试通过；Provider、Services、UI
增量 TypeScript 构建通过。全仓 lint 为 0 error、35 条既有 warning。全量 pre-push 按当前约定留到
后续集中执行。

## 133. 旧 Provider Store 删除 Catalog enrichment

旧 `config.json` / `model-providers.json` 读取链路会加载仓库根目录的中国模型 Catalog，按 Model ID
匹配 context、output、modalities 和 reasoning，再把补齐结果写回用户配置。Provider ID 与 API Format
不参与查找；相同 Model ID 在任意 Provider 下都会得到同一份 metadata。这不仅形成 Official Config
之外的第二事实源，还会把系统缺省值持久化成看似由用户配置的字段，干扰后续 Personal 差异导入。

本轮把旧 Store 的职责收窄为旧格式解析与字段规范化：

```text
旧 config.json / model-providers.json
                |
                v
      legacy schema migration
                |
                v
   normalize existing values only
                |
                v
       compatibility projection

Official + Personal + Account Config
                |
                v
        Provider Registry
                |
                v
Properties / Option Specs / reasoning mapping
```

旧 Store 不再补齐缺失 output、扩展 reasoning 档位或复制模型媒体事实。显式写在旧文件里的值继续保留；
本切片完成时 `[1m]` 的旧格式规范化仍暂时存在，随后由第 135 项迁入 Official Config。Registry
解析相同模型时仍从 Official/Personal
`ModelConfigRules` 获得完整缺省事实。测试同时固定 DeepSeek V4 Pro 的 1M context、384K output 与
reasoning 档位仍存在于仓库 Official Config，防止删除旧来源时误删事实本身。

对应 Catalog Loader、Loader 测试、5,000 多行旧 Catalog JSON 和 Electron `extraResources` 打包项已
删除。Shared 中仍保留旧 Catalog provenance 字段和 schema，供历史配置与协议兼容解析；它们不再指向
任何运行时 Catalog Source，后续随旧 DTO/Store 整体退出。

Provider Service、Official Source、Personal 导入、Provider Runtime 与桌面资源相关 5 个测试文件、
191 条测试通过；全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。全量 pre-push 按当前
约定留到后续集中执行。

## 134. Builtin Preset 系统值退出 Personal 首次迁移

旧 `ModelProviderService` 会把 Builtin Preset 的本地兜底和远端同步结果写入旧 Provider Store。
这些对象同时包含用户 API Key、系统 label、运行 endpoint、远端模型列表和账号可用状态。此前首次
迁移会把它们整体与 Official Config 求差异；当旧兜底只有 `GLM-5.2`、`GLM-5-Turbo`，而 Official
已经包含完整 Z.ai 模型列表时，这个差异会被误写成 Personal `models`，导致新 Registry 反而长期
丢失 Official 新模型。

本轮按旧数据中能够证明的所有权收窄迁移：

```text
旧 Builtin API Provider
├─ API Key                         -> Personal
├─ modified=true 的模型配置       -> Personal ModelConfigRule
└─ label / endpoint / models 等    -> 不迁移，继续由 Official 决定

旧 Builtin Account Provider
├─ modified=true 的模型配置       -> Personal ModelConfigRule
└─ 静态字段 / 可用状态 / 凭据      -> 不迁移
```

未知的旧 Builtin Provider 仍不进入 Personal。Personal-only Provider 和旧 Store 中按 custom 来源保存的
Official API Provider 继续沿用原来的完整/差异迁移语义，不受这一裁决影响。回归测试固定旧 Z.ai 两模型
兜底不能覆盖 Official 模型集合，同时保留用户显式新增的 modified 模型。

## 135. 模型后缀与新增模型缺省退出 UI 和 Shared 硬编码

设置页、Shared 模型工厂、旧 Store 归一化和协议投影此前都会识别模型 ID 的 `[1m]` 后缀，并强制把
context window 改成 1M。设置页新增模型还直接用 Shared 常量初始化 200K。相同事实因而存在于多个层级，
Personal 显式配置也无法覆盖后缀规则。

本轮把两项缺省写入 Official `ModelConfigRules`：首条通用规则提供 200K context 和默认输入能力；随后
的 `[1m]` 规则把 context 覆盖为 1M。设置页新增模型通过 Settings Facade Preview 取得结果；模型行、
编辑弹窗和保存逻辑只使用当前配置值。Shared 工厂、旧 Store 与协议投影仅规范化或传递显式 metadata，
不再从模型名称推断能力。模型 ID 改变时，新增表单会同时清除上一模型的 context 与 output preview，
等待新模型的 Config 结果，避免短暂或失败的查询复用旧值。

```text
Official ModelConfigRules
├─ model=.*        -> contextWindow = 200K
└─ model=.*[1m]    -> contextWindow = 1M
             |
             v
Settings Preview / Registry ModelConfig
             |
             v
Renderer 与执行侧消费最终值
```

因此 `[1m]` 现在表达 Official 缺省，而不是不可覆盖的代码规则。Personal 的精确 Model Config 位于 Official
规则之后，用户显式 context 可以覆盖它；旧文件中已经写明的 context 在首次导入时也能保留为 Personal
意图。7 个相关测试文件、261 条测试通过；全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。
全量 pre-push 按当前约定留到后续集中执行。

## 136. 删除停用的 Endpoint 建议与远端模型探测出口

设置页当前通过 Provider Settings Facade 编辑明确的 `apiFormat`、`baseURL` 和模型列表，已经不再读取旧
`getEndpointSuggestions` 与 `getModelsByEndpoint`。旧 Hook 仍暴露这两个未被消费的方法，Service 与
OAuth Preset Repo 也因此继续保留一条访问 `client/configs` 的设置辅助链路。

本轮删除 UI Hook 返回值、公共 Service 契约、Service/Repo 实现、Web stub、死组件与只覆盖该出口的
测试。显式连通性测试继续保留；Account 权益与旧 Preset 迁移仍可按自身职责访问远端服务。

```text
Add Provider
     |
     v
Provider Settings Facade
├─ apiFormat
├─ baseURL
└─ explicit models

testModelConnectivity
└─ 用户显式触发的独立操作
```

这项删除避免远端 Provider 列表再次成为设置页面的候选事实源，也不改变 desktop-attached remote 仍在使用
的 Workspace Snapshot 兼容链路。Services 与设置页相关 3 个测试文件、343 条测试通过；全仓 typecheck
通过，lint 为 0 error、35 条既有 warning。全量 pre-push 按当前约定留到后续集中执行。

## 137. Start Plan 模型集合退出 UI 和旧 Store 硬编码

Shared 曾以 `ZAI_START_PLAN_FREE_MODELS` 保存两个免费模型。输入框的旧 Provider Snapshot 投影会用这份
常量过滤 Start Plan 模型，设置页还会用它构造一份占位 Provider；旧 Provider Store 在远端同步失败时，
也会据此把 Z.ai 与 BigModel Start Plan 写入旧配置。这三处逻辑会覆盖或伪造正式事实：Official Config
已经声明静态模型，Account Overlay 又会根据当前权益给出实际可用成员。

本轮删除该常量及其三类消费者。正式事实链现在是：

```text
Official Provider / Model Config
              +
当前 Account ProviderConfigMap
              |
              v
       Provider Registry View
              |
              v
       设置与模型选择投影
```

兼容投影在 Registry View 尚未 hydrate 时，只转发上游旧 Provider Snapshot 已有的模型，不再根据模型名
和 `modified` 标记二次裁决。旧 Store 的网络失败 fallback 仍可补 API Key Provider 和内部 ZAPI，但不再
凭本地模型常量创建 Account Provider；未取得 Account 事实时，Start Plan 应保持不可用。

新增回归测试先证明旧实现会过滤上游模型并伪造 Start Plan，再完成生产修改。UI 与 Services 相关
4 个测试文件、340 条测试通过；全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。全量
pre-push 按当前约定延后集中执行。

## 138. 本地 Host 停止用旧 Snapshot 覆盖 Worker Registry

调研本地 Session 创建链路时发现，Host 和 Core Worker 虽然都已经装配进程级 Provider Registry，
Host 仍会从旧 `ModelProviderService` Snapshot 派生 `runtimeModel`，并在 create/resume/set/send 等入口
发送给 Worker。CLI 会把这份输入注册为 execution-scoped Model Source；因此同一个 Environment 的
普通模型执行最终仍由旧 Snapshot 覆盖，Worker 自己维护的 Official、Personal、Account Registry 没有
成为执行权威。

本轮把 Host 的两项职责拆开：

```text
ModelSelectionView
├─ 判断本地模型执行是否就绪
├─ 空 View 变为可用时唤醒等待中的 Worker
└─ 不产生 runtimeModel

旧 Provider Registry Snapshot
├─ desktop-attached remote 兼容
├─ 显式旧调用兼容
└─ 不参与已装配新 Provider Runtime 的本地执行
```

本地 Session 入口现在只发送 `ModelSelection` 与 thought level。Worker 在 Loop 创建时查询自己的进程级
Registry，Provider Config 更新只影响以后创建的 Model；已经持有的 Model 生命周期不变。调用方显式携带
的 execution-scoped `runtimeModel` 仍保留，因此闲时任务等迁移期临时 Provider 没有被这次改动删除。

实现过程中还发现 `createLocalServices()` 创建了正式 `AccountProviderConfigSource`，但传给
`ZCodeAgentService` 的仍只有 desktop-attached remote 使用的 Legacy Source。该遗漏会使本地
`provider/updateAccountConfig` 同步永远取不到新 Account Overlay。本轮将正式 Source 接入 Agent
Service；远端缺少同源 Registry 时继续使用 Legacy Source，不扩大本次迁移边界。

旧测试 Fake Agent 曾把 runtime preferences 请求绑定在 `workspace/updateProviderRegistry` 之后，V4
冷订阅也仍断言 Host 会先下发完整 Snapshot。两处测试已改为进程级 Registry 语义：runtime preferences
在 session 创建的运行时物化阶段请求，冷订阅只使用旧 Snapshot 做启动门禁。

## 139. 本地 Repo Wiki 预热退出旧 Workspace Snapshot

Repo Wiki 的模型菜单和 Option Specs 已经来自 `ModelSelectionView`，但未激活项目的草稿预热仍会无条件
同步旧完整 Registry，并由 Host 解析同一模型的 `runtimeModel`。本地 Worker 已经以自己的进程 Registry
作为执行权威，这两步会重新引入第二事实源。

本轮按 Workspace 类型分流：

```text
本地 Repo Wiki 预热
└─ preferredModel / ModelSelection -> Worker Registry

desktop-attached remote 预热
├─ 同步旧 Workspace Registry Snapshot
├─ 解析兼容 runtimeModel
└─ 创建远端草稿 Session
```

远端通过 `workspaceIdentity` 或 `remoteSessionId` 进入兼容链路；这符合远端必须携带
`workspaceIdentity` 的现有约束，也能覆盖断线期间暂时没有 `remoteSessionId` 的工作区。本地路径不再调用
`getProviderRegistrySnapshot()` 或 `resolveRuntimeModelForV4()`。新增测试分别固定远端继续同步与本地完全
绕开旧链路的行为。

## 140. 本地 V4 模型切换拒绝退出旧 Snapshot 恢复

V4 `switchModelConfig` 收到 `provider.notInRegistry` 后，Renderer 过去会无条件重推旧完整 Registry，
再由 Host 解析 runtimeModel 并重试。这原本用于 desktop-attached remote 的进程内目录恢复；本地 Worker
接入正式进程 Registry 后，这条恢复会用第二事实源覆盖 Worker 的明确拒绝。

现在只有携带 `workspaceIdentity` 或 `remoteSessionId` 的远端 workspace 进入兼容恢复。本地返回首个
拒绝结果，不调用旧 `getProviderRegistrySnapshot()`、`workspace/updateProviderRegistry` 或
`resolveRuntimeModelForV4()`。远端仍最多重试一次，第二次继续失败时停止循环。SessionPane 的 44 条测试
覆盖了本地禁止恢复、远端重推、runtimeModel 注入和防循环语义。

## 141. 本地 V4 草稿预热退出 Host runtimeModel 解析

V4 草稿 Session 预热会先取得 Composer 的初始模型配置，再调用 Host
`resolveRuntimeModelForV4()`。本地 Host 已不再持有执行 Registry Source，因此该调用通常返回空；更重要的
问题是，这个接口继续表达“Host 可以为本地执行构造 runtimeModel”，与 Worker Registry 权威相冲突。

现在本地预热的 runtimeModel resolver 直接返回空，`createSession` 只携带初始 provider/model/thought；Worker
按自己的进程 Registry 创建 Model。携带 `workspaceIdentity` 或 `remoteSessionId` 的远端 workspace 仍由 Host
解析并携带兼容 runtimeModel。测试直接捕获 SessionPane 传给预热协调器的 resolver，分别固定本地零调用和
远端正常解析；SessionPane 全部 46 条测试通过。

## 142. 本地 replayable/Bot V4 create 退出 Host runtimeModel

Services 的 task adapter 还有一条独立的 V4 `createSession` 入口，供手机 replayable 与 Bot 创建任务使用。
它过去只要收到 model 就调用 Host `resolveRuntimeModelForV4()`，即使目标是本地 Worker。由于本地 Agent
进程已经维护正式 Registry，这条输入同样会把 Host 兼容配置带回 Worker。

现在本地 V4 create 只发送 config 中的 provider/model/thought；只有带 `workspaceIdentity` 的
desktop-attached remote 目标继续解析并附加 runtimeModel。这里没有使用 `workspacePath` 判断远端，符合
远端身份隔离必须携带 `workspaceIdentity` 的约束。task adapter 的 90 条测试覆盖本地零调用与远端兼容
runtimeModel 注入。

## 143. 本地 Automation 模型切换退出 Host runtimeModel

Automation 的统一配置入口会发送 V4 `switchModelConfig`，但此前无论目标位于本地还是远端，都会先由
Host `resolveRuntimeModelForV4()`。本地 Worker 已经能用 provider/model/thought 从进程 Registry 创建
Model，这份 runtimeModel 只会重新引入旧执行投影。

现在本地 Automation 命令仅携带 Selection 与 Options；带 `workspaceIdentity` 的 desktop-attached remote
继续附加兼容 runtimeModel。Automation 原有的 collaboration mode、thought 收敛和命令顺序保持不变。
task adapter 的 91 条测试覆盖本地零解析和远端 runtimeModel 注入。

## 144. desktop-attached remote 动态鉴权边界（已裁决）

M2.8 继续退出远端旧 Account Secret Snapshot 时，确认了一个不能靠删除兼容分支解决的跨进程边界：

```text
Desktop Local Host
└─ Credential Store
   └─ Account Request Auth Resolver

Renderer
├─ Local Host services
└─ Remote Host services

Remote Host
└─ Remote Core Worker
   └─ interaction/requestProviderRuntimeHeaders
```

远端 server 使用 `desktop-attached-remote` authority mode 启动，当前没有装配 Official/Personal
Provider Config Runtime，也没有 Desktop 账号的 Credential Store。远端 `ZCodeAgentService` 收到 Worker
的鉴权请求后，只能调用远端进程自己的旧 `modelProviderService.accountRequestAuthResolver`。该 Resolver
读取远端用户目录和远端账号状态，不能代表 Desktop Environment 的登录态。

现有 UI bridge 也没有修正这个边界。`V4WorkspaceProviderRuntimeHeadersBridge` 会把 Controller 包在目标
Workspace 的 `ServiceProvider` 中；远端 tab 因而同时取得远端 `zcodeAgentService`、远端
`modelProviderService` 和远端 `codingPlanSubscriptionService`。它可以把响应送回 Remote Host，却不能
天然取得 Desktop Local Host 的 Account Request Auth Material。

静态配置已经有可复用的无 Secret 协议：

```text
Desktop Account ProviderConfigMap
        |
        | provider/updateAccountConfig
        v
Remote Worker Registry
```

真正待裁决的是每次请求的动态路由：

```text
方案 A：Renderer 临时中转

Remote Worker -> Remote Host -> Renderer
                              -> Local Host Auth Service
                              -> Remote Host -> Remote Worker

方案 B：Host 直接中转

Remote Worker -> Remote Host -> Local Host Auth Broker
                              -> Remote Host -> Remote Worker
```

方案 A 可以复用 Renderer 已经同时持有 Local/Remote services 的事实，并且与当前一次性安全校验 Header bridge 的位置
一致；需要新增一个窄的 Local Host Account Request Auth Service，并允许一次性 Auth Material 经过
Renderer 内存。方案 B 的进程职责更纯粹，Renderer 不接触 Auth Material，但当前 Local Host 与 Remote
Host 之间没有直接 RPC 通道，需要在远端连接管理层增加新的 Host-to-Host broker，影响面明显更大。

### 人的裁决

两种跨 Host 路由都不进入目标架构。Desktop Local Environment 与 Remote Environment 各自拥有
Provider Config、Credential Store、Account Source 和 Registry；`desktop-attached` 只表达远程控制关系。

迁移分三步：

1. Remote ProviderRuntime 先成为 Remote Worker 的唯一事实源，删除 Desktop 下发完整 Registry、
   runtimeModel、Account Config 和 Secret Snapshot 的主链路。
2. 同事负责的独立同步功能后续持续把本地 Config 与 Credential 写入 Remote Store；Remote Source
   根据 Store 变化重建 Registry，请求仍只读取 Remote Account Request Auth。
3. 更后续允许 App 直接调用 Remote Settings / OAuth Service，远程操作远端登录和模型配置。

第二步是 Provisioning，不是运行时 Provider 注入。同步中断时 Remote Environment 仍使用最后一次成功写入
的本地事实运行；Desktop 不参与每次模型请求。原 Renderer Auth 中转与 Host-to-Host Auth Broker 方案废弃。

## 145. Account Request Auth 提升为独立服务契约

跨 Host 传输方案尚未裁决，但 Renderer 中转与 Host-to-Host Broker 都需要同一个请求期鉴权能力。原实现
只有 `modelProviderService.accountRequestAuthResolver` 这一具体 runtime 内部属性，调用者若直接依赖它，
会继续把动态鉴权绑在旧 Provider 服务上。

本轮新增 `IAccountRequestAuthService`，接口只保留：

```text
resolve(providerId, modelId, accountAccessId, reason)
        |
        v
AccountRequestAuthMaterial
├─ apiKey
└─ headers
```

Local Services 使用现有 Resolver 装配该服务。服务层只做委托，不读取 Config、不缓存凭据、不回退旧
Provider，也不吞掉鉴权失败。`ZCodeAgentService`、集合内 Off-Peak Service 与 Desktop Host Off-Peak
Runtime 现在都依赖这份窄契约；旧 `ModelProviderService.accountRequestAuthResolver` 只在
`createLocalServices()` composition root 中用于产生迁移实现。

实现中曾尝试把该服务注册为标准 Service Channel。全仓类型检查追到 Desktop Host 的现有装配后发现，那里
已经明确禁止把 API Key 解析能力开放给 Renderer/Remote Client；若继续注册，会在跨 Host 方案尚未裁决时
提前选择 Renderer 中转。最终实现撤回 Channel、`IServiceAccessor` 与 `RemoteServiceAccess` 代理，通过与
`ProviderRuntime` 相同的 `WeakMap<ServiceCollection, Service>` 侧表保持 Local Host 进程私有。Desktop Host
可从 node composition API 取得同一实例，但 `ServiceCollection.exposeOnChannelServer()` 不会暴露它。

新增测试覆盖 Resolver 原样委托、失败不降级和 Local Host 私有实例可取得；Agent/Off-Peak 现有行为测试
改为直接注入服务契约。5 个定向测试文件共 80 条测试通过；全仓 typecheck 通过，lint 为 0 error、35 条
既有 warning。全量 pre-push 按约定延后。

## 146. Account Request Auth 退出旧 Provider Service 所有权

条目 145 先收窄了消费者接口，但 Local Host 最初仍然从
`modelProviderService.accountRequestAuthResolver` 构造新服务。这使新接口在运行时仍由旧 Provider
Service 拥有，后续删除旧服务时还会再次迁移同一条鉴权链路。

本轮把装配移动到 `createLocalServices()`：

```text
Credential Service / OAuth Credential Repo
Account Provider Credential Store
Team Plan Request Key Resolver
        |
        v
AccountProviderRequestAuthService
        |
        v
IAccountRequestAuthService（Local Host 私有）
```

普通 Personal Coding Plan Key 先读新的 `account-provider:<accessId>:api-key`；只有新键不存在时，才通过
闭包回读旧 Provider Store 并完成一次性迁移。Start Plan 继续从 OAuth Credential Repo 读取当前
Token Set；Team Plan 的请求期 Key 算法保持原样。旧 `ModelProviderService` 已删除 Resolver 字段和构造，
不再拥有动态鉴权能力。

Team Plan Key 的具体实现暂时仍与旧 Registry Snapshot 共用 `modelProviderService.ts` 中的纯函数。把这段
动态账号执行逻辑移动到独立 Account Runtime 模块是后续代码内聚清理，不影响本轮事实源和生命周期边界。

测试先验证 Local Host 的窄服务能在旧 Resolver 被移除后从新 Credential Store 解析当前 Key；相关 4 个
测试文件共 145 条测试通过。全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。全量 pre-push
按约定延后。

## 147. OAuth logout 清理新的 Account Credential Store

Personal Coding Plan Key 已经从旧 Provider Store 单向迁入按 `accessId` 管理的 Account Credential Store，
但 OAuth logout 仍只调用旧 `ModelProviderService.clearCodingPlanApiKey()`。这会让退出登录后的新请求鉴权
事实源残留旧 Key；后续重新登录或账号状态恢复时，Request Auth 仍可能读取这份陈旧凭据。

本轮让 logout handler 同时依赖两条明确的清理边界：

```text
OAuth logout
├─ 旧 Provider Store
│  └─ 清理 Start / Coding Plan 迁移期副本
└─ Account Credential Store
   └─ 删除 coding-plan:<providerId> Personal Key
```

Start Plan 的 JWT 随 OAuth Token Set 清理，不在 Account Credential Store 中另存一份；Team Plan Key 在请求期
解析，也不属于本次持久凭据清理。Local Host、Remote Connection Host 和 Remote Workspace Host 都使用各自
已经持有的 Credential Service 构造同一种 Account Credential Store，避免不同 Host 的 logout 行为再次分叉。

测试先增加新 Store 删除断言，再修改实现。3 个定向测试文件共 10 条测试通过；全仓 typecheck 通过，lint
为 0 error、35 条既有 warning。全量 pre-push 按约定延后。

## 148. Team Plan Request Key 移出旧 Provider Service

条目 146 留下的代码内聚问题已经收束。BigModel 与 Z.ai Team Plan 的请求期 Key 解析现在位于独立
`accountProviderTeamPlanRequestKey` 模块：

```text
accessId + OAuth Credential Port + ApiClient
        |
        v
Team Plan Request Key Resolver
├─ 校验选中的 organization / project
├─ 查找或创建 zcode-team-api-key
├─ 复制 Secret
└─ 返回本次请求使用的 Key
```

新的 Account Request Auth Service 直接依赖该模块。旧 Registry Snapshot 在退出前也调用同一实现，因此
迁移期不会形成两套 Team Plan Key 算法。模块不读取 Provider Config、不持有 Registry，也不缓存 Key；它只
处理请求期账号鉴权。BigModel 对陈旧 ZCode JWT 的拒绝、旧 project-only 选择的组织恢复，以及 Z.ai 的业务域
Header 行为均保持原样。

测试先建立独立模块边界，并分别覆盖 BigModel 与 Z.ai 从组织/项目取得 `apiKey.secret` 的完整流程；再移动
实现。3 个相关测试文件共 141 条测试通过；全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。
全量 pre-push 按约定延后。

## 149. Prompt CLI / TUI 关闭 Workspace Legacy Model Source

Prompt CLI 与 TUI 已经启动进程级 Registry，并在首次启动时把旧 CLI Provider Config 导入 Personal Config。
但两个 Entry 创建 App 时只注入了 `providerRegistry`，没有显式设置
`workspaceProviderCompatibilityMode: "registry-only"`。`createZCodeApp()` 的迁移期缺省值因此仍会装配
Workspace Legacy Compatibility Source：当新 Registry 缺少整个 Provider 时，Standalone 执行仍可能回读
旧 Runtime Model Overlay。

本轮让两个 Entry 在 Registry 存在时显式选择 registry-only：

```text
Official + Personal Config
        |
        v
Process Provider Registry
        |
        v
Prompt CLI / TUI App ModelFactory

Workspace Legacy Compatibility Source
        X 不再装配
```

旧 CLI Config 只在 Personal Config 不存在时参加一次性导入；导入后的执行事实只来自 Registry。测试先为
Headless Prompt 与 TUI 的 App 装配增加模式断言，确认修复前两个 Entry 都会退出，再修改实现；两条入口测试
通过。全仓静态检查结果随本轮提交统一记录，全量 pre-push 按约定延后。

## 150. Usage / Entitlement 迁移需要独立裁决

`BigModelUsageQuotaProvider` 仍直接读取旧 `ModelProviderConfig[]`。这不是单纯的静态 Provider View 消费：同一
服务把三种不同事实混在一个对象中使用。

```text
旧 ModelProviderConfig
├─ label / endpoint / provider family      静态展示与路由
├─ enabled / 当前连接                      账号选择状态
└─ apiKey                                  请求期鉴权
```

同时，Usage 的查询语义不完全等于当前 Registry：Team Plan 激活时，用户仍可显式查询 Personal Coding Plan；
已经断开、当前不可选择的 Provider 也可能需要展示历史用量或明确的未配置状态。直接替换为
`ModelSelectionView` 会把“当前可选模型集合”误当成“可查询用量来源”，直接改成 Account Request Auth 又会把
非模型 API 的套餐监控请求塞入模型请求接口。

因此该迁移需要先裁决 Usage 的领域边界。较清晰的方向是建立独立 Usage Source / Authorization 边界：静态
Provider 信息读取新 Config/Settings 投影，Personal Key 读取 Account Credential Store，Team Key 复用已抽离
的 Team Plan Request Key Resolver；是否允许查询非当前连接和已断开来源由 Usage 产品语义明确决定。在这项
裁决完成前，不能用 Registry 可选性过滤替换现有行为，也不能宣称旧 Provider Service 已可删除。

## 151. 连通性测试退出模型名 Reasoning 硬编码

设置页“测试连接”已能从 `ProviderSettingsView` 取得最终 Model Config，并把其
`reasoningMapping` 投影成当前连通性请求需要的 Provider Options。但旧 Probe 仍会在映射缺失时，
根据 `GLM` 模型名和 `low / high / max` 档位猜测 Anthropic `effort` 与
`thinking.budgetTokens`。这使 Probe 成了 Official / Personal Model Config 之外的第二个映射事实源。

本轮收窄为一条数据链：

```text
Model Config default reasoning level
        |
        | 查找同档 reasoningMapping
        v
Provider Options
        |
        v
Connectivity wire request
```

Probe 内部的 Request Body Builder 不再接收通用 `thoughtLevel` 并自行翻译；它只投影已经由
Model Config 解析好的 Provider Options。映射存在时，Anthropic / OpenAI-compatible /
OpenAI Responses 保持原有 wire 字段；映射缺失时，不根据模型名补齐任何 reasoning 参数。

测试先把旧 GLM fallback 用例改为“未配置则不发送”，确认修改前失败；随后删除 fallback 和
Helper 的 `thoughtLevel` 翻译入口。连通性 Helper 与 Provider Service 共 148 条测试通过；
全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。全量 pre-push 按约定延后。

## 152. 闲时任务编辑器退出 GLM Reasoning 名称兜底

闲时任务是 execution-scoped Provider，它的可用模型和静态模型事实由 Host 从
`client/configs.offPeak.allowed_models` 与 `builtinModels` 解析为 `allowedModelConfigs`。Renderer 已经可以
直接读取其 reasoning 档位，但旧 helper 在模型元数据缺失时仍会根据 `GLM-5.2`
模型名本地补齐 `max / high / nothink`。

本轮删除这条 Renderer 名称兜底。现在的行为是：

```text
allowedModelConfigs 包含目标模型与 reasoning
        |
        v
展示远程配置声明的档位和缺省值

allowedModelConfigs 没有目标模型或 reasoning
        |
        v
不展示 reasoning 选项
```

这项改动不把闲时任务强行改成常驻 Registry Provider；它只确保 execution-scoped
Provider 的调用方不再重建第二份模型事实。测试先新增“缺失 `allowedModelConfigs`
时 GLM-5.2 也不显示档位”的失败用例，再删除硬编码。UI 选项、Off-Peak Client Config
与 Runtime Model 共 38 条定向测试通过。全量 pre-push 按约定延后。

## 153. Root Provider 刷新入口切换到新 Runtime

Root 在启动、Provider Family 迁移、OAuth 会话恢复、登录成功和登出后都会调用同一个
Provider 刷新回调。模型选择和设置页已切换到新 Service，但这个 Root 入口仍无条件读取
`IModelProviderService.getAllCached()` 并刷新旧 Preset Snapshot，使新 Host 在启动和账号变更时
继续运行已经退出裁决的 Catalog / Preset 网络链路。

现在 Root 按 Entry 能力选择唯一刷新边界：

```text
新 Host
Root refresh
    |
    v
ProviderSettingsService.refresh()
    |
    +-- Official / Personal Config Source
    +-- Account Provider Source
    `-- Provider Registry

旧 Entry
Root refresh
    |
    v
Legacy ModelProvider Snapshot
```

`cachedOnly` 只是旧 Snapshot 刷新的迁移期选项。新 Service 存在时，Root 使用 Facade 的 ready
barrier 并等待 Registry 发布当前代 View，不再触发旧 `getAll*`。新增单测确认新 Service
装配时两个旧读入方法均不会被调用；Root OAuth、启动门禁与旧 Snapshot 共 45 条相关测试
通过。全量 pre-push 按约定延后。

## 154. 新 Runtime 启动停止预热旧 Preset

Root 刷新入口退出旧 Snapshot 后，`createLocalServices()` 仍会在后台无条件调用
`refreshPresetProviders()`。因此新 Host 即使已经装配 Official / Personal / Account Source，
启动时仍会请求旧 `release/latest` 与 `client/configs`，并修改旧 Provider Store。它既制造
重复网络请求，也让旧 Preset 在新 Registry 之外继续作为并行事实运行。

本轮把启动边界收敛为：

```text
已装配 Provider Runtime
    |
    +-- Official Config
    +-- Personal Config
    `-- Account Source
            |
            v
         Registry

未装配 Provider Runtime 的旧 Entry
    |
    v
Legacy Preset 预热
```

Account Source 自己负责账号可用性刷新；请求鉴权继续由 Account Request Auth Service
按请求取得，本次没有改变登录、套餐或动态凭据逻辑。新增 Local Services 集成测试，确认
存在 Official Config 路径时启动不会访问旧 Preset 接口，同时保留 desktop-attached remote
不预热旧 Preset 的原有断言，并新增旧 Local Entry 仍执行兼容预热的正向覆盖。
Provider Runtime、Config Runtime 与 Local Services 共 12 条定向测试通过。全量 pre-push
按约定延后。

## 155. 设置页连通性测试需要新的 Host 执行边界（暂缓）

设置页的常驻 Provider 投影已经退出 Account Secret，但用户点击“测试连接”时仍会按需读取旧
`ModelProviderService.getAllCached()`，再把完整 Endpoint、API Key、Header 和旧 Provider 对象交给
Renderer 侧的旧 Connectivity Probe。这条链路保留了两个已经退出主要路径的职责：Renderer 组装模型请求，
旧 Provider Snapshot 提供 Account 请求凭据。

普通 API Provider、Coding Plan 与 Start Plan 的真实依赖并不完全相同：

```text
普通 API Provider
Renderer: providerId + modelId
       |
       v
Host: Registry 静态事实 + Personal API Key -> Connectivity Request

Coding Plan
Renderer: providerId + modelId
       |
       v
Host: Registry 静态事实 + Account Request Auth -> Connectivity Request

Start Plan
Renderer: 交互取得本次一次性安全校验 Header
       |
       | providerId + modelId + 一次性 Header
       v
Host: Registry 静态事实 + Account Request Auth JWT -> Connectivity Request
```

官方版本安全校验依赖页面级交互，不能直接搬进 Host；JWT、Personal/Team Key、Endpoint、模型属性、
Option Specs 与 reasoningMapping 又不应继续由 Renderer 或旧 Snapshot 组装。因此目标接口应只接收
`providerId`、`modelId` 和可选的本次交互 Header，Host 负责完成其余解析与请求。它不能继续接收完整
Provider Config，否则调用方仍可绕过 Registry 制造另一份执行事实。

待裁决的是这项操作的服务归属：

- 扩展 `IProviderSettingsService.testModelConnectivity()`：连通性是设置页当前唯一消费者，接口集中，
  但会让原本只负责 Config/View 的 Settings Facade 增加网络执行职责。
- 新建窄的 `IProviderConnectivityService`：Settings 继续只管理配置，Connectivity 单独依赖 Registry、
  Account Request Auth 和请求 Adapter；将来 CLI/TUI 若需要显式探测可以直接复用，但会新增一个 Service/RPC。

无论选择哪一种，`@zcode/provider` 继续保持无 IO；执行实现位于 Services/Host，Renderer 只承担 Start Plan
交互式安全校验材料的获取。

人的裁决是 M2 暂时维持现状。连通性测试只在设置页用户显式点击时运行，结果不修改 Registry、Config 或
模型可用状态；新 Settings View 继续提供协议、Endpoint 和模型静态事实，旧 Snapshot 只按需补充这次测试
所需的兼容凭据。因此它不会影响正常 Agent Loop、Worker Registry、模型选择或 CLI/TUI，可以降级为旧
`ModelProviderService` 最终删除前的独立课题。当前不新增 Connectivity RPC，也不让这项局部技术债阻断
Remote Provider Authority 与其余 M2 收口。

## 156. 官方版本安全校验判定退出旧 Provider Snapshot

Start Plan 请求期的官方版本安全校验判定原先仍通过 `ModelProviderService.getAllCached()` 读取旧 Provider
Endpoint。这项判断属于静态 Provider 事实，不需要 API Key、JWT 或旧 Registry Snapshot。

本轮改为按 Entry 能力读取唯一静态来源：新 Provider Runtime 读取 `ProviderSettingsView.effectiveConfig` 的
`apiFormat/baseURL`；仅未装配 Provider Settings Service 的旧 Entry 继续走 Legacy Provider Snapshot 兼容判断。
Provider Settings Service 存在时，Provider 缺失直接 fail closed，不回退旧 Snapshot。具体实现与定向测试只在官方版本
维护；全仓 typecheck 通过，lint 为 0 error、35 条既有 warning。全量 pre-push 按约定延后。

## 157. 官方版本安全校验删除幽灵 Registry 依赖

官方版本安全校验的材料获取与发送前 Header 准备曾要求调用方传入从未读取的 `getProviderRegistrySnapshot`，
让 Renderer 看起来仍与旧完整 Registry 耦合。本轮删除该未使用的契约参数，只保留对 Provider 静态输入的依赖；
已弃用的 `setProviderRuntimeHeaders` 兼容入口行为未改变。全仓 typecheck 通过，lint 恢复为 0 error、
35 条既有 warning。全量 pre-push 按约定延后。

## 158. Account accessId 纳入具体登录账号作用域

Account Source 原先为 Personal Coding Plan 和 Start Plan 生成固定的连接种类 ID，例如
`coding-plan:<providerId>`。同一机器切换登录账号后，该 ID 不变，使 Usage Cache、Credential Store、
Account Config 和已创建 Model 无法区分两个账号。

本轮在原 Plan/Team 连接 ID 后追加非敏感账号身份：

```text
<plan-connection-id>:account:<encoded-account-profile-id>
```

账号身份来自 OAuth Profile 的稳定 `id`，不包含 JWT、API Key、动态 Header，也不使用 Secret 哈希。
同一账号刷新 Token 或 Runtime Key 时 ID 保持不变；切换账号后 ID 必须变化。Team Plan 同样增加账号
作用域，组织与项目连接仍保留在原有基础 ID 中。

Account Provider 已被权益判断为 available、但 Account Source 无法取得账号身份时，本轮选择
fail closed：刷新抛错并由现有 AccountProviderService 保留 last-known-good，而不生成可能跨账号复用的
无作用域 ID。Request Auth 在迁移期仍接受旧无作用域 ID，保护已经创建的 Model、旧远端兼容 Source
和持久 Session；新的 Account Source 只生成带账号作用域的形态。Team Key 解析前先剥离账号后缀，
避免旧两段 Team Key 把账号字段误识别成 organization/project。

测试先覆盖账号切换、同账号凭据刷新、缺少账号身份、Personal/Start/Team 请求鉴权，再修改实现。
Account Connection、Config Source 与 Request Auth 共 13 条定向测试通过；Services TypeScript 检查通过。
全量 pre-push 按约定延后。

## 159. Request Auth 拒绝把旧 Model 静默切到新账号

账号级 `accessId` 首轮实现后继续检查动态鉴权，发现 Start/Team 请求仍会按 Provider Family 直接读取
当前 OAuth Token。若账号 A 创建的 Model 尚未结束、用户已经登录账号 B，旧 Model 的 scoped accessId
虽然保持 A，但请求仍可能取得 B 的 Token。

Account Request Auth 现在先解析 accessId 中的账号身份，并与 OAuth Profile 当前稳定 ID 对照；身份缺失
或不一致时返回 `AccountRequestCredentialUnavailableError`，不会继续读取 API Key、JWT 或 Team Key。
同一账号的 Token 刷新不改变 Profile ID，因此仍能在 Model 生命周期内取得最新凭据。无账号作用域的旧
accessId 暂时跳过该检查，只服务迁移期已创建 Model 与旧 Source；新的 Account Source 已由第 158 节
保证不会再生成这种形态。

新增测试先复现“账号 A 的 Model 读到账号 B Personal Key”，再固定拒绝行为。Request Auth、Host Runtime
Header、Workspace Header 与 OffPeak 共 41 条定向测试通过；Services TypeScript 检查通过。全量 pre-push
按约定延后。

## 160. Usage / Entitlement 使用 Account Access 作为请求权威

Usage、Entitlement、Coding Plan Usage 和套餐重置虽然已经由 UI 选定具体来源，Host 仍会重新读取
`ModelProviderService.getAllCached()`，从旧 `ModelProviderConfig[]` 中寻找 Provider、判断是否启用、读取
API Key，并在 Team Plan 场景自行创建或复制项目 Key。这样同一次请求存在两套来源身份：UI 已选择的
账号连接，以及 Usage 层从旧 Provider 数组重新猜出的连接。

本轮把请求边界收敛为：

```text
Provider Settings / Usage Source
├─ providerId
├─ accessId
├─ organizationId?
└─ projectId?
        |
        v
Usage / Entitlement / Reset Request
        |
        v
Account Request Auth
├─ 校验 accessId 属于当前登录账号
├─ Personal Coding Plan -> Account Credential Store
├─ Team Plan            -> Team Key Resolver
└─ Start Plan           -> 当前 ZCode JWT
        |
        v
Usage API
```

`BigModelUsageQuotaProvider` 删除了对旧 `IModelProviderService` 的直接依赖，也不再负责创建 Team API Key。
Team Key 的取得和缓存由 Account Request Auth 保持统一；Usage 只消费本次连接对应的请求材料。套餐重置
同样先校验 `providerId + accessId` 的账号身份，再读取当前账号的 ZCode JWT 与对应 Provider Family 的
OAuth JWT。

Shared Protocol 为 Coding Plan Usage 和 Reset 增加必填 `accessId`；Entitlement 与通用 Usage 请求在兼容
接口上保持可选，但所有 Account Provider 生产调用都从 `ProviderSettingsView` 取得并传递该字段。UI 的
请求缓存、in-flight 合并、Reset Coordinator 和自动播放状态也把 `accessId` 纳入 key，避免同一 Provider
下的不同账号或 Personal/Team 连接共享结果。

OAuth 登录完成和启动恢复是独立的权益请求入口。它们现在先刷新 Provider Settings View，从最新 Account
Config 取得 Coding Plan 与 Start Plan 的 `accessId`，再读取 Entitlement；不再因为新服务拒绝无身份请求而
把已登录账号误判为未配置。

普通 API Provider 的 monitor usage 当前没有生产消费者，保留窄的 `resolveApiAuthorization` 注入点，后续由
新 Effective API Provider Config 提供授权，不恢复旧 Provider 数组选择。Account Credential Store 内部仍可
执行一次性旧 Key 导入；该导入是旧 Config 退出时的迁移入口，导入成功后只读取新的账号级凭据键。

Provider、Services 与 UI 共 274 条定向测试通过；Provider、Shared、Services 和 UI TypeScript 检查通过。
全量 pre-push 按约定延后。

## 161. 远端 Environment 建立自己的 Provider Runtime

检查 desktop-attached remote 的真实启动链路后发现，新 Config/Registry 虽已能在 Services 中装配，远端
`zcode-server.cjs` 却没有携带 Official Config。`createStdioServices()` 因而无法创建 Provider Runtime，实际
执行仍依赖 Desktop Renderer 把本地完整 Registry 与 `runtimeModel` 推给远端。

本轮先补齐远端事实来源。远端 Server 构建时嵌入仓库唯一的 `config/provider/official.json`；启动时按内容
哈希物化为不可变版本文件，再把路径交给远端 `createLocalServices()`。Personal Config 继续读取远端用户
目录，Account Source 继续读取远端账号与 Credential Store。新版本文件不会覆盖旧进程正在使用的文件，
相同版本会直接复用。

远端 Host 装配随后切换为自己的 Provider Runtime：模型就绪状态、Account Config、Repo Wiki 模型目录均
读取远端 Registry；旧 `LegacyAccountProviderConfigSource` 不再参与远端组合根。Desktop 的 remote workspace
服务集合也直接转发远端 `ModelSelectionService` 与 `ProviderSettingsService`，模型选择和设置视图开始服从
目标 Environment，而非 Desktop 本地 Provider。

在业务热路径上，SessionPane 删除了发送前 Registry 推送和 `provider.notInRegistry` 后注入 Desktop
`runtimeModel` 的恢复逻辑；Repo Wiki 预热也统一只提交 `ModelSelection`。Provider 被目标 Environment 拒绝时，
调用方保留该拒绝结果，由远端 Config/Account Facts 修复，不再以另一份事实覆盖。

本切片暂未删除连接恢复、旧设置保存和 Bot 路径剩余的完整 Registry 同步入口；它们继续列为后续清理目标，
不能被视为新的兼容契约。Server、Services、Desktop、Client 与 UI 共 71 条定向测试通过，相关包 TypeScript
检查通过，远端单文件 Bundle 构建通过。全量 pre-push 按约定延后。

## 162. Desktop 退出远端 Registry 与 Runtime Model 注入

远端 Provider Runtime 就绪后，Desktop 仍有四条遗留写入：打开或重连 remote workspace 时同步完整
Registry；设置保存和删除后向所有 workspace 广播 Registry；Bot 取得远端 runtime port 后同步 Registry；
草稿预热时由 Renderer 解析并下发 `runtimeModel`。它们会让同一远端执行同时受远端事实与 Desktop
Snapshot 控制，也让本地 Provider 修改静默改变另一个 Environment。

本轮删除这些生产链路。remote workspace 和远端 Bot 建连时改为读取远端 `ModelSelectionService.getView()`，
把它作为远端 Provider Facade 已就绪的检查；检查失败即不缓存或暴露半初始化 runtime。设置保存只写
Personal Config，Registry 由每个 Environment 的 Config Source 更新。草稿预热继续提交初始 Session Config，
其中只有 provider、model 和 thought 等用户选择；远端在自己的命令处理阶段从当前 Registry 创建 Model。

Bot `/model` 在存在新 Model Selection Facade 时同样只提交 `modelRef`。`updateProviderRegistry` 仅为尚未
装配 Facade 的旧 Entry 保留，远端身份不再触发这一兼容分支。旧协议和 Agent 内部 Snapshot 缓存将在所有
旧 Entry 接入 Provider Runtime 后统一删除，本轮不把协议删除与远端权威切换绑成一次高风险变更。

删除的 UI 同步模块包含 revision/pending 状态、workspace target 枚举和 Desktop Registry 广播，共退出三份
并行状态。Remote Bot Runtime 增加 Model Selection Facade 代理，继续复用既有 MessagePort 服务集合。
Services 与 UI 共 191 条定向测试通过，两个包 TypeScript 检查通过；全量 pre-push 继续按约定延后。

## 163. 旧 Registry 协议停止生产写入，协议删除与 Fixture 迁移分开

Desktop、Remote UI 和 Bot 的生产调用退出后，`workspace/updateProviderRegistry` 已经没有新 Provider Runtime
调用方。继续尝试删除协议时发现，CLI 的冷恢复、V4 projection、runtime header 和模型限制等大量既有测试
仍用它建立旧 workspace catalog fixture；直接删除会同时改变这些测试的准备方式，无法判断失败来自协议退出
还是被测行为变化。

本轮选择先完成事实源断流，不在同一提交中删除协议壳。Bot 最后的 legacy `/model` 分支已经删除；无论本地
还是远端都只提交 `modelRef`。Repo Wiki 也删除 workspace Registry 镜像，只读取当前 Environment 的
Model Selection View；未装配新 Runtime 的旧 Entry 仍可读取自身 legacy source，但不能再从另一个
Environment 接收镜像。

远端 Host 管理的 Core Worker 现在与本地 Host 一样接收当前 Environment 的 Account Config。此前代码仅凭
`workspaceIdentity` 是 SSH/WSL 就跳过 Account Config 同步，这是 Desktop 注入时代的遗留条件，会让已经拥有
远端账号事实的 Remote Host 无法把自己的 Account Overlay 交给 Worker；本轮删除该条件。它仍是同一
Environment 内 Host 到 Worker 的 Config 同步，不是 Desktop 到 Remote 的跨 Environment 注入。

协议本体的最终删除将与 CLI 测试 fixture 改用 Official/Personal/Account Source 同批完成。届时一起清理
Shared Schema、Session/Agent Service 方法、CLI handler、workspace catalog 的 snapshot revision 水位线和
对应测试，避免留下无覆盖的半删除状态。相关 Services 定向测试 125 条与全仓 TypeScript 检查通过；lint
保持 0 error，并在移除本轮废弃 import 后回到 35 条既有 warning。

## 164. Remote App 禁止回退 Workspace Registry Snapshot

远端进程已经建立自己的 Official、Personal、Account Config 与 Registry，但 Protocol Entry 在创建 Remote App
时仍显式选择 `legacy-snapshot`。这会继续装配旧 workspace overlay 兼容来源；即使 Desktop 写入方已经删除，
该入口仍允许未来的遗留调用把跨 Environment Snapshot 重新带回执行链。

本轮把“进程 Registry 已就绪”的组合根规则收敛为单一函数：无论当前进程服务本地 Desktop Workspace，还是
SSH、WSL、Docker 等 Remote Environment，创建 App 时都注入本进程 Registry，并固定使用 `registry-only`。
运行表述因此统一为：

```text
当前 Environment 的 Official + Personal + Account Config
                         |
                         v
                 Process Registry
                         |
                         v
                 App Model Runtime
```

Turn 临时 Provider 仍由 execution-scoped source 注入，不属于 workspace snapshot，也不受这项删除影响。
未装配进程 Registry 的旧手工 Entry 继续保持原行为；`legacy-snapshot` 类型与测试夹具暂时保留，等待旧协议
和 workspace catalog fixture 同批退出。staging 将兼容媒体能力改为可缺省后，Registry 的完整性检查同时
收紧了内部返回类型，确保执行投影仍取得确定的图片、PDF 和视频布尔值。Bootstrap 相关 3 个测试文件、
13 条测试及类型检查通过；全仓 lint 保持 0 error、35 条既有 warning。

## 165. 冷恢复以进程 Registry 判断模型就绪

Remote App 改为 `registry-only` 后继续审计冷恢复，发现 Session materialization 仍只通过旧
`workspaceModelCatalogs` 判断历史模型是否可用。Remote Environment 即使已经从自身 Config 启动进程
Registry，只要 Desktop 没有下发旧 Snapshot，这个判断就会选择 deferred adapter，并给 Session 挂上
`restoreWarning`；后续用户发送可能被错误拒绝。

Protocol Server 现在显式记录当前进程是否已建立 Provider Registry。冷恢复的兼容分支调整为：

```text
已有 Process Registry
└─ 直接由当前 Environment Registry 恢复

没有 Process Registry
├─ workspace compatibility target 存在 -> 使用该 target
└─ target 不存在                         -> deferred adapter + restoreWarning
```

这个布尔事实只描述组合根是否已装配新 Registry，不携带 Provider 数据，也不创建新的模型事实源。旧手工
Protocol Entry 的行为保持不变；Desktop、Remote Worker、Prompt CLI 和 TUI 已装配 Registry 时都不会再等待
workspace Snapshot。新增冷恢复集成测试同时覆盖新 Registry 直接恢复和旧 Entry 的 restoreWarning 语义，
Bootstrap 相关 3 个测试文件、40 条测试及类型检查通过。

## 166. Provider Config Schema 收敛为 Access、API 与 Model API Adapter

此前的 Provider Config 把 `apiKey`、`accessId`、`apiFormat`、`baseURL`、Headers 和模型推理映射铺在同一层，
调用方需要通过字段组合猜测它描述的是访问身份、请求协议还是模型适配行为。Account Provider 接入 Overlay
之后，这种结构还会让 Official、Personal 和 Account 三路配置以不同方式表达同一事实。

本轮将配置文档升级到 Schema v5，并把字段按实际职责收拢：

```text
Provider Config
├─ access
│  ├─ api-key
│  └─ zhipu-account
├─ api
│  ├─ type
│  ├─ baseURL
│  └─ headers
└─ models
   └─ Model Config
      └─ apiAdapter
         ├─ reasoningMapping
         ├─ preserveThinking
         └─ reasoningContentField
```

Official、Personal 与 Account Access 继续使用同一份 `ProviderConfig` Overlay。配置只描述当前来源掌握的事实；
动态请求凭据仍由执行链在请求时取得，不进入 Registry 的静态模型事实。`ModelConfigRule` 同时把
`apiFormatMatch` 收敛为 `apiMatch`，允许同一模型的公共属性与不同 API 协议下的适配规则分层覆盖。

旧 v4 文档由唯一迁移入口转换到 v5：扁平 Provider 字段进入 `access` 与 `api`，模型级
`reasoningMapping` 进入 `apiAdapter`。Official 配置文件也同步切换到新格式，生产调用方不再读取旧字段。

实现 Personal 配置差量投影时发现，若把 `access`、`api` 或 `apiAdapter` 当作一个普通字段整体保存，用户只
修改 API Key 就会把当前 Official 的管理地址一并复制进 Personal；以后 Official 更新该地址将不再生效。
因此差量投影按这些嵌套 Overlay 的直接字段递归比较，只保存用户实际修改的字段。旧 Personal Config 导入
同样复用这条投影路径，不再预先做一份顶层差量计算。

Provider 72 条、Provider Node 10 条、Services 69 条、Bootstrap 39 条以及 UI 相关定向测试通过；全仓
TypeScript 检查和 lint 通过，lint 保持 35 条既有 warning、0 error。UI 全量测试仍有 2 条既有 Composer
Continuity Mock 缺少 `modelSelectionService.onDidChange` 的失败；Bootstrap 全量测试还包含既有环境与 Session
Lifecycle 基线失败。本切片没有修改这些链路，定向测试已经覆盖所有 Schema v5 生产调用方。

## 167. Personal Config 原位切换到首个正式 Schema

Provider Config 尚未正式发布，前几个切片中的 v1-v5 只是开发过程中的中间编号。继续保留这些迁移步骤会把
未上线的历史固化成长期兼容负担。本轮把最终的 `access`、`api`、`models.apiAdapter` 结构定为首个正式
`schemaVersion: 1`，删除内置的开发期逐版本迁移；未来真正发布 v2 时，再增加明确的 v1 到 v2 迁移。

Personal Provider Config 继续使用现有 `~/.zcode/v2/config.json`，不创建第二份 `provider-config.json`。首次
读取没有 `schemaVersion` 的旧文件时，由 Entry 注入旧格式转换器，在同目录先写入内容一致且不覆盖已有文件的
备份，再原子写入新 v1 文档：

```text
读取旧 config.json
        |
        v
创建 config.json.pre-provider-v1-<sha256>.bak
        |
        v
Entry 转换旧格式 -> Provider Config v1
        |
        v
原子替换 config.json
```

备份创建失败、旧格式转换失败或转换器缺失时，原文件保持不变，启动方收到明确错误。备份名包含原始内容的完整
SHA-256；同一内容重复迁移可以复用已有备份，不同内容不会覆盖旧备份。Standalone CLI/TUI 与 Host/Worker
使用相同默认路径，但各 Entry 仍负责注入自己掌握的旧格式读取方式。

新设置链路保存、删除 Provider、更新 API Key 和调整模型顺序时只写新 Personal Config，不再镜像写入旧
`ModelProviderService`。账号刷新等尚未迁出的兼容调用仍可能经过旧 Service，因此旧存储层增加所有权保护：
发现目标文件已经是正式 Provider Config v1 时拒绝写入，防止旧结构覆盖新事实源。该保护只用于迁移期；后续
账号链路接入 Account Config Source 后，旧 Provider 存储实现整体删除。

Provider 69 条、Provider Node 12 条、Services 与 UI 定向 36 条、Bootstrap 14 条及 CLI 路径 4 条测试通过；
全仓 TypeScript 检查通过，lint 保持 35 条既有 warning、0 error。误触发的 Bootstrap/CLI 全量测试仍暴露
既有 MCP、Session、Telemetry、SEA 资源与测试清理问题，均不在本切片修改链路内。

## 168. Account Source 直接取得账号级 Coding Plan 凭据

新 Registry 已经使用 Account Config Overlay 表达账号 Provider，但登录、启动恢复、购买完成和登出仍调用旧
`ModelProviderService.refreshCodingPlanApiKey()`。该方法除了写旧 Provider Store，还隐藏承担了一个必要职责：
使用当前 OAuth Access Token 向业务接口创建或复制 Personal Coding Plan API Key。直接删除调用会让新登录账号
无法进入 Coding Plan Registry。

本轮把这项职责收敛为 `AccountProviderCredentialService`。它以账号级 `accessId` 读取和保存凭据；缓存缺失时，
使用当前 OAuth Token 调用现有业务 Key 解析实现，并合并同一账号连接的并发请求：

```text
providerId + accountIdentity
        |
        v
scoped coding-plan accessId
        |
        +-- Credential Store 命中 -> 返回
        |
        `-- 未命中 -> OAuth Token -> 业务 Key 接口 -> 保存 -> 返回
```

Account Source 在查询 Coding Plan 权益前先取得当前账号身份，再按该身份取得 Key；最终发布的 Account Config 与
请求期 Credential Store 因此使用同一个 scoped `accessId`。Model 请求鉴权不再回读旧 Provider Store。OAuth
回调会显式强制刷新账号 Key，普通启动恢复继续复用缓存；同一次 OAuth 回调中的多次 Provider 刷新共享同一
Promise，避免为 Start/Coding/最终 selectedKey 重复复制 Key。

新 Provider Runtime 下，启动恢复、登录回调、设置页鉴权变化和购买完成只刷新 Account Source。登出先清理
迁移期无账号作用域的旧 Key，再直接刷新 Account Source；Account Source 在账号身份消失后发布不可用结果。
旧 `refreshCodingPlanApiKey`、`clearCodingPlanApiKey` 只留给未装配 Provider Runtime 的兼容 Entry。新 Runtime
同时停止订阅旧 `ModelProviderService` 的 Account Facts 事件，账号设置由 Settings invalidation 驱动，登录、
登出和购买由各自业务流程主动刷新。

远端业务 Key 的 HTTP 实现暂时复用 `OAuthPresetProviderRepoProviderResolvers` 中无状态的 Key 解析方法；它不读
旧 Provider Config 或 Registry。删除旧 Preset Repo 时应把该方法移动到账号凭据领域，保持当前 Service 契约
不变。Provider、Services 与 UI 共 12 个定向测试文件、345 条测试通过；全仓 TypeScript 检查通过，lint 保持
35 条既有 warning、0 error。

## 169. 进程 Registry 拒绝旧 Workspace Provider 写入

生产 Worker 已经在进程启动时从所属 Environment 的 Official、Personal 与 Account Config 建立 Registry，但
协议和 Host Service 仍保留 `workspace/updateProviderRegistry`、`workspace/upsertModelProvider` 与
`workspace/removeModelProvider`。这些方法已经没有生产调用方，却仍允许旧 Host Snapshot 或 Workspace 级写入
重新建立第二套 Provider 事实。

本轮先在进程 Registry 的组合边界关闭这三条旧命令：只要 Worker 已装配进程 Registry，协议统一返回
`Method not found`。同时删除 `IZCodeAgentService` 与 `IZCodeSessionService` 暴露的三组方法、参数和返回类型，
Host、Remote Service Proxy 与 Renderer 因此不再拥有调用旧写协议的静态接口。未装配新 Registry 的手工测试
Entry 暂时保留旧 handler，供下一步把测试 fixture 迁到新 Registry 后整体删除协议 Schema 与实现。

远端 stdio 装配测试也从“由 Desktop 推送一份 Provider Snapshot 后启动”改为“Remote Environment 从自己的
Official Config 建立 Selection View 后启动”。测试由此直接覆盖已经裁决的远端第一事实来源：Desktop 只触发
远程操作，不传 Provider 配置或鉴权。

新增协议边界测试覆盖三条旧命令在生产 Registry 模式下均不可用；Session Service 17 条测试、Remote stdio
装配测试和 Bootstrap 定向测试通过，全仓 TypeScript 检查通过。完整协议 Schema、旧 Workspace Provider 字段
及其测试 fixture 的删除继续作为下一切片推进。

## 170. 删除 Desktop Provider Snapshot 的远端内存回退

上一切片删除 Host 写入口后，`ZCodeAgentService` 中的 `providerRegistryByWorkspaceKey` 已经失去唯一写入点，
但模型解析、启动就绪和请求期 Header 处理仍保留读取分支。这些分支在运行时永远无法命中，同时继续表达
“远端可以回退到 Desktop 推送 Snapshot”的过时架构。

本轮删除该 Map、生命周期清理逻辑和三处回退分支。SSH/WSL 等远端目标与本地目标现在遵循同一条规则：

```text
所属 Environment 的 Config 与 Account Access
                    |
                    v
             进程 Provider Registry
                    |
          +---------+---------+
          |                   |
          v                   v
   Runtime Model 解析       启动就绪判断
```

动态请求鉴权继续由请求期 Account Service 和交互响应提供，并作为本次请求的 `requestAuth` 返回。没有进程
Registry 时，不再借用 Session 缓存或 Desktop Snapshot 重新构造 Provider；这使“模型静态事实”和“请求期
鉴权材料”保持分离，也避免远端重新出现第二事实来源。

原先验证 pushed Registry 的三条 SSH 测试改为验证进程 Registry；无 Runtime Model 缓存的动态 Header 测试
改为验证仅返回 request-scoped auth，不改写 Session Runtime Model。三条定向测试与全仓 TypeScript 检查通过。

## 171. 补齐 Remote Host 与 Worker 的 Environment Config 边界证据

进一步核对远端生产装配后，确认 Remote Host 会在每次启动 Worker 时注入远端自己的
Official Config 与 Personal Config 路径。Worker 随后从这两份 Config 和远端 Account Source 重建
Registry；Desktop 不参与 Provider 事实和鉴权的传递。原有两处注释仍在描述“Desktop 重下发
Registry”，已更正为当前架构。

新增 Process Manager 测试直接观测子进程环境，覆盖 Official / Personal 两个 Provider Config 路径
确实进入 Worker。这条测试补齐了之前“Remote Host 能构建 Registry”与“Remote Worker 实际读到同源
Config”之间的空白。

尝试将 `workspace/upsertModelProvider` 与 `workspace/removeModelProvider` 从所有 Entry 立即关闭时，全量协议
测试暴露 28 条直接依赖该协议的旧测试。其中大部分验证将被 Official Model Config Rules 取代的
reasoning 硬编码合成，少数仍验证 Session 默认模型与思考深度语义。本轮没有通过批量删测试强行
关闭；生产 Registry 继续在协议边界拒绝三条旧写入。后续先把有价值的 Session 语义迁到进程 Registry
测试，再连同旧 reasoning 硬编码、Schema 和 handler 整体删除。

## 172. Registry 模式切断旧 CLI 与 Workspace 模型事实

进程 Registry 装配后，旧 CLI Config 的 `model`、`modelCatalog` 和 Workspace Catalog 仍可能通过
`bootstrapModelConfig`、Runtime capability fallback 与 Workspace compatibility source 进入模型执行。这些路径
虽然已经不是主装配入口，但仍会让旧文件或旧 Workspace Snapshot 覆盖 Registry 中的模型属性、Option 和
Provider 路由。

本轮把边界收敛为：

```text
旧 CLI Runtime Config
├─ MCP / Hooks / Permission 等尚未迁移领域 -> 暂时继续使用
└─ Provider / Model / Model Catalog         -> Registry 模式不再进入执行

Workspace Catalog
└─ Registry 模式不再生成 bootstrapModelConfig

Turn Temporary Provider
└─ 继续通过 execution-scoped Model Source 注入
```

删除 `workspaceProviderCompatibilityMode`、Workspace compatibility source 及其 Registry 合并逻辑。Registry 中
不存在的 Provider 现在直接返回 `ProviderNotFound`；只有当前 Turn 显式携带的临时 Provider 可以在执行作用域内
补充 Registry。Prompt CLI、TUI 和 Protocol Worker 都使用同一规则，不再需要 Entry 选择兼容模式。

同时修复一个优先级泄漏：此前即使传入进程 Registry，`bootstrapModelConfig` 仍可能优先于 Registry 初始化
Runtime。现在 Registry 模式完全忽略这份旧模型配置，context window、max output、输入媒体能力和 reasoning
options 只从 Registry 与当前 execution-scoped Overlay 取得。

Bootstrap 6 个定向测试文件共 208 条测试、Prompt CLI/TUI 两条进程 Registry 生命周期测试通过。Bootstrap 与
CLI TypeScript 检查通过；CLI 检查前先重建 Shared Types 和 Bootstrap 产物，避免旧 `dist` 声明造成伪失败。
全仓 lint 保持 35 条既有 warning、0 error。

## 173. Workflow Child Runtime 复用 Registry Adapter

继续审计旧 CLI Config 读取时发现，主 App 已由进程 Registry 创建 ModelFactory 和 Adapter，但 Expert Workflow
与 Script Workflow 的 Child Runtime 仍会各自调用 `createModelAdapter()`。在 Registry 模式下，这些子 Runtime
没有旧 `RuntimeModelConfig`，`createModelAdapter()` 因而会自行读取 `~/.zcode/cli/config.json`，把已经退出主链路
的旧 Provider 与 Model 事实重新带回进程。

本轮让两类 Workflow Child Runtime 直接复用主 App 已装配的 Adapter：

```text
Process Registry
      |
      v
App ModelFactory + Adapter
      |
      +-- Main Agent
      +-- Expert Workflow Child
      `-- Script Workflow Child
```

每个 Child Loop 仍通过 ModelFactory 创建并持有自己的 execution-scoped Model；共享 Adapter 只复用 Provider
协议执行基础设施，不会让不同 Loop 共享可变模型选择。删除 Workflow 装配中重复的 Model Catalog、Model Config、
Endpoint Routing 和 Model Logger 输入后，Bootstrap 生产代码只剩主 App 一处 `createModelAdapter()` 调用。

回归测试先观测到一次 Expert Workflow 会重复创建 8 个 Adapter，修改后整个 App 生命周期只创建 1 个。
Provider Registry App Runtime 与 Script Workflow 共 12 条测试、Bootstrap TypeScript 检查通过。

## 174. 冷恢复测试退出 Workspace Provider 写协议

`v4-cold-resume` 的集成测试此前会在每次恢复前调用
`workspace/updateProviderRegistry`。这些测试真正验证的是冷恢复、持久化物化、usage、thought、
远端 workspace identity 和恢复后的命令准入；旧 RPC 只是把历史 Session 所选模型临时变成
“可用”的测试夹具。

本轮将夹具改为生产同构的进程级事实源：测试启动一个 `ProviderRegistry`，由 Server 的 App
Factory 注入每个恢复出来的 App。模型的 context window 和 reasoning 档位直接来自 Registry。
除专门保留的“无进程 Registry 的旧版恢复告警”兼容测试外，不再向 Workspace 写入 Provider。

原 `provider-registry-context-window-sync` 测试随之删除。它验证的是旧 Workspace Registry 更新后
立即改写正在运行 Session 的 context/output limits；这与已经确认的生命周期冲突：已经创建的
Model 在其连续执行期间保持不变，Registry 更新只影响以后创建的 Model。该生命周期已由
`provider-registry-model-runtime` 的“Registry 更新后只替换后续执行配置”测试覆盖。

迁移后的 `v4-cold-resume` 32 条测试全部通过。下一步可以在保留产品行为证据的前提下删除
`zcode-protocol.test` 中用于验证旧 Workspace Provider 写入和模型名 reasoning 推断的历史测试。

## 175. 删除 Agent 侧 Workspace Provider Writer

完成冷恢复迁移后，Agent 侧仍保留三条可以重建 Workspace Provider 目录的协议 handler：

```text
workspace/updateProviderRegistry
workspace/upsertModelProvider
workspace/removeModelProvider
```

这些 handler 会维护独立的 Provider Map、secret、revision、水位线、模型能力差异和 active session
热更新。即使生产 Registry 模式已经拒绝调用，未启用 Registry 的测试或嵌入 Entry 仍可使用它们，
所以旧事实源并未真正退出。

本轮先把仍有价值的 `workspace/generateText` 临时 App 测试迁到进程 Registry，并修正生产装配：
Registry 模式由 Entry 的 App Factory 注入 Registry/Adapter，不再额外创建会读取旧 CLI Config 的
Workspace deferred Adapter，也不再同步 Workspace Catalog。随后删除三条 handler 及其生产实现。
任意 Entry 调用旧方法现在统一得到 JSON-RPC `Method not found`。

协议主测试中随旧 writer 删除 37 条历史用例。它们覆盖的是 Workspace Snapshot 时序、active session
热改以及按 Provider/Model 名称合成 reasoning 参数；这些行为已经由新的 Config Resolver、Registry
生命周期与 Model Config reasoning mapping 取代。Session 冷恢复、模型选择、临时 App 释放等产品行为
均保留在新事实源测试中。

`zcode-protocol.test` 剩余 115 条测试全部通过。Shared 协议 Schema/常量与 Services 的历史 Host 推送
测试仍待下一切片同步删除；暂时保留它们不会重新开启 Agent handler。

## 176. 删除 Host 到 Agent 的旧 Provider Writer 协议

Agent handler 删除后，Shared 仍导出了三条旧 Workspace writer 的方法常量、参数 Schema 和结果 Schema；
Services 测试中的 fake agent 也继续返回这些方法的成功响应。这些脚手架会掩盖生产代码重新发送旧 RPC
的回归。

本轮删除 Shared 中的 writer 协议声明和 Dev Docs 中的写入口，并清理 Services 测试里已经失效的
`service.updateProviderRegistry()` 用例。fake agent 不再接受旧 writer；仍保留的字符串只用于断言 Host
没有发送这些方法，Bootstrap 协议测试则明确断言旧方法返回 `Method not found`。

`ZCodeProviderRegistrySnapshot` 暂时保留。它目前仍是 Host 模型选择、请求鉴权和迁移期 Runtime Model
投影使用的兼容数据结构，不再具有向 Agent Workspace 写入 Provider 事实的能力。后续应随着 Config / Registry
视图收敛逐项替换，而不是在本切片连带删除。

Shared 协议、Services Provider Registry、Runtime Headers、Repo Wiki Lane、Services 主测试和 V4 测试共
184 条测试通过；全仓 TypeScript 检查通过。

## 177. 补齐 HTTP Server 与 Standalone Server Core 的进程 Registry

审计所有生产 Entry 后发现，Desktop、Remote stdio、Prompt CLI 和 TUI 已经提供 Official Config，
`packages/server` 的 HTTP Entry 与 `zcode-server-cli` 的 Standalone Server Core 仍直接调用
`createLocalServices()`。这两个入口因此没有创建 Provider Runtime，会回退到旧 `ModelProviderService`。

本轮把 Official Config 的内容版本物化能力收敛到 `@zcode/provider-node`：构建时把唯一的
`config/provider/official.json` 嵌入 Server 产物，启动时按内容哈希写入所属 Server Runtime 的
`config/provider` 目录，再把版本文件路径显式传给 Services。相同内容复用同一路径；内容变化生成
新路径，已启动进程继续读取旧版本，不会被原地修改。

```text
Official Config Source File
            |
            v
      Server Build Artifact
            |
            v
immutable revision file in runtime root
            |
            v
createLocalServices({ officialProviderConfigFilePath })
            |
            v
Official + Personal + Account Provider Runtime
```

HTTP Server、Remote stdio 与 Standalone Server Core 现在使用同一物化机制。Provider Node、Server
物化与两套构建配置共 20 条定向测试通过。CLI/TUI 登录仍会写旧 CLI Provider Config；它涉及
Account Provider 的账号连接和动态凭据语义，未在这个纯 Entry 装配切片中顺手改写。

## 178. Services 不再允许创建无 Official Config 的旧 Provider 权威

所有生产 Entry 接入 Official Config 后，`createLocalServices()` 的可选路径只剩测试使用。该可选参数仍让
新的 Entry 可以在未装配 Provider Runtime 时编译通过，并在运行时退回旧 `ModelProviderService`：启动预热
旧 Preset、用旧 Registry Snapshot 判断 Agent 就绪，并让 Repo Wiki 读取旧 Provider 事实。

本轮将 `officialProviderConfigFilePath` 提升为 `createLocalServices` 的必填依赖，同时把 Desktop `init-local`
协议字段和运行时 Schema 改为必填。任一 Host/Server 漏传 Official Config 都会在编译或协议准入阶段失败，
不会静默创建第二事实来源。

Services 随之固定创建 Config、Account Source 和 Registry，删除旧 Preset 启动预热、旧 Registry readiness
source 与 Repo Wiki Registry fallback。`ModelProviderService` 暂时继续承担旧设置形态迁移及尚未收敛的外围
能力，但不再能因为 Entry 漏配置而重新成为 Agent 的 Provider 权威。生产 Bot 也只注入新的 Model
Selection Service；Bots 内部为独立旧式测试保留的 `ModelProviderService` fallback 不再由 Host 装配。

四个入口/协议/Services 定向测试文件共 47 条测试通过；全仓 TypeScript 检查通过。

## 179. Standalone 登录改为 Account Config 与请求期鉴权

Prompt CLI 与 TUI 的 Coding Plan 登录过去把 API Key、Provider 定义和默认模型一起写入旧
`~/.zcode/cli/config.json`。这会让 Standalone Entry 即使已经启动进程 Registry，登录后仍重新制造一份旧
Provider 事实源。

本轮将 Standalone 登录收敛为两类状态：

```text
Shared Credential Store
├─ 当前账号身份
└─ accessId 对应的 API Key

Model Selection Config
└─ configuredDefault
```

进程启动时，Standalone Account Source 根据账号身份和当前可取得的 API Key 生成第三层
`ProviderConfigMap`。它只携带 `accessId`；Provider 的模型、Properties、Option Specs 和静态 API 配置继续来自
Official Config，秘密不进入 Registry。登录、手工 Coding Plan API Key 和退出都修改同一 Credential Store，
同进程订阅者在写入完成后刷新 Account Source 与 Registry。

Model 请求在每个真实 attempt 前使用 Model 固定的 `accessId` 读取当前 API Key。API Key 轮换因此不修改
Registry，也不改变已经创建的 Model 身份；下一次请求直接取得新值。账号身份被删除或切换时，旧 accessId
失效，Account Source 同时把对应 Provider 从以后创建 Model 使用的 Registry 中移除。

Z.AI OAuth 使用服务端用户 ID 作为账号身份。BigModel OAuth 和手工 API Key 当前没有稳定 Profile ID，暂时使用
API Key 的不可逆摘要形成进程内需要的稳定身份；未来 Account Service 提供正式账号 ID 后可以替换这一来源，
`accessId` 与请求期鉴权边界不需要变化。当前只接入 Z.AI / BigModel Personal Coding Plan，不借此扩展 Start Plan、
Team Plan 或闲时任务。

旧 CLI Config 现在只作为 Personal Config 与 configured default 的一次性导入输入。新文件一旦生成，后续修改旧
Provider/Model 字段不会再次进入 Registry。`createZCodeApp` 仍读取旧文件中的 MCP、Hooks、Permission 等尚未迁移
领域，但 Registry 模式明确忽略其 `model` 与 `modelCatalog`。

当前 Credential 变化通知覆盖同一进程内的多个 Store 实例；新进程启动时会读取最新落盘事实。一个已经长期运行
的 Standalone 进程尚未监听其他进程修改 Credential 文件，这属于后续 Source 同步切片，不能通过把 API Key
重新放回 Registry 规避。

## 180. 生产设置入口停止容忍缺失 Provider Settings Service

`ProviderSettingsService` 此前虽然已经由 Desktop、Remote、Server 和 Standalone Entry 装配，UI 契约仍把它
声明为可选。设置、Welcome API Key、购买完成和安全校验链路因此保留了“服务缺失时读取或写入旧
ModelProviderService”的分支，新的生产 Entry 仍可能在装配错误时静默回到第二事实源。

本轮把 `ProviderSettingsService` 提升为 `IServiceAccessor` 的必备服务。纯 Web 首页等不运行 Provider 的 Entry
显式提供空 Settings View，而不是依赖 `undefined` 表达能力缺失。设置页、登录页、购买完成刷新和 Root 刷新只走
Settings/Selection Facade；API Key Management URL 也从 Settings View 的 Effective Provider Config 读取。

旧设置表单仍可作为迁移期输入，但它只存在于 Renderer 边界适配层。适配层把当前表单和
`ProviderSettingsView` 组合成结构化的完整 Effective Provider/Model Config，Settings Facade 再相对当前
Official Config 计算稀疏 Personal Overlay。Official Provider 和 Personal-only Provider 共用这一入口，不会
把 Official label、Endpoint 或完整模型列表复制进 Personal Config。

Start Plan 的官方版本安全校验继续保留原有动态材料、request-scoped Header 与回执机制；其判定所用的
`api.type/baseURL` 静态事实改为强制读取 Settings View，删除 `getAllCached()` fallback。购买完成后同样只刷新
Account Source 与 Registry，不再额外调用旧 `refreshCodingPlanApiKey`。

这一调整没有重构显式“测试连接”操作。该操作仍按用户点击临时读取兼容凭据，且不能覆盖 Settings View 的静态
Provider/Model 事实；它已在 M2 计划中作为独立后续课题记录。

## 181. Root 删除 Renderer 旧 Provider Snapshot

`ProviderSettingsService` 成为生产必备服务后，Root 仍维护一份独立的
`ModelProviderConfig[]` 内存快照。启动门禁、登录弹窗与 OAuth 刷新同时观察 Selection View 和旧快照，
使“Registry 尚未发布”和“旧 Provider 可用”仍可能形成两种答案。

本轮删除 Renderer 的 `modelProviderSnapshot` 模块及 Root 订阅状态。启动可用性与登录门禁现在只认
`ModelSelectionView`：`null` 表示 Registry 尚未发布，空 View 表示 Registry 已确认没有可选择模型，
两种状态都不会读取旧 Provider 数组。

OAuth 链路同时收敛为一次 Provider Runtime 刷新：账号登录成功后先完成 Provider Family 的
`selectedKey` 校正和 App Settings 快照刷新，再调用 `ProviderSettingsService.refresh()` 更新 Account Source、
Registry、Settings View 与 Selection View。Renderer 不再按 Coding/Start/Team Provider 分别调用旧
`refreshCodingPlanApiKey()`，也不再维护 `cachedOnly`、请求 ID 或旧快照竞态屏障。

设置页使用的 Legacy 表单投影仍存在，但其输入只来自 `ProviderSettingsView`。显式“测试连接”仍保留按需读取
兼容凭据的独立边界；它没有重新成为 Root 常驻状态或模型选择事实来源。

针对 Root 启动、登录门禁、OAuth、设置投影与保存边界的 9 个测试文件、63 条测试通过；全仓 TypeScript
检查通过，lint 为 0 error，保留 35 条与本切片无关的既有 warning。

## 182. Bot 删除旧 Provider 候选事实源

Bot 的 `/model`、`/status` 和旧状态迁移此前优先使用新的 Model Selection View，但
`BotsService` 仍把 Selection Service 设计为可选依赖，并保留旧 `ModelProviderService`、旧 Registry
Snapshot、内存 Provider TTL 缓存和持久 Provider 菜单作为 fallback。Remote Workspace Host 还把
Desktop Local Host 的旧 Model Provider Service 注入远端 Bot，因此同一个 Remote Environment 可能同时观察
远端 Selection View 和桌面本地 Provider 事实。

本轮把 Model Selection Service 提升为 `BotsService` 的必备依赖，删除旧 Provider Service、Registry
Snapshot 和 Provider 菜单缓存链路。Bot 模型菜单、Provider label 与旧状态迁移只消费所属 Environment 的
Selection View；View 成功返回空列表时表达当前确实没有可选模型，读取失败时只允许沿用同一 Selection Source
最近一次成功的内存投影。Workspace runtime `configOptions` 缓存继续独立存在，它记录 Agent 配置项，不承担
Provider/Model 事实。

Local Services 注入本地进程 Registry 的 Selection Service；Remote Workspace Host 注入远端连接提供的
Selection Service。远端 Bot 因此不再读取 Desktop Local Host 的 Provider 配置。两个直接构造 Bot 的 E2E
harness 也显式提供 Selection View，防止测试继续依赖生产代码中的隐式旧 fallback。

Bot 与 Remote Workspace Host 的 9 个定向测试文件、121 条测试通过；全仓 TypeScript 检查通过。

## 183. 设置页连通性测试退出旧 Provider Snapshot

设置页的“测试模型”有一项容易遗漏的产品语义：它测试当前编辑器里的草稿，Endpoint、API Key 或模型名可能
尚未保存。因此不能把 RPC 简化成 `providerId/modelId` 后让 Host 只读取 Registry，否则用户看到的配置和实际
测试对象会不一致。

本轮在 Provider Settings Service 增加连通性测试操作。Renderer 把本次静态草稿和模型名交给 Settings RPC；
Host 等待 Provider Runtime 就绪，并从最新 Settings View 查找同 ID Provider。API Key Provider 直接使用当前
草稿。Account Provider 则忽略草稿中可能残留的鉴权值，按 Effective Config 的 `accessId` 调用请求期鉴权服务，
再把当前 API Key/Team Key 合并进这一次探测。Start Plan 的一次性安全校验 Header 仍由现有交互链路生成，并随
这次草稿一起提交。

既有 `ModelProviderService.testModelConnectivity` 暂时继续承担网络 Probe、Start Plan 权益检查和请求安全校验；新增
的 `requestAuthResolved` 边界明确告诉它本次凭据已经由新 Account Request Auth Service 解析，禁止它再次读取
旧 Provider Snapshot 或 Family 设置改写身份。这个兼容复用不再产生 Provider 事实，后续提取独立 Probe 时可以
直接删除旧 Service 上的同名入口。

Renderer 的 `getAllCached()` 读取和 `resolveLegacyConnectivityProvider()` 已删除。实现过程中还发现一条购买完成
测试仍断言调用已退休的 `refreshCodingPlanApiKey()`；测试已改为锁定当前行为：购买完成刷新 Account Source /
Registry，且不会重新刷新旧 Provider API Key。

Provider Runtime、请求期鉴权、旧 Probe 隔离、设置投影、购买完成和官方版本安全校验相关的 7 个测试文件、198 条测试
通过；全仓 TypeScript 检查通过。

## 184. 删除旧 Snapshot 到 Account Config 的迁移 Source

远端 M2.8 链路重新审计后确认，Remote Host 已经使用自己的 Official、Personal、Account Source 和 Registry，
Remote Worker 读取同一 Environment 的 Config 路径，并由 Remote Host 通过 `provider/updateAccountConfig` 同步
第三层 Account Overlay。后者属于一个 Environment 内的 Host→Worker 配置同步，不是 Desktop→Remote 注入，
因此继续保留。

M2 主计划中四条远端事项仍标为待实施，是计划状态落后于第 161–176 节已经完成的代码和测试；本轮将它们
同步为完成。生产代码已经没有 `workspace/updateProviderRegistry` writer，也没有给
`LegacyAccountProviderConfigSource` 的装配点。该 Source 只剩公开导出和自己的单元测试，却仍允许未来调用方
把旧完整 Registry Snapshot 重新投影成 Account ProviderConfigMap。

本轮删除 `LegacyAccountProviderConfigSource` 及其测试。旧 `ModelProviderService` 在构造尚未完全退出的兼容
Snapshot 时仍需把 Family selected key 转换为 `accessId`，这段纯转换函数移动到独立的
`legacyAccountAccessId.ts`，不再和 Account Config Source 混在一起。依赖引用检查确认被删除的 Class 没有生产
调用方；新的纯函数测试与旧 Model Provider Service 的 136 条定向测试通过。

## 185. Repo Wiki 删除旧 Registry Source fallback

Repo Wiki 的 Workspace Provider 适配器已经在所有生产 Entry 中注入所属 Environment 的
`ModelSelectionService`，旧 `providerRegistrySource` 只剩一个没有生产调用方的可选分支和对应测试。该分支
允许未装配 Provider Runtime 的 Entry 继续把旧 Snapshot 当作 Wiki 静态模型事实，与 M2.8 已完成的权威边界
冲突。

本轮把 `modelSelectionSource` 改为必填依赖，删除旧 Source 接口、fallback 和测试夹具。适配器仍暂时把
Selection View 投影成 Repo Wiki 内部尚在消费的 Snapshot 形状；这只是同一事实的结构适配，不再读取第二
事实源。后续迁移 Repo Wiki 内部类型时可以继续删除这层历史数据形状。

## 186. 启动门禁测试开始退出旧 Registry Snapshot

审计 `ZCodeAgentService.providerRegistrySource` 时确认它已无生产装配，但测试仍让它同时承担启动门禁、
Runtime Model 解析、Session 热更新和安全校验恢复四种职责。直接删除会让二十多项协议测试在真正断言前因
“Provider 未就绪”失败，无法区分产品语义回归与夹具失真。

本轮先迁移边界清楚的启动门禁用例。Provider 不可用、多个等待 Workspace、只读 Runtime 转为可执行、
Account Request Auth 初始化等场景改用 `ModelSelectionReadinessSource`；需要动态就绪变化的测试使用
`ModelSelectionView` change source。Runtime Model 与热更新测试继续保留旧 Source，等待下一切片按职责迁移。

一次删除实验还发现 V4 并发决策测试把同一个旧 Source 的调用次数当作时序屏障。该测试没有被强行改写，
实验性生产改动已撤回；后续应先为 Runtime Model 解析提供正式夹具，再删除旧 Source。迁移后的 Provider
Registry 34 条测试和独立启动门禁测试通过。

## 187. 共享 Agent 测试 Helper 分离 Readiness 与 Runtime Model Source

`zcodeAgentService.test`、V4、Provider Runtime Header 和 Repo Wiki Lane 的共享夹具此前只注入
`providerRegistrySource`。同一份旧 Snapshot 因而既决定进程能否启动，又提供 Runtime Model 解析数据；测试
很难证明生产已经由 Selection View 负责启动门禁。

本轮为这些共享夹具显式增加 `modelSelectionReadinessSource`。旧 Source 暂时只保留给仍在验证的
Runtime Model 缓存、Header 恢复和兼容投影。V4 并发模型决策用例原先把“启动门禁读取 Snapshot”计入调用
次数；分离后第一次旧 Registry 读取就是命令 ACK 后的 Runtime Model 重建，测试屏障已按真实职责调整。

这一步不改变生产代码。它继续降低删除 `providerRegistrySource` readiness fallback 的测试迁移面；剩余工作
主要集中在 `zcodeAgentService.providerRegistry.test.ts` 中逐项构造旧 Runtime Model 的用例。

## 188. Agent 启动门禁退出旧 Registry Snapshot

剩余 Provider Registry 测试已经显式区分两项输入：`ModelSelectionReadinessSource` 只回答当前进程是否存在
可选模型，旧 `providerRegistrySource` 只为尚未迁移的 Runtime Model 解析、Header 恢复和热更新用例提供兼容
数据。新增回归用例先证明：仅注入一份含模型的旧 Registry Snapshot 时，旧实现仍会错误地解锁 Worker。

生产 `ZCodeAgentService` 随后删除 Registry-to-readiness 转换、Registry change 触发启动和
`startupRegistry` 旁路。现在的启动时序固定为：

```text
ModelSelectionView
        |
        v
Host 启动门禁
        |
        v
Worker 启动后使用自己的 Registry 再次解析 Model
```

旧 Registry change event 仍暂时负责已存在 Session 的 Runtime Model 兼容热更新，但它已经不能启动等待中的
Worker。Provider Registry 35 条测试和 Agent Service、V4、Runtime Header、Repo Wiki Lane 共 92 条测试通过。

## 189. Host 退出 Runtime Model 重建与热同步

继续审计确认，`ZCodeAgentService.providerRegistrySource` 已经没有生产装配点；剩余行为全部由历史测试维持。
它仍允许 Host 从旧 Registry Snapshot 重建 `runtimeModel`、监听 Snapshot 变化并更新已存在 Session，还让动态
鉴权回执顺手修改 Session Runtime。上述行为会让 Host 和目标 Worker 各自解释 Provider 事实，与“所属
Environment 的 Worker Registry 是执行权威”冲突。

本轮删除旧 Source、Host 侧 Runtime Model 构造、Snapshot 热同步和相关 Provider/Plan 错误分类。普通
Session、Workspace、V4 Bot 与 Automation 请求现在只传 `providerId/modelId/thought`；本地和远端 Worker 都用
自己的最新 Registry 创建 Model。远端链路不再因为存在 `workspaceIdentity` 而由 Desktop Host 附加一份本地
`runtimeModel`：

```text
Host / Remote Controller
        |
        | ModelSelection
        v
Target Worker Registry
        |
        v
      Model
```

`resolveRuntimeModelForV4()` 已从 Agent、Session 与 Task Adapter API 中删除。动态鉴权请求仍由 Host 返回本次
请求需要的 API Key/Header，但不会再据此更新 Session Runtime。显式随 Submission 或 V4 命令提供的
execution-scoped `runtimeModel` 继续透传并在该段执行中缓存；普通 Selection 命令会清除此前的显式临时缓存。
这条临时输入用于闲时任务等执行级 Provider，不重新引入 Host Registry。

旧代码曾为“ACK 后异步重建 Runtime Model”维护 decision token。重建步骤删除后，缓存更新只剩同步保存或清除
显式 `runtimeModel`，因此同时删除该伪并发状态机。远端 Bot/Automation 回归测试改为明确断言协议载荷只包含
Selection，不包含 Desktop `runtimeModel`；相关 Service 与 UI 定向测试 293 条通过，全仓 TypeScript 检查通过；
lint 为 0 error，保留 35 条与本切片无关的既有 warning。

## 190. 删除 Session Runtime Model 热同步协议

Host Runtime Model 重建删除后，`session/updateRuntimeModelConfig` 已没有生产调用方。它仍在共享协议与 Worker
保留一套完整 handler，可以把任意 `runtimeModel` 事后写入已存在 Session，也可以用
`applyModelSelection=false` 把请求级 Header 合并进 Workspace Model Overlay。这两项能力分别属于旧 Host 热同步
和旧安全校验恢复设计，会绕过 Worker Registry 与请求期鉴权边界。

本轮删除该协议方法、参数/结果 Schema、Host Service API、Worker dispatch 和 handler。冷恢复时，历史
ModelSelection 由 Worker 自己的 Registry 解析；当前 Registry 不再包含该模型时，Session 保留历史展示并明确
报告不可用，Host 不能再用完整 Provider 配置把它临时“修活”。API Key、一次性安全校验 Header 等动态鉴权材料在真实
请求前解析并交给 Adapter，不写入 Session Runtime 或静态模型目录。

原协议测试中“冷恢复不可用模型会拒绝继续发送”的部分继续保留；依赖 Host 事后修补 Runtime 与把安全校验 Header
写入 Session Overlay 的断言删除。Bootstrap 协议 114 条测试、Provider Registry 12 条测试和全仓 TypeScript
检查通过。一次错误的 package test 命令额外触发了 Bootstrap 全量套件，其中存在多项与本切片无关的既有失败；
随后使用精确 Vitest 入口验证了本次受影响文件。

## 191. Workspace 模型回显删除旧 Provider Config 裁决器

`resolveWorkspaceModelSelection` 曾经混合读取 workspace 下的 GLM `config.json`、Renderer localStorage 偏好与旧
Provider 列表，再通过 Provider ID、Base URL 和模型名判断是否展示 ghost supplier。当前生产调用已经统一为
ZCode Agent，非 GLM 分支不可达；该 resolver 却无论传入 Claude、Codex 还是 Gemini 都固定读取 GLM 配置。
把它迁入新的 Model Selection Service 会把旧 workspace 配置重新确立为 Provider 事实源。

本轮删除 resolver、Parser、Repo、Helper、旧 Service API 和对应旧行为测试。Workspace reload 现在只有一条模型
回显链：

```text
prepare configOptions
        +
App Recent Model Selection
        +
当前进程 Model Selection View
        |
        v
Composer 模型与 supplier 回显
```

旧会话残留的 Agent provider 标识先归一为当前唯一的 `glm`，不会触发另一套配置读取。Model Selection View 负责
判断 provider 是否仍可选择；prepare 回包负责表达当前 runtime 已接受的模型；App Recent 只在现有优先级允许时
初始化或覆盖 Composer。旧 workspace Provider Config 不再参与这条链路。

新增回归测试覆盖旧 provider 标识归一、当前 Provider 回显、不可用 Recent 不覆盖 prepare 结果，以及 Start/Coding
Plan 切换后的权威回包优先级。UI 与 Provider Facade 定向测试 12 条通过，全仓 TypeScript 检查通过。

## 192. 删除全局 Provider Runtime Header

正式的一次性 Header 链路已经在每次模型请求前通过 `providerRuntimeHeaders.request/response` 获取一次性 Header，
恢复时也只把新 Header 暂存给对应 workspace、session 和下一次请求。旧 `ModelProviderService` 仍暴露
`setProviderRuntimeHeaders()`，允许 UI 把一次性 Header 写入进程级 Map、失效旧 Registry Snapshot，再由 Snapshot 把
Header 投影给模型。该入口没有生产调用方，但测试仍把它描述成可用行为。

这条全局状态会破坏一次性凭据的作用域：

```text
旧链路
一次性 Header -> Provider 级 Map -> Registry Snapshot -> 任意后续请求

当前链路
一次性 Header -> 指定 request response -> 对应模型请求
```

本轮删除 Service API、Provider 级 Map、两个已弃用 UI helper 及其测试。旧 Provider 配置中可能残留的
官方版本安全校验 Header 仍在兼容 Snapshot 投影时被剥离；Start Plan 的静态 Authorization 继续从当前
Credential 获取，不与一次性 Header 合并。请求级 Header 构造、并发串行化、暂存与响应逻辑保持
不变。

Provider Service、官方版本安全校验状态机与日志 helper 共 161 条定向测试通过。后续旧 Registry Snapshot 即使仍为
少量兼容消费者存在，也不能再承载动态请求凭据。

## 193. 校正 M2.3c 主计划状态

复核当前代码后确认，M2.3c 主计划中曾标为“待实施”的三项已经由前面的实现切片完成：

- Provider Config 已使用 `access.type`、`api.type` 与模型级 `apiAdapter`，规则使用
  `apiMatch` 表达模型/API 组合行为。
- Personal Config 继续使用 `~/.zcode/v2/config.json`。首次读取旧格式时先创建内容哈希备份，
  再由唯一导入入口写回正式文档；写入使用原子替换，备份或转换失败不会覆盖原文件。
- 最终格式以 `schemaVersion: 1` 作为首次正式版本，开发阶段的 v1–v5 只保留在历史记录中，
  不作为长期公开迁移链路。

本次只同步主计划的状态文字，没有新增兼容逻辑，也没有改变已有文件迁移行为。后续 M2.3c 仍需继续
完成“所有有效静态事实迁入 Official / Personal Config、删除剩余 Catalog/Preset/hardcode 分支”的
收尾审计；该审计与上述 Schema、路径和版本切换是不同的工作项。

## 194. 退出旧 Provider Registry 全局变更事件

旧 `IModelProviderService.onDidChangeProviderRegistry` 没有生产订阅者。它原本用于把旧 Service 生成的完整
Registry Snapshot 主动推送给 Host/Worker；Runtime Model 同步协议和对应生产调用已经移除，新的 Model Selection
与 Provider Settings 通过各自 Facade 读取 Registry View。

本轮保留旧 Service 内部的 Snapshot 缓存，继续让保存 Provider、账号状态刷新和套餐状态变更使缓存失效；移除
对外事件、异步构造并推送快照的逻辑，以及两个只验证旧事件的测试订阅。这样下一次读取仍然得到最新快照，
但 Provider 变化不会重新建立一条全局热推送事实链。`getProviderRegistrySnapshot()` 仍保留给当前尚未迁出的
设置连通性兼容路径，待该路径改用新 Registry 后再删除。

## 195. 删除旧 `applyToProvider` 入口

`IModelProviderService.applyToProvider()` 曾用于把模型选择应用到旧 Agent Provider，并承担 ZAPI、Provider
和 Model 存在性校验。当前本地执行已经由 Submission 携带 Selection、Worker 自己的 Registry 创建 Model；
仓库生产代码没有剩余调用，旧入口也不再写入 `~/.zcode/cli/config.json`。

本轮删除接口、实现和仅覆盖该兼容入口的测试。Provider 保存继续由 Settings Service 负责，Selection 校验由
Model Selection Service/Registry 负责，连通性测试继续使用独立的 `testModelConnectivity()`。远端旧 Snapshot
兼容链路在代码中已无生产调用，相关历史说明保留在调用地图中供后续清理审计使用。

## 196. 删除旧 Provider Display Order 文件

旧 `IModelProviderService.getDisplayOrder()` 与 `saveDisplayOrder()` 读写独立的
`model-provider-display-order.json`。当前设置页的 Provider 与模型调序已经由 `ProviderSettingsService`
直接修改 Personal Config Overlay；Effective 顺序由 Official 与 Personal 两层解析得到，旧展示排序文件不再
参与模型选择或设置页面。

本轮删除旧接口、Storage 读写函数、路径 helper 和对应文件故障测试。Shared/UI 中仍保留的
`ModelProviderDisplayOrderState` 只作为设置页面投影的兼容数据形状，不代表旧文件继续存在。

## 197. 校正 M2.3d 账号身份状态

复核 M2.3d 主计划中四条账号身份事项后确认，它们已经由现有 Account Source、Request Auth、Credential
Store 和 Usage 链路共同完成，原计划文字落后于实现：

- Account Source 使用 `createAccountScopedAccessId()` 生成账号作用域身份；同一账号刷新凭据时保持稳定，
  切换账号时生成新的 `accessId`。
- `AccountProviderRequestAuthService` 在请求前校验 Provider 与 `accessId` 的匹配，并校验当前 OAuth
  账号身份；Team 的 organization/project 从同一个 `accessId` 解析并传给 Team Key 解析器。
- Personal Coding Plan API Key 以账号作用域 `accessId` 作为 Credential Store key。旧 provider 级 key
  只作为迁移期读取，不参与新请求事实。
- Usage、Entitlement、Team Products 和相关缓存请求都携带账号作用域 `accessId`，Team 请求同时保留
  organization/project 上下文，没有再引入平行的账号缓存身份。

本轮只同步实施状态和证据，不改变运行逻辑。后续仍需单独处理的是旧 `ModelProviderService` 兼容读取和
远端/迁移期入口的最终退出，不应再把账号身份本身列为未完成事项。

## 198. 补齐 Registry 到 Adapter 的视频能力投影

M1 已把 `supportsVideo` 纳入 `Model.properties`，Model 层也会在请求进入执行器前拒绝明确不支持视频的
模型。但 Registry 编译到 AI SDK Adapter 的 `inputMediaCapabilities` 只携带图片和 PDF；直接走 Adapter
请求转换时，视频能力因此无法沿用同一份 Registry Model Config。

本轮把 `supportsVideo` 加入 Adapter 的媒体能力结构，并在 Registry Model Runtime、生成请求和流式请求的
消息转换中完整传递。执行级 Provider 覆盖也同步使用同一字段。这样 Model 层的属性校验与 Adapter 层的
媒体投影读取同一份能力事实；没有改变“明确为 false 才省略媒体，未声明时保持兼容”的既有语义。

Bootstrap Registry Runtime 12 条测试、Adapter runner/transform 69 条测试通过。本轮未触碰旧 Catalog 或
Provider Service 的兼容路径。

## 199. 复核旧 Model Catalog 的剩余引用

本轮重新检查了 `ModelCatalogService`、`modelCatalog.overrides`、bundled models.dev 快照以及旧
`model-providers.json` 的生产引用。结果需要分成两类理解。

在 `providerRegistry` 已装配的生产路径中，模型选择和执行的关键数据已经由新 Registry 提供：

```text
Provider Registry
├─ listModels -> ModelSelectionView
├─ model properties / option specs -> Registry Model
└─ createModel -> Provider Model Runtime
```

`create-app.ts` 会在这一条件下关闭 `includeLegacyProviderModels`，`ApiProviderModelRuntime` 负责执行模型，
Session Facade 的 Registry 分支负责模型选择与 reasoning 档位。因此旧 `ModelCatalogService` 不再是这些主链路的
事实来源。

旧 Catalog 代码仍有以下兼容性引用：

- 没有注入 `providerRegistry` 的旧 App/CLI 装配仍通过 `model-selection.ts`、`model-input-capabilities.ts`
  和 `runtime-model-factory.ts` 构造模型能力；
- workspace catalog 的迁移、回显和历史协议辅助函数仍需要把旧结构转换为能力投影；
- 旧 Runtime Config 仍保留 `modelCatalog.overrides` 的解析，以支撑尚未切到新 Registry 的兼容入口；
- 旧 `ModelProviderService` 的 `model-providers.json` 读取仍作为一次性 Personal Config 迁移和少量遗留服务边界。

因此本轮不删除这些模块，也不把它们重新接回 Registry 主链路。它们的当前定位是“无 Registry 装配的兼容运行时和一次性迁移适配”，而不是另一套并行的生产 Provider 事实源。

后续删除前必须分别证明两件事：所有仍可启动的 Entry 都注入 Registry；旧文件迁移、workspace 历史恢复和兼容测试已经不再需要旧 Catalog 结构。届时应按调用点逐项删除，而不是以 `ModelCatalogService` 这个类名为依据整体移除。

## 200. 补齐兼容能力路径的视频属性

前一轮已经把新 Registry 的 `Model.properties.supportsVideo` 投影到 Adapter 的媒体能力结构；本轮继续检查未装配 Registry 的兼容路径，发现 `model-input-capabilities.ts` 仍只收集图片和 PDF。这样同一个模型的 `supportsVideo` 在旧 CLI/临时执行模型路径中会丢失，最终 Core 的视频输入策略无法得到配置结果。

本轮同步了四个边界：

- models.dev 的 `modalities.input` 将 `video` 转换为旧 Catalog 能力；
- Catalog Override 合并保留 `supportsVideo`；
- 运行时兼容能力解析在显式配置、Catalog 和缺省投影之间传递 `supportsVideo`；
- 旧模型选择投影把该属性带到 `ZCodeModelOption`。

这项改动只补齐已经确定的媒体属性，不改变 Registry 主链路，也没有扩大旧 Catalog 的事实职责。新增回归覆盖 models.dev 视频事实、显式视频 Override 和模型选择投影。

## 201. 删除旧 Preset 的公开刷新入口

`IModelProviderService.refreshPresetProviders()` 已经没有生产调用方。新的 Host、Worker、Prompt CLI 和 TUI
分别由 Official、Personal 与 Account Source 驱动 Registry 刷新；继续公开这个方法，会让任意 RPC 消费者重新
触发旧 Preset 同步并改写旧 Provider Store。

本轮删除接口和 Service 返回对象上的公开方法。旧 Service 的 `getAll()` 暂时继续在内部调用同名私有刷新函数，
只服务尚未删除的一次性迁移与兼容读取；该内部函数不再能通过 `IModelProviderService` 或 RPC 主动调用。这样
收窄了旧事实源的生产表面，同时没有改变 Personal Config 导入或旧 Entry 的首次读取行为。

## 202. 设置连通性测试退出旧 Provider Service

新设置链路此前已经从 Provider Settings View 取得静态 Provider 事实，并按 Account Overlay 的 `accessId`
在请求期解析凭据；最后一步却仍调用 `IModelProviderService.testModelConnectivity()`，再用
`requestAuthResolved: true` 阻止旧 Service 重新读取 Provider Snapshot。这个兼容开关使旧 Snapshot 继续成为
网络探测的间接依赖。

本轮把鉴权后的单次探测定义为窄 `ProviderSettingsConnectivityProbe`。组合层负责 Account 凭据和请求 Header，
Probe 只接收当前设置草稿、模型与本次 API Key，处理 Start Plan 权益校验、请求安全校验和实际 endpoint 探测。
生产装配直接创建 Probe，不再把旧 `ModelProviderService` 注入设置链路，也不再传递
`requestAuthResolved`。旧 Service 的同名方法暂留给尚未删除的兼容测试与远端旧频道；它已不是新设置功能的
生产依赖，后续可以独立删除旧方法和完整 Snapshot 构造器。

## 203. 删除旧连通性测试 API

上一节完成后，`IModelProviderService.testModelConnectivity()` 已没有生产调用方。它原本同时承担
Provider Snapshot 读取、Account/Team 凭据重写、Start Plan 权益判断和网络探测，保留这个公开入口会让
设置链路之外的调用者继续依赖旧 Provider Service 的事实组合。

本轮删除接口、实现和远端 Host 的兼容入口。连通性行为没有被删除：通用协议探测、模型级 reasoningMapping、
Start Plan 可用性与请求安全校验现在由独立的 `ProviderSettingsConnectivityProbe` 覆盖。新增的 Probe 测试直接
验证当前 apiFormat、reasoningMapping 和模型名未命中规则时的行为；Account/Team 请求凭据仍由既有
`accountProviderRequestAuthService` 与 `accountProviderTeamPlanRequestKey` 测试覆盖。

这一步收窄了旧 Provider Service 的职责，不改变设置页提交草稿、请求期鉴权或网络探测的产品语义。旧
Registry Snapshot 的实现仍单独存在，下一步继续审计它的测试与兼容引用，再决定删除范围。

## 204. 删除旧 Provider Registry Snapshot

完成设置连通性迁移后，`getProviderRegistrySnapshot()` 已没有生产消费者。剩余调用只存在于旧
`ModelProviderService` 的接口、缓存构造器和专门验证该快照的测试；Host、Worker、Selection、Settings 与
执行 Model 都已经使用新的 Registry / Facade 链路。

本轮删除旧 Service 的 Snapshot 接口、缓存、代际失效和完整快照构造器，并移除只验证旧快照投影、旧运行凭据
覆盖和旧并发初始化的测试。`ZCodeProviderRegistrySnapshot` 协议类型及 Repo Wiki 的兼容输入暂时保留，因为它们
仍是独立的历史数据形状；它们不再由 `ModelProviderService` 生成，也不再参与当前模型创建。

删除后的 Model Provider Service 测试保留 100 条，覆盖旧 Store 的迁移、预置同步、Account 可用性和 Personal
写入行为。单独运行该测试文件时通过；与其他带后台权益刷新测试并行运行时，已有的临时目录清理存在一次
`ENOTEMPTY` 竞态，后续应作为测试隔离问题单独处理，不恢复 Snapshot 兼容层。

## 205. 清理旧 Snapshot API 的测试残留

删除 `getProviderRegistrySnapshot()` 后，生产代码已经没有该 API 的调用方；UI 测试仍在多个服务 mock
中保留它，模型切换测试还保留了对它的配置、重置和“不应调用”断言。这些测试残留会让已退出的接口看起来仍
属于当前服务边界，也会掩盖测试真正依赖的服务最小集合。

本轮只删除 UI 测试中的旧 mock 字段、无效初始化和断言，不改变测试覆盖的交互行为。受影响的 9 个测试文件
共 104 条测试通过。`getProviderRegistrySnapshot` 现在只剩历史文档或独立兼容协议的语义，不再出现在生产
服务接口和测试 mock 中。

`readLegacyProviders` 与 `getAllCached()` 没有在本轮删除：它们仍承担 Personal Config 首次读取时的单向
旧配置导入。该入口的退出条件是确认所有支持的 Entry 已完成迁移，而不是简单地按名称删除旧 Service。

## 206. 审计旧 Provider Service 的剩余生产入口

旧 Snapshot API 清理后，剩余生产依赖集中在两条迁移/兼容路径：

1. Local Host 的 `ProviderConfigRuntime` 在 Personal Config 尚不存在正式版本时，调用
   `modelProviderService.getAllCached()` 读取旧 Provider Store，转换为稀疏 Personal Config，并在同一路径完成
   备份与原子写入。正式 Config 存在后，这个回调不会再次执行。
2. `remoteWorkspaceServiceCollection` 的本机兼容 Host 为 `AccountProviderCredentialStore.loadApiKey()` 提供
   旧 Provider Store 回退；同一文件还把旧 `ModelProviderService` 作为 OAuth logout 的迁移期清理入口。该路径
   服务的是兼容 Host 的本机 Usage/OAuth 边界，不是 Remote Worker 创建 Model 的事实来源；Remote Worker 的
   Registry 和 Request Auth 仍读取所属 Environment。

因此本轮不删除这两条入口，也不把它们重新解释为 Registry 来源。删除它们需要先分别确认：所有可启动 Entry
都已完成 Personal Config 迁移，以及兼容 Host 的旧账号凭据清理不会再被内部使用者依赖。后续若退出，应先把
远端兼容 Host 的旧凭据清理改成独立迁移服务，再删除 `IModelProviderService` 上的对应方法，避免把一次性迁移
和长期 Provider 事实混在一次改动里。

## 207. OAuth logout 退出旧 Provider Store 清理

继续沿着上面的调用面检查后，OAuth logout 中对 `ModelProviderService.clearCodingPlanApiKey()` 的调用被确认
只是在登出时改写旧 Provider Store 的派生 key。新请求鉴权读取账号作用域 Credential Store，Account Source
负责重新发布可用性；旧 Store 的清理不会影响当前 Registry、Model 或请求凭据。

本轮让 logout 只依赖 `AccountProviderCredentialStore.deleteApiKey()` 和 Account Source 刷新，移除
`remoteWorkspaceServiceCollection`、`remoteConnectionServiceCollection` 到旧 Service 的 logout 注入，并删除
只验证旧 Store 被改写的测试。`IModelProviderService` 自身的 `clearCodingPlanApiKey()` 实现暂时保留，供迁移期
旧内部调用和后续单独清理使用；它已经不再是 OAuth logout 的生产依赖。

## 208. 清理 UI 中已退出的 Coding Plan API mock

设置页的 OAuth 测试已经验证 logout 和 Account Source 刷新，不再调用旧的
`refreshCodingPlanApiKey` / `clearCodingPlanApiKey`。本轮删除这些 mock、重置和“不得调用”断言，保留真实的
登录、解绑、刷新和凭据读取断言。9 条设置测试全部通过。

旧 Service 方法及其专门的历史测试暂不在本轮删除；它们仍需要按 Account Provider 新流程重新归类，避免把
权益判断测试一起误删。

## 209. 清理 V4 测试中的旧 Provider Store mock

同一批 V4 测试还为 `modelProviderService.getAllCached()` 构造了空 mock，但这些用例已经通过
Selection/Settings 服务验证模型恢复、草稿预热和错误门禁，实际没有读取旧 Provider Store。本轮删除这些
无效 mock；10 个受影响测试文件共 113 条测试通过。生产迁移入口不受影响。

## 210. 删除旧 Coding Plan Key 刷新与清理 API

OAuth、设置页和 Account Provider 已经分别通过 Account Credential Store、Account Source 与 Request Auth
完成登录刷新、可用性发布和请求期鉴权。旧 `IModelProviderService.refreshCodingPlanApiKey()` 与
`clearCodingPlanApiKey()` 已没有生产调用方；它们剩余的行为是把动态凭据和权益结果写回旧 Provider Store，
继续保留会让已经分离的账号事实重新汇入旧静态配置。

本轮删除两个公共方法、Service 实现、旧依赖注入和 29 个以旧 Store 改写结果为断言的测试。测试清理前先将
仍然有效的产品规则迁到 `codingPlanProviderAvailability.test.ts`，直接覆盖 Z.ai Start/Coding 未登录、互斥权益、
Coding 查询暂时失败时保留 Start 结果，以及已选 Team Project 校验暂时失败时保留上一版连接状态。权益规则
继续由新的 Account Connection Resolver 调用，不再依赖旧 Service 的刷新副作用。随两个调用入口一同失去
消费者的旧 Account Facts Emitter 和断开原因辅助函数也同步删除，避免继续暗示旧 Service 会发布账号事实。

`ModelProviderService.getAll()` 内部的旧 Preset 同步与 Entry Status 缓存暂时保留；它们服务尚未退出的首次
Personal Config 导入和旧兼容读取，不再对外提供主动刷新或清理入口。相关 6 个测试文件共 98 条测试通过，
全量 TypeScript 构建通过。

## 211. 一次性旧配置迁移退出 ModelProviderService

旧 Service 的两个真实消费者都只需要读取旧物理存储，不需要 Preset 同步、Entry Status、Family 过滤或任何
运行态投影。Local Host 的 Personal Config 首次导入改为直接调用旧 Store Reader；迁移输入因而只包含旧文件
本身的 Provider 值，不再经过 `getAllCached()` 混入账号入口状态。

Remote Workspace 本机侧为历史 Personal Coding Plan Key 保留一次性迁移。该链路新增窄函数
`loadLegacyAccountProviderApiKey(providerId)`，只读取指定 Provider 的旧 Key，交给 Account Credential Store
写入账号作用域凭据。Remote Workspace 不再为此构造或注册一套本机旧 ModelProviderService，相关工厂和仅验证
旧 Preset/ZAPI 行为的测试同步退出；模型选择和设置仍直接使用目标 Remote Environment 的 Registry 服务。

新增旧 Key 窄读取测试，并回归 Account Credential Store、Remote Workspace 服务装配和 Provider Config 首次
迁移。3 个测试文件 13 条测试通过，全量 TypeScript 构建通过。

## 212. 删除旧 ModelProviderService 公共服务面

完成首次 Personal Config 导入和旧 Account Key 迁移隔离后，生产代码已经不再需要旧
`IModelProviderService` 的配置、Snapshot、Preset Sync、连通性或运行时 Resolver 能力。继续保留这层
Accessor、RPC、Host 代理和服务注册，只会让已退出的 Provider 事实来源继续看起来像当前架构的一部分。

本轮删除 `IModelProviderService` 的公共类型、服务实现、Preset Sync、旧 Service Helpers、RPC channel、
Accessor/Proxy 暴露以及 Local Host、Remote Workspace、Server 的装配注册；同时删除只验证这些旧服务行为的
测试。Web/Renderer/Host 测试中的旧 service mock 也同步移除，测试改为验证当前的 Model Selection、Provider
Settings 和 Account Request Auth 边界。旧物理 `modelProviderServiceStorage` 文件保留，职责收窄为一次性迁移读取和
兼容数据写入；它不再通过服务实例参与运行时 Provider 事实构建。

这一步没有改变当前模型选择、设置保存或请求期鉴权逻辑，只删除已经没有生产消费者的公共入口。受影响测试通过，
全量 TypeScript 构建通过。

## 213. 收窄旧 Store 写入边界

删除旧 `ModelProviderService` 后，`modelProviderServiceStorage.writeProviders()` 已没有生产调用方。旧 Store
写入曾经是长期 Provider 配置服务的一部分；在当前架构中，运行时配置写入由 Personal Config Repository 和
Provider Settings Facade 负责，旧 Store 只承担迁移输入及迁移过程中的内部落盘。

本轮移除这个公共写入函数，并将原有原子写测试改为从旧 `model-providers.json` 触发真实一次性读取迁移，继续
验证 Windows rename 重试、临时文件清理，以及正式 Provider Config 接管原路径后不会被旧迁移覆盖。物理存储文件
仍保留读取和迁移内部函数，直到所有兼容迁移入口退出。

## 214. Settings 保存切换到结构化 Effective Config

设置页原先把旧 `ModelProviderConfig` 表单直接交给 Provider Runtime，由 Runtime 内部调用一次性迁移适配器，
这让旧表单类型继续成为 Settings Service 的写入协议，也使 Official Provider 与 Personal-only Provider
拥有两套保存入口。

本轮新增 `ProviderSettingsFacade.saveEffectiveProvider()`。它接收 Provider 和 Model 的结构化完整编辑态，
在当前 Registry Snapshot 的 Official Config 上计算稀疏 Personal Overlay，然后通过
`ProviderConfigService.replacePersonalConfig()` 一次原子替换 Provider 与精确 Model Config。Renderer 仍可
暂时使用旧表单，但转换逻辑被收拢在 `providerPersonalSave.ts`，Provider Service 不再认识旧表单，也不再提供
`saveLegacyPersonalApiProvider()` 或 `importLegacyProviderFormConfig()`。

这一步没有改变设置页的产品行为：保存后的排序、模型属性、reasoning 规则和 Official Override 仍按当前
Effective View 展示；变化只在写入边界，Personal Config 不再保存由 Official Config 展开的默认字段。新增与重命名
Provider、Official Provider 覆盖、模型精确配置和原子替换均由同一条 Facade 链路覆盖。相关 Provider、Services、
Renderer 测试通过，`pnpm typecheck` 通过，lint 保持 0 error。

## 215. M2.3c / M2.5c 生产事实源收口审计

本轮对计划中仍标记“实施中”的两项做了调用面审计。普通 API Provider 的生产路径在存在进程
`ProviderRegistry` 时统一走 `ApiProviderModelRuntime`；`provider-registry-app-runtime.test.ts` 已覆盖
Registry 模型创建、缺失模型直接报错、旧 Workspace Overlay 不进入执行 Registry，以及 Workflow 子 Runtime
复用同一进程 Registry。`createRuntimeModelFactory` 仍出现在 `turn-execution-model-source.ts`，它只负责
执行期临时模型来源，属于后续 execution-scoped Provider 范畴，不是普通长期 Provider 的事实读取。

同时确认，`presetModelDefaults.ts`、旧 `modelProviderServiceStorage` 和仍有消费者的 Preset 辅助代码中剩余的默认模型与映射
只通过一次性 Personal/Account 迁移或尚未装配新 Registry 的内部兼容 Entry 使用。它们不会参与新 Registry 的
Provider/Model 解析，也不会覆盖 Official / Personal / Account 的新配置事实。此处不删除代码，原因是当前内部
CLI/TUI/评测仍依赖这些兼容入口；删除应安排在对应消费者完成迁移之后，并单独验证迁移输入不会丢失。

因此 M2.3c 与 M2.5c 均可标记完成。后续清理目标是退出兼容消费者，而不是继续修改 Registry 的生产解析链路。

## 216. 删除无消费者的 OAuthPresetProviderRepo

符号级引用审计确认 `OAuthPresetProviderRepo` 与 `createOAuthPresetProviderRepo()` 均没有静态消费者；仓库中也没有
动态导入或字符串加载该模块。这个旧 Repo 曾同时读取 OAuth Token、拉取远端 Provider、拼接 Preset 模型与映射、
解析 Coding Plan Key，并产出旧 `ModelProviderConfig`。这些职责现在分别由 Account Config Source、Account
Credential Service、Request Auth 和 Official Model Config 承担。

本轮删除整个旧 Repo，以及只为它存在的 Provider Meta、Provider 列表和依赖类型；保留仍被当前请求鉴权使用的
Remote Client、Provider Resolver、Team Plan 类型与 shared helpers。`presetModelDefaults.ts` 和旧 Store 中仍有
消费者的部分继续限制在一次性迁移/兼容边界，不随本轮误删。

删除后 Services TypeScript 检查通过，Account Credential、Request Auth、Team Plan Key 和 Preset Shared 的
4 个测试文件共 21 条测试通过。这个切片不改变 Account Provider 产品行为，只移除已经失去入口的第二套构建器。

## 217. 旧 Provider Store 退出稳态 Preset 同步

符号级引用审计确认，旧 `modelProviderServiceStorage` 对外只剩 `readProviders()` 仍有生产消费者。它们分别读取
一次性 Personal Config 迁移输入和历史 Account Provider Key；Preset 模型收集、远端模型合并、OAuth Provider
Upsert、Fallback Provider 注入以及公开写入队列均已没有调用方。这些逻辑继续存在，会把已退出的稳态 Provider
拼装规则和硬编码模型列表留在迁移存储边界中。

本轮删除旧 Store 中无消费者的稳态同步尾部，保留多版旧 Schema 读取、物理文件迁移、旧 Account Key 读取，以及
迁移时仍需执行的历史字段归一化。随旧同步逻辑失去消费者的默认模型列表、Managed 模型过滤和 Claude 映射构造
也一并删除；`presetModelDefaults.ts` 只保留旧文件迁移仍在使用的 Provider 判定与 GLM-5.2 上下文修正。

这一步没有改变当前 Registry、设置页、模型执行或账号鉴权行为，只进一步把旧 Store 收窄为一次性迁移边界。
Services TypeScript 检查和 touched-file lint 通过，旧 Store 原子迁移、Personal Config 导入与 Account Key 迁移的
3 个测试文件共 7 条测试通过。

## 218. Account Key 请求退出旧 Preset Remote Client

删除旧 `OAuthPresetProviderRepo` 后，账号 Key 解析仍借用了它拆出的 Remote Client 和 Provider Resolver。调用面
审计确认，生产代码只使用通用业务接口请求与 `resolveProviderApiKey()`；`release/latest`、`client/configs`、远端
Provider/Model 事实转换、ZAPI Preset 构造与 Coding Plan Endpoint 构造均已没有消费者。它们继续存在会形成一条
看似仍可工作的远端 Official Provider 事实来源，与当前版本化 Official Config 冲突。

本轮将剩余能力收窄并按现职命名为 `AccountProviderApiClient` 与 `AccountProviderApiKeyResolver`。前者只解释业务
接口的 Envelope，后者只根据账号 Token 获取或复制 Coding Plan API Key。旧 Remote Client 的 Config Version
缓存、Client Config 拉取与 Provider 构建全部删除；只为这些能力存在的远端 Provider 类型、配置转发模块、共享
转换函数和测试同步退出。旧 Store 迁移仍使用的 BigModel 历史 URL 修正继续留在迁移文件内部；个人项目选择与
业务状态码判断分别收归 Account Key Resolver 和 Account API Client。

这一步不改变 Account Connection、Credential Store 或请求期鉴权语义。Services TypeScript 检查和 touched-file
lint 通过，Account Credential、Request Auth、Team Plan Key、Personal/Account 迁移等 6 个测试文件共 19 条
测试通过。

## 219. Preset 模型常量收归旧文件迁移边界

清理稳态 Store 与 Remote Config 构建后，`presetModelDefaults.ts` 只剩三个消费者，且全部位于旧 Provider 文件
迁移内部：识别历史 GLM Provider、识别固定上下文的历史 Plan Provider，以及修正 GLM-5.2 的历史上下文值。
这些规则不再构成当前 Provider 默认值，也不应继续以可复用模块的形态存在。

本轮删除该文件，把三条规则作为带 `legacy` 语义的私有函数内联到 `modelProviderServiceStorage`。新 Registry、
Official Config、Account Access 和模型执行均无法引用这些规则。Services TypeScript 检查和 touched-file lint 通过，
旧 Store 原子迁移、Personal Config 导入与 Account Key 迁移的 3 个测试文件共 7 条测试通过。

## 220. 剩余 Client Config 与 Account Access / Off-Peak 边界审计

旧 Preset Remote Config 退出后，仓库中仍有套餐服务请求 `client/configs`，并读取 `builtinModels`。调用链审计确认，
这份数据不再构造普通长期 Provider，也不进入进程级 Registry：Start Plan 的 `billing/balance` 只把当前账号允许的
Model ID 投影为 Account Provider Overlay 的 `models` 过滤；模型 Properties、Option Specs 与 Adapter 规则仍来自
Official / Personal Config。

`client/configs.configs.offPeak.allowed_models` 与同响应中的 `builtinModels` 目前只用于构造闲时任务的临时
`allowedModelConfigs`。它随本次任务下发 `turnRuntimeModel`，属于 execution-scoped Provider 的兼容输入，后续由
M4 迁入统一的临时 Provider Config / ModelFactory 链路。它不应回写长期 Registry，也不应在 M2 中被误当成普通
Official Provider 事实源删除。

因此 M2 的普通长期事实源仍保持唯一：Official、Personal 与 Account Access 三层 Config。剩余远端模型元数据
只有 execution scope，退出条件由 M4 管理。

## 221. 落地 Human in the Loop：撤回 ModelConfig.apiAdapter 包装层

Human in the Loop 第 11、12 项已经明确：配置层不再引入 `ModelApiAdapterConfig`，
`reasoningMapping` 直接属于 `ModelConfig`。此前代码和 Official Config 仍使用
`model.apiAdapter.reasoningMapping`，导致已经裁决撤回的包装层继续成为公共 Schema、
Personal 差量投影、Settings 投影和 Registry Model Runtime 的事实形态。

本轮将配置链路收敛为：

```text
ModelConfig
├─ properties
├─ optionSpecs
└─ reasoningMapping
```

Overlay、完整性校验、Schema 解析、Personal Config 差量投影和 Registry Runtime 现在都
直接读取 `reasoningMapping`。模型声明 `optionSpecs.reasoningLevel` 时，完整性错误路径
也直接指向 `reasoningMapping.<level>`。Official Config 的 44 条规则已从包装对象改为直接
字段；旧的 `preserveThinking` 与 `reasoningContentField` 没有迁入新格式。

旧 CLI 与旧 Desktop 配置导入仍保留正式的 `reasoningLevel` 和映射结果，但直接写入新的
字段。该改动没有改变 Adapter 收到的 Reasoning 参数，也没有改变 `apiMatch` 的规则顺序、
AI SDK namespace 投影或 GLM/Anthropic 的现有兼容参数；它只删除一个已经被人裁决撤回的
配置层级。Provider、Bootstrap、Services 和 UI 的针对性测试通过，后续不再接受
`apiAdapter` 作为新 Provider Config 字段。

## 222. Human in the Loop 收口审计

逐项复核当前实现后，Human in the Loop 第 1–13 项中会影响 M2 普通长期 Provider 的裁决
已经落地：Account Config 复用三层 Overlay，Registry 保留 last-known-good，任意 Model
Options、模型级 Header 与 Usage 开关均已退出，账号级 `accessId`、远端 Provider Authority、
Usage 解耦、`access/api` 分层、正式 v1 Config 和直接 `reasoningMapping` 均已进入生产链路。

第 14 项描述闲时任务的 Builtin Provider 与 Turn 级鉴权材料。它属于 M4 的
execution-scoped Provider 重构；当前 M2 只保证临时来源不会进入长期 Registry，不在本轮提前
设计鉴权能力。Standalone 登录后硬编码默认 `GLM-5.2` 也属于 Selection 初始化策略，后续由
Interaction 阶段改为从 Registry 候选产生，不作为 Provider 静态事实继续扩散。

Bootstrap 中按模型名补齐 Reasoning/媒体能力的剩余代码只服务尚未迁移的旧 Entry 与 Turn
临时模型。进程 Registry 拥有的普通 Provider 已直接读取 ModelConfig，不经过这些 Catalog
规则。

## 223. Workspace Catalog 退出 Registry 模型 preflight

Session preflight 原先同时使用 `app.listModels()` 和旧 Workspace Catalog 判断模型是否可用。
即使进程 Registry 已经发布当前模型，只要旧 Catalog 中还存在另一项可用模型，当前模型仍会
被否决并回退；回退顺序也会优先采用旧 Catalog，而不是 Registry 顺序。

现在进程 Registry 模式以 Registry-backed `app.listModels()` 作为成员和首项的唯一事实，
Workspace Catalog 只继续保存默认/最近选择状态。尚未装配 Registry 的旧 Entry 保留原有
Catalog 过滤，避免把隐藏 CLI base model 暴露为可选项。新增测试分别覆盖当前 Registry 模型
不被旧 Catalog 否决，以及模型删除后按 Registry 首项回退。

同一测试文件暴露了已有的 Turn 临时 GLM-5.3 默认档位回归：兼容层补齐档位时把 Host 明确
传入的 `high` 改成了 Catalog 默认 `max`。本轮保留合法的传入默认档位，只补齐协议映射；这不
改变长期 Registry，也不展开闲时鉴权重构。

## 224. 进程 Registry 退出 Workspace Provider 投影与 Runtime 回写

继续沿 Workspace Catalog 调用链审计后发现，成员 preflight 之外仍有四条旧事实回流：

- `syncAppWorkspaceModelCatalog()` 会把旧 Catalog Overlay 和模型容量写回 Registry App；
- `createWorkspaceZCodeApp()` 只检查直接传入的 `providerRegistry`，看不到 Entry 包装器注入的
  进程 Registry，仍可能生成旧 `bootstrapModelConfig`；
- Workspace State 会把 App Registry View 与旧 Catalog Provider 合并，并发布旧
  `providerRevision`；
- V4 冷恢复 usage 从旧 Catalog 查 context window，跨 Provider 切换也用旧 Catalog 判断成员。

这些路径会实际改变普通长期 Provider 的属性、可见成员或模型切换结果，直接违反 M2 唯一事实源，
因此没有按“旧协议以后再删”整体推迟。本轮在 `hasProcessProviderRegistry` 边界统一收口：旧
Workspace Provider 同步与 Host `runtimeModel` 写入成为 no-op；App 初始化不生成旧 bootstrap；
Workspace View 只展示 Registry-backed `app.listModels()`；切换目标 Provider 从同一 View 判断；
冷恢复 context window 使用当前 App Runtime 已固定的模型属性；旧 provider revision 不再冒充
Registry revision。

Workspace Catalog 仍保留 default、last-used、mode 等交互状态，并继续服务尚未装配进程 Registry
的旧 Entry。单轮临时 Provider 仍使用独立 Turn Overlay，完整生命周期和鉴权改造留给 M4。无生产
调用者的旧 Active Session Model Limits 辅助函数仅是清理项，不影响当前 Authority，后排处理。
同一审计中确认无调用者的旧 Session Settings 广播辅助函数已直接删除，避免继续暗示 Workspace
Provider Catalog 仍会主动驱动 Registry Session。

新增回归覆盖 Registry 模型不被旧 Catalog 否决、按 Registry 首项回退、旧 Overlay/Runtime
写入被阻止、切换目标 Provider 从 Registry View 判断、context window 取当前 Runtime，以及
Workspace View 不混入旧 Provider/revision。真实 Protocol 装配测试也改为只设置进程 Registry
标志，防止测试通过直接注入 App Options 掩盖线上装配缝隙。

进一步核对生产协议后确认，普通 `runtimeModel` 与闲时任务的 `turnRuntimeModel` 已有明确边界：
前者是 Host 派生的旧兼容快照，后者通过独立 Turn Overlay 进入单次执行。进程 Registry 模式阻止
前者写入 Workspace Catalog 不会截断闲时任务。旧协议字段暂时仍可透传并提交 ModelSelection，
但不能借此恢复普通 Provider 的 Host Snapshot 权威。

## 225. Workspace Read State 退出模型写入职责

继续审计 `runtimeModel` 协议入口时发现，`workspace/readState` 虽然名为读取接口，仍允许调用方
携带完整 `runtimeModel`。若 Workspace 已存在 Active Session，它会在构建返回投影前把其中的
thought level 写入 Session，并更新 `record.modelRuntime`。这使目录补水、窗口恢复或 Repo Wiki
准备都可能成为模型状态的隐藏写入者。

本轮将 `workspace/readState` 收敛为严格的只读投影：协议 Schema、Services 参数和 Bootstrap
实现均删除 `runtimeModel`；Active Session 只读取当前 App Runtime，不再由 Workspace 查询修改。
UI 的 `prepareWorkspaceWithZCodeSessionService` 同时删除 `preferredRuntimeModel`，Deferred Session
只提交 ModelSelection；Repo Wiki 也沿用同一入口。模型或 reasoning 的修改继续通过明确的
Session/Submission 命令完成。

回归测试先证明旧实现会接受该字段并调用 `setThoughtLevel("max")`，再固定新协议拒绝旧字段、
Active Session 不发生写入，以及 Deferred Session 请求不再携带 Host Snapshot。

## 226. Workspace Default Model 只保存 Selection

`workspace/setDefaultModel` 的调用方已经全部只提交 `ModelSelection`，但协议与 Services 类型仍允许
附加完整 `runtimeModel`，Worker 也会把它并入 Workspace Catalog 后再保存默认模型。这使“下一份
草稿默认选择”的写接口仍能顺带创建 Provider 事实，与进程 Registry 权威冲突。

本轮从共享协议、Agent/Session Service 参数和 Worker 实现中删除该字段。Services 不再执行
`model` 与 `runtimeModel` 的双字段一致性判断，也不再记录或转发派生快照。Workspace Default
继续保存 providerId、modelId 和独立 thought/mode 交互状态；真正创建草稿 App 时由目标
Environment Registry 校验 Selection 并创建 Model。

共享协议测试先固定有效旧 `runtimeModel` 必须被 strict Schema 拒绝；Bootstrap、Services 与 UI
相关回归确认默认模型写入和草稿准备行为保持不变。

## 227. V4 普通模型命令退出 Host Runtime Snapshot

V4 `createSession` 与 `switchModelConfig` 虽然生产调用方已经只提交 Selection，共享 Schema、
Command Handler 和 Bridge 仍保留 `runtimeModel` 回落：Host 可以把完整 Provider 运行快照交给
Worker，Bridge 再把它安装进旧 Workspace Catalog。这与目标 Environment Registry 权威冲突。

本轮删除两个命令的 `runtimeModel` 字段，把 Bridge 能力收窄为 `ensureProviderAvailable()`：它只在
Worker 当前 Registry 中校验 providerId，不接收或安装 Provider 快照。闲时任务的
`sendText.turnRuntimeModel` 保持独立，继续表达 execution-scoped Model。

回归测试还暴露出 Repo Snapshot 旁路在没有 `runtimeModel` 时会调用 `workspace/readState` 猜测本轮
Provider，不仅可能阻塞旁路上传，也会重新消费旧 Workspace 模型状态。现在旁路只使用命令明确
携带的 Selection 或临时 Turn Model；缺少时允许模型元数据为空，真实请求归因继续由 Model 的
Usage/Trace 负责。

## 228. 旧 Session 协议退出 Host Runtime Snapshot

V4 普通模型命令收口后，旧 Session 协议仍允许 Host 在 create、resume、send、compact、
setModel 与 setThoughtLevel 中携带完整 `runtimeModel`。Worker 会把这份快照写入 Workspace
Catalog、更新 App Runtime，并使用 `modelRuntimeRevision` 维护一套 Host/Worker CAS。即使生产
调用方已经不再发送，该协议能力本身仍能重新建立第二 Provider 事实源。

本轮从共享协议、Services 公共类型和 Bootstrap 实现中删除普通 Session 的 `runtimeModel`、
`expectedModelRuntimeRevision` 与 `modelRuntimeRevision`。Session 创建和恢复只接收持久化或显式
ModelSelection；模型和 reasoning 的明确修改继续走对应命令，Worker 使用所属 Environment 的
Registry 校验并创建 Model。与 Host Snapshot 一起存在的 Worker 派生缓存、revision 比较、刷新和
错误分支同步删除。

V4 `sendText.turnRuntimeModel` 保持不变。它是闲时任务当前 Turn 的 execution-scoped 输入，通过
独立 Turn Overlay 创建 Model，不写入长期 Registry。Repo Snapshot 的旧 Session 旁路在没有明确
执行模型时不再猜测 Workspace 模型元数据；真实模型归因继续由执行 Model 的 Usage 与 Trace 负责。

共享协议、Services/V4 与 Bootstrap 针对性测试共 285 条通过；根 TypeScript 与 Bootstrap
TypeScript 检查通过。旧行为测试已经删除，只读 Workspace State 与旧字段拒绝测试继续保留。

## 229. 新 Staging 功能按目标 Environment Authority 重新接线

远端 `staging` 被团队回退并重建后，Provider 分支整体 rebase 到新的提交图。新基线新增了
Subagent 设置页的模型目录对账能力：当设置表单发现目标 Workspace 缺少模型时，旧实现先把
Host Registry 注入 Worker，再读取 Workspace State。这会重新建立已经由 M2 删除的第二事实源。

本轮保留缺失检测、请求过期保护、一次重试和设置表单投影，只把同步链路收敛为：

```text
目标 Environment Worker Registry
        |
        | workspace/readState
        v
Renderer 设置表单投影
```

Renderer 不再向本地或远端 Worker 注入 Host Registry。目标 Environment 自己维护 Registry，
设置页只重新读取目标运行环境发布的模型目录。两组专项测试覆盖直接读取、过期结果丢弃、失败重试
和 Remote Session 切换，共 9 条通过。

同一次 rebase 中，新基线新增了 Start Plan 多套餐和额度桶测试。这些测试仍直接使用已经退出的
`ModelProviderService` 构造参数，导致迁移后的 Provider 无法取得 `accountAccessId`，请求在鉴权前
退化为未配置。本轮只把新增用例接入现有 `createProviderForTest()` Account Request Auth 装配；
多套餐顺序、非 active 套餐过滤、额度桶 `planId` 和缺失 `expires_at` 的生产逻辑均保持新基线语义，
没有恢复旧 Provider Config 凭据读取。Plan 与设置相关测试共 230 条通过。

冲突处理遵循同一原则：保留新基线的产品功能和数据契约；凡是依赖旧 Host Snapshot、旧 Workspace
Registry 注入或旧 Provider Service 的实现，都改接目标 Environment Registry 与请求期鉴权，不把
团队已经回退的旧 staging 提交重新带入新分支。

## 230. Process Registry 成为协议 Entry 的必备依赖

最终退役审计确认，Bootstrap 仍允许缺少进程 Registry，并以 Workspace Provider Catalog 补齐
Provider、Model、Properties 和 revision。这条 fallback 会让直接构造 Bootstrap App 的 Harness
继续通过，同时掩盖生产 Entry 的装配错误。

本轮将进程 Registry 改为协议 Entry 的必备依赖。缺少 Official 或 Personal Config 路径时启动
直接失败；生产 Entry 和测试 Harness 均显式装配 Registry。`hasProcessProviderRegistry` 分叉被删除，
`workspaceModelCatalogs` 收缩并更名为 `workspaceModelPreferences`，只保存 default、last-used、
thought level、mode 与 revision。Provider 成员、模型属性、context window 和回退顺序统一来自
Registry View。

普通 Session 的 Host Runtime Snapshot 已经退出；闲时任务的 `turnRuntimeModel` 继续作为单次
Execution Overlay，不写入 Registry 或 Workspace Preferences。

## 231. 设置表单 DTO 的上线边界

清理评估原计划让设置页面在 M2 内彻底退出旧 `ModelProviderConfig`。进一步检查后确认，这个类型
当前只作为 Renderer 内部的表单 DTO：Settings View 投影为可编辑表单，保存时再生成正式
Provider/Model Config。它不读取文件、不构建 Registry、不决定模型是否可选，也不创建执行 Model。

将整套设置表单同时改写会扩大上线前的 UI 回归面，却不会进一步收敛事实源。因此本轮保留这层
隔离适配，并把它明确记录为后续设置体验重构的删除点。旧物理格式导入也继续使用私有 Legacy
形状；两者都不能被 Registry 稳态路径依赖。

## 232. M2 最终验证

退役清理完成后，根目录 `pnpm typecheck` 与 `pnpm lint` 通过，lint 为 0 error；Services/UI
针对性测试 10 个文件共 117 条通过，Bootstrap 针对性测试 6 个文件共 219 条通过，Bootstrap
独立 typecheck 通过。

Bootstrap 全量测试另行暴露了已有测试债务：Session Persistence mock 缺少新方法、Native Boundary
已有跨域导入，以及若干历史 timeout。本轮没有把这些失败包装成 Provider 回归，也不宣称全量套件
通过；上线交付中保留该验证边界。

## 233. 最新 Staging 的官方 MCP 与 Usage 适配

最终上线 rebase 时，`staging` 新增了官方 Server MCP 身份头、MCP 额度展示和统一额度重置弹窗。
原实现通过已经由 M2 删除的 `ModelProviderService.getProviderRegistrySnapshot()` 判断 Coding Plan
Provider 是否存在，并在测试中直接向 Usage Provider 注入旧 Provider Config。

冲突处理保留新功能的产品语义：MCP 身份头、五类身份字段、额度请求、独立 MCP 额度条、统一重置
弹窗和动态上下文面板宽度均保留。Provider 存在性改读正式 `ModelSelectionView`，Usage 鉴权改用
`AccountRequestAuthService` 与 `accessId`，没有恢复旧 Snapshot 或旧 Provider Service。

rebase 后根 typecheck 和 lint 通过；MCP、Usage、Provider、Repo Wiki、模型选择与 UI 针对性测试
15 个文件共 258 条通过，Bootstrap Registry/协议测试 6 个文件共 219 条通过。当前本地 Node 22
低于仓库声明的 Node 24，标准流水线仍需在正式运行时完成最终复核。

## 234. Workspace Snapshot 删除重复 Provider Catalog

最终协议审计发现，`workspace/readState` 在已经返回 `settings.model` 的同时，仍额外返回一份
`modelCatalog`。这份结构重新把 Provider、模型属性和 revision 投影到旧协议中；UI 已经不再消费，
唯一业务读取者是闲时首次派发，Workspace `state.updated` 发出的 `{ modelCatalog }` 也无法被
Services 现有 Settings 解析器识别。

本轮删除 `ZCodeWorkspaceModelCatalogState`、Snapshot 字段、Bootstrap 映射和 Provider 分组逻辑。
闲时派发改为直接继承目标 Environment 已解析完成的 `settings.model.current`，并在
`settings.model.available` 中验证其仍然可用。Workspace 更新通知发送同一份 Settings Patch，
default、thought level 与 mode 的 revision 语义保持不变。

引用审计同时确认 `convertModelProviderConfigToZCodeProviderInput()` 已经没有生产调用者，只剩旧
协议投影专项测试，因此连同其私有 endpoint、媒体能力与 Provider 转换辅助逻辑一起删除。CLI
Adapter 内部仍名为 `modelCatalog` 的 reasoning/capability 迁移结构属于执行侧兼容边界，本轮没有
混同处理。

Shared、Services、Bootstrap 与 UI 针对性回归共 299 条通过，根 TypeScript 与 lint 检查通过；
lint 为 0 error、36 条当前基线 warning。

## 235. 删除 App 的 Workspace Provider Overlay 写入口

协议与 Snapshot 清理后继续审计 Bootstrap，发现 `ZCodeApp.setModelCatalogOverlay()` 已经没有生产
调用者，但 App 仍保存 Workspace 级 Provider/Model Overlay，并会把它混入模型列表、Properties
和旧 Adapter Registry。它使已退出协议的完整 Workspace Snapshot 仍可从公共 App API 重新进入，
与进程 Registry 的唯一事实源原则冲突。

本轮先把测试改为要求 App 不再公开该入口，确认旧实现失败后，删除 Workspace Overlay API、状态、
监听器与测试假对象。`RuntimeModelOverlayManager` 现在只管理 Turn Overlay；闲时任务等单次执行仍可
注入临时 Provider，普通长期 Provider 无法再通过 Workspace Overlay 旁路 Registry。

Overlay 专项测试 5 条、Registry 写入口测试 1 条、Session Facade、冷恢复与闲时 Overlay 回归 45 条
通过。完整 Registry App 测试的 6 条断言均通过，但 Node 22 下 MCP 测试进程关闭时出现已有的
`ERA_NEGOTIATION_FAILED` 未处理拒绝，Vitest 因测试基础设施噪声返回非零；该问题与本次 Overlay
删除无调用关系，正式全量验证继续使用仓库要求的 Node 24。

## 236. 裸 App Factory 的 Legacy 删除改为测试基座迁移

Workspace Overlay 删除后，审计继续发现 `createZCodeApp()` 仍允许不注入 Process Registry，并保留
旧 Runtime Config、Model Catalog 与 `includeLegacyProviderModels` 分叉。先补门禁测试并在工厂入口
拒绝缺少 Registry 后，正式 Registry 用例按预期通过，但 Bootstrap 的 Session Persistence、MCP、
Workspace Hook 与 Script Workflow 套件共有 56 条用例失败。

失败并非简单缺少一项参数：部分用例仍在验证旧 CLI Provider Config，其他用例注入旧 ModelPort
形状而没有新 ModelFactory 需要的 `createModel()`。使用一份静态假 Registry 会改变测试语义并掩盖
真实迁移缺口。因此本轮撤销尚未提交的 App Factory 门禁，不把不可信的机械迁移带入上线分支。

正式 Prompt CLI、TUI 和 Protocol Entry 已经先启动并注入 Process Registry，生产事实链路不受影响。
后续独立切片需要先迁移或删除旧 Provider 专项测试，再把其他 Harness 改成真实 Registry Model
Fixture，同时更新 Compact/Memory E2E 与 Prompt Trajectory 工具；完成后删除裸 App Legacy 分叉。

## 237. 上线分支最终同步与验证

远端 `staging` 前进到 `a9a3a40a53`，新增 MR 平台默认构建策略与 CI 修正。M2 的 7 个提交无冲突
rebase 到该基线，没有恢复团队已经删除的实现，也没有改变 Provider 代码。

rebase 后，Model Overlay、Session Facade、V4 冷恢复和闲时 Turn Overlay 共 50 条测试通过；
Registry App 的 Workspace Overlay 写入口测试 1 条通过。根目录 TypeScript、Bootstrap 独立
TypeScript 与 lint 通过，lint 为 0 error、36 条当前基线 warning；`git diff --check` 通过。
Human in the Loop 全部条目均为已确认、已完成或明确被后续裁决取代，没有新的待确认语义。

## 238. 完成裸 App Factory 与内部 Harness 迁移

最终上线审计重新执行了第 236 项中暂缓的迁移。先以门禁测试固定 `createZCodeApp` 缺少 Registry
必须失败，再把 Session Persistence、MCP、Workspace Hook、Script Workflow 等测试切换到
Registry-backed Harness。Harness 使用完整 Model Config 和可执行 Model Factory，继续保留原测试
注入的模型响应，不用空 Registry 掩盖执行差异。

Compact/Microcompact 与 Memory E2E、Prompt Trajectory 录制工具改为显式构造测试 Registry。Compact
Harness 文件只保留 Permission、Storage、Feature 等非 Provider 设置，Provider Fixture 单独作为
测试输入读取；旧 CLI `provider` / `model` 字段不再承担执行事实。

生产侧随后删除 `bootstrapModelConfig`、无 Registry Runtime Model Factory、旧模型列表拼接和
`includeLegacyProviderModels` 分叉。`RuntimeModelOverlayManager` 同时收缩为纯 Turn 临时 Provider
容器，不再具备用旧 Config 刷新 Adapter Registry 的第二种运行模式。

过程中自主处理了两项测试维护：Registry 测试显式关闭与用例无关的 MCP，避免关闭期协商拒绝；
Telemetry Lifecycle Harness 增加空的 Official/Personal Config 路径并补齐最新 MCP Pool mock。这些
变化只让测试满足正式 Entry 的必填装配，不改变产品语义。Human in the Loop 复核没有新增待裁决项。

## 239. 删除旧 CLI Config 的隐式执行入口

裸 App Factory 收口后继续审计执行侧，发现 `createModelAdapter()` 在调用方没有提供任何模型输入时，
仍会自行读取旧 CLI Config；Prompt Trajectory 和 BigModel WebSearch Probe 也会把同一文件作为默认
模型来源。它们绕过了 Process Registry 的正式装配，因而会让已经退出生产 Entry 的旧 Provider
事实通过内部工具重新进入执行链。

本轮将 Model Adapter 工厂收紧为显式依赖：调用方必须提供 Registry Config，或者提供仅用于当前
执行的 Runtime Model Config。TypeScript 类型和运行时门禁共同保护这项约束。Prompt Trajectory
要求 Fixture 或命令行显式提供模型身份、Endpoint 与凭据来源；WebSearch Probe 同样改为显式参数，
不再读取旧用户文件。旧 `updateModelSelectionInFileConfig()` 只有专项测试引用，已连同测试删除，
因此模型选择不能再被写回旧 CLI Config。

旧 Config Schema、Parser 和文件读取仍保留给 Personal Config 首次导入，以及 MCP、Hook、Permission
等尚未迁移的 Harness 设置。它们可以解释旧物理格式，但稳态模型执行不会消费其 Provider、Model
或 Model Catalog 字段。这是迁移边界与运行事实边界的明确分离，不是第二条 Provider 链路。

Bootstrap、Adapters 与 Prompt Trajectory 针对性测试共 86 条通过，三个包的独立 TypeScript 检查
通过；根目录 TypeScript 与 lint 通过，lint 为 0 error、36 条当前基线 warning。

提交后远端 `staging` 又前进 7 个提交。本分支的 10 个提交无冲突 rebase 到 `24ef10c138`；
`range-diff` 确认已有 8 个后续提交补丁等价，首个主体提交只因上游相邻上下文变化重新生成，
本轮旧事实源删除作为新增第 10 个提交保留。rebase 后上述 86 条针对性测试、根目录 TypeScript
与 lint 再次通过。

## 240. 通用 RuntimeConfig 退出旧模型事实

继续沿旧 CLI Config 的消费链审计后，确认正式 App Runtime 已经只从 Process Registry、Session
Selection 和显式 Turn Overlay 取得模型，但通用 `RuntimeConfig`、`ConfigPort` 和 Config 来源元数据
仍保存 `model`、`modelCatalog` 与 `hasModel`。这些字段已经没有正式执行消费者，却会让后续代码误以为
旧 CLI 文件或 `ZCODE_MODEL` 仍是可用的稳态事实源。

本轮先增加失败测试，固定旧文件和环境变量模型字段不能进入 `createConfig().config`，随后删除
`RuntimeConfig` 与 ConfigPort 中的模型字段、四个 Model Config Key 和来源 `hasModel` 元数据。
旧 Schema 与 `RuntimeConfigPatch` 中的兼容字段暂时保留并标记 deprecated，服务于 Personal Config
和 Configured Default 的一次性迁移；它们在 ConfigPort 边界被丢弃，无法再影响 Agent Runtime。

CLI 全包 TypeScript 检查随后暴露出 Prompt CLI 与 TUI 的装配类型仍把 Process Registry 启动器视为
可选依赖，实际 `createZCodeApp` 已经要求 Registry。正式 Entry 因此改为在启动器缺失时直接报告装配
错误，并始终向 App 注入 Registry；三个通用 CLI 测试基座补入最小 Registry Runtime，专项生命周期
用例继续验证 Prompt CLI 借用后释放、TUI 跨 App 替换复用同一进程 Registry。该调整没有增加新的
模型来源，只把类型和测试基座收敛到已经生效的生产约束。

这一切片没有改变 Turn Overlay：闲时任务等 execution-scoped 临时 Provider 仍通过显式 Submission
输入创建 Model，继续属于 M4 迁移边界。没有新增 Human in the Loop 裁决项。

验证结果：Adapters 全量 86 个文件、1327 条通过，3 条跳过；Bootstrap Runtime Config、Process
Registry Runtime 与 Legacy Importer 共 41 条通过；CLI Registry 生命周期 2 条、CWD 与输出格式
18 条通过；根目录 TypeScript 检查通过。CLI 整份历史单元文件在当前 Node 22 环境中仍被一个与
Provider 无关的 Skill 用例失败打断，并连带取消后续异步清理用例，因此本轮只记录已隔离通过的
相关用例，不将该文件误报为全量通过。
根目录 lint 同时通过，保持 0 error、36 条基线 warning；CLI 独立 TypeScript 检查通过，
`git diff --check` 通过。

## 241. 最新 staging 对齐与上线前复核

远端 `staging` 在收尾期间前进 6 个提交至 `cf009a3b19`。M2 的 12 个提交全部无冲突 rebase，
没有执行人工冲突选择，也没有恢复上游已经删除的代码。rebase 后根目录 TypeScript 与 lint 通过，
lint 保持 0 error、36 条基线 warning；Runtime Config 边界测试 63 条、Bootstrap Registry 与 Legacy
Importer 41 条、CLI Registry 生命周期 2 条、CWD 与输出格式 18 条均通过。

一次错误的测试筛选命令触发了 Adapters 与 Bootstrap 全量套件，暴露出已有的执行 timeout、V4
跨协议边界、Session Resident Pool 和 Session Persistence 时序失败。随后使用明确文件路径重新运行
本轮相关用例并全部通过；这些全量基线债务没有通过 Provider 收尾代码兜底或改写。

## 242. 旧模型文件解析退出通用 Runtime Config

第 240 项已经让正式 `RuntimeConfig` 与 `ConfigPort` 退出模型事实，但 `RuntimeConfigPatch` 仍保留
deprecated 的 `model` / `modelCatalog`，通用环境变量解析器和 Config Merger 也继续构造、合并这些
字段。它们虽然会在后续边界被丢弃，却仍把 `ZCODE_MODEL`、`ZCODE_BASE_URL` 和旧文件 Schema 表现成
有效的普通运行配置入口。

本轮先修改测试，要求旧模型环境变量被通用 Config 忽略，并要求旧文件的模型兼容语义由专用迁移
解析器继续完整覆盖。随后从 `RuntimeConfigPatch`、Env Adapter、Config Merger 和通用文件投影中删除
模型字段，新增 `parseLegacyCliModelConfig()` 作为 Personal Config 与 Configured Default 首次迁移的
唯一入口。复杂 Provider、能力和 reasoning 兼容转换仍然保留，但其类型和调用点明确限定为旧 CLI
迁移，不再通过通用 Config API 对外暴露。

Adapters Config 定向测试 62 条、Bootstrap Legacy Importer 9 条通过；Contracts、Adapters 与 Bootstrap
独立 TypeScript 检查通过。该调整没有改变旧文件的一次性迁移结果，也没有改变 Turn Overlay、当前
Session Selection 或 Adapter 执行语义。Human in the Loop 没有新增待裁决项。

## 243. Account 刷新时序与 Connectivity 测试收尾

MR 静态审查发现，`AccountProviderService` 的当前刷新轮如果失败，会提前退出循环。失败期间到达的
Config 或账号事件仍留在 `pendingReasons`，但 in-flight 释放后没有执行者继续处理，Registry 可能一直
保留旧 Account Snapshot，直到未来偶然出现第三个事件。

本轮先增加时序测试复现：初始化成功，刷新 A 阻塞，事件 B 到达，A 失败；旧实现只调用两次 Resolver。
修复后，A 的原调用方仍收到失败，Service 发布 `onDidRefreshError` 并保留 last-known-good；释放 A 的
in-flight 后自动为 B 启动下一轮，成功后发布新 Snapshot。Provider 成员、失败策略和事件合并规则均未
改变。

同一次静态审查还发现 Connectivity 的三个专项测试仍调用旧 `endpoints/model/provider` 参数。生产设置页
已经使用正式 `baseURL/modelId/modelConfig/providerId` 接口，因此测试改为直接构造当前 Model Config，
继续验证 URL、Header、默认 reasoning mapping 和无 mapping 行为，没有修改生产 Connectivity。

Account Provider Service 6 条、Connectivity Probe 3 条测试通过；Provider 独立 TypeScript 检查通过。
两项均是已确认语义下的实现与测试收尾，没有新增 Human in the Loop 裁决项。

## 244. Personal 投影与原子保存收尾

MR 静态审查继续发现三处实现偏离已经确认的 Config Overlay 规则。

第一，设置页保存 Account Provider 的 Effective Config 时，会把 Account Overlay 动态注入的 `accessId`
投影进 Personal Config。修复后，Official 与 Effective Access 同为 `zhipu-account` 时，Personal 投影忽略
动态账号身份；账号可用性继续只来自 Account Provider Source。

第二，`reasoningMapping` 在 Model Overlay 中是普通值字段，后层应整体覆盖前层，但旧投影函数会在档位
内部继续求差异。修复后，Mapping 未变化时不写 Personal 字段，发生变化时保存完整字段，读取与写入
使用同一种 Overlay 语义。

第三，`ProviderSettingsFacade` 原先根据 Registry 的旧快照计算整份 Personal Config，再进入 Repository
文件锁执行全量替换。另一个进程在快照之后、加锁之前写入的无关 Provider 会因此丢失。现在 Effective
保存由 `ProviderConfigService` 在 Repository `update()` 内完成：锁内读取最新 Personal Config，只更新
目标 Provider 和它的精确模型规则，并保留 Pattern 规则及其他 Provider。完整替换接口只继续服务配置
迁移和显式全量导入。

三项均先补充失败测试，再修改实现。Provider Config Service、Facade 与 Personal Projection 共 18 条
测试通过。它们落实既有 Official、Personal、Account 分层、普通字段整体覆盖和 Repository 原子更新
原则，没有新增 Human in the Loop 裁决项。

## 245. 新建 Provider 退出 Settings View 前置条件

设置页仍使用旧编辑 DTO 的迁移适配器。编辑已有 Provider 时，适配器需要当前 Settings View 补齐表单
没有直接暴露的继承字段；但新建 Provider 尚未进入 Registry，当前 View 天然不存在对应项。Renderer
因此会在调用 Config Service 前直接抛出“尚未出现在 Settings View”，使新建自定义 Provider 无法保存。

本轮先增加失败测试，再把 View 调整为保存边界的可选继承输入。新建时直接使用 Add Provider 表单中
已经完整构造的 Provider 和 Model Draft；编辑已有 Provider 时继续复用 View 的 Effective Config。
连接测试使用同一 Draft 构造函数，因此新建表单也能在保存前发起连接测试。这个修复没有重写设置页
DTO，也没有改变 Official Provider 的继承与 Personal 投影规则。

设置保存、Draft 与 Provider Config 相关 46 条测试通过。完整设置页退出旧 DTO 仍作为 R1 后续切片，
新建 Provider 的上线阻断不再依赖该大范围迁移。

## 246. OAuth 重登强制刷新账号级 Coding Plan Key

账号级 Coding Plan Key 使用包含账号身份的 `accessId` 缓存。Resolver 原先只有在刷新 reason 包含
`oauth-callback` 时才跳过缓存，但 Renderer 在真实登录完成链路中发出的是
`oauth-login-entitlement`。同一账号登出后再次登录时，Account Source 因此可能直接复用旧 Key，而不是
根据新的 OAuth Token 重新取得请求凭据。

本轮先把 Config Source 测试切换到真实 Renderer 事件并复现失败，再让 Resolver 同时识别实际登录事件
与历史 callback 事件。登录后的权益刷新现在强制跳过账号级 Key 缓存；远端取 Key 成功后覆盖原账号
作用域凭据，失败时不会回退旧值。

Account Config Source、Connection Resolver、Credential Service、Request Auth 与 OAuth Logout 共 20 条
测试通过。登出时精确删除账号作用域 Key 仍需要 OAuth Service 在清除 Session 前传递账号身份，本轮没有
为解决数据清理问题扩大 OAuth 生命周期接口；该剩余项继续记录在 MR 审查 R6。

## 247. 删除无消费者的旧 Services Provider 存储

M2 继续按“能够减少当前双轨就立即清理”的原则审计 Services。`knip` 找到四个完整的未使用文件：
`codingPlanCache.ts`、`atomicFileRepo.ts`、`glmWorkspaceConfigRepo.ts` 和 `providerSettingsJson.ts`。
无 scope 的 `dep:refs` 逐项确认所有导出均没有静态引用或再导出；全仓字符串扫描也没有发现动态导入、
脚本或测试消费者。

这些文件分别保存旧套餐入口状态、读写 GLM workspace Provider 配置、提供未接入正式 Config
Repository 的原子文件草稿，以及解析旧 Provider settings JSONC。它们已经不参与当前产品行为，却仍
保留了重新建立旧 Provider 物理事实源的完整代码形状。本轮先增加失败的结构门禁，再删除四个文件。

结构门禁 4 条和根 TypeScript 检查通过。Human in the Loop 复核仍为 16 项均已确认，没有新增需要人
裁决的产品语义或公共契约。

## 248. 请求鉴权退出当前 Registry 重解析

MR 静态审查 R5 发现，已经创建的 Account Model 在每个请求 attempt 取得新 API Key/Header 后，会再次
调用当前 AI SDK Registry 的完整 `resolve()`。如果 Provider Config 在同一 Agent Loop 内热更新，这次
鉴权刷新会同时换掉旧 Model 的 SDK Factory、Endpoint、协议、Provider Options 和静态 Header，违反
Model 在一段连续执行中保持身份与静态执行配置不变的既定契约。

本轮先增加失败时序测试：创建使用 Provider A 的 Model，热替换 Registry 为同 ID 的 Provider B，再触发
请求鉴权；旧实现实际调用 B。修复后，Adapter 在 Model 创建时通过 `bindModel()` 捕获 Provider 静态执行
快照。请求鉴权只把当次 API Key/Header 合并到该快照，并据此创建 attempt 使用的 SDK Model；Registry
热更新只影响以后创建的 Model。代理、物理路由和请求安全校验继续由 Adapter 请求设施动态管理，不成为 Registry
静态事实。

Adapters Model 与 Registry 56 条测试、Adapters 独立 TypeScript 检查通过。该修复落实既有 Model 生命周期
设计，没有新增 Human in the Loop 裁决项。

## 249. OAuth 登出精确清理账号级 Coding Plan Key

第 246 项已经保证重新登录后强制刷新账号级 Personal Coding Plan Key，但显式登出仍在 OAuth Session
清空之后才通知派生 Provider 清理。此时 Logout Handler 只能删除历史无账号作用域 Key，无法构造当前
`coding-plan:<provider>:account:<identity>`，旧账号 Key 会留在 Credential Store。

本轮先修改失败测试，要求 OAuth logout 在通知中携带清理前的 Profile ID，并要求 Logout Handler 同时
删除账号作用域与历史无作用域 Key。实现现在于 Session mutation 内、清理主会话之前捕获账号身份；显式
logout、unlink、过期 JWT 失效和 logout-all 都把该身份传给同一 Handler。凭据损坏恢复无法可靠读取身份
时保持原 fail-safe：清 OAuth 主事实、下线 Account Provider，并清理能确定的旧 Key。

OAuth Service 与 Logout Handler 78 条测试通过。该修复补齐 MR 审查 R6 的剩余清理问题，没有改变账号
可用性、重新登录刷新或 Team Plan 请求期解析规则，也没有新增 Human in the Loop 裁决项。

## 250. 删除孤立的旧模型覆盖 Header

继续运行 `knip`、无 scope `dep:refs` 和全仓字符串扫描后，确认
`providers/codexModelOverride.ts` 只导出 `X-ZCode-Codex-Model-Override` 常量，引用、再导出和动态使用均为
零。当前模型选择、Submission、Registry、Request Auth 与 Adapter 请求都不读取该 Header；它已经不是
一项兼容行为，而是孤立的旧入口形状。

本轮先把该文件加入 M2 Legacy 结构门禁并验证失败，再删除文件。结构门禁现在覆盖 5 个退役文件并全部
通过。没有改变外部 Agent CLI 自身的模型参数或 Changelog 生成脚本，也没有新增 Human in the Loop
裁决项。

## 251. 全量校验修复退役 Registry 测试夹具与 Server Core 源码启动

上线前首次完整执行 `verify:pre-push`，Provider 主链路测试暴露了两处随 M2 接口切换遗漏的测试与
源码运行边界。

Official MCP 路由测试仍向 `ZCodeAgentService` 注入已经退役的 `providerRegistrySource`。Service 当前
通过 `ModelSelectionView` 判断 Provider 与模型是否就绪，因此旧夹具实际没有提供任何可执行模型，9 条
测试都在启动门禁处提前结束。夹具现在改为注入正式的 `modelSelectionReadinessSource`，继续测试原有
MCP 鉴权与远端路由行为。

Server Core 正式构建通过 tsup 嵌入 Official Provider Config；运行时集成测试则用 `tsx` 直接启动源码，
没有编译期常量，Core 会在发送 ready 前退出。Core 现在接受显式的
`ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE` 作为源码运行、开发和测试入口；未显式提供时，正式 bundle 仍
物化自身嵌入的 Official Config。两条路径都指向同一种版本化 Official 文档，没有回退旧 Provider Store
或新增第二事实来源。

Official MCP 与 Server Runtime Integration 共 11 条测试通过。完整 pre-push 中另外两组失败来自
`ConversationDraftSuggestedPrompts` 样式断言和 `appARMSBootstrap` 源码字符串断言；对应实现文件与测试
文件的 Git blob 均和 `origin/staging` 完全相同，确认不是 M2 引入。按照本阶段只运行一次全量 pre-push
的约定，后续使用根 TypeScript、Lint 和所有改动相关的定向测试完成收口。

## 252. 删除 Renderer Workspace Model Mirror 死链

继续以 Knip 审计 Renderer 后，发现 `workspaceModelMirror.ts` 整文件已经没有消费者。它保留了一条按
Workspace Identity 串行调用 `setWorkspacePreferredModel` 的异步镜像队列，属于旧 Workspace 模型状态
需要由 Renderer 主动追平时留下的辅助层。当前 Composer 与 Session 的模型选择已经使用
Session-aware Selection 控制链路，这两个导出函数的静态引用、再导出和全仓字符串引用均为零。

本轮先增加失败的 Renderer M2 结构门禁，再删除该文件。门禁测试和 UI 独立 TypeScript 检查通过。
Human in the Loop 复核仍为 16 项全部确认；删除无消费者镜像没有引入新的状态、时序或产品语义裁决。

## 253. Desktop E2E Direct Seed 收敛到 Personal Config

上线前继续审计测试夹具时，发现 `custom-openai-provider-store` 仍把同一个 Replay Provider 同时写入
旧 `model-providers.json`、旧 CLI Config 与 App `config.json`。夹具注释还把这种三写描述为保证
UI 与 Agent 一致所必需，因而会让测试持续掩盖 M2 已经删除的双轨事实来源。

本轮先增加失败测试，固定 Direct Seed 的正式边界：只写版本化 Personal Provider Config；不创建旧
Provider Store；不修改 CLI Config 中的 MCP 等非 Provider 内容。实现随后直接复用 `@zcode/provider`
的 Config 类型、精确 Model Rule 与序列化格式。E2E 调用方暂时需要的旧 `ModelProviderConfig` 只在
函数返回值和诊断读取时生成，属于测试 View，不再持久化。

`desktop-app.readModelProviders()` 同时增加了从正式 Personal Config 生成旧测试 DTO 的投影，使已有
E2E 断言可以逐步迁移，而不会迫使夹具恢复旧文件。新增单测与 Desktop E2E TypeScript 检查通过。
Human in the Loop 仍为 16 项全部确认；该改动只落实既有单一事实源裁决。

## 254. Restart E2E 退出旧 Provider 与启动模型配置

后续审计发现 Restart E2E 仍有第二套三写 helper：Replay Provider 同时写旧 Provider Store、旧 App
Provider 形状与 CLI Provider Config；Turbo 冷启动默认模型则连同整份 Provider、Model reasoning 参数写入
Project CLI Config。这些夹具会让重启用例继续依赖已经退出生产链路的旧事实来源。

本轮先为两条行为增加失败测试。Replay Provider 现在只通过 `ModelConfigRules.replaceExactForProvider()`
写版本化 Personal Config，并保留已有 Pattern Rule 与其他 Provider。冷启动默认模型写入独立的版本化
`model-selection.json`，不再复制 Provider 或 reasoning 配置。模型能力和 reasoning mapping 由 Official、
Personal、Account 解析后的 Process Registry 提供。

原来用于从 CLI Config 人为删除 Provider 的 prewarm case 也随之更新。I64 现在验证 Host 与 Worker
分别从同一 Personal Config 完成 Process Registry 初始化后，首个预热 Session 保持 custom GLM；不再
构造已经删除的 Host Snapshot/CLI Catalog revision 缺口。Conversation Catalog、Coverage Matrix 和
P0 E2E 说明同步更新。

三条 Desktop Provider Seed 单测和 Desktop E2E TypeScript 检查通过。Human in the Loop 仍为 16 项
全部确认，没有新增产品语义裁决。

## 255. 删除 Bootstrap 的旧 Active Model Limits 与 MCP 再导出死链

全仓 Knip 与字符串引用审计发现两个 Bootstrap 整文件没有任何生产、测试或脚本消费者。
`active-session-model-limits.ts` 保存了 Registry 热更新后原地修改 Active Session Runtime 容量并重新
发送 ModelSelected 的旧实现；该行为已经被 M1/M2 的 Model 生命周期取代，Registry 更新只影响以后
创建的 Model。`official-mcp-trusted-origins.ts` 只把 Shared 的 MCP Trust API 原样再导出，消费方已经
直接依赖 Shared。

本轮先增加失败的 Bootstrap 结构门禁，再删除两个文件。Official MCP Spec 的实现位置同步指向
`packages/shared/src/official-mcp-auth.ts`。Workspace 默认模型适配器中的历史注释也更新为当前事实：
该入口只保存 Workspace ModelSelection，Provider 与能力来自进程 Registry。

Bootstrap 结构门禁 2 条与独立 TypeScript 检查通过。Human in the Loop 仍为 16 项全部确认；本项没有
增加兼容路径或改变运行语义。

## 256. Team Plan E2E 退出旧 Provider 三写

上线前审计继续发现，Team Plan Usage E2E 会把同一份 BigModel Coding Plan Provider 同时写入旧 CLI
Config、App `config.json` 的旧 Provider 字段和 `model-providers.json`。该用例测试的是 Personal/Team
连接切换与用量展示，不是旧配置迁移；继续三写会掩盖 Official、Personal、Account 三层事实源之间的
真实装配问题。

本轮把场景准备改为只写版本化 Personal Config。Personal 层提供用例需要的 endpoint、模型静态字段和
enabled 覆盖，测试中的账号服务响应继续通过 Account Overlay 提供 Personal/Team 连接身份。两者按照
生产 Registry 的层次解析，不再由测试私自拼出第三份 Provider Store。

Desktop E2E TypeScript 检查和改动文件 Lint 通过。Human in the Loop 仍为 16 项全部确认；这项改动只
落实既有单一事实源裁决，没有改变 Team Plan 的用户行为。

## 257. Reasoning E2E 删除旧 Provider 读取回退

四条 Reasoning manual-review E2E 在解析 replay endpoint 时，会绕过统一测试投影，分别读取旧
`model-providers.json` 和旧 CLI Provider Config。Direct Seed 与 Settings 写入已经收敛到 Personal Config，
这些回退不会提供新的有效事实，只会让用例在正式配置缺失时误用旧文件继续运行。

本轮删除两层回退。用例仍优先使用显式环境变量和 replay runtime 文件；需要从产品配置读取时统一通过
`readModelProviders()` 的 Personal Config 投影。该 helper 自身保留首次迁移诊断所需的旧 Store 兼容，
用例不再各自复制迁移逻辑。

Desktop E2E TypeScript 检查和四个文件的 Lint 通过。Human in the Loop 仍为 16 项全部确认；改动不改变
Reasoning 请求断言或设置交互。

## 258. 额度重置请求补齐 Account Access 作用域

最终 Lint 审计发现，设置详情已经从 Registry View 解析出当前 Personal/Team Plan 的 `accessId`，并传给
`CodingPlanStatusPanel`；Panel 内部却没有继续把它交给额度重置 hook。`sourceKey` 可以隔离本地展示状态，
但服务请求仍需要 `accessId` 定位账号连接。漏传会让同一 Provider 下的 Personal/Team 重置请求失去正式
Account Access 作用域。

本轮只补齐该参数传递，没有恢复 Renderer Credential 或 Provider API Key。Model Selection Repository 中
同轮发现的无意义对象 spread 也一并消除。Coding Plan 与 Model Selection 共 205 条定向测试通过，相关
文件 Lint 不再产生 M2 warning。Human in the Loop 仍为 16 项全部确认。

## 259. 上线前最终静态与验证收口

最后一轮重新拉取 `origin/staging`，分支保持 0 behind。`@zcode/provider` 与
`@zcode/provider-node` 的 Knip 审计没有未使用文件或导出；生产代码对旧
`model-providers.json` 的剩余读取只位于 Personal Config 首次导入和 Account Key 一次性迁移，继续作为
明确、单向、可删除的迁移边界保留。

根 `pnpm typecheck` 通过；根 `pnpm lint` 为 0 error、35 条与 M2 无关的基线 warning；Coding Plan 与
Model Selection 定向测试 205 条通过，Desktop E2E TypeScript 与改动文件 Lint 通过。Human in the Loop
16 项全部确认，没有新的待裁决问题。

## 260. Runtime Model Overlay 收窄为 Turn Model Overlay

继续按 M2 完成定义审计 Bootstrap 时发现，Workspace/Session Provider Overlay 已经删除，但内部对象仍叫
`RuntimeModelOverlayManager`，并同时公开 `getModelConfig/getTurnModelConfig`、
`getModelCatalog/getTurnModelCatalog` 两组完全相同的方法。这个 API 形状仍暗示普通长期模型可以从
Registry 之外的 Runtime Overlay 取得事实。

本轮先修改现有测试固定目标边界，再把对象收窄为 `TurnModelOverlayState`。它只保留当前 Turn 所需的
`set/clear/hasModel/getModelConfig/getModelCatalog/onDidChange`，文件也改名为
`turn-model-overlay.ts`。Session Facade 与 execution-scoped Source 继续使用同一份临时模型状态，闲时任务
协议和执行行为没有变化。M2 结构门禁新增旧文件路径，防止通用 Runtime Overlay 再次出现。

Turn Overlay、Runtime Model Factory、Session Facade 与 M2 结构门禁共 16 条测试通过，Bootstrap 独立
TypeScript 检查通过。随后根 `pnpm typecheck` 通过，根 `pnpm lint` 为 0 error、33 条当前 staging
基线 warning。Human in the Loop 16 项仍全部确认；该项只是落实已经确认的“普通 Provider 只来自
进程 Registry、临时 Provider 只属于当前 Turn”，没有新增产品语义。

## 261. 设置表单退出共享旧 Provider Store 类型

完成条件反证审计发现，Provider Settings 已经只读写正式 Settings Facade，但 Renderer 的表单状态仍
直接使用共享旧 Store 类型 `ModelProviderConfig`，投影文件也仍叫 `providerSettingsLegacyProjection`。
它不构成第二事实源，却会让调用者继续误把旧物理存储形状当成当前配置契约。

本轮先增加结构门禁，确认生产 UI 中仍有 22 个旧类型调用文件，再新增 Renderer 私有的
`ProviderSettingsFormProvider` / `ProviderSettingsFormModel`，迁移全部生产调用者与相关测试 fixture。
投影改名为 `providerSettingsFormProjection`，明确表达它只在正式 Settings View 与一次编辑会话之间
转换。共享旧 `ModelProviderConfig` 现在只属于一次性 Personal/Account 物理迁移代码。

UI 独立 TypeScript 检查通过；设置投影、保存、排序、套餐可见性、模型编辑、闲时 reasoning 与官方版本安全校验
相关 12 个测试文件共 282 条通过；改动文件 Oxlint 为 0 warning、0 error。该项不改变表单交互或保存
语义，只收窄类型所有权。Human in the Loop 16 项仍全部确认，没有新增裁决。

## 262. 设置页可用性判断收敛到 Registry

设置表单退出旧 Store 类型后，继续审计发现 Renderer 仍通过 Shared 的
`isModelProviderUsableForAgentStartup()`，根据表单里的 API Key、Endpoint 和模型字段重新计算 Provider
是否可用。这套算法只剩设置页两个调用方，却会让保存后的 Provider Family 修正、Plan 同步补偿与
Registry 的 `selectable` 产生两种答案。

本轮先增加结构门禁与投影测试，再把 Registry 发布的 `selectable` 投影到 Renderer 私有表单。Provider
保存接口原本就返回写入并刷新完成后的新 Settings View；保存调用现在把该 View 返回给交互层，后续判断
直接使用其中的最新 `selectable`，不依赖保存前的 React 快照。Shared 中已经没有静态调用方的两项旧启动
判断 helper 随之删除。

设置表单边界、Settings View 投影、启动 Registry View 与保存返回值测试通过，根 `pnpm typecheck`
通过。Human in the Loop 16 项仍全部确认；该项落实已有“Registry 决定模型可选性”的设计，没有新增
产品语义裁决。

## 263. 删除旧 Agent Registry Provider 过滤器

Shared 中还保留 `shouldIncludeModelProviderInZCodeAgentRegistry()`，按旧 Provider Store 的 enabled、API Key、
Builtin ID 和 Plan 特例决定是否进入 Agent Registry。生产调用方早已全部退出，只剩该函数自己的旧单测；
继续保留会暗示旧 Store 仍可建立另一份 Registry 成员关系。

静态引用审计确认零生产调用方后，本轮删除函数与对应历史测试。当前 Provider 成员关系和 `selectable`
只由 `@zcode/provider` 的 Official、Personal、Account 解析与 Process Registry 决定。Shared 其余旧类型与
转换 helper 继续仅服务一次性物理迁移和 Renderer 表单兼容，不恢复执行侧过滤入口。Human in the Loop
16 项仍全部确认，没有新增裁决。

## 264. 套餐连接与设置导航删除旧表单回退

设置页虽然已经从 Settings View 取得 Account Access 和 Registry `selectable`，套餐状态解析仍允许缺少
`accountProviderAccessIds` 时回退到旧表单的 API Key、Endpoint 与模型列表；Provider 导航状态点也会调用
旧字段 helper 重新判断“已配置”。生产 `ModelProviderSection` 始终显式传入 Account Access 集合，因此该
分支只剩历史测试和兼容注释，却仍能形成第二套连接与可选性答案。

本轮将缺省 Account Access 明确定义为“当前没有账号连接”，删除 API Key/Endpoint 回退与无调用方的
表单配置判断 helper。Coding/Start/Team Plan 的状态解析、详情卡片、首次同步与补偿同步只认 Account
Overlay `accessId`；Provider 导航是否点亮只认 Registry `selectable`。测试 fixture 同步显式声明 Account
Access 与 Registry 可选状态，不再通过旧 API Key 暗示连接。

Coding Plan、Provider Family、导航国际化与表单结构门禁共 221 条测试通过。Human in the Loop 16 项仍
全部确认；该项落实已经确认的账号与 Registry 权威边界，没有新增产品语义。

## 265. 旧 Provider Store 收敛为只读迁移边界

最终生产引用审计确认，旧 `modelProviderServiceStorage` 只被 Personal Config 首次导入和 Account API Key
一次性迁移调用，而且两个调用方都显式关闭旧 Store 的写回。文件内部仍保留的“读取后写入旧
`config.json`”分支只由历史原子写测试维持，会让旧 Store 看起来仍能修改正式配置事实。

本轮把该文件改名为 `legacyModelProviderStoreReader`，并收敛成纯读取适配器：继续识别历史 `config.json`
与 `model-providers.json` 的多版格式，向上游
返回旧 Provider DTO；迁移结果只由正式 Personal Config Repository 和 Account Credential Store 写入各自
的新事实源。旧读取器不再写文件、不再恢复备份，也不再持有原子写依赖。该项不会改变已存在用户的首次
迁移结果，只删除一条生产中从未启用的反向写入能力。

## 266. WDIO 全局 Provider Seed 退出旧事实源

旧 Store 收敛为只读后，反证审计发现 WDIO 全局启动器仍把普通测试 Provider 同时写入旧
`model-providers.json` 与 CLI Config。运行时最终会由 Personal 首次导入接管这些值，但普通 E2E 因此始终
顺带依赖迁移路径，CLI Config 也继续表现成 Worker Provider 的并行事实源。

本轮先增加结构门禁，再将 DeepSeek、Output Budget、Repo Wiki、Context Window 与 Provider 过滤夹具
统一改为写版本化 Personal Config。Environment 默认模型写入独立 Model Selection Config；CLI Config
只保留 `modelStream` timeout。Coding Plan 的 Builtin Provider 副本同时删除，套餐 Provider 继续由
Official 与 Account Source 构建。专门测试旧配置导入的单元测试仍保留，不与普通 E2E 混用。

Desktop E2E TypeScript 检查通过；结构门禁与 Provider Seed 共 4 条测试通过，改动文件 Lint 为 0 warning、
0 error。Human in the Loop 仍为 16 项全部确认，没有新增裁决。

## 267. Desktop E2E 诊断退出旧 Provider 读取回退

WDIO Seed 迁移后，Desktop E2E 的 `readModelProviders()` 仍会在正式 Personal Config 不存在时读取旧
`model-providers.json`，并且还能把旧版 CLI 配置的 `config.provider` 转换成 Provider 列表。普通 E2E 虽然已经
不再写这些格式，这个读取回退仍可能掩盖错误夹具，让测试在没有建立正式事实源时意外通过。

本轮先增加反向测试，固定“只存在旧 Provider Store 时诊断结果为空”，再删除旧文件路径、旧版 CLI 配置的
Provider/Model 转换和相关辅助函数。E2E 诊断现在只解析版本化 Personal Config；历史格式读取只留在
Services 的一次性迁移器和迁移测试。对应案例清单中的夹具路径也改为正式 `config.json`。

Desktop Provider Seed 与边界测试共 4 条通过，Desktop E2E TypeScript 检查通过，改动文件 Oxlint 为
0 warning、0 error。Human in the Loop 16 项仍全部确认；该项只收紧测试事实源，没有新增产品语义。

## 268. 旧 Store 迁移类型退出 ZCode Protocol 出口

符号级引用审计确认，`ModelProviderStoreFile` 迁移 Schema 和裸数组迁移函数仍由
`packages/shared/src/zcode-protocol/index.ts` 再导出，但没有生产协议消费者。它们描述的是旧物理存储格式，
不属于 App 与 Worker 的通信契约；保留这个出口会继续把一次性存储迁移误表示成协议能力。

本轮删除 Protocol 的导入与再导出。旧 Store Reader 继续从 Shared Provider 类型直接使用迁移函数，原有
Schema/迁移测试也改为直接测试其所属模块；一次性 Personal/Account 迁移能力没有变化。

## 269. M2 完成边界升级为跨包结构门禁

最终审计发现，原有 Services、UI 与 Bootstrap 结构测试只保护若干已经删除的文件路径，无法阻止旧 DTO、
旧 Snapshot 或旧 Store 入口换一个文件名重新进入生产。仅凭搜索结果宣称“没有残留”也无法为后续提交
提供持续约束。

本轮新增跨包异步源码扫描测试，覆盖 Services、UI、Desktop、Shared 以及 Worker 的 Adapter、Bootstrap
和 Contracts 生产目录。门禁明确允许 `ModelProviderConfig` 只存在于 Shared 历史 DTO、Personal 首次导入、
Account Key 一次性迁移及其装配入口；`model-providers.json` 只允许由旧 Store Reader 读取。旧完整 Registry
Snapshot、完整 Snapshot 更新协议、通用 Runtime Overlay、旧 Settings 投影与已退役 Provider Service 名称
必须保持为零。

门禁首次运行同时发现旧 Reader 的日志 Scope 和一处注释仍使用已删除的 `ModelProviderService` 名称；两处
改为准确的迁移 Reader/已退役 Registry 表述。Human in the Loop 16 项仍全部确认，没有新增裁决。

## 270. Desktop E2E 夹具退出旧 Provider Store DTO

生产边界门禁完成后，测试设施仍有两处遗留：WDIO 的普通 Provider seed 先构造旧
`ModelProviderConfig`，再转换成 Personal Config；E2E 读取 Personal Config 后，又反向拼成同一个旧 DTO
供断言使用。它们不参与线上执行，却让新增 E2E 继续依赖已经退役的 Store 形状，也会掩盖新 Config 字段
没有被夹具表达的问题。

本轮将普通 seed 输入改为直接描述 `ProviderConfig` 与精确 `ModelConfig` 的测试类型，删除旧 DTO 的
endpoint、kind、source 与 model factory 转换。reasoning 档位、默认值和 mapping 现在直接进入正式
`ModelConfig`；此前这部分元数据会在旧 DTO 到新 Config 的转换中丢失。E2E 读取侧改为明确的
`E2EModelProviderSnapshot`，只承担测试观察与断言，不再冒充配置或运行时契约。

结构门禁现在递归扫描全部 Desktop E2E TypeScript，禁止重新引入旧顶层 `ModelProviderConfig`。Desktop E2E
TypeScript 检查、相关 seed/读取测试与改动文件 Oxlint 均通过。Human in the Loop 16 项仍全部确认；该项
只清理测试基础设施并恢复 reasoning 夹具表达，没有新增产品语义。

## 271. 删除无消费者的旧 Provider 查询与转换出口

完成边界反证继续沿 Shared 旧 Provider 类型向外追踪。符号级引用审计发现，生产 UI 仍通过
`isModelProviderEnabled()` 间接绑定旧 `ModelProviderConfig`；Shared 还公开了模型 ID/Label 查询、模型查找、
Kind 反向转换和 supported format 解析等零生产消费者函数。Remote Model Facts 中也保留了一个没有任何
调用方的完整性判断出口。这些函数不承担物理迁移职责，也不属于 M4 的 Turn Runtime Model 边界。

本轮先扩展跨包结构门禁，再让 Provider 设置表单直接读取自己的 `enabled` 字段，让 Provider Readiness
E2E 直接检查 `E2EModelProviderSnapshot.models`。随后删除上述 Shared helper 与 Remote Facts 无消费者出口，
并把只在文件内部复用的 modalities 解析函数收回为私有实现。`getModelProviderModelIds()` 等仍被一次性
Legacy Reader 使用的函数继续留在迁移边界，不按名称批量删除。

M2 结构门禁与 UI 表单边界 17 条测试通过，Desktop E2E 与根 TypeScript 检查通过。Human in the Loop
16 项仍全部确认或被后续已确认裁决取代，没有新增产品语义。

## 272. 非迁移测试退出旧 Provider DTO

生产边界收敛后，Usage、Repo Wiki、Bots 与 Provider Runtime 的普通测试仍使用完整
`ModelProviderConfig` 组织夹具。实际被测代码通常只读取 Provider ID、API Key、可用状态，或把模型字段
投影成当前 Registry View；完整旧 DTO 会让测试继续暗示旧 Store 是这些功能的输入契约。

本轮先扩展 M2 完成门禁，明确旧 DTO 只允许出现在一次性迁移、历史 Schema 和 Renderer 表单边界测试。
随后把 Usage 测试改为最小鉴权夹具，把 Repo Wiki 测试改为局部的 Registry View 输入夹具，并让 Provider
Runtime 测试直接使用正式 Provider Config。Bots v2 cache 测试中还发现了一个已经失效的 `providers`
附加字段：生产 cache Schema 早已不读取它，本轮删除该字段及其旧 Provider 构造，避免测试继续验证空壳数据。

M2 完成门禁与上述六组行为测试共 135 条通过。Human in the Loop 16 项仍全部确认或被后续已确认裁决
取代；该项只清理测试契约，没有新增产品语义。

## 273. Session 与请求鉴权协议退出 Provider Revision 空壳

要求级完成性审计发现，完整 Provider Snapshot 与 revision CAS 已经删除后，Session Settings 仍公开
`appliedProviderRevision`，但所有生产 Snapshot 都固定传入 `undefined`；Provider Runtime Headers 响应也
保留 `providerRevision`，Host 从未返回该字段，Standalone 仅把 `accessId` 填入后写到 debug 日志。这两个
字段均不再参与刷新、并发控制、鉴权或 Model 创建，却继续把已经退出的 Registry revision 表示成协议能力。

本轮先把 Core 源码纳入 M2 跨包结构门禁，再删除 Session Schema、Mapper 参数、动态鉴权协议、Invocation
Context、Core Port 与 Adapter callback 中的 revision 字段。请求期鉴权仍返回 `requestAuth`，官方版本安全校验重试、
账号身份核对与每次 attempt 刷新行为不变。普通 Session Settings 继续只表达模型、思考档位、模式和权限。

Shared、Services、UI、Adapter、Bootstrap 与 Core 定向回归共 669 条通过。Human in the Loop 16 项仍全部
确认或被后续已确认裁决取代；该项落实已确认的 Snapshot/revision 退役边界，没有新增产品语义。

## 274. 完成门禁覆盖全部生产 Entry 并清理误导术语

要求级审计继续核对“Host、Worker、Prompt CLI、TUI 复用同一 Provider 领域实现”。原有跨包门禁已经
覆盖 Host、Worker 与共享协议，却没有扫描 `@zcode/provider`、`@zcode/provider-node`、Prompt CLI 和
TUI 自身；旧边界若从这些目录重新进入，测试不会失败。

本轮把四个目录加入同一生产源码门禁，并固定 Workspace Catalog、完整 Snapshot 更新协议、旧 Runtime
Overlay、旧 App Bootstrap 等已经退出的名称必须保持为零。扩展后的扫描没有发现 Prompt CLI/TUI
回退旧 Provider 事实源；两者继续通过进程级 Registry 装配。

扫描同时发现 Workspace 状态已经收缩为 Model Preferences 后，协议实现的局部变量和 revision 错误消息
仍使用 `catalog`。本轮统一改为 Preferences/Registry View 术语，未改变 Workspace revision、默认模型、
思考档位或恢复行为。Bootstrap 还残留一个没有任何调用者的 legacy OpenAI-compatible reasoning 迁移
函数；该函数已删除并加入退役 helper 门禁。Human in the Loop 16 项仍全部确认或被后续裁决取代，
没有新增产品语义。

## 275. 设置页 Provider 顺序退出 Builtin 硬编码

继续按“Official/Personal/Account 是唯一 Provider 事实来源”反证 UI 后，发现设置页已经从
`ProviderSettingsView` 取得完整 Effective 顺序，却仍在 `modelProviderOrdering` 中维护一份 Builtin
Provider ID 排序表。显式 View 顺序通常会遮住它，但 View 缺失或调用方未传顺序时，这张表仍会改变输入
顺序，构成 Official Config 之外可生效的第二静态事实源。

本轮先增加行为测试，证明没有显式顺序时原实现会重排 Registry View 输入；随后删除 Builtin 顺序表。
排序函数现在只做一件事：有显式 Provider Order View 时按它排列，未列出的项保持相对顺序；没有显式
顺序时完整保留输入顺序。正常设置页的 Order View 直接由有序 Effective Provider View 投影。

旧 `ModelProviderDisplayOrderState.updatedAt` 没有参与 CAS、持久化或服务调用，也一并退出 Shared 旧
Provider DTO。UI 使用只包含 `providerIds` 的内部 `ProviderOrderView`，拖动仍调用
`reorderPersonalProviders()`，最终顺序继续由 Personal Overlay 自身表达。相关 UI 回归与 M2 门禁共
76 条通过，根 typecheck 通过。Human in the Loop 16 项仍全部确认或被后续裁决取代；该项落实既有顺序
裁决，没有新增产品语义。

## 276. 收窄 Bootstrap 与 CLI 的 Provider 内部导出

符号级审计确认，Bootstrap 的 Personal 首次导入、Registry Model Runtime、Runtime Capability、Standalone
Account Runtime 与旧 Turn Runtime 装配文件公开了一批没有模块外调用者的类型、常量和辅助函数。它们
只是文件内部实现，却会在源码层表现成可复用扩展点，使后续代码更容易绕过进程 Registry 的正式入口。

本轮收回这些内部 `export`，保留真正跨模块使用的 Registry 启动、Model 创建和 Selection API。重复位于
`model-config.ts` 的 `DEFAULT_MODEL` 再导出也已删除；Bootstrap 的正式包入口仍直接从 Contracts 导出该
兼容常量。Knip 复核后，Bootstrap/CLI 的 Provider、Model、Registry 相关未使用导出为零；六组相关模块
测试共 61 条通过，Bootstrap 与 CLI 独立 typecheck 通过。Human in the Loop 16 项仍全部确认或被后续
裁决取代，没有新增产品语义。

## 277. 删除旧 Provider 禁用状态 helper 并收窄 Account 内部出口

Services 符号审计发现，`codingPlanProviderAvailability` 仍保留
`isSystemDisabledCodingPlanProvider()` 与 `isUserDisabledCodingPlanProvider()`。两个函数按照旧
Provider DTO 的 `enabled/systemDisabledReason` 解释可用性，已经没有任何调用者；当前 Account Source
直接发布 available/unavailable/unknown 结果，不再需要这层旧状态推断。

本轮先以 M2 结构门禁证明两个 helper 仍存在，再删除实现并固定其不得回归。Account Credential、Request
Auth、Team Plan Key、Connectivity、Provider Runtime、Repo Wiki Selection 与 Off-Peak 文件中只供文件
内部使用的类型和 helper 也收回导出；正式 Service/Factory 接口保持不变。Services Knip 复核后，剩余
Provider 相关输出只包含其他领域的公共或待独立整理类型。17 组 Account/Provider 行为测试与 M2 门禁共
133 条通过。Human in the Loop 16 项仍全部确认或被后续裁决取代，没有新增产品语义。

## 278. 收回 Services 路径实现的多余公共出口

Services 路径审计发现，`getWorkspaceKey()` 与 `getProviderWorkspaceZCodeConfigIsolationDir()` 只在
`paths.ts` 内部用于 Session 路径和外部 Agent 的技能、插件、运行状态隔离，却仍被导出为公共 API。
后者名称中的 Provider 表示 Claude、Gemini 等外部 Agent Runtime，不是 M2 的模型 Provider Config
事实源，因此保留其行为，只收回模块导出。

路径测试 14 条通过；本轮没有修改路径布局、迁移行为或 Provider 产品语义，也没有新增 Human in the
Loop 裁决。

## 279. 修正 Registry 冷启动门禁的遗留命名

完成条件反证时发现，V4 Conversation 测试仍把冷启动门禁称为 “legacy provider registry”，注释也写成
Host 读取“旧 Snapshot”。实际夹具和生产代码都已经通过 `ModelSelectionReadinessSource` 读取当前 Registry
View；Host 只用该 View 判断是否允许模型执行，不下发完整 Registry。

本轮只修正测试名称与注释。生产行为、协议和裁决均未改变。

## 280. 按完成条件进行上线前反证

最终审计不再按零散符号清理，而是逐条对照 M2 完成条件，反向扫描旧完整 Provider DTO、Workspace
Registry 更新协议、Runtime Overlay、Builtin 顺序硬编码和旧 App Bootstrap。剩余旧 DTO 仍只位于一次性
Personal/Account 迁移、Renderer 私有表单和 M4 闲时任务输入；普通 Host、Worker、Prompt CLI 与 TUI
没有发现可回退的旧 Provider 事实源。

Provider、Provider Node、M2 结构门禁、Account 鉴权、Host 冷启动、Worker Runtime、UI 顺序与协议入口
共 21 个文件、181 条测试通过。根 `pnpm typecheck` 通过；根 `pnpm lint` 为 0 error、33 条当前 staging
基线 warning。Human in the Loop 16 项仍全部确认或被后续裁决取代。抓取远端后，分支基于
`origin/staging` `6b4f6fc636f5`，相对该基线为 0 behind。

## 281. 设置页编辑态直接使用正式 Config

上线前反证确认，共享旧 `ModelProviderConfig` 虽已退出生产 UI，Renderer 私有表单仍复刻了同一组
`endpoints/defaultKind/kinds/modalities/ProviderOptionsPatch` 字段，再在保存时翻译成正式 Config。这条双重
表达会让设置页继续理解已经退出的 Provider Store 语义，也会在编辑模型时丢失界面没有暴露的
`reasoningMapping` 等配置。

本轮把设置页编辑态收敛为 `ProviderConfigObject` 与 `ModelConfigObject` 的可变副本，只在外层附加
`providerId/modelId`、Registry 投影状态和 Personal 来源标记。名称、API Key、API 类型、Base URL、模型
容量和顺序直接修改正式 Config 字段；保存仍把完整 Effective Config 交给 Facade，由 Repository 在锁内
计算稀疏 Personal Overlay。模型删除表达为有效模型列表中移除该项，不再由 Renderer 制造旧 Store 墓碑。

设置页没有模型级 API kind 控件，因此模型编辑不再反推或写入 `kinds/defaultKind`。Provider API 类型仍由
Provider Config 单独编辑。模型元数据弹窗只修改 Model ID、Context Window 与 Max Output Tokens，并保留
完整 Model Config 中未展示的 Properties、Option Specs 与 Reasoning Mapping。

闲时任务的 `allowedModelConfigs` 是 M4 Temporary Provider 协议输入，仍保持当前专用形态；它没有重新
进入 Provider Settings 表单，也没有被伪装成 Registry Model。该边界留给既定的闲时任务重构处理。

设置页相关 24 个测试文件、313 条测试通过。全量 UI 测试中 777 个文件、5996 条测试通过；剩余 2 个
`v4ConversationDraftSuggestedPrompts` 文件的 4 条失败是当前 staging 已有的图标尺寸与文字字号断言，
不涉及 Provider 设置。根 typecheck 通过，根 lint 为 0 error。该项落实已经确认的 Settings Config 同源
边界，没有新增 Human in the Loop 裁决。

## 282. API 类型退出模型级设置旁路

继续检查设置页正式 Config 边界时，发现 `ProviderModelApiFormatTags` 仍保存一套模型级 API kind、Endpoint
Path 和多选控件。生产界面只从该文件复用 API 类型的显示标题，其余组件和转换函数均无调用方。这套实现会
让后续维护者误以为每个模型仍可独立选择执行协议，与当前“API 类型属于 Provider Config”的设计冲突。

本轮先增加结构门禁，再删除该模型级编辑旁路。Provider 连接表单直接使用 `ProviderApiType`，API 类型标题
与固定协议路径留在 `ProviderApiFormatSelect` 中展示。Repo Wiki 的 Registry View 投影也改用同一个正式
类型；连接探测直接按 `ProviderApiType` 选择请求协议和 AI SDK options namespace，不再绕回旧
`ModelProviderKind` 转换。两个没有调用方的设置迁移 helper 同时删除。

旧 `ModelProviderApiFormat` 现在只留在 Shared 历史 DTO 与一次性 Legacy Reader。M4 前的旧 Turn Model
输入能力解析也改用正式 `ProviderApiType`，但其媒体能力推断和临时执行行为保持不变。设置页、Repo Wiki、
连接探测和 Bootstrap 执行输入均不再消费旧类型。Human in the Loop 16 项仍全部确认或被后续裁决取代，
没有新增产品语义。

## 283. Model Adapter 创建退出旧 Runtime Model Config

继续沿 Bootstrap 兼容边界反证时，发现 Prompt Trajectory 已经创建正式 Provider Registry，却仍先用同一份
旧 `RuntimeModelConfig` 初始化 `ModelAdapter`。App 启动后 `ApiProviderModelRuntime` 会立即用进程 Registry
替换这份 AI SDK Registry，因此旧配置只制造了一次没有业务价值的预装，也让公共
`createModelAdapter()` 继续表现成普通执行可以绕过 Provider Registry。

本轮把 `createModelAdapter()` 收窄为只接收显式 `registryConfig`。正常 App 传入由正式 Registry Runtime
管理的空执行容器和进程基础设施；Prompt Trajectory 同样传入空容器，随后由它已装配的测试 Provider
Registry 发布实际模型。旧 `RuntimeModelConfig -> AiSdkModelRegistryConfig` 转换只留在 M4 前的 Turn
Execution Source 内部，服务 execution-scoped 临时输入，不再是公共 Adapter 创建分支。

同时删除了无调用方的 `createRuntimeAiSdkModelRegistryConfig()`，并由 M2 完成门禁禁止恢复。Bootstrap、
CLI 与 Prompt Trajectory typecheck 通过，Bootstrap 定向回归 45 条、M2 门禁 37 条通过。Human in the Loop
16 项仍全部确认或被后续裁决取代，没有新增产品语义。

## 284. 上线前按事实来源重新分类残留旧类型

公共 Adapter Factory 收口后，继续按 M2 完成条件审计 `RuntimeModelConfig`、`ModelCatalog`、Builtin
Provider ID、Provider Family 与旧 Store 相关引用。审计结论按职责分为三类：

- 普通长期 Provider 的设置、选择、Registry 装配与 Model 创建没有发现新的旧事实回退；
- `RuntimeModelConfig` 与 `ModelCatalog` 的活跃执行引用集中在 `TurnExecutionModelSource`，只服务闲时任务
  的 execution-scoped 输入，属于 M4 已记录的退场边界；
- Builtin Provider ID 与 Family 的活跃引用负责账号、套餐、购买和请求鉴权映射，消费 Account Source
  产生的状态，不为 Registry 补充模型静态 Properties 或 Option Specs，属于 M6 内部整理范围。

一次性旧 CLI Provider、Personal Config 和 Account Key Reader 仍只在新物理文件不存在或旧凭据迁移时
运行，M2 结构门禁继续限制其文件所有者。Human in the Loop 16 项均已有确认或后续取代结论，没有发现
需要新增裁决的产品语义。

## 285. 旧 Provider 字段退出普通 CLI Config Schema

继续审计旧 CLI Config 时发现，通用 `RuntimeConfigPatch` 虽已删除模型字段，普通文件 Schema 仍显式声明
并校验 `provider`、`model`、`modelCatalog` 与 `small_model`。因此一个已经不再参与执行的旧 Provider 字段
只要格式错误，仍会让同文件中的 MCP、权限、网络等正式运行配置整体加载失败。

本轮把这四个字段移入 `LegacyCliModelConfigFileSchema`。普通 `ZCodeConfigFileSchema` 不再拥有它们，
运行配置解析把残留旧字段视为无关扩展；一次性 Personal Importer 继续使用 Legacy Schema 严格校验并
拒绝无法迁移的旧格式。这个调整不增加兼容事实源，反而把旧格式的读取和失败影响限制在迁移边界。

Adapters Config 与环境配置定向回归 63 条、Adapters typecheck 通过。Human in the Loop 16 项仍全部确认
或被后续裁决取代，没有新增产品语义。

## 286. 固定旧 Runtime Model Config 的剩余边界

上线前最后一轮类型审计确认，旧模型环境变量已经不会进入普通 Runtime Config：`ZCODE_MODEL` 与
`ZCODE_BASE_URL` 没有运行时消费者，`ZCODE_API_KEY` 的剩余读取只服务旧 CLI Provider 的一次性导入。
正常 Provider 执行仍以 Official、Personal 与 Account Config 聚合后的进程 Registry 为唯一事实源。

`RuntimeModelConfig` 的剩余生产引用分为两组：Adapters 中的旧 CLI 文件解析，以及 M4 尚未重构的
execution-scoped Turn Overlay。为防止该类型以后重新扩散到普通 Session、Settings、Selection、Registry
或 ModelFactory，本轮把允许文件集合加入 M2 跨包结构门禁。该项只收紧架构边界，不改变执行语义，也
没有新增 Human in the Loop 裁决。

Provider 全量 14 个文件、111 条测试和 Provider 包 typecheck 通过。根 `pnpm typecheck` 通过；根
`pnpm lint` 为 0 error、33 条当前 staging 基线 warning。刷新远端后，分支相对
`origin/staging` `6b4f6fc636f5` 为 0 behind，工作区无未提交文件。

## 287. 统一同名 Turn Overlay 的执行优先级

运行时分支审计发现，execution-scoped Turn Overlay 与进程 Registry 使用相同
`providerId/modelId` 时，`ApiProviderModelRuntime` 已经优先创建 Overlay Model，但 Session Facade 的
模型切换、reasoning 读取与修改仍优先解释 Registry。结果是实际请求使用临时 Model，UI/Runtime 元数据
却来自长期 Registry，违反同一执行段只能有一个 Model 事实来源的边界。

本轮让 transient `setModel` 和当前模型元数据查询先判断 Turn Overlay；Overlay 不拥有目标时才查询
Registry。清理 Turn Overlay 时也调整为先删除临时层，再从最新 Registry 恢复原模型，避免临时模型与
原模型同名时再次解析到刚结束的 Overlay。Overlay 仍不进入设置、选择列表和持久 Session Selection。

新增同名 Provider/Model 回归用例，覆盖 transient 切换、reasoning 读取、枚举、修改以及清层后回到
Registry。目标测试文件 8 条通过，Bootstrap typecheck 通过。联合运行的 V4 Commands 52 条断言均通过，
但 staging 已有的 timeout 测试仍产生一个异步 `V4PromptRejectedError` unhandled rejection，使该联合
命令最终返回 1；本轮没有扩张到 V4 队列时序。Human in the Loop 16 项仍全部确认或被后续裁决取代，
没有新增产品语义。

## 288. 完成 Model 生命周期与 Facade 收尾审计

上线前最后按执行时序复核 Registry 更新、Model 创建和前端投影。`Model` 创建时通过
`bindModel()` 固定 Provider 的静态执行事实；Registry 更新只影响之后创建的 `Model`，请求期鉴权刷新
只能补充当前凭据与 Header。Registry 读取或解析失败继续保留 last-known-good View，后续成功刷新可以
恢复。Settings 与 Selection Facade 共用 Runtime ready barrier；UI 先订阅再读取，并按 revision 丢弃迟到
结果。

本轮没有发现新的双轨事实源，也没有修改生产代码。分支相对最新 `origin/staging` 为 65 ahead、0 behind。
M2 结构门禁、Registry、Facade、Adapter、Bootstrap、Services 与 UI 定向测试共 104 条通过；根
`pnpm typecheck` 通过，根 `pnpm lint` 为 0 error、33 条 staging 基线 warning。Human in the Loop 的
16 项裁决均已确认或被后续已确认结论取代。

## 289. 完成迁移、删除集合与旁路归因的清洁审计

上线收尾继续反查三个容易在大迁移中被遗漏的边界。

Personal Config 与旧 `~/.zcode/v2/config.json` 共用物理路径。旧文件没有 Provider Config
`schemaVersion` 时，Repository 会先按内容哈希写入确定性备份，再调用唯一 Legacy Importer 生成正式
v1 文档，并原子替换原路径；正式版本与未来版本不会进入旧导入链。备份失败不会覆盖原文件，重复启动
不会重复迁移。Provider Node 与 Services 的迁移测试继续固定这组行为。

本轮还逐项审计了相对 staging 删除的 63 个文件。删除集合由旧 Provider Store、Workspace Catalog、
完整 Registry Snapshot、旧设置投影和它们的专项测试构成；少数名称不直接包含 Provider 的文件是已经
没有调用者的转发层、旧启动门禁或误放在 Provider Working Memory 根下的临时记录。没有发现删除
staging 新功能后又以 M2 名义带入旧实现的情况。

Repo Snapshot Sidecar 中的 `bigmodel / z.ai / others` 只写入旁路快照上传元数据，用于服务端归因；它
不选择 Provider、Model，不补充 Properties 或 Option Specs，也不参与 Model 创建。该品牌映射仍属于
Account/产品域的后续整理对象，但不构成 M2 Provider 执行事实源。为此不在 M2 临时增加新的 Provider
品牌字段。

Provider、Provider Node、Services 与 Bootstrap 的定向 Knip 导出审计没有发现 Provider/Model 相关的
未使用公共出口。M2 结构门禁、Provider Node 迁移、Services 迁移装配与 Repo Snapshot 归因测试共
55 条通过。根 `pnpm typecheck` 通过；根 `pnpm lint` 为 0 error、33 条当前 staging 基线 warning。
该项没有修改生产代码，也没有新增 Human in the Loop 裁决。

## 290. 固定模型硬编码缺省值的遗留边界

要求级审计继续追查 `default-policy` 与旧 `ModelCatalogService`。模型名称驱动的能力缺省值仍由旧 CLI
配置导入、旧 Catalog/Turn Runtime 和附件能力兼容投影使用；正式 Process Registry 的 Provider、Model
和 ModelFactory 不读取这套规则，完整 Properties 与 Option Specs 只来自 Official、Personal 与 Account
Config 聚合结果。

本轮把 `resolveModelCapabilityDefaults()`、`createDefaultModelCapability()` 与
`applyModelCapabilityDefaults()` 的允许文件集合加入 M2 跨包结构门禁。以后这些模型名硬编码一旦进入
正式 Registry、Model、Settings 或 Selection 链路，测试会直接失败。现有允许位置继续作为 M4 迁移
Turn Overlay 和旧 CLI 文件时的单一遗留边界，不被描述成 M2 的第二事实源。

文档同时清理了三处已被后续实现取代的迁移期表述：所有生产 Entry 已强制装配 Selection Service，
Remote Snapshot fallback 已退出生产，设置页已直接使用正式 Config/View。Human in the Loop 中早期允许
Account Snapshot 投影的记录也明确标记为已被 M2.8 取代。M2 结构门禁 39 条通过，没有新增产品裁决。
根 `pnpm typecheck` 通过；根 `pnpm lint` 为 0 error、33 条当前 staging 基线 warning。Push 时的
affected-test 门禁再次运行 M2 结构测试并通过。分支基于最新 `origin/staging`，相对基线为 0 behind，
工作区没有未提交内容。

## 291. 将 M2 重放到最新 staging

`provider-refactor-m2` 先 rebase 到 `origin/staging` `58cbc6065d`，随后继续重放到本轮验证时的
最新 `3524b06c9f`。冲突处理以最新 staging 的 CUA 生命周期、动态设置页和 Team Plan 行为为基线，
同时保留 M2 的 Process Registry、Provider Services 注册和旧 Runtime Registry 退出边界；staging
已删除的 `packages/ax-macos` 没有被恢复。

冲突后回归发现，Team Plan fallback 仍调用 `parseTeamPlanConnectionKeyByFamily()`，但 import 在重放
期间丢失；本轮恢复该 import。锁文件则按最新 workspace 依赖重新生成并通过 frozen install，避免保留
手工冲突结果。测试覆盖说明同步改为 M2 当前的 Registry readiness 语义。

Bootstrap Runtime Config 27 条测试通过；根项目冲突相关测试 131 条通过；根 `pnpm typecheck` 通过；
根 `pnpm lint` 为 0 error、39 条最新 staging 基线 warning。本轮没有新增产品裁决，也没有改变 Working
Memory 中已有的 Provider 设计。

# Todo127：Built-in 配置在线发布与更新链路修复

> 状态：**代码及复审完成；Pro 桌面刷新整链、macOS 双进程及最终文件检查通过；手机／SSH 等限制保留**。Goal 已授权实施。下载、生命周期、Account 对齐与恢复已接通；验证和发布限制见 [实施复审](./todo-127-implementation-review.md)，不能把 CDN 文件可下载当成全端可用。
>
> 审查证据：[在线发布链路复核](../research/builtin-online-release-review-2026-09-11.md)。承接 Todo18 的下载／缓存机制；不把 Todo18 历史完成状态等同于新 URL 协议已可用。

## 1. 背景与已确认裁决

调查时服务器已在 `data.configs.builtin_provider_config_json` 返回 CDN URL，而 App／CLI 还读旧的 `configs.zcodeBuiltin` 对象。最初生产文件是 schemaVersion 1、revision 19。当时的同版结论已过时：本轮本地为 revision 21；线上仍为 19，且含已删除的 `teamApiKeyManagementUrl`，新版严格校验会拒绝并保留本地候选，须另行发布新文件。

- 用户确认：**每次发布新 URL，不覆盖同一个 URL**。长期 CDN 缓存无需通过每次随机 query 绕开。
- 包内、CDN、Active 继续使用同一个 `{ schemaVersion: 1, revision, config }`；Provider 与 Model 一起原子替换，不新增 Overlay、配置文件或数据表。
- revision 在包内与线上发布间统一单调递增；回退内容也发布更高 revision、新 URL。不能通过删除缓存或把 revision 降低强行回退。
- 继续保持 Environment 权威、Personal 覆盖和冻结执行边界；不重写模型选择、旧字段、消息、统计、历史或运行中的 Model。
- 本 Todo 负责发布传输和可靠生效；Todo113／116 负责实际模型目录、能力和默认启停内容，不在这里重复修改。
- 不重开原来已废弃的客户端业务完整性门禁；格式／正则／CEL 等复用现有 Parser。完整性与真实参数通过发布前验证证明，不能承诺任何可解析内容都能用。

## 2. 目标链路（一层层）

### 2.1 发布端

```text
准备完整配置 + 更高 revision
           |
对最终要上传的内容执行验证
           |
上传新的 CDN URL → 确认内容可读且正确
           |
更新 client/configs.builtin_provider_config_json
```

不在本 Todo 自动发布线上数据，也不凭空增加发布平台。实施结果给出可复用的检查步骤；旧客户端支持范围由现有 app_version／platform 控制面分流核实，不能因为 schemaVersion 同为 1 就假定所有旧版都支持新字段、枚举或协议。当前只实测一个生产版本／平台组合。

### 2.2 传输入口

```ts
interface BuiltinClientConfigFields {
  builtin_provider_config_json?: string; // 实际 schema 限定合法下载 URL
}
```

接口仅展示形状，实现从 schema 推导类型。该字段的值仅是 URL，不兼容成 JSON 字符串或混合对象；字段缺省不清除当前配置。字段存在但非法、HTTP 失败、超时、坏 JSON／不支持 schemaVersion 均进入有原因的失败路径，保留有效本地候选。

App Services 与独立 CLI 共用解析／下载／Release 解码逻辑，通过依赖注入接入网络。避免两份实现再次分叉，也不为此统一所有 client/configs 消费者。是否删除旧 `zcodeBuiltin` 解码导出，实施时查引用；不默认引入双协议优先级或永久兼容分支。

下载边界已确认，以下取代此前待定数值：

| 项目                                | 最终裁决                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 超时                                | 请求 client/configs 与下载 CDN 两阶段**合计 20 秒**，贯穿两次请求的响应头和正文消费；不是每次各 20 秒。保留现有 30 秒 lease，下载预算小于 lease |
| 正文上限                            | CDN 正文 **10 MB**，按十进制 `10,000,000` 字节落地，取代此前 5 MiB 建议；边读边累计实际正文，不仅检查 Content-Length                            |
| URL                                 | 生产使用 HTTPS，拒绝地址内的用户名／密码                                                                                                        |
| 凭据                                | CDN 请求不携带账号 Token、API Key，不从控制面请求复制鉴权头                                                                                     |
| 字段缺省                            | 保留当前配置，表示本次没有在线发布，不视为清空指令                                                                                              |
| 非法字段／HTTP 失败／超时／解析失败 | 保留有效本地候选，记录失败原因，进入现有下载退避                                                                                                |
| 退出                                | 取消请求及正文读取，停止后续应用                                                                                                                |

实施时核对实际文件尺寸并补超时、大小边界测试；已确定上限不是实施时可自行调整的待定项。不借此改所有 ApiClient 的超时实现，先在共用 Built-in 下载边界修复已复现问题。

### 2.3 刷新生命周期

保留先加载随包／有效缓存、后台检查的启动方式，以及设置页手动刷新入口。不要让启动必须等网络，不在每次模型请求前增加下载门槛。

已确认职责：共用下载、刷新与调度代码放在 `provider-node`，App／CLI 注入网络请求能力。App／Server Host 在现有 Provider Runtime 生命周期启动、释放；独立 CLI 的持续刷新移到长期运行时，入口函数只准备路径与本地基线，不再持有一次下载后即销毁的刷新对象。Managed Worker 只读／监听 Host 注入的 Active 文件，不启动下载循环；手机复用连接的目标 Host。

```text
App / Server Environment Host            独立 CLI 长期运行时
        下载与调度                            下载与调度
            |                                    |
         Active 文件                          Active 文件
            |                                    |
    Managed Worker 读／监听                  本进程配置系统读取
```

| 触发时机 | 已确认行为                                                                              |
| -------- | --------------------------------------------------------------------------------------- |
| 启动     | 先服务本地配置，后台尝试刷新，遵守共享 TTL                                              |
| 运行期间 | **每分钟检查一次是否到期**；正常成功后的网络请求间隔为一小时，不是每分钟下载            |
| 下载失败 | 沿用现有 nextEligibleAt 和退避：约 1、2、4 分钟逐步增加，上限一小时；到期检查才再次尝试 |
| 手动刷新 | 绕过 TTL，仍遵守有效 lease                                                              |
| 退出     | 停止周期检查，取消下载，释放资源，不阻止 CLI 退出                                       |

每分钟检查只读取现有 nextEligibleAt，不另外维护第二份下载重试时间。多个窗口 Host 可以各自检查，共享 lease 合并网络请求，不宣称机器上只有一个 Host。配置正常生效通过变化通知与版本对齐完成，不靠定时等待来同步。

进程内复用 in-flight、进程间复用控制文件 lease；force 只绕过 TTL，不绕过有效 lease。退出取消下载并释放调度资源，不因 timer 阻止 CLI 退出；唤醒／网络恢复后按到期状态检查，不堆积错过的周期。控制面 Endpoint 切换沿用隔离路径，CDN URL 更换不改变来源身份。

### 2.4 提交与生效

```text
CDN 完整 Release
      |
Parser 校验 → 文件锁内比较 revision → 原子替换 Active
      |
Config 变化 ──> Account 基于该 Built-in 重建
      |                      |
      +────同版本完整快照─────+
                  |
               Registry
         /                     \
设置与各选模入口             后续新建 Model

Managed Worker：监听 Active + 接收 Host Account
Standalone：监听 Built-in + 凭据，自行派生 Account
```

已确认：Standalone 的 Built-in 变化和凭据变化共用一个串行重建流程，读取当前 Built-in 和真实凭据派生 Account，不要求重新登录，不为配置更新重新申请 API Key。没有登录账号也要生成基于新 Built-in 的 fail-closed 快照，使普通 API Provider 能正常更新。

```text
Built-in 20，Account 19
          |
继续使用完整 Registry 19，启动 Account 重建
          |
重建期间 Built-in 又到 21？
  是：20 的结果不发布，按最新事实重算 21
  否：Account 20 + Built-in 20 → 完整发布 Registry 20
```

不能删除 Registry 的同版本检查，也不能只修改旧 Account 的 revision 冒充重建。重建过程中 Built-in 或凭据变化时，过期结果不能发布；启动初始化与后台下载交错也要遵守同一规则。

重建失败时保留旧的完整 Registry，并复用 §2.3 的每分钟检查判断 **Built-in 与 Account 是否仍未对齐**；仅未对齐时重新触发 Account 重建。该恢复检查不能被下载 TTL、下载失败或 CDN unchanged 挡住，不必重新下载 CDN，也不再新增定时器。App 同样覆盖这一恢复路径，不将成功下载等同于成功应用。

App 正常 Account 重建与 Worker 协议继续复用。Managed Worker 收到文件和 Account 的顺序不限；同版后发布新 Registry，之前继续服务旧的完整快照。文件已更新、Registry 已更新、Worker 已观察分别验收，不新造第二个配置权威或发送前全局 barrier。已创建的 Model 保持冻结，后续新建 Model 读取更新后的配置。

### 2.5 实施顺序与修改落点

1. **共用下载边界**：`packages/provider-node/src/` 承接新字段解析、两阶段下载和现有 Release 校验；修改 Services `zcodeBuiltinRemoteConfig.ts` 与 CLI `provider-runtime-env.ts` 的装配，先通过 BR117-01／02／03。
2. **Account 对齐与恢复**：围绕 `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts`、Standalone Account 派生、Provider Node Runtime 和 App Account 装配补齐变化触发、过期结果处理；保留 `ProviderRegistryService` 的版本护栏，先通过 BR117-06／07。
3. **生命周期调度**：在共用 Provider Node 运行时接入每分钟检查和既有刷新协调机制，App／Standalone 生命周期装配负责启停；同一检查入口也驱动未对齐 Account 恢复。验证 BR117-04／05，不把职责放进 Renderer 或 Managed Worker。
4. **整链验收**：完成 BR117-08 至 11，验证 Personal、冻结执行、真实消费者与最终发布文件；再执行门禁并记录未测平台。各步骤均先补失败测试，再实现，不把接口重组扩大为全局 ClientConfigService 或 Account 协议重构。

## 3. 这次 review 要处理的事项

| 项目                                | 结论与行动                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| 旧字段导致不下载                    | 已实测；改 App／CLI 共用 URL 下载                                 |
| Standalone 文件更新但 Registry 旧版 | 底层运行复现 + 生产订阅缺口已确认；修复版本派生与启动竞态         |
| App 正文超时失效                    | 本地 HTTP 实测；在本功能下载边界补全，不默认改所有 ApiClient      |
| 只有 TTL，无自动调度                | 静态确认；补 Environment 生命周期调度和实际失败恢复               |
| Active 仅保证可解析                 | 既有设计边界；发布前验证最终内容，不新增客户端业务门禁            |
| 文件锁／版本／缓存／通知            | 现有定向测试支持，保留设计；增加两阶段 URL 下载和消费链路集成验证 |

日志最少区分缺省／未到刷新时间／正在由其他进程刷新／版本未变／版本过旧／已更新／失败阶段；使用现有 logger，更新记录包含 revision 和来源身份，避免记录配置全文或带敏感 query 的完整 URL。正常定时未变不刷高频 info。不把 downloaded/updated 当全端应用成功。

## 4. Impact Brief

### Feature Summary

模式为 planning；能力是 Built-in 在线配置供给，改动层为 option-source、validation、persistence 和生命周期。主要 seeds：`fetchZCodeBuiltinRemoteRelease`、`fetchCliZCodeBuiltinRelease`、`ZCodeBuiltinRemoteSynchronizer`、`NodeProviderConfigRuntime`、`NodeProviderRegistryRuntime`、`ProviderRegistryService`、Standalone Account 装配。

### UI Surface Matrix

| 场景／入口                        | 共享来源与提交                                                          | 展示／草稿及权威                                               | 模式与隔离                                                          |
| --------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| 模型设置刷新、模板列表、智能参数  | useModelProviders → ProviderSettingsService → refreshSources → Registry | Renderer 草稿不变；Host Config／Registry 权威，下载仅写 Active | 桌面与手机复用 Host；不能清空未保存草稿或代写 Personal              |
| 对话、自动化、Subagent、Wiki 选模 | 各自读取公共 Selection／Registry 投影                                   | 各入口保持自己的提交和保存归属                                 | 新候选可变，历史及已绑定执行不代写                                  |
| CLI／TUI                          | Standalone 下载 owner → 文件 Source／Account → Registry                 | CLI 长期运行时拥有配置生命周期                                 | 无 UI 网络下载 owner，不让短命初始化函数遗留 timer                  |
| 手机远控、远程工作区              | shared-host attachment／目标 Environment 服务                           | 手机只消费目标 Host；远程 Host 自己管理配置                    | 不另起 Agent，不复制本地 Registry，不混用 workspacePath 与 identity |

### Shared And Divergent Behavior / State Owners And Commit Sinks

App 与 CLI 共用 Release、下载和刷新算法，网络能力由装配层注入；Account 的派生来源不同。缓存唯一写入方为所属 Environment Source；Personal Repository 和各业务保存入口不受在线下载驱动。Managed Worker 消费 Host Active 与 Account 协议；Standalone 必须自己对齐 Built-in／Account。

### Feature Relationships / Must-Preserve Invariants

- must-inspect：下载入口、调度 owner、文件提交、Account 版本对齐与 Registry 发布，直接决定在线更新能否使用。
- should-inspect：设置页刷新、智能参数、各选模入口与后续 ModelFactory 创建；证明同一权威数据投影。
- conditional：Endpoint 变化、跨进程文件通知、SSH／WSL／Docker／Server 自有网络与缓存。
- invariant-only：Personal 手动覆盖、选择／历史不代写、已创建 Model 冻结、桌面 continuous／手机 replayable 分离；不得用本功能重构远控数据流。
- evidence-only：审查报告中的 60 条现有测试和运行复现；不将其视为 URL 功能已完成。

### Codegraph Evidence / Graph Drift Candidates / Graph Delta

已使用 feature-boundary-planner 的语义图和 domain map；当前无 codegraph 工具，未执行 codegraph 深度 2 扫描。改用直接源码调用／订阅追踪并运行复现，不能宣称已完成机械影响面扫描。

已追踪 App `node.ts → fetchZCodeBuiltinRemoteRelease → Source → Config → Registry`、`useModelProviders → refreshSources`、CLI `prepareCliProviderRuntimeEnv → bootstrap`、Host `zcodeAgentService → Account 同步`。语义图中的旧 remote provider authority／defaultModelRef 文字有历史漂移，现行 Design V2 的目标 Environment 权威优先；本 Todo 不改图谱或恢复旧行为。拟增图关系为在线源传输→现有 Model capability Source，实施稳定后再整理，不在审查中扩大范围。

### Unresolved Questions / Planning Handoff

本 Todo 不要求先搭发布后台。下载上限 10 MB、总超时 20 秒、现有 lease 30 秒、每分钟到期检查与正常一小时下载间隔已确定，不再作为待定项。旧字段解码导出是否仍有调用、具体 helper／生命周期接口签名，由实施查引用后确定；职责与行为须遵守 §2。若需增加客户端业务门禁、改变 Account 产品状态、引入新持久化字段或迁移、自动发线上配置，必须另行讨论，不能混入本任务。

## 5. 验证计划与交接

### Clarification Log / Dimensions / Pruning

- 用户已确认 URL 字段、CDN 完整数据、版本化 URL 不覆盖，以及 §2 的刷新职责、周期、Account 重建与失败恢复、20 秒总超时。正文上限按用户修正为 10 MB，取代 5 MiB。当前授权是落盘，不是立刻实施或发布。
- 维度：App／Standalone／Managed Worker；首次启动／运行更新／退出；missing／失败／低同高 revision；正常／慢正文／超 lease；单／多进程；Account 同版／滞后／失败；有效缓存／损坏缓存。
- 剪枝：不枚举所有模型和所有账号套餐笛卡尔积。用一个普通 API 模型和一个 Account Provider 证明配置／Account 对齐；真实模型规格分别归 Todo113／116。无 UI 布局改动，不扩展主题色／布局设计。

### Accepted Cases / Coverage Rows

以下为实施验收目标；先用测试复现缺口，再改代码。

| ID       | 设置与动作                                                                                                   | 必须断言／证据层                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| BR117-01 | client/configs 返回真实形状的 URL，CDN 返回合法新 release                                                    | App／CLI 两阶段请求，版本平台参数正确，不将 URL 当 JSON；下载→文件→Registry 一致                                          |
| BR117-02 | 缺字段、非法 URL、404／500、坏 JSON、旧 schema、坏正则／CEL                                                  | 缺省与失败区分；有效缓存不被覆盖，错误可诊断；不改变其他 client/configs 消费者                                            |
| BR117-03 | 两阶段累计慢响应、立即响应头后慢正文／不结束正文、缺省或伪小 Content-Length、正文恰好 10,000,000 与多 1 字节 | 两次请求合计 20 秒，正文计数上限 10 MB，超限／超时取消 body，in-flight 最终释放且可重试；App／CLI 同语义                  |
| BR117-04 | 并发刷新、有效 lease、超 lease 接管、迟到旧版本、同版本不同内容                                              | 有界去重、不降级或撕裂写入、旧 owner 不覆盖新控制记录；退出／Endpoint 切换不串源                                          |
| BR117-05 | 下载新版本／unchanged；假时钟每分钟推进，覆盖一小时成功间隔及 1／2／4 分钟到一小时的失败退避；dispose        | 检查发生而未到期不请求；到期才刷新，无第二份下载重试时间、重复调度或后台泄漏；不逐模型请求下载                            |
| BR117-06 | Standalone 运行中更新 Built-in，凭据不变或无账号；初始化交错；重建 20 期间再更新到 21／凭据变化              | Account 自动重建到最新事实；过期结果不发布，普通 API 也不卡住；不重新登录、不重新申请 Key、不只改 revision                |
| BR117-07 | App／Standalone Account 重建一次失败，下载仍在 TTL 内或返回 unchanged；Worker 两种到达顺序                   | 同一分钟检查能仅对未对齐状态重试 Account，无需下载；旧 Registry 保留，恢复后同版；receivedRevision 不冒充应用，不去掉护栏 |
| BR117-08 | 有个人覆盖／未保存设置草稿／已创建执行时更新                                                                 | Personal 文件、历史选择和草稿不被代写；新 Model 采用应继承的新值，旧 Model 不被替换                                       |
| BR117-09 | 两个进程监听共享文件；Windows／macOS／Linux 原子替换                                                         | 消费者实际读到新 revision；断网重启仍有可用基线，损坏 Active 回随包                                                       |
| BR117-10 | 桌面设置手动刷新、手机连接同 Host、远程 Environment                                                          | 显示／后续执行来自各自目标 Registry；真实 UI+Host／协议证据，不另起手机 runtime                                           |
| BR117-11 | 对最终发布文件执行完整性测试，然后新 URL 下载比对                                                            | 验证对象与上传对象相同，业务缺参数不能因 decoder 通过就发布；回退用更高 revision                                          |

### E2E Handoff Notes / Matrix Backfill

实施时按 e2e-case-lifecycle 接入已有 Provider 设置／配置测试目录，不在本次编写 E2E。使用本地可控 HTTP 服务模拟 client/configs 与 CDN、临时 Environment 目录、可控时钟与两个真实消费进程；不改生产字段，不需要付费模型请求。UI 验收至少串起设置页刷新→目标 Registry→随后创建的执行配置，手机使用既有 shared-host attachment。无法覆盖的系统和远程模式明确留证，不写成通过。

## 6. 待执行清单

### 2026-09-11 Goal 实施设计

已核实当前源码仍为旧内联字段。共用下载模块放 provider-node；网络通过 `request` 注入，保留 ApiClient 的网络装配，不改其通用超时实现。下载模块持有 20 秒总预算、正文实际字节上限和退出信号，错误只报告阶段，不回显 URL query 或配置正文。

生命周期复用 Node Config Runtime，下载 owner 每分钟执行一次共享检查；Account 恢复回调与下载独立，不受 TTL/missing/失败阻挡。Standalone 优先复用已有 AccountProviderService 的串行/变化机制而不是再建队列，并补发布前过期检查；Managed Worker 仍为 Host Account Source，不建立下载 owner。CLI 短入口仅物化基线，网络刷新移至长期运行时。

- [x] 更新工作区基线，重新核实线上字段和 CDN，并补本 Todo 的失败场景测试。
- [x] 接入共用 URL 下载，修正文超时、取消和资源上限，保留现有 Release schema。
- [x] 修复 Standalone Account／Builtin 对齐及启动竞态；覆盖 App／Worker 恢复边界。
- [x] 补生命周期调度与可观测结果，复用当前 lease／退避／文件锁／revision，不增加第二套状态权威。
- [x] 完成核心集成、Pro 桌面刷新 E2E、最终 revision22 文件检查及受影响测试、typecheck、lint、architecture 门禁。
- [ ] 补充手机 shared-host／SSH 联合验证和未测平台；不能由桌面通过推断全端通过。
- [x] 记录真实上线限制；线上发布由有权限流程另行执行。本轮 Goal 仅授权推送工作分支，不自动发布配置。

核心集成和门禁已执行；真实 UI／多端与最终 Todo113 目录更新后的发布文件在整批验收收口。以本 Todo 和现行 Design V2 为准，旧 Todo18 的内联字段示例仅作历史资料。

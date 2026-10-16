# 18 ZCode Built-in Config 远端同步与 LKG 兜底

> 状态：已完成
>
> 日期：2026-08-25
>
> 来源讨论：Provider Refactor 完成后的 ZCode Built-in Provider/Model 配置发布方式收口
>
> 相关任务：[`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md)、
> [`13`](./todo-13-target-host-model-selection-authority.md)、
> [`15`](./todo-15-provider-release-validation.md)、
> [`17`](./todo-17-provider-registry-settings-authority-boundary-closure.md)、
> [`19`](./todo-19-zcode-builtin-release-integrity-validation.md)
>
> 相关设计：[`configuration.md`](../design/registry/configuration.md)、
> [`registry.md`](../design/registry/registry.md)、
> [`runtime.md`](../design/registry/runtime.md)、
> [`environment.md`](../design/environment/environment.md)

## 0. 任务定位

ZCode Built-in Provider Config 与 ZCode Built-in Model Config Rules 当前只从随仓库和安装包发布的
`config/provider/zcode-builtin.json` 读取。本 Todo 将 `/api/v1/client/configs` 增加为这同一份 Built-in
事实的远端优先发布通道，并为每个 Environment 保存最近一次确认可用的远端配置（Last Known Good，LKG）。

本 Todo 只做完成该目标所需的最小改动，不统一重构现有 Client Config 基础设施：

- 不抽取全局 `ClientConfigService`；
- 不改造 `BigModelCodingPlanSubscriptionProvider` 的既有 `/client/configs` 请求、TTL 或缓存；
- 不合并 Desktop Main 的 Force Update、Computer Use、Desktop Context Prompt 请求；
- 不改变 Coding Plan、官方版本安全校验、Off-Peak 或 `modelContextBudget.strategy` 的现有配置所有权；
- 允许本阶段为 Built-in Config 增加一条独立的 `/client/configs` 请求；公共 Client Config 收口另立任务。

本 Todo 只改变 ZCode Built-in Config 的 Source 与发布时序，不改变 Provider 领域主链：

```text
ZCode Built-in Provider Config
              |
              v
    Account Provider Config
              |
              v
   Personal Provider Config
              |
              v
 Effective Provider Config

ZCode Built-in Model Config Rules
              +
 Personal Model Config Rules
              |
              v
Effective Model Config Rules
              |
              v
        Registry / ModelFactory
```

远端、LKG 与安装包配置是同一份 ZCode Built-in Source 的三个候选，不是新的 Overlay 层。

## 1. 已确认裁决

### 1.1 `/client/configs` 使用两层原子结构

服务端在 `data.configs` 下增加一个一级字段：

```ts
interface ZCodeBuiltinConfigContent {
  /** 现有 ZCode Built-in Provider Config 的纯内容。 */
  readonly providers: Record<string, ProviderConfigObject>;
  /** 现有 ZCode Built-in Model Config Rules 的纯内容。 */
  readonly modelConfigRules: readonly ModelConfigRuleObject[];
}

interface ZCodeBuiltinRelease {
  readonly schemaVersion: number;
  /** 每次发布单调递增；内容回滚也产生更大的 revision。 */
  readonly revision: number;
  readonly config: ZCodeBuiltinConfigContent;
}

interface ClientConfigFields {
  readonly zcodeBuiltin?: ZCodeBuiltinRelease;
}
```

结构只保留两层：内层 `config` 是已经存在的 Provider Config 与 Model Config Rules 纯内容，不携带
`schemaVersion`、`revision`、`fetchedFor` 或缓存状态；外层 Release 统一承担格式版本和发布顺序。

示意响应：

```json
{
  "code": 0,
  "data": {
    "configs": {
      "zcodeBuiltin": {
        "schemaVersion": 1,
        "revision": 42,
        "config": {
          "providers": {},
          "modelConfigRules": []
        }
      }
    }
  }
}
```

`config.providers` 与 `config.modelConfigRules` 必须作为同一次发布共同出现、共同解析、共同应用。客户端不支持两个独立
一级字段，不允许把远端 Provider 与本地 Model Rules 或本地 Provider 与远端 Model Rules 混合。

`zcodeBuiltin` 是 Client Config 传输边界的原子分组，不成为新的 Provider 领域对象或 Overlay 层。解析成功后
立即投影为现有 `ProviderConfigLayerSnapshot` 所需的 `ProviderConfigMap + ModelConfigRules`。

仓库/安装包中的 Built-in 也继续维护为一份完整 JSON。Provider 分组和 Model Rule 分层通过
[`configuration.md`](../design/registry/configuration.md) 规定的单文件声明顺序表达；本 Todo 不把它拆成多份
源文件，不增加配置生成/拼装流水线。Remote、Environment Active Cache 与 Bundled 始终使用上述同一个
两层 Release 形状。

### 1.2 远端配置是完整替换，不是相对 Bundled 的补丁

远端 `config.providers` 是当前 ZCode Built-in Provider 的完整有序集合，`config.modelConfigRules` 是当前完整、有序的
Built-in Rule 数组。服务端删除 Provider、模型成员或 Rule 时，客户端必须在新快照中同样删除，不能继续从
Bundled Config 补回。

```text
Bundled Release ─────┐
Active Cache Release ┼─> 选择一个兼容候选 ─> ZCode Built-in Source
Remote Release ──────┘
```

单条 Model Config Rule 继续允许稀疏；Personal Rules 仍排在 Built-in Rules 之后，不因远端同步改变顺序。
Built-in Release 的业务完整性发布门禁不属于客户端同步首版；旧 Todo 19 已废弃，未来如有需要另立发布门禁任务。

### 1.3 Bundled、LKG 与 Remote 的职责

三类物理输入分别是：

| 输入                     | 含义                                                       | 生命周期     | 是否运行时改写       |
| ------------------------ | ---------------------------------------------------------- | ------------ | -------------------- |
| Bundled Config           | 当前安装包携带的兼容基线                                   | App 发布版本 | 否                   |
| Environment Active Cache | 当前 Environment 已接受并正在使用的 Built-in；同时承担 LKG | 跨进程重启   | 是，原子替换         |
| Remote Config            | `/client/configs.data.configs.zcodeBuiltin` 当前响应       | 单次远端刷新 | 不直接作为持久化文件 |

运行时不得改写仓库中的 `config/provider/zcode-builtin.json` 或安装包只读资产。远端成功结果只原子替换所属
Environment 的可写 `active.json`。该文件既是 Host/Worker 共同读取的活动 Source，也是重启时的 LKG；不再维护
第二份 LKG 文件。

仓库/安装包配置继续在每次 Built-in 配置发布时同步更新，保证新安装和不具备有效 LKG 的客户端拥有合理
基线；这属于发布流程，不等于客户端改写源码仓库。

### 1.4 LKG 只表示 Last Known Good，不保证天然更新

LKG（Last Known Good）表示“当前 Environment 最近一次成功解析并应用的远端 Release”。它仍可能：

- 比新安装包携带的 Bundled Config 更旧；
- 由旧 App 版本拉取；
- 使用当前客户端已经不支持的 Schema；
- 因文件损坏而无法解析；
- 来自同一机器上不同平台或 Environment 的错误缓存路径。

因此启动时不能无条件让 LKG 覆盖 Bundled。Active Cache 只有满足以下条件才是候选：

1. Release 外壳可读取；
2. `schemaVersion` 为当前客户端支持版本；
3. Provider Config 与 Model Config Rules 能由当前正式 Parser 解析；
4. `Active.revision >= Bundled.revision`。

```text
Bundled valid ────────┐
                      +--> compatibility gate --> max revision --> startup snapshot
LKG readable/valid ───┘

LKG incompatible / older
└─ ignore LKG, use Bundled

Bundled and LKG both invalid
└─ fail Provider Runtime startup; do not create empty/fake fallback
```

第一版通过 `<platform>/<appVersion>/<endpointKey>/active.json` 物理路径隔离 Cache，不把 `fetchedFor` 再写入 JSON，也不因
JSON 恰好可解析就跨版本复用。后续若需要跨补丁版本复用，必须先建立明确的兼容范围，不在本 Todo 推断。

### 1.5 `revision` 必须可排序并由同一发布流程生成

普通内容 Hash 或 HTTP ETag 只能判断相同/不同，不能判断 LKG 与 Bundled 谁更新。本 Todo 要求
`zcodeBuiltin.revision` 使用服务端单调递增整数，并同步写入同次发布生成的 Bundled Config。

内容回滚也必须产生新 revision：

```text
revision 40 -> content A
revision 41 -> content B
revision 42 -> rollback to content A
```

客户端按 revision 判断发布顺序，不比较本机文件时间，也不把内容 Hash 当成可排序版本。Source 仍可用标准化
内容 Hash 作为进程内相同内容去重信息，但它不替代发布 revision。

### 1.6 只有 Environment 组合根负责远端同步

每个执行 Environment 拥有自己的 Built-in 配置和 LKG：

```text
Local Environment Host
├─ fetch /client/configs
├─ Local LKG
├─ Local Registry
└─ Local Core Workers read/watch the selected local file

SSH / Server Environment Host
├─ fetch /client/configs
├─ Remote LKG
├─ Remote Registry
└─ Remote Core Workers read/watch the selected remote file
```

Desktop 控制远程 Workspace 时只读取 Remote Host 的 Settings/Selection Facade。Desktop 不把本地
`zcodeBuiltin`、LKG、Registry Snapshot 或 Provider/Model 静态事实推给远端。

普通 Core Worker 不独立请求 `/client/configs`。Host 先选择启动候选并把同一可读 Built-in 文件路径提供给
Worker；远端成功更新后原子更新该 Environment 的活动文件，由 Host 和 Worker 的现有 Source watcher 刷新。
这样避免每个 Workspace 重复请求和同一 Environment 内多个 revision 并存。

### 1.7 远端更新只影响后来创建的 Model

```text
Remote Built-in refresh
        |
        v
Source change -> Account refresh -> Registry rebuild -> Facade update
                                                |
                                                v
                                  later ModelFactory.create()

already-created Active Model
└─ remains frozen for its execution
```

远端刷新可以改变新的 Settings View、Selection View、Provider 成员和后来创建的 Model，但不能热改已创建
Active Model 的 Endpoint、API Type、Properties、Option Specs 或 Reasoning Mapping。

### 1.8 本轮明确不统一 Client Config

当前 `/client/configs` 仍由多条生命周期不同的链路读取：

- `BigModelCodingPlanSubscriptionProvider` 内的商品、套餐、官方版本安全校验、Off-Peak、Context Budget 等；
- Desktop Main 的 Computer Use 与 Desktop Context Prompt 灰度；
- Desktop 启动前 Force Update gate。

本 Todo 不重排这些 owner，不建立公共 `IClientConfigService`，也不为了消除重复请求扩大改造范围。Built-in
同步实现可以复用现有 `ApiClient`、Endpoint 与平台参数工具，但不能依赖 Coding Plan Provider，也不能让
Provider Config Source 反向依赖 Subscription Service。

允许的最小新增关系是：

```text
Environment composition root existing ApiClient
              |
              v
ZCode Built-in remote fetch/synchronizer
              |
              v
Built-in active Source file（同时承担 LKG）
```

后续统一 Client Config 时可以把这条网络读取迁入公共 Transport/Service；不得改变本 Todo 已确认的
Environment 所有权、原子 `zcodeBuiltin` 契约和 Active Cache 选择边界。

### 1.9 Environment 级落盘刷新消抖

进程内 `inFlight` 不能阻止同一 Environment 的多个 Desktop Host、CLI 或 Server Entry 重复请求。每个
Environment 在按 Endpoint 隔离的 Active Cache 旁维护 `refresh-control.json`，以文件锁和可过期 lease 协调刷新：

```text
多个 Entry 请求刷新
        |
        v
锁 refresh-control.json
        |
        +--> nextEligibleAt 未到或已有有效 lease：跳过网络
        |
        `--> 写入短期 lease 后释放锁
                    |
                    v
                 请求远端
                    |
                    v
              重新加锁并比较 revision
                    |
          成功：原子替换 active.json，记录下次时间
          失败：保留 active.json，记录递增退避
```

网络请求期间不持有文件锁；进程崩溃后 lease 到期即可接管。成功刷新使用一小时量级间隔，失败使用有上限的
递增退避。显式刷新可以绕过 `nextEligibleAt`，但不能绕过仍有效的 lease。Endpoint 变化必须改变控制文件中的
`endpointKey`，使新 Endpoint 不受旧 TTL 阻塞。

## 2. 失败与刷新语义

### 2.1 启动

```text
read Bundled + read LKG
          |
          v
choose compatible max revision
          |
          v
publish immediately
          |
          v
start remote refresh in background
```

远端网络请求不阻塞 Provider Runtime 使用本地有效候选完成首次 ready。若本地没有任何有效候选，则启动失败；
不得为等待网络而发布空 Registry，也不得制造半完整 Provider。

### 2.2 远端响应分类

| 情况                           | 处理                                     |
| ------------------------------ | ---------------------------------------- |
| HTTP/超时/JSON/Envelope 失败   | 保持当前 Snapshot 与 LKG，记录可诊断错误 |
| `configs.zcodeBuiltin` 缺失    | 视为服务端尚未下发，保持当前 Snapshot    |
| Schema 不支持                  | 拒绝响应，保持当前 Snapshot 与 LKG       |
| Provider/Rule 严格解析失败     | 拒绝整份响应，不做局部应用               |
| revision 小于当前有效 revision | 视为陈旧响应，忽略                       |
| revision 等于当前且内容一致    | 去重，不写盘、不通知                     |
| revision 等于当前但内容不同    | 视为发布协议错误，拒绝并记录错误         |
| revision 更高且兼容解析成功    | 原子替换 Active Cache，随后发布变化      |

### 2.3 写入与发布顺序

```text
remote payload
      |
      v
strict envelope/domain parse
      |
      v
atomic replace active.json
      |
      v
publish Source changed
```

若持久化失败，本轮远端更新不进入 Host 内存 Registry。这样已运行 Host、后来启动的 Worker 和重启恢复不会
各自看到不同事实。写入必须使用 Environment 明确的可写路径、文件锁和原子替换，不依赖源码路径、宽泛环境
变量或跨 Environment 共享缓存。

## 3. 实施范围

### Step 0：先更新正式 Design

- 在 Environment Design 中把 Management Service 的长期蓝图收敛为本轮 `/client/configs.zcodeBuiltin` 入口；
- 在 Configuration/Runtime Design 中写明 Bundled/LKG/Remote 是同一个 Built-in Source 的候选；
- 写明 Environment 组合根是同步 owner，Core Worker 只读活动文件；
- 写明当前不统一 Client Config Service。

### Step 1：定义两层 Release Schema 与缓存路径

- 为 `configs.zcodeBuiltin` 建立严格运行时 Schema；
- 增加单调递增 `revision` 与 `schemaVersion`；
- 内层 `config` 只保存现有 Provider Config 与 Model Config Rules 内容；
- Bundled、Remote 与 Active Cache 使用完全相同的两层 Release 结构；
- 以 `<platform>/<appVersion>/<endpointKey>/active.json` 路径表达缓存兼容范围，不在 JSON 中增加 `fetchedFor`；
- 不向 Provider Domain 引入 Remote Config Document 类型。

### Step 2：建立本地候选选择与原子 Repository

- 读取并分别兼容解析 Bundled 与 Active Cache；
- 按兼容性与 revision 选择启动候选；
- Active Cache 缺失、损坏、过旧或不兼容时自然使用 Bundled；
- `active.json` 同时承担活动 Source 与 LKG，只做一次带锁原子替换；
- 不写入仓库/安装包文件。

### Step 3：增加最小远端同步器

- 在 Environment 组合根使用现有 `ApiClient` 请求 `/client/configs`；
- 使用当前 Environment 的 Endpoint、App Version 和平台参数；
- 对原子 `zcodeBuiltin` 执行严格 Envelope 与现有 Provider/Model Config Parser 兼容解析；
- 使用落盘 `refresh-control.json`、可过期 lease、请求超时和递增退避做 Environment 级去重；
- 多 Host 共享同一 Environment 路径时在文件锁内重新比较 revision，防止晚到请求陈旧覆盖；
- 不修改其他 Client Config 消费者。

### Step 4：接入 Host/Worker Source 路径

- Local Host 与 Remote Host 各自使用所属 Environment 的活动 Built-in 文件；
- spawn 的 Core Worker 继续取得同一路径并使用现有文件 Source/watcher；
- Prompt CLI、TUI、standalone server 等没有 Desktop Local Host 的 Environment Entry 明确拥有同等同步 owner；
- Desktop attached remote 只消费 Remote Host Facade，不建立本地推送路径。

### Step 5：刷新与生命周期

- 本地有效候选完成首次 ready 后后台刷新一次；
- 后续刷新频率先沿用一小时量级 TTL，并提供显式 refresh 入口；
- 网络恢复可以触发重试，但失败不清空当前 Snapshot；
- dispose 后禁止晚到请求写盘或发布变化；
- 配置变化触发现有 Account Source 与 Registry 刷新，不建立第二套 Registry 同步。

### Step 6：清理与验证

- 删除仅因旧单文件 Source 假设而存在的路径硬编码；
- 不删除或重构其他 `/client/configs` 链路；
- 更新发布构建，确保 Bundled 与远端发布 revision 来自同一配置发布流程；
- 增加本 Todo 的单元、集成和目标 Environment 验证。

## 4. 测试计划

### 4.1 Schema 与原子性

- `zcodeBuiltin` 完整对象严格解析；
- 缺失 `config.providers`、`config.modelConfigRules`、`schemaVersion` 或 `revision` 时整份拒绝；
- 未知旧 `builtinProviders/builtinModels` 不进入正式 Source；
- Rule 正则、Provider API/Access、Model Properties 与 Reasoning Mapping 使用当前正式 Schema；
- 不在客户端增加已废弃 Todo 19 所讨论的额外 Built-in 业务完整性规则集。

### 4.2 Bundled/LKG 选择

- 无 LKG 使用 Bundled；
- 有效且更新的 LKG 胜出；
- LKG revision 更旧时使用 Bundled；
- 旧 appVersion、错误 platform 由缓存路径隔离；未知 Schema、损坏 JSON 或 Domain Parser 失败的 Cache 均被忽略；
- Bundled 与 LKG 都无效时明确失败；
- App 升级后不复用旧版本 LKG。

### 4.3 远端刷新

- 更高 revision 成功解析、原子替换 `active.json` 并只发布一次变化；
- 同 revision 同内容去重；
- 同 revision 不同内容拒绝；
- 更低 revision、晚到陈旧请求不覆盖当前配置；
- HTTP、超时、JSON、Envelope、Schema、Domain Parser 和写盘失败均保留当前 Snapshot/Active Cache；
- dispose 后晚到响应不写盘、不通知。
- 多 Host/Entry 同时刷新时只有一个取得落盘 lease 并请求服务端；
- lease owner 崩溃后可在过期后接管；Endpoint 变化不受旧 TTL 阻塞；
- 失败使用有上限的递增退避，显式刷新仍不绕过有效 lease。

### 4.4 Environment 与执行

- Local Host 与其 Core Worker 读取同一活动 Built-in revision；
- Remote Host 与 Remote Worker 使用远端 Environment 自己的 LKG；
- Desktop attached remote 不使用 Desktop 本地 Built-in；
- 多 Workspace Worker 不各自请求 `/client/configs`；
- Built-in 更新后 Settings/Selection View 更新；
- Account Provider 按新 Built-in 重新约束；
- 已创建 Active Model 不变化，后来创建的 Model 使用新 revision；
- Personal Provider/Model Config 不被远端更新重写，继续作为最后 Overlay。

### 4.5 回归

- Coding Plan 商品、套餐、官方版本安全校验、Off-Peak 与 Context Budget 的原 Client Config 行为不变；
- Desktop Computer Use、Desktop Context Prompt 与 Force Update 请求链不变；
- Desktop continuous 与 Web Remote replayable 的 Session/Task 数据链不受影响；
- Provider 设置、模型选择、Connectivity、Automation、Subagent、Repo Wiki 和 Off-Peak 仍通过目标 Host Facade；
- `pnpm typecheck`、`pnpm lint`、受影响单测与相关 Desktop/Remote E2E 通过。

## 5. 完成定义

- `/client/configs.data.configs.zcodeBuiltin` 成为远端 Built-in 的唯一传输字段；
- Provider 与 Model Rules 原子发布、原子校验、原子应用；
- Bundled 与 Active Cache 按兼容性和 revision 正确选择；
- `active.json` 同时承担活动 Source 与 LKG，写入不会修改仓库或安装包资产；
- 每个 Environment 组合根自己拉取、缓存和发布，Core Worker 不独立请求；
- Remote Workspace 不接受 Desktop 本地 Built-in 推送；
- 远端失败、陈旧、损坏和不兼容配置均不会破坏当前可用 Registry；
- 配置刷新只影响后来创建的 Model；
- 其他 Client Config 消费者没有被顺手重构；
- Design、测试、类型检查与 Lint 同步完成，并以 Conventional Commit 提交。

## 6. 明确不做

- 不建立全局或跨进程 Client Config 单例；
- 不统一 `BigModelCodingPlanSubscriptionProvider`、Desktop Main 与 Force Update 的 Client Config 请求；
- 不持久化整份 `/client/configs`，只持久化验证后的 `zcodeBuiltin`；
- 不把远端、LKG、Bundled 建模为三层 Provider Overlay；
- 不允许 Remote Provider Config 与 Bundled Model Rules 混合；
- 不恢复旧 `builtinProviders`、`builtinModels`、Catalog、Preset 或具体模型 hardcode；
- 不修改 Account Access、Personal Config、凭据、请求鉴权或服务端最终授权语义；
- 不修改模型选择、队列、恢复、Continuous/Replayable 或 Session 生命周期。

## 7. 实施记录

2026-08-25 已按本文完成：

- `@zcode/provider-node` 增加严格两层 Release Schema、Bundled/Active 候选选择、原子 Active Source、
  跨进程刷新控制文件与 Remote Synchronizer；
- 正式 `config/provider/zcode-builtin.json` 已迁为 `revision=1` 的两层 Release；
- Services Environment 组合根使用当前 Endpoint、App Version、平台参数和既有 `ApiClient` 后台读取
  `/api/v1/client/configs`；Local/Remote Host 向 Worker 注入 Active 路径；
- Standalone Server 复用 Services owner；独立 Prompt CLI/TUI 负责自己的 Active/LKG 与后台刷新，Host
  显式注入路径时不重复刷新；
- Settings 显式刷新会触发 Built-in Remote、Account Source 与 Registry 的既有刷新链；
- 未修改其他 Client Config 消费者，未增加额外的发布者业务完整性校验。

核心自动化覆盖严格解析、候选选择、相同 revision 冲突、远端新旧 revision、原子更新、跨进程 lease、
Endpoint 变化、dispose 晚到响应、Services 组合根、Remote Host owner、Worker Active 路径及 CLI/SEA 入口。

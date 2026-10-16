# 07 Account Connection 选择与 Access 上下文收口

> 状态：已完成
>
> 日期：2026-08-24
>
> 来源审查：[`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> 目标设计：[`../design/registry/configuration.md`](../design/registry/configuration.md)、
> [`../design/registry/runtime.md`](../design/registry/runtime.md)、
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md)
>
> 前置：[`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)
> 先建立唯一 Registry 完整类型边界；本任务原位加强 `zhipu-account` 的结构化 Access 与完整性。

## 0. 实际交付

- Settings 已只保存 `providerFamilyConnectionSelections`；旧 mode/selected-key 双状态退出正式生产链；
- Start、Individual、Team 由 Built-in Provider 自己声明固定 `family + planKind`，Account Resolver 按结构化
  selection 产生完整 Account Overlay，不维护 Provider ID 到套餐的运行时对照表；
- enabled Account Provider 的完整 Access 被固定进 Registry/Active Model，请求鉴权只消费该结构，
  `accessId` 对消费方保持 opaque；
- Off-Peak 与 Official MCP 已消费完整 Account Access，不再解析 connection key 或比较 scoped/unscoped ID；
- Account accessId、credential 缓存、账号切换失效和 Team scope 由同一 Credential/Auth 链处理；
- 旧 Settings 字段和旧字符串 key 只存在测试/一次性迁移输入，不进入当前 AppSettings、Protocol、Registry 或
  Request Auth。

## 1. 任务目标

把 Provider Family 的用户连接选择、Account Connection 事实、Account Built-in Provider Config 和请求期
鉴权收敛成一条结构化链路，删除 `selectedConnectionKey` 和 `accessId` 字符串解析形成的隐式协议。

```text
当前

AppSettings
├─ modelProviderFamilyModes[family]
└─ modelProviderFamilySelectedKeys[family]
          |
          | preset:/coding-plan:/team-plan: 字符串
          +--------------------+----------------------+------------------+
          |                    |                      |                  |
          v                    v                      v                  v
Account Resolver       Settings / Usage       Off-Peak / MCP       Task / Session
          |                    |                      |                  |
          `-------- 各自 parse / match / rebase / startsWith -----------'
                               |
                               v
                  scoped accessId 再次编码账号身份

目标

AppSettings.providerFamilyConnectionSelections
          |
          | 结构化用户选择意图
          v
Account Connection Resolver
├─ current account（内部事实）
├─ entitlement / availability
└─ selected structured connection
          |
          v
Account Connection Result
├─ status
├─ resolved access { family, planKind, Team scope?, opaque accessId }
└─ models?
          |
          v
Account Built-in Provider Config
          |
          +--> Registry / Model 固定 Account Access
          +--> Request Auth
          +--> Off-Peak
          `--> Official MCP
```

本任务不是给 `selectedConnectionKey` 改名，也不是把当前字符串 parser 集中到另一个 helper。目标是让
Settings 只保存结构化选择意图，让 Account Connection Resolver 成为唯一解释者，并让执行消费方直接读取
Provider Config 中已经解析完成的 Account Access。

Todo 03 不提前实现本任务的结构化账号 Access，也不创建临时 Account Access DTO。Todo 03 的
`RegistryProviderConfig` 先按当时已经存在的 Access Schema 收窄；本任务修改 `ZhipuAccountAccessConfig`
时，同步扩充同一个 `CompleteProviderAccessConfig`、`requireComplete` 和完整序列化契约。

## 2. 已确认裁决

### 2.1 用户选择使用结构化单字段

删除两份必须原子维护的 Settings 状态：

- `modelProviderFamilyModes`；
- `modelProviderFamilySelectedKeys`。

替换为：

```ts
type ProviderFamilyConnectionSelection =
  | { kind: "api-key"; providerId: string }
  | { kind: "start-plan" }
  | { kind: "individual-coding-plan" }
  | {
      kind: "team-coding-plan";
      productId: string;
      organizationId: string;
      projectId: string;
    };

interface AppSettings {
  providerFamilyConnectionSelections?: Partial<
    Record<ProviderFamilyDomain, ProviderFamilyConnectionSelection>
  >;
}
```

`kind` 已经包含 API Key/OAuth 与具体套餐形态，不再维护独立 mode。`providerFamilyDomain` 继续表达当前激活
的 Provider Family，不在本任务中删除或合并。

Account Plan 选择不保存 Built-in Provider ID，也不从 Built-in Provider ID 推断套餐。外层 Family、`kind`
和 Team Scope 是 Account Connection Resolver 查找连接的结构化输入；API Key 选择保留用户实际选择的
Provider ID。当前登录账号由 Account Connection Service 内部参与解析，不进入 Settings 或 Provider Config。

### 2.2 Start、Individual 与 Team 是独立 Built-in Provider

同一 Family 的 Start Plan、Individual Coding Plan、Team Coding Plan 分别定义为独立 ZCode Built-in
Provider。每个 Provider 的 `access.family` 和 `access.planKind` 固定，不允许一个 Coding Plan Provider
在运行时于 Individual 与 Team 之间变形。

正常 Settings 流程在同一 Family 的互斥账号连接中只选择一个；Account Built-in Overlay 只为匹配
`family + planKind` 的 Provider 补齐 Access 并设为 enabled，其余账号 Provider 设为 disabled。Resolver
扫描 Built-in Provider 自己声明的 Access，不维护 Start/Individual/Team Built-in Provider ID 对照表。

Individual 与 Team 可以声明相同的模型 ID；Registry 身份仍是 `providerId + modelId`。正常选择流程只有
一个 Provider enabled，所以 Selection 只出现当前连接下的模型。用户手工通过 Personal Config 启用多个
Provider 时遵循普通 Config 语义，不增加来源权限校验。

目标 Built-in 身份使用明确名称，不保留“一个 Coding Plan Provider 同时代表两种 Plan”的正式语义：

```text
builtin:zai-start-plan
builtin:zai-individual-coding-plan
builtin:zai-team-coding-plan

builtin:bigmodel-start-plan
builtin:bigmodel-individual-coding-plan
builtin:bigmodel-team-coding-plan
```

旧 `builtin:*-coding-plan` 只存在于一次性 Settings/Personal/Selection importer。迁移器能从同一次迁移的
结构化选择明确判断 Individual 或 Team 时映射到对应新 Provider；无法判断的手工配置产生明确诊断，不
复制到两个 Provider，也不长期保留运行时 alias。强制升级窗口结束后删除 importer 和旧 ID 常量。

### 2.3 Account Connection 是连接事实权威

Account Connection Resolver 读取当前 Family、结构化选择、登录账号身份、权益、Credential Port 和 Plan
API，输出按 Provider 区分的结果：

```ts
type AccountProviderConnectionResult =
  | {
      providerId: string;
      status: "available";
      access: CompleteZhipuAccountAccessConfig;
      models?: readonly string[];
    }
  | {
      providerId: string;
      status: "unavailable";
    };
```

Renderer、Usage、Off-Peak、Official MCP、Task 和 Session 不再各自解释 Settings 字符串。

### 2.4 Provider Config 固定结构化 Account Access

`zhipu-account` Access 目标结构：

```ts
type ZhipuAccountAccessConfig =
  | {
      type: "zhipu-account";
      accessId?: string | null;
      family: "zai" | "bigmodel";
      planKind: "start-plan" | "individual-coding-plan";
    }
  | {
      type: "zhipu-account";
      accessId?: string | null;
      planKind: "team-coding-plan";
      family: "zai" | "bigmodel";
      productId?: string | null;
      organizationId?: string | null;
      projectId?: string | null;
    };
```

ZCode Built-in Provider Config 先声明固定 `family + planKind`；Team 的具体 Scope 和所有 Plan 的
`accessId` 可以缺省。Account Connection Resolver 使用这些字段与 Settings 选择、当前账号和权益查找连接；
Account Built-in Provider Config 整体替换为同一 Plan 的完整 Access。Registry 要求 enabled Account
Provider 的 `accessId` 非空，Team 还要求完整 Scope。

Account Built-in Provider Config 是 Provider/Model 执行所需的不可变快照。`accessId` 是稳定、非敏感的
连接身份，但消费方必须把它当作 opaque value，不能从中识别 Plan、Family、Team Scope 或账号身份。
当前账号身份只由 Account Connection Service 内部用于生成、查找和失效 `accessId`；账号切换后旧
`accessId` 无法再取得凭据，不把 `accountIdentity` 复制进 Provider Config。

本任务可以暂时保持现有 accessId 字节格式和 Credential Store key，避免无必要的凭据迁移；“保持现有
格式”不构成继续解析该格式的许可。兼容窗口结束后，只有 Account Source/Importer 内确实仍需要的旧格式
迁移代码可以保留到统一退役点。

### 2.5 UI 可编辑性不是 Schema 权限

设置页可以不展示 Account Access，也可以把 Built-in 字段设为只读，但 Config Schema 不因此禁止用户手工
书写这些字段。Personal 继续使用通用整体 Overlay：

```text
UI 不提供 Account Access 编辑
        !=
Personal Schema 禁止表达 Account Access
```

Schema 和 Registry 只检查结构、discriminant 与 Effective Config 完整性，不检查 `accessId` 或账号
Access 字段是否由 Account Built-in Source 产生。用户手工写入结构完整但业务无效的连接时，由 Request
Auth 或服务端鉴权失败，不增加 Source 权限系统。

### 2.6 Off-Peak 与 Official MCP 属于本任务

Off-Peak 和 Official MCP 当前都重新读取 Settings 并解析 `selectedConnectionKey`。本任务负责把二者迁移到
Account Connection / Effective Account Access，不留给 M4 或其他任务。

Off-Peak 当前还存在一个明确 bug candidate：生产 Account Provider 的 `accessId` 带账号作用域，而
`selectedConnectionKey` 不带，代码直接比较两者会把有效连接判为不可用。目标实现删除这次比较，不增加
“去作用域后再比较”的兼容 helper。

## 3. 当前事实与影响面

当前精确文本扫描显示，`modelProviderFamilySelectedKeys` 或 `selectedConnectionKey` 至少出现在 37 个非单测
文件中：UI 18、Services 11、Shared 5、Desktop 3。

| 范围                       | 当前职责                                 | 目标                                    |
| -------------------------- | ---------------------------------------- | --------------------------------------- |
| AppSettings / Schema       | 持久化 mode 与字符串 key                 | 单一结构化 selection                    |
| Provider Settings          | 导航、切换、恢复与 pending state         | 编辑结构化 selection                    |
| Account Resolver           | 解析 Plan/Team key 并生成 accessId       | 按 Access 字段查找连接并生成 accessId   |
| Request Auth               | 从 accessId 识别 Plan、账号与 Team Scope | 消费完整 Account Access                 |
| Usage / Entitlement        | 从 selected key 生成查询上下文           | 消费 Account Connection View            |
| Session / Task / Repo Wiki | 层层透传 selected keys                   | 删除透传，使用 Registry/Account Service |
| Off-Peak                   | 解析 Settings、比较两种 ID               | 消费当前 Account Access                 |
| Official MCP               | 重复解析 Plan 与 Team Scope              | 消费当前 Account Access                 |
| Desktop remote host        | 临时构造 selected key map 求 Team Key    | 直接传结构化 Account Access             |

### 3.1 UI Surface Matrix

| 用户场景              | UI 入口                   | Draft/展示 owner        | 提交落点             | 本任务变化               | 隔离边界                      |
| --------------------- | ------------------------- | ----------------------- | -------------------- | ------------------------ | ----------------------------- |
| 切换 API Key/套餐连接 | Provider Settings         | 本地 pending selection  | AppSettings          | 一次提交结构化 selection | 不改 Personal Provider Config |
| 查看当前连接与套餐    | Provider Settings / Usage | Account Connection View | 无或 Usage 请求      | 不解析 accessId/key      | 动态额度不进入 Registry       |
| 选择模型              | Composer model control    | Composer Draft          | Session/Task command | 候选只来自 Registry      | 不在模型选择器切换连接        |
| 创建闲时任务          | Off-Peak entry            | Off-Peak support view   | Off-Peak service     | Host 消费 Account Access | 不把凭据发给 Renderer         |
| OAuth 登录后恢复连接  | Root callback             | AppSettings             | Setting Service      | 写结构化 selection       | Settings mount 不重排有效选择 |

Automation、Subagent 与 Repo Wiki 只共享 Registry 模型候选，不拥有 Account Connection selection。当前向这些
路径透传 selected keys 的代码是待删除桥接，不代表产品语义。

### 3.2 State owner 与提交落点

| 状态/事实                    | 权威 owner                        | 持久化/缓存                      | 消费方                        |
| ---------------------------- | --------------------------------- | -------------------------------- | ----------------------------- |
| 用户当前连接选择意图         | AppSettings structured selection  | `setting.json`                   | Account Resolver、Settings UI |
| 当前账号身份与权益           | OAuth/Account/Plan services       | 各自既有缓存                     | Account Resolver              |
| 当前可用 Account Connection  | Account Provider Service          | last-known-good Account Source   | Registry、Account Views       |
| Provider 执行 Account Access | Effective Provider Config / Model | Registry revision / Active Model | Request Auth                  |
| API Key/JWT/Team Secret      | Credential / Request Auth service | 既有 Credential Store            | 单次 request attempt          |
| Off-Peak Ticket/Auth         | Off-Peak execution context        | 当前派发内存                     | idle Model request-auth       |

## 4. Impact Brief

| 字段             | 结论                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Developer intent | 删除账号连接字符串协议与跨层透传，统一选择、Provider Access 和请求鉴权                                           |
| Capability       | Provider Registry、Plan Entitlements、Provider Settings、Off-Peak、Official MCP                                  |
| Change layer     | `persistence`、`option-source`、`validation`、`commit-effect`                                                    |
| Operating mode   | implementation-handoff                                                                                           |
| Primary seeds    | `AccountProviderConnectionResolver`、`AppSettings`、`resolveOffPeakCredentials`、`resolveOfficialMcpCredentials` |
| Out of scope     | 套餐产品逻辑重做、远程 Provisioning、凭据中心重构、Queue/Recovery、Model 选择生命周期                            |

| 等级           | 关系                                                    | 原因                                           |
| -------------- | ------------------------------------------------------- | ---------------------------------------------- |
| must-inspect   | AppSettings -> Provider Settings -> Account Resolver    | selection 的 persistence/commit 主链           |
| must-inspect   | Account Resolver -> Account Built-in Config -> Registry | 结构化连接事实的唯一投影链                     |
| must-inspect   | Active Model -> Request Auth                            | 账号切换时旧 Model 不能跟随新账号              |
| must-inspect   | Account Access -> Off-Peak / Official MCP               | 当前重复解析字符串且闲时存在 ID 比较断点       |
| should-inspect | Usage / Entitlement / Sidebar                           | 当前从 selected key/accessId 重建产品上下文    |
| conditional    | Local/Remote Host Account Source                        | 远端 Environment 必须使用自己的 Account Source |
| invariant-only | desktop continuous / mobile replayable                  | 本任务不改变 task/session/stream 恢复语义      |
| evidence-only  | 现有 connection-key helper tests                        | 只证明旧协议行为，不证明旧抽象应保留           |

功能图已经记录 Account Connection 来源权威、Provider 执行快照和 UI/Schema 解耦不变量。当前环境没有可
调用的 codegraph 工具，本影响面使用语义图与精确 `rg` 调用点复核；实施前仍需用 `dep:refs`、TypeScript
和测试补足符号级证据。

## 5. 实施范围与顺序

### Step A：测试冻结与结构化选择

- 为 API Key、Start、Individual、Team project 选择和重启恢复先写失败测试；
- 在 Shared 定义结构化 selection 与严格 Schema；
- AppSettings 改为单一 `providerFamilyConnectionSelections`；
- Provider Settings pending state、保存、OAuth 回调恢复和默认初始化一次提交完整 selection；
- `providerFamilyDomain` 保持独立。

### Step B：Account Connection 与 Provider Access

- 为每个 Family 分别定义 Start、Individual、Team Built-in Provider；删除 Individual/Team 共用 Provider；
- 每个 Provider 固定声明 `access.family + access.planKind`，Team Effective Access 额外携带完整 Scope；
- Account Resolver 按结构化 Access 和 selection 查找连接，不维护 Built-in Provider ID 对照表；
- `AccountProviderConnectionResult.available` 返回完整 `ZhipuAccountAccessConfig`；
- Account Connection Service 内部使用当前账号生成和失效 opaque accessId，不把 accountIdentity 投影进 Config；
- Account Built-in Config 为选中 Provider 整体投影完整 Access、可选 builtinModelIds 和 enabled=true；同一互斥范围的其他 Account Provider 投影 enabled=false；
- Account Resolver 成功时原子发布整份结果；外部依赖失败时由 Service 保留整份上一版 Snapshot，不做局部 LKG；
- 删除逐 Provider `unknown + previousProviders` 的半套恢复分支，不新增 Family/Provider 故障隔离协议；
- `validateComplete` / `requireComplete` 校验结构完整性，不校验字段来源或真实权益；
- ModelFactory/Model 原样固定完整 Account Access。

### Step C：Request Auth 与消费方收口

- Request Auth 按 `family + planKind` 选择鉴权流程，按 opaque accessId 取得对应动态材料；
- Team Key/Header 使用 Access 中的明确 Scope，不解析 accessId；
- 删除 Request Auth 和 Account Resolver 中 Family/Plan 到 Built-in Provider ID 的硬编码映射；
- Usage、Entitlement、Reset、Sidebar 和 Provider Settings 使用 Account Connection View；
- Host 不再按 `start-plan:` 前缀判断是否需要官方版本安全校验；Request Auth 通过既有类型化交互/错误边界表达；
- 保持 Credential Store 当前以完整 accessId 构造的 key，除非测试证明必须迁移。

### Step D：删除跨层 selection 透传

- 删除 ZCodeTask、ZCodeSession、Agent、workspace prepare、Repo Wiki、thought catalog 中的 selected keys 参数；
- Runtime 只通过 Registry 中的 Provider/Model 取得执行 Access；
- Renderer 只在 Provider Settings 修改 selection，不把它塞进 ModelSelection 或 Session state；
- Remote Workspace 继续由目标 Environment 的 Account Source 产生 Account Built-in Config。

### Step E：Off-Peak 与 Official MCP

- Off-Peak 取得当前有效 Individual/Team Account Access；Start/API Key 继续按产品规则拒绝；
- 删除 scoped accessId 与 unscoped selected key 的直接比较；
- `OffPeakCredentialSnapshot`、`OffPeakCodingPlanSupport` 删除 `selectedConnectionKey`；
- Official MCP 使用同一 Account Access 判断 Individual/Team scope；
- 凭据解析前后继续执行一致性检查，但比较 Account Source revision/结构化连接，不拼接两代凭据；
- Renderer 不接收 JWT、API Key、Team Secret 或其他动态凭据。

### Step F：迁移与机械删除

- Repository 读取旧 AppSettings 时执行一次性 mode/key -> structured selection 迁移；
- 只迁移可明确识别的 `preset:`、`coding-plan:` 和完整 `team-plan:`；损坏值不猜测；
- 将旧通用 `builtin:*-coding-plan` Provider ID 按同一次结构化选择迁移为 Individual 或 Team ID；
- 迁移 Settings、Personal Provider key 和尚需恢复的持久化 ModelSelection；歧义手工配置报告诊断，不向两个新 Provider 复制；
- 不双写旧字段，不在正式业务代码中长期双读；
- 强制升级兼容窗口结束后删除迁移函数、旧 schema 字段和 parser/matcher tests；
- 删除 connection-key create/parse/matches/rebase helper 及无调用方的 legacy accessId parser。

## 6. 测试先行

### 6.1 Settings 与迁移

1. API Key、Start、Individual、Team selection 严格 round-trip；
2. mode 与 selected key 原子迁移为一个结构化值；
3. Team migration 保留 product/organization/project；
4. 损坏旧 key 不猜 Plan 或 Team Scope；
5. OAuth 回调只更新目标 Family，其他 Family selection 不变；
6. Settings mount 不覆盖仍有效的已保存 selection；
7. 用户切换连接一次写入，不出现 mode/key 半更新状态。
8. 旧通用 Coding Plan Provider ID 根据明确 selection 迁移到 Individual 或 Team；歧义输入不猜测或双写。

### 6.2 Account Provider 与 Registry

1. Start、Individual、Team 各自对应独立 Built-in Provider，Plan 类型不会运行时变形；
2. Team 额外产生完整 product/organization/project；
3. Resolver 可以根据结构化 family/planKind/Team Scope 查得 accessId，无 Built-in Provider ID 对照表；
4. 正常选择 Individual 时仅 Individual Provider enabled，选择 Team 时仅 Team Provider enabled；
5. Token/Runtime Key 刷新不改变 Account Access；账号或 Team project 切换产生新 Access；
6. Account 刷新成功时整体发布，任一外部依赖失败时整份上一版 Snapshot 保持不变；
7. Personal 可以整体覆盖 access，不做来源资格校验；
8. 手工 fake access 结构完整时通过 Config 完整性，Request Auth 或服务端失败；
9. enabled Account Provider 缺 accessId，或 Team 缺 Scope 时不能进入 Registry。

### 6.3 Request Auth、Off-Peak 与 MCP

1. Start、Individual、Team Request Auth 不解析 accessId 字符串；
2. 账号切换后旧 accessId 无法取得新账号凭据并在网络前失败；
3. Team Header/Key 使用 Access 中的明确 Scope；
4. Off-Peak 的 scoped Account Access 正常解析，不再触发错误的 `connection_unavailable`；
5. 选择切换发生在凭据解析过程中时整轮重试，不混用两代凭据；
6. Official MCP 的 Individual/Team scope 与 Account Access 一致；
7. Start/API Key 对 Off-Peak/MCP 的既有产品门禁不变；
8. Renderer 可见 support/outcome 不包含 Secret。

### 6.4 多端与回归

1. Desktop、Web、手机设置页对同一 selection 使用相同 Setting Service；
2. Local/Remote Environment 各自生成 Account Built-in Config；
3. Composer、Automation、Subagent、Repo Wiki 候选仍来自 Registry，各自 Draft/commit sink 不变；
4. desktop continuous、mobile replayable、Queue、snapshot、workspace identity 不发生协议语义变化；
5. 已创建 Active Model 在全局账号/连接切换后继续持有旧 Access，不能静默跟随。

稳定 Case ID：

| Case ID | Setup                              | Action                          | Assertions                                         |
| ------- | ---------------------------------- | ------------------------------- | -------------------------------------------------- |
| AC-01   | 保存 Team selection                | 重启 Settings                   | organization/project 原样恢复，无字符串 parse      |
| AC-02   | Account A 创建 Model               | 切换 Account B 后请求旧 Model   | 网络前身份不匹配，不使用 B 凭据                    |
| AC-03   | Team project P1 Active             | 切换 P2                         | 旧 Model 保持 P1，新 Model 使用 P2                 |
| AC-04   | Personal 手写 fake Account Access  | 创建并请求 Model                | Schema 不做来源拒绝；Request Auth 明确失败         |
| AC-05   | 有效 scoped Account Access         | 创建 Off-Peak ticket            | 不与 unscoped key 比较，正常取得双凭据             |
| AC-06   | 凭据解析中切换连接                 | 解析 Off-Peak/MCP               | 不混用两代 JWT/API Key/scope                       |
| AC-07   | Remote Environment                 | 同步/刷新 Provider              | 使用远端 Account Source，不读取本地 selection 执行 |
| AC-08   | Individual 与 Team Provider 均存在 | 切换结构化 connection selection | 仅匹配 Provider enabled，模型候选只出现当前连接    |

## 7. 非目标

- 不重做套餐 SKU、购买、折扣、额度或服务端授权产品逻辑；
- 不把动态 API Key、JWT、Team Secret、一次性安全校验 Header 或 Ticket 放入 Provider Config；
- 不建立统一 Credential Center；
- 不改变 ModelSelection、Session Selection、App Recent 或 Active Model 生命周期；
- 不改变 remote Provisioning、远程设置或登录产品能力；
- 不改变 Queue、continuous/replayable、snapshot 或 workspace identity；
- 不因本任务修改现有 accessId 字节格式或 Credential Store key；
- 不为用户手工配置增加 Source 权限或“禁止写账号 accessId”的特殊校验；
- 不把 Badge、Label、套餐展示文案放入 Account Access。

## 8. 完成条件

机械归零：

```text
AppSettings.modelProviderFamilyModes                                   = 0
AppSettings.modelProviderFamilySelectedKeys                            = 0
生产领域/协议中的 selectedConnectionKey                                = 0
Task/Session/Repo Wiki/workspace prepare 的 family selected keys 透传   = 0
业务代码 create/parse/matches Team/Coding/Preset connection key         = 0
UI/Host/Off-Peak/MCP 从 accessId 反解 Plan/Family/Team/account identity = 0
Account Resolver / Request Auth 的 Built-in Provider ID 套餐映射          = 0
正式 Config/Registry 中的旧通用 builtin:*-coding-plan Provider ID          = 0
provider.accessId !== selection.selectedConnectionKey                  = 0
OffPeak support/snapshot selectedConnectionKey                         = 0
enabled zhipu-account 缺少完整 family/planKind/accessId/Team Scope      = 0
```

通用 Select 组件内部仅用于 React option identity 的局部 `key` 不在归零范围；禁止的是把字符串 key 作为跨
Settings、Services、Protocol、Runtime 的账号连接协议。

行为验收：

- 用户连接选择只有一份结构化持久化状态；
- Account Connection Resolver 是选择意图到账号连接事实的唯一解释者；
- Account Built-in Provider Config 是执行所需 Account Access 的唯一静态快照；
- Start、Individual、Team 是固定类型的独立 Built-in Provider，正常流程只启用当前选择；
- Request Auth、Off-Peak 和 Official MCP 消费同一结构化 Account Access；
- accessId 被所有消费方视为 opaque identity；
- UI 可编辑性不改变 Personal Schema 表达能力；
- 账号/连接切换不会让已创建 Model 静默改用另一套凭据；
- 无新旧双写、双读或长期 compatibility DTO。

## 9. 验证与提交

至少执行：

```bash
pnpm test:unit:affected
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

使用 `pnpm dep:refs`、TypeScript 和 `rg` 复核机械归零项。UI 改动执行 Provider Settings、OAuth 重连、Team
project 切换和 Off-Peak 入口的相关 Desktop E2E，并检查手机 Web 响应式行为。远端环境若无法完整验证，
提交说明必须列出 Local/Remote Account Source 的影响面和待补证据。

完成后更新本 Todo 状态与实际交付，记录仍处于强制升级窗口的唯一 importer 边界，并以独立 Conventional
Commit 提交。

# Todo 26：智谱 Access Mode 契约切换与伪通用协议字段退役

> 状态：已完成
>
> 日期：2026-08-27
>
> 前置关系：Todo 24 已完成 `accessId`、账号创建时绑定和请求安全校验 pathname 特判的清理；本 Todo 根据后续产品裁决，
> 取代 Todo 24 中 `api-key / zhipu-account / execution-provided` 三种 Access、`planKind` 以及
> `challenge / requestSigning / executionProtocol` 通用字段的目标结构。Todo 24 的账号动态鉴权、Account Overlay
> 收窄、私有 Credential 隔离和服务端最终授权等其他结论继续有效。

## 1. 最终裁决

Provider Access 不再用一组看似正交、实际只有特定智谱产品能够执行的可选字段描述产品协议。正式结构只保留两种一级
Access Type：

```ts
type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;

interface ApiKeyAccessConfig {
  readonly type: "api-key";
  readonly apiKey?: string | null;
  readonly apiKeyManagementUrl?: string | null;
}

type ZhipuAccountMode =
  | "api-key"
  | "start-plan"
  | "individual-coding-plan"
  | "team-coding-plan"
  | "off-peak";

interface ZhipuAccountAccessConfig {
  readonly type: "zhipu-account";
  readonly family?: "zai" | "bigmodel" | null;
  readonly mode?: ZhipuAccountMode | null;
}
```

本轮 `mode` 只是普通枚举值，不建立二级对象、二级 Class 或二级 discriminated union：

```json
{
  "type": "zhipu-account",
  "family": "bigmodel",
  "mode": "team-coding-plan"
}
```

智谱产品专属的访问策略只由 `access.type + access.mode` 分派；`family` 继续提供访问体系参数，
Provider API Config 继续提供 Endpoint 与 API 协议。不得再暴露或持久化以下伪通用选项：

```text
planKind
challenge
requestSigning
executionProtocol
execution-provided
```

这不是把协议事实移回 Provider ID、Model ID 或 URL，而是让有限、真实的智谱访问种类成为正式 Config 判别事实。

## 2. 设计原则

### 2.1 Type 与 Mode 表达真实访问产品

```text
access.type
├─ api-key
│  └─ 普通模型服务的静态 API Key 访问
│
└─ zhipu-account
   ├─ family = zai | bigmodel
   └─ mode
      ├─ api-key
      ├─ start-plan
      ├─ individual-coding-plan
      ├─ team-coding-plan
      └─ off-peak
```

`zhipu-account` 在这里表示智谱账号与产品访问体系，包含固定 Family 中由账号提供 API Key 的入口。
它不表示 Provider Config 管理动态账号凭据；具体 API Key、JWT、Ticket 和 Team scope 仍由当前
Environment 的 Account/Credential Service 解析。

### 2.2 不为单一产品行为制造通用 Config 字段

- 官方版本访问安全校验只属于 `zhipu-account/start-plan`；
- ZCode V4 静态准入只属于 `zhipu-account/api-key`、`individual-coding-plan` 和 `team-coding-plan`；
- Off-Peak 排队、Ticket 过期和重试只属于 `zhipu-account/off-peak`；
- 普通 `api-key` 永远不因 Endpoint、Provider ID 或 Model ID 自动进入 ZCode V4；
- 新增真实访问产品时新增 `mode` 枚举、严格 Schema 分支行为和穷举测试，不向所有 Access 塞可选字段。

### 2.3 Config 封装调用，不裁决授权

Provider Config 决定客户端如何取得请求材料、封装模型 API 调用和解释产品协议。它不证明 API Key、账号、套餐或模型权限
有效，也不承担最终鉴权。当前凭据是否可用以及请求是否获准，分别由当前 Environment 的账号/凭据服务和模型服务端裁决。

### 2.4 Built-in 拥有智谱静态身份

对固定 Built-in 智谱 Provider：

```text
ZCode Built-in Provider Config
├─ access.type
├─ access.family
└─ access.mode
        |
        v
Account Overlay
├─ 不修改 Access
├─ 投影账号状态对应的 enabled
└─ Start 额外投影账号特定 builtinModelIds
        |
        v
Personal Overlay
└─ 只覆盖其 Source Schema 允许的用户字段
```

`family/mode` 不是 Account Service 动态状态，也不是设置页通用选项。Account Connection 只提供当前登录、当前连接、套餐、
Team scope 和凭据状态。Personal 继续是最后一层 Overlay，但不因此获得改写 Built-in `group/family/mode` 等来源专属事实的
权限。固定 `account:*` Provider 的 Personal Overlay 不写入 `access`；手动输入的 API Key 只属于普通
`api-key` Provider。

## 3. Built-in Provider 精确映射

### 3.1 普通 API Provider

以下 Provider 是普通设置入口，不使用 ZCode V4：

| Provider ID    | Access                | V4  |
| -------------- | --------------------- | --- |
| `zai-api`      | `{ type: "api-key" }` | 否  |
| `bigmodel-api` | `{ type: "api-key" }` | 否  |

它们继续保持 `group="standard-builtin"`，由普通“添加供应商”流程管理，与 Family Provider 的 Account Connection、
账号凭据、enabled 和固定顺序相互隔离。

### 3.2 Family API Key Provider

| Provider ID                | Access                                           | V4  |
| -------------------------- | ------------------------------------------------ | --- |
| `account:zai-api-key`      | `zhipu-account / family=zai / mode=api-key`      | 是  |
| `account:bigmodel-api-key` | `zhipu-account / family=bigmodel / mode=api-key` | 是  |

它们属于固定 Family UI。Built-in 只声明 `type/family/mode`；实际 API Key 由当前账号体系提供，
经 Account/Credential Service 在请求期解析，不写入 Personal Config、Account Overlay、Registry 或 Active Model。

当前未发布实现把这两个 `account:*` Provider 也做成了手动输入 API Key，并将 Key 保存到 Personal
Config。这是本 Todo 需要直接替换的中间态，不是目标产品契约。

实现修正见 [`Bugfix 09：Account API Key 所有权漂移清理`](./bugfix-09-account-api-key-ownership-drift.md)：
Account API 设置页、Family mode 恢复逻辑和 Welcome 手填 Key 入口不再把账号 Provider 当成普通 API Key
Provider，写边界同时机械拒绝固定 Account Provider 的 Personal `access`。

### 3.3 Coding Plan、Start 与 Off-Peak

| 产品入口                               | Access Mode              | 静态行为                                                     |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| Z.ai / BigModel Start Plan             | `start-plan`             | 官方版本安全校验材料链；不进入 V4                            |
| Z.ai / BigModel Individual Coding Plan | `individual-coding-plan` | 当前连接请求鉴权；具备 V4 静态准入                           |
| Z.ai / BigModel Team Coding Plan       | `team-coding-plan`       | 当前 Team scope 与请求鉴权；具备 V4 静态准入                 |
| Z.ai / BigModel Idle Plan              | `off-peak`               | 执行期 JWT、Plan Key、Ticket 与 Off-Peak 失败协议；不进入 V4 |

每个 Provider 保留既有精确 Provider ID、`group`、`visibility`、Endpoint 和模型成员。固定 ID 继续用于 Provider 身份、
ModelSelection 和任务持久化，不用于猜测 Mode。

## 4. Config、Schema 与 Overlay

### 4.1 Source Schema 所有权

| Source          | 可以写入的 Access 事实                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| ZCode Built-in  | 完整 `type`；智谱 Provider 的完整 `family + mode`；普通 API Provider 的 Key 管理入口         |
| Account Overlay | 不允许写入或替换 `access`                                                                    |
| Personal        | 只允许普通/Personal `api-key` Provider 的 API Key Access；固定 `account:*` 不允许写 `access` |

正式 Schema 必须严格拒绝来源越权字段。设置页不展示智谱 `family/mode` 编辑器，也不把官方版本安全校验、V4 或 Off-Peak 暴露为
高级布尔开关。

### 4.2 稀疏 Config 与完整 Effective

本轮不建立二级 Mode 联合。稀疏 Config 仍可让允许的叶子缺省或显式 `null`，但 Effective Access 必须完整：

```text
api-key
├─ type 完整
└─ enabled Provider 执行前具有非空 API Key

zhipu-account/所有 Mode
├─ family 完整
├─ mode 完整
└─ 不存在 apiKey/apiKeyManagementUrl 配置字段
```

账号动态凭据缺失不使静态 Provider Config 结构不完整；真正请求时由 Request Auth 在网络前失败。

### 4.3 Overlay 规则

- 允许写入 `access` 的 Source 中，外层 `access.type` 相同时按该 Access Class 的叶子 Overlay；
- 普通/Personal Provider 的外层 `access.type` 不同时整个 Access 分支替换；
- `mode` 是普通枚举叶子，没有二级合并或二级替换协议；
- 固定 Built-in 智谱 Provider 的 `access` 只由 Built-in 声明，Account/Personal 不产生任何 Access Overlay；
- Effective Config 不独立持久化，不能反向写回 Built-in、Account 或 Personal Source。

## 5. 运行时唯一分派

```text
Effective Provider Access
          |
          v
Active Model 冻结 type/family/mode
          |
          v
每次 request attempt 按 type/mode 进入唯一 Handler
```

### 5.1 普通 API Key

```text
type=api-key
└─ 使用 Config 中的静态 API Key
   └─ 普通 Transport，不进入 ZCode V4
```

### 5.2 Family API Key

```text
type=zhipu-account, mode=api-key
├─ 从当前 Family Account/Credential Service 解析账号提供的 API Key
├─ 不读取 Personal Provider API Key
└─ 具备 ZCode V4 静态准入
```

### 5.3 Start、Individual 与 Team

```text
mode=start-plan
└─ 当前兼容 Start 连接 + 官方版本安全校验材料

mode=individual-coding-plan
└─ 当前兼容 Individual 连接 + Coding Plan Key + V4 静态准入

mode=team-coding-plan
└─ 同一次当前连接解析 product/org/project + Team Key + V4 静态准入
```

旧 Active Model 只冻结静态 `type/family/mode`，每次请求允许账号服务按当前兼容连接及自身缓存/刷新策略解析材料。它不绑定
创建时账号、Team project、凭据或连接版本。

### 5.4 Off-Peak

```text
type=zhipu-account, mode=off-peak
├─ family 直接来自 Access，不从 provider.group 推导
├─ 当前兼容 Individual/Team 连接
├─ 本次执行注入 JWT + Coding Plan Key + Ticket + Team Headers
└─ Adapter 启用 Off-Peak 排队、Ticket 过期和续跑语义
```

Off-Peak 必须从同一次连接选择解析 Team scope 和凭据，并在账号/选择变化时重读或失败，不能拼接两代材料。

### 5.5 ZCode V4

V4 静态准入只由以下模式集合决定：

```text
zhipu-account/api-key
zhipu-account/individual-coding-plan
zhipu-account/team-coding-plan
```

官方版本请求安全校验的动态发布开关与协议实现保持不变（细节只在官方版本维护）。不得恢复 URL、pathname、Provider ID 或 Model ID 推断。

## 6. Account、Credential 与授权边界

| 状态或事实                            | 权威 Owner                       | 进入 Provider Config？ |
| ------------------------------------- | -------------------------------- | ---------------------- |
| Built-in `type/family/mode`           | ZCode Built-in Provider Config   | 是                     |
| 当前账号、登录状态与当前 Family       | 当前 Environment Account Service | 否                     |
| 当前套餐连接                          | Account Connection Selection     | 否                     |
| Team product/org/project              | Account Connection Selection     | 否                     |
| 账号身份与 Credential Store 物理 Key  | Credential Service 私有实现      | 否                     |
| Account `enabled` 与 Start 模型投影   | Account Overlay                  | 是，仅对应字段         |
| 手动输入的普通 API Key                | Personal Provider Config         | 是，仅 `api-key`       |
| 账号提供的 API Key/JWT/Ticket/Headers | Account/Credential/Request Auth  | 否                     |
| V4 动态发布开关                       | 远端 Runtime Config              | 否                     |
| 最终授权结果                          | 模型服务端                       | 否                     |

生产公共 Config、Registry、Active Model、Protocol 与 UI 不得重新引入 `accessId`、`accountConnectionVersion`、
`bindingId` 或账号身份镜像。Account/Credential Service 可以保留账号隔离、LKG scope、物理 Credential Key 和 single-flight
所需的私有身份；这些内部键不得跨入模型静态配置。

Account last-known-good 只能在同一私有账号 scope 内复用。账号 scope 已变化时，旧账号 Overlay 不得继续提供 enabled 或
Start 模型集合；新状态未解析成功时等待或 fail-closed。

## 6.1 实施结果（2026-08-27）

- Provider Config 和 Runtime 已收口为 `api-key | zhipu-account`，静态智谱访问使用 `family + mode`。
- Built-in、Provider Schema、Registry、Active Model、Adapter 与 Bootstrap 已删除
  `execution-provided`、`planKind`静态字段、`challenge`、`requestSigning` 和 `executionProtocol`。
- Account Overlay 只投影 `enabled` 与 Start 账号模型集合；固定 `account:*` Provider 的 Personal Source
  严格拒绝 `access`。
- 动态 `ZCodeAccountAccess.planKind` 仍表达当前账号连接解析结果，不是 Provider Config 的静态字段。
- Off-Peak 保留固定 Provider ID、Group 和运行时 Ticket/重试语义；特殊行为由
  `access.type=zhipu-account + mode=off-peak` 驱动。
- 已通过 Provider、Provider Node、Services、Adapter 与 Bootstrap 定向回归；Adapter 全量仅剩两个与本轮
  无关的既有失败（进程后代清理、Session Store 旧期望形状）。

## 7. Environment 边界

每个执行 Environment 独立拥有 Provider 与账号事实：

```text
Environment Built-in/LKG
        +
Environment Account Overlay
        +
Environment Personal Config
        |
        v
Environment Registry / Active Model
        |
        v
Environment Account/Credential Service
```

Desktop Local、SSH、WSL、Docker 与 Standalone Server 均按目标 Environment 本地事实执行。Desktop 不向远端推送本地
Provider Registry 或账号配置。本 Todo 不改变 Remote Provisioning、workspace identity、desktop continuous、mobile
replayable、Session/Task Queue、Snapshot 或恢复语义。

## 8. UI Surface Matrix

| 用户场景                     | 展示/草稿来源                      | 提交或运行 Owner                  | 本 Todo 行为                                   | 必须隔离                     |
| ---------------------------- | ---------------------------------- | --------------------------------- | ---------------------------------------------- | ---------------------------- |
| 普通 Provider 设置           | Personal API Key Draft             | Provider Settings Service         | `zai-api/bigmodel-api` 保持普通 API Key、无 V4 | 不进入 Family Account 流程   |
| Z.ai/BigModel Family API Key | Account Connection 与凭据状态      | Account/Credential + Request Auth | Built-in Mode 固定为 `api-key`，不提供手填 Key | 不写 Personal access         |
| Start 登录与请求             | Account Connection + 安全校验 UI   | Account/Request Auth              | 只按 `mode=start-plan` 进入安全校验            | 不影响普通 API Key           |
| Individual/Team 请求         | Account Connection                 | Request Auth + Adapter            | 按 Mode 解析当前 Key，具备 V4 准入             | 不冻结账号或 Team scope      |
| Off-Peak 创建与执行          | 固定 Provider Selection + 当前账号 | Off-Peak Service + Adapter        | 按 `mode=off-peak` 执行                        | 不污染普通 Session Selection |
| Usage/Entitlement            | Account/Subscription Service       | Usage Services                    | 不从 Effective Access 反推动态产品状态         | 不改变刷新与计费策略         |

## 9. 实施切片

### Slice A：正式 Design 与失败测试

1. 用本 Todo 的二层 `type + mode enum` 更新 configuration、runtime、settings、model creation 和 access protocol Design；
2. 标记 Todo 24 的三 Access Type 与通用协议字段结构已被本 Todo 取代；
3. 更新 Feature Graph 中 `accessId`、通用 protocol 字段和 `request-auth` 旧不变量；
4. 先增加严格 Schema、Source 所有权、Built-in 映射和运行时 Mode 分派失败测试。

### Slice B：Config、Schema 与 Built-in

1. `ApiKeyAccessConfig` 删除通用协议字段；
2. `ZhipuAccountAccessConfig` 使用 `family + mode enum`，删除 `planKind`；
3. 删除 `ExecutionProvidedAccessConfig` 和 `ProviderAccessProtocolInput`；
4. 更新 Source Schema、Overlay、序列化、Personal projection 和完整性校验；
5. 迁移全部 Built-in Provider；`zai-api/bigmodel-api` 明确保持普通 API Key 且无 V4；
6. Family API Key、Individual、Team、Start 与 Off-Peak 写入准确 Mode；
7. `ZhipuAccountAccessConfig` 不声明 API Key 字段，Personal Source 不允许为固定 `account:*` 写入 `access`。

### Slice C：Account 与请求期鉴权

1. Account Resolver 只处理 `zhipu-account`，按 `mode` 穷举 availability；Start 额外投影账号模型集合；
2. Account Overlay 不再识别 `execution-provided`、`planKind` 或通用协议字段；
3. Request Auth 按 `family + mode` 解析当前连接；`mode=api-key` 取当前账号提供的 API Key，不读 Personal Config；
4. Team 与 Off-Peak 保持同一次选择的 scope/凭据一致性；
5. Account LKG 增加或保留私有账号 scope 防串态，不进入公共链。

### Slice D：Protocol、Active Model 与 Adapter

1. Shared/Agent Protocol 使用相同的 `type/family/mode` 结构；
2. Active Model 原样冻结完整 Effective Access，不创建 capability DTO；
3. Adapter 按 Mode 选择静态 Key、Request Auth、官方版本安全校验和 Off-Peak Handler；
4. 删除 `requestSigning`、`challenge`、`executionProtocol`、`execution-provided` 的运行时消费；
5. 保留 V4 动态 rollout 和 Signer 协议实现，不恢复任何 URL/ID/path 业务判断。

### Slice E：Services、UI 与清理

1. 官方版本安全校验 UI 改为识别 `zhipu-account/start-plan`；
2. Family UI 只展示 Built-in Mode 对应产品入口，不提供 Mode 或 API Key 编辑控件；
3. 现有 Family 登录 API Key 表单不再向 `account:*` 持久化 Personal API Key；手动 Key 只进入普通
   `zai-api/bigmodel-api` Provider 的 Personal Config；
4. Off-Peak 选择继续使用固定 Provider ID，访问行为只看 Mode；
5. Usage/Entitlement 继续读取 Account/Subscription，不从 Access 反推动态状态；
6. 同步当前 Design、Feature Graph、步骤索引与 Todo 24 superseded 说明。

## 10. 测试计划与接受用例

### 10.1 Config 与来源边界

- 两种一级 Access Type 严格解析、Overlay、`null` 和 JSON round-trip；
- `zhipu-account.mode` 五个枚举值完整解析；
- 正式 Schema 拒绝 `planKind/challenge/requestSigning/executionProtocol/execution-provided`；
- Account Schema 拒绝 `access`；Personal Schema 拒绝为固定 `account:*` 写入任何 `access`；
- `zhipu-account` 的所有 Mode 都拒绝 `apiKey/apiKeyManagementUrl`；
- Effective Access 缺少 `family/mode` 时不能进入 Registry。

### 10.2 Built-in 映射

- `zai-api/bigmodel-api` 是普通 `api-key` 且不进入 V4；
- 两个 Family API Key Provider 是 `zhipu-account/api-key`；
- Start、Individual、Team、Off-Peak 的 Z.ai/BigModel Provider 均声明正确 Family/Mode；
- Built-in JSON 不含真实 API Key和旧协议字段。

### 10.3 运行时纵向证明

- 普通 API Key 使用静态 Key、普通 Transport；
- Family API Key 从当前 Account/Credential Service 解析 Key，不读 Personal Config，并只在动态开关开启时进入请求安全校验；
- 手动 `zai-api/bigmodel-api` 不调用 Account Request Auth，即使动态开关开启也不进入安全校验；
- Start 只进入官方版本访问安全校验链；
- Individual/Team 每次解析当前兼容连接并按动态开关进入安全校验；
- Team 账号或项目切换后使用本次解析的 scope/key；
- Off-Peak 注入 JWT/Key/Ticket，启用既有排队/过期语义且不进入安全校验；
- 当前连接不兼容或材料缺失时网络前失败；
- Registry 更新只影响后来创建的 Model，旧 Model 静态 Access 不变但可解析当前兼容凭据。

### 10.4 状态与跨环境

- 同账号刷新失败可以保留 LKG；账号切换后刷新失败不得复用旧账号 Overlay；
- Account Overlay 与对应 Built-in revision 原子发布；
- Local、SSH/WSL/Docker 与 Standalone 使用目标 Environment 的 Provider/Account 服务；
- ModelSelection、普通队列、Off-Peak 任务身份和 desktop/mobile 恢复边界不改变。

## 11. Mechanical Zero

完成时生产公共链至少满足：

```text
access.planKind                              = 0
access.challenge                             = 0
access.requestSigning                        = 0
access.executionProtocol                     = 0
Access Type execution-provided               = 0
ProviderAccessProtocolInput                  = 0
ExecutionProvidedAccessConfig                = 0
生产公共链 accessId                           = 0
生产公共链 accountConnectionVersion            = 0
从 provider.group 推导 Access family           = 0
按 URL/path/Provider ID/Model ID 推导 V4 或 Mode = 0
zai-api / bigmodel-api 的 V4 准入              = 0
ZhipuAccountAccessConfig.apiKey                   = 0
ZhipuAccountAccessConfig.apiKeyManagementUrl      = 0
固定 account:* 的 Personal access               = 0
从 Personal Config 解析账号 API Key            = 0
```

允许保留：

- 历史实施文档中的旧字段证据；
- Credential Service 私有账号身份、物理 Key 和 LKG scope；
- 官方版本请求安全校验的动态开关及内部协议状态；
- Off-Peak 固定 Provider ID、任务 ID、Ticket marker 和既有状态机；
- Account Connection 自己的连接选择 `kind`，但不得重新投影为 Provider `planKind`。

机械检查必须逐条审计例外，不能用宽泛 allowlist 隐藏生产残留。

## 12. 非目标与不变量

本 Todo 不处理：

- Remote Provisioning；
- Provider Release 业务完整性发布门禁；
- 真实账号与正式制品的统一人工验证；
- Off-Peak 字符串错误协议结构化；
- Model Properties、Reasoning、模型选择、队列或恢复重构；
- 二级 Mode discriminated union；只有出现真实 Mode 专属结构扩展需求时再单独设计。

必须保持：

1. Provider Overlay 顺序仍是 ZCode Built-in -> Account -> Personal；
2. Account Overlay 只约束 Built-in 智谱 Provider，不处理 Personal-only Provider；
3. Personal 是允许字段的最后覆盖层，但不能突破 Source Schema 改写 Built-in 专属身份；
4. Provider Config 不管理动态账号凭据，不承担服务端最终授权；
5. Active Model 静态事实不可变，请求期账号材料允许按当前兼容连接解析；
6. `provider.group` 只负责展示分类，`access.family` 只负责智谱访问体系；
7. 普通 `zai-api/bigmodel-api` 保存手动 Key 且无 V4；Family API Key Provider 只使用账号提供的 Key 且可进入 V4；
8. Off-Peak 固定 ID、group、hidden visibility 和任务选择身份继续保留；
9. 不新增第二套 Registry、Access capability DTO、凭据中心或执行专用 Model。

## 13. 完成定义

只有以下条件全部满足才能完成：

1. 两种一级 Access Type 与智谱 Mode 枚举进入正式 Config、Schema、Registry、Protocol 和 Adapter；
2. Built-in Provider 全部迁入正确类型和 Mode，普通 Z.ai/BigModel API 明确退出 V4，Family API Key
   明确改为账号凭据来源；
3. Account Overlay、Request Auth、官方版本安全校验、Off-Peak 均只按 `type/mode` 分派；
4. 旧通用协议字段与 `execution-provided` 完成生产机械归零；
5. Account 私有 LKG scope 防止跨账号复用，但没有公共账号绑定重新进入模型链；
6. Environment-local Provider/Account 权威和已有 Overlay 原子性保持不变；
7. 当前 Design、Feature Graph、Todo 24 superseded 说明和实现事实一致；
8. Provider、Provider Node、Services、Shared、Adapter、Bootstrap、UI 定向测试通过；
9. `pnpm typecheck`、`pnpm lint`、相关格式检查、`pnpm knip` 与机械残留检查通过；
10. 受影响的普通 API Key、Family API Key、Start、Individual、Team、Off-Peak 和 Remote Environment 回归通过，
    并使用 Conventional Commit 提交。

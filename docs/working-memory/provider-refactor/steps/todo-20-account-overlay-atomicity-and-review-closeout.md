# 20 Account Overlay 原子性与 Provider Review 收口

> 状态：已实施（代码与 Provider 定向验证完成；全仓既有环境项见实施记录）
>
> 日期：2026-08-26
>
> 来源：Provider Refactor 全分支上线前静态审查与 Account Provider 语义复核
>
> 相关任务：[`07`](./todo-07-account-connection-selection-and-access-context-cutover.md)、
> [`17`](./todo-17-provider-registry-settings-authority-boundary-closure.md)、
> [`18`](./todo-18-zcode-builtin-client-config-sync-and-lkg.md)
>
> 相关设计：[`configuration.md`](../design/registry/configuration.md)、
> [`registry.md`](../design/registry/registry.md)、
> [`runtime.md`](../design/registry/runtime.md)、
> [`model-creation.md`](../design/registry/model-creation.md)、
> [`environment.md`](../design/environment/environment.md)

## 0. 任务定位

本 Todo 收口 Provider Refactor 全分支静态审查中已经完成产品与架构裁决、但尚未进入实现的改动：

1. 保留 Account Built-in Provider Config 作为正式 Overlay，并用 `enabled`、账号级 Start Plan
   `builtinModelIds` 与结构化 Account Access 表达当前账号动态事实；
2. 阻止 Registry 发布“新 ZCode Built-in + 旧 Account Overlay”的中间组合；
3. 将 ZCode Built-in Environment Active/LKG 按 ZCode Endpoint 物理隔离；
4. 修正 CLI `--help` / `--version` 不必要启动 Provider Runtime，以及 Bootstrap 漏声明 `zod`；
5. 删除审查确认的孤儿 ZIP 实现与专属依赖。

本 Todo 不包含最新 `origin/staging` 的语义移植与冲突处理，也不承担最终 Release Checklist 或额外的
Built-in Release 业务完整性发布门禁。

## 1. 已确认裁决

### 1.1 Account 继续是正式 Provider Config Overlay

Account Overlay 不是为了形式统一而存在。当前账号会真实改变账号型 Built-in Provider 的有效配置：

```text
ZCode Built-in Provider Config
              |
              v
Account Built-in Provider Config
├─ enabled
├─ Start Plan builtinModelIds
└─ accessId / family / planKind / Team scope
              |
              v
Personal Provider Config
              |
              v
Effective Provider Config
```

顺序保持：

```ts
const effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);

const effectiveProviders = effectiveBuiltinProviders.overlay(personalProviders);
```

Account 只读取和约束 ZCode Built-in 中 `access.type = "zhipu-account"` 的 Provider，不读取、不约束 Personal-only
Provider。Personal 继续作为最后一层用户覆盖。

### 1.2 账号可用性统一使用 `enabled`

Account Provider 是否可用不再通过“缺少 Account Overlay，最终因 `accessId` 不完整而退出 Registry”间接表达。
Account Source 对每个相关 Built-in Account Provider 明确投影：

```text
available
└─ enabled: true

unavailable
└─ enabled: false

unknown
├─ 有上一份成功 Account Overlay：保留上一份
└─ 无上一份：fail-closed，enabled: false
```

`enabled` 继续是 Provider 的统一执行门。Settings 可保留 disabled Provider 用于展示和诊断；Selection、Registry
可执行 View 与 ModelFactory 均拒绝 `enabled = false`。不增加并行的 `available`、`eligible` 或新的执行状态字段。

### 1.3 Start Plan 模型成员是账号级事实

产品事实已经确认：不同 Start Plan 账号的可用模型集合可能不同，`billing/balance` 返回的模型集合必须进入
Account Overlay：

```text
Start Plan balance
└─ capabilities: model:<id>
   （暂时保留 show_name legacy fallback）
              |
              v
Account Provider Config.builtinModelIds
              |
              v
ZCode Built-in Model Config Rules resolve
```

规则如下：

- Start Plan available 且解析到非空模型集合：以账号集合整列表覆盖 Built-in `builtinModelIds`；
- Individual / Team 接口不提供模型集合：Account Overlay 不写 `builtinModelIds`，继承 Built-in 默认成员；
- Start Plan active 但本轮未解析到任何模型：有 LKG 时保留上一份成功 Overlay；无 LKG 时 fail-closed，不得回退到
  宽泛 Built-in 默认集合；
- `show_name` 只作为当前服务端兼容输入暂时保留；服务端保证稳定提供 `model:<id>` 后另行删除；
- Account 只改变成员资格，不提供 Properties、Reasoning、context 或 max output；模型静态事实仍
  由 ZCode Built-in + Personal Model Config Rules 解析；
- Personal `modelIds` 继续在账号约束后的 Built-in Inventory 之后加入，真实请求仍由服务端最终授权。

### 1.4 Account Access 继续进入 Overlay，但不包含真实凭据

`accessId` 是客户端从当前账号身份、Provider、Plan 与 Team scope 生成的稳定、非敏感访问身份。它不是服务端返回的
Secret，但当前执行语义需要它：

- 同一账号刷新 Token、JWT、API Key 或 Header 时保持同一访问身份；
- 切换账号、套餐或 Team scope 时访问身份变化；
- Active Model 固定创建时的 Account Access，后续凭据刷新不能无声切换到另一个账号；
- Individual Coding Plan Credential Store 按访问身份隔离；
- Team Plan 的 product/organization/project 作为结构化 Access 字段参与请求期解析。

Account Overlay 可以写入：

```ts
access: {
  type: "zhipu-account";
  accessId: string;
  family: "zai" | "bigmodel";
  planKind: "start-plan" | "individual-coding-plan" | "team-coding-plan";
  productId?: string;
  organizationId?: string;
  projectId?: string;
}
```

Token、JWT、API Key、动态 Header 与凭据刷新仍归 Request Auth/Credential Service；它们不得进入 Config、Registry 或
Active Model 静态配置。服务端继续承担最终授权裁决。

### 1.5 Account Overlay 必须声明 Built-in 来源 revision

当前 `AccountProviderService` 使用 Built-in Account Provider 计算 Overlay；Registry 又同时订阅 Config Source 与 Account
Source。Built-in 变化时，Registry 可能短暂组合新 Built-in 与旧 Account Overlay：

```text
B0 + A0
   |
   | Built-in -> B1
   v
B1 + A0  <- 禁止发布
   |
   | Account refresh
   v
B1 + A1  <- 唯一允许的新 Snapshot
```

不建立跨服务端接口的共同版本协议，也不要求 Account API 返回 Built-in revision。只在客户端派生 Source 中保存来源证明：

```ts
interface ProviderConfigSnapshot {
  readonly revision: string;
  readonly zcodeBuiltinRevision: string;
  readonly personalRevision: string;
  // existing config fields
}

interface AccountProviderConfigSnapshot {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: ProviderConfigMap;
}
```

Registry 只在两者匹配时发布：

```ts
account.basedOnZCodeBuiltinRevision === config.zcodeBuiltinRevision;
```

不匹配时保留当前完整 Registry Snapshot，等待 Account Source 完成对新 Built-in 的投影。Account 即使得到与上一轮内容相同的
Provider Map，只要 `basedOnZCodeBuiltinRevision` 改变，也必须发布新的 Account Source revision/change event，使 Registry
能够应用新 Built-in。Personal 更新不改变 `zcodeBuiltinRevision`，不得被 Account 网络刷新阻塞。

### 1.6 Active/LKG 按 ZCode Endpoint 隔离

这里的 Endpoint 指 ZCode 平台控制面 `zcodeEndpointOrigin`（生产、测试或开发/mock Origin），不是 Provider Config 中的
模型 API Endpoint。Todo 18 当前只让 `refresh-control.json.endpointKey` 隔离刷新 TTL，但不同 Endpoint 仍共享
`active.json`，导致互不相关的 revision 被比较。

Remote Active 与刷新控制文件必须按规范化 Endpoint 的稳定、碰撞安全路径段物理隔离：

```text
<environmentConfigRoot>/provider/zcode-builtin/
└─ <platform>/
   └─ <appVersion>/
      └─ <endpointKey>/
         ├─ active.json
         └─ refresh-control.json
```

约束：

- `endpointKey` 从规范化 Origin 确定性生成；不得直接把不安全 URL 字符写成路径；
- revision 只在同一 Endpoint 的 Bundled/Remote 发布语义内比较；
- 切换 Endpoint 后若该 Endpoint 没有 Active，使用 Bundled 完成 ready，再后台刷新新 Endpoint；
- 不得把 Endpoint A 的 LKG 作为 Endpoint B 的候选；
- 切回旧 Endpoint 时允许复用该 Endpoint 自己的 LKG；
- 保留 control payload 中的 `endpointKey` 作为防御性一致性检查；
- Todo 18 尚未形成正式发布兼容历史，不为旧的未分区 Active 路径增加 dual-read；旧路径自然退出。

### 1.7 CLI 与依赖修正

CLI Provider Runtime 准备逻辑不得覆盖纯元信息入口：

```text
--help / -h / --version / -v
└─ 不读取或落盘 Provider Config
   不启动 /client/configs 刷新
   不依赖 Built-in asset ready
```

只修正入口判定和对应测试，不借机重构整个 CLI Bootstrap。`doctor` 等既有不需要 Provider Runtime 的命令保持现状。

Bootstrap 生产代码直接导入 `zod`，必须在自己的 `dependencies` 中直接声明，不能依赖 workspace 提升或传递依赖。

### 1.8 审查确认的机械清理

删除零引用的：

- `packages/zcode-server-cli/src/packaging/zipArchive.ts`；
- 仅由它使用的 `yazl`；
- 仅由它使用的 `@types/yazl`。

保留实际用于 ZIP 解压的 `yauzl`，并保留此前为 Linux pre-push/测试环境修复的 Server ZIP、macOS notarize 与跨平台
`stat` 行为。删除前后用 `dep:refs`、`knip` 和目标打包测试证明没有静态调用方或发布入口依赖孤儿实现。

`packages/ui/src/hooks/useProviderModelOrder.ts` 已确认由当前 Provider Refactor 新增且零引用，已在提交
`01ac05e2be` 删除，不再作为本 Todo 的待实施内容。PDF 脚本文件尾空行不处理。

## 2. 目标刷新链

```text
Bundled / Endpoint-scoped Active / Remote
                    |
                    v
          ZCode Built-in Source Bn
                    |
                    +----------------------+
                    |                      |
                    v                      |
       AccountProviderService             |
       ├─ enabled                          |
       ├─ Start builtinModelIds            |
       └─ accessId / scope                 |
                    |                      |
                    v                      |
      Account Overlay basedOn = Bn         |
                    |                      |
                    +----------+-----------+
                               |
Personal Provider Config ------+
                               |
                               v
                     Provider Registry
                               |
                               v
                   later ModelFactory.create()

already-created Active Model
└─ remains frozen
```

## 3. 实施步骤

### Step 0：先同步正式 Design 与 Feature Graph

- 在 `configuration.md`、`registry.md`、`runtime.md`、`model-creation.md` 写明本 Todo 的 Account Overlay 字段和
  revision barrier；
- 在 Environment Design 写明 Active/LKG 的 Endpoint 物理隔离；
- 修正 Todo 18 中 `<platform>/<appVersion>/active.json` 的旧路径表述；
- 更新 Feature Graph 的 Provider Registry invariant：Account Overlay 显式控制 `enabled`、Start 账号模型成员和
  Account Access，并且 Registry 只发布来源 revision 匹配的组合。

### Step 1：先写失败测试

- 固定 Account `enabled`、Start 账号模型成员、LKG 与 revision mismatch 行为；
- 固定 Personal 更新不等待 Account 刷新；
- 固定 Endpoint A/B 的 Active/LKG 隔离；
- 固定 CLI help/version 不准备 Provider Runtime；
- 固定 Bootstrap 独立依赖与 ZIP 打包路径不依赖孤儿 helper。

### Step 2：补齐分层 revision

- `ProviderConfigSnapshot` 暴露 `zcodeBuiltinRevision` 与 `personalRevision`，保留现有组合 `revision`；
- `AccountProviderConfigSnapshot` 增加 `basedOnZCodeBuiltinRevision`；
- Mutable/Empty/Test Sources 使用同一契约，不增加字符串解析或 wildcard revision；
- Account Source revision 同时包含来源 Built-in revision 与 Overlay 内容身份，保证同内容新来源仍触发变化。

### Step 3：收正 Account Overlay

- availability 显式投影 `enabled`；
- unavailable 发布 sparse `{ enabled: false }` Overlay；
- available 发布完整结构化 Account Access；
- Start Plan 精确投影账号 `builtinModelIds`；
- Individual/Team 不复制 Built-in 模型成员；
- Start 无法解析模型时执行 LKG/fail-closed，不回退宽泛 Built-in；
- 保留当前 `show_name` compatibility，但只限 Account Source 私有解析边界。

### Step 4：增加 Registry revision barrier

- Config/Account 来源不匹配时不调用 Resolver、不替换 Registry、不通知 Facade；
- 保留上一份完整 Snapshot；
- Account 更新到匹配 revision 后只发布一次最终 Registry；
- generation 变化继续丢弃过时 rebuild；
- Personal-only 变化沿当前快速路径立即发布；
- 刷新失败保留上一份 Account Overlay 与完整 Registry，并输出可诊断错误。

### Step 5：Endpoint-scoped Active/LKG

- 将规范化 Endpoint 映射为稳定安全的缓存路径段；
- Active 与 refresh-control 进入同一 Endpoint 目录；
- 同 Endpoint 多进程继续共享文件锁、lease、TTL 与 revision 比较；
- Endpoint 切换触发该 Endpoint 的 Built-in refresh，并按 Account -> Registry 顺序收敛；
- 删除旧未分区路径使用，不增加迁移 fallback。

### Step 6：CLI、依赖与孤儿代码

- 排除 `--help/-h/--version/-v` 的 Provider Runtime prepare；
- 为 Bootstrap 添加直接 `zod` dependency；
- 删除 `zipArchive.ts`、`yazl` 与 `@types/yazl`；
- 不修改 `yauzl` 解压链和已确认的 Linux pre-push 兼容修复。

### Step 7：验证与记录

- 执行 Provider、Provider Node、Services、CLI Bootstrap 的定向单测与 typecheck；
- 执行根 `pnpm typecheck`、`pnpm lint`、相关 unit 与格式检查；
- 更新 Todo 状态、实施记录与 Feature Graph evidence；
- 使用 Conventional Commit 提交，不与 staging merge 冲突解决混成同一提交。

## 4. 测试计划

### 4.1 Account Overlay

- available Account Provider 得到 `enabled: true` 和完整 Access；
- unavailable 得到 `enabled: false`，不靠完整性失败表达禁用；
- unknown 有 LKG 时保留，无 LKG 时 fail-closed；
- Start 两个账号返回不同 models 时得到不同精确 `builtinModelIds`；
- Start active 但模型列表为空/不可解析时不继承宽泛 Built-in；
- Individual/Team 不返回 models 时继承当前 Built-in；
- Team product/org/project 与 accessId 稳定生成，切换任一身份字段后变化；
- Account Overlay 不能约束 Personal-only Provider；
- Personal 仍在 Account 之后覆盖。

### 4.2 Registry 原子发布

- `B0/A0 -> B1` 且 Account refresh 延迟时不发布 `B1/A0`；
- Account 完成 `A1 basedOn B1` 后只发布 `B1/A1`；
- Account Overlay 内容相同但来源从 B0 变 B1 时仍触发最终 rebuild；
- Personal P0 -> P1 且 Built-in 仍为 B1 时立即发布 `B1/A1/P1`；
- Account 刷新失败时保持旧完整 Registry；
- 已创建 Active Model 不被任何刷新热改。

### 4.3 Endpoint Active/LKG

- Endpoint A revision 20 与 Endpoint B revision 10 分别进入独立路径，B 不被 A 判 stale；
- A/B 同 revision 不同内容不互相产生发布协议错误；
- 切回 A 可复用 A 的 LKG；
- B 无 LKG且远端失败时使用 Bundled，不使用 A 的 LKG；
- 同 Endpoint 多进程仍只有一个 lease owner 发起网络请求；
- Endpoint Setting/Environment 变化触发正确 Source 刷新。

### 4.4 CLI、依赖与清理

- `--help/-h/--version/-v` 不调用 Provider Runtime prepare；
- prompt/TUI/server 等需要模型的入口继续正常 prepare；
- Bootstrap filtered typecheck/install/packaging 能解析直接 `zod`；
- 删除 `zipArchive.ts` 后 dep:refs 为零且 Server ZIP 目标测试继续通过；
- `yauzl` 解压测试与 Linux pre-push 修复不回归。

## 5. 非目标与不变量

- 不合并最新 staging；
- 不实现最终 Release Checklist 中的真实账号、真实发布制品和跨平台统一验证；
- 不实现额外的 Built-in 业务完整性发布门禁；
- 不删除 Account Overlay、Start 账号模型集合或 accessId；
- 不把 Token、JWT、API Key、Header 写入 Config；
- 不改变 Model Config Rule 顺序、Model Properties、Reasoning 或 Adapter 事实；
- 不改变 Off-Peak、Subagent、Compact、Memory 的 Active Model 所有权；
- 不改变 Desktop continuous、Mobile replayable、队列和恢复语义；
- 不为 Endpoint 缓存引入第二份 LKG、dual-read 或跨 Endpoint revision 比较。

## 6. 完成标准

- Account Overlay 用 `enabled` 明确表达账号 Provider 可用性；
- Start Plan 每个账号的精确模型成员进入 `builtinModelIds`，空结果安全 fail-closed；
- Account Access 保持非敏感、完整、可冻结，真实凭据仍在请求期解析；
- Registry 永不发布来源 Built-in revision 不匹配的 Account Overlay；
- Personal-only 更新不被 Account 刷新阻塞；
- Active/LKG 与刷新控制按 Endpoint 隔离；
- CLI help/version 不触发 Provider Runtime；Bootstrap 直接声明 `zod`；
- 孤儿 ZIP 文件与专属依赖删除，保留的跨平台 ZIP/Notarize 行为测试通过；
- 定向测试、根 typecheck、lint、相关 unit 与格式检查通过；
- Design、Todo 状态和 Feature Graph 与最终实现一致。

## 7. Impact Brief

| Field            | Value                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Developer intent | 收口 Provider Review 已裁决缺口，不改变主架构                                                                   |
| Capability       | Provider Registry、Account Overlay、Built-in Remote/LKG、CLI Bootstrap                                          |
| Change layer     | option-source / validation / persistence / commit-effect                                                        |
| Operating mode   | planning                                                                                                        |
| Primary seeds    | `AccountProviderService`、`ProviderRegistryService`、`resolveZCodeBuiltinCachePaths`、`requiresProviderRuntime` |
| Out of scope     | staging merge、真实环境统一验证、Release 业务完整性门禁                                                         |

### State Owners And Commit Sinks

| State/fact                    | Authoritative owner        | Persistence/cache             | Publish sink     |
| ----------------------------- | -------------------------- | ----------------------------- | ---------------- |
| Built-in revision/content     | ZCode Built-in Source      | Endpoint-scoped `active.json` | Config Service   |
| Account enabled/models/access | AccountProviderService     | 进程内 LKG Snapshot           | Account Source   |
| Personal Config               | Personal Repository        | `config.json`                 | Config Service   |
| Effective Provider/Model      | ProviderRegistryService    | 进程内 immutable Snapshot     | Registry/Facades |
| Active Model                  | ModelFactory-created Model | 执行生命周期内冻结            | Adapter request  |

### Must-Preserve Invariants

- Account 只约束 Built-in account Provider，Personal 最后覆盖；
- Account Start models 是成员事实，不是模型静态能力事实；
- revision barrier 只表达客户端派生来源，不创造服务端共同版本协议；
- Endpoint 是 Environment 配置源隔离，不是模型 API Endpoint；
- 动态凭据不进入 Config，服务端最终授权；
- 已创建 Active Model 不随 Config/Account 刷新变化。

### Graph Delta

实施 Step 0 将更新 `capability.provider-registry`：补充 Account `enabled`、Start 账号模型成员、Account Access 与
`basedOnZCodeBuiltinRevision` 原子发布不变量；补充 Built-in Active/LKG 的 Endpoint-scoped persistence 节点。当前 Todo
是已确认语义的实施入口，不新增 UI Surface。

### Unresolved Questions

无会改变本 Todo 实施范围的未决产品问题。`show_name` 退役依赖服务端后续保证，作为明确兼容退出条件保留，不阻塞本 Todo。

## 8. 实施记录

### 8.1 已落地

- `ProviderConfigSnapshot` 已拆分组合 revision、ZCode Built-in revision 与 Personal revision；
  `AccountProviderConfigSnapshot` 已携带 `basedOnZCodeBuiltinRevision`，且 Account revision 同时包含来源与 Overlay 内容；
- Account Resolver 已统一投影 `enabled`：available 显式启用，unavailable 显式禁用，unknown 首次 fail-closed；
  Start Plan 精确采用账号模型集合，空集合执行 LKG/fail-closed；Individual/Team 继承 Built-in 成员；
- Registry 已增加 Built-in/Account revision barrier：不匹配时保留上一份完整 Snapshot，匹配后再发布；Personal-only
  revision 变化不等待 Account 重算；
- Environment Source 已按规范化 ZCode 控制面 Origin 的 SHA-256 路径段隔离 `active.json` 与
  `refresh-control.json`；Endpoint 切换使用各自 Bundled/LKG，晚到的旧 Endpoint 响应不会落盘；
- Desktop Services 在读取 Settings 时动态解析当前 Endpoint；Bootstrap、Protocol 与 Agent stdio payload 已贯穿
  Account 来源 revision；首次 Account 事实尚未到达时使用与当前 Built-in 匹配的 fail-closed Snapshot；
- CLI `--help/-h/--version/-v` 已跳过 Provider Runtime prepare；Bootstrap 已直接声明 `zod`；
- 零引用的 `zipArchive.ts` 及 Server CLI 对 `yazl`、`@types/yazl` 的专属依赖已删除，`yauzl` 解压链保留。

### 8.2 自动化证据

- `@zcode/provider`：14 个测试文件、130 条测试通过，package typecheck 通过；
- `@zcode/provider-node`：5 个测试文件、36 条测试通过，package typecheck 通过；
- Services Account/Registry/Request Auth 定向测试：3 个测试文件、24 条测试通过；
- CLI Bootstrap process/protocol 定向测试：114 条测试通过，package typecheck 通过；
- CLI Provider Runtime Env 的 development、SEA 与元信息入口 3 条定向测试通过；
- Server CLI build 通过；根 `pnpm typecheck` 与 `pnpm lint` 通过；本次修改文件格式化与 `git diff --check` 通过。
- 全量 `pnpm test:unit` 共 12,388 条：12,360 条通过、25 条跳过、3 条失败；其中 Provider 改动面没有失败，
  失败项由下节记录的两个既有环境/时序基线组成。

### 8.3 已确认的仓库/环境基线

- Server CLI 全包测试中的两个 Windows ZIP 用例在当前 Linux 环境因系统命令 `zip` 不存在而报 `spawn zip ENOENT`；
  当前生产打包路径原本就直接使用该系统命令，被删除的孤儿 helper 没有任何调用方，因此这不是本 Todo 引入的回归；
- CUA Permission Broker 的 socket close 时序用例在全量并发运行时失败一次；同一条用例随后独立复跑通过，属于与 Provider
  无关的既有时序波动；
- `@zcode/cli` 独立 typecheck 仍被既有 `AgentRuntimeConfig.modelSelection` 缺失挡住，报错位于
  `prompt-command.ts` 与 `tui-prompt-handler.ts`，不在本 Todo 改动面；
- 全仓 `fmt:check` 仍会扫描 Electron vendor fiddle 的既有非法 HTML 与二进制 `gb2312.js`，因此本次以修改文件格式检查
  和 `git diff --check` 作为提交证据；
- 工作区新鲜度检查因当前环境无法连接 Git proxy `127.0.0.1:1080` 而无法刷新远端引用；本 Todo 未合并 staging。

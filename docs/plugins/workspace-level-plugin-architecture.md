# Workspace-level Plugin Architecture

> Status: Accepted architecture; V1 implementation and local pending E2E evidence recorded; mobile remains focused integration only and formal admission is pending
> Date: 2026-08-19
> Decision: 采用 User/Workspace 两级配置形态；不做 Local scope，并采用 ZCode 已确认的开放 Plugin 安全策略
> Target: Desktop local、SSH/WSL/Docker workspace Agent Host、mobile `/remote` shared-host attachment

## 1. Final decision

Workspace-level Plugin 的含义是：Plugin 的启用状态和运行时 options 可以由当前 Workspace 的项目配置决定。配置 scope 与 Skill、Command、Hook 保持一致，只支持两级：

```text
User       ~/.zcode/cli/config.json
Workspace  <workspace>/.zcode/config.json
```

不实现以下内容：

- `<workspace>/.zcode/config.local.json`；
- Host 外部 `plugins/assignments/workspaces/<hash>.json`；
- Workspace 独立 package/cache/data；
- 打开项目时自动安装 Plugin；
- resident App 热插拔；
- Plugin MCP 的独立 approval；
- Plugin 域的 Workspace trust gate。

Workspace 配置可以被 Git 跟踪。`plugins.options`、credential 和 secret 按产品决策允许由项目仓库注入，但 UI、日志、diagnostic、provider capture 和 mobile replayable artifact 必须脱敏。

Plugin Marketplace 不属于配置 scope：市场只负责目标 Host 的 User package lifecycle，
不展示 User/Workspace selector，也不直接编辑 Plugin enabled/options。安装、更新、卸载和
Marketplace cache 均属于 Host User inventory；新安装默认在 User config 中启用。User 与
Workspace 的 enabled/options 统一在 Settings > Plugins 的“已安装”配置视图中编辑。

## 2. Scope and precedence

### 2.1 Enabled state

```text
workspace.plugins.enabledPlugins[pluginId]
        ?? user.plugins.enabledPlugins[pluginId]
        ?? plugin manifest defaultEnabled
```

缺少 key 表示继承；显式 `false` 是有效覆盖，不能使用“缺省等于 false”的实现来代替。

### 2.2 Options

options 按 Plugin ID 和 option key 深度合并：

```ts
effectiveOptions[pluginId] = {
  ...user.plugins.options[pluginId],
  ...workspace.plugins.options[pluginId],
};
```

示例：

```json
{
  "plugins": {
    "enabledPlugins": {
      "formatter@team-market": true
    },
    "options": {
      "formatter@team-market": {
        "style": "compact",
        "apiToken": "shared-project-secret"
      }
    }
  }
}
```

Workspace 配置只覆盖自己声明的字段，其余字段继续继承 User 配置。

## 3. Persistence ownership

### 3.1 Workspace config

权威文件：

```text
<workspace>/.zcode/config.json
```

支持的 Plugin 配置包括：

- `plugins.enabledPlugins`：项目启用/禁用哪些 Plugin；
- `plugins.options`：项目共享的普通 option、credential、secret；
- `plugins.dirs`：项目内 Plugin root 或项目相对 Plugin 路径，受路径和 manifest schema 校验。

Workspace 配置不保存 package bytes、安装完成态、Marketplace cache、Plugin data 或 Host 用户级安装记录。
敏感 option 的空输入表示保留当前值；用户显式清除时只删除当前 scope 的指定 option key，
不会重置该 Plugin 的 enablement 或其他 options。

### 3.2 User/Host state

```text
~/.zcode/cli/config.json
  plugins.enabledPlugins
  plugins.options
  plugins.suppressedBuiltins
  user-level plugins.dirs

~/.zcode/cli/plugins/
  known_marketplaces.json
  installed_plugins.json
  marketplaces/
  cache/{marketplace}/{plugin}/{version}/
  data/{pluginId}/
```

Plugin package、安装、更新、卸载、缓存和 data 仍是目标 Agent Host 上的 User/Host 状态。Workspace 配置引用缺失 package 时只保留声明并显示 `missing`，不自动下载或安装。

## 4. Runtime loading

设置页面不直接加载 Plugin。Agent 在创建 Workspace 对应的 App/Session 时读取并解析：

```text
打开 Workspace / 创建新 Session
          |
          v
确定 workspacePath、workspaceIdentity、remoteTarget
          |
          v
读取 User config
          |
          v
读取 <workspace>/.zcode/config.json
          |
          v
按 Plugin ID/key 合并 effective enabled/options
          |
          v
发现目标 Host 上的 installed/builtin/Workspace Plugin package
          |
          +-------------------+
          |                   |
       package 存在        package 缺失
          |                   |
          v                   v
校验 manifest/schema     overview=missing
          |
          v
直接注册 Hook/Skill/Command/Agent/MCP
          |
          v
创建当前 Session runtime
```

Plugin 的 Hook、Skill、Command、Agent 和 MCP 使用同一份 effective Plugin registry。运行时不需要知道配置来自 User 还是 Workspace；scope 只影响配置读取、写回和来源展示。

### 4.1 Session activation boundary

```text
保存配置
   |
   +-- 配置文件立即更新
   +-- Settings overview 立即刷新
   +-- 当前 resident App 保持创建时的 Plugin catalog
   +-- 新建 Session 使用最新 effective config
   +-- cold resume 使用最新 effective config
```

V1 不热插拔 resident App，不因 Settings 保存强制重启正在运行的任务。

### 4.2 Plugin MCP

Plugin MCP 在 Plugin registry 注册后直接进入 runtime：

- 不需要 Workspace trust；
- 不需要 Plugin MCP approval；
- 仍做 manifest、配置、路径和协议 schema 校验；
- `${user_config.KEY}` 可在 env/header/clientSecret 等 sensitive sink 中展开；
- sensitive 值不允许展开到 command、args、URL 等非敏感字段；
- 运行时错误只返回脱敏后的诊断信息。

这只是 Plugin 域的例外，不改变顶层 project MCP、Hook、Agent 等非 Plugin 配置的既有安全合同。

## 5. Settings control plane

设置页复用 Skill/Command/Hook 的 scope 交互：

```text
Settings > Plugins

Scope: [User | Workspace]
Workspace: [local workspace / remote workspace]
```

选择 Workspace 后，所有读取和写回都绑定被选择的 Workspace target。

Plugin Marketplace 是独立主视图，不提供 scope selector：

```text
Settings / Plugins / Workspace A
        | open marketplace; remember returnScopeKey=A
        v
Plugin Marketplace
  | install/update/uninstall package in Host User inventory
  | new install defaults User enabled=true
        | back
        v
Settings / Plugins / Workspace A
  | row is visible as effective enabled, source=User
```

从非 Settings 入口打开 Marketplace 时，返回目标固定为 User 已安装列表。Marketplace 的
source 只来自 User/Host 配置；Workspace 不支持 Marketplace 声明、添加或刷新，当前 Workspace
只作为窗口/Agent 的执行上下文，不会改变市场的安装或配置 scope。

插件详情区分三类状态：

```text
Package: Installed v1.2.0 / Missing
Enabled: On / Off / Inherited
Source: User / Workspace
```

### 5.1 Enable/disable

```text
User scope:
  patch ~/.zcode/cli/config.json#plugins.enabledPlugins[id]

Workspace scope:
  patch <workspace>/.zcode/config.json#plugins.enabledPlugins[id]
```

Workspace 页面提供“恢复 User 配置”，行为是删除 Workspace 中的 key，而不是写入第三种 sentinel。

### 5.1.1 Scope list semantics

设置页的 User / Workspace 列表表示配置视图，不是互斥的资源归属：

```text
Host available Plugin set
  = Host installed inventory
  + builtin Plugins
  + scope-specific Plugin roots/declarations

User view
  = User + manifest default projection

Workspace view
  = User + Workspace merged effective projection
```

同一个 Host 已安装 Plugin 可以同时出现在 User 和 Workspace 页面。User 页面编辑 User
enabled/options；Workspace 页面展示该 Workspace 的 effective 状态和来源：

- Workspace 有显式 key：来源为 Workspace；
- Workspace 无 key、User 有显式 key：来源为 User inheritance；
- 两层都无 key：来源为 manifest default。

Workspace toggle 写入当前 Workspace 的显式 `true`/`false`；“恢复继承”只删除 Workspace
override。Workspace options 显示 effective 值与来源，但写回只修改 Workspace。User 页面必须
读取不含项目覆盖的 User/default 投影，不能把 Workspace override 当成 User 值。

Plugin 贡献的 MCP、Skill、Command、Hook 按所选 target 的实际 effective enablement 展示：
从 User 继承后生效的能力必须出现在 Workspace 视图，已禁用 Plugin 的能力不得仅因 package
存在而出现。

`installed_plugins.json` 始终是 Host User inventory。其 legacy `scope` 不具备
`workspacePath` / `workspaceIdentity`，不参与 Workspace 隔离或配置来源判断。

### 5.2 Options

options 表单写入当前选定 scope。`sensitive: true` 使用掩码输入，但允许保存到 User 或 Workspace 配置；不能用 trust 或 approval 阻止保存。

### 5.3 Package actions

安装、更新、卸载与配置写入保持独立：

```text
Workspace enable succeeds + package missing
  -> 项目保留 enabled 声明，状态为 missing

Marketplace install succeeds
  -> package 写 Host User inventory
  -> User enabledPlugins 默认 true
  -> Workspace config 不被 Marketplace 修改
```

不做跨文件伪原子事务，也不因为一边失败回滚另一边已经成功的合法用户操作。

## 6. Remote and mobile boundaries

```text
Renderer
   |
   v
one window-scoped Local Host
   |
   +--> local workspace service
   |
   +--> RemoteConnectionRegistry
          |
          +--> SSH / WSL / Docker / Server Agent Host
```

文件读写使用执行语义：

```text
<target workspacePath>/.zcode/config.json
```

缓存、Session、异步请求和状态隔离使用：

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

Remote workspace 必须携带 `workspaceIdentity` 和 `remoteSessionId`。不能因为两个目标的 `workspacePath` 相同就复用错误的 Plugin 状态。

手机 `/remote` 只 attach 到现有 shared Host，不创建独立 Plugin runtime、配置副本或安装状态。桌面保持 `desktop-continuous`，手机保持 `web-remote-replayable`，Plugin 配置不能改变两种交付语义。

## 7. Service and protocol contract

UI 不直接写文件，保持：

```text
UI -> PluginManagementStore -> IPluginManagementService
   -> ZCode Protocol -> Agent config loader/runtime
```

接口显式携带 scope 和 Workspace 上下文：

```ts
type PluginScope = "user" | "workspace";

configurePlugin({
  pluginId,
  options,
  scope,
  workspacePath,
  workspaceIdentity,
});
```

`setPluginEnabled`、Marketplace mutation、overview/list 也必须遵守相同的 target resolution。overview 需要返回最终值和来源：

```ts
{
  effectiveEnabled: true,
  enabledSource: "workspace",
  effectiveOptions: { GITHUB_HOST: "github.example.com" },
  optionSources: { GITHUB_HOST: "workspace" },
  package: { installed: true, version: "1.2.0" },
}
```

Settings 的 overview/list 请求增加可选 `configScope`：

```ts
type PluginConfigScopeView = "user" | "workspace";
```

- `user`：忽略 project Plugin config，返回 User + manifest default 投影；
- `workspace`：返回 User + Workspace merged effective 投影；
- 缺省：保持既有 effective 行为，兼容旧调用方。

当配置中声明的 Plugin 在目标 Host 无法发现 package 时，`plugins/list` 仍返回该配置行，
并以可选 `packageStatus: "missing"` 标识；缺省表示 package 可用。missing 行不进入已安装
inventory，不投影 MCP/Skill/Command 等能力，但仍允许写 enabled override、恢复继承，并可跳转
Marketplace 执行显式安装。

UI 异步结果和缓存必须同时绑定
`(workspaceIdentity?.trim() || workspacePath, configScope)`。

## 8. E2E contract

每个 feature 必须有独立的 setup、action、assertion 和 evidence，不能仅通过一条长路径顺带声称覆盖。正式用例见：

- [Plugin Management Lifecycle Case Catalog](../plugin-management-lifecycle-case-catalog.md)
- [Plugin Management Lifecycle E2E Coverage Matrix](../testing/plugin-management-lifecycle-e2e-coverage-matrix.md)

Workspace-level E2E feature 分组如下：

| Feature                         | E2E case  | 必须证明                                                                                                                |
| ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| User/Workspace scope UI         | `WPL-001` | 两级配置视图共享 Host 候选；User 不受项目覆盖污染；Workspace inheritance/override 与 A/B 隔离                           |
| enabled 状态优先级              | `WPL-002` | Workspace 显式 true/false 覆盖 User，缺 key 继承                                                                        |
| options 深合并                  | `WPL-003` | 按 Plugin/key 合并，未覆盖 User option 保留                                                                             |
| sensitive/secret                | `WPL-004` | Workspace 可保存并运行；UI/log/provider/mobile artifact 不泄露原值                                                   |
| Plugin 全组件直达 runtime       | `WPL-005` | Hook/Skill/Command/Agent/MCP 无 trust/approval 即进入新 Session                                                         |
| 缺包行为                        | `WPL-006` | 只显示 missing，不自动安装；显式安装后才可运行                                                                          |
| 配置与包生命周期分离            | `WPL-007` | enable/disable、install/uninstall 互不错误回滚                                                                          |
| resident/cold resume            | `WPL-008` | resident App 冻结，新 Session/cold resume 读取新配置                                                                    |
| Global Marketplace install      | `WPL-009` | 只有 User Marketplace 可添加/刷新；声明本身不触发下载；市场安装写 User inventory/config，不写 Workspace enabled/options |
| Remote target isolation         | `WPL-010` | 相同 path、不同 identity 不串配置和 runtime                                                                             |
| Remote missing/explicit install | `WPL-011` | 连接不复制本机 package；显式 Sync/Install 只物化 remote Host                                                            |
| Mobile shared-host              | `WPL-012` | `/remote` 使用现有 Host，不复制 Plugin runtime/store                                                                    |
| builtin Workspace disable       | `WPL-013` | 只改 enabledPlugins，不删除 builtin asset/user data                                                                     |
| project Plugin root/MCP         | `WPL-014` | 合法项目 Plugin root 直接激活；非法 manifest/path fail closed                                                           |
| Marketplace/installed roundtrip | `WPL-015` | 从 User 已安装进入全局市场；市场无 scope/config；安装写 User；返回 User，再切 Workspace 做配置                          |

E2E 证据分层：

```text
UI scope/source state
  + persisted User/Workspace config snapshot
  + Agent protocol/effective overview
  + new Session runtime evidence
  + package/cache/remote target evidence
  + no-secret and no-trust/approval evidence
```

当前证据状态不是“全部完成”：`WPL-001` 至 `WPL-011`、`WPL-013`、`WPL-014`、`WPL-015`
已有独立 pending spec，并在本地 macOS 上取得 targeted/replay pass。2026-08-31 使用隔离 SSH
目标完成远程验证：`WPL-010` run `desktop-e2e-20260831-060023-004` 证明相同 path、不同
workspace identity 的配置、catalog 与 runtime 不串；`WPL-011` run
`desktop-e2e-20260831-054511-469` 证明连接不复制本机 package，显式 Sync 后才在 remote Host
物化并进入新 Session runtime。`WPL-012` 只有 shared-host focused integration test 和显式
external bridge 字段投影的源码证据，不是手机端到端 E2E。所有 pending case 仍未完成人工审核、
promotion、Docker admission 和三平台 CI。`WPL-005` 当前只用 Skill+MCP 代表性 fixture 证明
直达 runtime，Command、Agent 和 Hook 的逐组件闭环仍待补充。

## 9. Implementation slices

### Slice A: config foundation

- User/Workspace config contract；
- Workspace config discovery；
- `enabledPlugins` 和 `options` deep merge；
- sensitive option 持久化放开与输出脱敏；
- User Marketplace source、Host inventory 与 Workspace 配置视图的边界。

### Slice B: runtime resolution

- startup、`mcp/list`、Settings overview 使用同一 effective resolver；
- installed/builtin/Workspace Plugin candidate discovery；
- Hook/Skill/Command/Agent/MCP 同源注册；
- resident freeze、新 Session、cold resume 回归。

### Slice C: Settings control plane

- User/Workspace config selector；
- Marketplace scope-free package lifecycle；
- Marketplace returnScopeKey 回到来源已安装列表；
- enable/disable/reset inheritance；
- sensitive options 掩码和保存；
- missing package/install CTA；
- package/config 独立错误状态；
- remote target stale-result guard。

### Slice D: remote/mobile and rollout

- RemoteConnectionRegistry 目标路由；
- remote Host package/config evidence；
- mobile shared-host focused integration evidence；
- macOS/Linux/Windows targeted E2E。

## 10. Acceptance gates

1. Plugin 页面存在 User/Workspace selector，行为与 Skill/Command scope 一致。
2. Workspace 配置写入 `<workspace>/.zcode/config.json`，不创建 Local 文件。
3. Workspace `enabledPlugins` 对新 Session 生效，缺包不自动安装。
4. Workspace options 按 option key 覆盖 User；普通、credential、secret 均可生效。
5. sensitive 值允许持久化，但 UI、日志、diagnostic、provider capture、mobile replay 不泄露。
6. Plugin Hook/Skill/Command/Agent/MCP 无 Workspace trust 和独立 MCP approval 即进入新 runtime。
7. package 生命周期不会修改项目声明；配置失败不会错误回滚已成功的 package 操作。
8. remote 按目标 workspacePath 读文件，按 workspaceIdentity 隔离状态。
9. mobile 复用 shared Host，不创建独立 Plugin runtime/store。
10. resident App 不热变；新 Session/cold resume 使用最新配置。
11. 当前 targeted pass 的 WPL case 具备独立 E2E setup/action/assertion/evidence；pending、review、fixture、Docker 和多平台门禁仍是后续晋级条件。
12. 只有 `WPL-001` 至 `WPL-015` 全部完成对应实现、独立 E2E、人工审核和平台门禁，才能宣称完整 feature complete；本 V1 commit 不做该声明。
13. 当前提交本身必须通过 `pnpm typecheck`、`pnpm lint`、E2E typecheck 和已实现 WPL 的 targeted E2E。
14. Marketplace 不显示 scope、enable 或 options 控件；安装固定写 Host User inventory/User enablement，返回动作恢复来源配置视图。

## 11. Out of scope

- Workspace 外部 assignment store；
- Local scope 和 `config.local.json`；
- Workspace 独立 package/cache/data；
- 打开 repo 自动安装 package；
- resident App 热插拔；
- 同 Host 同 Plugin ID 多版本并存；
- Marketplace 内编辑 User/Workspace enabled/options；
- relay/main 持有 Plugin 业务状态；
- 根据 workspacePath 猜测 remote identity；
- 修改非 Plugin project hooks/MCP/subagent trust/approval 合同。

## 12. Security posture

```text
clone/open repository
        |
        v
Workspace Plugin config loads without Workspace trust
        |
        +--> Hook/Skill/Command/Agent/MCP enter a new App
        +--> options/credentials/secrets enter Plugin runtime
        +--> Plugin MCP starts without separate approval
```

这是明确的 Plugin 域例外。tracked `.zcode/config.json` 可能包含明文 secret，也可能改变 Plugin runtime 参数或启动 Plugin MCP；产品不阻止该行为，只保留 schema/path/protocol validation 和输出脱敏。

| Boundary                               | Decision                                            |
| -------------------------------------- | --------------------------------------------------- |
| Workspace Plugin enable、dirs、options | 无 Workspace trust，直接进入新 App resolution       |
| Plugin Hook/Skill/Command/Agent        | 随已启用 Plugin 激活                                |
| Plugin MCP                             | 直接进入 runtime，无独立 approval                   |
| 顶层 project hooks/MCP/Agent           | 保持既有安全合同                                    |
| sensitive value persistence            | User/Workspace 均可明文保存                         |
| sensitive value output                 | UI/log/diagnostic/provider/mobile artifact 必须脱敏 |

## 13. Evidence and source boundary

当前实现和验证边界包括：

- 项目配置由现有 `.zcode/config.json` discovery 链加载；
- Plugin startup、`mcp/list` 和 Settings overview 必须统一到同一 effective resolver；
- Plugin package/installed record 当前是目标 Host 用户级；
- `workspaceKey = workspaceIdentity?.trim() || workspacePath` 是状态隔离合同；
- `sensitive` option 的 User/Workspace 持久化阻断已移除，输出仍按脱敏合同处理；
- Marketplace source 只保存在 User/Host 层；Workspace config 不声明、不添加、不刷新 Marketplace，
  只有显式 User Marketplace refresh/install 才物化目标 Host 的 cache/package 状态；
- local、dual-SSH remote 和生命周期 pending E2E 已有本地证据；mobile 目前只证明 shared-host
  attachment 不复制 Plugin state，尚未完成真实手机 `/remote` E2E。

实现时不能只修改 Settings UI；必须同时修改 config loader、Plugin discovery、Session startup、protocol/service contract 和 E2E fixture/coverage。


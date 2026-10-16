# Workspace-level Plugin Proposal Comparison

> Status: Superseded proposals, final decision recorded
> Date: 2026-08-17
> Baseline: `origin/staging` at `c707c9576c`

## 1. Final decision

此前方案 A 与方案 B 都把 Workspace assignment 放在项目目录之外。该共同前提已被产品
裁决覆盖：

```text
不采用：
~/.zcode/cli/plugins/assignments/workspaces/<hash>.json

采用：
<workspace>/.zcode/config.json
```

最终方案不是两份旧方案的折中。它以项目配置文件为权威，并按用户决策收敛为
User/Workspace 两级，并开放 Workspace runtime config：

```text
Workspace config
  = shared Plugin declaration + options/credentials/secrets

target Host user storage
  = package/cache/user options/credentials/data
```

完整合同见
[Workspace-level Plugin Architecture](./workspace-level-plugin-architecture.md)。

## 2. Historical proposals

| Proposal | Historical shape | Useful analysis retained | Rejected core |
| --- | --- | --- | --- |
| 方案 A | Host package store + user/workspace assignment store + effective resolver | package 与项目启用声明必须分离；target Host authority；Session freeze | 外部 assignment authority、workspace data、assignment APIs/GC |
| 方案 B | CLI-owned workspace state overlay + shared package/cache | cold resume 会重建 App；旧 `scope=workspace` 无 workspace key | 外部 workspace state、ownership overlay、同步/迁移设计 |

两份方案仍提供了有效的当前源码诊断：

- installed record 和 package cache 是 Host 用户级状态；
- `scope=workspace` 当前没有 runtime 隔离能力；
- Plugin 能力在 App 构造时冻结；
- local/remote Plugin runtime 的 authority 在目标 Agent Host；
- mobile `/remote` 应复用 shared Host。

但这些事实不要求引入 assignment store。

## 3. Why the project file is authoritative

| Dimension | External assignment file | Project config with open ZCode policy |
| --- | --- | --- |
| 团队共享 | 每个用户手工重建 | Git 可跟踪 |
| 可发现性 | 状态藏在用户目录 hash 文件 | repo 内明确声明 |
| checkout/branch | 容易残留旧 assignment | 随 Git 内容切换 |
| scope override | 需要自定义 assignment schema | 复用 User/Workspace scope，与 Skill/Command 一致 |
| 缺包行为 | assignment 容易与 inventory 纠缠 | declaration 保留，package 显示 missing |
| 安全 | 避开 repo 但无法共享 | 无 Workspace trust/Plugin MCP approval；保留 schema/path validation 与输出脱敏 |
| 实现复杂度 | 新 persistence/API/GC/migration | 扩展现有 config loader/merger 和 sensitive option 写入 |

最终采用的开放激活链路：

```text
repo declaration
      |
      v
installed package check
      |
      v
runtime activation
```

## 4. Adopted configuration

| Concern | ZCode |
| --- | --- |
| Workspace 项目配置 | `.zcode/config.json` |
| Local scope | 不采用；不做 Local 配置文件 |
| 启用声明 | `plugins.enabledPlugins` |
| 额外 Marketplace | `plugins.extraKnownMarketplaces`（仅 User/Host；Workspace 不支持 Marketplace） |
| Plugin options | `plugins.options` 对 User/Workspace 全开放，含 sensitive values |
| 项目 Plugin 目录 | `.zcode/plugins` or Workspace `plugins.dirs`，无 Workspace trust |
| Plugin MCP | 与 Hook/Skill/Command/Agent 一样直接进入 runtime，无独立 approval |
| per-user Plugin install/cache | target Host `~/.zcode/cli/plugins` |

采用 ZCode 既有 config 文件名，避免 `.zcode/settings.json` 与 `.zcode/config.json` 双权威；
安全策略按 ZCode 产品决策放开。

## 5. Explicitly removed design elements

以下内容不进入实现：

- `assignments/user.json`；
- `assignments/workspaces/<hash>.json`；
- user direct / workspace direct / override assignment schema；
- workspace assignment revision、CAS、repair 和 version gate；
- `plugins/assign`、`plugins/removeAssignment`、`plugins/configureAssignment`；
- assignment ref-count package GC；
- Workspace-scoped Plugin data；
- 把 legacy installed records 迁为 assignment；
- 打开 remote workspace 后隐式复制本地 assignment/package。

## 6. Retained constraints

- package/cache/installed inventory 归目标 Agent Host 用户；
- Workspace 配置无需 Workspace trust，打开 workspace 后直接参与新 App runtime；
- project declaration 缺包时不自动安装；
- Workspace 可以注入 Plugin options、credentials 和 secrets，按 option key 覆盖；
- sensitive values 可明文持久化，但 UI/log/diagnostic/provider capture 必须脱敏；
- Plugin MCP 与其它 Plugin 组件一样直接运行，不需要独立 approval；
- V1 同 Host 每 Plugin ID 一个 active version；
- resident App 不热加载，新 Session/cold resume 生效；
- remote 从目标 `workspacePath` 读项目文件，状态关联用 `workspaceIdentity`；
- 每个 BrowserWindow 只有一个 Local Host，remote 通过 `RemoteConnectionRegistry`；
- mobile `/remote` 复用 shared Host。

## 7. Implementation consequence

主要工作从“新建 assignment subsystem”变为“补齐项目配置 scope 与 sensitive option 语义”：

```text
Plugin deep merge
        +
Workspace sensitive option persistence
        +
target Host missing-package UX
        +
startup/catalog common resolver
```

User/Workspace scope、Plugin options deep merge 和 sensitive option 写入当前都不是完整能力，是正式交付
前置；Local scope 不进入实现，Workspace trust 也不进入 Plugin 实现。

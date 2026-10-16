# SSH 远程 MCP 同步设计

## 背景

ZCode 当前已经支持把本地用户级 Skills 同步到 SSH 远端主机。MCP 的运行链路与 Skills 有相似处：本地设置页读取本机用户目录中的 MCP 配置，创建或恢复 ZCode Agent session 时把启用的 MCP 配置显式下发给 agent，agent 再在其所在运行时启动 stdio MCP 或连接 HTTP / SSE MCP。

这意味着 SSH 远程 workspace 里，MCP 进程实际运行在远端 zcode-server 所在主机上。当前本地用户级 MCP 可以通过 session 参数临时传给远端 runtime，但远端用户目录并不会持久化这批 MCP 配置。用户在远端主机上重新打开 workspace、手机端通过 shared-host 进入同一远端 workspace、或远端 runtime 自行读取配置时，仍然缺少远端 `~/.zcode/cli/config.json` 中的用户级 MCP 配置。

## 目标

- 允许用户在已连接 SSH 远程 workspace 中，把本机用户级 ZCode Agent MCP 配置同步到该 SSH 主机的远端用户级 `~/.zcode/cli/config.json`。
- 本机候选只包含用户级 MCP，不包含 workspace 级 MCP、plugin MCP、系统内置 MCP 或外部 Agent 原始来源。
- 候选发现语义与本地 MCP 设置保持一致：优先读取 `~/.zcode/cli/config.json` 的 `mcp.servers`；当该 scope 下没有 ZCode MCP server 时，兼容读取 `~/.agents/mcp.json` 的 `mcpServers`。
- 远端导入写入 `~/.zcode/cli/config.json` 的 `mcp.servers`，不写 `.agents`。
- 远端已存在同名 MCP 时默认跳过，不覆盖。
- stdio / context7 这类命令型 MCP 可直接复制配置；不检查远端是否已经安装命令、包管理器或依赖。
- HTTP / SSE MCP 直接复制 URL、headers、token 等 secret 字段，允许 secret 写入远端配置文件。
- filesystem MCP 在同步时需要把本地路径改写成远端可用路径。
- 保持 remote workspace 的 `workspaceIdentity` / `remoteSessionId` 路由边界，不把远端导入误落到本机用户目录。

## 非目标

- 首版不支持覆盖远端同名 MCP。
- 首版不同步 workspace 级 MCP。workspace 配置属于项目文件，应该通过代码仓库、远端文件编辑或单独的 workspace 配置同步设计处理。
- 首版不迁移 plugin MCP。plugin MCP 来源于插件安装状态，不能当作用户级配置复制。
- 首版不验证远端环境可用性。context7、npx、uvx、自定义命令是否存在，由远端运行时在实际 mcp/list 或 session 启动时暴露状态。
- 首版不把远端 `.agents/mcp.json` 迁移为 `.zcode/cli/config.json`；若远端已经有效存在同名 server，同步结果显示 skipped。
- 不新增通用远端文件写入 API。

## MCP 本地运行逻辑

本地 MCP 读取发生在 renderer 的 MCP store：

1. `mcpStore.loadMcpFromUserDirectory()` 通过 `IPlatformService.loadMcpFromUserDirectory()` 读取宿主用户目录。
2. desktop platform 的实现读取 workspace scope，再读取 user scope；每个 scope 先读 `.zcode`，如果没有 server 再读 `.agents`。
3. UI 内存里得到 `ZCodeMcpServer[]`，用户可启用、禁用、编辑或删除。
4. 创建 / 恢复 task 前，`getEnabledMcpServersForZCode()` 把启用的 `zcodeagentmcp` 配置转成 ZCode Protocol 的 `mcpServers` 参数。
5. service adapter 把 `mcpServers` 传给 zcode-agent create/resume session。
6. zcode-server / bootstrap 把 protocol MCP 转成 runtime config，agent runtime 再调用 MCP adapter。
7. stdio MCP 使用 agent runtime 所在机器的 `command` / `args` 启动；HTTP / SSE MCP 使用 URL 和 headers 连接远端服务。

因此 SSH remote 下的 MCP 运行位置是远端 zcode-server 所在机器。本地配置直接传给远端 runtime 可以临时生效，但不能代表远端用户目录已经持久化。

## 服务边界

新增受限的 MCP 同步服务，而不是扩展 platform 目录读写：

- `IMcpSyncService.listLocalUserMcpCandidates()`：在调用方所在机器列出用户级 MCP 候选。renderer 通过 base services 调用时读取本机用户目录；通过 remote services 调用时读取远端用户目录。
- `IMcpSyncService.listRemoteUserMcpStatuses({ names })`：在远端查询同名 server 是否已存在。
- `IMcpSyncService.exportMcpServers({ serverIds })`：本机按候选 id 导出 MCP 配置 DTO，并带上本机 home 路径用于路径改写。
- `IMcpSyncService.importMcpServers({ servers, localHomeDir, remoteWorkspacePath, localWorkspacePath?, overwrite: false })`：远端写入 `~/.zcode/cli/config.json`，同名存在时跳过；filesystem MCP 在写入前执行路径改写。

服务需要像 skill-sync 一样注册到本地 host 和远端 zcode-server service collection。桌面 renderer 合并 remote workspace services 时，`mcpSyncService` 必须覆盖为 remote service；否则导入会写回本机用户目录。

## 数据同步内容

同步的最小数据单元是单个用户级 MCP server 配置：

- `name`
- `enabled` 状态。禁用状态以现有兼容字段 `enable: false` 写入 server config；启用状态不额外写字段。
- `config` 原始字段，包括：
  - stdio: `type`、`command`、`args`、`env`、`timeout` / `timeoutMs` 等字段。
  - HTTP / SSE: `type`、`url`、`headers`、`http_headers`、`timeout` / `timeoutMs` 等字段。
  - provider-specific secret 字段，例如 `apiKey`、`personalAccessToken`、`Authorization` header。

不直接同步文件内容、二进制包、npm / uv / pip 依赖、环境变量引用所指向的宿主环境，也不复制 workspace `.zcode/config.json`。

## filesystem MCP 路径改写

filesystem MCP 识别规则：

- server name 归一化后等于 `filesystem`、`file-system` 或 `fs`；或
- stdio `args` 中包含 `@modelcontextprotocol/server-filesystem`；或
- stdio `command` / `args` 中出现 `mcp-server-filesystem`。

路径改写只处理 stdio args 中的路径参数，不改写 command、env、HTTP URL 或 headers。

路径改写规则：

1. 如果参数是本地 workspace 路径或其子路径，并且调用方提供了 `localWorkspacePath` 与 `remoteWorkspacePath`，改写为远端 workspace 路径并保留相对后缀。
2. 如果参数是本地 home 路径或其子路径，改写为远端 home 路径并保留相对后缀。
3. 其他绝对路径保持原样，例如 `/tmp/mcp-cache`。这些路径是否在远端存在由远端运行时负责暴露错误。
4. 相对路径、包名、flag、URL、纯参数值保持原样。
5. 支持把 Windows 本地 home 路径改写成 POSIX / Windows 远端 home 路径，远端路径分隔符以远端 `process.platform` 为准。

示例：

本机用户级配置：

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/alice/workspace/z-code", "/Users/alice/Documents"],
        "enable": true
      },
      "context7": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"]
      },
      "docs-api": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer secret"
        }
      }
    }
  }
}
```

同步到远端 `dev@host:/home/dev/z-code`，远端 home 为 `/home/dev`，写入：

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/dev/z-code", "/home/dev/Documents"],
        "enable": true
      },
      "context7": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"]
      },
      "docs-api": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer secret"
        }
      }
    }
  }
}
```

## UI 设计

在 `Settings > MCP Servers` 中，MCP 配置列表必须和 Skills 一样跟随当前 workspace services：

- 本地 workspace 读写本机用户目录 / workspace 目录。
- SSH remote workspace 读写 SSH 主机上的用户目录 / workspace 目录。
- 页面顶部显示当前 remote context，避免把远端配置误认为本机配置。
- 创建 / 恢复 / 队列续跑 ZCode task 前，MCP store 必须通过当前 workspace services 刷新；SSH remote task 只能把远端 MCP 配置传给远端 agent runtime。

在 SSH remote context 顶部显示 `同步 MCP 到此 SSH 主机` 图标按钮。点击后打开 `RemoteMcpSyncDialog`：

- 顶部显示目标 SSH 主机与远端 workspace 路径。
- 列表显示本机用户级 MCP server，包含名称、类型、来源文件路径和状态。
- 远端缺失项默认勾选；远端已存在项默认不勾选并标记“远端已存在”。
- 提供 `显示远端已存在` 过滤器和全选缺失项 checkbox。
- 提交后展示 synced / skipped / failed 结果。
- 同步完成后刷新 MCP store 的远端用户目录读取和远端 MCP status list。弹窗里的“本机候选”仍使用 base services，弹窗外的 MCP 设置列表使用当前 workspace services。

所有 SSH 远程工作区入口必须与 Skills 同步入口保持成对出现，并复用同一套入口组件：

- workspace header 更多菜单、workspace sidebar 更多菜单、SSH 连接成功后的目录选择页、Settings 中的 Skills / MCP 管理页都只能在 SSH remote context 显示同步入口。
- 菜单入口使用同一组 `同步 Skill` / `同步 MCP` 菜单项，避免某个入口遗漏 MCP。
- 连接成功后的目录选择页使用单个 `同步` 下拉按钮，按钮左侧是上传云图标，右侧是下拉箭头；下拉菜单包含 `同步 Skill` 与 `同步 MCP`，后续可追加 `同步 Subagent`、`同步 Plugin`。
- 连接成功后的目录选择页中，MCP 菜单项需要等当前远程目录路径可用后才能点击，因为 filesystem MCP 的路径改写依赖远程 workspace 路径。
- 所有入口最终打开同一个 `RemoteSkillSyncDialog` / `RemoteMcpSyncDialog`，并保留各自同步后的刷新回调。

## 远程与多端兼容

- 本地 workspace 不显示远端 MCP 同步入口。
- SSH remote workspace 显示入口。
- Docker / WSL remote workspace 首版不显示入口，避免不同传输目标的路径改写语义混淆。
- Web 手机远控不新增独立 runtime，不绕过 shared-host attachment。若用户在手机端进入同一 remote workspace host，服务调用仍通过已存在 remote services 路由。
- 所有 workspace 级状态查找使用 `workspaceIdentity?.trim() || workspacePath`；实际文件读写使用 `workspacePath`。

## 错误处理

- 远端断连：弹窗显示错误并禁止提交。
- 本机没有用户级 MCP：显示空状态。
- 远端同名：跳过，不覆盖。
- 部分失败：已同步结果保留，失败项显示错误。
- JSON 写入失败或权限不足：远端 service 返回明确错误。
- filesystem 路径未命中 home / workspace 映射：保持原样，不阻塞同步。

## 测试与验证

- 单元测试：
  - 候选列表读取本机 `~/.zcode/cli/config.json` 用户级 `mcp.servers`。
  - `.zcode` 用户级没有 server 时读取 `~/.agents/mcp.json` 的 `mcpServers` fallback。
  - 导入 HTTP MCP 时保留 URL、headers 和 secret。
  - 导入 context7 / stdio MCP 时直接复制 command / args / env。
  - 导入 filesystem MCP 时把本地 home 路径改写为远端 home 路径。
  - 同名远端 MCP 跳过且不覆盖。
- UI 测试：
  - 本地 workspace 不显示 MCP 同步入口。
  - SSH remote workspace 的 `Settings > MCP Servers` 显示同步入口。
  - 弹窗默认选择远端缺失项，完成后展示结果。
- 仓库必跑：
  - `pnpm typecheck`
  - `pnpm lint`

## 风险

- 复制 secret 到远端是明确产品选择，功能实现不做脱敏或过滤；用户需要信任 SSH 远端主机。
- context7 / npx / 自定义 stdio 命令可能在远端不可用。首版不做环境探测，以远端 MCP status 和运行日志作为反馈。
- filesystem 路径改写只能覆盖确定映射。无法推断的绝对路径保持原样，可能在远端连接失败。

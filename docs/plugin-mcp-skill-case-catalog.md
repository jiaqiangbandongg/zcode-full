# Plugin MCP Skill Case Catalog

目标：把 ZCode 桌面端"插件提供的 MCP skill"从导入到关闭的产品语义展开成 e2e case，供产品、QA、开发 review。本目录 v1 只覆盖三个最基础的 happy-path 状态（未安装 / 安装并启用 / 安装但禁用）；后续导入动作的多步路径、per-skill 关闭、跨工作区继承、卸载后清状态等行为单独维护 catalog 增量。

## 命名与固定标记

- 工具命名空间（runtime）：agent 加载 plugin MCP server 后通过 `apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts` 把 `plugin:<plugin-name>:<server>` 重写为 anthropic 兼容的 `mcp__plugin_<plugin-name>_<server>__<tool>`，这是真正发给模型的 tool name。本目录用例固定使用：
  - 插件：`e2e-plugin-mcp-ping`（fixture 路径 `packages/desktop/test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping/`）
  - server：`ping`
  - plugin 命名空间（plugin 内部）：`plugin:e2e-plugin-mcp-ping:ping`（仅用于 debug 日志 / `getEnabledMcpServers`）
  - 模型 tools 数组实际名：`mcp__plugin_e2e-plugin-mcp-ping_ping__ping`
  - plugin id（installed_plugins.json 内的 id）：`e2e-plugin-mcp-ping@e2e-fixture`
- e2e marker 前缀：`E2E_PLUGIN_MCP_PING_<STATE>_<runId>`
- 状态 A：`not-installed`；状态 B：`installed-enabled`；状态 C：`installed-disabled`

## 枚举边界

| 维度              | 等价类                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| 安装状态          | `not-installed`、`installed-enabled`、`installed-disabled`                                       |
| 触发面            | `installed_plugins.json` 存在/缺失、`config.json#plugins.enabledPlugins[id]` 真/假/缺           |
| MCP server 启动   | `lazy`（仅在 listTools 时 spawn）；`eager`（plugin 启用即 spawn）                               |
| 对话层 tool 暴露  | `tools[]` 数组里包含 namespaced 工具名 / 不包含                                                  |
| 软证据            | chat 出现 `chat-tool-call-block-<toolName>` block / 不出现                                       |
| fixture 复用      | `fixtures/upstream/plugin-mcp-skill/conversation-session-plugin-mcp-skill-{baselines,installed-enabled}.json` |

## Review 状态

| 状态          | 含义                                  |
| ------------- | ------------------------------------- |
| accepted      | 产品预期明确，可以生成测试            |
| undefined     | 产品预期未定义，待补                  |
| bug-candidate | 当前实现与 case 冲突，未必是协议问题  |

## Case 列表

| ID  | 前置状态                                | 用户/系统事件                     | 规则命中                                                       | 期望结果                                                                                              | Review   |
| --- | --------------------------------------- | --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| P01 | `installed_plugins.json` 不含本插件     | 用户在 chat 里发普通文本          | `not-installed` baseline                                        | 请求 `tools[]` 不含 `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`；chat 无对应 tool-call block                  | accepted |
| P02 | `installed_plugins.json` 含本插件，`enabledPlugins[id] = true` | 用户发"调工具"prompt | `installed-enabled` 强证据 | 请求 `tools[]` 含 `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`；chat 出现该工具的 tool-call block                | accepted |
| P03 | `installed_plugins.json` 含本插件，`enabledPlugins[id] = false` | 用户发普通文本     | `installed-disabled`                                            | 请求 `tools[]` 不含 `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`；chat 无对应 tool-call block                    | accepted |

## v1 验证记录

- 2026-07-05：在本地 macOS (Apple M4 Pro) + Electron desktop 真实启动下，三个 spec 全部通过：
  - P01 未安装基线（marker `E2E_PLUGIN_MCP_PING_NOT_INSTALLED_*`，deepseek replay 回纯文本）→ 9s 通过。
  - P02 已安装并启用（marker `E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED_*`，deepseek replay 回 `toolUse.name="mcp__plugin_e2e-plugin-mcp-ping_ping__ping"`）→ 9s 通过；chat 端成功渲染对应 tool-call block。
  - P03 已安装但禁用（marker `E2E_PLUGIN_MCP_PING_DISABLED_*`）→ 7s 通过；`enabledPlugins[id] = false` 生效，请求 `tools[]` 0 个 plugin MCP。
- 关键 fix（v1 → 跑通）：
  1. `installed_plugins.json` 必须落到 `<E2E_HOME>/.zcode/cli/plugins/` 而不是 `cli/`（bootstrap 的 `pluginStorageRoot = cli/plugins`，`listInstalledPluginRecords(pluginStorageRoot)` 读 `<pluginStorageRoot>/installed_plugins.json`）。
  2. 安装型 plugin `defaultEnabled = false`，必须显式 `config.plugins.enabledPlugins[id] = true`；delete 字段会被当成默认 false。
  3. agent 注入模型的工具名是 `mcp__plugin_<plugin-name>_<server>__<tool>`，不是 `plugin:<plugin-name>:<server>`（后者只在 plugin 内部命名空间用）。replay fixture 与 chat 断言都要用前者。

## Fixture 合约

### e2e 启动前由 wdio.conf.ts 写入

- `<E2E_HOME>/.zcode/cli/plugins/installed_plugins.json`：
  - A 状态：`resetE2EHome()` 已清空 E2E home，不写 plugin 安装记录
  - B/C 状态：从 `fixtures/plugin-mcp-skill/installed-plugins.{enabled,disabled}.template.json` 渲染（占位 `__INSTALL_PATH__` 替换为绝对路径），name=`e2e-plugin-mcp-ping`，marketplace=`e2e-fixture`，scope=`user`
- `<E2E_HOME>/.zcode/cli/config.json`（必须在 `seedUpstreamE2EModelConfig` 之后再 patch）：
  - B 状态：`plugins.enabledPlugins["e2e-plugin-mcp-ping@e2e-fixture"] = true`（必须显式 true，因为安装型 plugin 在 `NodePluginAdapter.resolveCandidates` 里 `defaultEnabled = false`）
  - C 状态：`plugins.enabledPlugins["e2e-plugin-mcp-ping@e2e-fixture"] = false`

### deepseek replay fixture

- `fixtures/upstream/plugin-mcp-skill/conversation-session-plugin-mcp-skill-baselines.json`：A 与 C 共享，匹配 `E2E_PLUGIN_MCP_PING_{NOT_INSTALLED,DISABLED}`，回纯文本 `deepseek-e2e-ok`
- `fixtures/upstream/plugin-mcp-skill/conversation-session-plugin-mcp-skill-installed-enabled.json`：B 专用，匹配 `E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED`，先回 `toolUse.name="mcp__plugin_e2e-plugin-mcp-ping_ping__ping"`，再在工具结果轮回纯文本 `deepseek-e2e-ok`

## 复用现有 helper

- `prepareConversationE2E()` / `startNewTask()` / `sendPrompt()` / `waitForUserMessageContaining()` / `waitForUpstreamRequestContaining()` / `waitForAssistantMessageContaining()` / `waitForChatState()` —— `helpers/conversation-session.ts`
- `ensureToolCrossProductFullAccessMode()` / `respondToToolCrossProductBlockers()` —— `helpers/conversation-session-tool-cross-product.ts`（仅 B 状态使用，避免 Full access / permission 弹窗把 tool-call 拦截）
- `getToolCallBlockByToolName()` —— 同上
- 新增 `helpers/plugin-mcp-skill.ts`：`PLUGIN_MCP_TOOL_NAME`、`captureArtifactAdvertisesToolName`、`findUpstreamRequestContaining`

## 不复用 / 暂不做

- 真实 MCP server `tools/call` 响应回路（v1 信任 deepseek replay 伪造；fixture `server.mjs` 仅保证 agent 在 enabled 状态下能成功启动做 listTools）
- per-skill 关闭（plugin 内多个 skill 单独关闭）
- marketplace 拉取真实插件的端到端测试（不属于本目录，仅"插件已落地后"的 skill 生命周期）
- 卸载后清缓存 / data dir / skillRoot 重扫
- 跨工作区 workspace identity 切换时的 MCP 工具继承

## 失败定位速查

- `installed_plugins.json` 在 wdio 启动时如果被 agent 忽略（路径错位）→ 看 `apps/zcode-cli/packages/adapters/src/exec/index.ts:78` 的 `ZCODE_STORAGE_DIR` / `homedir()`，确认 agent 进程实际读的是 `<E2E_HOME>/.zcode/cli/`
- `tools[]` 命名空间不是 `plugin:<name>:<server>` → 直接 grep `toNamespacedServerName` 确认实现
- deepseek capture artifact 拿不到 `requestJson` → fallback 走 `record.requestBody` 的文本扫描（弱证据，仅证明 marker 进入请求体）

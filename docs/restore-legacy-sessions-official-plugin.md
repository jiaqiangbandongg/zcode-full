# Restore Legacy Sessions Official Plugin

## 背景

旧版 ZCode 的 session 快照保存在 `~/.zcode/v2/sessions`。迁移能力已经作为本地 skill 验证过，可以列出旧 agent、workspace、conversation，并把选中的历史对话恢复到新 ZCode 的任务索引和 CLI session DB。

为了避免默认会话暴露高风险本地迁移能力，需要把该 skill 包装成官方插件，但默认关闭。用户显式启用后，新的 session 才能看到迁移 skill 和命令。

## Plugin Identity

- 插件名：`restore-legacy-sessions`
- 插件 id：`restore-legacy-sessions@zcode-plugins-official`
- 版本：`0.1.0`
- 类型：官方 bundled plugin
- 默认状态：关闭

该插件不加入 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`，因此和 `ios-simulator` / `android-emulator` 一样，只有用户显式启用后才注入能力。

## 内容

插件包位于：

```text
apps/zcode-cli/packages/restore-legacy-sessions-plugin/
```

包含：

```text
.zcode-plugin/plugin.json
README.md
package.json
skills/restore-legacy-sessions/SKILL.md
skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs
skills/restore-legacy-sessions/scripts/restore-conversation.mjs
commands/restore-legacy-sessions.md
```

这是 skill-only / command-only 插件，不声明 `mcpServers`，也不启动长期运行的 MCP server。迁移脚本由 agent 按需通过本地 Node.js 执行。

## 行为边界

- 默认源目录是 `~/.zcode/v2/sessions`。
- 只有用户明确要求读取其它目录时，才传 `--legacy-dir <path>` 覆盖默认源。
- 目的地保持为：
  - `~/.zcode/v2/tasks-index.sqlite`
  - `~/.zcode/cli/db/db.sqlite`
- 恢复前必须创建时间戳备份。
- 旧版会话恢复后的 provider 固定写 `glm`。
- 不写 `migration_source`，也不写 `meta_json.migrationSource`。
- 不启动旧 runtime。
- 不改写已有新任务里的用户续写消息。

## 启用方式

CLI：

```sh
zcode plugins enable restore-legacy-sessions
```

会话内：

```text
/plugins enable restore-legacy-sessions
```

变更对新 session 生效。启用后可使用：

```text
/restore-legacy-sessions
```

或者直接请求 `$restore-legacy-sessions`。

## 打包

官方插件 seed 逻辑需要能在源码运行、Electron packaged layout 和 SEA 运行时都发现该插件。

- `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 注册官方插件 root candidates。
- `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs` 注册 SEA asset，`requiresRuntime: false`。
- 因为没有 MCP runtime，seed 阶段不需要 rewrite `.zcode-plugin/plugin.json`。

## 验证

- `zcode plugins list` 能看到 `restore-legacy-sessions@zcode-plugins-official`，默认 disabled。
- disabled 状态不注入 skill roots 或 command roots。
- enable 后 `skillCount = 1`，`commandRootCount = 1`。
- SEA asset manifest 包含 `skills/restore-legacy-sessions/SKILL.md`、两个脚本和 `commands/restore-legacy-sessions.md`。
- `pnpm typecheck`
- `pnpm lint`

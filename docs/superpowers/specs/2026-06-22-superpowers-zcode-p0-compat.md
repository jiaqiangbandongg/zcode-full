# Superpowers ZCode P0 兼容规范

## 背景

ZCode 已支持内置插件、Claude/Codex manifest 发现、插件 hooks、Skill 工具和 Agent subagent 工具，但 Superpowers 仍存在两类 P0 兼容缺口：

- Superpowers 文档和测试按 `superpowers:<skill>` 调用技能，ZCode agent runtime 只按裸 `skill.name` 精确匹配，导致 `superpowers:test-driven-development` 等名称不可加载。
- Superpowers 的 `SessionStart` bootstrap 会注入 `using-superpowers`，但其 skill 文档来自 Claude Code 生态，会直接引用 `Task` 等 Claude Code 工具名；ZCode 不能只靠给 Superpowers hook 追加文本来翻译工具名，必须在工具注册和 hook matcher 层提供结构化兼容。

目标是在不修改用户外部 Claude 插件缓存的前提下，让内置 Superpowers 和 `.claude-plugin` 形态的满血 Superpowers 至少达到：启用后 skills 可按 `superpowers:*` 加载，bootstrap 生效，Claude Code 插件文档中提到的 `Task` subagent 调度能在 ZCode 工具面直接执行。

## Skill Alias 规则

当 skill root 来自 `source: "plugin"` 时，ZCode agent runtime 必须从插件 root 的 manifest 反推出插件名，并为每个技能生成可选的 fully qualified alias：

```text
<plugin manifest name>:<skill frontmatter name>
```

例如 Superpowers 插件中的 `skills/test-driven-development/SKILL.md`：

- 裸名仍为 `test-driven-development`，保持既有兼容。
- Qualified name 为 `superpowers:test-driven-development`，作为推荐调用名暴露给模型。

Manifest 搜索顺序与插件发现保持兼容：

1. `.zcode-plugin/plugin.json`
2. `.claude-plugin/plugin.json`
3. `.codex-plugin/plugin.json`
4. `.cursor-plugin/plugin.json`

搜索从 skill root 开始向父目录有限上溯，覆盖标准 `plugin/skills/<skill>/SKILL.md` 与自定义 skills 子目录。Manifest 无法读取或缺少合法 `name` 时，不阻断 skill 加载，只是不生成 qualified alias。

Skill 加载必须同时接受裸名与 qualified name。Skill 上下文列表应优先展示 qualified name，并注明裸名仍可加载，避免模型看到 Superpowers 文档后调用不存在的裸/前缀混合名称。

## Subagent Skill 过滤

自定义 subagent profile 若声明 `skills` 白名单，过滤逻辑必须同时识别裸名和 qualified name。否则 profile 写 `superpowers:*` 精确技能名时，父 runtime 可以加载，子 runtime 却会被白名单拒绝。

## Claude Code Tool Compatibility

ZCode 不应要求用户改写外部 Claude 插件里的 skill 文档或 `hooks/session-start`。兼容层放在工具注册和 hook matcher 两处：

- `Task` 作为 Claude Code 兼容工具名注册，底层委托 ZCode 现有 `Agent` subagent handler。`Task` 与 `Agent` 使用同一输入/输出 schema、权限能力、结果预算和后台任务恢复语义。
- 当 runtime 未配置 subagent port 时，`Agent` 与 `Task` 都不得暴露；当子 agent runtime 禁止递归 subagent 时，`Agent` 与 `Task` 都必须被过滤。
- tool hook stdin 仍写入实际发生的工具名，避免轨迹里出现虚假的工具名；hook matcher 额外接受兼容 aliases。`Agent` 调用应能命中 matcher `Task`，`Task` 调用也应能命中 matcher `Agent`。
- `ApplyPatch` 若重新启用，hook matcher 可兼容 Claude Code 风格的 `Write` / `Edit` matcher，但不得改变实际 toolName。

因此 Superpowers `SessionStart` hook 输出只负责注入它自身的 `using-superpowers` 上下文；ZCode 不再为 Superpowers 专门追加工具映射文本。其它 `.claude-plugin` 也能复用同一个兼容层。

Subagent 兼容的完整边界见 `docs/subagent-compatibility.md`。

## SessionStart Bootstrap 验证

启用 Superpowers 后，`SessionStart` hook 在 `startup|clear|compact` 匹配时应：

- 通过 `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` 执行插件 hook。
- 解析 `hookSpecificOutput.additionalContext`、top-level `additionalContext` 或 Cursor 风格 `additional_context`。
- 将 `using-superpowers` 注入当前 turn 的 `hook_context` system reminder。

`resume` 不在 Superpowers 默认 matcher 内，除非插件 manifest 未来声明对应 matcher。

## 验证要求

- plugin skill root 能从 `.claude-plugin/plugin.json` 推导出 `superpowers:*` alias。
- `Skill(skill="superpowers:test-driven-development")` 能加载对应技能。
- Skills 上下文展示 `superpowers:*`。
- subagent skill 白名单可识别 qualified alias。
- `Task` 工具可作为 Claude Code 兼容 alias 调度 ZCode subagent。
- `Task` 与 `Agent` 的 hook matcher aliases 互通，但 hook input 仍保留实际 toolName。
- Superpowers `SessionStart` additional context 不再追加 Superpowers 专用 ZCode tool mapping。
- `pnpm typecheck`
- `pnpm lint`

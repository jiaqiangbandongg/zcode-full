# `/` 与 `$` 面板内置 Skill 中英描述

## 背景

ZCode 官方内置 skill 通过官方插件随 CLI 打包。用户在输入框中主要通过两种入口发现它们：

- `/` 面板：slash command 面板会把 enabled skill 也作为候选，选中后插入 `$skill`。
- `$` 面板：skill mention 面板直接展示 skill 候选。

当前官方内置 skill 的描述有些是中文、有些是英文；切换 UI 语言后，`/` 与 `$` 候选面板的描述不会跟随语言变化。

## 目标

- 只在 `/` 与 `$` 候选面板里为官方内置 skill 提供中文 / 英文描述。
- 用户自定义 skill、第三方 skill、Agent runtime 注入和 CLI `zcode skills` 输出保持原状。
- 同一个本地化 helper 被 `/` skill 候选与 `$` skill mention 候选复用，避免两处文案漂移。
- 未命中的 skill 继续使用服务端返回的 `description`。

## 非目标

- 不修改 `SKILL.md` 正文或 frontmatter 解析格式。
- 不改 `@zcode/protocol`、`@zcode/contracts`、`ISkillsService` 参数。
- 不影响模型可见的 skill selection metadata。
- 不改变 skill 名称、路径、启用状态、排序或过滤规则。

## 设计

新增 UI 侧 helper：

- 输入：`name`、`description`、`path`、`scope`、可选 `pluginName`、当前 `Locale`。
- 仅当 skill 判断为官方内置插件 skill 时尝试本地化：`scope === "plugin"` 且 `pluginName` 属于官方内置插件集合，或 path 位于官方插件缓存路径。
- 文案表按 skill `name` 存储 `zh-CN` / `en-US` 两份描述。
- fallback：无当前语言文案时使用原始 `description`；无描述时沿用现有 scope fallback。

接入点：

- `packages/ui/src/slashCommandHelpers.ts` 的 `buildSkillSuggestions()` 接收当前 locale，用 helper 生成 `/` 面板 skill 候选描述。
- `packages/ui/src/mentions/providers/skillsMentionProvider.ts` 从 `useZCodeIntl()` 读取 locale，用同一个 helper 生成 `$` 面板 skill 候选描述与 source label。

## 验证

- 补充 `slashCommandHelpers` 与 `skillsMentionProvider` 单测，覆盖官方内置 skill 在中英文 locale 下的描述。
- 按仓库要求执行 `pnpm typecheck` 和 `pnpm lint`。

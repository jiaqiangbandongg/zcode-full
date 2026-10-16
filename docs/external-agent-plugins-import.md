# External Agent Plugins Import

## 目标

设置页「插件管理」支持从外部 Agent 的本地 plugins 目录一键导入到 ZCode。交互与「技能」「命令」导入保持一致，但业务目录、扫描规则、目标写入和去重逻辑独立维护。

## 来源范围

导入入口自动扫描以下本地来源：

- Claude Code：用户级 `~/.claude/plugins` 与工作区级 `<workspace>/.claude/plugins`
- Codex CLI：用户级 `~/.codex/plugins` 与工作区级 `<workspace>/.codex/plugins`
- OpenCode：用户级 `~/.config/opencode/plugins` 与工作区级 `<workspace>/.opencode/plugins`
- OpenClaw：用户级 `~/.openclaw/plugins` 与工作区级 `<workspace>/plugins`
- Augment：用户级 `~/.augment/plugins` 与工作区级 `<workspace>/.augment/plugins`
- Continue：用户级 `~/.continue/plugins` 与工作区级 `<workspace>/.continue/plugins`
- Goose：用户级 `~/.config/goose/plugins` 与工作区级 `<workspace>/.goose/plugins`
- Qwen Code：用户级 `~/.qwen/plugins` 与工作区级 `<workspace>/.qwen/plugins`
- Qoder：用户级 `~/.qoder/plugins` 与工作区级 `<workspace>/.qoder/plugins`
- Qoder CN：用户级 `~/.qoder-cn/plugins` 与工作区级 `<workspace>/.qoder/plugins`
- Windsurf：用户级 `~/.codeium/windsurf/plugins` 与工作区级 `<workspace>/.windsurf/plugins`
- Trae：用户级 `~/.trae/plugins` 与工作区级 `<workspace>/.trae/plugins`
- Kiro CLI：用户级 `~/.kiro/plugins` 与工作区级 `<workspace>/.kiro/plugins`
- Roo Code：用户级 `~/.roo/plugins` 与工作区级 `<workspace>/.roo/plugins`
- CodeBuddy：用户级 `~/.codebuddy/plugins` 与工作区级 `<workspace>/.codebuddy/plugins`

不支持 Gemini，也不扫描用户级或项目级 `.agents/plugins`。

## 识别规则

- 插件候选是包含 manifest 的目录。
- manifest 优先级：
  1. `.zcode-plugin/plugin.json`
  2. `.claude-plugin/plugin.json`
  3. `.codex-plugin/plugin.json`
- manifest 必须是 JSON object，且 `name` 为非空字符串；`version` 读不到时不展示。
- 扫描深度只查来源根目录下一层插件目录，不递归扫描插件内部资源目录。

## 导入策略

- 导入目标由用户在导入按钮下拉菜单中选择：
  - `Global` 写入 `~/.zcode/plugins/<plugin-dir>/`，并把该绝对路径追加到 `~/.zcode/cli/config.json` 的 `plugins.dirs`。
  - `Project` 写入 `<workspace>/.zcode/plugins/<plugin-dir>/`，并把该绝对路径追加到 `<workspace>/.zcode/config.json` 的 `plugins.dirs`。
- 导入方式与技能、命令一致：
  - `软链`：在目标路径创建指向来源插件目录的符号链接，默认选项。
  - `直接复制`：复制插件目录到目标路径。
- 若没有打开工作区，`Project` 目标不可选。
- 已存在同名目标目录，或目标配置中已经存在相同 plugin id（`<manifest.name>@inline`）时跳过，不覆盖现有插件。
- 打开弹窗或重新扫描后默认停留在 `Global`，但 `Global` 与 `Project` 来源都不默认勾选，需要用户显式选择。

## UI 行为

- 「插件管理」设置页在刷新按钮旁展示导入图标按钮。
- 弹窗结构、范围 Select、刷新按钮、两层来源树、全选/取消全选、导入目标分裂按钮、导入方式下拉菜单、完成结果列表均与技能、命令导入保持一致。
- 第二层展示插件名称；若 manifest 中存在 `version`，紧跟插件名称展示版本 badge。
- 导入完成页展示本次涉及的插件列表；每项显示状态图标和插件名，不展示文件路径。

## 兼容与边界

- `settings-sync` 新增 `plugins` 分类，插件来源表独立维护，不从 `skills` 或 `commands` 来源表派生；资源扫描、去重和导入也独立。
- 远程 workspace 只使用当前 host process 可访问的文件系统路径；身份隔离语义仍传递 `workspaceIdentity`，路径执行仍使用 `workspacePath`。
- 直接复制模式不引用外部目录；软链模式会持续指向外部插件目录，适合希望跟随外部 Agent 插件变更的用户。
- ZCode 运行态通过 `plugins.dirs` 读取导入后的 inline 插件；导入功能不写入 official marketplace cache。

## 验证

- 覆盖缺失目录、空目录、同名跳过、用户级导入、工作区级导入、copy/symlink 两种模式。
- 覆盖 `.zcode-plugin/plugin.json` 与 `.claude-plugin/plugin.json` 两种 manifest。
- UI 覆盖导入按钮、弹窗来源列表、导入完成刷新。
- 必须运行 `pnpm typecheck` 和 `pnpm lint`。

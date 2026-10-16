# External Agent Skills Import

## 目标

设置页「技能」支持从外部 Agent 的本地技能目录一键导入到 ZCode。第一阶段只导入 Skills，不导入 MCP 服务器、插件、命令或模型供应商。

## 来源范围

导入入口自动扫描以下本地来源：

- Claude Code：用户级 `~/.claude/skills` 与工作区级 `<workspace>/.claude/skills`
- Codex CLI：用户级 `~/.codex/skills` 与工作区级 `<workspace>/.codex/skills`
- OpenCode：用户级 `~/.config/opencode/skills` 与工作区级 `<workspace>/.opencode/skills`
- OpenClaw：用户级 `~/.openclaw/skills` 与工作区级 `<workspace>/skills`
- Augment：用户级 `~/.augment/skills` 与工作区级 `<workspace>/.augment/skills`
- Continue：用户级 `~/.continue/skills` 与工作区级 `<workspace>/.continue/skills`
- Goose：用户级 `~/.config/goose/skills` 与工作区级 `<workspace>/.goose/skills`
- Qwen Code：用户级 `~/.qwen/skills` 与工作区级 `<workspace>/.qwen/skills`
- Qoder：用户级 `~/.qoder/skills` 与工作区级 `<workspace>/.qoder/skills`
- Qoder CN：用户级 `~/.qoder-cn/skills` 与工作区级 `<workspace>/.qoder/skills`
- Windsurf：用户级 `~/.codeium/windsurf/skills` 与工作区级 `<workspace>/.windsurf/skills`
- Trae：用户级 `~/.trae/skills` 与工作区级 `<workspace>/.trae/skills`
- Trae CN：用户级 `~/.trae-cn/skills` 与工作区级 `<workspace>/.trae/skills`
- Kiro CLI：用户级 `~/.kiro/skills` 与工作区级 `<workspace>/.kiro/skills`
- Roo Code：用户级 `~/.roo/skills` 与工作区级 `<workspace>/.roo/skills`
- CodeBuddy：用户级 `~/.codebuddy/skills` 与工作区级 `<workspace>/.codebuddy/skills`

不支持 Gemini。

## 导入策略

- 只处理包含 `SKILL.md` 的技能目录。
- 导入目标由用户在导入按钮下拉菜单中选择：
  - `Global` 写入 `~/.zcode/skills/<skill-dir>/`。
  - `Project` 写入 `<workspace>/.zcode/skills/<skill-dir>/`。
- 导入方式由用户在弹窗底部切换：
  - `软链`：在目标目录创建指向来源技能目录的符号链接，默认选项；Windows 下目录链接使用 `junction`。
  - `直接复制`：复制整个技能目录到目标目录。
- 若没有打开工作区，`Project` 目标不可选。
- 没有打开工作区时仍扫描和导入用户级来源；工作区级来源只在存在 `workspacePath` 时参与。
- 已存在同名目标目录，或目标 ZCode 技能目录中已存在相同 `name` 的技能时跳过，不覆盖现有 ZCode 技能。
- 软链模式只对新导入技能生效；如果目标目录已经存在普通复制目录，不会自动替换为软链，仍按“目标目录已存在”跳过。
- 导入结果按来源汇总 `importedCount` / `skippedCount` / `failedCount`。
- 导入完成后刷新技能列表，让新技能立即出现在设置页。

## UI 行为

- 「技能」设置页在新建按钮旁展示导入图标按钮。
- 点击后弹出导入对话框，默认扫描并列出可导入技能来源。
- 弹窗参考 onboarding 向导的圆角、留白和工作区面板风格，但保持单栏结构；标题行右侧保留范围 Select 和刷新按钮，不展示标题说明文案。范围 Select 不显示额外 label，仅显示当前 `Global` / `Project` 值。当前视图使用两层来源树：第一层展示 Agent 与扫描路径，第二层展示该路径下的技能列表并默认折叠；点击箭头或来源文本展开确认技能明细。两个范围始终可选择，当前范围没有来源时在列表区展示空态。
- 用户可在第二层单独勾选技能，第二层只展示可导入技能；已导入过、目标目录已存在或同名技能已存在的技能直接过滤，不展示在导入列表中。若 `SKILL.md` frontmatter 中存在 `version`，紧跟技能名称展示版本 badge，不展示路径。第一层复选框用于全选/取消该来源下全部可导入技能，并在部分选中时展示半选态。
- 列表顶部提供当前范围的全选/取消全选 checkbox 控制，只作用于当前 `Global` / `Project` 范围内可导入的技能，不影响另一个范围的选择状态。打开弹窗或重新扫描后默认停留在 `Global`，但 `Global` 与 `Project` 来源都不默认勾选，需要用户显式选择。
- 导入按钮采用分裂按钮：左侧点击后按当前目标和导入方式处理已选技能，右侧下拉菜单只切换导入目标，不直接触发导入；同名或同 `name` 的现有 ZCode 技能继续跳过，不覆盖。底部下拉菜单可在 `直接复制` 与 `软链` 间切换，旁边的叹号图标 hover 后通过 tooltip 说明当前导入方式的影响。
- 导入完成页弱化顶部统计数字，并展示本次涉及的技能列表；每个技能显示状态图标、名称和可选版本，不展示文件路径，跳过项通过图标提示展示具体原因。
- 空扫描结果保留弹窗并提示暂无可导入技能，避免用户误以为按钮无效。

## 兼容与边界

- `settings-sync` 继续承载导入状态机；本功能新增 `skills` 分类与外部 Agent source，但不改变 onboarding 的默认 `providers` 可见范围。
- 导入弹窗不扫描用户级或项目级 `.agents/skills`，因为普通技能列表已经直接回读 `.agents` 技能目录；导入只负责把其它外部 Agent 来源复制到 ZCode 技能目录。
- 工作区技能列表从当前目录向上遍历到 worktree 根时，每一层都合并读取 `.zcode/skills` 与 `.agents/skills`，与 Agent runtime 的默认 roots 保持一致；不得因为同层 `.zcode/skills` 已有技能就整根跳过 `.agents/skills`。两个根命中同一 realpath 时只保留一份，同名但路径不同的技能继续按安装项分别保留；废弃的 `.zcode/cli/skills` 与 `.claude/skills` 不参与发现。
- 用户级技能列表同时读取 `~/.zcode/skills` 与 `~/.agents/skills`，避免导入一个全局技能后把剩余外部 Agent 全局技能从设置页隐藏；若 `.agents` 下某技能已按同目录名或相同 `name` 复制到 `.zcode/skills`，列表优先展示 `.zcode` 副本，避免重复。
- Agent runtime 与设置页必须对 `SKILL.md` frontmatter 使用一致语义：`description` 支持 YAML 单行标量、`>` folded block 与 `|` literal block。`~/.agents/skills` 常见手写技能会用 `description: >` 编写多行触发说明，不能只读取顶层 `description: >` 字面值而丢弃缩进行；否则设置页能显示完整描述，但 Agent 注入的 skills 清单只剩 `>`。
- 远程 workspace 只使用当前 host process 可访问的文件系统路径；身份隔离语义仍传递 `workspaceIdentity`，路径执行仍使用 `workspacePath`。
- 直接复制模式不引用外部目录，避免外部 Agent 后续删除或修改影响 ZCode；软链模式会持续指向外部目录，适合希望跟随外部 Agent 技能变更的用户。

## 验证

- 覆盖缺失目录、空目录、同名跳过、用户级导入、工作区级导入。
- 覆盖工作区同层 `.zcode/skills` 与 `.agents/skills` 同时存在时两边都能发现，并继续忽略 `.zcode/cli/skills` 与 `.claude/skills`。
- 覆盖 `.agents/skills` 中 `description: >` / `description: |` 多行 frontmatter，确保 Agent runtime 发现结果与设置页一致。
- UI 覆盖导入按钮、弹窗来源列表、导入完成刷新。
- 必须运行 `pnpm typecheck` 和 `pnpm lint`。

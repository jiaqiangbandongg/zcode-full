# Slash Command Skill Suggestions

## 背景

用户习惯在聊天输入框里输入 `/` 搜索可用能力。Skill 目前只在 `$` 触发面板中展示，导致用户进入 `/` 菜单时看不到已启用技能，误以为技能不可用。

## 产品语义

- `/` 面板继续作为能力发现入口，展示 slash commands、skills、subagents 三类结果。
- 从 `/` 面板选择 skill 时，插入内容仍使用现有 `$skill` mention 语义；不要新增 `/skill` 命令协议，也不要让 agent 侧误把 skill 当作 custom slash command。
- Skill 列表复用 `$` 面板的启用状态、provider 过滤、同名折叠和本地化描述，避免两个入口展示不一致。
- 空 query 时按 commands、skills、subagents 的分组顺序展示；有 query 时每组内复用现有模糊搜索，全局键盘默认选中仍按统一评分选择最佳项。

## 边界

- 本改动只影响 UI composer 建议面板和 mention 序列化，不修改 `@zcode/protocol`、session stream、task queue、snapshot 或远控 replayable/continuous 语义。
- 桌面和 Web 远控都通过现有 shared skill store 读取 skills；远程 workspace 继续由既有 `workspaceIdentity` 绑定逻辑隔离。
- 如果 skill store 未加载或报错，`/` 面板只在技能分组显示加载/错误状态，不阻塞 commands 和 subagents。

## 验收

- 输入 `/` 能看到启用技能分组。
- 输入 `/code` 能匹配 `code-review` 这类 skill。
- 选择 skill 后输入框中生成现有 skill mention markdown，发送路径等价于从 `$` 面板选择该 skill。
- `/` 面板仍能展示 `/goal`、`/compact`、`/init`、custom command 和 subagent。

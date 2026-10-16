# Mention Node Tokens

> **当前状态**：输入节点与 V4 conversation 用户消息回显共用这些 token。

`packages/ui/src/styles.css` 新增了一组专门给提示词 mention node 使用的主题 token：

- `--color-file-node`
- `--color-file-node-hover`
- `--color-file-node-foreground`
- `--color-skill-node`
- `--color-skill-node-hover`
- `--color-skill-node-foreground`
- `--color-command-node`
- `--color-command-node-hover`
- `--color-command-node-foreground`

用途：

- 统一提示词输入框里的 mention node 和 `UserPrompt` 里的回显样式
- 允许 Zai Light / Zai Dark 分别调整 node 配色；默认 light / dark 仅作为 fallback token 基础保留
- 避免在组件里继续写死 `sky/violet/primary` 的 Tailwind 原子颜色
- mention node 是结构化视觉标签，不是可点击控件；输入框和消息回显都使用 `cursor-default`
- command mention node 的图标语义保持稳定：`/goal` 使用 target，`/compact` 使用 scroll-text，普通/自定义 slash command 使用 `square-slash`，颜色仍走 command node token

## V4 UserPrompt 回显规则

V4 conversation 的 `userInput.text` 保留发送给 Agent 的原始 mention markdown，展示层负责按旧版 `UserMessage` 的语义还原为结构化标签，不能把内部路径或 session id 直接暴露在用户气泡中：

- `[$skill](.../SKILL.md)` 与旧格式 `$skill`：魔杖图标 + 可读 skill 名称，隐藏 `SKILL.md` 路径。
- `[#标题](#sess_xxx)` 与裸 `#sess_xxx`：对话图标 + 标题或 session id；markdown 目标中的 session id 不重复展示。
- `[文件名](path)` 与目录链接：按文件/目录类型显示 Material icon + label，隐藏 markdown destination。
- `@subagent`：Bot 图标 + subagent 名称。
- `/goal`、`/compact` 与其他 slash command：分别使用 Goal、ScrollText、SquareSlash 图标。
- 已被发送入口认定为 goal 控制命令的开头 `/goal` / `/target` 在只读用户气泡中
  还原为不带 `/` 的 `goal` / `target` mention 标签；输入框中的 command node 继续保留
  原始 slash command 语义。

`/goal` 仍受 V4 command intent 边界约束：只有发送入口认定为 goal 控制命令时才在
command 标签中省略 `/`；携带普通附件或隐藏上下文而退化为普通 prompt 时必须保留原文，
不能仅靠文本前缀重猜语义。复制和行内编辑继续使用原始 `userInput.text`，mention 标签只
影响只读展示。

代码入口：

- 主题变量定义：`packages/ui/src/styles.css`
- mention 样式复用：`packages/ui/src/mentions/mentionChip.ts`
- command node 图标与输入节点：`packages/ui/src/mentions/nodes/PromptMentionNode.ts`
- V4 用户消息回显：`packages/ui/src/v4/ConversationRowView.tsx`

后续如果要调 node 颜色，优先改 token，不要直接在组件里改原子类。

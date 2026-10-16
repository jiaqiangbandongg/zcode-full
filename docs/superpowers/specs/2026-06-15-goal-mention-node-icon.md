# Goal Mention Node Icon

## 背景

聊天输入框中的 `/goal` 结构化 command mention node 仍使用旧的靶心样式图标，而聊天发送后的 command chip、goal tool、goal verification 等位置已经使用 lucide `GoalIcon`。同一个 goal 语义在输入前后图标不一致。

## 目标

- `/goal` command mention node 的图标改为 lucide `goal` 图标。
- 仅替换 goal node 图标路径，不改变 command mention 的颜色、尺寸、文案和序列化 markdown。
- `/compact` 和普通 slash command 的图标保持不变。

## 验收

- `/goal` mention node 渲染的 SVG path 与 lucide `GoalIcon` 一致。
- `pnpm typecheck` 与 `pnpm lint` 通过。

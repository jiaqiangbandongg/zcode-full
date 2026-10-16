# Chat Input Yen Skill Alias

## 背景

聊天输入框用 `$` 触发 skill mention。中文和日文输入环境里，用户可能更容易输入 `¥` 或全角 `￥`，导致无法唤起 skill 面板。

## 目标

- 用户在聊天输入框中输入 `¥` 或 `￥` 时，把它们作为 `$` 的触发别名唤起 skill mention 面板。
- 别名只影响 trigger 识别语义，不在输入进入编辑器前把用户手输字符改写成 `$`。
- 选择候选后继续复用现有 `$` skill mention token 插入和发送解析逻辑。
- 行为在桌面端、本地 Web 和手机远控输入框中一致。

## 边界

- trigger 提取层识别 `¥` / `￥`，并把它们归一到现有 `$` skill trigger 分支。
- 不新增独立的 `¥` trigger 类型，不新增独立面板，不修改 `$` 候选来源。
- 不修改协议和 agent 解析层；候选选择后的 mention markdown 仍使用现有 `$skill` 语义。

## 兼容性

- 逻辑位于 `packages/ui` 的 prompt trigger 解析层，桌面端、本地 Web 和手机远控复用同一输入组件与面板逻辑。
- 不涉及 `@zcode/protocol`，不影响 session、continuous/replayable 实时消息流、远控 snapshot 或 task command queue。
- `$` 原有输入、匹配、筛选和 mention 插入行为保持不变。

## 验收

- 输入 `¥` 后，按 `$` 的空 query skill trigger 打开 skill mention 面板。
- 输入 `￥code` 后，按 `$code` 过滤 skill 候选。
- 选择候选后，`¥code` / `￥code` 被替换为现有 skill mention token，markdown 仍等同 `$skill`。
- 不会在用户手输 `¥` 的瞬间把编辑器内容改写成 `$`。
- 原有 `、` 位于全文开头时归一为 `/` 的行为保持不变。

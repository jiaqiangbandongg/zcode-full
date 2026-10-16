# Todo 31：模型配置弹窗输入控件一致性收口

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：Provider 设置页真实体验反馈
>
> 关联任务：[`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md)、
> [`Todo 29`](./todo-29-model-config-resolution-and-idle-trigger-closure.md)

## 1. 问题

模型配置弹窗的 JSON 字段最初同时使用外层字段卡片和内层 `Textarea`，形成双层边框；删除外层卡片后，
共享 `Textarea` 的弱背景和边框在深色弹窗中几乎不可见，实际控件看起来退化成裸 JSON。现有测试只验证
外层卡片被删除，没有证明保留的文本框与普通输入框一致可辨。

技术输入还继承了浏览器的自然语言拼写检查，macOS/Electron 会在 Model ID 下显示错误的红色拼写虚线。
与此同时，模型弹窗的 Model ID、上下文窗口和最大输出 Token 都把任意 Enter 直接解释为保存，没有区分
中文输入法候选确认产生的 Enter。

```text
IME 正在组词
      |
      | Enter
      v
候选文字上屏 + onCommit()
      |
      v
弹窗意外保存
```

## 2. JSON 单层文本框

每个 JSON 字段只保留一层普通多行文本框：

```text
字段标题
└─ Textarea（唯一的背景和边框）
```

- 不增加卡片、额外背景或第二层边框；
- 背景色、边框色、Focus 状态与普通文本框相同，不使用 Checkbox 的 Personal Override 强调样式；
- 没有 Personal 值时，Effective JSON 继续作为 placeholder；存在 Personal 值时显示普通输入文字；
- 固定高度，内容超出后在文本框内部滚动，不允许拖拽改变高度；
- 保持等宽字体和 JSON 换行，不新增只读 Effective Preview；
- JSON 非法时沿用普通输入错误状态和字段级错误文案。

## 3. 技术输入行为

Model ID、Provider 技术字段、URL、API Key 和 JSON 不参与自然语言辅助输入：

- 关闭拼写检查；
- 关闭自动纠正和自动大写；
- 关闭浏览器自动完成；
- 不改变密码可见性、数值键盘、placeholder 或保存语义。

## 4. IME-safe Enter

所有“Enter 表示保存/结束编辑”的 Provider 设置输入统一复用已有 IME composition 判断：

```text
Enter
├─ composition active
│  └─ 仅由输入法确认候选；不 preventDefault、不保存、不失焦
└─ ordinary keydown
   └─ 执行原有保存或失焦行为
```

- 同时读取组件维护的 `compositionstart/compositionend` 状态和原生 `isComposing`；
- 模型弹窗的 Model ID、上下文窗口、最大输出 Token 使用同一判断；
- Provider 名称、Base URL、API Key 等现有 Enter-to-save 入口统一使用同一 helper；
- JSON Textarea 中 Enter 始终输入换行，不承担保存；
- 显式保存按钮、普通 Enter、blur 和 1200ms idle save 的既有行为不变。

## 5. 测试与完成标准

1. JSON 字段仍是两个固定高度的 `Textarea`，外层无卡片，文本框使用普通输入样式；
2. Effective JSON 作为 placeholder，Personal JSON 作为 value；
3. Model ID 与 JSON 等技术输入关闭拼写检查和自动纠正；
4. `compositionstart -> Enter` 不调用保存，候选确认不被阻止；
5. `compositionend -> 普通 Enter` 只保存一次；
6. Provider 页面所有 Enter-to-save 技术输入遵守相同 IME 边界；
7. JSON Enter 不触发保存；
8. 中英文、浅色/深色主题和键盘操作保持可用；
9. UI 定向测试、typecheck、lint、格式检查和 `git diff --check` 通过；
10. 完成后更新实施结果并提交 Conventional Commit。

本 Todo 不修改 Model Config Rule 内容、Overlay 顺序、Registry、账号套餐或模型运行时能力。

## 6. 实施结果

- JSON 字段收口为单层、固定高度的普通 `Textarea`，背景、边框和 Focus 状态与普通
  `Input` 一致；
- Personal JSON 仍作为 `value`，Effective JSON 仍作为 `placeholder`，没有引入新的预览状态；
- Provider 名称、Base URL、API Key、Model ID、数值字段和 JSON 统一关闭拼写检查与自动改写；
- Provider Base URL/API Key 和模型弹窗的 Enter 保存均同时使用本地 composition 状态与
  原生 `isComposing`，中文候选确认不再导致失焦或保存；
- 新增回归测试先证明旧实现会误保存，再验证 composition 结束后的普通 Enter 仍只保存一次。

验证结果：

- Provider/Model UI 定向测试：57 个通过；
- affected 单测升级为全量单测：12,477 个通过，25 个跳过；
- `pnpm typecheck` 通过；
- `pnpm lint` 通过（0 error，34 个既有 warning）；
- 本轮修改文件格式检查和 `git diff --check` 通过。

全仓 `pnpm fmt:check` 仍被仓库内 Electron 文档的既有非法 HTML 和
`apps/zcode-cli/tests/gb2312.js` 的读取问题阻断；本轮文件已单独通过 `oxfmt --check`。

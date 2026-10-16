# 我的反馈详情编号展示

## 背景

用户在“问题反馈 / 我的反馈”里打开单条反馈后，需要把该反馈的 issue 编号发给研发、产品或客服定位问题。当前详情页只展示标题、状态、提交时间和处理进度，用户无法直接看到或复制编号。

## 目标

- 在“我的反馈”详情页顶部展示当前反馈的编号。
- 编号旁提供复制按钮，点击后复制纯编号值，便于粘贴到聊天、文档或后台检索框。
- 交互保持桌面端和手机 Web 端一致，不依赖桌面专有 API。

## 设计

- 编号来源使用 `FeedbackTicketDetail.id`，不新增反馈服务协议字段。
- 显示文案为 `Issue #<id>`；其中 `<id>` 使用等宽字体，避免长编号阅读困难。
- 复制按钮放在编号同一行，使用 `Button` 的 `ghost` + `icon-sm` 尺寸和 `CopyIcon`，符合 `DESIGN.md` 对紧凑工具按钮的要求。
- 复制内容只包含 `<id>`，不包含 `Issue #` 前缀。
- 复制成功后按钮的可访问标签短暂切换为“已复制”；复制失败时通过 `packages/ui/src/logger.ts` 记录 warn，不直接调用 `console` 或 `window.zcode`。

## 兼容性

- 浏览器剪贴板使用 `navigator.clipboard.writeText`，桌面 Electron、Web 和手机远控都走同一 Web API。
- 剪贴板不可用或写入失败时不阻断详情页渲染，只记录可诊断日志。
- 该改动不涉及 `clientMode`、`deliveryKind`、task realtime、snapshot、queue 或远控恢复链路。

## 验证

- 单测覆盖详情页渲染编号和复制按钮标签。
- 运行 `pnpm typecheck`。
- 运行 `pnpm lint`。

# 11 个可直接修复 E2E 失败修复设计

## 范围

本次只修复 `summary.json` 中已确认可直接处理的 11 个失败：

- I35～I39、I42 共 6 个 Turbo provider case：补齐 WDIO Coding Plan mock 的 spec 识别。
- I25、I29 共 2 个 DeepSeek case：case-local replay 同时覆盖 seed provider 的 OpenAI `/chat/completions` 与重启窗口可能先恢复到的 Anthropic `/messages`；case 只验证 provider/model，不把传输协议竞态误纳入语义。
- `conversation-session-v4-refresh-permission`：不再依赖已按产品设计隐藏的 exact rule 文本，通过稳定的权限 option 语义定位“始终允许”。
- `conversation-session-v4-queue`：queue 冲突 toast 断言同时接受产品支持的中英文文案。
- `conversation-session-v4-load-older`：在触发补页时记录真实可见 turn 锚点，prepend 后按 DOM 几何差校正视口；现有总高度差保留为无 DOM 锚点时的 fallback。

I27、I28 不在本次范围内；即使共享修复使其结果变化，也不把它们声明为已修复。

## 根因与边界

### Provider 启动与 replay 合同

拆分 Turbo spec 后，`shouldUseCodingPlanTeamMock` 仍只识别旧 spec，导致 provider registry 中没有可用 Coding Plan。DeepSeek 启动 provider 已使用 `anthropic-messages`，但两个旧 fixture 仍匹配 `/chat/completions` 并返回 OpenAI SSE。

```text
formal spec -> WDIO spec gate -> Coding Plan mock -> provider registry -> toolbar/session
                                  ^
                                  | 漏掉两个拆分后的 Turbo spec

startup DeepSeek(apiFormat=anthropic-messages) -> POST /anthropic/v1/messages
seeded DeepSeek(apiFormat=openai-compatible)   -> POST /chat/completions
case-local fixture                             -> 两种稳定响应合同
```

修复只更新 E2E 基础设施和 fixture，不改变 provider 产品逻辑。

### 权限 option 定位

exact rule 按既定产品设计不展示，因此 E2E helper 不能再用 `data-permission-rule-scopes` 推断 allow-always。`PermissionDialog` 在 option 按钮上暴露规范化后的 display kind，helper 按 `allowAlways` 选择。刷新 case 继续通过“弹窗恢复、批准成功、重复 exact 命令不再询问”证明规则恢复，不断言被隐藏的文本。

### Queue 草稿冲突提示

```text
workspace locale=zh-CN -> 产品显示中文 toast
                           |
旧 E2E 只匹配英文 ----------+-> 误报 toast 缺失
```

运行时日志确认产品已正确阻止撤回并显示中文 toast；失败来自测试继承 workspace locale 后仍只匹配英文。断言改为接受同一 i18n key 的中英文文案，不修改 queue admission、桌面 continuous 或 Web replayable 行为。

### Load older 锚点

```text
用户接近顶部
  -> 记录首个可见 turnId + viewport offset
  -> onLoadOlder
  -> prepend commit
  -> 同一 turn 新 offset - 旧 offset
  -> scrollTop += delta（绘制前）
```

旧逻辑只比较 `virtualizer.getTotalSize()`；prepend 的新估算高度尚未进入该值时 delta 为 0，且下一 commit 已失去“首行变小”的检测窗口。真实 DOM 锚点优先，既有总高度差 fallback 兼容锚点未挂载的虚拟化窗口。

## 验证

- 秒级单测覆盖 Turbo spec gate、权限 option kind 和 prepend 锚点差值。
- 两个 model-provider spec 运行 fixture check。
- 运行受影响 UI/desktop 定向测试。
- 最后执行根目录 `pnpm typecheck`、`pnpm lint`。

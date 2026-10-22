# 插件页面承载层点击穿透修复

## 原因与规则

握手超时后 webview 已移除，但侧栏承载容器仍保留覆盖区域和 `pointer-events: auto`，空容器会拦住宿主的重载按钮。

共享页面承载层只负责定位，始终使用 `pointer-events: none`；其中的 webview 显式使用 `pointer-events: auto`。不新增生命周期状态、定时器或错误分支。

```text
有 webview：鼠标 → webview → 插件内容
无 webview：鼠标穿过空容器 → 宿主重载按钮
```

MCP Apps 与 Gen UI 共用该承载层，因此内联、侧栏和 popover 预览均遵守同一点击规则。原有锚点迁移、实例清理、握手时限和重载流程保持不变。

## 保活侧栏的展示边界

插件页面挂在 body 下的独立浮层，不能继承宿主侧栏的透明度、裁剪及祖先页面隐藏状态。收起时锁宽、切标签时保留 DOM，会使锚点仍连接且有尺寸；不能只凭几何相交判断是否应该显示。

展示状态唯一来源是宿主：工作区可见、聊天主视图、侧栏展开、当前标签同时成立。`WorkspaceShellLayout` 投影页面可见性，`AnimatedSidePanePanel` 合并当前标签，沿 `PluginUiSidePane` → model → view → card 传递。card 在 layout effect 同步解绑隐藏锚点，不等待动画或 observer 回调，不删除 tab 或实例 owner。

```text
工作区可见 ∧ 聊天页 ∧ 侧栏展开 ∧ 当前标签 → 绑定展示锚点
任一条件关闭 → 同步解绑 → inert 后台表面 → 同一 guest 继续运行
条件恢复 → 重新绑定 → 同一 guest 与内存编辑状态重新显示
```

隐藏后的非零尺寸后台表面沿用[后台执行契约](plugin-ui-background-execution.md)，不因隐藏而暂停或回收 MCP 页面，不要求插件上报私有状态。重新显示不重复握手。

## 验证

- 真实 Electron 中用启动失败的测试页面触发 15 秒握手超时，等待 webview 移除后，鼠标点击宿主重载按钮；只触发一次回调并重建一个运行实例。
- 对正常页面，宿主命中测试必须落到 webview；通过 Chromium 鼠标与键盘事件确认插件按钮和输入框可操作。
- 内联、侧栏、popover 预览切换后仍可交互，保持同一 guest。
- 真实 Electron 用鼠标收起侧栏、切换标签、离开聊天页及切换工作区。保留真实卡片 DOM，断言后台表面不可命中、inert、页面不再可见；双帧工作仍完成、编辑状态与 guest 身份保持，恢复可交互且不新增注册。覆盖深浅主题。
- 初始隐藏的侧栏不绑定锚点；桌面和手机壳的页面隐藏状态均传给侧栏。Web/remote 的能力回退继续验证。
- 不使用 DOM `.click()` 代替鼠标命中测试。故障页为受控夹具，不代表原始用户插件的启动问题也已修复。
- 无布局、主题、文案或平台能力变化；Web/手机/远程的不支持回退保持现状，不修改 continuous/replayable 消息语义。运行时证据以实际执行平台为准。

回归入口：`node packages/desktop/scripts/mcp-apps-host-e2e.mjs --managed-only`（超时重载及生命周期）与 `--storage-only`（真实 guest 在内联、侧栏、预览中的交互）。

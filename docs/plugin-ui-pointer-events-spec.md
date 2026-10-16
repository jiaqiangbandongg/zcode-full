# 插件页面承载层点击穿透修复

## 原因与规则

握手超时后 webview 已移除，但侧栏承载容器仍保留覆盖区域和 `pointer-events: auto`，空容器会拦住宿主的重载按钮。

共享页面承载层只负责定位，始终使用 `pointer-events: none`；其中的 webview 显式使用 `pointer-events: auto`。不新增生命周期状态、定时器或错误分支。

```text
有 webview：鼠标 → webview → 插件内容
无 webview：鼠标穿过空容器 → 宿主重载按钮
```

修改仅涉及 `pluginUiPagePlane.ts` 的容器重置样式与 webview 创建样式。MCP Apps 与 Gen UI 共用该承载层，因此内联、侧栏和 popover 预览均遵守同一规则。原有锚点迁移、实例清理、握手时限和重载流程保持不变。

## 验证

- 真实 Electron 中用启动失败的测试页面触发 15 秒握手超时，等待 webview 移除后，鼠标点击宿主重载按钮；只触发一次回调并重建一个运行实例。
- 对正常页面，宿主命中测试必须落到 webview；通过 Chromium 鼠标与键盘事件确认插件按钮和输入框可操作。
- 内联、侧栏、popover 预览切换后仍可交互，保持同一 guest。
- 不使用 DOM `.click()` 代替鼠标命中测试。故障页为受控夹具，不代表原始用户插件的启动问题也已修复。
- 无布局、主题、文案或平台能力变化；Web/手机/远程的不支持回退保持现状，不修改 continuous/replayable 消息语义。运行时证据以实际执行平台为准。

回归入口：`node packages/desktop/scripts/mcp-apps-host-e2e.mjs --managed-only`（超时重载及生命周期）与 `--storage-only`（真实 guest 在内联、侧栏、预览中的交互）。

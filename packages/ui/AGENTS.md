# UI 开发规则

本文件补充[根规则](../../AGENTS.md)，用于组件、页面、样式、hooks 与 UI 状态变更。

## 设计与平台

- 修改界面前读 [DESIGN.md](../../DESIGN.md)，遵守颜色、层级、尺寸、字体、圆角、组件复用、响应式、主题与国际化规则。插件商店另读 [CONTEXT.md](../../CONTEXT.md)。
- 同时检查桌面和手机 Web；视觉验证使用 DESIGN 定义的当前深浅主题，并考虑不同语言长度。
- 平台操作通过 `usePlatform()` / `IPlatformService`，不直接调用 `window.zcode`。平台实现通过注入隔离：Desktop 入口见 [desktopPlatform.ts](../desktop/src/renderer/src/desktopPlatform.ts)，Web 入口见 [main.tsx](../web/src/main.tsx)。

## 服务与状态

- 组件通过 [hooks](src/hooks/) 访问服务，由 hook 使用 `useServices()`；组件不直接取服务或访问 Repo。复用已有 hook，具体导出以源码为准。
- 使用 [Zustand store](src/store/) 与 StoreProvider；订阅通过 selector，例如 `useZCodeStore(selector)`。保持现有 Provider 依赖顺序，不在组件内构造第二份服务或业务状态。
- theme、locale 等跨窗口字段通过 broadcastService 的 `state:` 频道同步；应用广播时保留 `applyingBroadcast` 防回环语义。
- task/session、已提交输入等业务状态归属见 [runtime 边界](../../docs/agents/runtime-boundaries.md)。UI 保留草稿和展示投影，不能承接第二份 accepted queue。
- 含 JSX 的 hooks/Provider 文件使用 `.tsx`。

## 调试与验证

- 日志统一使用 [src/logger.ts](src/logger.ts)，它同时输出控制台与本地文件；不直接使用 `console.log` 或 `window.zcode.log`。
- 交互 bug 用日志或浏览器/CDP 执行证据定位；保留说明非显然根因的中文注释。
- 交互变更按根验证矩阵维护 E2E；纯视觉变更按矩阵做桌面/手机及主题验证。相关 React 问题可按任务需要使用现有 React skill，不需要为纯文档改动加载它。

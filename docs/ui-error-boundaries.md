# UI Error Boundaries

ZCode 的 React 错误边界分两层：

- 根级 `AppErrorBoundary`：兜住启动、Provider、Root 级异常，避免整窗白屏。
- 局部 `ScopedErrorBoundary`：按 workspace 内的故障域隔离 sidebar、header、chat、terminal、side pane、settings layer 等区域。

## 隔离范围

局部边界优先放在稳定布局容器内部，避免 fallback 破坏 `ResizablePanelGroup` 这类结构性组件。比如 terminal 和 side pane 的边界放在各自 `ResizablePanel` 内容层里，而不是包住整个 panel。

## Reset Key

涉及 workspace 级隔离时，统一使用：

```ts
const workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

不同区域再追加自己的上下文 key：

- chat：`workspaceKey + activeTaskId`
- side pane：`workspaceKey + activeTabId`
- terminal/sidebar：`workspaceKey`

这样远程 workspace 能按身份隔离，本地 workspace 继续回退到真实路径。

## 日志

局部边界统一通过 `packages/ui/src/logger.ts` 打 `error` 日志，日志中包含 `scope` 和 React component stack。事件回调、Promise、stream handler 等异步错误不会被 React Error Boundary 捕获，仍需要在对应 hook 或调用点显式处理。

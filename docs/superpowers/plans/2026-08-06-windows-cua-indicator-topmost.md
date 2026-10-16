# Windows CUA 提示条持续置顶实施计划

## 目标

修复 Windows CUA 顶部提示条在一次隐藏后复用时失去系统级置顶、被前台普通窗口遮挡的问题，同时保持不抢焦点、鼠标穿透和截图排除。

## 实施范围

- `packages/desktop/test/windowsCuaOperationIndicator.test.ts`
- `packages/desktop/src/main/windowsCuaOperationIndicator.ts`
- 不修改 CUA 生命周期协议、Host tracker、Renderer 或 `zcode-cua` helper。

## 实施步骤

1. 在窗口测试替身中增加 `setAlwaysOnTop` 和 `moveTop`，断言首次显示与隐藏后复用都严格执行 `showInactive -> setAlwaysOnTop(true, "screen-saver") -> moveTop`。
2. 先运行 Windows CUA indicator 单测，确认新断言因现有实现未调用置顶 API 而失败。
3. 提取统一显示函数，在每次 `showInactive()` 后重新声明 `screen-saver` 层级并调用 `moveTop()`；用中文注释记录 Windows 隐藏透明窗口会丢失原生 topmost 状态的根因。
4. 重新运行目标单测，确认首次显示、复用显示和既有显隐/异常路径全部通过。
5. 执行 `pnpm typecheck`、`pnpm lint` 与 `git diff --check`，提交实现。
6. 设置 `ZCODE_CUA_DEV_ROOT=C:\Users\dev\zcode-cua` 后重启 desktop dev，交给用户进行真实前台窗口遮挡验证。

## 验证重点

- 前台应用保持焦点，提示条不接收鼠标事件。
- 第二个 CUA turn 复用同一 BrowserWindow 时仍恢复最高应用层级。
- 普通窗口、任务栏和常见全屏窗口无法覆盖提示条。
- UAC 安全桌面、锁屏和独占全屏仍遵循 Windows 系统限制。

# Windows CUA Indicator Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去除 Windows CUA 顶部提示的矩形原生阴影和 CSS 裁剪硬边，同时保持可见卡片尺寸与顶部位置不变。

**Architecture:** `WindowsCuaOperationIndicator` 继续拥有唯一的 capture-excluded 透明 `BrowserWindow`。窗口显式关闭 DWM shadow，并把原来的可见卡片包在透明安全区中；定位逻辑以扩大后的窗口居中，但用 top inset 抵消 y 坐标，保证卡片顶边仍是 work area `+12px`。

**Tech Stack:** Electron `BrowserWindow`、TypeScript、内嵌 HTML/CSS、Vitest。

## Global Constraints

- 只修改 Windows 原生浮层，不修改 macOS、Linux、Web、手机或 CUA lifecycle 状态链。
- 可见卡片保持中文/英文 `234px`/`308px` 宽、`38px` 高，顶边保持 work area `+12px`。
- 透明安全区固定为左/右 `8px`、上 `6px`、下 `12px`；窗口为中文 `250px × 56px`、英文 `324px × 56px`。
- `BrowserWindow` 必须显式 `hasShadow: false`，阴影只能由 CSS 绘制。
- 保持 `alwaysOnTop`、不可聚焦、鼠标穿透、`setContentProtection(true)`、主题、国际化和 reduced-motion 行为。
- 先看到回归测试因旧窗口几何失败，再修改生产代码。
- 完成前运行定向测试、`pnpm typecheck`、`pnpm lint` 和 `git diff --check`。

---

### Task 1: 让透明窗口承载唯一的圆角 CSS 阴影

**Files:**

- Modify: `packages/desktop/test/windowsCuaOperationIndicator.test.ts`
- Modify: `packages/desktop/src/main/windowsCuaOperationIndicator.ts`

**Interfaces:**

- Consumes: `createWindowsCuaOperationIndicator(options)`、`indicatorCopy(locale)` 和现有 `positionWindow()`/`loadContent()` 生命周期。
- Produces: 关闭原生阴影、带透明安全区且保持可见卡片位置不变的 `BrowserWindow`；不新增跨模块接口。

- [ ] **Step 1: 写窗口阴影 owner 和几何的失败测试**

在首个 active turn 测试中要求：

```ts
expect(browserWindowOptions[0]).toMatchObject({
  alwaysOnTop: true,
  focusable: false,
  frame: false,
  hasShadow: false,
  resizable: false,
  show: false,
  skipTaskbar: true,
  transparent: true,
});
expect(windows[0]?.setBounds).toHaveBeenCalledWith({
  width: 250,
  height: 56,
  x: 2_435,
  y: 46,
});
const html = decodeIndicatorHtml(windows[0]?.loadURL.mock.calls[0]?.[0] ?? "");
expect(html).toContain("padding: 6px 8px 12px");
expect(html).toContain(
  "box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18)",
);
expect(html).not.toContain("box-shadow: 0 4px 12px");
```

把再次激活后的 work area 断言改为：

```ts
expect(windows[0]?.setBounds).toHaveBeenLastCalledWith({
  width: 250,
  height: 56,
  x: 835,
  y: 6,
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsCuaOperationIndicator.test.ts
```

Expected: FAIL；实际 options 缺少 `hasShadow:false`，bounds 仍为 `236 × 40`，HTML 仍包含旧阴影。

- [ ] **Step 3: 写最小生产实现**

在 `windowsCuaOperationIndicator.ts` 中把 copy width 定义为可见卡片宽度，并集中声明安全区：

```ts
const INDICATOR_CARD_HEIGHT = 38;
const INDICATOR_CARD_TOP_OFFSET = 12;
const INDICATOR_SHADOW_INSET = { top: 6, right: 8, bottom: 12, left: 8 } as const;

function indicatorCopy(locale: Locale): { text: string; width: number } {
  return locale === "zh-CN"
    ? { text: "ZCode 正在操作电脑", width: 234 }
    : { text: "ZCode is controlling your computer", width: 308 };
}

function indicatorWindowSize(locale: Locale): { width: number; height: number } {
  const { width } = indicatorCopy(locale);
  return {
    width: width + INDICATOR_SHADOW_INSET.left + INDICATOR_SHADOW_INSET.right,
    height: INDICATOR_SHADOW_INSET.top + INDICATOR_CARD_HEIGHT + INDICATOR_SHADOW_INSET.bottom,
  };
}
```

`positionWindow()` 和 `createWindow()` 使用 `indicatorWindowSize()`；y 坐标为：

```ts
y: Math.round(
  workArea.y + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top,
),
```

BrowserWindow options 新增：

```ts
hasShadow: false,
```

HTML 中改为：

```css
body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 8px 12px;
}
.indicator {
  width: 100%;
  height: 38px;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.08),
    0 6px 12px -6px rgba(15, 23, 42, 0.18);
}
```

dark media query 使用 spec 中的双层暗色阴影。新增中文原因注释，说明旧的 `1px` 透明余量裁剪 CSS shadow，且默认 DWM shadow 造成矩形灰带。

- [ ] **Step 4: 运行定向测试并确认转绿**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsCuaOperationIndicator.test.ts
```

Expected: PASS，全部 Windows indicator tests 通过。

- [ ] **Step 5: 运行仓库门禁**

Run:

```powershell
pnpm typecheck
pnpm lint
git diff --check
```

Expected: commands exit `0`；lint 允许仓库既有 warning，但不得新增本次文件 warning。

- [ ] **Step 6: 提交实现并重启本地 dev**

只暂存本任务两个代码/测试文件，不包含 `.pnpm-store/` 或 `.tmp/`：

```powershell
git add -- packages/desktop/src/main/windowsCuaOperationIndicator.ts packages/desktop/test/windowsCuaOperationIndicator.test.ts
git commit -m "fix(cua): render natural Windows indicator shadow"
```

停止当前 `@zcode/desktop dev:local-cli` 进程树，然后用以下环境变量启动隐藏 dev 进程：

```powershell
$env:ZCODE_CUA_DEV_ROOT = "C:\Users\dev\zcode-cua"
pnpm --filter @zcode/desktop dev:local-cli
```

Expected: Electron main、desktop Host、`zcode.cjs app-server --stdio` 和 `C:\Users\dev\zcode-cua\dist\windows-helper.js` 均存在。

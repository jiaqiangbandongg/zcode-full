# Web Remote Control 浏览器标签图标设计

## 背景

手机端通过浏览器打开 Web Remote Control 页面时，标签页显示浏览器默认图标。根因是 `packages/web/index.html` 只设置了页面标题，没有声明 favicon；`packages/web/public` 中也没有 ZCode 品牌 favicon。

本地 `pnpm dev:web-remote-control` 还存在一个额外问题：Chrome 在部分 dev 场景下不会为 favicon 发起独立网络请求，只依赖入口 HTML 中已经可用的 icon metadata。仅提供 `/favicon.ico` 或 `/remote/favicon.ico` 静态资源无法覆盖这种情况。

## 目标

- Web Remote Control 页面在常见桌面和手机浏览器标签中显示与桌面 App 一致的 ZCode 图标。
- 直接复用现有桌面 App 图标，不重新设计品牌资产。
- 不改变桌面端 continuous 链路、手机端 replayable 链路或任何远控业务状态。

## 非目标

- 不增加 PWA manifest。
- 不增加“添加到主屏幕”专用的 Apple Touch Icon 或 Android 图标。
- 不修改页面标题、启动页、主题或其他 UI。

## 设计

将桌面端多尺寸图标 `packages/desktop/build/icon.ico` 原样复制为 `packages/web/public/favicon.ico`，保留给传统 favicon 路径和构建产物使用。同时在 `packages/web/index.html` 的 `<head>` 中内嵌现有 App 小尺寸 PNG 图标：

```html
<link rel="icon" type="image/png" href="data:image/png;base64,..." sizes="32x32" />
```

选择 ICO 是因为现有文件已经包含多种尺寸，浏览器可按标签页显示密度选择合适图层；复制到 Web 的 `public` 目录可以让 Vite 在开发和生产构建中提供该静态资源。入口 HTML 使用 data URL 是为了覆盖 Chrome dev 不发 favicon 网络请求的场景，让浏览器在解析 HTML 时就拿到图标。data URL 来自 `public/logo/icons/32x32.png`，该图标集的 `icon.ico` 与桌面端 `packages/desktop/build/icon.ico` 二进制一致。

`dev:web-remote-control` 本地脚本继续使用 Vite root base，以保持既有 `/remote` SPA 路由行为；否则 Vite 会把 `/remote` 拦截成 base URL 提示页。

## 验证

- 在现有 `packages/web/test/webRemoteControlBootstrapShell.test.ts` 中增加回归断言，确认入口 HTML 内嵌 `public/logo/icons/32x32.png` 的 data URL favicon。
- 断言 Web favicon 与桌面 App ICO 的二进制内容一致，防止误用 Material Icons 中同名的通用文件图标。
- 在 root build scripts 测试中断言 `dev:web-remote-control` 继续用 root base 启动 Vite，覆盖本地复制链接场景。
- 运行 Web 定向测试、`pnpm typecheck` 和 `pnpm lint`。
- 执行带非根 base 的 Web 构建，确认输出 HTML 保留 base 无关的 data URL favicon，且传统 `favicon.ico` 文件进入构建产物。

## 兼容性与风险

改动仅涉及 Web 静态资源和 HTML metadata，不触及 React 组件、服务、协议、workspace identity 或远控消息流。桌面端与手机端的业务行为不变。浏览器可能缓存旧 favicon；发布后首次验证可使用无痕窗口或强制刷新排除缓存影响。

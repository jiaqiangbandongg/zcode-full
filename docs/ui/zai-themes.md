# Zai Themes

## 目标

新增 `zai-light` 与 `zai-dark` 两套品牌主题，并由它们接管用户可见的 Light Theme / Dark Theme。
默认 `light` / `dark` CSS 变量仍作为底层 fallback 保留，但主题菜单不再暴露原生 light / dark 入口。

## 实现

- `Theme` 枚举保留 `light` / `dark` 作为旧偏好兼容值，实际持久化与应用时会规范化到 `zai-light` / `zai-dark`。
- `resolveTheme()` 将 `zai-light` 归入 light 分支，将 `zai-dark` 归入 dark 分支，继续复用标题栏、代码预览和移动端远控的明暗模式边界。
- `system` 会按系统明暗偏好套用 `zai-light` 或 `zai-dark`，避免回落到默认 CSS 主题。
- `styles.css` 中的 `.theme-zai-light` / `.theme-zai-dark` 使用 Zai semantic token 映射到项目现有 `--color-*` 语义变量，组件层不直接依赖 primitive 色阶。
- 桌面、Web 首屏 bootstrap、进程监控页和手机远控主题菜单都使用 Zai 主题入口，避免首帧回退或入口不可选。

## Token 映射

- `bg/page` -> `--color-background`
- `bg/bg` -> `--color-card`、`--color-popover`、`--color-input`、`--color-input-focused`
- `bg/surface` -> `--color-panel`
- `bg/overlay` -> `--color-background-win-alt`，并以 60% 透明度派生 `--color-background-alt`
- `text/primary` -> `--color-foreground`
- `text/secondary` -> `--color-foreground-subtle`
- `text/tertiary` -> `--color-foreground-subtlest`
- `border/default` -> `--color-border`
- `interactive/bg/primary/default` -> `--color-brand`、`--color-primary`
- `border/strong` -> `--color-input-border-focused`
- `accent/blue/default` -> 蓝色强调类辅助变量

Zai dark 的应用根前景色按当前 shell 参考类使用 `#ffffff`，而不是继续使用导出 token 中接近白色的 `#f8f8f8`。

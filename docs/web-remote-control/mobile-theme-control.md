# 手机远控主题控制

手机远控主题分两段处理：

1. 二维码链接不再追加 `theme` query 参数，避免桌面端主题继续耦合手机端首次进入链路。
2. 手机端 `/remote` 首次打开时，若本机浏览器没有 `localStorage["zcode-theme"]`，会使用默认 `zai-dark` 作为初始主题；后续只使用手机端本地偏好。

这样可以保证之后两端互不影响：手机端切主题只改手机浏览器本地存储，桌面端切主题只改桌面 renderer 的本地存储。

手机端任务列表页和聊天页顶部 header 右侧都渲染 `WebRemoteControlThemeMenu`。菜单只暴露 `system`、`zai-dark`、`zai-light`，其中 `zai-dark` / `zai-light` 分别显示为 Dark Theme / Light Theme。

## 浏览器表面同步

手机远控运行在普通浏览器页面中，主题切换不能只改变 React 子树。Web 入口必须把同一个 resolved theme 同步到以下浏览器级表面：

- `html`、`body` 和 `#root` 使用当前主题的 `--color-background`，不能继承 Electron vibrancy 所需的透明根背景。
- `color-scheme` 声明当前页面采用的亮暗配色，使原生控件和浏览器默认表面使用一致的配色方案。
- `meta[name="theme-color"]` 使用当前主题的页面背景色，供支持该标准的浏览器着色自身界面。

该同步是浏览器能力边界，不按 Safari、Chrome、Firefox 或具体系统版本分支。首次加载由 `index.html` 在业务 bundle 执行前根据手机本地偏好完成；运行时切换和 `system` 模式的系统主题变化继续由共享 `applyTheme()` 使用同一 resolved theme 更新。Desktop Electron 不声明浏览器表面 opt-in，继续保留透明根背景和原生窗口 vibrancy。

```text
localStorage / system preference
              |
              v
       resolved light/dark
              |
      +-------+-------------------+
      |                           |
      v                           v
React theme classes       browser theme surface (Web only)
dark / theme-zai-*        root background + color-scheme + theme-color
```

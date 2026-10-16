# 内置 Browser JavaScript 对话框来源标识 Spec

## 背景

ZCode 桌面端内置 Browser 使用标准 Electron 41 `<webview>`。网页调用 `alert()` / `confirm()` 时，Chromium 原生对话框只展示消息正文，不展示来源站点，用户无法区分“网页内容”和“ZCode 自身提示”。期望形态是对话框带类似 `www.runoob.com says` 的来源标题。

标准 Electron 没有为 `<webview>` 原生对话框添加来源标题的开关，因此为 guest 安装固定的隔离 preload，在网页调用原生 `alert` / `confirm` 之前同步请求 main 展示系统 MessageBox。

## 目标

- 桌面端用户可见的内置 Browser 中，`alert()` 和 `confirm()` 使用系统原生 MessageBox。
- MessageBox 第一行固定展示由 main 进程从 Chromium 可信 URL 解析出的 `<host> says`，第二行展示网页消息。
- `alert()` 保持返回 `undefined`；`confirm()` 保持返回布尔值。
- 按当前应用语言展示按钮：中文为“取消 / 确定”，英文为 `Cancel / OK`。
- 浏览器工具执行期间保留 Chromium 原生 JavaScript Dialog，使现有 CDP `getDialog` / `handleDialog` 能继续观察和处理对话框。
- 不改变 Web 端、手机端和远控链路；这些端不承载 Electron `<webview>`。

## 非目标

- 本期不接管 `prompt()`。Electron 的系统 MessageBox 不提供同步文本输入控件，强行替换会破坏 `prompt()` 的同步返回语义；它继续走 Chromium 原生实现。
- 本期不接管 `beforeunload`、HTTP 认证、权限请求或文件选择器。
- 不在 renderer/UI 层渲染仿系统弹窗；颜色、圆角、主题和可访问性由操作系统原生组件负责。

## 来源与安全边界

- preload 只暴露一个 `alert` / `confirm` 同步请求桥，不暴露通用 IPC、Node API 或文件系统能力。
- 正常导航、`src`、`srcdoc` iframe 通过 `nodeintegrationinsubframes` 各自加载固定 preload。无 `src` 的继承型 `about:blank` iframe 不产生文档级导航，Electron 不会为它单独执行 preload；顶层 preload 使用 `MutationObserver` 发现这类 frame，并仅在浏览器同源策略允许访问时安装同一包装。跨源 frame 无法被父页面读取，继续由自身导航时加载的 preload 处理。
- 来源标题优先由 main 进程读取 Electron `event.senderFrame.url` 生成；Electron 41 对同源 iframe 可能返回空值或 `about:blank`。只有能解析出 HTTP(S) host 的 frame URL 才能直接使用，否则继续回退到 Chromium `WebContents.getURL()` 维护的 guest 主文档 URL。两者都由 Electron/main 提供，禁止信任网页传入的 URL、DOM title 或自行拼接的 origin 文本。
- `http:` / `https:` URL 使用 `URL.host`；frame URL 与 guest URL 都无法解析出 host 时才使用 `This page says`。
- 只有 renderer 已通过 `BrowserViewAttachGuest` 绑定、且 tab id 以 `browser:` 开头的用户 Browser guest 可以进入定制对话框路径。
- 未绑定 guest、browser-use 专用 `iab-tab:`、非 `alert` / `confirm`、自动化窗口或系统对话框创建失败时，main 返回 `handled: false`，preload 必须调回 Chromium 原生 API。

## 状态与时序

用户点击与 Agent/CDP 操作共享同一个 guest，因此必须显式区分“用户交互”和“自动化窗口”：

```text
用户点击网页（automation = idle）
  page alert/confirm wrapper
        |
        v
  preload sendSync(type, message)
        |
        +--> main 校验 browser: guest + senderFrame
                  |
                  v
            从 frame URL / guest URL 计算 host
                  |
                  v
            showMessageBoxSync(parent)
                  |
                  +--> return { handled: true, value }
                  |
                  +--> wrapper 同步返回，不调用原生 API

Agent browser command（automation = active / grace）
  main 标记所属窗口为 native-dialog passthrough
        |
        v
  page alert/confirm wrapper -> preload sendSync
        |
        +--> main return { handled: false }
        |
        +--> wrapper 调用 Chromium 原生 API
                 |
                 v
        BrowserGuestManager pendingDialogs
                 |
                 +--> getDialog / handleDialog
```

自动化命令开始时，窗口进入 passthrough；命令结束后保留 3 秒 grace，覆盖点击后通过微任务或短定时器延迟触发的 Dialog。并发命令使用引用计数，最后一个命令结束后才进入 grace。

旧 CDP 方案的设计缺陷是截获时 Chromium Dialog 已经创建。即使 `Page.handleJavaScriptDialog` 已回报 closed、`confirm` 已返回，macOS 仍可能绘制已排队的 NSAlert。新链路在原生 API 调用之前做决策；用户路径不创建 Chromium Dialog，因此不存在第二个原生框的绘制竞态。

## 平台与兼容性

- macOS、Windows、Linux 共用 Electron `dialog.showMessageBoxSync`，父窗口固定为 guest 所属 ZCode 窗口。
- 图标复用桌面应用图标；系统不支持或图标为空时允许无图标降级。
- 两种主题均使用系统原生主题，不新增 UI token。
- guest 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。`nodeIntegrationInSubFrames: true` 只用于让固定 preload 进入每个 iframe 的隔离世界；网页主世界不获得 Node 或 `ipcRenderer`。
- `<webview>` 创建时显式声明 `nodeintegrationinsubframes`，main 的 `will-attach-webview` 再固定同一偏好和 preload 路径；不能只在 guest attach 后补设，否则已经存在的子 frame 不会回补 preload。
- Electron sender frame 带有有效 HTTP(S) URL 时展示发起 frame 的 host；Electron 返回 `about:blank` 时展示 guest 主文档 host。
- 手机 `/remote`、Web 端以及 desktop/phone task realtime 的 continuous/replayable 语义均不经过此链路。

## 验收

1. 在 `https://www.runoob.com/try/try.php?filename=tryjs_events` 的运行结果 iframe 中触发 `confirm("123 来之内置浏览器")`，看到 `www.runoob.com says`、正文和取消/确定按钮。
2. `alert()` 只提供确定按钮，调用返回 `undefined`。
3. `confirm()` 的取消、确定分别返回 `false`、`true`。
4. 网页无法伪造来源标题；修改 `document.title` 不影响标题。
5. browser 工具触发对话框后，`getDialog()` 仍可读取，`handleDialog()` 仍可接受或拒绝。
6. `prompt()`、Web/手机端、普通 ZCode 原生对话框行为不变。
7. 关闭定制系统框后，同一个 Dialog 不再出现第二个 Chromium 原生框。
8. 无 `src`、由父页面 `document.write` 写入的同源结果 iframe 同样只出现一个带 host 的系统框。

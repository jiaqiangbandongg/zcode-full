# 终端 Profile 继承

ZCode 内置终端的目标不是维护一份固定字体清单，而是尽量继承用户系统终端已经生效的 profile。这样使用 oh-my-zsh、oh-my-posh、Nerd Font、kubectl 代理和自定义 Kube 配置时，内置终端更接近用户直接打开系统终端的效果。

## 当前覆盖范围

- 运行环境：服务启动时从登录 shell 捕获 PATH、代理、KUBECONFIG、locale 和常见工具链变量，再合并到后续 ZCode Agent/终端子进程环境。
- 字体：终端创建时按“用户显式覆盖 > 系统终端配置 > ZCode fallback 字体栈”的顺序解析字体。系统终端配置当前覆盖 Windows Terminal、VS Code、iTerm2、macOS Terminal、Kitty 和 Alacritty。
- 配色：终端背景色、默认正文色和光标色始终由 ZCode 当前 app 主题控制；系统终端 profile 只允许补充 ANSI 调色板、选区等终端细节色。这样 macOS 继承 iTerm2 / Terminal profile 时不会把深色背景带进 ZCode 浅色界面，也不会因为 profile 光标色和当前背景撞色导致光标不可见，同时仍保留用户习惯的命令输出色彩。
- 设置：通用设置页提供“继承系统终端 Profile”开关和“终端字体”覆盖输入框；字体留空时回到自动继承。

## 主要模块

- `packages/services/src/runtime-tools/runtimeCommandEnv.ts`：负责登录 shell 环境继承。
- `packages/services/src/terminal/terminalProfile.ts`：负责终端字体 profile 检测，内部通过 detector 注册表扩展不同终端来源。
- `packages/services/src/terminal/terminalService.ts`：创建 PTY 时返回解析后的字体 profile。
- `packages/ui/src/terminal/TerminalSession.tsx`：把服务端返回的字体和受限 profile theme 应用到 xterm。

## 扩展方式

新增 WezTerm 或其他终端来源时，在 `terminalProfile.ts` 中增加一个 `TerminalFontDetector`，实现 `detect(env)` 并注册到 `TERMINAL_FONT_DETECTORS`。主流程不需要变更。

iTerm2 和 macOS Terminal 属于 best-effort detector：只尝试读取本机 plist，读取失败、格式异常或字段不存在时返回 `null`，继续尝试下一个 detector，不影响终端启动。

macOS profile detector 可能会读取到 `background` / `foreground` / `cursor` / `cursorAccent`，但 UI 合并阶段会丢弃这些字段。原因是这些字段属于 ZCode 窗口主题的基础可读性边界，不应该被某个系统终端 profile 覆盖；否则浅色 app 中可能出现深色终端块，或光标和当前 terminal 背景撞色后不可见，和 Windows 目前只继承字体的行为也不一致。

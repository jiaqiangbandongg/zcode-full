# Chromium Hardware Acceleration Setting

## 背景

ZCode 桌面端运行在 Electron/Chromium 上。部分显卡或驱动环境可能在 GPU 初始化、页面合成或 WebGL 路径上出现白屏、闪退、渲染异常。Electron 只允许在 `app.ready` 之前调用 `app.disableHardwareAcceleration()`，因此产品开关必须保存为启动期配置，并在下次启动生效。

## 产品语义

- 设置项名称：Chrome 硬件加速。
- 默认值：开启。
- 关闭后：下次启动桌面端时调用 `app.disableHardwareAcceleration()`。
- 开启后：不调用 `app.disableHardwareAcceleration()`，恢复 Electron/Chromium 默认硬件加速行为。
- 修改后必须提示用户重启应用生效；本次改动不做运行时即时切换。
- 本次范围不包含 Linux AppImage deep link `.desktop Exec` 参数同步。

## 实现边界

- 配置字段写入全局 `AppSettings`，只表达桌面端启动行为；Web 和手机端读取到该字段也不产生平台动作。
- 启动早期使用同步文件读取 `~/.zcode/v2/setting.json`，避免等到 `createSettingService().get()` 或 `app.whenReady()` 后才读取导致调用时机过晚。
- 读取失败、配置缺失、配置类型非法时都回退为默认开启，不影响应用启动。
- UI 仅在桌面端设置页展示开关，文案说明关闭硬件加速可规避部分显卡/驱动问题，并明确重启后生效。

## 验证

- 单测覆盖设置 schema 默认值和 patch。
- 单测覆盖启动期配置提取与 `app.disableHardwareAcceleration()` 调用边界。
- 单测覆盖设置页桌面端开关渲染与回调。
- 完成后执行 `pnpm typecheck` 和 `pnpm lint`。

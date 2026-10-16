# Android 远程控制壳

`packages/android` 当前是 ZCode 手机远控的 Android 壳。第一版不重写 ZCode Agent、relay 或
RPC 协议，而是用原生入口承载现有 `/remote` 手机 Web 远控页面。

## 入口

- 粘贴或分享 `https://zcode.z.ai/remote?...` 链接。
- 扫描桌面端生成的远控二维码。
- 通过 `zcode://remote?...` deep link 打开。
- 首页会保存最近 5 条成功打开过的远控链接，App 重启后可以直接点开。列表只展示设备名、host
  和时间；实际完整链接保存在 App 私有 `SharedPreferences` 中。

生产包只允许打开 `https://zcode.z.ai/remote`。Debug 包额外允许 localhost 和局域网
`/remote`，方便真机调试本地 Vite 页面。

## 扫码

扫码使用 CameraX 预览和 ML Kit Barcode Scanning。扫描器只识别 QR Code，扫到内容后仍交给
`RemoteControlUrlPolicy` 校验，非法链接不会进入 WebView。

## 后台稳定性

远控页面打开后，App 会启动前台服务并保持屏幕常亮。前台服务的作用是降低 Android 在后台回收进程
或收紧网络的概率；它不改变业务事实源。手机端断线或恢复仍依赖现有 Web 远控的
`web-remote-replayable` 语义、bridge 重建和 task snapshot 对齐。

Android App 不创建独立 Agent runtime、local host 或 SSH/WSL/Docker session。手机端仍只能 attach
到桌面窗口已经存在的 host。

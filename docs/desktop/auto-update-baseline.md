# 自动更新临时 Baseline（历史方案）

## 当前状态

桌面端新包默认通过服务端 manifest 接口检查更新。CI 上传 OSS 时只写版本化静态产物：

```text
<path-prefix>/<version>/macos-arm64/
<path-prefix>/<version>/macos-x64/
<path-prefix>/<version>/windows-x64/
<path-prefix>/<version>/windows-arm64/
<path-prefix>/<version>/linux-x64/
<path-prefix>/<version>/linux-arm64/
```

版本化平台/架构目录内统一上传包含多语言日志的 `latest.yml`、安装包和 `.blockmap`。electron-builder 固定配置 `detectUpdateChannel: false`，包括 prerelease 在内都生成统一的 `latest.yml`，发布通道由服务端 manifest 决定。灰度与全量发布只通过 release API 的 `status=3` / `status=1` 控制，CI 不再覆盖 `/update` 或 `/update-insider` 这类 stable feed，也不再支持 `ZCODE_STABLE_UPDATE_FEED_ROOTS` 发布开关。

## 历史背景

旧版桌面端依赖 electron-updater generic feed。已安装的旧包会固定读取包内 `app-update.yml` 写入的 generic stable feed，例如 macOS arm64 的主 feed 是：

```text
https://${CDN_DOMAIN}/${OSS_PATH_PREFIX}/update/mac/arm64/latest-mac.yml
```

当时为了避免 `2.0.0` 旧包被直接推进到 `3.0.x`，曾使用 `/update-insider/<platform>/<arch>/` 作为临时 baseline feed，并通过发布阶段覆盖一个或多个 feed 来切流。

这个机制已从当前 CI 主链路移除。若仍需兼容旧包，应使用单独的应急发布动作或旧 feed 运维流程，不能依赖当前 release pipeline 自动刷新 feed。

## 当前替代方案

- 新客户端：使用 `GET /api/v1/releases/electron/manifest`，由服务端根据 `platform`、`device_mid` 和 `channel` 返回 stable 或 preview 版本。
- 灰度：CI publish 阶段发送 `status=3`，服务端按 `device_mid` 策略决定是否返回 preview 版本。
- 全量：CI promote 阶段发送 `status=1`，服务端 stable manifest 返回同一批版本化 CDN 文件。
- 旧 generic feed：仅作为诊断、应急或历史兼容入口保留，不由当前 CI 自动上传。

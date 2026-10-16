# Linux Arch pacman package

## 目标

为 Linux x64/arm64 构建额外的 Arch Linux 原生安装包 `.pkg.tar.zst`，复用现有 Electron Builder 应用内容；AppImage 继续作为 Linux 自动更新主产物，deb/rpm 保持不变。

## 边界

- 本阶段不发布 PKGBUILD/AUR 源码配方；`.pkg.tar.zst` 由 Electron Builder 直接生成。
- 不改变应用运行时、协议、Agent、远程控制或自动更新协议。
- pacman 包作为下载/安装分发产物，不作为 `latest.yml` 的 primary update artifact。

## 构建与发布链路

```text
Linux x64/arm64 CI
        |
        v
electron-builder
  |       |       |       |
AppImage deb     rpm     pacman (.pkg.tar.zst)
  |       |       |       |
  +-------+-------+-------+--> artifact collect -> upload -> release validation
        |
        +--> latest.yml primary path remains AppImage
```

## 包契约

- 文件名沿用现有命名：`ZCode-<version>-linux-<arch>.pkg.tar.zst`。
- package name 与 deb/rpm 使用相同的 flavor 隔离名称，避免 Preview/Production 互相覆盖。
- pacman 依赖由配置中的 Arch 官方仓库运行时依赖列表生成（gtk3、nss、libxss、libxtst、libnotify、alsa-lib、mesa、xdg-utils）；计划在 Arch x64/arm64 上执行安装、启动、卸载 smoke test。
- `.pkg.tar.zst` 进入 CI artifact manifest、OSS 上传和 release metadata，但不替代 AppImage 更新路径。

## 客户端自动更新契约（2026-09-16 修订）

ZCT-2100231841920471040：3.12.1 在 Ubuntu deb 安装形态下载 3.12.2 时，旧过滤器删除 deb，只留下 AppImage；DebUpdater 找不到文件，读取 `fileInfo.info` 抛错。旧约定“Linux 仅 AppImage 支持自动更新”错误，现予以替换。

- macOS、Windows、Linux 各安装形态均沿用 electron-updater 的下载、校验和安装流程；Linux 不再统一删除 deb/rpm/pacman。
- 当前 updater 实例是安装类型的唯一真源；ManifestUpdateProvider 只为 Linux 更新器选择同类型产物，不另读 package-type、不维护第二份平台状态。AppImageUpdater 对应 `.AppImage`，DebUpdater 对应 `.deb`，RpmUpdater 对应 `.rpm`，PacmanUpdater 对应 `.pkg.tar.zst`（兼容 `.pacman`）。
- 清单缺少当前安装类型时，在解析边界明确失败，禁止 updater 的 fallback 误选其他格式。缺少包是发布不完整，不等于该安装方式不支持更新。
- URL 按 pathname 判定后缀，支持绝对/相对地址、查询参数及大小写；保留真实下载 URL 与校验值。
- PacmanUpdater 仍按旧 `.pacman` 后缀生成缓存路径，`.pkg.tar.zst` 的 `info.url` 使用实际文件名，避免把完整 URL 拼入缓存路径；网络下载 URL 不变。
- macOS/Windows 保持原清单解析语义，下载器负责选 zip/exe；不改变更新通道、下载时序、权限、安装命令、UI 或手机远控链路。

```text
服务端完整清单 → 当前 updater 实例决定安装类型 → 同类型文件 → 下载/校验 → 原平台安装器
                                             └─ 缺少同类型包：明确失败，不跨格式回退
```

验收：测试须在任意开发机运行 Linux 安装类型矩阵，覆盖混合清单、单类型清单、缺失类型、绝对/相对 URL、query、校验值与 Pacman 缓存路径；macOS/Windows 原解析行为回归。现场日志与失败测试先于修复，禁止只断言过滤器本身。真实提权安装仍需对应系统的发行包 smoke 验证。

## 风险与验收

- 产物收集、共享目录清理、OSS glob、发布校验必须识别复合后缀 `.pkg.tar.zst`。
- 不得把源码、source map、密钥或 CI 凭据加入包；沿用现有 app.asar 裁剪策略。
- 需要验证 pacman 包的架构、依赖、桌面 entry、`zcode://` 协议注册，以及与 deb/rpm 共存时的 package identity。

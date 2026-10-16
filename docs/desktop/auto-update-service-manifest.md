# 桌面端服务端 Manifest 自动更新

## 背景

旧版桌面端直接让 `electron-updater` 读取 CDN 上的 `latest*.yml`。这种方式适合静态全量发布，但不适合按设备灰度、区分 stable / preview 或在服务端把 preview 提升为 stable。新版客户端改为先请求 ZCode 服务端 manifest 接口，再把服务端返回的 `latest.yml` 同格式内容交给 `electron-updater` 执行下载、校验和安装。

CDN 仍保存安装包、blockmap 和更新清单文件，但这些文件只进入版本化目录，不再由 CI 覆盖全局 stable feed。服务端 manifest 根据 release API 中的 stable / preview 状态选择版本，并下发指向版本化平台目录的绝对 CDN URL。

## Manifest 接口

客户端检查更新时请求：

```text
GET /api/v1/releases/electron/manifest
```

客户端同时通过 query 和 header 传递更新选择参数：

| query        | header              | 取值                                                                             |
| ------------ | ------------------- | -------------------------------------------------------------------------------- |
| `platform`   | `X-Platform`        | `darwin-aarch64` 等发布服务平台名；服务端也兼容 `win32-x64` 这类 Node 风格平台名 |
| `channel`    | `X-Release-Channel` | 标准通道 `1`；抢先体验/preview 通道 `3`                                          |
| `device_mid` | `X-Device-Mid`      | 桌面端 telemetry 复用的 uuidv4 风格设备 ID                                       |

响应体保持 electron-builder 生成的 `latest*.yml` 格式，例如：

```yaml
version: 3.4.0
files:
  - url: https://cdn.example.com/zcode/electron/releases/3.4.0/macos-arm64/ZCode-3.4.0-mac-arm64.zip
    sha512: ...
    size: 123456
path: https://cdn.example.com/zcode/electron/releases/3.4.0/macos-arm64/ZCode-3.4.0-mac-arm64.zip
sha512: ...
releaseDate: "2026-07-09T00:00:00.000Z"
```

下载文件 URL 推荐服务端下发绝对 CDN URL。若服务端下发相对路径，客户端使用 endpoint origin 作为兜底 base URL；因此生产响应不要依赖旧 CDN feed 目录作为隐式 base。

Electron 发布产物在 OSS 上的版本化目录固定按平台和架构分层：

```text
<path-prefix>/<version>/macos-arm64/
<path-prefix>/<version>/macos-x64/
<path-prefix>/<version>/windows-x64/
<path-prefix>/<version>/windows-arm64/
<path-prefix>/<version>/linux-x64/
<path-prefix>/<version>/linux-arm64/
```

版本化平台目录内统一使用包含 `releaseNotesByLocale` 的 `latest.yml`，安装包和 `.blockmap` 都随对应平台/架构一起上传。remote `manifest-*.json` 仍保留在 `<path-prefix>/<version>/` 根目录，`components/...` 仍保留在跨版本目录，避免 remote runtime 资产 URL 发生不必要变化。当前 CI 不再生成 locale 或旧客户端 generic feed 的更新清单副本。

## 发布通道

- stable：面向正式用户。CI 全量阶段把 release API 状态置为 `status=1` 后，服务端 manifest 对 stable 返回该版本。
- preview：面向主动开启预览更新的用户。CI 灰度阶段把 release API 状态置为 `status=3` 后，服务端按 `device_mid` 灰度策略决定 preview manifest 是否返回该版本。
- preview 可被服务端标记/提升为 stable。提升后无需重新上传安装包，stable manifest 返回同一批 CDN 产物即可。

客户端只负责传递 channel 和 device_mid，不在本地实现灰度比例或通道提升判断。

## CI 两阶段

发布流水线拆成两个明确阶段：

1. 灰度阶段：沿用现有安装包上传、CDN 预热和 release metadata 产物，调用 release API 时发送 `status=3`。此阶段不覆盖 stable CDN feed 的 `latest*.yml`。
2. 全量阶段：人工或规则触发后，复用同一批 release metadata，调用 release API 时发送 `status=1`。全量阶段不再上传 stable CDN feed，服务端 manifest 直接返回同一批版本化平台目录中的文件。

安装包、blockmap、`latest*.yml` 上传和 CDN 预热都只针对版本化平台目录执行。stable / preview 的可见性由 release API 状态和服务端 manifest 控制，CI 不再通过覆盖 CDN feed 表达发布状态。

## 客户端状态机

新版交互把“发现更新”和“下载更新”拆开：

```text
idle -> checking -> update-available -> download-progress -> update-downloaded
```

- `update-available`：只展示更新入口，不自动下载。菜单和标题栏按钮都显示有新版本。左上角标题栏入口文字使用 `font-medium text-ui-xs` 的 badge 层级，按钮使用最小高度而非固定高度，展开态宽度由本地化短文案自然撑开；调整 UI 字号后不得裁切文字，默认字号下仍保持紧凑胶囊，下载态图标入口继续保持可见。
- 用户点击更新入口后打开独立更新窗口。独立窗口只承载更新 UI，不启动 Local/Remote Host 或 workspaceKey Agent runtime；窗口内继续复用原更新弹窗内容和状态控制器，保证下载前、下载中、下载后所有按钮、文案、进度和 release notes 缓存逻辑与原 Dialog 严格一致。主界面入口只负责显示当前更新状态和打开独立窗口；若运行环境没有桌面窗口 IPC，才回退到内嵌 Dialog。
- 更新窗口内容采用标题区、下载进度、操作区三段结构，并使用偏窄的紧凑宽度和 `16px` 横向内边距；标题区使用 `logo | 标题 + 发布时间` 的横向 flex 布局，左侧复用与 macOS Dock 完全同源的 `public/icon_512@2x.png` 产品图标，固定为 `56px`（`size-14`），右侧标题和发布时间作为纵向信息组并相对 logo 垂直居中；产品图标保留原图的圆角、透明留白和比例，不再额外裁切、缩放、添加边框或阴影，同时作为不参与读屏的装饰图像；窗口不展示 stable / preview 通道 badge，避免用户在更新弹窗里感知当前更新通道，发布时间放在标题行下方并只显示格式化日期；更新日志 Markdown 数据仍可用于入口 hover 等其他展示，但窗口内不再展开显示 release notes 正文、标题、折叠控制或背景卡片。窗口视觉只使用中性 surface / border / foreground token，不额外引入成功色、品牌色或 accent 背景，窗口内按钮使用纯文字，关闭入口保留底部“稍后”；主界面左上角更新入口保持原来的 success 色块，和窗口的中性视觉分开处理。
- 更新窗口按显式阶段渲染，不通过多个布尔值组合推导：
  - 下载前（`update-available`）：展示发布时间，不展示更新通道 badge；底部展示“跳过此版本”“稍后”“下载更新”。
  - 下载中（`download-progress`）：隐藏“跳过此版本”“稍后”，只展示下载进度和“取消下载”；进度区域在弹窗主内边距内再增加 `8px` 左侧外边距；进度条右侧优先展示已下载/总大小，格式为 `1.0MB / 10.0MB`，保留 1 位小数，字节数据缺失时不显示右侧文本，避免残留 `0%` 这类百分比口径；主界面更新入口显示 loading spinner，不显示文字。`download-progress.version` 是协议可选字段，renderer 必须按 `kind` 识别下载态，即使某一帧缺少版本号也要保持更新入口和已打开弹窗，不得卸载组件或关闭弹窗。用户点击“下载更新”后，renderer 必须先本地进入“下载已请求”的 downloading 展示；`downloadUpdate()` 的 IPC 返回只代表命令已被 main 侧接收，不代表已经进入下载态。若随后短暂收到 `checking` / `idle` 等无版本过渡状态，renderer 必须复用上一帧可见更新模型保持弹窗，直到 `download-progress` / `update-downloaded` 收口。若 main 侧下载启动失败，失败收敛必须回到 `update-available` 让用户可见并可重试，不得直接广播 `idle` 让主入口和弹窗一起消失。
  - 下载后（`update-downloaded` / legacy `UpdateReady` ready）：展示发布时间，不展示更新通道 badge；底部展示“稍后”“重启以更新”，不展示“跳过此版本”。
- Renderer 侧更新入口和独立窗口必须先通过纯状态模型把 `UpdateStatePayload` 转成 view model，再渲染 UI。状态模型负责统一产出 `phase`、`displayVersion`、`progressValue`、`progressLabel`、`skippableVersion`、`updateChannel` 和 action 完成判定；组件只处理用户操作、设置写入和渲染。用户习惯边界必须集中在状态模型里：下载态按 `kind` 而不是 `version` 判断，下载中不自动关闭窗口；普通 idle/checking/error 状态才允许卸载更新入口；下载操作进入下一状态后释放按钮锁，取消/跳过离开下载态后释放锁。
- Renderer 启动期同时存在一次性 `getUpdateState()` 快照和持续 `onUpdateStateChanged` 事件。快照结果可能晚于事件返回，必须用 revision 防止旧快照覆盖新事件；尤其不能让旧 `idle` 覆盖已经收到的 `update-available` / `download-progress`，否则主页更新按钮会消失。
- 下载前用户可点击“跳过此版本”。跳过版本按 channel 持久化；同一 channel 的更高版本仍会再次提示。下载开始后弹窗隐藏“跳过此版本”，用户若不想继续下载应使用“取消下载”；取消下载不等同于跳过版本。
- 用户点击“下载更新”后才调用 `downloadUpdate()`，进入 `download-progress` 并显示进度条；主界面左上角更新入口恢复 loading 样式，持续提示下载正在进行，且下载态 spinner 在窄按钮和展开文字状态下都必须可见。
- 下载中用户可点击“取消下载”。客户端通过 `electron-updater` 的 cancellation token 中断当前传输，清理下载中状态并退回 `update-available`，保留相同 version / channel / release notes，用户可稍后重试或关闭弹窗；取消下载不等同于跳过版本。
- 下载完成后进入 `update-downloaded`。如果没有检查在飞，立即再查一次 manifest；已有检查在飞则交给 2 分钟短轮询。下载失败后退回 `update-available` 并再查一次；失败发生在当前检查收口前时，等收口后再查。强制更新失败只反馈错误，不复查。用户点击“重启以更新”时，仅当 ready 包版本仍等于当前目标才调用 `quitAndInstall()`；目标已经更高则不安装旧包。
- 启动检查之后，无可见更新时每 15 分钟复查；`update-available` 或 `update-downloaded` 仍在展示时每 2 分钟复查。复查到更高版本就替换当前目标，已展示的入口不切成 `checking`。菜单“检查更新”在发现态同样重新请求，不回放旧目标。
- 若用户下载完成但尚未安装就重启应用，main 进程会在启动 hydrate 时用持久化的 pending release notes 恢复 `update-downloaded`；仅当 pending 版本高于当前 `app.getVersion()` 时恢复，避免已缓存包再次提示“下载更新”。pending 版本真正等于当前应用版本后，才作为安装后的 release notes 同步给 renderer。
- 强制更新 gate 仍然可以复用同一更新器，但在 `update-available` 时会立即启动下载，保持阻断升级语义。

旧的 `UpdateReady` 事件保留，用于兼容已下载状态同步；新的 UI 主要订阅持续的 `UpdateStateChanged` 状态。

## 设置项

`AppSettings` 新增：

```ts
receivePreviewUpdates?: boolean;
skippedElectronUpdateVersions?: Partial<Record<"stable" | "preview", string>>;
```

- `receivePreviewUpdates` 默认 `false`，仅影响桌面端自动更新检查；Web 和手机远控不读取该设置。
- 设置页切换 `receivePreviewUpdates` 后，renderer 通过 `syncAppSettings` 即时通知 main 进程。main 若当前处于 `update-available` / `idle` / `checking` 的可切换状态，会清理旧通道的可用版本并重新请求服务端 manifest；例如 preview `3.3.3` 已提示时关闭开关，应重新拉取 `channel=stable` 并展示 stable `3.3.2`。下载中或已下载待安装时不打断当前安装流程。
- `skippedElectronUpdateVersions` 由 main 进程维护，renderer 只通过 IPC 请求跳过当前版本，避免 UI 直接拼写 channel 语义。

## 兼容与迁移

- 旧安装包若仍按包内 `app-update.yml` 从 CDN stable feed 检查更新，不再由当前 CI 全量阶段自动刷新对应 feed。需要兼容旧包时，应由服务端 manifest 迁移策略、单独的应急发布动作或旧 feed 运维流程承接，避免把新 release 状态再次绑定到 CI 的静态 feed 覆盖。
- 新安装包默认使用服务端 manifest provider；`ZCODE_UPDATE_FEED_URL` 保留为诊断/应急覆盖入口，值必须是完整 manifest 接口 URL。显式配置时仍走服务端 manifest provider，并由客户端覆盖 `platform` / `device_mid` / `channel` 查询参数和对应 header，不再切换到旧 generic feed。
- post-update release notes、已下载待安装状态和 Windows 安装前资源释放逻辑继续沿用现有实现。
- Windows 从 `quitAndInstall()` 到 NSIS 的进程退出、快捷方式和完成页启动边界见
  `docs/desktop/windows-update-install-handoff.md`。

## 本地调试启动

本地测试服务端 manifest 自动更新时，先确认发布服务的 manifest 接口可访问，例如：

```bash
curl "http://intranet.example.invalid:3011/api/v1/releases/electron/manifest?platform=darwin-aarch64&channel=stable&device_mid=00000000-0000-4000-8000-000000000000"
```

然后在仓库根目录启动桌面端。`ZCODE_UPDATE_FEED_URL` 必须传完整 manifest 接口 URL，客户端会在请求时覆盖 `platform`、`channel`、`device_mid` query 和对应 header；`ZCODE_AUTO_UPDATE_DEV=1` 用于在 dev Electron 内打开更新链路，`ZCODE_AUTO_UPDATE_DEV_VERSION` 用于把本地应用版本压低到服务端版本以下，方便触发“发现更新”：

```bash
ZCODE_UPDATE_FEED_URL="http://intranet.example.invalid:3011/api/v1/releases/electron/manifest" \
ZCODE_AUTO_UPDATE_DEV=1 \
ZCODE_AUTO_UPDATE_DEV_VERSION=3.3.3 \
pnpm dev:desktop:prod
```

如果要测试 preview 通道，在设置页打开“抢先体验/preview 更新”后重新检查更新即可；不要把 channel 固定写进 `ZCODE_UPDATE_FEED_URL`，否则容易和 renderer 设置态不一致。

## 验证要求

- 单元测试覆盖 manifest provider 请求参数、stable/preview channel 选择、跳过版本、发现不下载、点击后下载、强制更新仍自动下载。
- CI 配置测试覆盖灰度 `status=3` 与全量 `status=1` 两个 job，上传脚本测试覆盖版本化平台/架构目录以及 stable feed 不再上传。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`。
- 若无法在当前环境完成真实安装器升级验证，提交说明中列出待补的打包包体升级验证项。

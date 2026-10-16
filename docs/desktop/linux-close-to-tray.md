# Linux 关闭窗口驻留托盘(close-to-tray)Spec

## 背景与目标

Windows 已支持"关闭窗口时隐藏到托盘驻留"(`closeToTrayOnWindows` 设置,默认开)。Linux 现状是关窗即走"确认退出 → `app.quit()`",与 ZCode 长任务后台型应用的产品意图(防误关打断 agent 会话)不符。

macOS 的"关窗不退"依赖系统级应用生命周期模型(Dock 常驻 + 运行指示),Linux 桌面没有该模型;Linux 上唯一带可见入口的驻留机制是系统托盘(StatusNotifierItem)。因此 Linux 对齐 **Windows 托盘模式**,而不是 mac 模式。

Linux 桌面环境的托盘支持不统一:

- KDE / XFCE 等原生提供 StatusNotifierItem host
- GNOME 自 3.26 起默认移除系统托盘,需用户安装 AppIndicator 类扩展
- Electron `new Tray()` 在无 host 的 GNOME 上**创建成功但不渲染、不报错**——静默失败

因此核心设计原则:**驻留能力不取决于托盘是否创建成功,而取决于托盘是否真的可被渲染;检测不到就降级到现有"确认退出"路径,用户永远不失联**。

## 行为矩阵

| 平台 / 环境 | 设置开关 | 默认值 | 关窗行为 | 托盘 |
| --- | --- | --- | --- | --- |
| Windows | 可操作(现状不变) | 开 | 隐藏驻留(现状不变) | 常驻 |
| Linux + 托盘可用 | 可操作 | **关** | 用户开启后:隐藏驻留 | 能力检测通过后创建 |
| Linux + 托盘不可用 | **置灰锁定为关** | — | 现有"确认退出"路径,与今天一致 | 不创建 |
| macOS | 不显示该设置 | — | 系统默认(关窗不退,Dock 保活) | 无(现状不变) |

隐藏驻留的找回入口:托盘图标(点击/双击唤回,菜单含退出)+ 既有 `second-instance` 唤回(点 pin 图标/桌面图标,已实现,无需改动)。

## 托盘能力检测

### 检测信号

session DBus 上 `org.kde.StatusNotifierWatcher` name 是否有 owner:

- 有 owner → 有 SNI host(KDE/XFCE 原生满足;GNOME 装了 AppIndicator 扩展后满足)→ 托盘可用
- 无 owner / 查询失败 / 超时 → 按"不可用"处理(安全默认)

**不维护桌面环境硬编码名单**(不用"是 GNOME 就不支持"的判断),一条信号天然覆盖所有桌面环境,未来新桌面无需改代码。

`XDG_CURRENT_DESKTOP` 含 `gnome`(不区分大小写)→ 标记 `gnomeLike`,仅用于置灰文案是否追加"安装 AppIndicator 扩展"提示。

### 检测实现

零新增依赖:依次尝试系统工具向 session bus 查询 `org.freedesktop.DBus.NameHasOwner`:

1. `gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher`(GNOME 系标配,输出 `(true,)` / `(false,)`)
2. `busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s "org.kde.StatusNotifierWatcher"`(systemd 系标配,输出 `b true` / `b false`——布尔不带引号;解析器同时接受带引号变体)
3. `qdbus org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher`(QT 系,输出 `true` / `false`)

任一工具给出明确结果即返回;工具不存在/执行失败/超时(约 1.5s)→ 按不可用处理。三个工具覆盖主流发行版;均缺失的极端环境落到安全默认,行为等同 GNOME 默认(不驻留),不会失联。

### 缓存与刷新(monitor)

关窗路径 `handleDesktopWindowCloseRequest` 是同步回调,不能 await 探测;因此 main 进程维护**同步缓存**:

```
createCloseToTrayCapabilityMonitor
  ├─ getSync(): Linux 返回缓存值;启动后未完成首次探测时返回 null(视为不可用,走安全路径)
  └─ refresh(): 异步探测并更新缓存
```

刷新时机(不做周期轮询,避免常驻子进程):

- app ready 后首次探测
- 设置页通过 IPC 查询时(缓存 stale 超过 10s 则重新探测)——用户装完扩展打开设置页即可看到开关解除置灰

启动时序说明:自启动场景下 Linux 的 StatusNotifierWatcher 可能晚于 ZCode 启动,首次探测为 false、随后用户开设置页会重新探测并纠正;期间关窗走安全路径(确认退出),可接受。

### 托盘创建时机与"可隐藏能力"合并(CR-01)

- Windows:app ready 后创建,`trayReady` 由创建结果置位
- Linux:**能力探测通过后创建**(探测失败不创建,避免注册无人渲染的 DBus name);托盘创建跟随能力,不跟随设置开关(与 Windows 语义一致:设置只控制关窗是否驻留,不控制托盘常驻);设置页 IPC 查询时若能力变为可用而托盘未建会补建
- Linux 托盘图标用 PNG(dev: `build/icon.png`;打包态: `resources/icon.png`,extraResources 已无条件打包,无需改打包配置);Windows 继续用 `tray_icon.ico`

**可隐藏能力的最终裁决(`resolveCloseToTraySupported`)**:DBus watcher 存在只证明桌面可能有 host,不能证明 Electron `Tray` 实例创建成功(图标缺失、会话未就绪等会让 `new Tray()` 抛错)。隐藏窗口前必须验证最终用户入口真实存在:

```
win32:  trayReady
linux:  trayReady ∧ DBus 能力探测通过
其它:   不可隐藏
```

关窗分支与设置页能力查询(IPC)都读该合并结果,任一不满足按不可用走确认退出/置灰,杜绝"DBus 可用但 Tray 创建失败时隐藏即失联"。

## 关窗路径

`handleDesktopWindowCloseRequest` 的隐藏分支条件泛化:

```
关窗请求
  ├─ (win32 或 (linux 且 closeToTraySupported)) + 设置开 + 非强制退出/显式退出
  │     → win.hide() 驻留(现有 Windows 分支行为)
  ├─ darwin / 非最后窗口 → 系统默认
  └─ 其余(Linux 无托盘、或设置关)
        → 现有"最后窗口确认退出"路径(生产环境 + 运行中会话时弹确认框)
```

`closeToTraySupported` 取 monitor 同步缓存(空按 false,安全默认)。设置开但关窗瞬间能力不可用 → 不驻留,走确认退出,不会出现"隐藏了但无处找回"。

`window-all-closed` 无需改动:`win.hide()` 只隐藏不销毁窗口,不会触发。

## 设置项

### 存储 key 兼容

保留 `closeToTrayOnWindows` 存储 key 与 schema(避免存量设置迁移成本),仅扩展语义到 Linux。函数参数等内部命名改为语义中性的 `closeToTray`。

### Linux 默认值迁移

问题:存量 Linux 用户已被 `migrateCloseToTrayOnWindowsDefault`(shared 无平台概念)把 `closeToTrayOnWindows` 归位为 `true`,且 Linux 此前**没有设置入口**(UI 仅 Windows 显示),存量 true 不可能是 Linux 用户显式选择。

方案:新增标记字段 `closeToTrayLinuxMigrationInitialized`(schema default false),main 进程 bootstrap 加载设置时:

```
Linux && !closeToTrayLinuxMigrationInitialized
  → closeToTrayOnWindows 强制 false(归位默认关)+ 写入 initialized=true
Linux && 已初始化 → closeToTrayOnWindows ?? false(尊重用户显式选择)
非 Linux        → 现状不变(closeToTrayOnWindows ?? true,标记字段不读)
```

新装 Linux 用户首次启动即完成归位,默认关。

**持久化时序(CR-02)**:迁移写入必须 `await` 完成后再继续启动(创建窗口/renderer 读取设置之前),保证设置页读到的一直是迁移后的值;本地 JSON 写入耗时可忽略。**写入失败**(磁盘满/只读等):内存值回退为持久化文件的当前值(`resolveCloseToTrayRuntimeValue`),维持"文件是唯一可信来源"——main 行为与设置页显示保持一致(都是文件值),避免双数据源;迁移在下次启动重试,失败期间 Linux 用户保持迁移未完成的旧行为。

### 通道(状态层级)

```
main 进程(唯一数据源)
  closeToTrayCapabilityMonitor ──缓存──→ 关窗分支(getSync)
  mainSettingService(设置持久化)──closeToTrayOnWindows──→ 关窗分支
        │ ipcMain.handle(GetCloseToTrayCapability)
        ▼
preload bridge(window.zcode.getCloseToTrayCapability)
        ▼
renderer desktopPlatform(IPlatformService 适配)
        ▼
SettingsPage(置灰判断;Web/远控无桥不实现,设置项本就仅桌面显示)
```

返回 DTO:`{ supported: boolean; gnomeLikeWithoutTray: boolean }`(后者 = gnomeLike && !supported,决定文案)。

### 设置页 UI

- 显示条件从 `isWindowsDesktop` 扩为 `isWindowsDesktop || isLinuxDesktop`
- Linux 且 `capability` 查询中/不可用 → Switch 置灰(`disabled`)
- 置灰描述文案:"当前桌面环境未提供系统托盘,无法启用关闭驻留";`gnomeLikeWithoutTray` 时追加:"GNOME 用户可安装 AppIndicator 类扩展后重启应用启用"
- Windows 不查询 capability,开关直接可用(现状不变)

## i18n

- 复用现有 `settings.closeToTrayOnWindows`(文案"关闭窗口时隐藏到托盘"本身平台中立)
- 新增 `settings.closeToTrayUnavailable`、`settings.closeToTrayGnomeHint`(中英)

## 限制与后续(非本期)

- **托盘图标素材**:Linux 托盘 22~24px 下直接用彩色应用 PNG 可辨识度一般;后续出单色 symbolic 风格图标(深浅主题各一版)
- **能力动态监听**:可订阅 DBus `NameOwnerChanged` 实时感知 watcher 上线/下线并动态建/销毁托盘;本期以"设置页查询刷新"覆盖主场景
- **真机验证项**(CI 容器无桌面会话,无法覆盖):KDE/XFCE 托盘交互、GNOME 装扩展前后、AppImage/deb/rpm/pacman 四包格式;列 MR 待验证
- GNOME 上左键单击行为受 AppIndicator 扩展实现影响(可能弹菜单而非触发 `click`),`double-click` 与菜单入口兜底

## 测试要求

- 能力探测:mock 子进程 executor,覆盖 gdbus/busctl/qdbus 输出解析、工具缺失、超时、非 Linux 直通
- 关窗分支:linux + supported/unsupported × 设置开/关 的矩阵单测(现有 `desktopWindowLifecycle.test.ts` 增补)
- Linux 默认值归位:纯函数抽取后单测(未初始化强制 false;已初始化尊重显式值;非 Linux 不动)
- monitor:缓存刷新、stale 语义

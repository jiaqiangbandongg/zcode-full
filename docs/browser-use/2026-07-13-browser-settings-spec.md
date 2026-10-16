# Browser 设置页规格

## 功能摘要

设置页在“索引库”之后新增“浏览器”分区，集中承载 Browser Use 的可用性和本机浏览器数据管理：

1. “内置浏览器控制”直接读写官方插件 `browser-use@zcode-plugins-official` 的启用状态，不新增第二份开关。
2. “导入 Chrome 登录状态”与“开启内置浏览器控制”同属“浏览器控制”分组的同一张卡片，作为开启控制后的第一步配套动作；“浏览器数据”分组只保留清除类的破坏性操作。文案以用户收益为主语（AI 直接打开已登录网站），不以内部数据结构（Cookie / LocalStorage / Profile）作为面向用户的说明主体。
3. macOS/Linux 的“导入 Chrome 登录状态”先确认本机存在可执行的 Chrome/Chromium，再发现 Profile；未安装时立即返回 `chrome_executable_not_found` 并显示“Chrome 未找到”，不得访问 Profile 或修改内置浏览器数据。可执行文件发现依次覆盖显式环境变量、运行中进程、系统注册位置（macOS Spotlight 应用注册、Linux XDG desktop entry/PATH）和标准目录，从而兼容非默认安装目录；不做全盘扫描。确认安装后，按 `Local State.profile.last_used` → `Default` → 唯一可用 Profile 的顺序选择源，一次点击完成 Cookie 与 LocalStorage 的一次性导入，不提供 Profile 选择器和持续同步，也不读取密码库。Windows 桌面端暂时不渲染导入行，但继续保留清缓存和清全部数据；既有 App-Bound `v20` 原生导入实现、手动构建脚本及测试保留，待入口恢复后仍遵循显式 UAC、一次性 `LocalSystem` 服务和 fail-closed 边界。默认 Windows 开发、CI 和发布构建不得编译、签名或打包该 helper；只有显式设置 `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT=1` 时才恢复 helper 资产链路，该构建开关本身不恢复 UI 入口。macOS 请求 Chrome Safe Storage 钥匙串访问时，用户明确拒绝或取消授权必须终止整次导入，不写入 Cookie，也不再启动 LocalStorage 导入，并显示未授权提示。Linux `v11` Cookie 由同品牌 Chrome/Chromium helper 通过当前桌面会话的 Libsecret/KWallet 解密；ZCode 不直接读取密钥环。导入不主动刷新已打开的页面，用户手动刷新或新开 tab 后读取新数据；Chrome 中可恢复的 session Cookie 在内置持久化分区中保持可恢复，避免 ZCode 重启后立即丢失登录态。
4. “清除浏览器缓存”清理内置浏览器分区的 HTTP cache、Cache Storage、Service Worker 和 shader cache，保留 Cookie、LocalStorage 与 IndexedDB。
5. “清除全部浏览器数据”作为次级危险操作，二次确认后清理内置浏览器分区的全部站点数据。
6. Browser 数据操作按钮与设置页同层级的 Terminal font 操作控件统一使用 `lg` 尺寸：高度 `32px`、`rounded-lg`；不同操作仍通过 outline/destructive 语义区分，不以尺寸制造层级差异。

内置浏览器分区继续使用 `persist:zcode-embedded-browser`。数据管理属于桌面宿主能力；Web/手机设置页保留相同信息结构，但操作项禁用并提示需在桌面端完成，不在 relay、desktop main 之外创建新的 Browser Use runtime 或业务状态。

## 澄清记录

| 问题                     | 用户确认                          | 固定边界                                                                                      |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------- |
| 导入行归属分组           | 与内置浏览器控制同组              | “导入 Chrome 登录状态”排在“开启内置浏览器控制”之后、同属一张卡片；“浏览器数据”分组只留清除类操作 |
| 导入行文案取向           | 讲用户收益，不讲数据结构          | 标题“导入 Chrome 登录状态”；描述只说明 AI 可直接打开已登录网站，不把 Cookie/LocalStorage/Profile 作为面向用户的说明主体 |
| 开关是否新增独立配置     | 开关行为同步 Browser Use 插件行为 | 直接复用官方 browser-use plugin enabled 状态；不写 `AppSettings` 或 localStorage              |
| 关闭如何生效             | 与当前插件逻辑一致                | 沿用插件能力刷新和草稿 session 失效逻辑；运行中 session 不强制改写 runtime                    |
| 是否选择 Chrome Profile  | 不展示选择器，自动选择            | `last_used` → `Default` → 唯一可用 Profile；多 Profile 且无法确定时返回明确错误               |
| Chrome 渠道与自定义目录  | 按建议兼容                        | 发现 Stable/Beta/Dev/Canary/Chromium 标准目录，并读取可安全发现的运行参数、环境或企业配置目录 |
| 非默认目录如何发现       | 不依赖默认安装目录                | 环境变量和运行进程优先；macOS 查 Spotlight 注册应用；Linux 查 PATH 与 XDG desktop entry；最后回退标准/Snap/Flatpak 目录；不遍历整块磁盘 |
| Chrome 未安装            | 显示 Chrome 未找到                | macOS/Linux 在 Profile 发现和目标写入前检查可执行文件；缺失时返回 `chrome_executable_not_found` |
| Windows 导入入口         | 暂时隐藏                          | Windows desktop 不渲染“导入 Chrome 登录状态”行，清缓存/清全部数据保持可用；原生实现不删除    |
| Windows 默认构建         | 不携带导入 helper                 | 默认 dev/CI/package 不编译、不签名、不复制 helper；仅 `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT=1` 显式恢复资产链路，且不自动恢复 UI |
| Windows App-Bound Cookie | 保留既有安全边界                  | 入口恢复后，`v20` 仅在用户确认后交给 ZCode 原生 broker + 一次性 `LocalSystem` 服务；取消或校验失败时不写 Cookie |
| Windows 提权授权         | 入口恢复后每次显式确认并触发 UAC  | 不安装常驻服务；未勾选确认时不发起 UAC；UAC 取消后 LocalStorage 可继续作为部分成功             |
| Windows helper 供应链    | 开发构建可验证，发布构建必须签名  | x64/arm64 helper 独立打包；发布态签名、文件摘要、应用版本、commit、架构、安装路径任一不匹配即 fail closed |
| Windows 原生失败诊断     | 细分原因只写本地日志              | main 仅从固定白名单提取 helper 的稳定失败原因；UI、IPC 和公共错误码继续返回通用 App-Bound 解密失败 |
| macOS 钥匙串授权         | 拒绝后不再导入                    | 用户拒绝或取消 Chrome Safe Storage 访问时，整次导入终止；目标 Cookie 与 LocalStorage 均不变   |
| Linux 系统密钥环         | 复用同品牌浏览器                  | `v11` 交给 Chrome/Chromium helper 访问 Libsecret/KWallet；不在 ZCode 内实现密钥环协议         |
| 是否持续同步             | 不持续同步                        | 导入完成后 Chrome 与内置浏览器数据各自演进                                                    |
| 导入的数据范围           | Cookie + LocalStorage             | 读取站点 Cookie 与 LocalStorage；不发现、不读取、不解密 Chrome 密码库；界面不展示密码相关状态 |
| 普通清理范围             | 按建议实现                        | 保留 Cookie 和本地站点数据；全量清理由独立危险入口二次确认                                    |

## 领域范围与高风险交叉

主要领域：

- Plugin / skill / MCP：开关状态唯一来源是官方插件。
- Desktop lifecycle / native capability：Chrome Profile 发现、系统凭据访问和 Electron session 清理只在桌面 main 执行。
- Persistence / auth：Chrome Cookie、LocalStorage 和 `persist:zcode-embedded-browser` 是不同持久化源；不得记录 Cookie/LocalStorage 值或解密材料。
- Theme / locale / responsive：设置页复用现有 Settings card、Switch、Button、Dialog 和 i18n，兼容窄屏图标侧栏。

高风险交叉：

- 插件开关 × 已存在草稿/运行中 session：只让后续能力解析遵循现有插件语义，不额外终止运行中任务。
- Chrome 正在运行 × SQLite WAL：兼容新版 `<profile>/Network/Cookies` 和旧版 `<profile>/Cookies`；优先通过 SQLite Online Backup API 从只读连接生成一致快照。若 Windows 不允许新连接加入运行中 Chrome 的 WAL/SHM 锁协议，则复制主库与持久化 `-wal`（绝不复制不含数据库内容且可能锁定的 `-shm`），在临时目录重建 SHM 后再次执行 Online Backup；只有通过 SQLite 读取校验的快照才进入导入。源文件只读。
- Chrome 正在运行 × LocalStorage LevelDB：必须先复制 `<profile>/Local Storage` 快照，再从快照发现 origin 并由隔离的无网络 Chrome helper 读取；通过隐藏的同分区 Electron 页面写入目标 origin，不直接修改运行中的目标 LevelDB。
- Windows App-Bound Encryption × native broker：普通 renderer/main 不能解开 `v20`。用户确认后，main 只向已验证的原生 broker 提交一次性请求；elevated controller 只创建/清理临时 `LocalSystem` 服务，原始非提权 broker 直接连接服务，使服务 impersonate Chrome 数据所属的原始用户完成 SYSTEM DPAPI → 用户 DPAPI → SYSTEM 后处理。标准用户在 UAC 中另输其他管理员账号时，普通 broker 不得尝试跨账号打开高完整性 controller 读取映像路径；broker 侧改用管理员限定 pipe ACL、由 `Process.Start` 返回的精确 controller PID 和一次性随机 token 绑定连接，controller 仍反向校验 broker PID + helper 映像路径，SYSTEM service 仍校验 broker PID + helper 映像路径 + token。这样不会错误使用管理员账号的 DPAPI 身份，也不会把跨完整性级别不可读取的进程路径当成必要条件。明文主密钥/Cookie 值不得进入 renderer、argv、环境变量、磁盘、日志或 IPC 结果；仅允许在受限命名管道和 desktop main 的短生命周期内存中流转，并在使用后清零。
- Windows native pipe wait × bounded timeout：所有通过 `BeginWaitForConnection` / `EndWaitForConnection` 实现有界等待的服务端命名管道必须用 `PipeOptions.Asynchronous` 创建；客户端连接保持同步即可。修复不得扩大 pipe ACL、删除超时、放宽 PID/映像路径/token 校验，或改变 broker → controller → `LocalSystem` service 的身份边界；同步创建模式与异步等待 API 的组合必须由 native source contract 阻止回归。
- Windows helper 失败诊断 × 敏感信息：进入通用 App-Bound 失败分支时，desktop main 只允许记录 `helper_failed`、`broker_initialization_failed`、`controller_handshake_failed`、`service_channel_failed`、`elevation_failed`、`timeout`、`peer_verification_failed`、`service_failed`、`validation_failed`、`unsupported_key`、`cng_failed`、`decryption_failed`、`service_cleanup_failed` 这十三种固定白名单原因；未知或格式错误的响应统一记为 `invalid_response`。前三种阶段原因只用于区分 broker 初始化、提权控制器握手和 SYSTEM 服务通道，不携带异常文本、路径、PID、pipe/token 或其他运行时原文。不得记录 helper 原始 stdout、请求、Chrome 路径、密钥、Cookie 或 LocalStorage 内容；UI、IPC 和 `BrowserDataImportError` 仍只暴露 `chrome_cookie_app_bound_decryption_failed`。
- UAC / service lifecycle × partial success：未确认、UAC 取消、服务创建失败、helper 签名/版本/架构失败均不得写入 Cookie；LocalStorage 继续按现有部分成功语义执行。普通 broker 与 elevated controller 都有独立父进程监控和硬超时；即使 Electron 退出、JS 定时器消失或 SYSTEM 服务卡住，controller 也必须进入停止、必要时终止精确服务 PID、删除并核验无残留。
- Windows build gate × 当前发布流程：默认构建只保留 TypeScript/C# 源码、单元测试和手动 `prepare:browser-import-helper` 脚本，不把 helper 视为本地 runtime 必需资产，也不进入 electron-builder 的 `extraResources`、签名或签名校验。显式开启 `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT=1` 后才恢复完整资产链路；UI 入口仍由独立产品边界控制。
- Linux `v11` × Libsecret/KWallet：检测到 `v11` 时使用发现 Profile 时匹配到的同品牌 Chrome/Chromium 可执行文件读取隔离快照；若运行中 Chrome 显式携带受支持的 `--password-store`，helper 必须转发该值，否则让 Chrome 按当前桌面环境自动选择。helper 不可用时允许本进程继续导入 `v10`，`v11` 计入 skipped，并保留 LocalStorage 导入。
- OS 凭据保护 × 导入结果：单条 Cookie 无法解密时跳过受保护项；macOS 用户明确拒绝或取消 Chrome Safe Storage 钥匙串访问时，必须在任何目标写入前终止整次导入，且不得继续导入 LocalStorage。
- 安装发现 × 自定义目录：只使用用户显式环境变量、运行进程命令行、OS 注册索引、PATH/XDG desktop entry 和已知标准目录；所有候选必须实际存在且可执行。未注册、未运行且不在这些安全来源中的任意磁盘路径不做全盘遍历，用户可通过 `CHROME_PATH` 或 `CHROME_EXECUTABLE` 显式指定。
- Desktop continuous × Web remote replayable：数据操作不进入 task stream、snapshot 或 relay；手机端不另起浏览器 runtime。

## 概念图

| 概念             | 状态所有者                         | 当前事实/落点                                                                                               | 本功能行为                                  |
| ---------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Browser Use 开关 | ZCode plugin config                | `docs/browser-use/browser-use-plugin-runtime-boundary.md`、`packages/ui/src/store/pluginManagementStore.ts` | 调用 `plugins/setEnabled`，复用现有能力刷新 |
| 内置浏览器数据   | Electron persistent session        | `packages/ui/src/browser-use/UnifiedBrowserView.tsx` 的 `persist:zcode-embedded-browser`                    | main 通过 `session.fromPartition` 导入/清理 |
| Chrome 源数据    | 本机 Chrome/Chromium Profile       | 标准或可安全发现的 User Data 目录；`Local State` 持有最近使用 Profile                                       | 自动选择源；只读快照；不修改 Chrome 文件    |
| 设置导航         | renderer UI                        | `packages/ui/src/settings/settingsPageConfig.ts`、`packages/ui/src/lib/settingsNavigation.ts`               | Browser 排在 Indexing 后                    |
| 跨端能力         | `IPlatformService`                 | `packages/shared/src/platform.ts`                                                                           | Desktop 实现；Web fallback 返回 unsupported |
| 可观察证据       | UI + IPC result + Electron session | toast、平台返回值、session cookies/storage                                                                  | 不记录 Cookie/LocalStorage 值或解密密钥     |
| Windows 原生导入 | Desktop main + 一次性系统服务      | main 校验 helper；broker 管理 UAC/服务；服务持有 SYSTEM 能力；Electron session 持有最终 Cookie              | 源码/测试保留；默认构建不携带 helper，显式 opt-in 后才恢复资产链路 |

Chrome 安装发现与导入顺序：

```text
macOS/Linux 点击导入
        |
        v
环境变量 -> 运行中进程 -> OS 注册/PATH/XDG -> 标准/Snap/Flatpak
        |
        +-- 无可执行文件 --> 返回 chrome_executable_not_found --> 显示“Chrome 未找到” --> 不读 Profile/不写目标
        |
        +-- 找到且可执行 --> 发现并选择 Profile --> Cookie/LocalStorage 导入

Windows 设置页
        |
        +-- 不渲染导入行 --> 清缓存/清全部数据仍可用

Windows dev / CI / package
        |
        +-- 默认 ------------------------------> 不编译、不签名、不复制 helper
        |
        +-- ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT=1 --> 构建/签名/打包 helper（UI 仍保持隐藏）
```

macOS 授权与导入顺序：

```text
点击导入
   |
读取 Chrome Cookie 快照
   |
请求 Chrome Safe Storage 钥匙串授权
   +-- Allow ------> 写入 Cookie ------> 导入 LocalStorage ------> 返回成功/部分成功
   |
   +-- Deny/取消 --> 不写入目标数据 ----> 不启动 LocalStorage ----> 返回未授权并提示已取消
```

Linux Cookie 解密顺序：

```text
读取 Cookie 快照
   |
检查 encrypted_value 前缀
   +-- v10 --------> ZCode 使用 Chromium basic 兼容密钥解密
   |
   +-- v11 --------> 同品牌 Chrome/Chromium helper
                        |
                        +-- 显式 --password-store --> 转发已知安全值
                        +-- 未显式指定 -----------> 按 GNOME/KDE 自动选择
                        |
                        +-- 成功 --> CDP 返回 Cookie --> 写入内置 session
                        +-- 失败 --> v11 skipped，继续 v10 与 LocalStorage
```

Windows App-Bound 授权与导入顺序：

```text
设置页          desktop main        native broker          临时系统服务          Electron session
  | 确认管理员授权   |                    |                     |                         |
  |----------------->| 校验 helper        |                     |                         |
  |                  |------------------->| UAC                 |                         |
  |                  |                    |--取消-------------->|                         |
  |                  |<--cookie cancelled-|                     |                         |
  |                  |                    |--同意/创建服务----->|                         |
  |                  |                    |<==受限命名管道======>| SYSTEM+用户层解密       |
  |                  |<-----短生命周期密钥/稳定结果-------------|                         |
  |                  | 清零密钥；停止/删除服务                   |                         |
  |                  |--------------------------------------------------------->| 写 Cookie
  |<-----------------| Cookie 结果 + LocalStorage 结果（只有计数/错误码）       |
```

## 维度与等价类

| 维度                | 值/等价类                                         | 影响                                                                                                       |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Surface             | macOS/Linux desktop / Windows desktop / web-mobile | macOS/Linux 可导入；Windows 暂时隐藏导入行但保留清理；web-mobile 只读禁用                                  |
| Plugin state        | enabled / disabled / loading / error              | 决定 Switch 状态与反馈                                                                                     |
| Chrome source       | Stable/Beta/Dev/Canary/Chromium / 自定义 / 未安装 | 决定 User Data 与官方 helper 的候选集合                                                                    |
| Profile selection   | last_used / Default / 唯一可导入 / 多个候选不明确 | 先过滤没有 Cookie 数据库且没有 LocalStorage 的空 Profile，再自动选择前三类；不明确时不猜测、不修改目标分区 |
| Installation source | env / running / macOS registered / Linux PATH-XDG / standard / missing | 覆盖非默认安装目录；候选必须存在且可执行；missing 在 Profile 发现前停止                                    |
| Linux installation  | XDG config / PATH / desktop entry / Snap / Flatpak | 标准目录为空时继续探测注册和沙箱安装目录；空的 `Default` 不得抢占后续真实数据源                            |
| Cookie protection   | plaintext / v10-v11 / Windows v20 / macOS OS 拒绝 | 不允许把 Cookie 值带到 renderer/log；单条解密失败可部分成功，授权拒绝则整次终止                            |
| Windows elevation   | 未确认 / UAC allow / UAC cancel / helper invalid / service failure / success | 决定是否允许启动系统能力；除 success 外均不得写入 App-Bound Cookie |
| Native artifact     | default dormant / dev unsigned opt-in / release signed x64 / release signed arm64 / mismatch | 默认构建没有 helper 资产；显式 opt-in 后，发布态只接受匹配版本、架构、签名和受信安装路径的 helper |
| LocalStorage source | 快照可读 / 无数据 / 快照锁定 / helper 不可用      | 必须先快照再发现 origin；按 origin/entry 返回数量                                                          |
| Clear mode          | cache / all                                       | cache 保留认证数据；all 二次确认后删除                                                                     |
| Client mode         | desktop-continuous / web-remote-replayable        | 不进入 session/task realtime 状态                                                                          |
| Workspace           | local / remote identity                           | 插件开关沿当前 workspace 配置；浏览器数据始终属于本机 desktop partition                                    |

## 候选组合与剪枝

| ID     | 组合                                       | 决策     | 理由                                                                       |
| ------ | ------------------------------------------ | -------- | -------------------------------------------------------------------------- |
| BS-C01 | Desktop + plugin enabled/disabled          | accepted | 用户明确要求复用插件开关                                                   |
| BS-C02 | Web/mobile 直接操作本机 Chrome 数据        | pruned   | 浏览器数据属于 desktop host，本端无本机 Chrome/partition                   |
| BS-C03 | 手机端另起 IAB runtime                     | pruned   | 违反 shared-host attachment 约束                                           |
| BS-C04 | Chrome 多 Profile 选择器                   | pruned   | 用户确认自动选择最近使用 Profile，不增加交互                               |
| BS-C05 | Chrome 数据持续同步                        | pruned   | 用户明确一次性导入                                                         |
| BS-C06 | 明文 Cookie 成功、部分加密 Cookie 无法解密 | accepted | 可读取项继续导入，受保护项按 skipped 统计                                  |
| BS-C07 | 把 Chrome Cookie 值写进日志/renderer       | pruned   | 敏感数据边界，不允许跨 IPC 返回 Cookie 值                                  |
| BS-C11 | 把 LocalStorage 值写进日志/renderer        | pruned   | 本地站点数据同属敏感数据，只返回 origin/entry 数量                         |
| BS-C08 | 普通清理删除 Cookie                        | pruned   | 普通清理必须保留认证数据                                                   |
| BS-C09 | 全量清理无确认直接执行                     | pruned   | 数据损失边界要求二次确认                                                   |
| BS-C10 | remote workspace 使用远端 Chrome Profile   | ignored  | 当前范围只管理桌面宿主的内置浏览器分区                                     |
| BS-C12 | last_used 不存在但 Default 可用            | accepted | 自动 fallback，不把可用 Chrome 误报为未找到                                |
| BS-C13 | 无 Default 但只有一个可用 Profile          | accepted | 自动选择唯一候选，保持一键导入                                             |
| BS-C14 | 多个可用 Profile 且无法确定 last_used      | accepted | 返回 `chrome_profile_ambiguous`，禁止静默猜测                              |
| BS-C15 | Windows Cookie 为 App-Bound `v20`          | accepted | 用户确认后仅走 ZCode 原生 broker + 一次性系统服务；不再依赖临时 Chrome headless 读取 |
| BS-C16 | LocalStorage 源正在被 Chrome 写入          | accepted | 先复制快照再发现 origin，失败时返回 source locked                          |
| BS-C17 | Windows Chrome 持有 Cookie WAL/SHM         | accepted | Online Backup 不可用时复制主库与 WAL，在临时目录重建 SHM；不复制锁定的 SHM |
| BS-C18 | macOS 用户拒绝或取消钥匙串访问             | accepted | 授权是整次导入的前置条件；拒绝后不允许转入 LocalStorage 部分导入           |
| BS-C19 | Linux `v11` 使用 Libsecret/KWallet         | accepted | 由同品牌 Chrome/Chromium helper 解密；ZCode 不直接接入或导出系统密钥       |
| BS-C20 | 首个 Chrome 安装目录存在但 Profile 无数据  | accepted | 跳过空 Profile，继续探测同安装的其他 Profile 以及 Snap/Flatpak 数据目录    |
| BS-C21 | Chrome helper 已读到数据但临时目录仍有残留 | accepted | 重试清理；最终清理失败只记安全日志，不得覆盖已经成功的 Cookie 读取结果     |
| BS-C22 | 导入成功但存在 skipped/failed 计数         | accepted | 用户界面只展示实际导入数量；详细计数仅写入不含敏感值的本地日志             |
| BS-C23 | Windows 用户未勾选管理员授权确认           | accepted | 不触发 UAC、不启动服务、不写 Cookie；界面停留在确认态                       |
| BS-C24 | Windows 用户在 UAC 中取消                  | accepted | App-Bound Cookie 不写入；LocalStorage 继续，结果标记 Cookie 授权取消        |
| BS-C25 | helper 签名/版本/架构/路径校验失败         | accepted | 可信 PowerShell 锁住已签名 helper，核对摘要、应用版本、commit 后启动同一文件；失败即 fail closed，不启动服务；LocalStorage 可部分成功 |
| BS-C26 | 一次性系统服务失败、超时或 ZCode 退出      | accepted | 不写入未完成 Cookie；停止并删除服务；不得遗留 LocalSystem 常驻进程           |
| BS-C27 | 把明文主密钥/Cookie 放进 argv/env/磁盘/日志 | pruned  | 敏感数据边界；只允许受限管道和短生命周期内存，使用后清零                    |
| BS-C28 | Windows 导入 Chrome 密码库                 | pruned   | 用户确认只修复 Cookie；不发现、不打开、不复制 `Login Data`                  |
| BS-C29 | Web/mobile/非 Windows 启动 Windows helper  | pruned   | 平台能力只属于 Windows desktop main；remote/mobile 不创建 runtime            |
| BS-C30 | 把 helper 原始 stdout 或内部原因展示给用户 | pruned   | 本地日志只保留白名单稳定原因；UI/IPC 继续使用通用失败，避免泄露敏感上下文     |
| BS-C31 | 标准用户在 UAC 中切换到其他管理员账号     | accepted | broker 不跨账号读取 controller 路径；精确 PID + 管理员 pipe ACL + token 继续绑定 controller，后续反向校验与服务校验保持不变 |
| BS-C32 | Windows 设置页展示 Chrome 导入入口        | ignored  | 当前暂时隐藏导入行；不删除底层 App-Bound 实现，清理操作继续可用             |
| BS-C33 | 对 macOS/Linux 做全盘 Chrome 搜索         | pruned   | 成本、权限和隐私边界不可控；安全来源不足时由环境变量显式指定                 |
| BS-C34 | Chrome 未安装时继续扫描 Profile           | pruned   | 安装探测必须先于 Profile 访问，返回“Chrome 未找到”且不产生目标 mutation      |
| BS-C35 | 默认 Windows 构建编译或打包导入 helper    | pruned   | Windows 导入入口已隐藏；默认流程不得继续承担原生编译、签名和包体成本，源码/测试与显式 opt-in 链路保留 |
| BS-C36 | 导入行继续留在“浏览器数据”分组            | pruned   | 导入是开启内置浏览器控制后的配套动作，与清除类破坏性操作不同语义；同组展示才能让用户按顺序完成配置 |
| BS-C37 | 面向用户的描述继续以 Cookie/LocalStorage 为主语 | pruned | 用户只关心“AI 能不能直接用已登录的网站”；数据结构细节留在 spec、日志和错误码，不进入设置页主描述 |

当前没有未决产品语义。本功能读取 Chrome Cookie 数据库与 `Local Storage` 快照，不发现、不打开、不复制 `Login Data`，平台返回值和界面也不包含密码字段。2026-07-16 用户确认：只实现 Windows App-Bound Cookie；保留现有 LocalStorage；不导入密码；每次显式确认并触发 UAC；使用后删除临时服务；继续兼容 Stable/Beta/Dev/Canary/Chromium。2026-07-17 用户确认：helper 细分失败原因只写本地日志，不展示给用户、不扩展 IPC 或公共错误类型。2026-07-20 用户确认：Windows 暂时隐藏 Chrome 导入入口；macOS/Linux 导入前先发现 Chrome，可通过系统注册信息覆盖非默认安装目录，未安装时提示“Chrome 未找到”。同日再次确认：Windows 原生实现后续可能恢复使用，因此不删除源码和测试；默认开发、CI、签名与打包流程停用 helper，仅保留 `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT=1` 显式资产开关。2026-08-21 用户确认：导入行从“浏览器数据”移到“浏览器控制”分组，与“开启内置浏览器控制”同一张卡片、排在开关之后；标题改为“导入 Chrome 登录状态”，描述改为面向用户收益的表述（一次性带过登录状态，AI 可直接打开已登录网站），不再以 Cookie/LocalStorage/Profile 作为主描述。功能边界、错误码、导入范围和 Windows 隐藏策略均不随本次调整改变。

## 已接受验收用例

| Case   | Setup                                                                                      | Action                     | Assert                                                                                                                                | Evidence                                                               |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| BS-001 | Desktop，官方 browser-use plugin 已启用                                                    | 关闭开关                   | plugin enabled 变为 false；后续草稿 session 重新解析能力                                                                              | UI Switch；`plugins/setEnabled` 结果；刷新后的 plugin overview         |
| BS-002 | Desktop，官方 browser-use plugin 已禁用                                                    | 开启开关                   | plugin enabled 变为 true；不生成第二份设置值                                                                                          | UI Switch；plugin config/overview                                      |
| BS-003 | Chrome 最近使用 Profile 含可读取 Cookie 与 LocalStorage                                    | 点击一键导入               | 自动选择该 Profile；Cookie 与 LocalStorage 写入内置 session；不主动刷新页面；session Cookie 在重启后仍可恢复；源 Profile 不变         | IPC result；`session.cookies.get()`；目标页面 LocalStorage；源文件只读 |
| BS-004 | 同时存在可读取 Cookie 与无法解密的受保护 Cookie                                            | 点击一键导入               | 可读取 Cookie 保持成功；受保护项计入 skipped；无 Cookie 值进入 renderer/log                                                           | IPC result；日志字段审计                                               |
| BS-005 | Chrome 已安装但没有可用 Profile                                                            | 点击一键导入               | 不修改内置数据；提示未找到可导入 Profile                                                                                              | IPC result；session 前后状态                                           |
| BS-006 | 内置 session 已有 Cookie、LocalStorage、IndexedDB 与 cache storage                         | 清除浏览器缓存             | HTTP/cache 类存储清除，Cookie、LocalStorage、IndexedDB 保持                                                                           | Electron session API 调用；cookies/storage 前后对比                    |
| BS-007 | 内置 session 已有认证数据                                                                  | 点击清除全部并取消         | 不执行清理                                                                                                                            | Dialog action；session 状态                                            |
| BS-008 | 内置 session 已有认证数据                                                                  | 确认清除全部               | Cookie 和站点数据清除，显示成功反馈                                                                                                   | Electron session API；cookies/storage 状态                             |
| BS-009 | Web/手机端打开 Browser 设置                                                                | 查看并尝试操作             | 页面不空白；native 操作禁用并提示桌面端；不创建 runtime                                                                               | UI；无 platform mutation/relay payload                                 |
| BS-010 | 远程 workspace 设置页                                                                      | 切换插件并执行本机数据操作 | 插件仍按 workspace identity 路由；数据操作只命中本机 partition                                                                        | plugin request workspaceKey；desktop IPC                               |
| BS-011 | `last_used=Profile 2`，同时存在 Default                                                    | 点击一键导入               | 选择 Profile 2；不混入 Default 数据                                                                                                   | discovery unit；IPC result                                             |
| BS-012 | `last_used` 无效、Default 存在                                                             | 点击一键导入               | fallback 到 Default                                                                                                                   | discovery unit                                                         |
| BS-013 | 无 Default、只有一个数据 Profile                                                           | 点击一键导入               | 选择唯一 Profile                                                                                                                      | discovery unit                                                         |
| BS-014 | 无有效 last_used/Default 且有多个 Profile                                                  | 点击一键导入               | 返回 Profile 不明确；目标 session 不变                                                                                                | discovery unit；UI component                                           |
| BS-015 | Windows Profile 含 `v20` Cookie，用户已确认且 UAC Allow                                     | 点击一键导入               | 签名 helper 创建一次性系统服务；Cookie 导入目标 session；服务停止并删除；源 Profile 不变                                              | native protocol/unit；Windows real smoke；session cookies              |
| BS-016 | Chrome 正在写 LocalStorage LevelDB                                                         | 点击一键导入               | 从已复制快照发现 origin；锁定或复制失败返回明确原因                                                                                   | filesystem unit；Windows real smoke                                    |
| BS-017 | Windows Chrome 正在运行且持有 `Cookies-wal` / `Cookies-shm`                                | 点击一键导入               | 优先 SQLite Online Backup；源连接返回 SQLite 错误时复制主库与 WAL、重建 SHM 并生成已校验的一致快照；不复制锁定的 SHM；源 Profile 不变 | SQLite fixture；Windows Chrome running smoke                           |
| BS-018 | macOS Profile 含加密 Cookie，系统弹出 Chrome Safe Storage 授权                             | 点击 Deny 或取消           | 返回未授权失败；不写入任何 Cookie；不启动 LocalStorage 导入；设置页显示“已取消导入”提示                                               | 注入系统凭据拒绝结果；目标 session 调用；UI component                  |
| BS-019 | Linux Profile 同时含 `v10` 与由 Libsecret/KWallet 保护的 `v11` Cookie                      | 点击一键导入               | `v11` 由同品牌 helper 解密；显式 password store 被安全转发；helper 失败时仍导入 `v10` 与 LocalStorage，不读取或记录密钥               | helper unit；GNOME/KDE real smoke                                      |
| BS-020 | Linux 标准 `Default` 目录为空，其他 Profile 或 Snap/Flatpak Profile 含 Cookie/LocalStorage | 点击一键导入               | 跳过空 `Default` 并选择实际含可导入数据的 Profile；不返回通用导入失败                                                                 | discovery unit；Linux real smoke                                       |
| BS-021 | Linux Chrome helper 已通过 CDP 返回 Cookie，但退出后临时 Profile 短暂产生新文件            | 完成 helper 读取           | 重试删除临时目录；即使最终返回 `ENOTEMPTY`，仍保留已读取结果并记录错误类型/错误码                                                     | cleanup unit；Linux real smoke                                         |
| BS-022 | 导入结果包含 imported、skipped、failed 计数                                                | 展示导入结果               | 页面和 toast 只展示 imported 数量；本地日志保留三类计数且日志导出不因 `cookie` 键名误脱敏                                             | UI component；log field audit                                          |
| BS-023 | Windows Profile 含 `v20`，用户未勾选管理员授权确认                                      | 点击导入                   | 导入按钮不可提交；无 UAC、无 helper/service 进程、目标数据不变                                                                       | UI component；launcher spy                                             |
| BS-024 | Windows Profile 含 `v20`，用户勾选后在 UAC 取消                                         | 点击导入并取消 UAC         | Cookie 返回 `chrome_cookie_elevation_cancelled` 且不写入；LocalStorage 可成功；无遗留服务                                             | broker fake；target session spy；service cleanup probe                 |
| BS-025 | 发布态 helper 签名/版本/架构/路径任一不匹配                                             | 点击导入                   | fail closed，返回 `chrome_cookie_helper_verification_failed`；不触发系统服务；不回退临时 Chrome headless；LocalStorage 可继续           | verifier unit；launcher spy；IPC result                                |
| BS-026 | 系统服务启动后发生超时/pipe 断开/ZCode 退出                                             | 导入进行中                 | 中止 Cookie 导入；密钥内存清零；服务停止并删除；下次导入不复用旧 pipe/token                                                           | native integration；Windows service query；bounded timeout             |
| BS-027 | Windows x64/arm64 发布包                                                                | 安装并导入                 | helper 架构匹配、随主包签名并位于受信资源路径；非 Windows 包不含/不启动该 helper                                                      | bundle audit；签名检查；两架构 CI smoke                                |
| BS-028 | Windows helper 返回已知失败、未知失败或畸形响应                                          | 点击导入                   | 本地日志只记录白名单 `reason` 或 `invalid_response`；broker/controller/service 通道异常保留固定阶段原因但不保留异常原文；不得包含原始 stdout、路径、PID、pipe/token、密钥或 Cookie；UI/IPC 仍返回通用 App-Bound 解密失败 | parser unit；native source contract；logger spy；IPC contract          |
| BS-029 | 当前 Windows 用户不是 Administrators 成员，UAC 使用其他管理员凭据                          | 确认授权并导入             | broker 不跨账号打开 controller 查询映像路径；精确 PID + 管理员 pipe ACL + 一次性 token 完成握手；controller/service 对普通 broker 的映像路径校验保持启用；无 helper/service 残留 | native source contract；Windows 标准用户 UAC smoke；残留检查           |
| BS-030 | broker 或 service 通过有界异步 API 等待 pipe 客户端，但服务端 pipe 以同步模式创建           | 确认授权并导入             | 服务端 pipe 统一以 `PipeOptions.Asynchronous` 创建并完成握手；客户端保持同步；ACL、超时、PID/映像路径/token 校验不变；不得在进入解密前返回通道失败                | native source contract；helper 编译；Windows 签名包 UAC smoke         |
| BS-031 | Windows desktop 打开 Browser 设置页                                                       | 查看浏览器数据操作         | 不渲染“导入 Chrome 登录状态”行和管理员授权 Dialog；清缓存、清全部数据仍展示并可用                                                   | UI component；无 import IPC 调用                                       |
| BS-032 | macOS Chrome 安装在非默认目录，但应用已被 Spotlight 注册                                   | 点击一键导入               | 从注册的 app bundle 解析并验证可执行文件，再进入 Profile 发现；不要求位于 `/Applications`                                            | discovery unit；macOS custom-location smoke                            |
| BS-033 | Linux Chrome 安装在非默认目录，并在 PATH 或 XDG desktop entry 注册                          | 点击一键导入               | 解析注册候选并验证可执行文件，再进入 Profile 发现；继续兼容 Snap/Flatpak                                                              | discovery unit；Linux custom-location smoke                            |
| BS-034 | macOS/Linux 未找到任何 Chrome/Chromium 可执行文件                                           | 点击一键导入               | 在 Profile 发现前返回 `chrome_executable_not_found`；显示“Chrome 未找到”；目标 Cookie/LocalStorage 不变                               | discovery/import unit；UI component；session spy                       |
| BS-035 | Windows 默认开发或发布构建，未设置 `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT`                    | 准备 runtime assets 并打包 | 不编译、不要求、不复制、不签名 helper；Browser 设置仍无导入行；清缓存和清全部数据保持可用                                             | build source contract；bundle config；UI component                     |
| BS-036 | Desktop/Web 打开 Browser 设置页                                                     | 查看导入、清缓存、清全部数据按钮 | 三个操作按钮均使用设置页 `lg` 控件尺寸（`32px` 高、`rounded-lg`），与 Terminal font 操作控件一致                                       | UI component class contract                                            |
| BS-037 | macOS/Linux desktop 打开 Browser 设置页                                             | 查看分区信息结构                 | “导入 Chrome 登录状态”与“开启内置浏览器控制”在“浏览器控制”分组的同一张卡片内，且排在开关之后；“浏览器数据”分组只剩清缓存与清全部数据 | UI component DOM 顺序契约                                              |

## 覆盖矩阵

| Case           | Unit/contract                                  | Component                            | Desktop integration/E2E               | 初始状态                                    |
| -------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------- |
| BS-001/002     | plugin store 既有覆盖                          | BrowserSettingsSection Switch 已覆盖 | plugin runtime 既有覆盖               | automated                                   |
| BS-003/004/005 | Chrome Cookie/LocalStorage source 与结果已覆盖 | 一键导入状态与 toast 已覆盖          | 真实 Chrome 当前 Profile + z.ai smoke | macOS passed；Windows/Linux 实机待补        |
| BS-006/007/008 | session clear mode 已覆盖                      | 确认 Dialog 与按钮 pending 已验证    | Electron persistent partition         | automated + runtime smoke                   |
| BS-009         | Web unsupported result 已覆盖                  | disabled controls 已覆盖             | mobile layout smoke                   | automated                                   |
| BS-010         | workspace identity 参数沿用 plugin store       | section props 已覆盖                 | remote workspace regression           | partial：远程实机待补                       |
| BS-011/012/013 | Profile 自动选择优先级 unit                    | 无额外选择器                         | 三平台标准目录 smoke                  | automated；macOS passed，Windows/Linux 待补 |
| BS-014         | 多 Profile 歧义错误 unit                       | 明确错误文案                         | 无目标数据 mutation                   | automated                                   |
| BS-015         | App-Bound native protocol unit                | 管理员授权确认/部分成功文案          | Windows Chrome real smoke + UAC       | automated；签名实机 UAC smoke 待补          |
| BS-016         | 快照顺序与复制失败 unit                        | source locked 文案                   | Windows Chrome running smoke          | automated；Windows 实机待补                 |
| BS-020         | 空 Profile 过滤与 Linux 沙箱目录候选 unit      | 沿用现有导入结果反馈                 | Ubuntu Chrome/Chromium real smoke     | automated；Linux 实机待补                   |
| BS-021/022     | helper cleanup 与安全计数日志 unit             | 成功态只展示实际导入数               | Ubuntu Chrome helper real smoke       | automated；Linux 实机待补                   |
| BS-017         | Online Backup failure + locked SHM + WAL unit  | 沿用导入结果文案                     | Windows Chrome running smoke          | automated；Windows 实机待补                 |
| BS-018         | macOS system credential denial unit            | 未授权终止文案                       | macOS Keychain Deny smoke             | automated；macOS 实机待补                   |
| BS-019         | Linux v10/v11 helper/fallback unit             | 沿用成功/部分保护文案                | GNOME Libsecret + KDE KWallet smoke   | automated；Linux 实机待补                   |
| BS-023/024     | consent/cancel unit                            | 管理员授权确认、取消/部分成功文案     | Windows Chrome real smoke + UAC       | automated；签名实机 UAC smoke 待补          |
| BS-025/026     | helper verifier、pipe auth、service cleanup    | helper 失败稳定文案                   | Windows service lifecycle smoke       | verifier automated；pipe/service 已编译，实机残留检查待补 |
| BS-027         | bundle asset/version/arch/sign contract        | 无额外 UI                             | Windows x64/arm64 signed artifact     | automated build gate；签名需发布 CI         |
| BS-028         | helper reason allowlist、未知响应归一化、日志字段审计 | 公共失败文案保持不变                  | Windows 真实 App-Bound smoke          | parser/logger automated；已安装签名 helper 已复现通用失败；细分原因待新签名包复验 |
| BS-029         | controller 精确 PID 校验、反向 broker 路径校验 contract | 管理员确认交互保持不变                | Windows 标准用户 + 其他管理员 UAC     | source contract 自动化；签名实机待发布包复验 |
| BS-030         | 服务端 pipe 异步打开模式 source contract       | 无 UI 变化                            | Windows 签名 helper UAC smoke         | source contract automated；helper compiled；签名实机待复验 |
| BS-031         | 无额外 native unit                              | Windows 导入行不可见、清理按钮可用    | Windows settings smoke                | component automated；Windows 实机待补       |
| BS-032/033     | 注册/PATH/XDG/自定义目录 executable discovery   | 沿用导入 pending/结果反馈             | macOS/Linux 非默认安装目录 smoke      | unit automated；两平台实机待补              |
| BS-034         | executable preflight 在 Profile discovery 前终止 | “Chrome 未找到”文案                   | 无目标 partition mutation             | unit + component automated                  |
| BS-035         | 默认关闭与显式 opt-in build gate contract         | 复用 BS-031 隐藏入口                  | Windows 默认 bundle 不含 helper       | build source contract planned               |
| BS-036         | 无额外 service unit                               | Browser 操作按钮 `lg` 尺寸 class contract | desktop/web responsive smoke          | component automated                         |
| BS-037         | 无额外 service unit                               | 导入行与控制开关同卡片、顺序在后的 DOM 契约 | desktop/web settings smoke            | component automated                         |

## E2E 交接说明

- 不创建 conversation E2E；本功能不修改 task/session realtime 语义。
- Desktop E2E fixture 不携带真实用户 Cookie 或 LocalStorage。自动化使用临时 Electron partition、合成 SQLite fixture 与合成 LocalStorage snapshot；真实 Chrome 导入只做本机手动 smoke。
- Windows App-Bound 自动化分三层：纯协议/校验使用合成密文与 fake broker；Windows 本机集成使用测试专用双层 DPAPI fixture，不读取真实 Cookie；真实 Chrome 只做人工 smoke。当前机器已完成真实 x64 helper 编译和 `--version`（协议、x64、应用版本、commit）执行。2026-07-17 经用户授权读取本机 `APPB` 密文并运行已安装签名 helper；生命周期监控确认标准用户 broker 启动、UAC 切换到其他管理员 controller 后在创建 `ZCodeBrowserImport_*` 服务之前返回 `helper_failed`，未进入 Chrome 密钥格式/CNG 阶段；诊断产生的 helper 残留已清理，服务残留为 0。最新签名包日志进一步把失败定位为 `controller_handshake_failed`；使用合成密文的同构 .NET 运行时探针确认 `PipeOptions.None` 创建的服务端 pipe 调用 `BeginWaitForConnection` 会抛出 “Pipe is not opened in asynchronous mode”，未创建临时服务，也没有读取真实 Cookie 或把密钥/Cookie 写入日志。服务端 pipe 已改为 `PipeOptions.Asynchronous`，BS-030 source contract 14/14 通过且 x64 helper 已重新编译；本机应用控制仍阻止运行未签名工作区 helper，因此发布完成仍须补 x64/arm64 helper 签名、标准用户凭据切换 UAC allow/cancel、服务/helper 残留和真实 Chrome `v20` 验证。macOS Keychain、Linux Secret Service 的真实授权行为继续按原平台边界手动验证；Linux 至少覆盖 GNOME + `gnome-libsecret`、KDE + `kwallet5/kwallet6` 与 `basic/v10`。单条数据无法安全解密时必须稳定计入 skipped 或返回明确失败，macOS 明确拒绝/取消钥匙串授权时必须终止整次导入；不得把 Cookie/LocalStorage 值或解密密钥写入日志或 IPC。
- Web/mobile 验证只检查禁用态和无 mutation，不允许为测试创建独立 Browser Use runtime。

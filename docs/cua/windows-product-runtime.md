# Windows CUA 产品运行时规范

## 目标

在不依赖本地 `zcode-cua` 源码目录、不控制 SSH/WSL/Docker/远程工作区的前提下，让
Windows x64/arm64 的 ZCode 安装包能够按需启动本机 Computer Use Helper，并复用现有
`@zcode/protocol`、CUA broker、官方 `zcode-cua` 插件和桌面本地 host 生命周期。

源码开发仍允许使用 `ZCODE_CUA_DEV_ROOT` 覆盖产品资源；产品安装包默认只读取自身
`resources/tools/cua-helper`，不搜索相邻目录、不下载 Helper、不回退到 macOS 实现。

## 设计结论

Windows 沿用 macOS 已验证的“Agent 只连接 broker、Helper 独立持有自动化能力”边界，
但不复制 macOS 为 TCC 授权单独发布 `.app`/SEA 的形式。Windows 没有对应的 TCC
授权主体要求，因此 Helper 由安装包内的 Electron Node 运行时启动，原生
`ax_native.node` 作为安装资源发布。

`@zcode/zcode-cua` 是 Helper JavaScript、native source、addon 与版本校验的唯一包身份；不得再为同一 Git 提交声明 helper-runtime alias。macOS/Windows CI 必须从 canonical 包重建目标架构 addon，缺少 `binding.gyp` 或对应平台源码时 fail closed。

```text
构建期

固定提交的 @zcode/zcode-cua（或构建期显式 ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR）
  ├─ package.json:zcodeCuaRuntime.windows.entry
  ├─ package.json:zcodeCuaRuntime.windows.nativeAddon
  └─ 外置运行依赖 express / sharp
                 |
                 v
prepare:windows-cua-helper
  ├─ 校验 package 身份、目标 win32 架构和 PE machine
  ├─ 复制最小运行文件
  └─ 生成带 SHA-256 的 runtime-manifest.json
                 |
                 v
bundled-tools/win32-{x64|arm64}/cua-helper
                 |
                 v
electron-builder extraResources + Windows signExts(.node/.dll)
  ├─ 复制时先签名最终目录中的 .node/.dll
  ├─ afterPack 按实际 context 校验 win32/arch 与配置目标一致
  ├─ 只用最终已签名字节刷新 manifest.sha256
  └─ 再严格校验 manifest / PE / hash / 依赖闭包 / realpath containment
                 |
                 v
<安装目录>/resources/tools/cua-helper
```

```text
运行期（仅 desktop-local）

官方 CUA 插件启用
  -> host 延迟解析 Windows runtime
     -> 若 ZCODE_CUA_DEV_ROOT 非空：严格使用显式源码根
     -> 否则：严格使用 process.resourcesPath/tools/cua-helper
        -> 校验 manifest / win32 / arch / Electron 版本 / 文件哈希
           -> Electron.exe + ELECTRON_RUN_AS_NODE=1 fork windows-helper.js
              -> Helper 加载 ax_native.node
                 -> named pipe broker ready + health PID 复核
                    -> Agent 获得 socket/token/pluginAuthority
```

`desktop-attached-remote`、`standalone-server`、带 remote workspace identity 的 host
继续不创建默认 Helper。此变更不新增 runtime、local host、SSH/WSL/Docker session，
也不改变手机 `/remote` 的 replayable、owner、queue、snapshot 或 workspace identity
语义。

## 发布资源契约

生产者必须在 `package.json` 暴露严格、可版本化的 Windows runtime 契约：

```json
{
  "zcodeCuaRuntime": {
    "schema": 1,
    "windows": {
      "entry": "dist/windows-helper.js",
      "nativeAddon": "build/Release/ax_native.node"
    }
  }
}
```

契约对象和 Windows 子对象不允许未知字段；两个 artifact 都必须是规范的 `/` 分隔相对路径，
不能相同，也不能包含反斜杠、绝对路径、空段、`.`、`..`、ADS 冒号或 NUL。消费端不得再固定生产者
版本号或 artifact 目录。

产品目录固定为 `resources/tools/cua-helper`，至少包含：

- `runtime-manifest.json`
- `package.json`（声明 `"type": "module"`；version 与 manifest 的 `packageVersion` 一致）
- 契约 `entry` 指向的 Helper 文件
- 契约 `nativeAddon` 指向的原生模块
- `node_modules/express` 及其运行时依赖闭包
- `node_modules/sharp` 和目标平台对应的 `@img/*` 预编译包

`package.json` 的 module 声明是硬性要求（ZCT-2093176018262081536）：entry 是含裸
`import` 的 ESM，若运行时根没有最近的 package.json，Node 只能靠 detect-module 语法探测
兜底；安装盘符链上任何带 `"type"` 的杂散 package.json 都会禁用探测，让 Helper 以
`SyntaxError` exit 1 失败并表现为 `broker_unavailable`。staging 负责生成该文件，
afterPack verifier 负责校验其存在、类型与版本一致性。

manifest schema 版本为 `1`，字段固定为：

```json
{
  "schemaVersion": 1,
  "packageName": "@zcode/zcode-cua",
  "packageVersion": "0.5.2",
  "platform": "win32",
  "arch": "x64",
  "electronVersion": "41.0.3",
  "entry": "dist/windows-helper.js",
  "addon": "build/Release/ax_native.node",
  "sha256": {
    "entry": "<lowercase hex>",
    "addon": "<lowercase hex>"
  }
}
```

上例路径和版本只用于展示。staging 必须把当前生产者的契约路径原样写入 `entry`/`addon`，
把当前 package version 原样写入 `packageVersion` 作为来源追踪；运行时只要求它是非空字符串，
不与 ZCode 内的版本常量比较。真正的发布版本选择仍由 lockfile 的精确 commit 管理。

`arch` 允许 `x64` 或 `arm64`。构建期必须检查 `.node` 的 PE machine：
`0x8664` 对应 x64，`0xaa64` 对应 arm64。目标不匹配时构建立即失败，禁止把宿主
x64 产物误装进 arm64 包。

发布依赖必须固定到可从远端获取的 `zcode-cua` 精确 commit；不能使用分支浮动引用、
相邻目录猜测或安装时临时编译。`ZCODE_CUA_DEV_ROOT` 只作为显式本地开发覆盖。

## 运行时准入与失败语义

1. 平台不是 `win32` 时，Windows resolver 返回稳定的 `unsupported-platform`。
2. `ZCODE_CUA_DEV_ROOT` 非空时必须是绝对路径，并继续执行 package/entry/addon 校验；
   配错后 fail closed，不回退产品资源。
3. 未设置开发覆盖时必须存在绝对 `resourcesPath`，产品根固定派生为
   `tools/cua-helper`。
4. 产品模式必须校验 manifest schema、packageName、platform、arch、
   Electron 版本、entry/addon 相对路径和 SHA-256。
5. 诊断只报告稳定 reason 和相对 artifact，不输出无关环境变量、token 或文件内容。
6. Helper 仍延迟启动；特性关闭或官方插件未启用时不启动、不探测、不产生子进程。
7. start/stop/restart/health、ready PID、health PID、named-pipe token 和终止阻塞语义沿用
   现有 Windows Helper host，不因产品化新增第二套生命周期。

源码准入和 staging 不能只检查词法路径。source root 必须是非链接目录；`package.json`、
entry、addon 必须是非链接普通文件，且各自的 `realpath` 必须物理包含在 source root 的
`realpath` 内。这样即使中间目录被 junction/reparse point 替换，也不能把仓库外文件带入
开发运行时或安装包。

## 签名与安装边界

- Windows 发布构建继续由仓库的 vsigntool hook 统一签名。
- `electron-builder.win.signExts` 必须包含 `.node` 和 `.dll`，使 CUA addon、Sharp
  addon/libvips 与其他安装包原生依赖进入同一签名时机。
- 本地无证书构建允许生成未签名测试包，但不能宣称完成发布签名验证。
- electron-builder 26 会在复制 `extraResources` 时通过 Windows transformer 签名
  `.node`/`.dll`，签名会改变文件字节。`afterPack` 必须先验证 manifest 的固定字段、路径、
  PE 架构、依赖闭包和物理包含关系，只刷新最终目录中 entry/addon 的 SHA-256，再执行一次
  包含哈希在内的严格校验；不能继续使用 staging 阶段的未签名字节哈希。
- Windows `afterPack` 必须从 electron-builder context 取得实际 os/arch，并与配置目标严格
  相等；`--win` 交叉构建或环境变量不一致时必须失败，不能返回 skipped 或按错误架构验收。
- 更新包复用桌面应用既有更新通道，Helper 不建立独立下载/更新状态。

```text
staging manifest（未签名字节 hash）
  -> extraResources copy
     -> Windows transformer 签名 .node/.dll
        -> afterPack 校验实际 win32/arch
           -> 校验固定契约 + PE + dependency closure + realpath containment
              -> 刷新最终字节 hash
                 -> 严格复验最终 manifest
                    -> 后续 EXE/app.asar 签名（不再改 resources/tools/cua-helper）
```

## 验收

自动化至少覆盖：

- source override 与 packaged runtime 两种解析路径；
- 配错 source override 不回退；
- manifest schema/platform/arch/Electron/hash 任一不匹配均 fail closed；
- Windows 特性在无 `ZCODE_CUA_DEV_ROOT` 时仍可创建延迟产品 host；
- 非 desktop-local 与 remote workspace identity 继续拒绝创建；
- staging 的 x64/arm64 PE machine 校验；
- source/staging 拒绝 symlink、junction/reparse point 造成的物理越界；
- electron-builder 包含 Helper 资源、`.node`/`.dll` 签名扩展、context 目标断言，以及
  签名后 hash 刷新与严格 afterPack 复验；
- 使用 Electron 41 直接加载 staged `ax_native.node`；
- 从 staged/packaged 产品根启动 Helper，完成 ready/health，并在退出后确认 named pipe
  不可连接、无遗留 Helper 子进程；
- Windows 现有 30 工具 source/live smoke 不回退。

仓库级门禁保持 `pnpm typecheck` 与 `pnpm lint`。当前分支既有、与 CUA 无关的
`test:unit:affected` 失败必须单独列出，不得把它们伪装成 CUA 回归。

## 本地产品验收记录（2026-07-29）

Windows `--dir` 验收必须显式加载仓库的非默认配置文件名；裸跑
`electron-builder --win --x64 --dir` 不会加载 `electron-builder.config.js`，会在
`extraMetadata.version` 注入前错误报告 desktop `package.json` 缺少 version。正确命令为：

```powershell
Remove-Item Env:ZCODE_CUA_DEV_ROOT -ErrorAction SilentlyContinue
$env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR='D:\path\to\zcode-cua'
$env:ZCODE_SKIP_REMOTE_ASSETS='1'
$env:ZCODE_TARGET_OS='win32'
$env:ZCODE_TARGET_ARCH='x64'
pnpm --filter @zcode/desktop build
pnpm --filter @zcode/desktop exec electron-builder `
  --config electron-builder.config.js --win --x64 --dir
Remove-Item Env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR
```

本机通过显式 `ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR` 选择本地 producer 完成
`@zcode/zcode-cua` staging；workspace/lockfile 仍保持远端可获取的精确 pinned dependency，目标为
win32/x64，addon PE machine 为 `0x8664`。产物资源目录为
`<workspace>\packages\desktop\dist\win-unpacked\resources`，manifest 为
`resources\tools\cua-helper\runtime-manifest.json`。GitHub 下载中断后复用了已缓存并按
Electron 官方 `checksums.json` 验证的 `electron-v41.0.3-win32-x64.zip`；zip SHA-256 为
`93346b31dfcd779c4c4cdfdfb2e3f9642e7a9888e388a8971ff3e95dbf948887`。

本地命令执行器的 20 分钟上限恰好在 `rcedit` 修改 branded
`ZCode Preview.exe` 时中断，遗留 exe 的版本仍是 Electron `41.0.3`，hash 也不同于
cache 原始 `electron.exe`；Windows Application Control 因而拒绝启动它。该次命令没有
可采信的最终 exit code，不能记为 branded unpacked build 成功。独立运行与 afterPack
相同的 `verifyPackagedWindowsCuaHelper` 已验证最终 resources 中的 manifest、entry/addon
hash、PE、express/Sharp 依赖闭包和物理包含关系，返回 `verified`。

为了只验证 packaged resources 与目标 ABI，从上述 exact zip 提取原始 Electron
`41.0.3` x64（exe SHA-256
`c3ff0b19217c3f3521bd392899cffa65b0f0c0aae500ee0291e85490a52327d4`），与 unpacked
Electron 资源同目录运行；其版本为 Electron `41.0.3`、embedded Node `24.14.0`、
N-API `10`。产品集成测试使用该 executable 仅覆盖 resolver 的 `command`，其余
root/entry/addon/node_modules 均来自上述 packaged resources。最终专项门禁记录中的 owned
Helper PID 为 `39992`；ready、health、`broker_info` PID 完全一致，`stop()` 后新 named-pipe
连接在 500 ms 内被拒绝，exact PID 退出，token 未出现在 argv 或捕获日志。

同一 packaged entry/addon/node_modules 的 live smoke 均 exit `0`：

- pointer：移动、零滚轮、位置观察/恢复、hold 中断和 Helper clean exit 全部通过；
- clipboard：文本读取、marker 写入/读回、原文本恢复复核和 Helper clean exit 全部通过；
- screen：display/window WGC、遮挡等价、`capture_app`、`state_image`、最小化固定失败、
  光标恢复及 Helper/fixture clean exit 全部通过；
- canonical tool surface：30-tool 覆盖有效，28 个非剪贴板 observation/display/pointer/
  keyboard/semantic/focus/runtime 工具通过；clipboard 两项由 companion smoke 覆盖。

本机没有发布证书，不能把上述 ABI/resources 验收外推为最终 branded/signed executable
验收。CI/签名机构建仍必须完整跑完 `rcedit -> .node/.dll/exe 签名 -> afterPack`，并再次
执行 branded exe 生命周期测试；不得为本地验收关闭 Windows Application Control。

## 明确不做

- 不控制或新增 SSH、WSL、Docker、远程 workspace、手机 `/remote` runtime。
- 不为 Windows 新建独立 Helper 下载器、安装器或自动更新器。
- 不新增 Windows 管理员提权；高完整性目标继续 fail closed。
- 本阶段不承诺 HDR/ICC 精确色彩管理；WGC 的普通桌面捕获正确性沿用源码阶段结论。

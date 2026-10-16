# Embedded Search Native Build Spec

## 目标

ZCode 的 Bash embedded search 分支最终需要消费随发行包分发的原生搜索程序，而不是依赖用户机器预装的 `find`、`grep`、`rg` 或通过 Node 子进程再次转发到系统命令。

本阶段完成 macOS、Linux 与 Windows 构建和执行接入：`bfs`、`ugrep` 从固定版本源码构建，所有目标的 `rg` 统一使用 Microsoft `ripgrep-prebuilt v14.1.1-1`。macOS、Linux 和 Windows x64 均提供真实 Bash embedded-search E2E 独立验证入口，但正式 desktop 打包不运行行为 E2E；Windows arm64 当前只保留既有 x64 runner 交叉构建并执行 PE 静态门禁，不冒充目标架构运行时 E2E。tool exposure 和 provider-visible prompt 不因执行 backend 切换而改变。

跨平台目标能力与当前发行启用状态必须分开管理：

| 平台            | 目标包内工具                                       | 当前发行启用 |
| --------------- | -------------------------------------------------- | ------------ |
| macOS arm64     | `bfs`、`ugrep`、`rg`                               | 是           |
| macOS x64       | `bfs`、`ugrep`、`rg`                               | 是           |
| Linux x64/arm64 | `bfs`、`ugrep`、`rg`                               | 是           |
| Windows x64     | `ugrep.exe`、`rg.exe`；`find` 回退 Git Bash/system | 是           |
| Windows arm64   | `ugrep.exe`、`rg.exe`；`find` 回退 Git Bash/system | 是           |

Windows 不提供原生 `bfs`：ZCode 不自行移植 Windows `bfs`，也不把上游 Unix `bfs` 包装成伪原生产物。

Linux desktop/SEA 与 Linux remote 共用同一份 native-search release plan：`bfs` 继续消费
`v4.1.1-2`，`ugrep` 与其他平台统一消费 `v7.8.4-1`，`rg` 消费 Microsoft
`v14.1.1-1`。Darwin remote 继续只部署历史 `rg 13.x`，不能被 Linux release plan
隐式改写。

## 用户开关与 Session 生命周期

设置页「常规」的终端设置区提供 `nativeSearchEnhancementsEnabled` 开关，默认启用。该开关只控制 Bash startup prelude 是否把 `find` / `grep` 映射到 `bfs` / `ugrep`，不控制原生产物准备、`rg` fallback、Glob/Grep tool exposure 或 provider-visible tool matrix。关闭后 Bash 自然使用当前 shell 的 system `find` / `grep`；Windows 仍不提供 `bfs`。

设置值是根 Session runtime 的启动偏好，不是 turn metadata，也不写入 Session history、queue、runtime snapshot 或 shell init snapshot：

- 新建根 Session 与真正 cold resume 在 runtime 物化时，通过 `session/requestRuntimePreferences` 向所属 Host 读取一次当前值。
- 已存在 runtime 的 active resume 不重新读取，保持当前 runtime 的值。
- fork、selection side chat 与 subagent 继承父 runtime 的值，不再次读取 Host。
- 开关切换不热更新正在运行或仍 active 的 Session；新建或真正 cold resume 的 Session 才使用新值。
- `rowsRange`、`plans`、`fileChanges`、`fileRewindPreview`、`attachmentBegin` 和 `subscribe` 只是 cold resume 的触发入口，全部进入同一个 singleflight materialization，不携带设置字段。

设置权威与远程链路固定为：

```text
Desktop-local SettingService
        ^
        | typed blocking runtime-preferences request
Desktop shared Host
        ^
        | service-scoped Agent RPC, correlated by requestId
desktop-attached remote Host
        ^
        | ZCode Protocol reverse request
Agent root runtime materialization
```

本地 workspace 和 standalone server 由所在 Host 直接读取自己的权威 `SettingService`。desktop-attached SSH/WSL/Docker workspace 由远端 Host 把请求桥接到 desktop shared Host，再读取桌面本地设置；手机 `/remote` 复用同一个 shared-host attachment，不创建独立 runtime 或设置副本。relay 与 desktop main 只透传，不保存这项业务状态。

`session/requestRuntimePreferences` 使用严格 schema，并以 `scope` 区分 `runtime-materialization` 与 `user-execution`。本节只消费前者的 `nativeSearchEnhancementsEnabled`。每次请求最多等待 15 秒；Host 保持连接但未响应时按超时错误阻止本次 runtime 物化。旧 Host 返回 `-32601`，或 Agent 尚未连接 Host 返回 `-32020` 时，为兼容旧版本默认启用；非法响应、设置 resolver 异常、超时和其他传输错误都不能静默改成启用。

## 版本基线与安全偏离

内嵌搜索工具的版本与构建基线：

- `bfs 4.1.1`。
- `bfs` 按以下顺序使用 configure flags：`--enable-release --with-oniguruma --without-libselinux --without-libacl --without-liburing --without-libcap`，并支持固定前置参数 `-S dfs -regextype findutils-default`。
- 早期基线是 `ugrep 7.5.0`；ZCode 有意升级到 `ugrep 7.8.4`，获得 DFA
  state/edge 与 position-set 复杂度上限，避免恶意或意外的复杂正则在编译阶段耗尽内存。
  这是安全偏离，不得表述为沿用早期二进制版本。
- `ugrep --version` 必须暴露 `-z:zlib,bzip2,zstd,brotli,7z,tar/pax/cpio/zip`；macOS 使用 `-P:pcre2`，Linux 和 Windows 使用 `-P:pcre2jit`。
- PCRE2 JIT 按平台分支配置：macOS 关闭，Linux 和 Windows 开启。`win32-x64` / `win32-arm64` 都必须包含 Windows feature 分支。
- 所有 desktop/SEA 平台的 `rg` 统一固定为 Microsoft `ripgrep-prebuilt v14.1.1-1`，运行时版本必须为 `ripgrep 14.1.1`，并且必须暴露 `features:+pcre2` 和 PCRE2 10.43；JIT 可用性继续由目标平台能力决定。除 Linux arm64 musl 归档不暴露 revision 外，其余目标必须输出上游 revision `4649aa9700`。归档内容身份由固定 SHA-256 保证，不能为补齐展示字符串包装或修改二进制。
- 最终产物不得依赖 Homebrew 或构建目录中的动态库。macOS 上 `bfs` 只允许链接系统 `libSystem`；`ugrep` 只允许链接系统 `libSystem` 和 `libc++`。
- native search sidecar 沿用各平台既有打包边界：macOS 产物的 deployment target 不得高于 Electron 41 的 macOS 12.0；Linux `bfs` / `ugrep` 的最高 GLIBC symbol version 固定为 `GLIBC_2.28`，producer 必须实际运行 Node 24、glibc 2.28、GCC 12 与 G++ 12；Windows x64/arm64 产物不得动态依赖构建契约明确要求静态链接的 CRT、PCRE2 与压缩库。

Linux 的兼容性门禁检查最终 ELF 的 `readelf --version-info`，按数字版本比较全部
`GLIBC_x.y[.z]` 引用。`bfs` / `ugrep` 必须至少包含一个可解析的 GLIBC 引用，且最大值不得高于
`2.28`；Microsoft musl `rg` 允许没有任何 GLIBC 引用。只检查构建容器的
`getconf GNU_LIBC_VERSION` 不足以证明最终产物兼容，产物 gate 不能省略。

## 预编译资源分发

普通 desktop/SEA prepare 与本地开发流程不在下载失败后现场编译 native search tools。自产 `bfs` / `ugrep` 归档与 Microsoft `ripgrep-prebuilt v14.1.1-1` 原始归档统一从 `${ZCODE_DEPS_BASE_URL}/native-search-tools` 下载。平台打包 CI 在执行 prepare 之前可运行一次 deps ensure：它根据同一份 `platform-arch` release plan 直接检查 runner 映射的共享 deps 文件系统；producer 归档缺失时，受信任流水线在当前目标 toolchain 上构建、验证、确定性打包，并以临时文件加同目录 rename 发布到共享 deps。所有 producer 归档都必须在 release plan 中配置 `archiveSha256`，并在复用、发布和下载前严格校验；摘要缺失或不匹配时立即失败，不能继续打包。ensure 默认拒绝补产，只有 protected ref 或显式设置 `ZCODE_NATIVE_SEARCH_ALLOW_PUBLISH=1` 的受信任入口才进入写入分支；仓库内 macOS、Linux、Windows 三个平台打包 template 是授权的共享 deps 写入入口。同一 `platform-arch` 的打包 job 必须使用 GitLab `resource_group` 跨 pipeline 串行，避免两个 producer 同时发布同一个固定版本路径；不同目标仍可并行。已存在的版本归档不可覆盖；若人工调用期间看到目标已出现，只能在内容摘要相同时接受。

上述 ensure 不是 downloader fallback：Microsoft `rg` 缺失必须立即失败，不能改为自产或重新打包；HTTP 超时、非 200、SHA-256 缺失或不匹配、解压失败或二进制校验失败也必须终止当前构建，不能触发 producer。Microsoft `rg` 与自产 `bfs` / `ugrep` 的全部正式归档都必须在 release plan 中固定 SHA-256，并在解包前校验。尚未准备且未由受信任 CI 补产的 producer 资源，其默认 URL 必须 404，不能用其他平台的产物补位。内网 `rg` 只镜像 Microsoft release 的原始字节，不重命名、不重新打包。

下载器默认直连 `${ZCODE_DEPS_BASE_URL}` 内网镜像。只有 `github.com` 与其 `githubusercontent.com` release 重定向主机允许读取构建环境的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`；其他主机不隐式进入代理。所有下载都必须在连接长期无响应时明确失败，不能让无法直连 GitHub 的构建机无限等待，也不能让内网依赖地址被外部代理劫持。

新增资源统一放在 `${ZCODE_DEPS_BASE_URL}/native-search-tools` 下，并按工具独立版本化：

```text
native-search-tools/
  bfs-v4.1.1-1/
    bfs-v4.1.1-1-aarch64-apple-darwin.tar.gz
    bfs-v4.1.1-1-x86_64-apple-darwin.tar.gz
  bfs-v4.1.1-2/
    bfs-v4.1.1-2-aarch64-unknown-linux-gnu.tar.gz
    bfs-v4.1.1-2-x86_64-unknown-linux-gnu.tar.gz
  ugrep-v7.8.4-1/
    ugrep-v7.8.4-1-aarch64-apple-darwin.tar.gz
    ugrep-v7.8.4-1-x86_64-apple-darwin.tar.gz
    ugrep-v7.8.4-1-aarch64-unknown-linux-gnu.tar.gz
    ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz
    ugrep-v7.8.4-1-x86_64-pc-windows-msvc.zip
    ugrep-v7.8.4-1-aarch64-pc-windows-msvc.zip
  ripgrep-v14.1.1-1/
    ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz
    ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz
    ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz
    ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz
    ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip
    ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip
```

Microsoft 预编译归档的上游下载地址为 `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v14.1.1-1/`。内网静态服务的目标目录固定为：

```text
/Users/dev/shared/zcode/deps/native-search-tools/ripgrep-v14.1.1-1/
```

对应默认 HTTP base URL 为 `http://intranet.example.invalid:12345/zcode/deps/native-search-tools/ripgrep-v14.1.1-1/`。需要原样镜像的归档为：

| 目标          | Microsoft 归档                                        | SHA-256                                                            |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| macOS arm64   | `ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz`       | `84ff9b227b9aad651be0ac4cf7802a190015bfba3dfa6b015cc7aa89dd8c5c2b` |
| macOS x64     | `ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz`        | `cfedd7993342bc5f90310ce73a00cbf5d3b5237654c9bfc18b383f0e829f3b11` |
| Linux arm64   | `ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz` | `98c0371366a9db920ed6c196083e8030511055e5f128b3bde2ca56bbddf85b9a` |
| Linux x64     | `ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz`  | `1154dd91f7b144cee490b91f1ab27ce04f8f01d8876cde2d9c0eff845c8ab012` |
| Windows x64   | `ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip`        | `ede1d7f533f30d7e2870f77139d0fb9d7591daad5260b80d6a525e0bb5bd440e` |
| Windows arm64 | `ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip`       | `88660d96f822d2e0329e254031068e82028f9c13efcec9b2d78c5a19d3f9ac47` |

自产归档已固定或待 producer 回填的摘要为：

| 目标          | 自产归档                                          | SHA-256                                                            |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| macOS arm64   | `bfs-v4.1.1-1-aarch64-apple-darwin.tar.gz`        | `696f73eaff50d3c3de8a8ee36746a89693dd6ff0d010b05cd3b4b3eb2a369781` |
| macOS arm64   | `ugrep-v7.8.4-1-aarch64-apple-darwin.tar.gz`      | `01ea803e3fc3b94e796a9376e4d062a5490fe08e5760c6173e72b8f31546a4f3` |
| macOS x64     | `bfs-v4.1.1-1-x86_64-apple-darwin.tar.gz`         | `d993d72530749fa777339a7546f03338499abf235e2147d4adcd086641c6376f` |
| macOS x64     | `ugrep-v7.8.4-1-x86_64-apple-darwin.tar.gz`       | `6a2bedd9ccf53a2ac574d2fa498a36dcbe21e957b40442f9493180c6dad4dea9` |
| Linux arm64   | `bfs-v4.1.1-2-aarch64-unknown-linux-gnu.tar.gz`   | `dabdde935a02f89dd0c48c5cd0ec756a87d300fd5ace85a78e6a9eb51d771118` |
| Linux arm64   | `ugrep-v7.8.4-1-aarch64-unknown-linux-gnu.tar.gz` | `bf3b99c0af41f50c0ec3031b32ab8f67fa95b5581add18fad5163ece978d31ba` |
| Linux x64     | `bfs-v4.1.1-2-x86_64-unknown-linux-gnu.tar.gz`    | `9adf5759000021dd8fcd99670461cc43863f9172fb16f2f9a3e49c700311e7a0` |
| Linux x64     | `ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz`  | `13732f50fe63da07f3472f627f611b75359153163d07a0eb01e7c54125ae930e` |
| Windows arm64 | `ugrep-v7.8.4-1-aarch64-pc-windows-msvc.zip`      | `e9de73f1b542105203d586b19b4d57b8ecf2bf780f23e86c66a0fb7f56d51024` |
| Windows x64   | `ugrep-v7.8.4-1-x86_64-pc-windows-msvc.zip`       | `7bbd8e56540d2019a343688f1fc0ddb2ff5f0988090c577d2b9d6f4a8a86be21` |

`<tool>-v<version>-<revision>` 中的 revision 只在同一个上游版本下因编译方式或二进制内容变化时递增，不随 ZCode CLI 版本变化。`bfs 4.1.1` 的 Linux 产物因 GLIBC 构建基线变化保留 `-2`；`ugrep` 上游版本升级后，所有平台从新的 `v7.8.4-1` namespace 开始，Linux 不继承旧版 `v7.5.0-2` 的 revision。历史 remote `rg` resource 仍单独消费 `${ZCODE_DEPS_BASE_URL}/ripgrep-v13.0.0-10`；该兼容资源不属于新的 desktop/SEA embedded-search release plan，也不能作为其版本 fallback。

固定归档摘要用于确认下载内容身份；下载后的二进制仍必须通过版本、feature、架构、动态依赖校验，Linux producer 产物还必须通过 GLIBC 2.28 ceiling 校验。`.bundle-meta.json` 同时记录归档摘要和实际二进制摘要：前者使摘要变化后的旧缓存失效，后者用于本地缓存一致性；两者不能互相替代。

下载或 producer 构建成功后，每个工具目录写入与预编译 release 对应的 `.bundle-meta.json`。后续 prepare 只有在二进制存在、实际 SHA-256 与 metadata 一致，且 metadata 中的工具、版本、release、目标平台和文件名全部匹配时才能跳过；Unix 主机上的目标二进制还必须保留可执行权限，若仅权限丢失则原地恢复后复用，不重复下载。历史 rg 13 等无 metadata、内容校验失败或 metadata 不匹配的残留必须按当前 release 重新下载，不能仅凭固定输出路径存在就复用。

producer 仍可作为显式人工流程使用：在对应平台的 producer runner 上执行 `pnpm run pack:native-search`，默认从锁定源码构建、验证并打包当前 host 的 `platform-arch` 自产集合，然后在 `dist/native-search-tools-deps/native-search-tools` 生成与上述静态目录完全一致的文件树。平台打包 CI 通过 `pnpm run ci:ensure-native-search-deps` 复用同一 producer；它只在共享 deps 缺少当前目标归档时构建，并先输出到 job 临时目录，再发布缺失文件。后续正式 prepare 必须重新从内网 HTTP 路径下载刚发布的归档，使首次补产流水线也覆盖真实分发与解包路径，不能直接复用 producer 的本地 binary 输出跳过下载。

所有 producer 都只处理 `bfs` / `ugrep`，不构建或重新打包 Microsoft `rg`。Linux 必须在目标架构原生构建，macOS 必须在 macOS 上构建；Windows 沿用既有 x64 MSVC runner，并通过 CMake `-A x64` / `-A ARM64` 生成对应架构的 `ugrep.exe`。已支持的显式目标可通过 `pnpm run pack:native-search -- --platform <platform> --arch <arch>` 选择。发布前由 prepare 从内网镜像下载 Microsoft `rg` 并对所有 Windows 目标执行 PE machine/import 静态校验；仅 host/target 同架构时执行完整运行时 E2E。普通 `prepare:native-search` 只负责下载，不能调用 producer 或写入共享 deps。

`rg` 的来源按目标固定，不做运行时探测：macOS arm64/x64 使用仅依赖系统库、deployment target 分别为 11.0/10.12 的 Microsoft 归档；Linux arm64/x64 使用无 glibc 动态依赖的 Microsoft musl 静态归档；Windows x64/arm64 使用通过 PE machine/import gate 的 Microsoft MSVC 归档。`rg` 与 `find` / `grep` 的 shell 策略不同：`find` / `grep` 在 embedded branch 中无条件 shadow 为 `bfs` / `ugrep`，`rg` 只在当前 shell 找不到可执行 `rg` 时补随包原生实现，不能覆盖用户已有的系统 `rg`。

### 归档来源：内网镜像与仓库内置归档

`scripts/prepare-native-search-tools.mjs` 是 desktop `prepare:native-search`、SEA、server-cli staging 与 remote 资产准备共用的唯一入口。来源由 `resolveNativeSearchArtifactSource(env)` 一次判定，调用方不自行判断：

| 条件 | 来源 | 行为 |
| --- | --- | --- |
| 设置了 `NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL`，或 `resolveIntranetDepsBaseUrl(env)` 能解析出地址 | `intranet` | 原样调用 `downloadNativeSearchTools`：URL、代理、SHA-256、bundle meta 与缓存跳过语义均不变；remote Linux/macOS 仍分别执行既有的 `download-native-search-tools.mjs` 与 legacy rg13 `download-ripgrep.mjs` 命令 |
| 内网依赖源未配置（解析抛错或为空） | `repository` | 先校验 `apps/zcode-cli/dependencies/native-search` 中本次 plan 全部归档的 SHA-256，再逐个解包、做目标架构校验并写 bundle meta；不下载、不回退镜像 |

- 本仓库的 `intranetDefaults.mjs` 带默认内网地址，因此默认总是 `intranet`，内网构建与 CI 行为不变；仓库归档只在依赖源确实未配置的环境（例如导出后的开源树）生效。
- 仓库归档与内网镜像同名、同 SHA-256，release plan 同时给出 `downloadUrl`（仅 `intranet`）与 `archivePath`；两种来源不能混用或互为失败兜底，任一路径校验失败都直接终止。
- remote 资产使用 `resolveRemoteNativeSearchPrebuiltPlan`：Linux 与 desktop/SEA 同一 plan，macOS 保留 rg13；legacy rg13 的版本与摘要仍由 `native-search-tools-config.mjs` 唯一持有。
- 两种来源在返回前都通过 `stageNativeSearchNotices` 在每个工具目录写入 `THIRD-PARTY-NOTICES.txt` 与 `SOURCES.json`（`binary.origin` 分别为 `intranet-mirror` / `repository-archive`），缓存命中也刷新；remote 组件在计算内容哈希前完成写入，因此组件归档自带材料。
- 解包、定位与归档验真只有 `prebuilt-binary-extract.mjs` 一份实现，下载链路复用它；Windows 上 tar 参数统一使用正斜杠并优先相对 cwd 的归档路径，避免 GNU tar 把盘符当成远程主机。
- producer 打包（`pack:native-search` / `ci:ensure-native-search-deps`）仍只打入二进制，保持与已固定 SHA-256 的归档逐字节可复现。

## 源码与依赖

构建入口必须固定源码提交或 release 版本，并在解包前校验 SHA-256。三平台构建共享以下版本源：

| 组件      | 固定版本                                           | 用途                        |
| --------- | -------------------------------------------------- | --------------------------- |
| bfs       | 4.1.1 / `f220fb5afd8dd7f46b1d1a2ae9c36261eaccf3cd` | `find` backend              |
| ugrep     | 7.8.4 / `550599a6434fc5315fb6ecd415a5d859e6d846a8` | `grep` backend              |
| Oniguruma | 6.9.10                                             | bfs 的 GNU find regex 语义  |
| PCRE2     | 10.43                                              | ugrep `-P`                  |
| zlib      | 1.3.1                                              | ugrep gzip/zip/archive 支持 |
| bzip2     | 1.0.8                                              | ugrep bzip2 支持            |
| zstd      | 1.5.6                                              | ugrep zstd 支持             |
| Brotli    | 1.1.0                                              | ugrep Brotli 支持           |

这些依赖只参与构建并静态链接到目标程序，不作为最终 runtime sidecar 单独分发。

GitHub commit archive 不携带 `.git`，bfs 4.1.1 的 `build/version.sh` 会因此回退成 `4.1`。producer 必须通过构建环境 `VERSION=4.1.1` 固定 patch version，不能传 `./configure --version=4.1.1`；后者会污染 `bfs --version` 的 `CONFFLAGS` 输出。

TODO：全部平台的 native build 与 E2E 接入完成后，将上述锁定源码归档同步到 ZCode 内部依赖源，并为 source downloader 增加专用镜像地址解析；在镜像产物准备完成前继续使用官方 URL 与 SHA-256 校验，不能把源码文件名直接假设为现有 `ZCODE_DEPS_BASE_URL` 下的资源。

可观察基线只覆盖 `bfs` / `ugrep` 顶层版本、Oniguruma 开关、`ugrep` feature set，以及 ripgrep/PCRE2 能力。Microsoft 归档来自同一 ripgrep 14.1.1 上游版本，不要求 build identity 逐字节一致；当前目标是相同版本、feature set、参数行为和动态依赖边界。表中的传递依赖版本是为可复现构建固定的兼容版本。

## 构建边界

- source manifest、SHA-256 校验、下载/解压、CLI 参数解析、输出 plan 和行为 E2E 属于跨平台共享层。
- `bfs`、`ugrep`、`rg` 的版本号只能在共享 manifest 中声明一次；各平台 builder、Microsoft 归档映射、产物 verifier 和各平台 source plan 必须复用该版本源，不能维护互相漂移的版本常量。
- macOS/Linux 的静态依赖、`bfs` 和 `ugrep` 构建属于 Unix 共享层；平台只提供 compiler toolchain、预处理 flags 和原生依赖校验。
- Microsoft `rg` 不参与任何 producer，也不复用 ugrep 的 PCRE2 build。Linux 继续使用固定 SHA-256 的 musl 归档。
- Windows `ugrep.exe` 使用独立 MSVC/CMake builder，并通过 `-A x64` / `-A ARM64` 选择目标；固定的 ugrep 源码是无 BOM UTF-8，MSVC 必须显式使用 `/utf-8`，不能依赖 runner 当前用户代码页解释源码。`rg.exe` 直接来自固定 SHA-256 的 Microsoft 对应架构 MSVC 归档。两者复用下载 plan 与 PE 静态 verifier；x64 目标保留独立行为 E2E，arm64 目标沿用既有 x64 Windows 交叉构建链。
- Windows 构建固定使用静态 MSVC runtime，并静态链接 PCRE2、zlib、bzip2、zstd、Brotli 和 ugrep 自带的 7zip decoder。最终 PE 必须拒绝 `VCRUNTIME*.dll`、`MSVCP*.dll` 和 `ucrtbase.dll` 等动态 CRT，以及上述本应静态链接的构建依赖。
- Linux producer 的放行依据是实际工具链能力，不是具体镜像身份：构建脚本必须在下载源码前检查 Node major 为 24、builder glibc 为 2.28、`CC` 的 GCC major 与 `CXX` 的 G++ major 都为 12，最终产物再通过 GLIBC symbol gate。macOS 的 Apple Silicon runner 允许使用系统 clang 的 `-arch x86_64` 构建 x64 sidecar，并通过 Rosetta 执行 configure probe；独立 E2E 入口同样可通过 Rosetta 验证 x64 产物，但不嵌入正式打包 job。ugrep configure 必须显式使用 `x86_64-apple-darwin` host，避免把 arm64 runner 身份写入 x64 产物。x64 继续由上游 compiler probe 启用 baseline SSE2 并禁用 AVX2。其他未经验证的 Unix 交叉编译继续拒绝。
- Linux seed/rebuild 由开发机本地 Docker 分别以 `--platform linux/arm64` / `--platform linux/amd64` 启动目标架构容器，并在容器内使用统一入口 `pnpm pack:native-search -- --platform linux --arch <arm64|x64>`；当前可复现基线是 Rocky Linux 8 的 glibc 2.28、Node 24 与 GCC Toolset 12。macOS 与 Windows 仍由各自平台打包机产出。`ci:ensure-native-search-deps` 在当前 runner 满足 Node 24 / glibc 2.28 / GCC 12 / G++ 12 门禁时复用同一打包实现补产，不要求仓库提供额外 Dockerfile 或平台专用 wrapper；镜像名称本身不替代上述运行时门禁与固定归档 SHA-256。
- macOS 自产 `bfs` / `ugrep` sidecar 的 deployment target 固定为 `12.0`；Microsoft `rg` 的 deployment target 可以更低但不得高于 `12.0`。构建校验必须同时读取 Mach-O `LC_BUILD_VERSION.minos` 与旧式 `LC_VERSION_MIN_MACOSX.version`，禁止任何工具提高 Electron 41 的最低 macOS 版本。
- macOS `bfs` 必须屏蔽 macOS 26 SDK 新增的标准 `posix_spawn_file_actions_addfchdir()`，让上游继续选择从 macOS 10.15 可用的 `posix_spawn_file_actions_addfchdir_np()`；同时注入 `-Dfdclosedir=__bfs_poison_fdclosedir_macos_26_4`。两者都用于防止新版 SDK 的 configure probe 让 deployment target 为 12.0 的产物弱导入更高系统版本才存在的符号。
- Linux `ugrep` 必须静态链接 GCC/C++ runtime；最终依赖白名单不得接受
  `libstdc++.so`、`libgcc_s.so`、`libc++.so` 或 `libc++abi.so`，避免构建参数回归后仍通过
  verifier，并把 GLIBCXX/CXXABI 兼容性风险带入发行包。
- x64 `ugrep` 使用 baseline CPU 配置，禁用 AVX2/AVX512；arm64 使用目标编译器的 NEON 路径。
- macOS 构建依赖 Xcode Command Line Tools、系统 `make`、`curl` 和 `tar`，不要求 Cargo/Rust 或 Homebrew library。Linux 构建依赖 binutils、`make`、`curl`、`file` 和 `tar`，同样不要求 Cargo/Rust；`CC` / `CXX` 可显式覆盖，但脚本必须分别执行实际 compiler 的版本探测，两个 major 都必须是 12。Windows producer 只构建 `ugrep.exe`，依赖 VS 2022 Build Tools、CMake、`curl` 和 `tar`；arm64 target 还要求对应的 MSVC ARM64 toolset。
- 默认输出位置沿用 desktop runtime asset 结构：
  - `packages/desktop/bundled-tools/darwin-<arch>/{bfs,ugrep,ripgrep}` 由 native search 预编译下载链路准备。
  - `packages/desktop/bundled-tools/linux-<arch>/{bfs,ugrep,ripgrep}` 由 native search 预编译下载链路准备。
  - `packages/desktop/bundled-tools/win32-<arch>/{ugrep,ripgrep}` 由 native search 预编译下载链路准备。
- desktop host 和 Linux remote server 通过现有 runtime tool resolver 发现各平台已启用的产物，并把绝对路径投影为对应的 `ZCODE_BFS_BINARY`、`ZCODE_UGREP_BINARY`、`ZCODE_RG_BINARY`。Windows 不生成也不投影 `ZCODE_BFS_BINARY`，`find` 继续走 Git Bash/system；已发现工具的所在目录追加到 Agent runtime 的 `PATH`，保留用户命令优先级。
- SEA 仍按 target 交付单一可执行文件，不能把 `bfs`、`ugrep`、`rg` 作为同目录 sidecar 交付。构建时把当前 target 已启用的原生工具及 manifest 写入 SEA assets；运行时首次读取 asset 并解压到 `ZCODE_STORAGE_DIR`（默认 `~/.zcode`）下的 `cache/runtime_tools`。
- `pnpm build:sea` 保持既有 all-target 契约并显式传入 `--all`。各目标平台的 producer 必须先构建、验证并发布预编译归档；SEA 构建再按同一 release plan 为每个 target 下载、校验并准备 `packages/desktop/bundled-tools/<platform>-<arch>` 后统一消费。缺少 foreign target 工具时必须 fail-closed，不能把公开命令降级成 host-only。host E2E 使用底层 `sea --target <host-target>`，不改变发行入口。
- SEA runtime tool 缓存必须按 `<target>/<tool>/<tool-version>-<binary-sha256>` 定位，不能包含 CLI 版本。多个 CLI 版本携带完全相同的工具版本和二进制内容时必须复用同一份缓存；单个工具升级时也不能迫使其他未变化工具重复解压。
- SEA 解压必须逐文件校验 manifest 中的 SHA-256，写入同级临时目录后原子替换，并恢复可执行权限。并发首次启动必须收敛到同一缓存目录；已完成且 marker、文件大小、实际 SHA-256 和可执行权限均有效的缓存直接复用。
- SEA runtime tool manifest 只描述目标平台、工具 id、工具版本、二进制名称、大小和 SHA-256。缓存路径和 manifest 均不得依赖 ZCode/CLI 版本；非 SEA 的 desktop、源码 CLI 和 remote runtime 继续沿用各自现有发现链路。
- Windows x64/arm64 SEA 内置 `ugrep 7.8.4` 和 `ripgrep 14.1.1`；`find` 继续回退 Git Bash/system。两个架构都必须通过 PE 目标格式和静态依赖校验，x64 另有独立真实运行时 E2E；arm64 在可用的目标机器上完成同等 E2E 前仍是明确的待验证项，不能因为 SEA 支持解压任意工具就宣称已完成目标架构运行验证。
- runtime tool resolver 接受的 env 必须贯穿显式二进制路径、server runtime root 和 PATH 查找，不能一部分读取参数、一部分隐式读取全局 `process.env`。
- desktop 本地二进制定位信息与 remote resource package 的部署版本是两类 metadata。Linux remote manifest 显式复用同一份 native-search release plan，发布 `bfs-v4.1.1-2`、`ugrep-v7.8.4-1` 和 Microsoft `ripgrep-v14.1.1-1`；Darwin remote 继续发布历史 `ripgrep-v13.0.0-10`。remote producer 必须按目标平台显式选择这两条依赖链，不能让 desktop release plan 隐式改写 Darwin remote，也不能删除历史 release 资产。
- Agent 默认 embedded-search backend 直接持有 `bfs` / `ugrep` / `rg` 三个原生程序路径。Bash prelude 不再通过 `__internal-search` 启动 Node 转发层；`bfs` / `ugrep` 不可执行时分别回退系统 `find` / `grep`；shell 已有可执行 `rg` 时保持不变，缺失时才补直接执行随包 `rg` 的函数。
- `find` 固定参数必须按 `-S dfs -regextype findutils-default "$@"` 排列。
- `grep` 固定参数必须按 `-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl "$@"` 排列；默认参数在前，用户参数在后。
- `grep` 遇到 `-*-filter*`、`-*-pager*`、`-*-view*`、`-*-format-open*`、`-*-config*`、`---*`、`-@*`、`-*-save-config*`、`-[Zz]*`、`-[!-]*[Zz]*`、`--null` 或 `--null-data` 时绕过 `ugrep`，直接调用系统 `grep`；后四组用于保留 GNU grep 的 null-data/短选项语义，与 ugrep 的压缩选项不同。
- 需要通过 embedded `grep` 触发 ugrep 解压时使用 `--decompress`；`-z` / `-Z` 及 `--null` / `--null-data` 保留给 system grep 兼容路径。
- Bash 中的 `rg` fallback 不添加默认 flags，只把用户 `"$@"` 原样交给包内 ripgrep；内部文件搜索调用使用的 `--no-config` 等参数不属于 Bash shell function contract。
- E2E 可以通过 `--output-dir` 写入临时目录，不能污染正式 runtime asset。
- 下载、编译和中间依赖都位于独立临时工作目录；成功或失败后默认清理。写入二进制元数据的依赖 flags 必须使用稳定的相对路径，不能记录随机临时目录，否则同一 target、同一工具版本的 SHA-256 会发生漂移；仅显式调试参数可以保留工作目录。
- 构建产物不提交到 Git。开发态 `pre-dev` 通过与发行构建相同的版本、feature、架构、ABI
  verifier 判断本地 native-search sidecar 是否有效；文件缺失或校验失败时重新准备产物，不能
  只按路径存在判定 ready。desktop 出包流程在构建阶段准备产物；已安装应用的 runtime 不做
  源码下载或现场编译。
- desktop prepare、缺失资产检测和 `extraResources` 必须读取同一份 `platform-arch` release plan。新增目标通常只有在真实构建与独立 E2E 验证通过后才能加入发行启用集合，不能因为同一 OS 的另一个架构通过就整体启用；已启用目标的每次正式打包不重复运行行为 E2E。Windows arm64 是本轮明确恢复的既有交叉发布分支；它的 PE 静态门禁不能被记录为已完成运行时 E2E，后续仍需在目标机器补验。
- 预编译产物必须先在临时解包路径通过 Mach-O / ELF / PE 格式和目标架构静态校验，再覆盖正式路径并写入 bundle metadata。bundle metadata 只校验本地文件后续是否变化，不能把下载文件自身计算出的 SHA-256 当作来源可信证明；已有 metadata 的缓存也必须重新通过目标校验才能跳过下载。
- release plan 必须显式区分 native build 输出与 Electron 动态打包的 sidecar；desktop/SEA 调用方不能再拼接平台特有的 legacy ripgrep 下载分支。
- macOS arm64/x64 desktop 发行包都通过 `extraResources` 携带对应架构的 `bfs` / `ugrep` / `rg` sidecar，并统一复用 bundled-tools 签名与公证链路。两个 macOS 出包 job 只执行资产 verifier、签名和公证，不在签名前运行 Bash toolcall E2E。第三方 license notice 仍属于正式发行前的合规清单；临时 E2E 产物不进入发行包。
- 所有平台的 prepare 都必须下载固定 SHA-256 的 Microsoft `rg 14.1.1` 归档；producer 不得产出 `rg`。desktop prepare 与缺失资产修复不得调用 legacy `prepare:rg` 下载链路。
- Linux x64/arm64 CI job 必须分别进入与目标架构一致的执行环境；可以是原生 runner，也可以是
  `docker --platform` 明确选择的目标架构环境。runner tag 或镜像名称本身不作为放行依据，
  构建进程看到的 arch、实际 Node/glibc/CC/CXX 门禁以及最终 ELF 架构/ABI 校验必须全部匹配。
- 正式 `build:windows:x64` / `build:windows:arm64` 继续复用既有 `windows` runner；当前 x64 runner 交叉生成 arm64 Electron/NSIS 与 native-search 产物。两个目标都必须直接读取 PE header 和 import table 校验 machine 与静态 runtime，但打包 job 不执行完整运行时 E2E。

## Linux remote 与 WSL 资源边界

Linux x64/arm64 的 producer、共享归档和打包消费链验证完成后，Linux remote
（WSL、Linux SSH、Linux Docker）与 desktop/SEA 复用同一份 native-search release plan：

```text
Linux x64/arm64 producer
        |
        v
bfs 4.1.1-2 / ugrep 7.8.4-1 immutable archives + Microsoft rg 14 musl archive
        |
        +-------------------------+
        |                         |
        v                         v
Linux desktop / SEA       Linux remote asset manifest
                                  |
                                  v
                         bfs / ugrep / ripgrep components
        |
        v
WSL / Linux SSH / Linux Docker
  -> find: bfs 4.1.1
  -> grep: ugrep 7.8.4
  -> rg: system rg 优先，缺失时使用 bundled rg 14.1.1

Darwin remote asset manifest
        |
        v
legacy ripgrep 13 component
```

remote resource id、manifest mount 白名单、部署循环与 runtime descriptor 必须在同一个变更中
接通，不能只让 Bash prelude 看见不存在的路径。该接入复用既有 shared host 和 Agent runtime，
不创建新的 WSL Agent runtime，不改变 workspace identity，也不触碰桌面
`desktop-continuous` 与手机 `web-remote-replayable` 的交付边界。

## E2E 契约

macOS/Linux/Windows x64 E2E 是独立验证入口，默认从空临时目录调用真实 prepare。外层 runner 只负责按目标构建 producer 集合、下载 Microsoft `rg`、执行版本/feature/ABI 校验和启动一次真实 Bash toolcall E2E，不得再维护一套重复的 fixture 与行为断言。Linux 验证可以先在对应架构 producer 中生成并校验自产 `bfs` / `ugrep`，再由 prepare 补齐 Microsoft musl `rg`，最终通过 `ZCODE_BFS_BINARY` / `ZCODE_UGREP_BINARY` / `ZCODE_RG_BINARY` 把同一组正式产物交给运行 E2E；不能在两个阶段重复编译同一工具。Windows 使用自产 `ugrep` 与 Microsoft `rg`，并让 `find` 走 Git Bash/system。Windows arm64 的跨 target fixture 与 PE verifier 只证明编译、收集和静态依赖契约，不冒充目标架构运行时 E2E。toolcall E2E 必须从根 workspace 按 `@zcode/bootstrap` 的真实依赖关系构建前置 package，不能依赖工作区中预存的 `dist`。完整链路至少覆盖：

`pnpm test:sea-runtime-tools:e2e` 是 SEA 单文件交付的 host E2E：它构建当前 target 的 SEA，把产物复制到不含 sidecar 的隔离目录，验证首次解压、二次复用、版本/SHA/执行权限，再把解压路径交给同一套真实 Bash toolcall E2E。该命令不得在用户默认 storage root 留下 runtime-tool 缓存或临时目录，也不得作为 desktop Electron 打包的前置步骤。

SEA 单测中的跨 target fixture 只验证 manifest 和 asset 收集契约；它不能替代各目标平台的真实 native build、host SEA E2E 或跨平台产物聚合门禁。package-script 回归必须证明 `build:sea` 始终传入 `--all`；后续新增但尚未完成的 target 可以让发行构建明确失败，但不能改变既有命令行为。

正式 desktop 打包只由 `prepare:desktop-runtime` 生成 `bundled-tools/<platform>-<arch>` 产物，并执行版本、feature、架构、ABI、签名等机械校验后进入 Electron 打包；macOS、Linux、Windows 的打包 template 都不得调用 `pnpm test:native-search:e2e` 或 `pnpm test:sea-runtime-tools:e2e`。需要验证行为时，由独立 E2E 入口以绝对路径消费同一 release plan 生成的产物。

1. macOS/Linux 校验 `bfs --version`，Windows 校验 system `find --version`；所有平台校验 `ugrep --version` 的版本及能力串。
2. `file` 加平台检查工具校验最终随包分发的 `bfs`、`ugrep`、`rg` 的目标架构与动态依赖边界：macOS 使用 `otool -L` / `vtool -show-build`，Linux 使用 `readelf -d` 校验动态依赖并使用 `readelf --version-info` 断言 `bfs` / `ugrep` 的最大 GLIBC 引用不高于 2.28，Windows 直接读取 PE header / import table 校验 machine，并拒绝动态 CRT 与本应静态链接的 PCRE2、压缩库。
3. `bfs -S dfs -regextype findutils-default` 的目录、深度、类型、名称和 regex 查询。
4. `ugrep -G --ignore-files --hidden -I` 加 VCS 排除参数的递归搜索。
5. hidden 文件可搜索、ignore 文件和 VCS 目录被排除、binary 文件被 `-I` 排除。
6. stdin-only 搜索、无匹配退出码、非法 regex 退出码和管道被 `head` 提前关闭。
7. 用户参数中的 `-E`、`-F`、`-P` 能覆盖默认 `-G`，并验证 PCRE2 以及 gzip、bzip2、zstd、Brotli、zip/archive 解压搜索能力。
8. 默认 backend 从 `ZCODE_BFS_BINARY` / `ZCODE_UGREP_BINARY` / `ZCODE_RG_BINARY` 解析三个原生程序，并从真实 Bash tool entry 的 handler 进入 `NodeExecutionAdapter`，不能由测试手工构造 `ExecutionRequest` 跳过 toolcall 边界。
9. 至少一个完整 Bash toolcall 必须同时证明实际命中 `bfs 4.1.1`（Windows 为 system find）/ `ugrep 7.8.4` / `ripgrep 14.1.1`，并覆盖 ZCode 对 embedded search 承诺的完整集成能力：`bfs` 的目录、深度、类型、名称和 GNU find regex；`ugrep` 的递归、hidden/ignore/VCS/binary 过滤、stdin、`-E` / `-F` / `-P`、特殊参数 system grep 绕行、压缩文件和 archive、退出码及提前关闭管道；`rg` 的文件/glob、hidden、stdin、fixed string、PCRE2、退出码及提前关闭管道。
10. shell 中已有可执行 `rg` 时不得被随包 `rg` 覆盖；shell 缺少 `rg` 时直接执行 `ZCODE_RG_BINARY`，不能退回 Node、WASM 或 internal CLI 转发层。
11. toolcall E2E 必须显式关闭 execution adapter、删除 fixture/output 临时目录，并启用 Vitest async-leak 检测；构建入口成功或失败后都不能残留 build/E2E workdir、child process、timer 或未完成 promise。

这里的完整集成能力以 ZCode 实际注入的参数及其对应行为为边界，不要求穷举 `bfs`、`ugrep`、`rg` 上游 CLI 的全部独立参数。`ugrep --version` 仍需断言完整编译 feature set；行为测试至少分别执行 gzip、bzip2、zstd、Brotli，并以 zip 和 tar 代表 archive 搜索路径。

上游测试只作为源码版本升级或构建链调整时的补充证据，可通过显式构建参数运行 `ugrep make test` 和 `bfs` unit tests，不属于每次 release build 的强制 gate。正式打包门禁以固定源码/归档 SHA 和版本/feature/架构/ABI verifier 为准；目标架构上的真实 ZCode Bash toolcall E2E 作为独立验证证据，不随每次安装包构建重复执行。当前 Windows arm64 交叉构建仅通过 PE 静态校验，是提交代码后的待补发布验证，不是已完成的 E2E 证据。macOS 自带 Bash 3.2 不支持 bfs 集成测试 harness 使用的 `coproc`，因此仓库 E2E 不能依赖该 harness，而应直接覆盖 ZCode 实际使用的参数组合。

## 后续接入

macOS arm64/x64 已接入 desktop 本地 runtime asset，并分别提供对应架构的独立 Bash toolcall E2E。Linux 的 `bfs` / `ugrep` 由通过 Node 24 / glibc 2.28 / GCC 12 / G++ 12 门禁的 producer 构建，两个架构的 `rg` 均使用 Microsoft musl 静态归档；组合产物在 desktop/SEA 和 Linux remote 打包时执行版本、feature、架构、动态依赖与 GLIBC 2.28 ceiling 检查，完整 Bash toolcall E2E 独立运行。Windows x64/arm64 CI 通过 MSVC/CMake builder 生成 `ugrep.exe`、从 Microsoft release 下载对应架构的 `rg.exe`；两个目标都必须通过 PE 静态依赖检查，x64 的 Git Bash toolcall 和 SEA E2E 保留为独立验证，arm64 沿用既有交叉构建发布链。Darwin remote 暂时保留历史 rg13 component，后续迁移必须作为独立变更完成。

未携带原生产物的平台继续由 Bash prelude 回退系统 `find` / `grep`，不能回退到 Node 转发层。后续平台接入不得改变 provider-visible embedded branch 的既有契约。

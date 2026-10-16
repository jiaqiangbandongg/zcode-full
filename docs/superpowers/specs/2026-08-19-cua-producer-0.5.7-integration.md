# CUA producer 0.5.7 接入与 consumer 收敛

- 日期：2026-08-19
- 状态：已实现，等待人工 review
- producer 候选：`zcode-cua@52da434158df32f6d0825db6af1c3d263754c44c`
- 目标分支：`feat/cua-merge-0817`

## 背景

z-code 已将 Helper runtime 的事实源迁到固定的 `@zcode/zcode-cua`，但旧 producer pin 仍迫使
consumer 维护三类重复状态：

1. renderer 已不调用的 controller status/take/stop permission-service facade；
2. 恒为 true 的 ghost cursor/PiP async getter，以及没有运行时消费者的
   `--permission-mode product` / `--backend broker` 标签；
3. z-code 自行维护的 Helper app/display/executable 名称。

producer 0.5.7 已删除这些 facade/伪配置，并把稳定与 dev Helper 身份收敛为不可分割的
canonical constants。consumer 必须在同一批完成迁移，不能只改 git pin，否则会生成
“旧 app 目录与 plist + 新 executable”的混合包。

Pin 演进：`d55c5f3a` 提供 producer surface 收敛；`305df53f` 合入稳定截图点击、
Zoom/ghost cursor 与 HTTP request 生命周期；`d51e5365` 把失败启动的 Helper 身份检查/
退出证据接入强制 CI；`611304cc` 对退出等待期间的 PID 复用 fail closed，且绝不向
新身份升级发送 SIGKILL；最终 `52da4341` 在该基线上收敛 Skill 指南。consumer 只记录该
不可变最终 revision。

## 架构与发布顺序

```text
zcode-cua MR（producer）
  ├─ ports: getStatus / restartHelper
  ├─ product host: ghost=true, PiP=true, background=false
  ├─ raw broker controller protocol + lease 保留
  └─ canonical Helper identity
             │ 固定不可变 commit SHA
             ▼
z-code MR（consumer）
  ├─ Local Host 只实现 getStatus / restartHelper
  ├─ plugin-host 只校验 authority + exact socket + token
  ├─ build/package/desktop 全部消费 canonical Helper identity
  └─ wrapper / skill / lockfile 与 producer 0.5.7 同步

人工 review 顺序：先合 producer MR，再合 z-code MR；本任务不自动合并或打 tag。
```

## 契约

### Desktop 安装包运行时闭包

- `@zcode/services` 会把 producer broker 接入 Desktop main、host 与 scheduler；对应的
  `@zcode/zcode-cua` JavaScript 必须由 tsup 内联，不能在最终 bundle 中留下裸包导入。
- electron-builder 继续排除 `node_modules/@zcode/**`。不得为了修复模块解析而把 producer
  的源码、sourcemap、构建目录或 `ax_native.node` 整包复制进 `app.asar`；原生动作仍只由
  独立 Helper 承载。
- 单元测试必须对 main、host、scheduler 三个配置机械检查 `noExternal`；发布验证必须实际
  构建并启动安装包，不能只以 DMG/ZIP 生成成功作为启动成功的替代证据。

### Permission service 与 controller

- `ICuaPermissionService` 只保留 `getStatus`、`restartHelper`。
- 删除 z-code 中仅实现自身和测试引用的 `getHelperStatus`、`takeController`、`stopController`
  路由及 DTO re-export。
- raw broker 的 `controller_status` / `controller_takeover` / `controller_stop`、controller
  lease、admission、visual ownership 与 orphan reaper 全部保留。
- desktop continuous 与 web remote replayable 都继续附着同一个 window-scoped Local Host；
  本次不新增 runtime、session event、snapshot 或远端状态。

### Plugin authority

- 删除没有运行时决策消费者的 permission-mode/backend argv 注入与校验；CLI bootstrap 在调用
  producer 之前统一剥离 `--` terminator 之前的旧标签，避免混版本配置继续下传已退役 argv。
  services 仅为测试保留的 producer injection re-export 不承担这层 consumer canonicalization。
- 这项 canonicalization 与 broker 凭据注入解耦：无 socket 的显式 local-dev raw 路径及非 macOS
  透传路径也必须清理旧标签，但不得因此注入 socket/token/authority 或改变 fail-closed omit 决策。
- 清理与 canonical socket upsert 只把“不以 `--` 开头”的相邻 token 当作独立值；畸形配置中
  flag 后直接跟另一个 flag 时不得吞掉后者，也不得留下旧 socket/value 作为孤儿 positional。
- official plugin 在 import 前仍必须同时证明：official plugin id、resolver 捕获的 authority、
  与捕获值完全相等的 broker socket、非空 broker token。
- socket/token/authority 任一缺失或漂移都 fail closed；不得用 server 名称或旧标签替代。

### Helper identity 与打包

- 稳定包固定使用 `ZCode Computer Use.app`，dev 包固定使用
  `ZCode Computer Use Dev.app`，两者 executable 均为 `ZCode Computer Use`。
- dev 包的目录名、`CFBundleDisplayName` 与 broker display policy 使用
  `ZCode Computer Use Dev`；这不改变 `CFBundleExecutable`。后者必须继续使用 producer 的
  `HELPER_DISPLAY_NAME`（`ZCode Computer Use`），不得从 dev app 名反向推导 executable。
- build、electron-builder、release zip、notarize、doctor、runtime resolver 与 CI 使用同一组
  producer constants；可执行的 JavaScript 构建/开发入口直接导入 constants，shell/CI 中无法
  导入模块的字面量由单测与 `HELPER_APP_NAME` / `HELPER_DISPLAY_NAME` 机械比对，不再依靠人工同步。
  z-code 不再复制默认显示名。
- Helper CI 必须从 workspace catalog 动态读取 immutable producer SHA；提取命令本身必须由
  Node 单测按 CI 中的原始脚本文本实际执行，禁止只做字符串存在性检查。shell/YAML 中的正则
  不得双重转义 `/`，否则 Node 24 会在 native build 完成后以语法错误终止双架构 Helper job。
- feature graph 必须把 Helper build/release 作为 Computer Use 与 build-release engineering 的
  共同服务节点，并把 `ZCode Computer Use.app` / `ZCode Computer Use Dev.app` 记录为当前契约；
  旧 `cua-helper-build` seed 不得继续描述已退役的 app 名称。
- `assembleHelperApp` 不再接收 `displayName`，bundle id 一次性决定 app 目录、plist 名称与
  executable，禁止部分覆写。
- 0.5.5 legacy：旧 `ZCode CUA Helper.app` 可能留在用户目录；TCC 仍按既有 bundle id/签名身份识别。本批
  不做未经证明的目录删除或进程名 kill。
- 当前运维、签名、公证、安装与排障 runbook 必须只把 `ZCode Computer Use.app` 当作验收目标；
  旧名称只允许出现在带 `0.5.5 legacy` 标记的残留说明中，避免 `codesign` / `spctl` 静默验到旧包。

### Pin 与 skill

- workspace catalog 只保留一个 canonical `@zcode/zcode-cua` git pin。
- wrapper package/plugin/bootstrap version、最终 raster spec 的 producer commit、bundled skill
  与 `upstream.json` 必须同步到 0.5.7 候选。
- skill sync 脚本只接受一个 canonical pin，并写入明确的 upstream ref；不得要求已删除的
  helper-runtime alias，也不得把临时本地分支名写入发布 metadata。

## 测试与门禁

- 先更新/新增契约测试，再修改实现。
- service：permission facade inventory、授权状态/重启、TOCTOU final attestation、Windows
  runtime 与 UI “不自动 controller RPC”用例。
- AX read-only、Electron backend 和 Helper installer 的底层契约由 producer 单一持有；
  z-code 删除三份已漂移的镜像测试，只保留 product wiring、permission UI、Local Host 和
  packaging 的 consumer 边界测试。
- CLI/plugin：authority/socket/token 缺失与漂移 fail closed；不再出现 permission-mode/backend。
- packaging：stable/dev app、plist、executable、zip allowlist、electron-builder 资源路径、CI
  staging 路径与 producer provenance 一致；dev app 的 display name 与 executable 必须分别验证，
  防止把 `ZCode Computer Use Dev` 错当成 executable。
- operations docs 与 feature graph：所有可执行路径、签名验收命令和 build contract 指向
  canonical app；旧名只保留明确的 `0.5.5 legacy` 残留警告，并由机械测试锁定。
- version/skill：version coherence、skill sync 实际执行、single-pin 断言、frozen install。
- 必过：`pnpm typecheck`、`pnpm lint`、相关 unit tests、`pnpm build:cua-helper`、
  `pnpm package:cua-helper:release:dry`。平台实机/CI 无法在当前 macOS 完成的项目必须在 MR
  中列为待补，不用兼容兜底恢复已删除的重复状态。

### 测试所有权迁移账本

删除 consumer 镜像测试不等于删除回归门禁。下表以固定 producer commit 为事实源，列出 producer
行为测试与仍留在 z-code 的跨包 smoke；producer MR 必须先通过完整 `pnpm test`，consumer MR 再通过
对应 smoke、Helper build/release 与全仓 unit。路径相对各自仓库根目录。

| 已删除的 z-code 镜像                          | producer 0.5.7 行为 owner / 可执行测试                                                                                                                                                                                                                 | z-code 保留的 consumer 边界                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cuaPermissionBroker.axReadOnly.test.ts`      | `test/native/windows-app-ref-resolution.test.ts`、`test/broker/ax-action-dispatch-status.test.ts`、`test/broker/capture-app-incremental-contract.test.ts`、`test/request-access-read-only.test.ts`                                                     | `packages/services/test/cuaPermissionBrokerNodeHelper.test.ts` 验证 pinned Helper/Node seam；Windows product/runtime integration 继续留在 consumer                                                                                            |
| `cuaPermissionBroker.electronBackend.test.ts` | `test/request-access-read-only.test.ts`、`test/electron-screenshot-display-provenance.test.ts`、`test/windows-capability-truthfulness.test.ts`、`test/open-application-identity-conjunction.test.ts`、`test/macos-background-application-open.test.ts` | `packages/services/test/cuaPermissionBrokerHelperHost.test.ts` 与 `cuaPermissionBrokerNodeHelper.test.ts` 验证 Local Host→producer 组装和 fail-closed 启动                                                                                    |
| `cuaPermissionBrokerHelperInstaller.test.ts`  | `test/broker/helper-install-variants.test.ts`、`test/broker/helperInstaller.production-source.test.ts`、`test/broker/helperInstaller.build-id-promotion.test.ts`、`test/standalone/helper-launch/{installer,downloader,signature-verifier}.test.ts`    | `packages/services/test/cuaPermissionBrokerHelperAppBundle.test.ts`、`cuaPermissionBrokerHelperReaper.test.ts`、`packages/desktop/test/{cuaHelperRuntimeProvenance,runtime-asset-scripts}.test.ts` 验证 app 组装、清理、打包与 pin provenance |
| `cuaControllerServiceRouting.test.ts`         | `test/broker/{controller-admission,controllerCoordinator,controllerLease}.test.ts` 保留 Helper 内部仲裁；不恢复已退役 desktop RPC facade                                                                                                               | `packages/services/test/cuaProducerSurfaceSimplification.test.ts` 与 UI negative tests 锁定 controller RPC 不复活                                                                                                                             |
| `cuaGhostCursorSettingsWiring.test.ts`        | `test/broker/product-host-launch-policy.test.ts` 锁定 product ghost/PiP 恒开及 background 关闭                                                                                                                                                         | `cuaPermissionBrokerHelperHost.test.ts` 只验证 product host 接线，不复制 producer 策略实现                                                                                                                                                    |

这份账本只允许在 owner 测试仍存在且 producer 全量 gate 通过时删除镜像；若 producer 路径改名或行为
下沉位置变化，必须先更新本表与对应 producer 测试，再调整 consumer smoke。

## 实施验证

- 测试所有权账本已按固定 producer commit 实跑：producer 18 files / 122 tests，consumer
  boundary 9 files / 261 tests，全部通过。
- Node 24.14.0 下 root typecheck 与 CLI 22-package typecheck 通过。
- CUA/desktop 定向回归：19 files / 423 tests 通过；CLI authority、skill 与配置：
  188 tests 通过。
- 全仓 unit：1307 files 通过、1 skipped；11396 tests 通过、11 skipped。
- 官方自包含 Node 24.14.0 下 `build:cua-helper` 通过，产物为
  `ZCode Computer Use.app`；release dry-run 通过，当前环境仅缺少真实签名 identity。
- 官方自包含 Node 24.19.0 下 `build:cua-helper:dev` 通过（本机 stable dev identity 的 keychain
  访问阻塞后使用脚本支持的显式 adhoc escape hatch）；实际 bundle 为
  `ZCode Computer Use Dev.app`，`CFBundleName` / `CFBundleDisplayName` 为
  `ZCode Computer Use Dev`，`CFBundleExecutable` 与唯一 arm64 Mach-O 文件均为
  `ZCode Computer Use`。该验证只覆盖 dev bundle identity，不替代 release 签名 gate。
- root lint 0 errors（仓库已有 37 warnings）。root `fmt:check` 仍被已有 Electron
  fiddle HTML 与 `gb2312.js` 阻断；本次变更文件格式通过，上游 Skill 为了 byte-for-byte
  provenance 保持 producer 原样。

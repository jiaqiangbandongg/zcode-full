# 自动更新安装退出重入修复计划

**Goal:** 从 `v3.15.2` 修复原生退出时重复安装导致的卡死，并保留失败重试能力。

**Architecture:** main 更新器唯一持有安装生命周期标记。沿用现有安装命令、错误处理和 Host/Agent 退出屏障，不增加定时器或新的状态副本。

**Tech Stack:** TypeScript、Vitest、Electron、electron-updater、Playwright。

## 执行步骤

1. 更新 `docs/desktop/auto-update-superseded-ready-package.md`，明确成功安装交接、失败重试及多端边界。
2. 在 `packages/desktop/test/autoUpdaterReadyState.test.ts` 先添加 macOS/Linux 异步退出、重复命令与同步/异步安装失败重试用例；运行并确认旧实现失败。
3. 添加 `packages/desktop/scripts/auto-update-install-reentry-smoke.mjs`，用隔离 Electron 进程点击 renderer IPC 安装入口，执行真实 MacUpdater 的异步 staging / 退出回调，记录安装次数和退出状态；确认旧实现不能通过。
4. 修改 `packages/desktop/src/main/autoUpdater.ts`：成功调用保留标记，同步抛错及有效失败解除标记，失败继续进入已有错误处理；添加中文根因注释。
5. 运行定向单测、Electron smoke、`pnpm architecture:check --changed`、`pnpm typecheck`、`pnpm lint` 和改动文件格式/开源检查；记录实际结果与签名发布包验证限制。
6. 审查 diff 并提交 Conventional Commit；本任务不推送或创建 MR。

## 验证记录

- 旧实现：macOS/Linux 退出放行单测失败；Electron smoke 观察到 `before-quit` 被阻止并重复调用安装准备。
- 修复后：更新器状态、Linux 四种安装包下载、强制更新、应用菜单和 renderer 消息入口共 93 条定向单测通过；Electron smoke 记录准备、安装入口、原生 staging、原生安装、退出的顺序，安装调用为一次，退出码为 0。
- `pnpm typecheck`、`pnpm lint`、架构检查、改动文件格式与竞品词检查通过。Lint 有 68 条已有警告。
- 首次 `ZCODE_PRE_PUSH_BASE=v3.15.2 pnpm verify:pre-push` 的相关测试扩展为 2077 个文件：19808 条通过、3 条失败、13 条跳过。失败属于 provider 构建与 runtime update 集成，缺少 CUA 的 `broker/helperConstants` / `broker/server` 模块；本机 desktop/services 的依赖链接指向未提供这些入口的旧工作区目录。相关失败文件相对 tag 没有改动，provider 构建用例独立重跑也复现相同缺模块错误。
- MR 准备时核对已安装 CUA 包的 manifest 与固定 producer commit 一致，仅恢复错误的本机依赖链接；producer pin 与仓库依赖声明没有变化。上述 3 条失败用例独立重跑全部通过，完整门禁在推送时正常重跑。
- Electron smoke 替换了原生安装器，因此签名发布包的 ShipIt 文件替换和重启仍待发布前验证；手机端及 Windows 的完整产品流程未重跑。本改动没有改变其通信或退出准备实现。

## MR 2906：CR-01 修复边界

- 原评审提交：`95ed60e166abd70b4d0318d55ff3bba07df8240a`。Reviewer graph 的 sourceCommit / graphCommit 与该提交一致；影响文件是更新器源码、ready-state 单测与 Electron smoke，impactedNodes / relatedTests 为空，三个 testGaps 为候选缺口，需结合真实测试核验。
- 原因：后台更高版本下载失败会无条件释放安装标记，但旧安装调用仍在等待退出准备 Promise；重复 IPC 或退出事件便可再创建安装调用。
- 修复：由 main 的单一阶段状态持有安装生命周期。`preparing` 阶段不被通用错误释放，准备完成后由原调用复核原包与当前目标并自行收口；`installing` 阶段不被后台下载失败释放。有效安装失败仍允许重试。
- 修改范围：`autoUpdater.ts`、`autoUpdaterReadyState.test.ts`、`auto-update-install-reentry-smoke.mjs`、现有更新 spec 及本计划。未复用旧 graph 作为修改后的快照，下一轮只接受新提交对应的评审/graph。
- 回归证据：修复前退出准备/安装次数为 2/2，修复后为 1/1。单测覆盖 macOS/Linux/Windows 准备期间下载失败、重复 IPC/退出事件和目标改变；Electron smoke 增加 `--preparing-download-failure` 场景，使用 renderer IPC 实测相同顺序。
- 验证：更新器及调用入口 97 条单测通过；正常路径与准备期间下载失败两种 Electron smoke 通过；typecheck、typecheck:e2e、lint、architecture、格式与开源词检查通过。Lint 仍有 68 条已有警告。
- 本轮为默认模式，只处理 Critical Issues；SG-01 / SG-02 建议与真实发布包/跨平台实机验证仍保留。

## MR 2906：第二轮 CR-01 / CR-02 修复边界

- 修复前提交：`316628224442d5de50799b7a1cdffb7c43e94950`。新的 reviewer / graph 均对应此提交：affectedFiles 仍为 3，impactedNodes / relatedTests 为 0，testGaps 从 3 增为 4，仅作候选缺口。
- CR-01 根因：退出准备会不可逆地关闭服务，准备之后才复核目标并取消安装会留下失效窗口。CR-02 根因：安装与后台下载共享 updater 上下文，不能用当前菜单中的下载状态推断异步原生错误的来源。
- 修复：新增 `admitting` 准入阶段，阻止新检查并等待已接受的检查、异步结果与下载 Promise 收口；在服务清理前确认目标，进入准备后锁定更新结果与下载入口。安装错误此时不再与下载重叠，可以解除安装状态；准备期间的原生 staging 失败在清理结束后受控重启恢复服务。
- 测试先行：旧实现新增回归 8 条失败；修复后定向单测 105 条通过，涵盖三平台的清理前拒绝/清理后目标锁定、已有下载准入、同步缓存 ready、原生错误顺序与重复事件。相关既有测试改为等待生命周期完成，避免假定固定 microtask 数量。
- 两种隔离 Electron smoke 均通过；准备期间的新目标事件被锁定，renderer 重复 IPC 不重入，实际 MacUpdater 安装调用与服务准备各一次，进程正常退出。`--preparing-download-failure` 参数保留为历史调用兼容，当前用例验证并发下载在目标锁定后不能启动。
- 修改范围仍为 updater / 单测 / smoke / 两篇现有文档。真实签名包替换、Linux/Windows 实机及手机完整回归仍待人工验证，默认模式未处理 Suggestions。
- 验证：`pnpm typecheck`、desktop `typecheck:e2e`、lint（68 条已有警告、0 错误）、architecture（0 违规）、格式与开源词检查通过。额外独立 `tsconfig.main.json` 检查报 77 个已有错误；通过 TypeScript compiler host 用修复前的 updater 源码对比，当前错误数量与内容完全一致，本次未新增类型错误。

## MR 2906：第三轮 CR-01 / CR-02 修复边界

- 修复前提交：`cf09013d43a6ebd476a47ecb45e12158239aeb94`；reviewer / graph 均对应该提交。第二轮两项 Critical 已确认 resolved，但安装交接后的原生错误恢复与挂起网络准入又有阻断项。affectedFiles 仍为 3、impactedNodes / relatedTests 为 0，候选 testGaps 为 8。
- 锁定依赖核验：BaseUpdater 安装读取 downloadedUpdateHelper，MacUpdater 安装读取已建立的 native staging / proxy；manifest 检查只更新 updateInfoAndProvider，不直接替换已下载安装包。checkForUpdates 的错误事件带来源说明，native 错误不带该说明。
- 删除 `admitting` 与网络 Promise 等待集合，确认安装即锁定 ready；所有迟到检查事件、异步设置读取及已发出检查的失败都不能改写该包。真实下载的 ready 事件关联现有 CancellationToken，成功收口后再发布；失败/取消不发布。安装不依赖网络工作完成，也不引入超时同步。
- 服务清理开始后的失败统一进入 `recovering`，受控 relaunch / exit 恢复 Host/Agent 与远控服务；终态过滤重复错误，不在已销毁服务的旧窗口重试。新进程可重新下载并安装。
- 红测：旧实现 11 条失败，包含三平台挂起检查、下载未结束的 ready 与原生错误后的失效窗口。修复后 79 条更新器单测通过；相关入口与 Linux 下载合计 109 条。
- 四种 Electron smoke：正常退出、准备期间目标变化、永不完成的后台检查、原生 staging 错误恢复，均通过；安装/准备仅一次，原生错误恢复仅一次，退出码为 0。真实签名包替换及多端实机验证仍待补。
- 验证：项目 typecheck、E2E typecheck、lint（68 条已有警告）、architecture、格式与开源词检查通过。独立 main 类型检查相对修复前仍为同样的 77 个历史错误，新增 0 个。默认模式未扩展处理非阻塞 Suggestions。

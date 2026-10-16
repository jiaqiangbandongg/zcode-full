# staging pre-push 单测基线失败报告（2026-08-24）

> **环境复核说明：** 已通过 MacBook Pro 的受限 SSH 转发访问内网资产服务，并使用仓库锁定的
> **Node v24.14.0 + pnpm 10.33.2** 成功执行完整 `pnpm bootstrap`。install、Desktop
> `node-pty` rebuild、Agent/CUA bundle、native-search-tools 下载与校验、workspace build 和
> Desktop build 均成功，bootstrap 最终 exit code 为 0。随后重跑下列 7 个文件，结果仍为
> **30 条失败、128 条通过、4 条跳过**，失败集合完全不变。因此缺少 install、bootstrap 未完成、
> 内网下载失败和 Node 小版本差异均已排除。

## 摘要

在 Linux 本地环境对最新 `origin/staging` 做独立 detached worktree 验证：

- staging SHA：`0e867f1323`（`Merge branch 'fix/tool-call-display-consistency' into 'staging'`）；
- 定向运行 pre-push 全量测试中报错的 9 个测试文件；
- staging 实际结果：**30 条失败**；
- Provider Refactor 当前分支结果：**32 条失败，12,366 条通过，25 条跳过**；
- 两者共有同样的 30 条 Windows packaging、macOS notarization 与 CUA 失败；
- 当前分支额外的 2 条 Settings 源码守卫失败，已经由 staging 提交 `4f0b024f73` 修复；
- 因此 Provider Refactor 的 pre-push 失败主体不是本次 Provider 改造引入，最新 staging 在同一环境下也无法通过该 gate。

## 环境

```text
OS: Linux
首次验证 Node: v24.19.0
复核 Node: v24.14.0（仓库锁定版本）
pnpm: 10.33.2
仓库期望 Node: 24.14.0
Vitest: 4.1.4
staging: 0e867f1323
```

验证使用独立 staging worktree，没有修改 Provider Refactor 当前工作区。CUA catalog 版本在 staging 与当前
分支之间没有差异；Services CUA 测试复用同一份已安装 catalog 依赖。

## staging 的 30 条失败

### 1. Windows release packaging：2 条

文件：

- `packages/zcode-server-cli/test/releaseInstaller.test.ts`
- `packages/zcode-server-cli/test/packaging.test.ts`

失败用例：

```text
release installer
  × installs a Windows zip and writes a launcher that is safe for quoted paths

stageRelease
  × stages a Windows target with a cmd launcher and zip archive
```

代表性错误：

```text
Error: spawn zip ENOENT
```

### 2. macOS notarization：3 条

文件：`packages/desktop/test/notarizeMacosScript.test.ts`

失败用例：

```text
× 测试环境 DMG 带 TEST 后缀时也应能进入公证流程
× retries transient notary upload failures before continuing
× 正式 release 缺少安装后 app 验收路径时不应把 notarization 判定为成功
```

代表性错误：

```text
scripts/notarize-macos.sh: line 92: integer expression expected
[notarize] dmg not found ... for arch=arm64
```

脚本在 Linux 上把 `stat` 输出当作整数处理，随后误判测试 DMG 不存在。

### 3. Desktop CUA identity：2 条

文件：`packages/desktop/test/cuaHelperDevIdentity.test.ts`

失败用例：

```text
× skips import entirely when the identity is already trusted and listed
× reuse-branch success returns without scope errors and reports persist state
```

代表性错误：

```text
expected security import calls to have length 0, but got 1
expected result.ok to be true, but got false
```

### 4. Desktop CUA System Settings watcher：8 条

文件：`packages/desktop/test/cuaSystemSettingsWindowWatcher.test.ts`

失败用例：

```text
× parses a JSON line into the latest bounds
× reassembles bounds split across chunk boundaries
× keeps only the last line when several arrive in one chunk
× picks the largest layer-0 window so modal sheets do not hijack the anchor
× reports null once the settings window closes (empty array)
× fails open when the process exits or errors
× never spawns twice and kills the child on stop
× does not throw when the binary is missing (spawn throws synchronously)
```

代表性错误：

```text
expected watcher.latest() to equal window bounds, received null
expected spawnProcess to be called once, received 0 calls
expected error event not to throw, but Error: ENOENT was thrown
```

### 5. Services CUA Node Helper：10 条

文件：`packages/services/test/cuaPermissionBrokerNodeHelper.test.ts`

失败用例：

```text
× does not expose missing or non-function raw-input/PiP exports from a legacy addon
× kills a timed-out capture, cleans its temp dir, and allows the next request
× serves observation/screen/clipboard methods behind the token over a real socket
× rejects an unauthenticated method call (helper requires the token)
× self-terminates (startup-claim watchdog) when no client claims it within the TTL
× does not report startup-timeout termination when an admitted action cannot drain safely
× freezes an unclaimed startup epoch before late authenticate + broker_info can pass health
× retries an explicit terminal stop after timeout until the admitted action drains
× terminal stop cancels a window-scoped native hold without waiting its 30s duration
× does not self-terminate once a client has authenticated (claimed)
```

代表性错误：

```text
preventActivation must stay fail-closed: expected function to be undefined
expected captureWindowPng(...) to return PNG bytes, received null
TypeError: native.probeAccessibility is not a function
```

### 6. Services CUA Helper Host：5 条

文件：`packages/services/test/cuaPermissionBrokerHelperHost.test.ts`

失败用例：

```text
× permission refresh 重启进程但复用 socket/token，成功验证后才删除 marker
× marker complete 首次失败后保留 handle，重试只清理 marker 而不重启健康 H2
× 外部 stop 在旧 transport 确认退役后清理 pending refresh marker
× permission refresh 的 H1 不响应 TERM 时禁止 SIGKILL 和 H2 launch，并保持 marker
× permission refresh 的 H2 launch 失败后 fail closed；下次只能 fresh 并返回 reused=false
```

共同错误形态：

```text
CuaHelperError: Failed to verify the live ZCode Computer Use process identity
Caused by: ENOENT: no such file or directory,
rename '<socket>.pending' -> '<socket>'
```

## 当前 Provider Refactor 分支额外的 2 条失败

文件：

- `packages/ui/test/settingsSubagentRowContent.test.ts`
- `packages/ui/test/settingsSkillScopeBadge.test.ts`

失败用例：

```text
× uses the shared scoped resource-list structure
× does not repeat scope metadata beside the skill name in Plugin
```

这两条在 `origin/staging@0e867f1323` 已通过。对应 staging 修复提交：

```text
4f0b024f73 fix(ui): 更新源码守卫断言到 resolvePluginDisplayName
```

所以合入最新 staging 后预计从 32 条降为 30 条，但不能让 pre-push gate 整体变绿。

## 复现命令

全量 pre-push：

```bash
pnpm verify:pre-push
```

只运行 staging 仍失败的 7 个文件：

```bash
pnpm exec vitest run \
  packages/zcode-server-cli/test/releaseInstaller.test.ts \
  packages/zcode-server-cli/test/packaging.test.ts \
  packages/desktop/test/notarizeMacosScript.test.ts \
  packages/desktop/test/cuaHelperDevIdentity.test.ts \
  packages/desktop/test/cuaSystemSettingsWindowWatcher.test.ts \
  packages/services/test/cuaPermissionBrokerNodeHelper.test.ts \
  packages/services/test/cuaPermissionBrokerHelperHost.test.ts
```

## 结论

当前 Provider Refactor 的定向 Provider、Adapter、Bootstrap、Services、Protocol 与 UI 回归均已通过；阻止
force-with-lease push 的是仓库 pre-push 对全量单测的硬门禁。最新 staging 在同一环境下也复现其中 30 条，
因此需要单独修复或调整这些跨平台/CUA 基线测试，不能归因于 Provider Refactor。

## 修复设计

这 30 条属于跨平台测试门禁缺陷，修复不改变 CUA、发布或 Provider 的产品语义：

- Windows ZIP 归档改用仓库内的异步 Node 实现，不再要求测试机或发布机构建机预装 `zip` 命令；
- notarize 脚本的 mtime 读取同时兼容 BSD/macOS 与 GNU/Linux `stat`；
- macOS identity 与 System Settings watcher 测试的 platform seam 必须贯穿到内部 helper；
- macOS Node Helper 契约测试显式固定 `darwin`，跨平台 broker 测试的 fake native 则补齐当前平台 ABI；
- 不启动真实 broker socket 的 Helper Host 状态机测试显式关闭 transport rendezvous，避免临时目录长度决定测试分支；
- 所有修复继续 fail-closed，不通过 skip 整组测试来隐藏跨平台失败。

## 修复结果

2026-08-24 已按上述设计完成修复：原 7 个失败文件在 Linux 上得到 `158 passed / 4 skipped`，
原 30 条失败全部消失。与此同时将 Windows ZIP 的生成与安全解压统一改为进程内异步实现，移除了
发布机对系统 `zip` 以及 GNU tar 读取 ZIP 的错误依赖。当前分支另外两条 UI 源码守卫漂移同步采用
staging 已有修复 `4f0b024f73` 的断言结果，不改变 UI 产品实现。

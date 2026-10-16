# Windows CUA Upstream Main Forward Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已验证的 Windows CUA runtime 正向迁移到 `zcode-cua` 最新上游 main，并让 `z-code` 当前分支在 clean consumer tree 中通过显式本地 producer 路径生成、校验和打包该 runtime；远端 Git pin 留到 producer commit push 后闭环。

**Architecture:** `zcode-cua` 是 Windows Helper entry、native addon 和 package runtime contract 的 producer；`z-code` 只固定 producer Git SHA、读取 producer contract、生成 digest manifest，并由 desktop-local Host 按需启动。迁移按当前上游 broker/incremental/input-cleanup 语义重新接线，不覆盖其提交或恢复旧实现。

**Tech Stack:** TypeScript 5/6、Vitest、Node 24、N-API/node-gyp、C++/Win32 UIA/WGC/D3D11、Electron 41、pnpm 10。

## Global Constraints

- `z-code` 在当前 `feat/cua-helper-app` 分支原地开发。
- `zcode-cua` 在本地 `main` 上开发；先保留安全分支，再把 `main` 指向最新 `origin/main`。
- Windows 移植变更在 `zcode-cua/main` 最终只有一个新 commit；不改写上游 commit，不 push。
- producer contract schema 固定为 `1`，package name 固定为 `@zcode/zcode-cua`。
- consumer 固定完整 Git SHA，不再重复硬编码 package version。
- Windows raw input 必须验证唯一前台 PID；不能用 UIA、标题、basename 或枚举第一项猜测身份。
- Windows Helper 只服务本地 desktop continuous；SSH、WSL、Docker、remote workspace 和手机 `/remote` 不创建独立 runtime。
- token 只通过环境变量传递，不进入 argv、manifest 或日志。
- 所有功能修改先写失败测试；生产代码不能先于 RED test。
- 新增 bug 原因/修复注释使用中文。
- 两个仓库完成前都执行各自 typecheck、lint 和 focused/full tests。

---

### Task 1: 准备 zcode-cua 最新 main 与可恢复引用

**Files:**

- No product file changes.

**Interfaces:**

- Consumes: `origin/main`，迁移来源 `codex/windows-cua-pointer-foundation`。
- Produces: 本地 `main` 指向最新上游 main；两个 backup branch 保留旧引用。

- [ ] **Step 1: 验证两个工作区没有未提交修改**

```powershell
git -C C:\Users\dev\z-code status --short
git -C C:\Users\dev\zcode-cua status --short
```

Expected: 两个命令都不输出文件；`z-code` 只允许 branch ahead 状态。

- [ ] **Step 2: 刷新并记录 producer 基线**

```powershell
git -C C:\Users\dev\zcode-cua fetch origin --prune
git -C C:\Users\dev\zcode-cua show -s --format="%H %an %s" origin/main
```

Expected: `origin/main` 可解析，author/merge history 属于上游当前主线。

- [ ] **Step 3: 创建不会覆盖的安全引用**

```powershell
git -C C:\Users\dev\zcode-cua branch backup/windows-cua-before-forward-port-20260804 codex/windows-cua-pointer-foundation
git -C C:\Users\dev\zcode-cua branch backup/local-main-before-forward-port-20260804 main
```

Expected: 两个 backup branch 指向原有 commit；若名称已存在，验证它们指向预期 commit 后复用。

- [ ] **Step 4: 原地对齐本地 main，不使用 hard reset**

```powershell
git -C C:\Users\dev\zcode-cua switch codex/windows-cua-pointer-foundation
git -C C:\Users\dev\zcode-cua branch -f main origin/main
git -C C:\Users\dev\zcode-cua switch main
```

Expected: `git status --short --branch` 显示 `main...origin/main`，无 ahead/behind、无文件修改。

- [ ] **Step 5: 安装依赖并建立 baseline**

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 所有命令 exit 0。若 baseline 失败，停止并记录失败，不进入 Task 2。

---

### Task 2: 用 producer-owned contract 锁定 Windows Helper 包契约

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\windows-package-artifacts.test.ts`
- Create: `C:\Users\dev\zcode-cua\src\windows-helper.ts`
- Modify: `C:\Users\dev\zcode-cua\package.json`
- Modify: `C:\Users\dev\zcode-cua\scripts\build.mjs`

**Interfaces:**

- Produces: `packageJson.zcodeCuaRuntime.windows.entry === "dist/windows-helper.js"`。
- Produces: export `./windows-helper` 指向 `./dist/windows-helper.js`。
- Consumes later: z-code staging/runtime resolver。

- [ ] **Step 1: 写 package contract RED test**

```ts
it("publishes the current Windows helper runtime contract", () => {
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  expect(packageJson.name).toBe("@zcode/zcode-cua");
  expect(packageJson.zcodeCuaRuntime).toEqual({
    schema: 1,
    windows: {
      entry: "dist/windows-helper.js",
      nativeAddon: "build/Release/ax_native.node",
    },
  });
  expect(packageJson.exports["./windows-helper"]?.import).toBe("./dist/windows-helper.js");
});
```

同一测试调用 `pnpm pack --dry-run --json`，断言 pack 包含：

```ts
for (const path of [
  "dist/windows-helper.js",
  "binding.gyp",
  "src/native/ax_win.cc",
  "scripts/build-native.cjs",
]) {
  expect(paths).toContain(path);
}
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
pnpm exec vitest run test/windows-package-artifacts.test.ts
```

Expected: FAIL，原因是 `zcodeCuaRuntime`/`./windows-helper`/entry 不存在，而不是测试加载错误。

- [ ] **Step 3: 添加最小 package contract 与 build entry**

在 `package.json` 添加：

```json
"./windows-helper": {
  "types": "./dist/windows-helper.d.ts",
  "import": "./dist/windows-helper.js"
},
"zcodeCuaRuntime": {
  "schema": 1,
  "windows": {
    "entry": "dist/windows-helper.js",
    "nativeAddon": "build/Release/ax_native.node"
  }
}
```

`src/windows-helper.ts` 只能调用 broker/server 提供的 Windows Helper main；不得重复实现 broker。
`scripts/build.mjs` 把该入口加入现有 esbuild entries。

- [ ] **Step 4: 运行 GREEN 验证**

```powershell
pnpm build
pnpm exec vitest run test/windows-package-artifacts.test.ts
```

Expected: build 和测试 exit 0；pack 内容来自当前源码生成物。

---

### Task 3: 把 Windows Helper 生命周期接入当前上游 broker

**Files:**

- Create: `C:\Users\dev\zcode-cua\src\broker\server\windowsDevHelperMain.ts`
- Create: `C:\Users\dev\zcode-cua\src\broker\server\windowsSystemSurface.ts`
- Create: `C:\Users\dev\zcode-cua\test\windowsDevHelperMain.test.ts`
- Create: `C:\Users\dev\zcode-cua\test\broker\windowsSystemSurface.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\index.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\helperMain.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeSystemSurface.ts`

**Interfaces:**

- Produces: `parseWindowsDevHelperConfig`、`runWindowsDevHelper`、`WINDOWS_DEV_CONTROL_PROTOCOL`。
- Consumes: 当前 `startCuaPermissionBroker`、native loader、上游 cleanup/cancellation semantics。

- [ ] **Step 1: 写 Helper config/lifecycle RED tests**

覆盖以下真实行为：

```ts
expect(
  parseWindowsDevHelperConfig({
    argv: ["node", "entry", "--socket", SOCKET, "--parent-pid", "12"],
    env: { ZCODE_CUA_PERMISSION_BROKER_TOKEN: TOKEN },
    platform: "win32",
  }),
).toEqual({ socketPath: SOCKET, parentPid: 12, token: TOKEN });
```

并断言：非 win32、非 named pipe、非正 parent PID、缺 token、出现 `--token` 均拒绝；
ready 必须等 broker bound；IPC/disconnect/signal/parent loss 复用一个 idempotent async stop；
错误消息和 control IPC 不含 token。

- [ ] **Step 2: 运行并确认 RED**

```powershell
pnpm exec vitest run test/windowsDevHelperMain.test.ts test/broker/windowsSystemSurface.test.ts
```

Expected: FAIL，原因是 Windows Helper modules 尚不存在。

- [ ] **Step 3: 实现当前-main 兼容的最小 Helper entry**

实现顺序：配置校验 → native/system surface 注入 → broker ready IPC → watchdog/listeners →
统一 terminal cleanup。中文注释记录：Windows 没有 TCC Helper.app，但仍由独立 Host child
持有自动化能力；token 放 argv 会泄露到进程列表，因此只接受 env。

- [ ] **Step 4: 验证 GREEN**

```powershell
pnpm exec vitest run test/windowsDevHelperMain.test.ts test/broker/windowsSystemSurface.test.ts
```

Expected: 所有非 native tests 通过；native smoke 在 addon 未构建时明确 skip。

---

### Task 4: 正向迁移 Windows AUMID、pointer 与 clipboard

**Files:**

- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`
- Modify: `C:\Users\dev\zcode-cua\src\native\win.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackend.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackendTypes.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeAutomationAdapter.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronInputHandlers.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronAppHelpers.ts`
- Modify: `C:\Users\dev\zcode-cua\src\tools\pointer.ts`
- Create: Windows pointer/clipboard/AUMID tests listed in the design WCFR-06/07/08.

**Interfaces:**

- Produces native ABI: `moveTo`、`scrollAt`、`drag`、`mouseDown`、`mouseUp`、
  `releaseSyntheticInputs`、async clipboard read/write、AUMID activate/resolve。
- Preserves upstream `InputHoldRegistry`、delivery-state 和 re-resolution。

- [ ] **Step 1: 导入并适配测试，先锁定 current-main 语义**

从安全分支读取测试意图，但在 main 上重新创建测试。至少覆盖：

```ts
expect(
  await dispatchWindowsPointer({ appRef: expectedApp, activeApps: [expectedApp] }),
).toMatchObject({ sent: true });
expect(() => dispatchWindowsPointer({ appRef: expectedApp, activeApps: [otherApp] })).toThrow(
  /frontmost/iu,
);
```

另覆盖：虚拟桌面负坐标、drag partial failure 补发 up、stop/cancel 释放 owned input、
Unicode clipboard 精确 round-trip、AUMID 0/多候选 fail closed、普通 Win32 使用 canonical exe。

- [ ] **Step 2: 运行 focused tests 并确认 RED**

```powershell
pnpm exec vitest run `
  test/native/windows-aumid-application.test.ts `
  test/native/windows-input-dispatch.test.ts `
  test/native/windows-clipboard.test.ts `
  test/windows-pointer-foreground-gate.test.ts `
  test/windows-native-clipboard-adapter.test.ts `
  test/windows-open-application-identity.test.ts
```

Expected: FAIL，分别指向缺失 ABI/adapter/identity 行为。

- [ ] **Step 3: 按层实现最小 GREEN**

顺序固定为：native ABI → TS adapter → neutral backend ports → broker handler → tool scope。
工具层不得出现 Win32/UIA 名称；Windows-only 分支只存在 native/Helper adapter。

- [ ] **Step 4: 重建 addon 并运行 GREEN**

```powershell
pnpm rebuild:native
pnpm exec vitest run `
  test/native/windows-aumid-application.test.ts `
  test/native/windows-input-dispatch.test.ts `
  test/native/windows-clipboard.test.ts `
  test/windows-pointer-foreground-gate.test.ts `
  test/windows-native-clipboard-adapter.test.ts `
  test/windows-open-application-identity.test.ts
```

Expected: focused tests exit 0；需要交互桌面的测试明确 skip，而不是伪造 pass。

---

### Task 5: 正向迁移 WGC 与 state-image 绑定

**Files:**

- Create: `C:\Users\dev\zcode-cua\src\native\screen_capture_win.h`
- Create: `C:\Users\dev\zcode-cua\src\native\screen_capture_win.cc`
- Create: `C:\Users\dev\zcode-cua\src\native\windowsScreenCapture.ts`
- Modify: `C:\Users\dev\zcode-cua\binding.gyp`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`
- Modify: `C:\Users\dev\zcode-cua\src\native\win.ts`
- Modify: current broker observation/capture adapters without replacing upstream incremental state logic.
- Create: WGC capability/adapter/app-state tests listed in WCFR-04/05。

**Interfaces:**

- Produces: async display/window PNG capture + exact logical bounds。
- Consumes: current upstream explicit visual capture and incremental/full observation contract。

- [ ] **Step 1: 写 WGC RED tests**

覆盖：支持状态真实反映 native ABI；display/window capture 返回 PNG+bounds；
`capture_app` 将 image 绑定到 verified HWND/window_id；state-image 使用同一 bounds；
最小化/锁屏/unsupported 返回明确 unavailable。

- [ ] **Step 2: 运行并确认 RED**

```powershell
pnpm exec vitest run `
  test/native/windows-wgc-screen-capture.test.ts `
  test/windows-native-screen-capture-adapter.test.ts `
  test/windows-app-state-screen-capture.test.ts `
  test/windows-capability-truthfulness.test.ts
```

Expected: FAIL，当前 main 的 `captureWindowImage`/capability 没有 WGC 实现。

- [ ] **Step 3: 实现 WGC bridge**

从安全分支迁移 WinRT capture item、D3D11 device/frame pool、PNG 编码和 bounds 校验；
接入当前 main 的 explicit visual capture seam。中文注释说明为什么最小化/非交互桌面必须
fail closed，不能返回空白图片冒充成功。

- [ ] **Step 4: 构建并运行 GREEN**

```powershell
pnpm rebuild:native
pnpm build
pnpm exec vitest run `
  test/native/windows-wgc-screen-capture.test.ts `
  test/windows-native-screen-capture-adapter.test.ts `
  test/windows-app-state-screen-capture.test.ts `
  test/windows-capability-truthfulness.test.ts
```

Expected: focused tests exit 0，current-main incremental observation tests 继续通过。

---

### Task 6: Producer 全量验证与单一 commit

**Files:**

- Modify generated: `C:\Users\dev\zcode-cua\dist\**`
- Create/update: Windows live smoke scripts and `docs/platforms.md` only when current behavior needs记录。

**Interfaces:**

- Produces: 一个可由 Git dependency 安装的完整 producer commit SHA。

- [ ] **Step 1: 重新生成产物并检查 diff**

```powershell
pnpm build
git status --short
git diff --check
```

Expected: `dist` 只反映当前 source build；无 conflict marker、无意外 macOS/Linux 删除。

- [ ] **Step 2: 执行 producer 完整自动化门禁**

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm rebuild:native
pnpm build
pnpm pack --dry-run --json
```

Expected: 全部 exit 0；记录 tests passed/skipped 数量。

- [ ] **Step 3: 执行 Windows live smoke**

```powershell
node scripts/windows-pointer-live-smoke.mjs
node scripts/windows-clipboard-live-smoke.mjs
node scripts/windows-screen-capture-live-smoke.mjs
node scripts/windows-tool-surface-live-smoke.mjs
```

Expected: pointer/clipboard 恢复原状态，WGC/30-tool smoke exit 0，无 Helper/fixture orphan。

- [ ] **Step 4: 创建唯一 producer commit**

```powershell
git add --all
git diff --cached --check
git commit -m "feat(windows): forward-port CUA runtime onto current main"
```

Expected: `origin/main..main` 只有一个新 commit，且未 push。

---

### Task 7: z-code consumer 先用 RED tests 去掉旧版本真相

**Files:**

- Modify: `C:\Users\dev\z-code\packages\desktop\test\windows-cua-helper-assets.test.ts`
- Modify: `C:\Users\dev\z-code\packages\services\test\windowsCuaDevRuntime.test.ts`
- Modify: `C:\Users\dev\z-code\packages\desktop\test\runtime-asset-scripts.test.ts`

**Interfaces:**

- Consumes: Task 6 本地 producer commit 和 `zcodeCuaRuntime` contract。
- Produces: RED evidence that hardcoded `0.3.28` consumer cannot consume current producer。

- [ ] **Step 1: 记录本地 producer SHA，保持远端 dependency pin 不变**

运行：

```powershell
$producerCommit = git -C C:\Users\dev\zcode-cua rev-parse HEAD
Write-Output $producerCommit
```

用户明确要求不 push，因此该 SHA 暂时不能被 Git URL clean checkout 获取。实现和本地产品
验证使用显式 `ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR=C:\Users\dev\zcode-cua`；
`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 在 producer commit 可从 remote 获取前保持当前
上游 pin，禁止提交不可获取的 SHA 或 `file:` 本地路径。最终 Git URL pin/clean-install gate
标记为待用户 push 后执行，不能伪造成功。

- [ ] **Step 2: 修改 consumer tests 表达新契约**

测试 package fixture 使用：

```ts
{
  name: "@zcode/zcode-cua",
  version: "0.5.2",
  zcodeCuaRuntime: {
    schema: 1,
    windows: {
      entry: "dist/windows-helper.js",
      nativeAddon: "build/Release/ax_native.node",
    },
  },
}
```

另断言版本可以变为 `0.5.3` 而不需要修改 consumer 常量，但 schema/name/path/digest 仍严格校验。

- [ ] **Step 3: 运行并确认 RED**

```powershell
pnpm exec vitest run packages/desktop/test/windows-cua-helper-assets.test.ts
pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts
pnpm exec vitest run packages/desktop/test/runtime-asset-scripts.test.ts
```

Expected: FAIL，旧实现仍要求 `0.3.28`，且 preparation 未调用 Windows CUA staging。

---

### Task 8: 实现 consumer contract、clean staging 与 runtime resolver

**Files:**

- Modify: `C:\Users\dev\z-code\packages\desktop\scripts\windows-cua-helper-assets.mjs`
- Modify: `C:\Users\dev\z-code\packages\desktop\scripts\prepare-runtime-assets.mjs`
- Modify: `C:\Users\dev\z-code\packages\services\src\cua-permission-broker\windowsCuaDevRuntime.ts`
- Keep validation local to each allowed layer: desktop staging validates producer package contract；services validates the staged manifest and explicit dev-root contract。两处通过同一 parity fixture 锁定 schema/name/path 规则，不跨层导入 desktop/service 实现。
- Update: `C:\Users\dev\z-code\docs\cua\windows-product-runtime.md`
- Update: `C:\Users\dev\z-code\docs\cua\windows-source-development.md`

**Interfaces:**

- Produces: canonical `WindowsCuaRuntimeContract` parser semantics。
- Produces: staged `runtime-manifest.json` with observed version and digests。

- [ ] **Step 1: 实现 producer contract parser**

Parser 只接受：

```ts
type WindowsCuaRuntimeContract = {
  schema: 1;
  windows: {
    entry: string;
    nativeAddon: string;
  };
};
```

路径检查拒绝 absolute、反斜杠、空段、`.`、`..`、NUL、链接逃逸。package version 作为
manifest provenance 原样记录，不与 consumer 常量比较；entry/nativeAddon 的具体值由固定
producer commit 声明，consumer 不再重复保存这两个路径常量。

- [ ] **Step 2: 把 contract 接入 staging/resolver**

staging 从 package JSON 读取 contract，生成 SHA-256 inventory；resolver 校验 manifest、
entry/native addon、Electron、PE arch 和 digest。现有 dev override/product-only 查找边界保持不变。

- [ ] **Step 3: 把 Windows staging 接入资源准备**

`prepare-runtime-assets.mjs` 仅在目标平台/架构为 Windows 时调用 Windows CUA staging；
macOS/Linux 流程不读取 Windows native addon。

- [ ] **Step 4: 运行 GREEN tests**

```powershell
pnpm exec vitest run packages/desktop/test/windows-cua-helper-assets.test.ts
pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts
pnpm exec vitest run packages/desktop/test/runtime-asset-scripts.test.ts
```

Expected: 全部 exit 0。

---

### Task 9: Clean-tree/package smoke 与 z-code commit

**Files:**

- Update docs only if verification reveals an exact command/limitation not covered by Task 8。

**Interfaces:**

- Produces: P0 completion evidence and z-code implementation commit。

- [ ] **Step 1: 在独立临时目录验证无 ignored 资源依赖**

从当前 tracked tree 创建临时 checkout，确认 `packages/desktop/bundled-tools` 初始不存在；
显式把 `ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR` 指向 Task 6 本地 producer，执行 staging，
然后检查 manifest/entry/native digests。

Expected: 不复制当前工作区历史 `bundled-tools` 也能生成资源。由于 producer commit 未 push，
该结果是 local producer + clean consumer tree 证据，不宣称远端 Git dependency clean install 已闭环。

- [ ] **Step 2: 执行 z-code focused/integration gates**

```powershell
pnpm exec vitest run packages/services/test/windowsCuaDevHelperHost.test.ts
pnpm exec vitest run packages/services/test/windowsCuaProductHelper.integration.test.ts
pnpm --filter @zcode/zcode-cua-plugin test
```

Expected: exit 0；真实 child integration 在 prerequisites 缺失时明确 skip。

- [ ] **Step 3: 执行强制全局门禁**

```powershell
pnpm typecheck
pnpm lint
```

Expected: 两个命令 exit 0。若全量或 affected tests 有既有失败，保留完整输出并做 clean baseline 对照。

- [ ] **Step 4: 检查模式不变量**

用测试/静态断言证明：remote workspace、SSH、WSL、Docker、mobile `/remote` 不进入
Windows Helper start/staging；desktop continuous 与 web replayable 无协议变化。

- [ ] **Step 5: 创建 z-code 实现 commit**

```powershell
git add --all
git diff --cached --check
git commit -m "fix(cua): align Windows runtime with current producer"
```

Expected: commit 成功，工作区 clean，未 push。

---

### Task 10: 完成审计与下一里程碑入口

**Files:**

- No required product changes.

**Interfaces:**

- Produces: 两仓库 commit SHA、验证结果、已知风险和后续 Windows settings/indicator 入口。

- [ ] **Step 1: 核对提交拓扑**

```powershell
git -C C:\Users\dev\zcode-cua log --oneline origin/main..main
git -C C:\Users\dev\z-code log --oneline origin/feat/cua-helper-app..HEAD
```

Expected: zcode-cua 只有一个新 Windows commit；z-code 包含既有 Windows integration、spec 和本次 consumer fix。

- [ ] **Step 2: 核对工作区与 push 状态**

```powershell
git -C C:\Users\dev\zcode-cua status --short --branch
git -C C:\Users\dev\z-code status --short --branch
```

Expected: 两个 working tree clean；分支只在本地 ahead，没有 push。

- [ ] **Step 3: 逐项对照 spec 完成定义**

核对 WCFR-01 至 WCFR-10；任何未验证 live/package 项必须明确标为未完成，不能从 unit tests 外推。

- [ ] **Step 4: 进入后续 P1 前更新计划状态**

P0 全部满足后，才开始 Windows 独立设置 Tab；UI 修改前先读取根 `DESIGN.md` 并另走 spec/TDD。

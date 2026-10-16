# CUA 无系统弹窗授权引导（拖拽 + 吸附）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ZCode CUA 首次授权全程不弹 macOS 系统权限弹窗，改为「主窗内权限清单模态 → 打开系统设置页 → 吸附浮窗把 Helper.app 拖进权限列表」的拖拽式引导。

**Architecture:** 删除 onboarding 中触发 native prompt 的 `requestHelper*PermissionViaLaunchServices` 调用，并把它承载的同步指纹终检迁移到 dragstart 前；恢复 2026-08 审计（`663f58e7e7`）删除的 `Prepare/StartCuaHelperPermissionDrag` IPC 链（预热已验证路径+指纹缓存，dragstart 只做微秒级同步比对再 `startDrag`）；新增一个 Electron 无焦点置顶浮窗承载可拖拽 tile，位置由一个常驻 Swift CLI 提供的系统设置窗口 bounds 驱动。会话协调器、验签链、授权后重启 Helper 机制全部保留。

**Tech Stack:** Electron 41.0.3（`webContents.startDrag`）、TypeScript、React、Vitest、Swift（`CGWindowListCopyWindowInfo`）、electron-builder extraResources

**Spec:** 本文档「设计依据」段（brainstorming 在会话内确认，未单独出 spec 文件）

---

## 设计依据

### 为什么拖拽是必需的，不是装饰

系统弹窗的**唯一实质作用**是让 app 出现在 TCC 权限列表里。不弹窗 → 全新用户的列表里没有这个 app → 无从勾选。拖拽是唯一替代路径。

**已实测验证**（2026-08-20，本机 macOS Darwin 25.5.0）：用 Electron `webContents.startDrag({file, icon})` 把 `Calculator.app`（基线：TCC 中零条目）拖入「辅助功能」列表后：

```
kTCCServiceAccessibility | com.apple.calculator | auth_value=2 | 17:34:58
```

条目**凭空创建且直接为 granted(2)**，比系统弹窗少一步（弹窗只创建条目，仍需用户自己找到并勾选）。验证后已 `tccutil reset` 清理。

### 弹窗触发源（本次要摘掉的）

| API | 弹窗 |
|---|---|
| `AXIsProcessTrustedWithOptions({prompt: true})` | **弹** — 上游 `ax_macos.mm:2967` `PromptTrust` |
| `CGRequestScreenCaptureAccess()` | **弹** |
| `AXIsProcessTrusted()` / `{prompt: false}` | 不弹 — 上游 `FreshAXIsTrusted` |
| `CGPreflightScreenCaptureAccess()` | 不弹 |

链路：`openCuaPermissionOnboarding` → `requestHelper*PermissionViaLaunchServices`（上游 `dist/broker/server/helperLauncher.js:563`）→ `/usr/bin/open` 拉起 Helper 到一次性权限请求模式 → Helper 进程内命中上述弹窗 API。

### 为什么浮窗不能做进 Helper

Helper 是 **Node SEA + `LSUIElement=true`**（实测 `NODE_SEA_BLOB` 命中、Info.plist `LSUIElement=true`），"原生"部分只是 `Resources/ax_native.node` 这个 Node 扩展，不是 AppKit app。`ax_macos.mm` 注释原文：*"does not run a normal NSApplication event loop"*。NSPanel 显示与 `beginDraggingSession` 都需要 run loop。更关键的是**循环依赖**：授权 UI 的目的就是给 Helper 授权，若 UI 由 Helper 承载，则 Helper 起不来时引导一并瘸掉 —— 这正是 macOS ≤14 `lockf` 事故的形态（`broker_unavailable` → 工具不注册 → 授权引导永不弹）。

### 吸附为什么需要新二进制

`CGWindowListCopyWindowInfo` 拿窗口 bounds **不需要任何权限**，但 Electron 无绑定。三条路排除结果：`osascript`+System Events 需要辅助功能权限（死结，正是此刻缺的）；`desktopCapturer` 只给窗口名不给 bounds；`koffi` 这类 FFI 自身是 native addon，要 electron-rebuild。故用常驻 Swift CLI。已实测：57KB 产物、1.5s 编译、无权限拿到 `{"w":723,"x":134,"h":752,"y":157,"owner":"System Settings","layer":0}`。

---

## Global Constraints

- **平台**：全部新增能力仅 `darwin`；非 darwin 分支必须 fail-safe 返回而非抛错。
- **核心不变量**：onboarding 全流程**绝不**调用 `requestHelperAccessibilityPermissionViaLaunchServices` / `requestHelperScreenRecordingPermissionViaLaunchServices`，也绝不调用上游 `promptTrust`。这是本次改造的目的，必须有测试锁死。
- **权限展示态**：任何常驻 UI 的权限判定用 `isCuaPermissionTccGranted`（`packages/ui/src/lib/cuaPermissionStatusStore.ts`），**禁止**使用带 `includeFunctionalProbes` 的判定 —— 只读刷新的 `screenCaptureProbeOk` 恒为 `false`，用它会让已授权用户恒显「待授权」。
- **dragstart 同步约束**：`event.sender.startDrag()` 必须在 dragstart 事件链路里**同步**调用，其间**禁止** `await` 任何 I/O，否则错过 OS 拖拽手势窗口，用户拖不出任何文件。install/verify 必须预先在 prepare 阶段完成并缓存。
- **TOCTOU 门**：拖拽前必须同步比对 `cuaHelperBundleFingerprintUnchanged`（`ino:ctimeNs:size`，ctime 用户态不可回拨）；不符即拒拖并清缓存，绝不把可能被替换的 bundle 拖进权限列表。
- **fail-closed vs fail-open**：验签/指纹相关一律 fail-closed（拒绝操作）；窗口 bounds 获取失败一律 fail-open（退回屏幕底部居中），吸附是增强不是可用性前提。
- **授权后生效**：两项权限都必须重启 Helper 才生效（SR 对已运行进程不生效；accessibility 有 `AXIsProcessTrusted` 进程级缓存）。保留 `restartHelperAfterReturn` 机制。
- **语言跟随 ZCode**：权限拖拽浮窗不得自行读取浏览器 `localStorage` 或操作系统语言；每次 `show(permission)` 都从 main 进程的 `currentApplicationLocale` 读取当前 ZCode 界面语言，并通过浮窗 state IPC 传给 renderer。renderer 只支持 shared `Locale` 已声明的 `zh-CN` / `en-US`，同步更新说明文案、拖拽 tooltip、`document.title` 与 `<html lang>`。state 必须在 `showInactive()` 前发送，避免英文界面先闪出中文 fallback。
- **git**：禁用 `--no-verify`。上游 `@zcode/zcode-cua` 本次**不修改**，全部改动在下游仓库。
- **macOS API 版本**：`CGWindowListCopyWindowInfo` 自 10.5 起可用，安全。新增任何系统命令前必须核最低支持版本（`/usr/bin/lockf` 是 15+ 曾致 macOS ≤14 全线不可用）。

语言状态链路：

```text
ZCode 设置 / System default
             │
             ▼
main.currentApplicationLocale
             │  每次 panel.show(permission) 读取
             ▼
zcode:cua-permission-panel-state { permission, locale, iconDataUrl }
             │
             ▼
浮窗 renderer：文案 + tooltip + title + html lang
```

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/shared/src/cuaAccessibilitySettings.ts` | 新增 `PrepareCuaHelperPermissionDragResult` 类型 |
| `packages/shared/src/channels.ts` | 新增两个 IPC 通道常量 + schema |
| `packages/shared/src/platform.ts` | 新增两个 platform 方法声明 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts` | 删除 request* 调用；新增 `prepareCuaHelperPermissionDrag` |
| `packages/desktop/src/main/desktopCuaPermissionIpc.ts` | 新增 drag IPC handlers（缓存 + TOCTOU 门 + 同步 startDrag） |
| `packages/desktop/src/main/cuaPermissionDragPanel.ts` | **新建** 浮窗生命周期管理 |
| `packages/desktop/src/main/cuaPermissionPanelPositioner.ts` | **新建** 纯函数定位计算（可独立单测） |
| `packages/desktop/src/main/cuaSystemSettingsWindowWatcher.ts` | **新建** 常驻 Swift CLI 的 spawn/解析/fail-open |
| `packages/desktop/native/macos-window-bounds/main.swift` | **新建** 输出系统设置窗口 bounds 的 CLI |
| `packages/desktop/scripts/build-macos-window-bounds.mjs` | **新建** swiftc 构建脚本 |
| `packages/desktop/electron-builder.config.js` | 打包 + 签名新 CLI |
| `packages/desktop/src/renderer/permission-panel/` | **新建** 浮窗内容页（拖拽 tile） |
| `packages/ui/src/cua/CuaPermissionChecklistModal.tsx` | **新建** 首弹窗（权限清单） |

---

## Task 1: shared 契约 —— 恢复两个 IPC 通道与结果类型

**Files:**
- Modify: `packages/shared/src/cuaAccessibilitySettings.ts`
- Modify: `packages/shared/src/channels.ts:279`（通道常量）、`:818` 附近（schema）
- Modify: `packages/shared/src/platform.ts:643` 附近
- Test: `packages/shared/test/channels.test.ts`

**Interfaces:**
- Produces: `PlatformChannels.PrepareCuaHelperPermissionDrag = "zcode:prepare-cua-helper-permission-drag"`、`PlatformChannels.StartCuaHelperPermissionDrag = "zcode:start-cua-helper-permission-drag"`；类型 `PrepareCuaHelperPermissionDragResult { success: boolean; error?: string; helperAppPath?: string; helperDisplayName?: string; helperBundleId?: string }`（**注意**：`helperBundleFingerprint` 故意不进 shared —— 它只允许 main 进程内存消费，不得跨 IPC 暴露给 renderer）；platform 方法 `prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>`、`startCuaHelperPermissionDrag?(): void`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/channels.test.ts` 追加：

```ts
import { describe, expect, it } from "vitest";
import { PlatformChannels } from "../src/channels.js";

describe("CUA helper permission drag channels", () => {
  it("声明 prepare 与 start 两个通道", () => {
    expect(PlatformChannels.PrepareCuaHelperPermissionDrag).toBe(
      "zcode:prepare-cua-helper-permission-drag",
    );
    expect(PlatformChannels.StartCuaHelperPermissionDrag).toBe(
      "zcode:start-cua-helper-permission-drag",
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/shared test -- channels`
Expected: FAIL — `PrepareCuaHelperPermissionDrag` 为 `undefined`

- [ ] **Step 3: 实现**

`packages/shared/src/cuaAccessibilitySettings.ts` 追加（**不要**给 `CuaAccessibilitySettingsResult` 加字段，避免污染 onboarding 结果形状）：

```ts
/**
 * 拖拽预热结果。helperBundleFingerprint 故意不在此声明：它是 main 进程内存缓存的同步 TOCTOU
 * 证据，跨 IPC 暴露给 renderer 既无用又扩大攻击面。
 */
export interface PrepareCuaHelperPermissionDragResult {
  success: boolean;
  error?: string;
  helperAppPath?: string;
  helperDisplayName?: string;
  helperBundleId?: string;
}
```

`packages/shared/src/channels.ts` 在 `OpenCuaPermissionOnboarding` 常量旁追加：

```ts
  PrepareCuaHelperPermissionDrag: "zcode:prepare-cua-helper-permission-drag",
  StartCuaHelperPermissionDrag: "zcode:start-cua-helper-permission-drag",
```

同文件 schema 区（`[PlatformChannels.OpenCuaPermissionOnboarding]` 旁）追加，并把新类型加进顶部 import：

```ts
  [PlatformChannels.PrepareCuaHelperPermissionDrag]: {
    request: undefined;
    response: PrepareCuaHelperPermissionDragResult;
  };
  [PlatformChannels.StartCuaHelperPermissionDrag]: {
    request: undefined;
    response: void;
  };
```

`packages/shared/src/platform.ts` 在 `openCuaPermissionOnboarding` 声明旁追加：

```ts
  /**
   * 预热并缓存已验证的 Helper 路径 + 指纹，使随后的 dragstart 能同步 startDrag。
   * 必须在浮窗挂载时调用；dragstart 期间不允许任何异步 I/O。Desktop only。
   */
  prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
  /** 从权限浮窗拖拽 Helper.app 到 macOS 权限列表。Desktop only。 */
  startCuaHelperPermissionDrag?(): void;
```

`packages/shared/src/index.ts` 导出 `PrepareCuaHelperPermissionDragResult`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/shared test -- channels`
Expected: PASS

Run: `pnpm typecheck`
Expected: 无错误（`channels.ts` 的 schema 映射是穷举类型，漏 import 会立刻报错）

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src packages/shared/test
git commit -m "feat(cua): restore helper permission drag IPC contract"
```

---

## Task 2: 摘掉 native 权限弹窗（核心改动）

**Files:**
- Modify: `packages/desktop/src/main/cuaAccessibilitySettings.ts`（`runSession` 内 stage 循环）
- Test: `packages/desktop/test/cuaAccessibilitySettings.test.ts`

**Interfaces:**
- Consumes: 无（本任务只删除调用）
- Produces: `OpenCuaAccessibilitySettingsOptions` 移除 `requestHelperAccessibilityPermission` / `requestHelperScreenRecordingPermission` 两个注入点；`HelperPermissionRequestContext` 不再在本文件构造。`verifyHelperPermissionIdentityUnchanged` 返回的 `launchFingerprint` 改为交给 Task 4 的缓存消费。

- [ ] **Step 1: 写失败测试 —— 锁死核心不变量**

在 `packages/desktop/test/cuaAccessibilitySettings.test.ts` 追加：

```ts
it("绝不触发 native 权限请求（不弹系统弹窗）", async () => {
  const requestCalls: string[] = [];
  const openedUrls: string[] = [];
  const result = await openCuaPermissionOnboarding({
    platform: "darwin",
    requiredPermissions: ["screen_recording", "accessibility"],
    ensureHelperInstalled: async () => "/tmp/helper/ZCode Computer Use.app",
    verifyHelperInstalled: async () => {},
    resolveHelperIdentity: async (appPath) => ({
      appPath,
      executablePath: `${appPath}/Contents/MacOS/ZCode Computer Use`,
      displayName: "ZCode Computer Use",
      bundleId: "dev.zcode.cua-helper",
    }),
    // 这两个注入点在改造后不应存在；若实现回退到调用它们，本测试立刻失败
    requestHelperAccessibilityPermission: async () => {
      requestCalls.push("accessibility");
    },
    requestHelperScreenRecordingPermission: async () => {
      requestCalls.push("screen_recording");
    },
    openSettingsUrl: async (url) => {
      openedUrls.push(url);
    },
    openSettingsAndWaitForReturn: async ({ openSettings }) => {
      await openSettings();
    },
  } as never);

  expect(requestCalls).toEqual([]);
  expect(openedUrls).toEqual([
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  ]);
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaAccessibilitySettings.test.ts -t "绝不触发"`
Expected: FAIL — `requestCalls` 为 `["screen_recording", "accessibility"]`

- [ ] **Step 3: 实现 —— 删除请求调用，保留验签**

在 `cuaAccessibilitySettings.ts` 的 `runSession` stage 循环里，删除从 `const requestContext: HelperPermissionRequestContext = {` 到 `await request(session.identity.appPath, requestContext);` 以及紧随的 `if (controller.signal.aborted) throw controller.signal.reason;` 整段（即 `const request = permission === "accessibility" ? ... : ...;` 也一并删除）。

`verifyHelperPermissionIdentityUnchanged(session.identity, options, "launch")` 的调用**必须保留**，但其返回值改为登记到会话上，供 Task 4 的拖拽缓存复用。在 `ActiveOnboardingSession` 接口加一个字段：

```ts
  /** 每 stage 重新建立的验签指纹证据；拖拽缓存据此判断"自验签以来字节未变"。 */
  launchFingerprint?: CuaHelperBundleFingerprint;
```

并把原 `const launchFingerprint = await verifyHelperPermissionIdentityUnchanged(...)` 改为：

```ts
        // 保留每 stage 重新验签：用户停留设置页期间同 UID 进程可能替换安装目录。
        // 原先这份指纹交给 requestHelper*ViaLaunchServices 在 open(2) 前同步终检；
        // 改造后 native 请求已删除，终检下沉到 dragstart（见 desktopCuaPermissionIpc）。
        session.launchFingerprint = await verifyHelperPermissionIdentityUnchanged(
          session.identity,
          options,
          "launch",
        );
```

从 `OpenCuaAccessibilitySettingsOptions` 接口删除 `requestHelperAccessibilityPermission` 与 `requestHelperScreenRecordingPermission` 两个可选注入点，并删除文件顶部对 `requestHelperAccessibilityPermissionViaLaunchServices`、`requestHelperScreenRecordingPermissionViaLaunchServices`、`HelperPermissionRequestContext` 的 import。同时删除已无引用的 `DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS` 与 `permissionRequestTimeoutMs` 选项。

在文件头部注释追加一行说明改造：

```ts
// 2026-08-20：授权引导不再触发任何 native 权限弹窗（AXIsProcessTrustedWithOptions{prompt:true} /
// CGRequestScreenCaptureAccess）。Helper 进入 TCC 列表改由用户从浮窗拖拽 .app 完成，
// 每 stage 的验签指纹交由 dragstart 前的同步比对消费。
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaAccessibilitySettings.test.ts`
Expected: PASS。**注意**：原有断言「会调用 request*」的用例会失败，逐个改为断言不调用；断言 `openSettingsUrl` 顺序、会话协调、recovery 权的用例应全部保持通过。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/cuaAccessibilitySettings.ts packages/desktop/test/cuaAccessibilitySettings.test.ts
git commit -m "feat(cua): stop triggering native permission prompts in onboarding"
```

---

## Task 3: 恢复 `prepareCuaHelperPermissionDrag`

**Files:**
- Modify: `packages/desktop/src/main/cuaAccessibilitySettings.ts`
- Test: `packages/desktop/test/cuaAccessibilitySettings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PrepareCuaHelperPermissionDragResult`
- Produces: `prepareCuaHelperPermissionDrag(options?: PrepareCuaHelperPermissionDragOptions): Promise<PrepareCuaHelperPermissionDragResult & { helperBundleFingerprint?: CuaHelperBundleFingerprint }>`；`PrepareCuaHelperPermissionDragOptions { env?; platform?; logger?; ensureHelperInstalled?; bundledHelperAppPath?; verifyHelperInstalled?; resolveHelperIdentity? }`

- [ ] **Step 1: 写失败测试**

```ts
it("验签期间 bundle 被改则拒绝预热", async () => {
  let verifyCount = 0;
  const result = await prepareCuaHelperPermissionDrag({
    platform: "darwin",
    ensureHelperInstalled: async () => helperFixturePath,
    verifyHelperInstalled: async () => {
      verifyCount += 1;
      // 在验签过程中改动 bundle 字节，指纹必须失配
      writeFileSync(join(helperFixturePath, "Contents", "Info.plist"), `<plist/>${verifyCount}`);
    },
    resolveHelperIdentity: async (appPath) => ({
      appPath,
      executablePath: `${appPath}/Contents/MacOS/x`,
      displayName: "ZCode Computer Use",
      bundleId: "dev.zcode.cua-helper",
    }),
  });
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/changed while its drag signature was being verified/);
});

it("预热成功返回路径与身份，但不泄漏指纹给 renderer 形状", async () => {
  const result = await prepareCuaHelperPermissionDrag({
    platform: "darwin",
    ensureHelperInstalled: async () => helperFixturePath,
    verifyHelperInstalled: async () => {},
    resolveHelperIdentity: async (appPath) => ({
      appPath,
      executablePath: `${appPath}/Contents/MacOS/x`,
      displayName: "ZCode Computer Use",
      bundleId: "dev.zcode.cua-helper",
    }),
  });
  expect(result.success).toBe(true);
  expect(result.helperAppPath).toBe(helperFixturePath);
  expect(result.helperDisplayName).toBe("ZCode Computer Use");
  expect(result.helperBundleFingerprint).toBeTruthy();
});
```

`helperFixturePath` 用 `mkdtempSync` 造一个含 `Contents/MacOS/x`、`Contents/Info.plist`、`Contents/_CodeSignature/CodeResources`、`Contents/Resources/` 的假 bundle，`afterEach` 清理。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaAccessibilitySettings.test.ts -t "预热"`
Expected: FAIL — `prepareCuaHelperPermissionDrag is not a function`

- [ ] **Step 3: 实现**

在 `cuaAccessibilitySettings.ts` 追加（顺序至关重要：**先抓指纹快照，再 verify，验签后与 identity 读取后各复核一次**；旧实现曾在 ensure/verify 返回后才抓指纹，攻击者可在两者之间替换 .app 使恶意字节成为"已验证指纹"）：

```ts
export interface PrepareCuaHelperPermissionDragOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: OpenCuaAccessibilitySettingsOptions["logger"];
  ensureHelperInstalled?: () => Promise<string>;
  bundledHelperAppPath?: string;
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
}

export interface PrepareCuaHelperPermissionDragMainResult
  extends PrepareCuaHelperPermissionDragResult {
  /** 只允许 main 内存缓存消费，绝不跨 IPC 返回 renderer。 */
  helperBundleFingerprint?: CuaHelperBundleFingerprint;
}

// 拖拽授权与 onboarding 最终引向同一个 TCC 授权主体，安全校验必须一致：磁盘上被旧版 / 坏签名 /
// 错误 Team / 同用户可写内容替换的 .app 若被拖进权限列表，TCC 授权会落到错误主体，绕过整个
// Team-pin 设计。所以拖拽前必须走同一条 install+verify。但 Electron 原生拖拽要求 dragstart 里
// *同步* 调用 startDrag，等不了这些异步 I/O —— 故拆到本函数预热，dragstart 只读缓存。
export async function prepareCuaHelperPermissionDrag(
  options: PrepareCuaHelperPermissionDragOptions = {},
): Promise<PrepareCuaHelperPermissionDragMainResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { success: false, error: "ZCode Computer Use permissions are only available on macOS." };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled
    )();
    const verifiedFingerprint = captureCuaHelperBundleFingerprint(helperAppPath);
    await (options.verifyHelperInstalled ?? defaultInstaller?.verifyInstalled)?.(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag signature was being verified");
    }
    const identity = await (
      options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
    )(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag identity was being resolved");
    }
    return {
      success: true,
      helperAppPath,
      helperDisplayName: identity.displayName,
      helperBundleId: identity.bundleId,
      helperBundleFingerprint: verifiedFingerprint,
    };
  } catch (error) {
    const message = messageOf(error);
    options.logger?.warn(
      "[cua-permission-onboarding] helper install/verify failed; refusing to prepare drag of an unverified Helper",
      message,
    );
    return { success: false, error: message };
  }
}
```

同时删除文件末尾那条已过时的审计注释（`// 2026-08 审计：openCuaAccessibilitySettings / prepareCuaHelperPermissionDrag 已删除…`），改为记录本次恢复的原因。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaAccessibilitySettings.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/cuaAccessibilitySettings.ts packages/desktop/test/cuaAccessibilitySettings.test.ts
git commit -m "feat(cua): restore verified helper drag preparation"
```

---

## Task 4: 恢复 drag IPC handlers 与 renderer 桥

**Files:**
- Modify: `packages/desktop/src/main/desktopCuaPermissionIpc.ts`
- Modify: `packages/desktop/src/preload/index.ts:616` 附近
- Modify: `packages/desktop/src/renderer/src/desktopPlatform.ts:48` 附近
- Modify: `packages/client/src/globals.d.ts:220` 附近
- Test: `packages/desktop/test/desktopCuaPermissionIpc.test.ts`

**Interfaces:**
- Consumes: Task 1 通道常量、Task 3 的 `prepareCuaHelperPermissionDrag`
- Produces: 两个 IPC handler；renderer 侧 `platform.prepareCuaHelperPermissionDrag()` / `platform.startCuaHelperPermissionDrag()`

- [ ] **Step 1: 写失败测试**

```ts
it("指纹在 prepare 之后被篡改时拒绝拖拽", async () => {
  const startDragCalls: unknown[] = [];
  const sender = { startDrag: (item: unknown) => startDragCalls.push(item) };
  registerCuaPermissionIpc({ ipcMain: fakeIpcMain, logger, /* … */ });

  await fakeIpcMain.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag);
  // 篡改 bundle：dragstart 的同步指纹比对必须拦住
  writeFileSync(join(helperFixturePath, "Contents", "Info.plist"), "<plist>tampered</plist>");
  fakeIpcMain.emit(PlatformChannels.StartCuaHelperPermissionDrag, { sender });

  expect(startDragCalls).toEqual([]);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("refusing to drag a possibly-tampered bundle"),
  );
});

it("预热后未被篡改则同步发起拖拽", async () => {
  const startDragCalls: Array<{ file: string }> = [];
  const sender = { startDrag: (item: { file: string }) => startDragCalls.push(item) };
  registerCuaPermissionIpc({ ipcMain: fakeIpcMain, logger, /* … */ });

  await fakeIpcMain.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag);
  fakeIpcMain.emit(PlatformChannels.StartCuaHelperPermissionDrag, { sender });

  expect(startDragCalls).toHaveLength(1);
  expect(startDragCalls[0]!.file).toBe(helperFixturePath);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/desktop exec vitest run test/desktopCuaPermissionIpc.test.ts -t "拖拽"`
Expected: FAIL — 通道无 handler

- [ ] **Step 3: 实现**

`desktopCuaPermissionIpc.ts` 顶部 import 追加 `nativeImage`（来自 `electron`）、`cuaHelperBundleFingerprintUnchanged` 与 `prepareCuaHelperPermissionDrag`（来自 `./cuaAccessibilitySettings.js`），并加入常量与缓存：

```ts
// 1x1 透明 PNG。startDrag 在 macOS 上要求 icon 非空（electron.d.ts: "The image must be
// non-empty on macOS"），拿不到系统图标时用它兜底，避免 startDrag 抛异常导致完全拖不动。
const CUA_HELPER_DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
```

在 `registerCuaPermissionIpc` 作用域内加入缓存与刷新：

```ts
  // 原生文件拖拽必须在 dragstart 链路里*同步*调用 startDrag，不能等 install/verify 这类异步 I/O
  // （否则错过 OS 拖拽手势窗口，用户拖不出任何文件）。故浮窗挂载时预热并缓存已验证路径 + 指纹。
  let verifiedHelperAppPath: string | null = null;
  let verifiedHelperFingerprint: string | null = null;

  function cacheVerifiedHelper(helperAppPath: string, verifiedFingerprint: string): void {
    verifiedHelperAppPath = helperAppPath;
    verifiedHelperFingerprint = verifiedFingerprint;
  }

  function clearVerifiedHelper(): void {
    verifiedHelperAppPath = null;
    verifiedHelperFingerprint = null;
  }

  async function refreshVerifiedHelperAppPath(): Promise<void> {
    const result = await prepareCuaHelperPermissionDrag({ logger: options.logger });
    if (result.success && result.helperAppPath && result.helperBundleFingerprint) {
      cacheVerifiedHelper(result.helperAppPath, result.helperBundleFingerprint);
    } else {
      clearVerifiedHelper();
      options.logger.warn("[cua-permission-onboarding] prepare helper drag failed", result.error);
    }
  }

  ipcMain.handle(PlatformChannels.PrepareCuaHelperPermissionDrag, async () => {
    const result = await prepareCuaHelperPermissionDrag({ logger: options.logger });
    if (result.success && result.helperAppPath && result.helperBundleFingerprint) {
      cacheVerifiedHelper(result.helperAppPath, result.helperBundleFingerprint);
    } else {
      clearVerifiedHelper();
      options.logger.warn("[cua-permission-onboarding] prepare helper drag failed", result.error);
    }
    // 指纹绝不跨 IPC 返回 renderer
    return {
      success: result.success,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.helperAppPath !== undefined ? { helperAppPath: result.helperAppPath } : {}),
      ...(result.helperDisplayName !== undefined
        ? { helperDisplayName: result.helperDisplayName }
        : {}),
      ...(result.helperBundleId !== undefined ? { helperBundleId: result.helperBundleId } : {}),
    };
  });

  ipcMain.on(PlatformChannels.StartCuaHelperPermissionDrag, (event) => {
    const helperAppPath = verifiedHelperAppPath;
    const fingerprint = verifiedHelperFingerprint;
    if (!helperAppPath || !fingerprint) {
      // 尚未预热：这里绝不能做异步 install/verify（会错过拖拽手势）。后台补一次让下次可用。
      options.logger.warn(
        "[cua-permission-onboarding] helper drag not prepared yet; verifying in background for next drag",
      );
      void refreshVerifiedHelperAppPath();
      return;
    }
    // TOCTOU 门：prepare(验签) 到此刻之间，同 UID 攻击者可能覆写 Helper.app，而 TCC 绑定的是被拖入的
    // bundle 身份。同步比对字节指纹（微秒级，不会错过手势）；不符即拒拖 + 清缓存重新 prepare。
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, fingerprint)) {
      options.logger.warn(
        "[cua-permission-onboarding] cached helper changed since verification; refusing to drag a possibly-tampered bundle",
      );
      clearVerifiedHelper();
      void refreshVerifiedHelperAppPath();
      return;
    }
    const namedIcon = nativeImage.createFromNamedImage("NSApplicationIcon");
    const icon = namedIcon.isEmpty()
      ? nativeImage.createFromDataURL(CUA_HELPER_DRAG_ICON_DATA_URL)
      : namedIcon;
    try {
      event.sender.startDrag({ file: helperAppPath, icon });
    } catch (error) {
      options.logger.warn(
        "[cua-permission-onboarding] helper drag failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    void refreshVerifiedHelperAppPath();
  });
```

在现有 `OpenCuaPermissionOnboarding` handler 的 `return result;` 之前插入（onboarding 含用户在设置页的长等待，不能把 stage 启动时的旧验签证据当作"已验证指纹"，成功后另起一次 prepare）：

```ts
    if (result.success) void refreshVerifiedHelperAppPath();
```

`preload/index.ts` 追加：

```ts
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
```

`renderer/src/desktopPlatform.ts` 追加：

```ts
    prepareCuaHelperPermissionDrag: window.zcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.zcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.zcode.startCuaHelperPermissionDrag
      ? () => window.zcode.startCuaHelperPermissionDrag?.()
      : undefined,
```

`packages/client/src/globals.d.ts` 补上对应两条可选声明（形状与 preload 一致）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/desktop exec vitest run test/desktopCuaPermissionIpc.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src packages/client/src/globals.d.ts packages/desktop/test
git commit -m "feat(cua): restore helper permission drag IPC handlers"
```

---

## Task 5: 系统设置窗口 bounds CLI（吸附数据源）

**Files:**
- Create: `packages/desktop/native/macos-window-bounds/main.swift`
- Create: `packages/desktop/scripts/build-macos-window-bounds.mjs`
- Create: `packages/desktop/src/main/cuaSystemSettingsWindowWatcher.ts`
- Modify: `packages/desktop/electron-builder.config.js`
- Modify: `packages/desktop/package.json`（构建脚本挂进 prepare 链）
- Test: `packages/desktop/test/cuaSystemSettingsWindowWatcher.test.ts`

**Interfaces:**
- Produces: `createSystemSettingsWindowWatcher(options): { start(): void; stop(): void; latest(): SettingsWindowBounds | null }`，其中 `SettingsWindowBounds = { x: number; y: number; width: number; height: number }`

- [ ] **Step 1: 写失败测试**

```ts
it("解析 CLI 输出的 JSON 行并暴露最新 bounds", () => {
  const watcher = createSystemSettingsWindowWatcher({
    spawnProcess: () => fakeChild,
    logger,
  });
  watcher.start();
  fakeChild.stdout.emit("data", '[{"x":134,"y":157,"w":723,"h":752,"layer":0}]\n');
  expect(watcher.latest()).toEqual({ x: 134, y: 157, width: 723, height: 752 });
});

it("CLI 崩溃或输出损坏时 fail-open 返回 null，不抛错", () => {
  const watcher = createSystemSettingsWindowWatcher({
    spawnProcess: () => fakeChild,
    logger,
  });
  watcher.start();
  fakeChild.stdout.emit("data", "not-json\n");
  expect(watcher.latest()).toBeNull();
  fakeChild.emit("exit", 1);
  expect(() => watcher.latest()).not.toThrow();
  expect(watcher.latest()).toBeNull();
});

it("忽略非 layer-0 窗口（面板/浮层不是主窗口）", () => {
  const watcher = createSystemSettingsWindowWatcher({ spawnProcess: () => fakeChild, logger });
  watcher.start();
  fakeChild.stdout.emit("data", '[{"x":0,"y":0,"w":100,"h":40,"layer":25}]\n');
  expect(watcher.latest()).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaSystemSettingsWindowWatcher.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`native/macos-window-bounds/main.swift`（**不需要任何 TCC 权限**；只有取窗口*图像*才需要 Screen Recording）：

```swift
import CoreGraphics
import Foundation

// 输出 System Settings 主窗口几何。CGWindowListCopyWindowInfo 自 macOS 10.5 起可用，
// 且取 bounds 不需要 Accessibility / Screen Recording —— 这一点是本方案成立的前提：
// 授权引导运行时恰恰还没有这两个权限。
let intervalMs = UInt32(CommandLine.arguments.dropFirst().first.flatMap { UInt32($0) } ?? 150)
let owners = ["System Settings", "System Preferences", "系统设置", "系統設定"]
setvbuf(stdout, nil, _IOLBF, 0)  // 行缓冲：父进程要逐行读

while true {
    var out: [[String: Any]] = []
    if let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] {
        for w in list {
            guard let owner = w[kCGWindowOwnerName as String] as? String,
                  owners.contains(where: { owner.contains($0) }),
                  let dict = w[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: dict as CFDictionary)
            else { continue }
            out.append([
                "x": rect.origin.x, "y": rect.origin.y,
                "w": rect.size.width, "h": rect.size.height,
                "layer": w[kCGWindowLayer as String] as? Int ?? -1,
            ])
        }
    }
    if let data = try? JSONSerialization.data(withJSONObject: out),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
    usleep(intervalMs * 1000)
}
```

`scripts/build-macos-window-bounds.mjs`：非 darwin 直接跳过；`swiftc -O native/macos-window-bounds/main.swift -o resources/macos-window-bounds/zcode-window-bounds`；产物目录加进 `.gitignore`（`ci-repo-hygiene.mjs` 拒绝构建产物入库）。

`src/main/cuaSystemSettingsWindowWatcher.ts`：`spawn` 一次 CLI（**不是每帧起进程**），按行解析 stdout，取第一个 `layer === 0` 的窗口；`exit`/`error`/解析失败一律把 `latest()` 归零并**不抛错**；`stop()` 必须 kill 子进程。所有 timer 用 `unref()`，但注意验证时 vitest 自身会保活事件循环，需要 tsx 子进程探针才能证明真的不阻止退出。

`electron-builder.config.js`：照 `shouldPackageWindowsBrowserImportHelper` 的模式，darwin target 时把 `resources/macos-window-bounds/` 加入 `extraResources`；macOS 侧无需额外签名步骤（随 app 签名遍历覆盖），但需在 `assertPackagedNativeResourcePolicy` 中登记该路径为允许的原生资源。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaSystemSettingsWindowWatcher.test.ts`
Expected: PASS

Run: `node packages/desktop/scripts/build-macos-window-bounds.mjs && ./packages/desktop/resources/macos-window-bounds/zcode-window-bounds 150 | head -2`
Expected: 打开系统设置后能看到形如 `[{"x":134,"y":157,"w":723,"h":752,"layer":0}]` 的行

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/native packages/desktop/scripts packages/desktop/src/main/cuaSystemSettingsWindowWatcher.ts \
        packages/desktop/electron-builder.config.js packages/desktop/package.json packages/desktop/test .gitignore
git commit -m "feat(cua): add macOS system settings window bounds watcher"
```

---

## Task 6: 拖拽浮窗

**Files:**
- Create: `packages/desktop/src/main/cuaPermissionPanelPositioner.ts`
- Create: `packages/desktop/src/main/cuaPermissionDragPanel.ts`
- Create: `packages/desktop/src/renderer/permission-panel/index.html`
- Test: `packages/desktop/test/cuaPermissionPanelPositioner.test.ts`、`packages/desktop/test/cuaPermissionDragPanel.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `createSystemSettingsWindowWatcher`、Task 1 通道
- Produces: `resolvePanelBounds({ settings, display, panel }): Rect`；`createCuaPermissionDragPanel(options): { show(permission: CuaPermissionKind): void; hide(): void; destroy(): void }`

- [ ] **Step 1: 写失败测试**

```ts
// positioner：纯函数，覆盖吸附与 fail-open
// 全部输出必须是整数（Electron setBounds 要求），统一用 Math.round。
// 本例特意选不触发下缘夹回的 settings：吸附 y = 157+600-6 = 751，
// 751+124 = 875 ≤ 可视区下缘 33+949 = 982，故能纯粹验证吸附公式本身。
it("有 settings bounds 时吸附到其底部居中", () => {
  expect(
    resolvePanelBounds({
      settings: { x: 134, y: 157, width: 720, height: 600 },
      display: { x: 0, y: 33, width: 1512, height: 949 },
      panel: { width: 560, height: 124 },
    }),
  ).toEqual({ x: 214, y: 751, width: 560, height: 124 });
});

it("无 settings bounds 时退回屏幕底部居中（fail-open）", () => {
  expect(
    resolvePanelBounds({
      settings: null,
      display: { x: 0, y: 33, width: 1512, height: 949 },
      panel: { width: 560, height: 124 },
    }),
  ).toEqual({ x: 476, y: 830, width: 560, height: 124 });
});

it("吸附位置超出屏幕下缘时夹回可视区内", () => {
  const bounds = resolvePanelBounds({
    settings: { x: 0, y: 800, width: 700, height: 400 },
    display: { x: 0, y: 33, width: 1512, height: 949 },
    panel: { width: 560, height: 124 },
  });
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(33 + 949);
});
```

```ts
// 浮窗：所有终态都必须销毁，避免像 PiP 那样凭空常驻
it.each(["success", "canceled", "timeout", "origin-destroyed"])(
  "%s 终态必须销毁浮窗",
  (terminal) => {
    const panel = createCuaPermissionDragPanel({ createWindow: () => fakeWindow, watcher, logger });
    panel.show("accessibility");
    panel.destroy();
    expect(fakeWindow.destroy).toHaveBeenCalledTimes(1);
    expect(watcher.stop).toHaveBeenCalledTimes(1);
  },
);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaPermissionPanelPositioner.test.ts test/cuaPermissionDragPanel.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`cuaPermissionPanelPositioner.ts`：纯函数，无 Electron 依赖（便于单测）。有 `settings` 时 x 取 `settings.x + (settings.width - panel.width)/2`、y 取 `settings.y + settings.height - 6`（与设置窗口底边微重叠，视觉上吸附）；无则 x 居中于 display、y 取 `display.y + display.height - panel.height - 28`；最后统一夹进 display 可视区。

`cuaPermissionDragPanel.ts`：spike 已验证过的属性组合原样落地：

```ts
const win = new BrowserWindow({
  width, height,
  frame: false,
  transparent: true,
  hasShadow: true,
  resizable: false,
  focusable: false,   // 关键：一点就把 System Settings 踢到后台就毁了整个流程
  skipTaskbar: true,
  show: false,
  webPreferences: { preload, contextIsolation: true },
});
win.once("ready-to-show", () => {
  win.showInactive();                                    // 显示但不激活
  win.setAlwaysOnTop(true, "screen-saver");              // 需压过 System Settings
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
});
```

位置由 watcher 的 `latest()` 驱动，节流到 ~150ms，仅在目标矩形变化时 `setBounds`（避免每 tick 都触发窗口移动）。`destroy()` 必须同时 `watcher.stop()`，且对已 destroyed 的窗口幂等。

`renderer/permission-panel/index.html`：一个拖拽 tile + 文案（"把 ZCode Computer Use 拖到上面的列表"）。`dragstart` 里 `event.preventDefault()` 后调 `platform.startCuaHelperPermissionDrag()`；挂载时先调 `prepareCuaHelperPermissionDrag()` 预热。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/desktop exec vitest run test/cuaPermissionPanelPositioner.test.ts test/cuaPermissionDragPanel.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/cuaPermissionPanelPositioner.ts \
        packages/desktop/src/main/cuaPermissionDragPanel.ts \
        packages/desktop/src/renderer/permission-panel packages/desktop/test
git commit -m "feat(cua): add draggable permission panel anchored to system settings"
```

---

## Task 7: 首弹窗（权限清单模态）与串联

**Files:**
- Create: `packages/ui/src/cua/CuaPermissionChecklistModal.tsx`
- Modify: `packages/ui/src/settings/ComputerUseSection.tsx:330-400`
- Modify: `packages/ui/src/cua/CuaPermissionGateController.tsx`
- Modify: `packages/desktop/src/main/desktopCuaPermissionIpc.ts`（onboarding 期间 show/hide 浮窗）
- Test: `packages/ui/test/cuaPermissionChecklistModal.test.tsx`

**Interfaces:**
- Consumes: `isCuaPermissionTccGranted`（`packages/ui/src/lib/cuaPermissionStatusStore.ts`）、`platform.openCuaPermissionOnboarding`
- Produces: `<CuaPermissionChecklistModal open onContinue onCancel />`

- [ ] **Step 1: 写失败测试**

```tsx
it("两项权限都列出，且状态取自 TCC 判定而非功能探针", () => {
  // 严格复刻上游门控语义：只读刷新时 screenCaptureProbeOk 恒 false
  const status = {
    accessibility: "granted",
    screenRecording: "granted",
    accessibilityProbeOk: false,
    screenCaptureProbeOk: false,
  };
  render(<CuaPermissionChecklistModal open status={status} onContinue={noop} onCancel={noop} />);
  expect(screen.getByText("辅助功能")).toBeInTheDocument();
  expect(screen.getByText("屏幕录制")).toBeInTheDocument();
  // 若误用带 probe 的判定，这里会显示「待授权」
  expect(screen.queryByText("待授权")).not.toBeInTheDocument();
  expect(screen.getAllByText("已授权")).toHaveLength(2);
});

it("点击继续时只请求仍缺失的权限", async () => {
  const onContinue = vi.fn();
  render(
    <CuaPermissionChecklistModal
      open
      status={{ accessibility: "denied", screenRecording: "granted" }}
      onContinue={onContinue}
      onCancel={noop}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "继续" }));
  expect(onContinue).toHaveBeenCalledWith(["accessibility"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/ui exec vitest run test/cuaPermissionChecklistModal.test.tsx`
Expected: FAIL — 组件不存在

- [ ] **Step 3: 实现**

`CuaPermissionChecklistModal.tsx`：两行权限（辅助功能 / 屏幕录制），每行状态用 `isCuaPermissionTccGranted` 派生，**不读** `*ProbeOk`。「继续」回调只传仍缺失的权限数组。文案走 `react-intl`，新增 id 挂在既有 `cuaPermission.*` 命名空间下。

`ComputerUseSection.tsx`：`openPermissionSettings` 前先展示该模态，用户点「继续」后再调 `platform.openCuaPermissionOnboarding({ requiredPermissions })`。现有的并发/失效保护（`permissionStatusCheckTokenRef`、`helperContextKeyRef`、`returnRecoveryRef`、让出 macrotask 后复查）**必须原样保留** —— 它们防的是「另一窗口刚授权完 / 刷新 in-flight / workspace A→B 切换」导致给错误上下文打开设置页。

`desktopCuaPermissionIpc.ts`：在 `openCuaPermissionOnboarding` 的 `openSettingsAndWaitForReturn` 适配器里，打开设置页后 `panel.show(permission)`，该 stage 结束或会话进入任何终态（成功/取消/超时/origin destroyed）时 `panel.hide()`，`finally` 里 `panel.destroy()`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/ui exec vitest run test/cuaPermissionChecklistModal.test.tsx`
Expected: PASS

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。注意根 `pnpm typecheck` **不覆盖** desktop renderer/main tsconfig，desktop 与 ui 的 `test/*.test.ts` 更无 tsconfig 归属，需要按 typecheck 覆盖盲区的临时配方单独校验。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src packages/ui/test packages/desktop/src/main/desktopCuaPermissionIpc.ts
git commit -m "feat(cua): add permission checklist modal and wire drag panel"
```

---

## Task 8: 端到端手工验证

**Files:** 无（验证任务）

- [ ] **Step 1: 造干净的 TCC 状态**

```bash
tccutil reset Accessibility dev.zcode.cua-helper.dev
tccutil reset ScreenCapture dev.zcode.cua-helper.dev
sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select service,auth_value from access where client='dev.zcode.cua-helper.dev';"
```
Expected: 无输出（零条目 = 模拟全新用户）

- [ ] **Step 2: 起 dev**

```bash
nohup env ZCODE_CUA_DEV_MODE=1 ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  pnpm run dev:desktop > /tmp/zcode-desktop-dev.log 2>&1 < /dev/null & disown
```
就绪判据：`grep -a "cua helper ready at" /tmp/zcode-desktop-dev.log`。**不要**用 harness 的 background 启动 dev（任务被清理会把整条 dev 链带走）；失败只认 `ELIFECYCLE` / `exited with code [1-9]`。

- [ ] **Step 3: 走一遍授权流程，逐条核对**

- [ ] 全程**没有**任何 "would like to control this computer" / 屏幕录制系统弹窗
- [ ] 首弹窗列出辅助功能 + 屏幕录制两项
- [ ] 点继续后系统设置打开到对应页，浮窗出现并**吸附在系统设置窗口底部**
- [ ] 点/拖浮窗时系统设置**没有**被踢到后台
- [ ] 拖动 tile 能把 Helper 拖进列表，`auth_value` 直接为 2
- [ ] 拖完浮窗即时反馈已授权并推进到下一项
- [ ] 会话终态后浮窗销毁，且 `zcode-window-bounds` 子进程随之退出（`pgrep -f zcode-window-bounds` 为空）

- [ ] **Step 4: 核对 TCC 结果**

```bash
sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select service,auth_value from access where client='dev.zcode.cua-helper.dev';"
```
Expected: 两条记录 `auth_value=2`

- [ ] **Step 5: 提交验证记录**

把实测结果补进本计划末尾，提交。

---

## 自查

**Spec 覆盖**：不弹窗 → Task 2；拖拽入列 → Task 3/4；首弹窗列两权限 → Task 7；吸附 → Task 5/6；保留会话协调/验签/重启 → Task 2 显式保留 + Task 7 保留并发保护。

**类型一致性**：`PrepareCuaHelperPermissionDragResult`（shared，无指纹）与 `PrepareCuaHelperPermissionDragMainResult`（main，含指纹）严格区分，Task 4 的 handler 显式剥离指纹字段后才返回 renderer。`captureCuaHelperBundleFingerprint` / `cuaHelperBundleFingerprintUnchanged` 沿用 `cuaAccessibilitySettings.ts` 现有导出，未重新定义。

**已知风险**：不弹窗后全新用户**只能靠拖拽**入列，没有第二条路 —— 小窗没看见或不会拖就会卡住。缓解措施是 Task 6 的吸附（让小窗紧贴用户视线焦点）与 Task 7 的清单模态（先说清要授哪两项）。若后续实测发现拖拽成功率不足，可在浮窗上补一条「打不开？点这里看图示」的静态引导，但不应回退到系统弹窗 —— 那是本次改造要消除的东西。

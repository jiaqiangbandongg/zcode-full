# Windows CUA 基于上游 Main 的正向迁移设计

> 日期：2026-08-04
>
> 状态：已确认
>
> 关联仓库：`C:\Users\dev\zcode-cua`、`C:\Users\dev\z-code`

## 1. 目标

以 `zcode-cua` 最新 `origin/main` 中上游已合入的实现为唯一基线，把 Windows 移植
分支上已经验证过的 Windows UIA、WGC、指针、剪贴板、AUMID 和 Helper runtime
能力正向迁移到该基线；随后让 `z-code` 当前分支通过显式本地 producer 路径消费新的
producer commit，恢复 clean consumer tree 下可生成、校验、暂存和打包的 Windows CUA
产品链路。用户要求本轮不 push，因此远端 Git SHA pin 与任意机器 clean install 在 producer
commit 可从 remote 获取后再闭环；本轮不得提交不可获取的 SHA 或 `file:` 本地路径。

本阶段只解决 P0 producer/consumer 闭环。Windows 设置页、顶部操作状态提示动效、
Esc 中断、用户输入失效检测、PiP 和 UIA-only 后台模式属于后续独立里程碑。

## 2. 已确认的仓库与历史边界

- `z-code` 继续在当前 `feat/cua-helper-app` 分支修改，不新建功能分支。
- `zcode-cua` 的工作基线是最新 `origin/main`；本地 `main` 对齐该基线后直接产生新 commit。
- Windows 移植当前 `codex/windows-cua-pointer-foundation` 分支保留为迁移来源和安全备份。
- Windows 移植从共同基线分叉出的 Windows 提交合并为一个新 commit，放在最新 `main` 顶部。
- 不改写、不 rebase、不覆盖任何上游已存在的 commit。
- 两个仓库都只创建本地 commit，不 push。

```text
zcode-cua

共同基线 f285ccd8
      |\
      | +-- 上游后续实现 -----------------------> 最新 origin/main
      |
      `---- Windows 移植 49 commits ------------> 迁移来源分支

目标：

最新 origin/main
      |
      `---- 一个新的 Windows forward-port commit


z-code

当前 feat/cua-helper-app
      |
      `---- 消费上述 producer commit，并修复 staging/package contract
```

## 3. 不采用的方案

### 3.1 逐个 rebase Windows 移植的 49 个提交

不采用。上游后续修改与 Windows 分支同时触及 broker、输入清理、观察状态、native
adapter 和生成产物。逐提交 rebase 会反复解决同一语义冲突，并可能把上游后续安全
修复恢复成旧实现。

### 3.2 把依赖退回 `0.3.28`

不采用。它会丢失上游在 `0.4.x`、`0.5.x` 上的安全、增量状态、PiP 和产品 Helper
修复，也违背“以上游修改为准”的约束。

### 3.3 只修改 z-code 中的版本常量

不采用。当前 `0.5.2` producer 不发布 `dist/windows-helper.js`，并缺少完整 Windows
WGC、pointer、clipboard ABI；消费者放宽检查会把缺失能力伪装成可用产品资源。

## 4. Producer 设计：zcode-cua

### 4.1 迁移原则

迁移按能力边界重新实现，不机械覆盖文件：

1. 先在最新 `main` 上写当前语义的失败测试；
2. 从 Windows 移植分支读取经过验证的 Windows 行为和 Win32/WGC 实现；
3. 把行为接入上游当前的 broker、incremental state、input cleanup 和 native loader；
4. 所有冲突均以上游当前实现为准，只补 Windows 分支；
5. 重新生成 `dist/`，不复制旧分支生成物。

### 4.2 Producer-owned runtime contract

Windows Helper 的入口和必需产物由 producer 在根 `package.json` 声明。建议采用以下
机器可读字段：

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

约束：

- `schema` 必须精确等于 `1`；未知 schema fail closed。
- 路径必须是 `/` 分隔、无 `.`/`..`、无绝对路径、无符号链接逃逸的 canonical relative path。
- package name 仍必须为 `@zcode/zcode-cua`。
- package version 是 provenance 信息，由实际 producer package 读取，不在 consumer 重复硬编码。
- producer commit 仍由 `pnpm-workspace.yaml` 的完整 Git SHA 固定；运行时 contract 不能替代 Git pin。
- `pnpm build` 必须生成 Helper entry；`pnpm pack --dry-run` 必须包含 entry、native build
  source 和 runtime 所需的 JS 依赖。

### 4.3 Windows 能力

正向迁移以下已经在旧 Windows 分支验证过的能力：

- UIA 应用、窗口、元素树和语义动作；
- Win32 普通应用的 canonical executable identity；
- packaged app 的 AUMID 激活和 HWND/PID 唯一解析；
- WGC display/window capture，以及 screenshot bounds 到 `state_image` 的映射；
- 虚拟桌面坐标下的 move、scroll、drag、mouse down/up；
- `CF_UNICODETEXT` 原生异步剪贴板读写；
- Windows Helper entry、named pipe、parent PID、ready/health 和终止清理；
- package artifact、focused unit 和可选 live smoke。

不改变 30-tool canonical surface，不增加 Windows 专用 MCP 工具。

### 4.4 必须保留的上游语义

- incremental/full observation 和 `state_id` ownership；
- window-bound state isolation 和 live element re-resolution；
- read/action delivery-state，不重放 `possibly_sent` action；
- bounded warmup、refresh marker 和 cancellation 语义；
- input hold registry 及 stop/cancel 后的 owned-input cleanup；
- macOS AX、ScreenCaptureKit、PID-targeted input、PiP 和签名 Helper 行为；
- Linux AT-SPI 行为；
- flat canonical 30-tool surface。

## 5. Consumer 设计：z-code

### 5.1 Staging

`packages/desktop/scripts/windows-cua-helper-assets.mjs` 从固定 Git dependency 的
`package.json.zcodeCuaRuntime.windows` 读取入口和 native addon，不再维护独立的
`0.3.28`/`dist/windows-helper.js` 真相。

staging 仍然负责：

- package name、schema、canonical path 和支持架构校验；
- Electron runtime、native PE machine 和文件类型校验；
- SHA-256 inventory；
- 临时目录构建后原子发布；
- 拒绝链接、越界、遗漏文件和源文件变更竞态。

生成的 `runtime-manifest.json` 保留实际 package version、entry、native addon、
Electron version、target triplet 和所有文件 digest。

### 5.2 Runtime resolver

`windowsCuaDevRuntime.ts` 使用同一个 producer contract/manifest schema 校验开发目录和
产品资源。产品运行时只信任 app `resources/tools/cua-helper`；`ZCODE_CUA_DEV_ROOT` 只作为
显式本地开发覆盖，不扫描相邻目录、不下载资源。

### 5.3 Clean checkout

`prepare-runtime-assets.mjs` 必须把 Windows CUA staging 纳入 Windows 本地和正式构建
资源准备流程，不能依赖被 `.gitignore` 忽略的历史 `bundled-tools` 文件。

```text
pnpm install（固定 producer SHA）
        |
        v
读取 producer runtime contract
        |
        +-- build/source artifacts 缺失 --> fail closed
        |
        v
校验 native / Electron / target arch
        |
        v
生成带 digest 的 staged runtime
        |
        v
electron-builder -> resources/tools/cua-helper
        |
        v
Desktop local Host 按需启动 Windows Helper
```

## 6. 生命周期与模式边界

```text
desktop-local + win32 + official plugin enabled
        |
        v
Host resolves verified packaged runtime
        |
        v
spawn Electron Node child
  argv: entry / socket / parent-pid
  env : bearer token（不进入 argv/日志）
        |
        v
ready + health exact PID evidence
        |
        v
Agent receives broker credentials
        |
        v
30-tool continuous local CUA

SSH / WSL / Docker / remote workspace / mobile /remote
        |
        `--> 不安装、不暂存、不启动独立 Windows Helper
```

本阶段不改变 desktop `continuous` 或 web remote `replayable` 语义，也不新增 remote
runtime、snapshot、queue 或 owner command。

## 7. 错误语义

| 场景                                      | 行为                                        |
| ----------------------------------------- | ------------------------------------------- |
| producer contract 缺失或 schema 不支持    | 构建/暂存 fail closed                       |
| entry/native addon 缺失                   | 构建/暂存 fail closed                       |
| staged digest、PE arch 或 Electron 不匹配 | runtime resolver 拒绝启动                   |
| WGC 不支持、锁屏、高完整性或窗口最小化    | 明确 unavailable，不返回空白成功            |
| AUMID/exe identity 不能唯一解析           | action 前拒绝，不猜测 PID                   |
| raw input 目标不是唯一前台 PID            | action 前拒绝，不自动激活、不重放           |
| clipboard 不在交互桌面或被占用超时        | bounded failure，不增加 PowerShell fallback |
| Helper stop/parent exit                   | 停止 admission，释放 owned input，关闭 pipe |

## 8. 测试策略

实现严格遵循 RED → GREEN → REFACTOR。

### 8.1 zcode-cua

先在最新 main 上补失败测试，证明当前缺口：

- package contract 和 `windows-helper` export/artifact；
- current-main broker 与 Windows Helper entry 的组合；
- WGC window/display capture capability 和 fail-closed 状态；
- pointer foreground PID gate、虚拟桌面和 cleanup；
- clipboard capability、bounded retry 和 exact Unicode round-trip；
- AUMID 激活、唯一 HWND/PID 和 Win32 executable identity；
- 上游 incremental state、cancellation、delivery-state 和 input cleanup 回归。

最低自动化门禁：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm rebuild:native
pnpm build
pnpm pack --dry-run
```

Windows live smoke 在自动化门禁后运行，覆盖 WGC、pointer、clipboard 和 30-tool surface；
它们不能替代 unit/integration tests。

### 8.2 z-code

先修改测试使其期望 producer-owned contract 和 clean staging，并观察旧实现失败：

- `windows-cua-helper-assets.test.ts`：实际 package version/contract、路径和 digest；
- `windowsCuaDevRuntime.test.ts`：manifest 与 producer contract，不再固定 `0.3.28`；
- `runtime-asset-scripts.test.ts`：Windows preparation 确实调用 CUA staging；
- product Helper integration：真实 child、named pipe、ready/health 和 clean stop；
- provenance/version coherence：两个 dependency alias 固定到同一个完整 commit。

最低自动化门禁：

```powershell
pnpm exec vitest run packages/desktop/test/windows-cua-helper-assets.test.ts
pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts
pnpm exec vitest run packages/services/test/windowsCuaDevHelperHost.test.ts
pnpm --filter @zcode/zcode-cua-plugin test
pnpm typecheck
pnpm lint
```

完成前还要从一个不含历史 `bundled-tools` 的临时目录执行资源准备和 package smoke。

## 9. Impact Brief

| 字段         | 结论                                                              |
| ------------ | ----------------------------------------------------------------- |
| Capability   | Computer Use / desktop-local CUA                                  |
| Change layer | validation、commit-effect、persistence/build artifact             |
| 操作模式     | planning                                                          |
| 主要入口     | desktop local Host、official CUA plugin、Windows packaged runtime |
| 明确不涉及   | 设置 UI、conversation stream、mobile replay、remote runtime       |

### 9.1 Surface/owner

| 场景                      | 入口                                  | Authority                                    | Commit/副作用         | 模式边界                |
| ------------------------- | ------------------------------------- | -------------------------------------------- | --------------------- | ----------------------- |
| Windows desktop local CUA | official plugin + Host                | pinned producer contract + packaged manifest | 启动本地 Helper child | desktop-continuous only |
| macOS desktop local CUA   | Computer Use settings + signed Helper | signed Helper/TCC                            | 安装或启动 Helper.app | 保持不变                |
| mobile remote             | `/remote` shared-host attachment      | 已存在 desktop Host                          | 只透传/附着           | 不创建 Helper           |

### 9.2 关系分级

| 等级           | 关系                                          | 原因                                   |
| -------------- | --------------------------------------------- | -------------------------------------- |
| must-inspect   | zcode-cua package -> z-code staging/resolver  | producer/consumer 同一运行时契约       |
| must-inspect   | Host lifecycle -> official plugin credentials | Helper ready 后才可投影 authority      |
| should-inspect | electron-builder/runtime preparation          | clean checkout 必须可重现              |
| invariant-only | macOS Helper/TCC/PiP                          | Windows 迁移不得改变上游 macOS 语义 |
| invariant-only | web remote shared-host                        | 不新增独立 runtime                     |
| evidence-only  | Windows live smoke                            | 证明实机行为，不定义产品边界           |

### 9.3 Graph drift

现有 feature graph 把 `boundary.cua-desktop-local` 描述为 macOS-only，但 live code 已包含
Windows Host 分支。规划阶段将其修正为 macOS/Windows desktop-local，并补入 Windows
runtime/Host code seeds；是否“发布可用”仍由本 spec 的 clean-package gate 决定。

## 10. 用例剪枝与验收

| ID      | Setup                                      | Action                 | Assertions                                  | 状态               |
| ------- | ------------------------------------------ | ---------------------- | ------------------------------------------- | ------------------ |
| WCFR-01 | clean zcode-cua latest main                | build/package          | contract、entry、native source 均在 pack 中 | accepted           |
| WCFR-02 | clean z-code checkout + fixed producer SHA | prepare runtime        | 不依赖 ignored 文件，生成 digest manifest   | accepted           |
| WCFR-03 | packaged Windows local desktop             | enable official plugin | Helper ready，30 tools 可调用，退出无孤儿   | accepted           |
| WCFR-04 | occluded non-minimized test window         | capture                | WGC 返回与 HWND 绑定的非空图片              | accepted           |
| WCFR-05 | minimized/locked/high-IL target            | capture/action         | fail closed，不伪造成功                     | accepted           |
| WCFR-06 | foreground target changes before raw input | dispatch               | action 被拒绝且不发送输入                   | accepted           |
| WCFR-07 | Unicode clipboard marker                   | write/read/restore     | 精确回读并恢复原值                          | accepted           |
| WCFR-08 | packaged Calculator AUMID                  | open/observe           | 唯一 HWND/PID，后续 state 绑定同一 app      | accepted           |
| WCFR-09 | macOS/Linux build/tests                    | regression             | 现有行为和 30-tool surface 不变             | accepted           |
| WCFR-10 | mobile/remote workspace                    | initialize             | 不暂存或启动独立 Helper                     | pruned：架构不变量 |

## 11. 提交策略

- `zcode-cua/main`：一个 `feat(windows): forward-port CUA runtime onto current main` commit。
- `z-code/feat/cua-helper-app`：设计 spec commit 与后续实现 commit 分开；实现使用
  Conventional Commits。
- 不 push、不建 MR、不创建 tag。

## 12. 完成定义

只有同时满足以下条件才进入 Windows 设置页里程碑：

1. `zcode-cua` 最新 main + 单一 Windows forward-port commit 可通过全部必需门禁；
2. 新 producer commit 可由 `z-code` 通过显式本地 producer 路径消费；
3. clean consumer tree 可生成 Windows runtime assets，且不依赖历史 ignored 文件；
4. packaged runtime resolver 能校验并启动真实 Helper；
5. WGC、pointer、clipboard、AUMID 和 30-tool focused/live evidence 均保留；
6. macOS/Linux、desktop/mobile/remote 不变量没有回归；
7. 两个仓库均有本地 commit，且没有 push；
8. 远端 Git SHA pin、lockfile 更新和任意机器 clean install 明确留到 producer commit push 后，
   不得在本轮伪造为通过。

# Windows Shell Provider 分阶段实施计划

> **给执行 agent 的要求：**实现本计划时必须按任务逐步执行，并使用 `superpowers:executing-plans`。所有任务步骤使用 checkbox (`- [ ]`) 追踪。

**目标：**Phase 1 在 Windows 上为 `Bash` tool 增加 Git Bash 自动解析，并预留外部 shell 注入口；Phase 2 再把“集成终端Shell”设置项、当前本机 shell 枚举和 UI 联调接上。

**架构：**继续把 `Bash` 作为 provider-visible tool，继续让 `ExecutionPort` 作为唯一进程边界。Phase 1 只在 `command.shellProfile === "posix-bash"` 的内部执行路径上增加 shell provider 选择，优先使用外部注入的 shell override，其次自动检测 Git Bash，最后回落到现有 `ComSpec` / `cmd.exe`。Phase 2 通过 AppSettings 和 SettingsPage 把用户选择映射成 Phase 1 的 shell override，不把 UI 选择逻辑塞进 adapter。

**技术栈：**TypeScript、Node.js `child_process.spawn`、`path.win32`、`path.posix`、Vitest adapter/core tests、现有 `ExecutionPort` contract、ZCode AppSettings、SettingsPage。

---

## 阶段边界

### Phase 1: Windows Bash shell resolve + 外部注入口

本阶段做：

- Windows `Bash` tool 自动检测 Git Bash。
- 检测不到 Git Bash 时保持 `ComSpec ?? "cmd.exe"` fallback。
- 增加内部 shell override contract，允许外侧在构造 `ExecutionRequest` 时主动指定 shell。
- override 只在 `shellProfile === "posix-bash"` 的 Bash tool 内部路径生效。
- cwd capture 从“按 platform 选择 wrapper”改成“按实际 shell dialect 选择 wrapper”。
- 不新增设置页、不枚举当前本机 shell、不做 UI 联调。

本阶段验收时，执行链路必须能接受这类外部注入：

```ts
const request: ExecutionRequest = {
  command: {
    mode: "shell",
    command: "arr=(a b); printf '%s\\n' \"${arr[1]}\"",
    shellProfile: "posix-bash",
    shellOverride: {
      dialect: "git-bash",
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
      source: "user-config",
    },
  },
  cwd: "C:\\repo",
  captureCwdAfterSuccess: true,
};
```

### Phase 2: 用户可配置“集成终端Shell”

本阶段做：

- 在设置面板增加 Windows only 的“集成终端Shell”下拉。
- 下拉第一项为“自动选择”。
- 下拉其余项来自当前本机可识别 shell 选项。
- 用户主动选择某个 shell 后，该选择成为 Bash shell resolve 的最高优先级。
- 用户选择“自动选择”或没有设置时，回到 Phase 1 的自动检测 Git Bash，然后 fallback 到 `cmd.exe`。
- 新增 shell 枚举服务、设置持久化、UI、i18n、联调测试。

本阶段不做：

- 不把 WSL 当作本地 Bash fallback。
- 不新增 provider-visible `PowerShell` tool。
- 不改变 generic `ExecutionPort` shell mode 的默认行为。

## 目标行为基线

### Windows Git Bash resolver

Git Bash 自动解析顺序：

1. 检查 `C:\Program Files\Git\bin\bash.exe`。
2. 检查 `C:\Program Files (x86)\Git\bin\bash.exe`。
3. 在 PATH 里找 `git`，再从 `git.exe` 位置反推 `..\..\bin\bash.exe`。
4. 如果都找不到，返回 `null`，由调用方 fallback。

Windows path 和 Git Bash path 需要双向转换：

- Windows path -> Git Bash path：
  - `C:\repo` 或 `C:/repo` -> `/c/repo`
  - UNC `\\server\share` -> `//server/share`
  - 其他情况把反斜杠替换成斜杠
- Git Bash path -> Windows path：
  - `//server/share` -> `\\server\share`
  - `/cygdrive/c/repo` -> `C:\repo`
  - `/c/repo` -> `C:\repo`
  - 其他情况把斜杠替换成反斜杠

bash provider 不是一个裸 shell path，而是一个 provider shape：

- `type: "bash"`
- `shellPath`
- `detached: true`
- `buildExecCommand(command, options)`：
  - 生成 POSIX shell wrapper
  - 可选 source shell snapshot
  - 禁用 `extglob` / zsh extended glob
  - 通过 `eval <quoted command>` 执行用户命令
  - 把 `pwd -P` 写入 cwd capture 文件
  - 在 Windows 上，把 temp/cwd 文件路径转换为 Git Bash path 后再嵌入 shell script
- `getSpawnArgs(commandString)`：
  - 无 snapshot 时返回 `["-c", "-l", commandString]`
  - 有 snapshot 时跳过 `-l`
- spawn env 包含 `SHELL=<shellPath>` 和 `GIT_EDITOR=true`

Windows 不设启动门槛：Git Bash 缺失时 fallback 到 `cmd.exe`，而不是让 CLI 启动失败或提示安装。

### Provider-visible 边界

- 本功能不应该改变 provider-visible `Bash` tool 名称。即使 Windows 内部使用 Git Bash 执行，模型看到的仍然是 `Bash` tool。
- shell provider 只影响 executor，不影响 tool exposure 或 tool description 分支。
- 如果 ZCode 后续增加 provider-visible `PowerShell` tool，则 main prompt 的 shell tool wording 需要重新评估。该能力不属于本计划。

## 当前 ZCode 状态

已检查的 ZCode 文件：

- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
- `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts`
- `apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts`
- `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts`
- `apps/zcode-cli/packages/core/src/tool/read-file-state.ts`
- `packages/shared/src/protocol.ts`
- `packages/shared/src/validationAppSettings.ts`
- `packages/services/src/system/system.ts`
- `packages/services/src/system/systemService.ts`
- `packages/ui/src/SettingsPage.tsx`
- `packages/ui/src/settingsPageHelpers.tsx`
- `apps/zcode-cli/docs/design/v2/tool/04-bash.md`
- `apps/zcode-cli/docs/bash-shell-provider.md`
- `apps/zcode-cli/docs/bash-cwd-persistence-plan.md`

当前执行链路：

1. `Bash` handler 创建 `ExecutionRequest`：
   - `command.mode = "shell"`
   - `command.shellProfile = "posix-bash"`
   - foreground command 设置 `captureCwdAfterSuccess = true`
2. `NodeExecutionAdapter.spawnChild()`：
   - 通过 `buildExecutionEnv()` 构建 env
   - 通过 `createCwdCapturePlan(request, platform)` 创建 cwd capture wrapper
   - 通过 `resolveExecutionCommand(capturePlan.command, ...)` 解析 spawn shape
   - 使用 `shell`、`cwd`、`env`、stdio、timeout、output budget 执行子进程
3. `resolveExecutionCommand()` 只有在 `platform !== "win32"` 时才调用 `resolvePosixBashShell()`。
4. Windows 上 shell mode 走 `resolveShell()`，也就是 `ComSpec ?? "cmd.exe"`。

当前 Windows 约束：

- `docs/design/v2/tool/04-bash.md` 目前写的是 Windows 默认 shell mode 使用 `ComSpec` / `cmd.exe`，并且不得默认暗中搜索 Git Bash。Phase 1 需要更新这个 contract：Git Bash 自动检测只允许在 Bash tool 的 `shellProfile === "posix-bash"` 内部路径生效。
- `cwd-capture.ts` 当前按 `platform` 选择 wrapper：
  - Windows：`cmd.exe` 语法，使用 `%ERRORLEVEL%` 和 `exit /b`
  - 非 Windows：POSIX 语法，使用 `$?` 和 `pwd -P`
- 所以如果直接在 Windows 上启用 Git Bash，但不重构 cwd capture，就会把 `cmd.exe` wrapper 丢进 Bash 执行，foreground Bash 命令会坏。

现有可复用能力：

- `read-file-state.ts` 已经能在 Windows 下把 `/c/...` Git Bash drive alias 归一化。
- `outputEncoding.ts` 已经为子进程补 UTF-8 文本环境，并处理 Windows 输出解码。
- `buildExecutionEnv()` 已经按 Windows 大小写无关语义处理 env key。
- background execution 已经不做 cwd capture，所以 background 主要需要 shell resolution 和 output path 保持稳定。
- `AppSettings` 已经有 terminal 相关字段：`terminalInheritSystemProfile`、`terminalFontFamily`。Phase 2 的“集成终端Shell”应沿用 AppSettings 持久化路径，但不能复用字体/profile 字段。

## 目标契约

### Phase 1 resolver 优先级

Windows `Bash` tool 的 shell 选择优先级：

1. `ExecutionCommand.shellOverride` 存在、`source === "user-config"`、path 仍可执行，并且 dialect 是 adapter 支持的 Windows dialect，则使用该 override。
2. 没有 override，或 override 已失效，则自动检测 Git Bash：
   - `C:\Program Files\Git\bin\bash.exe`
   - `C:\Program Files (x86)\Git\bin\bash.exe`
   - PATH 中的 `git.exe` 反推 `..\..\bin\bash.exe`
3. 自动检测失败时，fallback 到当前 `ComSpec ?? "cmd.exe"` 行为。

Phase 1 不新增读取 shell path 的环境变量：

- shell 显式选择只通过内部 `shellOverride` 注入
- 不通过环境变量切换 PowerShell
- 不要求 Windows 用户必须安装 Git Bash

### Phase 2 用户设置契约

设置项：

- UI 文案：`集成终端Shell`
- 展示范围：Windows only；依据 host `systemService.info().platform === "win32"`，不是浏览器 platform。
- 默认值：`自动选择`
- 用户主动选择 shell 后：最高优先级映射为 Phase 1 的 `shellOverride`。
- 用户恢复 `自动选择` 后：清空 override，走 Phase 1 自动检测 Git Bash，再 fallback `cmd.exe`。

建议内部设置 shape：

```ts
export type IntegratedTerminalShellSelection =
  | {
      mode: "auto";
    }
  | {
      mode: "shell";
      dialect: "cmd" | "git-bash";
      id: string;
      label: string;
      path: string;
    };
```

说明：

- Phase 2 的本机枚举可以发现更多 shell，但第一版只把 `cmd` 和 `git-bash` 作为 Bash execution 支持 dialect。
- PowerShell 不在本计划里接入 Bash tool。要支持 PowerShell 应新增 provider-visible `PowerShell` tool 或单独 runtime 语义。
- WSL 不在本计划里接入本地 Bash fallback。WSL 应作为 remote/workspace adapter 设计。

## 明确不做

- 不新增 provider-visible `PowerShell` tool。
- 不新增 Windows 启动门槛（Git Bash/PowerShell 缺失不阻止启动）。
- 不把 WSL 加为默认 Bash provider。
- 不把本地 Windows workspace 通过 `wsl.exe` 跑。
- 不改变没有 `shellProfile` 的 generic `mode: "shell"` 调用。
- 不改变 argv-mode 的 `.cmd` / `.bat` / `.exe` resolution。
- Phase 1 不新增 settings schema、不新增 UI、不新增 shell 枚举服务。
- Phase 2 不改 provider-visible Bash result content，不改 Bash permission policy。

## WSL 决策

WSL 不进入本轮实现。

原因：

- Git Bash 是 Windows process，基本共享 Windows 文件系统视图，可以放在现有 local `ExecutionPort` 内。
- WSL 是另一套 Linux runtime 和 filesystem boundary。`C:\repo`、`/mnt/c/repo`、`/home/user/repo`、`\\wsl$\...` 都需要明确的 workspace identity、filesystem adapter、artifact、background log、Read/Edit path mapping 语义。
- 如果把 `wsl.exe -- bash -lc ...` 当作 shell fallback，provider-visible Bash 可能看起来成功，但命令实际已经悄悄跑进了另一个文件系统和进程环境。

WSL 后续建议：

- 把 WSL 当作 remote/workspace adapter 来设计，参考 SSH/remote workspace 的边界，而不是当成本地 Windows `Bash` fallback。

## Shell 依赖影响面

| 区域 | 当前依赖 | Phase 1 影响 | Phase 2 影响 | 计划动作 |
| --- | --- | --- | --- | --- |
| Bash handler | 总是设置 `shellProfile: "posix-bash"` | 不需要读取设置 | 需要从 runtime/settings 注入 override | Phase 2 在 handler 依赖层注入，不让 UI 逻辑进入 adapter |
| Execution contract | `shellProfile?: "posix-bash"` | 增加内部 `shellOverride` | AppSettings 映射成 `shellOverride` | contract 注释写清楚内部用途 |
| Shell resolver | 只在 `platform !== "win32"` 找 bash/zsh | 增加 Windows override/Git Bash/cmd fallback | 使用用户选择优先级 | resolver 返回 shell dialect / spawn plan |
| Cwd capture | 按 `platform` 选择 wrapper | 改成按 shell dialect | 用户选择 cmd/git-bash 都复用 | 增加 `ShellDialect` aware wrapper |
| Captured cwd readback | 直接把文件内容当 host path | Git Bash 返回 `/c/...` | 同 Phase 1 | `statSync` 前转回 Windows path |
| Temp/cwd capture file path | 直接嵌入 host path | Git Bash 需要 `/c/...` | 同 Phase 1 | 嵌入 shell 前转成 Git Bash path |
| Spawn `cwd` | Node spawn 使用 request cwd | Git Bash 可以接受 Windows cwd | 同 Phase 1 | 保持 Windows host path |
| Env | Windows env key 大小写无关 | Git Bash 加 `SHELL`、`GIT_EDITOR` | 用户选择 Git Bash 时同样加 | 复用现有 env key 处理 |
| Output decoding | Windows 可能是 code page | Git Bash 通常是 UTF-8 | 同 Phase 1 | 保持现有 decoder，补 UTF-8 验证 |
| Stdin | stdin 写完后关闭 | shell 选择不应影响 | 同 Phase 1 | 补 Windows real-world prompt case |
| Background Bash | 不做 cwd capture | resolver 仍应生效 | 用户选择 shell 仍应生效 | 补 background shellProfile 测试 |
| Output artifact | 结果路径是 Windows host path | provider-visible 文件路径仍应是 host path | 同 Phase 1 | 不转换 result content 里的 artifact/log path |
| Read-state | 已处理 `/c/...` alias | Git Bash path 出现概率增加 | 同 Phase 1 | 复用并按需补覆盖 |
| Permission/parser | Bash parser 假设 Bash-ish syntax | Windows 下 Bash syntax 更真实 | 同 Phase 1 | 本计划不改 permission policy |
| Hooks/config runner | generic shell 或显式 hook shell | 不应被 Bash shellProfile 影响 | 设置项不应影响 hooks | `shellProfile` 继续只给 Bash tool 内部使用 |
| Settings/AppSettings | 无 shell selection 字段 | 不改变 | 增加 `integratedTerminalShell` | schema + settings service 归一化 |
| System service | 只有 `info()` | 不改变 | 增加 shell 枚举方法 | 只在 Windows 返回候选 |
| SettingsPage | 终端 profile/font | 不改变 | Windows only 下拉 | 使用 host platform 判断展示 |
| Web remote | 通过 host service 操作 | 不改变 | 设置更新仍走现有 host service | 不新增独立 agent runtime |

## 文件结构

### Phase 1 文件

- 修改：`apps/zcode-cli/docs/design/v2/tool/04-bash.md`
  - 更新 Windows contract，允许 `Bash` tool best-effort 使用 Git Bash。
  - 记录 shell override 是内部执行注入口，不是 provider-visible schema。
  - 保留“Git Bash 非必需”和“fallback 到 cmd.exe”的保证。

- 修改：`apps/zcode-cli/docs/bash-shell-provider.md`
  - 增加说明：Windows shell provider 由本分阶段 plan 覆盖。
  - 保留原 macOS/Linux plan 的历史语义。

- 修改：`apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
  - 增加 `ExecutionShellDialect` / `ExecutionShellOverride`。
  - 在 shell command 上增加 `shellOverride?: ExecutionShellOverride`。
  - 注释写明只供 Bash tool 内部执行路径使用。

- 修改：`apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts`
  - 增加 Windows Git Bash resolver。
  - 增加 Windows path <-> Git Bash path 转换 helper。
  - 增加 shell provider metadata。

- 修改：`apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts`
  - 增加 shell dialect aware cwd capture。
  - 保留现有 cmd wrapper 和 POSIX wrapper。
  - Git Bash 下转换 cwd capture 文件路径和 readback path。

- 修改：`apps/zcode-cli/packages/adapters/src/exec/index.ts`
  - 接入 shell provider metadata。
  - 把 shell dialect 传入 cwd capture。
  - generic shell mode 保持不变。

- 修改：`apps/zcode-cli/packages/adapters/tests/exec.test.ts`
  - 补 override 优先级、resolver、cwd capture、readback、fallback、background 的聚焦单测。

### Phase 2 文件

- 修改：`packages/shared/src/protocol.ts`
  - 增加 `IntegratedTerminalShellSelection` 和 `AppSettings.integratedTerminalShell`。

- 修改：`packages/shared/src/validationAppSettings.ts`
  - 增加 settings schema / patch schema。
  - 归一化空值为 `{ mode: "auto" }` 或 `undefined`。

- 修改：`packages/services/src/setting/settingService.ts`
  - 归一化 `integratedTerminalShell` patch。

- 修改：`packages/services/src/system/system.ts`
  - 增加 `listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]>`。

- 修改：`packages/services/src/system/systemService.ts`
  - Windows 下枚举 `cmd.exe` 和 Git Bash。
  - 非 Windows 返回空列表，或只返回当前平台后续支持的候选；本计划 UI 只消费 Windows。

- 修改：`packages/ui/src/SettingsPage.tsx`
  - 读取、保存 `integratedTerminalShell`。
  - 拉取 system shell options。

- 修改：`packages/ui/src/settingsPageHelpers.tsx`
  - 在 Windows only 条件下渲染“集成终端Shell”下拉。
  - 第一项为“自动选择”。

- 修改：`packages/ui/src/i18n/locales/zh-CN.ts`
  - 增加中文文案。

- 修改：`packages/ui/src/i18n/locales/en-US.ts`
  - 增加英文文案。

- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - 从运行时依赖读取 Phase 2 映射后的 shell override。
  - 构造 `ExecutionRequest` 时传入 `command.shellOverride`。

- 修改：相关 tests
  - `packages/shared/test/zcodeEndpoint.test.ts` 或 settings schema 现有测试文件。
  - `packages/services/test/settingService.test.ts`。
  - `packages/services/test/systemService.test.ts`。
  - `packages/ui/test/settingsDataBaseDirControl.test.ts` 或新增 settings shell row 测试。
  - `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`。

## Phase 1 实施任务

### Task 1: 更新 Bash Windows contract spec

**Files:**

- Modify: `apps/zcode-cli/docs/design/v2/tool/04-bash.md`
- Modify: `apps/zcode-cli/docs/bash-shell-provider.md`

- [ ] **Step 1: 更新 Windows contract 文案**

把当前绝对的“不得暗中查找 Git Bash”规则替换为：

```markdown
- Windows `Bash` tool may best-effort use Git Bash when Git for Windows is already installed and detectable. Git Bash remains optional: if it cannot be resolved, `Bash` falls back to the existing `ComSpec` / `cmd.exe` shell path.
- Windows `Bash` tool may accept an internal shell override from ZCode runtime settings. A valid user-configured override has higher priority than automatic Git Bash detection.
- ZCode must not require Git Bash, MSYS2, Cygwin, or WSL to run the built-in `Bash` tool.
- Generic `ExecutionPort` shell mode on Windows continues to use `ComSpec` / `cmd.exe`; Git Bash auto-detection and shell override apply only to `command.shellProfile === "posix-bash"` created by the `Bash` tool.
```

- [ ] **Step 2: 记录 Git Bash 缺失的处理**

加入说明：

```markdown
ZCode does not add a Git Bash path environment variable or Windows startup gates. Missing Git Bash is a fallback condition, not a startup failure.
```

- [ ] **Step 3: 跑文档检查**

运行：

```bash
git diff --check -- apps/zcode-cli/docs/design/v2/tool/04-bash.md apps/zcode-cli/docs/bash-shell-provider.md
```

预期：无 whitespace error。

### Task 2: 增加内部 shell override contract

**Files:**

- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

- [ ] **Step 1: 先写 override 优先级失败测试**

新增测试：

```ts
it("uses a valid user-configured Windows Git Bash override before auto detection", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "printf 'ok\\n'",
      shellProfile: "posix-bash",
      shellOverride: {
        dialect: "git-bash",
        id: "git-bash:D:\\Tools\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "D:\\Tools\\Git\\bin\\bash.exe",
        source: "user-config",
      },
    },
    {
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
      },
      exists: (path) =>
        path === "D:\\Tools\\Git\\bin\\bash.exe" ||
        path === "C:\\Program Files\\Git\\bin\\bash.exe",
      platform: "win32",
    },
  );

  expect(resolved).toMatchObject({
    args: ["-c", "-l", expect.any(String)],
    cwdDialect: "git-bash",
    file: "D:\\Tools\\Git\\bin\\bash.exe",
    shell: false,
  });
});

it("falls back to auto detection when the user-configured shell no longer exists", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "printf 'ok\\n'",
      shellProfile: "posix-bash",
      shellOverride: {
        dialect: "git-bash",
        id: "git-bash:D:\\Missing\\bash.exe",
        label: "Git Bash",
        path: "D:\\Missing\\bash.exe",
        source: "user-config",
      },
    },
    {
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
      },
      exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
      platform: "win32",
    },
  );

  expect(resolved).toMatchObject({
    cwdDialect: "git-bash",
    file: "C:\\Program Files\\Git\\bin\\bash.exe",
    shell: false,
  });
});
```

- [ ] **Step 2: contract 中增加类型**

在 `ExecutionCommand` 前增加：

```ts
export type ExecutionShellDialect = "cmd" | "posix" | "git-bash";

export interface ExecutionShellOverride {
  /**
   * Stable id from settings/UI. Adapter must not parse semantics from this field.
   */
  id?: string;
  /** Human-readable label for diagnostics only. */
  label?: string;
  /** Absolute shell executable path in host OS path syntax. */
  path: string;
  /** Shell syntax and cwd capture dialect used by this shell. */
  dialect: ExecutionShellDialect;
  /** Current supported source. Future callers may add internal test/runtime sources explicitly. */
  source: "user-config";
}
```

在 shell command shape 增加：

```ts
      /**
       * Internal shell override selected by ZCode runtime settings. This is only honored for
       * Bash tool commands with shellProfile === "posix-bash"; generic shell execution must ignore it.
       */
      shellOverride?: ExecutionShellOverride;
```

- [ ] **Step 3: 跑 contract typecheck**

运行：

```bash
pnpm --filter @zcode/contracts typecheck
```

预期：PASS。若 package 没有单独 typecheck script，运行覆盖 contracts 的最近 package-level typecheck，并在验证记录里写明命令。

### Task 3: 先补 Windows Git Bash resolver 和 path conversion 失败测试

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

- [ ] **Step 1: 写 resolver 失败测试**

新增测试：

```ts
it("resolves Windows Git Bash from the default Program Files path for posix-bash", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "printf 'ok\\n'",
      shellProfile: "posix-bash",
    },
    {
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
      },
      exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
      platform: "win32",
    },
  );

  expect(resolved).toMatchObject({
    args: ["-c", "-l", expect.any(String)],
    cwdDialect: "git-bash",
    file: "C:\\Program Files\\Git\\bin\\bash.exe",
    shell: false,
  });
});

it("falls back to ComSpec when Windows Git Bash cannot be resolved", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "dir",
      shellProfile: "posix-bash",
    },
    {
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\tools",
      },
      exists: () => false,
      platform: "win32",
    },
  );

  expect(resolved).toEqual({
    args: [],
    cwdDialect: "cmd",
    file: "dir",
    shell: "C:\\Windows\\System32\\cmd.exe",
  });
});
```

- [ ] **Step 2: 增加 path conversion 测试**

新增 helper export 的测试：

```ts
expect(windowsPathToGitBashPath("C:\\repo\\sub")).toBe("/c/repo/sub");
expect(windowsPathToGitBashPath("C:/repo/sub")).toBe("/c/repo/sub");
expect(windowsPathToGitBashPath("\\\\server\\share\\repo")).toBe("//server/share/repo");
expect(gitBashPathToWindowsPath("/c/repo/sub")).toBe("C:\\repo\\sub");
expect(gitBashPathToWindowsPath("/cygdrive/d/repo")).toBe("D:\\repo");
expect(gitBashPathToWindowsPath("//server/share/repo")).toBe("\\\\server\\share\\repo");
```

- [ ] **Step 3: 运行 targeted tests，确认先失败**

运行：

```bash
pnpm --filter @zcode/adapters test -- --run tests/exec.test.ts -t "Windows Git Bash"
```

预期：实现前 FAIL，原因是 Windows Git Bash resolver/path helper 还不存在，或者 Windows 仍 fallback 到 ComSpec。

### Task 4: 实现 Windows shell provider resolver

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`

- [ ] **Step 1: 增加结构化 provider shape**

新增：

```ts
export interface BashShellProvider {
  dialect: ExecutionShellDialect;
  envOverlay?: Record<string, string>;
  file: string;
  getSpawnArgs(command: string): string[];
  shell: boolean | string;
}
```

`ResolvedSpawnCommand` 增加：

```ts
export interface ResolvedSpawnCommand {
  args: string[];
  cwdDialect: ExecutionShellDialect;
  envOverlay?: Record<string, string>;
  file: string;
  shell: boolean | string;
}
```

- [ ] **Step 2: 增加 Windows Git Bash resolver helper**

实现：

```ts
const WINDOWS_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
] as const;

export function resolveWindowsGitBashShell(
  env: NodeJS.ProcessEnv,
  exists?: ExecutableCheck,
): string | undefined {
  for (const candidate of WINDOWS_GIT_BASH_PATHS) {
    if (isExecutableCandidate(candidate, exists)) return candidate;
  }

  const gitExe = windowsExecutableCandidates("git", env).find((candidate) =>
    isExecutableCandidate(candidate, exists),
  );
  if (!gitExe) return undefined;

  const inferred = win32.normalize(
    win32.join(win32.dirname(gitExe), "..", "..", "bin", "bash.exe"),
  );
  return isExecutableCandidate(inferred, exists) ? inferred : undefined;
}
```

把 `index.ts` 里已有的 `windowsExecutableCandidates()` helper 抽出来复用，确保 argv-mode resolution 和 Git Bash 检测使用同一套 PATH/PATHEXT 规则。

- [ ] **Step 3: 增加 path conversion helpers**

实现：

```ts
export function windowsPathToGitBashPath(value: string): string {
  if (value.startsWith("\\\\")) return value.replaceAll("\\", "/");
  const driveMatch = value.match(/^([A-Za-z]):[/\\]?/u);
  if (driveMatch) {
    const rest = value.slice(2).replaceAll("\\", "/");
    return `/${driveMatch[1]!.toLowerCase()}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  return value.replaceAll("\\", "/");
}

export function gitBashPathToWindowsPath(value: string): string {
  if (value.startsWith("//")) return value.replaceAll("/", "\\");
  const cygdrive = value.match(/^\/cygdrive\/([A-Za-z])(\/|$)/u);
  if (cygdrive) {
    const rest = value.slice(`/cygdrive/${cygdrive[1]}`.length).replaceAll("/", "\\");
    return `${cygdrive[1]!.toUpperCase()}:${rest || "\\"}`;
  }
  const drive = value.match(/^\/([A-Za-z])(\/|$)/u);
  if (drive) {
    const rest = value.slice(2).replaceAll("/", "\\");
    return `${drive[1]!.toUpperCase()}:\\${rest}`;
  }
  return value.replaceAll("/", "\\");
}
```

- [ ] **Step 4: override 优先于 auto detection**

实现优先级：

```ts
function resolveWindowsBashShellProvider(options: {
  env: NodeJS.ProcessEnv;
  exists?: ExecutableCheck;
  override?: ExecutionShellOverride;
}): BashShellProvider | undefined {
  const override = options.override;
  if (override?.source === "user-config" && isExecutableCandidate(override.path, options.exists)) {
    if (override.dialect === "git-bash") return createGitBashProvider(override.path);
    if (override.dialect === "cmd") return createWindowsCmdProvider(options.env, override.path);
  }

  const gitBash = resolveWindowsGitBashShell(options.env, options.exists);
  return gitBash ? createGitBashProvider(gitBash) : undefined;
}
```

`resolveExecutionCommand()` 只在 `command.mode === "shell" && command.shellProfile === "posix-bash"` 时调用该 helper。generic shell mode 不读取 `shellOverride`。

- [ ] **Step 5: 跑 resolver 测试**

运行：

```bash
pnpm --filter @zcode/adapters test -- --run tests/exec.test.ts -t "Windows Git Bash|user-configured Windows Git Bash"
```

预期：resolver/path conversion/override 优先级测试 PASS；涉及 foreground cwd capture 的 Git Bash 测试可能仍会失败，直到 Task 5 完成。

### Task 5: 把 cwd capture 改成 shell dialect aware

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

- [ ] **Step 1: 改 `createCwdCapturePlan` 入参**

改为：

```ts
export function createCwdCapturePlan(
  request: ExecutionRequest,
  options: {
    dialect: ExecutionShellDialect;
    platform: NodeJS.Platform;
  },
): CwdCapturePlan
```

- [ ] **Step 2: 按 dialect 生成 wrapper**

使用：

```ts
const wrappedCommand =
  options.dialect === "cmd"
    ? createWindowsCmdCwdCaptureCommand(request.command.command, cwdFilePath)
    : createPosixCwdCaptureCommand(
        request.command.command,
        options.dialect === "git-bash" ? windowsPathToGitBashPath(cwdFilePath) : cwdFilePath,
      );
```

- [ ] **Step 3: Git Bash readback path 转回 Windows path**

把 `readCapturedCwd` 改成：

```ts
export function readCapturedCwd(
  cwdFilePath: string | undefined,
  options: { dialect: ExecutionShellDialect },
): string | undefined
```

在 `statSync(value)` 之前转换：

```ts
const hostValue = options.dialect === "git-bash" ? gitBashPathToWindowsPath(value) : value;
```

- [ ] **Step 4: 在 `spawnChild` 中只解析一次 shell provider**

推荐流程：

```ts
const env = buildExecutionEnv(...);
const resolvedCommand = resolveExecutionCommand(request.command, {
  cwd: request.cwd,
  env,
  platform: this.platform,
});
const capturePlan = createCwdCapturePlan(request, {
  dialect: resolvedCommand.cwdDialect,
  platform: this.platform,
});
const spawnCommand =
  capturePlan.command === request.command
    ? resolvedCommand
    : applyResolvedShellProvider(resolvedCommand, capturePlan.command);
```

实现时注意：不要因为 cwd capture wrapper 再次调用 resolver，导致 override/auto detection 前后不一致。

- [ ] **Step 5: 增加 cwd capture 测试**

新增：

```ts
it("uses POSIX cwd capture syntax for Windows Git Bash", () => {
  const plan = createCwdCapturePlan(
    {
      command: {
        mode: "shell",
        command: "cd subdir",
        shellProfile: "posix-bash",
      },
      captureCwdAfterSuccess: true,
    },
    { dialect: "git-bash", platform: "win32" },
  );

  expect(plan.command.command).toContain("__zcode_status=$?");
  expect(plan.command.command).toContain("pwd -P >");
  expect(plan.command.command).not.toContain("%ERRORLEVEL%");
});
```

再加一个纯函数测试：

```ts
expect(normalizeCapturedCwdForHost("/c/path/to/repo", "git-bash")).toBe("C:\\path\\to\\repo");
expect(normalizeCapturedCwdForHost("C:\\path\\to\\repo", "cmd")).toBe("C:\\path\\to\\repo");
```

- [ ] **Step 6: 跑 cwd tests**

运行：

```bash
pnpm --filter @zcode/adapters test -- --run tests/exec.test.ts -t "cwd capture"
```

预期：已有 POSIX 和 cmd cwd capture 测试仍 PASS；新增 Git Bash cwd capture 测试 PASS。

### Task 6: 保持 generic Windows execution 行为不变

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

- [ ] **Step 1: 保留 generic shell fallback 测试**

保留或更新断言：

```ts
it("keeps generic Windows shell commands on the legacy shell path", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "dir",
      shellOverride: {
        dialect: "git-bash",
        id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        source: "user-config",
      },
    },
    {
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
      exists: () => {
        throw new Error("Git Bash resolver should not run without shellProfile");
      },
      platform: "win32",
    },
  );

  expect(resolved).toEqual({
    args: [],
    cwdDialect: "cmd",
    file: "dir",
    shell: "C:\\Windows\\System32\\cmd.exe",
  });
});
```

- [ ] **Step 2: 保留 argv mode 测试**

运行：

```bash
pnpm --filter @zcode/adapters test -- --run tests/exec.test.ts -t "Windows .cmd"
pnpm --filter @zcode/adapters test -- --run tests/exec.test.ts -t "Windows .exe"
```

预期：已有 `.cmd` / `.bat` / `.exe` argv-mode 测试仍 PASS。

### Task 7: 增加真实 Windows 方向的 shell provider 覆盖

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
- Modify: `apps/zcode-cli/real-world-test-prompt/bash-shell-provider.md`

- [ ] **Step 1: Windows + Git Bash 可用时跑集成测试**

如果运行环境是 Windows 且检测到 Git Bash，增加 gated integration test：

```ts
it.skipIf(process.platform !== "win32" || !hasGitBash())(
  "runs Bash syntax through Git Bash on Windows",
  async () => {
    const adapter = createNodeExecutionAdapter();
    const result = await adapter.run({
      command: {
        mode: "shell",
        shellProfile: "posix-bash",
        command: "arr=(a b); printf 'array=%s\\n' \"${arr[1]}\"",
      },
      captureCwdAfterSuccess: true,
      timeoutMs: 5000,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout.text).toContain("array=b");
  },
);
```

- [ ] **Step 2: fallback 集成测试不依赖开发机**

通过注入 resolver 或纯 unit path 覆盖，不依赖当前机器是否安装 Git Bash：

```ts
expect(resolveExecutionCommand(dirCommand, existsAlwaysFalseWindowsOptions)).toEqual({
  args: [],
  cwdDialect: "cmd",
  file: "dir",
  shell: "C:\\Windows\\System32\\cmd.exe",
});
```

- [ ] **Step 3: real-world prompt 加 Windows 段**

加入：

```markdown
## Windows Git Bash addendum

If this session is running on Windows, execute Bash calls that print `$0`, `${BASH_VERSION:-}`, `pwd -P`, an array expression, and process substitution.
```

不要在 prompt 文件里写预期输出。

### Task 8: Phase 1 全量验证

**Files:**

- No code files beyond previous tasks.

- [ ] **Step 1: 跑 adapter focused tests**

运行：

```bash
pnpm --filter @zcode/adapters test -- --run tests/exec.test.ts
```

预期：PASS。

- [ ] **Step 2: 跑 core Bash tests**

运行：

```bash
pnpm --filter @zcode/core test -- --run tests/bash-handler.test.ts
```

预期：PASS。

- [ ] **Step 3: 跑 Bash conformance tests**

如果当前分支有这些测试，运行：

```bash
pnpm --filter @zcode/core test -- --run tests/bash-run-conformance.test.ts tests/bash-result-mapping.test.ts
```

预期：PASS，或者只有已知 pre-existing skip。

- [ ] **Step 4: 跑静态检查**

运行：

```bash
pnpm lint
pnpm typecheck
```

预期：PASS。如果 repo-wide checks 因无关工作区问题失败，记录具体失败，并补跑覆盖本次改动的 package-level checks。

## Phase 2 实施任务

### Task 9: 增加 settings schema

**Files:**

- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/validationAppSettings.ts`
- Modify: `packages/services/src/setting/settingService.ts`
- Modify: `packages/services/test/settingService.test.ts`

- [x] **Step 1: 增加 AppSettings 类型**

在 `protocol.ts` 增加：

```ts
export type IntegratedTerminalShellDialect = "cmd" | "git-bash";

export type IntegratedTerminalShellSelection =
  | {
      mode: "auto";
    }
  | {
      mode: "shell";
      dialect: IntegratedTerminalShellDialect;
      id: string;
      label: string;
      path: string;
    };
```

在 `AppSettings` 增加：

```ts
  /** Windows Bash tool shell selection. Undefined or auto means runtime auto-detects Git Bash then falls back to cmd.exe. */
  integratedTerminalShell?: IntegratedTerminalShellSelection;
```

- [x] **Step 2: 增加 validation schema**

在 `validationAppSettings.ts` 增加：

```ts
const integratedTerminalShellSchema = z.union([
  z.object({
    mode: z.literal("auto"),
  }),
  z.object({
    mode: z.literal("shell"),
    dialect: z.enum(["cmd", "git-bash"]),
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    path: z.string().trim().min(1),
  }),
]);
```

`appSettingsObjectSchema` 使用：

```ts
  integratedTerminalShell: integratedTerminalShellSchema
    .default({ mode: "auto" })
    .optional(),
```

`appSettingsPatchSchema` 使用：

```ts
  integratedTerminalShell: integratedTerminalShellSchema.optional(),
```

- [x] **Step 3: settingService 归一化**

在 `normalizeSettingsPatch()` 增加：

```ts
  if (
    "integratedTerminalShell" in normalizedPatch &&
    normalizedPatch.integratedTerminalShell?.mode === "auto"
  ) {
    normalizedPatch.integratedTerminalShell = undefined;
  }
```

- [x] **Step 4: settings test**

新增：

```ts
it("normalizes integrated terminal shell auto selection back to default", async () => {
  const service = createSettingServiceForTest();
  await service.update({
    integratedTerminalShell: {
      dialect: "git-bash",
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      mode: "shell",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
    },
  });
  await service.update({ integratedTerminalShell: { mode: "auto" } });

  const settings = await service.get();
  expect(settings.integratedTerminalShell).toBeUndefined();
});
```

### Task 10: 增加本机 shell 枚举服务

**Files:**

- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/services/src/system/system.ts`
- Modify: `packages/services/src/system/systemService.ts`
- Modify: `packages/services/test/systemService.test.ts`

- [x] **Step 1: 增加 shell option 类型**

在 `protocol.ts` 增加：

```ts
export interface IntegratedTerminalShellOption {
  dialect: IntegratedTerminalShellDialect;
  id: string;
  label: string;
  path: string;
  source: "system" | "path";
}
```

- [x] **Step 2: system service interface 增加方法**

在 `ISystemService` 增加：

```ts
  listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]>;
```

- [x] **Step 3: systemService Windows 枚举**

实现顺序：

```ts
const options: IntegratedTerminalShellOption[] = [];
options.push({
  dialect: "cmd",
  id: `cmd:${process.env.ComSpec ?? "cmd.exe"}`,
  label: "CMD",
  path: process.env.ComSpec ?? "cmd.exe",
  source: "system",
});
const gitBash = resolveWindowsGitBashShell(process.env);
if (gitBash) {
  options.push({
    dialect: "git-bash",
    id: `git-bash:${gitBash}`,
    label: "Git Bash",
    path: gitBash,
    source: "system",
  });
}
return dedupeShellOptions(options);
```

非 Windows 返回：

```ts
return [];
```

- [x] **Step 4: systemService tests**

新增：

```ts
it("lists Windows cmd and Git Bash shell options when Git Bash is detectable", async () => {
  const service = createSystemService({
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Program Files\\Git\\cmd",
    },
    exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
    platform: "win32",
  });

  await expect(service.listIntegratedTerminalShells()).resolves.toEqual([
    {
      dialect: "cmd",
      id: "cmd:C:\\Windows\\System32\\cmd.exe",
      label: "CMD",
      path: "C:\\Windows\\System32\\cmd.exe",
      source: "system",
    },
    {
      dialect: "git-bash",
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
      source: "system",
    },
  ]);
});
```

### Task 11: SettingsPage 增加 Windows only 下拉

**Files:**

- Read first: `DESIGN.md`
- Modify: `packages/ui/src/SettingsPage.tsx`
- Modify: `packages/ui/src/settingsPageHelpers.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: UI settings tests

- [x] **Step 1: 读取设计规范**

运行：

```bash
sed -n '1,240p' DESIGN.md
```

预期：执行者已阅读颜色、圆角、控件、响应式、主题和国际化规则。

- [x] **Step 2: SettingsPage 状态接入**

在 `SettingsPage.tsx` 增加 state：

```ts
const [integratedTerminalShell, setIntegratedTerminalShell] =
  useState<IntegratedTerminalShellSelection>({ mode: "auto" });
const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
  IntegratedTerminalShellOption[]
>([]);
```

settings 加载后：

```ts
setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
```

system info 是 Windows 时加载 options：

```ts
if (info.platform === "win32") {
  services.systemService
    .listIntegratedTerminalShells()
    .then(setIntegratedTerminalShellOptions)
    .catch(() => setIntegratedTerminalShellOptions([]));
}
```

保存 handler：

```ts
const handleIntegratedTerminalShellChange = useCallback(
  async (selection: IntegratedTerminalShellSelection) => {
    await services.settingService.update({ integratedTerminalShell: selection });
    setIntegratedTerminalShell(selection);
  },
  [services.settingService],
);
```

- [x] **Step 3: settingsPageHelpers 渲染下拉**

在 terminal settings group 中新增 `SettingsRow`：

```tsx
{platform === "win32" ? (
  <SettingsRow
    label={intl.formatMessage({ id: "settings.integratedTerminalShell" })}
    description={intl.formatMessage({
      id: "settings.integratedTerminalShellDescription",
    })}
    control={
      <Select
        value={serializeIntegratedTerminalShellSelection(integratedTerminalShell)}
        onValueChange={(value) => {
          void onIntegratedTerminalShellChange(
            parseIntegratedTerminalShellSelection(value, integratedTerminalShellOptions),
          );
        }}
      >
        <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">
            {intl.formatMessage({ id: "settings.integratedTerminalShell.auto" })}
          </SelectItem>
          {integratedTerminalShellOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    }
  />
) : null}
```

辅助函数：

```ts
function serializeIntegratedTerminalShellSelection(
  selection: IntegratedTerminalShellSelection,
): string {
  return selection.mode === "auto" ? "auto" : selection.id;
}

function parseIntegratedTerminalShellSelection(
  value: string,
  options: IntegratedTerminalShellOption[],
): IntegratedTerminalShellSelection {
  if (value === "auto") return { mode: "auto" };
  const option = options.find((candidate) => candidate.id === value);
  return option
    ? {
        dialect: option.dialect,
        id: option.id,
        label: option.label,
        mode: "shell",
        path: option.path,
      }
    : { mode: "auto" };
}
```

- [x] **Step 4: 增加 i18n 文案**

`zh-CN.ts`：

```ts
"settings.integratedTerminalShell": "集成终端Shell",
"settings.integratedTerminalShellDescription": "Windows 下 Bash 工具使用的本机 shell。选择自动时会优先尝试 Git Bash，找不到时回退到 cmd.exe。",
"settings.integratedTerminalShell.auto": "自动选择",
```

`en-US.ts`：

```ts
"settings.integratedTerminalShell": "Integrated terminal shell",
"settings.integratedTerminalShellDescription": "The local shell used by the Bash tool on Windows. Auto tries Git Bash first and falls back to cmd.exe.",
"settings.integratedTerminalShell.auto": "Auto",
```

### Task 12: 把 AppSettings 映射到 Bash ExecutionRequest

**Files:**

- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgent.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Modify: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

- [x] **Step 1: protocol 参数携带当前 AppSettings selection**

`session/create`、`session/resume` 和 `session/send` 都携带
`integratedTerminalShell?: IntegratedTerminalShellSelection`。Host 侧
`zcodeAgentService` 每次请求前读取 `settingService.get().integratedTerminalShell`：

- 读到具体 shell：发送 `{ mode: "shell", ... }`。
- 读到 `undefined`：发送 `{ mode: "auto" }`，用于清空已存在 runtime 的旧 override。
- 旧协议 strict schema 不认识该字段时，create/resume/send 均按 optional compat field 剥离后重试。

- [x] **Step 2: bootstrap 层映射成 ExecutionShellOverride**

映射函数放在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`：

```ts
function integratedTerminalShellToExecutionOverride(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellOverride | undefined {
  if (!selection || selection.mode === "auto") return undefined;
  return {
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}
```

`createRecord()` 在初始 `runtimeConfig` 里注入 `bashShellOverride`。已有 session 的
`resume/send` 通过 `record.app.runtime.updateConfig({ bashShellOverride })` 更新当前 runtime；
`mode:auto` 会把该字段更新为 `undefined`。

- [x] **Step 3: core executor 按当前 runtime config 注入 Bash request**

Core 不直接依赖 `AppSettings` 或 UI/service 类型。`AgentRuntime` 通过
`getBashShellOverride: () => this.config.bashShellOverride` 注入 tool executor；
`bash.ts` 只在创建 command 时消费 `context.bashShellOverride`：

```ts
const command: ExecutionCommand = {
  mode: "shell",
  command: input.command,
  shellProfile: "posix-bash",
  ...(context.bashShellOverride ? { shellOverride: context.bashShellOverride } : {}),
};
```

- [x] **Step 4: handler test**

新增：

```ts
it("passes user-configured integrated terminal shell into Bash execution request", async () => {
  const execution = createMockExecutionPort();
  const handler = createBashHandler({
    execution,
    settings: {
      integratedTerminalShell: {
        dialect: "git-bash",
        id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
        label: "Git Bash",
        mode: "shell",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
    },
  });

  await handler.execute({ command: "printf 'ok\\n'" }, createToolContext());

  expect(execution.run).toHaveBeenCalledWith(
    expect.objectContaining({
      command: expect.objectContaining({
        shellOverride: {
          dialect: "git-bash",
          id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
          label: "Git Bash",
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
          source: "user-config",
        },
      }),
    }),
    expect.anything(),
  );
});
```

### Task 13: Phase 2 全量验证

**Files:**

- No code files beyond previous tasks.

- [x] **Step 1: settings schema tests**

运行：

```bash
pnpm --filter @zcode/shared test -- --run test/zcodeEndpoint.test.ts
pnpm --filter @zcode/services test -- --run test/settingService.test.ts test/systemService.test.ts
```

预期：PASS。

- [x] **Step 2: UI settings tests**

运行：

```bash
pnpm --filter @zcode/ui test -- --run test/settingsDataBaseDirControl.test.ts
```

预期：PASS，或者新增的 settings shell row test PASS。

- [x] **Step 3: core Bash tests**

运行：

```bash
pnpm --filter @zcode/core test -- --run tests/bash-handler.test.ts
```

预期：PASS。

- [x] **Step 4: repo-level checks**

运行：

```bash
pnpm lint
pnpm typecheck
```

预期：PASS。

当前验证记录：

- `pnpm lint` 已通过，保留仓库既有 warning。
- `pnpm typecheck` 已执行；当前分支仍被既有 `@zcode/shared` export 缺失、implicit any、TS6305 build output 等错误阻塞，首批错误不在本 Phase 2 改动文件内。
- `pnpm --filter @zcode/bootstrap exec tsc --noEmit --pretty false` 已通过。
- `pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts -t "passes a configured Bash shell override to the execution adapter"` 已通过。
- `pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts` 已执行；当前仍有 2 个既有 claude-code-hint/image 相关失败，本 Phase 2 不处理这些历史用例。

- [ ] **Step 5: Windows 手动验证**

在 Windows + Git Bash 环境中：

1. 设置页选择“自动选择”，执行 Bash real-world prompt。
2. 设置页选择“Git Bash”，执行 Bash real-world prompt。
3. 设置页选择“CMD”，执行一个确认 fallback 行为的 Bash call。
4. 清空为“自动选择”，确认设置落盘后下次启动仍是自动。

预期：

- 自动选择和 Git Bash 均能运行 Bash syntax。
- CMD 选择不会让进程启动失败，仍走 cmd dialect。
- provider-visible `Bash` tool 名称和 result shape 不变。
- 手机 Web 远控不会新建独立 agent runtime，设置变更仍经 host service 生效。

## 风险表

| 风险 | 为什么重要 | 缓解方式 |
| --- | --- | --- |
| 把 cmd wrapper 跑进 Git Bash | 会导致 Windows foreground Bash 全坏 | Phase 1 先把 cwd capture 改成 dialect-aware |
| 用户配置的 shell 过期 | 用户升级/卸载 Git Bash 后 path 可能失效 | override path 不可执行时 fallback auto detection |
| Git Bash path conversion 破坏 UNC path | workspace path 可能不可访问 | 补 UNC conversion 测试，不把 WSL path 走 Git Bash |
| 没装 Git Bash 的 Windows 用户从成功变失败 | 会回归现有用户 | resolver 必须无声 fallback 到 `ComSpec ?? "cmd.exe"` |
| generic shell hooks 意外改用 Git Bash | 会破坏 configured hooks/plugin commands | 只对 `shellProfile === "posix-bash"` 生效 |
| `.cmd` / `.bat` argv mode 回归 | Windows 包管理器依赖 shim 处理 | 不动 argv resolver，并跑 `.cmd` tests |
| provider-visible path shape 变化 | 模型可能看到 `/c/...` 而不是 `C:\...` | result content 里的 artifact/log path 保持 host Windows path |
| WSL 混进本地 workspace 语义 | Read/Edit/artifact 可能指错文件系统 | 本计划不启用 WSL fallback |
| 按模型切换的 prompt branch 漂移 | prompt 可能提错 shell/search tool | 本功能不改变 provider-visible tool pool，不改 prompt branch |
| SettingsPage 在非 Windows 展示无效项 | 会误导 macOS/Linux 用户 | Phase 2 使用 host `systemService.info().platform` 控制展示 |
| Web remote 误用浏览器 platform | 手机控制 Windows host 时会判断错 | Phase 2 使用 host service 返回的 platform 和 shell options |
| UI 设置逻辑进入 adapter | 会让 adapter 依赖 app/settings 层 | Phase 1 只接受 `shellOverride`，Phase 2 在 handler/runtime 依赖层映射 |

## 验收标准

### Phase 1

- Windows 且安装 Git Bash 时，`Bash` 可以执行 Bash syntax：array、process substitution、`[[ ... ]]`、`pwd -P`。
- Windows 且未安装 Git Bash 时，`Bash` 仍使用 `ComSpec ?? "cmd.exe"`，shell resolution 不报错。
- 外部注入的有效 `shellOverride` 优先于自动检测。
- 外部注入 path 已失效时，回到自动检测和 cmd fallback。
- 没有 `shellProfile` 的 generic `mode: "shell"` 行为不变。
- 内部 argv mode 继续按原逻辑解析 `.cmd` / `.bat` / `.exe`。
- Git Bash 和 cmd fallback 下 foreground cwd persistence 都可用。
- foreground failed command 不持久化 cwd。
- background Bash 不 capture cwd，继续写 stdout/stderr log。
- 不新增 shell path 环境变量或 Windows startup gate。
- 不把 WSL 当作本地 Bash fallback。

### Phase 2

- Windows 设置页展示“集成终端Shell”下拉，非 Windows 不展示。
- 下拉包含“自动选择”和本机可识别的 supported shell 选项。
- 用户选择 Git Bash 后，Bash execution request 携带 `shellOverride`，并优先使用该 shell。
- 用户选择“自动选择”后，不携带 `shellOverride`，走 Phase 1 自动检测。
- 设置持久化经过 AppSettings schema 和 settingService 归一化。
- UI 文案有 zh-CN / en-US。
- desktop local 和 web remote 仍通过同一个 host setting/system service 链路工作。

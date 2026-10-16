# 原生 WSL 支持实现计划

> 状态（2026-07-15）：已实施并被统一 Remote Target 架构吸收，本文保留为历史计划。
> 当前事实以 `docs/architecture/remote-target-abstraction.md`、
> `packages/server/src/remote/wsl-backend.ts` 和统一 remote 连接 UI 为准；下文独立
> `InitWSL` / `WSLDialog` 方案没有成为当前接口。

## 概述

在 Windows 上支持原生 WSL 连接，通过 `wsl.exe` 直接启动 host process，不走 SSH 网络协议。复用现有的 `IRemoteBackend` 抽象，仅替换 transport 层。

## 核心思路

现有 SSH 远程架构：
```
Main → spawnHostProcess(InitRemote) → Host Process → SSHBackend → 远程 server
```

WSL 架构：
```
Main → spawnHostProcess(InitWSL) → Host Process → WSLBackend → wsl.exe → WSL 内 server
```

区别仅在 backend 实现：SSH 走网络连接 + SFTP，WSL 走 `child_process.spawn("wsl.exe", ...)` + 文件系统直接访问（`\\wsl$\`）。

---

## Step 1: WSLBackend 实现

**文件**: `packages/server/src/remote/wsl-backend.ts`

实现 `IRemoteBackend` 接口，用 `wsl.exe` 替代 SSH：

```typescript
interface WSLBackendOptions {
  distro?: string; // 默认使用 WSL 默认 distro
}
```

### 各方法实现策略

| 方法 | SSH 实现 | WSL 实现 |
|------|---------|---------|
| `detect()` | `ssh exec "uname -s/-m"` | `wsl.exe -d <distro> -- uname -s/-m` |
| `upload(local, remote)` | SFTP 上传 | `fs.copyFile(local, wslToWindowsPath(remote))`，通过 `\\wsl$\<distro>\` UNC 路径直接复制 |
| `exec(cmd)` | `ssh exec cmd` | `child_process.spawn("wsl.exe", ["-d", distro, "--", "bash", "-c", cmd])`，返回 stdio stream |
| `exists(path)` | `ssh exec "test -f"` | `wsl.exe -- test -f <path>` 或直接 `fs.access(wslToWindowsPath(path))` |
| `readFile(path)` | `ssh exec "cat"` | `fs.readFile(wslToWindowsPath(path))` 或 `wsl.exe -- cat <path>` |
| `dispose()` | `client.end()` | 无需特殊清理 |

### 路径转换工具

```typescript
// Linux 路径 → Windows UNC 路径
// ~/.zcode/server/node → \\wsl$\Ubuntu\home\user\.zcode\server\node
function wslToWindowsPath(linuxPath: string, distro: string): string
```

- `~` 需要先通过 `wsl.exe -d <distro> -- echo $HOME` 获取实际 home 目录
- 使用 `\\wsl$\<distro>` 或 `\\wsl.localhost\<distro>` 前缀（Win11 推荐后者）

### 注意事项

- `upload()` 直接用 Node.js `fs.copyFile` 通过 UNC 路径复制，比 `wsl.exe -- cp` 快得多
- `exec()` 返回的 `StdioStream` 需要包装 `child_process.ChildProcess` 的 stdin/stdout/stderr
- `chmod +x` 仍需通过 `wsl.exe -- chmod +x` 执行（Windows fs 不支持 Unix 权限位）

---

## Step 2: WSL 检测工具

**文件**: `packages/server/src/remote/wsl-detect.ts`

提供 WSL 可用性检测和 distro 列表：

```typescript
// 检查当前系统是否为 Windows 且安装了 WSL
async function isWSLAvailable(): Promise<boolean>

// 列出已安装的 WSL distro
interface WSLDistro {
  name: string;       // e.g. "Ubuntu-22.04"
  isDefault: boolean;
  state: "Running" | "Stopped";
  version: 1 | 2;    // WSL 1 or 2
}
async function listWSLDistros(): Promise<WSLDistro[]>
```

### 实现方式

- `isWSLAvailable()`: `process.platform === "win32"` + 尝试执行 `wsl.exe --status`
- `listWSLDistros()`: 执行 `wsl.exe -l -v --all`，解析表格输出
  - 注意：`wsl.exe -l -v` 输出是 UTF-16LE 编码，需要正确解码
  - 默认 distro 用 `*` 标记

### 注意事项

- WSL 1 不支持 `\\wsl$\` UNC 路径访问，需要标记并在 UI 上提示用户升级到 WSL 2
- 非 Windows 平台直接返回 `isWSLAvailable() = false`

---

## Step 3: 类型定义与消息协议扩展

### 3.1 新增 WSLConnectOptions

**文件**: `packages/shared/src/index.ts`

```typescript
export interface WSLConnectOptions {
  distro?: string; // 不填则用默认 distro
}
```

### 3.2 新增 Zod 校验

**文件**: `packages/shared/src/validation.ts`

```typescript
export const wslConnectOptionsSchema = z.object({
  distro: z.string().optional(),
});

export const hostInitWSLMessageSchema = z.object({
  type: z.literal("init-wsl"),
  wslOptions: wslConnectOptionsSchema,
  remoteAssets: remoteAssetDirsSchema,
});
```

更新 `hostIncomingMessageSchema` discriminated union 加入 `hostInitWSLMessageSchema`。

### 3.3 扩展 HostMessageTypes

**文件**: `packages/shared/src/channels.ts`

```typescript
export const HostMessageTypes = {
  InitLocal: "init-local",
  InitRemote: "init-remote",
  InitWSL: "init-wsl",       // 新增
  Dispose: "dispose",
  Broadcast: "broadcast",
} as const;
```

### 3.4 新增 PlatformChannel

```typescript
export const PlatformChannels = {
  ...
  ConnectRemote: "zcode:connect-remote",
  ConnectWSL: "zcode:connect-wsl",    // 新增
  ListWSLDistros: "zcode:list-wsl-distros", // 新增
  ...
};
```

在 `PlatformChannelMap` 中添加对应类型映射。

---

## Step 4: Host Process 扩展

**文件**: `packages/desktop/src/host/index.ts`

在现有的 `InitLocal` / `InitRemote` 分支旁添加 `InitWSL` 分支：

```typescript
} else if (msg.type === HostMessageTypes.InitWSL) {
  logger.info(`initializing WSL connection, distro=${msg.wslOptions.distro ?? "default"}`);
  try {
    const connection = await setupWSLConnection(msg.wslOptions, msg.remoteAssets);
    // 后续注册服务的逻辑与 InitRemote 完全一致
    // file/system/terminal/zcode task/session → 来自 WSL（远端）
    // setting/credential/broadcast → 本地
    ...
    parentPort.postMessage({ type: HostResponseTypes.Connected });
  } catch (err) {
    parentPort.postMessage({ type: HostResponseTypes.Error, error: String(err) });
  }
}
```

### setupWSLConnection

```typescript
async function setupWSLConnection(
  options: WSLConnectOptions,
  remoteAssets: RemoteAssetDirs,
): Promise<RemoteConnection> {
  const { WSLBackend } = await import("@zcode/server/remote");
  const backend = new WSLBackend(options);
  return connectRemote(backend, remoteAssets);
  // connectRemote() 完全复用 —— 它只依赖 IRemoteBackend 接口
}
```

---

## Step 5: Main Process 扩展

**文件**: `packages/desktop/src/main/index.ts`

### 5.1 新增 createWSLWindow 函数

参考 `createRemoteWindow`，创建 `createWSLWindow`：

```typescript
async function createWSLWindow(options: WSLConnectOptions) {
  // 与 createRemoteWindow 结构相同
  // 区别：
  // 1. 窗口标题: `ZCode - WSL (${options.distro ?? "default"})`
  // 2. 发送 InitWSL 消息而非 InitRemote
  // 3. remoteAssets 解析逻辑相同
}
```

### 5.2 注册 IPC handler

```typescript
ipcMain.handle(PlatformChannels.ConnectWSL, async (_event, rawOptions) => {
  const parsed = wslConnectOptionsSchema.safeParse(rawOptions);
  if (!parsed.success) return { success: false, error: formatZodError(parsed.error) };
  try {
    await createWSLWindow(parsed.data);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
});
```

---

## Step 6: Preload Bridge 扩展

**文件**: `packages/desktop/src/preload/index.ts`

在 `window.zcode` 上新增：

```typescript
connectWSL: (options: WSLConnectOptions) =>
  ipcRenderer.invoke(PlatformChannels.ConnectWSL, options),
listWSLDistros: () =>
  ipcRenderer.invoke(PlatformChannels.ListWSLDistros),
```

---

## Step 7: Platform Service 接口扩展

**文件**: `packages/shared/src/platform.ts`

在 `IPlatformService` 中新增：

```typescript
connectWSL(options: WSLConnectOptions): Promise<{ success: boolean; error?: string }>;
listWSLDistros(): Promise<WSLDistro[]>;
```

**文件**: `packages/desktop/src/renderer/src/main.tsx`

Desktop 实现接入 `window.zcode.connectWSL` / `window.zcode.listWSLDistros`。

**文件**: `web/src/main.tsx`

Web 实现返回 `{ success: false, error: "WSL not supported in web mode" }` 和空数组。

---

## Step 8: UI —— WSL 连接对话框

**文件**: `packages/ui/src/WSLDialog.tsx`

比 SSHDialog 简单得多，只需要一个 distro 选择器：

### 交互流程

1. 用户点击"连接到 WSL"按钮
2. Dialog 打开，自动调用 `listWSLDistros()` 获取可用 distro 列表
3. 显示 distro 列表（radio 或 select），默认选中 default distro
4. 用户选择 distro 后点击"连接"
5. 调用 `connectWSL({ distro })` → 新窗口打开

### 状态处理

- Loading 状态：检测 distro 列表中
- Empty 状态：未安装 WSL 或无 distro，提示安装指引
- Error 状态：连接失败，显示错误信息
- WSL 1 distro：显示但标记为不可选，tooltip 提示需升级到 WSL 2

### 入口位置

与 SSH 连接入口并列：
- `ChatEmptyState` 中新增 WSL 连接按钮
- `WorkspaceSidebar` 中新增 WSL 连接选项
- 仅在 `process.platform === "win32"` 时显示（通过 `systemInfo.platform` 判断）

---

## Step 9: 国际化

**文件**: `packages/ui/src/i18n/` 下对应的 locale 文件

新增 key：
```
wsl.trigger: "连接到 WSL" / "Connect to WSL"
wsl.title: "WSL 连接" / "WSL Connection"
wsl.description: "选择要连接的 WSL 发行版" / "Select a WSL distribution to connect"
wsl.distro: "发行版" / "Distribution"
wsl.distro.default: "默认" / "Default"
wsl.connecting: "正在连接…" / "Connecting…"
wsl.success: "连接成功" / "Connected"
wsl.noDistro: "未检测到 WSL 发行版" / "No WSL distributions found"
wsl.wsl1Warning: "WSL 1 不受支持，请升级到 WSL 2" / "WSL 1 is not supported, please upgrade to WSL 2"
wsl.connect: "连接" / "Connect"
wsl.cancel: "取消" / "Cancel"
```

---

## Step 10: 导出和模块注册

### 10.1 server 包导出

**文件**: `packages/server/src/remote/index.ts`

新增导出：
```typescript
export { WSLBackend } from "./wsl-backend.js";
export type { WSLBackendOptions } from "./wsl-backend.js";
export { isWSLAvailable, listWSLDistros } from "./wsl-detect.js";
export type { WSLDistro } from "./wsl-detect.js";
```

### 10.2 shared 包导出

确保 `WSLConnectOptions`、`WSLDistro`、`wslConnectOptionsSchema` 从 shared 包正确导出。

---

## 实现顺序建议

1. **Step 1 + Step 2** — WSLBackend + 检测工具（核心，可独立测试）
2. **Step 3** — 类型和消息协议（无运行时影响）
3. **Step 4 + Step 5** — Host Process + Main Process（连通管道）
4. **Step 6 + Step 7** — Preload + Platform 接口（打通到 renderer）
5. **Step 8 + Step 9** — UI + 国际化（可见的用户入口）
6. **Step 10** — 导出清理

## 风险点

1. **`wsl.exe -l -v` 输出编码**：UTF-16LE 且格式不稳定，不同 Windows 版本可能有差异，需要做健壮的解析
2. **UNC 路径兼容性**：`\\wsl$\` 在某些 Windows 10 版本不可用，需要同时尝试 `\\wsl.localhost\`
3. **node-pty 预编译**：需要准备 linux-x64 的 node-pty 预编译文件用于 WSL（与 SSH 远程连接到 Linux 时复用同一套）
4. **WSL 1 vs WSL 2**：WSL 1 没有完整的 Linux 内核，部分功能可能不兼容，建议仅支持 WSL 2
5. **Windows 路径权限**：通过 UNC 路径复制的文件可能缺少执行权限，`chmod +x` 必须通过 `wsl.exe` 执行

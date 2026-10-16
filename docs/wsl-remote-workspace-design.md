# WSL 远程工作区支持方案

## 背景

当前 ZCode 支持 SSH 和 Docker 远程连接。本文档记录 WSL（Windows Subsystem for Linux）支持的实现方案。

## 实现状态

### ✅已完成

- [x] `WSLBackend` 类（`packages/server/src/remote/wsl-backend.ts`）
- [x] `WSLDetect` 工具（`packages/server/src/remote/wsl-detect.ts`）
- [x] `createRemoteBackend` 工厂支持 wsl（`packages/server/src/remote/create-backend.ts`）
- [x] UI 层 KindStep 添加 WSL 选项
- [x] UI 层 SettingsStep 支持 WSL 表单
- [x] UI 层 ConnectingStep 支持 WSL
- [x] 国际化文案（en-US / zh-CN）
- [x] 反馈模块支持 WSL 连接失败

## SSH vs WSL 核心差异

| 维度 | SSH | WSL |
|------|-----|-----|
| 连接方式 | TCP 网络协议，ssh2 库 | 本地子进程，wsl.exe |
| 认证 | 密码/私钥/SSH Agent | Windows 用户身份（无需认证） |
| 文件系统 | SFTP / exec pipe | Windows 路径映射 `\\wsl$\Distro` |
| 部署路径 | 远程 `~/.zcode/server` | WSL 路径 `/home/user/.zcode/server` |

## 当前释放生命周期

WSL 使用 window-scoped pooled Remote Host：同一窗口、同一 normalized distro/user 的 logical workspace
session 共享一个 Host、一个 `wsl.exe` server launcher 和一个 `zcode-server`。每个 session 仍保留独立
`remoteSessionId`、attachment 和 `workspaceKey`。最小化、隐藏到托盘、renderer reload、手机 `/remote`
attachment 断开都不直接销毁 Host。

```text
单 workspace 最后引用关闭
  -> Host 按 workspace generation 释放 preparation/Agent runtime
  -> 有 running task 时延迟到 terminal
  -> 同 workspace 快速重开先等待 acquire ACK，再 attach RPC port

最后 Host owner 关闭
  -> 保留 60 秒 idle TTL，期间可复用同一 Host/server

真实关窗 / app quit / update install
  -> RemoteSessionManager 快照并去重 Remote Host
  -> Main 发送 Host Dispose，并等待 Host 退出
  -> Host 分阶段释放 services
  -> RemoteConnection 同步 stdin.end()，等待远端 stdio close
  -> WSLBackend 等待自己创建的 wsl.exe 子进程退出
  -> grace timeout 后只 kill 该 backend 记录的 child
```

释放过程禁止调用 `wsl --terminate` 或 `wsl --shutdown`。WSL distro 可能仍显示 Running，这是发行版级
运行状态，不代表 ZCode 的 Host、`wsl.exe` 或远端 `zcode-server` 仍被持有。任何 fallback 只能作用于
当前 backend 明确 spawn 的子进程，不能按进程名扫描或终止用户在同一 distro 中的其他任务。

Main 的 Remote Host 集合包含 WSL/SSH shared Host、Docker/Server dedicated Host 和 Bot remote runtime。
应用退出和更新安装使用同一幂等等待屏障；屏障开始后拒绝创建新的 Remote Host，避免新进程落在快照之外。

## 方案：组合模式 + 接口统一

### 核心思路

复用 `IRemoteBackend` 接口（`packages/server/src/remote/backend.ts`），创建 `WSLBackend` 实现类，通过 `wsl.exe` 子进程替代 ssh2。

### 目录结构

```
packages/server/src/remote/
├── ssh-backend.ts          # 现有 SSH 实现
├── wsl-backend.ts          # 新增 WSL 实现
├── backend.ts              # IRemoteBackend 接口
├── connect.ts              # 连接流程编排（需修改）
└── detectEnv.ts            # 环境检测（可复用）
```

### WSLBackend 实现

```typescript
// packages/server/src/remote/wsl-backend.ts
import { spawn, execSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { Emitter } from "@zcode/rpc";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  StdioStream,
} from "@zcode/server/remote/backend.js";

export interface WSLBackendOptions {
  distribution?: string;  // WSL 分发版名称，如 "Ubuntu"
}

export class WSLBackend implements IRemoteBackend {
  private readonly distro: string;
  private disposed = false;
  private readonly disconnectEmitter = new Emitter<RemoteDisconnectEvent>();
  readonly onDidDisconnect = this.disconnectEmitter.event;

  constructor(options: WSLBackendOptions = {}) {
    this.distro = options.distribution || "Ubuntu";
  }

  // 1. 检测环境：直接执行 wsl 命令
  async detect(): Promise<RemoteEnvironment> {
    const platform = await this.execSimple("uname -s").catch(() => "Linux");
    const arch = await this.execSimple("uname -m").catch(() => "x86_64");
    return { platform, arch };
  }

  // 2. 上传文件：Windows -> WSL 路径
  async upload(localPath: string, remotePath: string): Promise<void> {
    const wslDest = this.toWSLPath(remotePath);
    // 使用 wsl.exe cp 或 exec cat
    await this.execSimple(`mkdir -p "$(dirname '${wslDest}')" && cat > '${wslDest}'`);
  }

  // 3. 执行命令：wsl.exe --exec
  async exec(command: string): Promise<StdioStream> {
    const proc = spawn("wsl.exe", ["--distribution", this.distro, "--", "bash", "-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      stdin: proc.stdin!,
      stdout: proc.stdout!,
      stderr: proc.stderr!,
      onClose: (callback: (code: number) => void) => {
        proc.on("close", (code) => callback(code ?? 0));
      },
    };
  }

  // 4. 检查文件存在
  async exists(remotePath: string): Promise<boolean> {
    const wslPath = this.toWSLPath(remotePath);
    const result = await this.execSimple(`test -f "${wslPath}" && echo OK`);
    return result.trim() === "OK";
  }

  // 5. 读取文件
  async readFile(remotePath: string): Promise<string> {
    const wslPath = this.toWSLPath(remotePath);
    return this.execSimple(`cat "${wslPath}"`);
  }

  // 工具方法：Windows 路径 -> WSL 路径
  private toWSLPath(path: string): string {
    // ~ 展开为 /home/user/
    if (path.startsWith("~")) {
      return path.replace("~", this.getHomeDir());
    }
    return path;
  }

  private getHomeDir(): string {
    try {
      return execSync(`wsl.exe --distribution ${this.distro} -- bash -c "printf %s \\$HOME"`, {
        encoding: "utf-8",
      }).trim();
    } catch {
      return "/home/user";
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnectEmitter.dispose();
  }
}
```

### 连接流程修改

```typescript
// packages/server/src/remote/connect.ts
import { SSHBackend } from "./ssh-backend.js";
import { WSLBackend } from "./wsl-backend.js";
import type { IRemoteBackend } from "./backend.js";

export type RemoteBackendType = "ssh" | "wsl";

export interface RemoteConnectOptions {
  type: RemoteBackendType;
  // SSH 选项
  host?: string;
  port?: number;
  username?: string;
  // WSL 选项
  distribution?: string;
  // 通用选项
  privateKeyPath?: string;
  password?: string;
}

export function createRemoteBackend(options: RemoteConnectOptions): IRemoteBackend {
  switch (options.type) {
    case "wsl":
      return new WSLBackend({ distribution: options.distribution });
    case "ssh":
    default:
      return new SSHBackend({
        host: options.host!,
        port: options.port,
        username: options.username!,
        privateKeyPath: options.privateKeyPath,
        password: options.password,
      });
  }
}
```

## 关键实现细节

### 1. WSL 路径转换

WSL 有两种访问方式：
- WSL 内部路径：`/home/user/.zcode`
- Windows 访问 WSL：`\\wsl$\Ubuntu\home\user\.zcode`

但为了保持与 SSH 的一致性，建议使用 WSL 内部路径。

### 2. 文件上传优化

当前 SSH 使用 SFTP + exec fallback，WSL 可以：
- 小文件：`wsl.exe --exec cat` + stdin pipe
- 大文件：考虑 `wsl.exe cp` 或直接写 `\\wsl$\Distro` 路径

### 3. 部署 zcode-server

与 SSH 完全相同：
```bash
# SSH
ssh user@host "ZCODE_SERVER_RUNTIME_ROOT=~/.zcode/server ~/.zcode/server/node ..."

# WSL
wsl.exe --exec bash -c "ZCODE_SERVER_RUNTIME_ROOT=~/.zcode/server ~/.zcode/server/node ..."
```

### 4. 检测可用 WSL 分发版

```typescript
export async function listWSLDistributions(): Promise<string[]> {
  const output = execSync("wsl.exe --list --quiet", { encoding: "utf-8" });
  return output.split("\n").map((s) => s.trim()).filter(Boolean);
}
```

## UI 层改动

连接对话框需要：
1. 增加连接类型选择：SSH / WSL
2. SSH 模式：显示 host、port、username、认证方式
3. WSL 模式：显示分发版选择（默认读取可用列表）

## 风险与注意事项

1. **WSL 版本**：需 WSL2（支持 `wsl.exe --exec`）
2. **路径分隔符**：Windows 用 `\`，WSL 用 `/`
3. **权限**：WSL 以当前 Windows 用户身份运行，无需额外认证
4. **性能**：WSL 通信比 SSH 快（本地进程 vs TCP）
5. **平台限制**：仅在 Windows 桌面端可用

## 实现顺序

1. ✅ 定义 `IRemoteBackend` 接口（已存在）
2. 📝 实现 `WSLBackend` 类
3. 📝 修改 `connect.ts` 支持创建 WSL 后端
4. 📝 UI 层添加 WSL 连接选项
5. 📝 测试部署流程

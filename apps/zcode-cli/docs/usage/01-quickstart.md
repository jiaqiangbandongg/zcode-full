# 01 · 快速开始

## 从源码构建

准备 Git、Node.js 24.14.0 和 pnpm 10.33.2；以仓库根目录的 [mise.toml](../../../../mise.toml) 为准。以下命令在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --version
node apps/zcode-cli/packages/cli/dist/zcode.cjs doctor --json
```

`@zcode/cli...` 包含 CLI 的 workspace 依赖。首次安装会执行仓库的资源准备步骤，需要能访问包和资源下载源。不要把安装脚本被跳过的目录当作完整发行包。

需要单文件可执行产物时，在完成构建后执行：

```sh
pnpm --filter @zcode/cli sea --target linux-x64
```

目标包括 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win-arm64`、`win-x64`。产物在 `apps/zcode-cli/packages/cli/dist/`；Windows 文件名使用 `zcode-windows-<arch>.exe`。交叉打包不等于目标平台运行验证。

后文以 `zcode` 代表 CLI 命令。使用普通 Node bundle 时，替换为 `node /absolute/path/to/zcode.cjs`，并保留构建生成的相邻资源。SEA 内嵌 Node，不依赖系统 Node 版本；MCP、Hook 或插件启动的外部程序仍须单独安装。

## 使用可执行文件

macOS/Linux 给可信产物添加执行权限，然后直接使用绝对路径：

```sh
chmod +x /absolute/path/to/zcode-darwin-arm64
/absolute/path/to/zcode-darwin-arm64 doctor --json
```

Windows PowerShell 示例：

```powershell
& 'C:\tools\zcode-windows-x64.exe' doctor --json
```

不要使用不匹配的系统或 CPU 架构。macOS 若拦截未签名产物，先确认来源，再通过系统设置允许运行；不要对未知文件批量移除安全属性。

## 自检与模型设置

```sh
zcode --version
zcode --help
zcode doctor --json
zcode plugins list --json
zcode skills list --json
```

`doctor` 用于检查版本、平台、CPU、Node、执行路径和 SEA 状态；它不证明模型凭据、网络或工具调用已经可用。插件清单可以独立查询，不要求先发一次付费模型请求。

当前源码的个人模型设置保存在 `~/.zcode/v2/provider_config.json`；运行与扩展设置仍在 `~/.zcode/cli/config.json`。按[配置](03-config.md)建立个人 provider，或在受支持的账号路径上执行 `zcode login`。远程终端可用 `zcode login --no-browser` 显示登录 URL；浏览器回调仍可能要求与 CLI 位于同一机器。

## 第一次非交互调用

```sh
zcode --prompt "只用一句话回复 ready，不调用工具" --cwd /absolute/path/to/project --mode plan --json --no-color
```

普通 prompt 成功时返回 `sessionId`、`response` 和相关运行信息。然后在一次性测试目录中验证所需工具，检查真实文件或命令结果。模型回复“成功”不等于工具已执行。

需要执行命令、修改文件的自动化任务通常显式使用 `--mode yolo`，并由任务容器或操作系统限制可访问范围。`--prompt` 缺省也采用 `yolo`。这不是只读模式，也不是沙箱。批量执行前继续阅读[工具](04-tools.md)和[权限](05-permissions.md)。

## 隔离运行环境

并发任务应使用独立工作目录、用户目录和数据基目录。在子进程环境中同时设置 `HOME`、`USERPROFILE`、`ZCODE_DATA_BASE_DIR` 为本次运行的临时目录；不要修改调用者的全局环境。这样可隔离凭据、个人模型配置、会话、插件和记忆。`ZCODE_STORAGE_DIR` 只控制部分存储路径，不能单独代表完整隔离。

可复制的跨平台子进程例子见[批量任务](13-automation.md)。配置文件和密钥也须写入该隔离环境；不能依赖开发机原有登录态。

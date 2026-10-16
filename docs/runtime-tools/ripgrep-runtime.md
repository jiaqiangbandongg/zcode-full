# Ripgrep Runtime

## 背景

- ZCode Agent 在 GUI desktop、SSH remote、WSL、Docker 里执行 shell 时，不能稳定依赖宿主机器是否已经把 `rg` 放进 `PATH`
- 同一批环境里还会遇到 GUI / 非 login shell 丢失 `bun`、`nvm` 路径的问题

## 方案

- `packages/shared/src/runtime-tool-runtime.ts` 统一声明内置 `bfs`、`ripgrep`、`ugrep` runtime tool
- 本地 desktop/SEA 和 Linux remote 的 `ripgrep` 固定为 Microsoft `ripgrep-prebuilt v14.1.1-1`；macOS arm64/x64、Linux arm64/x64 与 Windows x64/arm64 全部从 `${ZCODE_DEPS_BASE_URL}/native-search-tools/ripgrep-v14.1.1-1` 下载固定 SHA-256 的 Microsoft 原始归档，不再由 native-search producer 构建。所选 macOS 归档的 deployment target 不高于 12.0，Linux 使用无 glibc 依赖的 musl 静态归档，Windows 两个架构拒绝动态 CRT 与本应静态链接的构建依赖，因此升级 rg 不改变 ZCode 原有系统分发下限。Darwin remote producer 暂时保留历史 `v13.0.0-10` 资源，两者不共用版本 metadata，desktop prepare 不再暴露旧版本下载入口
- `packages/services/src/runtime-tools/runtimeCommandEnv.ts` 在 host / server 启动时：
  - 尝试从 login shell 回放一份 `PATH`
  - 再把内置工具目录 append 到 `PATH`；`rg` 保留用户已有命令的优先级，`find` / `grep` 由 embedded-search prelude 直接使用随包绝对路径
  - 同时注入 `ZCODE_BFS_BINARY`、`ZCODE_RG_BINARY`、`ZCODE_UGREP_BINARY`
- ZCode Agent 子进程继续通过 clean runtime env 继承这套环境，不需要各入口单独处理

## 资源布局

### 本地 desktop

```text
packages/desktop/bundled-tools/<platform>/ripgrep/rg(.exe)
resources/tools/ripgrep/rg(.exe)
```

### Remote

```text
mock-cdn/releases/<version>/tools/linux-<arch>/{bfs,ripgrep,ugrep}/<binary>
~/.zcode/server/tools/{bfs,ripgrep,ugrep}/<binary>
```

Linux remote（包括 WSL、Linux SSH 与 Linux Docker）部署 `bfs 4.1.1-2`、
`ugrep 7.8.4-1` 与 Microsoft `ripgrep 14.1.1-1`。Darwin remote 继续部署历史
`ripgrep 13.0.0-10`，不随 Linux remote 迁移；旧版本发布的 rg13 资产也继续保留。

## 结果

- 本地 GUI 启动时，ZCode Agent/终端能恢复 login shell 里的 `bun`
- 宿主机已有 `rg` 时继续优先使用用户版本；没有 `rg` 时，ZCode Agent 在本地和 remote 都能直接运行随包版本
- desktop/SEA 与 Linux remote 可使用随包 `bfs` / `ugrep`；工具缺失或不可执行时仍分别回退 system `find` / `grep`

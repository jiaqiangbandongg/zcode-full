# Desktop 本地 Crash 留档

Desktop 主进程在启动早期配置 crash dump 路径，并同时保留两条链路：

- ARMS 接收 native crash 与 Electron main 异常，用于线上监控（`appARMSBootstrap.ts`）
- 本地额外归档一份原始 minidump，方便用户或开发排查（`desktopCrashCapture.ts`）

ARMS crash collector 会扫描 `live` 目录中的全部 dump。为避免后代或外部程序继承
Crashpad 后把 `hdc`、`plugin-container`、`chrome-headless-shell` 等 dump 混入 ZCode
健康度，`beforeReport` 先保留 `binary_images` 中含当前 ZCode 产品可执行文件的事件；但仅有
二进制命中不能证明是主进程崩溃。没有明确 `native_dump_process_role=main` 的 dump 会标记为
`native_dump_unattributed`，继续保留原始诊断事件但不进入 App Crash / Crash-Free，避免
Linux/Windows 共用 executable 的 helper/utility crash loop 污染产品稳定性指标。
角色来源必须是 Crashpad dump 的结构化注解：`@arms/rum-electron` 的 crash collector
必须从 minidump stream directory 定位 Crashpad info，并沿 annotation 的 RVA 引用读取
`process_type` / `ptype` 后透传为事件 `meta.process_type`，应用侧再把 `browser` 归一化为
`main`。不得扫描整个 dump 猜测相邻的 key/value 字节；未被 Crashpad annotation 结构引用的
同名字节一律忽略。
事件里的 `meta.process` 仅是应用名，不能作为进程角色回退；缺失或无法解析角色时必须保持
`native_dump_unattributed`。
可信可执行文件名同时取产品应用名与 `basename(process.execPath)`：生产包通常两者相同；
本地开发运行实际使用 `Electron`，Linux Preview 则使用 `zcode-preview`，不能只拿
`app.getName()` 与 dump 模块名比较。
本地 `archive` 仍保留原始文件，过滤线上指标不会改变本地诊断链路。

## 目录结构

```
<appConfigDir>/crash/
  ├── live/        ← Electron / Crashpad 实时写入目录（`app.setPath("crashDumps")`）
  └── archive/     ← ZCode 额外保留的本地副本
```

`appConfigDir` 默认 `~/.zcode/v2/`；用户配置了自定义 `dataBaseDir` 时，路径为 `<dataBaseDir>/.zcode/v2/crash/`（依赖 `desktopEarlyDataBaseDirBootstrap` 在 crash 初始化前注入 `dataBaseDir`）。

## 本地归档保留策略

`archive/` 只用于保留原始 minidump，供线上事件不足以定位问题时离线排查；它不参与
Crashpad 采集或 ARMS 上报。为了避免历史 dump 无限占用用户磁盘，本地归档遵循以下规则：

- 最多保留最近 5 个 `.dmp`
- 除最新一个外，归档总大小不得超过 100 MiB
- 最新一个 `.dmp` 始终保留，即使它本身超过 100 MiB
- 删除旧 `.dmp` 时一并删除同名 `.dmp.json` 元数据；若元数据删除暂时失败，后续清理会识别并重试删除不存在同名普通 `.dmp` 的孤立元数据，不处理其他 JSON 文件
- 清理只作用于 `archive/`；`live/` 仍完全由 Electron Crashpad / ARMS 管理

清理在每次归档完成后执行，按 `.dmp` 修改时间从新到旧保留。这样既限制历史文件累积，
又保证最近一次原生崩溃仍有本地原始现场可供分析。若最新单个 dump 本身异常巨大，目录允许
临时超过 100 MiB；这是保留最近崩溃诊断能力的有意例外，而不是严格磁盘配额。

## 启动顺序

1. `desktopEarlyDataBaseDirBootstrap`：同步读取 `setting.json` 的 `dataBaseDir`
2. `appCrashCaptureBootstrap`：配置 `crashDumps`、归档上一轮残留 `.dmp`
3. `appARMSBootstrap`：初始化 ARMS（`collectors.crash: true`）
4. `index.ts`：`app.setPath("userData")` / `sessionData` 等
5. `registerCrashEventMonitor`：renderer / 子进程崩溃后延迟归档（避免 live 目录被 SDK 清理后无本地副本）

## 相关文件

- `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts`
- `packages/desktop/src/main/desktopEarlyDataBaseDirBootstrap.ts`
- `packages/desktop/src/main/appCrashCaptureBootstrap.ts`
- `packages/desktop/src/main/desktopCrashCapture.ts`
- `packages/desktop/src/main/appARMSBootstrap.ts`
- `packages/desktop/src/main/index.ts`

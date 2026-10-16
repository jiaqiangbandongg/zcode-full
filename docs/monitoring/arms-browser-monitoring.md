# ARMS Electron 监控

当前只在 Electron 桌面端接入 `@arms/rum-electron`。Web/手机远控端暂不接入 ARMS Browser SDK。ARMS SDK 只接在 main 进程入口，不进入 `packages/ui`。

参考：[阿里云 ARMS Electron 接入文档](https://www.alibabacloud.com/help/zh/arms/user-experience-monitoring/integrating-with-an-electron-application)

## 监控范围

ARMS 负责 Electron 运行时用户体验监控：

- 全局 JS Error、Promise rejection（主进程 + SDK 自动注入 Renderer）。
- XHR/fetch API 成功率、失败率、耗时、状态码。
- Renderer longTask / LoAF / rAF 主线程卡顿事件；主进程 `beforeReport` 仅补低基数归因摘要，不补原始脚本名或 URL。
- Electron main 进程异常、原生崩溃、应用启动相关事件（`application` collector）。
- RPC 调用（`rpc` collector，需主进程 tRPC 使用 `instrumentTRPC`）。

ARMS 不负责：Host/Agent 业务日志、质量统计数据库、`/report` 业务埋点、Web 远控端 RUM。Agent 非预期退出不依赖 SDK 自动采集，由 Host lifecycle bridge 主动发送脱敏的 `perf_agent_crash` / `perf_agent_spawn_error` 自定义事件。

## Console Error 采集边界

Desktop main logger 会按 `console.error(prefix, message, context)` 输出错误，其中 `prefix` 是
`[timestamp] [pid] [source]` 公共前缀，`source` 包括 `main`、`renderer` 等来源。ARMS Electron
SDK 的 console collector 必须在采集边界归一化多参数调用，不能只把第一个参数当作
`exception.message`：

```text
console.error(prefix, message, context/Error)
                    │
                    ▼
          ARMS console collector
          ├─ Error：保留 name / message / stack
          └─ 非 Error：去掉公共 prefix，安全序列化其余参数
                    │
                    ▼
         有界、脱敏的 exception.message
```

归一化规则：

- 参数中存在 `Error` 时继续优先上报该对象，保留原始堆栈。
- 非 `Error` 多参数调用去掉首个 main logger 公共前缀（`main` / `renderer` 等 source），再按调用顺序拼接字符串和上下文。
- 对对象键名及常见 token 文本做脱敏；循环引用不得让采集器抛错。
- 最终 message 最长 2000 字符；只有公共前缀、没有业务正文时不产生 exception 事件。
- `clean-exit` / `killed` 等受控退出属于生命周期信息，使用 `info`；可恢复异常退出使用
  `warn`；只有确认的 crash、OOM、启动失败等才使用 `error`。

## 依赖补丁安装约束

仓库使用 `node-linker=hoisted`，当前 ZCode 补丁固定基于 `@arms/rum-electron@0.0.3`。修改补丁时
必须从该版本的原始 `dist/index.mjs` 一次性重新生成完整 unified diff，禁止直接向现有 patch
追加 hunk；否则后续 hunk 的目标行号和目标 blob hash 会与完整结果不一致，pnpm 10 第二次
`pnpm install` 会对已 patch 文件再次应用补丁并报 `ERR_PNPM_PATCH_FAILED`。补丁变更后必须校验
patch 头的目标 blob 与安装产物一致，并验证同一工作区连续执行两次 `pnpm install` 都成功。

## 配置（硬编码）

| 项                         | 位置 / 值                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Endpoint                   | `ZCODE_ARMS_RUM_ENDPOINT`（`packages/shared/src/env.ts`）                                                            |
| 上报环境                   | `mapZCodeEnvToArmsRumEnv(runtimeEnv)`：本地开发运行态始终为 `local`；非本地运行态仅 `ZCODE_ENV=production` 为 `prod` |
| `sessionConfig.sampleRate` | `1`（100% 会话采样）                                                                                                 |
| `autoInject`               | `true`（SDK 在 `dom-ready` 注入 Browser SDK；勿再 preload/renderer 手动 init）                                       |
| `browserCollectors`        | `perf/webvitals/exception/whiteScreen/api/staticResource/click/longTask: true`（见 `ARMS_BROWSER_COLLECTORS`）       |
| `spaMode`                  | `false`（Electron 单页整页加载，非 History SPA）                                                                     |
| `parseViewName`            | `file://` 取 html 文件名；http dev-server 取 pathname                                                                |
| `tracing`                  | `arms_env=prod` 时 `enable: true`、`sample: 0.1`（0.1%）；`arms_env=local` 时 `sample: 1`                            |

无 `ZCODE_ARMS_*` 环境变量。

## longTask 归因摘要

Browser SDK 的 `longTask` collector 会把 LoAF / rAF attribution 写入 `snapshots`。为便于 SLS 查询且避免高基数与路径泄露，主进程 `appARMSBootstrap.beforeReport` 只把 top attribution 摘要合入同一条 longTask 的 `properties`：

| 字段                    | 含义                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `loaf_script_count`     | `snapshots` 中 attribution 条数，最多 5。                   |
| `loaf_top_duration_ms`  | top attribution 耗时 ms。                                   |
| `loaf_top_invoker_type` | `user-callback` / `event-listener` / `script` / `unknown`。 |
| `loaf_top_share_pct`    | top attribution 占 longTask `duration` 的百分比整数。       |

该增强不新增事件、不改变采样率；`snapshots` 缺失或解析失败时跳过。禁止把原始脚本名、URL、文件路径、selector、堆栈或源码片段写入这些 properties。

## 自动采集事件的脱敏边界

SDK collector 采集的字段由 ARMS 决定，其原始内容可能包含用户界面文本、本机路径和完整
URL。`appARMSBootstrap.beforeReport` 是这些事件离开本机前的唯一收口，必须在 longTask 归因
摘要之后、返回 payload 之前对整批事件执行脱敏。脱敏只改写上报副本，不改变本地日志、错误
展示、崩溃归档和 `perf_network_window` 的聚合口径（网络聚合在脱敏前完成 ingest，沿用
`normalizeHttpInterface` 自己的维度规则）。

### `click`

Browser SDK 的 `name` 形如 `click on <type-><tag>: <innerText 前 20 字符>...`，
`snapshots` 为 `{id,name,className,href,src}` 的 JSON。ZCode 的可点击文本包含会话标题、
工作区目录名、文件名、消息正文和账号邮箱，因此：

- `name` 只保留 `click on <type-><tag>`，截掉 `: ` 之后的元素文本。
- 删除 `snapshots`（`href` / `src` 可能是本地文件路径，`id` / `className` 无诊断价值）。
- 保留 `target_name`（XPath 只表达结构位置，不含文本）与耗时、视图等非内容字段。

### `exception`

`jsError`（`uncaughtException` / `unhandledRejection`）、`consoleError`、`whiteScreen` 与
renderer 侧 exception 的 `message` / `stack` / `file` / `snapshots` 按统一文本脱敏规则处理：URL 只留
`protocol//host` 与归一化路由、绝对路径归一为 `{path}`、邮箱归一为 `{email}`、凭据与
Authorization 归一为 `{redacted}` / `{secret}`，并做有界截断。依赖补丁中的 console 脱敏只覆盖
凭据关键字，路径与邮箱由本节收口补齐。`file` 是 SDK 从 `ErrorEvent.filename` 采到的脚本 URL，
Windows 安装版位于 `C:\Users\<用户名>\AppData\...`，必须与 `stack` 同规则处理；
`crashReporter` 原生 dump 事件不在本节范围，其 `binary_images` 仍用于产品二进制判定。

### `api` / `resource`

`url` 与 `name` 只保留 `protocol//host` 加归一化路由，丢弃 query 与 fragment；路由分段中的
ID、hash、邮箱形态归一为占位符。`message`（statusText 或错误摘要）按文本脱敏规则处理。

上述规则的文本实现是 `@zcode/shared` 的 `redactTelemetryText`，与 CLI
[`error-sanitizer`](../trace/cli-agent-telemetry.md) 保持同一套模式；新增自动采集器或新增
携带自由文本的字段时必须同步扩展本节与该实现。

## 初始化位置与顺序

1. `desktopEarlyDataBaseDirBootstrap`（`dataBaseDir`）
2. `appCrashCaptureBootstrap`（`crashDumps` + 本地 archive）
3. `appARMSBootstrap`：模块加载时**启动** `armsRum.init()`，导出 `armsInitPromise`
4. `app.whenReady()` 内、**创建主窗口之前** `await armsInitPromise`
5. Renderer：由主进程 `autoInject` + `browserCollectors` 在 `dom-ready` 注入并 `RumSDK.init`（无 preload/renderer 手动 init）

`init()` 必须在 `app.ready` 之前被调用（side-effect import 链保证）；同时必须 **await** 完成后再开首窗。`browserCollectors` 仅作用于注入到 renderer 的采集器；主进程 `collectors` 仍管 Electron 侧（crash、rpc 等）。

## 本地验证

1. 开发态启动 Desktop（`pnpm dev:desktop` 或等价命令）。
2. 打开主窗口并操作（切换页面、触发请求）。
3. 查看主进程日志：
   - 成功：`[arms] electron initialized env=local version=...`
   - 开发态每次上报前：`[arms] beforeReport batch=N perf=1 ... [view:perf, ...]`（`perf` 应 ≥1）
   - 失败：`[arms] electron init failed:`
4. 等待约 1–2 分钟，在 ARMS 控制台 **用户体验监控 > 应用列表** 查看；开发构建上报环境为 **`local`**，筛选勿只选 `prod`。

## 控制台仍无数据时排查

| 现象                                                                | 可能原因                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 无 `electron initialized` 日志                                      | `init` 抛错（endpoint 错误、网络拉远程配置失败等）                                                            |
| 有 initialized 但无 `beforeReport`                                  | 会话未采样（须 `sessionConfig.sampleRate: 1`）、或渲染进程未产生事件                                          |
| 有 `beforeReport` 但 `perf=0`（有 `view:webvitals` 无 `view:perf`） | `autoInject` 晚于 `load`，perf-collector 未 `sendPerf`；主窗口 `scheduleArmsBrowserPerfLoadNudge` 补发 `load` |
| 有 `beforeReport` 控制台仍无数据                                    | 控制台环境筛成 `prod`、地域与应用不一致、内网无法访问 `*.aliyuncs.com`                                        |
| `[RUM] Invalid bundle received from renderer, dropped`              | SDK 上报 events[]；ARMS frame preload 闭包绕过 ipc 补丁；须 preload 同步 `patchArmsEventBridgeSend`           |
| Renderer 控制台 `[RUM] ArmsEventBridge is not available`            | 首窗早于 init 完成（应已通过 `await armsInitPromise` 修复）                                                   |

## SourceMap

生产构建使用 hidden sourcemap。未接入 `@arms/rum-vite-plugin` 自动上传；需要时在 ARMS 控制台按应用 ID `arms-id-placeholder` 与根 `package.json` 的 `version` 手动上传。

## Sentry 移除影响

Desktop Sentry 已移除，Renderer/main 崩溃与 JS 错误由 ARMS 承接。Host utility 与 Web 远控 RUM 不在此链路内；CLI Agent 仅通过 desktop main 的自定义稳定性事件上报非预期退出和 spawn error，不由 Electron crash collector 自动采集。

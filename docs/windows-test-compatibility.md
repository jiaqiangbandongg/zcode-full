# Windows 单元测试兼容规范（spec）

## 背景

Windows 开发机上 `pnpm test` 曾大面积失败（56 文件 / 161 用例）并间歇性以
`0xC0000005`（ACCESS_VIOLATION）崩溃退出。逐用例定性后约 97% 是 Windows 环境兼容
问题，分 8 类根因；本规范记录每类根因的修复方式与今后写测试必须遵守的规则。
分支：`fix/windows-unit-test-compat`。

## rebase 后状态（2026-08-24，基线 origin/staging c8c15b8d02）

rebase 到最新 staging 后全量单测 **9 失败 / 12444 通过**，无崩溃。剩余构成：

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| Windows 进程树回收残余 | 3 | `zcodeAgentProcessManager`；lifecycle fixtures 工作已把该项从 8 修到 3 |
| staging 存量漂移（任何平台都挂） | 3 | settings MCP/skill/subagent scope badge 的 `formatCanonicalPluginName` 断言；`a9263f3d03` 从列表组件移除该调用但未同步测试，需业务定性 |
| 跨平台漂移 | 2 | `feedbackHttpClient`、`stdioDesktopPresentationSurface`（见下） |
| flaky（负载超时） | 1 | `appUsagePanel`，单独运行通过 |

rebase 附带处理：staging 的 CUA 单包合并（broker 51 文件并入 `@zcode/zcode-cua`）
移除了 `launchSocketPath` / `reservedTransport`（rendezvous `.pending` 让渡机制），
本地 windowsCuaDevHelperHost / node.ts 与相关测试已对齐新 API（Windows named pipe
无 fs 让渡语义，socketPath 即唯一事实源；caller_timeout 一律 warming up fail-closed）。

## 环境事实（先读这一节）

| 事实 | 影响 |
| --- | --- |
| 仓库 `core.autocrlf=true`，工作区文本为 CRLF | 所有"读源码断言片段"的测试必须换行归一化 |
| Git Bash 把 `/usr/bin`（GNU tar 1.35）注入 PATH 最前 | GNU tar 把归档参数里的 `C:` 当远程主机；`zip`/`ditto` 等 macOS/Linux 命令缺失 |
| Windows 真实用户 PATH 中 System32 靠前（bsdtar） | 产品在用户机上用的是 bsdtar；测试环境需在 vitest.setup.ts 恢复同序 |
| NTFS 不保留 POSIX exec 位（0o111 恒 0） | exec 位断言仅在 POSIX 宿主生效 |
| Windows 无法删除任何进程 cwd 所在目录；持打开句柄期间 rename 同一目标 EPERM | 子进程生命周期类测试的 teardown 顺序有硬约束 |
| `node:fs` globSync 在 Windows 返回反斜杠路径 | glob 结果必须归一化后再做前缀过滤 |
| 产品 control endpoint 在 Windows 使用 `\\\\.\\pipe\\...` named pipe | IPC 测试必须按平台构造 endpoint，禁止因 POSIX socket fixture 在 Windows 报 EACCES 而跳过产品链路 |

## 已修复的 8 类根因与规则

1. **CRLF（16 用例 / 12 文件）**：新增 `packages/{ui,desktop}/test/readSourceText.ts`
   （读取后 `\r\n → \n`）。规则：契约测试读源码一律走 `readSourceText` /
   `readSourceTextAsync`，禁止裸 `readFileSync + toContain(多行片段)`。
2. **fixture 注入 Windows 路径产生非法 JSON（7 用例）**：占位符替换必须连引号一起
   换成 `JSON.stringify(path)` 的产物，禁止把裸路径 `replaceAll` 进 JSON 字符串。
3. **GNU tar / zip / ditto（21 用例）**：
   - vitest.setup.ts 把 System32 前置到 PATH（Windows 且 System32 有 tar.exe 时）；
   - 产品 `stageRelease` 在 Windows 用 `tar -a` 写 zip（**真实产品 bug 修复**，
     Windows 本机没有 `zip` 命令）；POSIX 宿主保留 `zip`；
   - 测试造 zip fixture 在 Windows 用 `tar -acf`；依赖 `ditto` 的用例 win32 skip。
4. **Unix socket / macOS 专属链路（约 50 用例）**：CUA 权限代理是 macOS/Linux 专属
   （.app / LaunchServices / codesign / ps+SIGTERM），相关 describe/it 用
   `describe.skipIf(process.platform === "win32")` 并注明原因；平台无关的纯逻辑
   组保留运行。ZCode Server control channel 不属于此类：Windows 产品实现使用 named
   pipe，测试必须用 `resolveServerLayout(...).controlEndpoint` 或等价的平台 endpoint
   helper 覆盖。规则：skip 必须写清"产品为什么不支持 Windows"，禁止无注释 skip。
5. **路径分隔符（约 20 用例）**：mock POSIX 风格输入的用例，期望值与产品同源构造
   （`join` / `resolve` / `path.delimiter`），验证拼接语义而非分隔符字形。
   例外：产品硬编码的 POSIX 字面量（如 flatpak 导出路径）期望保持字面量。
6. **exec 位断言（3 处）**：`if (process.platform !== "win32")` 包裹。
7. **pdfjs cMapUrl（1 用例，兼 0xC0000005 可疑源头）**：Node factory 用 fs.readFile
   读取 cMapUrl 拼接路径；跨平台唯一可行形态是"正斜杠 fs 路径 + /"。
   `file://` URL 与反斜杠路径均不可用（已实测）。
8. **teardown EPERM**：测试 teardown 的 rm 加 `maxRetries/retryDelay`（Node 官方
   Windows 文件锁机制）。注意：**retry 救不了长持句柄**（见下）。

## 已知未修复（需专项，勿盲目兜底）

### Windows 进程树回收不彻底（当前最大剩余失败源）

现象：`zcodeAgentProcessManager`（8 用例）报
`runtime process tree cleanup incomplete; remaining pid=...`；其衍生效应使
`zcodeAgentService(.v4)` / `localServicesRemoteAuthority` / `daemonRegistration`
（约 32 用例）在 afterEach 删除 temp 目录时 EPERM——**agent 子进程未完全退出时
cwd 占用目录，Windows 无法删除任何进程的 cwd 目录**（已用最小 repro 验证：
进程活着 → EPERM 恒失败；退出后 → 删除成功）。

`processTreeTerminator.ts` 的 Windows 分支（taskkill /T /F + fail-closed 身份验证）
设计语义需完整调查后再动；禁止用"删目录前无脑 sleep"或"跳过身份验证"之类兜底。
排查入口：`cleanupManagedProcessForShutdown` → `forceTerminateWindowsProcessTree`
→ `processTreeWaiter` 的残留上报，抓 taskkill 实际输出与退出时序。

### 产品设计缺口：Project Memory 稳定读 vs Windows rename

`projectMemoryStableRead` 的前提"读取方持 O_RDONLY 句柄、并发方原子 rename 更新"
在 Windows 不成立：持打开句柄期间 rename 同一目标必然 EPERM（最小 repro 已验证）。
测试侧已改为"先 rename 后 open"的双平台一致顺序，但**产品在 Windows 真实并发场景
仍会遇到**；需要设计 Windows 分支（如 rename 失败退化为 copy+truncate，或写入侧
retry）。修完恢复原 mock 顺序作为回归。

### 3 个跨平台真实失败（非 Windows 问题，需业务定性）

- `stdioDesktopPresentationSurface`：期望装配传 `presentationSurface: "desktop"`，
  `packages/server/src` 无该字段（services 层有）；
- `feedbackHttpClient`：ZCODE_ENV=test 期望 base `zcode.z.ai`，实际 `zcode.z.ai`；
- `useCodingPlanQuotaResetUi`：mock 收到 `builtin:personal-granted`，期望 `builtin:team`。

### 间歇性 0xC0000005

全量跑时 vitest worker 偶发原生崩溃（本轮复现一次于 pdfjs CMap 用例修复前）。
pdfjs 修复后未再复现，但未定论；若复现，优先排查该用例与 native 模块加载顺序。

## 安全备注

（历史记录）`changelogAiClient` 失败时 vitest 会把完整真实环境变量（含 API key、
JWT）打进测试输出；该测试已随 staging `b232f93ab1` 移除自定义 changelog 管线一并
删除，但"vitest 断言失败会整对象打印 mock 参数"的行为仍在——任何断言 spawn
options 的测试都应避免把真实 env 塞进可 diff 对象。本地调试日志须及时清理，
泄露过的凭据建议轮换。

## Rebase 后新增回归约束（2026-08-21）

- JSON 格式的 Windows service descriptor 必须先 `JSON.parse` 再断言字段，禁止对
  序列化文本直接匹配原始反斜杠路径。
- 测试临时路径必须用 `join` 构造；fixture 中的 PATH 必须用 `path.delimiter` 构造。
- macOS CUA 测试分为两类：可注入平台的纯逻辑测试显式传 `platform: "darwin"`；
  依赖真实 Darwin native ABI 的测试组在 Windows 显式 skip，平台无关策略测试继续运行。
- Repo Wiki JSON 状态必须走共享原子写入工具，避免 cancel/generate 并发读到半截 JSON。
- Coding Plan history/read 去重必须包含 provider/organization/project scope，禁止只用
  `usedAt`，否则同一时间戳会让不同套餐互相吞掉上报。
- 测试通过 timer 模拟后台生命周期写入时，必须持有并在 teardown 前等待该 Promise；
  临时文件名必须唯一，禁止 fire-and-forget 写入固定 `.test.tmp`。
- “持有只读句柄时 rename 覆盖目标文件”的原子替换场景只在 POSIX 成立；Windows
  会按文件共享模式返回 `EPERM`，此类 POSIX 语义测试必须显式隔离，不能伪装成跨平台契约。

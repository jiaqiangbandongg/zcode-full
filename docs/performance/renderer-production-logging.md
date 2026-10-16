# Renderer 生产日志策略

## 背景

Renderer 层运行在桌面窗口和 Web 远控页面内，日志调用会和 React 渲染、消息流处理、远控恢复链路抢主线程时间。历史上 UI 日志统一写 console，并在桌面端通过 `window.zcode.log` 转发到 main 进程落盘；当会话流、工具调用、任务快照和远控同步变多时，这些同步格式化、IPC 转发和文件写入会放大生产版本的性能成本。

## 目标

- 生产构建里的 renderer 本地日志默认不输出。
- 生产构建里的 UI 日志不再通过 `window.zcode.log` 转发到 main 进程落盘。
- 开发构建继续保留 renderer console 和桌面日志桥，方便本地排查。
- 正式监控链路不属于本策略的关闭范围，例如 ARMS、telemetry、crash capture、用户主动导出日志、服务层和 host/main 进程日志。

## 环境边界

日志开关以 Vite 构建态 `import.meta.env.PROD` 为准，而不是 `ZCODE_ENV`。原因是 `ZCODE_ENV=production` 只表示连接生产产品环境；`dev:desktop:prod` 仍是本地开发运行态，仍需要 renderer 日志辅助调试。只有真实生产构建才应让 renderer 本地日志 no-op。测试或诊断场景可以通过 `globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ === true` 强制关闭 renderer 日志；该开关只能额外关闭日志，不能在生产构建中重新打开日志。

## 实现约束

- `packages/ui/src/logger.ts` 是 UI 层唯一日志入口；生产构建中 `debug` / `info` / `warn` / `error` / `trace` 都直接返回，不写 console、不转发桌面 bridge。
- `packages/client` 中面向 renderer 的连接日志必须遵循同一生产构建边界，避免绕过 UI logger。
- 唯一例外是 `logger.logMemoryDiagnostics`：它是 [进程内存本地诊断日志](../monitoring/memory-diagnostics-log.md) 的正式监控出口，最多每 60 秒一行、有变化才写，生产构建仍经桌面桥落盘；Web 端无桥时 no-op。其他模块不得借用它输出业务日志。
- 桌面和 Web renderer 入口里的 console 调试输出只允许在非生产构建执行。
- Web 远控 relay trace 继续保持开发态限定；高频消息日志不得进入生产 renderer。

## 验证

- 单测覆盖开发构建会输出、生产构建不输出。
- 运行 `pnpm typecheck`。
- 运行 `pnpm lint`。

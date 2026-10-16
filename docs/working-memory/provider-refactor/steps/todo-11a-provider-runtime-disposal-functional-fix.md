# 11A Provider Runtime 完整释放功能性修复

> 状态：已完成
>
> 日期：2026-08-25
>
> 任务性质：[`Todo 11`](./todo-11-provider-runtime-composition-boundary-cleanup.md) 审查中发现的功能性修复
>
> 关联设计：[`../design/registry/runtime.md`](../design/registry/runtime.md)

## 0. 任务定位

本文只修复 Agent Protocol 进程没有释放完整 Provider 进程资源的问题。它是 Todo 11 审查发现的功能性缺陷，
但不依赖 Todo 11 对 Runtime 组合边界、命名和公共 API 的后续裁决，可以单独实施。

本任务不是用临时兜底掩盖架构问题。“临时”的含义是：在 Todo 11 整体搁置期间，先恢复当前既有生命周期对象
已经声明的完整释放语义；未来 Todo 11 若重组组合根，再由新的最外层 owner 继续承担同一释放责任。

## 1. 已确认问题

`startProcessProviderRegistryRuntime()` 返回的最外层结果拥有以下资源：

```text
Process Provider Registry Runtime
|- Credential Store subscription（仅 Standalone Prompt/TUI）
|- Model Selection Config Repository
|  `- Node fs.watch
`- Node Provider Registry Runtime
   |- Provider Registry Service
   `- Provider Config watchers/repositories
```

外层 `dispose()` 会按所有权释放全部资源；内层 `runtime.dispose()` 只释放 Registry 与 Provider Config 资源。

当前入口行为不一致：

| 入口           | 当前释放调用                                     | 结果                            |
| -------------- | ------------------------------------------------ | ------------------------------- |
| Prompt CLI     | 外层 `providerRegistryRuntime.dispose()`         | 完整                            |
| TUI            | 外层 `providerRegistryRuntime.dispose()`         | 完整                            |
| Protocol Agent | 内层 `providerRegistryRuntime.runtime.dispose()` | 遗漏 Model Selection Repository |

Protocol Agent 的正常启动环境会提供 Model Selection Config 文件路径。Repository 首次 `read()` 后创建持久
`fs.watch`；只释放内层 Runtime 不会关闭该 watcher。

因此当前退出链路实际是：

```text
Protocol transport 关闭
        |
        v
Protocol finally 清理内层 Registry/Config
        |
        v
Model Selection fs.watch 仍存活
        |
        v
Node event loop 无法自然耗尽
        |
        v
CLI exit watchdog 到期后强制 process.exit
```

这不会改变模型选择结果或损坏配置，但会把正常 Protocol Agent 退出错误地变成依赖 watchdog 的强制退出。

## 2. 修复目标

1. Protocol Agent 退出时调用 `startProcessProviderRegistryRuntime()` 返回结果的最外层 `dispose()`；
2. 一次调用同时释放 Model Selection Repository、Registry 与 Config 文件资源；
3. 保持 Prompt CLI、TUI 和 Host 现有生命周期行为不变；
4. 退出后不再由本任务涉及的 Model Selection watcher 阻止事件循环自然耗尽；
5. 测试以最外层 owner 为释放入口，不再通过手工分别释放 Repository 和内层 Runtime 掩盖所有权错误。

## 3. 实施要点

### 3.1 先补失败测试

- 为 Process Provider Registry Runtime 增加组合释放测试，证明外层 `dispose()` 会释放 Model Selection
  Repository，并继续释放内层 Registry/Config；
- 为 Protocol Agent cleanup 增加断言，证明 finally 调用的是完整 owner 的 `dispose()`，而不是只释放其
  `runtime` 成员；
- 将现有测试中的 `modelSelectionConfigRepository.dispose()` + `runtime.dispose()` 手工组合改为外层
  `dispose()`，让测试遵守生产所有权契约；
- 测试不应依赖 CLI 的一秒 exit watchdog 来判定清理成功。

### 3.2 修正 Protocol 清理入口

把 Protocol Agent finally 中的内层释放：

```ts
providerRegistryRuntime?.runtime.dispose();
```

改为最外层 owner 释放：

```ts
providerRegistryRuntime?.dispose();
```

继续通过现有 `runProtocolCleanupStep` 执行，确保单项失败不会跳过后续 Telemetry shutdown，也不覆盖原始错误。

### 3.3 保持现有释放顺序

本次不重新设计外层 `dispose()`。维持当前顺序：

1. 停止接收新的 Standalone Credential 变化；
2. 关闭 Model Selection Repository watcher；
3. 释放 Registry 与 Provider Config 资源。

Protocol 入口当前不创建 Standalone Credential subscription，因此本次已确认的实际泄漏只有 Model Selection
watcher；调用完整 owner 同时保证未来新增外层资源时不会再次被 Protocol 绕过。

## 4. 非目标

- 不执行 Todo 11 候选的 Runtime 扁平化、改名或组合根重构；
- 不删除 `NodeProviderConfigRuntime`、`NodeProviderRegistryRuntime` 或 Services Runtime；
- 不裁决 Node Config resources 的最终公共 API；
- 不改变 Host 与 Agent 各自维护进程内 Registry 的现状；
- 不改变 Model Selection 的读取、保存、同步和默认值语义；
- 不调整 CLI exit watchdog；watchdog 继续作为未知残留句柄的最后兜底，不能替代资源 owner 的正常释放；
- 不扩展处理 Standalone Credential refresh 已经开始后与 shutdown 并发的有限异步窗口，除非实施测试证明其形成
  独立的功能性故障。

## 5. 验收标准

- Protocol Agent finally 只调用 Process Provider Registry Runtime 的最外层 `dispose()`；
- 配置了 Model Selection 文件路径并执行过 `read()` 后，完整 dispose 会关闭对应 watcher；
- dispose 后 Model Selection Repository 不再可读写，内层 Registry/Config 同样已释放；
- Prompt CLI 与 TUI 的现有外层释放行为保持不变；
- cleanup 中某个其他资源失败时，Provider 完整释放与 Telemetry shutdown 仍按现有旁路规则执行；
- 相关单元测试通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 通过；
- 完成后提交 Conventional Commit。

## 6. 实施结果

- Protocol cleanup 已改为释放 `startProcessProviderRegistryRuntime()` 返回的完整 owner，不再绕过
  Model Selection Repository；
- 生命周期测试包裹真实 Process Runtime，分别观测外层与内层 dispose，证明 Protocol 只调用外层 owner；
- 组合测试证明完整 dispose 后 Model Selection Repository 与 Node Provider Registry Runtime 均拒绝再次使用；
- 现有测试中的手工 `repository.dispose() + runtime.dispose()` 已统一为 owner dispose；
- Review 同时发现 Standalone CLI importer 仍引用 Todo 35 已删除的 Effective→Personal projection，现已同步按
  Todo 35 收口并补齐独立测试，避免真实 CLI legacy 迁移静默变为空配置；
- Bootstrap 定向测试 27 条、Bootstrap typecheck、根 lint、目标文件格式检查与 `git diff --check` 均通过。

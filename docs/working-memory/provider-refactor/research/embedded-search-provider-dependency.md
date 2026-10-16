# Embedded Search 与 Provider 依赖调研

> 状态：调研完成；尚未修改生产代码
> 日期：2026-08-10
> 对应阶段设计：[`../steps/01-model-and-request.md`](../steps/01-model-and-request.md)

## 结论

Embedded Search 是 Environment 提供的工具能力，与 Model Provider 无关。当前代码虽然通过 `ModelConnectionPort` 解析模型连接，但分支结果只取决于功能开关和 Bash 是否可用。Provider 依赖可以移除，不需要转移到新的 `Model` 接口。

目标入口可以收敛为：

```ts
resolveEmbeddedSearchBranchCapability({
  bashAvailable,
  embeddedSearchBranchEnabled,
})
```

## 代码事实

`resolveEmbeddedSearchBranchCapability()` 当前接收 Bash 状态、shell selection、model ref 和 `ModelConnectionPort`。函数会解析 Connection，并把 model、provider kind、base URL 与移除凭据后的 Connection 放进 decision context。

真正决定结果的只有：

```text
embedded-search feature flag
             +
       Bash available
             |
             v
 useEmbeddedSearchBranch
```

model ref、provider kind、base URL、Provider options 和 shell selection 都没有参与判断。Connection 解析失败时，函数仍返回相同结果。

这个结果被三个位置使用：

```text
主 Runtime tool exposure
└─ 决定是否隐藏 direct Glob / Grep

Tool executor
└─ 写入 embeddedSearch.enabled

Subagent Runtime
└─ 决定 child tool surface
```

三个调用方最终都只读取 `useEmbeddedSearchBranch`。

判断函数位于 `apps/zcode-cli/packages/core/src/embedded-search/capability.ts`；三处调用分别位于 `runtime/methods/embedded-search-branch.ts`、`tool/executor/call-runner.ts` 和 `runtime/methods/subagent.ts`。

现有测试要求保留部分 Provider context，理由是未来可能按模型分支；历史设计也明确写过 first-party 当前固定启用，不按 provider、source 或 variant 区分。这些内容证明 Provider Connection 是预留信息，不是当前行为依赖。

## 清理边界

实现时需要同步修改 capability 输入类型、主 Runtime、Tool executor、Subagent 调用点和相关测试。Shell 是否支持 prelude 注入继续由 execution/adapter 层判断，不影响 Agent 看到的 embedded tool surface。

这项清理没有 UI、持久化或协议变化，也不依赖新的 `Model` 接口落地。必须保持的行为是：功能开关开启且 Bash 可用时隐藏 direct Glob/Grep；Bash 不可用或开关关闭时继续暴露 direct tools。

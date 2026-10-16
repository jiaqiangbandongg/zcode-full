# Task Restore Model List Fallback Design

## Background

历史 task 的持久化模型可能已经不在当前可用模型中。上一版恢复逻辑在
`useTaskRestore` 中用 provider snapshot 的第一项作为自动 fallback，但 provider
snapshot 是底层 registry 视角，不等同于用户模型下拉列表，也不一定能被 host
runtime 接受。

实际日志中出现过：UI 选择 `builtin:bigmodel/GLM-5.2` 作为 provider snapshot
fallback，但 host 认为该 session 模型不可用；而工具栏仍回显历史
`builtin:bigmodel/GLM-5.1`。

## Goal

当历史 task 模型被确认不可用时，自动切换应复用模型列表中的第一个可选模型，
也就是用户当前能在工具栏下拉中看到并选择的第一项。

## Design

- task restore 解析层只判断 task-local 模型是否可用，不再自己从 provider
  snapshot 挑 fallback 模型。
- task restore / send 解析层在确认历史模型不可用且没有显式可见模型
  fallback 时，不再把旧模型作为 resume hint 传给 runtime。
- 工具栏模型自动定位恢复为 active task 可用：当前模型不在 `modelSelectGroups`
  时，无论它来自原生模型还是 custom provider，都使用
  `modelSelectGroups[0].items[0].value` 作为 fallback。
- 自动切换走现有 `handleModelValueChange` 链路，保持 UI 选择、provider 同步、
  task config 和 runtime hint 的语义一致。
- 如果模型列表没有任何可选模型，则不自动 fallback，保留现有不可用提示。

## Non-Goals

- 不引入新的 host RPC 来查询 runtime 第一可用模型。
- 不在 task restore lib 中依赖 toolbar 组件。
- 不改变用户手动切换模型的行为。

## Verification

- 单测覆盖 active task 当前模型不可用时会回落到模型列表第一项。
- 单测覆盖 task restore 确认模型不可用时不再使用 provider snapshot 第一项。
- 运行相关 vitest、`pnpm typecheck`、`pnpm lint`。

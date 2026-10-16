# Explore 工具分组阶段状态

## 发布状态

功能当前用户设置默认开启。Settings 中的“分组探索工具”持久化为应用级
`toolGroupingExploreEnabled`；缺失时由 `ENABLE_EXPLORE_TOOL_CALL_GROUPING=true` 兜底。关闭时
Read/Search 及只读 Shell 保持原始独立工具行，工具分类、生命周期、协议和 session 持久化均不改变。

## Feature Summary

| Field                 | Value                                                                               |
| --------------------- | ----------------------------------------------------------------------------------- |
| Change                | Explore 父分组从“子工具状态聚合”改为“可见阶段边界 + 当前 work segment 状态”         |
| User-visible surfaces | 桌面 `desktop-continuous`、普通 Web、手机 `/remote` 的共享 v4 conversation renderer |
| State owner           | V4 projection 持有原始 rows 和 turn header；renderer 只派生 Explore 父级展示状态    |
| Out of scope          | 不修改子工具状态、Execute 状态、协议、runtime、snapshot、replay 或持久化            |

## Problem

单个只读工具保持原始工具行；第二个连续只读工具到达后才建立 Explore 父分组。父分组建立后，若当前
children 都已完成、下一次只读工具尚未出现，旧实现会短暂从“探索中”跳成“已完成”，随后又回到
“探索中”。Explore 表达模型的一段探查阶段，父级不应把子工具之间的模型间隔误判为阶段结束。

```text
Read completed
     |
     +-- work segment still running + no visible boundary --> Explore in_progress
     |
     `-- visible non-Explore boundary / segment terminal ----> Explore completed
```

## Boundary Decisions

| Boundary         | Decision                                                                   | Includes                                                        | Excludes / prunes                       |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Group threshold  | 至少两个连续 Explore-compatible rows 才创建父分组；单项保持原始工具行      | Read/Search/readonly Shell 的连续组合                           | 只有一个 child 的空壳父组               |
| Running          | Explore 位于当前可见 work chunk 尾部，且该 chunk 仍是运行中 segment 的尾部 | children 全部 completed 的模型间隔                              | 不要求任一 child running                |
| Completed        | Explore 后出现任一可见非 Explore row，或 segment 已终态                    | Execute、Write/Edit、Agent/Todo、assistant text、可见 reasoning | 隐藏的非首 reasoning 不构成边界         |
| Child lifecycle  | 每个 child 继续展示自己的 pending/running/success/error/cancelled          | 失败详情、审批、输出                                            | child 状态不再决定 Explore 父级 running |
| Stopped fallback | terminal Explore children 含 cancelled 时父级可显示 stopped                | 没有运行中的 segment                                            | 不新增独立 turn-stop 协议字段           |
| Execute symmetry | Execute 使用同一可见阶段边界派生父状态                                     | running 尾部、可见边界、segment 终态                            | 工具分类与摘要仍各自独立                |

## State And Event Flow

```text
visible assistant work rows
          |
          v
collect consecutive Explore rows
          |
          +-- next visible row is non-Explore ------> completed
          |
          +-- group is chunk tail, but a later flow
          |   item/text ends the visual stage ------> completed
          |
          +-- group is true segment tail
          |   && segment state is running ----------> in_progress
          |
          `-- segment terminal ---------------------> completed/stopped
```

调用方必须显式告诉 row builder 当前 chunk 是否是“仍运行的真实 segment 尾部”。只传
`segment.workStatus.state === running` 不够，因为 assistant history chunk 后面可能已有 assistant text、
following rows 或其他 flow item。

## Accepted Cases

| Case ID | Setup                                                       | Action           | Assertions                                                                | Evidence         | Status       |
| ------- | ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- | ---------------- | ------------ |
| ETS01   | 两个连续 completed Read 位于运行中 segment 的真实尾部       | 构建 work items  | 第二项到达后创建 Explore，父级保持 in_progress                            | UI unit          | covered-unit |
| ETS02   | Explore 后出现 Execute/Write/其他可见工具                   | 构建 work items  | 前一个 Explore completed                                                  | UI unit          | covered-unit |
| ETS03   | Explore 后出现 assistant text 或可见 reasoning              | 构建 flow/chunk  | Explore completed                                                         | UI unit          | covered-unit |
| ETS04   | Explore children 间只有隐藏的非首 reasoning，segment 仍运行 | 关闭 reasoning   | Explore 仍聚合并保持 in_progress                                          | UI unit          | covered-unit |
| ETS05   | child 仍 running，但后面已经出现非 Explore 边界             | 构建 work items  | Explore 父 completed；child 自身仍 running                                | UI unit          | covered-unit |
| ETS06   | Explore 位于已终态 segment 尾部                             | cold/live render | 父 completed；有 cancelled child 时 stopped                               | UI unit          | covered-unit |
| ETS07   | Execute children running/completed                          | 同次改动回归     | Execute 使用相同阶段边界，分类与详情仍保持独立                            | UI unit          | covered-unit |
| ETS08   | desktop/replayable 得到相同 rows 和 segment terminal fact   | renderer 构建    | 相同 Explore 父状态；不改变 delivery/recovery                             | shared invariant | partial      |
| ETS09   | Explore 后收到 command 尚未到达的运行中 Shell row           | 流式补全 command | 未分类阶段完全透明；readonly 并入原 Explore；execute 出现后才结束 Explore | UI unit          | covered-unit |

## Pruning Decisions

| Decision ID | Pruned combinations            | Guard/invariant                              | Representative coverage       |
| ----------- | ------------------------------ | -------------------------------------------- | ----------------------------- |
| ETS-P01     | Shell/Read/Search 工具名全排列 | 既有 `isExploreToolCall` 负责分类            | Read + readonly Bash 代表     |
| ETS-P02     | theme/locale/OS/workspace 类型 | 状态派生无文案、主题或平台分支               | focused UI unit               |
| ETS-P03     | continuous/replayable 网络排列 | 使用已投影 rows/turn facts，不修改 transport | shared renderer + 既有 STIP03 |
| ETS-P04     | Execute 工具类型与状态全排列   | Execute 复用阶段边界函数，分类/摘要独立验证  | Execute representative unit   |

## E2E Handoff

- 第一版使用 deterministic row/chunk builder focused tests。
- 正式 E2E 可用 controlled stream：先连续完成 Read 与 Grep 建立 Explore，再延迟第三条只读工具，
  断言间隔内 Explore 不显示 completed；再发非 Explore Bash，断言 Explore 收口。
- 手机真实 gap/snapshot 继续由既有 replayable case 证明，不用 desktop fixture 替代。

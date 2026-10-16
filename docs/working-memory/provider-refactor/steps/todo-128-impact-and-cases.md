# Todo128 影响面与验收边界

## Feature Summary

| Field | Value |
| --- | --- |
| Intent / capability | 启动只表示就绪；闲时资格读取当前 Registry 并串行刷新 |
| Change layer / mode | validation、option-source；planning |
| Seeds | ProviderRuntime、NodeProviderConfigRuntime、NodeProviderRegistryRuntime、ProviderRegistryService、offPeakTaskStore |
| Existing docs | Todo128、docs/off-peak-task/spec.md |
| Out of scope | Composer、持久化、账号同步重构、闲时远程支持、实际取号规则 |

## UI Surface Matrix

| Scenario / entry | Shared implementation | Display/draft | Default | Guard | Commit / authority | Mode / isolation |
| --- | --- | --- | --- | --- | --- | --- |
| Automations 创建入口 | Store + Provider Settings 完成通知 | Store 资格；表单草稿独立 | 无资格默认 | 当前连接支持且额度 ready | getCodingPlanSupport → getTakeNumberAvailability；Host Registry/服务端 | 仅既有桌面本地范围；不影响定时任务 |
| OffPeakNewTaskEntry | 同一 Store/刷新 Hook | 横幅及导航草稿 | 现有模板 | 导航使用任意套餐；不替代创建校验 | 仅导航，不取号 | 当前未挂载，不借修复重新开放入口 |

## Shared And Divergent Behavior

| Concern | Shared | Different / reason |
| --- | --- | --- |
| UI / option source | 最新已完成 Provider 事实 | 不调整布局；首页和创建门禁不同 |
| Default / validation | 未确认不放行；资格与额度同代 | 首页导航不等于取号 |
| Commit / persistence | 无新缓存、无数据库修改 | 实际取号仍由 Host 服务端验证；不改变 Ticket 绑定 |

## Feature Relationships

| Rank | Edge | Why / evidence |
| --- | --- | --- |
| must-inspect | start → 闲时凭据解析 | node.ts 当前消费首次 Promise 的旧快照 |
| must-inspect | Registry → ProviderSettings.onDidChange → 闲时重查 | Facade 的 View 通知基于已发布快照 |
| must-inspect | 页面初始化/连接变化/手动刷新 → Store | 当前三处并发且可能拼接资格额度 |
| should-inspect | Node 启动 → Protocol 启动日志 | 返回值改 void 后显式读取一次快照 |
| invariant-only | 创建/派发/鉴权 | 同一凭据解析闭包；不放宽资格 |
| invariant-only | Web shared-host / workspace identity | 不新增 Host、不改 continuous/replayable |

## State Owners And Commit Sinks

| Fact | Owner | Mirror / sink |
| --- | --- | --- |
| 当前模型资格 | Registry | Store 只保存脱敏支持结果 |
| 取号额度 | 服务端 | Store 同代结果；非持久化 |
| 启动就绪 | Runtime 生命周期 Promise<void> | 不充当数据缓存 |
| 连接选择 | Settings | UI 只比对，不写回或回退连接 |

## Must-Preserve Invariants

启动去重、失败后可重试、dispose、后台刷新不变。API Key 和账号模型资格不放宽。资格/额度只有最新一代可一起发布；旧成功、失败、finally 不开门。未知状态禁入。发送与同步不新绑等待。

## Codegraph Evidence

本环境没有 Codegraph 工具，未执行 Codegraph 扫描；使用 dep:refs 的 ProviderRegistryService 引用报告（/tmp/provider128-refs.log）及精确 rg 调用检查替代。深度 2：Runtime→消费闭包→闲时服务；Store→两入口→创建门禁。不得把静态命中写成运行验证。

## Graph Drift Candidates

图中“Provider 无 enabled”、旧套餐模型清单已过时，由对应 Todo 独立承接，不借本次扩大修改。只补确认的启动/闲时刷新关系。

## Graph Delta

confirmed：Provider Registry 和闲时 Store 节点增加生命周期/资格同代约束，以及已完成通知边；依据 Todo128 已确认裁决。

## Unresolved Questions

无新产品裁决。Air 实机可用性仅为验证前置，不阻塞独立开发，不把未测算通过。

## Planning Handoff

规格以 Todo128 §2–5 和本页为准；下面是合并后的用例目录、覆盖矩阵、裁决表。UI 用例进入 pending 回归，共享真实 Store/Hook，服务端受控；最终实机另记。

## Clarification Log / Boundary Decisions

用户已确认：四个 start 返回 void；统一闲时资格刷新；不动 Composer/同步/资格规则。因此不重复提问。

## Domain Scope / High-Risk Cross-Products

Provider 生命周期、闲时 validation 两域。重点：首次未就绪 × 账号后到；连接切换 × 旧资格/额度/错误晚到；双入口 × 同一通知。排除全端全账号笛卡尔积。

## Concept Map / State Owners / Dimensions

start 是就绪，不是最新业务数据；Registry 是事实；Store 是显示。状态轴：未初始化/检查中/ready/error，事件轴：初始化/已完成通知/连接变化/手动刷新；旧请求可在资格或额度阶段结束。Owner 见上表。

## Candidate Combinations / Accepted Cases

| ID | Setup → action | Assertions | Evidence / E2E |
| --- | --- | --- | --- |
| S1 | 四 Runtime 并发启动；修改 Personal 后再次 start | void；读取接口最新；资源不重复 | 单测 |
| S2 | 启动失败/释放 | 保留原重试/释放边界 | 既有测试 + 类型 |
| Q1 | 冷启动无套餐 → Registry Team 就绪通知 | 无需重开页面，支持与额度一次更新 | Store + pending UI |
| Q2 | 旧 support/额度在途 → 连接变更 | 串行合并重查；旧成功/错误不覆盖；无中间 ready | Store |
| Q3 | 双入口同时初始化/收到同 revision | 共用检查，不重复并发取号查询 | Store + pending UI |
| Q4 | 手动刷新，资格由 false→true / true→false | 先资格再额度；失败不开放创建 | Store + pending UI |
| Q5 | 无灰度/无资格/额度错误 | 保持禁入；后续通知仍可恢复 | Store |

## Pruning Decisions / Questions For User

不运行真实取号、取消 Ticket 或改真实账号设置；用户未要求扩大该权限。手机闲时创建、Composer 提交属于排除项。无待确认问题。

## Matrix Backfill / E2E Handoff Notes

本页维护 S1–Q5 矩阵；Store 单测复用延迟 Promise，不靠 sleep；浏览器 pending 复用共享 Hook/Store 和受控服务事件。文件使用临时目录，Provider 网络不参与模拟。无需 replay provider fixture（本组不发模型请求）。Air 若不可连需如实留验证限制；不当作实现成功证据。

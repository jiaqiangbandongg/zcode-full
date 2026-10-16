# Usage Stats E2E Case Catalog

## 目标

本目录定义 `fix/usage-remaining-refresh` 分支新增或修改行为的 Desktop E2E 合同。覆盖范围包括
App Usage、个人/团队 Coding Plan、访问刷新、Context/Footer/Provider Settings 跨入口同步，
以及可由真实 renderer、host 和 CLI 链路稳定观察的错误恢复。

本文只把具有独立 setup、action、assertion 的场景计为覆盖。纯映射、日期数学、图表数据清洗
继续以 focused test 为主要证据；E2E coverage 报告只用于发现执行缺口，不替代行为断言。

## 状态维度与建议剪枝

| 维度                  | 值                                                          | 建议决定                                               | 原因                                               |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| 数据域                | App Usage / Coding Plan quota / activity / credit / health  | 全部纳入                                               | 分支同时修改 UI、service 和 CLI 聚合               |
| 套餐来源              | Z.AI 个人 / BigModel 个人 / BigModel Team                   | BigModel 个人和 Team 完整覆盖，Z.AI 做来源隔离代表样本 | 避免对共享 mapper 做品牌笛卡尔积                   |
| 入口                  | Usage / Context / Footer / Provider Settings                | 全部纳入                                               | 共享 access freshness 和 snapshot 是本分支核心合同 |
| 结果                  | success / empty / business error / network error / recovery | 全部纳入高价值路径                                     | 命中错误分类、缓存清理、force refresh              |
| range                 | today / 7d / 30d / all                                      | 每种语义至少一条；不与每个来源相乘                     | range 会改变请求和展示，但与品牌正交               |
| client                | desktop-continuous / web-remote-replayable                  | Desktop 完整；手机只保留 shared-host 不变量            | Usage 不进入 task replayable 状态                  |
| viewport/theme/locale | desktop / narrow；light / dark；zh / en                     | 每轴一条代表样本，不做全组合                           | 展示兼容性需要证据，但与数据源正交                 |
| timing                | fast / in-flight / freshness / retry                        | 全部纳入                                               | 并发与刷新策略是本分支高风险路径                   |

用户已确认 D1-D4，上述剪枝自 2026-08-17 起作为 accepted 规划边界。下表历史
`proposed` 状态统一提升为 `accepted`；只有实现并通过独立断言的 case 才能进一步标为
`covered`。

## App Usage

| Case                     | Setup                                                            | Action                            | Assertions                                                                         | Status       |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| US-AU-01 empty           | 隔离 HOME 中没有 usage facts                                     | 打开 Settings > Usage > App Usage | 全量摘要、Token Activity、趋势和模型分布显示确定空态，无远端套餐请求               | formal-green |
| US-AU-02 mixed history   | seed 多 session：新版 usage、旧 character fallback、跨日和多模型 | 打开 App Usage                    | 全量 Token、session、active days、最长 session、连续天数正确；旧数据不丢失且不重复 | formal-green |
| US-AU-03 range isolation | seed 超过 30 天的数据                                            | 切换 7d / 30d                     | 全量摘要和 52 周 activity 不变；趋势与模型分布只展示当前 range                     | formal-green |
| US-AU-04 activity modes  | seed 稀疏日期、跨月、零值周                                      | 切换每日/每周/累计并 hover        | 周日起始、52 周、月份标签、列高亮、两行 tooltip 与累计单调性正确                   | formal-green |
| US-AU-05 chart extremes  | seed 7 个以上模型、未知模型和极端 token                          | 查看趋势与模型饼图                | 空日期补零、首尾轴不裁切、Top 模型与“其他模型”聚合正确                             | formal-green |

## Coding Plan 数据与来源

| Case                                | Setup                                                              | Action                      | Assertions                                                                                                                                                                                                                        | Status                 |
| ----------------------------------- | ------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| US-CP-01 personal credit            | BigModel 个人套餐，quota + credit activity/detail/performance 成功 | 打开个人 Coding Plan        | remaining 百分比、KPI、stacked model bars、tool usage、health 均来自匹配接口；Peak tokens 正文不拼日期，悬停信息图标显示峰值日期；Token Activity hover 展示远端真实 Token 与 `mcpCalls` 工具次数，不把缺失的轮数显示为 `0 轮消息` | covered                |
| US-CP-02 team scope                 | Team pricing 含组织/项目，所有 usage 接口成功                      | 打开 Team tab               | 请求携带 organization/project，UI 不混入个人来源                                                                                                                                                                                  | covered                |
| US-CP-03 source switching           | 同时 seed 个人和两个团队来源                                       | 依次切换 tabs               | 每个 tab 的 quota/model/tool 独立；个人请求不携带团队 header                                                                                                                                                                      | covered                |
| US-CP-04 range switching            | 三个 range 返回不同 marker                                         | 切换 today/7d/30d           | 请求日期与 UI range 一致；旧 range 只做局部过渡，不进入新 scope 共享缓存                                                                                                                                                          | covered                |
| US-CP-05 legacy fallback            | credit 接口不可用，legacy monitor 成功                             | 打开 Coding Plan            | 展示 legacy trend，隐藏仅新版 credit KPI，不回退 App Usage                                                                                                                                                                        | focused-test           |
| US-CP-06 optional failures          | quota 成功，activity/detail/performance 分别失败                   | 逐场景打开页面              | 只清空对应可选区域，其余区域保留                                                                                                                                                                                                  | covered-representative |
| US-CP-07 fatal failures             | quota 网络失败、HTTP 200 业务失败、token 失效三场景                | 打开页面并重试              | 页面整体错误；业务错误不伪装空态或 credential generic；恢复后显示数据                                                                                                                                                             | covered-representative |
| US-CP-08 team availability recovery | Team quota 首次网络/业务失败，随后成功                             | 重开/强制刷新               | 失败不写 24h 成功缓存；恢复后 provider/tab 同步可用                                                                                                                                                                               | proposed               |
| US-CP-09 reset presentation         | 5h、week、MCP limit 含有/缺少 reset time                           | 查看 Usage 与 Provider Card | Usage stats 的全部额度显示月日+时间；Provider Card 保持既有紧凑格式；缺值隐藏；三色顺序正确                                                                                                                                         | covered-representative |

## 访问刷新与跨入口同步

| Case                             | Setup                                  | Action                                                            | Assertions                                                    | Status   |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| US-RF-01 freshness               | 可计数 quota server，已有成功快照      | 60 秒内依次访问 Footer、Context、Usage、Provider Card，再推进时间 | 首次请求一次；窗口内不重复；到期后再请求                      | proposed |
| US-RF-02 in-flight success       | 首个相同 scope 请求保持 pending        | 同时挂载两个入口后完成请求                                        | 底层只请求一次，两个入口收到同一 snapshot                     | proposed |
| US-RF-03 in-flight failure       | 首个相同 scope 请求保持 pending 后失败 | 同时挂载两个入口                                                  | 底层只请求一次，两个入口收到错误且 pending cache 被清理       | proposed |
| US-RF-04 force triggers          | cached `none/unavailable`              | 分别触发手动刷新、token/fingerprint 变化、购买成功                | 均绕过 freshness 并重新探测                                   | proposed |
| US-RF-05 retry backoff           | server 连续失败后成功                  | 按 30/60/120/300 秒访问                                           | 退避序列正确，成功后清零；access freshness 不遮蔽恢复窗口     | proposed |
| US-SY-01 cold footer             | 登录且 provider 已配置，不打开设置     | 启动 workspace                                                    | Footer 主动探测并显示额度，不依赖其它入口预热                 | proposed |
| US-SY-02 context feedback        | 有缓存，access 请求依次成功/失败       | hover Context                                                     | loading→1 秒成功勾→详情；失败时保留缓存并显示 warning tooltip | proposed |
| US-SY-03 context empty recovery  | 无缓存且首次请求失败                   | hover、点击重试                                                   | 显示 notice 与重试按钮；成功后替换为额度条                    | proposed |
| US-SY-04 mounted synchronization | Footer、Context、Usage 同时挂载        | 任一入口强制刷新                                                  | 其它入口无需重挂载即显示同 scope 新快照                       | proposed |

## Coding Plan / Start Plan 互斥

| Case                               | Setup                                         | Action              | Assertions                                  | Status |
| ---------------------------------- | --------------------------------------------- | ------------------- | ------------------------------------------- | ------ |
| US-SP-01 coding preferred          | Coding Plan 有 quota，同时存在 Start Plan     | 打开 Context/Footer | 只查询和展示 Coding Plan，不显示 Start Plan |
| US-SP-02 explicit no-plan fallback | Coding Plan 明确 `no_plan`，Start Plan 可用   | 打开 Context        | 允许查询并展示 Start Plan                   |
| US-SP-03 no transient fallback     | Coding Plan pending/network/token/unavailable | 打开 Context        | 任一瞬态状态都不降级 Start Plan             |
| US-SP-04 start access              | 仅 Start Plan，可计数 balance server          | 首次/重复 hover     | 首次请求；60 秒内复用；有缓存静默刷新不闪空 |

## 兼容性与架构不变量

| Case                      | Setup                                    | Action                          | Assertions                                                          | Status   |
| ------------------------- | ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | -------- |
| US-CM-01 narrow viewport  | 窄 renderer viewport + 密集数据          | 操作 Usage tabs、图表和 tooltip | 无关键控件不可达；activity 可滚动；tooltip 不越界                   | accepted |
| US-CM-02 theme/locale     | Zai Light/暗色及中英文代表样本           | 依次打开四入口                  | semantic color 可读、文案无关键截断、错误不泄露 raw provider 内容   | accepted |
| US-CM-03 remote invariant | shared-host remote workspace，Usage 可用 | 打开 Usage 并刷新               | 使用注入 service；不创建独立 runtime，不写 task replayable snapshot | accepted |

## 明确不以 GUI E2E 穷举的内容

- mapper 的每个 null/NaN/负数/乱序字段组合，由 services focused tests 覆盖。
- 每个日期、时区、自然周边界，由 CLI/query 与 UI focused tests 覆盖。
- 所有品牌 × range × theme × locale × viewport 的全笛卡尔积。
- 不可稳定从 UI 触达且没有用户可观察结果的防御分支。

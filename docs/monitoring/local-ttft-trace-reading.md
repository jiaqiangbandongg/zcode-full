# 怎么读一条本地 TTFT Trace

Status: ready

[父合同](ttft-stage-telemetry.md) · [查询与诊断合同](local-ttft-queries.md) · [看板模板](dashboards/local-ttft.json) · [上线清单](local-ttft-rollout-checklist.md)

面向第一次打开 `zcode-local-ttft` 瀑布图的人。查询入口和指标口径见查询合同，本文只讲怎么把一条 Trace 读成结论。

## 三个先决常识

**1. `duration` 是纳秒。** 根 span 显示 `701699951` 是 **701.70 毫秒**，不是 7 亿。看原始字段一律 `duration / 1000000`。

**2. 一条消息是一整棵 span 树，不是一条记录。** 一次发送几十条 span 全属于同一个 trace，`observation_id` 去掉连字符就是 trace ID。

**3. 结论在根 span 的 `attributes` 字段里。** 它是一个 JSON blob，不是预定义列；SQL 里写 `select attributes.observation_id` 会报 Column cannot be resolved，用全文检索该值命中即可。

## span 命名规律

| span 名形态                    | 是什么                                   | 是否代表耗时         |
| ------------------------------ | ---------------------------------------- | -------------------- |
| `local_ttft`                   | 根：一次发送的总 TTFT，每条消息只有 1 个 | 是                   |
| `local_ttft.<主阶段>`          | 六个主阶段之一                           | 是                   |
| `local_ttft.prepare.<子阶段>`  | 请求准备内部的细分                       | 是                   |
| `local_ttft.attempt`           | 一次物理模型请求                         | 是                   |
| `local_ttft.retry_wait`        | 两次 attempt 之间的等待                  | 是                   |
| `local_ttft.user_confirmation` | 队列二次确认弹窗里的用户停留             | 是（但不是系统耗时） |
| `local_ttft.checkpoint`        | 过程中的状态快照，一条消息可能几十个     | **否**               |
| `local_ttft.start`             | 提交时刻的起点标记                       | **否**               |
| `<任意>.started`               | 该阶段已开始、尚未结束的点记录           | **否**               |
| `local_ttft.first_text`        | 首正文的独立观察                         | 是，但不是主 TTFT    |
| `local_ttft.no_text`           | 整轮结束都没有正文                       | 否                   |

看瀑布前先把 `checkpoint`、`start` 和 `.started` 滤掉，剩下的才是耗时区间。`.started` 的 duration 为 0 不表示这个阶段零耗时，表示它没有收到结束边界。

## 六个主阶段

按真实时间顺序，边界定义见[父合同的阶段与时间合同](ttft-stage-telemetry.md#阶段与时间合同)。

| 阶段                | 这段时间在干什么                                    | 变大意味着                    |
| ------------------- | --------------------------------------------------- | ----------------------------- |
| `renderer_prepare`  | 界面收到点击/Enter，通过发送门禁并组装命令          | 发送前的本地处理延迟          |
| `command_admission` | 命令送到 CLI 并被权威受理，含 admission gate 等待   | 通信延迟或 admission 竞争     |
| `execution_wait`    | 受理完成，等着轮到这条输入执行                      | 前面有任务在排队              |
| `request_prepare`   | 开始执行：hooks、上下文加载、持久化、压缩、请求装配 | 展开 `prepare.*` 看具体是哪项 |
| `model_request`     | 请求发出到 CLI 形成该输入的首个有效输出             | 看 `attempt` 个数区分慢与重试 |
| `output_return`     | 首输出从 CLI 经 Host 回到发起界面                   | 回传链路瓶颈                  |

## 示例：一条真实样本

`observation_id = 820f1085-7bf1-4b04-9229-c2625b11da47`（2026-09-15 平台验收样本，62 个 span）。**这是 E2E 回放样本，其中的命令延迟和首正文延迟是测试故意注入的，不代表线上性能。**

```text
0        7.5                        303   310        383            669    701.7 ms
├────────┼──────────────────────────┼─────┼──────────┼──────────────┼──────┤
│renderer│   command_admission      │exec │ request  │ model_request│output│
│_prepare│        295.48            │_wait│ _prepare │    285.38    │_return
│  7.50  │                          │6.77 │  73.81   │              │32.75 │
└────────┴──────────────────────────┴─────┴──────────┴──────────────┴──────┘
   ↑                                                                    ↑
 点了发送                                                      看到第一个输出
```

六段合计 701.69ms，根 701.70ms —— 这正是 `unattributed_ms=0` 的含义：**总时长被完整解释，没有说不清去哪儿的时间**。该值不为 0 时，差额是未归因部分，不要硬塞给模型或网络。

`request_prepare` 的 73.81ms 内部：`prepare.context` 10.48、`prepare.hooks` 5.86、`prepare.persistence` 3.21、`prepare.request_assembly` 3.82、`prepare.mcp` 0.14、`prepare.tools` 0.10。子阶段之和小于主阶段是正常的，未细分的部分不填零。

`local_ttft.attempt` 285.39 ≈ `model_request` 285.38：这次只请求了一次。有重试时会看到多个 `attempt` 加 `retry_wait`。

## 主 TTFT 与首正文是两件事

同一条样本里 `local_ttft.first_text` = **8450.50ms**，是根的十倍多。这不矛盾：根 span 的 `first_output_kind = reasoning`，0.7 秒时用户看到的是思考内容，真正的文字回答 8.45 秒才到。

只看总 TTFT 会判断体验很好；配上 `first_text` 才知道用户等了 8 秒才看到答案。两者分别统计，不要相互替代。

## 根 attributes 检查清单

| 属性                | 本样本值              | 怎么用                                                                                      |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `quality`           | `complete`            | 只有 complete 能进完整阶段分布；`missing` 是校准缺失/过期，`clock_invalid` 是检测到时钟异常 |
| `visibility`        | `background_returned` | 默认体验只看 `foreground`；本样本中途切后台又回来                                           |
| `send_mode`         | `idle`                | `idle`/`queued`/`guided` 分组统计，不要混算                                                 |
| `first_output_kind` | `reasoning`           | 首输出是正文、思考还是工具调用                                                              |
| `unattributed_ms`   | `0`                   | 未归因时间；用可靠区间的**并集**对账，并行不重复计                                          |
| `clock_error_ms`    | `5.02`                | 跨进程对齐误差，阈值 10ms                                                                   |
| `truncated`         | `false`               | 是否因容量上限被截断                                                                        |
| `missing_stages`    | 空                    | 缺哪些阶段；缺失不等于该阶段耗时为 0                                                        |

关联 ID（`command_id`/`input_id`/`query_id`、`turn_id`、`product_turn_id`、`logical_call_id`、`request_id`、`cli_instance_id`）只用于 Trace 串联，不进指标标签。`request_id` 随重试变化，不能当整次发送的主键。

## 按症状定位

先看根的总时长和 `first_output_kind`，再看哪个主阶段占大头：

- `command_admission` 大 → 命令传递或 CLI 受理竞争，不是模型慢
- `execution_wait` 大 → 业务排队，配合 `send_mode=queued` 判断是否正常
- `request_prepare` 大 → 展开 `prepare.*`，常见是 hooks 或上下文加载
- `model_request` 大 → 数 `attempt` 个数：一次慢请求，还是多次失败重试累积
- `output_return` 大 → 回传链路
- `user_confirmation` 大 → 用户在确认弹窗停留，不是系统处理耗时

## 未收口不等于失败

只有 `local_ttft.start` 和若干 `checkpoint`、没有根 span 的记录是**未收口**：可能仍在运行，也可能丢了终态。

- 有明确退出或中断证据才记 `interrupted`；5 分钟观察清理后仍无结果的留 `unclosed`
- 查询窗口没覆盖首次提交会造成开始/结束集合不一致，这是窗口截断，不是超时
- 不要把 `start` 与终态的数量差解释成超时率

## 常见误读

- 把 `checkpoint` 或 `.started` 当成耗时阶段
- 把 `first_text` 当作 TTFT，或反过来只看 TTFT 忽略首正文
- 把 `attempt`、`prepare.*` 的区间数量当成用户消息数
- 把并行子阶段的耗时相加当成主阶段墙钟耗时
- 相加不同阶段的 P95，或用总 P95 减模型 P95 推导其他阶段
- 把 `background` / `background_returned` / `quality != complete` 的样本混进默认体验统计
- 把 `unattributed_ms` 的差额归因给网络或模型

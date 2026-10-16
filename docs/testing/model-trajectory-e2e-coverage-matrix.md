# 模型调用轨迹 E2E 覆盖矩阵

本文定义 Model Trajectory Viewer 的端到端验收语义。覆盖率门槛按固定区间
`1f015ca1726a4e1f932c6e87b8b7ce64623317af..f5ce7b4b360eaec0a396b55f1e2ad36586ecd837`、
且可归因于调用轨迹能力的可执行 TypeScript/TSX 变更行聚合计算，目标不低于 95%。归因集合固定为
`3e00cec9d0`、`bfcef0c9c4`、`1d434a6dda`、`65156894ac`、`274ebbd8f4`、`f5ce7b4b36`，
对应原生滚动、reasoning 落盘、tool metadata 投影、轨迹 UX、内容搜索和有界尾部读取；
不得把同期进入 staging 的 provider、media、settings、通用 task action tracing 等无关变更计入
分母。纯文档、测试代码、翻译字典与纯 CSS 不进入可执行行分母，但对应视觉和文案必须由 E2E
断言覆盖。Renderer 使用 Istanbul 覆盖率，Desktop host / CLI 使用 V8 覆盖率。`094ac1c5a1`
的默认展开是上界之后的当前行为，E2E 保留回归断言，但不进入本次固定分母。

## 状态维度与剪枝

| 维度     | 接受状态                                                                 | 剪枝                                                                                                                 |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 数据     | records、`error-text`、record error；完整记录与旧格式兼容记录            | Pane 的 loading/empty/read-error 是既有通用状态，不进入本次 UX 重构的 changed-line E2E；JSONL 投影语义与模型厂商无关 |
| 内容类型 | System、User、Reasoning、Assistant、Tool Call、Tool Result、record error | 不做六类内容的笛卡尔积；在一条复合 fixture 中覆盖                                                                    |
| 展开     | 默认展开、单行收起、全部、自定义类型、溢出正文                           | 不逐条重复相同 toggle 断言                                                                                           |
| 搜索     | 无结果、单结果、多结果、前后导航、折叠命中、虚拟区外命中                 | 大小写和空白归一化由单测覆盖，E2E 验证产品链路                                                                       |
| 列表     | 短列表、长列表虚拟化、展开后动态测高                                     | 不按固定记录数量重复跑；长列表代表规模边界                                                                           |
| 视口     | Desktop 标准宽度、窄侧栏                                                 | `/remote` 不新建 Agent runtime；共享 host 兼容由组件与现有 remote 回归覆盖                                           |

## 接受的 Cases

| ID    | Setup                                                                                            | Action                                                     | Assertions                                                                                                                                                                                                   | 自动化归并                 |
| ----- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| TRJ01 | 真实 main-turn 建立 task/session，先读取 CLI 实际写入的 model-io，再追加包含六类内容的确定性记录 | 显式固定 `zh-CN` 后，从真实 task 右键菜单打开调用轨迹      | CLI 实际记录包含 main-turn response/reasoning；Host 读取当前 task 文件；来源、finish reason 与六类内容通过稳定语义属性正确投影；代表性中文文案、token、耗时、tool name/id 均正确，功能断言不依赖英文展示文本 | live writer/host-read spec |
| TRJ02 | 注入兼容 JSONL：full → delta、顶层 tool metadata、`error-text`、record error                     | 打开轨迹并展开错误行                                       | delta 还原后的新增 user 可见且旧 assistant 不重复为 Input；tool name/id 分离；错误摘要取 value；展开为 destructive 样式；record error 可见                                                                   | fixture projection spec    |
| TRJ03 | 复合内容含普通与超高正文                                                                         | 验证默认展开，点击整行收起/再展开、复制、展开/收起溢出全文 | 默认展开；整行可收起并恢复；复制只在展开态；超高正文 mask 与居中展开 pill 工作；换行保留                                                                                                                     | interaction spec           |
| TRJ04 | 六类内容同时存在                                                                                 | 全部展开/收起；分别在菜单中切换 Reasoning 与 Tool Result   | 批量状态立即生效；两种自定义开关只影响目标类型；后发命令覆盖旧单行 override                                                                                                                                  | interaction spec           |
| TRJ05 | 生成超过虚拟化阈值的多调用数据，若干行不同高度                                                   | 滚动到中段、展开稳定 key 的一行、滚出挂载窗口后再返回      | 只渲染窗口附近记录；动态测高不重叠；header 吸顶；展开状态在真实卸载/重挂载后保持                                                                                                                             | virtual/search spec        |
| TRJ06 | 多处命中且分布于已渲染记录                                                                       | 搜索、上一个/下一个、关闭搜索                              | 总数与索引正确；活动命中和普通命中样式区分；导航不闪烁；关闭后高亮清空且用户展开状态恢复                                                                                                                     | virtual/search spec        |
| TRJ07 | 唯一命中位于折叠正文且在虚拟窗口外                                                               | 搜索并导航到命中                                           | 目标记录滚入视口、对应行自动展开，命中高亮并居中定位                                                                                                                                                         | virtual/search spec        |
| TRJ08 | 窄侧栏与完整 tool name/id                                                                        | 缩窄 Desktop renderer                                      | 页面无水平滚动；tool name 完整；可见操作列右边线误差不超过 2px                                                                                                                                               | narrow-layout spec         |
| TRJ09 | 创建超过 32 MiB 的稀疏 model-io，尾部追加完整 recent record                                      | 刷新调用轨迹                                               | Host 只读取有界尾部、丢弃起点残行、保留 recent record，并显示 truncated 提示                                                                                                                                 | bounded-tail spec          |

## 覆盖责任

| 层                    | E2E 责任                                               | 补充测试                                |
| --------------------- | ------------------------------------------------------ | --------------------------------------- |
| CLI writer            | TRJ01 验证 reasoningText 实际落盘                      | runner unit 验证提取与 bounded append   |
| Service projection    | TRJ01/TRJ02 验证文件读取、delta、tool/error 元数据贯通 | modelTrajectory unit 覆盖异常行与 limit |
| UI rendering          | TRJ01-TRJ04/TRJ08                                      | 纯 formatter、expansion state 单测      |
| Virtualization/search | TRJ05-TRJ07                                            | search/highlight 纯逻辑单测             |

## 95% 审计规则

1. 运行 trajectory E2E 时设置 `ZCODE_E2E_COVERAGE=1`。
2. 合并 Renderer Istanbul 与 Node V8 报告后，仅筛选固定区间内、且由上述 trajectory commits 引入的相关可执行变更行；以目标 revision 的 blame 归因，Babel/Istanbul statement 起始行确定 TS/TSX 可执行行。
3. 每个 case 必须具备 setup、action、assertion；仅路过代码不计作语义覆盖。
4. 若聚合低于 95%，先补有产品意义的 case/断言；不可用无断言调用伪造覆盖率。
5. 最终同时运行 `typecheck:e2e`、根 `typecheck`、`lint` 与 fixture check。

## 2026-08-24 历史执行证据

- Formal case：`conversation-session-model-trajectory-viewer.test.ts`，TRJ01–TRJ08 全部自动化归并为一次真实 Desktop/host 链路运行，并已通过人工 review 与 formal admission audit。
- Case-local provider fixture 与 manifest 已通过 `e2e:fixture:check`；运行时 model-io 文件由 spec 按真实 task id 创建。
- `ZCODE_E2E_COVERAGE=1` 正式运行通过，artifact run id：
  `desktop-e2e-20260824030501067-p90124-d7b5300b50c7a917`。
- Renderer/host 源码报告与 CLI V8 dist 对应行合并后，保守计入 CLI 本次新增的全部 27 行，
  changed-line 命中为 **1382 / 1437（96.17%）**，超过 95% 门槛。
- CLI `runner-debug` 的 generate、stream、reasoning normalization 新增路径在同次 V8 报告中均有命中；
  reasoning 数组内容与空值边界继续由 runner unit 精确断言。

该证据早于 `f5ce7b4b36` 的有界尾部读取修复，只能证明当时的 UX 重构覆盖率，不能作为当前
95% 门槛的最终凭证。当前审计必须在 TRJ01–TRJ09 与固定分母上重新生成同一次运行证据。

## 2026-08-27 当前执行证据

- Formal case：`conversation-session-model-trajectory-viewer.test.ts`，TRJ01–TRJ09 单次正式 replay
  通过；完整重建后的 run id：`desktop-e2e-20260827-131338-656`，exit code `0`，first-time pass
  rate `100%`。
- Case-local DeepSeek fixture 与 common fixture 显式组合；用例先让真实 CLI main-turn 写出包含
  `response.reasoningText` 的 model-io，再追加确定性记录，并通过真实 task 右键菜单进入 Pane。
- 同一次运行采集 Renderer Istanbul、Host V8 与 CLI V8。固定 revision blame 与 executable-line
  交集审计结果如下：

| 覆盖来源          | 命中 / changed executable lines |     覆盖率 |
| ----------------- | ------------------------------: | ---------: |
| Renderer Istanbul |                       397 / 413 |     96.13% |
| Host V8           |                         37 / 38 |     97.37% |
| CLI V8            |                           6 / 6 |       100% |
| 合计              |                   **440 / 457** | **96.28%** |

- CLI 报告落在编译后的 `runner-debug.js`；对应 source executable lines 的 generate/stream
  `reasoningText` 与 `modelIOReasoningText` 均在同次 V8 报告中命中。未命中的 17 行主要是不可达的
  未引用旧组件、复制失败 catch、无内容 fallback、不可序列化 payload catch 与搜索 range 已在视口外的
  滚动修正；它们不影响 95% 门槛，且未用无断言调用制造命中。

# 输入框卡顿埋点设计(perf_ui_input_lag)

日期:2026-06-25
状态:已设计待实现

## 背景与目标

聊天输入框是 Lexical 富文本编辑器(`packages/ui/src/LexicalChatInput.tsx`),
不是普通 textarea。用户反馈在长文本/连续输入时存在打字卡顿手感。

现有 `uiPerfArmsTelemetry.ts` 已覆盖**输出侧**性能(首 token、消息完成、
agent step、流式停顿 `perf_ui_stream_stall`),但没有**输入侧**的卡顿观测。
本设计新增一类埋点,把输入处理延迟上报到 ARMS,用线上数据验证根因、量化手感。

非目标:不做端到端「按键到 paint」延迟(不引入 keydown↔rAF 配对);
不做会话级聚合分布(首版只抓超阈卡点)。

## 卡顿发生的链路(根因假设)

每次敲键触发:

```
editor 内容变化
  → Lexical update
  → TextContentPlugin 的 registerUpdateListener 回调
      → getEditorMarkdown(editorState)   // $getRoot().getTextContent() 全量序列化,O(n)
      → getEditorMarkdown(prevEditorState) // 再来一次全量序列化
      → nextText !== previousText 比较
      → onChange(nextText)                // 同步触发父组件 setState → React 重渲染
```

热点在两次全量序列化 + `onChange` 引发的同步重渲染。文本越长,
`getTextContent()` 越慢——这是首要根因假设,用 `text_length` 维度验证。

## 设计

### 1. 事件与测量口径

- 新事件 `perf_ui_input_lag`,沿用现有分组 `UI_PERF_ARMS_GROUP = "ui_perf"`。
- 加进现有 `packages/ui/src/lib/uiPerfArmsTelemetry.ts`,**不新建文件**,
  与 `perf_ui_stream_stall` 同源同组。
- 测量点:`LexicalChatInput.tsx` 的 `TextContentPlugin` update listener。
  用 `performance.now()` 包住 `getEditorMarkdown + onChange` 这段同步处理,
  得到**单次输入处理耗时 lagMs**。
- 口径:只测 listener 内同步耗时,**不追到浏览器 paint**。
  与 `perf_ui_stream_stall` 测「真实间隔」的朴素口径一致,不引入 rAF 配对复杂度。

### 2. 触发条件、阈值与异常处理

- **只在超阈值时上报**。
- `INPUT_LAG_REPORT_THRESHOLD_MS = 500`:保守起点,只抓最严重卡顿,
  事件量极小;导出为常量,后续可据线上分布往下收紧
  (与 `STREAM_STALL_REPORT_THRESHOLD_MS` 写法一致)。
- `INPUT_LAG_SANITY_MAX_MS = 5000`:超过此值大概率是断点调试、标签页挂起、
  设备休眠唤醒,丢弃避免污染分布(与 `LAUNCH_TO_INPUT_SANITY_MAX_MS` 同思路)。
- **失败不阻断**:复用现有 `emit()`,上报失败只 `logger.warn`,绝不影响输入主流程。

**排除项(不算打字卡顿):**

1. **IME 组合中**:中文/日文输入法组合期间 update 频繁且耗时天然高,会误判,排除。
   - 实现细节:update listener 本身不直接带 isComposing,需从编辑器 root 的
     composition 状态(或 root 元素 `isComposing`)判断 Lexical 是否暴露,**写计划时确认**。
2. **程序化改写**:`replaceEditorText` / `setText` / mention 插入 / 历史导航回填
   这类非用户敲键的 `editor.update` 会一次性改大量节点、耗时高,但不是打字卡顿,排除。
   - 实现:给这些 `editor.update` 调用打上 Lexical update **tag**;
     listener 读 `tags: Set<string>`,命中即跳过。**tag 命名与挂载点写计划时定**。

### 3. 事件字段(payload)

复用现有 `ArmsCustomEventPayload`(`name` / `group` / `value` / `properties`):

| 字段 | 值 | 用途 |
|------|-----|------|
| `name` | `"perf_ui_input_lag"` | 事件名 |
| `group` | `"ui_perf"` | 沿用现有分组 |
| `value` | `Math.round(lagMs)` | 主指标,看板做分布/p95 |
| `properties.lag_ms` | 同 value | 与 stream_stall 的 `stall_ms` 镜像口径,便于维度筛选 |
| `properties.text_length` | 当前编辑器文本长度 | 关键归因:验证「文本越长越卡」 |
| `properties.task_id` | 当前 taskId(草稿态为空) | 关联会话,与其它 ui_perf 事件口径一致 |

不放(YAGNI):文本内容(隐私+体积)、model(输入侧与模型无关)、
mention 数量(首版先看 text_length,需要再加)。

### 4. 接线与测试

**接线(与 stream_stall 对称):**

- `uiPerfArmsTelemetry.ts` 新增导出 `recordInputLag(params: { lagMs; textLength; taskId? })`,
  内部走现有 `emit()`。无新增 reporter,复用已有 `armsReporter`
  (`Root.tsx` 已 `setUiPerfArmsReporter`,**无需改 Root**)。
- `LexicalChatInput.tsx` 的 `TextContentPlugin`:`performance.now()` 包住
  `getEditorMarkdown + onChange`,算 `lagMs`;读 `tags` 跳过程序化改写、
  跳过 IME 组合态;`lagMs > 500 && lagMs <= 5000` 时调 `recordInputLag`,
  `text_length` 取 `nextText.length`。

**测试(纯函数为主,与 `chatErrorArmsTelemetry.test.ts` 同风格):**

1. 判定抽成纯函数 `shouldReportInputLag({ lagMs, isProgrammatic, isComposing })`,
   单测覆盖:低于阈值不报、超阈值报、超哨兵不报、程序化跳过、IME 跳过。
2. `recordInputLag`:无 reporter 时静默、有 reporter 时 payload 字段正确、
   reporter 抛错时只 warn 不抛。
3. 不写组件层重型 E2E:Lexical 在 jsdom 下 update 行为不稳,判定逻辑已被纯函数覆盖。

**改动文件:**

- `packages/ui/src/lib/uiPerfArmsTelemetry.ts`:加常量 + `recordInputLag` + `shouldReportInputLag`。
- `packages/ui/src/LexicalChatInput.tsx`:`TextContentPlugin` 接线 + 给程序化 update 打 tag。
- `packages/ui/test/uiPerfArmsTelemetry*.test.ts`:追加/新增测试 case。

## 关键决策记录

- 覆盖范围:不限定单一现象,埋点把能测的覆盖,首版聚焦 keystroke 处理延迟。
- 上报策略:只上报超阈卡顿(最小事件量,代码多处注释担心逐条上报放大量)。
- 测量机制:update listener 内 `performance.now` 计时(最贴近真实处理成本,改动最小)。
- 阈值:500ms(用户指定,保守起点)。
- 程序化改写:排除(只看纯打字手感,口径最干净)。

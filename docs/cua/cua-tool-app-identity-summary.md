# CUA Tool App Identity Summary

## 目标

CUA 工具摘要在 Agent 已经通过 `list_apps` 观察到 App 身份、且后续调用显式携带 PID 时，
从执行开始阶段显示目标 App 名称和图标，降低连续 CUA 操作的辨识成本。

## node_repl 时代的身份来源（2026-09-17）

Computer Use 收成 `node_repl` 的 JS 面之后，模型可见的工具名只有 `mcp__node_repl__js`，
本文下面「事实来源与时序」「CUA Tool Call Group」两节依赖的 `mcp__computer-use__*` 工具名判据
全部失效，只对**历史会话回放**继续成立。新会话按本节投影。

```text
Helper application_info / capture
        |
        v
producer 统一 wrapper 附加 _meta["zcode.cua/app-associations-v1"].primary
  { appKey, displayName?, icon? }
        |
        v  broker 响应（沙箱不可见）
node-repl-host CUA bridge —— 唯一可信记录点
        |
        v  run 结果的可信槽位
node_repl 工具结果 _meta["zcode/nodeReplCuaApp"] = { appKey, displayName? }
        |
        v
Core display `node_repl_images.app`
        |
        v
Node REPL 工具卡 leading icon -> IPlatformService.getApplicationIcon(locator)
```

- **信任边界**：身份只能由 node-repl-host 的 CUA bridge 在收到 broker 响应时记录。
  `nodeRepl.setResponseMeta` 与 `nodeRepl.emitStructuredResult` 都挂在模型可见的 sandbox
  globals 上，因此经这两条通道到达的 `zcode.cua/app-associations-v1` 一律**丢弃**，不得参与展示
  （同 `zcode/nodeReplBrowserScreenshotContentIndices` 的既有处置）。宿主自己写的
  `zcode/nodeReplCuaApp` 是唯一被 Core 消费的键。
- **一个 cell 多次调用**：最后一个产生 `primary` 的 CUA 方法胜出，与 `_meta` 既有的
  last-write-wins 语义一致。`request_access`、`stop_computer_control` 声明 `none`，
  `list_apps` 声明 `items`，三者都不产生 `primary`，因此不会把前面的身份覆盖掉。
- **图标解析**：`appKey` 按前缀派生 locator——`darwin:` → `darwin-bundle-id`，
  `windows-aumid:` → `windows-aumid`，`windows-exe:` → `windows-executable-path`。
  `linux-exe:` 没有对应 locator，与 Web/手机远控一样回退通用 Node REPL 图标。
  producer `_meta` 里的内联 `icon` PNG **不投影**：会话协议不承载 data URL（见下节「协议与展示」），
  且同一个 app 的图标会在长会话里逐步重复几十次。
- **不在本次范围**：`app` 名称不进摘要行（`js` 的 `title` 已由模型描述本次动作，再拼一次 App 名会
  重复）；`list_apps` 的 `items` 不投影（node_repl 下没有逐条列表卡）；CUA Group 分组仍然只对
  历史会话成立。

## 事实来源与时序

> 本节及「CUA Tool Call Group」按 `mcp__computer-use__*` 工具名分流，只对历史会话回放成立；
> 新会话见上节。

```text
list_apps #1 success ── snapshot #1 ── pid tool ── pid tool
list_apps #2 success ── snapshot #2 ── pid tool ── ...
```

- 快照范围是单个 task 的有序事件流；不得跨 task/session 复用。
- 只有官方 CUA `list_apps` 成功结果整体替换快照；失败结果保留旧快照。
- 后续官方 CUA tool scheduled 时，优先从输入中已有的 `app_ref.pid` 查询当前快照；没有
  PID 时，再以 `bundle_id` 完全相等查询。`name` 不作为查询键。
- `app_ref` / 等价 AppRef 位置同时接受结构化对象与可解析为对象的 JSON 字符串，与 CUA
  执行层输入归一化保持一致；无效字符串不参与匹配。
- 不从 `state_id` 反查，不为摘要隐式调用 `list_apps`，也不猜测截图、等待等全局操作的 App。
- 冷恢复按同一事件日志重建快照；continuous 与 replayable 消费相同 `ToolCallRow` 事实。

## 协议与展示

`ToolCallRow` 可选携带：

```ts
cuaApp?: {
  pid: number;
  name: string;
  bundleId?: string;
};
```

展示身份优先采用同一次工具完成结果中的 App，其次采用 scheduled 时固化的 `cuaApp`，最后
回退 `Computer Use`。匹配成功时显示 `App Icon + App Name + Action`；图标通过平台服务按
`bundleId` 异步解析，不把 data URL 写入会话协议。平台不支持、无 bundle id 或图标读取失败时
保留 CUA Icon，但仍显示 App 名称。

### 元素动作目标标签

- 动作目标 tag 统一使用 `text-ui-sm`，作为 App/动作正文的次级紧凑信息。
- `left_click`、`right_click` 和 `type` 完成后优先使用结果状态中目标元素的可读名称作为摘要 tag。
- 若目标元素自身只有与 index 相同的数字占位名，可在结果状态的扁平元素列表中，读取其后到下一个可操作元素之前的连续文本节点并组合为标签。例如 `[59] 59 (pressable)` 后的“智谱 / 快速 / 订餐”显示为“智谱快速订餐”。
- 该读取必须在下一个 `pressable` 或 `editable` 元素处停止，不能跨搜索结果拼接无关文本；无法得到可靠文本时继续回退到元素 index。
- 最终只能回退到纯数字 index 时，摘要 tag 必须显示本地化的 `元素 #57` / `Element #57`，
  不直接裸露 `57`；已解析出的可读元素名称保持不变。

### 展开时机

- 所有 CUA 工具在 `pending` / `running` 阶段只显示摘要，不提供展开入口，也不响应上层 `forceOpen`。
- 工具进入完成态后，才允许按现有详情规则展开；失败截图没有图片数据时不渲染截图项目。

## CUA Tool Call Group

CUA Group 是 V4 renderer-only 展示投影，但分组所需的 response 归属是协议事实。V4
`ReasoningRow`、`AssistantTextRow` 与 `ToolCallRow` 通过可选 `assistantResponseId` 指向 runtime 已有的
`assistantMessageId`；桌面 continuous 与手机 replayable 从同一有序 row 事实确定性构造 Group。

```text
Assistant response start
                 ── 创建稳定 ResponseEnvelope，正文正常 streaming
response 只含官方 CUA
                 ── reasoning + message + CUA 加入或延续活动 Group
response 含非 CUA tool
                 ── 关闭旧 Group；message/非 CUA 外置，CUA 从新 Group 开始
response 无 tool ── message 外置，response/turn 完成时关闭 Group
未分类 reasoning / message
                 ── 外置显示，本身不关闭 Group
marker / status  ── 外置显示，本身不关闭 Group
turn / work segment / user boundary
                 ── 强制关闭 Group
```

- 单个官方 CUA 也形成 Group；第三方同名 MCP 不参与。
- Group 的稳定身份与位置锚定首个含官方 CUA 的 Assistant response，key 使用其
  `assistantResponseId`，不再锚定 tool call。tool-only response 才以第一条 CUA 作为视觉 fallback。
- response start 时 reasoning 与正文始终在原位流式显示，不创建、关闭或暂挂进 CUA Group；
  同 response 的官方 CUA 到达后，reasoning、正文与容器才从外部移除并整体进入 Group。
- 非 CUA到达时正文保持外部并关闭旧 Group；response 完成且仍无 tool 时才确认 text-only
  并关闭旧 Group。未分类 streaming message 不进入滚动摘要。
- response 确认为纯 CUA 后，外部 Assistant render item 必须整体删除，包括 RowShell、间距和
  actions 容器；展开 Group 时由同一 row 在内部渲染一份完整 message 容器，不允许只搬正文而留下空壳。
- 外层 flow 投影中的 history chunk 还必须经过内层可见性与工具分组投影；若投影后没有
  任何可渲染项，则不得创建 `CollapsibleContent`、内边距或 work-items 容器。这保证
  CUA 消费 message 或运行中工具延迟分类时，不会在 Group 外留下可占据间距的空 history 结构。
- `request_access`、`list_apps` 与其他官方 `mcp__computer-use__*` 一视同仁。第三方同名 MCP 按
  非 CUA tool 处理。marker、todo/status 不加入且不主动关闭 Group。
- 旧快照缺少 `assistantResponseId` 时只聚合 CUA tools，不猜相邻 reasoning/message，保持兼容降级。
- 活动 Group 和关闭后的 Group 都允许用户点击或键盘展开全部 CUA children；活动 Group 仍忽略
  上层 `forceOpen`，避免运行中被动自动展开，但不再禁用手动展开入口。
- 展开明细使用固定最大高度的内部滚动视口；首次展开、追加 child 或明细高度变化时始终滚动
  到底部，让最新 CUA 事件保持可见，且不推动外层 conversation 无限增高。
- 内部滚动视口复用 Thinking 的条件式上下边缘 mask：只有对应方向仍有隐藏内容时才显示
  24px 渐隐，滚动到顶部或底部时移除该侧 mask，明暗主题使用同一透明度语义。
- 运行中的折叠摘要为 `<滚动内容> · N events[, M messages]`；完成后固定收敛为
  `<CUA Icon> Computer Use · N events, M messages`，不再保留最后一次 App/动作内容。完成态始终
  产品名走 locale，英文显示 `Computer Use`、中文显示 `电脑控制`；并显示 message 计数，包括 `M=0`。
  `N` 统计 Group 内当前可见的 reasoning、CUA 与 Assistant
  message；被“显示思考过程”隐藏的 reasoning 不计数，首条 reasoning 仍沿用全局可见性合同。
  `M` 只统计 Assistant message；单复数和中文量词走 i18n。分隔点和计数不用空格字符拼接，
  而是按独立布局节点展示。
- 完成态 CUA Icon 走普通 tool summary 的 leading icon 槽位，颜色与其他 tool icon 一致使用
  `text-foreground-subtlest`；完成态不再经过滚动摘要容器，避免空 primary slot 在产品名和分隔点
  之间叠加额外间距。运行态 App/CUA icon 仍属于滚动内容，不参与文字渐变。
- 滚动内容只投影终态 CUA：无 App 身份时显示 `CUA Icon + Computer Use + Action`；有身份时
  显示 `App Icon + App Name + Action`。Assistant message 不进入滚动候选、不触发滚动动画；它仍
  计入 events/messages，并在展开时间线用次要文字色显示正文、不重复显示图标。App 图标
  失败只回退图标，不丢失 App 名称。
- CUA 摘要中的动态动作文案必须使用已声明的中英文 locale key。`key` 与 `hold_key`
  在输入包含组合键时显示本地化动作加组合键 tag；`list_windows` 在完成结果可解析数量时
  显示本地化窗口数量，任何渲染路径都不得向用户泄露 message id。
- Group summary 的 App/CUA 图标统一放入
  `shrink-0 size-4 flex items-center justify-center [&_svg]:size-4` 容器：CUA fallback SVG
  保持 `size-4`；真实 App Icon 由 `CuaAppSummaryIcon` 在 Group 投影时显式接收 `size-5`，
  不使用父级 descendant selector 覆盖其默认 `size-4`。两者都不参与文字压缩；
  图标容器与滚动文字之间使用 `gap-2`。
- Group 展开后的子 CUA tool 同样通过明确的 render context 传入 App Icon `size-5`；
  子 tool renderer 同时为图标增加 `shrink-0 size-4 flex items-center justify-center`
  固定父容器，让 20px App Icon 以 16px 占位居中显示。普通独立 CUA tool 仍使用
  默认 `size-4`，不额外包裹该容器；两者都不使用 CSS descendant selector 覆盖图片尺寸。
- 虚拟父节点为 `in_progress` 时，滚动摘要中的 App 名称与动作使用 CUA 专属旧版快速
  宽光带：`1s / 200% / 40%–60% 弱色带 / 0.5s delay`。图标、分隔符、计数和失败状态不参与
  动画；reduced-motion 下关闭滚动和渐变。
- 滚动项只消费终态 CUA child：`success / error / cancelled` 经 legacy adapter 分别对应
  `completed / failed / stopped`。Assistant message 的 streaming、完成或失败状态都不产生滚动
  key；其他活动 CUA 和 message 都不覆盖上一条终态工具摘要。
- 业务失败属于终态并进入滚动队列，但长错误只出现在 tooltip 和详情中。
- 滚动复用 Explore 的实时更新播放语义；冷恢复直接显示最后一个终态项，不补播历史动画。
- 展开明细按 response/part 原始顺序混合显示：reasoning 复用现有折叠式 Reasoning 组件和
  可见性规则，但 Group 已承担父级边界，因此展开的子思考内容不重复显示左导线与左缩进；CUA
  复用现有工具详情；Assistant message 使用无图标轻量正文行，不附带最终正文的
  copy/fork/retry/preview actions。
- 主 turn flow 与 history/background-result 兼容工作项路径必须向同一个 CUA Group renderer
  传递完整 `events`。兼容路径不能只传虚拟父节点，否则其中的 Assistant message 会在被
  外层投影消费后从展开时间线消失。
- CUA 子工具详情中的“原始数据”必须展示完整 `toolCall` JSON，而不是只拆出 input/output；
  `toolId`、工具名称、状态、`raw.display`、`v4Status` 和流式元数据属于排障所需事实。
  完整数据放在二级 disclosure 中，默认保持折叠，避免影响常规详情的可读性。
- Group 不跨 user input、turn、work segment、workspace 或 session。

## 兼容与失败语义

- 旧快照没有 `cuaApp` 时保持现有摘要。
- Linux 的 `bundle_id` 可为空，名称仍可使用；Windows 的 `bundle_id` 可能是 AUMID。
- PID 在两次显式 `list_apps` 之间被视为 Agent 最近观察到的事实；系统变化不会触发隐式刷新。
- 第三方 MCP 即使工具名相似，也不得获得官方 CUA 身份投影。

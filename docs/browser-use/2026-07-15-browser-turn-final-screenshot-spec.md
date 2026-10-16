# Browser Use 轮次结束自动截图规格

> 状态：已实现，正式桌面/手机 E2E 待补。
> 日期：2026-07-15。
> 关联：`docs/browser-use/2026-07-10-browser-use-codex-parity-spec.md`、
> `docs/conversation-session-case-catalog.md`、
> `docs/testing/conversation-session-e2e-coverage-matrix.md`。

## 1. 产品目标

当且仅当本轮通过 Node REPL 成功调用过关联具体页面的 Browser API 时，在正常完成轮次后自动截取
当前 active tab，作为独立的轮尾图片块展示。本轮是否通过 `nodeRepl.emitImage(...)` 显式返回过图片，
不影响轮尾自动截图；显式图片属于工具结果，自动截图属于轮次结束时的页面最终状态，两者语义不同。

自动截图不是模型输出，也不回灌 provider context。它是 CLI/runtime 持久化的 conversation
展示事实，桌面 `desktop-continuous` 与手机 `web-remote-replayable` 读取同一份事实。

## 2. 已确认边界

| 维度         | 结论                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 触发来源     | 仅 Node REPL 内成功执行、且 response meta 关联具体 tab 的 Browser API                                     |
| 不计入触发   | `agent.browsers.list()`、documentation、capability 查询、失败调用                                         |
| 已有显式图片 | 不跳过自动截图；显式图片保留在原工具结果中，轮尾仍追加当前 active tab 的最终状态截图                      |
| tab 选择     | 完成时重新读取 browser tabs，只截当前 `active=true` 的 tab；这里的 `active` 是 main 给出的 effective active（含后台回退），不等于「UI 当前可见」 |
| 轮次终态     | 只在正常完成时尝试；Stop、取消、失败均跳过                                                                |
| 展示位置     | 同轮内容区最后：最终 assistant/Website 等预览卡和 file diff 摘要之后、消息操作栏之前；不回挂既有工具卡    |
| 展示样式     | 复用 Node REPL 工具结果截图的图片渲染逻辑、尺寸、左对齐、圆角、紧贴图片的 border 和大图查看器             |
| 失败策略     | browser 已关闭、scope 内已无存活 tab、截图失败，或压缩后仍超预算时静默跳过，并使用 service/runtime logger 留日志；scope 内还有存活 tab 时不会走本行，effective active 必非空 |
| 模型上下文   | 自动截图不进入 message history/provider content，不增加模型 tool call                                     |

## 3. 状态与时序

```text
Node REPL Browser API success
  -> turn-local marker { browserId, generation, tabId }
  -> 后续模型/工具继续运行
  -> final assistant text 持久化完成
  -> normal turn completion boundary
       ├─ 没有 qualifying browser marker -> skip
       ├─ list tabs 无 active tab（scope 内已无存活 tab）-> skip + debug log
       └─ screenshot(active tab)，不受本轮显式 emitImage 影响
            ├─ failed / invalid -> skip + warn/debug log
            └─ success
                 -> 超过 Node REPL 展示预算时先缩放/转码
                 -> 压缩后仍超预算 -> skip + warn log
                 -> persist turn-tail screenshot fact
                 -> desktop continuous delta
                 -> TurnComplete
                 -> mobile replayable snapshot 可恢复同一图片块
  -> browser turnEnded cleanup
```

截图必须在 `TurnComplete` 之前形成持久化事实，`turnEnded` cleanup 仍在主轮完成/失败后的 finally
执行。不能先 cleanup 再尝试截图，也不能由 renderer 在看到 completed 后临时调用 Browser API。

持久化 row 的先后顺序不能直接当成完成态 UI 的最终布局顺序。Website 预览卡从最终 assistant
正文派生，file diff 摘要从 turn header 聚合；renderer 必须把自动截图放到这些同轮内容之后：

```text
final assistant text
  -> Website / file preview cards
  -> per-turn file diff summary
  -> browser turn-end screenshot
  -> copy / feedback / fork / retry / timestamp actions
```

该重排只作用于 `source=browser_turn_end` 的展示 row；普通工具结果图片和
`turnTailBoundary` marker 继续保持既有位置，不按 UI 类型做全局重排。

## 4. 分层与多端约束

- Browser API 使用检测和最终截图由 CLI/runtime 负责；desktop main、relay 不拥有 turn 状态。
- Browser execute 继续走现有 `BrowserControlPort` 和 shared-host attachment，不新增手机 Agent/runtime。
- 远程 workspace 继续沿现有请求贯穿 `workspaceIdentity`、`remoteSessionId`、`clientMode`；不得只按
  `workspacePath` 关联。
- 桌面 continuous 直接收到新增轮尾事实；手机 replayable 通过同一 CLI event log/projection 的
  delta、gap 或 snapshot 恢复，不能把 replayable 拼接规则扩散到桌面链路。
- 自动截图只属于发起 Browser API 的 session/turn；跨 session active UI 切换不改变归属。

## 5. 数据与安全预算

- 图片只接受严格 `image/*` MIME 和合法 base64，沿用 `node_repl_images` 的数量与单图预算；原始截图
  超出单图预算时，必须先经现有 `ImageProcessorPort` 缩放/转码后再构造展示事实，不得直接放宽持久化预算。
- Browser 截图源图为 PNG。源图尺寸与字节预算都满足时直接保留；源图仅字节超预算时，允许再尝试一次
  原尺寸优化 PNG。该候选仍不满足预算后，压缩状态必须单向进入 JPEG：先在受 `maxDimension` 约束的
  最大可用尺寸依次尝试 quality `80 / 60 / 40 / 20`，再按 `75% / 50% / 25%` 逐级缩小并重复 JPEG
  quality，最后才走既有低质量、小尺寸 JPEG fallback。进入 JPEG 分支后不得再尝试量化 PNG 或缩小后的
  PNG，避免较大尺寸 JPEG 尚可满足预算时先返回低分辨率 PNG。
- 展示数据使用严格 schema；未知/损坏 payload fail closed，不回退显示 `[Attached image/png: MCP image]`。
- 日志不记录图片 base64、页面正文或完整 URL query/hash；高频调用标记使用 `debug`，单次自动截图失败使用
  `warn`，正常跳过使用 `debug`。
- fork/compact/cold resume 只复制或恢复已持久化的轮尾事实，不重新截图。

压缩候选状态机：

```text
PNG source
  ├─ 原始 PNG 满足尺寸与字节预算 -> original PNG
  ├─ 原尺寸优化 PNG 满足预算     -> optimized PNG
  └─ 原尺寸优化 PNG 仍超预算
       -> JPEG-only
            ├─ 最大可用尺寸 × quality 80 / 60 / 40 / 20
            ├─ 75% × quality 80 / 60 / 40 / 20
            ├─ 50% × quality 80 / 60 / 40 / 20
            ├─ 25% × quality 80 / 60 / 40 / 20
            └─ aggressive JPEG fallback
```

代表组合按不变量剪枝，不与 tab、turn、client mode 做全排列：

| Case    | Setup                              | Action            | Assertion                                         | Evidence              |
| ------- | ---------------------------------- | ----------------- | ------------------------------------------------- | --------------------- |
| BTA-C01 | PNG 原图已满足尺寸与字节预算       | `prepareForModel` | 字节、MIME、尺寸不变，strategy=`original`         | adapter unit          |
| BTA-C02 | PNG 原图超预算、原尺寸 JPEG 可满足 | `prepareForModel` | 输出 `image/jpeg`，宽高不变，不返回缩小 PNG       | adapter unit          |
| BTA-C03 | PNG 原图与原尺寸 JPEG 都超预算     | `prepareForModel` | 后续候选保持 `image/jpeg`，按既有比例缩小至预算内 | adapter unit          |
| BTA-C04 | JPEG、GIF、WebP 输入               | `prepareForModel` | 沿用既有格式入口与失败合同                        | existing adapter unit |

## 6. 验收

1. Browser API 成功 + 正常结束：同轮 Website/file preview 与 file diff 摘要之后、消息操作栏之前出现一张 active tab 截图。
2. 本轮显式 `emitImage`：工具结果保留显式图片，最终回答后仍独立追加 active tab 自动截图。
3. 仅文档、browser discovery、capability 或失败调用：不追加截图。
4. Stop/取消/失败、scope 内已无存活 tab、截图失败：对话终态不受影响，无空白占位。
5. 刷新、冷恢复和手机 replayable snapshot 后，截图仍在同一轮尾且只出现一次。
6. 截图沿用现有 Node REPL 图片样式：左对齐、border 紧贴实际图片、桌面和手机窄屏不横向溢出。
7. 同一 session 连续多轮调用 Browser API 时，每一轮独立检测、截图与持久化；上一轮的截图或 cleanup
   不得抑制下一轮。复杂页面的原始 PNG 超过展示预算时，压缩后仍须正常展示。
8. 原尺寸优化 PNG 超预算后，后续持久化候选只能是 JPEG；若原尺寸 JPEG 已满足预算，不得降低图片宽高。
9. 会话全程在后台（side pane 未展开，或该 browser tab 未被选中）：仍按上述规则追加轮尾截图。renderer
   在后台只上报 `attachGuest({ active: false })`，这**不**构成第 4 条的「无存活 tab」——main 的
   effective active 回退保证 scope 内只要还有存活 tab，`tabs.list()` 就有唯一 `active`，见
   `2026-07-12-browser-tab-selection-activation-spec.md` 的「系统 effective active 回退」。

## 7. 大图查看交互

Node REPL 工具结果截图和自动轮尾截图必须复用同一个 renderer-only 大图查看器，不新增
conversation fact、协议字段或持久化状态：

```text
缩略图
  -> 单击
  -> 全屏遮罩 + 当前图片按视口等比适配
       ├─ 单击图片或遮罩空白 -> 关闭
       ├─ 单击右上角关闭     -> 关闭
       └─ Escape              -> 关闭
```

- 桌面端、普通 Web 和手机 `/remote` 使用相同交互；手机 replayable 只负责恢复原图片事实，
  不同步遮罩开关状态。
- 大图保持原图片比例，最大宽高不能超出当前视口；高度方向至少预留 96px 的查看器安全空间，
  避免图片贴满窗口后与关闭按钮、桌面标题栏争用右上角；不支持滚轮缩放、拖拽或平移。
- 缩略图保留左对齐、紧贴图片的 border 与窄屏无横向溢出合同；打开大图不能改变原工具块或轮尾块布局。
- 缩略图入口、右上角关闭按钮和 Escape 均需可访问；关闭后焦点返回触发缩略图。
- 多图结果按所点击图片分别打开，遮罩只展示当前图片，图片数据与原 `node_repl_images` fact 保持一致。
- Windows 桌面端的关闭按钮必须位于原生 `titleBarOverlay` 下方，并向视口内侧留出额外间距；
  位置优先使用 Window Controls Overlay 的真实 `titlebar-area-height`，不因 DPI 或 ZCode 页面缩放
  回到原生关闭按钮命中区。Windows 大图的最大高度必须同步扣除上下两侧标题栏安全高度，
  使图片顶部与关闭按钮底部至少间隔 8px；不能只移动按钮而保留原图片高度。macOS、Linux、
  普通 Web 和手机 `/remote` 不继承该 Windows 安全区。

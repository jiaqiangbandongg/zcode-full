ZCode CUA AX 树优化方案
本文给出 ZCode Computer Use（CUA）AX 树的完整优化方案，覆盖数据采集、跨平台归一化、模型可见格式、稳定节点身份、full/delta/no-change 状态、复杂 Web 树裁剪、动作后验证、持久化恢复、迁移和量化验收。方案基于 ZCode CUA 的真实 Calculator、TextEdit、System Settings、Chrome 轨迹分析。

核心结论：目标架构保留 ZCode 的 state_id、window owner、坐标系和 stale 校验等执行安全与跨平台契约，同时采用层级语义表示和真正的增量 patch，降低模型上下文成本。
1. 实测基线

以下为 ZCode CUA 在真机轨迹上的现状测量：

| 场景 | ZCode CUA 实测 |
|---|---|
| Calculator full | 约 9,435 字符 / 58 元素 |
| Calculator 小变化 | 9,351–11,684 字符（仍倾倒完整树） |
| TextEdit full | 3,636 字符 / 29 元素 |
| TextEdit no-change | 仍返回约 3.6–4 KB 完整树 |
| 复杂浏览器页 | 5,015–8,757 字符（不能只按长度判断质量） |

ZCode Calculator 同一会话 11 个带 state_id 的结果合计 112,279 字符，平均每次约 10,207 字符。ZCode 的 changes 当前只是附加摘要，并没有替代完整 elements。
2. 两种模型格式的差异
2.1 目标格式：层级文本 DSL
目标 full DSL（完整规格见第 8 节）
@state s-4 mode=full app=Calculator window=main
0 window "Calculator"
  1 region "Keypad"
    6 text "Display" value="46"
    14 button "All Clear" [press]
    23 button "7" [press]
目标 delta DSL
@state s-5 base=s-4 mode=delta
~ 6 value="7"
~ 14 name="Clear"
目标格式用缩进保留父子关系，以连续 index 作为动作句柄，把 role、selected/editable/expanded、Description、Help、ID 和 Secondary Actions 内联到单行。小变化用 +、~ 和 removed ID range 表达；无变化只返回 no-change 与焦点。该格式面向模型，不承担跨进程结构化契约。
2.2 现状：扁平 JSON 快照
ZCode compact state
{
  "state_id": "s-3",
  "focused_element": 18,
  "readable_text": ["Untitled"],
  "elements": [
    {
      "index": 18,
      "kind": "textarea",
      "name": "First Text View",
      "editable": true,
      "focused": true
    }
  ],
  "changes": {
    "added": [],
    "removed": []
  }
}
ZCode 的 app、window、state、coordinate space、elements、changes 和 action outcome 边界清楚，kind 屏蔽 macOS AX、Windows UIA 和 Linux AT-SPI 差异，state_id + index 支持过期快照防护。但扁平数组丢失父子上下文，JSON key 重复占用 token，changes 与完整 elements 同时返回，后面还可能附带 top_candidates 和长自然语言指导。
3. 当前核心问题
3.1 changes 不是增量
当前 ZCode 状态流
S0：完整 compact elements
        │
        ▼
      action
        │
        ▼
S1：完整 compact elements
  + changes.added/removed
  + top_candidates 重复元素
  + 静态自然语言指导
即使 added_count 和 removed_count 都为 0，也会重复整个树。动作结果自带 settled state 本来可以减少一次 get_app_state，但完整状态回灌使上下文收益被抵消。
3.2 节点身份与 stale fingerprint 混用
现有 element fingerprint 包含 role、title、value 和 coarse bounds，同时用于 diff identity 与动作 stale/TOCTOU 校验。TextEdit 中同一个 textarea 仅 value 改变，就被 changes 表达为 removed + added；这不是节点替换，而是状态更新。两个用途必须拆开。
3.3 扁平化丢失语义父链
重复的“OK”“Edit”“More”控件需要父节点、row、dialog、toolbar 或 section 才能区分。ZCode compact 只保留扁平 kind/name，模型需要依赖 index、top_candidates 或位置提示猜上下文，无法直接表达“按钮属于哪个区域”。
3.4 复杂 Web 树的预算被容器占满
ZCode Chrome 搜索结果页实测 80 个元素中有 56 个 AXGroup，75 个没有有效 name/value，且 truncated=true。无信息容器先占满 node cap，真正 link/text/button 可能被截掉；反向极端是保留太多重复链接和长 tracking URL，单页体积失控。
3.5 静态指导反复进入结果
Calculator 单次结果前置指导约 728 字符；TextEdit menu-only 失败轨迹总计 3,741 字符，其中约 2,453 字符是策略指导，占 66%。这些内容应属于 skill/tool description 或结构化诊断码，不应随每个状态重复。
4. 目标架构
AX 目标架构
macOS AX / Windows UIA / Linux AT-SPI
                  │
                  ▼
        normalized semantic tree
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
 stable node identity   material fingerprint
   full/delta 对齐       stale/TOCTOU 校验
        │                    │
        ▼                    ▼
 semantic pruning       action verification
        │
        ▼
 snapshot engine
  ├─ full
  ├─ delta
  └─ no_change
        │
        ├─ structured JSON：进程/存储/replay/测试
        └─ compact DSL：模型上下文
内部结构化契约与模型表现层分开：JSON 是事实和恢复协议，DSL 是 token 优化后的模型视图。两者由同一 semantic snapshot 生成，不维护两套行为逻辑。
5. 状态与节点模型
5.1 Snapshot identity
仅 full 观察生成并向模型暴露新的 session state_id。delta/no_change 不 mint 新 id：模型复用其上一次 full 观察持有的 session state_id（实现见 `AccessibilitySession.lastStateId()`），broker 内部仍维护 base_state_id 用于 diff，但不向模型暴露该 broker 计数器 id（它是独立计数器，targeting resolver 无法解析）。delta 必须声明 base_state_id；调用方只有持有 base 时才能应用 patch。compaction、重连、进程恢复、跨页面导航或 base 丢失时强制 full。
5.2 Stable node identity
增加 opaque node_id，用于跨快照识别同一语义节点。优先使用 backend stable native identifier；无法获得时由 window identity、可访问路径、稳定 role/name 与 sibling discriminator 组合。node_id 不包含 value、focus、selected 或临时 bounds。
5.3 Material fingerprint
material fingerprint 继续包含会影响动作安全的 role、title/value、enabled、bounds 与必要 capability，用于 actuation 前重新读取和 stale 判断。它不参与 delta identity。index 保留为当前 snapshot 内的短别名，动作仍提交 state_id + index/node_id。
节点契约
{
  nodeId: "ax:window-3642:path-1.2.18",
  index: 18,
  parentNodeId: "ax:window-3642:path-1.2",
  kind: "textarea",
  name: "First Text View",
  value: "hello",
  capabilities: ["edit", "focus"],
  state: { focused: true },
  materialFingerprint: "mfp:..."
}
6. Full、Delta 与 No-change
delta response
{
  "schema_version": 3,
  "state_id": "s-5",
  "base_state_id": "s-4",
  "mode": "delta",
  "updated": [
    {
      "node_id": "calc:display",
      "index": 6,
      "changes": {"value": "7"}
    }
  ],
  "added": [],
  "removed_node_ids": [],
  "focus": null
}
full。首次观察、base 不可用、window identity 变化、页面/文档导航、大比例节点重建、schema 版本变化时返回 pruned full snapshot。
delta。同一 window/document 且变化节点比例低于阈值时，只返回 added、updated、removed、focus、selection 与 readable text patch。初始建议阈值为 patch 估算字符数小于 full 的 40%；最终阈值由轨迹评测确定，而不是硬编码经验值。
no_change。semantic tree、focus、selection 和关键 readable text 均未变化时，只返回 state_id、base_state_id、mode=no_change、重复观察计数与必要的一句 next action。目标长度不超过 200–300 字符。
checkpoint。连续 delta 达到固定数量、上下文即将 compact、mobile replay gap、调用方显式请求或服务端判断 base 风险升高时发送 full checkpoint。delta 永远不能依赖调用方不可恢复的 renderer-local 状态。
7. 语义裁剪与层级保留
裁剪顺序从“节点出现顺序”改为“信息价值”。先保留 focused、editable、pressable、selectable、selected/checked、错误/状态节点；再保留有可读 name/value 的 text/link/button/menuitem；然后为已保留节点补齐最短父链。纯布局容器默认折叠成 section/container summary，只有承担 disambiguation 时保留。


节点类型

默认策略

例外

focused/editable/actionable

始终保留

安全字段 value 必须屏蔽

selected/checked/error/status

始终保留状态

重复状态合并

text/link/button

有 name/value 时保留

重复 link 合并

group/container

折叠或省略

作为父级消歧时保留摘要

offscreen/invisible

默认省略

可滚动目标或菜单按需保留

disabled

低优先级

用户正在处理禁用原因时保留
预算从固定 node count 改为字符/token 预算与语义配额并用。响应应包含 omitted_counts_by_kind、truncated_reason 和可调用的 get_element_subtree(node_id) / get_more_elements(cursor)。不能让 56 个空 AXGroup 抢占全部预算。
8. 模型可见 DSL
模型层使用稳定、无平台前缀、保留最短父链的文本 DSL。内部仍持有完整 JSON。DSL 只是一种 serializer，不是新的事实源。
建议 full DSL
@state s-4 mode=full app=Calculator window=main
0 window "Calculator"
  1 region "Keypad"
    6 text "Display" value="46"
    14 button "All Clear" [press]
    23 button "7" [press]
@focus none
@omitted container=4 disabled=1
建议 delta DSL
@state s-5 base=s-4 mode=delta
~ 6 value="7"
~ 14 name="Clear"
@focus none
DSL 中保留 index、kind、name/value、关键状态与 capability；Help、native role 按 subtree 拉取；actions 已在 compact 中无条件返回，bounds 不再对模型暴露。长 URL 默认保留 origin/path 摘要，移除 tracking query；用户明确处理 URL 时再请求 full value。
9. 动作结果与观察合并
ZCode 当前动作后 settled state 是正确方向，但返回内容应改为 action_outcome + delta/no_change。动作执行、验证和后观察仍在同一 transaction/锁语义内，避免为了 token 优化重新引入 TOCTOU。
动作结果
{
  "action_outcome": {
    "status": "verified",
    "target_node_id": "calc:equals"
  },
  "state": {
    "state_id": "s-6",
    "base_state_id": "s-5",
    "mode": "delta",
    "updated": [
      {"node_id": "calc:display", "changes": {"value": "46"}}
    ]
  }
}
如果 return_state=none，仅返回 outcome 和明确的 state_available=false；如果动作无效果，返回 no_change + no_effect 原因；如果窗口关闭、权限回退或 base 无效，返回结构化 recovery code，不重复一大段策略说明。
10. 浏览器与大树策略
同文档内输入、展开、选择和局部加载可使用 delta；跨 URL/document navigation 默认 full。判断依据不是 App 名称，而是 document identity、root signature 和节点复用率。
Web pruning 需要额外规则：合并同一卡片的 image link/title link；空 group 只保留必要父链；URL 删除 tracking query；长聚合文本按来源拆成 text nodes；优先 viewport、focused、interactive 与 selected；超预算时按 section 分页。对于 canvas/AX sparse 页面，明确返回 state_quality=visual_required，避免伪造空树可用性。
11. 截图与 AX 的协同
AX-first 的默认 include_screenshot=false 保留，这一点优于每次观察都捕获图片。只有视觉读取、state_image coordinate、AX sparse 或显式用户截图时才捕获。图片通过 media block/artifact 传输，不放进 AX JSON 或日志。
当返回 screenshot 时，snapshot 记录 window、display provenance、device pixel ratio、image region 和 media ref。AX delta 与图片 dirty crop 使用同一 state_id/base_state_id，但任一方缺失不能让另一方不可解析。桌面 continuous 和手机 replayable 共享持久化 snapshot fact。
12. 跨平台与恢复
normalized kind、capability 和 state 字段跨 macOS AX、Windows UIA、Linux AT-SPI 一致；native role、native action 和 backend handle 只存在 adapter/private state。node_id 可以包含 backend namespace，但调用方将其视为 opaque。
snapshot/delta 必须可持久化并运行时 schema 校验。移动端 replay gap、进程重启、服务端 LRU 淘汰、session fork 或 base_state_id 不存在时请求/推送 full checkpoint。desktop continuous 不拼接手机 replayable 专用恢复消息。
13. 迁移计划


阶段

内容

兼容策略

P0 基线

锁定 Calculator、TextEdit、Settings、Chrome 的字符、token、成功率、节点保留率与延迟。

不改变现有输出。

P1 Identity

引入 node_id；拆分 stable identity 与 material fingerprint；增加 updated diff。

旧 state_id+index 继续可用。

P2 Snapshot

增加 schema_version、base_state_id、mode 和 full/delta/no_change。

能力协商；旧客户端继续收到 full。

P3 Pruning

语义预算、父链、容器折叠、Web 去噪、subtree/cursor。

subtree/cursor 保留诊断入口。

P4 DSL

模型上下文切到 compact DSL；JSON 用于事件、存储和调试。

双 serializer 对照期，行为来自同一 snapshot。

P5 Rollout

灰度开启 delta；监控 action success、stale、reobserve、token 与恢复错误。

出现 base/diff 异常自动回退 full。
14. 代码影响面
src/zcode_cua/accessibility/models.py：增加 node_id、parent_node_id、semantic state/capability。
src/zcode_cua/accessibility/state.py：拆分 identity/material fingerprint，实现 updated/full/delta/no-change。
src/zcode_cua/accessibility/filtering.py：语义评分、父链和字符预算。
src/zcode_cua/platforms/macos_ax.py、Windows UIA、Linux AT-SPI：提供 backend stable identity 候选。
src/zcode_cua/observation/presentation.py：动作结果返回 delta/no-change，移除重复指导。
src/zcode_cua/tools/observation_tools.py：能力协商、snapshot mode、subtree/cursor 工具契约。
ZCode protocol/event/projection：持久化 snapshot/delta 与 base dependency，支持 replay/cold recovery。
15. 测试方案
Identity 单测。value、focus、selected 改变不改变 node_id；窗口/文档/语义路径变化正确换 id；重复兄弟节点稳定消歧；material fingerprint 对影响动作安全的变化敏感。
Diff 单测。updated/added/removed/no-change、重复节点、focus、父节点变化、base mismatch、阈值回退 full、patch 应用后与新 full 完全一致。
Pruning 单测。actionable、focused、readable text 不丢；空 group 不占满预算；父链最短且足以消歧；secure field 永不输出 value；长 URL 去 tracking。
跨平台合约。同一 fixture 在 AX/UIA/AT-SPI 得到一致 kind/capability/state；native role 不泄漏到 compact DSL；Windows DPI、macOS Retina、Linux X11 坐标元数据保持现有安全语义。
轨迹 E2E。Calculator 连续运算、TextEdit 输入与保存面板、System Settings 页面切换、Chrome 同页交互与跨页导航、AX sparse/canvas、权限回退、窗口关闭、mobile replay gap 和 session cold restore。
16. 指标与目标


指标

建议目标

说明

Calculator warm full

不高于 4–5 KB

当前约 9.4 KB，目标收紧一半以内

原生 App 小变化 delta

不高于 full 的 20%

Calculator/TextEdit 目标可进一步达到 5–10%

no-change

不高于 300 字符

只含状态链与必要诊断

复杂 Web full

按模型 token budget

优先保证语义节点，不追求单纯短

 retained semantic ratio

持续上升

保留节点中 actionable/readable/stateful 的占比

base/delta 恢复错误

接近 0

错误自动 full checkpoint

action success/stale false positive

不劣于当前基线

token 优化不能牺牲动作正确性

重复观察次数

显著下降

no-change 和 action outcome 应阻止观察循环
运行时延迟需要单独基准：启动/settle 与序列化不能混为一个指标。ZCode 应拆分 backend capture、normalize、prune、diff、serialize、image capture 和 transport duration，分别设定目标。
17. 验收标准
state schema 明确区分 full、delta、no_change，并带 schema_version。
delta 总是声明 base_state_id，base 丢失可自动回退 full。
stable node_id 与 material fingerprint 分离。
TextEdit value 变化表达为 updated，而非 removed + added。
Calculator 小变化不再重复完整 58 元素树和 top_candidates。
复杂 Web 树不会被无名 group 占满预算。
模型 DSL 保留必要父链，内部 JSON 可完整 replay。
action result 返回 outcome + delta/no-change，不增加额外观察轮次。
secure field、剪贴板、密钥和敏感 value 不进入模型与日志。
macOS、Windows、Linux 与 desktop/mobile 恢复链通过测试。
上下文成本显著下降且 action success、stale 防护不退化。
18. 风险与取舍
Delta 依赖 base。如果模型上下文 compact 或 mobile replay 丢失 base，patch 会不可读。必须由 snapshot engine 管理 checkpoint，而不是把责任交给 renderer 或 prompt。
稳定 node identity 不可能在所有 App 完美。没有 native identifier 的动态 Web/Canvas 节点只能使用启发式路径。identity confidence 低或 tree rebuild 比例高时直接 full，不能为了 delta 率强行匹配。
裁剪可能隐藏必要信息。因此保留 subtree/cursor 与 omitted summary；验收以任务成功率和语义保留率为准，不以最短字符为唯一目标。
双格式维护风险。JSON 与 DSL 必须由同一 snapshot serializer pipeline 生成；禁止两套独立过滤和 diff 逻辑，否则会出现模型所见与执行 state 不一致。
19. 轨迹与实现参考
ZCode Calculator：~/.zcode/cli/debug/model-io-sess_4c0dec29-abc9-45db-b92a-85b734cfa5eb.jsonl
ZCode TextEdit：~/.zcode/cli/debug/model-io-sess_9ce83024-e3ca-4a27-8bb7-352186b9c06e.jsonl
ZCode Chrome：~/.zcode/cli/debug/model-io-sess_d7748be0-9015-464e-b6e1-7e35b3c8563c.jsonl
核心实现：src/zcode_cua/accessibility/state.py、models.py、filtering.py、observation/presentation.py。


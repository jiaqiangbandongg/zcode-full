# Ghost cursor overlay 多显示器可见性（窗口跟随目标屏）

## 问题

ghost cursor 的 overlay 原先是**一个**覆盖全部显示器并集（`ComputeDisplayUnion()`）的
borderless 窗口。macOS 默认开启「显示器具有单独的空间」（`com.apple.spaces spans-displays`
未设置 / 为 false），此时一个窗口横跨多块屏只会出现在**它占面积最大的那块屏**上，其余屏上的
那部分画布根本不上屏。

实测（2026-10-10，主屏 1512×982 + 外接 2560×1440 位于左侧）：并集窗口为
`[-2560,-458, 4072×1440]`，只出现在外接屏；CUA 在笔记本屏上的全部动作反馈（glide、涟漪、
focus-rect、键盘 cue）永远不可见，而 native 的 `ghostState().shown` 仍报 `true`。单屏时并集
就是那块屏，因此问题只在多屏 + 默认 Spaces 设置下出现。

## 决策

overlay 仍是**单窗口**，但窗口 frame 由「整个并集」改为「**当前反馈点所在的那块屏**」：

1. 每次把反馈落到一个全局 DIP 点之前（指针移动、点击涟漪、focus-rect、屏幕配置变化），
   先算出该点所在的 `NSScreen`，若与窗口当前 frame 不同则 `setFrame` 到那块屏。
2. 换 frame 时沿用 `ScreenParamsChanged` 的保位逻辑：先按旧 frame 把 dot/bloom 的位置
   读回全局 DIP，换 frame 后再映射回新的 content-local 坐标。
3. 点不落在任何屏内（屏幕刚被拔掉的竞态等）时回退到最近的屏，再回退到主屏，不抛错。
4. 坐标系不变：layer 写入继续经 `GlobalDipToContent`（以 `g_window.frame` 原点换算），
   CG 全局坐标→NS 全局坐标的翻转基准仍是主屏高度。

### 已知代价

跨屏 glide 在屏幕边界处会跳一下：窗口切到新屏后，旧屏上那段动画路径不在窗口内。CUA 的动作
通常落在单个目标窗口内，跨屏移动罕见，可接受。

## 第二个根因：翻转基准误用 key window 所在屏

窗口跟随修好后真机仍复现「外接屏上点击搜索框看不到光标、在地图区滚动却能看到」。原因是 CG
全局坐标（左上原点）与 NS 全局坐标（左下原点）互转时，翻转基准高度取的是
`NSScreen.mainScreen`。它的语义是**key window 所在的屏**，并不是原点 (0,0) 的主显示器：焦点在
外接屏时返回 2560×1440，基准就从主屏的 982 错成 1440，所有反馈整体下移 458px。外接屏顶部那段
落到 overlay 窗口之外，所以顶部搜索框的点击不可见、靠下的地图区可见。

决策：所有翻转、frame 回读、兜底 frame 一律使用 `PrimaryScreenFrame()`（`[NSScreen screens]` 的
第一块屏，即主显示器）。CG 全局坐标本就以主显示器左上角为原点。该问题与焦点在哪块屏有关，
早先 live 用例通过只是因为当时焦点恰好在主屏。

### 未选方案

「每块屏一个 overlay 窗口」能保留跨屏动画，但显隐、层级、遮挡 probe 对 overlay 自身的排除
（`g_window_server_id`）、capture 开关都要改成多窗口，改动面与风险都明显更大。

## 不变量

- 反馈点所在屏与 overlay 窗口 frame 一致：`ghostState().windowFrame` 等于该点所在屏的
  frame（CG 全局 DIP，左上原点）。
- 换 frame 前后 dot 的屏幕位置不变（不跳位）。
- overlay 窗口身份（window number）不变，遮挡 probe 排除自身的逻辑无需改动。

## 验证

- 源码契约：窗口 frame 不再取 `ComputeDisplayUnion()`；`MoveGhostTo` / 涟漪 / focus-rect /
  `ScreenParamsChanged` 都先经 `EnsureWindowOnScreenForGlobalDip`。
- live（`ZCODE_CUA_LIVE_NATIVE=1`）：对每块活动显示器的中心点 `ghostMove`，断言
  `windowFrame` 等于该显示器 bounds。
- 真机：多屏 + 默认 Spaces 下，光标在两块屏上都能被肉眼看到（截屏对该窗口无效，默认
  `NSWindowSharingNone`）。

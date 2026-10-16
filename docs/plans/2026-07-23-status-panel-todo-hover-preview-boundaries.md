# Status Panel Todo Hover Preview Boundaries

## Feature Summary

| Field | Value |
| --- | --- |
| Change | 将 Todo 隐藏分组从面板内点击展开改为左侧 HoverCard 预览 |
| User-visible surfaces | V4 Status Panel 的“已完成 n 项 / 待处理 n 项”入口 |
| Existing reference | Goal iteration Todo hover preview：`028be830cd` 至 `ff372381e1` |
| State owner | renderer-local HoverCard open state；Todo snapshot 仍由 plan model 权威提供 |
| Out of scope | Todo 排序、三条聚焦窗口、协议、session/store 持久化 |

## Clarification Log

| Round | Question | User answer | Boundary fixed |
| --- | --- | --- | --- |
| 1 | 是否继续点击后在面板内展开 | 否，hover 后在左侧显示 | 明细不再进入 Status Panel 文档流 |
| 2 | 视觉与交互参考 | 之前 Goal item hover 卡片 | 复用 HoverCard 的延迟、方向、间距、尺寸与滚动合同 |
| 3 | 完成方式 | 使用 goal 完成 | 规格、实现、测试、运行时证据和提交均纳入验收 |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes |
| --- | --- | --- | --- |
| 桌面指针 | hover / focus 打开，离开触发器和卡片后关闭 | 入口到卡片可穿越 | 面板内插入明细 |
| 无 hover 输入 | 点击入口打开同一 HoverCard | 手机 Web、触屏、键盘 focus | 新建移动端专用 UI |
| 放置 | `left + start + 4px`，空间不足时交给 Radix collision | Goal 卡片同款位置 | 固定屏幕坐标 |
| 内容 | 原序展示窗口前/后位置桶，单项最多两行；仅在桶内 status 纯净时使用“已完成/待处理”，混合时使用“前面/后面” | 卡片内部滚动 | model 截断、重新排序或用位置桶虚报状态 |
| snapshot | id / content / status 变化后关闭旧卡片并重算分组 | renderer key 重建 | 持久化打开状态 |

## State And Event Flow

```text
plan snapshot
    |
    +--> getStatusPanelTodoFocusWindow()
            |
            +--> focusItems ----------> Status Panel 固定三条
            |
            +--> completed/waiting ---> HoverCard trigger
                                            |
                           hover/focus/click
                                            v
                                      左侧预览卡片
                                      (独立滚动)

snapshot signature changes
    --> PlanStatusItems remount
    --> HoverCard open state reset
```

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence |
| --- | --- | --- | --- | --- |
| THP01 | 仅窗口前有隐藏项目 | hover / focus 上方入口 | 左侧显示完整已完成分组，面板高度和三条窗口不变 | component + CDP |
| THP02 | 仅窗口后有隐藏项目 | hover / focus 下方入口 | 左侧显示完整待处理分组，内容可滚动 | component + CDP |
| THP03 | 前后均有隐藏项目，且任一位置桶含混合 status | 依次 hover 两个入口 | 同时最多一个对应预览，分组不串联；混合桶使用中性位置文案 | component + CDP |
| THP04 | 无 hover 输入 | 点击入口及外部 | 点击打开同一预览，不在面板内展开；失焦后关闭 | component + mobile follow-up |
| THP05 | 预览已打开 | Todo snapshot 更新 | 旧预览关闭，入口和内容按新 snapshot 重算 | component key + CDP |

## Pruning

- `desktop-continuous` 与 `web-remote-replayable` 只共享 renderer 投影，不扩展协议状态组合。
- theme / locale 由 HoverCard、语义色和现有 i18n 文案保证，不做全排列。
- workspace identity、provider、runtime 状态不影响纯 renderer 派生预览。

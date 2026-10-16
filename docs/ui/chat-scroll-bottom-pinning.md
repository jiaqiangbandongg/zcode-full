# Chat scroll bottom pinning

> **V4 当前事实**：`ConversationTimeline` 持有底部跟随与滚动记忆接线；记忆模块为
> `packages/ui/src/lib/chatSessionScrollMemory.ts`。

V4 timeline 维护一个显式吸底状态机：

- `isPinnedToBottom=true` 表示当前视口吸附在消息底部，流式输出、thinking shimmer 和消息布局变化时自动跟随到底部。
- `isPinnedToBottom=false` 表示用户已经离开底部，流式输出不得覆盖用户当前阅读位置。

```text
                         用户回到底部 / 点击“回到底部”
                    ┌──────────────────────────────────┐
                    │                                  v
┌──────────────────────────┐  用户向上滚动且可离底  ┌──────────────────────────┐
│ FOLLOWING                 │ ─────────────────────> │ DETACHED                  │
│ 内容增长/缩短都继续贴底   │                        │ 所有布局变化都保持阅读权   │
└──────────────────────────┘                        └──────────────────────────┘
          │                                                     │
          │ running -> terminal：live tail 虚拟化、              │ terminal 折叠、测高、
          │ “工作中”历史自动折叠、动态测高                       │ virtualizer 补偿
          └────────────── 保持 FOLLOWING ────────────────────────┴─ 保持 DETACHED
```

`FOLLOWING / DETACHED` 表达用户滚动意图，不是每次读取
`scrollHeight - clientHeight - scrollTop` 得到的瞬时几何结果。终态切换会让 running live tail
迁入虚拟历史，同时把“工作中”历史折为“已工作”；virtualizer 的估算、真实测高和折叠动画会在
连续多个布局阶段改变 `scrollTop`。这些变化不是用户上滚，不能把 `FOLLOWING` 误判成
`DETACHED`。

## 行为

- 打开 task 时优先读取滚动记忆；如果记忆里记录离开前处于吸底状态，则切回时执行一次滚动到底部并继续保持吸底；否则恢复保存的历史阅读位置。没有滚动记忆时滚动到底部并进入吸底状态。
- 用户滚动后，如果 `distanceToBottom > 48px`，立即退出吸底状态。
- 用户回到底部附近或点击“滚动到底部”按钮后，恢复吸底状态。
- running assistant 进入 terminal 时，如果切换前仍是吸底状态，则 live tail 迁入虚拟历史、assistant history 自动折叠和后续动态测高期间都继续贴底。
- 用户已经离底，或在终态布局变化同一帧发起向上滚动时，用户输入优先；终态切换不得恢复吸底，也不得把视口拉回最新消息。
- 对话内查找、全局搜索结果高亮和 fork 锚点属于定位型滚动，触发前必须退出吸底状态，避免下一次流式布局更新把定位结果拉回底部。
- “回到底部”按钮只在离底且存在 render unit 时显示；内容没有纵向溢出时不显示。

## 滚动事件优先级

```text
同一帧内：用户滚动意图 > 显式定位动作 > 内容/测高/折叠布局变化
```

| 事件来源                                        | FOLLOWING 时          | DETACHED 时               |
| ----------------------------------------------- | --------------------- | ------------------------- |
| wheel/touch/键盘/滚动条向上离底                 | 立即转 DETACHED       | 保持 DETACHED             |
| 用户滚回底部附近                                | 保持 FOLLOWING        | 转 FOLLOWING              |
| 点击“回到底部”或提交立即开始的新 prompt         | 保持 FOLLOWING 并贴底 | 转 FOLLOWING 并贴底       |
| live delta、terminal 折叠、virtualizer 测高补偿 | 保持 FOLLOWING 并贴底 | 保持 DETACHED，不夺滚动权 |
| 查找、轮次导航、fork 锚点定位                   | 先转 DETACHED 再定位  | 保持 DETACHED             |

## 实现边界

- 会话流滚动视口使用 `scrollbar-gutter: stable` 预留原生纵向滚动条空间，避免内容在滚动条出现或消失时发生横向位移；桌面端与手机 Web 复用同一规则。
- 自动吸底使用 `scrollRef.current.scrollTop = scrollHeight - clientHeight`，避免流式输出期间连续 smooth scroll 造成抖动。
- 用户点击“回到底部”或提交需要定位到最新消息的 prompt 时，使用 instant `scrollTop` 写入并立即进入吸底状态；同一处理内必须同步提交当前 session 的吸底记忆，不能等待后续 `scroll` 或 scope cleanup，确保紧接着切换 session 仍按“吸底”恢复。
- `scroll` 事件只有在关联到真实用户滚动输入时才允许改变吸底意图；组件自身贴底以及 virtualizer/折叠/测高造成的 `scrollTop` 变化只更新几何账目，不改变 `FOLLOWING / DETACHED`。用户向上滚动的输入在浏览器派发 `scroll` 之前先登记，因此与 terminal commit 同帧时也能优先解除跟随。
- 滚动记忆只保存 renderer-local 的阅读位置和吸底意图；切到别的 task 后后台继续流式输出时，原本吸底的 task 切回必须重新吸到底部，避免旧 `scrollTop` 被当成用户阅读历史位置。
- 用户滚动、scope 变化和 timeline 卸载都会保存当前状态；scope 变化使用 React before-mutation snapshot 读取旧 DOM，并对账尚未派发的上滚/下滚，避免快速“滚动后切走”被新会话 DOM 覆盖或误存为吸底。
- 会话恢复时 rows 可能晚于 session scope 到达；“回到底部”按钮可见性必须在 rows/测高就绪后重新对账。只要恢复意图是离底且已有可滚动内容，就必须提供按钮；不得因为恢复瞬间 `rowCount=0` 而永久隐藏，也不得出现视口明显离底但逻辑仍显示为吸底的状态。
- session scope、lease 与 rows 必须来自同一会话：lease 尚未匹配目标 session 时 timeline 暂不消费旧 projection。非空 tail window 或未完成测高把离底位置钳制到临时边界时，保留原始恢复意图；历史补齐后重新落地，期间 prepend 锚定不得把临时钳制位置升级为最终阅读锚点。真实用户滚动仍拥有最高优先级并立即取消待恢复意图。
- 记忆按 workspace key、pane 与 session/task scope 隔离，最多保留 200 项；只持续到当前 renderer 结束，不跨刷新、应用重启或设备同步。
- 本功能只影响 renderer 内部滚动位置，不改变 desktop continuous 和 web remote replayable 的 task 消息语义。

## 覆盖决策

- 接受 `following=true` 的 running -> terminal 折叠/虚拟化路径，以及 `following=false` 和“用户上滚与 terminal 同帧”的竞争路径。
- desktop `desktop-continuous` 用 controlled-stream E2E 代表真实流式和终态时序；最终正文使用足够长的自然文本，即使模型不遵守显式换行也能稳定产生可滚动高度。
- 手机 Web 与桌面复用 renderer 滚动状态机，以 focused test 证明输入来源和状态优先级；本修复不新增 snapshot、queue、owner、relay 或 `web-remote-replayable` 状态，不把 desktop 的 renderer-local 滚动位置同步到手机。
- reasoning/tool/subagent 的具体内容形态、主题和 locale 不改变滚动权归属，不做笛卡尔积；E2E 选择一段可折叠 assistant history 作为代表。

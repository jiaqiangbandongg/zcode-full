# MCP 页面保留与后台执行

## 问题与边界

协议握手早于编辑器初始化完成；session 停止也不代表插件没有内部工作。
宿主不能从这两个状态推断任意插件何时可以停帧，更不能要求插件增加私有执行上报。
无锚点时等待 React 挂载、将 guest 置于 `display:none`、按空闲期限销毁 guest，
都会使后台初始化或依赖 `requestAnimationFrame` 的操作失败。

## 生命周期

### 首次打开与会话恢复的连接屏障

会话恢复完成不等于目标 MCP 已连接。`mcp/uiOpenInstance` 必须等待该 server 已有的
连接任务完成，再读取连接身份并签发页面凭证。等待由 MCP adapter / pool 持有，不等待
其它 server，不重新连接，不在 UI 增加轮询、延迟或自动重试计数。

```text
session 恢复 → 打开 App → 等待目标 MCP 现有 connecting
                            ├─ connected → 校验 session / lease / 连接身份 → 创建页面
                            └─ failed / owner 已释放或替换 → 拒绝创建
```

已有页面的同步身份校验不等待、不重连。连接失败仍显示错误并保留重新加载入口。
等待期间关闭或替换会话、释放 lease 或更换连接时，旧请求不得给新 owner 签发凭证。
Web / 手机 / remote 的不支持回退与 continuous / replayable 边界不变。

回归 `PLM-UI-CONNECTION-READY`：真实 Electron 页面在 MCP initialize 被控制闸门阻塞时
保持准备中；放行后无需点击重新加载即可运行，且只创建一个实例。adapter / pool / 协议
单测覆盖失败、并发等待和 owner 失效。入口沿用 `--managed-only`。

```text
当前执行的成功 UI 工具结果 → 窗口级接收器 → page owner 准入 → 立即创建 guest
历史卡片 / 手动面板打开 ────────────────────┘       （不等待展示锚点）
                           ├─ 可见：正常展示
                           └─ 不可见：有尺寸、不可交互的后台表面 + 目标 guest 活动
任务删除 / 显式重载 / 来源或 runtime 失效 / 窗口关闭 → 撤销凭证与活动 → 释放 guest 和租约
```

- 所有 MCP 页面使用相同宿主规则，不改插件代码、不新增插件协议、不区分插件名称。
  page owner 在准入完成后立即启动，即使请求方此时已切页、没有绑定锚点。
- 首次创建不能依赖工具卡片或 SessionPane 挂载。Agent 在当前执行的成功工具结果完成投影后，
  经 `v4/plugin-ui/tool-result` 向所属本地宿主发送 UI 描述和原始输入；不要求 conversation 订阅。
  Host 校验 schema、当前 runtime 来源与本地范围，只有可信桌面 attachment 可订阅；窗口接收器
  复用相同逻辑键和准入 Promise。卡片与接收器并发只能创建一个页面。
  历史 hydration、失败、取消和 MCP isError 不产生此通知；不扫描历史或保活所有会话投影。
  后台结果只更新页面的工具数据，不绑定锚点、不抢焦点或改当前侧栏；返回会话后复用同一 guest。
  Web/手机/远程不接收创建副作用，仍使用普通工具记录。页面订阅与删除清理由既有 owner 持有。
- 已创建的 MCP guest 在整个有效生命周期内保持可执行；握手完成、session 空闲、
  停止回合均不改变这个规则。workspace/session 租约与资源 feed 随页面保留；
  session 的执行投影不再作为页面运行的开关。
- 有展示尺寸的内联锚点保留在原滚动树中。没有可展示锚点（含 forceMount 隐藏 tab）
  时迁移到非零尺寸、不可交互的后台表面；恢复展示仍是同一个 guest，不重建编辑器。
- 页面不可见或 owner document 隐藏/窗口最小化时，宿主为对应 guest 保持已有可逆
  capturer 活动。Main 按 sender、sandboxId、initId 校验；旧请求不能控制新实例。
  加载期间提前收到的活动请求保留到 `did-stop-loading` 再启用；DOM 就绪事件中仍可能处于加载态，不能吞掉首次请求。
  不设置全窗口 `backgroundThrottling:false`，不唤醒不属于该生命周期的普通页面。
- MCP 页面拒绝自动 `suspend()`；切页、离屏五分钟和容量压力不能丢失插件的内存状态。
  显式 `suspend(true)` 沿用凭证撤销、取消调用、teardown、关闭 guest 和释放租约的路径。
  迟到事件不能重建已删除页面。
- 性能边界：只创建实际请求过的页面；保留最多三十个任务、六十四个活页面的准入限制。
  没有可回收页时拒绝新建，不能淘汰已有 MCP 页面。Main 继续使用已有间隔至少 200ms
  的目标 guest 探测，不引入新的忙闲推断、定时回收或恢复快照。该间隔不是插件帧率上限。
  通用后台执行与保留编辑状态需要资源，不承诺后台零 CPU 或释放这些页面占用的内存。
- Gen UI 沿用连续离屏五分钟和容量回收；普通 Browser、Web/手机/远程的不支持回退不变。
  不预加载全部历史工具行，不承诺应用退出、崩溃或显式重载后的未保存状态恢复。

## 回归契约

使用真实 Electron、生产 page owner、Agent 和无私有执行协议的受控 MCP 页面验证：

| 场景                     | 必须断言                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- |
| 工具结果到达前切离会话   | 无工具卡片、无 conversation 订阅时由真实 Agent 结果创建；后台完成工作，返回复用 guest |
| 无锚点 / 隐藏 tab 冷启动 | session 空闲时完成握手后多帧初始化，页面尺寸非零                                      |
| session 空闲 / 停止回合  | 页面内部 rAF 工作仍能完成，无需新模型回合或宿主工具调用                               |
| 窗口最小化               | 后台操作完成；恢复展示后 guest 身份和编辑状态不变                                     |
| 离屏期限 / 容量压力      | 已有 MCP guest 和内存状态保留，无可回收页时拒绝新建                                   |
| 原生隔离                 | 不唤醒未申请活动的旁路 guest；错 owner / 旧 initId 被拒绝                             |
| 隐藏与恢复               | 后台表面不接收鼠标，内联滚动不漂移，恢复后可正常显示                                  |
| 删除 / runtime 失效      | 活动、guest 和租约释放，迟到事件不复活                                                |
| Web / remote             | 不创建本地沙箱，不产生额外订阅                                                        |

入口：`node packages/desktop/scripts/mcp-apps-host-e2e.mjs --background-only`；
既有生命周期与回退使用 `--managed-only`。真实插件验证直接使用未修改的 PhotoCraft 0.2.2：
`ZCODE_PHOTOCRAFT_SERVER=/path/to/photocraft/dist/server.mjs node packages/desktop/scripts/mcp-apps-host-e2e.mjs --photocraft-background-only`。
macOS Electron 已验证：宿主先最小化再首次创建插件、后台初始化与编辑、跨离屏期限保留和恢复截图 `photocraft-restored.png`。
测试外壳的白底不是插件成功证据，必须结合实际命令结果和恢复截图；该夹具不覆盖商店安装路径。

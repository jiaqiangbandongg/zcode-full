# CUA 截图像素与 Zoom 回归测试记录

状态：producer、独立 MCP、ZCode Agent 与可见 Desktop 的 Kimi K3 真机链路均通过；Skill 精简候选待 MR/CI 复验；透明覆盖窗像素归属修复已在 producer 落地，catalog pin 待 bump

## 0.5.8 透明覆盖窗静默截走坐标点击

0.5.6 把 capture 与 dispatch 的像素归属统一到了 WindowServer 快照，这部分按预期工作；本轮暴露
的是**归属候选本身**的缺口。坐标点击的投递是 `SLEventPostToPid` 定向钉到解析出的 owner 窗口，
背后没有 OS 命中判定，所以「front_to_back 第一个 bounds 含点的窗口」就是命中判定本身。任何盖住
该点的 on-screen 窗口都会截走点击——无论它有没有在那里画过像素，而且工具照样返回 success。

轨迹 `model-io-sess_364a4761`（2026-08-19 19:19–19:53，Helper 3.8.1 / producer 0.5.7）连丢三次
点击，返回体 `resolved_app_ref` 如实记录了投递目标：

| 请求# | 实际收到点击的窗口 | layer | bounds |
| --- | --- | --- | --- |
| 18 | `com.electron.lark.iron`（飞书屏幕共享提示层 LarkSSPromptWindow） | 非零 | `[0,0,1512,982]` |
| 25 | `com.volcengine.corplink.networkextension-wrapper`（飞连网络扩展） | 25 | `[0,0,1512,982]` |
| 31 | `now.typeless.desktop`（Typeless "Status"） | 1001 | `[381,482,750,500]` |

三次 `isError=false`。22 个工具调用耗在定位和挪走这些看不见的窗口上。装了飞连的机器上主屏**任意
一点**都归属到它的包装窗，坐标点击不是偶发出错而是整屏不可用。

排除法和几个显而易见的替代判据都不成立（单机 26 个 on-screen 窗口全量实测）：

- `kCGWindowIsOnscreen` 三者都为 true，本来就是快照的前置条件；
- 窗口级 `kCGWindowAlpha` 是 1.0——内容透明只体现在逐像素 alpha（飞连那个窗口整幅 239 万像素
  均匀 4/255），现有 `alpha<=0` 过滤看不见；
- 按 `layer!=0` 排除会误杀 13 个 layer-25 的 `com.apple.controlcenter` 菜单栏项和 3 个通知中心
  桌面小组件，并且漏掉飞书那个与真窗同 bounds、排在真窗**之前**的 layer-0 幽灵窗；
- `SLSFindWindowByGeometry` 只做几何/形状查询，对同一批点返回同一个覆盖窗；
- per-window `CGWindowListCreateImage` 抓 alpha 能分开，但每个候选 75–85ms，投递路径上不可用。

判据改为窗口自己向 WindowServer 声明的事件掩码：`SLSGetWindowEventMask` 的
`kCGEventLeftMouseDown` 位。覆盖窗实测 `0x00005c28` / `0x00005c08`（该位为 0），所有真实点击
目标实测 `0xee5cffde` 或 `0xee5efffe`（该位为 1）。这也解释了用户为什么没察觉——覆盖窗是点击
穿透的，真实点击本来就穿过去了，只有钉窗口的合成投递会把事件硬塞给一个已声明不收点击的窗口。

投递机制未改动，只是既有 `SLEventPostToPid` 路径之前的候选筛选，后台操作、不抢焦点、不动系统
光标的性质全部保持。fail-closed 报错现在带出被跳过窗口的身份，recovery 指向
`open_application(activate=true)` 抬升目标窗口，而不是去挪用户环境里的覆盖窗。

producer 侧契约与实测数据见上游 `docs/frame-pixel-zoom-regression.md` §v0.5.8。producer 提交
`baa016908`，已随 `da7cbaf241cc2c279fdc4cbd30df9a990db559ec` 合入上游 main，catalog pin 已 bump
到该 sha。真机复验用例：在飞连（或任一透明全屏覆盖窗）在位时对其覆盖区域做纯坐标点击，修复前
静默错投给覆盖窗并返回 success，修复后应命中下方 layer-0 的可见窗口，且 layer-25 的菜单栏状态项
仍可被坐标点击命中。飞书那个与真窗同 bounds、排在真窗之前的 layer-0 幽灵窗是同一类的第二个活体
用例，只按 layer 过滤的方案在它上面仍是死点击。

## 0.5.7 Skill 精简与 Zoom 使用边界

官方 Computer Use Skill 是模型决策指南，不是 producer 开发手册。运行时契约保持
`AX element -> visual fallback -> verify`：只要 AX tree 能定位并表达动作，就使用 element
target，保持后台安全且不抢焦点；只有 AX 无法定位或表达目标时，才请求最终 raster 并使用
coordinate target。

模型只从当前工具结果交付的 raster 读取整数 `(x,y)`，并原样携带相邻的 `frame_id`。所有
resize、byte-budget、Retina/DPI、crop、window/display origin 和 native dispatch 投影均由
`@zcode/zcode-cua` 内部完成，不得要求模型计算。

Zoom 不属于常规流程。当前 raster 中的目标清晰可辨时必须直接点击；只有目标过小或存在
歧义、无法可靠选点时，才把 Zoom 作为最后手段。C07 模型提示与工具 description 使用相同
边界，避免把 `screenshot` 与 `zoom` 并列成默认步骤。

对应 producer 候选为
`52da434158df32f6d0825db6af1c3d263754c44c`（`v0.5.7`）。可见 Dev App 使用 Kimi K3
在不泄露几何坐标的 C07 Canvas fixture 上执行
`list_apps -> get_app_state(include_screenshot=true) -> left_click(strategy=event)`；没有调用
Zoom、没有重复截图，首击由 authenticated DOM oracle 证明 `trusted=true`、`matched=true`。

## 0.5.6 无 AX 截图点击回归

本轮根因是截图 owner 与点击 owner 使用了两套权威：capture provenance 来自
WindowServer，dispatch 前却使用 AX hit-test。全屏 Dock layer-20 管理窗口因此在 capture
侧被误认成 owner，而 AX 命中下层 Chrome，即时点击也被拒绝为
`frame_live_owner_changed`。

修复后的像素链路统一为 WindowServer snapshot。只穿透
`com.apple.dock + 非零 layer + 覆盖完整目标 display` 的管理 surface；小型 Dock、菜单、
弹窗和其他 overlay 均继续阻挡。全图、`get_app_state(include_screenshot=true)` 窗口图与
Zoom 子图都在 Helper 最终派发前比较 capture/live owner、window bounds 和 display
topology，不使用 AX `elementAtPoint`/`captureApp`。element target/AXPress 不变。

C07 保持 canvas 内部目标不可由 AX tree 定位，并补齐 direct MCP 与 ZCode Agent 两层证据。
marker-grid 覆盖 window/full/zoom，记录 raster hash/尺寸、frame id、crop、像素、独立投影点、
capture/live owner、raw dispatch method 和 authenticated DOM hit。该变更不进入 conversation
状态、snapshot/replay 或手机 remote 链路，因此不修改 conversation catalog/matrix。
macOS Accessibility/Screen Recording 已授权；像素实现 producer `625b32ad` 的 direct C07 与
Calculator AX 回归均为 100 分。独立 marker-grid 的窗口帧、全图、Zoom 与 stale-frame
门禁全部通过；可见 ZCode Desktop 中 Kimi K3 也使用窗口截图的精确 `frame_id` 完成了
无 AX canvas 点击。

可见 Desktop 首次回归还暴露了一个独立的开发缓存问题：MCP bundle 正确将原生 `sharp`
保留为 external，但开发态 `~/.zcode/cli/plugins/cache` 只同步 JS 时无法解析该依赖，导致
截图和 Zoom 报 `Cannot find module 'sharp'`。开发缓存现在复用产品打包的 sharp runtime
staging，并有真实 native load smoke；同步后新 MCP 进程上的同一 K3 用例通过。产品包与
开发缓存因此使用同一条原生媒体依赖链路，不再依赖仓库根的 hoist 偶然可见。

## 背景与基线

2026-08-13 的 Godot 国际象棋轨迹来自旧坐标协议。轨迹中，模型在收到
`756×485` 的 Zoom 图后仍提交 `(295,623)`，旧实现拒绝截图坐标后又允许模型改用
屏幕坐标执行；另一次把 `state_id/index` 当作 Zoom 目标，产生了无业务意义的
`12×14` 图像。这两条旧行为现在都必须作为负向回放，而不是成功基准。

像素完整性的最低 producer 基线是
`72a8487d5a1bf1dfa2a31b282aafc4093a997b3e`。候选 producer 必须是该基线的
后继，并保留 `./frame-contract` 导出、不可变 `frame_id`、最终栅格裁剪和 Helper
provenance 门禁。仅提升 package/tag 版本不能替代实现证明。

本轮最终集成候选为
`52da434158df32f6d0825db6af1c3d263754c44c`（`v0.5.7`）。它继承
`611304ccccc92e10cd97635a8cc886e0e2e3519e` 的完整稳定点击基线，并合并
`2fdac16ebef758d7866586d1a9de0fb3ae74e8b4` 的截图点击、Ghost Cursor 和 active HTTP
request lifetime 修复，以及 `d55c5f3a7713a3499bfd7102fd7d2842b53e71ec` 的 producer surface
简化。前者继承
`a0d4eaca6342b3cbff41b444309726873d0f5b11` 的最终栅格与旧棋盘轨迹负向回放，
补齐子 Agent runtime-scope 拒绝的稳定 `structuredContent.code`，并统一 WindowServer
截图/派发 owner 权威与 retained-raster Zoom crop。ZCode catalog
使用精确 commit 锁定，wrapper、bundled skill、Helper runtime contract 与 producer
最终 package 版本统一为 `0.5.7`。

标准 `pnpm dev:desktop` 构建必须无条件把 CUA plugin 视为开发态 filesystem seed，
将 `sharp` 及当前平台 native closure 写入 seed source 后再构建 agent。不能要求调用者额外设置
`ZCODE_CUA_DEV_MODE=1`；否则 bootstrap 会用不含 `sharp` 的同版本 seed 原子替换缓存，
`screenshot`、`zoom` 与 `get_app_state(include_screenshot=true)` 会在真实模型回合中同时失效。

模型可见的 `frame_id` 使用短不透明 token（例如 `frame-a1b2c3d4`），不公开可被模型
猜测的代次。`get_app_state` 按 `image_ref -> image -> frame hint -> AX tree` 返回；提示在
图片旁重复精确 token，并要求在下一次视觉观测前先动作，避免长 AX tree 把 frame
provenance 挤出有界 transcript。该提示不签发 authority，唯一权威仍是紧邻最终 raster
的结构化 `image_ref`。私有 session/generation、latest/supersession、TTL、digest 与 Helper
native provenance gate 均保持不变。

## 契约与时序

```text
capture/zoom -> final raster + frame_id -> model {frame_id, x, y}
                                              |
                                              v
                           registry live/bounds check
                              | current       | stale/invalid
                              v               v
                     Helper provenance       reject
                              |               broker calls = 0
                              v
                           actuate once
```

- 坐标目标只接受 `{type:"coordinate", frame_id, x, y}`，`x/y` 必须是整数。
- `space:"screen"`、`space:"screenshot"`、`state_id/index` 坐标兼容格式全部拒绝。
- Zoom 从模型实际收到的 raster 裁剪，不重新截图，不泄漏源屏幕几何。
- stale、越界、窗口/owner/topology 变化必须在原生动作前 fail closed。
- 成功以夹具业务标记变化为准，不能只以 CGEvent/AX 调用成功为准。

## 自动化用例

1. **旧轨迹负向回放**
   - `756×485` 帧上的 `(295,623)` 越界拒绝，broker 调用为零。
   - 旧 `space` 与 `state_id/index` 目标在 schema 阶段拒绝。
   - screenshot A -> zoom B 后引用 A，返回 stale/superseded，broker 调用为零。
2. **C07 顺序压力**
   - screenshot -> zoom -> click 命中唯一 canvas 标记。
   - screenshot -> zoom -> screenshot -> 旧帧 click 拒绝。
   - Retina、奇数尺寸、负屏幕原点、部分越界裁剪保持像素中心投影。
   - resize/move、owner 或 display topology 改变后拒绝旧帧。
3. **ZCode 最后一公里**
   - `image_ref` 与 image 相邻，字节、MIME、宽高不变。
   - 无效、重复、跨 session frame 在 action broker RPC 前拒绝。
   - producer 候选缺失 frame-contract 导出时，版本一致性门禁失败；最低基线合入关系另记入
     immutable provenance，不能由 semver 推断。

## macOS 实机验收

- 先运行确定性 marker-grid/C07 replay，再分别运行 direct MCP、ZCode Agent 和可见
  ZCode Desktop 真模型链路。
- 每次保留 raster SHA-256/尺寸、frame_id、模型像素、投影点、窗口/显示器 provenance、
  点击前后业务标记及截图；不保存 provider 请求中的完整图片字节。
- 确定性 window/full/Zoom 必须全部正确命中；真模型链路必须正确命中或在原生动作前
  安全拒绝，不能以工具返回成功替代 fixture 业务结果。
- 模型选错区域但投影正确归类为视觉/语义失败；错帧、错坐标系或错误物理点才归类为
  像素坐标回归。

## 当前证据

| 层级                                  | 结果                     | 说明                                                                                                                                                                                              |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 历史 `v0.5.3/6d02fc3c`                | 拒绝                     | 与 `72a8487d` 分叉，缺少 frame-contract；证明相同版本号不足以证明实现                                                                                                                             |
| producer frame 基线 `v0.5.4/a0d4eaca` | 2750 passed、38 skipped  | 225 个文件通过、3 个文件跳过；包含 frame、Zoom、Retina、stale、native gate                                                                                                                        |
| 最终 producer `v0.5.5/372cbac9`       | 2766 passed、23 skipped  | 227 个文件通过、1 个文件跳过；补齐 30-tool subagent 稳定错误码和 package/plugin 版本一致性门禁，Node 24.14.0 下完整 socket suite 通过                                                             |
| 像素点击实现 `v0.5.6/625b32ad`        | 2786 passed、23 skipped  | 228 个文件通过、1 个文件跳过；zge evaluator 472/472、Python 32/32，通过统一 WindowServer owner、无 AX window/full/Zoom 点击、本地化 AX 回归、K3 模型证据判定与 Helper LaunchServices TCC 归属门禁 |
| 最终 producer `v0.5.6/c863cff9`       | 2814 passed、23 skipped  | 合并最新 `main` 的 AX authoritative-state 屏障后，230 个文件通过、1 个文件跳过；build/typecheck/lint、evaluator 472/472、Python 32/32 通过                                                        |
| 最终 producer `v0.5.6/07a6dca8`       | 2814 passed、23 skipped  | frame hint 固定在图片与 AX tree 之间，trace 在截断前只记录已交付 frame provenance；230 个文件通过、1 个跳过，evaluator 474/474、Python 32/32，Kimi K3 direct/app-server 通过                      |
| producer 轨迹/坐标重点集              | 77/77 通过               | 12 个文件；旧棋盘轨迹新增 3 个 fail-closed 用例                                                                                                                                                   |
| ZCode consumer 完整性                 | 124/124 通过             | 6 个文件；最终依赖固定为 `07a6dca8`/`0.5.6`，提交前完整门禁与 MR pipeline 仍需复验                                                                                                                |
| wrapper 版本/skill/contract 门禁      | 13/13 通过               | 缺少 Windows Helper 或 final-raster frame-contract 均直接拒绝                                                                                                                                     |
| wrapper host authority                | 1/1 通过                 | 产品包 host 权限路径保持一致                                                                                                                                                                      |
| CUA eval 判定器                       | 474/474 通过             | Node evaluator 全集；另有 Python 32/32，覆盖 C07、region、K3 model-I/O 与 frame-id 恢复                                                                                                           |
| CUA eval definition                   | 31/31 通过               | definition-only quality 100                                                                                                                                                                       |
| ZCode 全量单测                        | 11476 passed、12 skipped | 1309 个文件通过、1 个文件跳过；本地对 consumer 最终树执行完整 `test:unit`，提交后再由 affected/pre-push 门禁按 commit range 复验                                                                  |
| ZCode Node 24.14.0                    | 通过                     | `typecheck`；`lint` 0 error、38 条既有 warning                                                                                                                                                    |
| producer Node 24.14.0                 | 通过                     | `typecheck`；`lint` 0 error、14 条既有 warning                                                                                                                                                    |
| 插件产品包校验                        | 通过                     | bundled skill provenance、producer SHA、版本与 contract 一致                                                                                                                                      |
| 独立 `zcode-cua` MCP                  | 通过                     | Node `24.14.0` 以 stdio 启动 `v0.5.6`；canvas marker-grid 的 window 5/5、full、strict-interior Zoom、drag 均由 authenticated DOM oracle 证明命中，全部报告 `window_event`；stale frame 零派发     |
| Chrome                                | 已安装                   | `151.0.7922.138`；C07 fixture 可启动并置前台                                                                                                                                                      |
| Godot                                 | 已安装                   | `4.7.1.stable.official.a13da4feb`；应用可启动                                                                                                                                                     |
| CUA Helper dev 包装                   | 构建通过                 | 使用 Node `24.14.0` SEA base 与同 ABI `ax_native.node`，provenance `arm64/node_abi=137` 通过并安装到 `~/.zcode/computer-use/dev`                                                                  |
| macOS C07 runtime                     | 通过                     | 最新 Dev Helper 的 Accessibility/Screen Recording 均为 granted；final-SHA direct C07 与 Calculator M02 AX 均为 100 分                                                                             |
| Kimi K3 app-server                    | 通过                     | final-SHA gate 的 direct 与 `zcode_agent_core` 两条 lane 均通过；product/release score 100，模型请求确实携带并识别截图                                                                            |
| Kimi K3 可见 ZCode Desktop            | 通过                     | session `sess_be30c6a3-2ce7-4574-aaac-2fe821e311ed`；窗口 raster `1280×900`、`frame-0c9a96ea`、模型像素 `(641,496)`，DOM oracle 为 `Marker placed at 450, 280`，canvas 无 AX 子元素               |
| Desktop 插件缓存 sharp                | 通过                     | 首次运行稳定复现缺少 sharp；`sync:cache` 复用产品 staging 后，sharp `0.34.5`/libvips `8.17.3` native load smoke 与全新 MCP/K3 C07 均通过                                                          |

最终 Kimi K3 真机记录绑定 producer `07a6dca8`：direct C07 为 100 分；ZCode
app-server lane 为 `vision-pass`、product score 100。模型实际收到窗口图
`frame-8ce8ecf9`，提交整数像素 `(641,469)`，Helper 以 `window_event` 派发，DOM
oracle 返回 `Marker placed at 450, 280`。同一候选的 direct C07 还覆盖 retained-raster
Zoom，Calculator M02 AX 回归同为 100 分。

以上正式自动化证据均使用 Node `24.14.0`；macOS TCC 两项权限已经生效。provider 密钥和
完整 provider 图片未写入仓库或 MR。外接二级显示器不属于本轮真机环境，负原点和 topology
变化由确定性测试覆盖；若后续提供双屏环境，再补一条实机 topology 证据，不影响当前单屏
window/full/Zoom 的验收结论。

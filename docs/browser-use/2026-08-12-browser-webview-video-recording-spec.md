# Browser Use 内置 WebView 视频录制 Spec

> 状态：2026-08-14 revised implementation（Electron MediaRecorder / WebM）。
>
> 目标：让 `video2code` 等普通插件通过官方 Browser Use SDK 录制 ZCode 内置浏览器，移除
> Playwright/独立 Chromium 依赖；普通插件仍不获得 raw CDP 或 Electron 权限。
>
> 本能力随 Browser Use plugin `0.3.0` 发布，版本与录屏文档资产合同见
> `2026-08-14-browser-use-plugin-version-0-3-0-spec.md`。

## 1. Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 复用内置 `<webview>` 与 Browser Use 交互链路产出 WebM，不依赖外部视频编码器 |
| Capability | Browser Use embedded WebView scenario recording |
| Change layer | validation / commit-effect / transient state / artifact materialization |
| Operating mode | implementation handoff |
| Primary seeds | `BrowserGuestManager`、`DesktopBrowserScreenshotSurfaceCoordinator`、`BrowserControlMainBridge`、Browser client `Tab` |
| Out of scope | 给第三方插件开放 raw CDP；另起 Chromium；录制整个 ZCode 窗口；把录制任务写入 task snapshot；为其它视频处理功能提供转码 |

## 2. 产品与安全决策

1. 第三方插件只能调用官方 `node_repl` Browser Use SDK 的 `Tab.recording.*`；权限边界仍由
   `browser-use@zcode-plugins-official` 控制，plugin manifest 不能声明高权限 browser runtime。
2. v1 录制的是一个已受控 IAB tab 的 WebView 合成内容。页面交互和画面来自同一个 guest、同一条
   CDP 时间线，不创建 Playwright browser/context。
3. 使用异步 `start/status/cancel`，每条 BrowserControl 命令都在既有 30 秒 transport budget 内完成；
   最长 90 秒的录制不占住一次无状态 `node_repl` 调用。
4. 录制动作使用受限 DSL（wait/click/type/hover/move/scroll/scrollTo/wheel/drag/waitFor），不接受
   `eval` 或任意脚本。selector 是 CSS selector；交互仍走 CDP trusted input。
5. 录制使用 Electron `session.setDisplayMediaRequestHandler` 把目标 guest 的 `WebFrameMain` 定向授权给
   ZCode 自有的隐藏 recorder renderer；renderer 用 Chromium `MediaRecorder` 直接编码 VP8 WebM。
   不收集 JPEG 帧、不启动 FFmpeg，也不依赖 PATH 或用户安装的系统软件。
6. recorder renderer 运行在一次性内存 session 中，只能捕获 main 指定的目标 frame；WebM 分片经
   `MessagePort` 流式交给 main 写盘。被录网页与普通插件都拿不到 capture stream、录制分片或 IPC 权限。
   录制 surface lease 显式声明 `surfaceScaleMode=unscaled`：owner renderer 在 lease 存续期间用请求
   viewport 临时派生 100% 自由尺寸合成表面，不改写用户保存的 Fit/固定预览比例；release 后 React
   派生状态自动恢复。原始 display stream 再在受信任 renderer 的 canvas 中归一化到请求
   viewport/fps 后交给 `MediaRecorder`，避免高 DPI 泄漏到产物分辨率，也禁止把 Fit 低清 surface
   放大伪装成目标分辨率。
7. main 只拥有 WebView 和短期录制产物。Host 在 `recordingStatus` 完成回包时把 WebM 原子落到
   workspace，再把模型可见 path 改写为最终路径。模型永远不直接依赖 main 临时路径。
8. 当前 Browser Use backend 在纯 CLI、Server remote 或未注入 Desktop IAB executor 时保持
   `backend_unavailable`；本特性不为这些形态另起浏览器 runtime。

## 3. Impact Brief

### 3.1 UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 桌面任务录制当前网页 | Browser Use side pane | 当前 `UnifiedBrowserView` guest | renderer tab shell + main recording job | official Browser Use runtime、session/tab scope、90 秒上限 | Host materializes WebM into workspace | job/main temp 与 workspace file；不进 task DB | `desktop-continuous` | 其它 window/workspace/session |
| 手机远控发起录制 | `/remote` 已附着桌面 shared host | 同一 Desktop IAB guest/executor | desktop main | trusted `clientMode` + workspaceKey + remoteSessionId | 同一 Host 返回 workspace path | 不进入 replayable snapshot | `web-remote-replayable` carrier only | 独立 mobile browser runtime |
| 面板隐藏或 Fit 预览时录制 | 无新 UI | screenshot surface prepare/release | main transient lease + renderer 派生 100% surface | guest generation、surface identity、100% scale、watchdog | release surface after capture | 不持久化；用户 preview zoom 不改写 | Desktop Electron | relay/task recovery |
| 远程 workspace | 既有 remote workspace task | 仅在既有 Desktop IAB executor 可达时复用 | Desktop main + Host remote backend | workspaceIdentity + remoteSessionId；否则 fail closed | backend upload 到远端 workspace | 远端文件 | remote workspace scope | 只按 workspacePath 判等 |

### 3.2 Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters |
| --- | --- | --- | --- |
| Browser authority | 都走 BrowserControl session/tab authority | 普通 plugin 不直接访问 CDP | 不能因录制绕过 official plugin gate |
| WebView residency | screenshot 与 recording 共用 background surface | recording lease 有更长但有界 watchdog，并要求 100% surface；screenshot 保留当前 preview scale | 隐藏面板仍有原生清晰度帧，且不会永久关闭节流 |
| Artifact path | model 只看到 workspace 最终 path | main 临时 path 只在 host↔main 内部出现 | 避免远端 Agent 读取桌面临时路径 |
| Delivery | 不修改 task/session 消息流 | 手机只把 BrowserControl 当 shared-host RPC | continuous/replayable 语义不互相扩散 |
| Encoder | 所有 Desktop IAB 形态产出 VP8 WebM | MIME 支持在 recorder renderer 启动时探测 | 不把系统 FFmpeg 可用性变成录屏前置条件 |

### 3.3 Feature Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | embedded browser recording | records guest from | Browser Use side-pane guest | same tab/generation | 画面与交互必须同源 | manager runtime test |
| must-inspect | recording job | holds bounded lease through | screenshot surface coordination | capture phase only | hidden pane must keep emitting frames | coordinator/manager tests |
| must-inspect | recording surface | temporarily overrides display scale of | owner renderer free-size canvas | recording lease only | Fit/50% 不能成为录制源分辨率 | renderer + coordinator tests |
| must-inspect | recording artifact | materialized by | Host browser bridge | completed status + validated output path | main temp path 不能泄漏 | bridge tests |
| must-inspect | third-party video2code plugin | executes through | official stateless Browser Use MCP | official plugin enabled | 不新增 plugin 高权限 | manifest/docs tests |
| invariant-only | recording transient state | must-not-enter | desktop/mobile task delivery | all client modes | 不改变 replayable/continuous | protocol diff + tests |
| invariant-only | recording scope | isolated by | workspace key + remoteSessionId + session + tab generation | every command | 防串 workspace/session | protocol/manager tests |
| evidence-only | recording capability | covered by | schema/client/main/bridge/runtime evidence | accepted cases | 防只测类型不测真实取帧 | focused tests + Electron smoke |

### 3.4 State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| recording id/status/phase | Browser SDK 的序列化结果 | `BrowserGuestManager` process-local job registry | `recordingStart/status/cancel` | 1 小时有界临时状态 | manager tests |
| WebView media stream | 无 UI draft | target guest `WebFrameMain` + isolated recorder renderer | `getDisplayMedia`/`MediaRecorder` | WebM chunk stream | recorder tests + Electron smoke |
| capture residency | renderer background surface | Desktop main coordinator | prepare/release lease | 不持久化 | surface tests |
| recording surface scale | renderer 根据 prepare payload 派生 | Desktop main recording lease | `surfaceScaleMode=unscaled` | 不写入 preview zoom state | renderer/coordinator tests |
| final WebM path | Browser SDK result | workspace filesystem / remote backend | Host artifact materializer | 用户 workspace 文件 | bridge/materializer tests |

### 3.5 Must-Preserve Invariants

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`，远程 identity 与 `remoteSessionId` 不丢失。
- recording id 不是授权凭证；status/cancel 必须再次验证完整 BrowserControl scope。
- 同一个 tab 同时最多一个 recording；录制期间 `captureActive=true`，32-tab LRU 不得淘汰该 tab。
- turn/session/window/tab 结束必须取消仍运行的录制、停止 MediaRecorder/media tracks、关闭 recorder
  renderer、文件句柄与 MessagePort，并释放 surface 与 cursor overlay。
- 完成/失败/cancel 都必须清理一次性 display-media handler；失败产物不能作为 artifact 暴露。
- recording surface ready 必须同时满足请求 viewport 与 `surfaceScale=1`；Fit/50% 等 preview surface
  不得被 main 接受。release/失败/cancel 后必须恢复用户原 preview zoom，不能留下 100% 持久状态。
- 高频 chunk 日志只能走 `debug`，不能按分片写 production `info`。
- output path 必须位于当前 workspace；拒绝 `..` 逃逸和绝对路径跨根覆盖。
- Desktop `continuous` 不拼接手机 replayable 状态；手机不创建独立 Host/Agent/browser runtime。

### 3.6 Codegraph Evidence

当前环境没有可用的 `codegraph` 命令，按 feature graph seed 与 `rg` 追踪 2 层调用：

| Seed | Query | Direct callers / key path | Depth | Interpretation |
| --- | --- | --- | ---: | --- |
| `BrowserGuestManager.execute` | callers/callees | host request → main runner → manager → guest CDP | 2 | recording command authority 与真实 guest owner |
| `DesktopBrowserScreenshotSurfaceCoordinator.prepare` | callers | manager screenshot path → renderer background surface | 2 | recording 必须复用的 hidden-pane wake lease |
| `createBrowserControlMainBridge` | callers/callees | agent service → host pending map → main result | 2 | final artifact materialization sink |
| `Tab` | affected API | Browser client facade → BrowserCommand schema | 2 | plugin-facing async recording API |

### 3.7 Graph Drift / Delta

- 新增 `capability.browser-webview-video-recording`、`state.browser-recording-job-registry`、
  `evidence.browser-webview-video-recording-tests`。
- recording 与 screenshot surface、stateless Browser Use MCP、workspace key、desktop/mobile delivery boundary
  的语义边在 planning 模式写回 feature graph。

## 4. 状态与时序

### 4.1 状态机

```text
                start(scope, tab, actions)
 idle ------------------------------------------------> preparing
                                                        |
                                                        | surface ready + recorder started
                                                        v
                                                     capturing
                                                        |
                                                        | actions finished
                                                        v
                                                     finalizing
                                                        |
                             +--------------------------+------------------+
                             |                                             |
                             v                                             v
                          completed                                     failed
                             |
                             | Host validates/materializes outputPath
                             v
                       workspace artifact

 preparing/capturing/finalizing -- cancel | turn/session/window/tab end --> cancelled
 completed/failed/cancelled -- TTL -------------------------------------> cleanup
```

### 4.2 事件顺序

```text
Browser client      node_repl/Browser SDK      Host       Desktop main       owner renderer        recorder / target
      | recording.start(options) |               |              |                    |                    |
      |-------------------------->| BrowserCommand|              |                    |                    |
      |                           |-------------->| parentPort   |                    |                    |
      |                           |               |------------->| sync CSS viewport  |                    |
      |                           |               |              |-- prepare(unscaled)->|                    |
      |                           |               |              |<-- ready(scale=1) ---|                    |
      |                           |<--------------| running{id}  |                    |                    |
      |<--------------------------|               |              | getDisplayMedia(target WebFrameMain)       |
      |                           |               |              |<========== MediaRecorder =================>|
      |                           |               |              |<--------- WebM chunks ---------------------|
      | recording.status(id,out)  |               |              |                    |                    |
      |-------------------------->|-------------->|------------->| completed(temp.webm)|                    |
      |                           |               |              |-- release --------->| restore preview   |
      |                           |               | copy/upload + rewrite path                                   |
      |                           |<--------------| workspace WebM|                    |                    |
      |<--------------------------|               |              |                    |                    |
```

`recording.start` 只启动任务，不等待 capture/encode；每次 `status` 都在 fresh JS kernel 中用字符串 id
重新寻址。Browser/tab 连续性仍归 BrowserControl registry，不归 JS global。

## 5. 协议与 API

### 5.1 BrowserCommand

- `recordingStart { tabId?, options }`
- `recordingStatus { recordingId, outputPath? }`
- `recordingCancel { recordingId }`

`options` 包含 `viewport`、`fps`、`maxDurationMs`、`settleMs`、`showCursor` 与受限 `actions[]`。
默认 viewport 1280×720、25 fps、最长 60 秒；schema 硬上限 90 秒。`jpegQuality` 仅为未发布旧调用的
兼容字段，新 recorder 忽略它，后续协议大版本可移除。

### 5.2 Browser client

```js
const job = await tab.recording.start({
  viewport: { width: 1280, height: 720 },
  actions: [
    { type: "wait", durationMs: 800 },
    { type: "click", selector: "#start" },
    { type: "scroll", deltaY: 600, durationMs: 1000 }
  ]
});

const status = await tab.recording.status(job.id, {
  outputPath: "recordings/demo.webm"
});
// status.status === "completed" 时 status.artifact.path 是 workspace 最终路径。
```

## 6. Case Planning

### 6.1 Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| browser runtime | 只录制已有 IAB guest | desktop shared-host / mobile attached | plugin Playwright、独立 Chromium | 用户要求 + runtime boundary |
| duration | async job，schema 最长 90 秒 | capture + encode phase polling | 单次 600 秒 node_repl call | 120 秒 tool 上限 |
| interaction | CSS selector + trusted CDP input DSL | URL2Video 常用动作 | eval、自定义 JS、网络请求 | Browser safety |
| artifact | Host workspace materialization | local copy；已有 backend 时 upload | 暴露 main temp path | process responsibility |
| encoder | Chromium MediaRecorder | VP8 WebM；启动时 `isTypeSupported` | FFmpeg、外部二进制、独立 Chromium | 零安装依赖 |
| delivery | browser RPC only | desktop continuous、mobile carrier | task snapshot/replay queue | remote architecture |

### 6.2 Accepted Cases

`E2E status` 列记录**实际落地的自动化**，不是计划。修改录制链路时先按这里核对，再决定要补哪一层。

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| BVR01 | visible IAB animation page | start → wait/click/scroll → poll | WebM 非空，分辨率/fps/duration 正确，交互出现在同一视频 | schema + client + main + file | ✅ focused unit（`browserGuestManager.test.ts` BVR01/BVR04、`browserVideoRecorder.test.ts`，recorder 注入）+ ✅ Electron smoke（`scripts/browser-webm-recording-smoke.mjs`：EBML 头、真实播放分辨率、seek 得到的真实时长、画面动态比、实测解码帧率）<br>⬜ 缺口：smoke 直连 recorder，未经 manager 的 DSL 动作，"交互出现在同一视频"仍无自动化证据 |
| BVR02 | Browser side pane hidden | start recording | surface lease 保持取帧，完成后 release | main + renderer/CDP | ✅ focused unit（`browserGuestManager.test.ts`：prepare 即失效、录制中失效、lease 指向别的 webContents，三条均断言不取帧且归还 lease）<br>⬜ 缺口：hidden pane 的真实 surface runtime probe |
| BVR03 | two sessions/tabs | use foreign recording id for status/cancel | fail closed，不返回状态/path | protocol + main | ✅ focused unit（跨 session status、跨 session cancel 且原作业存活、错 tabId） |
| BVR04 | active recording | turn/session/window/tab end | stop/ack/release/cursor cleanup，状态 cancelled | main lifecycle | ✅ focused unit（endTurn / closeSession / closeWindow 各一条，断言 cancelled + recorder.cancel + lease release；recorder 侧另有外部 abort 回收用例）<br>⬜ 缺口：closeTab 入口未单测 |
| BVR05 | same tab active job | start second recording | structured execution error；第一任务继续 | main state | ✅ focused unit（断言 execution_error、不再起第二个 recorder、第一作业仍 running） |
| BVR06 | output `../outside.webm` 或 `.mp4` | completed status materialization | reject path escape/错误扩展名，不写 workspace 外 | Host IO | ✅ focused unit（`browserRecordingArtifactMaterializer.test.ts` 4 条 + `browserControlMainBridge.test.ts` materialization） |
| BVR07 | Chromium 不支持 VP8 WebM 或 recorder renderer 崩溃 | start/finish capture | failed status 包含 recorder unavailable；不伪造 artifact | main recorder | ✅ focused unit（`electronBrowserWebmRecorder.test.ts`：MIME 白名单、renderer 崩溃、MessagePort 意外关闭、写盘失败；`browserGuestManager.test.ts`：recorder 不可用 → failed 且无 artifact） |
| BVR08 | mobile attached local workspace | recording RPC | 不创建 runtime/snapshot；仍按 workspace/session/tab scope | host/protocol | ⚠️ 部分：`scopeKey` 含 `clientMode`，已单测证明 web-remote 客户端查不到桌面作业。`attachGuest` 的 options 不接受 `clientMode`，本层无法构造 mobile-attached 的 tab，"不创建 runtime/snapshot" 需在 host/server 层验证 |
| BVR09 | tab 当前 preview 为 Fit/50%，录制请求相同或不同 viewport | start → prepare → capture → release | renderer 临时按请求 viewport 以 100% 合成；ready 只接受 scale=1；完成/失败后恢复原 preview zoom | shared payload + main + renderer | ✅ focused unit（`browserScreenshotSurfaceCoordinator.test.ts` 只收 scale=1；`UnifiedBrowserView.test.ts` UI 侧临时切换；`browserGuestManager.test.ts` main 侧还原 viewport override）<br>⬜ 缺口：Electron runtime smoke 未覆盖 zoom 还原 |

**覆盖注记**

- `scripts/browser-*-smoke.mjs` 系列需要 Electron GUI 与屏幕录制权限，**未接入 CI**，属于手工/本地门禁。改录制链路时需手动跑
  `pnpm --filter @zcode/desktop test:browser-webm-recording-smoke`。
- `packages/desktop/test/*.test.ts`（非 e2e 单测）不被任何 `tsconfig` include，类型错误不会被 `pnpm typecheck` 拦住。
- `browserVideoRecorder.ts` 返回的 `width/height/fps/durationMs/frameCount` 全部由入参推算，不解析 WebM。
  只有 Electron smoke 会核对容器里的真实分辨率与时长，单测层对这几个字段的断言是重言式。


### 6.3 Pruning Decisions

- 不做 Browser UI 录制按钮；入口是 plugin/agent API。`packages/ui` 只根据瞬时 surface request 派生
  100% capture 布局，不增加控件、不写入用户 preview zoom 状态。
- 不做每种 SSH/WSL/Docker × 每种动作全排列；workspace materializer 的 local/remote 两类代表足够，
  BrowserControl 本身不可达的 remote/server 形态继续结构化 `backend_unavailable`。
- 不写 conversation-session E2E；没有改变 conversation/session 状态语义。协议、manager、Host 与真实 Electron
  smoke 直接覆盖录制链路，避免把媒体编码夹进 provider 对话 fixture。

## 7. 完成门槛

- `video2code` 中没有 Playwright Python import、browser install/launch 检查或独立 Chromium 启动脚本。
- official Browser Use 文档/manifest 暴露 `Tab.recording.start/status/cancel`，fresh-kernel 示例可执行。
- visible 与 hidden IAB guest 都能产出可播放 VP8 WebM；录制包含 DSL 触发的真实交互。
- 录制期间 owner renderer 回报 `surfaceScale=1`；当前预览为 Fit/固定非 100% 时仍从原生尺寸
  surface 取流，release 后恢复原预览比例。
- 未安装 FFmpeg、PATH 中没有 ffmpeg/ffmpeg.exe 时录制能力仍可启动并完成。
- temp artifact 不直接返回 Agent；output path 逃逸被拒绝。
- lifecycle cancel、scope isolation、surface lease、tab LRU capture protection 有自动化证据。
- 不新增 task/replayable snapshot 字段；workspaceIdentity/remoteSessionId/clientMode 透传不回归。
- focused tests、`pnpm typecheck`、`pnpm lint` 通过，并完成一次真实 Electron 录制验证。
